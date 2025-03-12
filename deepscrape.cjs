const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const sharp = require('sharp');
const { URL } = require('url');

// ✅ Display Help
function displayHelp() {
    console.log(`
DeepScrape - Version 7 (Cookie Banner + WEBP Screenshot)

Usage:
  node deepscrape.cjs [options]

Options:
  -h, --help           Show this help message and exit.
  --no-images          Skip downloading images from the page.
  --rate-limit <ms>    Delay between operations (default: 1000ms).
  -n <name>            (Optional) Name for the scan folder.
  -ss                  Save a full-page WEBP screenshot for each URL.
                       (at 1440x900 in headless mode)

Examples:
1) Minimal scan:
   node deepscrape.cjs
2) Save screenshots in WEBP:
   node deepscrape.cjs -ss -n MyScreens
3) No images, with screenshots:
   node deepscrape.cjs -ss --no-images -n NoImages
4) Rate limit 3s:
   node deepscrape.cjs --rate-limit 3000 -ss
`);
    process.exit(0);
}

// ✅ Read URLs
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

// ✅ Generate Unique Output Dir
function generateUniqueOutputDir(baseDir = './output', name = '') {
    const timestamp = new Date().toISOString().replace(/[-:.]/g, '').replace('T', '_').slice(0, 15);
    const scanId = Math.random().toString(36).substr(2, 8);
    let folderName = `scan_${timestamp}_${scanId}`;
    if (name) {
        folderName += `_${name.replace(/\s+/g, '_')}`;
    }
    return path.join(baseDir, folderName);
}

// ✅ Ensure Directory
function ensureDir(base, sub) {
    const out = path.join(base, sub);
    if (!fs.existsSync(out)) {
        fs.mkdirSync(out, { recursive: true });
        console.log(`📁 Created directory: ${out}`);
    }
    return out;
}

// ✅ Convert domain+path => folder
function sanitizeUrlToFolderName(url) {
    return url
        .replace(/[^a-zA-Z0-9]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '');
}

// ✅ Download images
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

// ✅ Function to click "Reject optional cookies" in a Shadow DOM
async function clickRejectOptionalCookiesShadowDom(page) {
    console.log('🔍 Attempting to click "Reject optional cookies" in Shadow DOM...');
    try {
        // Wait for the main host up to 5s
        await page.waitForSelector('#__tealiumGDPRecModal > tealium-consent', { timeout: 5000 });

        // Evaluate in the browser context
        await page.evaluate(() => {
            const host = document.querySelector('#__tealiumGDPRecModal > tealium-consent');
            if (!host || !host.shadowRoot) {
                console.warn('⚠️ Shadow host or root not found');
                return;
            }
            const banner = host.shadowRoot.querySelector('tealium-banner > div > tealium-button-group > tealium-button:nth-child(2)');
            if (!banner || !banner.shadowRoot) {
                console.warn('⚠️ tealium-button not found in second child');
                return;
            }
            const realBtn = banner.shadowRoot.querySelector('button');
            if (!realBtn) {
                console.warn('⚠️ No final <button> inside tealium-button');
                return;
            }
            realBtn.click();
            console.log('✅ Clicked "Reject optional cookies" in shadow DOM');
        });

        // short wait
        await page.waitForTimeout(2000);
    } catch (err) {
        console.warn(`⚠️ Could not click "Reject optional cookies" => ${err.message}`);
    }
}

// ✅ Capture full-page screenshot => .webp
async function captureWebpScreenshot(page, outPath) {
    console.log(`📸 Capturing screenshot => ${outPath}`);
    try {
        // 1) capture PNG in memory
        const pngBuf = await page.screenshot({
            fullPage: true,
            type: 'png'
        });

        // 2) convert PNG => WEBP with "sharp"
        await sharp(pngBuf).webp({ quality: 90 }).toFile(outPath);
        console.log(`✅ Screenshot saved as .webp => ${outPath}`);
    } catch (err) {
        console.error(`❌ Error capturing/converting screenshot => ${err.message}`);
    }
}

// ✅ Process URLs
async function processUrls(urls, outDir, rate, screenshotFlag, skipImages) {
    // Launch headless, 1440x900
    const browser = await puppeteer.launch({
        headless: true,
        defaultViewport: { width: 1440, height: 900 },
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox'
        ]
    });

    for (const url of urls) {
        console.log(`🌍 Fetching HTML for: ${url}`);
        try {
            // get raw HTML
            const resp = await axios.get(url);
            const html = resp.data;

            const parsed = new URL(url);
            const domainPath = parsed.hostname + parsed.pathname;
            const folderName = sanitizeUrlToFolderName(domainPath) || 'root';

            const htmlDir = ensureDir(outDir, `html/${folderName}`);
            const imagesDir = ensureDir(outDir, `images/${folderName}`);
            const screenshotDir = ensureDir(outDir, `screenshots/${folderName}`);

            // Save the HTML
            const htmlFile = path.join(htmlDir, 'index.html');
            fs.writeFileSync(htmlFile, `<!-- ${url} -->\n${html}`, 'utf8');
            console.log(`✅ Saved HTML: ${htmlFile}`);

            // Extract images
            const $ = cheerio.load(html);
            const imgs = [];
            $('img[src]').each((_, el) => {
                const src = $(el).attr('src');
                if (src) imgs.push(new URL(src, url).href);
            });

            if (imgs.length > 0) {
                const imagesTxt = path.join(imagesDir, 'images.txt');
                fs.writeFileSync(imagesTxt, imgs.join('\n'), 'utf8');
                console.log(`✅ Saved image URLs: ${imagesTxt}`);

                if (!skipImages) {
                    await downloadImages(imgs, imagesDir, rate);
                }
            }

            // If user specified -ss (screenshots)
            if (screenshotFlag) {
                console.log(`📸 Screenshot capturing: ${url}`);

                const page = await browser.newPage();

                // confirm the viewport
                await page.setViewport({ width: 1440, height: 900 });

                await page.goto(url, { waitUntil: 'networkidle0' });

                // Press "Reject optional cookies" in the Shadow DOM
                await clickRejectOptionalCookiesShadowDom(page);

                // short wait
                await new Promise(r => setTimeout(r, 2000));

                const webpFile = path.join(screenshotDir, 'index.webp');
                await captureWebpScreenshot(page, webpFile);

                await page.close();
            }

            if (rate > 0) {
                await new Promise(r => setTimeout(r, rate));
            }
        } catch (err) {
            console.error(`❌ Error for: ${url} => ${err.message}`);
        }
    }

    console.log("🛑 Closing Puppeteer.");
    await browser.close();
}

// ✅ Main
async function main() {
    const args = process.argv.slice(2);

    if (args.includes('-h') || args.includes('--help')) {
        displayHelp();
    }

    const screenshotFlag = args.includes('-ss'); // e.g. "node deepscrape.cjs -ss"
    const skipImages = args.includes('--no-images');

    const rateIndex = args.indexOf('--rate-limit');
    const rate = rateIndex !== -1 ? parseInt(args[rateIndex + 1], 10) : 1000;

    const nIndex = args.indexOf('-n');
    const scanName = nIndex !== -1 ? args[nIndex + 1] : '';

    const outDir = generateUniqueOutputDir('./output', scanName);
    console.log(`📂 Using output directory: ${outDir}`);

    // read urls
    const allUrls = readUrlsFromFile('urls.txt');
    if (!allUrls.length) {
        console.error("❌ 'urls.txt' is empty or missing.");
        process.exit(1);
    }

    await processUrls(allUrls, outDir, rate, screenshotFlag, skipImages);

    console.log("✅ Program completed.");
    process.exit(0);
}

main();
