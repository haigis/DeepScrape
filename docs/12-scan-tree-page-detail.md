# Scalable scan tree + page detail with history (issue #13)

Built for sites with thousands of pages in nested directories (banks etc.).

## New API endpoints

| Endpoint | Purpose |
|---|---|
| `GET /scan/tree?scan=` | Server-built directory tree of a scan's pages with per-folder recursive page counts + aggregate stats (pages, screenshots, images, broken links, artifact list). `images/` asset folders are counted but excluded from the tree. |
| `GET /scan/page?scan=&path=` | Per-page detail: original URL (from the saved `<!-- url -->` comment), HTML size, mtime, screenshot URL, **incoming links** (from the spider's `incoming-links.json`), **outgoing links** (parsed from the saved HTML, capped at 300). |
| `GET /scan/history?domain=&path=` | Every scan of the domain containing that page, newest first, with size + **size delta vs the previous scan** and screenshot availability. |

All three validate paths with the same resolve-and-prefix-check used by
`/scan/all`; traversal attempts return 400.

## UI

- **`scans.html`** — the page table is now a **directory tree** (`<details>`
  elements). Children are only inserted into the DOM on first expand, so huge
  scans render instantly as collapsed folders with count badges. A filter box
  searches every page path in the scan (flat results, capped at 300 shown).
  Clicking a page opens the bespoke page view.
- **`page.html`** *(new)* — per-page view: site-relative path, original URL,
  stat tiles (size / incoming / outgoing / scan count), saved-HTML and
  screenshot actions with lightbox, **scan history table** (date, size,
  colored delta, per-scan links, "View this scan →" cross-navigation), and
  scrollable incoming/outgoing link lists.

Implementation: `src/scanStore.js` (tree/detail/history over the output dir,
unit-tested), endpoints in `api.js`, vanilla-JS UI with DOM-API text
insertion throughout.

## Verified

**Unit:** 8 new tests in `tests/scanStore.test.js` (tree counts/sorting/stats
on a fixture, page detail incl. incoming/outgoing mapping, history ordering
+ deltas + missing-page skip). Suite: 30/30 green.

**Scale (synthetic bank, 3,125 pages in the newest scan, 20 nested product
dirs):**

- `GET /scan/tree` → **11–33 ms**, 324 KB JSON
- Initial render of the scan: **431 ms** with only **19 DOM nodes**
  (collapsed folders + counts)
- Expanding `bigbank.example → personal (1,249) → loans (156)`: counts
  correct, DOM grows to just 514 nodes
- Filter `product-042` across all 3,125 pages: **~110 ms**, 20 matches,
  links point at `page.html?scan=…&path=…`
- `page.html`: original URL recovered, incoming/outgoing links listed,
  2-scan history with delta and cross-scan navigation
- Traversal attempts on all three new endpoints → 400
