import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { processUrls } from './scraper.js';
import { fetchSitemapUrls } from './sitemap.js';
import { spiderCrawl } from './spider.js';
import { generateOutputDir } from './fileHandler.js';

const app = express();

// Bind to loopback by default; opt in to LAN exposure with HOST=0.0.0.0.
const PORT = Number(process.env.PORT) || 5700;
const HOST = process.env.HOST || '127.0.0.1';

// The UI is served same-origin, so CORS is only needed when another
// origin must call this API. Opt in via ALLOWED_ORIGINS=https://a.com,https://b.com
if (process.env.ALLOWED_ORIGINS) {
  const origins = process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim());
  app.use(cors({ origin: origins, methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
}

app.use(express.json());

const OUTPUT_ROOT = path.resolve(process.cwd(), 'output');

// Serve static files (scanned results)
app.use('/output', express.static(OUTPUT_ROOT));
app.use(express.static('public'));

/**
 * Helper function to parse boolean values correctly.
 */
const parseBoolean = (value) => {
  return value === true || value === 'true';
};

/**
 * Resolves a user-supplied scan identifier ("domain/date") to a path
 * inside the output root, rejecting traversal attempts like "../..".
 * @param {string} scan
 * @returns {string|null} - Absolute path, or null if invalid.
 */
function resolveScanPath(scan) {
  const resolved = path.resolve(OUTPUT_ROOT, scan);
  if (resolved !== OUTPUT_ROOT && !resolved.startsWith(OUTPUT_ROOT + path.sep)) {
    return null;
  }
  return resolved;
}

/**
 * GET /scans
 * Returns a list of available scan directories (e.g., "example.com/2026-08-08").
 */
app.get('/scans', (req, res) => {
  try {
    if (!fs.existsSync(OUTPUT_ROOT)) return res.json({ scans: [] });

    const domains = fs.readdirSync(OUTPUT_ROOT).filter(domain =>
      fs.statSync(path.join(OUTPUT_ROOT, domain)).isDirectory()
    );

    const scans = [];
    domains.forEach(domain => {
      const dates = fs.readdirSync(path.join(OUTPUT_ROOT, domain));
      dates.forEach(date => {
        scans.push(`${domain}/${date}`);
      });
    });

    // ISO date folders (YYYY-MM-DD) sort chronologically as strings; latest first.
    scans.sort((a, b) => b.split('/')[1].localeCompare(a.split('/')[1]));

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
    if (!outDir) throw new Error('❌ Could not determine a valid output directory.');

    const options = {
      rateLimit,
      screenshot: parseBoolean(screenshot),
      downloadImages: parseBoolean(downloadImages),
    };

    console.log(`📂 Using output directory: ${outDir}`);
    console.log(`📡 Scraping: ${url}`);

    await processUrls([url], options);

    res.json({ success: true, outputDir: outDir });
  } catch (error) {
    console.error(`❌ Error in /scrape:`, error);
    res.status(500).json({ error: error.message || 'Unknown server error' });
  }
});

/**
 * POST /scrape/sitemap
 * Scrapes URLs from a sitemap.xml (sitemap indexes and .gz supported).
 * Accepts ignoreUrls (or excludeUrls) as substring patterns to skip.
 */
app.post('/scrape/sitemap', async (req, res) => {
  const { sitemapUrl, rateLimit = 1000, screenshot, downloadImages } = req.body;
  const ignoreUrls = req.body.ignoreUrls ?? req.body.excludeUrls ?? [];
  if (!sitemapUrl) return res.status(400).json({ error: 'Sitemap URL is required' });

  try {
    console.log(`📡 Fetching sitemap: ${sitemapUrl}`);
    let urls = await fetchSitemapUrls(sitemapUrl);

    if (ignoreUrls.length > 0) {
      urls = urls.filter(url => !ignoreUrls.some(ignore => url.includes(ignore)));
      console.log(`🚫 Ignored ${ignoreUrls.length} URL patterns`);
    }

    if (urls.length === 0) return res.status(400).json({ error: 'No valid URLs found in sitemap.' });

    console.log(`🚀 Processing ${urls.length} URLs...`);
    const outDir = generateOutputDir(urls[0]);

    await processUrls(urls, {
      rateLimit,
      screenshot: parseBoolean(screenshot),
      downloadImages: parseBoolean(downloadImages),
    });

    res.json({ success: true, processedUrls: urls.length, ignoredUrls: ignoreUrls.length, outputDir: outDir });
  } catch (error) {
    console.error(`❌ Error in /scrape/sitemap:`, error);
    res.status(500).json({ error: error.message || 'Unknown server error' });
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
    if (!outDir) throw new Error('❌ Could not determine a valid output directory.');

    await spiderCrawl([url], {
      rateLimit,
      maxDepth,
      screenshot: parseBoolean(screenshot),
      downloadImages: parseBoolean(downloadImages),
    });

    res.json({ success: true, outputDir: outDir });
  } catch (error) {
    console.error(`❌ Error in /scrape/spider:`, error);
    res.status(500).json({ error: error.message || 'Unknown server error' });
  }
});

/**
 * POST /scrape/batch
 * Scrapes an explicit list of URLs sent in the request body.
 * Replaces POST /scrape/file, which read arbitrary file paths from the
 * server's filesystem (see docs/06-security.md).
 */
app.post('/scrape/batch', async (req, res) => {
  const { urls, rateLimit = 1000, screenshot, downloadImages } = req.body;
  const ignoreUrls = req.body.ignoreUrls ?? req.body.excludeUrls ?? [];

  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'urls must be a non-empty array' });
  }

  try {
    const cleaned = urls
      .map(u => String(u).trim())
      .filter(u => /^https?:\/\//i.test(u))
      .filter(u => !ignoreUrls.some(ignore => u.includes(ignore)));

    if (cleaned.length === 0) return res.status(400).json({ error: 'No valid http(s) URLs in list.' });

    console.log(`🚀 Processing ${cleaned.length} URLs from batch...`);
    const outDir = generateOutputDir(cleaned[0]);

    await processUrls(cleaned, {
      rateLimit,
      screenshot: parseBoolean(screenshot),
      downloadImages: parseBoolean(downloadImages),
    });

    res.json({ success: true, processedUrls: cleaned.length, outputDir: outDir });
  } catch (error) {
    console.error(`❌ Error in /scrape/batch:`, error);
    res.status(500).json({ error: error.message || 'Unknown server error' });
  }
});

/**
 * POST /scrape/file — removed for security reasons (arbitrary file read).
 */
app.post('/scrape/file', (req, res) => {
  res.status(410).json({
    error: 'POST /scrape/file has been removed: it read arbitrary paths from the server filesystem. Send the URL list in the request body via POST /scrape/batch { "urls": [...] } instead.',
  });
});

/**
 * GET /scan/all?scan=<domain>/<date>
 * Returns all files within the specified scan directory.
 */
app.get('/scan/all', (req, res) => {
  const scan = req.query.scan;
  if (!scan || typeof scan !== 'string') {
    return res.status(400).json({ error: 'Scan parameter is required' });
  }

  const scanPath = resolveScanPath(scan);
  if (!scanPath) {
    return res.status(400).json({ error: 'Invalid scan path' });
  }

  try {
    if (!fs.existsSync(scanPath)) {
      return res.status(404).json({ error: 'Scan directory not found' });
    }

    // Recursively list files, returned as URL-style (forward-slash) paths
    // relative to /output — previously path.join produced backslashes on
    // Windows, breaking the links in the UI.
    const files = fs.readdirSync(scanPath, { recursive: true })
      .map(f => String(f).replace(/\\/g, '/'))
      .filter(f => fs.statSync(path.join(scanPath, f)).isFile())
      .map(f => `${scan}/${f}`);

    res.json({ scan, files });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, HOST, () =>
  console.log(`🚀 API running at http://${HOST}:${PORT}`)
);
