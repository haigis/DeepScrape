# Unified scrape options (issue #1)

## Problem

The CLI (`src/index.js`) and the API (`src/api.js`) called the same scraper
functions with **different positional argument orders**, and the signatures had
drifted apart:

- `index.js` imported `generateUniqueOutputDir`, a function that no longer
  existed — the CLI crashed at import time (`npm start` was dead).
- `processUrls(urls, outDir, rateLimit, …)` from the CLI put a *path string*
  into the `rateLimit` parameter, and the rate-limit number into the
  screenshot flag (always truthy → screenshots always on).
- `spiderCrawl` was called with 6 args against a 5-param signature, so
  `maxDepth` received the rate limit — a "depth 2" crawl tried to go 1000
  levels deep.
- `skipImages` vs `downloadImages` meant opposite things in different files,
  and image downloading was never actually implemented.

## Fix

All scraping entry points now take **one shared options object**, defined once
in `src/scraper.js`:

```js
export const defaultOptions = {
    rateLimit: 1000,      // ms delay between requests
    maxDepth: 2,          // spider crawl depth
    screenshot: false,    // capture full-page WebP screenshot
    downloadImages: false // download page images alongside the HTML
};
```

- `processUrls(urls, options)`
- `spiderCrawl(startUrls, options)`
- `scrapePage(browser, url, outDir, options)`

`resolveOptions(partial)` merges user input with defaults, so a missing flag
can never shift another parameter's position again.

## Image downloading — now implemented

`downloadImages: true` (CLI: `--images`) saves every `<img src>` on the
rendered page to an `images/` folder next to the saved HTML. Downloads send a
browser-like `User-Agent` and a `Referer` header — sites such as Wikipedia
return **403** to the default axios user agent, which previously would have
failed silently. Failures are now counted and logged per URL.

### CLI flag change

| Before | After |
|---|---|
| `--no-images` (skip images — but images were never downloaded anyway) | `--images` (opt-in download; default is off, matching the API default) |

## Verified

- `node src/index.js --help` — prints usage, exits 0 (previously: `SyntaxError` at import).
- `node src/index.js -u https://example.com -ss --images --rate-limit 100` —
  saved `index.html` (588 bytes) + `index.webp` (9.8 KB).
- `node src/index.js -u https://en.wikipedia.org/wiki/Web_scraping --images` —
  downloaded **9/9 images** (0 failed).
- `POST /scrape {"url":"https://example.com","screenshot":"true"}` → `{"success":true,…}`;
  `GET /scans` lists the new scan.
