import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
    buildScanTree, getPageDetails, getPageHistory, readPageUrl,
    extractAnchors, urlToScanPath, extractPageMeta, assessDiscoverability,
    classifyHref, getInboundIndex,
} from '../src/scanStore.js';

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
    await write(scanB, 'bank.example/index.html',
        '<!-- https://bank.example/ -->\n<html>'
        + '<a href="https://bank.example/loans/personal">Personal loans</a>'
        + '<a href="https://bank.example/loans/personal#rates">Personal loans</a>'
        + '<a href="https://bank.example/missing-page">Not scraped</a>'
        + '<a href="https://other.example/" rel="nofollow">Partner site</a>'
        + '<a href="https://other.example/terms"><span>Terms</span></a>'
        + '<a href="https://cdn.example/asset">CDN</a>'
        + '</html>');
    await write(scanB, 'bank.example/index.webp', 'webp-bytes');
    // noindex page that other pages still link to — the conflict case.
    await write(scanB, 'bank.example/loans/personal.html',
        '<!-- https://bank.example/loans/personal -->\n'
        + '<html lang="en-GB"><head><title>Personal loans | Bank</title>'
        + '<meta name="description" content="Compare our personal loan rates and apply online in minutes with a decision in principle.">'
        + '<meta name="robots" content="noindex, follow">'
        + '<link rel="canonical" href="https://bank.example/loans/personal">'
        + '</head><body><h1>Personal loans</h1></body></html>');
    await write(scanB, 'bank.example/loans/mortgages/fixed.html', '<!-- https://bank.example/loans/mortgages/fixed -->\n<html>f</html>');
    await write(scanB, 'bank.example/images/logo.png', 'png');
    await write(scanB, 'all-links.txt', 'https://bank.example/a\nhttps://bank.example/b');
    await write(scanB, 'broken-links.txt',
        'https://bank.example/dead\nhttps://bank.example/gone\nhttps://bank.example/missing-page');
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
        expect(stats.brokenLinks).toBe(3);
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

describe('extractAnchors', () => {
    it('captures href, visible text and rel, stripping nested markup', () => {
        const anchors = extractAnchors('<a href="https://x.example/a" rel="NOFOLLOW"><span>Hello</span> world</a>');
        expect(anchors).toHaveLength(1);
        expect(anchors[0]).toMatchObject({
            href: 'https://x.example/a', text: 'Hello world', rel: 'nofollow',
            kind: 'page', tag: 'a', nofollow: true, ugc: false, sponsored: false,
        });
    });

    it('recognises ugc and sponsored rel tokens', () => {
        const [link] = extractAnchors('<a href="https://x.example/a" rel="ugc sponsored noopener">x</a>');
        expect(link.ugc).toBe(true);
        expect(link.sponsored).toBe(true);
        expect(link.nofollow).toBe(false);
    });

    it('skips non-http hrefs by default and anchors without href', () => {
        const anchors = extractAnchors('<a href="mailto:a@b.c">mail</a><a>plain</a><a href="#top">top</a>');
        expect(anchors).toEqual([]);
    });

    it('classifies non-http links when asked for them', () => {
        const anchors = extractAnchors(
            '<a href="mailto:a@b.c">Mail us</a><a href="tel:+441234">Call</a>'
            + '<a href="javascript:void(0)">JS</a><a href="#top">Top</a>'
            + '<a href="https://x.example/">Page</a>',
            { includeNonHttp: true });
        expect(anchors.map(a => a.kind)).toEqual(['mailto', 'tel', 'script', 'fragment', 'page']);
    });

    it('includes <area> image-map links, falling back to alt text', () => {
        const anchors = extractAnchors('<area href="https://x.example/zone" alt="Zone one">');
        expect(anchors).toHaveLength(1);
        expect(anchors[0]).toMatchObject({ tag: 'area', text: 'Zone one', kind: 'page' });
    });

    it('reads single-quoted href and rel attributes', () => {
        const [link] = extractAnchors("<a href='https://x.example/q' rel='nofollow'>q</a>");
        expect(link.href).toBe('https://x.example/q');
        expect(link.nofollow).toBe(true);
    });
});

describe('classifyHref', () => {
    it('classifies each scheme', () => {
        expect(classifyHref('https://x.example')).toBe('page');
        expect(classifyHref('HTTP://x.example')).toBe('page');
        expect(classifyHref('mailto:a@b.c')).toBe('mailto');
        expect(classifyHref('tel:+44')).toBe('tel');
        expect(classifyHref('javascript:void(0)')).toBe('script');
        expect(classifyHref('#section')).toBe('fragment');
        expect(classifyHref('ftp://x.example')).toBe('other');
    });
});

describe('urlToScanPath', () => {
    it('maps URLs to their saved location', () => {
        expect(urlToScanPath('https://bank.example/')).toBe('bank.example/index.html');
        expect(urlToScanPath('https://bank.example/loans/personal')).toBe('bank.example/loans/personal.html');
        expect(urlToScanPath('not a url')).toBeNull();
    });
});

describe('getPageDetails', () => {
    it('returns url, size, screenshot, incoming and outgoing links', async () => {
        const d = await getPageDetails(scanB, 'bank.example/2026-08-08', 'bank.example/index.html');
        expect(d.url).toBe('https://bank.example/');
        expect(d.size).toBeGreaterThan(0);
        expect(d.screenshotUrl).toBe('/output/bank.example/2026-08-08/bank.example/index.webp');
        expect(d.outgoing).toContain('https://bank.example/loans/personal');
        expect(d.outgoing).toContain('https://other.example');
    });

    it('splits outgoing links into internal and external with status', async () => {
        const { links } = await getPageDetails(scanB, 'bank.example/2026-08-08', 'bank.example/index.html');

        const personal = links.internal.find(l => l.url.endsWith('/loans/personal'));
        expect(personal.text).toBe('Personal loans');
        expect(personal.scraped).toBe(true);
        expect(personal.broken).toBe(false);
        expect(personal.pageUrl).toContain('page.html?scan=');
        // /loans/personal and /loans/personal#rates collapse to one target
        expect(personal.occurrences).toBe(2);

        const missing = links.internal.find(l => l.url.endsWith('/missing-page'));
        expect(missing.scraped).toBe(false);
        expect(missing.broken).toBe(true);
        expect(missing.pageUrl).toBeNull();

        expect(links.external.map(l => l.host).sort())
            .toEqual(['cdn.example', 'other.example', 'other.example']);
        const partner = links.external.find(l => l.url === 'https://other.example');
        expect(partner.nofollow).toBe(true);
        // anchor text survives nested markup
        expect(links.external.find(l => l.url.endsWith('/terms')).text).toBe('Terms');
    });

    it('groups external links by host, most-linked first', async () => {
        const { links } = await getPageDetails(scanB, 'bank.example/2026-08-08', 'bank.example/index.html');
        expect(links.externalHosts).toEqual([
            { host: 'other.example', count: 2 },
            { host: 'cdn.example', count: 1 },
        ]);
        expect(links.counts.brokenOut).toBe(1);
        expect(links.counts.nofollow).toBe(1);
    });

    it('resolves incoming links with the anchor text the source used', async () => {
        const d = await getPageDetails(scanB, 'bank.example/2026-08-08', 'bank.example/loans/personal.html');
        expect(d.incoming).toEqual(['https://bank.example/']);
        expect(d.screenshotUrl).toBeNull();

        const [source] = d.links.incoming;
        expect(source.url).toBe('https://bank.example/');
        expect(source.scraped).toBe(true);
        expect(source.anchorTexts).toEqual(['Personal loans']);
        expect(source.occurrences).toBe(2); // plain + #rates anchor
        expect(source.pageUrl).toContain('bank.example%2Findex.html');
    });

    it('returns null for missing pages', async () => {
        const d = await getPageDetails(scanB, 'x', 'bank.example/nope.html');
        expect(d).toBeNull();
    });
});

describe('extractPageMeta', () => {
    it('extracts title, h1s, description, canonical and lang', () => {
        const meta = extractPageMeta(
            '<html lang="en"><head><title> Home &nbsp; page </title>'
            + '<meta name="description" content="A description.">'
            + '<link rel="canonical" href="https://x.example/">'
            + '</head><body><h1><span>Main</span> heading</h1><h2>a</h2><h2>b</h2></body></html>');

        expect(meta.title).toBe('Home page');
        expect(meta.h1s).toEqual(['Main heading']);
        expect(meta.h1Count).toBe(1);
        expect(meta.h2Count).toBe(2);
        expect(meta.description).toBe('A description.');
        expect(meta.descriptionLength).toBe(14);
        expect(meta.canonical).toBe('https://x.example/');
        expect(meta.lang).toBe('en');
    });

    it('reports multiple and missing H1s', () => {
        expect(extractPageMeta('<h1>One</h1><h1>Two</h1>').h1Count).toBe(2);
        const none = extractPageMeta('<html><body><p>no headings</p></body></html>');
        expect(none.h1Count).toBe(0);
        expect(none.title).toBeNull();
        expect(none.description).toBeNull();
    });

    it('parses robots directives regardless of attribute order or case', () => {
        const meta = extractPageMeta('<meta content="NoIndex, NoFollow" name="ROBOTS">');
        expect(meta.robots.noindex).toBe(true);
        expect(meta.robots.nofollow).toBe(true);
        expect(meta.robots.directives).toEqual(['noindex', 'nofollow']);
    });

    it('treats robots "none" as noindex + nofollow and merges googlebot', () => {
        const meta = extractPageMeta('<meta name="robots" content="none"><meta name="googlebot" content="noarchive">');
        expect(meta.robots.noindex).toBe(true);
        expect(meta.robots.nofollow).toBe(true);
        expect(meta.robots.noarchive).toBe(true);
    });

    it('defaults to indexable when no robots meta is present', () => {
        const meta = extractPageMeta('<html><head><title>t</title></head></html>');
        expect(meta.robots.noindex).toBe(false);
        expect(meta.robots.directives).toEqual([]);
    });
});

describe('assessDiscoverability', () => {
    const baseMeta = (overrides = {}) => ({
        title: 'T', h1s: ['H'], h1Count: 1, h2Count: 0,
        description: 'x'.repeat(80), descriptionLength: 80,
        canonical: null, lang: 'en',
        robots: { raw: null, googlebot: null, directives: [], noindex: false, nofollow: false },
        ...overrides,
    });

    it('flags a noindex page that internal links still reach', () => {
        const meta = baseMeta({ robots: { directives: ['noindex'], noindex: true, nofollow: false } });
        const d = assessDiscoverability(meta, [{ nofollow: false }, { nofollow: false }], [], 'https://x.example/p');

        expect(d.status).toBe('noindex-but-linked');
        expect(d.indexable).toBe(false);
        expect(d.inboundFollowed).toBe(2);
        expect(d.notes[0]).toMatch(/still reachable — 2 followed internal links point here/);
    });

    it('calls an indexable page with no inbound links an orphan', () => {
        const d = assessDiscoverability(baseMeta(), [], [], 'https://x.example/p');
        expect(d.status).toBe('orphan');
        expect(d.notes.some(n => n.startsWith('Orphan'))).toBe(true);
    });

    it('flags pages reachable only via nofollow links', () => {
        const d = assessDiscoverability(baseMeta(), [{ nofollow: true }], [], 'https://x.example/p');
        expect(d.status).toBe('nofollow-links-only');
        expect(d.inboundFollowed).toBe(0);
        expect(d.inboundNofollow).toBe(1);
    });

    it('flags meta nofollow wasting the page outgoing links', () => {
        const meta = baseMeta({ robots: { directives: ['nofollow'], noindex: false, nofollow: true } });
        const d = assessDiscoverability(meta, [{ nofollow: false }], [{}, {}, {}], 'https://x.example/p');
        expect(d.followable).toBe(false);
        expect(d.notes.some(n => n.includes('3 internal links on this page are not followed'))).toBe(true);
    });

    it('detects a canonical pointing at another URL', () => {
        const meta = baseMeta({ canonical: 'https://x.example/other' });
        const d = assessDiscoverability(meta, [{ nofollow: false }], [], 'https://x.example/p');
        expect(d.status).toBe('canonicalised-away');
        expect(d.canonicalisedAway).toBe(true);
    });

    it('treats a self-referencing canonical as fine (trailing slash tolerant)', () => {
        const meta = baseMeta({ canonical: 'https://x.example/p/' });
        const d = assessDiscoverability(meta, [{ nofollow: false }], [], 'https://x.example/p');
        expect(d.canonicalisedAway).toBe(false);
        expect(d.status).toBe('indexable-and-linked');
    });

    it('notes missing H1, description and title problems', () => {
        const meta = baseMeta({ h1s: [], h1Count: 0, description: null, descriptionLength: 0, title: null });
        const d = assessDiscoverability(meta, [{ nofollow: false }], [], 'https://x.example/p');
        expect(d.notes).toContain('No H1 heading.');
        expect(d.notes).toContain('No meta description.');
        expect(d.notes).toContain('No <title>.');
    });
});

describe('getPageDetails metadata', () => {
    it('returns meta and discoverability for a saved page', async () => {
        const d = await getPageDetails(scanB, 'bank.example/2026-08-08', 'bank.example/loans/personal.html');

        expect(d.meta.title).toBe('Personal loans | Bank');
        expect(d.meta.h1s).toEqual(['Personal loans']);
        expect(d.meta.description).toMatch(/^Compare our personal loan rates/);
        expect(d.meta.lang).toBe('en-GB');
        expect(d.meta.robots.noindex).toBe(true);
        expect(d.meta.robots.nofollow).toBe(false);

        // Linked from the index page, yet noindex — the conflict we care about.
        expect(d.discoverability.status).toBe('noindex-but-linked');
        expect(d.discoverability.inboundFollowed).toBe(1);
        expect(d.discoverability.canonicalisedAway).toBe(false);
        expect(d.discoverability.headerRobotsChecked).toBe(false);
    });
});

describe('getInboundIndex (issue #19)', () => {
    let noCrawlScan;

    beforeAll(async () => {
        // A sitemap/batch-style scan: pages saved, NO incoming-links.json.
        noCrawlScan = path.join(root, 'nocrawl');
        const page = (url, body) => `<!-- ${url} -->\n<html><body>${body}</body></html>`;
        await write(noCrawlScan, 'shop.example/index.html',
            page('https://shop.example/', '<a href="https://shop.example/deals">Deals</a>'));
        await write(noCrawlScan, 'shop.example/about.html',
            page('https://shop.example/about',
                '<h1>About the shop</h1><a href="https://shop.example/deals">Today’s deals</a>'));
        await write(noCrawlScan, 'shop.example/help.html',
            page('https://shop.example/help', '<a href="https://shop.example/deals">Deals</a><a href="https://shop.example/deals#top">Deals anchor</a>'));
        await write(noCrawlScan, 'shop.example/deals.html',
            page('https://shop.example/deals', '<a href="https://shop.example/">Home</a>'));
        await write(noCrawlScan, 'shop.example/lonely.html',
            page('https://shop.example/lonely', '<p>nothing links here</p>'));
    });

    it('finds every linking page without any crawl artifact', async () => {
        const { index } = await getInboundIndex(noCrawlScan);
        const sources = index.get('shop.example/deals.html');
        expect(sources.map(s => s.path).sort())
            .toEqual(['shop.example/about.html', 'shop.example/help.html', 'shop.example/index.html']);
    });

    it('keeps the anchor text each source used', async () => {
        const { index } = await getInboundIndex(noCrawlScan);
        const about = index.get('shop.example/deals.html')
            .find(s => s.path === 'shop.example/about.html');
        expect(about.anchorTexts).toEqual(['Today’s deals']);
        expect(about.url).toBe('https://shop.example/about');
        expect(about.scraped).toBe(true);
    });

    it('collapses repeat links from one source into an occurrence count', async () => {
        const { index } = await getInboundIndex(noCrawlScan);
        const help = index.get('shop.example/deals.html')
            .find(s => s.path === 'shop.example/help.html');
        expect(help.occurrences).toBe(2); // /deals and /deals#top
    });

    it('attaches each source page’s H1 so links can be labelled by page', async () => {
        const { index, pageMeta } = await getInboundIndex(noCrawlScan);
        expect(pageMeta.get('shop.example/about.html').h1).toBe('About the shop');
        const about = index.get('shop.example/deals.html')
            .find(s => s.path === 'shop.example/about.html');
        expect(about.h1).toBe('About the shop');
    });

    it('leaves genuinely unlinked pages out of the index', async () => {
        const { index } = await getInboundIndex(noCrawlScan);
        expect(index.has('shop.example/lonely.html')).toBe(false);
    });

    it('reports inbound links through getPageDetails with no crawl data', async () => {
        const d = await getPageDetails(noCrawlScan, 'shop.example/2026-08-08', 'shop.example/deals.html');
        expect(d.links.counts.incoming).toBe(3);
        expect(d.links.incoming[0].pageUrl).toContain('page.html?scan=');
    });

    it('rebuilds the index when a page changes', async () => {
        const before = (await getInboundIndex(noCrawlScan)).index.get('shop.example/deals.html').length;
        await new Promise(r => setTimeout(r, 12)); // ensure a new mtime
        await write(noCrawlScan, 'shop.example/extra.html',
            '<!-- https://shop.example/extra -->\n<html><a href="https://shop.example/deals">More deals</a></html>');
        const after = (await getInboundIndex(noCrawlScan)).index.get('shop.example/deals.html').length;
        expect(after).toBe(before + 1);
    });
});

describe('link type reporting', () => {
    it('separates mailto/tel/javascript/fragment links from page links', async () => {
        const mixedScan = path.join(root, 'mixed');
        await write(mixedScan, 'x.example/index.html',
            '<!-- https://x.example/ -->\n<html>'
            + '<a href="mailto:hi@x.example">Email us</a>'
            + '<a href="tel:+441234567">Call us</a>'
            + '<a href="javascript:openChat()">Chat</a>'
            + '<a href="#main">Skip to content</a>'
            + '<a href="https://x.example/about">About</a>'
            + '</html>');

        const d = await getPageDetails(mixedScan, 'x.example/2026-08-08', 'x.example/index.html');
        expect(d.links.counts.other).toBe(4);
        expect(d.links.other.map(o => o.kind).sort())
            .toEqual(['fragment', 'mailto', 'script', 'tel']);
        expect(d.links.other.find(o => o.kind === 'mailto').text).toBe('Email us');
        // The real page link is still classified as internal.
        expect(d.links.counts.internal).toBe(1);
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
