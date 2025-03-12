// deepscrape.cjs – Part 1/4

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

// Utility: Generate a unique output directory for each scan
function generateUniqueOutputDir(baseDir = './output', name = '') {
  const timestamp = new Date().toISOString().replace(/[-:.]/g, '').replace('T', '_').slice(0, 15);
  const scanId = Math.random().toString(36).substr(2, 8);
  return path.join(baseDir, `scan_${timestamp}_${scanId}${name ? '_' + name : ''}`);
}

// Utility: Ensure a directory exists (create if not)
function ensureDir(base, sub) {
  const out = path.join(base, sub);
  if (!fs.existsSync(out)) {
    fs.mkdirSync(out, { recursive: true });
    console.log(`📁 Created directory: ${out}`);
  }
  return out;
}

// Utility: Sanitize URL segments to be filesystem‑friendly
function sanitizeSegment(segment) {
  return segment.replace(/[^a-zA-Z0-9.-]/g, '_');
}

// Utility: Build folder taxonomy from URL (hostname plus path segments)
function buildFolderPath(url) {
  const { hostname, pathname } = new URL(url);
  const segments = pathname.split('/').filter(Boolean).map(sanitizeSegment);
  return segments.length ? path.join(hostname, ...segments) : hostname;
}

// Utility: Fix relative paths in HTML content by injecting a <base> tag into <head>
function fixRelativePaths(htmlContent, baseUrl) {
  const $ = cheerio.load(htmlContent);
  // Add or update <base> tag so relative links work
  if ($('head base').length === 0) {
    $('head').prepend(`<base href="${baseUrl}">`);
  } else {
    $('head base').attr('href', baseUrl);
  }
  // Also fix <link>, <script>, inline styles as a fallback
  $('link[href]').each((i, el) => {
    const href = $(el).attr('href');
    if (href && !href.startsWith('http') && !href.startsWith('//')) {
      const absHref = new URL(href, baseUrl).toString();
      $(el).attr('href', absHref);
    }
  });
  $('script[src]').each((i, el) => {
    const src = $(el).attr('src');
    if (src && !src.startsWith('http') && !src.startsWith('//')) {
      const absSrc = new URL(src, baseUrl).toString();
      $(el).attr('src', absSrc);
    }
  });
  // Fix URLs in inline style and <style> tags
  $('[style]').each((i, el) => {
    let styleAttr = $(el).attr('style');
    styleAttr = styleAttr.replace(/url\((?!['"]?(?:http|data):)['"]?([^'")]+)['"]?\)/g, (match, p1) => {
      const absolute = new URL(p1, baseUrl).toString();
      return `url(${absolute})`;
    });
    $(el).attr('style', styleAttr);
  });
  $('style').each((i, el) => {
    let styleText = $(el).html();
    styleText = styleText.replace(/url\((?!['"]?(?:http|data):)['"]?([^'")]+)['"]?\)/g, (match, p1) => {
      const absolute = new URL(p1, baseUrl).toString();
      return `url(${absolute})`;
    });
    $(el).html(styleText);
  });
  return $.html();
}

// Utility: Auto-scroll for lazy loading
async function autoScroll(page) {
  await page.evaluate(() => new Promise(resolve => {
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
  }));
}

// Utility: Capture a full-page screenshot as a WEBP image
async function captureWebpScreenshot(page, outPath) {
  try {
    const pngBuf = await page.screenshot({ fullPage: true, type: 'png' });
    await sharp(pngBuf).webp({ quality: 90 }).toFile(outPath);
    console.log(`✅ Screenshot saved: ${outPath}`);
  } catch (err) {
    console.error(`❌ Screenshot error => ${err.message}`);
  }
}
// deepscrape.cjs – Part 3/4

// -----------------------------
// Normal Scan Mode
// -----------------------------
async function scrapePage(browser, url, outDir, skipImages, screenshotFlag, rateLimit) {
    console.log(`🌍 Navigating: ${url}`);
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    
    // Navigate and dismiss cookie banner
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await handleCookieBanner(page, new URL(url).hostname);
    await waitMs(2000);
    
    // Get HTML and fix relative paths (inject <base> tag)
    let html = await page.content();
    html = fixRelativePaths(html, url);
    
    // Build output folder structure based on URL taxonomy
    const relativeFolderPath = buildFolderPath(url);
    const pageDir = ensureDir(outDir, relativeFolderPath);
    const baseName = path.basename(pageDir);
    
    // Save HTML file
    const htmlFile = path.join(pageDir, `${baseName}.html`);
    fs.writeFileSync(htmlFile, `<!-- ${url} -->\n${html}`, 'utf8');
    console.log(`✅ Saved HTML: ${htmlFile}`);
    
    // Collect image URLs and save them
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
    
    // Capture screenshot if required
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
    progressBar.start(total, 0);
    
    const browser = await puppeteer.launch({
      headless: true,
      defaultViewport: { width: 1440, height: 900 },
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
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
  
  // -----------------------------
  // Spider Mode
  // -----------------------------
  async function spiderCrawl(startUrls, outDir, rateLimit, maxDepth, skipImages, screenshotFlag) {
    const urlsFilePath = path.join(outDir, 'urls.txt');
    const reportPath = path.join(outDir, 'spider_report.txt');
    
    // Create initial files (clear them first)
    fs.writeFileSync(urlsFilePath, "Visited URLs:\n", 'utf8');
    fs.writeFileSync(reportPath, "Crawl Report:\n", 'utf8');
    
    const visited = new Set();
    const queue = startUrls.map(url => ({ url, depth: 0 }));
    const results = [];
    
    function normalizeUrl(url) {
      try {
        let parsedUrl = new URL(url);
        parsedUrl.hash = ""; // Remove fragment identifiers
        parsedUrl.protocol = "https:"; // Force HTTPS
        parsedUrl.pathname = parsedUrl.pathname.replace(/\/$/, ""); // Remove trailing slash
        parsedUrl.searchParams.sort(); // Sort query parameters
        return parsedUrl.toString();
      } catch (err) {
        return url;
      }
    }
    
    // Enqueue initial URLs (normalized)
    for (const u of startUrls) {
      const normalizedUrl = normalizeUrl(u);
      if (!visited.has(normalizedUrl)) {
        queue.push({ url: normalizedUrl, depth: 0 });
        visited.add(normalizedUrl);
        fs.appendFileSync(urlsFilePath, normalizedUrl + '\n', 'utf8');
      }
    }
    
    const browserSpider = await puppeteer.launch({
      headless: true,
      defaultViewport: { width: 1440, height: 900 },
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    while (queue.length > 0) {
      const { url, depth } = queue.shift();
      console.log(`🕸️ [Depth ${depth}] Visiting: ${url}`);
    
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
          const page = await browserSpider.newPage();
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await handleCookieBanner(page, new URL(url).hostname);
    
          // Save HTML with fixed relative paths
          let html = await page.content();
          html = fixRelativePaths(html, url);
          const relativeFolderPath = buildFolderPath(url);
          const pageDir = ensureDir(outDir, relativeFolderPath);
          const baseName = path.basename(pageDir);
          const htmlFile = path.join(pageDir, `${baseName}.html`);
          fs.writeFileSync(htmlFile, `<!-- ${url} -->\n${html}`, 'utf8');
          console.log(`✅ [SPIDER] Saved HTML: ${htmlFile}`);
          fs.appendFileSync(reportPath, `Visited: ${url} [Depth: ${depth}]\n`, 'utf8');
    
          // Collect images
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
    
          // Capture screenshot if required
          if (screenshotFlag) {
            console.log(`📸 [SPIDER] Capturing screenshot: ${url}`);
            await autoScroll(page);
            await waitMs(2000);
            await page.evaluate(() => window.scrollTo(0, 0));
            await waitMs(1000);
            const screenshotFile = path.join(pageDir, `${baseName}.webp`);
            await captureWebpScreenshot(page, screenshotFile);
          }
    
          // Extract and enqueue internal links (ignore fragments)
          const domain = new URL(url).hostname;
          const anchors = await page.$$eval('a', els => els.map(a => a.getAttribute('href')).filter(Boolean));
          await page.close();
          for (const link of anchors) {
            try {
              const newUrl = new URL(link, url).href;
              const normalizedNewUrl = normalizeUrl(newUrl);
              if (new URL(normalizedNewUrl).hostname === domain && !visited.has(normalizedNewUrl)) {
                visited.add(normalizedNewUrl);
                queue.push({ url: normalizedNewUrl, depth: depth + 1 });
                fs.appendFileSync(urlsFilePath, normalizedNewUrl + '\n', 'utf8');
              }
            } catch (err) {
              // Ignore invalid URLs
            }
          }
        } catch (puppErr) {
          console.error(`❌ Puppeteer error on ${url}: ${puppErr.message}`);
        }
      }
      if (rateLimit > 0) await waitMs(rateLimit);
    }
    
    // Write final spider report
    const finalReport = ['URL, STATUS', ...results.map(r => `${r.url}, ${r.status}`)].join('\n');
    fs.writeFileSync(reportPath, finalReport, 'utf8');
    console.log(`✅ Spider report written: ${reportPath}`);
    
    await browserSpider.close();
    console.log("✅ Spider crawl completed.");
  }
  // deepscrape.cjs – Part 4/4

async function displayHelp() {
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
  
  async function main() {
    const args = process.argv.slice(2);
    if (args.includes('-h') || args.includes('--help')) {
      await displayHelp();
    }
  
    const screenshotFlag = args.includes('-ss');
    const skipImages = args.includes('--no-images');
    const rateLimitIdx = args.indexOf('--rate-limit');
    const rateLimit = rateLimitIdx !== -1 ? parseInt(args[rateLimitIdx + 1], 10) : 1000;
    const nameIdx = args.indexOf('-n');
    const scanName = nameIdx !== -1 ? args[nameIdx + 1] : '';
    const outDir = generateUniqueOutputDir('./output', scanName);
    console.log(`📂 Using output directory: ${outDir}`);
  
    let urls = [];
    if (args.includes('-spider')) {
      const spiderIdx = args.indexOf('-spider');
      const spiderUrl = args[spiderIdx + 1];
      if (!spiderUrl) {
        console.error("❌ No URL provided with -spider flag.");
        process.exit(1);
      }
      fs.mkdirSync(outDir, { recursive: true });
      const maxDepth = 2; // Adjust recursion depth as desired
      await spiderCrawl([spiderUrl], outDir, rateLimit, maxDepth, skipImages, screenshotFlag);
      console.log("✅ Spidering complete.");
      process.exit(0);
    } else if (args.includes('-u')) {
      const uIdx = args.indexOf('-u');
      const singleUrl = args[uIdx + 1];
      if (!singleUrl) {
        console.error("❌ No URL provided after '-u' flag.");
        process.exit(1);
      }
      urls = [singleUrl];
    } else if (args.includes('-f')) {
      const fIdx = args.indexOf('-f');
      const filePath = args[fIdx + 1];
      if (!fs.existsSync(filePath)) {
        console.error(`❌ File not found: ${filePath}`);
        process.exit(1);
      }
      urls = fs.readFileSync(filePath, 'utf8').trim().split('\n').map(line => line.trim()).filter(Boolean);
    } else if (args.includes('-sm')) {
      const smIdx = args.indexOf('-sm');
      const sitemapUrl = args[smIdx + 1];
      if (!sitemapUrl) {
        console.error("❌ No sitemap URL provided with -sm flag.");
        process.exit(1);
      }
      urls = await readUrlsFromSitemap(sitemapUrl);
      if (!urls.length) {
        console.error(`❌ Sitemap at ${sitemapUrl} returned no URLs.`);
        process.exit(1);
      }
      if (args.includes('-ign')) {
        const ignIdx = args.indexOf('-ign');
        const ignArg = args[ignIdx + 1];
        if (ignArg) {
          const ignoreList = ignArg.split(',').map(x => x.trim()).filter(Boolean);
          const initialCount = urls.length;
          urls = urls.filter(url => !ignoreList.some(ig => url.startsWith(ig)));
          console.log(`ℹ️ Filtered URLs. ${initialCount} => ${urls.length} remain.`);
        }
      }
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
  