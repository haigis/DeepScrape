import crypto from 'crypto';
import { closeBrowser } from './scraper.js';

/**
 * In-memory job queue. Jobs run sequentially (one Puppeteer workload at
 * a time); each POST /scrape* endpoint returns a job id immediately and
 * clients poll GET /jobs/:id for status.
 *
 * @typedef {object} Job
 * @property {string} id
 * @property {string} type            scrape | sitemap | spider | batch
 * @property {object} params          Sanitized request parameters (for display).
 * @property {'queued'|'running'|'completed'|'failed'} status
 * @property {string} createdAt
 * @property {string} [startedAt]
 * @property {string} [finishedAt]
 * @property {object|null} progress   e.g. { done, total, currentUrl }
 * @property {object|null} result     Runner return value on completion.
 * @property {string|null} error      Error message on failure.
 */

const jobs = new Map();
const queue = [];
let running = false;

/** Cap on finished jobs kept in memory. */
const MAX_JOBS_KEPT = 200;

function trimOldJobs() {
    const finished = [...jobs.values()]
        .filter(j => j.status === 'completed' || j.status === 'failed');
    if (finished.length <= MAX_JOBS_KEPT) return;
    finished
        .sort((a, b) => a.finishedAt.localeCompare(b.finishedAt))
        .slice(0, finished.length - MAX_JOBS_KEPT)
        .forEach(j => jobs.delete(j.id));
}

/**
 * Creates a job and schedules it. The runner receives an onProgress
 * callback; whatever it returns becomes job.result.
 * @param {string} type
 * @param {object} params
 * @param {(onProgress: (p: object) => void) => Promise<object>} runner
 * @returns {Job}
 */
export function createJob(type, params, runner) {
    const job = {
        id: crypto.randomUUID(),
        type,
        params,
        status: 'queued',
        createdAt: new Date().toISOString(),
        progress: null,
        result: null,
        error: null,
    };
    jobs.set(job.id, job);
    queue.push({ job, runner });
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
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    console.log(`▶️ Job ${job.id} (${job.type}) started`);

    try {
        job.result = await runner(progress => { job.progress = progress; });
        job.status = 'completed';
        console.log(`✅ Job ${job.id} completed`);
    } catch (err) {
        job.status = 'failed';
        job.error = err.message;
        console.error(`❌ Job ${job.id} failed: ${err.message}`);
    } finally {
        job.finishedAt = new Date().toISOString();
        running = false;
        void pump();
    }
}

/**
 * @param {string} id
 * @returns {Job|undefined}
 */
export function getJob(id) {
    return jobs.get(id);
}

/**
 * @param {number} limit
 * @returns {Job[]} - Newest first.
 */
export function listJobs(limit = 50) {
    return [...jobs.values()]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit);
}
