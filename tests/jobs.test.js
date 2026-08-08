import { describe, it, expect } from 'vitest';
import { createJob, getJob, listJobs, cancelJob, moveJob, updateJob } from '../src/jobs.js';

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

        expect(getJob(urgent.id).queuePosition).toBe(0);
        expect(getJob(urgent.id).priority).toBe(true);

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
