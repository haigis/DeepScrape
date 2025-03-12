// cookie_handler.cjs

const fs = require('fs');

// Utility: Wait for a specified number of milliseconds
async function waitMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Load cookie banner configurations from cookie_selectors.json
let cookieConfigs = {};
try {
  if (fs.existsSync('cookie_selectors.json')) {
    const configData = fs.readFileSync('cookie_selectors.json', 'utf8');
    cookieConfigs = JSON.parse(configData);
    console.log("✅ Loaded cookie_selectors.json.");
  }
} catch (err) {
  console.error("❌ Could not load cookie_selectors.json:", err.message);
}

/**
 * Dismisses the cookie banner for a given domain based on the configuration.
 * First tries a standard click (if clickSelector is provided), then
 * attempts to traverse shadow DOM elements using the provided shadowSelectors.
 *
 * @param {object} page - Puppeteer page object.
 * @param {string} domain - Domain of the current page.
 */
async function handleCookieBanner(page, domain) {
  const config = cookieConfigs[domain];
  if (!config) {
    console.log(`ℹ️ No cookie config found for: ${domain}`);
    return;
  }
  // Attempt standard selector click
  if (config.clickSelector) {
    try {
      await page.waitForSelector(config.clickSelector, { timeout: 5000 });
      await page.click(config.clickSelector);
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

module.exports = { handleCookieBanner, waitMs };
