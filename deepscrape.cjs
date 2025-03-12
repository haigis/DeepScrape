const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const { URL } = require('url');

// Version
function displayHelp() {
    console.log(`
DeepScrape - Version 2.5

Usage:
  node deepscrape.cjs [options] [file_path | scanID]

Options:
  -h, --help            Show this help message and exit.
  --download-images     Download the extracted images from a scan.
  --rate-limit <ms>     Add a delay (in milliseconds) between operations. Default is 1000ms.
  -n <name>             Add a readable name to the scan folder.
  -sm <url>             Specify a sitemap URL to process directly.
  -f <file_path>        Specify a local file containing URLs to process.
  --pdf                 Save a PDF screenshot of the fully rendered page.

Examples:
1. Run a new scan:
   node deepscrape.cjs -n myscan

2. Save PDF screenshots:
   node deepscrape.cjs --pdf -n pdfscan

3. Process a sitemap:
   node deepscrape.cjs -sm https://example.com/sitemap.xml
`);
    process.exit(0);
}

// Generate a unique output folder
function generateUniqueOutputDir(baseDir = './output', readableName = '') {
    const timestamp = new Date().toISOString().replace(/[-:.]/g, '').replace('T', '_').slice(0, 15);
    const scanId = Math.random().toString(36).substr(2, 8);
    let folderName = `scan_${timestamp}_${scanId}`;
    if (readableName) {
        folderName += `_${readableName.replace(/\s+/g, '_')}`;
    }
    return path.join(baseDir, folderName);
}

// Ensure directories exist
function ensureDirectories(outputDir) {
    const directories = ['html', 'images', 'pdf'];
    directories.forEach(subdir => {
        const dirPath = path.join(outputDir, subdir);
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
            console.log(`Created directory: ${dirPath}`);
        }
    });
}

// Read URLs from a file
function readUrlsFromFile(filepath) {
    try {
        if (!fs.existsSync(filepath)) return [];
        const content = fs.readFileSync(filepath, 'utf8').trim();
        return content ? content.split('\n').map(url => url.trim()) : [];
    } catch (error) {
        console.error(`Error reading file ${filepath}: ${error.message}`);
        return [];
    }
}

// Fetch HTML, extract images, and save PDFs if enabled
async function processUrls(urls, outputDir, rateLimitMs, savePdfFlag) {
    const htmlDir = path.join(outputDir, 'html');
    const pdfDir = path.join(outputDir, 'pdf');
    let browser = null;

    try {
        // If PDFs are enabled, launch Puppeteer only once
        if (savePdfFlag) {
            console.log("🚀 Launching Puppeteer...");
            browser = await puppeteer.launch({ headless: true });
        }

        for (const url of urls) {
            try {
                console.log(`🌍 Fetching HTML for: ${url}`);
                const response = await axios.get(url);
                const html = response.data;

                // Save HTML
                const encodedFileName = encodeURIComponent(url) + '.html';
                const filePath = path.join(htmlDir, encodedFileName);
                fs.writeFileSync(filePath, `<!-- ${url} -->\n${html}`, 'utf8');
                console.log(`✅ Saved HTML: ${filePath}`);

                // Save PDF screenshot if enabled
                if (savePdfFlag && browser) {
                    console.log(`📄 Generating PDF for: ${url}`);
                    const page = await browser.newPage();
                    await page.goto(url, { waitUntil: 'networkidle2' });

                    const pdfPath = path.join(pdfDir, encodeURIComponent(url) + '.pdf');
                    await page.pdf({ path: pdfPath, format: 'A4' });
                    await page.close();
                    console.log(`✅ PDF saved: ${pdfPath}`);
                }

                if (rateLimitMs > 0) {
                    await new Promise(resolve => setTimeout(resolve, rateLimitMs));
                }

            } catch (error) {
                console.error(`❌ Error processing URL ${url}: ${error.message}`);
            }
        }

    } finally {
        if (browser) {
            console.log("🛑 Closing Puppeteer...");
            await browser.close();
        }
    }
}

// Main function
async function main() {
    const args = process.argv.slice(2);

    if (args.includes('-h') || args.includes('--help')) {
        displayHelp();
    }

    const baseOutputDir = './output';
    const rateLimitIndex = args.indexOf('--rate-limit');
    const rateLimitMs = rateLimitIndex !== -1 ? parseInt(args[rateLimitIndex + 1], 10) : 1000;
    const nameIndex = args.indexOf('-n');
    const readableName = nameIndex !== -1 ? args[nameIndex + 1] : '';
    const sitemapIndex = args.indexOf('-sm');
    const fileIndex = args.indexOf('-f');
    const savePdfFlag = args.includes('--pdf'); // ✅ Fixed flag detection

    let allUrls = [];

    if (sitemapIndex !== -1) {
        const sitemapUrl = args[sitemapIndex + 1];
        const sitemapUrls = await fetchSitemapUrls(sitemapUrl);
        allUrls = allUrls.concat(sitemapUrls);
    } else if (fileIndex !== -1) {
        const filePath = args[fileIndex + 1];
        allUrls = readUrlsFromFile(filePath);
    } else {
        const urls = readUrlsFromFile('urls.txt');
        allUrls = urls;
    }

    const uniqueOutputDir = generateUniqueOutputDir(baseOutputDir, readableName);
    ensureDirectories(uniqueOutputDir);

    console.log(`📂 Processing URLs, saving files to: ${uniqueOutputDir}`);
    await processUrls(allUrls, uniqueOutputDir, rateLimitMs, savePdfFlag);
    console.log('✅ Program completed.');

    // 🚀 Ensures script fully exits
    process.exit(0);
}

main();
