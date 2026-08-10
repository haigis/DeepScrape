import { describe, it, expect } from 'vitest';
import { rateFindingsV3, reachFactor, PILLARS_V3 } from '../src/rating.js';
import { analyzePageExtractability, checkExtractability } from '../src/extractability.js';
import { parseRobots, isFullyBlocked, analyzeAccess } from '../src/access.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const finding = (over = {}) => ({
    id: 'f1',
    category: 'facts',
    severity: 'high',
    pagesAffected: 10,
    ...over,
});

describe('rating v3 formula', () => {
    it('pillar weights sum to 1', () => {
        const total = Object.values(PILLARS_V3).reduce((s, p) => s + p.weight, 0);
        expect(Math.round(total * 100)).toBe(100);
    });

    it('scores 100 with no findings', () => {
        const rating = rateFindingsV3([], 50);
        expect(rating.score).toBe(100);
        expect(rating.grade).toBe('A');
        expect(rating.methodologyVersion).toBe('rating.v3-shadow');
    });

    it('reach floors at 0.25 and saturates at ~10% of the site', () => {
        expect(reachFactor(1, 10000)).toBeCloseTo(0.25, 1);
        expect(reachFactor(1000, 10000)).toBe(1);
        expect(reachFactor(5, 50)).toBe(1); // max(5, 0.1×50)=5 pages saturates
    });

    it('confidence discounts heuristic findings', () => {
        const confirmed = rateFindingsV3([finding({ confidence: 'confirmed', pagesAffected: 100 })], 100);
        const weak = rateFindingsV3([finding({ confidence: 'weak', pagesAffected: 100 })], 100);
        expect(100 - weak.score).toBeLessThan(100 - confirmed.score);
    });

    it('attributes lost points exactly per pillar', () => {
        const rating = rateFindingsV3([
            finding({ id: 'a', pagesAffected: 50 }),
            finding({ id: 'b', severity: 'medium', pagesAffected: 5 }),
        ], 100);
        const attributed = rating.attribution.reduce((s, a) => s + a.pointsCost, 0);
        expect(Math.round(attributed * 10) / 10).toBe(rating.pillars.facts.lostPoints);
    });

    it('routes access and extractability findings to their pillars', () => {
        const rating = rateFindingsV3([
            finding({ id: 'x', category: 'access' }),
            finding({ id: 'y', category: 'extractability' }),
        ], 100);
        expect(rating.pillars.access.findings).toBe(1);
        expect(rating.pillars.extractability.findings).toBe(1);
        expect(rating.pillars.facts.findings).toBe(0);
    });
});

describe('extractability analysis', () => {
    it('profiles semantic structure and question headings', () => {
        const profile = analyzePageExtractability(
            '<html><body><main><h2>How do refunds work?</h2><table><tr><td>x</td></tr></table>' +
            '<time datetime="2026-01-01">Jan</time></main></body></html>');
        expect(profile.hasMain).toBe(true);
        expect(profile.questionHeadings).toBe(1);
        expect(profile.hasTable).toBe(true);
        expect(profile.hasTime).toBe(true);
    });

    it('spots facts that only exist in image alt text', () => {
        const profile = analyzePageExtractability(
            '<html><body><main><p>Call us today.</p><img alt="Call 0141 555 0192"></main></body></html>');
        expect(profile.factsOnlyInImages.length).toBe(1);
    });

    it('flags a site with no semantic containers', () => {
        const pages = Array.from({ length: 10 }, (_, i) => ({
            path: `p${i}.html`,
            extract: analyzePageExtractability('<html><body><div>plain text</div></body></html>'),
        }));
        const findings = checkExtractability(pages);
        expect(findings.some(f => f.id === 'extract-no-semantic-main')).toBe(true);
        const semantic = findings.find(f => f.id === 'extract-no-semantic-main');
        expect(semantic.severity).toBe('medium'); // >80% of pages
        expect(semantic.confidence).toBe('strong');
    });

    it('stays quiet on a well-structured site', () => {
        const html = '<html><body><main><h2>What is Acme?</h2><time datetime="2026-01-01">Jan</time></main></body></html>';
        const pages = Array.from({ length: 6 }, (_, i) => ({
            path: `p${i}.html`,
            extract: analyzePageExtractability(html),
        }));
        expect(checkExtractability(pages)).toEqual([]);
    });
});

describe('access analysis', () => {
    it('parses robots groups and full blocks', () => {
        const groups = parseRobots('User-agent: *\nDisallow: /admin\n\nUser-agent: GPTBot\nDisallow: /');
        expect(isFullyBlocked(groups, 'GPTBot')).toBe(true);
        expect(isFullyBlocked(groups, 'ClaudeBot')).toBe(false); // falls to *, /admin only
    });

    it('flags a blanket disallow as high/confirmed and a half AI policy as low', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ds-access-'));
        const fetchFor = (robots) => async (url) =>
            url.endsWith('robots.txt')
                ? { ok: true, text: async () => robots }
                : { ok: false };

        const blanket = await analyzeAccess(dir, 'x.com', {
            network: true,
            fetchImpl: fetchFor('User-agent: *\nDisallow: /'),
        });
        expect(blanket.findings.some(f => f.id === 'access-blanket-disallow' && f.severity === 'high')).toBe(true);

        const half = await analyzeAccess(dir, 'x.com', {
            network: true,
            fetchImpl: fetchFor('User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nDisallow:'),
        });
        expect(half.findings.some(f => f.id === 'access-inconsistent-ai-policy')).toBe(true);
        expect(half.findings.some(f => f.id === 'access-blanket-disallow')).toBe(false);

        await fs.rm(dir, { recursive: true, force: true });
    });

    it('does not penalise a deliberate full AI block', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ds-access-'));
        const allAi = ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'anthropic-ai', 'Claude-Web',
            'Google-Extended', 'PerplexityBot', 'CCBot', 'Applebot-Extended', 'Bytespider', 'meta-externalagent']
            .map(ua => `User-agent: ${ua}\nDisallow: /`).join('\n\n');
        const result = await analyzeAccess(dir, 'x.com', {
            network: true,
            fetchImpl: async (url) => url.endsWith('robots.txt')
                ? { ok: true, text: async () => allAi + '\n\nUser-agent: *\nDisallow:' }
                : { ok: false },
        });
        expect(result.metrics.aiPolicy).toBe('all-blocked');
        expect(result.findings.some(f => f.id === 'access-inconsistent-ai-policy')).toBe(false);
        expect(result.findings.some(f => f.id === 'access-blanket-disallow')).toBe(false);
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('reports a missing llms.txt as a low confirmed finding', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ds-access-'));
        const result = await analyzeAccess(dir, 'x.com', {
            network: true,
            fetchImpl: async () => ({ ok: false }),
        });
        const llms = result.findings.find(f => f.id === 'access-no-llms-txt');
        expect(llms?.severity).toBe('low');
        expect(result.metrics.llmsTxt).toBe('absent');
        await fs.rm(dir, { recursive: true, force: true });
    });
});
