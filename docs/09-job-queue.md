# Async job queue (issue #9)

The foundation for using DeepScrape as a SaaS backend: scrape requests no
longer block the HTTP connection for the duration of the crawl.

## Before

Every `POST /scrape*` endpoint `await`ed the entire crawl before responding.
A large sitemap scan held the request open for minutes-to-hours — guaranteed
proxy/browser timeouts, no progress visibility, no concurrency control.

## API

| Endpoint | Change |
|---|---|
| `POST /scrape` | Returns **202** `{jobId, statusUrl, outputDir}` immediately |
| `POST /scrape/sitemap` | 202; sitemap fetch happens inside the job |
| `POST /scrape/spider` | 202 |
| `POST /scrape/batch` | 202 + `queuedUrls` count |
| `GET /jobs/:id` | **New** — `{status, progress, result, error, timestamps}` |
| `GET /jobs` | **New** — recent jobs, newest first (capped at 200 kept in memory) |

Job lifecycle: `queued → running → completed | failed`.
`progress` is `{done, total, currentUrl}` — for spiders, `total` is
`visited + queued` (grows as links are discovered).

Jobs run **sequentially** (one Puppeteer workload at a time), through a shared
browser instance (`getBrowser()`/`closeBrowser()` in scraper.js) that launches
lazily and closes when the queue drains. The CLI closes it on exit.
`processUrls` now returns `{processed, failed, total}`; spider returns
`{visited, broken, outDir}` — both become `job.result`.

`scan.html` polls `statusUrl` every 1.5 s and renders live progress instead of
the old fire-and-forget alert.

Note: the queue is in-memory — jobs are lost on server restart. For the SaaS
this graduates to a persistent queue (e.g. BullMQ/Redis or a DB table).

## Verified

- Spider job over the 5-page test site: `POST` answered **202 in 137 ms**
  (previously held ~13 s); mid-run poll showed
  `running, {done: 2, total: 4, currentUrl: …/a.html}`; final state
  `completed, result {visited: 5, broken: 1}`.
- Bad sitemap URL → job `failed`, `error: "Request failed with status code 404"`,
  API stays up.
- Two jobs submitted back-to-back: A `running` while B `queued`; both
  `completed` in order.
- Browser test of `scan.html`: submit → live status → `✅ Job completed`.
