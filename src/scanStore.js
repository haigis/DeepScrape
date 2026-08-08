import { promises as fs } from 'fs';
import path from 'path';
import { buildPagePath } from './scraper.js';

/**
 * Read access to scan output on disk: directory trees, per-page details
 * and page history across scans. Everything here works on paths already
 * validated to sit inside the output root (api.js does the validation).
 */

const ARTIFACT_NAMES = new Set(['all-links.txt', 'broken-links.txt', 'incoming-links.json']);

/** Caps to keep a single page view cheap on very large pages. */
const MAX_LINKS_ANALYZED = 500;
const MAX_INCOMING_ANALYZED = 100;

/**
 * Extracts anchors from saved HTML: href, visible text and rel.
 * Saved pages have absolute hrefs (fixRelativePaths runs at scrape time).
 * @param {string} html
 * @returns {{href: string, text: string, rel: string}[]}
 */
export function extractAnchors(html) {
    const anchors = [];
    for (const match of html.matchAll(/<a\s([^>]*?)>([\s\S]*?)<\/a>/gi)) {
        const [, attrs, inner] = match;
        const href = attrs.match(/href\s*=\s*"([^"]*)"/i)?.[1]
            ?? attrs.match(/href\s*=\s*'([^']*)'/i)?.[1];
        if (!href || !/^https?:\/\//i.test(href)) continue;

        const text = inner
            .replace(/<[^>]*>/g, ' ')       // strip nested markup (spans, imgs…)
            .replace(/&nbsp;/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 120);

        anchors.push({
            href,
            text,
            rel: attrs.match(/rel\s*=\s*"([^"]*)"/i)?.[1]?.toLowerCase() ?? '',
        });
    }
    return anchors;
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
export async function getPageDetails(scanPath, scan, pagePath) {
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

    const links = await analyzeOutgoing(absPage, scanPath, scan, selfHost, brokenSet, url);
    const incomingDetailed = await analyzeIncoming(scanPath, scan, url);

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
            counts: {
                incoming: incomingDetailed.length,
                internal: links.internal.length,
                external: links.external.length,
                externalHosts: links.externalHosts.length,
                brokenOut: links.internal.filter(l => l.broken).length,
                notScraped: links.internal.filter(l => !l.scraped && !l.broken).length,
                nofollow: [...links.internal, ...links.external].filter(l => l.nofollow).length,
                truncated: links.truncated,
            },
        },
    };
}

/**
 * Parses a saved page's anchors into internal/external links, resolving
 * internal targets to their place in the scan (scraped? broken?) and
 * grouping external links by host.
 */
async function analyzeOutgoing(absPage, scanPath, scan, selfHost, brokenSet, selfUrl) {
    let anchors;
    try {
        anchors = extractAnchors(await fs.readFile(absPage, 'utf8'));
    } catch {
        return { internal: [], external: [], externalHosts: [], truncated: false };
    }

    // Dedupe by URL, keeping the first non-empty anchor text and
    // counting how often the page links to the same target.
    const byUrl = new Map();
    for (const anchor of anchors) {
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
                nofollow: anchor.rel.includes('nofollow'),
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
            internal.push({
                ...link,
                host,
                path: rel,
                scraped,
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

    return { internal, external, externalHosts, truncated };
}

/**
 * Resolves the pages that link to this one, recovering the anchor text
 * each source used and linking through to the source's own dashboard.
 */
async function analyzeIncoming(scanPath, scan, url) {
    if (!url) return [];

    let sources = [];
    try {
        const map = JSON.parse(await fs.readFile(path.join(scanPath, 'incoming-links.json'), 'utf8'));
        sources = map[url] ?? map[stripTrailingSlash(url)] ?? map[url + '/'] ?? [];
    } catch {
        return []; // not a spider scan
    }

    const target = stripTrailingSlash(url);
    const results = [];

    for (const sourceUrl of sources.slice(0, MAX_INCOMING_ANALYZED)) {
        const rel = urlToScanPath(sourceUrl);
        const entry = {
            url: sourceUrl,
            path: rel,
            anchorTexts: [],
            occurrences: 0,
            nofollow: false,
            scraped: false,
            pageUrl: null,
        };

        if (rel) {
            const abs = path.join(scanPath, rel);
            try {
                const anchors = extractAnchors(await fs.readFile(abs, 'utf8'))
                    .filter(a => stripTrailingSlash(a.href.split('#')[0]) === target);
                entry.scraped = true;
                entry.occurrences = anchors.length;
                entry.nofollow = anchors.length > 0 && anchors.every(a => a.rel.includes('nofollow'));
                entry.anchorTexts = [...new Set(anchors.map(a => a.text).filter(Boolean))].slice(0, 5);
                entry.pageUrl = `/page.html?scan=${encodeURIComponent(scan)}&path=${encodeURIComponent(rel)}`;
            } catch { /* source page not saved in this scan */ }
        }

        results.push(entry);
    }

    // Sources that actually name the page (anchor text) first.
    results.sort((a, b) => b.anchorTexts.length - a.anchorTexts.length || a.url.localeCompare(b.url));
    return results;
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
