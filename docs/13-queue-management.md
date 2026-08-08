# Job queue management (issue #14)

The scan page now shows the live queue and gives full control over it.

## Backend

- **Cancellation** — `POST /jobs/:id/cancel`:
  - *queued* → removed from the queue immediately, status `cancelled`
  - *running* → an `AbortSignal` (checked by `processUrls`/`spiderCrawl`
    between pages) stops the job at the next page boundary; partial results
    are kept and marked `aborted: true` (spider still writes its link files)
  - *finished* → 409
- **Reorder** — `POST /jobs/:id/move {position}` repositions a queued job
  among queued jobs (0 = runs next).
- **Edit** — `PATCH /jobs/:id {rateLimit?, maxDepth?, screenshot?, downloadImages?}`
  (whitelisted, queued jobs only, 409 otherwise). Runners now receive
  `(onProgress, params, signal)` and read params **at start time**, so
  queued edits genuinely take effect.
- New job status `cancelled`; `GET /jobs` includes each queued job's
  `queuePosition`.

## UI (`scan.html`)

Live queue panel polling every 2 s (paused while an edit form is open):

| Status | Row shows | Controls |
|---|---|---|
| running | ▶, progress `done/total` | ⏹ Stop |
| queued | position number, settings summary | ▲ ▼ move · ✏️ Edit (inline form: rate limit, depth for spiders, screenshot, images) · ✖ Cancel |
| completed | result summary (`5 pages, 1 broken`, `stopped early` when aborted) | — |
| failed / cancelled | error / label | — |

## Verified

**Unit (7 new tests, suite 37/37):** queued cancel never runs the job;
running job stops via its signal with partial result; finished-job cancel
rejected; reorder changes execution order; queued edit is visible to the
runner; edits to finished jobs rejected; queue positions listed.

**API:** move → order swapped; PATCH while queued → params updated;
cancel queued → `cancelled`; cancel running spider → `cancelled` with
`{visited: 1, aborted: true}` partial result; PATCH finished → 409.

**Browser (scan.html):** queue table rendered running/queued/finished rows
with correct controls; ▼ swapped two queued jobs and they completed in the
new order; inline edit saved `rate 42ms` and the job ran with it; ⏹ Stop
cancelled the running spider.
