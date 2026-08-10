import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createJob, getJob, listJobs, cancelJob, moveJob, updateJob } from '../src/jobs.js';

// Ordering assertions below assume one runner slot. Concurrency has its
// own describe at the bottom.
beforeAll(() => { process.env.MAX_CONCURRENT_JOBS = '1'; });
afterAll(() => { delete process.env.MAX_CONCURRENT_JOBS; });

/** Waits until nothing is queued or running, so tests start clean. */
const waitForIdle = async (timeoutMs = 10000) => {
    const start = Date.now();
    while (listJobs(100).some(j => ['queued', 'running', 'paused'].includes(j.status))) {
        if (Date.now() - start > timeoutMs) throw new Error('queue never went idle');
        await new Promise(r => setTimeout(r, 20));
    }
};

const waitFor = async (predicate, timeoutMs = 5000) => {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
        await new Promise(r => setTimeout(r, 20));
    }
};

describe('job queue', () => {
    it('runs a job to completion and stores the result', async () => {
        const job = createJob('test', { a: 1 }, async (onProgress) => {
            onProgress({ done: 1, total: 2 });
            return { answer: 42 };
        });

        expect(['queued', 'running']).toContain(getJob(job.id).status);
        await waitFor(() => getJob(job.id).status === 'completed');

        const done = getJob(job.id);
        expect(done.result).toEqual({ answer: 42 });
        expect(done.progress).toEqual({ done: 1, total: 2 });
        expect(done.error).toBeNull();
        expect(done.startedAt).toBeDefined();
        expect(done.finishedAt).toBeDefined();
    });

    it('marks failing jobs as failed with the error message', async () => {
        const job = createJob('test', {}, async () => {
            throw new Error('boom');
        });

        await waitFor(() => getJob(job.id).status === 'failed');
        expect(getJob(job.id).error).toBe('boom');
    });

    it('runs jobs sequentially in submission order', async () => {
        const order = [];
        const slow = createJob('test', {}, async () => {
            await new Promise(r => setTimeout(r, 100));
            order.push('first');
        });
        const fast = createJob('test', {}, async () => {
            order.push('second');
        });

        await waitFor(() =>
            getJob(slow.id).status === 'completed' && getJob(fast.id).status === 'completed');
        expect(order).toEqual(['first', 'second']);
    });

    it('lists jobs newest first', async () => {
        const jobs = listJobs();
        expect(jobs.length).toBeGreaterThan(0);
        for (let i = 1; i < jobs.length; i++) {
            expect(jobs[i - 1].createdAt >= jobs[i].createdAt).toBe(true);
        }
    });
});

describe('queue management', () => {
    /** Occupies the runner slot so later jobs stay queued. */
    const blocker = (ms) => createJob('test', {}, () => new Promise(r => setTimeout(r, ms)));

    it('cancels a queued job without running it', async () => {
        blocker(150);
        let ran = false;
        const victim = createJob('test', {}, async () => { ran = true; });

        const result = cancelJob(victim.id);
        expect(result.ok).toBe(true);
        expect(getJob(victim.id).status).toBe('cancelled');

        await waitFor(() => getJob(victim.id).finishedAt != null);
        await new Promise(r => setTimeout(r, 250));
        expect(ran).toBe(false);
    });

    it('stops a running job via its AbortSignal', async () => {
        const job = createJob('test', {}, async (onProgress, params, signal) => {
            for (let i = 0; i < 100; i++) {
                if (signal.aborted) return { stoppedAt: i };
                await new Promise(r => setTimeout(r, 20));
            }
            return { stoppedAt: 100 };
        });

        await waitFor(() => getJob(job.id).status === 'running');
        expect(cancelJob(job.id).ok).toBe(true);
        await waitFor(() => getJob(job.id).status === 'cancelled');
        expect(getJob(job.id).result?.stoppedAt ?? 0).toBeLessThan(100);
    });

    it('rejects cancelling finished jobs', async () => {
        const job = createJob('test', {}, async () => 'done');
        await waitFor(() => getJob(job.id).status === 'completed');
        const result = cancelJob(job.id);
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/already completed/);
    });

    it('reorders queued jobs', async () => {
        const order = [];
        blocker(200);
        const a = createJob('test', {}, async () => { order.push('a'); });
        const b = createJob('test', {}, async () => { order.push('b'); });

        expect(moveJob(b.id, 0).ok).toBe(true); // b jumps ahead of a

        await waitFor(() =>
            getJob(a.id).status === 'completed' && getJob(b.id).status === 'completed');
        expect(order).toEqual(['b', 'a']);
    });

    it('edits params of a queued job and the runner sees them', async () => {
        blocker(150);
        let seen = null;
        const job = createJob('test', { rateLimit: 1000 }, async (onProgress, params) => {
            seen = params.rateLimit;
        });

        expect(updateJob(job.id, { rateLimit: 50 }).ok).toBe(true);
        await waitFor(() => getJob(job.id).status === 'completed');
        expect(seen).toBe(50);
    });

    it('rejects edits to running or finished jobs', async () => {
        const job = createJob('test', {}, async () => 'done');
        await waitFor(() => getJob(job.id).status === 'completed');
        const result = updateJob(job.id, { rateLimit: 1 });
        expect(result.ok).toBe(false);
    });

    it('puts priority jobs ahead of queued normal jobs', async () => {
        const order = [];
        blocker(250);
        const normalA = createJob('test', {}, async () => { order.push('normalA'); });
        const normalB = createJob('test', {}, async () => { order.push('normalB'); });
        const urgent = createJob('test', {}, async () => { order.push('urgent'); }, { priority: true });

        // With preemption the urgent job may already be running (it parks
        // the blocker) rather than sitting at position 0 — either is correct.
        expect(getJob(urgent.id).priority).toBe(true);
        expect([0, null]).toContain(getJob(urgent.id).queuePosition);

        await waitFor(() =>
            [normalA, normalB, urgent].every(j => getJob(j.id).status === 'completed'), 8000);
        expect(order).toEqual(['urgent', 'normalA', 'normalB']);
    });

    it('keeps priority jobs in submission order among themselves', async () => {
        const order = [];
        blocker(250);
        createJob('test', {}, async () => { order.push('normal'); });
        const p1 = createJob('test', {}, async () => { order.push('p1'); }, { priority: true });
        const p2 = createJob('test', {}, async () => { order.push('p2'); }, { priority: true });

        await waitFor(() =>
            [p1, p2].every(j => getJob(j.id).status === 'completed') && order.includes('normal'), 8000);
        expect(order).toEqual(['p1', 'p2', 'normal']);
    });

    it('reports queue positions in listJobs', async () => {
        blocker(200);
        const a = createJob('test', {}, async () => {});
        const b = createJob('test', {}, async () => {});

        const listed = listJobs();
        expect(listed.find(j => j.id === a.id).queuePosition).toBe(0);
        expect(listed.find(j => j.id === b.id).queuePosition).toBe(1);

        await waitFor(() => getJob(b.id).status === 'completed');
    });
});

describe('preemptive priority scans (issue #13)', () => {
    /**
     * A long job that yields to the pause gate between "pages" and
     * records the order of work, so we can prove a priority job runs
     * *while* the long one is parked — not after it finishes.
     */
    it('parks a running crawl so a priority job runs immediately', async () => {
        await waitForIdle();
        const order = [];
        const longJob = createJob('spider', {}, async (onProgress, params, signal, gate) => {
            for (let page = 0; page < 12; page++) {
                await gate?.wait();          // park here when preempted
                order.push(`crawl-${page}`);
                await new Promise(r => setTimeout(r, 40));
            }
            return { pages: 12 };
        });

        await waitFor(() => getJob(longJob.id).status === 'running');
        await new Promise(r => setTimeout(r, 90)); // let a couple of pages run

        const urgent = createJob('scrape', {}, async () => {
            order.push('URGENT');
            return { processed: 1 };
        }, { priority: true });

        // The crawl must be parked, not finished, while the urgent job runs.
        await waitFor(() => getJob(urgent.id).status === 'completed', 5000);
        expect(getJob(longJob.id).status).not.toBe('completed');

        const urgentIndex = order.indexOf('URGENT');
        expect(urgentIndex).toBeGreaterThan(0);              // crawl had started
        expect(urgentIndex).toBeLessThan(order.length);       // ran mid-crawl

        // …and the crawl resumes and finishes all its pages.
        await waitFor(() => getJob(longJob.id).status === 'completed', 8000);
        expect(getJob(longJob.id).result).toEqual({ pages: 12 });
        expect(order.filter(o => o.startsWith('crawl-'))).toHaveLength(12);
        // Work continued after the interruption — nothing was lost.
        expect(order.slice(urgentIndex + 1).some(o => o.startsWith('crawl-'))).toBe(true);
    }, 25000);

    it('reports the parked crawl as paused while priority work runs', async () => {
        await waitForIdle();
        let seenPaused = false;
        const longJob = createJob('spider', {}, async (onProgress, params, signal, gate) => {
            for (let page = 0; page < 10; page++) {
                await gate?.wait();
                await new Promise(r => setTimeout(r, 40));
            }
            return { done: true };
        });

        await waitFor(() => getJob(longJob.id).status === 'running');
        const urgent = createJob('scrape', {}, async () => {
            await new Promise(r => setTimeout(r, 120));
            return { ok: true };
        }, { priority: true });

        while (getJob(urgent.id).status !== 'completed') {
            if (getJob(longJob.id).status === 'paused') seenPaused = true;
            await new Promise(r => setTimeout(r, 20));
        }
        expect(seenPaused).toBe(true);

        await waitFor(() => getJob(longJob.id).status === 'completed', 8000);
    }, 25000);
});

describe('concurrent jobs', () => {
    it('runs jobs in parallel up to MAX_CONCURRENT_JOBS', async () => {
        const waitForIdleLocal = async () => {
            while (listJobs(100).some(j => ['queued', 'running', 'paused'].includes(j.status))) {
                await new Promise(r => setTimeout(r, 20));
            }
        };
        await waitForIdleLocal();
        process.env.MAX_CONCURRENT_JOBS = '2';
        try {
            let inFlight = 0;
            let peak = 0;
            const worker = () => createJob('test', {}, async () => {
                inFlight++;
                peak = Math.max(peak, inFlight);
                await new Promise(r => setTimeout(r, 120));
                inFlight--;
            });
            const jobs = [worker(), worker(), worker()];
            await waitFor(() => jobs.every(j => getJob(j.id).status === 'completed'), 8000);
            expect(peak).toBe(2); // two ran together, the third waited
        } finally {
            process.env.MAX_CONCURRENT_JOBS = '1';
        }
    }, 15000);
});
