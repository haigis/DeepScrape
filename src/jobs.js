import crypto from 'crypto';
import { closeBrowser } from './scraper.js';

/**
 * In-memory job queue with configurable concurrency. Multiple jobs can
 * run in parallel (each uses its own browser page within the shared
 * Puppeteer instance). Priority jobs (single-page re-scans) still
 * preempt long-running crawls via the pause gate.
 *
 * @typedef {object} Job
 * @property {string} id
 * @property {string} type            scrape | sitemap | spider | batch
 * @property {object} params          Job parameters; editable while queued.
 * @property {'queued'|'running'|'paused'|'completed'|'failed'|'cancelled'} status
 * @property {string} createdAt
 * @property {string} [startedAt]
 * @property {string} [finishedAt]
 * @property {object|null} progress   e.g. { done, total, currentUrl }
 * @property {object|null} result     Runner return value on completion.
 * @property {string|null} error      Error message on failure.
 */

/** Max concurrent non-priority jobs. Read per-call so tests can pin it. */
const maxConcurrent = () => Math.max(1, parseInt(process.env.MAX_CONCURRENT_JOBS ?? '3', 10) || 1);

/**
 * Watchdog: no job may run longer than this, whatever it is doing.
 * Per-page deadlines make a hung page cost minutes, not hours, but the
 * ceiling is what guarantees the queue always drains. 0 disables.
 */
const jobTimeoutMs = () =>
    Math.max(0, parseInt(process.env.DS_JOB_TIMEOUT_MINUTES ?? '240', 10) || 0) * 60_000;

const jobs = new Map();
/** @type {{job: Job, runner: Function}[]} */
const queue = [];
/** Currently running non-priority job count. */
let runningCount = 0;
/** AbortControllers keyed by job id for all running jobs. */
const aborts = new Map();
/** Set of currently running non-priority job ids (for preemption). */
const runningNonPriority = new Set();

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
        createdAt: new Date().toISOString(),
        progress: null,
        result: null,
        error: null,
    };
    jobs.set(job.id, job);

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
    job.startedAt = new Date().toISOString();
    console.log(`▶️ Job ${job.id} (${job.type}) started${isPriority ? ' (priority)' : ''} [${runningCount} running]`);

    let timedOut = false;
    const watchdogMs = jobTimeoutMs();
    const watchdog = watchdogMs > 0
        ? setTimeout(() => {
            timedOut = true;
            console.error(`⏱ Job ${job.id} exceeded ${watchdogMs / 60000} minutes — aborting.`);
            abort.abort();
        }, watchdogMs)
        : null;

    const settle = () => {
        if (timedOut) {
            job.status = 'failed';
            job.error = `job timed out after ${watchdogMs / 60000} minutes`;
            console.error(`❌ Job ${job.id} failed: ${job.error}`);
        } else if (abort.signal.aborted) {
            job.status = 'cancelled';
            console.log(`⏹ Job ${job.id} stopped by user`);
        }
    };

    try {
        const gate = isPriority ? null : pauseGate;
        job.result = await runner(progress => { job.progress = progress; }, job.params, abort.signal, gate);
        if (abort.signal.aborted) {
            settle();
        } else {
            job.status = 'completed';
            console.log(`✅ Job ${job.id} completed`);
        }
    } catch (err) {
        if (abort.signal.aborted) {
            settle();
        } else {
            job.status = 'failed';
            job.error = err.message;
            console.error(`❌ Job ${job.id} failed: ${err.message}`);
        }
    } finally {
        if (watchdog) clearTimeout(watchdog);
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
