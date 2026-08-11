import fs from 'fs/promises';
import crypto from 'crypto';
import path from 'path';
import puppeteer from 'puppeteer';
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

let sharedBrowser = null;

/**
 * Returns the shared Puppeteer browser, launching it if needed.
 * @returns {Promise<object>}
 */
export async function getBrowser() {
    if (!sharedBrowser || !sharedBrowser.connected) {
        sharedBrowser = await puppeteer.launch({ headless: true });
    }
    return sharedBrowser;
}

/**
 * Closes the shared browser if it is open.
 */
export async function closeBrowser() {
    if (sharedBrowser) {
        const b = sharedBrowser;
        sharedBrowser = null;
        await b.close().catch(() => {});
    }
}

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
 */

/**
 * Scrapes a given webpage and stores HTML, screenshot and images
 * while maintaining URL structure.
 * @param {object} browser - Puppeteer browser instance.
 * @param {string} url - The URL to scrape.
 * @param {string} outDir - Base directory for output.
 * @param {ScrapeOptions} options - Scrape options.
 * @returns {Promise<ScrapeResult>}
 */
export async function scrapePage(browser, url, outDir, options = {}) {
    const { screenshot, downloadImages, offline, cookieDismissal } = resolveOptions(options);
    console.log(`🌍 Navigating: ${url}`);
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });

    try {
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
            console.log(`📸 Capturing screenshot for: ${url}`);
            await autoScroll(page);
            await waitMs(2000);
            await page.evaluate(() => window.scrollTo(0, 0));
            await waitMs(1000);
            const screenshotFile = savePath.replace(/\.html?$/i, '.webp');
            await captureWebpScreenshot(page, screenshotFile);
        }

        return { ok: true, status, links };
    } catch (err) {
        console.error(`❌ Error processing ${url}:`, err.message);
        return { ok: false, links: [], error: err.message };
    } finally {
        await page.close();
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
            const timer = setInterval(() => {
                window.scrollBy(0, distance);
                totalHeight += distance;
                if (totalHeight >= document.body.scrollHeight) {
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
            const result = await scrapePage(browser, url, outDir, opts);
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
