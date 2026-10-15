import { describe, it, expect } from 'vitest';
import { normalizeUrl, createTrapGuard } from '../src/spider.js';
import { createRobots } from '../src/robots.js';

describe('normalizeUrl noise', () => {
    it('collapses search-form permutations of one page', () => {
        const a = normalizeUrl('https://x.test/help/insurance?_charset_=UTF-8&back=%2Fa&direct=true&q=&spellcheck=+++');
        const b = normalizeUrl('https://x.test/help/insurance?direct=true');
        expect(a).toBe(b);
    });
    it('strips jsessionid path params and double slashes', () => {
        expect(normalizeUrl('https://x.test//a//b;jsessionid=ABC123?x=1')).toBe('https://x.test/a/b?x=1');
    });
});

describe('trap guard', () => {
    it('caps distinct query variants of one page shape', () => {
        const guard = createTrapGuard(5);
        let admitted = 0;
        for (let offset = 0; offset < 100; offset += 10) {
            if (guard.admit(`https://x.test/search?offset=${offset}&q=a`).ok) admitted++;
        }
        expect(admitted).toBe(5);
        expect(Object.values(guard.skipped())[0]).toBe(5);
    });
    it('never limits plain paths', () => {
        const guard = createTrapGuard(1);
        for (let i = 0; i < 50; i++) expect(guard.admit(`https://x.test/p${i}`).ok).toBe(true);
    });
    it('treats different parameter sets as different shapes', () => {
        const guard = createTrapGuard(1);
        expect(guard.admit('https://x.test/s?page=1').ok).toBe(true);
        expect(guard.admit('https://x.test/s?page=2').ok).toBe(false);
        expect(guard.admit('https://x.test/s?cat=1').ok).toBe(true);
    });
    it('rejects repeating path segments and absurd depth', () => {
        const guard = createTrapGuard();
        expect(guard.admit('https://x.test/a/b/a/b/a/b').reason).toBe('repeating-path');
        expect(guard.admit('https://x.test/' + 'abcdefghijklmnop'.split('').map(c => c + c).join('/')).reason).toBe('path-too-deep');
    });
});

describe('robots.txt', () => {
    const txt = `User-agent: *\nDisallow: /private\nAllow: /private/public\nCrawl-delay: 2\n\nUser-agent: DeepScrape\nDisallow: /nope$\n`;
    it('prefers the group naming us, and its rules only', () => {
        const r = createRobots(txt);
        expect(r.allowed('/nope')).toBe(false);
        expect(r.allowed('/nope/x')).toBe(true);
        expect(r.allowed('/private')).toBe(true);
    });
    it('falls back to * with longest-match and crawl-delay', () => {
        const r = createRobots(txt, 'OtherBot');
        expect(r.allowed('/private/x')).toBe(false);
        expect(r.allowed('/private/public/x')).toBe(true);
        expect(r.crawlDelayMs).toBe(2000);
    });
    it('allows everything when empty', () => {
        expect(createRobots('').allowed('/anything?x=1')).toBe(true);
    });
});
