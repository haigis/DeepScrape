# Priority single-page re-scan (issue #17)

A **⚡ Re-scan now (priority)** panel on `page.html` re-scrapes just the page
you are looking at, jumping the queue.

## Why priority

A single page takes a second or two; a sitemap or spider job can take hours.
Without queue-jumping, "refresh this one page" would sit behind a long crawl
and be useless as an interactive action.

## Backend

`createJob(type, params, runner, { priority: true })` inserts the job **ahead
of normal jobs but behind priority jobs already waiting**, so urgent work stays
FIFO among itself and never starves. `POST /scrape` accepts `priority: true`.
Jobs carry a `priority` flag, and `GET /jobs/:id` now includes
`queuePosition` so the UI can show the wait.

## UI

The panel takes the settings for that one run — rate limit (defaults to 0,
since it is a single request), screenshot (pre-ticked if the page already has
one) and download images — then polls the job, showing queue position while it
waits and reloading the page data on completion so the new size, screenshot
and links appear immediately.

Pages whose original URL could not be read from the saved HTML show an
explanatory message instead of the button.

## Verified

**Unit (2 new, suite 44/44):** a priority job created behind two queued normal
jobs takes `queuePosition 0` and executes first (`urgent, normalA, normalB`);
two priority jobs keep submission order ahead of a normal job (`p1, p2, normal`).

**In-browser:** with a spider running and a normal scrape already queued,
clicking Re-scan produced `scrape:queued@0 PRIORITY` ahead of
`scrape:queued@1`; the status line read "position 1 in queue"; after stopping
the blocking spider the priority job ran first
(`scrape:completed PRIORITY {processed: 1}`) and the page reloaded itself.
