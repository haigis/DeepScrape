// deepscrape.cjs

// Imports
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const sharp = require('sharp');
const { URL } = require('url');
const cliProgress = require('cli-progress');

// Import cookie banner handler (CommonJS)
const { handleCookieBanner, waitMs } = require('./cookie_handler.cjs');

// =============================
// 1) Utility Functions
// =============================

function generateUniqueOutputDir(baseDir = './output', name = '') {
  const timestamp = new Date().toISOString().replace(/[-:.]/g, '').replace('T', '_').slice(0, 15);
  const scanId = Math.random().toString(36).substr(2, 8);
  return path.join(baseDir, `scan_${timestamp}_${scanId}${name ? '_' + name : ''}`);
}

function ensureDir(base, sub) {
  const out = path.join(base, sub);
  if (!fs.existsSync(out)) fs.mkdirSync(out, { recursive: true });
  return out;
}

function sanitizeSegment(segment) {
  return segment.replace(/[^a-zA-Z0-9.-]/g, '_');
}

function buildFolderPath(url) {
  const { hostname, pathname } = new URL(url);
  const segments = pathname.split('/').filter(Boolean).map(sanitizeSegment);
  return segments.length ? path.join(hostname, ...segments) : hostname;
}

// Read URLs from a file
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

async function downloadImages(imgUrls, destDir, rateLimit) {
  for (const imgUrl of imgUrls) {
    console.log(`📥 Downloading image: ${imgUrl}`);
    try {
      const resp = await axios({ url: imgUrl, method: 'GET', responseType: 'stream' });
      const filename = path.basename(new URL(imgUrl).pathname);
      const filePath = path.join(destDir, filename);
      resp.data.pipe(fs.createWriteStream(filePath));
      console.log(`✅ Image saved: ${filePath}`);
      if (rateLimit > 0) await waitMs(rateLimit);
    } catch (err) {
      console.error(`❌ Failed to download image: ${imgUrl} => ${err.message}`);
    }
  }
}

async function autoScroll(page) {
  await page.evaluate(() => new Promise(resolve => {
    let total = 0;
    const interval = setInterval(() => {
      window.scrollBy(0, 100);
      total += 100;
      if (total >= document.body.scrollHeight) {
        clearInterval(interval);
        resolve();
      }
    }, 100);
  }));
}

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
// 2) Regular Scan Mode
// =============================

async function scrapePage(browser, url, outDir, skipImages, screenshotFlag, rateLimit) {
  console.log(`🌍 Navigating: ${url}`);
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await handleCookieBanner(page, new URL(url).hostname);
  await waitMs(2000);

  // Save HTML
  const html = await page.content();
  const relativeFolderPath = buildFolderPath(url);
  const pageDir = ensureDir(outDir, relativeFolderPath);
  const baseName = path.basename(pageDir);
  const htmlFile = path.join(pageDir, `${baseName}.html`);
  fs.writeFileSync(htmlFile, `<!-- ${url} -->\n${html}`, 'utf8');
  console.log(`✅ Saved HTML: ${htmlFile}`);

  // Download images
  const imgUrls = await page.$$eval('img[src]', imgs => imgs.map(img => img.src).filter(Boolean));
  if (imgUrls.length > 0) {
    const imagesDir = ensureDir(pageDir, 'images');
    const imagesTxt = path.join(imagesDir, 'images.txt');
    fs.writeFileSync(imagesTxt, imgUrls.join('\n'), 'utf8');
    console.log(`✅ Saved image URLs: ${imagesTxt}`);
    if (!skipImages) {
      await downloadImages(imgUrls, imagesDir, rateLimit);
    }
  }

  // Screenshot
  if (screenshotFlag) {
    console.log(`📸 Capturing screenshot for: ${url}`);
    await autoScroll(page);
    await waitMs(2000);
    await page.evaluate(() => window.scrollTo(0, 0));
    await waitMs(1000);
    const screenshotFile = path.join(pageDir, `${baseName}.webp`);
    await captureWebpScreenshot(page, screenshotFile);
  }

  await page.close();
}

async function processUrls(urls, outDir, rateLimit, screenshotFlag, skipImages) {
  const total = urls.length;
  if (!total) {
    console.error("❌ No URLs to process.");
    return;
  }
  console.log(`🚀 Starting scraping of ${total} URLs...`);

  const progressBar = new cliProgress.SingleBar({
    format: 'Processing [{bar}] {percentage}% | {value}/{total} URLs | ETA: {eta_formatted}',
    hideCursor: true
  }, cliProgress.Presets.shades_classic);
  
  const browser = await puppeteer.launch({
    headless: true,
    defaultViewport: { width: 1440, height: 900 },
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  progressBar.start(total, 0);
  for (let i = 0; i < total; i++) {
    const url = urls[i];
    try {
      await scrapePage(browser, url, outDir, skipImages, screenshotFlag, rateLimit);
    } catch (err) {
      console.error(`❌ Error scraping ${url}: ${err.message}`);
    }
    if (rateLimit > 0) await waitMs(rateLimit);
    progressBar.increment();
  }
  progressBar.stop();
  await browser.close();
  console.log("✅ All URLs processed.");
}

// =============================
// 3) Spider Mode
// =============================

async function spiderCrawl(startUrls, outDir, rateLimit, maxDepth, skipImages, screenshotFlag) {
  const urlsFilePath = path.join(outDir, 'urls.txt');
  const reportPath = path.join(outDir, 'spider_report.txt');

  // Create initial files with headers
  fs.writeFileSync(urlsFilePath, "Visited URLs:\n", 'utf8');
  fs.writeFileSync(reportPath, "Crawl Report:\n", 'utf8');

  const visited = new Set();
  const queue = startUrls.map(url => ({ url, depth: 0 }));
  const results = [];

  function normalizeUrl(url) {
    try {
      let parsedUrl = new URL(url);
      parsedUrl.hash = "";
      parsedUrl.protocol = "https:";
      parsedUrl.pathname = parsedUrl.pathname.replace(/\/$/, "");
      parsedUrl.searchParams.sort();
      return parsedUrl.toString();
    } catch (err) {
      return url;
    }
  }

  // Enqueue initial URLs and log them
  for (const u of startUrls) {
    const norm = normalizeUrl(u);
    if (!visited.has(norm)) {
      queue.push({ url: norm, depth: 0 });
      visited.add(norm);
      fs.appendFileSync(urlsFilePath, norm + '\n', 'utf8');
    }
  }

  const browser = await puppeteer.launch({
    headless: true,
    defaultViewport: { width: 1440, height: 900 },
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  while (queue.length > 0) {
    const { url, depth } = queue.shift();
    console.log(`🕸️ [Depth ${depth}] Spider visiting: ${url}`);

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
        await handleCookieBanner(page, new URL(url).hostname);

        // Save HTML
        const html = await page.content();
        const relativeFolderPath = buildFolderPath(url);
        const pageDir = ensureDir(outDir, relativeFolderPath);
        const baseName = path.basename(pageDir);
        const htmlFile = path.join(pageDir, `${baseName}.html`);
        fs.writeFileSync(htmlFile, `<!-- ${url} -->\n${html}`, 'utf8');
        console.log(`✅ [SPIDER] Saved HTML: ${htmlFile}`);
        fs.appendFileSync(reportPath, `Visited: ${url} [Depth: ${depth}]\n`, 'utf8');

        // Save images
        const imgs = await page.$$eval('img[src]', els => els.map(i => i.getAttribute('src')).filter(Boolean));
        if (imgs.length) {
          const fullImgUrls = imgs.map(src => new URL(src, url).href);
          const imagesDir = ensureDir(pageDir, 'images');
          const imagesTxt = path.join(imagesDir, 'images.txt');
          fs.writeFileSync(imagesTxt, fullImgUrls.join('\n'), 'utf8');
          console.log(`✅ [SPIDER] Saved image URLs: ${imagesTxt}`);
          if (!skipImages) {
            await downloadImages(fullImgUrls, imagesDir, rateLimit);
          }
        }

        // Capture screenshot
        if (screenshotFlag) {
          console.log(`📸 [SPIDER] Capturing screenshot: ${url}`);
          await autoScroll(page);
          await waitMs(2000);
          await page.evaluate(() => window.scrollTo(0, 0));
          await waitMs(1000);
          const screenshotFile = path.join(pageDir, `${baseName}.webp`);
          await captureWebpScreenshot(page, screenshotFile);
        }

        // Enqueue internal links within same domain
        const domain = new URL(url).hostname;
        const anchors = await page.$$eval('a', els => els.map(a => a.getAttribute('href')).filter(Boolean));
        await page.close();
        for (const link of anchors) {
          try {
            const newUrl = new URL(link, url).href;
            if (new URL(newUrl).hostname === domain && !visited.has(newUrl)) {
              visited.add(newUrl);
              queue.push({ url: newUrl, depth: depth + 1 });
              fs.appendFileSync(urlsFilePath, newUrl + '\n', 'utf8');
            }
          } catch (err) {
            // ignore invalid URLs
          }
        }
      } catch (puppErr) {
        console.error(`❌ Puppeteer error on ${url}: ${puppErr.message}`);
      }
    }
    if (rateLimit > 0) await waitMs(rateLimit);
  }

  // Write final report
  const reportFile = path.join(outDir, 'spider_report.txt');
  const reportLines = results.map(r => `${r.url}, ${r.status}`);
  fs.writeFileSync(reportFile, ['URL, STATUS', ...reportLines].join('\n'), 'utf8');
  console.log(`✅ Spider report written: ${reportFile}`);

  await browser.close();
  console.log("✅ Spider crawl completed.");
}

// =============================
// 4) Main Execution Logic
// =============================

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
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

  const screenshotFlag = args.includes('-ss');
  const skipImages = args.includes('--no-images');
  const rateLimit = args.includes('--rate-limit') ? parseInt(args[args.indexOf('--rate-limit') + 1], 10) : 1000;
  const scanName = args.includes('-n') ? args[args.indexOf('-n') + 1] : '';
  const outDir = generateUniqueOutputDir('./output', scanName);
  console.log(`📂 Using output directory: ${outDir}`);

  let urls = [];
  if (args.includes('-spider')) {
    const spiderUrl = args[args.indexOf('-spider') + 1];
    if (!spiderUrl) {
      console.error("❌ No URL provided with -spider flag.");
      process.exit(1);
    }
    fs.mkdirSync(outDir, { recursive: true });
    const maxDepth = 2; // Adjust recursion depth as desired
    await spiderCrawl([spiderUrl], outDir, rateLimit, maxDepth, skipImages, screenshotFlag);
    console.log("✅ Spidering complete.");
    process.exit(0);
  } else if (args.includes('-sm')) {
    const sitemapUrl = args[args.indexOf('-sm') + 1];
    urls = await readUrlsFromSitemap(sitemapUrl);
    if (!urls.length) {
      console.error(`❌ Sitemap at ${sitemapUrl} returned no URLs.`);
      process.exit(1);
    }
    if (args.includes('-ign')) {
      const ignoreList = args[args.indexOf('-ign') + 1].split(',').map(x => x.trim()).filter(Boolean);
      const initialCount = urls.length;
      urls = urls.filter(url => !ignoreList.some(ig => url.startsWith(ig)));
      console.log(`ℹ️ Filtered URLs. ${initialCount} => ${urls.length} remain.`);
    }
  } else if (args.includes('-u')) {
    const singleUrl = args[args.indexOf('-u') + 1];
    if (!singleUrl) {
      console.error("❌ No URL provided after '-u' flag.");
      process.exit(1);
    }
    urls = [singleUrl];
  } else if (args.includes('-f')) {
    const filePath = args[args.indexOf('-f') + 1];
    if (!fs.existsSync(filePath)) {
      console.error(`❌ File not found: ${filePath}`);
      process.exit(1);
    }
    urls = fs.readFileSync(filePath, 'utf8').trim().split('\n').map(line => line.trim()).filter(Boolean);
  } else {
    urls = readUrlsFromFile('urls.txt');
    if (!urls.length) {
      console.error("❌ 'urls.txt' is empty or missing.");
      process.exit(1);
    }
  }

  fs.mkdirSync(outDir, { recursive: true });
  await processUrls(urls, outDir, rateLimit, screenshotFlag, skipImages);
  console.log("✅ Program completed successfully.");
  process.exit(0);
}

main();
