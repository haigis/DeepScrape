import fs from 'fs/promises';
import path from 'path';
import { scrapePage, resolveOptions, getBrowser } from './scraper.js';
import { generateOutputDir } from './fileHandler.js';
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
 * Strips URL fragments so /page and /page#section dedupe to one entry.
 * @param {string} url
 * @returns {string}
 */
const normalizeUrl = (url) => {
    const u = new URL(url);
    u.hash = '';
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

    /**
     * Optional path scope: when set, only URLs under this prefix are
     * crawled, so a customer can scan just /help instead of a whole
     * 10,000-page site. Normalised to a leading slash, no trailing one.
     */
    const pathPrefix = options.pathPrefix
        ? '/' + String(options.pathPrefix).trim().replace(/^\/+|\/+$/g, '')
        : null;

    /** True when a URL sits inside the scoped folder (or no scope is set). */
    const inScope = (url) => {
        if (!pathPrefix) return true;
        try {
            const { pathname } = new URL(url);
            return pathname === pathPrefix || pathname.startsWith(pathPrefix + '/');
        } catch {
            return false;
        }
    };

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
        + `${pathPrefix ? `, scoped to ${pathPrefix}` : ''})`);

    const visited = new Set();
    const queued = new Set();
    const queue = [];

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

    const browser = await getBrowser();

    while (queue.length) {
        // Park here when a priority job needs the runner — the crawl
        // resumes from this exact point, losing no work.
        await gate?.wait();
        if (signal?.aborted) {
            console.log('⏹ Aborted — stopping crawl.');
            break;
        }
        const { url, depth } = queue.shift();
        if (visited.has(url) || isImageUrl(url)) continue;

        visited.add(url);
        console.log(`🔍 Crawling: ${url} (Depth: ${depth})`);
        onProgress?.({ done: visited.size, total: visited.size + queue.length, currentUrl: url });

        const result = await scrapePage(browser, url, outDir, opts);

        if (!result.ok) {
            // Navigation error or HTTP >= 400 — record and move on.
            // Non-HTML content types are skipped but not "broken".
            if (!result.error?.startsWith('non-HTML')) {
                console.error(`❌ Broken link: ${url} (${result.error})`);
                brokenLinks.add(url);
            }
            continue;
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

    console.log(`✅ Spider crawl completed. Visited ${visited.size} pages, ${brokenLinks.size} broken.`);

    const incomingAsObject = Object.fromEntries(
        [...incomingLinks.entries()].map(([link, sources]) => [link, [...sources]]));

    await fs.writeFile(path.join(outDir, 'all-links.txt'), [...linksList].join('\n'), 'utf8');
    await fs.writeFile(path.join(outDir, 'broken-links.txt'), [...brokenLinks].join('\n'), 'utf8');
    await fs.writeFile(path.join(outDir, 'incoming-links.json'), JSON.stringify(incomingAsObject, null, 2), 'utf8');

    console.log(`📁 Saved crawl results to: ${outDir}`);
    return { visited: visited.size, broken: brokenLinks.size, outDir, aborted: signal?.aborted ?? false };
}
