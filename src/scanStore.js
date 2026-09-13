import { promises as fs } from 'fs';
import path from 'path';
import { buildPagePath } from './scraper.js';
import { classifyLinks, resolveChromeSelectors, resolveChromeGroups } from './chrome.js';

/**
 * Read access to scan output on disk: directory trees, per-page details
 * and page history across scans. Everything here works on paths already
 * validated to sit inside the output root (api.js does the validation).
 */

const ARTIFACT_NAMES = new Set(['all-links.txt', 'broken-links.txt', 'incoming-links.json', 'duplicate-pages.json']);

/** Folders holding downloaded assets rather than saved pages. */
const ASSET_FOLDERS = new Set(['images', '_assets']);

/** Caps to keep a single page view cheap on very large pages. */
const MAX_LINKS_ANALYZED = 500;
const MAX_INCOMING_ANALYZED = 100;

/**
 * Classifies an href by scheme so non-navigational links are reported
 * rather than silently dropped.
 * @param {string} href
 * @returns {'page'|'mailto'|'tel'|'script'|'fragment'|'other'}
 */
export function classifyHref(href) {
    const value = href.trim();
    if (/^https?:\/\//i.test(value)) return 'page';
    if (/^mailto:/i.test(value)) return 'mailto';
    if (/^tel:/i.test(value)) return 'tel';
    if (/^javascript:/i.test(value)) return 'script';
    if (value.startsWith('#')) return 'fragment';
    return 'other';
}

/**
 * Extracts links from saved HTML: `<a>` elements and `<area>` image-map
 * links. Saved pages have absolute hrefs (fixRelativePaths runs at
 * scrape time), but every scheme is classified so mailto/tel/javascript
 * and in-page fragments can be counted instead of discarded.
 *
 * @param {string} html
 * @param {{includeNonHttp?: boolean}} [opts]
 * @returns {{href: string, text: string, rel: string, kind: string,
 *            nofollow: boolean, ugc: boolean, sponsored: boolean,
 *            tag: 'a'|'area'}[]}
 */
/** Value of one attribute inside a tag's attribute string, or null. */
const attrValue = (attrs, name) => {
    const match = attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
    return match ? (match[1] ?? match[2] ?? '').trim() || null : null;
};

/** data-* attributes as a plain object, prefix removed, values as strings. */
const dataAttributes = (attrs) => {
    const data = {};
    for (const match of attrs.matchAll(/(?:^|\s)data-([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
        data[match[1].toLowerCase()] = (match[2] ?? match[3] ?? '').trim();
    }
    return data;
};

export function extractAnchors(html, { includeNonHttp = false, chromeSelectors = null } = {}) {
    const links = [];

    // Region lookup (nav/header/footer vs content), keyed by href+text so
    // the cheap regex scan below can be annotated without reparsing.
    let regionOf = null;
    if (chromeSelectors) {
        const classified = classifyLinks(html, chromeSelectors);
        regionOf = new Map();
        for (const link of classified.links) {
            const key = `${link.href} ${link.text}`;
            if (!regionOf.has(key)) regionOf.set(key, link.region);
        }
    }

    const push = (attrs, inner, tag) => {
        const href = attrs.match(/href\s*=\s*"([^"]*)"/i)?.[1]
            ?? attrs.match(/href\s*=\s*'([^']*)'/i)?.[1];
        if (!href) return;

        const kind = classifyHref(href);
        if (kind !== 'page' && !includeNonHttp) return;

        const rel = (attrs.match(/rel\s*=\s*"([^"]*)"/i)?.[1]
            ?? attrs.match(/rel\s*=\s*'([^']*)'/i)?.[1]
            ?? '').toLowerCase();
        const relTokens = rel.split(/\s+/).filter(Boolean);

        const text = (inner ?? '')
            .replace(/<[^>]*>/g, ' ')       // strip nested markup (spans, imgs…)
            .replace(/&nbsp;/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 120)
            // `<area>` has no inner text — fall back to its alt attribute.
            || (tag === 'area' ? (attrs.match(/alt\s*=\s*"([^"]*)"/i)?.[1] ?? '') : '');

        links.push({
            href: href.trim(),
            text,
            rel,
            kind,
            tag,
            region: regionOf?.get(`${href.trim()} ${text}`) ?? 'content',
            nofollow: relTokens.includes('nofollow'),
            ugc: relTokens.includes('ugc'),
            sponsored: relTokens.includes('sponsored'),
            // Identity attributes, so a watched link can be checked for an
            // analytics id or data-* hook that changed by mistake.
            id: attrValue(attrs, 'id'),
            className: attrValue(attrs, 'class'),
            data: dataAttributes(attrs),
        });
    };

    for (const match of html.matchAll(/<a\s([^>]*?)>([\s\S]*?)<\/a>/gi)) {
        push(match[1], match[2], 'a');
    }
    for (const match of html.matchAll(/<area\s([^>]*?)\/?>/gi)) {
        push(match[1], '', 'area');
    }

    return links;
}

/**
 * Maps an absolute URL to the path it would occupy inside a scan
 * directory, using the same rule the scraper saves with.
 * @param {string} url
 * @returns {string|null}
 */
export function urlToScanPath(url) {
    try {
        return buildPagePath(url).replace(/\\/g, '/');
    } catch {
        return null;
    }
}

const stripTrailingSlash = (url) => url.replace(/\/+$/, '');

/** Safety caps for the whole-scan inbound index. */
const MAX_INDEXED_PAGES = Number(process.env.DS_MAX_ANALYZED_PAGES) || 100000;

/** scanPath -> { token, index } — rebuilt when files change. */
const inboundCache = new Map();

/**
 * Lists every saved page in a scan with its mtime (cheap: readdir+stat).
 * @param {string} scanPath
 * @returns {Promise<{rel: string, mtimeMs: number}[]>}
 */
async function listPageFiles(scanPath) {
    const files = [];

    async function walk(dir, rel) {
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }

        const pages = entries.filter(e => !e.isDirectory() && /\.html?$/i.test(e.name));
        const stats = await Promise.all(pages.map(e =>
            fs.stat(path.join(dir, e.name)).catch(() => null)));
        pages.forEach((entry, i) => {
            if (stats[i]) {
                files.push({
                    rel: rel ? `${rel}/${entry.name}` : entry.name,
                    mtimeMs: stats[i].mtimeMs,
                });
            }
        });

        for (const entry of entries) {
            if (!entry.isDirectory() || ASSET_FOLDERS.has(entry.name)) continue;
            await walk(path.join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name);
        }
    }

    await walk(scanPath, '');
    return files;
}

/**
 * Builds (and caches) the scan's inbound link index by reading the
 * anchors of **every saved page** — not just the spider's
 * incoming-links.json, which only covers what one crawl reached and is
 * absent entirely from sitemap/batch scans (see issue #19).
 *
 * @param {string} scanPath
 * @returns {Promise<{index: Map<string, object[]>, pagesIndexed: number, truncated: boolean}>}
 *          index maps a page's scan-relative path to the pages linking to it.
 */
/**
 * Cheap fingerprint of a scan's saved pages (count + newest mtime),
 * used to invalidate derived caches when a scan changes.
 * @param {string} scanPath
 * @returns {Promise<string>}
 */
export async function getScanToken(scanPath) {
    const files = await listPageFiles(scanPath);
    return `${files.length}:${files.reduce((max, f) => Math.max(max, f.mtimeMs), 0)}`;
}

export async function getInboundIndex(scanPath, chromeOverrides = null) {
    const files = await listPageFiles(scanPath);
    // Chrome selectors change what counts as a content link, so they are
    // part of the cache identity.
    const chromeSelectors = Array.isArray(chromeOverrides)
        ? resolveChromeGroups(chromeOverrides)
        : resolveChromeSelectors(chromeOverrides ?? {});
    const chromeKey = JSON.stringify(chromeSelectors);
    const token = `${files.length}:${files.reduce((max, f) => Math.max(max, f.mtimeMs), 0)}:${chromeKey}`;

    const cached = inboundCache.get(scanPath);
    if (cached && cached.token === token) return cached.value;

    const considered = files.slice(0, MAX_INDEXED_PAGES);
    const index = new Map();
    /** path -> { h1, title } so link labels can name the page, not the anchor. */
    const pageMeta = new Map();
    /** target path -> the absolute URL it was first linked with. */
    const targetUrls = new Map();

    // Read in batches so a large scan doesn't open thousands of handles.
    const BATCH = 32;
    for (let i = 0; i < considered.length; i += BATCH) {
        const batch = considered.slice(i, i + BATCH);
        const contents = await Promise.all(batch.map(f =>
            fs.readFile(path.join(scanPath, f.rel), 'utf8').catch(() => null)));

        batch.forEach((file, j) => {
            const html = contents[j];
            if (!html) return;

            const sourceUrl = html.match(/^<!--\s*(https?:\/\/\S+)\s*-->/)?.[1] ?? null;

            // Cheap H1/title capture — we already have the file in memory.
            const h1 = innerText(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? '') || null;
            const title = innerText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '') || null;
            pageMeta.set(file.rel, { h1, title, url: sourceUrl });

            // Collapse repeats of the same target within one source page.
            const perTarget = new Map();
            for (const link of extractAnchors(html, { chromeSelectors })) {
                const cleanHref = stripTrailingSlash(link.href.split('#')[0]);
                const targetRel = urlToScanPath(cleanHref);
                if (!targetRel || targetRel === file.rel) continue;
                if (!targetUrls.has(targetRel)) targetUrls.set(targetRel, cleanHref);

                const entry = perTarget.get(targetRel);
                if (entry) {
                    entry.occurrences++;
                    if (!entry.anchorTexts.includes(link.text) && link.text && entry.anchorTexts.length < 5) {
                        entry.anchorTexts.push(link.text);
                    }
                    entry.nofollow = entry.nofollow && link.nofollow;
                    // A page linked from both its nav and its body counts
                    // as a content link — the editorial one is the signal,
                    // so its identity attributes win too.
                    if (link.region === 'content' && entry.region !== 'content') {
                        entry.region = 'content';
                        entry.id = link.id;
                        entry.className = link.className;
                        entry.data = link.data;
                    }
                } else {
                    perTarget.set(targetRel, {
                        path: file.rel,
                        url: sourceUrl,
                        anchorTexts: link.text ? [link.text] : [],
                        occurrences: 1,
                        nofollow: link.nofollow,
                        region: link.region ?? 'content',
                        scraped: true,
                        id: link.id,
                        className: link.className,
                        data: link.data,
                    });
                }
            }

            for (const [targetRel, entry] of perTarget) {
                if (!index.has(targetRel)) index.set(targetRel, []);
                index.get(targetRel).push(entry);
            }
        });
    }

    // Attach each source's own H1/title so the UI can label a link by the
    // page it comes from rather than by repeated nav anchor text.
    for (const sources of index.values()) {
        for (const source of sources) {
            const meta = pageMeta.get(source.path);
            source.h1 = meta?.h1 ?? null;
            source.title = meta?.title ?? null;
        }
    }

    const value = {
        index,
        pageMeta,
        targetUrls,
        pagesIndexed: considered.length,
        truncated: files.length > MAX_INDEXED_PAGES,
    };
    inboundCache.set(scanPath, { token, value });
    return value;
}

/** URLs the crawl recorded as broken, trailing slashes stripped. */
async function readBrokenSet(scanPath) {
    try {
        const raw = await fs.readFile(path.join(scanPath, 'broken-links.txt'), 'utf8');
        return new Set(raw.split('\n').map(l => stripTrailingSlash(l.trim())).filter(Boolean));
    } catch {
        return new Set();
    }
}

/** A source entry from the inbound index in the shape the link endpoints publish. */
const publishSource = (entry) => ({
    path: entry.path,
    url: entry.url ?? null,
    title: entry.title ?? null,
    text: entry.anchorTexts[0] ?? '',
    region: entry.region ?? 'content',
    nofollow: Boolean(entry.nofollow),
    occurrences: entry.occurrences ?? 1,
    id: entry.id ?? null,
    className: entry.className ?? null,
    data: entry.data ?? {},
});

/** Content-region sources first, then the richest anchors. */
const sortSources = (sources) => [...sources].sort((a, b) =>
    (a.region === 'content' ? 0 : 1) - (b.region === 'content' ? 0 : 1)
    || b.anchorTexts.length - a.anchorTexts.length
    || b.occurrences - a.occurrences
    || (a.path ?? '').localeCompare(b.path ?? ''));

/** Hostnames match when they differ only by a leading www. */
const sameSite = (a, b) => a.replace(/^www\./, '') === b.replace(/^www\./, '');

/**
 * Aggregates one link target from the pages that link to it.
 * @param {string} rel - Target scan path.
 * @param {object[]} sources - Inbound index entries.
 * @param {object} ctx - { domain, pageMeta, targetUrls, brokenSet, maxSources }
 */
function describeTarget(rel, sources, { domain, pageMeta, targetUrls, brokenSet, maxSources }) {
    const meta = pageMeta.get(rel);
    const url = targetUrls.get(rel) ?? meta?.url ?? `https://${rel.replace(/\/index\.html$/i, '/').replace(/\.html?$/i, '')}`;
    let host;
    try {
        host = new URL(url).hostname;
    } catch {
        host = rel.split('/')[0];
    }
    const internal = sameSite(host, domain);
    const scraped = pageMeta.has(rel);
    const regions = {};
    const anchorTexts = [];
    let occurrences = 0;
    let contentInbound = 0;
    let allNofollow = sources.length > 0;
    for (const source of sources) {
        const region = source.region ?? 'content';
        regions[region] = (regions[region] ?? 0) + 1;
        occurrences += source.occurrences ?? 1;
        if (region === 'content') contentInbound++;
        if (!source.nofollow) allNofollow = false;
        for (const text of source.anchorTexts) {
            if (text && !anchorTexts.includes(text) && anchorTexts.length < 5) anchorTexts.push(text);
        }
    }
    return {
        url,
        host,
        internal,
        path: internal ? rel : null,
        scraped,
        broken: internal && !scraped && brokenSet.has(stripTrailingSlash(url)),
        title: meta?.title ?? null,
        h1: meta?.h1 ?? null,
        inbound: sources.length,
        contentInbound,
        occurrences,
        nofollow: allNofollow,
        regions,
        anchorTexts,
        sources: sortSources(sources).slice(0, maxSources).map(publishSource),
    };
}

/** Sort/filter caps for the link inventory. */
const INVENTORY_SOURCES = 10;
const CHECK_SOURCES = 100;
const MAX_CHECK_URLS = 500;

/**
 * Every link target in a scan, aggregated from the anchors of all saved
 * pages: who links to it, from which regions, with what text and which
 * identity attributes — plus the saved pages nobody links to (orphans).
 * Filters and pagination are applied here so a 10k-page site never has
 * to ship its whole graph to the caller.
 *
 * @param {string} scanPath
 * @param {string} scan - "<domain>/<date>"
 * @param {{type?: string, q?: string, region?: string, limit?: number, offset?: number, sort?: string}} [opts]
 * @param {object|object[]|null} [chromeOverrides]
 */
export async function getLinkInventory(scanPath, scan, opts = {}, chromeOverrides = null) {
    const domain = scan.split('/')[0];
    const { index, pageMeta, targetUrls, pagesIndexed, truncated } = await getInboundIndex(scanPath, chromeOverrides);
    const brokenSet = await readBrokenSet(scanPath);
    const ctx = { domain, pageMeta, targetUrls, brokenSet, maxSources: INVENTORY_SOURCES };

    const all = [];
    for (const [rel, sources] of index) all.push(describeTarget(rel, sources, ctx));
    for (const rel of pageMeta.keys()) {
        if (!index.has(rel)) all.push(describeTarget(rel, [], ctx));
    }

    const hostPages = new Map();
    for (const target of all) {
        if (target.internal) continue;
        const bucket = hostPages.get(target.host) ?? { host: target.host, links: 0, pages: new Set() };
        bucket.links++;
        for (const source of index.get(urlToScanPath(target.url)) ?? []) bucket.pages.add(source.path);
        hostPages.set(target.host, bucket);
    }
    const externalHosts = [...hostPages.values()]
        .map(({ host, links, pages }) => ({ host, links, pages: pages.size }))
        .sort((a, b) => b.pages - a.pages || b.links - a.links || a.host.localeCompare(b.host));

    const counts = {
        targets: all.length,
        internal: all.filter(t => t.internal).length,
        external: all.filter(t => !t.internal).length,
        broken: all.filter(t => t.broken).length,
        notScraped: all.filter(t => t.internal && !t.scraped && !t.broken).length,
        orphans: all.filter(t => t.scraped && t.inbound === 0).length,
        externalHosts: externalHosts.length,
        nofollow: all.filter(t => t.nofollow).length,
    };

    const type = opts.type ?? 'all';
    const q = (opts.q ?? '').trim().toLowerCase();
    let matches = all.filter(t => {
        if (type === 'internal' && !t.internal) return false;
        if (type === 'external' && t.internal) return false;
        if (type === 'broken' && !t.broken) return false;
        if (type === 'orphan' && !(t.scraped && t.inbound === 0)) return false;
        if (opts.region === 'content' && t.contentInbound === 0) return false;
        if (opts.region === 'chrome' && !(t.contentInbound === 0 && t.inbound > 0)) return false;
        if (q && !(t.url.toLowerCase().includes(q)
            || t.anchorTexts.some(text => text.toLowerCase().includes(q))
            || (t.title ?? '').toLowerCase().includes(q))) return false;
        return true;
    });

    matches = opts.sort === 'url'
        ? matches.sort((a, b) => a.url.localeCompare(b.url))
        : matches.sort((a, b) => Number(b.broken) - Number(a.broken) || b.inbound - a.inbound || a.url.localeCompare(b.url));

    const limit = Math.min(Math.max(Number(opts.limit) || 200, 1), 1000);
    const offset = Math.max(Number(opts.offset) || 0, 0);

    return {
        scan,
        pagesIndexed,
        indexTruncated: truncated,
        counts,
        total: matches.length,
        offset,
        limit,
        links: matches.slice(offset, offset + limit),
        externalHosts,
    };
}

/**
 * Current state of specific links in a scan — for watched links and
 * journeys, so a caller can compare the same URLs across scans.
 *
 * @param {string} scanPath
 * @param {string} scan
 * @param {string[]} urls - Absolute URLs (fragments and trailing slashes are ignored).
 * @param {object|object[]|null} [chromeOverrides]
 */
export async function checkLinks(scanPath, scan, urls, chromeOverrides = null) {
    const domain = scan.split('/')[0];
    const { index, pageMeta, targetUrls } = await getInboundIndex(scanPath, chromeOverrides);
    const brokenSet = await readBrokenSet(scanPath);
    const ctx = { domain, pageMeta, targetUrls, brokenSet, maxSources: CHECK_SOURCES };

    return urls.slice(0, MAX_CHECK_URLS).map(raw => {
        const url = stripTrailingSlash(String(raw).split('#')[0].trim());
        const rel = urlToScanPath(url);
        if (!rel) {
            return { url, found: false, internal: false, scraped: false, broken: false, inbound: 0, contentInbound: 0, anchorTexts: [], sources: [] };
        }
        const sources = index.get(rel) ?? [];
        // Describe against the caller's URL, not the first-linked variant,
        // so the echo is exact.
        const target = describeTarget(rel, sources, { ...ctx, targetUrls: new Map([[rel, url]]) });
        return {
            url,
            found: sources.length > 0,
            internal: target.internal,
            scraped: target.scraped,
            broken: target.internal && !target.scraped && brokenSet.has(url),
            inbound: target.inbound,
            contentInbound: target.contentInbound,
            anchorTexts: target.anchorTexts,
            sources: target.sources,
        };
    });
}

/** Collapses markup and whitespace inside an element's inner HTML. */
const innerText = (html) => html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Parses an HTML attribute string into a lowercase-keyed object.
 * @param {string} attrString
 * @returns {Record<string, string>}
 */
function parseAttrs(attrString) {
    const attrs = {};
    for (const m of attrString.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
        attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
    }
    return attrs;
}

/** Robots directives DeepScrape reports on. */
const ROBOTS_DIRECTIVES = ['noindex', 'nofollow', 'none', 'noarchive', 'nosnippet', 'noimageindex', 'notranslate'];

/**
 * Extracts on-page SEO metadata from saved HTML: title, headings,
 * meta description, robots directives, canonical and language.
 *
 * Note: only the *meta tag* is visible here — the HTTP `X-Robots-Tag`
 * header is not captured at scrape time (see docs/16-page-seo.md).
 *
 * @param {string} html
 * @returns {object}
 */
export function extractPageMeta(html) {
    const metas = [...html.matchAll(/<meta\s([^>]*?)\/?>/gi)].map(m => parseAttrs(m[1]));
    const links = [...html.matchAll(/<link\s([^>]*?)\/?>/gi)].map(m => parseAttrs(m[1]));

    const metaByName = (name) => metas.find(m => (m.name ?? '').toLowerCase() === name)?.content ?? null;

    const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
    const h1s = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)]
        .map(m => innerText(m[1]))
        .filter(Boolean);
    const h2Count = [...html.matchAll(/<h2[\s>]/gi)].length;

    const description = metaByName('description');

    // robots + googlebot directives are merged; `none` implies noindex,nofollow.
    const robotsRaw = metaByName('robots');
    const googlebotRaw = metaByName('googlebot');
    const tokens = [robotsRaw, googlebotRaw]
        .filter(Boolean)
        .flatMap(value => value.split(',').map(t => t.trim().toLowerCase()));

    const robots = { raw: robotsRaw, googlebot: googlebotRaw, directives: [] };
    for (const directive of ROBOTS_DIRECTIVES) {
        const present = tokens.includes(directive) || (directive !== 'none' && tokens.includes('none') &&
            (directive === 'noindex' || directive === 'nofollow'));
        robots[directive === 'none' ? 'none' : directive] = present;
        if (present && directive !== 'none') robots.directives.push(directive);
    }

    const canonical = links.find(l => (l.rel ?? '').toLowerCase() === 'canonical')?.href ?? null;

    return {
        title: title != null ? innerText(title) : null,
        titleLength: title != null ? innerText(title).length : 0,
        h1s,
        h1Count: h1s.length,
        h2Count,
        description,
        descriptionLength: description ? description.length : 0,
        robots,
        canonical,
        lang: html.match(/<html\s([^>]*)>/i) ? parseAttrs(html.match(/<html\s([^>]*)>/i)[1]).lang ?? null : null,
    };
}

/**
 * Cross-references robots directives against the crawl's link graph:
 * a noindex page that other pages still link to is reachable but
 * excluded from search — the case worth surfacing.
 *
 * @param {object} meta - Result of extractPageMeta().
 * @param {object[]} incoming - Detailed incoming links.
 * @param {object[]} internalOut - Detailed internal outgoing links.
 * @param {string|null} url - This page's URL.
 * @returns {object}
 */
export function assessDiscoverability(meta, incoming, internalOut, url) {
    const inboundFollowed = incoming.filter(i => !i.nofollow).length;
    const inboundNofollow = incoming.length - inboundFollowed;

    const indexable = !meta.robots.noindex;
    const canonicalisedAway = !!(meta.canonical && url &&
        stripTrailingSlash(meta.canonical) !== stripTrailingSlash(url));

    let status;
    if (!indexable && inboundFollowed > 0) status = 'noindex-but-linked';
    else if (!indexable) status = 'noindex';
    else if (canonicalisedAway) status = 'canonicalised-away';
    else if (incoming.length === 0) status = 'orphan';
    else if (inboundFollowed === 0) status = 'nofollow-links-only';
    else status = 'indexable-and-linked';

    const notes = [];
    if (!indexable && inboundFollowed > 0) {
        notes.push(`Excluded from search by meta robots noindex, but still reachable — ${inboundFollowed} followed internal link${inboundFollowed === 1 ? ' points' : 's point'} here.`);
    }
    if (!indexable && inboundFollowed === 0 && inboundNofollow > 0) {
        notes.push(`noindex, and the only ${inboundNofollow} internal link${inboundNofollow === 1 ? '' : 's'} pointing here ${inboundNofollow === 1 ? 'is' : 'are'} nofollow.`);
    }
    if (indexable && incoming.length === 0) {
        notes.push('Orphan: no page in this scan links here, so crawlers can only find it via a sitemap or external link.');
    }
    if (indexable && incoming.length > 0 && inboundFollowed === 0) {
        notes.push(`Every one of the ${incoming.length} internal links pointing here is nofollow — link equity is not passed.`);
    }
    if (meta.robots.nofollow && internalOut.length > 0) {
        notes.push(`meta robots nofollow: the ${internalOut.length} internal link${internalOut.length === 1 ? '' : 's'} on this page are not followed.`);
    }
    if (canonicalisedAway) {
        notes.push(`Canonical points elsewhere (${meta.canonical}) — this URL is not the indexed version.`);
    }
    if (meta.h1Count === 0) notes.push('No H1 heading.');
    if (meta.h1Count > 1) notes.push(`${meta.h1Count} H1 headings — expected one.`);
    if (!meta.description) notes.push('No meta description.');
    else if (meta.descriptionLength > 160) notes.push(`Meta description is ${meta.descriptionLength} characters — likely truncated in results.`);
    else if (meta.descriptionLength < 50) notes.push(`Meta description is only ${meta.descriptionLength} characters.`);
    if (!meta.title) notes.push('No <title>.');

    return {
        status,
        indexable,
        followable: !meta.robots.nofollow,
        canonicalisedAway,
        inboundTotal: incoming.length,
        inboundFollowed,
        inboundNofollow,
        internalOutgoing: internalOut.length,
        notes,
        // Only the meta tag is observable in saved HTML.
        headerRobotsChecked: false,
    };
}

/**
 * Reads the original URL from a saved page (first line: <!-- url -->).
 * @param {string} filePath
 * @returns {Promise<string|null>}
 */
export async function readPageUrl(filePath) {
    let handle;
    try {
        handle = await fs.open(filePath, 'r');
        const { buffer, bytesRead } = await handle.read(Buffer.alloc(2048), 0, 2048, 0);
        const head = buffer.subarray(0, bytesRead).toString('utf8');
        const match = head.match(/^<!--\s*(https?:\/\/\S+)\s*-->/);
        return match ? match[1] : null;
    } catch {
        return null;
    } finally {
        await handle?.close();
    }
}

/**
 * Builds a nested directory tree of the saved pages in one scan.
 * Directories carry recursive page counts so the UI can show sizes
 * without expanding; only saved pages (.html/.htm) become leaf nodes.
 *
 * @param {string} scanPath - Absolute path of the scan directory
 *                            (output/<domain>/<date>).
 * @returns {Promise<{tree: object, stats: object}>}
 */
export async function buildScanTree(scanPath) {
    const stats = { pages: 0, screenshots: 0, images: 0, artifacts: [], brokenLinks: 0 };

    async function walk(dir, relPrefix) {
        const node = { name: path.basename(dir), type: 'dir', path: relPrefix, pages: 0, children: [] };
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            return node;
        }

        entries.sort((a, b) => a.name.localeCompare(b.name));

        for (const entry of entries) {
            const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                if (entry.name === 'images') {
                    const imgs = await fs.readdir(path.join(dir, entry.name)).catch(() => []);
                    stats.images += imgs.length;
                    continue; // image assets are counted, not shown in the page tree
                }
                if (ASSET_FOLDERS.has(entry.name)) continue; // offline asset store
                const child = await walk(path.join(dir, entry.name), rel);
                if (child.pages > 0) {
                    node.children.push(child);
                    node.pages += child.pages;
                }
            } else if (/\.html?$/i.test(entry.name)) {
                stats.pages++;
                node.pages++;
                node.children.push({ name: entry.name, type: 'page', path: rel });
            } else if (/\.webp$/i.test(entry.name)) {
                stats.screenshots++;
            } else if (ARTIFACT_NAMES.has(entry.name)) {
                stats.artifacts.push(rel);
            }
        }

        // Pages before subdirectories at each level, both alphabetical.
        node.children.sort((a, b) =>
            a.type === b.type ? a.name.localeCompare(b.name) : (a.type === 'page' ? -1 : 1));

        return node;
    }

    const tree = await walk(scanPath, '');
    tree.name = '/';

    const brokenFile = path.join(scanPath, 'broken-links.txt');
    try {
        const broken = await fs.readFile(brokenFile, 'utf8');
        stats.brokenLinks = broken.split('\n').filter(Boolean).length;
    } catch { /* no crawl artifacts in this scan */ }

    return { tree, stats };
}

/**
 * Detailed information about one saved page in one scan.
 *
 * @param {string} scanPath - Absolute scan directory.
 * @param {string} scan - Scan identifier "<domain>/<date>" (for URLs).
 * @param {string} pagePath - Page path relative to the scan dir (validated).
 * @returns {Promise<object|null>} - null when the page does not exist.
 */
export async function getPageDetails(scanPath, scan, pagePath, chromeOverrides = null) {
    const absPage = path.join(scanPath, pagePath);

    let stat;
    try {
        stat = await fs.stat(absPage);
    } catch {
        return null;
    }

    const url = await readPageUrl(absPage);

    const webpRel = pagePath.replace(/\.html?$/i, '.webp');
    const hasScreenshot = await fs.access(path.join(scanPath, webpRel)).then(() => true, () => false);

    const selfHost = url ? new URL(url).hostname : pagePath.split('/')[0];

    // Broken links recorded by the crawl, for flagging outgoing targets.
    let brokenSet = new Set();
    try {
        const raw = await fs.readFile(path.join(scanPath, 'broken-links.txt'), 'utf8');
        brokenSet = new Set(raw.split('\n').map(l => stripTrailingSlash(l.trim())).filter(Boolean));
    } catch { /* no crawl artifacts */ }

    const chromeSelectors = Array.isArray(chromeOverrides)
        ? resolveChromeGroups(chromeOverrides)
        : resolveChromeSelectors(chromeOverrides ?? {});
    const { pageMeta } = await getInboundIndex(scanPath, chromeOverrides);
    const links = await analyzeOutgoing(absPage, scanPath, scan, selfHost, brokenSet, url, pageMeta, chromeSelectors);
    const incomingDetailed = await analyzeIncoming(scanPath, scan, pagePath, url, chromeOverrides);

    let meta = null;
    try {
        meta = extractPageMeta(await fs.readFile(absPage, 'utf8'));
    } catch { /* unreadable page */ }
    const discoverability = meta
        ? assessDiscoverability(meta, incomingDetailed, links.internal, url)
        : null;

    return {
        scan,
        path: pagePath,
        url,
        size: stat.size,
        modified: stat.mtime.toISOString(),
        htmlUrl: `/output/${scan}/${pagePath}`,
        screenshotUrl: hasScreenshot ? `/output/${scan}/${webpRel}` : null,
        meta,
        discoverability,
        // Plain URL lists kept for callers that only need counts.
        incoming: incomingDetailed.map(i => i.url),
        outgoing: [...links.internal.map(l => l.url), ...links.external.map(l => l.url)],
        links: {
            incoming: incomingDetailed,
            internal: links.internal,
            external: links.external,
            externalHosts: links.externalHosts,
            other: links.other,
            counts: {
                incoming: incomingDetailed.length,
                // Chrome links repeat sitewide; content links are the signal.
                incomingContent: incomingDetailed.filter(i => (i.region ?? 'content') === 'content').length,
                incomingChrome: incomingDetailed.filter(i => (i.region ?? 'content') !== 'content').length,
                internal: links.internal.length,
                external: links.external.length,
                externalHosts: links.externalHosts.length,
                other: links.other.length,
                brokenOut: links.internal.filter(l => l.broken).length,
                notScraped: links.internal.filter(l => !l.scraped && !l.broken).length,
                nofollow: [...links.internal, ...links.external].filter(l => l.nofollow).length,
                truncated: links.truncated,
                indexTruncated: !!incomingDetailed.truncatedIndex,
            },
        },
    };
}

/**
 * Parses a saved page's anchors into internal/external links, resolving
 * internal targets to their place in the scan (scraped? broken?) and
 * grouping external links by host.
 */
async function analyzeOutgoing(absPage, scanPath, scan, selfHost, brokenSet, selfUrl, pageMeta = new Map(), chromeSelectors = null) {
    let anchors;
    try {
        anchors = extractAnchors(await fs.readFile(absPage, 'utf8'), { includeNonHttp: true, chromeSelectors });
    } catch {
        return { internal: [], external: [], externalHosts: [], other: [], truncated: false };
    }

    // Non-navigational links (mailto:, tel:, javascript:, #fragment) are
    // counted separately rather than silently dropped.
    const otherByHref = new Map();
    for (const anchor of anchors.filter(a => a.kind !== 'page')) {
        const existing = otherByHref.get(anchor.href);
        if (existing) existing.occurrences++;
        else otherByHref.set(anchor.href, { url: anchor.href, text: anchor.text, kind: anchor.kind, occurrences: 1 });
    }
    const other = [...otherByHref.values()];

    // Dedupe by URL, keeping the first non-empty anchor text and
    // counting how often the page links to the same target.
    const byUrl = new Map();
    for (const anchor of anchors.filter(a => a.kind === 'page')) {
        const clean = stripTrailingSlash(anchor.href.split('#')[0]);
        if (!clean || (selfUrl && clean === stripTrailingSlash(selfUrl))) continue;
        const existing = byUrl.get(clean);
        if (existing) {
            existing.occurrences++;
            if (!existing.text && anchor.text) existing.text = anchor.text;
        } else {
            byUrl.set(clean, {
                url: clean,
                text: anchor.text,
                nofollow: anchor.nofollow,
                region: anchor.region ?? 'content',
                ugc: anchor.ugc,
                sponsored: anchor.sponsored,
                occurrences: 1,
            });
        }
    }

    const all = [...byUrl.values()];
    const truncated = all.length > MAX_LINKS_ANALYZED;
    const internal = [];
    const external = [];
    const hostCounts = new Map();

    for (const link of all.slice(0, MAX_LINKS_ANALYZED)) {
        let host;
        try {
            host = new URL(link.url).hostname;
        } catch {
            continue;
        }

        if (host === selfHost) {
            const rel = urlToScanPath(link.url);
            const scraped = rel
                ? await fs.access(path.join(scanPath, rel)).then(() => true, () => false)
                : false;
            const targetMeta = rel ? pageMeta.get(rel) : null;
            internal.push({
                ...link,
                host,
                path: rel,
                scraped,
                h1: targetMeta?.h1 ?? null,
                title: targetMeta?.title ?? null,
                broken: brokenSet.has(link.url),
                pageUrl: scraped && rel
                    ? `/page.html?scan=${encodeURIComponent(scan)}&path=${encodeURIComponent(rel)}`
                    : null,
            });
        } else {
            external.push({ ...link, host });
            hostCounts.set(host, (hostCounts.get(host) ?? 0) + 1);
        }
    }

    const externalHosts = [...hostCounts.entries()]
        .map(([host, count]) => ({ host, count }))
        .sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));

    internal.sort((a, b) => Number(b.broken) - Number(a.broken) || a.url.localeCompare(b.url));
    external.sort((a, b) => a.host.localeCompare(b.host) || a.url.localeCompare(b.url));

    return { internal, external, externalHosts, other, truncated };
}

/**
 * Resolves the pages that link to this one.
 *
 * Sources come from the whole-scan inbound index (every saved page's
 * anchors), unioned with the spider's incoming-links.json so pages the
 * crawl saw but did not save are still reported.
 */
async function analyzeIncoming(scanPath, scan, pagePath, url, chromeOverrides = null) {
    const { index, truncated } = await getInboundIndex(scanPath, chromeOverrides);
    const byPath = new Map();

    for (const entry of index.get(pagePath) ?? []) {
        byPath.set(entry.path, {
            ...entry,
            pageUrl: `/page.html?scan=${encodeURIComponent(scan)}&path=${encodeURIComponent(entry.path)}`,
        });
    }

    // Union with the crawl artifact: it may name sources that were never
    // saved as pages (e.g. crawl stopped before reaching them).
    if (url) {
        try {
            const map = JSON.parse(await fs.readFile(path.join(scanPath, 'incoming-links.json'), 'utf8'));
            const sources = map[url] ?? map[stripTrailingSlash(url)] ?? map[url + '/'] ?? [];
            for (const sourceUrl of sources) {
                const rel = urlToScanPath(sourceUrl);
                if (rel && byPath.has(rel)) continue; // already indexed, with richer data
                const key = rel ?? sourceUrl;
                if (byPath.has(key)) continue;
                byPath.set(key, {
                    path: rel,
                    url: sourceUrl,
                    anchorTexts: [],
                    occurrences: 1,
                    nofollow: false,
                    scraped: false,
                    pageUrl: null,
                    fromCrawlOnly: true,
                });
            }
        } catch { /* not a spider scan */ }
    }

    const results = [...byPath.values()]
        // Content links first — a link written in a page's body says far
        // more than the same target appearing in every page's nav.
        .sort((a, b) => (a.region === 'content' ? 0 : 1) - (b.region === 'content' ? 0 : 1)
            || b.anchorTexts.length - a.anchorTexts.length
            || b.occurrences - a.occurrences
            || (a.path ?? a.url ?? '').localeCompare(b.path ?? b.url ?? ''));

    results.truncatedIndex = truncated;
    return results.slice(0, MAX_INCOMING_ANALYZED);
}

/**
 * History of one page across every scan of a domain: which scan dates
 * contain it and how it changed (size, screenshot availability).
 *
 * @param {string} domainRoot - Absolute path of output/<domain>.
 * @param {string} domain
 * @param {string} pagePath - Page path relative to a scan dir.
 * @returns {Promise<object[]>} - Newest first.
 */
export async function getPageHistory(domainRoot, domain, pagePath) {
    let dates;
    try {
        dates = await fs.readdir(domainRoot, { withFileTypes: true });
    } catch {
        return [];
    }

    const history = [];
    for (const entry of dates) {
        if (!entry.isDirectory()) continue;
        const date = entry.name;
        const absPage = path.join(domainRoot, date, pagePath);

        let stat;
        try {
            stat = await fs.stat(absPage);
        } catch {
            continue; // page not present in this scan
        }

        const webpRel = pagePath.replace(/\.html?$/i, '.webp');
        const hasScreenshot = await fs
            .access(path.join(domainRoot, date, webpRel))
            .then(() => true, () => false);

        history.push({
            scan: `${domain}/${date}`,
            date,
            size: stat.size,
            modified: stat.mtime.toISOString(),
            htmlUrl: `/output/${domain}/${date}/${pagePath}`,
            screenshotUrl: hasScreenshot ? `/output/${domain}/${date}/${webpRel}` : null,
        });
    }

    history.sort((a, b) => b.date.localeCompare(a.date));

    // Size delta vs the previous (older) scan of the same page.
    for (let i = 0; i < history.length; i++) {
        const older = history[i + 1];
        history[i].sizeDelta = older ? history[i].size - older.size : null;
    }

    return history;
}
