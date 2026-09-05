import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { closeBrowser } from './scraper.js';
import { runShutdownHooks } from './utils.js';

/**
 * In-memory job queue with configurable concurrency. Multiple jobs can
 * run in parallel (each uses its own browser page within the shared
 * Puppeteer instance). Priority jobs (single-page re-scans) still
 * preempt long-running crawls via the pause gate.
 *
 * @typedef {object} Job
 * @property {string} id
 * @property {string} type            scrape | sitemap | spider | full | batch
 * @property {object} params          Job parameters; editable while queued.
 * @property {'queued'|'running'|'paused'|'interrupted'|'completed'|'failed'|'cancelled'} status
 * @property {number} attempts        Runs so far, counting the first (resumes add one).
 * @property {string} createdAt
 * @property {string} [startedAt]
 * @property {string} [finishedAt]
 * @property {object|null} progress   e.g. { done, total, currentUrl }
 * @property {number} [progressAt]    Epoch ms of the last progress report (stall watchdog).
 * @property {object|null} result     Runner return value on completion.
 * @property {string|null} error      Error message on failure.
 * @property {boolean} [retryable]    The failure was the scanner's, not the site's — a re-run may succeed.
 */

/** Max concurrent non-priority jobs. Read per-call so tests can pin it. */
const maxConcurrent = () => Math.max(1, parseInt(process.env.MAX_CONCURRENT_JOBS ?? '3', 10) || 1);

/**
 * Watchdog: no job may run longer than this, whatever it is doing. The
 * stall watchdog below catches a wedged crawl within minutes; this is
 * the outer wall for a crawl that keeps moving but never ends. Sized
 * for 10k+ page sites on a gentle preset. 0 disables.
 */
const jobTimeoutMs = () =>
    Math.max(0, parseInt(process.env.DS_JOB_TIMEOUT_MINUTES ?? '720', 10) || 0) * 60_000;

/**
 * Stall watchdog: a running job that reports no progress for this long
 * is aborted and marked failed-but-retryable. A healthy crawl reports
 * progress every page; silence this long means a wedged browser or a
 * hung fetch that the per-page deadline somehow did not catch. Paused
 * jobs are not stalled. 0 disables. DS_JOB_STALL_MS overrides (tests).
 */
const jobStallMs = () => {
    if (process.env.DS_JOB_STALL_MS !== undefined) return Math.max(0, Number(process.env.DS_JOB_STALL_MS) || 0);
    return Math.max(0, parseInt(process.env.DS_JOB_STALL_MINUTES ?? '30', 10) || 0) * 60_000;
};
const watchdogTickMs = () => Math.max(20, Number(process.env.DS_WATCHDOG_TICK_MS) || 30_000);

/** Runs a job may have in total across restarts before it is given up on. */
const maxAttempts = () => Math.max(1, parseInt(process.env.DS_JOB_MAX_ATTEMPTS ?? '3', 10) || 1);

const jobs = new Map();
/** @type {{job: Job, runner: Function}[]} */
const queue = [];
/** Currently running non-priority job count. */
let runningCount = 0;
/** AbortControllers keyed by job id for all running jobs. */
const aborts = new Map();
/** Set of currently running non-priority job ids (for preemption). */
const runningNonPriority = new Set();

/**
 * Job records survive a restart.
 *
 * A runner is a live function, so the queue itself cannot be persisted.
 * What can is the record: id, params, progress. At startup anything that
 * was queued or running is marked `interrupted`, and the API decides what
 * to do with each one (see resumeInterrupted): crawls are put back on the
 * queue under the same id, where their checkpoint lets them carry on, so
 * a poller that was following the job sees it go queued → running →
 * completed as if nothing happened. Job types that cannot resume are
 * marked failed with a reason, which is still far better than the 404
 * the poller used to get.
 *
 * Written inside the scan output folder — the one path that is certainly
 * a persistent volume in every deployment; a sibling of it may be
 * container-local and vanish on redeploy, taking the records with it.
 * Test runs never persist (VITEST): they must not read or leave state.
 */
const STATE_FILE = path.join(
    process.env.DS_STATE_DIR || process.env.OUTPUT_DIR || 'output',
    'jobs.json',
);
const PERSIST = !process.env.VITEST;

let dirty = false;
/** Mark the store changed; the flusher writes it out shortly after. */
const touch = () => { dirty = true; };

function persistNow() {
    if (!dirty || !PERSIST) return;
    dirty = false;
    try {
        fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
        // Write then rename, so a crash mid-write cannot leave a truncated
        // file that fails to parse on the next boot.
        const tmp = `${STATE_FILE}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify([...jobs.values()]));
        fs.renameSync(tmp, STATE_FILE);
    } catch (err) {
        console.warn(`⚠️ Could not persist job state: ${err.message}`);
    }
}

/**
 * Loads saved job records. Anything that was live when the previous
 * process died becomes `interrupted`, awaiting resumeInterrupted().
 * Exported so tests can feed records in without a file.
 * @param {Job[]} saved
 * @returns {{restored: number, interrupted: number}}
 */
export function restoreFrom(saved) {
    if (!Array.isArray(saved)) return { restored: 0, interrupted: 0 };
    let interrupted = 0;
    for (const job of saved) {
        if (!job?.id) continue;
        job.attempts = Number(job.attempts) || 1;
        if (['queued', 'running', 'paused'].includes(job.status)) {
            job.status = 'interrupted';
            job.interruptedAt = new Date().toISOString();
            interrupted++;
        }
        jobs.set(job.id, job);
    }
    touch();
    if (interrupted) {
        console.warn(`⚠️ ${interrupted} job(s) were live when the scanner last stopped`);
    }
    return { restored: saved.length, interrupted };
}

function restoreJobs() {
    if (!PERSIST) return;
    let saved;
    try {
        saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch {
        return; // No state, or unreadable — start clean rather than crash.
    }
    restoreFrom(saved);
}

const RESTART_MESSAGE =
    'The scanner restarted while this scan was running, so it was stopped. Nothing is wrong with the site — start it again.';

/**
 * Decides the fate of every interrupted job. The resolver returns
 * `{runner, params?}` for a job it can re-create (the API knows how to
 * build a spider or full-scan runner from the saved params), or null.
 * Resumable jobs go back on the queue under their own id with the
 * attempt count bumped; the rest are failed with a plain explanation.
 * A job that has already been through the restart limit is failed too —
 * a crawl that takes the scanner down every time must not loop forever.
 *
 * @param {(job: Job) => ({runner: Function, params?: object}|null)} resolve
 * @returns {{resumed: string[], failed: string[]}}
 */
export function resumeInterrupted(resolve) {
    const summary = { resumed: [], failed: [] };
    for (const job of jobs.values()) {
        if (job.status !== 'interrupted') continue;
        const exhausted = job.attempts >= maxAttempts();
        let plan = null;
        if (!exhausted) {
            try {
                plan = resolve(job);
            } catch (err) {
                console.warn(`⚠️ Could not rebuild job ${job.id}: ${err.message}`);
            }
        }
        if (plan?.runner) {
            requeueJob(job.id, plan.runner, plan.params);
            summary.resumed.push(job.id);
            console.log(`⏯ Job ${job.id} (${job.type}) re-queued after restart — attempt ${job.attempts}`);
        } else {
            job.status = 'failed';
            job.retryable = !exhausted;
            job.error = exhausted
                ? `The scanner was restarted ${job.attempts} times during this scan, so it was stopped. Start it again.`
                : RESTART_MESSAGE;
            job.finishedAt = job.finishedAt ?? new Date().toISOString();
            summary.failed.push(job.id);
        }
    }
    touch();
    return summary;
}

/**
 * Puts a finished job back on the queue with a fresh runner — the
 * mechanism behind resume-after-restart. Same id, so pollers keep
 * following it; progress is kept so the UI does not flash to zero.
 * @param {string} id
 * @param {Function} runner
 * @param {object} [paramsPatch] - merged into the job's params (e.g. resume: true).
 */
export function requeueJob(id, runner, paramsPatch = {}) {
    const job = jobs.get(id);
    if (!job) return { ok: false, error: 'Job not found' };
    if (!['interrupted', 'failed', 'cancelled'].includes(job.status)) {
        return { ok: false, error: `Job is ${job.status}` };
    }
    job.status = 'queued';
    job.attempts = (Number(job.attempts) || 1) + 1;
    job.params = { ...job.params, ...paramsPatch };
    job.error = null;
    job.result = null;
    job.retryable = undefined;
    job.resumedAt = new Date().toISOString();
    delete job.finishedAt;
    queue.push({ job, runner });
    touch();
    void pump();
    return { ok: true, job };
}

/** Cap on finished jobs kept in memory. */
const MAX_JOBS_KEPT = 200;

function trimOldJobs() {
    const finished = [...jobs.values()]
        .filter(j => ['completed', 'failed', 'cancelled'].includes(j.status));
    if (finished.length <= MAX_JOBS_KEPT) return;
    finished
        .sort((a, b) => (a.finishedAt ?? '').localeCompare(b.finishedAt ?? ''))
        .slice(0, finished.length - MAX_JOBS_KEPT)
        .forEach(j => jobs.delete(j.id));
    touch();
}

/**
 * Creates a job and schedules it.
 * @param {string} type
 * @param {object} params
 * @param {(onProgress: (p: object) => void, params: object, signal: AbortSignal) => Promise<object>} runner
 * @param {{priority?: boolean}} [opts]
 * @returns {Job}
 */
export function createJob(type, params, runner, opts = {}) {
    const job = {
        id: crypto.randomUUID(),
        type,
        params,
        status: 'queued',
        priority: !!opts.priority,
        attempts: 1,
        createdAt: new Date().toISOString(),
        progress: null,
        result: null,
        error: null,
    };
    jobs.set(job.id, job);
    touch();

    if (opts.priority) {
        const firstNormal = queue.findIndex(q => !q.job.priority);
        queue.splice(firstNormal === -1 ? queue.length : firstNormal, 0, { job, runner });
    } else {
        queue.push({ job, runner });
    }

    void pump();
    trimOldJobs();
    return job;
}

/**
 * Preemption gate. Long crawls await this between pages so priority
 * jobs can park them and run immediately.
 */
const pauseGate = {
    depth: 0,
    async wait() {
        while (this.depth > 0) {
            await new Promise(resolve => setTimeout(resolve, 150));
        }
    },
    get paused() {
        return this.depth > 0;
    },
};

/** Non-priority jobs currently paused for priority work. */
const pausedJobs = new Set();

async function pump() {
    // Try to start as many queued jobs as concurrency allows.
    while (queue.length > 0) {
        const next = queue[0];

        if (next.job.priority) {
            // Priority jobs always run immediately — park non-priority jobs.
            if (runningNonPriority.size > 0 && pausedJobs.size === 0) {
                pauseGate.depth++;
                for (const id of runningNonPriority) {
                    const job = jobs.get(id);
                    if (job && job.status === 'running') {
                        job.status = 'paused';
                        touch();
                        pausedJobs.add(id);
                        console.log(`⏸ Job ${id} paused for priority work`);
                    }
                }
            }
            queue.shift();
            void runJob(next.job, next.runner, true);
        } else {
            // Non-priority: respect concurrency limit.
            if (runningCount >= maxConcurrent()) break;
            queue.shift();
            void runJob(next.job, next.runner, false);
        }
    }

    // If nothing is running at all, release the shared browser.
    if (runningCount === 0 && aborts.size === 0 && queue.length === 0) {
        await closeBrowser();
    }
}

async function runJob(job, runner, isPriority) {
    const abort = new AbortController();
    aborts.set(job.id, abort);
    if (!isPriority) {
        runningCount++;
        runningNonPriority.add(job.id);
    }
    job.status = 'running';
    job.startedAt = job.startedAt ?? new Date().toISOString();
    job.progressAt = Date.now();
    touch();
    console.log(`▶️ Job ${job.id} (${job.type}) started${isPriority ? ' (priority)' : ''}`
        + `${job.attempts > 1 ? ` (attempt ${job.attempts})` : ''} [${runningCount} running]`);

    let timedOut = false;
    let stalled = false;
    const watchdogMs = jobTimeoutMs();
    const watchdog = watchdogMs > 0
        ? setTimeout(() => {
            timedOut = true;
            console.error(`⏱ Job ${job.id} exceeded ${watchdogMs / 60000} minutes — aborting.`);
            abort.abort();
        }, watchdogMs)
        : null;

    const stallMs = jobStallMs();
    const stallTimer = stallMs > 0
        ? setInterval(() => {
            // A paused crawl is waiting on us, not on the site.
            if (job.status !== 'running') {
                job.progressAt = Date.now();
                return;
            }
            if (Date.now() - job.progressAt > stallMs) {
                stalled = true;
                console.error(`⏱ Job ${job.id} reported no progress for ${Math.round(stallMs / 1000)}s — aborting so it can be retried.`);
                abort.abort();
                clearInterval(stallTimer);
            }
        }, watchdogTickMs())
        : null;
    stallTimer?.unref?.();

    const settle = () => {
        if (timedOut) {
            job.status = 'failed';
            job.retryable = true;
            job.error = `job timed out after ${watchdogMs / 60000} minutes`;
            console.error(`❌ Job ${job.id} failed: ${job.error}`);
        } else if (stalled) {
            job.status = 'failed';
            job.retryable = true;
            job.error = `no progress for ${Math.round(stallMs / 60000)} minutes — the scan was stopped so it can be resumed`;
            console.error(`❌ Job ${job.id} failed: ${job.error}`);
        } else if (abort.signal.aborted) {
            job.status = 'cancelled';
            console.log(`⏹ Job ${job.id} stopped by user`);
        }
        touch();
    };

    try {
        const gate = isPriority ? null : pauseGate;
        const onProgress = progress => {
            job.progress = progress;
            job.progressAt = Date.now();
            touch();
        };
        job.result = await runner(onProgress, job.params, abort.signal, gate);
        if (abort.signal.aborted) {
            settle();
        } else {
            job.status = 'completed';
            touch();
            console.log(`✅ Job ${job.id} completed`);
        }
    } catch (err) {
        if (abort.signal.aborted) {
            settle();
        } else {
            job.status = 'failed';
            job.error = err.message;
            touch();
            console.error(`❌ Job ${job.id} failed: ${err.message}`);
        }
    } finally {
        if (watchdog) clearTimeout(watchdog);
        if (stallTimer) clearInterval(stallTimer);
        job.finishedAt = new Date().toISOString();
        aborts.delete(job.id);

        if (!isPriority) {
            runningCount--;
            runningNonPriority.delete(job.id);
        }

        // Resume paused crawls once no priority work remains.
        if (isPriority && !queue.some(e => e.job.priority)) {
            pauseGate.depth = Math.max(0, pauseGate.depth - 1);
            for (const id of pausedJobs) {
                const j = jobs.get(id);
                if (j && j.status === 'paused') {
                    j.status = 'running';
                    j.progressAt = Date.now();
                    touch();
                    console.log(`▶️ Job ${id} resumed`);
                }
            }
            pausedJobs.clear();
        }

        void pump();
    }
}

/**
 * Cancels a job.
 * @param {string} id
 * @returns {{ok: boolean, error?: string}}
 */
export function cancelJob(id) {
    const job = jobs.get(id);
    if (!job) return { ok: false, error: 'Job not found' };

    if (job.status === 'queued') {
        const idx = queue.findIndex(q => q.job.id === id);
        if (idx !== -1) queue.splice(idx, 1);
        job.status = 'cancelled';
        job.finishedAt = new Date().toISOString();
        touch();
        return { ok: true };
    }
    if (job.status === 'running' || job.status === 'paused') {
        aborts.get(id)?.abort();
        // Release pause gate if this was a paused job.
        if (job.status === 'paused') {
            pausedJobs.delete(id);
            if (pausedJobs.size === 0) {
                pauseGate.depth = Math.max(0, pauseGate.depth - 1);
            }
        }
        return { ok: true };
    }
    return { ok: false, error: `Job is already ${job.status}` };
}

/**
 * Moves a queued job to a new position (0 = next).
 */
export function moveJob(id, position) {
    const idx = queue.findIndex(q => q.job.id === id);
    if (idx === -1) return { ok: false, error: 'Job is not queued' };
    if (!Number.isInteger(position) || position < 0) {
        return { ok: false, error: 'position must be a non-negative integer' };
    }
    const [entry] = queue.splice(idx, 1);
    queue.splice(Math.min(position, queue.length), 0, entry);
    return { ok: true };
}

/**
 * Edits the params of a queued job.
 */
export function updateJob(id, patch) {
    const job = jobs.get(id);
    if (!job) return { ok: false, error: 'Job not found' };
    if (job.status !== 'queued') {
        return { ok: false, error: `Only queued jobs can be edited (job is ${job.status})` };
    }
    job.params = { ...job.params, ...patch };
    touch();
    return { ok: true, job };
}

/**
 * @param {string} id
 * @returns {number|null}
 */
export function getQueuePosition(id) {
    const idx = queue.findIndex(q => q.job.id === id);
    return idx === -1 ? null : idx;
}

/**
 * @param {string} id
 * @returns {(Job & {queuePosition: number|null})|undefined}
 */
export function getJob(id) {
    const job = jobs.get(id);
    return job ? { ...job, queuePosition: getQueuePosition(id) } : undefined;
}

/**
 * @param {number} limit
 * @returns {(Job & {queuePosition: number|null})[]}
 */
export function listJobs(limit = 50) {
    const positions = new Map(queue.map((q, i) => [q.job.id, i]));
    return [...jobs.values()]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit)
        .map(job => ({ ...job, queuePosition: positions.get(job.id) ?? null }));
}

/** Counts for /health. */
export function queueStats() {
    let running = 0;
    let paused = 0;
    for (const job of jobs.values()) {
        if (job.status === 'running') running++;
        else if (job.status === 'paused') paused++;
    }
    return { running, paused, queued: queue.length, known: jobs.size };
}

// Restore before anything can ask for a job, then flush changes on a
// short timer rather than on every mutation — a busy crawl updates
// progress constantly and does not need a write each time.
restoreJobs();
if (PERSIST) {
    const flusher = setInterval(persistNow, 2000);
    flusher.unref?.();
    // On a stop signal, let running crawls checkpoint first (bounded),
    // then write the job records and exit. The next boot re-queues them.
    for (const signal of ['SIGTERM', 'SIGINT']) {
        process.once(signal, () => {
            console.log(`${signal} received — checkpointing running crawls before exit`);
            runShutdownHooks(5000)
                .catch(() => {})
                .finally(() => {
                    persistNow();
                    process.exit(0);
                });
        });
    }
}
