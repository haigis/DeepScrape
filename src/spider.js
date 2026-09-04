import fs from 'fs/promises';
import path from 'path';
import { scrapePage, resolveOptions, getBrowser } from './scraper.js';
import { generateOutputDir } from './fileHandler.js';
import { waitMs, shutdownHooks } from './utils.js';

/**
 * Path scoping for a crawl. Three inputs combine:
 *  - pathPrefix       legacy single include folder (kept for back-compat)
 *  - includePaths[]   folders or exact pages to crawl; empty = whole site
 *  - excludePaths[]   folders or exact pages subtracted afterwards
 * A URL is in scope when it matches any include (or there are none) and
 * no exclude. Paths are normalised to a leading slash, no trailing one.
 *
 * @param {{pathPrefix?: string, includePaths?: string[], excludePaths?: string[]}} options
 * @returns {(url: string) => boolean}
 */
/** Memory bounds for the per-crawl link graph (issue coherence#60). */
const MAX_TRACKED_LINKS = Number(process.env.DS_MAX_TRACKED_LINKS) || 150000;
const MAX_SOURCES_PER_LINK = 25;

/** Crawl workers: request → env → default 4, clamped to 1-16. */
export const crawlConcurrency = (options = {}) => Math.max(1, Math.min(16,
    Number(options.concurrency) || Number(process.env.DS_CRAWL_CONCURRENCY) || 4));

export function makeScope(options = {}) {
    const normalise = (p) => '/' + String(p).trim().replace(/^\/+|\/+$/g, '');
    const includes = [options.pathPrefix, ...(options.includePaths ?? [])]
        .filter(Boolean)
        .map(normalise);
    const excludes = (options.excludePaths ?? []).filter(Boolean).map(normalise);
    const under = (pathname, prefix) => pathname === prefix || pathname.startsWith(prefix + '/');

    return (url) => {
        try {
            const { pathname } = new URL(url);
            if (includes.length > 0 && !includes.some(p => under(pathname, p))) return false;
            if (excludes.some(p => under(pathname, p))) return false;
            return true;
        } catch {
            return false;
        }
    };
}

/**
 * Checks if the given URL points to an image or disguised image file.
 * @param {string} url - The URL to check.
 * @returns {boolean} - Returns true if the URL is an image.
 */
const isImageUrl = (url) => {
    return /\.(jpg|jpeg|png|gif|svg|webp|bmp|ico)$/i.test(url) ||
           /(\.(jpg|jpeg|png|gif|svg|webp|bmp|ico)\.html?)$/i.test(url) ||
           /(\?|&)img=/.test(url); // Query strings that reference images
};

/**
 * Documents and binaries a browser cannot render as a page. Navigating
 * Chrome at a PDF can wedge a worker for hours (a prod crawl hung on
 * one), so these never enter the queue; the content-type check on the
 * response stays as the safety net for extensionless binary URLs.
 */
const isBinaryUrl = (url) =>
    /\.(pdf|zip|gz|tgz|tar|rar|7z|doc|docx|xls|xlsx|ppt|pptx|odt|ods|csv|mp3|mp4|m4a|m4v|avi|mov|wmv|webm|mkv|flv|ogg|wav|exe|dmg|msi|apk|iso|woff2?|ttf|eot)(\?|#|$)/i.test(url);

const isUncrawlable = (url) => isImageUrl(url) || isBinaryUrl(url);

/**
 * Query parameters that never change the page served — analytics and
 * click-tracking noise. Kept conservative: anything not listed here is
 * assumed to be meaningful (?page=2, ?q=…).
 */
const TRACKING_PARAMS = /^(utm_\w+|gclid|gclsrc|dclid|fbclid|msclkid|mc_[ce]id|igshid|_hs\w+|vero_\w+|yclid|s_kwcid)$/i;

export const normalizeUrl = (url) => {
    const u = new URL(url);
    u.hash = '';

    // Drop tracking params; sort the rest so ?a=1&b=2 and ?b=2&a=1 match.
    const kept = [...u.searchParams.entries()]
        .filter(([key]) => !TRACKING_PARAMS.test(key))
        .sort(([a], [b]) => a.localeCompare(b));
    u.search = '';
    for (const [key, value] of kept) u.searchParams.append(key, value);

    // Trailing-slash twins (/page vs /page/) are one page; keep the root "/".
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
        u.pathname = u.pathname.replace(/\/+$/, '');
    }

    return u.href;
};

// --- Retries ----------------------------------------------------------------

/** Attempts per URL before it is recorded as broken. */
const pageAttempts = () => Math.max(1, Number(process.env.DS_PAGE_ATTEMPTS) || 3);
/** First retry delay; later ones back off from it. */
const retryBaseMs = () => Math.max(0, Number(process.env.DS_RETRY_BASE_MS ?? 2000) || 0);
/** Responses that mean "not now" rather than "not there". */
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Whether a failed page result deserves another attempt, and how long
 * to wait first. Null means the failure is final: a 404 is a 404, and a
 * cancelled job is not retried.
 * @param {import('./scraper.js').ScrapeResult} result
 * @param {number} attempt - 1-based attempt that just failed.
 * @returns {number|null} delay in ms, or null.
 */
export function retryDelay(result, attempt) {
    if (!result || result.ok || result.error === 'cancelled') return null;
    const base = retryBaseMs();
    // Rate limiting and server errors: wait longer, and longer each time.
    if (RETRY_STATUSES.has(result.status)) return Math.min(base * 5 * attempt, 30000);
    if (result.transient) return base * 2 ** (attempt - 1);
    return null;
}

// --- Queue ------------------------------------------------------------------

/**
 * FIFO with O(1) dequeue. Array.shift() on a 100k-entry queue moves the
 * whole array each time; over a 10k-page crawl that is gigabytes of
 * memmove for nothing.
 */
class UrlQueue {
    constructor(entries = []) {
        this.items = [...entries];
        this.head = 0;
    }
    get length() { return this.items.length - this.head; }
    push(entry) { this.items.push(entry); }
    shift() {
        if (this.head >= this.items.length) return undefined;
        const entry = this.items[this.head];
        this.items[this.head] = undefined;
        this.head++;
        // Compact once the dead prefix outweighs the live tail.
        if (this.head > 1024 && this.head * 2 > this.items.length) {
            this.items = this.items.slice(this.head);
            this.head = 0;
        }
        return entry;
    }
    toArray() { return this.items.slice(this.head); }
    urls() { return this.toArray().map(entry => entry.url); }
}

// --- Checkpoints ------------------------------------------------------------

/**
 * A crawl checkpoints its URL state to the scan folder, so a crawl that
 * dies — scanner redeploy, OOM kill, watchdog abort — can be resumed
 * with `resume: true` instead of starting the whole site again. The
 * link graph goes to an append-only log beside it (one line per page),
 * which is cheap to keep current and is replayed on resume.
 *
 * Both files are removed when the crawl completes: a completed crawl is
 * not resumable, and a fresh scan the same day starts clean.
 */
export const CHECKPOINT_FILE = 'crawl-state.json';
export const LINK_LOG_FILE = 'crawl-links.ndjson';
const CHECKPOINT_VERSION = 1;
const checkpointEveryMs = () => Math.max(1000, Number(process.env.DS_CHECKPOINT_MS) || 30000);

async function readCheckpoint(outDir) {
    try {
        const state = JSON.parse(await fs.readFile(path.join(outDir, CHECKPOINT_FILE), 'utf8'));
        return state?.version === CHECKPOINT_VERSION ? state : null;
    } catch {
        return null;
    }
}

async function writeCheckpoint(outDir, state) {
    const file = path.join(outDir, CHECKPOINT_FILE);
    // Write then rename: a crash mid-write cannot leave a torn file.
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state), 'utf8');
    await fs.rename(tmp, file);
}

async function replayLinkLog(file, record) {
    let raw;
    try {
        raw = await fs.readFile(file, 'utf8');
    } catch {
        return 0;
    }
    let replayed = 0;
    for (const line of raw.split('\n')) {
        if (!line) continue;
        try {
            const { u, l } = JSON.parse(line);
            if (u && Array.isArray(l)) {
                record(u, l);
                replayed++;
            }
        } catch {
            // A torn last line from a crash mid-append — skip it.
        }
    }
    return replayed;
}

/**
 * The folder a crawl writes into. Normally today's `<domain>/<date>`;
 * a caller may pin the date so a scan retried after midnight, or a
 * resumed crawl, lands in the folder it started in. Only the date is
 * accepted — never a path — so a client cannot aim the crawler
 * anywhere else.
 * @param {string} startUrl
 * @param {{scanDate?: string}} options
 * @returns {string}
 */
export function resolveOutDir(startUrl, options = {}) {
    if (options.scanDate) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(options.scanDate)) {
            throw new Error('scanDate must be YYYY-MM-DD');
        }
        return path.join(process.env.OUTPUT_DIR ?? 'output', new URL(startUrl).hostname, options.scanDate);
    }
    return generateOutputDir(startUrl);
}

/**
 * Spider crawl to recursively scrape pages on the same domain.
 *
 * Depth semantics: the start URL is depth 0; maxDepth is the number of
 * link levels followed from it, inclusive (maxDepth 2 crawls depths 0-2).
 *
 * Writes to the scan directory:
 *  - all-links.txt       every unique link discovered (internal + external)
 *  - broken-links.txt    crawled pages that failed (HTTP >= 400 or navigation error)
 *  - incoming-links.json map of URL -> list of pages that link to it
 * and, while running, crawl-state.json + crawl-links.ndjson (see
 * Checkpoints above), removed on completion.
 *
 * @param {string[]} startUrls - Initial URLs to start crawling.
 * @param {Partial<import('./scraper.js').ScrapeOptions> & {
 *   resume?: boolean, scanDate?: string, maxPages?: number,
 *   onProgress?: Function, signal?: AbortSignal, gate?: {wait: Function}, live?: object,
 * }} options - Scrape options.
 * @returns {Promise<{visited: number, broken: number, outDir: string}|undefined>}
 */
export async function spiderCrawl(startUrls, options = {}) {
    const opts = resolveOptions(options);
    const { rateLimit, maxDepth } = opts;
    const { onProgress, signal, gate } = options;

    const baseScope = makeScope(options);
    const pathPrefix = options.pathPrefix ?? null; // logging only

    /**
     * Live inspection channel (options.live, owned by the API): the
     * spider publishes its URL state through live.getState, and honours
     * excludes pushed into live.dynamicExcludes *mid-crawl* — checked
     * both when queueing new links and when dequeuing already-queued
     * ones, so an exclude takes effect immediately.
     */
    const live = options.live ?? null;
    const dynamicallyExcluded = (url) => {
        const excludes = live?.dynamicExcludes;
        if (!excludes || excludes.length === 0) return false;
        return !makeScope({ excludePaths: excludes })(url);
    };
    const inScope = (url) => baseScope(url) && !dynamicallyExcluded(url);

    if (!startUrls || startUrls.length === 0) {
        console.error('❌ Error: spiderCrawl received an empty startUrls array.');
        return;
    }

    const domain = new URL(startUrls[0]).hostname;
    const outDir = resolveOutDir(startUrls[0], options);

    if (!outDir || outDir === 'output/unknown') {
        console.error('❌ Error: Could not determine a valid output directory.');
        return;
    }

    await fs.mkdir(outDir, { recursive: true });

    console.log(`🕷️ Starting spider crawl on: ${startUrls[0]} (maxDepth: ${maxDepth}`
        + `${pathPrefix ? `, scoped to ${pathPrefix}` : ''}`
        + `, workers: ${crawlConcurrency(options)})`);

    /** URLs handed to a worker (fetched, or being fetched). */
    const visited = new Set();
    /** URLs whose fetch finished, in order — what a checkpoint records as done. */
    const visitedList = [];
    /** Every URL ever queued (including visited): the dedupe set. */
    const queued = new Set();
    const queue = new UrlQueue();
    /** URL -> depth for fetches in progress; back on the queue in a checkpoint. */
    const inFlightUrls = new Map();
    /** sha1(html) -> first URL — shared with scrapePage for content dedupe. */
    const contentHashes = new Map();
    /** url -> the already-saved URL it duplicates. */
    const duplicates = new Map();

    const linksList = new Set();
    const brokenLinks = new Set();
    /** Map of URL -> Set of pages that link to it. */
    const incomingLinks = new Map();
    /** URLs dropped mid-crawl by a live exclude. */
    const excludedLive = [];
    let retries = 0;

    /**
     * Bounded link-graph tracking (issue coherence#60): large sites ×
     * links-per-page × concurrent crawls otherwise grows these maps past
     * the Node heap. Caps keep the analytics useful while bounding
     * memory; crawling itself (queued/visited) is unaffected.
     */
    const recordLinks = (from, links) => {
        for (const link of links) {
            if (linksList.size < MAX_TRACKED_LINKS) linksList.add(link);
            let sources = incomingLinks.get(link);
            if (!sources && incomingLinks.size < MAX_TRACKED_LINKS) {
                sources = new Set();
                incomingLinks.set(link, sources);
            }
            if (sources && sources.size < MAX_SOURCES_PER_LINK) sources.add(from);
        }
    };

    const linkLogFile = path.join(outDir, LINK_LOG_FILE);
    let resumed = null;
    if (options.resume) {
        const state = await readCheckpoint(outDir);
        if (state) {
            for (const url of state.visited ?? []) {
                visited.add(url);
                visitedList.push(url);
                queued.add(url);
            }
            for (const entry of state.queue ?? []) {
                if (entry?.url && !queued.has(entry.url)) {
                    queued.add(entry.url);
                    queue.push({ url: entry.url, depth: Number(entry.depth) || 0 });
                }
            }
            for (const url of state.broken ?? []) brokenLinks.add(url);
            for (const [url, original] of Object.entries(state.duplicates ?? {})) duplicates.set(url, original);
            for (const [hash, url] of Object.entries(state.hashes ?? {})) contentHashes.set(hash, url);
            excludedLive.push(...(state.excluded ?? []));
            retries = Number(state.retries) || 0;
            const replayed = await replayLinkLog(linkLogFile, recordLinks);
            resumed = { visited: visited.size, queued: queue.length, savedAt: state.savedAt };
            console.log(`⏯ Resuming crawl from checkpoint saved ${state.savedAt}: `
                + `${visited.size} pages done, ${queue.length} queued, link graph replayed for ${replayed} pages`);
        } else {
            console.log('ℹ️ Resume requested but no checkpoint found — starting fresh.');
        }
    } else {
        // A fresh crawl into a folder holding a dead crawl's log must not
        // inherit its lines.
        await fs.rm(linkLogFile, { force: true }).catch(() => {});
    }

    for (const url of startUrls) {
        let normalized;
        try {
            normalized = normalizeUrl(url);
        } catch {
            continue;
        }
        if (!queued.has(normalized)) {
            queued.add(normalized);
            queue.push({ url: normalized, depth: 0 });
        }
    }

    if (live) {
        live.getState = () => ({
            visited: visitedList,
            queued: queue.urls(),
            excluded: excludedLive,
        });
    }

    // Fail fast with a clear error if Chrome cannot start at all, rather
    // than one tab failure per page.
    await getBrowser();

    /**
     * Hard ceiling on pages fetched. Callers billing by page size need a
     * limit the crawler itself enforces — a plan cap that only lives in
     * the calling app is not a cap at all.
     */
    const maxPages = Number(options.maxPages) > 0 ? Number(options.maxPages) : null;
    let limitReached = false;

    // --- Checkpointing ------------------------------------------------------
    const snapshot = () => ({
        version: CHECKPOINT_VERSION,
        savedAt: new Date().toISOString(),
        startUrl: startUrls[0],
        visited: visitedList,
        // Pages mid-fetch when this was taken were not saved; they go
        // back on the queue so a resume fetches them.
        queue: [...[...inFlightUrls].map(([url, depth]) => ({ url, depth })), ...queue.toArray()],
        broken: [...brokenLinks],
        duplicates: Object.fromEntries(duplicates),
        hashes: Object.fromEntries(contentHashes),
        excluded: excludedLive,
        retries,
    });
    let dirty = false;
    let writing = null;
    const checkpoint = (why) => {
        if (writing) return writing;
        const state = snapshot();
        dirty = false;
        writing = writeCheckpoint(outDir, state)
            .catch(err => console.warn(`⚠️ Checkpoint (${why}) failed: ${err.message}`))
            .finally(() => { writing = null; });
        return writing;
    };
    const ticker = setInterval(() => { if (dirty) void checkpoint('periodic'); }, checkpointEveryMs());
    ticker.unref?.();
    const flushOnShutdown = () => checkpoint('shutdown');
    shutdownHooks.add(flushOnShutdown);

    // Link log appends are serialised so lines never interleave.
    let linkLog = Promise.resolve();
    const logLinks = (url, links) => {
        linkLog = linkLog
            .then(() => fs.appendFile(linkLogFile, JSON.stringify({ u: url, l: links }) + '\n', 'utf8'))
            .catch(err => console.warn(`⚠️ Link log append failed: ${err.message}`));
    };

    const progress = (currentUrl) => onProgress?.({
        done: visited.size,
        total: visited.size + queue.length,
        currentUrl,
        retries,
        resumed: Boolean(resumed),
    });

    /**
     * Concurrent workers over one shared queue. Each scrapePage opens
     * its own tab in the shared browser, so N workers ≈ N× throughput.
     * Single-threaded JS keeps the queue/visited bookkeeping safe; the
     * page cap can overshoot by at most workers−1 pages. Rate limit is
     * per worker — the polite delay a real visitor produces per tab.
     */
    const concurrency = crawlConcurrency(options);
    let inFlight = 0;

    async function worker() {
        for (;;) {
            if (signal?.aborted) return;
            // Park here when a priority job needs the runner — the crawl
            // resumes from this exact point, losing no work.
            await gate?.wait();
            if (maxPages && visited.size >= maxPages) {
                if (!limitReached) console.log(`🛑 Page limit reached (${maxPages}) — stopping crawl.`);
                limitReached = true;
                return;
            }

            const entry = queue.shift();
            if (!entry) {
                // Empty queue: done only once no worker can still enqueue.
                if (inFlight === 0) return;
                await waitMs(50);
                continue;
            }
            const { url, depth } = entry;
            if (visited.has(url) || isUncrawlable(url)) continue;
            // A live exclude may have arrived after this URL was queued.
            if (dynamicallyExcluded(url)) {
                excludedLive.push(url);
                dirty = true;
                continue;
            }

            visited.add(url);
            console.log(`🔍 Crawling: ${url} (Depth: ${depth})`);
            progress(url);

            // Momentary failures — a recycled browser, a dropped
            // connection, a 503 — get another go after a pause. A real
            // failure (404, non-HTML) is final on the first attempt.
            let result;
            inFlightUrls.set(url, depth);
            for (let attempt = 1; ; attempt++) {
                inFlight++;
                try {
                    result = await scrapePage(null, url, outDir, { ...opts, dedupe: contentHashes, signal });
                } finally {
                    inFlight--;
                }
                const delay = attempt < pageAttempts() && !signal?.aborted ? retryDelay(result, attempt) : null;
                if (delay === null) break;
                retries++;
                console.warn(`↻ Retrying ${url} (attempt ${attempt + 1}/${pageAttempts()}) in ${delay}ms — ${result.error}`);
                await waitMs(delay);
            }
            inFlightUrls.delete(url);

            // A crawl stopped mid-page did not fail the page: leave it
            // for the resume rather than recording it as done or broken.
            if (!result.ok && result.error === 'cancelled') {
                visited.delete(url);
                queue.push({ url, depth });
                dirty = true;
                return;
            }

            visitedList.push(url);
            dirty = true;

            if (!result.ok) {
                // Navigation error or HTTP >= 400 — record and move on.
                // Non-HTML content types are skipped but not "broken".
                if (!result.error?.startsWith('non-HTML')) {
                    console.error(`❌ Broken link: ${url} (${result.error})`);
                    brokenLinks.add(url);
                }
                continue;
            }

            if (result.duplicateOf) {
                duplicates.set(url, result.duplicateOf);
            }

            const links = [];
            for (const rawLink of result.links) {
                try {
                    const link = normalizeUrl(rawLink);
                    if (link !== url) links.push(link);
                } catch {
                    // Ignore invalid URLs
                }
            }
            recordLinks(url, links);
            logLinks(url, links);

            for (const link of links) {
                if (isUncrawlable(link) || queued.has(link)) continue;

                if (new URL(link).hostname === domain && inScope(link) && depth < maxDepth) {
                    queued.add(link);
                    queue.push({ url: link, depth: depth + 1 });
                }
            }

            if (rateLimit > 0) await waitMs(rateLimit);
        }
    }

    try {
        await Promise.all(Array.from({ length: concurrency }, () => worker()));
    } finally {
        clearInterval(ticker);
        shutdownHooks.delete(flushOnShutdown);
    }
    await writing;
    await linkLog;

    const aborted = signal?.aborted ?? false;
    if (aborted) {
        console.log('⏹ Aborted — stopping crawl.');
        // Whatever stopped this (cancel, watchdog, shutdown) may want to
        // pick it up again; leave the state where a resume finds it.
        await checkpoint('abort');
    }

    console.log(`✅ Spider crawl ${aborted ? 'stopped' : 'completed'}. Visited ${visitedList.length} pages, `
        + `${brokenLinks.size} broken, ${retries} retries.`);

    const incomingAsObject = Object.fromEntries(
        [...incomingLinks.entries()].map(([link, sources]) => [link, [...sources]]));

    await fs.writeFile(path.join(outDir, 'all-links.txt'), [...linksList].join('\n'), 'utf8');
    await fs.writeFile(path.join(outDir, 'broken-links.txt'), [...brokenLinks].join('\n'), 'utf8');
    await fs.writeFile(path.join(outDir, 'incoming-links.json'), JSON.stringify(incomingAsObject, null, 2), 'utf8');
    // URL -> canonical URL it duplicated; duplicate-content evidence for
    // the consistency engine, and proof of what was skipped and why.
    await fs.writeFile(
        path.join(outDir, 'duplicate-pages.json'),
        JSON.stringify(Object.fromEntries(duplicates), null, 2),
        'utf8',
    );

    if (!aborted) {
        // Done: nothing to resume, and the next scan today starts clean.
        await fs.rm(path.join(outDir, CHECKPOINT_FILE), { force: true }).catch(() => {});
        await fs.rm(linkLogFile, { force: true }).catch(() => {});
    }

    // Release the crawl's URL structures from the live inspector: swap
    // the getState closure (which pins visited/queue/excludes) for a
    // small frozen snapshot, so finished crawls can be garbage
    // collected while the queue UI keeps a useful summary.
    if (live) {
        const frozen = {
            visited: visitedList.slice(0, 5000),
            queued: [],
            excluded: excludedLive.slice(0, 1000),
        };
        live.getState = () => frozen;
    }

    console.log(`📁 Saved crawl results to: ${outDir}`);
    return {
        visited: visitedList.length,
        saved: visitedList.length - duplicates.size - brokenLinks.size,
        duplicates: duplicates.size,
        broken: brokenLinks.size,
        retries,
        resumed: Boolean(resumed),
        outDir,
        aborted,
        limitReached,
        maxPages,
    };
}
