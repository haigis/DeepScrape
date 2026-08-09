import { describe, it, expect } from 'vitest';
import { normalizeUrl } from '../src/spider.js';

describe('normalizeUrl (duplicate avoidance)', () => {
    it('strips fragments', () => {
        expect(normalizeUrl('https://x.example/page#section')).toBe('https://x.example/page');
    });

    it('strips tracking parameters but keeps meaningful ones', () => {
        expect(normalizeUrl('https://x.example/page?utm_source=tw&utm_medium=social&page=2'))
            .toBe('https://x.example/page?page=2');
        expect(normalizeUrl('https://x.example/p?gclid=abc&fbclid=def'))
            .toBe('https://x.example/p');
    });

    it('sorts remaining query params so orderings match', () => {
        expect(normalizeUrl('https://x.example/p?b=2&a=1'))
            .toBe(normalizeUrl('https://x.example/p?a=1&b=2'));
    });

    it('collapses trailing-slash twins but keeps the root slash', () => {
        expect(normalizeUrl('https://x.example/page/')).toBe('https://x.example/page');
        expect(normalizeUrl('https://x.example/')).toBe('https://x.example/');
    });

    it('leaves already-canonical URLs untouched', () => {
        expect(normalizeUrl('https://x.example/a/b?q=1')).toBe('https://x.example/a/b?q=1');
    });
});
