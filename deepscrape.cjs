const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const sharp = require('sharp');
const { URL } = require('url');
const cliProgress = require('cli-progress');

// Helper for old Puppeteer versions that lack page.waitForTimeout
function waitMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Load cookie banner configurations from cookie_selectors.json
let cookieConfigs = {};
try {
    const configData = fs.readFileSync('cookie_selectors.json', 'utf8');
    cookieConfigs = JSON.parse(configData);
    console.log("✅ Loaded cookie_selectors.json configuration.");
} catch (e) {
    console.error("❌ Could not load cookie_selectors.json:", e.message);
}

// Attempt to click a selector within the page
async function attemptSelectorClick(page, selector) {
    try {
        // Wait for up to 5s for the banner to appear
        await page.waitForSelector(selector, { timeout: 5000 });
        await page.click(selector);
        await waitMs(2000);  // replaces page.waitForTimeout(2000)
        console.log(`✅ Cookie banner closed with selector: ${selector}`);
        return true;
    } catch (err) {
        console.log(`⚠️ Could not click cookie banner selector "${selector}": ${err.message}`);
        return false;
    }
}

// Handle cookie banner
async function handleCookieBanner(page) {
    const currentUrl = page.url();
    const currentDomain = new URL(currentUrl).hostname;

    let configKey = null;
    for (const key in cookieConfigs) {
        if (currentDomain.endsWith(key)) {
            configKey = key;
            break;
        }
    }

    // If we found a matching domain in cookie_selectors.json:
    if (configKey && cookieConfigs[configKey].rejectSelector) {
        const foundAndClicked = await attemptSelectorClick(page, cookieConfigs[configKey].rejectSelector);
        if (foundAndClicked) {
            return; // done
        }
    }

    // Otherwise, fallback approach (Tealium shadow DOM, etc.)
    try {
        await page.evaluate(() => {
            const host = document.querySelector('#__tealiumGDPRecModal > tealium-consent');
            if (host && host.shadowRoot) {
                const banner = host.shadowRoot.querySelector(
                    'tealium-banner > div > tealium-button-group > tealium-button:nth-child(2)'
                );
                if (banner && banner.shadowRoot) {
                    const realBtn = banner.shadowRoot.querySelector('button');
                    if (realBtn) {
                        realBtn.click();
                    }
                }
            }
        });
        await waitMs(2000);
        console.log("✅ Fallback cookie banner attempt complete.");
    } catch (fallbackErr) {
        console.log(`⚠️ Fallback cookie banner error: ${fallbackErr.message}`);
    }
}

// Display Help
function displayHelp() {
    console.log(`
DeepScrape - Version 8 

Features: Spider, Cookie Banner acceptance, Full rendered screenshots after JS and lazy loading, and Sitemap Support)

Usage:
  node deepscrape.cjs [options]

Options:
  -h, --help           Show this help message and exit.
  --no-images          Skip downloading images from the page.
  --rate-limit <ms>    Delay between operations (default: 1000ms).
  -n <name>            (Optional) Name for the scan folder.
  -ss                  Save a full-page WEBP screenshot for each URL
                       (at 1440x900 in headless mode)
  -sm <sitemap_url>    Use the provided sitemap URL to read URLs instead of urls.txt
  -ign <ignore_urls>   (Optional) Comma-separated list of URL prefixes to ignore
                       (child pages will also be ignored)
  -u <url>             Scrape a single URL.
  -f <filepath>        Scrape URLs from a custom file instead of urls.txt.
  -spider <urls>       Spider one or more comma-separated URLs (within same domain).
                       Recursively find links on each page, check for broken links,
                       and produce spider_report.txt.

Examples:
  node deepscrape.cjs
  node deepscrape.cjs -ss -n MyScreens
  node deepscrape.cjs -ss --no-images -n NoImages
  node deepscrape.cjs --rate-limit 3000 -ss
  node deepscrape.cjs -sm https://example.com/sitemap.xml -ign "https://www.barclays.co.uk/branch-finder/,https://www.barclays.co.uk/contact-us/"
  node deepscrape.cjs -spider https://www.nationwide.co.uk/
`);
    process.exit(0);
}

// Read URLs from file
function readUrlsFromFile(filepath) {
    if (!fs.existsSync(filepath)) {
        console.error(`❌ File not found: ${filepath}`);
        return [];
    }
    try {
        const data = fs.readFileSync(filepath, 'utf8');
        return data.trim().split('\n').map(u => u.trim()).filter(Boolean);
    } catch (err) {
        console.error(`❌ Error reading file ${filepath}: ${err.message}`);
        return [];
    }
}

// Read URLs from sitemap
async function readUrlsFromSitemap(sitemapUrl) {
    console.log(`🔍 Fetching sitemap from: ${sitemapUrl}`);
    try {
        const resp = await axios.get(sitemapUrl);
        const xml = resp.data;
        const $ = cheerio.load(xml, { xmlMode: true });
        let urls = [];
        $('url').each((_, el) => {
            const loc = $(el).find('loc').text().trim();
            if (loc) {
                urls.push(loc);
            }
        });
        console.log(`✅ Found ${urls.length} URLs in sitemap.`);
        return urls;
    } catch (err) {
        console.error(`❌ Error fetching sitemap: ${sitemapUrl} => ${err.message}`);
        return [];
    }
}

// Generate a unique output directory
function generateUniqueOutputDir(baseDir = './output', name = '') {
    const timestamp = new Date().toISOString().replace(/[-:.]/g, '').replace('T', '_').slice(0, 15);
    const scanId = Math.random().toString(36).substr(2, 8);
    let folderName = `scan_${timestamp}_${scanId}`;
    if (name) {
        folderName += `_${name.replace(/\s+/g, '_')}`;
    }
    return path.join(baseDir, folderName);
}

// Ensure directory
function ensureDir(base, sub) {
    const out = path.join(base, sub);
    if (!fs.existsSync(out)) {
        fs.mkdirSync(out, { recursive: true });
        console.log(`📁 Created directory: ${out}`);
    }
    return out;
}

// Sanitize segments for folder or file name
function sanitizeSegment(segment) {
    return segment.replace(/[^a-zA-Z0-9.-]/g, '_');
}

// Build folder path based on the domain + sanitized segments
function buildFolderPath(url) {
    const parsed = new URL(url);
    const domainFolder = parsed.hostname;
    const pathSegments = parsed.pathname.split('/')
        .filter(seg => seg.trim().length > 0)
        .map(seg => sanitizeSegment(seg));

    if (!pathSegments.length) {
        return domainFolder;
    }
    return path.join(domainFolder, ...pathSegments);
}

// Download images
async function downloadImages(images, destDir, rate) {
    for (const imgUrl of images) {
        console.log(`📥 Downloading image: ${imgUrl}`);
        try {
            const resp = await axios({ url: imgUrl, method: 'GET', responseType: 'stream' });
            const filename = path.basename(new URL(imgUrl).pathname);
            const filePath = path.join(destDir, filename);
            resp.data.pipe(fs.createWriteStream(filePath));
            console.log(`✅ Image saved: ${filePath}`);
            if (rate > 0) {
                await new Promise(r => setTimeout(r, rate));
            }
        } catch (err) {
            console.error(`❌ Failed to download image: ${imgUrl} => ${err.message}`);
        }
    }
}

// Auto-scroll page to ensure lazy-loaded images appear
async function autoScroll(page) {
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 100;
            const timer = setInterval(() => {
                const scrollHeight = document.body.scrollHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;
                if (totalHeight >= scrollHeight - window.innerHeight) {
                    clearInterval(timer);
                    resolve();
                }
            }, 100);
        });
    });
}

// Capture screenshot as webp
async function captureWebpScreenshot(page, outPath) {
    console.log(`📸 Capturing screenshot => ${outPath}`);
    try {
        const pngBuf = await page.screenshot({
            fullPage: true,
            type: 'png'
        });
        await sharp(pngBuf).webp({ quality: 90 }).toFile(outPath);
        console.log(`✅ Screenshot saved as .webp => ${outPath}`);
    } catch (err) {
        console.error(`❌ Error capturing/converting screenshot => ${err.message}`);
    }
}

// A specialized helper to save the entire page (HTML, images, screenshot) for spider
async function scrapePageForSpider(page, url, outDir, skipImages, screenshotFlag, rate) {
    // 1) Save HTML
    const html = await page.content();
    const relativeFolderPath = buildFolderPath(url);
    const pageDir = ensureDir(outDir, relativeFolderPath);
    const baseName = path.basename(pageDir);
    const htmlFile = path.join(pageDir, `${baseName}.html`);
    fs.writeFileSync(htmlFile, `<!-- ${url} -->\n${html}`, 'utf8');
    console.log(`✅ [SPIDER] Saved HTML for: ${url} => ${htmlFile}`);

    // 2) Download images
    const imgs = await page.$$eval('img[src]', (els) =>
        els.map(img => img.getAttribute('src')).filter(Boolean)
    );
    if (imgs.length) {
        const imagesDir = ensureDir(pageDir, 'images');
        const fullImgUrls = imgs.map(src => new URL(src, url).href);
        const imagesTxt = path.join(imagesDir, 'images.txt');
        fs.writeFileSync(imagesTxt, fullImgUrls.join('\n'), 'utf8');
        console.log(`✅ [SPIDER] Saved image URLs => ${imagesTxt}`);
        if (!skipImages) {
            await downloadImages(fullImgUrls, imagesDir, rate);
        }
    }

    // 3) Screenshot
    if (screenshotFlag) {
        console.log(`📸 [SPIDER] Capturing screenshot for: ${url}`);
        // Ensure we see everything
        await autoScroll(page);
        await waitMs(2000);
        await page.evaluate(() => window.scrollTo(0, 0));
        await waitMs(1000);
        const screenshotFile = path.join(pageDir, `${baseName}.webp`);
        await captureWebpScreenshot(page, screenshotFile);
    }
}

// Spider mode: recursively discover same-domain links, check for broken links, and optionally scrape pages
async function spiderCrawl(startUrls, outDir, rate, maxDepth, skipImages, screenshotFlag) {
    const reportPath = path.join(outDir, 'spider_report.txt');
    const visited = new Set();
    const queue = [];

    // Convert comma-separated argument(s) into an array of seeds
    let seeds = [];
    for (const u of startUrls) {
        if (u.includes(',')) {
            seeds.push(...u.split(',').map(x => x.trim()).filter(Boolean));
        } else {
            seeds.push(u.trim());
        }
    }

    seeds.forEach(url => {
        queue.push({ url, depth: 0 });
        visited.add(url);
    });

    const results = []; // Will store { url, status }
    const browser = await puppeteer.launch({
        headless: true,
        defaultViewport: { width: 1440, height: 900 },
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    while (queue.length > 0) {
        const { url, depth } = queue.shift();
        console.log(`🕸️ Spider visiting: ${url}`);

        // HEAD request to check if link is valid
        let statusCode;
        try {
            const resp = await axios.head(url, { timeout: 10000 });
            statusCode = resp.status;
        } catch (error) {
            statusCode = (error.response && error.response.status)
                ? error.response.status
                : 'ERROR';
        }
        results.push({ url, status: statusCode });

        // If page is OK => open with Puppeteer, gather data, queue more links
        if (statusCode !== 'ERROR' && statusCode < 400 && depth < maxDepth) {
            try {
                const page = await browser.newPage();
                // Perform full GET to get HTML & links
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

                // Dismiss cookie banner
                await handleCookieBanner(page);

                // Save this page's content
                await scrapePageForSpider(page, url, outDir, skipImages, screenshotFlag, rate);

                // gather same-domain anchor links
                const domain = new URL(url).hostname;
                const anchors = await page.$$eval('a', (els) =>
                    els.map(a => a.getAttribute('href')).filter(Boolean)
                );
                await page.close();

                for (let link of anchors) {
                    try {
                        const newUrl = new URL(link, url).href;
                        const linkDomain = new URL(newUrl).hostname;
                        // same domain and not visited => queue it
                        if (linkDomain === domain && !visited.has(newUrl)) {
                            visited.add(newUrl);
                            queue.push({ url: newUrl, depth: depth + 1 });
                        }
                    } catch (e) {
                        // ignore invalid URLs
                    }
                }
            } catch (puppErr) {
                console.error(`❌ Puppeteer error on ${url}: ` + puppErr.message);
            }
        }

        // Rate limit
        if (rate > 0) {
            await new Promise(r => setTimeout(r, rate));
        }
    }

    // Write results to spider_report.txt
    let report = 'URL, STATUS\n';
    for (const r of results) {
        report += `${r.url}, ${r.status}\n`;
    }
    fs.writeFileSync(reportPath, report, 'utf8');
    console.log(`✅ Spider report written to: ${reportPath}`);

    await browser.close();
}

// Normal (non-spider) scraping
async function processUrls(urls, outDir, rate, screenshotFlag, skipImages) {
    const totalUrls = urls.length;
    const progressBar = new cliProgress.SingleBar(
        {
            format: 'Processing [{bar}] {percentage}% | {value}/{total} URLs | ETA: {eta_formatted} | Completion: {completion_time}',
            hideCursor: true
        },
        cliProgress.Presets.shades_classic
    );
    const startTime = Date.now();
    progressBar.start(totalUrls, 0, { completion_time: 'N/A' });

    const browser = await puppeteer.launch({
        headless: true,
        defaultViewport: { width: 1440, height: 900 },
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    for (let i = 0; i < totalUrls.length; i++) {
        const url = urls[i];
        console.log(`🌍 Fetching HTML for: ${url}`);
        try {
            const resp = await axios.get(url);
            const html = resp.data;

            // Build folder path
            const relativeFolderPath = buildFolderPath(url);
            const pageDir = ensureDir(outDir, relativeFolderPath);
            const baseName = path.basename(pageDir);

            // Save HTML
            const htmlFile = path.join(pageDir, `${baseName}.html`);
            fs.writeFileSync(htmlFile, `<!-- ${url} -->\n${html}`, 'utf8');
            console.log(`✅ Saved HTML: ${htmlFile}`);

            // Images
            const $ = cheerio.load(html);
            const imgs = [];
            $('img[src]').each((_, el) => {
                const src = $(el).attr('src');
                if (src) imgs.push(new URL(src, url).href);
            });
            if (imgs.length > 0) {
                const imagesDir = ensureDir(pageDir, 'images');
                const imagesTxt = path.join(imagesDir, 'images.txt');
                fs.writeFileSync(imagesTxt, imgs.join('\n'), 'utf8');
                console.log(`✅ Saved image URLs: ${imagesTxt}`);
                if (!skipImages) {
                    await downloadImages(imgs, imagesDir, rate);
                }
            }

            // Screenshots
            if (screenshotFlag) {
                console.log(`📸 Screenshot capturing: ${url}`);
                const page = await browser.newPage();
                await page.setViewport({ width: 1440, height: 900 });
                await page.goto(url, { waitUntil: 'networkidle0' });

                // Cookie banner dismissal
                await handleCookieBanner(page);

                // Wait more so banner can vanish
                await waitMs(2000);

                // Scroll
                await autoScroll(page);
                await waitMs(2000);

                // Return to top & finalize screenshot
                await page.evaluate(() => window.scrollTo(0, 0));
                await waitMs(1000);
                const screenshotFile = path.join(pageDir, `${baseName}.webp`);
                await captureWebpScreenshot(page, screenshotFile);

                await page.close();
            }

            // Rate limit
            if (rate > 0) {
                await new Promise(r => setTimeout(r, rate));
            }
        } catch (err) {
            console.error(`❌ Error for: ${url} => ${err.message}`);
        }

        // Update progress bar
        const processed = i + 1;
        const elapsed = Date.now() - startTime;
        const avgTime = elapsed / processed;
        const remaining = totalUrls.length - processed;
        const estimatedRemaining = avgTime * remaining;
        const finishTime = new Date(Date.now() + estimatedRemaining).toLocaleTimeString();
        progressBar.increment(1, { completion_time: finishTime });
    }
    progressBar.stop();
    console.log("🛑 Closing Puppeteer.");
    await browser.close();
}

// Main
async function main() {
    const args = process.argv.slice(2);

    if (args.includes('-h') || args.includes('--help')) {
        displayHelp();
    }

    const screenshotFlag = args.includes('-ss');
    const skipImages = args.includes('--no-images');
    const rateIndex = args.indexOf('--rate-limit');
    const rate = rateIndex !== -1 ? parseInt(args[rateIndex + 1], 10) : 1000;
    const nIndex = args.indexOf('-n');
    const scanName = nIndex !== -1 ? args[nIndex + 1] : '';
    const outDir = generateUniqueOutputDir('./output', scanName);
    console.log(`📂 Using output directory: ${outDir}`);

    // Spider mode
    if (args.includes('-spider')) {
        const spiderIndex = args.indexOf('-spider');
        const spiderArg = args[spiderIndex + 1];
        if (!spiderArg) {
            console.error('❌ No URL(s) provided with -spider flag.');
            process.exit(1);
        }
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

        const maxDepth = 2;
        await spiderCrawl(
            [spiderArg],
            outDir,
            rate,
            maxDepth,
            skipImages,
            screenshotFlag
        );
        console.log("✅ Spidering complete.");
        process.exit(0);
    }

    // Otherwise normal scraping
    let allUrls = [];
    if (args.includes('-sm')) {
        const smIndex = args.indexOf('-sm');
        const sitemapUrl = args[smIndex + 1];
        if (!sitemapUrl) {
            console.error('❌ No sitemap URL provided with -sm flag.');
            process.exit(1);
        }
        allUrls = await readUrlsFromSitemap(sitemapUrl);
        if (!allUrls.length) {
            console.error(`❌ Sitemap at ${sitemapUrl} returned no URLs.`);
            process.exit(1);
        }
        let ignoreList = [];
        if (args.includes('-ign')) {
            const ignIndex = args.indexOf('-ign');
            const ignArg = args[ignIndex + 1];
            if (ignArg) {
                ignoreList = ignArg.split(',').map(u => u.trim()).filter(Boolean);
            }
        }
        if (ignoreList.length > 0) {
            const initialCount = allUrls.length;
            allUrls = allUrls.filter(url => !ignoreList.some(ignoreUrl => url.startsWith(ignoreUrl)));
            console.log(`ℹ️ Filtered URLs using ignore list. ${initialCount} => ${allUrls.length} remaining.`);
        }
    } else if (args.includes('-u')) {
        const uIndex = args.indexOf('-u');
        const singleUrl = args[uIndex + 1];
        if (!singleUrl) {
            console.error('❌ No URL provided with -u flag.');
            process.exit(1);
        }
        allUrls = [singleUrl];
    } else if (args.includes('-f')) {
        const fIndex = args.indexOf('-f');
        const customFilePath = args[fIndex + 1];
        if (!customFilePath) {
            console.error('❌ No filepath provided with -f flag.');
            process.exit(1);
        }
        allUrls = readUrlsFromFile(customFilePath);
    } else {
        // Default: read from urls.txt
        allUrls = readUrlsFromFile('urls.txt');
        if (!allUrls.length) {
            console.error("❌ 'urls.txt' is empty or missing.");
            process.exit(1);
        }
    }

    await processUrls(allUrls, outDir, rate, screenshotFlag, skipImages);
    console.log("✅ Program completed.");
    process.exit(0);
}

main();
