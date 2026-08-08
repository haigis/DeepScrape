import { promises as fs } from 'fs';
import path from 'path';
import { urlToScanPath, getInboundIndex } from './scanStore.js';

/**
 * Scan analytics: aggregate site metrics and per-page "attributes"
 * that power the dashboards. Everything is computed from files already
 * on disk — no re-crawling.
 */

/**
 * Collects every saved page in a scan with its size and depth.
 * @param {string} scanPath
 * @returns {Promise<{path: string, size: number, depth: number, screenshot: boolean}[]>}
 */
async function collectPages(scanPath) {
    const pages = [];

    async function walk(dir, rel) {
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        const names = new Set(entries.filter(e => e.isFile()).map(e => e.name));

        // Stat this directory's pages in parallel — sequential awaits cost
        // ~1s on a 3k-page scan.
        const htmlEntries = entries.filter(e => !e.isDirectory() && /\.html?$/i.test(e.name));
        const stats = await Promise.all(htmlEntries.map(e =>
            fs.stat(path.join(dir, e.name)).catch(() => null)));

        htmlEntries.forEach((entry, i) => {
            if (!stats[i]) return;
            const childRel = rel ? `${rel}/${entry.name}` : entry.name;
            pages.push({
                path: childRel,
                size: stats[i].size,
                // Depth below the domain folder: domain/a/b/page.html -> 2
                depth: Math.max(0, childRel.split('/').length - 2),
                screenshot: names.has(entry.name.replace(/\.html?$/i, '.webp')),
            });
        });

        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name === 'images') continue;
            await walk(path.join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name);
        }
    }

    await walk(scanPath, '');
    return pages;
}

const median = (nums) => {
    if (nums.length === 0) return 0;
    const sorted = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};

/**
 * Builds the site dashboard for one scan: headline metrics, size
 * distribution, section breakdown, depth spread, link analysis and a
 * comparison against the previous scan of the same domain.
 *
 * @param {string} domainRoot - Absolute path of output/<domain>.
 * @param {string} domain
 * @param {string} date - Scan date folder name.
 * @returns {Promise<object>}
 */
export async function buildDashboard(domainRoot, domain, date) {
    const scanPath = path.join(domainRoot, date);
    const pages = await collectPages(scanPath);

    const sizes = pages.map(p => p.size);
    const totalSize = sizes.reduce((a, b) => a + b, 0);

    // Section = first path segment below the domain folder.
    const sections = new Map();
    for (const page of pages) {
        const parts = page.path.split('/');
        const section = parts.length > 2 ? parts[1] : '(root)';
        const entry = sections.get(section) ?? { section, pages: 0, size: 0 };
        entry.pages++;
        entry.size += page.size;
        sections.set(section, entry);
    }
    const sectionList = [...sections.values()]
        .map(s => ({ ...s, avgSize: Math.round(s.size / s.pages) }))
        .sort((a, b) => b.pages - a.pages);

    // Depth distribution.
    const depthCounts = {};
    for (const page of pages) depthCounts[page.depth] = (depthCounts[page.depth] ?? 0) + 1;
    const depths = Object.entries(depthCounts)
        .map(([depth, count]) => ({ depth: Number(depth), count }))
        .sort((a, b) => a.depth - b.depth);

    // Link analysis from the spider's incoming-links map.
    let incomingMap = {};
    try {
        incomingMap = JSON.parse(await fs.readFile(path.join(scanPath, 'incoming-links.json'), 'utf8'));
    } catch { /* not a spider scan */ }

    // Inbound counts come from the whole-scan index (every saved page's
    // anchors), unioned with the crawl artifact. Using incoming-links.json
    // alone under-counts badly when the spider covered only part of the
    // scan, or misses everything for sitemap/batch scans (issue #19).
    const { index: inboundIndex } = await getInboundIndex(scanPath);
    const inboundByPath = new Map();
    for (const [target, sources] of inboundIndex) {
        inboundByPath.set(target, sources.length);
    }

    const urlByPath = new Map();
    for (const [url, sources] of Object.entries(incomingMap)) {
        const rel = urlToScanPath(url);
        if (!rel) continue;
        if (!inboundIndex.has(rel)) {
            // Crawl saw links to this page from pages that were not saved.
            inboundByPath.set(rel, (inboundByPath.get(rel) ?? 0) + sources.length);
        }
        if (!urlByPath.has(rel)) urlByPath.set(rel, url);
    }

    const linked = pages.map(page => ({
        path: page.path,
        url: urlByPath.get(page.path) ?? null,
        size: page.size,
        inbound: inboundByPath.get(page.path) ?? 0,
    }));

    const mostLinked = [...linked].sort((a, b) => b.inbound - a.inbound).slice(0, 10);
    const orphans = linked.filter(p => p.inbound === 0);

    let brokenLinks = [];
    try {
        const raw = await fs.readFile(path.join(scanPath, 'broken-links.txt'), 'utf8');
        brokenLinks = raw.split('\n').map(l => l.trim()).filter(Boolean);
    } catch { /* no crawl artifacts */ }

    let imageCount = 0;
    async function countImages(dir) {
        let entries;
        try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (entry.name === 'images') {
                const imgs = await fs.readdir(path.join(dir, entry.name)).catch(() => []);
                imageCount += imgs.length;
            } else {
                await countImages(path.join(dir, entry.name));
            }
        }
    }
    await countImages(scanPath);

    // Comparison with the previous scan of this domain.
    let comparison = null;
    const allDates = (await fs.readdir(domainRoot, { withFileTypes: true }).catch(() => []))
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .sort((a, b) => b.localeCompare(a));
    const prevDate = allDates.find(d => d < date);

    if (prevDate) {
        const prevPages = await collectPages(path.join(domainRoot, prevDate));
        const prevMap = new Map(prevPages.map(p => [p.path, p.size]));
        const currMap = new Map(pages.map(p => [p.path, p.size]));

        const added = pages.filter(p => !prevMap.has(p.path)).map(p => p.path);
        const removed = prevPages.filter(p => !currMap.has(p.path)).map(p => p.path);
        const changed = pages
            .filter(p => prevMap.has(p.path) && prevMap.get(p.path) !== p.size)
            .map(p => ({ path: p.path, delta: p.size - prevMap.get(p.path) }))
            .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

        const prevTotal = prevPages.reduce((sum, p) => sum + p.size, 0);
        comparison = {
            previousDate: prevDate,
            previousPages: prevPages.length,
            pageDelta: pages.length - prevPages.length,
            previousTotalSize: prevTotal,
            sizeDelta: totalSize - prevTotal,
            added: added.slice(0, 50),
            addedCount: added.length,
            removed: removed.slice(0, 50),
            removedCount: removed.length,
            changed: changed.slice(0, 20),
            changedCount: changed.length,
        };
    }

    return {
        scan: `${domain}/${date}`,
        domain,
        date,
        availableDates: allDates,
        headline: {
            pages: pages.length,
            screenshots: pages.filter(p => p.screenshot).length,
            images: imageCount,
            brokenLinks: brokenLinks.length,
            orphans: orphans.length,
            totalSize,
            avgSize: pages.length ? Math.round(totalSize / pages.length) : 0,
            medianSize: median(sizes),
            maxDepth: pages.reduce((max, p) => Math.max(max, p.depth), 0),
            screenshotCoverage: pages.length
                ? Math.round((pages.filter(p => p.screenshot).length / pages.length) * 100)
                : 0,
            hasCrawlData: inboundIndex.size > 0 || Object.keys(incomingMap).length > 0,
        },
        sections: sectionList,
        depths,
        largestPages: [...pages].sort((a, b) => b.size - a.size).slice(0, 10),
        smallestPages: [...pages].sort((a, b) => a.size - b.size).slice(0, 10),
        mostLinked,
        orphans: orphans.slice(0, 50),
        brokenLinks: brokenLinks.slice(0, 50),
        comparison,
    };
}

/**
 * Scales a value onto the FM-style 1-20 attribute range.
 * @param {number} value
 * @param {number} best - Value that should map to 20.
 * @returns {number}
 */
function rate(value, best) {
    if (!best || best <= 0) return 1;
    return Math.max(1, Math.min(20, Math.round((value / best) * 20)));
}

/**
 * Per-page "attributes" scored against the rest of the scan, so each
 * page reads like a player profile.
 *
 * @param {string} scanPath
 * @param {string} pagePath
 * @param {object} pageDetails - Result of getPageDetails().
 * @returns {Promise<object>}
 */
export async function buildPageAttributes(scanPath, pagePath, pageDetails) {
    const pages = await collectPages(scanPath);
    const self = pages.find(p => p.path === pagePath);
    if (!self) return null;

    const sizes = pages.map(p => p.size);
    const maxSize = Math.max(...sizes, 1);
    const maxDepth = pages.reduce((max, p) => Math.max(max, p.depth), 1);

    const bigger = sizes.filter(s => s < self.size).length;
    const sizePercentile = pages.length > 1
        ? Math.round((bigger / (pages.length - 1)) * 100)
        : 100;

    const inbound = pageDetails.incoming.length;
    const outbound = pageDetails.outgoing.length;

    return {
        // 1-20 ratings, FM style.
        attributes: {
            size: rate(self.size, maxSize),
            inboundLinks: rate(inbound, 10),
            outboundLinks: rate(outbound, 40),
            // Shallow pages score higher — closer to the front page.
            prominence: rate(maxDepth - self.depth + 1, maxDepth + 1),
            coverage: self.screenshot ? 20 : 5,
        },
        vitals: {
            depth: self.depth,
            sizePercentile,
            rankBySize: [...sizes].sort((a, b) => b - a).indexOf(self.size) + 1,
            totalPages: pages.length,
            isOrphan: inbound === 0,
            hasScreenshot: self.screenshot,
        },
    };
}
