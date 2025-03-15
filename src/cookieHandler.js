import fs from 'fs';
import path from 'path';

// Utility: Wait for a specified number of milliseconds
export async function waitMs(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Load cookie banner configurations from `src/cookie_selectors.json`
let cookieConfigs = {};
const configPath = path.join(process.cwd(), 'src', 'cookie_selectors.json'); // Ensure correct path

try {
    if (fs.existsSync(configPath)) {
        const configData = fs.readFileSync(configPath, 'utf8');
        cookieConfigs = JSON.parse(configData);
        console.log("✅ Loaded cookie_selectors.json:", cookieConfigs);
    } else {
        console.error("❌ cookie_selectors.json not found at:", configPath);
    }
} catch (err) {
    console.error("❌ Could not load cookie_selectors.json:", err.message);
}

/**
 * Normalize a domain by stripping protocols and paths.
 */
function normalizeDomain(url) {
    try {
        let parsedUrl = new URL(url);
        return parsedUrl.hostname; // Return only the domain
    } catch (err) {
        return url;
    }
}

/**
 * Dismisses the cookie banner for a given domain based on the configuration.
 * First tries a standard click (if clickSelector is provided), then
 * attempts to traverse shadow DOM elements using the provided shadowSelectors.
 *
 * @param {object} page - Puppeteer page object.
 * @param {string} url - Full URL of the current page.
 */
export async function handleCookieBanner(page, url) {
    const domain = normalizeDomain(url); // Ensure correct domain lookup
    console.log(`🔍 Checking for cookie banner on: ${domain}`);

    const config = cookieConfigs[domain];
    if (!config) {
        console.log(`ℹ️ No cookie config found for: ${domain}`);
        console.log(`ℹ️ Available configs: ${Object.keys(cookieConfigs).join(', ')}`); // Debugging info
        return;
    }

    // Attempt standard selector click
    if (config.clickSelector) {
        try {
            console.log(`🔍 Trying to click: ${config.clickSelector}`);
            await page.waitForSelector(config.clickSelector, { timeout: 5000 });
            await page.evaluate((selector) => {
                let btn = document.querySelector(selector);
                if (btn) btn.click();
            }, config.clickSelector);
            console.log(`✅ Cookie banner dismissed via selector: ${config.clickSelector}`);
            await waitMs(2000);
            return;
        } catch (e) {
            console.log(`⚠️ Failed standard selector dismissal for ${domain}: ${e.message}`);
        }
    }

    // Attempt shadow DOM-based dismissal
    if (config.shadowSelectors) {
        try {
            console.log(`🔍 Attempting shadow DOM dismissal`);
            const shadowDismissed = await page.evaluate((selectors) => {
                function traverseShadow(selectors) {
                    let el = document.querySelector(selectors[0]);
                    if (!el) return null;
                    for (let i = 1; i < selectors.length; i++) {
                        if (!el.shadowRoot) return null;
                        el = el.shadowRoot.querySelector(selectors[i]);
                        if (!el) return null;
                    }
                    return el;
                }
                const btn = traverseShadow(selectors);
                if (btn) {
                    btn.click();
                    return true;
                }
                return false;
            }, config.shadowSelectors);

            if (shadowDismissed) {
                console.log(`✅ Cookie banner dismissed via Shadow DOM for ${domain}`);
                await waitMs(3000);
                return;
            } else {
                console.log(`⚠️ Shadow DOM cookie dismissal failed for ${domain}`);
            }
        } catch (e) {
            console.log(`⚠️ Error during shadow DOM dismissal for ${domain}: ${e.message}`);
        }
    }
}
