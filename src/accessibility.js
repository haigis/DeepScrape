import puppeteer from 'puppeteer';
import { promises as fs } from 'fs';
import path from 'path';
import axe from 'axe-core';

const axeSource = axe.source;

/**
 * Escapes a value for safe interpolation into report HTML.
 * Scraped page content (selectors, descriptions) is untrusted — without
 * this, a scanned page could inject script into our own reports.
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

/**
 * Recursively finds all .html files within a directory.
 * @param {string} dir - Directory to search in.
 * @returns {Promise<string[]>} - List of HTML file paths.
 */
async function findHtmlFiles(dir) {
    const files = await fs.readdir(dir, { withFileTypes: true });
    let htmlFiles = [];

    for (const file of files) {
        const filePath = path.join(dir, file.name);
        if (file.isDirectory()) {
            htmlFiles = htmlFiles.concat(await findHtmlFiles(filePath));
        } else if (file.name.endsWith('.html')) {
            htmlFiles.push(filePath);
        }
    }

    return htmlFiles;
}

/**
 * Analyze a single saved HTML file for WCAG violations.
 * @param {object} page - Puppeteer page (reused across files).
 * @param {string} filePath - Path to the saved HTML file.
 * @param {string} scanDate - Scan directory reference.
 * @returns {Promise<object>} - Axe results.
 */
async function analyzeSavedHTML(page, filePath, scanDate) {
    console.log(`📄 Analyzing: ${filePath}`);

    const htmlContent = await fs.readFile(filePath, 'utf8');
    await page.setContent(htmlContent, { waitUntil: 'load', timeout: 60000 });

    // Inject axe-core as a real script tag — the previous eval(source)
    // inside page.evaluate only worked via sloppy-mode scope leakage.
    await page.addScriptTag({ content: axeSource });

    const results = await page.evaluate(async () => await axe.run());

    console.log(`✅ Found ${results.violations.length} WCAG issues`);

    await saveReport(filePath, results, scanDate);
    return results;
}

/**
 * Save WCAG analysis results as a detailed HTML report.
 * All interpolated values from scanned pages are HTML-escaped.
 */
async function saveReport(filePath, results, scanDate) {
    const outputDir = 'audit-reports';
    await fs.mkdir(outputDir, { recursive: true });

    const fileName = path.basename(filePath, '.html') + '-report.html';
    const reportPath = path.join(outputDir, fileName);

    // Relative link into the API's /output static mount — works from
    // whichever host serves the reports (no hardcoded LAN IP).
    const pageUrl = '/' + filePath.replace(/\\/g, '/').replace(/^.*?output\//, 'output/');

    const rows = results.violations.map(v => `
            <tr>
                <td class="issue-${escapeHtml(v.impact)}">${escapeHtml(v.impact ? v.impact.charAt(0).toUpperCase() + v.impact.slice(1) : 'Unknown')}</td>
                <td>${escapeHtml(v.description)}</td>
                <td>
                    ${v.nodes.length} elements <br>
                    ${v.nodes.map(n => `<span class="code-box">${escapeHtml(n.target.join(', '))}</span>`).join('<br>')}
                </td>
            </tr>`).join('');

    const reportHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>WCAG Report - ${escapeHtml(fileName)}</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; background: #f7f7f7; color: #333; }
        h1 { text-align: center; margin-bottom: 20px; }
        .report-container { max-width: 900px; margin: 0 auto; padding: 15px; background: white; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.1); }
        .page-title { font-size: 20px; font-weight: bold; color: #007bff; margin-bottom: 5px; }
        .page-meta { font-size: 14px; color: #666; margin-bottom: 10px; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        th, td { padding: 10px; border: 1px solid #ddd; text-align: left; }
        th { background: #007bff; color: white; }
        tr:nth-child(even) { background: #f4f4f4; }
        .issue-moderate { color: #d67d00; font-weight: bold; }
        .issue-serious { color: #d60000; font-weight: bold; }
        .issue-critical { color: #8b0000; font-weight: bold; }
        .code-box { font-family: monospace; background: #eee; padding: 5px; border-radius: 4px; display: block; }
    </style>
</head>
<body>

    <h1>WCAG Accessibility Audit Report</h1>
    <div class="report-container">
        <p class="page-title">Analyzed Page: <a href="${escapeHtml(pageUrl)}" target="_blank">${escapeHtml(fileName.replace('-report.html', '.html'))}</a></p>
        <p class="page-meta">Scan Date: ${escapeHtml(scanDate)}</p>

        <h2>WCAG Issues Found: ${results.violations.length}</h2>
        <table>
            <tr>
                <th>Impact</th>
                <th>Description</th>
                <th>Affected Elements</th>
            </tr>${rows}
        </table>
    </div>

</body>
</html>
`;

    await fs.writeFile(reportPath, reportHtml, 'utf8');
    console.log(`📁 Saved report: ${reportPath}`);
}

/**
 * Generate an index page linking to all audit reports.
 */
async function generateIndexPage() {
    const outputDir = 'audit-reports';
    const files = (await fs.readdir(outputDir)).filter(f => f.endsWith('-report.html'));
    const reportLinks = files.map(file =>
        `<li><a href="${escapeHtml(file)}" target="_blank">${escapeHtml(file.replace('-report.html', ''))}</a></li>`).join('');

    const indexHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>WCAG Audit Reports</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; background: #f7f7f7; color: #333; }
        h1 { text-align: center; }
        .container { max-width: 900px; margin: 0 auto; background: white; padding: 15px; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.1); }
        ul { list-style: none; padding: 0; }
        li { margin: 5px 0; }
        a { color: #007bff; text-decoration: none; }
        a:hover { text-decoration: underline; }
    </style>
</head>
<body>

    <h1>WCAG Audit Reports</h1>
    <div class="container">
        <ul>${reportLinks}</ul>
    </div>

</body>
</html>
`;

    await fs.writeFile(path.join(outputDir, 'index.html'), indexHtml, 'utf8');
    console.log(`📁 Saved index page: audit-reports/index.html`);
}

/**
 * Start recursive analysis for all HTML files in the scan folder.
 * One browser and one page are reused for the whole scan and always
 * closed, even on error (previously: a new browser per file, leaked
 * whenever analysis threw).
 */
export async function analyzeScan(scanPath) {
    const fullScanPath = path.join(process.cwd(), scanPath);
    console.log(`\n📂 Scanning directory recursively: ${fullScanPath}`);

    const htmlFiles = await findHtmlFiles(fullScanPath);

    if (htmlFiles.length === 0) {
        console.log('⚠️ No HTML files found.');
        return;
    }

    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
        const page = await browser.newPage();

        // Block subresource fetches — we analyze saved static HTML.
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['script', 'xhr', 'fetch', 'eventsource'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        for (const filePath of htmlFiles) {
            try {
                await analyzeSavedHTML(page, filePath, scanPath);
            } catch (err) {
                console.error(`❌ Failed to analyze ${filePath}: ${err.message}`);
            }
        }
    } finally {
        await browser.close();
    }

    await generateIndexPage();
}

// Run as CLI: node src/accessibility.js output/<domain>/<date>/
const isMain = process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href;
if (isMain) {
    const scanDir = process.argv[2];
    if (!scanDir) {
        console.error('❌ Usage: node src/accessibility.js output/<domain>/<date>/');
        process.exit(1);
    }
    analyzeScan(scanDir).catch(err => {
        console.error(`❌ Error: ${err.message}`);
        process.exit(1);
    });
}
