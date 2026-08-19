import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Refuses scan targets that resolve to addresses inside the network the
 * scanner runs on.
 *
 * Without this, anyone who can start a scan can make the scanner fetch
 * internal services and archive the responses into a scan they can then
 * read. Verifying domain ownership does not prevent it: a domain you
 * genuinely control can have its A record pointed at 127.0.0.1, at the
 * docker bridge, or at a host on the same private network.
 *
 * The guard runs at the API boundary rather than inside the crawler, so
 * a new endpoint cannot quietly skip it — see the middleware below.
 */

/** Ranges that must never be reachable from a scan. */
function isBlockedAddress(ip) {
    if (isIP(ip) === 6) {
        const v6 = ip.toLowerCase();
        if (v6 === '::1' || v6 === '::') return true;
        // link-local, unique-local
        if (v6.startsWith('fe80') || v6.startsWith('fc') || v6.startsWith('fd')) return true;
        // IPv4-mapped (::ffff:127.0.0.1) — check the address it carries
        const mapped = v6.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        if (mapped) return isBlockedAddress(mapped[1]);
        return false;
    }

    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 127) return true;              // this host / loopback
    if (a === 10) return true;                          // private
    if (a === 172 && b >= 16 && b <= 31) return true;   // private (docker default bridge)
    if (a === 192 && b === 168) return true;            // private
    if (a === 169 && b === 254) return true;            // link-local, incl. cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true;  // CGNAT / tailnet
    if (a >= 224) return true;                          // multicast and reserved
    return false;
}

/**
 * Throws if the URL is malformed, not http(s), or resolves anywhere
 * private. Resolves silently when the target is a normal public site.
 *
 * @param {string} raw
 * @returns {Promise<void>}
 */
export async function assertPublicUrl(raw) {
    let url;
    try {
        url = new URL(String(raw));
    } catch {
        throw new Error(`Not a valid URL: ${raw}`);
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`Only http and https can be scanned, not ${url.protocol.replace(':', '')}`);
    }

    const host = url.hostname;

    if (isIP(host)) {
        if (isBlockedAddress(host)) {
            throw new Error(`${host} is not a publicly routable address`);
        }
        return;
    }

    let addresses;
    try {
        addresses = await lookup(host, { all: true });
    } catch {
        throw new Error(`${host} does not resolve`);
    }

    if (!addresses.length) throw new Error(`${host} does not resolve`);

    // Every answer must be public. A hostname with one public and one
    // private address is a rebinding attempt, not a misconfiguration.
    const blocked = addresses.find(entry => isBlockedAddress(entry.address));
    if (blocked) {
        throw new Error(`${host} resolves to ${blocked.address}, which is a private address`);
    }
}

/** Body fields across the scrape endpoints that carry a target. */
const URL_FIELDS = ['url', 'sitemapUrl', 'startUrl'];
const URL_LIST_FIELDS = ['urls'];

/**
 * Express middleware for the /scrape routes. Collects every target in the
 * body and refuses the request if any of them points inside the network.
 *
 * Applied to the whole prefix on purpose: guarding each handler
 * individually means the next endpoint added is unprotected by default.
 */
export async function guardScrapeTargets(req, res, next) {
    const targets = [];

    for (const field of URL_FIELDS) {
        const value = req.body?.[field];
        if (typeof value === 'string' && value.trim()) targets.push(value.trim());
    }
    for (const field of URL_LIST_FIELDS) {
        const list = req.body?.[field];
        if (Array.isArray(list)) {
            for (const value of list) {
                if (typeof value === 'string' && value.trim()) targets.push(value.trim());
            }
        }
    }

    if (targets.length === 0) return next();

    try {
        await Promise.all(targets.map(assertPublicUrl));
        return next();
    } catch (err) {
        console.warn(`⛔ Refused scan target: ${err.message}`);
        return res.status(400).json({ error: err.message });
    }
}
