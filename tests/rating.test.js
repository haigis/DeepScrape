import { describe, it, expect } from 'vitest';
import { rateFindings, gradeOf, METHODOLOGY_VERSION, PILLARS } from '../src/rating.js';

const finding = (id, category, severity, pagesAffected) => ({ id, category, severity, pagesAffected });

describe('rating v2', () => {
    it('returns a perfect score for no findings', () => {
        const rating = rateFindings([], 50);
        expect(rating.score).toBe(100);
        expect(rating.grade).toBe('A');
        expect(rating.methodologyVersion).toBe(METHODOLOGY_VERSION);
        expect(rating.verdict).toMatch(/one voice/);
        for (const pillar of Object.values(rating.pillars)) {
            expect(pillar.score).toBe(100);
            expect(pillar.lostPoints).toBe(0);
        }
    });

    it('weights pillar scores into the overall (facts heaviest)', () => {
        const factsHit = rateFindings([finding('f', 'facts', 'high', 50)], 50);
        const termHit = rateFindings([finding('t', 'terminology', 'high', 50)], 50);
        // Same finding severity/spread, but facts carry 35% vs terminology 15%.
        expect(factsHit.score).toBeLessThan(termHit.score);
        expect(factsHit.pillars.facts.score).toBe(termHit.pillars.terminology.score);
    });

    it('normalises by site size: same spread proportion, same score', () => {
        const small = rateFindings([finding('a', 'facts', 'high', 5)], 10);
        const large = rateFindings([finding('a', 'facts', 'high', 1500)], 3000);
        expect(small.score).toBe(large.score);
    });

    it('scales cost with spread, with a floor for single-page findings', () => {
        const narrow = rateFindings([finding('a', 'facts', 'high', 1)], 100);
        const wide = rateFindings([finding('a', 'facts', 'high', 100)], 100);
        expect(wide.score).toBeLessThan(narrow.score);
        // Even one page costs something real.
        expect(narrow.score).toBeLessThan(100);
    });

    it('attributes lost points exactly: attributions sum to pillar losses', () => {
        const rating = rateFindings([
            finding('p1', 'facts', 'high', 30),
            finding('p2', 'facts', 'medium', 10),
            finding('m1', 'metadata', 'low', 5),
        ], 60);

        for (const [pillarId, pillar] of Object.entries(rating.pillars)) {
            const sum = rating.attribution
                .filter(a => a.pillar === pillarId)
                .reduce((total, a) => total + a.pointsCost, 0);
            expect(Math.abs(sum - pillar.lostPoints)).toBeLessThan(0.15);
        }
    });

    it('saturates a pillar instead of going negative', () => {
        const findings = Array.from({ length: 12 }, (_, i) => finding(`f${i}`, 'facts', 'high', 50));
        const rating = rateFindings(findings, 50);
        expect(rating.pillars.facts.score).toBe(0);
        expect(rating.score).toBeGreaterThanOrEqual(0);
    });

    it('files findings with unknown categories under metadata rather than dropping them', () => {
        const rating = rateFindings([finding('x', 'mystery', 'high', 10)], 10);
        expect(rating.pillars.metadata.lostPoints).toBeGreaterThan(0);
        expect(rating.attribution[0].pillar).toBe('metadata');
    });

    it('names the costliest pillar in the verdict', () => {
        const rating = rateFindings([
            finding('f', 'facts', 'high', 40),
            finding('t', 'terminology', 'low', 2),
        ], 40);
        expect(rating.verdict).toContain('Contradictory facts');
    });

    it('maps grades to the documented bands', () => {
        expect(gradeOf(95)).toBe('A');
        expect(gradeOf(90)).toBe('A');
        expect(gradeOf(75)).toBe('B');
        expect(gradeOf(60)).toBe('C');
        expect(gradeOf(40)).toBe('D');
        expect(gradeOf(39)).toBe('F');
    });

    it('pillar weights sum to 1', () => {
        const total = Object.values(PILLARS).reduce((sum, p) => sum + p.weight, 0);
        expect(Math.abs(total - 1)).toBeLessThan(1e-9);
    });
});
