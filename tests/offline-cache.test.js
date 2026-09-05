import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/**
 * Asset fetching across the pages of one scan: each URL is requested
 * once, failures are remembered, and stylesheet url() assets are found.
 */
const requests = [];
vi.mock('axios', () => ({
    default: {
        get: vi.fn(async (url) => {
            requests.push(url);
            if (url.endsWith('dead.png')) {
                const err = new Error('connect ECONNREFUSED');
                err.code = 'ECONNREFUSED';
                throw err;
            }
            if (url.endsWith('.css')) {
                return { data: Buffer.from('body { background: url("bg.png") }'), headers: { 'content-type': 'text/css' } };
            }
            return { data: Buffer.from('png-bytes'), headers: { 'content-type': 'image/png' } };
        }),
    },
}));

const { downloadAssets, resetAssetCache } = await import('../src/offline.js');

const PAGE_HTML = `<html><head><link rel="stylesheet" href="https://cdn.example/site.css"></head>
<body><img src="https://cdn.example/logo.png"><img src="https://cdn.example/dead.png"></body></html>`;

let scanDir;
beforeEach(async () => {
    scanDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ds-assets-'));
    requests.length = 0;
    resetAssetCache();
});
afterEach(async () => {
    await fs.rm(scanDir, { recursive: true, force: true });
});

const byUrl = () => requests.reduce((acc, url) => ({ ...acc, [url]: (acc[url] ?? 0) + 1 }), {});

describe('downloadAssets', () => {
    it('fetches each asset once per scan, including assets nested in CSS', async () => {
        const first = await downloadAssets(PAGE_HTML, 'https://site.example/a', scanDir, path.join(scanDir, 'site.example'));
        expect(first.saved).toBe(3); // css, its bg.png, logo.png
        expect(first.failed).toBe(1);
        expect(first.map.get('https://cdn.example/logo.png')).toMatch(/_assets\/logo-[0-9a-f]+\.png$/);

        const before = requests.length;
        const second = await downloadAssets(PAGE_HTML, 'https://site.example/b', scanDir, path.join(scanDir, 'site.example'));
        expect(requests.length).toBe(before); // nothing fetched again — not even the dead one
        expect(second.saved).toBe(0);
        expect(second.failed).toBe(1);
        expect(second.map.get('https://cdn.example/site.css')).toBe(first.map.get('https://cdn.example/site.css'));
        expect(second.map.get('https://cdn.example/logo.png')).toBe(first.map.get('https://cdn.example/logo.png'));

        const counts = byUrl();
        expect(counts['https://cdn.example/site.css']).toBe(1);
        expect(counts['https://cdn.example/bg.png']).toBe(1);
        expect(counts['https://cdn.example/logo.png']).toBe(1);
        // The dead asset got its retries once, and never again.
        expect(counts['https://cdn.example/dead.png']).toBe(3);
    }, 20000);

    it('rewrites nested url() references inside the saved stylesheet', async () => {
        const result = await downloadAssets(PAGE_HTML, 'https://site.example/a', scanDir, path.join(scanDir, 'site.example'));
        const cssLocal = result.map.get('https://cdn.example/site.css');
        const css = await fs.readFile(path.join(scanDir, cssLocal.replace(/^\.\.\//, '')), 'utf8');
        expect(css).toMatch(/url\("bg-[0-9a-f]+\.png"\)/);
    }, 20000);
});
