# ISO date scan folders (issue #7)

## Problem

Scan folders used UK date format (`15-03-2025`), and `/scans` "sorted" them
with `new Date("15-03-2025")` — which is `Invalid Date`, so the sort was a
silent no-op and scans listed in filesystem order.

## Fix

- `generateOutputDir()` now emits ISO dates: `output/<domain>/2026-08-08/`.
  Lexicographic order equals chronological order, so `/scans` sorts with a
  plain `localeCompare` on the date segment — latest first, no date parsing.
- Bonus fix (found during the issue #6 browser check): `buildPagePath()`
  double-appended extensions — a URL ending `/a.html` saved as `a.html.html`.
  Now `.html`/`.htm` paths are left as-is, and the screenshot filename swap
  handles both (`/\.html?$/i`).

Existing scans in the old `DD-MM-YYYY` format will sort after ISO dates;
re-scrape or rename old folders if ordering matters.

## Verified

- Scrape → `output/localhost/2026-08-08/localhost/a.html` (ISO folder ✓,
  single extension ✓).
- With seeded older scans, `GET /scans` returns
  `["localhost/2026-08-08", "zzz.example/2026-01-15", "localhost/2025-12-31"]`
  — chronological, latest first, across domains ✓.
