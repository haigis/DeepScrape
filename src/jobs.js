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

async function pump() {
    if (running) return;
    const next = queue.shift();
    if (!next) {
        // Queue drained — release the shared browser.
        await closeBrowser();
        return;
    }

    running = true;
    const { job, runner } = next;
    const abort = new AbortController();
    runningAbort = abort;
    runningJobId = job.id;
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    console.log(`▶️ Job ${job.id} (${job.type}) started`);

    try {
        job.result = await runner(progress => { job.progress = progress; }, job.params, abort.signal);
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
        running = false;
        runningAbort = null;
        runningJobId = null;
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
    if (job.status === 'running') {
        runningAbort?.abort();
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
