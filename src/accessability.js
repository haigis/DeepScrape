import puppeteer from 'puppeteer';
import { promises as fs } from 'fs';
import path from 'path';
import axe from 'axe-core';

const axeSource = axe.source;

/**
 * Recursively finds all .html files within a directory.
 * @param {string} dir - Directory to search in.
 * @returns {Promise<string[]>} - List of HTML file paths.
 */
async function findHtmlFiles(dir) {
    let files = await fs.readdir(dir, { withFileTypes: true });
    let htmlFiles = [];

    for (let file of files) {
        let filePath = path.join(dir, file.name);
        if (file.isDirectory()) {
            htmlFiles = htmlFiles.concat(await findHtmlFiles(filePath)); // Recursive search
        } else if (file.name.endsWith('.html')) {
            htmlFiles.push(filePath);
        }
    }

    return htmlFiles;
}

/**
 * Analyze a single saved HTML file for WCAG violations and generate a detailed report.
 * @param {string} filePath - Path to the saved HTML file.
 * @param {string} scanDate - Scan directory reference.
 */
async function analyzeSavedHTML(filePath, scanDate) {
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();

    console.log(`📄 Analyzing: ${filePath}`);

    // Read the saved HTML file
    const htmlContent = await fs.readFile(filePath, 'utf8');

    // Disable JavaScript execution to improve performance
    await page.setRequestInterception(true);
    page.on('request', (req) => {
        if (['script', 'xhr', 'fetch', 'eventsource'].includes(req.resourceType())) {
            req.abort();
        } else {
            req.continue();
        }
    });

    // Set content with increased timeout
    await page.setContent(htmlContent, { waitUntil: "load", timeout: 60000 });

    // Inject Axe-core
    await page.evaluate(async (source) => {
        eval(source); // Inject Axe-core script
    }, axeSource);

    // Run Axe and get the results
    const results = await page.evaluate(async () => await axe.run());

    await browser.close();

    console.log(`✅ Found ${results.violations.length} WCAG issues`);

    // Generate a detailed HTML report
    await saveReport(filePath, results, scanDate);

    return results;
}

/**
 * Save WCAG analysis results as a detailed HTML report.
 */
async function saveReport(filePath, results, scanDate) {
    const outputDir = 'audit-reports';
    await fs.mkdir(outputDir, { recursive: true });

    const fileName = path.basename(filePath, '.html') + '-report.html';
    const reportPath = path.join(outputDir, fileName);

    // Extract page name and relative URL
    const pageUrl = filePath.replace(/\\/g, "/").replace(/^.*output\//, "http://192.168.1.31:5700/output/");

    // Generate report HTML
    const reportHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>WCAG Report - ${fileName}</title>
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
        <p class="page-title">Analyzed Page: <a href="${pageUrl}" target="_blank">${fileName.replace("-report.html", ".html")}</a></p>
        <p class="page-meta">Scan Date: ${scanDate}</p>

        <h2>WCAG Issues Found: ${results.violations.length}</h2>
        <table>
            <tr>
                <th>Impact</th>
                <th>Description</th>
                <th>Affected Elements</th>
            </tr>
            ${results.violations.map(v => `
            <tr>
                <td class="issue-${v.impact}">${v.impact.charAt(0).toUpperCase() + v.impact.slice(1)}</td>
                <td>${v.description}</td>
                <td>
                    ${v.nodes.length} elements <br>
                    ${v.nodes.map(n => `<span class="code-box">${n.target.join(", ")}</span>`).join('<br>')}
                </td>
            </tr>`).join('')}
        </table>
    </div>

</body>
</html>
    `;

    // Save the report
    await fs.writeFile(reportPath, reportHtml, 'utf8');
    console.log(`📁 Saved report: ${reportPath}`);
}

/**
 * Generate an index page linking to all audit reports.
 */
async function generateIndexPage() {
    const outputDir = 'audit-reports';
    const files = await fs.readdir(outputDir);
    const reportLinks = files.map(file => `<li><a href="${file}" target="_blank">${file.replace("-report.html", "")}</a></li>`).join('');

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
 */
async function analyzeScan(scanPath) {
    try {
        const fullScanPath = path.join(process.cwd(), scanPath);
        console.log(`\n📂 Scanning directory recursively: ${fullScanPath}`);

        const htmlFiles = await findHtmlFiles(fullScanPath);

        if (htmlFiles.length === 0) {
            console.log("⚠️ No HTML files found.");
            return;
        }

        for (const filePath of htmlFiles) {
            await analyzeSavedHTML(filePath, scanPath);
        }

        await generateIndexPage();
    } catch (error) {
        console.error(`❌ Error: ${error.message}`);
    }
}

// Run the analysis
const scanDir = process.argv[2];

if (!scanDir) {
    console.error("❌ Usage: node analyzeSavedPages.js output/15-03-2025/");
    process.exit(1);
}

analyzeScan(scanDir);
