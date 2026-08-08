# Correct incoming links + link type classification (issue #19)

## The bug

Inbound links were read **only** from the spider's `incoming-links.json`.
That file records what one crawl reached — nothing more.

On the real `monzo.com` scan:

```
incoming-links.json: 77 targets, every one with exactly 1 source
distinct source pages recorded: 1   (https://monzo.com/)
pages actually saved in the scan:  39
```

The spider had run at depth 1, so only the homepage ever contributed links,
while 39 pages were saved into the same scan folder by other jobs. `/loans`
therefore reported **"Linked from (1)"** despite 36 saved pages linking to it
from their navigation. Scans with no spider run at all (sitemap or batch)
showed **zero** inbound links for every page.

## The fix

`getInboundIndex(scanPath)` builds the inbound graph from **every saved page**
in the scan by extracting its anchors and mapping each target URL to the path
it occupies. `analyzeIncoming` uses that index, unioned with
`incoming-links.json` so sources the crawl saw but never saved are still
listed (badged *"seen by crawl only"*). The dashboard's orphan detection uses
the same index.

Per source page the index keeps the **anchor texts used**, an occurrence count
(repeat links, including `#fragment` variants, collapse into one source), and
whether every occurrence was `nofollow`.

**Caching:** the index is cached per scan and invalidated by a token of
`(page count, newest mtime)`, so a re-scan rebuilds it but repeat page views do
not. Files are read in batches of 32, capped at 5,000 pages
(`counts.indexTruncated` reports the cap).

## Link types now accounted for

`extractAnchors` previously handled only `<a href>` with `http(s)` and silently
dropped everything else. It now:

- reads `<a>` **and `<area>`** image-map links (falling back to `alt` for text)
- accepts single-quoted attributes as well as double-quoted
- classifies non-HTTP schemes instead of discarding them — `mailto:`, `tel:`,
  `javascript:`, in-page `#fragment`, and anything else — surfaced in a new
  **Other** tab on the page dashboard
- recognises `ugc` and `sponsored` alongside `nofollow` in `rel`

## Verified

**Unit (12 new, suite 69/69):** rel token parsing (nofollow/ugc/sponsored),
single-quoted attributes, `<area>` with alt fallback, scheme classification,
and a purpose-built **crawl-artifact-free** scan proving the index finds all
three linking pages, keeps each one's anchor text, collapses a repeat +
fragment link into `2×`, excludes a genuinely unlinked page, and rebuilds when
a page is added.

**Real data:**
- `monzo.com/loans` — inbound **1 → 36**. Graph header reads
  *"Linked from (36)"*; hovering `flex.html` shows
  *Anchor: "Loans", "Monzo loans" · Links here 3×*; metadata panel now reads
  *"36 followed internal links in · 65 internal out"*. Response 0.11s.
- `www.nationwide.co.uk/business/customer-support/contact-us` — 4 `mailto:`
  links now reported (one used 3×) that were previously invisible, plus a
  `nofollow` outgoing link.
