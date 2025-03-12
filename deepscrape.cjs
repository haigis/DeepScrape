const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const sharp = require('sharp');
const { URL } = require('url');
const cliProgress = require('cli-progress');

// =============================
// 1) Utility Functions
// =============================

// Simple wait for older Puppeteer versions lacking page.waitForTimeout
function waitMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Load cookie banner configurations
let cookieConfigs = {};
try {
    const configData = fs.readFileSync('cookie_selectors.json', 'utf8');
    cookieConfigs = JSON.parse(configData);
    console.log("✅ Loaded cookie_selectors.json configuration.");
} catch (e) {
    console.error("❌ Could not load cookie_selectors.json:", e.message);
}

// Attempt to click the provided selector
async function attemptSelectorClick(page, selector) {
    try {
        await page.waitForSelector(selector, { timeout: 1500 });
        await page.click(selector);
        await waitMs(2000);
        console.log(`✅ Cookie banner closed with selector: ${selector}`);
        return true;
    } catch (err) {
        console.log(`⚠️ Could not click cookie banner "${selector}": ${err.message}`);
        return false;
    }
}

// Handle cookie banner
async function handleCookieBanner(page) {
    const domain = new URL(page.url()).hostname;

    // See if domain matches a key in cookieConfigs
    let configKey = null;
    for (const key in cookieConfigs) {
        if (domain.endsWith(key)) {
            configKey = key;
            break;
        }
    }
    // If found
    if (configKey && cookieConfigs[configKey].rejectSelector) {
        const success = await attemptSelectorClick(page, cookieConfigs[configKey].rejectSelector);
        if (success) return;
    }

    // Otherwise fallback logic
    try {
        await page.evaluate(() => {
            const host = document.querySelector('#__tealiumGDPRecModal > tealium-consent');
            if (host && host.shadowRoot) {
                const banner = host.shadowRoot.querySelector('tealium-banner > div > tealium-button-group > tealium-button:nth-child(2)');
                if (banner && banner.shadowRoot) {
                    const realBtn = banner.shadowRoot.querySelector('button');
                    if (realBtn) realBtn.click();
                }
            }
        });
        await waitMs(2000);
        console.log("✅ Fallback cookie banner attempt complete.");
    } catch (err) {
        console.log(`⚠️ Fallback cookie banner error: ${err.message}`);
    }
}

// Print help
function displayHelp() {
    console.log(`
DeepScrape - Version 8

Features: 
 - Spider Mode 
 - Cookie Banner Acceptance 
 - Full rendered screenshots (after JS & lazy loading) 
 - Sitemap Support
 - Single-URL & Multi-URL scanning

Usage:
  node deepscrape.cjs [options]

Options:
  -h, --help           Show help message.
  --no-images          Skip downloading images.
  --rate-limit <ms>    Delay between operations (default: 1000ms).
  -n <name>            Custom name for scan folder.
  -ss                  Save a full-page WEBP screenshot for each URL (1440x900).
  -sm <sitemap_url>    Load URLs from specified sitemap.
  -ign <ignore_urls>   Comma-separated list of URL prefixes to ignore.
  -u <url>             Scrape a single URL.
  -f <filepath>        Scrape from custom file of URLs.
  -spider <urls>       Spider (recursively) same-domain links. Also saves HTML, images, screenshots.
`);
    process.exit(0);
}

// Read URLs from a text file
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
            if (loc) urls.push(loc);
        });
        console.log(`✅ Found ${urls.length} URLs in sitemap.`);
        return urls;
    } catch (err) {
        console.error(`❌ Error fetching sitemap: ${sitemapUrl} => ${err.message}`);
        return [];
    }
}

// Generate a unique output dir
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

// Sanitize folder segment
function sanitizeSegment(segment) {
    return segment.replace(/[^a-zA-Z0-9.-]/g, '_');
}

// Build folder path from URL
function buildFolderPath(url) {
    const parsed = new URL(url);
    const domain = parsed.hostname;
    const segments = parsed.pathname.split('/').filter(Boolean).map(sanitizeSegment);
    if (!segments.length) return domain;
    return path.join(domain, ...segments);
}

// Download images
async function downloadImages(imgUrls, destDir, rate) {
    for (const imgUrl of imgUrls) {
        console.log(`📥 Downloading image: ${imgUrl}`);
        try {
            const resp = await axios({ url: imgUrl, method: 'GET', responseType: 'stream' });
            const filename = path.basename(new URL(imgUrl).pathname);
            const filePath = path.join(destDir, filename);
            resp.data.pipe(fs.createWriteStream(filePath));
            console.log(`✅ Image saved: ${filePath}`);
            if (rate > 0) await waitMs(rate);
        } catch (err) {
            console.error(`❌ Failed to download image: ${imgUrl} => ${err.message}`);
        }
    }
}

// Auto-scroll to handle lazy loading
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
        const pngBuf = await page.screenshot({ fullPage: true, type: 'png' });
        await sharp(pngBuf).webp({ quality: 90 }).toFile(outPath);
        console.log(`✅ Screenshot saved: ${outPath}`);
    } catch (err) {
        console.error(`❌ Screenshot error => ${err.message}`);
    }
}

// =============================
// 2) Spider Mode
// =============================

async function spiderCrawl(startUrls, outDir, rate, maxDepth, skipImages, screenshotFlag) {
    const reportPath = path.join(outDir, 'spider_report.txt');
    const visited = new Set();
    const queue = [];
    const results = [];

    // Expand comma-separated seeds
    const seeds = [];
    for (const u of startUrls) {
        if (u.includes(',')) seeds.push(...u.split(',').map(x => x.trim()).filter(Boolean));
        else seeds.push(u.trim());
    }
    // Enqueue them
    for (const s of seeds) {
        queue.push({ url: s, depth: 0 });
        visited.add(s);
    }

    const browser = await puppeteer.launch({
        headless: true,
        defaultViewport: { width: 1440, height: 900 },
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    while (queue.length) {
        const { url, depth } = queue.shift();
        console.log(`🕸️ Spider visiting: ${url}`);

        let statusCode;
        try {
            const resp = await axios.head(url, { timeout: 10000 });
            statusCode = resp.status;
        } catch (err) {
            statusCode = err.response ? err.response.status : 'ERROR';
        }
        results.push({ url, status: statusCode });

        if (statusCode !== 'ERROR' && statusCode < 400 && depth < maxDepth) {
            try {
                const page = await browser.newPage();
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await handleCookieBanner(page);

                // 1) Save HTML
                const html = await page.content();
                const relativeFolderPath = buildFolderPath(url);
                const pageDir = ensureDir(outDir, relativeFolderPath);
                const baseName = path.basename(pageDir);

                // Write HTML
                const htmlFile = path.join(pageDir, `${baseName}.html`);
                fs.writeFileSync(htmlFile, `<!-- ${url} -->\n${html}`, 'utf8');
                console.log(`✅ [SPIDER] Saved HTML: ${htmlFile}`);

                // 2) Images
                const imgs = await page.$$eval('img[src]', els => els.map(i => i.getAttribute('src')).filter(Boolean));
                if (imgs.length) {
                    const fullImgUrls = imgs.map(src => new URL(src, url).href);
                    const imagesDir = ensureDir(pageDir, 'images');
                    const imagesTxt = path.join(imagesDir, 'images.txt');
                    fs.writeFileSync(imagesTxt, fullImgUrls.join('\n'), 'utf8');
                    console.log(`✅ [SPIDER] Saved image URLs: ${imagesTxt}`);
                    if (!skipImages) {
                        await downloadImages(fullImgUrls, imagesDir, rate);
                    }
                }

                // 3) Screenshot
                if (screenshotFlag) {
                    console.log(`📸 [SPIDER] Capturing screenshot: ${url}`);
                    await autoScroll(page);
                    await waitMs(2000);
                    await page.evaluate(() => window.scrollTo(0, 0));
                    await waitMs(1000);
                    const screenshotFile = path.join(pageDir, `${baseName}.webp`);
                    await captureWebpScreenshot(page, screenshotFile);
                }

                // 4) Gather new links
                const domain = new URL(url).hostname;
                const anchors = await page.$$eval('a', els => els.map(a => a.getAttribute('href')).filter(Boolean));
                await page.close();

                for (const link of anchors) {
                    try {
                        const newUrl = new URL(link, url).href;
                        if (new URL(newUrl).hostname === domain && !visited.has(newUrl)) {
                            visited.add(newUrl);
                            queue.push({ url: newUrl, depth: depth + 1 });
                        }
                    } catch (err) {
                        // ignore invalid
                    }
                }
            } catch (puppErr) {
                console.error(`❌ Puppeteer error on ${url}: ${puppErr.message}`);
            }
        }

        if (rate > 0) await waitMs(rate);
    }

    // Write spider_report
    let report = 'URL, STATUS\n';
    for (const r of results) {
        report += `${r.url}, ${r.status}\n`;
    }
    fs.writeFileSync(reportPath, report, 'utf8');
    console.log(`✅ Spider report written: ${reportPath}`);

    await browser.close();
}

// =============================
// 3) Normal Scrape (Non-Spider)
// =============================

async function scrapePage(browser, url, outDir, skipImages, screenshotFlag, rate) {
    console.log(`🌍 Navigating: ${url}`);

    // Puppeteer page
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });

    // Goto
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await handleCookieBanner(page);

    // Wait a bit for banner to close
    await waitMs(2000);

    // 1) Get HTML
    const html = await page.content();
    const relativeFolderPath = buildFolderPath(url);
    const pageDir = ensureDir(outDir, relativeFolderPath);
    const baseName = path.basename(pageDir);

    const htmlFile = path.join(pageDir, `${baseName}.html`);
    fs.writeFileSync(htmlFile, `<!-- ${url} -->\n${html}`, 'utf8');
    console.log(`✅ Saved HTML: ${htmlFile}`);

    // 2) Collect images
    const imgs = await page.$$eval('img[src]', els => els.map(i => i.getAttribute('src')).filter(Boolean));
    if (imgs.length) {
        const fullImgUrls = imgs.map(src => new URL(src, url).href);
        const imagesDir = ensureDir(pageDir, 'images');
        const imagesTxt = path.join(imagesDir, 'images.txt');
        fs.writeFileSync(imagesTxt, fullImgUrls.join('\n'), 'utf8');
        console.log(`✅ Saved image URLs: ${imagesTxt}`);
        if (!skipImages) {
            await downloadImages(fullImgUrls, imagesDir, rate);
        }
    }

    // 3) Screenshot
    if (screenshotFlag) {
        console.log(`📸 Screenshot capturing: ${url}`);
        await autoScroll(page);
        await waitMs(2000);
        await page.evaluate(() => window.scrollTo(0, 0));
        await waitMs(1000);
        const screenshotFile = path.join(pageDir, `${baseName}.webp`);
        await captureWebpScreenshot(page, screenshotFile);
    }

    await page.close();
}

async function processUrls(urls, outDir, rate, screenshotFlag, skipImages) {
    const total = urls.length;
    if (!total) {
        console.error("❌ No URLs to process.");
        return;
    }

    // Setup progress bar
    const progressBar = new cliProgress.SingleBar({
        format: 'Processing [{bar}] {percentage}% | {value}/{total} URLs | ETA: {eta_formatted} | Completion: {completion_time}',
        hideCursor: true
    }, cliProgress.Presets.shades_classic);

    const browser = await puppeteer.launch({
        headless: true,
        defaultViewport: { width: 1440, height: 900 },
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    progressBar.start(total, 0, { completion_time: 'N/A' });
    const startTime = Date.now();

    for (let i = 0; i < total; i++) {
        const url = urls[i];
        try {
            await scrapePage(browser, url, outDir, skipImages, screenshotFlag, rate);
        } catch (err) {
            console.error(`❌ Error scraping ${url}: ${err.message}`);
        }

        if (rate > 0) await waitMs(rate);

        // Update progress bar
        const processed = i + 1;
        const elapsed = Date.now() - startTime;
        const avgTime = elapsed / processed;
        const remaining = total - processed;
        const estimatedRemaining = avgTime * remaining;
        const finishTime = new Date(Date.now() + estimatedRemaining).toLocaleTimeString();
        progressBar.increment(1, { completion_time: finishTime });
    }

    progressBar.stop();
    console.log("🛑 Closing Puppeteer.");
    await browser.close();
}

// =============================
// 4) Main
// =============================

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

    // Check if spider mode
    if (args.includes('-spider')) {
        const spiderIndex = args.indexOf('-spider');
        const spiderArg = args[spiderIndex + 1];
        if (!spiderArg) {
            console.error('❌ No URL(s) provided with -spider flag.');
            process.exit(1);
        }
        fs.mkdirSync(outDir, { recursive: true });

        // Hard-coded depth=2 (adjust if desired)
        await spiderCrawl([spiderArg], outDir, rate, 2, skipImages, screenshotFlag);
        console.log("✅ Spidering complete.");
        process.exit(0);
    }

    // Otherwise normal scanning
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
        if (args.includes('-ign')) {
            const ignIndex = args.indexOf('-ign');
            const ignArg = args[ignIndex + 1];
            if (ignArg) {
                const ignoreList = ignArg.split(',').map(x => x.trim()).filter(Boolean);
                const initialCount = allUrls.length;
                allUrls = allUrls.filter(url => !ignoreList.some(ig => url.startsWith(ig)));
                console.log(`ℹ️ Filtered URLs. ${initialCount} => ${allUrls.length} remain.`);
            }
        }
    } else if (args.includes('-u')) {
        const uIndex = args.indexOf('-u');
        const singleUrl = args[uIndex + 1];
        if (!singleUrl) {
            console.error("❌ No URL provided after '-u' flag.");
            process.exit(1);
        }
        allUrls = [singleUrl];
    } else if (args.includes('-f')) {
        const fIndex = args.indexOf('-f');
        const filepath = args[fIndex + 1];
        if (!filepath) {
            console.error("❌ No filepath provided after '-f' flag.");
            process.exit(1);
        }
        allUrls = readUrlsFromFile(filepath);
        if (!allUrls.length) {
            console.error(`❌ No valid URLs found in file: ${filepath}`);
            process.exit(1);
        }
    } else {
        // Default: read from urls.txt
        allUrls = readUrlsFromFile('urls.txt');
        if (!allUrls.length) {
            console.error("❌ 'urls.txt' is empty or missing.");
            process.exit(1);
        }
    }

    // Make sure outDir exists
    fs.mkdirSync(outDir, { recursive: true });

    // Now do normal scraping
    await processUrls(allUrls, outDir, rate, screenshotFlag, skipImages);

    console.log("✅ Program completed.");
    process.exit(0);
}

main();
