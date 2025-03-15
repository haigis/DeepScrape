import fs from 'fs/promises';
import path from 'path';
import puppeteer from 'puppeteer';
import axios from 'axios';
import { ensureDir, fixRelativePaths, generateOutputDir } from './fileHandler.js'; // ✅ Import generateOutputDir from fileHandler
import { captureWebpScreenshot } from './screenshot.js';
import { handleCookieBanner, waitMs } from './cookieHandler.js';

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
    } else {
        pathName += '.html';
    }
    return path.join(parsedUrl.hostname, pathName);
}

/**
 * Scrapes a given webpage and stores HTML & screenshot while maintaining URL structure.
 * @param {object} browser - Puppeteer browser instance.
 * @param {string} url - The URL to scrape.
 * @param {string} outDir - Base directory for output.
 * @param {boolean} skipImages - Whether to skip images.
 * @param {boolean} screenshotFlag - Whether to take a screenshot.
 * @param {number} rateLimit - Delay between requests.
 */
export async function scrapePage(browser, url, outDir, skipImages, screenshotFlag, rateLimit) {
    console.log(`🌍 Navigating: ${url}`);
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });

    try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        await handleCookieBanner(page, new URL(url).hostname);
        await waitMs(2000);

        let html = await page.content();
        html = fixRelativePaths(html, url);

        const savePath = path.join(outDir, buildPagePath(url));
        await fs.mkdir(path.dirname(savePath), { recursive: true });

        await fs.writeFile(savePath, `<!-- ${url} -->\n${html}`, 'utf8');
        console.log(`✅ Saved HTML: ${savePath}`);

        if (screenshotFlag) {
            console.log(`📸 Capturing screenshot for: ${url}`);
            await autoScroll(page);
            await waitMs(2000);
            await page.evaluate(() => window.scrollTo(0, 0));
            await waitMs(1000);
            const screenshotFile = savePath.replace('.html', '.webp');
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
 * Fetches URLs from a sitemap and returns them as an array.
 * @param {string} sitemapUrl - The URL of the sitemap.
 * @returns {Promise<string[]>} - List of URLs from the sitemap.
 */
export async function processSitemap(sitemapUrl) {
    console.log(`📡 Fetching sitemap: ${sitemapUrl}`);
    try {
        const { data } = await axios.get(sitemapUrl);
        const urls = [...data.matchAll(/<loc>(.*?)<\/loc>/g)].map(match => match[1]);

        console.log(`✅ Found ${urls.length} URLs in sitemap.`);
        return urls;
    } catch (error) {
        console.error(`❌ Error fetching sitemap: ${error.message}`);
        throw error;
    }
}

/**
 * Processes a list of URLs and saves HTML/screenshot in the correct folder structure.
 * @param {string[]} urls - List of URLs to scrape.
 * @param {number} rateLimit - Delay between requests.
 * @param {boolean} screenshotFlag - Whether to take screenshots.
 * @param {boolean} downloadImages - Whether to download images.
 */
export async function processUrls(urls, rateLimit, screenshotFlag = false, downloadImages = false) {
    console.log(`🚀 Processing ${urls.length} URLs...`);
    console.log(`🖼 Screenshot: ${screenshotFlag ? 'Enabled' : 'Disabled'}`);
    console.log(`📥 Download Images: ${downloadImages ? 'Enabled' : 'Disabled'}`);

    const browser = await puppeteer.launch({ headless: true });

    for (const url of urls) {
        try {
            const outDir = generateOutputDir(url); // ✅ Now correctly using function from fileHandler.js
            await scrapePage(browser, url, outDir, downloadImages, screenshotFlag, rateLimit);
        } catch (err) {
            console.error(`❌ Error scraping ${url}: ${err.message}`);
        }
        if (rateLimit > 0) await waitMs(rateLimit);
    }

    await browser.close();
    console.log("✅ All URLs processed.");
}
