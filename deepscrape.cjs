const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const { URL } = require('url');

// ✅ **Read URLs from a File**
function readUrlsFromFile(filepath) {
    try {
        if (!fs.existsSync(filepath)) {
            console.error(`❌ File not found: ${filepath}`);
            return [];
        }
        const content = fs.readFileSync(filepath, 'utf8').trim();
        return content ? content.split('\n').map(url => url.trim()) : [];
    } catch (error) {
        console.error(`❌ Error reading file ${filepath}: ${error.message}`);
        return [];
    }
}

// ✅ **Generate Unique Output Folder**
function generateUniqueOutputDir(baseDir = './output', readableName = '') {
    const timestamp = new Date().toISOString().replace(/[-:.]/g, '').replace('T', '_').slice(0, 15);
    const scanId = Math.random().toString(36).substr(2, 8);
    let folderName = `scan_${timestamp}_${scanId}`;
    if (readableName) {
        folderName += `_${readableName.replace(/\s+/g, '_')}`;
    }
    return path.join(baseDir, folderName);
}

// ✅ **Ensure Directories Exist**
function ensureDirectories(outputDir, subDir = '') {
    const fullPath = path.join(outputDir, subDir);
    if (!fs.existsSync(fullPath)) {
        fs.mkdirSync(fullPath, { recursive: true });
        console.log(`📁 Created directory: ${fullPath}`);
    }
}

// ✅ **Sanitize Filenames**
function sanitizeFilename(url) {
    return url.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

// ✅ **Download Images (Now Skippable)**
async function downloadImages(imageUrls, imagesDir, rateLimitMs, skipDownload) {
    if (imageUrls.length === 0 || skipDownload) return;

    for (const url of imageUrls) {
        try {
            console.log(`📥 Downloading image: ${url}`);

            const response = await axios({
                url,
                method: 'GET',
                responseType: 'stream'
            });

            // Extract filename from URL
            const filename = path.basename(new URL(url).pathname);
            const filePath = path.join(imagesDir, filename);

            // Save image
            response.data.pipe(fs.createWriteStream(filePath));
            console.log(`✅ Image saved: ${filePath}`);

            if (rateLimitMs > 0) {
                await new Promise(resolve => setTimeout(resolve, rateLimitMs));
            }
        } catch (error) {
            console.error(`❌ Failed to download image: ${url} - ${error.message}`);
        }
    }
}

// ✅ **Process URLs (Fetch HTML, Extract Images, Save PDFs)**
async function processUrls(urls, outputDir, rateLimitMs, savePdfFlag, skipDownload) {
    let browser = null;

    try {
        if (savePdfFlag) {
            console.log("🚀 Launching Puppeteer...");
            browser = await puppeteer.launch({ headless: true });
        }

        for (const url of urls) {
            try {
                console.log(`🌍 Fetching HTML for: ${url}`);
                const response = await axios.get(url);
                const html = response.data;
                const sanitizedPage = sanitizeFilename(new URL(url).hostname + new URL(url).pathname);

                // 📁 Create Folders
                ensureDirectories(outputDir, `html/${sanitizedPage}`);
                ensureDirectories(outputDir, `images/${sanitizedPage}`);
                ensureDirectories(outputDir, `pdf/${sanitizedPage}`);

                // 📄 Save HTML
                const filePath = path.join(outputDir, `html/${sanitizedPage}/index.html`);
                fs.writeFileSync(filePath, `<!-- ${url} -->\n${html}`, 'utf8');
                console.log(`✅ Saved HTML: ${filePath}`);

                // 📷 Extract Images
                const $ = cheerio.load(html);
                const imageUrls = [];
                $('img[src]').each((_, element) => {
                    const imageUrl = $(element).attr('src');
                    if (imageUrl) {
                        const absoluteUrl = new URL(imageUrl, url).href;
                        imageUrls.push(absoluteUrl);
                    }
                });

                // 📄 Save Image URLs in `images.txt`
                const imagesTxtPath = path.join(outputDir, `images/${sanitizedPage}/images.txt`);
                if (imageUrls.length > 0) {
                    fs.writeFileSync(imagesTxtPath, imageUrls.join('\n'), 'utf8');
                    console.log(`✅ Saved image URLs: ${imagesTxtPath}`);

                    // 📥 **Download Images (Only If Not Skipping)**
                    await downloadImages(imageUrls, path.join(outputDir, `images/${sanitizedPage}`), rateLimitMs, skipDownload);
                }

                // 📄 Save PDF Screenshot
                if (savePdfFlag && browser) {
                    console.log(`📄 Generating PDF for: ${url}`);
                    const page = await browser.newPage();
                    await page.goto(url, { waitUntil: 'networkidle2' });

                    const pdfPath = path.join(outputDir, `pdf/${sanitizedPage}/index.pdf`);
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

// ✅ **Main Function**
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
    const savePdfFlag = args.includes('--pdf');
    const skipDownload = args.includes('--no-images'); // ✅ NEW FLAG!

    let allUrls = readUrlsFromFile('urls.txt');

    if (allUrls.length === 0) {
        console.error("❌ No URLs found to process.");
        process.exit(1);
    }

    const uniqueOutputDir = generateUniqueOutputDir(baseOutputDir, readableName);
    ensureDirectories(uniqueOutputDir);

    console.log(`📂 Processing URLs, saving files to: ${uniqueOutputDir}`);
    await processUrls(allUrls, uniqueOutputDir, rateLimitMs, savePdfFlag, skipDownload);

    console.log("✅ Program completed.");
    process.exit(0);
}

main();
