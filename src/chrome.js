import * as cheerio from 'cheerio';

/**
 * Site chrome detection.
 *
 * Navigation, headers and footers repeat on every page, so counting
 * their links as incoming links makes every page look like it links to
 * every other page — drowning the editorial links that actually say
 * something about a page's importance.
 *
 * Links are classified by the region they sit in, so analysis can lead
 * with content links and report chrome separately.
 */

/**
 * Default selectors, applied when a scan does not specify its own.
 * Semantic elements and ARIA landmarks first (reliable), then the
 * class and id conventions most sites still use.
 */
export const DEFAULT_CHROME_SELECTORS = Object.freeze({
    nav: [
        'nav',
        '[role="navigation"]',
        '.nav', '.navigation', '.navbar', '.menu', '.main-menu', '.site-nav',
        '#nav', '#navigation', '#menu',
        '.breadcrumb', '.breadcrumbs', '[aria-label*="breadcrumb" i]',
    ],
    header: [
        'header', '[role="banner"]',
        '.header', '.site-header', '.page-header', '#header',
    ],
    footer: [
        'footer', '[role="contentinfo"]',
        '.footer', '.site-footer', '#footer',
    ],
});

/** Regions in priority order — a link in nested chrome takes the innermost. */
const REGION_ORDER = ['nav', 'footer', 'header'];

/**
 * Merges caller-supplied selectors with the defaults.
 * Accepts either a single string (comma separated) or an array per region.
 *
 * @param {{nav?: string|string[], header?: string|string[], footer?: string|string[]}} [overrides]
 * @param {boolean} [replace] - true to use only the supplied selectors.
 * @returns {{nav: string[], header: string[], footer: string[]}}
 */
export function resolveChromeSelectors(overrides = {}, replace = false) {
    const toList = (value) => {
        if (!value) return [];
        const list = Array.isArray(value) ? value : String(value).split(',');
        return list.map(s => s.trim()).filter(Boolean);
    };

    const resolved = {};
    for (const region of ['nav', 'header', 'footer']) {
        const supplied = toList(overrides[region]);
        resolved[region] = replace && supplied.length > 0
            ? supplied
            : [...DEFAULT_CHROME_SELECTORS[region], ...supplied];
    }
    return resolved;
}

/**
 * Named selector groups: the general form of chrome configuration.
 *
 * A customer names the containers their site actually uses —
 *   [{ name: "Mega menu", selector: ".c-header__content", enabled: true }]
 * — and links inside them are reported under that name instead of
 * "content". The built-in nav/header/footer detection stays on unless
 * `includeDefaults` is false.
 *
 * @param {{name: string, selector: string, enabled?: boolean}[]} [groups]
 * @param {{includeDefaults?: boolean}} [opts]
 * @returns {{name: string, selectors: string[]}[]} enabled groups only,
 *          custom groups first so they win over the generic defaults.
 */
export function resolveChromeGroups(groups = [], { includeDefaults = true } = {}) {
    const custom = (Array.isArray(groups) ? groups : [])
        .filter(g => g && g.enabled !== false && g.selector && String(g.name ?? '').trim())
        .map(g => ({
            name: String(g.name).trim().slice(0, 40),
            selectors: String(g.selector).split(',').map(s => s.trim()).filter(Boolean),
        }))
        .filter(g => g.selectors.length > 0);

    const defaults = includeDefaults
        ? ['nav', 'footer', 'header'].map(region => ({
            name: region,
            selectors: [...DEFAULT_CHROME_SELECTORS[region]],
        }))
        : [];

    return [...custom, ...defaults];
}

/**
 * Parses a page and returns a lookup that classifies each anchor.
 *
 * Cheerio gives real CSS selector support, so a customer can name the
 * containers their site actually uses ("#globalnav", ".l-footer") rather
 * than being limited to whatever patterns we guessed.
 *
 * @param {string} html
 * @param {{nav: string[], header: string[], footer: string[]}} selectors
 * @returns {{links: {href: string, text: string, rel: string, region: string}[],
 *            chromeFound: {nav: boolean, header: boolean, footer: boolean}}}
 */
export function classifyLinks(html, selectors = resolveChromeSelectors()) {
    let $;
    try {
        $ = cheerio.load(html);
    } catch {
        return { links: [], chromeFound: {} };
    }

    // Accept either the legacy {nav, header, footer} trio or the general
    // named-group list from resolveChromeGroups().
    const groups = Array.isArray(selectors)
        ? selectors
        : REGION_ORDER.map(region => ({ name: region, selectors: selectors[region] ?? [] }));

    const chromeFound = {};

    // Tag every element inside a chrome region. Earlier groups win, so
    // custom groups (listed first) beat the generic defaults.
    for (const { name: region, selectors: groupSelectors } of groups) {
        chromeFound[region] ??= false;
        for (const selector of groupSelectors) {
            let matched;
            try {
                matched = $(selector);
            } catch {
                continue; // malformed selector supplied — skip it, keep the rest
            }
            if (matched.length > 0) chromeFound[region] = true;
            matched.find('a[href], area[href]').addBack('a[href], area[href]').each((_, el) => {
                if (!el.attribs) return;
                if (!el.attribs['data-ds-region']) el.attribs['data-ds-region'] = region;
            });
        }
    }

    const links = [];
    $('a[href], area[href]').each((_, el) => {
        const href = el.attribs?.href;
        if (!href) return;
        const $el = $(el);
        const text = $el.text().replace(/\s+/g, ' ').trim().slice(0, 120)
            || (el.attribs.alt ?? '').trim();
        links.push({
            href: href.trim(),
            text,
            rel: (el.attribs.rel ?? '').toLowerCase(),
            region: el.attribs['data-ds-region'] ?? 'content',
        });
    });

    return { links, chromeFound };
}
