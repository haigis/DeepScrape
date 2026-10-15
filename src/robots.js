/**
 * robots.txt for the crawler: which paths it may fetch, and how slowly.
 *
 * Follows the RFC 9309 matching rules that matter in practice: the most
 * specific user-agent group wins, the longest matching rule wins, and an
 * Allow beats a Disallow of equal length. `*` and a trailing `$` work in
 * patterns. Crawl-delay is honoured (it is not in the RFC, but major
 * sites publish it and a polite crawler reads it).
 *
 * A missing robots.txt (404) means everything is allowed. A robots.txt
 * that cannot be fetched at all (5xx, timeout) is treated as allow-all
 * too, rather than blocking the scan — but the caller is told, so it can
 * say so.
 */

/** Our product token, matched against `User-agent:` lines. */
export const ROBOTS_TOKEN = 'DeepScrape';

/**
 * @param {string} text
 * @returns {{agents: string[], rules: {allow: boolean, pattern: string}[], crawlDelay: number|null}[]}
 */
export function parseRobotsGroups(text) {
    const groups = [];
    let current = null;
    let lastWasAgent = false;
    for (const raw of String(text).split(/\r?\n/)) {
        const line = raw.replace(/#.*$/, '').trim();
        if (!line) continue;
        const idx = line.indexOf(':');
        if (idx < 0) continue;
        const field = line.slice(0, idx).trim().toLowerCase();
        const value = line.slice(idx + 1).trim();
        if (field === 'user-agent') {
            if (!current || !lastWasAgent) {
                current = { agents: [], rules: [], crawlDelay: null };
                groups.push(current);
            }
            current.agents.push(value.toLowerCase());
            lastWasAgent = true;
            continue;
        }
        lastWasAgent = false;
        if (!current) continue;
        if (field === 'allow' || field === 'disallow') {
            // An empty Disallow means "allow everything" — no rule at all.
            if (value) current.rules.push({ allow: field === 'allow', pattern: value });
        } else if (field === 'crawl-delay') {
            const seconds = Number(value);
            if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelay = seconds;
        }
    }
    return groups;
}

function patternToRegExp(pattern) {
    const anchored = pattern.endsWith('$');
    const body = (anchored ? pattern.slice(0, -1) : pattern)
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*');
    return new RegExp('^' + body + (anchored ? '$' : ''));
}

/**
 * @param {string} text - robots.txt body ('' = no restrictions).
 * @param {string} [token] - our user-agent product token.
 * @returns {{allowed: (pathAndQuery: string) => boolean, crawlDelayMs: number|null}}
 */
export function createRobots(text, token = ROBOTS_TOKEN) {
    const groups = parseRobotsGroups(text);
    const wanted = token.toLowerCase();
    // Most specific group: our token, else '*'. Groups naming us share
    // their rules.
    const pick = (match) => groups.filter(g => g.agents.some(match));
    let applicable = pick(a => a !== '*' && wanted.includes(a));
    if (applicable.length === 0) applicable = pick(a => a === '*');

    const rules = applicable.flatMap(g => g.rules)
        .map(r => ({ ...r, re: patternToRegExp(r.pattern), len: r.pattern.length }));
    const delay = applicable.map(g => g.crawlDelay).find(d => d != null);

    return {
        allowed(pathAndQuery) {
            let best = null;
            for (const rule of rules) {
                if (!rule.re.test(pathAndQuery)) continue;
                if (!best || rule.len > best.len || (rule.len === best.len && rule.allow)) best = rule;
            }
            return best ? best.allow : true;
        },
        crawlDelayMs: delay != null ? Math.round(delay * 1000) : null,
    };
}

/**
 * Fetches and parses https://<host>/robots.txt.
 * @param {string} origin - e.g. https://www.example.com
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number, userAgent?: string}} [opts]
 * @returns {Promise<ReturnType<typeof createRobots> & {status: 'present'|'absent'|'unavailable'}>}
 */
export async function loadRobots(origin, opts = {}) {
    const { fetchImpl = fetch, timeoutMs = 8000, userAgent } = opts;
    try {
        const res = await fetchImpl(new URL('/robots.txt', origin).href, {
            signal: AbortSignal.timeout(timeoutMs),
            headers: userAgent ? { 'user-agent': userAgent } : undefined,
            redirect: 'follow',
        });
        if (res.status === 404 || res.status === 410) {
            return { ...createRobots(''), status: 'absent' };
        }
        if (!res.ok) return { ...createRobots(''), status: 'unavailable' };
        // Cap the body: a hostile or broken robots.txt must not eat memory.
        const text = (await res.text()).slice(0, 512 * 1024);
        return { ...createRobots(text), status: 'present' };
    } catch {
        return { ...createRobots(''), status: 'unavailable' };
    }
}
