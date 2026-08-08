import { describe, it, expect } from 'vitest';
import { createJob, getJob, listJobs } from '../src/jobs.js';

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
