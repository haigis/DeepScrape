# Link inventory and watched-link checks

## Why

Coherence merges its "Broken links" and "Incoming / external links" pages
into one **Links** section that lists every link in a scan and lets a
customer tag key links or journeys and be told when one changes by
mistake — a CTA that lost its analytics `id`, an anchor whose `data-*`
hook was renamed, a step in a sign-up journey that no longer links to the
next one. The per-page endpoint (`/scan/page`, doc 14) cannot answer
"what changed across the whole site", so two whole-scan endpoints were
added on top of the inbound index (doc 18).

## Identity attributes on every anchor

`extractAnchors` now returns `id`, `className` and `data` (an object of
`data-*` attributes with the prefix removed, values as strings) for each
anchor. The inbound index keeps them per source page; when the same
target is linked from a page's nav and its body, the body anchor's
attributes win, matching the region rule. They appear on the incoming
links of `/scan/page` and on every `sources[]` entry below.

## `GET /scan/links?scan=<domain>/<date>`

Every link target in the scan, aggregated from the anchors of all saved
pages, plus the saved pages nobody links to (orphans).

Query parameters:

| param | values | meaning |
|---|---|---|
| `type` | `all` (default), `internal`, `external`, `broken`, `orphan` | broken = internal targets listed in `broken-links.txt`; orphan = saved pages with no inbound links |
| `region` | `content`, `chrome` | targets with at least one content-region link, or linked only from site chrome |
| `q` | text | case-insensitive substring of the URL, anchor texts or target title |
| `sort` | `inbound` (default), `url` | default order is broken first, then most linked |
| `limit`, `offset` | numbers | `limit` clamped to 1..1000, default 200 |
| `chrome` | JSON array | the customer's named chrome groups, as for `/scan/page` |

Response:

```jsonc
{
  "scan": "bank.example/2026-09-13",
  "pagesIndexed": 1308, "indexTruncated": false,
  "counts": { "targets", "internal", "external", "broken", "notScraped", "orphans", "externalHosts", "nofollow" },  // whole inventory
  "total": 3, "offset": 0, "limit": 200,                                                                          // after filters
  "links": [{
    "url", "host", "internal", "path", "scraped", "broken", "title", "h1",
    "inbound", "contentInbound", "occurrences", "nofollow", "regions": { "content": 5, "nav": 32 },
    "anchorTexts": ["…"],                    // ≤5 distinct
    "sources": [{ "path", "url", "title", "text", "region", "nofollow", "occurrences", "id", "className", "data": {} }]  // ≤10, content first
  }],
  "externalHosts": [{ "host", "links", "pages" }]   // always the full list
}
```

`nofollow` on a target is true only when every source links it with
`rel=nofollow`. URLs are normalised the way the scraper saves pages:
fragment dropped, trailing slash stripped, query string ignored.

## `POST /scan/links/check`

```jsonc
{ "scan": "bank.example/2026-09-13", "urls": ["https://bank.example/savings/squirrel-saver", "…"], "chrome": [] }
```

Returns the current state of up to 500 specific links so a caller can
compare the same URLs across scans:

```jsonc
{ "scan": "…", "results": [{
  "url",              // normalised echo of the input
  "found",            // at least one saved page links to it
  "internal", "scraped", "broken", "inbound", "contentInbound", "anchorTexts",
  "sources": [ /* every source, ≤100, content first, same shape as above */ ]
}] }
```

A URL that is not linked from anywhere comes back with `found: false` and
no sources rather than an error, so a watched link that disappeared is a
normal result, not a failure.

## Cost

Both endpoints read the cached inbound index, so after the first call for
a scan they cost one pass over an in-memory map. Filtering and paging
happen server-side; a 10k-page site never ships its whole graph.

## Tests

`tests/linkInventory.test.js` covers attribute capture, aggregation,
broken/external/orphan classification, filters, sorting, paging and the
check endpoint's normalisation.
