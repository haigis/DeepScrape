# Scan browser UI (issue #12)

`public/scans.html` reworked from a flat card dump (every scan of every site
rendered at once, all files fetched up front) into a two-pane scan browser:

- **Sidebar** — scanned sites grouped by domain, each expandable to its scan
  dates (newest first, count badge per site), with a live filter box.
- **Detail panel** — loads on selection only:
  - stat tiles: pages / screenshots / images / crawl artifacts
  - spider artifact links (`all-links.txt`, `broken-links.txt`,
    `incoming-links.json`) when the scan came from a crawl
  - page table: lazy-loaded screenshot thumbnail (click to open a lightbox),
    page path, HTML + screenshot links
- Same-origin relative URLs, vanilla JS, no build step. All dynamic text is
  inserted via `textContent`/DOM APIs (no HTML interpolation of scan names).

## Verified (against the live API)

- Sidebar groups `localhost` (2 dates, newest first) and a second seeded
  domain; filter box narrows to matching sites; count badges correct.
- Selecting `localhost/2026-08-08` (spider scan with screenshots):
  stats `Pages=3, Screenshots=3, Images=0, Crawl artifacts=3`; all three
  artifact links point into `/output/…`; three page rows with HTML +
  screenshot links.
- Screenshot assets serve (`200 image/webp`, thumbs render 1440×900).
- Switching to the older `2026-07-01` scan updates the panel and the active
  highlight.
