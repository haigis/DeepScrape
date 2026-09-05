# Crawl resilience: retries, checkpoints, resume, watchdogs (coherence#64)

A production scan failed with `Timed out after waiting 30000ms`. That is
Puppeteer's `browser.newPage()` giving up: Chrome had wedged under a long
crawl, and every new tab request timed out. The call sat outside the
per-page error guard in `scrapePage`, so one bad tab rejected the worker,
`Promise.all` rejected the crawl, and the whole job failed — hours of
captured pages discarded for a browser hiccup.

This change makes a crawl survive everything short of the host dying,
and makes even that recoverable.

## What changed

### The browser is a replaceable resource (`scraper.js`)

- `scrapePage` never throws. Opening the tab happens inside the guard,
  bounded by `DS_NEW_PAGE_TIMEOUT_MS` (20s), and any failure comes back
  as `{ ok: false, error, transient: true }`.
- Two consecutive tab failures **recycle** the browser: wait up to 30s
  for tabs in flight, close it (kill the process if close hangs), and
  the next `getBrowser()` launches a fresh one.
- It is recycled anyway every `DS_BROWSER_RECYCLE_PAGES` (500) pages,
  before a 10k-page crawl can grow Chrome into that state.
- `isTransientError()` classifies messages worth a retry (browser gone,
  connection reset, navigation timeout). A page deadline is not one — a
  page that needed two minutes will need them again.

### Pages are retried (`spider.js`)

A transient failure, a 429, or a 5xx gets up to `DS_PAGE_ATTEMPTS` (3)
attempts with backoff (`DS_RETRY_BASE_MS` 2s, doubling; rate limits wait
10s+). A 404 or non-HTML response is final on the first attempt. Retries
are counted in progress and the result.

### Crawls checkpoint and resume (`spider.js`)

Every `DS_CHECKPOINT_MS` (30s), and on abort, a crawl writes
`crawl-state.json` to its scan folder: pages done, the queue (pages
mid-fetch go back on it), broken pages, duplicates, content hashes. The
link graph goes to `crawl-links.ndjson`, one line per page, appended as
the crawl goes and replayed on resume. Both are deleted when a crawl
completes — a finished crawl is not resumable.

`POST /scrape/full` or `/scrape/spider` with `resume: true` continues
from the checkpoint; without one it starts fresh. `scanDate` pins the
`<domain>/<date>` folder so a retry after midnight lands where it
started. Only a date is accepted, never a path.

The queue is now O(1) dequeue (`Array.shift` on 100k entries was moving
the whole array per page).

### Interrupted jobs re-queue themselves (`jobs.js`, `api.js`)

Job records were already persisted across restarts (#28). Now a crawl
that was queued or running at shutdown is marked `interrupted` and, at
boot, **re-queued under the same job id** with `resume: true`. A caller
polling `/jobs/:id` sees `running → queued → running → completed` and
never has to know. `SIGTERM` flushes checkpoints first (5s cap).

`attempts` counts runs; after `DS_JOB_MAX_ATTEMPTS` (3) a crawl that
keeps taking the scanner down is failed instead of looped. Non-crawl
jobs (single scrape, batch, sitemap) are failed with a plain message.

### Two watchdogs (`jobs.js`)

- **Stall**: no progress report for `DS_JOB_STALL_MINUTES` (30) aborts
  the job as failed + `retryable: true`. A healthy crawl ticks every
  page; the full-scan sitemap phase now ticks per sitemap.
- **Total**: `DS_JOB_TIMEOUT_MINUTES` raised from 240 to 720 — a 10k+
  page site on a gentle preset needs it.

### `/health`

Browser state (connected, tabs in flight, recycles, faults), job counts,
RSS. The Dockerfile `HEALTHCHECK` uses it, so an orchestrator with a
restart policy restarts a wedged container and the crawls resume.

## Caller contract (Coherence)

- Send `scanDate` with the scan id's date; keep polling the same job id
  across a scanner restart.
- A `failed` job with `retryable: true` (stall, timeout, restart limit
  not reached) can be re-run with `resume: true` under the same
  `scanDate` and will finish rather than start over.
- Fetch failures against the scanner during a redeploy are the caller's
  to tolerate for a minute or two; the job is still there.

## Verified

- Unit: retry policy, checkpoint → abort → resume without re-fetching
  (with the in-flight page re-fetched and the link graph intact across
  both halves), stale checkpoint ignored without `resume`, `scanDate`
  path rejection, restore → re-queue under the same id, attempt limit,
  stall watchdog firing and not firing.
- Local end-to-end: a real crawl killed with SIGTERM mid-run, the API
  restarted, the same job id resumed from its checkpoint and completed.

## Follow-up review (coherence#64, second pass)

- **Assets fetched once per scan** (`offline.js`): every page used to
  re-download all of its assets, sequentially — 200+ requests a page,
  which on a slow CDN alone could exceed the page deadline and lose the
  page and its links. Now a per-scan cache (successes and failures) and
  `DS_ASSET_CONCURRENCY` (6) parallel fetches.
- **Global tab cap** `DS_MAX_TABS` (8) across all jobs; a browser fault
  only counts against the browser it happened on.
- **Screenshots never fail a saved page** (`DS_SCREENSHOT_TIMEOUT_MS`,
  45s): the HTML and links are kept, the screenshot is skipped.
- Cookie-banner wait 5s → 1.5s per page (the consent cookie persists
  after the first dismissal, so the wait was pure cost on every page).
- Job records live at `$OUTPUT_DIR/jobs.json`, on the volume.
- A report build that fails twice for the same folder state returns 500
  with the reason to `?wait=0` pollers, instead of an eventual timeout.
- The in-memory report cache is bounded (`DS_MAX_CACHED_REPORTS`, 12).
