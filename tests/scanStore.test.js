import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildScanTree, getPageDetails, getPageHistory, readPageUrl } from '../src/scanStore.js';

let root;        // temp output/<domain>
let scanA;       // output/<domain>/2026-08-01
let scanB;       // output/<domain>/2026-08-08

const write = async (base, rel, content) => {
    const abs = path.join(base, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
};

beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'deepscrape-store-'));
    scanA = path.join(root, '2026-08-01');
    scanB = path.join(root, '2026-08-08');

    // Older scan: index only, smaller.
    await write(scanA, 'bank.example/index.html', '<!-- https://bank.example/ -->\n<html>old</html>');

    // Newer scan: nested structure, screenshots, artifacts, images.
    await write(scanB, 'bank.example/index.html', '<!-- https://bank.example/ -->\n<html><a href="https://bank.example/loans/personal.html">x</a><a href="https://other.example/">y</a></html>');
    await write(scanB, 'bank.example/index.webp', 'webp-bytes');
    await write(scanB, 'bank.example/loans/personal.html', '<!-- https://bank.example/loans/personal -->\n<html>p</html>');
    await write(scanB, 'bank.example/loans/mortgages/fixed.html', '<!-- https://bank.example/loans/mortgages/fixed -->\n<html>f</html>');
    await write(scanB, 'bank.example/images/logo.png', 'png');
    await write(scanB, 'all-links.txt', 'https://bank.example/a\nhttps://bank.example/b');
    await write(scanB, 'broken-links.txt', 'https://bank.example/dead\nhttps://bank.example/gone');
    await write(scanB, 'incoming-links.json', JSON.stringify({
        'https://bank.example/loans/personal': ['https://bank.example/'],
    }));
});

afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
});

describe('readPageUrl', () => {
    it('reads the original URL from the saved comment', async () => {
        const url = await readPageUrl(path.join(scanB, 'bank.example/index.html'));
        expect(url).toBe('https://bank.example/');
    });

    it('returns null for files without the comment', async () => {
        const url = await readPageUrl(path.join(scanB, 'all-links.txt'));
        expect(url).toBeNull();
    });
});

describe('buildScanTree', () => {
    it('builds a nested tree with per-folder page counts and stats', async () => {
        const { tree, stats } = await buildScanTree(scanB);

        expect(stats.pages).toBe(3);
        expect(stats.screenshots).toBe(1);
        expect(stats.images).toBe(1);
        expect(stats.brokenLinks).toBe(2);
        expect(stats.artifacts.sort()).toEqual(['all-links.txt', 'broken-links.txt', 'incoming-links.json']);

        expect(tree.pages).toBe(3);
        const site = tree.children.find(c => c.name === 'bank.example');
        expect(site.pages).toBe(3);
        const loans = site.children.find(c => c.name === 'loans');
        expect(loans.pages).toBe(2);
        const mortgages = loans.children.find(c => c.name === 'mortgages');
        expect(mortgages.pages).toBe(1);
        // images/ folders are counted as assets, not shown as tree nodes.
        expect(site.children.some(c => c.name === 'images')).toBe(false);
        // pages sort before directories
        expect(site.children[0].type).toBe('page');
    });
});

describe('getPageDetails', () => {
    it('returns url, size, screenshot, incoming and outgoing links', async () => {
        const d = await getPageDetails(scanB, 'bank.example/2026-08-08', 'bank.example/index.html');
        expect(d.url).toBe('https://bank.example/');
        expect(d.size).toBeGreaterThan(0);
        expect(d.screenshotUrl).toBe('/output/bank.example/2026-08-08/bank.example/index.webp');
        expect(d.outgoing).toContain('https://bank.example/loans/personal.html');
        expect(d.outgoing).toContain('https://other.example/');
    });

    it('maps incoming links via incoming-links.json', async () => {
        const d = await getPageDetails(scanB, 'bank.example/2026-08-08', 'bank.example/loans/personal.html');
        expect(d.incoming).toEqual(['https://bank.example/']);
        expect(d.screenshotUrl).toBeNull();
    });

    it('returns null for missing pages', async () => {
        const d = await getPageDetails(scanB, 'x', 'bank.example/nope.html');
        expect(d).toBeNull();
    });
});

describe('getPageHistory', () => {
    it('lists scans containing the page newest first with size deltas', async () => {
        const h = await getPageHistory(root, 'bank.example', 'bank.example/index.html');
        expect(h.map(e => e.date)).toEqual(['2026-08-08', '2026-08-01']);
        expect(h[0].sizeDelta).toBe(h[0].size - h[1].size);
        expect(h[1].sizeDelta).toBeNull();
        expect(h[0].screenshotUrl).toContain('index.webp');
        expect(h[1].screenshotUrl).toBeNull();
    });

    it('skips scans that do not contain the page', async () => {
        const h = await getPageHistory(root, 'bank.example', 'bank.example/loans/personal.html');
        expect(h.map(e => e.date)).toEqual(['2026-08-08']);
    });
});
