import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { extractAnchors, getLinkInventory, checkLinks } from '../src/scanStore.js';

/**
 * Whole-scan link inventory and targeted link checks: the data behind
 * the product's Links section and its watched links / journeys.
 */

let root;
let scanPath;
const scan = 'bank.example/2026-09-13';

const write = async (rel, content) => {
    const abs = path.join(scanPath, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
};

const nav = '<nav><a href="https://bank.example/" id="nav-home" class="nav-link">Home</a>'
    + '<a href="https://bank.example/savings" class="nav-link" data-analytics="nav-savings">Savings</a></nav>';

beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'deepscrape-links-'));
    scanPath = path.join(root, 'bank.example', '2026-09-13');

    await write('bank.example/index.html',
        '<!-- https://bank.example/ -->\n<html><head><title>Bank home</title></head><body>' + nav
        + '<main><h1>Welcome</h1>'
        + '<a href="https://bank.example/savings/" id="cta-savings" class="btn btn-primary" data-analytics="home-savings-cta" data-track=\'1\'>Open a savings pot</a>'
        + '<a href="https://bank.example/dead-end">Old promo</a>'
        + '<a href="https://www.fca.org.uk/register" rel="nofollow">FCA register</a>'
        + '<a href="https://www.fca.org.uk/">The regulator</a>'
        + '</main></body></html>');
    await write('bank.example/savings.html',
        '<!-- https://bank.example/savings -->\n<html><head><title>Savings</title></head><body>' + nav
        + '<main><h1>Savings</h1>'
        + '<a href="https://bank.example/savings/squirrel-saver#rates" data-analytics="savings-squirrel">Squirrel Saver</a>'
        + '<a href="https://www.fca.org.uk/register">FCA register</a>'
        + '</main></body></html>');
    await write('bank.example/savings/squirrel-saver.html',
        '<!-- https://bank.example/savings/squirrel-saver -->\n<html><head><title>Squirrel Saver</title></head><body>' + nav
        + '<main><h1>Squirrel Saver</h1><a href="https://bank.example/savings">Back to savings</a></main></body></html>');
    // Saved, but nothing links to it.
    await write('bank.example/legal/orphan.html',
        '<!-- https://bank.example/legal/orphan -->\n<html><head><title>Orphan</title></head><body>' + nav + '<h1>Lonely</h1></body></html>');
    await write('broken-links.txt', 'https://bank.example/dead-end\n');
});

afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
});

describe('extractAnchors identity attributes', () => {
    it('captures id, class and data-* attributes per anchor', () => {
        const [link] = extractAnchors('<a href="https://x.example/a" id="cta" class="btn primary" data-analytics="hero-cta" data-Step=\'2\'>Go</a>');
        expect(link.id).toBe('cta');
        expect(link.className).toBe('btn primary');
        expect(link.data).toEqual({ analytics: 'hero-cta', step: '2' });
    });

    it('reports null / empty when the anchor has none', () => {
        const [link] = extractAnchors('<a href="https://x.example/a">Go</a>');
        expect(link.id).toBeNull();
        expect(link.className).toBeNull();
        expect(link.data).toEqual({});
    });
});

describe('getLinkInventory', () => {
    it('aggregates every target with sources, regions and attributes', async () => {
        const inventory = await getLinkInventory(scanPath, scan);
        expect(inventory.scan).toBe(scan);
        expect(inventory.pagesIndexed).toBe(4);

        const savings = inventory.links.find(l => l.url === 'https://bank.example/savings');
        expect(savings).toBeDefined();
        expect(savings.internal).toBe(true);
        expect(savings.scraped).toBe(true);
        expect(savings.path).toBe('bank.example/savings.html');
        expect(savings.title).toBe('Savings');
        // Linked from the nav of every other page plus the home CTA and the back link.
        expect(savings.inbound).toBe(3);
        expect(savings.contentInbound).toBe(2);
        expect(savings.anchorTexts).toEqual(expect.arrayContaining(['Savings', 'Open a savings pot', 'Back to savings']));
        // Content sources come first, carrying the content anchor's identity.
        expect(savings.sources[0].region).toBe('content');
        const home = savings.sources.find(s => s.path === 'bank.example/index.html');
        expect(home.id).toBe('cta-savings');
        expect(home.className).toBe('btn btn-primary');
        expect(home.data).toEqual({ analytics: 'home-savings-cta', track: '1' });
    });

    it('flags broken and external targets and lists orphans', async () => {
        const inventory = await getLinkInventory(scanPath, scan);
        const dead = inventory.links.find(l => l.url === 'https://bank.example/dead-end');
        expect(dead.broken).toBe(true);
        expect(dead.scraped).toBe(false);

        const register = inventory.links.find(l => l.url === 'https://www.fca.org.uk/register');
        expect(register.internal).toBe(false);
        expect(register.path).toBeNull();
        expect(register.inbound).toBe(2);
        // Only nofollow when every source says so.
        expect(register.nofollow).toBe(false);

        const orphan = inventory.links.find(l => l.path === 'bank.example/legal/orphan.html');
        expect(orphan.inbound).toBe(0);
        expect(orphan.scraped).toBe(true);

        expect(inventory.counts).toMatchObject({ broken: 1, external: 2, externalHosts: 1, orphans: 1 });
        expect(inventory.externalHosts).toEqual([{ host: 'www.fca.org.uk', links: 2, pages: 2 }]);
    });

    it('filters, searches, sorts and pages', async () => {
        const broken = await getLinkInventory(scanPath, scan, { type: 'broken' });
        expect(broken.total).toBe(1);
        expect(broken.links[0].url).toBe('https://bank.example/dead-end');

        const external = await getLinkInventory(scanPath, scan, { type: 'external', sort: 'url' });
        expect(external.links.map(l => l.url)).toEqual(['https://www.fca.org.uk', 'https://www.fca.org.uk/register']);

        const orphans = await getLinkInventory(scanPath, scan, { type: 'orphan' });
        expect(orphans.links.map(l => l.path)).toEqual(['bank.example/legal/orphan.html']);

        const search = await getLinkInventory(scanPath, scan, { q: 'squirrel' });
        expect(search.total).toBe(1);

        const page = await getLinkInventory(scanPath, scan, { limit: 2, offset: 2, sort: 'url' });
        expect(page.links).toHaveLength(2);
        expect(page.limit).toBe(2);
        expect(page.offset).toBe(2);
        expect(page.total).toBe(page.counts.targets);

        // Broken targets sort first by default.
        const all = await getLinkInventory(scanPath, scan);
        expect(all.links[0].broken).toBe(true);
    });
});

describe('checkLinks', () => {
    it('echoes normalised urls with their current state and every source', async () => {
        const results = await checkLinks(scanPath, scan, [
            'https://bank.example/savings/squirrel-saver/#rates',
            'https://bank.example/dead-end',
            'https://bank.example/never-linked',
            'not a url',
        ]);
        expect(results.map(r => r.url)).toEqual([
            'https://bank.example/savings/squirrel-saver',
            'https://bank.example/dead-end',
            'https://bank.example/never-linked',
            'not a url',
        ]);

        const [squirrel, dead, never, junk] = results;
        expect(squirrel.found).toBe(true);
        expect(squirrel.inbound).toBe(1);
        expect(squirrel.sources[0]).toMatchObject({ path: 'bank.example/savings.html', text: 'Squirrel Saver', data: { analytics: 'savings-squirrel' } });

        expect(dead.found).toBe(true);
        expect(dead.broken).toBe(true);

        expect(never.found).toBe(false);
        expect(never.internal).toBe(true);
        expect(never.broken).toBe(false);

        expect(junk.found).toBe(false);
    });
});
