import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { waitMs } from './utils.js';

/**
 * Cookie-banner dismissal. It exists for clean screenshots — the HTML is
 * captured either way — so it must stay cheap and must never fail a page.
 *
 * Strategy, most specific first:
 *  1. Per-site config in cookie_selectors.json (a plain selector, or a
 *     path through shadow roots).
 *  2. Well-known consent-platform "reject" buttons (OneTrust, Cookiebot,
 *     Didomi, Tealium, …).
 *  3. Any visible button/link whose text reads as a refusal ("Reject
 *     optional cookies", "Only necessary", …). Searched through every
 *     shadow root and every frame — the reason a hard-coded selector
 *     path rots the moment a vendor renames a wrapper element.
 *
 * Privacy first: the generic search only ever *rejects*. It never
 * accepts tracking on a site's behalf, so a banner it cannot refuse is
 * left alone rather than agreed to.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const configCandidates = [
    path.join(here, 'cookie_selectors.json'),
    path.join(process.cwd(), 'src', 'cookie_selectors.json'),
];

let cookieConfigs = {};
for (const file of configCandidates) {
    try {
        if (!fs.existsSync(file)) continue;
        cookieConfigs = JSON.parse(fs.readFileSync(file, 'utf8'));
        console.log(`✅ Loaded cookie config for ${Object.keys(cookieConfigs).length} sites`);
        break;
    } catch (err) {
        console.error(`❌ Could not load ${file}: ${err.message}`);
    }
}

/** Reject/close buttons of common consent platforms. */
export const KNOWN_REJECT_SELECTORS = Object.freeze([
    '#onetrust-reject-all-handler',
    '#CybotCookiebotDialogBodyButtonDecline',
    '#CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll',
    '#didomi-notice-disagree-button',
    '.didomi-continue-without-agreeing',
    'button[data-testid="uc-deny-all-button"]',
    '.qc-cmp2-summary-buttons button[mode="secondary"]',
    '#truste-consent-required',
    '.truste-consent-required',
    '.cc-deny',
    '.cc-btn.cc-dismiss',
    '#cookie-reject',
    'button[aria-label="Reject all"]',
    '[data-cookiebanner="reject_button"]',
]);

/** Visible text that reads as "refuse non-essential cookies". */
const REJECT_TEXT = /^(reject|decline|deny|refuse|disagree|no,? thanks|only (accept )?(strictly )?(necessary|essential)|(necessary|essential|required) (cookies )?only|use (only )?(necessary|essential)|continue without (accepting|agreeing)|reject (all|optional|non-?essential)|decline (all|optional))/i;

/** Per-domain memory so a site without a banner costs nothing. */
const state = new Map(); // domain -> { dismissed: boolean, misses: number }
const MAX_MISSES = 3;
const POLL_MS = 400;
const POLL_BUDGET_MS = 4000;

function normalizeDomain(url) {
    try {
        return new URL(url).hostname;
    } catch {
        return url;
    }
}

/**
 * Runs in the page (or a frame): finds and clicks one dismissal control.
 * Self-contained — it is serialised into the browser.
 * @param {{ domainConfig: object|null, known: string[], rejectSource: string }} args
 * @returns {string|null} what was clicked, or null.
 */
function findAndClick({ domainConfig, known, rejectSource }) {
    const reject = new RegExp(rejectSource, 'i');

    const visible = (el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return false;
        const style = getComputedStyle(el);
        return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
    };

    // Every root worth searching: the document plus all open shadow roots.
    const roots = [];
    const collect = (root) => {
        roots.push(root);
        for (const el of root.querySelectorAll('*')) {
            if (el.shadowRoot) collect(el.shadowRoot);
        }
    };
    collect(document);

    const fire = (el, why) => {
        el.click();
        return why;
    };

    // 1. Site config: a selector, then a path through shadow roots.
    if (domainConfig?.clickSelector) {
        for (const root of roots) {
            const el = root.querySelector(domainConfig.clickSelector);
            if (el && visible(el)) return fire(el, `config selector ${domainConfig.clickSelector}`);
        }
    }
    if (domainConfig?.shadowSelectors?.length) {
        const [first, ...rest] = domainConfig.shadowSelectors;
        let el = document.querySelector(first);
        for (const sel of rest) {
            if (!el) break;
            el = (el.shadowRoot ?? el).querySelector(sel);
        }
        if (el && el !== document.querySelector(first) && visible(el)) return fire(el, 'config shadow path');
    }

    // 2. Known consent-platform reject buttons.
    for (const root of roots) {
        for (const sel of known) {
            const el = root.querySelector(sel);
            if (el && visible(el)) return fire(el, `known ${sel}`);
        }
    }

    // 3. Any control whose text is a refusal.
    const candidates = 'button, [role="button"], a, input[type="button"], input[type="submit"]';
    for (const root of roots) {
        for (const el of root.querySelectorAll(candidates)) {
            const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
            if (text.length > 0 && text.length <= 60 && reject.test(text) && visible(el)) {
                return fire(el, `text "${text}"`);
            }
        }
    }
    return null;
}

/**
 * Dismisses the cookie banner if there is one.
 * @param {object} page - Puppeteer page.
 * @param {string} url - Page URL (for the per-site config and memory).
 * @returns {Promise<boolean>} true if something was clicked.
 */
export async function handleCookieBanner(page, url) {
    const domain = normalizeDomain(url);
    const memo = state.get(domain) ?? { dismissed: false, misses: 0 };
    state.set(domain, memo);

    const args = {
        domainConfig: cookieConfigs[domain] ?? null,
        known: KNOWN_REJECT_SELECTORS,
        rejectSource: REJECT_TEXT.source,
    };

    // A banner already dismissed on this domain stays away (the consent
    // cookie lives in the shared browser) and a site that repeatedly
    // shows none is not worth waiting on: one instant look, no polling.
    const patient = !memo.dismissed && memo.misses < MAX_MISSES;
    const deadline = Date.now() + (patient ? POLL_BUDGET_MS : 0);

    for (;;) {
        for (const frame of page.frames()) {
            let clicked = null;
            try {
                clicked = await frame.evaluate(findAndClick, args);
            } catch {
                // Detached or cross-process frame mid-navigation — skip it.
            }
            if (clicked) {
                console.log(`✅ Cookie banner dismissed on ${domain} (${clicked})`);
                memo.dismissed = true;
                memo.misses = 0;
                await waitMs(500); // let the overlay animate away
                return true;
            }
        }
        if (Date.now() >= deadline) break;
        await waitMs(POLL_MS);
    }

    if (!memo.dismissed) {
        memo.misses++;
        // Quiet after the first miss: this runs on every page of a crawl.
        if (memo.misses === 1) console.log(`ℹ️ No cookie banner found on ${domain}`);
    }
    return false;
}

/** Test hook: forget what was learned about sites. */
export function resetCookieMemory() {
    state.clear();
}
