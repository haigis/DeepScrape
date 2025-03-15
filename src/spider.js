import axios from 'axios';
import puppeteer from 'puppeteer';
import fs from 'fs/promises';
import path from 'path';
import { scrapePage } from './scraper.js';
import { ensureDir, generateOutputDir } from './fileHandler.js';
import { waitMs } from './utils.js';
import { URL } from 'url';

/**
 * Checks if the given URL points to an image or disguised image file.
 * @param {string} url - The URL to check.
 * @returns {boolean} - Returns true if the URL is an image.
 */
const isImageUrl = (url) => {
    return /\.(jpg|jpeg|png|gif|svg|webp|bmp|ico)$/i.test(url) || 
           /(\.(jpg|jpeg|png|gif|svg|webp|bmp|ico)\.html?)$/i.test(url) || 
           /(\?|\&)img=/.test(url); // Query strings that reference images
};

/**
 * Spider crawl to recursively scrape pages on the same domain.
 * @param {string[]} startUrls - Initial URLs to start crawling.
 * @param {number} rateLimit - Delay between requests (ms).
 * @param {number} maxDepth - Maximum depth to crawl.
 * @param {boolean} downloadImages - Whether to download images.
 * @param {boolean} screenshotFlag - Whether to take screenshots.
 */
export async function spiderCrawl(startUrls, rateLimit, maxDepth, downloadImages, screenshotFlag) {
    if (!startUrls || startUrls.length === 0) {
        console.error("❌ Error: spiderCrawl received an empty startUrls array.");
        return;
    }

    const domain = new URL(startUrls[0]).hostname;
    const outDir = generateOutputDir(startUrls[0]);

    if (!outDir || outDir === "output/unknown") {
        console.error("❌ Error: Could not determine a valid output directory.");
        return;
    }

    ensureDir('./', outDir);

    console.log(`🕷️ Starting spider crawl on: ${startUrls[0]}`);

    const visited = new Set();
    const queued = new Set();
    const queue = startUrls.map(url => ({ url, depth: 0 }));

    const linksList = new Set();
    const brokenLinks = new Set();
    const incomingLinks = new Map();

    const browser = await puppeteer.launch({ headless: true });

    while (queue.length) {
        const { url, depth } = queue.shift();
        if (depth >= maxDepth || visited.has(url) || isImageUrl(url)) continue;

        visited.add(url);
        console.log(`🔍 Crawling: ${url} (Depth: ${depth})`);

        try {
            const response = await axios.head(url, { timeout: 5000 });

            if (!response.headers['content-type']?.includes('text/html')) {
                console.log(`🚫 Skipping non-HTML content: ${url}`);
                continue;
            }

            const { data } = await axios.get(url);
            const matches = [...data.matchAll(/href="([^"]+)"/g)].map(m => m[1]);

            for (let link of matches) {
                try {
                    link = new URL(link, url).href;

                    if (isImageUrl(link) || visited.has(link) || queued.has(link)) continue;

                    linksList.add(link);
                    queued.add(link);
                    if (new URL(link).hostname === domain) {
                        queue.push({ url: link, depth: depth + 1 });
                    }
                } catch (e) {
                    // Ignore invalid URLs
                }
            }
        } catch (err) {
            console.error(`❌ Broken Link: ${url}`);
            brokenLinks.add(url);
        }

        if (!incomingLinks.has(url)) {
            incomingLinks.set(url, []);
        }
        incomingLinks.get(url).push(url);

        await scrapePage(browser, url, outDir, downloadImages, screenshotFlag, rateLimit);
        await waitMs(rateLimit);
    }

    await browser.close();
    console.log("✅ Spider crawl completed.");

    await fs.writeFile(path.join(outDir, 'all-links.txt'), Array.from(linksList).join('\n'), 'utf8');
    await fs.writeFile(path.join(outDir, 'broken-links.txt'), Array.from(brokenLinks).join('\n'), 'utf8');
    await fs.writeFile(path.join(outDir, 'incoming-links.txt'), JSON.stringify(Object.fromEntries(incomingLinks), null, 2), 'utf8');

    console.log(`📁 Saved crawl results to: ${outDir}`);
}
