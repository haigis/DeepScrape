# Page metadata & discoverability (issue #18)

A **Metadata & discoverability** panel on `page.html`, extracted from the saved
HTML and cross-referenced against the crawl's link graph.

## Extracted (`meta` on `GET /scan/page`)

| Field | Notes |
|---|---|
| `title` / `titleLength` | Markup stripped, whitespace collapsed |
| `h1s` / `h1Count` | **All** H1s — zero and multiple are both flagged |
| `h2Count` | Rough structure signal |
| `description` / `descriptionLength` | Flagged when missing, < 50 or > 160 chars |
| `robots` | `noindex`, `nofollow`, `noarchive`, `nosnippet`, `noimageindex`, `notranslate` — merged from `meta name="robots"` **and** `name="googlebot"`; `none` expands to noindex + nofollow. Attribute order and case independent |
| `canonical` | From `<link rel="canonical">` |
| `lang` | From `<html lang>` |

## The discoverability cross-check

This is the point of the panel: **a `noindex` page that other pages still link
to is reachable but excluded from search.** `discoverability.status` is one of:

| Status | Meaning |
|---|---|
| `indexable-and-linked` | ✅ Normal, healthy page |
| `noindex-but-linked` | 🚫 Excluded from search, yet N followed internal links point here — crawlers keep finding it |
| `noindex` | 🚫 Excluded, and nothing links to it |
| `canonicalised-away` | ↪️ Canonical names a different URL, so this one is not the indexed version |
| `orphan` | 🔗 Indexable, but no page in this scan links here — findable only via sitemap or external link |
| `nofollow-links-only` | ⚠️ Every inbound internal link is `nofollow` — no link equity passed |

Inbound links are split into **followed vs nofollow** using the per-link
`nofollow` data from the link analysis, and `meta robots nofollow` is reported
against the page's own outgoing links ("the 3 internal links on this page are
not followed"). Plain-English notes explain each finding underneath.

## Known limitation (stated in the UI)

Only the **meta tag** is observable — the scraper does not capture the HTTP
`X-Robots-Tag` response header, so a header-level `noindex` would not appear
here. `discoverability.headerRobotsChecked` is `false` to make that explicit.
Capturing response headers at scrape time would fix it and is a good follow-up.

## Verified

**Unit (13 new, suite 57/57):** extraction of title/H1s/description/canonical/
lang with nested markup and `&nbsp;`; multiple and missing H1s; robots parsing
with reversed attribute order and mixed case; `none` expansion and googlebot
merging; default-indexable when no robots meta. Discoverability: noindex +
inbound links → `noindex-but-linked`; orphan; nofollow-only inbound; meta
nofollow vs outgoing links; canonical pointing away; trailing-slash-tolerant
self-canonical; missing title/H1/description notes.

**Live spider scan** of two purpose-built pages:
- `/a.html` — ✅ *Indexable and linked internally*; title 18 chars, one H1,
  86-char description, `index, follow (default)` badge, self-referencing
  canonical, `en-GB`, "1 followed internal link in · 2 internal out"
- `/b.html` — 🚫 *noindex — but still reachable via internal links*; both H1s
  listed with "2 H1s — expected one", `noindex` badge with raw
  `"noindex, follow"`, and notes explaining the conflict and the 6-char
  description

(A mangled em-dash during testing turned out to be the fixture page missing
`<meta charset>` — the browser correctly assumed windows-1252. Adding the
charset produced the right title, confirming the scraper saves faithfully.)
