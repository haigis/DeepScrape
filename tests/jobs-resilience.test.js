import { describe, it, expect, afterEach } from 'vitest';
import { createJob, getJob, restoreFrom, resumeInterrupted, requeueJob } from '../src/jobs.js';

const waitFor = async (predicate, timeoutMs = 5000) => {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
        await new Promise(r => setTimeout(r, 20));
    }
};

afterEach(() => {
    delete process.env.DS_JOB_STALL_MS;
    delete process.env.DS_WATCHDOG_TICK_MS;
    delete process.env.DS_JOB_MAX_ATTEMPTS;
});

describe('restart survival', () => {
    it('re-queues an interrupted crawl under the same id and runs it to completion', async () => {
        const saved = [{
            id: 'job-crawl-1', type: 'full', status: 'running', attempts: 1,
            params: { url: 'https://x.example/', scanDate: '2026-01-02' },
            createdAt: new Date().toISOString(), progress: { done: 40, total: 100 }, result: null, error: null,
        }];
        expect(restoreFrom(saved)).toEqual({ restored: 1, interrupted: 1 });
        expect(getJob('job-crawl-1').status).toBe('interrupted');

        let ranWith = null;
        const summary = resumeInterrupted(() => ({
            runner: async (onProgress, params) => { ranWith = params; return { visited: 100 }; },
            params: { resume: true },
        }));
        expect(summary.resumed).toEqual(['job-crawl-1']);

        await waitFor(() => getJob('job-crawl-1').status === 'completed');
        const done = getJob('job-crawl-1');
        expect(done.attempts).toBe(2);
        expect(done.result).toEqual({ visited: 100 });
        expect(ranWith).toMatchObject({ url: 'https://x.example/', scanDate: '2026-01-02', resume: true });
    });

    it('fails jobs the resolver cannot rebuild, with a plain reason', () => {
        restoreFrom([{ id: 'job-scrape-1', type: 'scrape', status: 'running', params: {}, createdAt: 'x' }]);
        const summary = resumeInterrupted(() => null);
        expect(summary.failed).toContain('job-scrape-1');
        const job = getJob('job-scrape-1');
        expect(job.status).toBe('failed');
        expect(job.retryable).toBe(true);
        expect(job.error).toMatch(/restarted/);
    });

    it('stops resuming a crawl that has hit the attempt limit', () => {
        process.env.DS_JOB_MAX_ATTEMPTS = '2';
        restoreFrom([{ id: 'job-loop', type: 'full', status: 'running', attempts: 2, params: {}, createdAt: 'x' }]);
        let asked = false;
        const summary = resumeInterrupted(() => { asked = true; return { runner: async () => ({}) }; });
        expect(asked).toBe(false);
        expect(summary.failed).toEqual(['job-loop']);
        expect(getJob('job-loop').error).toMatch(/2 times/);
        expect(getJob('job-loop').retryable).toBe(false);
    });

    it('leaves finished jobs alone on restore', () => {
        restoreFrom([{ id: 'job-done', type: 'full', status: 'completed', params: {}, createdAt: 'x', result: { visited: 3 } }]);
        expect(getJob('job-done').status).toBe('completed');
        expect(getJob('job-done').attempts).toBe(1);
    });

    it('refuses to requeue a job that is still live', async () => {
        const job = createJob('test', {}, async () => { await new Promise(r => setTimeout(r, 100)); return {}; });
        await waitFor(() => getJob(job.id).status === 'running');
        expect(requeueJob(job.id, async () => ({})).ok).toBe(false);
        await waitFor(() => getJob(job.id).status === 'completed');
    });
});

describe('stall watchdog', () => {
    it('aborts a running job that stops reporting progress and marks it retryable', async () => {
        process.env.DS_JOB_STALL_MS = '150';
        process.env.DS_WATCHDOG_TICK_MS = '25';
        const job = createJob('spider', {}, (onProgress, params, signal) => new Promise((resolve, reject) => {
            onProgress({ done: 1, total: 10 });
            signal.addEventListener('abort', () => reject(new Error('cancelled')));
        }));
        await waitFor(() => getJob(job.id).status === 'failed', 3000);
        const failed = getJob(job.id);
        expect(failed.error).toMatch(/no progress/);
        expect(failed.retryable).toBe(true);
    });

    it('does not fire while progress keeps coming', async () => {
        process.env.DS_JOB_STALL_MS = '120';
        process.env.DS_WATCHDOG_TICK_MS = '25';
        const job = createJob('spider', {}, async (onProgress) => {
            for (let i = 0; i < 8; i++) {
                onProgress({ done: i, total: 8 });
                await new Promise(r => setTimeout(r, 50));
            }
            return { done: true };
        });
        await waitFor(() => ['completed', 'failed'].includes(getJob(job.id).status), 3000);
        expect(getJob(job.id).status).toBe('completed');
    });
});
