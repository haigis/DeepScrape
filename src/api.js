import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { processUrls, processSitemap, processFile, spiderCrawl } from './scraper.js';
import { generateOutputDir } from './fileHandler.js';

const app = express();
const PORT = 5700;

// Enable CORS for all origins (allowing access from mobile devices)
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json());

// Serve the output folder statically so files (HTML, images, etc.) can be viewed.
app.use('/output', express.static('./output'));

// Serve static files from the public folder (e.g., scans.html, scan.html, scans-all.html)
app.use(express.static('public'));


/**
 * GET /scans
 * Returns a list of available scan directories (e.g., "14-03-2025/23-30-09").
 */
app.get('/scans', (req, res) => {
  const outputDir = path.join(process.cwd(), 'output');
  try {
    const dates = fs.readdirSync(outputDir);
    let scans = [];
    dates.forEach(date => {
      const times = fs.readdirSync(path.join(outputDir, date));
      times.forEach(time => {
        scans.push(`${date}/${time}`);
      });
    });
    // Sort scans descending (latest first)
    scans.sort((a, b) => {
      function convert(scan) {
        const [day, month, year] = scan.split('/')[0].split('-');
        const time = scan.split('/')[1].split('-').join(':');
        return new Date(`${year}-${month}-${day}T${time}`);
      }
      return convert(b) - convert(a);
    });
    res.json({ scans });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Updated utility function to recursively get all files in a directory.
 * Now returns file paths relative to the scan directory.
 */
/**
 * Recursively retrieves all files in a directory and preserves full paths.
 * Returns file paths relative to the `output` folder.
 */
function getAllFiles(scanDir, scanFolderName, arrayOfFiles = []) {
    const files = fs.readdirSync(scanDir);
    files.forEach(file => {
        const fullPath = path.join(scanDir, file);
        if (fs.statSync(fullPath).isDirectory()) {
            // Recursively get files within subdirectories
            arrayOfFiles = getAllFiles(fullPath, scanFolderName, arrayOfFiles);
        } else {
            // Preserve the correct full relative path (including domain folders)
            const relativePath = path.relative(path.join(process.cwd(), "output"), fullPath);
            arrayOfFiles.push(relativePath);
        }
    });
    return arrayOfFiles;
}

/**
 * GET /scan/all?scan=<scanDir>
 * Returns a flat list of all files within the specified scan directory.
 * Example response:
 * {
 *   "scan": "14-03-2025/23-30-09",
 *   "files": [
 *     "www.nationwide.co.uk/www.nationwide.co.uk.html",
 *     "www.nationwide.co.uk/www.nationwide.co.uk.webp",
 *     "subfolder/page.html",
 *     "subfolder/image.jpg"
 *   ]
 * }
 */
/**
 * GET /scan/all?scan=<scanDir>
 * Returns all files within the specified scan directory with full relative paths.
 */
app.get('/scan/all', (req, res) => {
    const scan = req.query.scan; // Example: "15-03-2025/00-10-49"
    if (!scan) return res.status(400).json({ error: "Scan parameter is required" });

    const scanPath = path.join(process.cwd(), 'output', scan);
    
    try {
        if (!fs.existsSync(scanPath)) {
            return res.status(404).json({ error: "Scan directory not found" });
        }

        // ✅ Retrieve all files with full folder structure
        const files = getAllFiles(scanPath, scan);
        res.json({ scan, files });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});




/**
 * GET /scan/domains?scan=<scanDir>
 * Returns a list of domain directories inside the specified scan folder.
 */
app.get('/scan/domains', (req, res) => {
  const scan = req.query.scan; // e.g., "14-03-2025/23-30-09"
  if (!scan) return res.status(400).json({ error: "Scan parameter required" });
  const scanPath = path.join(process.cwd(), 'output', scan);
  try {
    if (!fs.existsSync(scanPath)) {
      return res.status(404).json({ error: "Scan directory not found" });
    }
    const domains = fs.readdirSync(scanPath).filter(item => {
      return fs.statSync(path.join(scanPath, item)).isDirectory();
    });
    res.json({ scan, domains });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /scan/pages?scan=<scanDir>&domain=<domain>
 * Returns all files (pages) for a given scan and domain.
 */
app.get('/scan/pages', (req, res) => {
  const { scan, domain } = req.query;
  if (!scan || !domain) return res.status(400).json({ error: "Both scan and domain parameters are required" });
  const domainPath = path.join(process.cwd(), 'output', scan, domain);
  try {
    if (!fs.existsSync(domainPath)) {
      return res.status(404).json({ error: "Domain folder not found" });
    }
    const files = fs.readdirSync(domainPath).filter(f => {
      return fs.statSync(path.join(domainPath, f)).isFile();
    });
    res.json({ scan, domain, files });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /scrape
 * Scrape a single URL.
 */
app.post('/scrape', async (req, res) => {
  const { url, skipImages = true, screenshot = false, rateLimit = 1000 } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }
  try {
    // Generate a unique output directory using UK date format taxonomy
    const outDir = generateOutputDir();
    console.log(`📂 Using output directory: ${outDir}`);
    console.log(`📡 Scraping: ${url} (Screenshot: ${screenshot ? 'Enabled' : 'Disabled'})`);
    await processUrls([url], outDir, rateLimit, screenshot, skipImages);
    res.json({ success: true, outputDir: outDir });
  } catch (error) {
    console.error(`❌ Error in /scrape:`, error);
    res.status(500).json({ error: error.message || "Unknown server error" });
  }
});

/**
 * POST /scrape/sitemap
 * Scrape all URLs from a sitemap.xml (with ignore list).
 */
app.post('/scrape/sitemap', async (req, res) => {
  const { sitemapUrl, ignoreUrls = [], skipImages = true, screenshot = false, rateLimit = 1000 } = req.body;
  if (!sitemapUrl) {
    return res.status(400).json({ error: 'Sitemap URL is required' });
  }
  try {
    console.log(`📡 Fetching sitemap: ${sitemapUrl}`);
    let urls = await processSitemap(sitemapUrl);
    // Filter out ignored URLs if any
    if (ignoreUrls.length > 0) {
      urls = urls.filter(url => !ignoreUrls.some(ignore => url.includes(ignore)));
      console.log(`🚫 Ignored ${ignoreUrls.length} URL patterns`);
    }
    console.log(`🚀 Processing ${urls.length} URLs...`);
    // Generate a unique output directory using UK date format taxonomy
    const outDir = generateOutputDir();
    console.log(`📂 Using output directory: ${outDir}`);
    await processUrls(urls, outDir, rateLimit, screenshot, skipImages);
    res.json({
      success: true,
      processedUrls: urls.length,
      ignoredUrls: ignoreUrls.length,
      outputDir: outDir
    });
  } catch (error) {
    console.error(`❌ Error in /scrape/sitemap:`, error);
    res.status(500).json({ error: error.message || "Unknown server error" });
  }
});

/**
 * POST /scrape/spider
 * Run Spider Crawl (Recursive Internal Link Discovery).
 */
app.post('/scrape/spider', async (req, res) => {
  const { url, maxDepth = 2, skipImages = true, screenshot = false, rateLimit = 1000 } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }
  try {
    console.log(`🕷️ Starting spider crawl on: ${url}`);
    // Generate a unique output directory using UK date format taxonomy
    const outDir = generateOutputDir();
    console.log(`📂 Using output directory: ${outDir}`);
    await spiderCrawl([url], outDir, rateLimit, maxDepth, skipImages, screenshot);
    res.json({ success: true, outputDir: outDir });
  } catch (error) {
    console.error(`❌ Error in /scrape/spider:`, error);
    res.status(500).json({ error: error.message || "Unknown server error" });
  }
});

/**
 * POST /scrape/file
 * Scrape URLs from a File (Batch Processing).
 */
app.post('/scrape/file', async (req, res) => {
  const { filePath, ignoreUrls = [], skipImages = true, screenshot = false, rateLimit = 1000 } = req.body;
  if (!filePath) {
    return res.status(400).json({ error: 'File path is required' });
  }
  try {
    console.log(`📂 Reading URLs from file: ${filePath}`);
    let urls = await processFile(filePath, ignoreUrls);
    console.log(`🚀 Processing ${urls.length} URLs...`);
    // Generate a unique output directory using UK date format taxonomy
    const outDir = generateOutputDir();
    console.log(`📂 Using output directory: ${outDir}`);
    await processUrls(urls, outDir, rateLimit, screenshot, skipImages);
    res.json({ success: true, processedUrls: urls.length, outputDir: outDir });
  } catch (error) {
    console.error(`❌ Error in /scrape/file:`, error);
    res.status(500).json({ error: error.message || "Unknown server error" });
  }
});

app.listen(PORT, '0.0.0.0', () =>
  console.log(`🚀 API running at http://0.0.0.0:${PORT}`)
);
