# Interactive analytics dashboards (issue #15)

"Football Manager for websites": every object, stat and shape is
**hoverable for detail and clickable to drill through**, so the relationships
between sites, sections, pages and links are explorable rather than just
listed.

## Shared visual language

- `public/app.css` — dark chrome + light panels, tiles, grids, badges,
  tooltip and chart styles, used by every page.
- `public/app.js` — dependency-free ES module: DOM/SVG builders, formatters,
  a floating hover tooltip, a **squarified treemap**, a horizontal
  **bar chart** and a **histogram**. Each chart takes `tooltip(item)` and
  `onClick(item)`, so every mark is interactive by construction.
- Consistent top nav across all four pages: **Dashboard · Page tree ·
  Scan & queue**, with the current scan carried between them in the URL.
  `/` now lands on the dashboard.

## Site dashboard (`dashboard.html`)

With no `?scan`, a **site picker** lists every scanned domain with its scan
count and latest date. With a scan selected:

| Element | Hover | Click |
|---|---|---|
| **Headline tiles** (pages, screenshots, images, broken links, orphans, max depth) | explanation + secondary figures (total/avg size, coverage) | scrolls to the relevant panel |
| **Section treemap** — area = pages | pages, total/avg size, % of site | drills into that section (banner shows its stats, with "Open in page tree →") |
| **Depth histogram** | page count + % of site | opens the page tree |
| **Most linked-to pages** bars | inbound link count, HTML size | opens that page's dashboard |
| **Biggest changes** bars (vs previous scan) | grew/shrank by X since the previous date | opens that page |
| **Largest pages / Orphans / Broken links** tables | full path + original URL | opens that page's dashboard |
| **Date selector** in the nav | — | switches scan, keeping you on the dashboard |

A comparison strip (pages ±, added, removed, changed, HTML size delta) appears
whenever a previous scan of the same domain exists.

## Page link neighbourhood (`page.html`)

The relationships view: the page sits in the centre, **inbound sources on the
left, outbound targets on the right**, joined by curved edges.

- Node colour encodes type — green inbound, blue internal outbound,
  **red broken**, purple external (labelled by host).
- Hovering a node **highlights its edge** and shows the URL, the **anchor
  text** used, occurrence count, `nofollow`, and whether the target was
  scraped or is broken.
- Clicking a node opens that page's own dashboard (or the live URL for
  external hosts), so you can walk the link graph page by page.
- Shows up to 8 inbound, 8 internal outbound and 4 external hosts.

## Performance

`GET /scan/dashboard` on the 3,125-page synthetic bank scan: **2.07s → 0.70s**.

1. Inbound counts are derived by mapping each linked **URL → its scan path**
   (O(links)) instead of reading every saved page's URL comment (O(pages),
   ~3k file opens).
2. `fs.stat` calls are issued per directory with `Promise.all` rather than
   sequentially.

## Verified in-browser

- Site picker lists all 7 scanned domains (including real
  `monzo.com` / `www.nationwide.co.uk` scans).
- 3,125-page dashboard: header "3,125 pages · 2.32 MB of HTML", tiles correct
  (25 orphans, 3 broken), treemap of 5 sections, 3 depth bars, all 7 panels.
- Treemap hover → *"/personal · 1,249 pages · 954.8 KB total · avg 783 B ·
  40% of the site"*; click → drill banner *"Drilled into /personal — 1249
  pages, 954.8 KB, avg 783 B"*.
- Histogram, hub bars and table rows all show tooltips; clicking a hub bar
  navigated to `/business/accounts/product-000.html`'s dashboard.
- Link graph on the test site: 7 nodes (2 inbound, 3 internal out incl. one
  **broken**, 1 external, centre), 6 edges. Hover highlighted exactly 1 edge
  and read *"This page links to … Anchor: "Missing" … Broken link"*; inbound
  hover read *"Anchor: "Home""*; mouseleave cleared the highlight; clicking a
  node navigated to that page.
- Deep link `/scans.html?scan=…` opens the tree with the right scan active and
  the Dashboard nav link carrying the scan.
- No page errors; all requests 200.
