# Spider crawl fixes (issue #2)

## Problems fixed

| Bug | Before | After |
|---|---|---|
| Depth off-by-one | `depth >= maxDepth` skipped the final level — `maxDepth: 2` never crawled depth-2 pages | Start URL is depth 0; pages up to and including `maxDepth` are crawled |
| Double fetch | Every page fetched by axios (HEAD + GET) **and** rendered by Puppeteer | Links come from the Puppeteer-rendered DOM (`page.$$eval('a[href]')`) — one fetch per page, and JS-injected links are now discovered |
| Broken-link false positives | `axios.head()` — many servers return 405 to HEAD, so live pages were logged broken; "broken" URLs were then scraped anyway | Liveness comes from the actual navigation response: HTTP ≥ 400 or a navigation error marks the page broken and skips saving |
| `incomingLinks` useless | Every URL mapped to an array containing itself | Real reverse-link map: `{"…/c.html": ["…/a.html"]}` built during link discovery |
| Queue duplicates | Start URLs never entered the `queued` set; fragments (`#section`) counted as distinct pages | All URLs normalized (fragment stripped) and deduped through one `queued` set |
| Regex link extraction | `/href="([^"]+)"/g` missed single quotes, unquoted attrs, matched commented-out markup | Browser DOM is the source of truth |

## Output files (per scan directory)

- `all-links.txt` — every unique link discovered (internal + external)
- `broken-links.txt` — crawled pages that failed (HTTP ≥ 400 or navigation error)
- `incoming-links.json` — **renamed from `incoming-links.txt`** (it was always JSON): URL → list of pages linking to it

`scrapePage()` now returns a `ScrapeResult` (`{ok, status, links, error}`), which
also gives it proper behaviour outside the spider: HTTP ≥ 400 responses and
non-HTML content types are no longer saved as if they were pages.

## Verified

Local 5-page test site with a known link graph (`index → a, b, missing(404),
external, a#fragment; a → c; c → d`), crawled with `--depth 2`:

- Crawled: `/` (0), `a.html`, `b.html` (1), `c.html` (2) — `d.html` discovered
  and recorded but **not** crawled (depth 3) ✓
- `missing.html` → `broken-links.txt`, not saved as HTML ✓
- `a.html#section` deduped into `a.html` ✓
- `https://example.com/` recorded in `all-links.txt`, not crawled ✓
- `incoming-links.json` shows real referrers (e.g. `c.html ← a.html`) ✓
