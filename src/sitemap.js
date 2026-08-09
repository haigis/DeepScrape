import axios from 'axios';
import zlib from 'zlib';
import xml2js from 'xml2js';
import { HTTP_USER_AGENT } from './scraper.js';

/** Safety cap on how many nested sitemap files one call may fetch. */
const MAX_SITEMAP_FETCHES = 50;

/**
 * Fetches a sitemap URL and returns its raw XML, transparently
 * gunzipping .gz sitemaps.
 * @param {string} url
 * @returns {Promise<string>}
 */
async function fetchXml(url) {
    const { data, headers } = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 30000,
        headers: { 'User-Agent': HTTP_USER_AGENT },
    });

    const buf = Buffer.from(data);
    const isGzip =
        /\.gz$/i.test(new URL(url).pathname) ||
        headers['content-type']?.includes('gzip') ||
        (buf[0] === 0x1f && buf[1] === 0x8b); // gzip magic bytes

    return isGzip ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
}

/**
 * Fetches all page URLs from a sitemap, following <sitemapindex>
 * entries recursively. Handles:
 *  - <urlset>       → returns its <url><loc> entries
 *  - <sitemapindex> → fetches each child <sitemap><loc> and merges results
 *  - gzipped sitemaps (.xml.gz)
 *
 * This replaces two previous divergent implementations: a regex scan in
 * scraper.js and an xml2js version in utils.js that crashed on sitemap
 * indexes (see issue #4).
 *
 * @param {string} sitemapUrl - URL of the sitemap or sitemap index.
 * @returns {Promise<string[]>} - Unique page URLs.
 */
export async function fetchSitemapUrls(sitemapUrl) {
    const urls = new Set();
    const queue = [sitemapUrl];
    const seen = new Set(queue);
    let fetches = 0;

    while (queue.length) {
        if (fetches >= MAX_SITEMAP_FETCHES) {
            console.warn(`⚠️ Sitemap fetch cap (${MAX_SITEMAP_FETCHES}) reached; results may be partial.`);
            break;
        }
        const current = queue.shift();
        fetches++;
        console.log(`📡 Fetching sitemap: ${current}`);

        const xml = await fetchXml(current);
        const parsed = await xml2js.parseStringPromise(xml);

        if (parsed.urlset) {
            for (const entry of parsed.urlset.url ?? []) {
                if (entry.loc?.[0]) urls.add(entry.loc[0].trim());
            }
        } else if (parsed.sitemapindex) {
            for (const entry of parsed.sitemapindex.sitemap ?? []) {
                const loc = entry.loc?.[0]?.trim();
                if (loc && !seen.has(loc)) {
                    seen.add(loc);
                    queue.push(loc);
                }
            }
        } else {
            throw new Error(`Unrecognised sitemap format at ${current} (no <urlset> or <sitemapindex> root)`);
        }
    }

    console.log(`✅ Found ${urls.size} URLs across ${fetches} sitemap file(s).`);
    return [...urls];
}

/**
 * Finds a site's sitemap URLs the way crawlers do: `Sitemap:` lines in
 * robots.txt first, then the /sitemap.xml convention as a fallback.
 * @param {string} origin - e.g. "https://www.example.com"
 * @returns {Promise<string[]>} - Sitemap URLs (possibly empty).
 */
export async function discoverSitemaps(origin) {
    const found = [];

    try {
        const { data } = await axios.get(`${origin}/robots.txt`, {
            timeout: 15000,
            responseType: 'text',
            headers: { 'User-Agent': HTTP_USER_AGENT },
        });
        for (const line of String(data).split('\n')) {
            const m = line.match(/^\s*sitemap:\s*(\S+)/i);
            if (m) found.push(m[1].trim());
        }
    } catch { /* no robots.txt — fall through */ }

    if (found.length === 0) {
        // Convention fallback: probe /sitemap.xml.
        try {
            const probe = `${origin}/sitemap.xml`;
            const urls = await fetchSitemapUrls(probe);
            if (urls.length > 0) return [probe];
        } catch { /* none there either */ }
    }

    return [...new Set(found)];
}
