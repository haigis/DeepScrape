# DeepScrape

A Node.js web scraping and site-analysis toolkit built on Puppeteer. Scrapes
rendered HTML, captures full-page WebP screenshots, downloads page images,
crawls sites recursively, parses sitemaps (including sitemap indexes and
`.xml.gz`), and runs axe-core accessibility audits over saved scans — all
available from a CLI and an async job-based REST API.

[![CI](https://github.com/haigis/DeepScrape/actions/workflows/ci.yml/badge.svg)](https://github.com/haigis/DeepScrape/actions/workflows/ci.yml)

## Requirements

- Node.js **22+**
- `npm install` (Puppeteer downloads its own Chromium)

## CLI

```bash
node src/index.js [options]
```

| Option | Description |
|---|---|
| `-u <url>` | Scrape a single URL |
| `-f <file>` | Scrape URLs from a file (one per line) |
| `-sm <sitemap>` | Scrape all URLs in a sitemap (index + gzip supported) |
| `-spider <url>` | Recursively crawl a domain |
| `--depth <n>` | Spider crawl depth (default 2; start URL is depth 0) |
| `--images` | Download page images alongside the HTML |
| `-ss` | Capture a full-page WebP screenshot per page |
| `--rate-limit <ms>` | Delay between requests (default 1000) |

Examples:

```bash
node src/index.js -u https://example.com -ss --images
```

```bash
node src/index.js -spider https://example.com --depth 2 --rate-limit 500
```

Accessibility audit of a finished scan:

```bash
npm run audit -- output/example.com/2026-08-08
```

## API

```bash
npm run api
```

Binds `127.0.0.1:5700` by default. Environment: `HOST` (`0.0.0.0` to expose),
`PORT`, `ALLOWED_ORIGINS` (comma-separated; CORS is off unless set).

The bundled UI is served at `/scan.html` (start scrapes, live job progress)
and `/scans.html` (browse results).

### Scrape endpoints (async)

All scrape endpoints return **202 Accepted** immediately:

```json
{ "success": true, "jobId": "…", "statusUrl": "/jobs/…" }
```

| Endpoint | Body |
|---|---|
| `POST /scrape` | `{ "url", "rateLimit"?, "screenshot"?, "downloadImages"? }` |
| `POST /scrape/sitemap` | `{ "sitemapUrl", "ignoreUrls"?: [], … }` |
| `POST /scrape/spider` | `{ "url", "maxDepth"?, … }` |
| `POST /scrape/batch` | `{ "urls": [], "ignoreUrls"?: [], … }` |

### Job + result endpoints

| Endpoint | Returns |
|---|---|
| `GET /jobs/:id` | `{ status, progress: {done, total, currentUrl}, result, error, … }` |
| `GET /jobs` | Recent jobs, newest first |
| `GET /scans` | Scan directories (`domain/YYYY-MM-DD`), latest first |
| `GET /scan/all?scan=<domain>/<date>` | Files in a scan (recursive) |
| `GET /output/...` | Static scan artifacts |

## Output layout

```
output/
└── example.com/
    └── 2026-08-08/
        ├── example.com/            # mirrors URL structure
        │   ├── index.html
        │   ├── index.webp          # with -ss / screenshot
        │   └── images/             # with --images / downloadImages
        ├── all-links.txt           # spider: every link discovered
        ├── broken-links.txt        # spider: pages failing with HTTP >= 400
        └── incoming-links.json     # spider: URL -> pages linking to it
```

## Architecture

```
src/
├── index.js         CLI entry — parses flags into one shared options object
├── api.js           Express API + static UI, async job endpoints
├── jobs.js          In-memory sequential job queue (id, status, progress)
├── scraper.js       Core: scrapePage/processUrls, shared browser, options
├── spider.js        Recursive same-domain crawler (rendered-DOM links)
├── sitemap.js       Sitemap parser (urlset, sitemapindex recursion, gzip)
├── fileHandler.js   Output paths (ISO dates), relative→absolute HTML fixes
├── screenshot.js    Full-page WebP capture via sharp
├── cookieHandler.js Cookie-banner dismissal (per-domain selectors JSON)
├── accessibility.js axe-core audit over saved scans → HTML reports
└── utils.js         Small shared helpers
```

Feature-by-feature docs live in [`docs/`](docs/):

1. [Unified options & image download](docs/01-unified-options.md)
2. [Spider crawl fixes](docs/02-spider-crawl.md)
3. [Screenshot filenames](docs/03-screenshot-filename.md)
4. [Sitemap parsing](docs/04-sitemap-parsing.md)
5. [Accessibility scanner](docs/05-accessibility-scanner.md)
6. [API security](docs/06-security.md)
7. [ISO date folders](docs/07-iso-dates.md)
8. [Dependency cleanup](docs/08-dependencies.md)
9. [Async job queue](docs/09-job-queue.md)
10. [Tests & CI](docs/10-tests-ci.md)

## Development

```bash
npm test
```

Vitest suite (22 tests) — also run by GitHub Actions on every push/PR.

## License

[MIT](LICENSE)
