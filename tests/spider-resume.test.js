import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/**
 * The crawl loop with a fake scraper: a six-page site, failures injected
 * per URL. Exercises checkpoints, resume, and the retry policy without
 * a browser.
 */
const SITE = {
    'https://t.example/': ['https://t.example/a', 'https://t.example/b'],
    'https://t.example/a': ['https://t.example/c', 'https://t.example/d'],
    'https://t.example/b': ['https://t.example/e'],
    'https://t.example/c': [],
    'https://t.example/d': [],
    'https://t.example/e': [],
};

const state = { fetched: [], failures: new Map(), onFetch: null };

vi.mock('../src/scraper.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        getBrowser: vi.fn(async () => ({ connected: true })),
        scrapePage: vi.fn(async (_browser, url) => {
            state.fetched.push(url);
            state.onFetch?.(url);
            const planned = state.failures.get(url);
            if (planned?.length) return { ok: false, links: [], ...planned.shift() };
            return { ok: true, status: 200, links: SITE[url] ?? [] };
        }),
    };
});

const { spiderCrawl, retryDelay, CHECKPOINT_FILE, LINK_LOG_FILE } = await import('../src/spider.js');

let outRoot;
const outDir = () => path.join(outRoot, 't.example', '2026-01-02');
const crawl = (extra = {}) => spiderCrawl(['https://t.example/'], {
    scanDate: '2026-01-02', rateLimit: 0, maxDepth: 5, concurrency: 2, offline: false, ...extra,
});

beforeEach(async () => {
    outRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ds-spider-'));
    process.env.OUTPUT_DIR = outRoot;
    process.env.DS_RETRY_BASE_MS = '5';
    state.fetched = [];
    state.failures = new Map();
    state.onFetch = null;
});

afterEach(async () => {
    delete process.env.OUTPUT_DIR;
    delete process.env.DS_RETRY_BASE_MS;
    delete process.env.DS_PAGE_ATTEMPTS;
    await fs.rm(outRoot, { recursive: true, force: true });
});

const exists = async (file) => fs.access(file).then(() => true, () => false);

describe('retryDelay', () => {
    it('retries transient failures with backoff', () => {
        const result = { ok: false, error: 'Timed out after waiting 30000ms', transient: true };
        expect(retryDelay(result, 1)).toBe(5);
        expect(retryDelay(result, 2)).toBe(10);
    });

    it('waits longer for rate limiting and server errors', () => {
        expect(retryDelay({ ok: false, status: 429, error: 'HTTP 429' }, 1)).toBe(25);
        expect(retryDelay({ ok: false, status: 503, error: 'HTTP 503' }, 2)).toBe(50);
    });

    it('never retries a real failure, a cancel, or a success', () => {
        expect(retryDelay({ ok: false, status: 404, error: 'HTTP 404' }, 1)).toBeNull();
        expect(retryDelay({ ok: false, error: 'cancelled' }, 1)).toBeNull();
        expect(retryDelay({ ok: false, error: 'page deadline exceeded (120000ms)' }, 1)).toBeNull();
        expect(retryDelay({ ok: true, links: [] }, 1)).toBeNull();
    });
});

describe('spider retries', () => {
    it('retries a transient page failure and does not count it as broken', async () => {
        state.failures.set('https://t.example/a', [{ error: 'Timed out after waiting 30000ms', transient: true }]);
        const result = await crawl();
        expect(result.visited).toBe(6);
        expect(result.broken).toBe(0);
        expect(result.retries).toBe(1);
        expect(state.fetched.filter(u => u === 'https://t.example/a')).toHaveLength(2);
    });

    it('gives up after DS_PAGE_ATTEMPTS and records the page as broken', async () => {
        process.env.DS_PAGE_ATTEMPTS = '2';
        state.failures.set('https://t.example/a', [
            { error: 'net::ERR_CONNECTION_RESET', transient: true },
            { error: 'net::ERR_CONNECTION_RESET', transient: true },
            { error: 'net::ERR_CONNECTION_RESET', transient: true },
        ]);
        const result = await crawl();
        expect(result.broken).toBe(1);
        expect(state.fetched.filter(u => u === 'https://t.example/a')).toHaveLength(2);
        // Its children were never discovered, so the crawl is smaller.
        expect(result.visited).toBe(4);
    });

    it('does not retry a permanent failure', async () => {
        state.failures.set('https://t.example/b', [{ status: 404, error: 'HTTP 404' }]);
        const result = await crawl();
        expect(result.broken).toBe(1);
        expect(result.retries).toBe(0);
        expect(state.fetched.filter(u => u === 'https://t.example/b')).toHaveLength(1);
    });
});

describe('spider checkpoints and resume', () => {
    it('leaves a checkpoint when aborted, and a resume finishes without re-fetching', async () => {
        const controller = new AbortController();
        // Stop after three pages have been handed out.
        state.onFetch = () => { if (state.fetched.length === 3) controller.abort(); };

        const first = await crawl({ signal: controller.signal, concurrency: 1 });
        expect(first.aborted).toBe(true);
        expect(await exists(path.join(outDir(), CHECKPOINT_FILE))).toBe(true);
        const checkpoint = JSON.parse(await fs.readFile(path.join(outDir(), CHECKPOINT_FILE), 'utf8'));
        expect(checkpoint.visited.length).toBeGreaterThan(0);
        expect(checkpoint.queue.length).toBeGreaterThan(0);
        const doneBefore = new Set(checkpoint.visited);

        state.fetched = [];
        const second = await crawl({ resume: true });
        expect(second.resumed).toBe(true);
        expect(second.visited).toBe(6);
        // Nothing already done was fetched again…
        for (const url of state.fetched) expect(doneBefore.has(url)).toBe(false);
        // …and the page in flight at the abort was.
        expect(state.fetched.length).toBe(6 - doneBefore.size);

        // The link graph covers pages from both halves of the crawl.
        const incoming = JSON.parse(await fs.readFile(path.join(outDir(), 'incoming-links.json'), 'utf8'));
        expect(incoming['https://t.example/a']).toContain('https://t.example/');
        expect(incoming['https://t.example/e']).toContain('https://t.example/b');

        // A completed crawl is not resumable.
        expect(await exists(path.join(outDir(), CHECKPOINT_FILE))).toBe(false);
        expect(await exists(path.join(outDir(), LINK_LOG_FILE))).toBe(false);
    });

    it('starts fresh when resume is requested without a checkpoint', async () => {
        const result = await crawl({ resume: true });
        expect(result.resumed).toBe(false);
        expect(result.visited).toBe(6);
    });

    it('ignores a stale checkpoint unless resume is asked for', async () => {
        const controller = new AbortController();
        state.onFetch = () => { if (state.fetched.length === 2) controller.abort(); };
        await crawl({ signal: controller.signal, concurrency: 1 });

        state.fetched = [];
        const result = await crawl();
        expect(result.resumed).toBe(false);
        expect(state.fetched).toHaveLength(6);
    });

    it('refuses a scanDate that is not a date', async () => {
        await expect(crawl({ scanDate: '../../etc' })).rejects.toThrow(/scanDate/);
    });
});
