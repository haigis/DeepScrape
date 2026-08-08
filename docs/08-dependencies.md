# Dependency cleanup (issue #8)

## Removed

| Package | Why |
|---|---|
| `fs@0.0.1-security` | Not the Node built-in — an npm **placeholder package** squatted for security. Depending on it does nothing (imports of `fs` resolve to the built-in), but it's a supply-chain smell. |
| `path@0.12.7` | Same story: userland shadow of a Node built-in. |
| `cheerio` | Never imported anywhere. |
| `cli-progress` | Never imported anywhere. |

## Changed

- `name`: `DeepScrape` → `deepscrape` (npm names must be lowercase).
- `version`: `1.1.0` (breaking-ish CLI/API changes from the modernisation).
- `license`: `ISC` → `MIT`, matching the README; added a `LICENSE` file
  (the README claimed MIT but no license file existed).
- `engines.node >= 22` documented (README already required Node 22+).
- Added `npm run audit` script for the accessibility scanner.

## Verified

- `npm install` → clean tree of 7 direct deps (axe-core, axios, cors,
  express, puppeteer, sharp, xml2js), all imported somewhere in `src/`.
- Smoke test after removal: scrape + screenshot of a test-site page works.
