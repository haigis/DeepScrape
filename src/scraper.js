import fs from 'fs/promises';
import crypto from 'crypto';
import path from 'path';
import puppeteer from 'puppeteer';
import { BROWSER_LAUNCH_OPTIONS } from './browserOptions.js';
import axios from 'axios';
import { fixRelativePaths, generateOutputDir } from './fileHandler.js';
import { captureWebpScreenshot } from './screenshot.js';
import { handleCookieBanner } from './cookieHandler.js';
import { waitMs } from './utils.js';
import { downloadAssets, rewriteForOffline } from './offline.js';

/**
 * Default scrape options shared by the CLI and the API.
 * A single object prevents the positional-argument drift that
 * previously broke the CLI (see issue #1).
 *
 * @typedef {object} ScrapeOptions
 * @property {number}  rateLimit       Delay between requests in ms.
 * @property {number}  maxDepth        Spider crawl depth (levels of links to follow).
 * @property {boolean} screenshot     Capture a full-page WebP screenshot.
 * @property {boolean} downloadImages Download page images alongside the HTML.
 */
export const defaultOptions = Object.freeze({
    rateLimit: 1000,
    maxDepth: 2,
    screenshot: false,
    downloadImages: false,
    // Saved pages are self-contained by default: assets are downloaded
    // and references rewritten so viewing a scan never calls the origin.
    offline: true,
    // Cookie-banner dismissal exists for clean screenshots — the HTML
    // is captured either way. It only runs before a screenshot, and a
    // site whose consent UI resists dismissal (up to 5s of selector
    // waits per page) can turn it off entirely.
    cookieDismissal: true,
});

/**
 * Merges user-supplied options with defaults.
 * @param {Partial<ScrapeOptions>} options
 * @returns {ScrapeOptions}
 */
export function resolveOptions(options = {}) {
    return { ...defaultOptions, ...options };
}

// --- Shared browser -------------------------------------------------------
// One Puppeteer instance reused across scrape runs/jobs. The job queue
// closes it when the queue drains; the CLI closes it before exit.
//
// The browser is the one part of a crawl that fails without any page
// failing. Chrome wedges under memory pressure on long crawls, and every
// newPage() then times out — "Timed out after waiting 30000ms", which
// used to escape the per-page guard and fail whole scans. So it is
// treated as a replaceable resource:
//  - opening a tab is bounded and counted; repeated failures recycle it
//  - it is recycled anyway every DS_BROWSER_RECYCLE_PAGES pages, before
//    a long crawl can grow it into that state
//  - a recycle waits (briefly) for tabs in flight, so workers lose at
//    most the page they are on, and the crawler retries that page.

let sharedBrowser = null;
/** In-progress launch, so concurrent workers share one. */
let launching = null;
/** In-progress recycle; getBrowser() waits on it. */
let recycling = null;
let activePages = 0;
let pagesSinceLaunch = 0;
let consecutiveFaults = 0;
const stats = { launches: 0, recycles: 0, faults: 0 };

/** Pages a browser serves before it is replaced with a fresh one. 0 = never. */
const recycleAfterPages = () => Math.max(0, Number(process.env.DS_BROWSER_RECYCLE_PAGES ?? 500) || 0);
/** How long newPage() may take before the browser is considered wedged. */
const newPageTimeoutMs = () => Math.max(5000, Number(process.env.DS_NEW_PAGE_TIMEOUT_MS) || 20000);
const FAULTS_BEFORE_RECYCLE = 2;
/** Longest a recycle waits for in-flight tabs before killing them. */
const RECYCLE_DRAIN_MS = 30000;
/**
 * Tabs open at once across every job. Per-crawl workers × concurrent
 * jobs is otherwise unbounded (6 × 3 = 18 tabs rendering full pages
 * with screenshots), which is exactly the memory pressure that wedges
 * Chrome in the first place.
 */
const maxTabs = () => Math.max(1, Number(process.env.DS_MAX_TABS) || 8);
/** A screenshot slower than this is skipped; the page is already saved. */
const screenshotTimeoutMs = () => Math.max(5000, Number(process.env.DS_SCREENSHOT_TIMEOUT_MS) || 45000);

/** Races a promise against a timer that is cleared when it settles. */
function withTimeout(promise, ms, message) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Returns the shared Puppeteer browser, launching it if needed.
 * @returns {Promise<object>}
 */
export async function getBrowser() {
    if (recycling) await recycling;
    if (sharedBrowser?.connected) return sharedBrowser;
    if (!launching) {
        launching = (async () => {
            const browser = await puppeteer.launch(BROWSER_LAUNCH_OPTIONS);
            stats.launches++;
            pagesSinceLaunch = 0;
            consecutiveFaults = 0;
            browser.once('disconnected', () => {
                if (sharedBrowser === browser) {
                    sharedBrowser = null;
                    console.warn('⚠️ Browser disconnected — a fresh one launches on the next page');
                }
            });
            sharedBrowser = browser;
            return browser;
        })().finally(() => { launching = null; });
    }
    return launching;
}

/**
 * Closes the shared browser if it is open. A close that hangs is not
 * waited on for long, and the Chrome process is killed regardless so a
 * wedged browser cannot survive as a zombie eating memory.
 */
export async function closeBrowser() {
    if (sharedBrowser) {
        const b = sharedBrowser;
        sharedBrowser = null;
        await Promise.race([b.close().catch(() => {}), waitMs(10000)]);
        try { b.process()?.kill('SIGKILL'); } catch { /* already gone */ }
    }
}

/**
 * Replaces the shared browser. Waits briefly for tabs in flight to
 * finish so their pages are kept; anything still open after that dies
 * with the browser and its worker retries the page.
 * @param {string} reason - Logged.
 * @returns {Promise<void>}
 */
export function recycleBrowser(reason) {
    if (recycling) return recycling;
    recycling = (async () => {
        console.warn(`♻️ Recycling browser: ${reason} (${activePages} tab(s) in flight)`);
        const started = Date.now();
        while (activePages > 0 && Date.now() - started < RECYCLE_DRAIN_MS) await waitMs(200);
        await closeBrowser();
        stats.recycles++;
    })().finally(() => { recycling = null; });
    return recycling;
}

/** Browser health, for /health and the logs. */
export const browserStats = () => ({
    ...stats,
    connected: Boolean(sharedBrowser?.connected),
    activePages,
    pagesSinceLaunch,
    recycling: Boolean(recycling),
});

/**
 * Opens a tab in the shared browser, bounded and health-tracked. Throws
 * a transient error when the browser cannot supply one; two failures in
 * a row recycle the browser in the background.
 * @returns {Promise<object>} Puppeteer page.
 */
async function acquirePage() {
    const budget = recycleAfterPages();
    if (budget > 0 && pagesSinceLaunch >= budget && sharedBrowser?.connected) {
        await recycleBrowser(`${pagesSinceLaunch} pages since launch`);
    }
    // Wait for a tab slot; a recycle in progress also holds new tabs back.
    while (activePages >= maxTabs() || recycling) await waitMs(100);
    const browser = await getBrowser();
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(
            () => reject(new Error(`browser did not open a tab within ${newPageTimeoutMs()}ms`)),
            newPageTimeoutMs(),
        );
    });
    try {
        const page = await Promise.race([browser.newPage(), timeout]);
        consecutiveFaults = 0;
        pagesSinceLaunch++;
        activePages++;
        return page;
    } catch (err) {
        // A failure on a browser that has since been replaced says
        // nothing about the new one — never let it recycle a healthy
        // browser that just launched.
        if (browser === sharedBrowser) {
            stats.faults++;
            consecutiveFaults++;
            if (consecutiveFaults >= FAULTS_BEFORE_RECYCLE) {
                void recycleBrowser(`${consecutiveFaults} consecutive tab failures — ${err.message}`);
            }
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Errors that say nothing about the page and everything about the
 * moment: a wedged or restarting browser, a dropped connection, a slow
 * origin. Worth one more try after a pause. A page deadline is
 * deliberately not here — a page that needed two minutes will need two
 * minutes again.
 */
const TRANSIENT_ERROR = new RegExp([
    'Timed out after waiting',
    'did not open a tab',
    'Target closed',
    'Session closed',
    'Protocol error',
    'Connection closed',
    'browser has disconnected',
    'Navigation timeout',
    'net::ERR_(CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_REFUSED|CONNECTION_TIMED_OUT|TIMED_OUT|NETWORK_CHANGED|EMPTY_RESPONSE|HTTP2_PROTOCOL_ERROR|SOCKET_NOT_CONNECTED|INTERNET_DISCONNECTED|NETWORK_IO_SUSPENDED)',
    'ECONNRESET',
    'ETIMEDOUT',
    'socket hang up',
].join('|'), 'i');

/** @param {string} message */
export const isTransientError = (message) => TRANSIENT_ERROR.test(String(message ?? ''));

/**
 * Builds a file path that preserves the website structure.
 * @param {string} url - The page URL.
 * @returns {string} - Formatted file path.
 */
export function buildPagePath(url) {
    const parsedUrl = new URL(url);
    let pathName = parsedUrl.pathname.replace(/\/$/, '');
    if (pathName === '' || pathName === '/') {
        pathName = 'index.html';
    } else if (!/\.html?$/i.test(pathName)) {
        // Don't double-append: /a.html previously saved as a.html.html
        pathName += '.html';
    }
    return path.join(parsedUrl.hostname, pathName);
}

/**
 * Browser-like User-Agent for direct HTTP requests. Many sites
 * (e.g. Wikipedia) return 403 to the default axios user agent.
 */
export const HTTP_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 DeepScrape/1.0';

/**
 * Downloads all images referenced by the rendered page into an
 * images/ folder next to the saved HTML.
 * @param {object} page - Puppeteer page object.
 * @param {string} pageUrl - URL of the page being scraped (used as Referer).
 * @param {string} imgDir - Directory to save images into.
 * @returns {Promise<{saved: number, failed: number}>}
 */
async function downloadPageImages(page, pageUrl, imgDir) {
    const imgUrls = await page.$$eval('img[src]', imgs => imgs.map(i => i.src));
    const unique = [...new Set(imgUrls)].filter(u => /^https?:/i.test(u));
    if (unique.length === 0) return { saved: 0, failed: 0 };

    await fs.mkdir(imgDir, { recursive: true });
    let saved = 0;
    let failed = 0;
    for (const imgUrl of unique) {
        try {
            const { pathname } = new URL(imgUrl);
            const name = pathname.replace(/^\//, '').replace(/[^a-z0-9._-]+/gi, '-') || 'image';
            const { data } = await axios.get(imgUrl, {
                responseType: 'arraybuffer',
                timeout: 15000,
                headers: { 'User-Agent': HTTP_USER_AGENT, Referer: pageUrl },
            });
            await fs.writeFile(path.join(imgDir, name), data);
            saved++;
        } catch (err) {
            failed++;
            console.warn(`⚠️ Image download failed (${err.response?.status ?? err.message}): ${imgUrl}`);
        }
    }
    return { saved, failed };
}

/**
 * Result of scraping a single page.
 * @typedef {object} ScrapeResult
 * @property {boolean}  ok      Whether the page was fetched and saved.
 * @property {number}   [status] HTTP status of the main navigation response.
 * @property {string[]} links   Absolute URLs of all <a href> links on the rendered page.
 * @property {string}   [error] Error message when ok is false.
 * @property {boolean}  [transient] The failure was momentary (browser, network) — worth a retry.
 */

/**
 * Hard ceiling on one page's total processing time. Individual steps
 * carry their own timeouts (navigation 30s, CDP protocol 180s, asset
 * downloads 20s), but their sum was unbounded — one pathological page
 * could wedge a crawl worker for hours and make cancellation
 * unreachable. The deadline puts a roof over the whole thing.
 */
const pageDeadlineMs = () => Math.max(30000, Number(process.env.DS_PAGE_TIMEOUT_MS) || 120000);

/**
 * Scrapes a given webpage and stores HTML, screenshot and images
 * while maintaining URL structure.
 *
 * The whole operation races a per-page deadline and the caller's abort
 * signal, so a hung page costs at most pageDeadlineMs and a cancelled
 * job stops mid-page rather than after it. Never throws: every failure,
 * including the browser refusing to open a tab, comes back as a result
 * with `ok: false` — one bad page (or one bad moment for Chrome) must
 * never take the crawl down with it. `transient` marks failures worth
 * retrying.
 *
 * @param {object|null} _browser - Ignored; the shared browser is fetched
 *   per page so a recycled browser is picked up automatically.
 * @param {string} url - The URL to scrape.
 * @param {string} outDir - Base directory for output.
 * @param {ScrapeOptions & {signal?: AbortSignal}} options - Scrape options.
 * @returns {Promise<ScrapeResult>}
 */
export async function scrapePage(_browser, url, outDir, options = {}) {
    const { signal } = options;
    if (signal?.aborted) return { ok: false, links: [], error: 'cancelled' };

    let page;
    try {
        page = await acquirePage();
    } catch (err) {
        console.error(`❌ Could not open a tab for ${url}: ${err.message}`);
        return { ok: false, links: [], error: err.message, transient: true };
    }

    let timer;
    let onAbort;
    const deadline = new Promise((_, reject) => {
        timer = setTimeout(
            () => reject(new Error(`page deadline exceeded (${pageDeadlineMs()}ms)`)),
            pageDeadlineMs(),
        );
        if (signal) {
            onAbort = () => reject(new Error('cancelled'));
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
        }
    });

    try {
        return await Promise.race([scrapePageInner(page, url, outDir, options), deadline]);
    } catch (err) {
        console.error(`❌ Error processing ${url}:`, err.message);
        return { ok: false, links: [], error: err.message, transient: isTransientError(err.message) };
    } finally {
        clearTimeout(timer);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        // Closing a wedged page can itself hang — never wait on it for
        // more than a moment; a leaked tab dies with the shared browser.
        await Promise.race([page.close().catch(() => {}), waitMs(5000)]);
        activePages = Math.max(0, activePages - 1);
    }
}

async function scrapePageInner(page, url, outDir, options = {}) {
    const { screenshot, downloadImages, offline, cookieDismissal } = resolveOptions(options);
    console.log(`🌍 Navigating: ${url}`);
    await page.setViewport({ width: 1440, height: 900 });

    {
        // When the scan wants neither screenshots nor images, the pixels
        // can't matter — skip image/media/font downloads for a much
        // faster page load. Never active on screenshot scans (the
        // archive would show broken images).
        if (!screenshot && !downloadImages) {
            await page.setRequestInterception(true);
            page.on('request', (request) => {
                if (['image', 'media', 'font'].includes(request.resourceType())) request.abort();
                else request.continue();
            });
        }

        const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        const status = response?.status();

        if (status && status >= 400) {
            console.error(`❌ HTTP ${status} for ${url} — not saving.`);
            return { ok: false, status, links: [], error: `HTTP ${status}` };
        }

        const contentType = response?.headers()['content-type'] ?? '';
        if (contentType && !contentType.includes('text/html')) {
            console.log(`🚫 Skipping non-HTML content (${contentType}): ${url}`);
            return { ok: false, status, links: [], error: `non-HTML content-type: ${contentType}` };
        }

        // Dismissal is a screenshot concern only (the HTML is captured
        // regardless), and per-site configurable — see defaultOptions.
        if (screenshot && cookieDismissal) {
            await handleCookieBanner(page, url);
        }
        await waitMs(2000);

        // Collect links from the *rendered* DOM — catches JS-injected links
        // and avoids re-fetching the page with a second HTTP client.
        const links = await page.$$eval('a[href]', anchors =>
            anchors.map(a => a.href).filter(href => /^https?:/i.test(href)));

        let html = await page.content();
        html = fixRelativePaths(html, url);

        // Content dedupe: when the caller shares a hash registry (the
        // spider does), a page whose rendered HTML is byte-identical to
        // one already saved is recorded as a duplicate, not saved again —
        // different URLs serving the same document are one page.
        if (options.dedupe) {
            const hash = crypto.createHash('sha1').update(html).digest('hex');
            const original = options.dedupe.get(hash);
            if (original && original !== url) {
                console.log(`♻️ Duplicate content: ${url} = ${original} — skipping save.`);
                // links stay empty: the original's links were already followed.
                return { ok: true, status, links: [], duplicateOf: original };
            }
            options.dedupe.set(hash, url);
        }

        const savePath = path.join(outDir, buildPagePath(url));
        await fs.mkdir(path.dirname(savePath), { recursive: true });

        // Make the saved copy self-contained: download the assets it needs
        // and repoint them locally, so viewing or auditing the scan later
        // never reaches back to the origin site.
        if (offline) {
            const { map, saved, failed, bytes } = await downloadAssets(
                html, url, outDir, path.dirname(savePath));
            html = rewriteForOffline(html, map);
            console.log(`📦 Offline assets: ${saved} saved (${failed} failed, ${(bytes / 1024).toFixed(0)} KB)`);
        }

        await fs.writeFile(savePath, `<!-- ${url} -->\n${html}`, 'utf8');
        console.log(`✅ Saved HTML: ${savePath}`);

        if (downloadImages) {
            const imgDir = path.join(path.dirname(savePath), 'images');
            const { saved, failed } = await downloadPageImages(page, url, imgDir);
            console.log(`🖼️ Downloaded ${saved} images (${failed} failed) to: ${imgDir}`);
        }

        if (screenshot) {
            // The page is saved and its links are in hand. A screenshot
            // that fails or drags — a 60,000px page through sharp — costs
            // the screenshot, never the page or the crawl below it.
            console.log(`📸 Capturing screenshot for: ${url}`);
            try {
                await withTimeout((async () => {
                    await autoScroll(page);
                    await waitMs(2000);
                    await page.evaluate(() => window.scrollTo(0, 0));
                    await waitMs(1000);
                    const screenshotFile = savePath.replace(/\.html?$/i, '.webp');
                    await captureWebpScreenshot(page, screenshotFile);
                })(), screenshotTimeoutMs(), `screenshot took longer than ${screenshotTimeoutMs()}ms`);
            } catch (err) {
                console.warn(`⚠️ Screenshot skipped for ${url}: ${err.message}`);
            }
        }

        return { ok: true, status, links };
    }
}

/**
 * Auto-scrolls to trigger lazy-loading of images for better screenshots.
 * @param {object} page - Puppeteer page object.
 */
async function autoScroll(page) {
    await page.evaluate(() => {
        return new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 100;
            // Bounded: an infinite-scroll feed grows scrollHeight faster
            // than we scroll, and the unbounded version never resolved.
            const maxHeight = 60000;
            const timer = setInterval(() => {
                window.scrollBy(0, distance);
                totalHeight += distance;
                if (totalHeight >= document.body.scrollHeight || totalHeight >= maxHeight) {
                    clearInterval(timer);
                    resolve();
                }
            }, 100);
        });
    });
}

/**
 * Fetches URLs from a file and filters out ignored URLs.
 * @param {string} filePath - Path to file with URLs.
 * @param {string[]} ignoreUrls - List of URLs to ignore.
 * @returns {Promise<string[]>} - List of valid URLs.
 */
export async function processFile(filePath, ignoreUrls = []) {
    console.log(`📂 Reading URLs from file: ${filePath}`);
    try {
        const fileContent = await fs.readFile(filePath, 'utf8');
        const urls = fileContent
            .trim()
            .split('\n')
            .map(url => url.trim())
            .filter(url => url && !ignoreUrls.includes(url));

        console.log(`✅ Loaded ${urls.length} URLs from file.`);
        return urls;
    } catch (error) {
        console.error(`❌ Error reading file: ${error.message}`);
        throw error;
    }
}

/**
 * Processes a list of URLs and saves HTML/screenshot in the correct folder structure.
 * @param {string[]} urls - List of URLs to scrape.
 * @param {Partial<ScrapeOptions>} options - Scrape options.
 */
export async function processUrls(urls, options = {}) {
    const opts = resolveOptions(options);
    const { onProgress, signal, gate } = options;
    console.log(`🚀 Processing ${urls.length} URLs...`);
    console.log(`🖼 Screenshot: ${opts.screenshot ? 'Enabled' : 'Disabled'}`);
    console.log(`📥 Download Images: ${opts.downloadImages ? 'Enabled' : 'Disabled'}`);

    const browser = await getBrowser();
    let processed = 0;
    let failed = 0;

    for (const url of urls) {
        // Yield to any priority job waiting to preempt this one.
        await gate?.wait();
        if (signal?.aborted) {
            console.log('⏹ Aborted — stopping before remaining URLs.');
            break;
        }
        onProgress?.({ done: processed + failed, total: urls.length, currentUrl: url });
        try {
            const outDir = generateOutputDir(url);
            const result = await scrapePage(browser, url, outDir, { ...opts, signal });
            result.ok ? processed++ : failed++;
        } catch (err) {
            failed++;
            console.error(`❌ Error scraping ${url}: ${err.message}`);
        }
        if (opts.rateLimit > 0) await waitMs(opts.rateLimit);
    }

    onProgress?.({ done: processed + failed, total: urls.length, currentUrl: null });
    console.log(`✅ Finished (${processed} ok, ${failed} failed of ${urls.length}).`);
    return { processed, failed, total: urls.length, aborted: signal?.aborted ?? false };
}
