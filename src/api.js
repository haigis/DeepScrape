import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { processUrls, processSitemap, processFile } from './scraper.js';
import { spiderCrawl } from './spider.js';
import { generateOutputDir } from './fileHandler.js';

const app = express();
const PORT = 5700;

// Enable CORS for all origins
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json());

// Serve static files (scanned results)
app.use('/output', express.static('./output'));
app.use(express.static('public'));

/**
 * Helper function to parse boolean values correctly.
 */
const parseBoolean = (value) => {
  return value === true || value === "true";
};

/**
 * GET /scans
 * Returns a list of available scan directories (e.g., "15-03-2025").
 */
app.get('/scans', (req, res) => {
  const outputDir = path.join(process.cwd(), 'output');
  try {
    const domains = fs.readdirSync(outputDir).filter(domain => 
      fs.statSync(path.join(outputDir, domain)).isDirectory()
    );

    let scans = [];
    domains.forEach(domain => {
      const dates = fs.readdirSync(path.join(outputDir, domain));
      dates.forEach(date => {
        scans.push(`${domain}/${date}`);
      });
    });

    // Sort scans by date (latest first)
    scans.sort((a, b) => new Date(b.split('/')[1]) - new Date(a.split('/')[1]));

    res.json({ scans });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /scrape
 * Scrapes a single URL.
 */
app.post('/scrape', async (req, res) => {
  const { url, rateLimit = 1000, screenshot, downloadImages } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  try {
    const outDir = generateOutputDir(url);
    if (!outDir) throw new Error("❌ Could not determine a valid output directory.");

    const screenshotFlag = parseBoolean(screenshot);
    const downloadImagesFlag = parseBoolean(downloadImages);

    console.log(`📂 Using output directory: ${outDir}`);
    console.log(`📡 Scraping: ${url}`);
    console.log(`🖼 Screenshot: ${screenshotFlag ? 'Enabled' : 'Disabled'}`);
    console.log(`📥 Download Images: ${downloadImagesFlag ? 'Enabled' : 'Disabled'}`);

    await processUrls([url], rateLimit, screenshotFlag, downloadImagesFlag);

    res.json({ success: true, outputDir: outDir });
  } catch (error) {
    console.error(`❌ Error in /scrape:`, error);
    res.status(500).json({ error: error.message || "Unknown server error" });
  }
});

/**
 * POST /scrape/sitemap
 * Scrapes URLs from a sitemap.xml.
 */
app.post('/scrape/sitemap', async (req, res) => {
  const { sitemapUrl, ignoreUrls = [], rateLimit = 1000, screenshot, downloadImages } = req.body;
  if (!sitemapUrl) return res.status(400).json({ error: 'Sitemap URL is required' });

  try {
    console.log(`📡 Fetching sitemap: ${sitemapUrl}`);
    let urls = await processSitemap(sitemapUrl);
    
    if (ignoreUrls.length > 0) {
      urls = urls.filter(url => !ignoreUrls.some(ignore => url.includes(ignore)));
      console.log(`🚫 Ignored ${ignoreUrls.length} URL patterns`);
    }

    if (urls.length === 0) return res.status(400).json({ error: "No valid URLs found in sitemap." });

    console.log(`🚀 Processing ${urls.length} URLs...`);
    const outDir = generateOutputDir(urls[0]);

    await processUrls(urls, rateLimit, parseBoolean(screenshot), parseBoolean(downloadImages));

    res.json({ success: true, processedUrls: urls.length, ignoredUrls: ignoreUrls.length, outputDir: outDir });
  } catch (error) {
    console.error(`❌ Error in /scrape/sitemap:`, error);
    res.status(500).json({ error: error.message || "Unknown server error" });
  }
});

/**
 * POST /scrape/spider
 * Performs a spider crawl.
 */
app.post('/scrape/spider', async (req, res) => {
  const { url, maxDepth = 2, rateLimit = 1000, screenshot, downloadImages } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  try {
    console.log(`🕷️ Starting spider crawl on: ${url}`);
    const outDir = generateOutputDir(url);
    if (!outDir) throw new Error("❌ Could not determine a valid output directory.");

    await spiderCrawl([url], rateLimit, maxDepth, parseBoolean(downloadImages), parseBoolean(screenshot));

    res.json({ success: true, outputDir: outDir });
  } catch (error) {
    console.error(`❌ Error in /scrape/spider:`, error);
    res.status(500).json({ error: error.message || "Unknown server error" });
  }
});

/**
 * POST /scrape/file
 * Scrapes URLs from a file.
 */
app.post('/scrape/file', async (req, res) => {
  const { filePath, ignoreUrls = [], rateLimit = 1000, screenshot, downloadImages } = req.body;
  if (!filePath) return res.status(400).json({ error: 'File path is required' });

  try {
    console.log(`📂 Reading URLs from file: ${filePath}`);
    let urls = await processFile(filePath, ignoreUrls);

    if (urls.length === 0) return res.status(400).json({ error: "No valid URLs found in file." });

    console.log(`🚀 Processing ${urls.length} URLs...`);
    const outDir = generateOutputDir(urls[0]);

    await processUrls(urls, rateLimit, parseBoolean(screenshot), parseBoolean(downloadImages));

    res.json({ success: true, processedUrls: urls.length, outputDir: outDir });
  } catch (error) {
    console.error(`❌ Error in /scrape/file:`, error);
    res.status(500).json({ error: error.message || "Unknown server error" });
  }
});

/**
 * GET /scan/all?scan=<scanDir>
 * Returns all files within the specified scan directory.
 */
app.get('/scan/all', (req, res) => {
  const scan = req.query.scan;
  if (!scan) return res.status(400).json({ error: "Scan parameter is required" });

  const scanPath = path.join(process.cwd(), 'output', scan);
  
  try {
    if (!fs.existsSync(scanPath)) {
      return res.status(404).json({ error: "Scan directory not found" });
    }

    const files = fs.readdirSync(scanPath).map(file => path.join(scan, file));
    res.json({ scan, files });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, '0.0.0.0', () =>
  console.log(`🚀 API running at http://0.0.0.0:${PORT}`)
);
