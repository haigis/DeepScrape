# Screenshot filename fix (issue #3)

## Problem

```js
const screenshotFile = savePath.replace('.html', '.webp');
```

`String.replace` with a string argument replaces the **first** occurrence
anywhere in the path. Any path containing `.html` mid-string got corrupted:

```
output/localhost/docs.html/page.html
→ output/localhost/docs.webp/page.html   ❌ (directory renamed, file still .html)
```

## Fix

Anchored regex in `src/scraper.js`:

```js
const screenshotFile = savePath.replace(/\.html$/, '.webp');
```

Only the trailing extension is replaced.

## Verified

Scraped `http://localhost:8931/docs.html/page` (test site with a directory
literally named `docs.html`) with `-ss`:

```
output/localhost/08-08-2026/localhost/docs.html/page.html
output/localhost/08-08-2026/localhost/docs.html/page.webp   ✓ side by side
```
