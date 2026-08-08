# Tests and CI (issue #10)

`npm test` previously exited 1 with "No tests defined". Now: **Vitest**, 22
tests across 5 files, plus a GitHub Actions workflow running them on every
push/PR to `main`.

## Test files

| File | Covers |
|---|---|
| `tests/scraper.test.js` | `buildPagePath` (root, extensionless, `.html`/`.htm` no double-append, trailing slash), `resolveOptions` defaults/overrides |
| `tests/fileHandler.test.js` | `generateOutputDir` ISO format + invalid-URL fallback, `fixRelativePaths` relative→absolute and absolute untouched |
| `tests/sitemap.test.js` | Real HTTP server fixture: flat urlset, sitemapindex recursion + gzip child + dedupe, unrecognised root throws, HTTP error throws |
| `tests/jobs.test.js` | Job lifecycle to `completed` with result/progress/timestamps, `failed` with error, **sequential execution order**, newest-first listing |
| `tests/accessibility.test.js` | `escapeHtml` XSS characters, ampersands/quotes, non-string input |

The sitemap tests bind a throwaway `http.Server` on port 0 (OS-assigned), so
they exercise the real axios + zlib + xml2js path with no mocks and no
network dependency.

## CI

`.github/workflows/ci.yml`: Node 22, `npm ci` (with
`PUPPETEER_SKIP_DOWNLOAD=true` — no test launches a browser, so the ~170MB
Chromium download is skipped), `npm test`.

## Verified

- Local: `npm test` → 5 files, 22 tests, all passing in ~2s.
- CI: first workflow run on `main` green (see Actions tab).
