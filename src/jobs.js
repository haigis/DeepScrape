import crypto from 'crypto';
import { closeBrowser } from './scraper.js';

/**
 * In-memory job queue. Jobs run sequentially (one Puppeteer workload at
 * a time); each POST /scrape* endpoint returns a job id immediately and
 * clients poll GET /jobs/:id for status.
 *
 * Queue management: queued jobs can be cancelled, reordered and have
 * their params edited (runners read job.params at start time). Running
 * jobs can be stopped via an AbortSignal that the scrapers check
 * between pages.
 *
 * @typedef {object} Job
 * @property {string} id
 * @property {string} type            scrape | sitemap | spider | batch
 * @property {object} params          Job parameters; editable while queued.
 * @property {'queued'|'running'|'completed'|'failed'|'cancelled'} status
 * @property {string} createdAt
 * @property {string} [startedAt]
 * @property {string} [finishedAt]
 * @property {object|null} progress   e.g. { done, total, currentUrl }
 * @property {object|null} result     Runner return value on completion.
 * @property {string|null} error      Error message on failure.
 */

const jobs = new Map();
/** @type {{job: Job, runner: Function}[]} */
const queue = [];
let running = false;
/** AbortController of the currently running job, keyed by job id. */
let runningAbort = null;
let runningJobId = null;
let runningJob = null;
/** AbortControllers for priority jobs running alongside a parked crawl. */
const priorityAborts = new Map();

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
 * Creates a job and schedules it. The runner is called as
 * runner(onProgress, params, signal) when the job starts, so edits to
 * job.params while queued take effect.
 * @param {string} type
 * @param {object} params
 * @param {(onProgress: (p: object) => void, params: object, signal: AbortSignal) => Promise<object>} runner
 * @param {{priority?: boolean}} [opts] - priority jobs jump the queue
 *        (used by single-page re-scans, which are quick).
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
        // Ahead of normal jobs, but behind priority jobs already waiting.
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
 * Preemption gate. A long crawl awaits this between pages, so a
 * priority job (an interactive single-page re-scan) can park it and run
 * immediately instead of waiting hours for the crawl to finish. The
 * crawl resumes from exactly where it stopped — no work is lost.
 */
const pauseGate = {
    depth: 0,
    /** Awaited by runners at each page boundary. */
    async wait() {
        while (this.depth > 0) {
            await new Promise(resolve => setTimeout(resolve, 150));
        }
    },
    get paused() {
        return this.depth > 0;
    },
};

/** The non-priority job currently parked, if any. */
let preemptedJob = null;

async function pump() {
    const next = queue[0];
    if (!next) {
        if (running) return;
        // Queue drained — release the shared browser.
        await closeBrowser();
        return;
    }

    // A priority job may run while a long non-priority job is parked.
    // Note this covers *successive* priority jobs too: once the crawl is
    // parked, each queued priority job runs in turn before it resumes.
    const isPriorityRun =
        running && next.job.priority && runningJob != null && !runningJob.priority;

    if (running && !isPriorityRun) return;

    // Park the crawl on the first priority job only.
    if (isPriorityRun && !preemptedJob) {
        preemptedJob = runningJob;
        pauseGate.depth++;
        preemptedJob.status = 'paused';
        console.log(`⏸ Job ${preemptedJob.id} paused for priority work`);
    }

    queue.shift();
    const { job, runner } = next;
    const wasPreempting = isPriorityRun;

    if (!wasPreempting) running = true;
    const abort = new AbortController();
    if (!wasPreempting) {
        runningAbort = abort;
        runningJobId = job.id;
        runningJob = job;
    } else {
        priorityAborts.set(job.id, abort);
    }
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    console.log(`▶️ Job ${job.id} (${job.type}) started${wasPreempting ? ' (preempting)' : ''}`);

    try {
        // Priority jobs never park themselves — only long jobs yield.
        const gate = job.priority ? null : pauseGate;
        job.result = await runner(progress => { job.progress = progress; }, job.params, abort.signal, gate);
        if (abort.signal.aborted) {
            job.status = 'cancelled';
            console.log(`⏹ Job ${job.id} stopped by user`);
        } else {
            job.status = 'completed';
            console.log(`✅ Job ${job.id} completed`);
        }
    } catch (err) {
        if (abort.signal.aborted) {
            job.status = 'cancelled';
            console.log(`⏹ Job ${job.id} stopped by user`);
        } else {
            job.status = 'failed';
            job.error = err.message;
            console.error(`❌ Job ${job.id} failed: ${err.message}`);
        }
    } finally {
        job.finishedAt = new Date().toISOString();

        if (wasPreempting) {
            priorityAborts.delete(job.id);
            // Resume the parked crawl once no priority work remains.
            if (!queue.some(entry => entry.job.priority)) {
                pauseGate.depth = Math.max(0, pauseGate.depth - 1);
                if (preemptedJob && preemptedJob.status === 'paused') {
                    preemptedJob.status = 'running';
                    console.log(`▶️ Job ${preemptedJob.id} resumed`);
                }
                preemptedJob = null;
            }
        } else {
            running = false;
            runningAbort = null;
            runningJobId = null;
            runningJob = null;
        }
        void pump();
    }
}

/**
 * Cancels a job. Queued jobs leave the queue immediately; the running
 * job is aborted (scrapers stop at the next page boundary).
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
        (priorityAborts.get(id) ?? (runningJobId === id ? runningAbort : null))?.abort();
        // A parked crawl must be released so it can observe the abort.
        if (job.status === 'paused') {
            pauseGate.depth = Math.max(0, pauseGate.depth - 1);
            preemptedJob = null;
        }
        return { ok: true };
    }
    return { ok: false, error: `Job is already ${job.status}` };
}

/**
 * Moves a queued job to a new position among the queued jobs (0 = next).
 * @param {string} id
 * @param {number} position
 * @returns {{ok: boolean, error?: string}}
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
 * Edits the params of a queued job (runners read params at start time).
 * @param {string} id
 * @param {object} patch - Whitelisted keys merged into job.params.
 * @returns {{ok: boolean, job?: Job, error?: string}}
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
 * @returns {number|null} - Position among queued jobs (0 = runs next).
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
 * @returns {(Job & {queuePosition: number|null})[]} - Newest first, with
 *          each queued job's current position (0 = runs next).
 */
export function listJobs(limit = 50) {
    const positions = new Map(queue.map((q, i) => [q.job.id, i]));
    return [...jobs.values()]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit)
        .map(job => ({ ...job, queuePosition: positions.get(job.id) ?? null }));
}
