# Preemptive priority scans + folder-scoped crawls (issues #13, #22)

## Preemption — instant single-page scans

Priority jobs previously jumped the *queue* but still waited for the
*running* job. Behind a 414-page crawl, an interactive "Re-scan now"
could wait hours.

A running crawl now **parks** so a priority job can run immediately:

- `pauseGate` is awaited by `spiderCrawl`/`processUrls` at each page
  boundary — the natural safe point, so no page is half-written.
- When a priority job arrives while a non-priority job runs, the crawl
  is marked `paused` and the quick job starts concurrently.
- Successive priority jobs all run before the crawl resumes; the gate is
  released only when no priority work remains.
- The crawl continues **from where it stopped** — nothing is re-fetched.
- Cancelling a paused job releases the gate so it can observe the abort.

New job status: `paused`, surfaced in `GET /jobs` and the queue UI.

## Folder-scoped crawls

`pathPrefix` limits a spider to one subtree:

```jsonc
POST /scrape/spider
{ "url": "https://site.com/help/", "pathPrefix": "/help" }
```

Only same-host URLs whose path equals the prefix or starts with
`prefix + "/"` are queued. `scan.html` gains a **Folder / path prefix**
field, and the queue shows `scope /help` on the job.

## Verified

**Preemption (2 tests, suite 97/97):** a 12-page crawl parked mid-run
for a priority job — work order `crawl-0,1,2, URGENT, crawl-3 … 11`,
proving the quick job ran *between* pages and the crawl finished all 12
afterwards. The crawl is observably `paused` while the priority job runs.

A deadlock was found and fixed by these tests: with a *second* priority
job queued, `preemptedJob` was already set so it could never start,
stranding the parked crawl forever. The queue now admits successive
priority jobs while parked (suite time fell 18s → 4.3s once fixed).

**Folder scope (live):** crawling `www.nationwide.co.uk` scoped to
`/current-accounts` found **57 pages** instead of the site's 414, and
every saved page was inside the scope — no leakage.
