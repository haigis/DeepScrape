# API security hardening (issue #6)

## Fixed

### Path traversal — `GET /scan/all`
`path.join(cwd, 'output', scan)` accepted `scan=../../anything`, letting any
caller list directories anywhere on the server. Scan identifiers are now
resolved with `path.resolve` and rejected unless the result stays inside the
`output/` root (prefix check against `OUTPUT_ROOT + path.sep`).

### Arbitrary file read — `POST /scrape/file` (removed)
The endpoint read **any server file path** supplied by the caller
(`{"filePath": "C:/…"}`). It now returns **410 Gone** with a migration
message. Replacement: `POST /scrape/batch {"urls": ["https://…", …]}` — the
client sends the URL list itself; only `http(s)` URLs are accepted.

### Network exposure
- Server bound `0.0.0.0` → now defaults to **127.0.0.1**; opt in to LAN
  exposure with `HOST=0.0.0.0` (and `PORT` is configurable).
- CORS was `origin: '*'` → now **off by default** (the UI is same-origin);
  opt in per origin with `ALLOWED_ORIGINS=https://a.com,https://b.com`.

### Hardcoded LAN IP
`public/scan.html` and `public/scans.html` called `http://192.168.1.31:5700`
— now same-origin relative URLs, so the pages work wherever the API runs.

## Also fixed while in the UI

- `scans.html` displayed the **hostname as the scan date** and vice versa
  (`scan.split('/')[0]` is the domain).
- `/scan/all` now lists files **recursively** and returns forward-slash
  paths; previously it returned only the top-level directory entry (so the
  UI showed no files) and produced backslash paths on Windows.
- Screenshot links used `replace('.html', '.webp')` (first occurrence) —
  same class of bug as issue #3; now anchored.
- `scan.html` sent `excludeUrls` but the API read `ignoreUrls`, so the
  exclude field silently did nothing. The API now accepts both.

## Env reference

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` | Bind address (`0.0.0.0` to expose on LAN) |
| `PORT` | `5700` | Listen port |
| `ALLOWED_ORIGINS` | *(unset — CORS off)* | Comma-separated origins allowed to call the API cross-origin |

## Verified

- `scan=../../src` and `scan=..%2F..%2Fsrc` → `400 {"error":"Invalid scan path"}`;
  `....//....//src` resolves inside output → 404, nothing leaked.
- `POST /scrape/file` → 410 with migration message.
- `POST /scrape/batch` with 2 valid + 1 invalid URL → `processedUrls: 2`.
- `OPTIONS /scans` with a foreign `Origin` → no `Access-Control-*` headers.
- `netstat`: listener on `127.0.0.1:5700` only.
- Browser check of `/scans.html`: hostnames/dates correct, relative
  `/output/...` links resolve, per-page rows render.
