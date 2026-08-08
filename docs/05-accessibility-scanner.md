# Accessibility scanner fixes (issue #5)

Also renamed: `src/accessability.js` → `src/accessibility.js` (typo), with a
new npm script: `npm run audit -- output/<domain>/<date>/`.

## Problems fixed

| Bug | Before | After |
|---|---|---|
| axe injection | `eval(source)` inside `page.evaluate` — only worked via sloppy-mode scope leakage of `var` declarations | `page.addScriptTag({ content: axeSource })` — the supported injection path |
| Browser churn / leak | A **new Puppeteer browser per HTML file**, never closed if analysis threw — large scans leaked browsers until crash | One browser + one page reused for the whole scan, closed in `finally`; per-file errors logged and skipped |
| Report XSS | Scraped page content (axe selectors, descriptions) interpolated into report HTML **unescaped** — a scanned page could inject script into your own audit reports | `escapeHtml()` applied to every interpolated value |
| Hardcoded LAN IP | Report links pointed at `http://192.168.1.31:5700/...` | Relative `/output/...` links — work from whichever host serves the reports |
| Crash on `impact: null` | axe violations can have `impact: null` → `TypeError` on `.charAt` | Guarded, renders "Unknown" |

## Verified

- Scraped the local test site, then hand-injected a hostile element
  (`class=""><script>alert(1)</script>"`) into the saved HTML before auditing.
- `node src/accessibility.js output/localhost/08-08-2026` → 5 WCAG issues,
  report + index generated, **zero** occurrences of raw `alert(1)` markup in
  the report; real selectors render escaped (`a[href=&quot;…&quot;]`).
- `escapeHtml('"><script>alert(1)</script>')` →
  `&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;` ✓
- Report link is now relative: `href="/output/localhost/08-08-2026/…"` ✓
