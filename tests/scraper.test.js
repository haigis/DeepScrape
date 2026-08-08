import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { buildPagePath, resolveOptions, defaultOptions } from '../src/scraper.js';

describe('buildPagePath', () => {
    it('maps the site root to hostname/index.html', () => {
        expect(buildPagePath('https://example.com/')).toBe(path.join('example.com', 'index.html'));
    });

    it('appends .html to extensionless paths', () => {
        const p = buildPagePath('https://example.com/about');
        expect(p.endsWith('about.html')).toBe(true);
    });

    it('does not double-append to .html paths', () => {
        const p = buildPagePath('https://example.com/page.html');
        expect(p.endsWith('page.html')).toBe(true);
        expect(p.endsWith('page.html.html')).toBe(false);
    });

    it('keeps .htm paths as-is', () => {
        const p = buildPagePath('https://example.com/legacy.htm');
        expect(p.endsWith('legacy.htm')).toBe(true);
    });

    it('strips trailing slashes', () => {
        const p = buildPagePath('https://example.com/blog/');
        expect(p.endsWith('blog.html')).toBe(true);
    });
});

describe('resolveOptions', () => {
    it('returns defaults for empty input', () => {
        expect(resolveOptions()).toEqual(defaultOptions);
    });

    it('overrides only the supplied keys', () => {
        const opts = resolveOptions({ maxDepth: 5 });
        expect(opts.maxDepth).toBe(5);
        expect(opts.rateLimit).toBe(defaultOptions.rateLimit);
        expect(opts.screenshot).toBe(false);
    });
});
