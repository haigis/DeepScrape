import { promises as fs } from 'fs';
import path from 'path';

/**
 * Read access to scan output on disk: directory trees, per-page details
 * and page history across scans. Everything here works on paths already
 * validated to sit inside the output root (api.js does the validation).
 */

const ARTIFACT_NAMES = new Set(['all-links.txt', 'broken-links.txt', 'incoming-links.json']);

/**
 * Reads the original URL from a saved page (first line: <!-- url -->).
 * @param {string} filePath
 * @returns {Promise<string|null>}
 */
export async function readPageUrl(filePath) {
    let handle;
    try {
        handle = await fs.open(filePath, 'r');
        const { buffer, bytesRead } = await handle.read(Buffer.alloc(2048), 0, 2048, 0);
        const head = buffer.subarray(0, bytesRead).toString('utf8');
        const match = head.match(/^<!--\s*(https?:\/\/\S+)\s*-->/);
        return match ? match[1] : null;
    } catch {
        return null;
    } finally {
        await handle?.close();
    }
}

/**
 * Builds a nested directory tree of the saved pages in one scan.
 * Directories carry recursive page counts so the UI can show sizes
 * without expanding; only saved pages (.html/.htm) become leaf nodes.
 *
 * @param {string} scanPath - Absolute path of the scan directory
 *                            (output/<domain>/<date>).
 * @returns {Promise<{tree: object, stats: object}>}
 */
export async function buildScanTree(scanPath) {
    const stats = { pages: 0, screenshots: 0, images: 0, artifacts: [], brokenLinks: 0 };

    async function walk(dir, relPrefix) {
        const node = { name: path.basename(dir), type: 'dir', path: relPrefix, pages: 0, children: [] };
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            return node;
        }

        entries.sort((a, b) => a.name.localeCompare(b.name));

        for (const entry of entries) {
            const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                if (entry.name === 'images') {
                    const imgs = await fs.readdir(path.join(dir, entry.name)).catch(() => []);
                    stats.images += imgs.length;
                    continue; // image assets are counted, not shown in the page tree
                }
                const child = await walk(path.join(dir, entry.name), rel);
                if (child.pages > 0) {
                    node.children.push(child);
                    node.pages += child.pages;
                }
            } else if (/\.html?$/i.test(entry.name)) {
                stats.pages++;
                node.pages++;
                node.children.push({ name: entry.name, type: 'page', path: rel });
            } else if (/\.webp$/i.test(entry.name)) {
                stats.screenshots++;
            } else if (ARTIFACT_NAMES.has(entry.name)) {
                stats.artifacts.push(rel);
            }
        }

        // Pages before subdirectories at each level, both alphabetical.
        node.children.sort((a, b) =>
            a.type === b.type ? a.name.localeCompare(b.name) : (a.type === 'page' ? -1 : 1));

        return node;
    }

    const tree = await walk(scanPath, '');
    tree.name = '/';

    const brokenFile = path.join(scanPath, 'broken-links.txt');
    try {
        const broken = await fs.readFile(brokenFile, 'utf8');
        stats.brokenLinks = broken.split('\n').filter(Boolean).length;
    } catch { /* no crawl artifacts in this scan */ }

    return { tree, stats };
}

/**
 * Detailed information about one saved page in one scan.
 *
 * @param {string} scanPath - Absolute scan directory.
 * @param {string} scan - Scan identifier "<domain>/<date>" (for URLs).
 * @param {string} pagePath - Page path relative to the scan dir (validated).
 * @returns {Promise<object|null>} - null when the page does not exist.
 */
export async function getPageDetails(scanPath, scan, pagePath) {
    const absPage = path.join(scanPath, pagePath);

    let stat;
    try {
        stat = await fs.stat(absPage);
    } catch {
        return null;
    }

    const url = await readPageUrl(absPage);

    const webpRel = pagePath.replace(/\.html?$/i, '.webp');
    const hasScreenshot = await fs.access(path.join(scanPath, webpRel)).then(() => true, () => false);

    // Outgoing links from the saved HTML (absolute after fixRelativePaths).
    let outgoing = [];
    try {
        const html = await fs.readFile(absPage, 'utf8');
        outgoing = [...new Set(
            [...html.matchAll(/href="(https?:\/\/[^"]+)"/g)].map(m => m[1])
        )].slice(0, 300);
    } catch { /* unreadable page — leave outgoing empty */ }

    // Incoming links from the crawl's incoming-links.json, keyed by URL.
    let incoming = [];
    if (url) {
        try {
            const raw = await fs.readFile(path.join(scanPath, 'incoming-links.json'), 'utf8');
            const map = JSON.parse(raw);
            incoming = map[url] ?? map[url.replace(/\/$/, '')] ?? map[url + '/'] ?? [];
        } catch { /* not a spider scan */ }
    }

    return {
        scan,
        path: pagePath,
        url,
        size: stat.size,
        modified: stat.mtime.toISOString(),
        htmlUrl: `/output/${scan}/${pagePath}`,
        screenshotUrl: hasScreenshot ? `/output/${scan}/${webpRel}` : null,
        incoming,
        outgoing,
    };
}

/**
 * History of one page across every scan of a domain: which scan dates
 * contain it and how it changed (size, screenshot availability).
 *
 * @param {string} domainRoot - Absolute path of output/<domain>.
 * @param {string} domain
 * @param {string} pagePath - Page path relative to a scan dir.
 * @returns {Promise<object[]>} - Newest first.
 */
export async function getPageHistory(domainRoot, domain, pagePath) {
    let dates;
    try {
        dates = await fs.readdir(domainRoot, { withFileTypes: true });
    } catch {
        return [];
    }

    const history = [];
    for (const entry of dates) {
        if (!entry.isDirectory()) continue;
        const date = entry.name;
        const absPage = path.join(domainRoot, date, pagePath);

        let stat;
        try {
            stat = await fs.stat(absPage);
        } catch {
            continue; // page not present in this scan
        }

        const webpRel = pagePath.replace(/\.html?$/i, '.webp');
        const hasScreenshot = await fs
            .access(path.join(domainRoot, date, webpRel))
            .then(() => true, () => false);

        history.push({
            scan: `${domain}/${date}`,
            date,
            size: stat.size,
            modified: stat.mtime.toISOString(),
            htmlUrl: `/output/${domain}/${date}/${pagePath}`,
            screenshotUrl: hasScreenshot ? `/output/${domain}/${date}/${webpRel}` : null,
        });
    }

    history.sort((a, b) => b.date.localeCompare(a.date));

    // Size delta vs the previous (older) scan of the same page.
    for (let i = 0; i < history.length; i++) {
        const older = history[i + 1];
        history[i].sizeDelta = older ? history[i].size - older.size : null;
    }

    return history;
}
