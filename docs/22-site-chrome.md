# Separating navigation from real incoming links (issue #23)

## The problem

Navigation, headers and footers repeat on every page. Counting their
links as incoming links made every page look like it linked to every
other page, drowning the editorial links that actually say something
about a page's importance.

On a real scan, `/current-accounts` reported **42 incoming links**. Only
**3** were written into another page's content; the other 39 were the
same nav block repeated across the site.

## The fix

`src/chrome.js` classifies every link by the region it sits in —
`content`, `nav`, `header` or `footer` — using **cheerio**, so real CSS
selectors work rather than guessed regex patterns.

**Defaults** (applied when a scan specifies nothing) cover semantic
elements and ARIA landmarks first, then the class/id conventions most
sites use:

- nav: `nav`, `[role="navigation"]`, `.nav`, `.navigation`, `.navbar`,
  `.menu`, `.site-nav`, `#nav`, `.breadcrumb`, `[aria-label*=breadcrumb]`
- header: `header`, `[role="banner"]`, `.header`, `.site-header`, `#header`
- footer: `footer`, `[role="contentinfo"]`, `.footer`, `.site-footer`, `#footer`

**Custom selectors** — one or many, comma separated — are added to the
defaults (or replace them) so a customer can name the containers their
site actually uses:

```
GET /scan/page?scan=…&path=…&navSelector=%23globalnav,.l-menu&footerSelector=.l-footer
```

A nav nested inside a footer is reported as nav (innermost wins), and a
page linked from both a nav and a body counts as **content** — the
editorial link is the signal. A malformed selector is skipped without
losing the valid ones.

## What changed in the analysis

- Every link carries `region`.
- `counts.incomingContent` / `counts.incomingChrome` split the total.
- Incoming links sort content-first.
- The link-neighbourhood graph draws **content links only**, with a note
  saying how many chrome links were excluded and where to find them.
- The Incoming table gains a **Where** column badging each source.

Chrome selectors are part of the inbound index cache key, so changing
them re-derives the graph without re-scraping.

## Verified

**Unit (10 tests, suite 107/107):** region classification for semantic
elements, ARIA landmarks and class conventions; nav-inside-footer;
custom selectors added to or replacing the defaults; a malformed
selector ignored without losing valid ones; anchor text and rel retained.

**Real scan (`www.nationwide.co.uk`):**

| Page | Incoming | Content | Chrome |
|---|---|---|---|
| `/current-accounts` | 42 | **3** | 39 |
| `/current-accounts/help` | 23 | **6** | 17 |
| `/current-accounts/flexdirect` | 10 | **10** | 0 |

The graph for `/current-accounts` now draws 3 inbound nodes instead of
42, and passing `navSelector=ul` moved a further link from content to
chrome — proving the selectors take effect.
