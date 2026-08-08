# Link analysis on the page dashboard (issue #16)

## Before

Two flat lists of raw URLs — no context, no anchor text, no way to tell an
external tracker from an internal page, no indication whether a target was
actually scraped or broken, and every link navigated **off** to the live site
instead of into the scan.

## Now

`GET /scan/page` returns a `links` object alongside the legacy URL arrays:

```jsonc
{
  "links": {
    "incoming":  [{ url, path, anchorTexts[], occurrences, nofollow, scraped, pageUrl }],
    "internal":  [{ url, text, host, path, scraped, broken, nofollow, occurrences, pageUrl }],
    "external":  [{ url, text, host, nofollow, occurrences }],
    "externalHosts": [{ host, count }],
    "counts": { incoming, internal, external, externalHosts,
                brokenOut, notScraped, nofollow, truncated }
  }
}
```

What that buys:

- **Anchor text** — extracted from the saved HTML, with nested markup stripped
  (`<a><span>Terms</span></a>` → `Terms`). For *incoming* links the source page
  is re-read to recover the words other pages use to link here — the single
  most useful fact about an inbound link.
- **Internal vs external split**, with external links grouped by host so
  "which third parties does this page reach" is one glance.
- **Target status** on internal links: `scraped` / `not scraped` / `broken`
  (cross-referenced against the crawl's `broken-links.txt`).
- **Navigation into the scan** — scraped targets and linking sources link to
  *their own* page dashboards (`page.html?scan=…&path=…`), so you can walk the
  site graph. A separate ↗ opens the live URL.
- **`nofollow`** flagged, and repeated links collapsed with an `n×` count
  (`/a.html` and `/a.html#section` count as one target linked twice).

UI: three tabs (Incoming / Internal out / External out) with per-tab filtering,
clickable host chips on the external tab, and a summary line
("1 broken outgoing · 1 external host"). Analysis is capped at 500 outgoing
links and 100 incoming sources per page, flagged via `counts.truncated`.

## Verified

**Unit (6 new, suite 44/44):** anchor extraction incl. nested markup, rel and
non-http rejection; URL→scan-path mapping; internal/external split with
scraped/broken/nofollow/occurrence assertions; host grouping order; incoming
anchor-text recovery.

**Live spider scan of the test site:**
- internal: `Missing` → broken ✓, `A` → scraped, 2× ✓, `B` → scraped ✓
- external: `External → example.com`, host chip `example.com (1)` ✓
- incoming for `/a.html`: source `/` with both anchor texts
  `["A", "A with fragment"]`, 2 occurrences ✓
- In-browser: tabs render, broken sorts first, 2 internal targets link to
  their own dashboards ✓
