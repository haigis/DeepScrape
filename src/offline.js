import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import axios from 'axios';
import { HTTP_USER_AGENT } from './scraper.js';
import { waitMs } from './utils.js';

/**
 * Makes a saved page a self-contained offline copy: every asset it
 * needs to render (stylesheets, scripts, images, fonts, and url()
 * references inside CSS) is downloaded into the scan and the markup is
 * rewritten to point at the local files.
 *
 * Navigational `<a href>` links are deliberately left absolute — they
 * are not fetched until clicked, and link analysis depends on them.
 */

/** Assets are shared across a scan so repeated files download once. */
export const ASSET_DIR = '_assets';

/** Caps so one hostile page cannot fill the disk. */
const MAX_ASSETS_PER_PAGE = 300;
const MAX_ASSET_BYTES = 12 * 1024 * 1024;
const MAX_CSS_DEPTH = 3;
/** Parallel asset fetches per page. */
const assetConcurrency = () => Math.max(1, Math.min(16, Number(process.env.DS_ASSET_CONCURRENCY) || 6));

/**
 * What each scan has already fetched: url -> { local } (null = failed).
 *
 * Pages of one site share almost all their assets, and before this
 * every page fetched every asset again — 200 sequential requests per
 * page on a big site, which on a slow CDN alone exceeded the page
 * deadline and lost the page. Failures are remembered too, so a dead
 * host costs one page its retries, not every page after it.
 */
const scanCaches = new Map();
const MAX_SCAN_CACHES = 8;
function cacheFor(scanDir) {
    let cache = scanCaches.get(scanDir);
    if (!cache) {
        cache = new Map();
        scanCaches.set(scanDir, cache);
        while (scanCaches.size > MAX_SCAN_CACHES) scanCaches.delete(scanCaches.keys().next().value);
    }
    return cache;
}

/** Test hook: forget everything fetched so far. */
export function resetAssetCache() {
    scanCaches.clear();
}

const EXT_BY_TYPE = {
    'text/css': '.css',
    'text/javascript': '.js',
    'application/javascript': '.js',
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'image/x-icon': '.ico',
    'font/woff2': '.woff2',
    'font/woff': '.woff',
    'font/ttf': '.ttf',
};

/**
 * Stable local filename for an asset URL: readable stem + content hash,
 * so different URLs never collide and the same URL is reused.
 * @param {string} url
 * @param {string} [contentType]
 * @returns {string}
 */
export function assetFileName(url, contentType = '') {
    const parsed = new URL(url);
    const base = path.posix.basename(parsed.pathname) || 'asset';
    const hash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 10);

    const stem = base.replace(/[^a-z0-9._-]+/gi, '-').slice(0, 60);
    const urlExt = path.posix.extname(stem);

    // Prefer the extension implied by the content type. Bundlers often
    // serve CSS/JS from extensionless or misleading URLs (Wikipedia's
    // load.php returns text/css); saving those as .php makes browsers
    // reject the stylesheet on MIME grounds when the copy is viewed.
    const typeExt = EXT_BY_TYPE[contentType.split(';')[0].trim().toLowerCase()] ?? '';
    const ext = typeExt || urlExt;

    const withoutExt = urlExt ? stem.slice(0, -urlExt.length) : stem;
    return `${withoutExt || 'asset'}-${hash}${ext}`;
}

/**
 * Collects the asset references in a page's HTML.
 *
 * Returns `{raw, url}` pairs: `raw` is the exact string in the markup
 * (so it can be rewritten verbatim) and `url` is the absolute URL to
 * download. Protocol-relative (`//host/x`) and root-relative (`/x`)
 * references are resolved against the page URL — `srcset` in particular
 * is never absolutised at save time, which is how Wikipedia's
 * `//upload.wikimedia.org` images escaped the first implementation.
 *
 * @param {string} html
 * @param {string} [baseUrl] - Page URL, used to resolve relative refs.
 * @returns {{raw: string, url: string}[]}
 */
export function collectAssetUrls(html, baseUrl) {
    const found = new Map(); // raw string -> absolute URL
    const add = (value) => {
        if (!value) return;
        const raw = value.trim();
        if (!raw || raw.startsWith('data:') || raw.startsWith('#')) return;
        if (found.has(raw)) return;

        if (/^https?:\/\//i.test(raw)) {
            found.set(raw, raw);
        } else if (baseUrl) {
            try {
                found.set(raw, new URL(raw, baseUrl).href);
            } catch { /* unresolvable */ }
        }
    };

    // <img src>, <script src>, <source src>, <video poster>, <iframe src> is
    // deliberately excluded — embedded documents are not part of this page.
    for (const m of html.matchAll(/<(?:img|script|source|video|audio|embed)\b[^>]*?\ssrc\s*=\s*"([^"]+)"/gi)) add(m[1]);
    for (const m of html.matchAll(/<video\b[^>]*?\sposter\s*=\s*"([^"]+)"/gi)) add(m[1]);

    // <link href> for stylesheets, icons and preloaded fonts.
    for (const m of html.matchAll(/<link\b([^>]*?)>/gi)) {
        const attrs = m[1];
        const rel = (attrs.match(/rel\s*=\s*"([^"]*)"/i)?.[1] ?? '').toLowerCase();
        if (!/stylesheet|icon|preload|apple-touch/.test(rel)) continue;
        add(attrs.match(/href\s*=\s*"([^"]+)"/i)?.[1]);
    }

    // srcset: "url 1x, url 2x"
    for (const m of html.matchAll(/\ssrcset\s*=\s*"([^"]+)"/gi)) {
        for (const candidate of m[1].split(',')) add(candidate.trim().split(/\s+/)[0]);
    }

    // url(...) inside inline <style> blocks and style attributes.
    for (const m of html.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) add(m[1]);

    return [...found.entries()].map(([raw, url]) => ({ raw, url }));
}

/** Extracts url(...) targets from a CSS file, resolved against its own URL. */
function collectCssUrls(css, baseUrl) {
    const urls = new Set();
    for (const m of css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) {
        const raw = m[1].trim();
        if (!raw || raw.startsWith('data:')) continue;
        try {
            urls.add(new URL(raw, baseUrl).href);
        } catch { /* unresolvable */ }
    }
    for (const m of css.matchAll(/@import\s+(?:url\()?\s*['"]([^'"]+)['"]/gi)) {
        try {
            urls.add(new URL(m[1], baseUrl).href);
        } catch { /* unresolvable */ }
    }
    return [...urls];
}

/**
 * Fetches one asset, retrying on rate limiting and transient errors.
 * CDNs (Wikimedia in particular) answer 429 when a page's assets are
 * pulled back to back, which silently cost us images before.
 *
 * @param {string} url
 * @param {string} pageUrl - Sent as Referer.
 * @param {number} [attempts]
 */
async function fetchAsset(url, pageUrl, attempts = 3) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            return await axios.get(url, {
                responseType: 'arraybuffer',
                timeout: 20000,
                maxContentLength: MAX_ASSET_BYTES,
                headers: { 'User-Agent': HTTP_USER_AGENT, Referer: pageUrl },
            });
        } catch (err) {
            lastError = err;
            const status = err.response?.status;
            const retryable = status === 429 || status === 503 || status === undefined;
            if (!retryable || attempt === attempts - 1) throw err;

            const retryAfter = Number(err.response?.headers?.['retry-after']);
            const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
                ? Math.min(retryAfter * 1000, 5000)
                : 400 * 2 ** attempt; // 400ms, 800ms
            await new Promise(resolve => setTimeout(resolve, waitMs));
        }
    }
    throw lastError;
}

/**
 * Downloads a page's assets into the scan and returns a URL → local
 * relative path map.
 *
 * @param {string} html - Saved page HTML (absolute URLs).
 * @param {string} pageUrl
 * @param {string} scanDir - Scan root (assets live in scanDir/_assets).
 * @param {string} pageDir - Directory of the saved page, for relative paths.
 * @returns {Promise<{map: Map<string,string>, saved: number, failed: number, bytes: number}>}
 */
export async function downloadAssets(html, pageUrl, scanDir, pageDir) {
    const assetsAbsDir = path.join(scanDir, ASSET_DIR);
    const map = new Map();
    let saved = 0;
    let failed = 0;
    let bytes = 0;

    const refs = collectAssetUrls(html, pageUrl).slice(0, MAX_ASSETS_PER_PAGE);
    /** Absolute URL -> the raw strings that referenced it in the markup. */
    const rawByUrl = new Map();
    for (const { raw, url } of refs) {
        if (!rawByUrl.has(url)) rawByUrl.set(url, new Set());
        rawByUrl.get(url).add(raw);
    }

    const queue = [...rawByUrl.keys()].map(url => ({ url, depth: 0 }));
    const seen = new Set(queue.map(q => q.url));
    /** Stylesheets downloaded here, awaiting url() rewriting. */
    const cssToRewrite = [];
    const failures = [];
    const cache = cacheFor(scanDir);
    let reused = 0;

    await fs.mkdir(assetsAbsDir, { recursive: true });

    const fetchOne = async ({ url, depth }) => {
        const known = cache.get(url);
        if (known) {
            // Fetched (or found dead) by an earlier page of this scan. A
            // cached stylesheet was rewritten and its nested assets
            // fetched at the time, so nothing more is queued here.
            if (known.local) {
                map.set(url, known.local);
                reused++;
            } else {
                failed++;
            }
            return;
        }
        try {
            const response = await fetchAsset(url, pageUrl);

            const contentType = response.headers['content-type'] ?? '';
            const fileName = assetFileName(url, contentType);
            const buffer = Buffer.from(response.data);
            const local = `${ASSET_DIR}/${fileName}`;

            // Stylesheets can pull in fonts and images of their own.
            if (contentType.includes('text/css') && depth < MAX_CSS_DEPTH) {
                const css = buffer.toString('utf8');
                for (const nested of collectCssUrls(css, url)) {
                    if (!seen.has(nested) && seen.size < MAX_ASSETS_PER_PAGE * 2) {
                        seen.add(nested);
                        queue.push({ url: nested, depth: depth + 1 });
                    }
                }
                // Remember the CSS so its url()s can be rewritten at the end.
                cssToRewrite.push({ fileName, baseUrl: url });
            }

            await fs.writeFile(path.join(assetsAbsDir, fileName), buffer);
            map.set(url, local);
            cache.set(url, { local });
            saved++;
            bytes += buffer.length;
        } catch (err) {
            failed++;
            cache.set(url, { local: null });
            failures.push(`${err.response?.status ?? err.code ?? err.message}: ${url}`);
        }
    };

    // A few at a time; a worker that finds nested CSS assets refills the
    // queue, so a worker with nothing to do waits for the others.
    let inFlight = 0;
    const worker = async () => {
        for (;;) {
            const next = queue.shift();
            if (!next) {
                if (inFlight === 0) return;
                await waitMs(20);
                continue;
            }
            inFlight++;
            try {
                await fetchOne(next);
            } finally {
                inFlight--;
            }
        }
    };
    await Promise.all(Array.from({ length: assetConcurrency() }, worker));

    if (failures.length) {
        console.warn(`⚠️ ${failures.length} asset(s) failed: ${failures.slice(0, 3).join(' | ')}`);
    }
    if (reused) console.log(`♻️ ${reused} asset(s) reused from earlier pages of this scan`);

    // Rewrite url() references inside downloaded CSS to the local copies.
    for (const { fileName, baseUrl } of cssToRewrite) {
        const abs = path.join(assetsAbsDir, fileName);
        try {
            let css = await fs.readFile(abs, 'utf8');
            css = css.replace(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi, (match, raw) => {
                if (!raw || raw.startsWith('data:')) return match;
                try {
                    const resolved = new URL(raw.trim(), baseUrl).href;
                    const local = map.get(resolved);
                    // Assets sit beside each other inside _assets/.
                    return local ? `url("${path.posix.basename(local)}")` : match;
                } catch {
                    return match;
                }
            });
            await fs.writeFile(abs, css, 'utf8');
        } catch { /* leave the CSS as downloaded */ }
    }
    // Key the rewrite map by the *raw* strings that appear in the markup
    // (which may be protocol- or root-relative), pointing at page-relative
    // asset paths since pages sit at varying depths.
    const relMap = new Map();
    const prefix = path.relative(pageDir, assetsAbsDir).replace(/\\/g, '/') || '.';
    for (const [url, local] of map) {
        const localPath = `${prefix}/${path.posix.basename(local)}`;
        for (const raw of rawByUrl.get(url) ?? [url]) {
            relMap.set(raw, localPath);
        }
    }

    return { map: relMap, saved, failed, bytes };
}

/**
 * Rewrites a page's asset references to the downloaded local copies and
 * injects a CSP that blocks any off-origin request, so viewing or
 * auditing the saved page cannot call the origin site.
 *
 * @param {string} html
 * @param {Map<string,string>} assetMap - Absolute URL → relative local path.
 * @returns {string}
 */
export function rewriteForOffline(html, assetMap) {
    let out = html;

    // Replace every mapped reference wherever it appears in an attribute
    // value (src, href, srcset candidates, inline style url(...)).
    //
    // Longest first, and only at a value boundary — a root-relative ref
    // like "/logo.png" is a substring of "https://cdn.example/logo.png",
    // so a naive replace would corrupt the longer URL.
    const refs = [...assetMap.entries()].sort((a, b) => b[0].length - a[0].length);
    for (const [ref, local] of refs) {
        const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Preceded by a quote, whitespace, comma or "url(" — i.e. the start
        // of an attribute value or srcset candidate.
        out = out.replace(new RegExp(`(["'(,\\s])${escaped}(?=["')\\s,>])`, 'g'), `$1${local}`);
    }

    const csp = '<meta http-equiv="Content-Security-Policy" content="'
        + "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval'; "
        + "img-src 'self' data: blob:; media-src 'self' data: blob:; "
        + "font-src 'self' data:; style-src 'self' data: 'unsafe-inline'; "
        + "script-src 'self' data: 'unsafe-inline' 'unsafe-eval'; "
        + "connect-src 'none'; frame-src 'none'; form-action 'none'"
        + '">';

    // Insert immediately after <head> so it governs everything below it.
    if (/<head[^>]*>/i.test(out)) {
        out = out.replace(/<head[^>]*>/i, match => `${match}\n${csp}`);
    } else {
        out = `${csp}\n${out}`;
    }

    // Neutralise resource hints that would otherwise reach out on load.
    out = out.replace(/<link\b[^>]*rel\s*=\s*"(?:preconnect|dns-prefetch|prefetch|prerender)"[^>]*>/gi, '');

    return out;
}
