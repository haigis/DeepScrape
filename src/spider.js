import fs from 'fs/promises';
import path from 'path';
import { scrapePage, resolveOptions, getBrowser } from './scraper.js';
import { generateOutputDir } from './fileHandler.js';

/**
 * Path scoping for a crawl. Three inputs combine:
 *  - pathPrefix       legacy single include folder (kept for back-compat)
 *  - includePaths[]   folders or exact pages to crawl; empty = whole site
 *  - excludePaths[]   folders or exact pages subtracted afterwards
 * A URL is in scope when it matches any include (or there are none) and
 * no exclude. Paths are normalised to a leading slash, no trailing one.
 *
 * @param {{pathPrefix?: string, includePaths?: string[], excludePaths?: string[]}} options
 * @returns {(url: string) => boolean}
 */
/** Crawl workers: request → env → default 4, clamped to 1-16. */
export const crawlConcurrency = (options = {}) => Math.max(1, Math.min(16,
    Number(options.concurrency) || Number(process.env.DS_CRAWL_CONCURRENCY) || 4));

export function makeScope(options = {}) {
    const normalise = (p) => '/' + String(p).trim().replace(/^\/+|\/+$/g, '');
    const includes = [options.pathPrefix, ...(options.includePaths ?? [])]
        .filter(Boolean)
        .map(normalise);
    const excludes = (options.excludePaths ?? []).filter(Boolean).map(normalise);
    const under = (pathname, prefix) => pathname === prefix || pathname.startsWith(prefix + '/');

    return (url) => {
        try {
            const { pathname } = new URL(url);
            if (includes.length > 0 && !includes.some(p => under(pathname, p))) return false;
            if (excludes.some(p => under(pathname, p))) return false;
            return true;
        } catch {
            return false;
        }
    };
}
import { waitMs } from './utils.js';

/**
 * Checks if the given URL points to an image or disguised image file.
 * @param {string} url - The URL to check.
 * @returns {boolean} - Returns true if the URL is an image.
 */
const isImageUrl = (url) => {
    return /\.(jpg|jpeg|png|gif|svg|webp|bmp|ico)$/i.test(url) ||
           /(\.(jpg|jpeg|png|gif|svg|webp|bmp|ico)\.html?)$/i.test(url) ||
           /(\?|&)img=/.test(url); // Query strings that reference images
};

/**
 * Query parameters that never change the page served — analytics and
 * click-tracking noise. Kept conservative: anything not listed here is
 * assumed to be meaningful (?page=2, ?q=…).
 */
const TRACKING_PARAMS = /^(utm_\w+|gclid|gclsrc|dclid|fbclid|msclkid|mc_[ce]id|igshid|_hs\w+|vero_\w+|yclid|s_kwcid)$/i;

export const normalizeUrl = (url) => {
    const u = new URL(url);
    u.hash = '';

    // Drop tracking params; sort the rest so ?a=1&b=2 and ?b=2&a=1 match.
    const kept = [...u.searchParams.entries()]
        .filter(([key]) => !TRACKING_PARAMS.test(key))
        .sort(([a], [b]) => a.localeCompare(b));
    u.search = '';
    for (const [key, value] of kept) u.searchParams.append(key, value);

    // Trailing-slash twins (/page vs /page/) are one page; keep the root "/".
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
        u.pathname = u.pathname.replace(/\/+$/, '');
    }

    return u.href;
};

/**
 * Spider crawl to recursively scrape pages on the same domain.
 *
 * Depth semantics: the start URL is depth 0; maxDepth is the number of
 * link levels followed from it, inclusive (maxDepth 2 crawls depths 0-2).
 *
 * Writes to the scan directory:
 *  - all-links.txt       every unique link discovered (internal + external)
 *  - broken-links.txt    crawled pages that failed (HTTP >= 400 or navigation error)
 *  - incoming-links.json map of URL -> list of pages that link to it
 *
 * @param {string[]} startUrls - Initial URLs to start crawling.
 * @param {Partial<import('./scraper.js').ScrapeOptions>} options - Scrape options.
 * @returns {Promise<{visited: number, broken: number, outDir: string}|undefined>}
 */
export async function spiderCrawl(startUrls, options = {}) {
    const opts = resolveOptions(options);
    const { rateLimit, maxDepth } = opts;
    const { onProgress, signal, gate } = options;

    const baseScope = makeScope(options);
    const pathPrefix = options.pathPrefix ?? null; // logging only

    /**
     * Live inspection channel (options.live, owned by the API): the
     * spider publishes its URL state through live.getState, and honours
     * excludes pushed into live.dynamicExcludes *mid-crawl* — checked
     * both when queueing new links and when dequeuing already-queued
     * ones, so an exclude takes effect immediately.
     */
    const live = options.live ?? null;
    const dynamicallyExcluded = (url) => {
        const excludes = live?.dynamicExcludes;
        if (!excludes || excludes.length === 0) return false;
        return !makeScope({ excludePaths: excludes })(url);
    };
    const inScope = (url) => baseScope(url) && !dynamicallyExcluded(url);

    if (!startUrls || startUrls.length === 0) {
        console.error('❌ Error: spiderCrawl received an empty startUrls array.');
        return;
    }

    const domain = new URL(startUrls[0]).hostname;
    const outDir = generateOutputDir(startUrls[0]);

    if (!outDir || outDir === 'output/unknown') {
        console.error('❌ Error: Could not determine a valid output directory.');
        return;
    }

    await fs.mkdir(outDir, { recursive: true });

    console.log(`🕷️ Starting spider crawl on: ${startUrls[0]} (maxDepth: ${maxDepth}`
        + `${pathPrefix ? `, scoped to ${pathPrefix}` : ''}`
        + `, workers: ${crawlConcurrency(options)})`);

    const visited = new Set();
    const queued = new Set();
    const queue = [];
    /** sha1(html) -> first URL — shared with scrapePage for content dedupe. */
    const contentHashes = new Map();
    /** url -> the already-saved URL it duplicates. */
    const duplicates = new Map();

    for (const url of startUrls) {
        const normalized = normalizeUrl(url);
        if (!queued.has(normalized)) {
            queued.add(normalized);
            queue.push({ url: normalized, depth: 0 });
        }
    }

    const linksList = new Set();
    const brokenLinks = new Set();
    /** Map of URL -> Set of pages that link to it. */
    const incomingLinks = new Map();
    /** URLs dropped mid-crawl by a live exclude. */
    const excludedLive = [];

    if (live) {
        live.getState = () => ({
            visited: [...visited],
            queued: queue.map(entry => entry.url),
            excluded: [...excludedLive],
        });
    }

    const browser = await getBrowser();

    /**
     * Hard ceiling on pages fetched. Callers billing by page size need a
     * limit the crawler itself enforces — a plan cap that only lives in
     * the calling app is not a cap at all.
     */
    const maxPages = Number(options.maxPages) > 0 ? Number(options.maxPages) : null;
    let limitReached = false;

    /**
     * Concurrent workers over one shared queue. Each scrapePage opens
     * its own tab in the shared browser, so N workers ≈ N× throughput.
     * Single-threaded JS keeps the queue/visited bookkeeping safe; the
     * page cap can overshoot by at most workers−1 pages. Rate limit is
     * per worker — the polite delay a real visitor produces per tab.
     */
    const concurrency = crawlConcurrency(options);
    let inFlight = 0;

    async function worker() {
        for (;;) {
            if (signal?.aborted) return;
            // Park here when a priority job needs the runner — the crawl
            // resumes from this exact point, losing no work.
            await gate?.wait();
            if (maxPages && visited.size >= maxPages) {
                if (!limitReached) console.log(`🛑 Page limit reached (${maxPages}) — stopping crawl.`);
                limitReached = true;
                return;
            }

            const entry = queue.shift();
            if (!entry) {
                // Empty queue: done only once no worker can still enqueue.
                if (inFlight === 0) return;
                await waitMs(50);
                continue;
            }
            const { url, depth } = entry;
            if (visited.has(url) || isImageUrl(url)) continue;
            // A live exclude may have arrived after this URL was queued.
            if (dynamicallyExcluded(url)) {
                excludedLive.push(url);
                continue;
            }

            visited.add(url);
            console.log(`🔍 Crawling: ${url} (Depth: ${depth})`);
            onProgress?.({ done: visited.size, total: visited.size + queue.length, currentUrl: url });

            inFlight++;
            let result;
            try {
                result = await scrapePage(browser, url, outDir, { ...opts, dedupe: contentHashes });
            } finally {
                inFlight--;
            }

            if (!result.ok) {
                // Navigation error or HTTP >= 400 — record and move on.
                // Non-HTML content types are skipped but not "broken".
                if (!result.error?.startsWith('non-HTML')) {
                    console.error(`❌ Broken link: ${url} (${result.error})`);
                    brokenLinks.add(url);
                }
                continue;
            }

            if (result.duplicateOf) {
                duplicates.set(url, result.duplicateOf);
            }

            for (const rawLink of result.links) {
                let link;
                try {
                    link = normalizeUrl(rawLink);
                } catch {
                    continue; // Ignore invalid URLs
                }
                if (link === url) continue;

                linksList.add(link);

                // Record who links to this URL (real incoming-links map).
                if (!incomingLinks.has(link)) incomingLinks.set(link, new Set());
                incomingLinks.get(link).add(url);

                if (isImageUrl(link) || queued.has(link)) continue;

                if (new URL(link).hostname === domain && inScope(link) && depth < maxDepth) {
                    queued.add(link);
                    queue.push({ url: link, depth: depth + 1 });
                }
            }

            if (rateLimit > 0) await waitMs(rateLimit);
        }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    if (signal?.aborted) console.log('⏹ Aborted — stopping crawl.');

    console.log(`✅ Spider crawl completed. Visited ${visited.size} pages, ${brokenLinks.size} broken.`);

    const incomingAsObject = Object.fromEntries(
        [...incomingLinks.entries()].map(([link, sources]) => [link, [...sources]]));

    await fs.writeFile(path.join(outDir, 'all-links.txt'), [...linksList].join('\n'), 'utf8');
    await fs.writeFile(path.join(outDir, 'broken-links.txt'), [...brokenLinks].join('\n'), 'utf8');
    await fs.writeFile(path.join(outDir, 'incoming-links.json'), JSON.stringify(incomingAsObject, null, 2), 'utf8');
    // URL -> canonical URL it duplicated; duplicate-content evidence for
    // the consistency engine, and proof of what was skipped and why.
    await fs.writeFile(
        path.join(outDir, 'duplicate-pages.json'),
        JSON.stringify(Object.fromEntries(duplicates), null, 2),
        'utf8',
    );

    console.log(`📁 Saved crawl results to: ${outDir}`);
    return {
        visited: visited.size,
        saved: visited.size - duplicates.size - brokenLinks.size,
        duplicates: duplicates.size,
        broken: brokenLinks.size,
        outDir,
        aborted: signal?.aborted ?? false,
        limitReached,
        maxPages,
    };
}
