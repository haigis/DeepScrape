import { describe, it, expect } from 'vitest';
import { collectAssetUrls, assetFileName, rewriteForOffline } from '../src/offline.js';

describe('collectAssetUrls', () => {
    const urlsOf = (html, base) => collectAssetUrls(html, base).map(r => r.url);

    it('resolves protocol-relative and root-relative references', () => {
        // srcset is never absolutised at save time — this is how Wikipedia's
        // //upload.wikimedia.org images escaped the first implementation.
        const refs = collectAssetUrls(
            '<img srcset="//upload.example/a.png 1x, /local/b.png 2x">',
            'https://en.example/wiki/Page');

        expect(refs).toEqual(expect.arrayContaining([
            { raw: '//upload.example/a.png', url: 'https://upload.example/a.png' },
            { raw: '/local/b.png', url: 'https://en.example/local/b.png' },
        ]));
    });

    it('finds images, scripts, stylesheets, icons and srcset candidates', () => {
        const urls = urlsOf(`
            <link rel="stylesheet" href="https://cdn.example/app.css">
            <link rel="icon" href="https://cdn.example/favicon.ico">
            <link rel="preconnect" href="https://analytics.example">
            <script src="https://cdn.example/app.js"></script>
            <img src="https://cdn.example/hero.png"
                 srcset="https://cdn.example/hero@1x.png 1x, https://cdn.example/hero@2x.png 2x">
            <div style="background: url('https://cdn.example/bg.jpg')"></div>
        `);

        expect(urls).toEqual(expect.arrayContaining([
            'https://cdn.example/app.css',
            'https://cdn.example/favicon.ico',
            'https://cdn.example/app.js',
            'https://cdn.example/hero.png',
            'https://cdn.example/hero@1x.png',
            'https://cdn.example/hero@2x.png',
            'https://cdn.example/bg.jpg',
        ]));
        // preconnect is a hint, not an asset to download
        expect(urls).not.toContain('https://analytics.example');
    });

    it('ignores data URLs, and relative refs with no base to resolve against', () => {
        expect(urlsOf('<img src="data:image/png;base64,AAA">')).toEqual([]);
        expect(urlsOf('<img src="/local.png">')).toEqual([]);
    });

    it('does not treat iframes as page assets', () => {
        expect(urlsOf('<iframe src="https://embed.example/x"></iframe>')).toEqual([]);
    });
});

describe('assetFileName', () => {
    it('keeps a readable stem and appends a URL hash', () => {
        const name = assetFileName('https://cdn.example/css/app.css');
        expect(name).toMatch(/^app-[0-9a-f]{10}\.css$/);
    });

    it('gives different URLs different names even with the same basename', () => {
        const a = assetFileName('https://cdn.example/v1/app.css');
        const b = assetFileName('https://cdn.example/v2/app.css');
        expect(a).not.toBe(b);
    });

    it('is stable for the same URL', () => {
        expect(assetFileName('https://cdn.example/a.png')).toBe(assetFileName('https://cdn.example/a.png'));
    });

    it('derives an extension from the content type when the URL has none', () => {
        expect(assetFileName('https://cdn.example/style', 'text/css; charset=utf-8')).toMatch(/\.css$/);
    });

    it('prefers the content type over a misleading URL extension', () => {
        // Wikipedia serves stylesheets from load.php; saving as .php makes
        // browsers reject the stylesheet on MIME grounds.
        const name = assetFileName('https://en.wikipedia.org/w/load.php?modules=x', 'text/css');
        expect(name).toMatch(/^load-[0-9a-f]{10}\.css$/);
    });
});

describe('rewriteForOffline', () => {
    const map = new Map([
        ['https://cdn.example/app.css', '../_assets/app-abc.css'],
        ['https://cdn.example/hero.png', '../_assets/hero-def.png'],
    ]);

    it('repoints asset URLs at the local copies', () => {
        const out = rewriteForOffline(
            '<head><link rel="stylesheet" href="https://cdn.example/app.css"></head>'
            + '<body><img src="https://cdn.example/hero.png"></body>', map);

        expect(out).toContain('href="../_assets/app-abc.css"');
        expect(out).toContain('src="../_assets/hero-def.png"');
        expect(out).not.toContain('https://cdn.example/app.css');
    });

    it('injects a CSP that blocks off-origin requests', () => {
        const out = rewriteForOffline('<html><head><title>t</title></head></html>', new Map());
        expect(out).toContain('Content-Security-Policy');
        expect(out).toContain("default-src 'self'");
        expect(out).toContain("connect-src 'none'");
        // must sit inside <head>, before the content it governs
        expect(out.indexOf('Content-Security-Policy')).toBeLessThan(out.indexOf('<title>'));
    });

    it('strips preconnect and dns-prefetch hints', () => {
        const out = rewriteForOffline(
            '<head><link rel="preconnect" href="https://analytics.example">'
            + '<link rel="dns-prefetch" href="https://x.example"></head>', new Map());
        expect(out).not.toContain('preconnect');
        expect(out).not.toContain('dns-prefetch');
    });

    it('leaves navigational anchors absolute so link analysis still works', () => {
        const out = rewriteForOffline(
            '<head></head><body><a href="https://site.example/about">About</a></body>', map);
        expect(out).toContain('href="https://site.example/about"');
    });

    it('adds the CSP even when the page has no head element', () => {
        const out = rewriteForOffline('<div>fragment</div>', new Map());
        expect(out.startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true);
    });
});
