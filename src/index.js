import fs from 'fs';
import { processUrls } from './scraper.js';
import { spiderCrawl } from './spider.js';
import { generateUniqueOutputDir } from './fileHandler.js';
import { readUrlsFromSitemap, readUrlsFromFile } from './utils.js';

async function main() {
    const args = process.argv.slice(2);

    if (args.includes('-h') || args.includes('--help')) {
        console.log(`Usage: node index.js [options]

Options:
  -u <url>          Scrape a single URL.
  -f <file>         Scrape from a file of URLs.
  -sm <sitemap>     Scrape URLs from a sitemap.
  -spider <url>     Crawl a domain recursively.
  --no-images       Skip downloading images.
  -ss               Save a full-page screenshot.
  --rate-limit <ms> Set request delay (default: 1000ms).
`);
        process.exit(0);
    }

    const screenshotFlag = args.includes('-ss');
    const skipImages = args.includes('--no-images');
    const rateLimit = args.includes('--rate-limit') ? parseInt(args[args.indexOf('--rate-limit') + 1], 10) : 1000;
    const outDir = generateUniqueOutputDir('./output');

    let urls = [];

    if (args.includes('-spider')) {
        const spiderUrl = args[args.indexOf('-spider') + 1];
        await spiderCrawl([spiderUrl], outDir, rateLimit, 2, skipImages, screenshotFlag);
    } else if (args.includes('-u')) {
        urls = [args[args.indexOf('-u') + 1]];
    } else if (args.includes('-f')) {
        urls = fs.readFileSync(args[args.indexOf('-f') + 1], 'utf8').trim().split('\n');
    } else if (args.includes('-sm')) {
        urls = await readUrlsFromSitemap(args[args.indexOf('-sm') + 1]);
    }

    if (urls.length > 0) {
        await processUrls(urls, outDir, rateLimit, screenshotFlag, skipImages);
    }
}

main();
