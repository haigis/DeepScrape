import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildConsistencyReport } from '../src/consistency.js';

process.env.DS_V3_NETWORK = 'false';

let scan;

const write = async (rel, content) => {
    const abs = path.join(scan, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
};

const page = (url, head, body) =>
    `<!-- ${url} -->\n<html lang="en"><head>${head}</head><body>${body}</body></html>`;

const org = (props) => `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org', '@type': 'Organization', name: 'Acme Ltd', ...props,
})}</script>`;

const currentYear = new Date().getFullYear();

const report = () => buildConsistencyReport(scan, 'test.example/2026-08-10');
const byId = (r, id) => r.findings.find(f => f.id === id);

beforeAll(async () => {
    scan = await fs.mkdtemp(path.join(os.tmpdir(), 'ds-v3checks-'));
});

afterAll(async () => {
    await fs.rm(scan, { recursive: true, force: true });
});

describe('temporal + entity checks (issues #36/#37)', () => {
    it('finds stale and mixed copyright years, phone parity, and sameAs drift', async () => {
        await write('a.html', page('https://test.example/a',
            `<title>A</title>${org({ telephone: '0141 555 0192', sameAs: ['https://linkedin.com/company/acme'] })}`,
            `<h1>A</h1><p>Call 0141 555 0192.</p><p>© ${currentYear}</p>`));
        await write('b.html', page('https://test.example/b',
            `<title>B</title>${org({ telephone: '0141 555 0300', sameAs: ['https://wikidata.org/wiki/Q1'] })}`,
            `<h1>B</h1><p>Call 0141 555 0192.</p><p>© ${currentYear - 3}</p>`));
        await write('c.html', page('https://test.example/c',
            '<title>C</title>',
            `<h1>C</h1><p>Copyright ${currentYear - 4}</p>`));

        const r = await report();

        // Temporal: b and c are stale; three distinct years are mixed.
        const stale = byId(r, 'temporal-stale-copyright');
        expect(stale).toBeDefined();
        expect(stale.pagesAffected).toBe(2);
        expect(stale.confidence).toBe('confirmed');
        expect(byId(r, 'temporal-mixed-copyright-years')).toBeDefined();

        // Cross-format parity: b's JSON-LD says 0300, its page says 0192.
        const parity = byId(r, 'jsonld-page-phone-mismatch');
        expect(parity).toBeDefined();
        expect(parity.pagesAffected).toBe(1);
        expect(parity.confidence).toBe('strong');

        // sameAs: two different sets across pages.
        const sameAs = byId(r, 'inconsistent-sameas');
        expect(sameAs).toBeDefined();
        expect(sameAs.evidence.length).toBe(2);
    });

    it('flags a missing Organization entity only when JSON-LD exists', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ds-v3checks2-'));
        const w = (rel, c) => fs.writeFile(path.join(dir, rel), c, 'utf8');
        await w('a.html', page('https://x.example/a',
            `<title>A</title><script type="application/ld+json">{"@type":"WebSite","name":"X"}</script>`,
            `<h1>A</h1><p>© ${currentYear}</p>`));
        const r = await buildConsistencyReport(dir, 'x.example/2026-08-10');
        expect(r.findings.some(f => f.id === 'no-organization-entity')).toBe(true);
        // No sameAs finding without an Organization node to hang it on.
        expect(r.findings.some(f => f.id === 'no-sameas-anchoring')).toBe(false);
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('flags a consistent org with no sameAs at low severity', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ds-v3checks3-'));
        const w = (rel, c) => fs.writeFile(path.join(dir, rel), c, 'utf8');
        await w('a.html', page('https://y.example/a',
            `<title>A</title>${org({ telephone: '0141 555 0192' })}`,
            `<h1>A</h1><p>Call 0141 555 0192.</p><p>© ${currentYear}</p>`));
        const r = await buildConsistencyReport(dir, 'y.example/2026-08-10');
        const f = r.findings.find(x => x.id === 'no-sameas-anchoring');
        expect(f?.severity).toBe('low');
        // Parity holds — no mismatch finding.
        expect(r.findings.some(x => x.id === 'jsonld-page-phone-mismatch')).toBe(false);
        await fs.rm(dir, { recursive: true, force: true });
    });
});
