# Fully offline scan copies (issue #20)

Saved scans are now self-contained. Viewing or auditing a page after the
scan makes **no requests to the origin site**.

## Before

`fixRelativePaths` rewrote relative URLs to **absolute URLs on the live site**.
Opening a saved page pulled its CSS, JS, images and fonts from the origin —
so browsing your own archive hit (and announced you to) the scanned website,
and the copy rotted as soon as the site changed.

## Now

`src/offline.js`, on by default (`offline: true`; CLI opt-out `--no-offline`,
API `{"offline": false}`):

1. **Collects** every asset reference — `<img|script|source|video|audio|embed src>`,
   `<link rel=stylesheet|icon|preload|apple-touch>`, `srcset` candidates,
   `<video poster>` and `url()` in inline styles. Protocol-relative
   (`//host/x`) and root-relative (`/x`) references are resolved against the
   page URL; `<iframe>` is excluded (an embedded document is not this page's
   asset).
2. **Downloads** them into a per-scan `_assets/` folder, deduplicated by URL
   with content-hashed filenames, retrying `429`/`503` with backoff and
   honouring `Retry-After`.
3. **Follows stylesheets** one level deeper (up to 3), pulling in the fonts and
   images referenced by `url()`/`@import` and rewriting those references
   inside the saved CSS.
4. **Rewrites** the markup to point at the local copies — longest-match-first
   and only at value boundaries, so a root-relative `/logo.png` cannot corrupt
   a longer `https://cdn.example/logo.png`.
5. **Injects a CSP** (`default-src 'self' data: blob:`, `connect-src 'none'`,
   `frame-src 'none'`, `form-action 'none'`) and strips `preconnect` /
   `dns-prefetch` / `prefetch` hints, so even scripts that survive cannot
   phone home.

**Navigational `<a href>` links stay absolute** — they are not fetched until
clicked, and the link analysis depends on them.

The file extension follows the **content type**, not the URL: Wikipedia serves
stylesheets from `load.php`, and saving those as `.php` makes browsers reject
them on MIME grounds.

## Verified

**Unit (13 tests):** asset collection incl. protocol/root-relative `srcset`
resolution, preconnect and iframe exclusion, content-type extension
precedence, hash stability and collision avoidance, CSP injection and
placement, hint stripping, and anchors left absolute.

**Live scrape of `en.wikipedia.org/wiki/Web_scraping`:** 58 assets (221 KB)
downloaded; every `src`, `srcset`, `<link>` stylesheet and CSS `url()` in the
saved page resolves locally; 14 stylesheets apply and the page renders with
its real layout when served from `/output`.

**Proof of the guarantee:** loading the saved copy in a browser recorded
**zero bytes** to any origin host — the residual requests attempted by
Wikipedia's own scripts show `transferSize: 0, duration: 0, responseStatus: 0`,
i.e. blocked by the CSP before any connection was made.

## Known limitation

Wikimedia's CDN answers **HTTP 429** when a page's images are fetched back to
back. Retry with backoff reduced the failures from 7 to 4 on that page, but a
few thumbnails still fail there and remain as external references — which the
CSP then blocks, so they render broken rather than leaking. Sites without
aggressive per-client throttling capture completely; a per-host asset rate
limit would close the gap.
