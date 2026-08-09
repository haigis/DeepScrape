import { describe, it, expect } from 'vitest';
import { classifyLinks, resolveChromeSelectors, resolveChromeGroups, DEFAULT_CHROME_SELECTORS } from '../src/chrome.js';

const page = (body) => `<html><body>${body}</body></html>`;

describe('resolveChromeSelectors', () => {
    it('returns the defaults when nothing is supplied', () => {
        const selectors = resolveChromeSelectors();
        expect(selectors.nav).toEqual(expect.arrayContaining(['nav', '[role="navigation"]']));
        expect(selectors.footer).toEqual(expect.arrayContaining(['footer']));
    });

    it('adds custom selectors to the defaults by default', () => {
        const selectors = resolveChromeSelectors({ nav: '#globalnav, .l-menu' });
        expect(selectors.nav).toEqual(expect.arrayContaining([...DEFAULT_CHROME_SELECTORS.nav, '#globalnav', '.l-menu']));
    });

    it('replaces the defaults when asked', () => {
        const selectors = resolveChromeSelectors({ nav: ['#globalnav'] }, true);
        expect(selectors.nav).toEqual(['#globalnav']);
        // Regions without an override still fall back to the defaults.
        expect(selectors.footer).toEqual([...DEFAULT_CHROME_SELECTORS.footer]);
    });
});

describe('classifyLinks', () => {
    it('separates navigation, header and footer links from content links', () => {
        const { links, chromeFound } = classifyLinks(page(`
            <header><a href="/logo">Home</a></header>
            <nav><a href="/products">Products</a><a href="/pricing">Pricing</a></nav>
            <main><p><a href="/products/widget">the widget we launched</a></p></main>
            <footer><a href="/legal">Legal</a></footer>
        `));

        const byRegion = Object.fromEntries(links.map(l => [l.href, l.region]));
        expect(byRegion['/logo']).toBe('header');
        expect(byRegion['/products']).toBe('nav');
        expect(byRegion['/pricing']).toBe('nav');
        expect(byRegion['/legal']).toBe('footer');
        expect(byRegion['/products/widget']).toBe('content');
        expect(chromeFound).toEqual({ nav: true, header: true, footer: true });
    });

    it('treats a page with no chrome as all content', () => {
        const { links, chromeFound } = classifyLinks(page('<a href="/a">a</a><a href="/b">b</a>'));
        expect(links.every(l => l.region === 'content')).toBe(true);
        expect(chromeFound).toEqual({ nav: false, header: false, footer: false });
    });

    it('recognises ARIA landmarks and class conventions', () => {
        const { links } = classifyLinks(page(`
            <div role="navigation"><a href="/n">n</a></div>
            <div class="site-footer"><a href="/f">f</a></div>
            <div id="header"><a href="/h">h</a></div>
        `));
        const byRegion = Object.fromEntries(links.map(l => [l.href, l.region]));
        expect(byRegion['/n']).toBe('nav');
        expect(byRegion['/f']).toBe('footer');
        expect(byRegion['/h']).toBe('header');
    });

    it('honours custom selectors for sites with unconventional markup', () => {
        const html = page('<div class="l-globalnav"><a href="/x">x</a></div><section><a href="/y">y</a></section>');
        const withDefaults = classifyLinks(html);
        expect(withDefaults.links.find(l => l.href === '/x').region).toBe('content');

        const withCustom = classifyLinks(html, resolveChromeSelectors({ nav: '.l-globalnav' }));
        expect(withCustom.links.find(l => l.href === '/x').region).toBe('nav');
        expect(withCustom.links.find(l => l.href === '/y').region).toBe('content');
    });

    it('classifies a nav nested inside a footer as nav', () => {
        const { links } = classifyLinks(page('<footer><nav><a href="/n">n</a></nav><a href="/f">f</a></footer>'));
        const byRegion = Object.fromEntries(links.map(l => [l.href, l.region]));
        expect(byRegion['/n']).toBe('nav');
        expect(byRegion['/f']).toBe('footer');
    });

    it('ignores a malformed selector without losing the valid ones', () => {
        const { links } = classifyLinks(
            page('<div class="ok"><a href="/x">x</a></div>'),
            resolveChromeSelectors({ nav: ['<<<broken', '.ok'] }, true),
        );
        expect(links.find(l => l.href === '/x').region).toBe('nav');
    });

    it('keeps anchor text and rel alongside the region', () => {
        const [link] = classifyLinks(page('<nav><a href="/a" rel="NOFOLLOW">Go <span>here</span></a></nav>')).links;
        expect(link).toMatchObject({ href: '/a', text: 'Go here', rel: 'nofollow', region: 'nav' });
    });
});

describe('named selector groups', () => {
    it('reports links under the custom group name', () => {
        const groups = resolveChromeGroups([
            { name: 'Mega menu', selector: '.c-header__content', enabled: true },
        ]);
        const { links } = classifyLinks(
            page('<div class="c-header__content"><a href="/m">m</a></div><main><a href="/c">c</a></main>'),
            groups,
        );
        const byHref = Object.fromEntries(links.map(l => [l.href, l.region]));
        expect(byHref['/m']).toBe('Mega menu');
        expect(byHref['/c']).toBe('content');
    });

    it('disabled groups are ignored', () => {
        const groups = resolveChromeGroups([
            { name: 'Mega menu', selector: '.c-header__content', enabled: false },
        ]);
        const { links } = classifyLinks(page('<div class="c-header__content"><a href="/m">m</a></div>'), groups);
        expect(links[0].region).toBe('content');
    });

    it('custom groups win over the built-in defaults', () => {
        const groups = resolveChromeGroups([{ name: 'Site chrome', selector: 'nav', enabled: true }]);
        const { links } = classifyLinks(page('<nav><a href="/n">n</a></nav>'), groups);
        expect(links[0].region).toBe('Site chrome');
    });

    it('defaults can be turned off entirely', () => {
        const groups = resolveChromeGroups([], { includeDefaults: false });
        const { links } = classifyLinks(page('<nav><a href="/n">n</a></nav>'), groups);
        expect(links[0].region).toBe('content');
    });

    it('supports several selectors in one group and several groups', () => {
        const groups = resolveChromeGroups([
            { name: 'Header', selector: '.c-header__content, .c-header__util' },
            { name: 'Legal', selector: '.c-legal' },
        ]);
        const { links } = classifyLinks(page(
            '<div class="c-header__util"><a href="/u">u</a></div>'
            + '<div class="c-legal"><a href="/l">l</a></div>'), groups);
        const byHref = Object.fromEntries(links.map(l => [l.href, l.region]));
        expect(byHref['/u']).toBe('Header');
        expect(byHref['/l']).toBe('Legal');
    });
});
