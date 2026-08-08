import { processUrls, processFile, resolveOptions, closeBrowser } from './scraper.js';
import { spiderCrawl } from './spider.js';
import { fetchSitemapUrls } from './sitemap.js';

function getFlagValue(args, flag) {
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
        console.log(`Usage: node src/index.js [options]

Options:
  -u <url>          Scrape a single URL.
  -f <file>         Scrape from a file of URLs (one per line).
  -sm <sitemap>     Scrape URLs from a sitemap.
  -spider <url>     Crawl a domain recursively.
  --depth <n>       Spider crawl depth (default: 2).
  --images          Download page images alongside the HTML.
  --no-offline      Keep asset URLs pointing at the live site (default is
                    a self-contained offline copy).
  -ss               Save a full-page WebP screenshot.
  --rate-limit <ms> Set request delay (default: 1000ms).
  -h, --help        Show this help message.
`);
        process.exit(0);
    }

    const options = resolveOptions({
        screenshot: args.includes('-ss'),
        downloadImages: args.includes('--images'),
        offline: !args.includes('--no-offline'),
        rateLimit: args.includes('--rate-limit')
            ? parseInt(getFlagValue(args, '--rate-limit'), 10)
            : undefined,
        maxDepth: args.includes('--depth')
            ? parseInt(getFlagValue(args, '--depth'), 10)
            : undefined,
    });

    if (Number.isNaN(options.rateLimit)) {
        console.error('❌ --rate-limit requires a number in milliseconds.');
        process.exit(1);
    }
    if (Number.isNaN(options.maxDepth)) {
        console.error('❌ --depth requires a number.');
        process.exit(1);
    }

    let urls = [];

    if (args.includes('-spider')) {
        const spiderUrl = getFlagValue(args, '-spider');
        if (!spiderUrl) {
            console.error('❌ -spider requires a URL.');
            process.exit(1);
        }
        await spiderCrawl([spiderUrl], options);
        return;
    } else if (args.includes('-u')) {
        const url = getFlagValue(args, '-u');
        if (!url) {
            console.error('❌ -u requires a URL.');
            process.exit(1);
        }
        urls = [url];
    } else if (args.includes('-f')) {
        const file = getFlagValue(args, '-f');
        if (!file) {
            console.error('❌ -f requires a file path.');
            process.exit(1);
        }
        urls = await processFile(file);
    } else if (args.includes('-sm')) {
        const sitemap = getFlagValue(args, '-sm');
        if (!sitemap) {
            console.error('❌ -sm requires a sitemap URL.');
            process.exit(1);
        }
        urls = await fetchSitemapUrls(sitemap);
    } else {
        console.error('❌ No mode specified. Use -u, -f, -sm or -spider (see --help).');
        process.exit(1);
    }

    if (urls.length > 0) {
        await processUrls(urls, options);
    } else {
        console.error('❌ No URLs to process.');
        process.exit(1);
    }
}

main()
    .catch(err => {
        console.error('❌ Fatal error:', err);
        process.exitCode = 1;
    })
    .finally(() => closeBrowser());
