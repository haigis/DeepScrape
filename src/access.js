import { promises as fs } from 'fs';
import path from 'path';

/**
 * Access & rendering analysis (rating v3, issue #35).
 *
 * Can an AI agent get the words at all? Signals: robots.txt policy for
 * AI crawlers, llms.txt presence, oversized pages, and broken internal
 * links. Network checks run once per scan state (the consistency
 * report is cached by scan token) with short timeouts, and fail soft —
 * an unreachable check produces no finding, never a false one.
 *
 * Deliberately NOT penalised: blocking AI crawlers by explicit rule.
 * That is a policy choice; the score only punishes configurations that
 * look accidental (a blanket Disallow: / for every agent).
 */

/** Documented AI crawler user agents (mid-2025 snapshot; extend as adopted). */
export const AI_CRAWLERS = [
    'GPTBot', 'OAI-SearchBot', 'ChatGPT-User',
    'ClaudeBot', 'anthropic-ai', 'Claude-Web',
    'Google-Extended', 'PerplexityBot', 'CCBot',
    'Applebot-Extended', 'Bytespider', 'meta-externalagent',
];

const FETCH_TIMEOUT_MS = 6000;

async function fetchText(url, fetchImpl) {
    try {
        const res = await fetchImpl(url, {
            redirect: 'follow',
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            headers: { 'User-Agent': 'DeepScrape-AccessCheck/1.0' },
        });
        if (!res.ok) return null;
        return await res.text();
    } catch {
        return null;
    }
}

/**
 * Parses robots.txt into { agent -> rules[] } (lowercased agents).
 * Minimal parser: user-agent grouping with disallow/allow lines.
 */
export function parseRobots(text) {
    const groups = new Map();
    let currentAgents = [];
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.replace(/#.*$/, '').trim();
        if (!line) continue;
        const [key, ...rest] = line.split(':');
        const value = rest.join(':').trim();
        const field = key.trim().toLowerCase();
        if (field === 'user-agent') {
            // A UA line after rules starts a new group.
            if (currentAgents.length && currentAgents.some(a => (groups.get(a) ?? []).length > 0)) {
                currentAgents = [];
            }
            currentAgents.push(value.toLowerCase());
            if (!groups.has(value.toLowerCase())) groups.set(value.toLowerCase(), []);
        } else if (field === 'disallow' || field === 'allow') {
            for (const agent of currentAgents) {
                groups.get(agent)?.push({ rule: field, path: value });
            }
        }
    }
    return groups;
}

/** Is this agent fully blocked (Disallow: / with no overriding Allow)? */
export function isFullyBlocked(groups, agent) {
    const rules = groups.get(agent.toLowerCase()) ?? groups.get('*') ?? [];
    const blocked = rules.some(r => r.rule === 'disallow' && r.path === '/');
    const allowed = rules.some(r => r.rule === 'allow' && r.path.length > 0);
    return blocked && !allowed;
}

/** Sizes of saved .html files, for the oversized-page check. */
async function pageSizes(scanPath) {
    const sizes = [];
    async function walk(dir, rel) {
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const childRel = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                if (entry.name !== 'images' && entry.name !== '_assets') await walk(path.join(dir, entry.name), childRel);
            } else if (/\.html?$/i.test(entry.name)) {
                const stat = await fs.stat(path.join(dir, entry.name)).catch(() => null);
                if (stat) sizes.push({ path: childRel, bytes: stat.size });
            }
        }
    }
    await walk(scanPath, '');
    return sizes;
}

/**
 * Access findings + metrics for a scan.
 *
 * @param {string} scanPath - Scan directory (saved pages).
 * @param {string} domain
 * @param {{network?: boolean, fetchImpl?: typeof fetch}} [opts]
 * @returns {Promise<{findings: object[], metrics: object}>}
 */
export async function analyzeAccess(scanPath, domain, opts = {}) {
    const network = opts.network ?? process.env.DS_V3_NETWORK !== 'false';
    const fetchImpl = opts.fetchImpl ?? fetch;
    const findings = [];
    const metrics = { robots: null, aiPolicy: null, llmsTxt: null, oversizedPages: 0, brokenLinks: 0 };

    if (network) {
        // --- robots.txt ---------------------------------------------------
        const robotsText = await fetchText(`https://${domain}/robots.txt`, fetchImpl);
        if (robotsText != null) {
            const groups = parseRobots(robotsText);
            const blockedAi = AI_CRAWLERS.filter(agent => isFullyBlocked(groups, agent));
            // Blanket = '*' blocked and no named group carves anything open.
            const blanketBlock = isFullyBlocked(groups, '*') &&
                [...groups.keys()].every(k => k === '*' || isFullyBlocked(groups, k));

            metrics.robots = 'present';
            metrics.aiPolicy = blockedAi.length === AI_CRAWLERS.length
                ? 'all-blocked'
                : blockedAi.length > 0 ? 'partial' : 'open';

            if (isFullyBlocked(groups, '*') && blanketBlock) {
                findings.push({
                    id: 'access-blanket-disallow',
                    category: 'access',
                    severity: 'high',
                    confidence: 'confirmed',
                    title: 'robots.txt blocks every crawler from the whole site',
                    detail: 'User-agent: * / Disallow: / with no Allow rules — every well-behaved crawler, AI or search, is told to stay out.',
                    why: 'A site no machine may read cannot appear in any machine\'s answer. If this is deliberate, exclude this site from scanning; it is usually an accident left over from staging.',
                    evidence: [{ value: 'Disallow: /', pages: ['robots.txt'], count: 1 }],
                    pagesAffected: 999999, // whole site by definition
                });
            } else if (blockedAi.length > 0 && blockedAi.length < AI_CRAWLERS.length) {
                findings.push({
                    id: 'access-inconsistent-ai-policy',
                    category: 'access',
                    severity: 'low',
                    confidence: 'strong',
                    title: 'Inconsistent AI-crawler policy',
                    detail: `robots.txt fully blocks ${blockedAi.join(', ')} but leaves ${AI_CRAWLERS.length - blockedAi.length} other AI crawlers open — the policy reads as accidental rather than chosen.`,
                    why: 'Blocking some assistants and not others splits your AI presence arbitrarily. Either policy is fine; a half-policy is not.',
                    evidence: [{ value: blockedAi.join(', '), pages: ['robots.txt'], count: blockedAi.length }],
                    pagesAffected: 1,
                });
            }
        } else {
            metrics.robots = 'absent';
        }

        // --- llms.txt -----------------------------------------------------
        const llms = await fetchText(`https://${domain}/llms.txt`, fetchImpl);
        metrics.llmsTxt = llms != null ? 'present' : 'absent';
        if (llms == null) {
            findings.push({
                id: 'access-no-llms-txt',
                category: 'access',
                severity: 'low',
                confidence: 'confirmed',
                title: 'No llms.txt',
                detail: 'The site does not serve /llms.txt — the emerging convention for telling AI agents what a site is and where its key content lives.',
                why: 'Cheap, unambiguous machine-readability signal. Sites that state their own facts to machines get them repeated correctly.',
                evidence: [{ value: 'GET /llms.txt → not found', pages: [], count: 1 }],
                pagesAffected: 1,
            });
        }
    }

    // --- Oversized pages (offline) ---------------------------------------
    const sizes = await pageSizes(scanPath);
    const oversized = sizes.filter(s => s.bytes > 2 * 1024 * 1024);
    metrics.oversizedPages = oversized.length;
    if (oversized.length > 0) {
        findings.push({
            id: 'access-oversized-pages',
            category: 'access',
            severity: 'low',
            confidence: 'confirmed',
            title: 'Pages over 2 MB of HTML',
            detail: `${oversized.length} page${oversized.length === 1 ? '' : 's'} exceed 2 MB of markup. Crawlers time-box fetches and truncate oversized documents.`,
            why: 'Truncated fetches mean partial content — whatever fell below the cut simply does not exist to the machine.',
            evidence: oversized.slice(0, 12).map(s => ({
                value: `${(s.bytes / 1024 / 1024).toFixed(1)} MB`, pages: [s.path], count: 1,
            })),
            pagesAffected: oversized.length,
        });
    }

    // --- Broken internal links (offline, from the crawl artifact) --------
    try {
        const raw = await fs.readFile(path.join(scanPath, 'broken-links.txt'), 'utf8');
        const broken = raw.split('\n').map(l => l.trim()).filter(Boolean);
        metrics.brokenLinks = broken.length;
        if (broken.length > 0) {
            findings.push({
                id: 'access-broken-links',
                category: 'access',
                severity: broken.length >= 10 ? 'medium' : 'low',
                confidence: 'confirmed',
                title: `${broken.length} broken internal link${broken.length === 1 ? '' : 's'}`,
                detail: 'Links the crawl followed that returned errors. Every one is a dead end for an agent walking the site.',
                why: 'Broken paths truncate crawl coverage and read as neglect — both lower a machine\'s confidence in the rest of the site.',
                evidence: broken.slice(0, 12).map(url => ({ value: url, pages: [], count: 1 })),
                pagesAffected: broken.length,
            });
        }
    } catch { /* not a spider scan */ }

    return { findings, metrics };
}
