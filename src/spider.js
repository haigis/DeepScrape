import axios from 'axios';
import puppeteer from 'puppeteer';
import fs from 'fs';
import { scrapePage } from './scraper.js';
import { ensureDir } from './fileHandler.js';
import { waitMs } from './utils.js';

export async function spiderCrawl(startUrls, outDir, rateLimit, maxDepth, skipImages, screenshotFlag) {
    const visited = new Set();
    const queue = startUrls.map(url => ({ url, depth: 0 }));

    const browser = await puppeteer.launch({ headless: true });

    while (queue.length) {
        const { url, depth } = queue.shift();
        if (depth >= maxDepth || visited.has(url)) continue;

        visited.add(url);
        await scrapePage(browser, url, outDir, skipImages, screenshotFlag, rateLimit);

        try {
            const { data } = await axios.get(url);
            const links = [...data.matchAll(/href="([^"]+)"/g)].map(m => m[1]);

            links.forEach(link => {
                if (!visited.has(link) && link.startsWith(url)) {
                    queue.push({ url: link, depth: depth + 1 });
                }
            });
        } catch (err) {}

        await waitMs(rateLimit);
    }

    await browser.close();
}
