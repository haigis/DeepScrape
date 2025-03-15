import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';
import axios from 'axios';
import { ensureDir, buildFolderPath, fixRelativePaths } from './fileHandler.js';
import { captureWebpScreenshot } from './screenshot.js';
import { handleCookieBanner, waitMs } from './cookieHandler.js';

/**
 * Generates a timestamped directory structure using UK format.
 * Example:
 * output/
 * ├── 14-03-2024/
 * │   ├── 15-30-45/
 * │   │   ├── www.barclays.co.uk/
 * │   │   │   ├── index.html
 * │   │   │   ├── images/
 * │   │   │   ├── screenshots/
 * @param {string} baseDir - The base output directory.
 * @returns {string} - The formatted directory path.
 */
function generateOutputDir(baseDir = './output') {
    const now = new Date();
    const datePart = now.toLocaleDateString('en-GB').replace(/\//g, '-'); // 14-03-2024
    const timePart = now.toTimeString().split(' ')[0].replace(/:/g, '-'); // 15-30-45
    return path.join(baseDir, datePart, timePart);
}

/**
 * Scrapes a given page and saves its HTML, optionally capturing a screenshot.
 * @param {object} browser - Puppeteer browser instance.
 * @param {string} url - The URL to scrape.
 * @param {string} outDir - Output directory path.
 * @param {boolean} skipImages - Whether to skip images.
 * @param {boolean} screenshotFlag - Whether to take a screenshot.
 * @param {number} rateLimit - Delay between requests.
 */
async function scrapePage(browser, url, outDir, skipImages, screenshotFlag, rateLimit) {
    console.log(`🌍 Navigating: ${url}`);
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });

    try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        await handleCookieBanner(page, new URL(url).hostname);
        await waitMs(2000);

        let html = await page.content();
        html = fixRelativePaths(html, url);

        const relativeFolderPath = buildFolderPath(url);
        const pageDir = ensureDir(outDir, relativeFolderPath);
        const baseName = path.basename(pageDir);

        const htmlFile = path.join(pageDir, `${baseName}.html`);
        fs.writeFileSync(htmlFile, `<!-- ${url} -->\n${html}`, 'utf8');
        console.log(`✅ Saved HTML: ${htmlFile}`);

        if (screenshotFlag) {
            console.log(`📸 Capturing screenshot for: ${url}`);
            await autoScroll(page);
            await waitMs(2000);
            await page.evaluate(() => window.scrollTo(0, 0));
            await waitMs(1000);
            const screenshotFile = path.join(pageDir, `${baseName}.webp`);
            await captureWebpScreenshot(page, screenshotFile);
        }
    } catch (err) {
        console.error(`❌ Error processing ${url}:`, err);
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
 * Processes a list of URLs, saving HTML and optionally taking screenshots.
 * @param {string[]} urls - List of URLs to scrape.
 * @param {string} outDir - Output directory path.
 * @param {number} rateLimit - Delay between requests.
 * @param {boolean} screenshotFlag - Whether to take screenshots.
 * @param {boolean} skipImages - Whether to skip images.
 */
export async function processUrls(urls, outDir, rateLimit, screenshotFlag, skipImages) {
    const baseOutDir = generateOutputDir();
    console.log(`📂 Using output directory: ${baseOutDir}`);

    console.log(`🚀 Processing ${urls.length} URLs...`);
    const browser = await puppeteer.launch({ headless: true });

    for (const url of urls) {
        try {
            await scrapePage(browser, url, baseOutDir, skipImages, screenshotFlag, rateLimit);
        } catch (err) {
            console.error(`❌ Error scraping ${url}: ${err.message}`);
        }
        if (rateLimit > 0) await waitMs(rateLimit);
    }

    await browser.close();
    console.log("✅ All URLs processed.");
}

/**
 * Fetches URLs from a sitemap and returns them as an array.
 * @param {string} sitemapUrl - The URL of the sitemap.
 * @returns {Promise<string[]>} - List of URLs from the sitemap.
 */
export async function processSitemap(sitemapUrl) {
    console.log(`📡 Fetching sitemap: ${sitemapUrl}`);
    const { data } = await axios.get(sitemapUrl);
    const urls = data.match(/<loc>(.*?)<\/loc>/g).map(loc => loc.replace(/<\/?loc>/g, ''));
    return urls;
}

/**
 * Reads URLs from a file, filtering out ignored ones.
 * @param {string} filePath - Path to the file containing URLs.
 * @param {string[]} ignoreUrls - List of URLs to ignore.
 * @returns {Promise<string[]>} - List of processed URLs.
 */
export async function processFile(filePath, ignoreUrls = []) {
    console.log(`📂 Reading file: ${filePath}`);
    const urls = fs.readFileSync(filePath, 'utf8').trim().split('\n').map(line => line.trim()).filter(url => url);

    const filteredUrls = urls.filter(url => !ignoreUrls.some(ignore => url.startsWith(ignore)));
    return filteredUrls;
}

/**
 * Performs a spider crawl by recursively following same-domain links.
 * @param {string[]} startUrls - Initial URLs to start crawling.
 * @param {string} outDir - Output directory path.
 * @param {number} rateLimit - Delay between requests.
 * @param {number} maxDepth - Maximum depth to crawl.
 * @param {boolean} skipImages - Whether to skip images.
 * @param {boolean} screenshotFlag - Whether to take screenshots.
 */
export async function spiderCrawl(startUrls, outDir, rateLimit, maxDepth, skipImages, screenshotFlag) {
    console.log(`🕷️ Starting spider crawl on: ${startUrls[0]}`);
    const baseOutDir = generateOutputDir();
    const browser = await puppeteer.launch({ headless: true });

    for (const url of startUrls) {
        try {
            await scrapePage(browser, url, baseOutDir, skipImages, screenshotFlag, rateLimit);
        } catch (err) {
            console.error(`❌ Error in spider crawl: ${err.message}`);
        }
    }

    await browser.close();
    console.log("✅ Spider crawl completed.");
}
