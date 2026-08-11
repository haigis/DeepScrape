import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { processUrls } from './scraper.js';
import { fetchSitemapUrls, discoverSitemaps } from './sitemap.js';
import { spiderCrawl, makeScope } from './spider.js';
import { generateOutputDir } from './fileHandler.js';
import { createJob, getJob, listJobs, cancelJob, moveJob, updateJob } from './jobs.js';
import { buildScanTree, getPageDetails, getPageHistory, getScanToken } from './scanStore.js';
import { getConsistencyReport } from './consistency.js';
import { buildDashboard, buildPageAttributes } from './analytics.js';
import { extractScanQa } from './qa.js';

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

const OUTPUT_ROOT = path.resolve(process.cwd(), process.env.OUTPUT_DIR ?? 'output');

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
 * Builds ScrapeOptions from a job's (possibly edited) params.
 */
const paramsToOptions = (params) => ({
  rateLimit: Number(params.rateLimit) || 1000,
  // Number(...) || 2 would turn an explicit 0 into 2 — depth 0 is a
  // legitimate request ("these pages only, follow nothing").
  maxDepth: Number.isFinite(Number(params.maxDepth)) && params.maxDepth !== null && params.maxDepth !== undefined && params.maxDepth !== ''
    ? Number(params.maxDepth) : 2,
  // Optional folder scope, e.g. "/help" — only that subtree is crawled.
  pathPrefix: params.pathPrefix || null,
  // Include/exclude lists (folders or exact pages); see makeScope().
  includePaths: Array.isArray(params.includePaths) ? params.includePaths.filter(p => typeof p === 'string') : [],
  excludePaths: Array.isArray(params.excludePaths) ? params.excludePaths.filter(p => typeof p === 'string') : [],
  // Parallel crawl workers (1-8); defaults to DS_CRAWL_CONCURRENCY or 3.
  concurrency: Number(params.concurrency) > 0 ? Number(params.concurrency) : undefined,
  // Hard page ceiling, enforced by the crawler itself (plan limits).
  maxPages: Number(params.maxPages) > 0 ? Number(params.maxPages) : null,
  screenshot: parseBoolean(params.screenshot),
  downloadImages: parseBoolean(params.downloadImages),
  // Offline copies are the default; pass offline:false to opt out.
  offline: params.offline === undefined ? true : parseBoolean(params.offline),
  // Cookie-banner dismissal (screenshot-only concern); default on.
  cookieDismissal: params.cookieDismissal === undefined ? true : parseBoolean(params.cookieDismissal),
});

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
app.post('/scrape', (req, res) => {
  const { url, rateLimit = 1000, screenshot, downloadImages, priority } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const outDir = generateOutputDir(url);

  const job = createJob(
    'scrape',
    { url, rateLimit, screenshot: parseBoolean(screenshot), downloadImages: parseBoolean(downloadImages) },
    (onProgress, params, signal) =>
      processUrls([params.url], { ...paramsToOptions(params), onProgress, signal }),
    { priority: parseBoolean(priority) });

  res.status(202).json({ success: true, jobId: job.id, statusUrl: `/jobs/${job.id}`, outputDir: outDir });
});

/**
 * POST /scrape/sitemap
 * Scrapes URLs from a sitemap.xml (sitemap indexes and .gz supported).
 * Accepts ignoreUrls (or excludeUrls) as substring patterns to skip.
 */
app.post('/scrape/sitemap', (req, res) => {
  const { sitemapUrl, rateLimit = 1000, screenshot, downloadImages } = req.body;
  const ignoreUrls = req.body.ignoreUrls ?? req.body.excludeUrls ?? [];
  if (!sitemapUrl) return res.status(400).json({ error: 'Sitemap URL is required' });

  const job = createJob(
    'sitemap',
    { sitemapUrl, ignoreUrls, rateLimit, screenshot: parseBoolean(screenshot), downloadImages: parseBoolean(downloadImages) },
    async (onProgress, params, signal, gate) => {
      let urls = await fetchSitemapUrls(params.sitemapUrl);

      const ignores = params.ignoreUrls ?? [];
      if (ignores.length > 0) {
        urls = urls.filter(url => !ignores.some(ignore => url.includes(ignore)));
        console.log(`🚫 Ignored ${ignores.length} URL patterns`);
      }

      if (urls.length === 0) throw new Error('No valid URLs found in sitemap.');

      const summary = await processUrls(urls, { ...paramsToOptions(params), onProgress, signal, gate });
      return { ...summary, outputDir: generateOutputDir(urls[0]) };
    });

  res.status(202).json({ success: true, jobId: job.id, statusUrl: `/jobs/${job.id}` });
});

/**
 * POST /scrape/spider
 * Performs a spider crawl.
 */
/**
 * Live crawl inspectors, keyed by job id. The spider publishes its URL
 * state through these and honours excludes pushed in mid-crawl. Kept
 * after completion so the full URL list stays inspectable; pruned FIFO.
 */
const liveCrawls = new Map();
const registerLiveCrawl = (jobId, live) => {
  liveCrawls.set(jobId, live);
  // Finished crawls hold only a small snapshot (spider.js swaps the
  // closure at crawl end), but keep the roster short regardless.
  while (liveCrawls.size > 20) {
    liveCrawls.delete(liveCrawls.keys().next().value);
  }
};

app.post('/scrape/spider', (req, res) => {
  const { url, maxDepth = 2, rateLimit = 1000, screenshot, downloadImages, pathPrefix, includePaths, excludePaths, maxPages, concurrency, cookieDismissal } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const live = { dynamicExcludes: [] };
  const job = createJob(
    'spider',
    { url, rateLimit, maxDepth, pathPrefix, includePaths, excludePaths, maxPages, concurrency, cookieDismissal, screenshot: parseBoolean(screenshot), downloadImages: parseBoolean(downloadImages) },
    (onProgress, params, signal, gate) =>
      spiderCrawl([params.url], { ...paramsToOptions(params), live, onProgress, signal, gate }));
  registerLiveCrawl(job.id, live);

  res.status(202).json({ success: true, jobId: job.id, statusUrl: `/jobs/${job.id}` });
});

/**
 * POST /scrape/full
 * Finds ALL pages on a domain: discovers the site's sitemaps
 * (robots.txt, then /sitemap.xml), seeds the spider with every sitemap
 * URL plus the start page, and lets link-following catch anything the
 * sitemap doesn't list. Orphans (in the sitemap but never linked) and
 * unlisted pages (linked but not in the sitemap) are both captured.
 */
app.post('/scrape/full', (req, res) => {
  const { url, maxDepth = 2, rateLimit = 1000, screenshot, downloadImages, pathPrefix, includePaths, excludePaths, maxPages, concurrency, cookieDismissal } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const live = { dynamicExcludes: [] };
  const job = createJob(
    'full',
    { url, rateLimit, maxDepth, pathPrefix, includePaths, excludePaths, maxPages, concurrency, cookieDismissal, screenshot: parseBoolean(screenshot), downloadImages: parseBoolean(downloadImages) },
    async (onProgress, params, signal, gate) => {
      const origin = new URL(params.url).origin;
      const host = new URL(params.url).hostname;

      onProgress({ done: 0, total: null, currentUrl: 'discovering sitemaps…' });
      const sitemaps = await discoverSitemaps(origin);

      let sitemapUrls = [];
      for (const sitemap of sitemaps) {
        try {
          sitemapUrls.push(...await fetchSitemapUrls(sitemap));
        } catch (err) {
          console.warn(`⚠️ Sitemap ${sitemap} failed: ${err.message}`);
        }
      }

      // Same host only; honour include/exclude scope if given.
      const inScope = makeScope(paramsToOptions(params));
      sitemapUrls = [...new Set(sitemapUrls)].filter(u => {
        try {
          return new URL(u).hostname === host && inScope(u);
        } catch {
          return false;
        }
      });

      console.log(`🌐 Full discovery: ${sitemaps.length} sitemap(s), ${sitemapUrls.length} URLs seeded + spider from ${params.url}`);

      const summary = await spiderCrawl(
        [params.url, ...sitemapUrls],
        { ...paramsToOptions(params), live, onProgress, signal, gate },
      );
      return { ...summary, sitemaps, sitemapSeeded: sitemapUrls.length };
    });
  registerLiveCrawl(job.id, live);

  res.status(202).json({ success: true, jobId: job.id, statusUrl: `/jobs/${job.id}` });
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

  const cleaned = urls
    .map(u => String(u).trim())
    .filter(u => /^https?:\/\//i.test(u))
    .filter(u => !ignoreUrls.some(ignore => u.includes(ignore)));

  if (cleaned.length === 0) return res.status(400).json({ error: 'No valid http(s) URLs in list.' });

  const job = createJob(
    'batch',
    { urls: cleaned, rateLimit, screenshot: parseBoolean(screenshot), downloadImages: parseBoolean(downloadImages) },
    (onProgress, params, signal, gate) =>
      processUrls(params.urls, { ...paramsToOptions(params), onProgress, signal, gate }));

  res.status(202).json({ success: true, jobId: job.id, statusUrl: `/jobs/${job.id}`, queuedUrls: cleaned.length });
});

/**
 * GET /jobs
 * Lists recent jobs, newest first.
 */
app.get('/jobs', (req, res) => {
  res.json({ jobs: listJobs() });
});

/**
 * GET /jobs/:id
 * Returns status/progress/result for one job.
 */
app.get('/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

/**
 * GET /jobs/:id/urls
 * Live URL state of a spider/full crawl: pages visited so far, the
 * queue still to fetch, URLs dropped by live excludes, and the current
 * exclude list. Works during the crawl and after it finishes.
 */
app.get('/jobs/:id/urls', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const live = liveCrawls.get(req.params.id);
  if (!live) return res.status(404).json({ error: 'No URL inspection for this job type' });

  const state = live.getState?.() ?? { visited: [], queued: [], excluded: [] };
  const CAP = 2000;
  res.json({
    jobId: job.id,
    status: job.status,
    counts: {
      visited: state.visited.length,
      queued: state.queued.length,
      excluded: state.excluded.length,
    },
    visited: state.visited.slice(-CAP),
    queued: state.queued.slice(0, CAP),
    excluded: state.excluded.slice(-CAP),
    dynamicExcludes: [...live.dynamicExcludes],
  });
});

/**
 * POST /jobs/:id/exclude { path, remove? }
 * Adds (or removes) a live exclude — a folder ("/branch-finder") or
 * exact page — while the crawl runs. Queued URLs under an excluded
 * path are dropped at dequeue time; nothing already saved is deleted.
 */
app.post('/jobs/:id/exclude', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const live = liveCrawls.get(req.params.id);
  if (!live) return res.status(404).json({ error: 'This job type has no live excludes' });

  const raw = req.body?.path;
  if (typeof raw !== 'string' || !raw.trim()) {
    return res.status(400).json({ error: 'path is required' });
  }
  const normalised = '/' + raw.trim().replace(/^\/+|\/+$/g, '');
  if (!/^\/[\w\-./%]{0,300}$/.test(normalised)) {
    return res.status(400).json({ error: 'path must be a simple path like /help or /pricing.html' });
  }

  if (req.body?.remove) {
    const idx = live.dynamicExcludes.indexOf(normalised);
    if (idx !== -1) live.dynamicExcludes.splice(idx, 1);
  } else if (!live.dynamicExcludes.includes(normalised)) {
    live.dynamicExcludes.push(normalised);
  }

  res.json({ success: true, dynamicExcludes: [...live.dynamicExcludes] });
});

/**
 * POST /jobs/:id/cancel
 * Cancels a queued job or stops the running one (aborts at the next
 * page boundary).
 */
app.post('/jobs/:id/cancel', (req, res) => {
  const result = cancelJob(req.params.id);
  if (!result.ok) return res.status(409).json({ error: result.error });
  res.json({ success: true, job: getJob(req.params.id) });
});

/**
 * POST /jobs/:id/move { position }
 * Moves a queued job to a new position among queued jobs (0 = next).
 */
app.post('/jobs/:id/move', (req, res) => {
  const result = moveJob(req.params.id, req.body?.position);
  if (!result.ok) return res.status(409).json({ error: result.error });
  res.json({ success: true });
});

/**
 * PATCH /jobs/:id
 * Edits settings of a queued job. Whitelisted keys only.
 */
app.patch('/jobs/:id', (req, res) => {
  const allowed = ['rateLimit', 'maxDepth', 'screenshot', 'downloadImages'];
  const patch = {};
  for (const key of allowed) {
    if (key in (req.body ?? {})) {
      patch[key] = key === 'rateLimit' || key === 'maxDepth'
        ? Number(req.body[key])
        : parseBoolean(req.body[key]);
    }
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: `No editable fields supplied (allowed: ${allowed.join(', ')})` });
  }
  if ((('rateLimit' in patch) && !Number.isFinite(patch.rateLimit)) ||
      (('maxDepth' in patch) && !Number.isFinite(patch.maxDepth))) {
    return res.status(400).json({ error: 'rateLimit and maxDepth must be numbers' });
  }

  const result = updateJob(req.params.id, patch);
  if (!result.ok) return res.status(409).json({ error: result.error });
  res.json({ success: true, job: result.job });
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

/**
 * GET /scan/tree?scan=<domain>/<date>
 * Server-built directory tree of a scan's pages with aggregate stats.
 * Scales to thousands of pages: the client renders collapsed folders
 * with counts instead of a flat file list.
 */
app.get('/scan/tree', async (req, res) => {
  const scan = req.query.scan;
  if (!scan || typeof scan !== 'string') {
    return res.status(400).json({ error: 'Scan parameter is required' });
  }

  const scanPath = resolveScanPath(scan);
  if (!scanPath) return res.status(400).json({ error: 'Invalid scan path' });
  if (!fs.existsSync(scanPath)) return res.status(404).json({ error: 'Scan directory not found' });

  try {
    const { tree, stats } = await buildScanTree(scanPath);
    res.json({ scan, stats, tree });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Validates a page path (relative, no traversal) inside a scan directory.
 * @returns {string|null} - Normalized relative path or null.
 */
function resolvePagePath(scanPath, pagePath) {
  if (!pagePath || typeof pagePath !== 'string') return null;
  const abs = path.resolve(scanPath, pagePath);
  if (!abs.startsWith(scanPath + path.sep)) return null;
  return path.relative(scanPath, abs).replace(/\\/g, '/');
}

/**
 * GET /scan/page?scan=<domain>/<date>&path=<page path>
 * Bespoke per-page detail: original URL, size, screenshot,
 * incoming links (spider scans) and outgoing links.
 */
app.get('/scan/page', async (req, res) => {
  const { scan, path: pagePath } = req.query;
  // Optional site-chrome selectors so a customer can name the containers
  // their site actually uses: ?navSelector=#globalnav&footerSelector=.l-footer
  // Named groups: ?chrome=[{"name":"Mega menu","selector":".c-header__content","enabled":true}]
  // Legacy per-region params still accepted.
  let chromeOverrides = {
    nav: req.query.navSelector,
    header: req.query.headerSelector,
    footer: req.query.footerSelector,
  };
  if (req.query.chrome) {
    try {
      const parsed = JSON.parse(req.query.chrome);
      if (Array.isArray(parsed)) chromeOverrides = parsed;
    } catch {
      return res.status(400).json({ error: 'chrome must be a JSON array of {name, selector, enabled}' });
    }
  }
  if (!scan || typeof scan !== 'string') {
    return res.status(400).json({ error: 'Scan parameter is required' });
  }

  const scanPath = resolveScanPath(scan);
  if (!scanPath) return res.status(400).json({ error: 'Invalid scan path' });

  const rel = resolvePagePath(scanPath, pagePath);
  if (!rel) return res.status(400).json({ error: 'Invalid page path' });

  try {
    const details = await getPageDetails(scanPath, scan, rel, chromeOverrides);
    if (!details) return res.status(404).json({ error: 'Page not found in scan' });

    // FM-style attributes scored against the rest of the scan.
    const profile = await buildPageAttributes(scanPath, rel, details);
    res.json({ ...details, ...(profile ?? {}) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /scan/dashboard?scan=<domain>/<date>
 * Site analytics for one scan: headline metrics, sections, depth
 * spread, largest/most-linked/orphan pages, broken links and a
 * comparison against the previous scan.
 */
app.get('/scan/dashboard', async (req, res) => {
  const scan = req.query.scan;
  if (!scan || typeof scan !== 'string') {
    return res.status(400).json({ error: 'Scan parameter is required' });
  }

  const scanPath = resolveScanPath(scan);
  if (!scanPath) return res.status(400).json({ error: 'Invalid scan path' });
  if (!fs.existsSync(scanPath)) return res.status(404).json({ error: 'Scan directory not found' });

  const [domain, date] = scan.split('/');
  if (!domain || !date) return res.status(400).json({ error: 'Scan must be "<domain>/<date>"' });

  try {
    const dashboard = await buildDashboard(path.dirname(scanPath), domain, date);
    res.json(dashboard);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /scan/history?domain=<domain>&path=<page path>
 * All scans of a domain containing the page, newest first, with
 * size deltas — powers the "previous scans" view.
 */
app.get('/scan/history', async (req, res) => {
  const { domain, path: pagePath } = req.query;
  if (!domain || typeof domain !== 'string') {
    return res.status(400).json({ error: 'Domain parameter is required' });
  }

  const domainRoot = resolveScanPath(domain);
  if (!domainRoot) return res.status(400).json({ error: 'Invalid domain' });

  // The page path is later joined under domainRoot/<date>/; validate it
  // against a representative base so traversal cannot escape.
  const probeBase = path.join(domainRoot, 'date');
  const cleanRel = resolvePagePath(probeBase, pagePath);
  if (!cleanRel) return res.status(400).json({ error: 'Invalid page path' });

  try {
    const history = await getPageHistory(domainRoot, domain, cleanRel);
    res.json({ domain, path: cleanRel, history });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /scan/qa?scan=<domain>/<date>&paths=<json>&selectors=<json>
 * Q&A pairs from the named source paths (FAQ group pages) plus
 * heading-scoped chunks for the whole scan. Deterministic extraction —
 * see src/qa.js.
 */
app.get('/scan/qa', async (req, res) => {
  const scan = req.query.scan;
  if (!scan || typeof scan !== 'string') {
    return res.status(400).json({ error: 'Scan parameter is required' });
  }
  const scanPath = resolveScanPath(scan);
  if (!scanPath) return res.status(400).json({ error: 'Invalid scan path' });
  if (!fs.existsSync(scanPath)) return res.status(404).json({ error: 'Scan directory not found' });

  let qaPaths = [];
  let selectors = [];
  try {
    if (req.query.paths) qaPaths = JSON.parse(req.query.paths);
    if (req.query.selectors) selectors = JSON.parse(req.query.selectors);
    if (!Array.isArray(qaPaths) || !Array.isArray(selectors)) throw new Error('not arrays');
  } catch {
    return res.status(400).json({ error: 'paths and selectors must be JSON arrays' });
  }

  try {
    const result = await extractScanQa(scanPath, { qaPaths, selectors });
    res.json({ scan, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /scan/consistency?scan=<domain>/<date>
 * Cross-page content consistency findings: contradictory facts,
 * metadata conflicts, structured data problems and terminology drift.
 */
app.get('/scan/consistency', async (req, res) => {
  const scan = req.query.scan;
  if (!scan || typeof scan !== 'string') {
    return res.status(400).json({ error: 'Scan parameter is required' });
  }

  const scanPath = resolveScanPath(scan);
  if (!scanPath) return res.status(400).json({ error: 'Invalid scan path' });
  if (!fs.existsSync(scanPath)) return res.status(404).json({ error: 'Scan directory not found' });

  try {
    const token = await getScanToken(scanPath);
    res.json(await getConsistencyReport(scanPath, scan, token));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, HOST, () =>
  console.log(`🚀 API running at http://${HOST}:${PORT}`)
);
