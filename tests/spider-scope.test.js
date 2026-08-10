import { describe, it, expect } from 'vitest';
import { makeScope } from '../src/spider.js';

describe('makeScope', () => {
    it('allows everything when no scope is given', () => {
        const inScope = makeScope({});
        expect(inScope('https://x.com/')).toBe(true);
        expect(inScope('https://x.com/anything/deep')).toBe(true);
    });

    it('restricts to include paths when given', () => {
        const inScope = makeScope({ includePaths: ['/help'] });
        expect(inScope('https://x.com/help')).toBe(true);
        expect(inScope('https://x.com/help/faq')).toBe(true);
        expect(inScope('https://x.com/about')).toBe(false);
    });

    it('subtracts exclude paths', () => {
        const inScope = makeScope({ excludePaths: ['/branch-finder'] });
        expect(inScope('https://x.com/about')).toBe(true);
        expect(inScope('https://x.com/branch-finder')).toBe(false);
        expect(inScope('https://x.com/branch-finder/glasgow')).toBe(false);
    });

    it('does not treat a path as a prefix of a longer sibling name', () => {
        const inScope = makeScope({ excludePaths: ['/blog'] });
        expect(inScope('https://x.com/blog/post')).toBe(false);
        expect(inScope('https://x.com/blogroll')).toBe(true);
    });

    it('applies excludes on top of includes', () => {
        const inScope = makeScope({ includePaths: ['/help'], excludePaths: ['/help/archive'] });
        expect(inScope('https://x.com/help/faq')).toBe(true);
        expect(inScope('https://x.com/help/archive/2019')).toBe(false);
    });

    it('honours the legacy pathPrefix as an include', () => {
        const inScope = makeScope({ pathPrefix: 'help' });
        expect(inScope('https://x.com/help/faq')).toBe(true);
        expect(inScope('https://x.com/about')).toBe(false);
    });

    it('rejects unparseable URLs', () => {
        expect(makeScope({})('not-a-url')).toBe(false);
    });

    it('reflects excludes added after the scope was built (live excludes)', () => {
        // The spider rebuilds a scope per check from a mutable array, so
        // an exclude pushed mid-crawl takes effect on the next URL.
        const dynamicExcludes = [];
        const excluded = (url) => !makeScope({ excludePaths: dynamicExcludes })(url);

        expect(excluded('https://x.com/branch-finder/glasgow')).toBe(false);
        dynamicExcludes.push('/branch-finder');
        expect(excluded('https://x.com/branch-finder/glasgow')).toBe(true);
        expect(excluded('https://x.com/about')).toBe(false);
    });
});
