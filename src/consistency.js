import { promises as fs } from 'fs';
import path from 'path';
import { extractPageMeta, extractAnchors, urlToScanPath, getInboundIndex } from './scanStore.js';
import { rateFindings, rateFindingsV3 } from './rating.js';
import { analyzePageExtractability, checkExtractability } from './extractability.js';
import { analyzeAccess } from './access.js';

/**
 * Content consistency engine.
 *
 * Finds contradictions across a site that make it harder for search
 * engines and language models to state facts about the business with
 * confidence: the same thing said two different ways, metadata that
 * disagrees with itself, structured data that contradicts the page, and
 * one concept called by several names.
 *
 * @typedef {object} Finding
 * @property {string} id
 * @property {'facts'|'metadata'|'structured-data'|'terminology'} category
 * @property {'high'|'medium'|'low'} severity
 * @property {string} title
 * @property {string} detail        Plain-English explanation.
 * @property {string} [why]         Why it matters for AI/search authority.
 * @property {object[]} evidence    [{ value, pages: [path], count }]
 * @property {number} pagesAffected
 */

const MAX_PAGES = Number(process.env.DS_MAX_ANALYZED_PAGES) || 100000;
const MAX_EVIDENCE = 12;

/** scanPath -> { token, report } */
const reportCache = new Map();

const norm = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
const lower = (value) => norm(value).toLowerCase();

/** Digits-only phone comparison so formatting differences don't count. */
const phoneKey = (value) => value.replace(/[^\d]/g, '').replace(/^44/, '0');

/**
 * Facts we can extract reliably enough to compare across pages.
 * Deliberately conservative: a false "contradiction" is worse than a
 * missed one.
 */
function extractFacts(text) {
    const facts = { phones: new Set(), emails: new Set(), postcodes: new Set(), prices: new Set() };

    // UK-style and international phone numbers.
    for (const m of text.matchAll(/(?:\+44\s?|\b0)(?:\d[\d\s-]{8,12}\d)/g)) {
        const digits = phoneKey(m[0]);
        if (digits.length >= 10 && digits.length <= 13) facts.phones.add(m[0].trim());
    }

    for (const m of text.matchAll(/\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/g)) {
        facts.emails.add(m[0].toLowerCase());
    }

    // UK postcodes.
    for (const m of text.matchAll(/\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/g)) {
        facts.postcodes.add(m[0].toUpperCase().replace(/\s+/g, ' '));
    }

    // Prices with an explicit currency symbol.
    for (const m of text.matchAll(/[£$€]\s?\d[\d,]*(?:\.\d{2})?/g)) {
        facts.prices.add(m[0].replace(/\s+/g, ''));
    }

    return facts;
}

/** Pulls JSON-LD blocks out of a page, ignoring malformed ones (recorded). */
function extractJsonLd(html) {
    const blocks = [];
    const invalid = [];
    for (const m of html.matchAll(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
        try {
            const parsed = JSON.parse(m[1].trim());
            for (const node of Array.isArray(parsed) ? parsed : [parsed]) {
                if (node && typeof node === 'object') blocks.push(node);
                // @graph containers are common.
                if (Array.isArray(node?.['@graph'])) blocks.push(...node['@graph']);
            }
        } catch {
            invalid.push(m[1].trim().slice(0, 80));
        }
    }
    return { blocks, invalid };
}

/** Strips markup, scripts and styles to comparable visible text. */
function visibleText(html) {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Reads every saved page once and pulls out everything the checks need. */
async function collectPages(scanPath) {
    const pages = [];

    async function walk(dir, rel) {
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }

        const htmlFiles = entries.filter(e => !e.isDirectory() && /\.html?$/i.test(e.name));
        const contents = await Promise.all(htmlFiles.map(e =>
            fs.readFile(path.join(dir, e.name), 'utf8').catch(() => null)));

        htmlFiles.forEach((entry, i) => {
            const html = contents[i];
            if (!html || pages.length >= MAX_PAGES) return;
            const childRel = rel ? `${rel}/${entry.name}` : entry.name;
            const meta = extractPageMeta(html);
            const text = visibleText(html);
            const { blocks, invalid } = extractJsonLd(html);

            pages.push({
                path: childRel,
                url: html.match(/^<!--\s*(https?:\/\/\S+)\s*-->/)?.[1] ?? null,
                meta,
                text,
                facts: extractFacts(text),
                jsonLd: blocks,
                invalidJsonLd: invalid,
                anchors: extractAnchors(html),
                extract: analyzePageExtractability(html),
            });
        });

        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name === 'images' || entry.name === '_assets') continue;
            await walk(path.join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name);
        }
    }

    await walk(scanPath, '');
    return pages;
}

/** Groups values to page lists: Map<value, Set<path>>. */
function groupBy(pages, pick) {
    const groups = new Map();
    for (const page of pages) {
        for (const value of pick(page)) {
            if (!value) continue;
            if (!groups.has(value)) groups.set(value, new Set());
            groups.get(value).add(page.path);
        }
    }
    return groups;
}

const evidenceFrom = (groups, limit = MAX_EVIDENCE) =>
    [...groups.entries()]
        .sort((a, b) => b[1].size - a[1].size)
        .slice(0, limit)
        .map(([value, paths]) => ({ value, pages: [...paths].slice(0, 8), count: paths.size }));

// --- Checks -------------------------------------------------------------

function checkFacts(pages) {
    const findings = [];

    const factChecks = [
        {
            id: 'contradictory-phone-numbers',
            key: 'phones',
            label: 'phone numbers',
            normalise: phoneKey,
            why: 'Search engines and assistants pick one number to show. Several competing numbers means the wrong one can be surfaced, and confidence in your contact details drops.',
        },
        {
            id: 'contradictory-postcodes',
            key: 'postcodes',
            label: 'postcodes',
            normalise: (v) => v.replace(/\s+/g, '').toUpperCase(),
            why: 'A business with several addresses stated across its own site is harder to place, weakening local and entity-level confidence.',
        },
        {
            id: 'contradictory-emails',
            key: 'emails',
            label: 'contact email addresses',
            normalise: (v) => v,
            why: 'Multiple contact addresses with no stated purpose make it ambiguous which one is authoritative.',
        },
    ];

    for (const check of factChecks) {
        const groups = new Map();
        for (const page of pages) {
            for (const value of page.facts[check.key]) {
                const key = check.normalise(value);
                if (!groups.has(key)) groups.set(key, { display: value, pages: new Set() });
                groups.get(key).pages.add(page.path);
            }
        }
        if (groups.size < 2) continue;

        const evidence = [...groups.values()]
            .sort((a, b) => b.pages.size - a.pages.size)
            .slice(0, MAX_EVIDENCE)
            .map(g => ({ value: g.display, pages: [...g.pages].slice(0, 8), count: g.pages.size }));

        findings.push({
            id: check.id,
            category: 'facts',
            severity: groups.size > 3 ? 'high' : 'medium',
            title: `${groups.size} different ${check.label} across the site`,
            detail: `The site states ${groups.size} distinct ${check.label}. Where these are not clearly scoped to different teams or locations, they read as contradictions.`,
            why: check.why,
            evidence,
            pagesAffected: new Set([...groups.values()].flatMap(g => [...g.pages])).size,
        });
    }

    // Prices are only compared when the same page family repeats them.
    const priceGroups = groupBy(pages, p => p.facts.prices);
    if (priceGroups.size > 1) {
        const spread = [...priceGroups.keys()];
        findings.push({
            id: 'price-spread',
            category: 'facts',
            severity: 'low',
            title: `${spread.length} distinct prices quoted across the site`,
            detail: 'Prices appear in multiple places. Check that the same product is not quoted at different prices on different pages.',
            why: 'Conflicting prices for one product are a direct factual contradiction; assistants may quote a stale figure.',
            evidence: evidenceFrom(priceGroups),
            pagesAffected: new Set([...priceGroups.values()].flatMap(s => [...s])).size,
        });
    }

    return findings;
}

function checkMetadata(pages) {
    const findings = [];

    // Duplicate titles / H1s / descriptions across different pages.
    const dupChecks = [
        { id: 'duplicate-titles', label: 'title', pick: p => (p.meta.title ? [norm(p.meta.title)] : []),
          why: 'Identical titles make pages indistinguishable, so the wrong page can be chosen to represent a topic.' },
        { id: 'duplicate-h1s', label: 'H1 heading', pick: p => p.meta.h1s.map(norm),
          why: 'The H1 is the strongest on-page statement of what a page is about; repeating it blurs which page owns the topic.' },
        { id: 'duplicate-descriptions', label: 'meta description', pick: p => (p.meta.description ? [norm(p.meta.description)] : []),
          why: 'Duplicate descriptions signal near-duplicate content and dilute each page’s distinct summary.' },
    ];

    for (const check of dupChecks) {
        const groups = groupBy(pages, check.pick);
        const dupes = new Map([...groups.entries()].filter(([, paths]) => paths.size > 1));
        if (dupes.size === 0) continue;

        const affected = new Set([...dupes.values()].flatMap(s => [...s]));
        findings.push({
            id: check.id,
            category: 'metadata',
            severity: affected.size > pages.length * 0.2 ? 'high' : 'medium',
            title: `${dupes.size} ${check.label}${dupes.size === 1 ? '' : 's'} reused across ${affected.size} pages`,
            detail: `The same ${check.label} appears on more than one page.`,
            why: check.why,
            evidence: evidenceFrom(dupes),
            pagesAffected: affected.size,
        });
    }

    // Missing metadata.
    const missing = [
        { id: 'missing-titles', label: 'title', test: p => !p.meta.title },
        { id: 'missing-descriptions', label: 'meta description', test: p => !p.meta.description },
        { id: 'missing-h1', label: 'H1 heading', test: p => p.meta.h1Count === 0 },
        { id: 'multiple-h1', label: 'more than one H1', test: p => p.meta.h1Count > 1 },
    ];
    for (const check of missing) {
        const hits = pages.filter(check.test);
        if (hits.length === 0) continue;
        findings.push({
            id: check.id,
            category: 'metadata',
            severity: hits.length > pages.length * 0.3 ? 'high' : 'low',
            title: `${hits.length} page${hits.length === 1 ? '' : 's'} with ${check.id.startsWith('multiple') ? check.label : `no ${check.label}`}`,
            detail: `${hits.length} of ${pages.length} pages are affected.`,
            why: 'Missing or duplicated structural signals leave a page’s subject open to interpretation.',
            evidence: [{ value: check.label, pages: hits.slice(0, 8).map(p => p.path), count: hits.length }],
            pagesAffected: hits.length,
        });
    }

    // Title and H1 telling different stories on the same page.
    const mismatched = pages.filter(p =>
        p.meta.title && p.meta.h1s.length === 1 &&
        !lower(p.meta.title).includes(lower(p.meta.h1s[0])) &&
        !lower(p.meta.h1s[0]).includes(lower(p.meta.title.split('|')[0])));
    if (mismatched.length) {
        findings.push({
            id: 'title-h1-mismatch',
            category: 'metadata',
            severity: 'low',
            title: `${mismatched.length} pages where the title and H1 describe different things`,
            detail: 'The browser title and the on-page heading share no common wording.',
            why: 'When the two strongest labels for a page disagree, extraction has to guess which one names the page.',
            evidence: mismatched.slice(0, MAX_EVIDENCE).map(p => ({
                value: `“${norm(p.meta.title)}” vs “${norm(p.meta.h1s[0])}”`,
                pages: [p.path],
                count: 1,
            })),
            pagesAffected: mismatched.length,
        });
    }

    // Canonical pointing away from the page itself.
    const canonicalAway = pages.filter(p =>
        p.meta.canonical && p.url &&
        p.meta.canonical.replace(/\/+$/, '') !== p.url.replace(/\/+$/, ''));
    if (canonicalAway.length) {
        findings.push({
            id: 'canonical-conflicts',
            category: 'metadata',
            severity: 'medium',
            title: `${canonicalAway.length} pages canonicalise to a different URL`,
            detail: 'These pages tell search engines that another URL is the real version.',
            why: 'If this is unintentional the page’s content is attributed elsewhere, and its authority is handed to another URL.',
            evidence: canonicalAway.slice(0, MAX_EVIDENCE).map(p => ({
                value: `${p.url} → ${p.meta.canonical}`,
                pages: [p.path],
                count: 1,
            })),
            pagesAffected: canonicalAway.length,
        });
    }

    // noindex pages that the site still links to.
    const noindex = pages.filter(p => p.meta.robots.noindex);
    if (noindex.length) {
        findings.push({
            id: 'noindex-pages',
            category: 'metadata',
            severity: 'low',
            title: `${noindex.length} page${noindex.length === 1 ? '' : 's'} marked noindex`,
            detail: 'These pages are excluded from search while remaining part of the site.',
            why: 'Content that cannot be indexed cannot support your authority, however good it is.',
            evidence: [{ value: 'noindex', pages: noindex.slice(0, 8).map(p => p.path), count: noindex.length }],
            pagesAffected: noindex.length,
        });
    }

    return findings;
}

function checkStructuredData(pages) {
    const findings = [];
    const withJsonLd = pages.filter(p => p.jsonLd.length > 0);

    if (withJsonLd.length === 0) {
        findings.push({
            id: 'no-structured-data',
            category: 'structured-data',
            severity: 'high',
            title: 'No structured data found anywhere on the site',
            detail: `None of the ${pages.length} pages scanned contain JSON-LD.`,
            why: 'Structured data is the most direct way to state facts about your organisation in a form machines read without inference. Without it, everything has to be guessed from prose.',
            evidence: [],
            pagesAffected: pages.length,
        });
        return findings;
    }

    const coverage = Math.round((withJsonLd.length / pages.length) * 100);
    if (coverage < 80) {
        findings.push({
            id: 'partial-structured-data',
            category: 'structured-data',
            severity: coverage < 40 ? 'high' : 'medium',
            title: `Structured data on only ${coverage}% of pages`,
            detail: `${withJsonLd.length} of ${pages.length} pages carry JSON-LD.`,
            why: 'Uneven coverage means some pages state their facts machine-readably and others do not, so the site speaks with two voices.',
            evidence: [{
                value: 'pages without JSON-LD',
                pages: pages.filter(p => p.jsonLd.length === 0).slice(0, 8).map(p => p.path),
                count: pages.length - withJsonLd.length,
            }],
            pagesAffected: pages.length - withJsonLd.length,
        });
    }

    const invalid = pages.filter(p => p.invalidJsonLd.length > 0);
    if (invalid.length) {
        findings.push({
            id: 'invalid-structured-data',
            category: 'structured-data',
            severity: 'high',
            title: `${invalid.length} page${invalid.length === 1 ? '' : 's'} with JSON-LD that does not parse`,
            detail: 'These blocks are present but malformed, so they are ignored entirely.',
            why: 'Broken structured data is worse than none: the effort is spent but no fact is communicated.',
            evidence: invalid.slice(0, MAX_EVIDENCE).map(p => ({
                value: p.invalidJsonLd[0], pages: [p.path], count: 1,
            })),
            pagesAffected: invalid.length,
        });
    }

    // Organization-level facts that disagree between pages.
    const orgFields = ['name', 'telephone', 'email', 'legalName'];
    for (const field of orgFields) {
        const groups = new Map();
        for (const page of pages) {
            for (const node of page.jsonLd) {
                const type = String(node['@type'] ?? '');
                if (!/Organization|Corporation|LocalBusiness|BankOrCreditUnion/i.test(type)) continue;
                const raw = node[field];
                if (typeof raw !== 'string' || !raw.trim()) continue;
                const key = field === 'telephone' ? phoneKey(raw) : lower(raw);
                if (!groups.has(key)) groups.set(key, { display: norm(raw), pages: new Set() });
                groups.get(key).pages.add(page.path);
            }
        }
        if (groups.size < 2) continue;

        findings.push({
            id: `organization-${field}-conflict`,
            category: 'structured-data',
            severity: 'high',
            title: `Organization ${field} declared ${groups.size} different ways`,
            detail: `Your structured data gives ${groups.size} values for the organisation's ${field}.`,
            why: 'This is your own machine-readable claim about who you are. Contradicting it across pages directly undermines entity confidence.',
            evidence: [...groups.values()].slice(0, MAX_EVIDENCE).map(g => ({
                value: g.display, pages: [...g.pages].slice(0, 8), count: g.pages.size,
            })),
            pagesAffected: new Set([...groups.values()].flatMap(g => [...g.pages])).size,
        });
    }

    return findings;
}

async function checkTerminology(pages, scanPath) {
    const findings = [];

    // The same destination linked under several different labels.
    const { index } = await getInboundIndex(scanPath);
    const drift = [];
    for (const [target, sources] of index) {
        const labels = new Map();
        for (const source of sources) {
            for (const text of source.anchorTexts) {
                const key = lower(text);
                if (!key || key.length < 3) continue;
                if (!labels.has(key)) labels.set(key, { display: norm(text), count: 0 });
                labels.get(key).count += 1;
            }
        }
        // Ignore generic wayfinding labels — they are not entity names.
        const meaningful = [...labels.entries()]
            .filter(([key]) => !/^(here|read more|more|learn more|click here|find out more|back|home|next|previous)$/.test(key));
        if (meaningful.length >= 3) {
            drift.push({
                target,
                labels: meaningful.sort((a, b) => b[1].count - a[1].count).map(([, v]) => v.display),
            });
        }
    }

    if (drift.length) {
        drift.sort((a, b) => b.labels.length - a.labels.length);
        findings.push({
            id: 'anchor-terminology-drift',
            category: 'terminology',
            severity: drift.length > 10 ? 'medium' : 'low',
            title: `${drift.length} pages are referred to by three or more different names`,
            detail: 'Internal links point at the same page using inconsistent wording.',
            why: 'Anchor text is one of the strongest signals of what a page is called. Several competing names for one page split the evidence and blur the entity.',
            evidence: drift.slice(0, MAX_EVIDENCE).map(d => ({
                value: d.labels.slice(0, 5).map(l => `“${l}”`).join(' · '),
                pages: [d.target],
                count: d.labels.length,
            })),
            pagesAffected: drift.length,
        });
    }

    return findings;
}

/**
 * Builds the full consistency report for a scan.
 * @param {string} scanPath
 * @param {string} scan - "<domain>/<date>", echoed back.
 * @returns {Promise<object>}
 */
export async function buildConsistencyReport(scanPath, scan) {
    const pages = await collectPages(scanPath);
    if (pages.length === 0) {
        return { scan, pages: 0, score: null, findings: [], summary: {} };
    }

    const findings = [
        ...checkFacts(pages),
        ...checkMetadata(pages),
        ...checkStructuredData(pages),
        ...await checkTerminology(pages, scanPath),
    ];

    // rating.v2: pillar scores, size normalisation, per-finding point
    // attribution. The old flat penalty is gone — see src/rating.js.
    const rating = rateFindings(findings, pages.length);
    const score = rating.score;

    // rating.v3 (shadow): the v2 findings plus the access and
    // extractability analyzers, scored with reach × confidence under
    // six pillars. Shown score stays v2 until v3 is calibrated
    // (docs/scoring-methodology-v3.md in the coherence repo). The new
    // findings ship in a separate array so consumers persisting the v2
    // category set are unaffected.
    const domain = scan.split('/')[0];
    const { findings: accessFindings, metrics: accessMetrics } =
        await analyzeAccess(scanPath, domain).catch(() => ({ findings: [], metrics: null }));
    const extractabilityFindings = checkExtractability(pages);
    const v3Findings = [...accessFindings, ...extractabilityFindings];
    const ratingV3 = rateFindingsV3([...findings, ...v3Findings], pages.length);

    const summary = { high: 0, medium: 0, low: 0 };
    for (const finding of findings) summary[finding.severity]++;

    const order = { high: 0, medium: 1, low: 2 };
    findings.sort((a, b) => order[a.severity] - order[b.severity] || b.pagesAffected - a.pagesAffected);
    v3Findings.sort((a, b) => order[a.severity] - order[b.severity] || b.pagesAffected - a.pagesAffected);

    return {
        scan,
        pages: pages.length,
        score,
        rating,
        ratingV3,
        v3Findings,
        accessMetrics,
        summary,
        byCategory: {
            facts: findings.filter(f => f.category === 'facts').length,
            metadata: findings.filter(f => f.category === 'metadata').length,
            'structured-data': findings.filter(f => f.category === 'structured-data').length,
            terminology: findings.filter(f => f.category === 'terminology').length,
        },
        findings,
    };
}

/** Cached wrapper keyed on the scan's file state. */
export async function getConsistencyReport(scanPath, scan, token) {
    const cached = reportCache.get(scanPath);
    if (cached && cached.token === token) return cached.report;
    const report = await buildConsistencyReport(scanPath, scan);
    reportCache.set(scanPath, { token, report });
    return report;
}
