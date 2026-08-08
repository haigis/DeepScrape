# Unified sitemap parsing (issue #4)

## Problem

Two divergent sitemap implementations existed:

- `scraper.js processSitemap()` — regex scan for `<loc>` tags. On a
  `<sitemapindex>` it returned the URLs *of other sitemap files* as if they
  were pages to scrape.
- `utils.js readUrlsFromSitemap()` — xml2js, but assumed `parsed.urlset.url`
  and **crashed** (`Cannot read properties of undefined`) on any sitemap
  index, which large sites commonly serve at `/sitemap.xml`.

Neither handled gzipped sitemaps (`.xml.gz`).

## Fix

One implementation: `src/sitemap.js → fetchSitemapUrls(sitemapUrl)`.

- `<urlset>` → collects `<url><loc>` entries
- `<sitemapindex>` → queues each child `<sitemap><loc>` and recurses
  (cycle-safe via a `seen` set, capped at 50 sitemap fetches)
- Gzip detected by extension, content-type, **or magic bytes** and
  transparently gunzipped
- Results deduped via a `Set`; browser-like User-Agent sent (some CDNs 403
  the default axios UA)

Both `readUrlsFromSitemap` and `processSitemap` are removed; CLI (`-sm`) and
API (`POST /scrape/sitemap`) now share this parser. Also deduplicated the
second `waitMs` copy out of `cookieHandler.js` (now imported from `utils.js`).

## Verified

Local test server serving `sitemap.xml` (index) → `sitemap-a.xml` (plain) +
`sitemap-b.xml.gz` (gzipped), with `a.html` listed in both children:

- Returned exactly 4 unique page URLs — recursion ✓, gzip ✓, dedupe ✓

Real world: `https://www.sitemaps.org/sitemap.xml` → 84 URLs from 1 file ✓
