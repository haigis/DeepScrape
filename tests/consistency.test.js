import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildConsistencyReport } from '../src/consistency.js';

let scan;

const write = async (rel, content) => {
    const abs = path.join(scan, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
};

const page = (url, head, body) =>
    `<!-- ${url} -->\n<html lang="en"><head>${head}</head><body>${body}</body></html>`;

const findingById = (report, id) => report.findings.find(f => f.id === id);

beforeAll(async () => {
    scan = await fs.mkdtemp(path.join(os.tmpdir(), 'deepscrape-consistency-'));

    // Home: one phone, one postcode, valid Organization JSON-LD.
    await write('acme.example/index.html', page('https://acme.example/',
        '<title>Acme Bank | Home</title><meta name="description" content="Acme Bank home page with everything you need.">'
        + '<script type="application/ld+json">{"@type":"Organization","name":"Acme Bank","telephone":"0800 111 2222"}</script>',
        '<h1>Acme Bank</h1><p>Call us on 0800 111 2222. Head office SW1A 1AA.</p>'
        + '<a href="https://acme.example/savings">Savings accounts</a>'));

    // Contact: DIFFERENT phone and postcode, and a conflicting Organization name.
    await write('acme.example/contact.html', page('https://acme.example/contact',
        '<title>Contact | Acme Bank</title><meta name="description" content="Get in touch with the Acme Bank team today.">'
        + '<script type="application/ld+json">{"@type":"Organization","name":"Acme Banking Group","telephone":"0333 444 5555"}</script>',
        '<h1>Contact us</h1><p>Call 0333 444 5555 or email help@acme.example. Office M1 4WB.</p>'
        + '<a href="https://acme.example/savings">Save with us</a>'));

    // Savings: duplicate title/description with offers, broken JSON-LD, no H1.
    await write('acme.example/savings.html', page('https://acme.example/savings',
        '<title>Savings | Acme Bank</title><meta name="description" content="Shared duplicate description text used twice.">'
        + '<script type="application/ld+json">{ this is not valid json }</script>',
        '<p>Our savings rates.</p>'));

    await write('acme.example/offers.html', page('https://acme.example/offers',
        '<title>Savings | Acme Bank</title><meta name="description" content="Shared duplicate description text used twice.">',
        '<h1>Offers</h1><h1>Second heading</h1>'
        + '<a href="https://acme.example/savings">Savings deals</a>'));

    // Canonicalised away, noindex.
    await write('acme.example/legacy.html', page('https://acme.example/legacy',
        '<title>Legacy page</title><meta name="robots" content="noindex">'
        + '<link rel="canonical" href="https://acme.example/">',
        '<h1>Legacy</h1>'));
});

afterAll(async () => {
    await fs.rm(scan, { recursive: true, force: true });
});

describe('consistency report', () => {
    it('scores the scan and counts findings by severity and category', async () => {
        const report = await buildConsistencyReport(scan, 'acme.example/2026-08-08');
        expect(report.pages).toBe(5);
        expect(report.score).toBeGreaterThanOrEqual(0);
        expect(report.score).toBeLessThan(100);
        expect(report.summary.high + report.summary.medium + report.summary.low)
            .toBe(report.findings.length);
        // Highest severity first.
        expect(report.findings[0].severity).toBe('high');
    });

    it('flags contradictory phone numbers with the pages that state them', async () => {
        const report = await buildConsistencyReport(scan, 'x');
        const finding = findingById(report, 'contradictory-phone-numbers');
        expect(finding.category).toBe('facts');
        expect(finding.title).toContain('2 different phone numbers');
        const values = finding.evidence.map(e => e.value.replace(/\s/g, ''));
        expect(values).toEqual(expect.arrayContaining(['08001112222', '03334445555']));
    });

    it('flags contradictory postcodes', async () => {
        const report = await buildConsistencyReport(scan, 'x');
        expect(findingById(report, 'contradictory-postcodes').title).toContain('2 different postcodes');
    });

    it('does not invent contradictions from formatting differences', async () => {
        const formatted = await fs.mkdtemp(path.join(os.tmpdir(), 'deepscrape-fmt-'));
        await fs.mkdir(path.join(formatted, 's.example'), { recursive: true });
        await fs.writeFile(path.join(formatted, 's.example/a.html'),
            page('https://s.example/a', '<title>A</title>', '<h1>A</h1><p>Call 0800 111 2222</p>'), 'utf8');
        await fs.writeFile(path.join(formatted, 's.example/b.html'),
            page('https://s.example/b', '<title>B</title>', '<h1>B</h1><p>Call 0800 1112222</p>'), 'utf8');

        const report = await buildConsistencyReport(formatted, 'x');
        expect(findingById(report, 'contradictory-phone-numbers')).toBeUndefined();
        await fs.rm(formatted, { recursive: true, force: true });
    });

    it('detects duplicate titles and descriptions', async () => {
        const report = await buildConsistencyReport(scan, 'x');
        expect(findingById(report, 'duplicate-titles').pagesAffected).toBe(2);
        expect(findingById(report, 'duplicate-descriptions').pagesAffected).toBe(2);
    });

    it('detects missing and multiple H1s', async () => {
        const report = await buildConsistencyReport(scan, 'x');
        expect(findingById(report, 'missing-h1').pagesAffected).toBe(1);
        expect(findingById(report, 'multiple-h1').pagesAffected).toBe(1);
    });

    it('detects canonical conflicts and noindex pages', async () => {
        const report = await buildConsistencyReport(scan, 'x');
        expect(findingById(report, 'canonical-conflicts').pagesAffected).toBe(1);
        expect(findingById(report, 'noindex-pages').pagesAffected).toBe(1);
    });

    it('reports invalid JSON-LD and partial coverage', async () => {
        const report = await buildConsistencyReport(scan, 'x');
        expect(findingById(report, 'invalid-structured-data').pagesAffected).toBe(1);
        expect(findingById(report, 'partial-structured-data').title).toContain('%');
    });

    it('flags an Organization name declared two different ways', async () => {
        const report = await buildConsistencyReport(scan, 'x');
        const finding = findingById(report, 'organization-name-conflict');
        expect(finding.severity).toBe('high');
        expect(finding.evidence.map(e => e.value))
            .toEqual(expect.arrayContaining(['Acme Bank', 'Acme Banking Group']));
    });

    it('reports no structured data at all when there is none', async () => {
        const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'deepscrape-bare-'));
        await fs.mkdir(path.join(bare, 'b.example'), { recursive: true });
        await fs.writeFile(path.join(bare, 'b.example/a.html'),
            page('https://b.example/a', '<title>A</title>', '<h1>A</h1>'), 'utf8');

        const report = await buildConsistencyReport(bare, 'x');
        expect(findingById(report, 'no-structured-data').severity).toBe('high');
        await fs.rm(bare, { recursive: true, force: true });
    });

    it('returns an empty report for a scan with no pages', async () => {
        const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'deepscrape-empty-'));
        const report = await buildConsistencyReport(empty, 'x');
        expect(report).toMatchObject({ pages: 0, score: null, findings: [] });
        await fs.rm(empty, { recursive: true, force: true });
    });
});
