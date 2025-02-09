const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const xml2js = require('xml2js');
const { URL } = require('url');

// Version

function displayHelp() {
    console.log(`
Marks Web Crawler - Version 2.4

Usage:
  node author.js [options] [file_path | scanID]

Options:
  -h, --help            Show this help message and exit.
  --download-images     Download the extracted images from a scan.
  --rate-limit <ms>     Add a delay (in milliseconds) between operations. Default is 1000ms.
  -n <name>             Add a readable name to the scan folder.
  -sm <url>             Specify a sitemap URL to process directly.
  -f <file_path>        Specify a local file containing URLs to process.

Examples:

1. Run a new scan:
   node author.js

   This creates a new folder in the "output" directory with a unique name, such as:
   output/scan_YYYYMMDD_HHMMSS_<scanID>/
   Inside the folder:
   - HTML files are saved in the "html/" subfolder.
   - Extracted image URLs are saved in "images.txt".
   - Images can be downloaded later using the --download-images option.

2. Add a readable name to the scan folder:
   node author.js -n MyScanName

   This creates a folder with the readable name added, e.g.,:
   output/scan_YYYYMMDD_HHMMSS_<scanID>_MyScanName/

3. Process a specific sitemap URL:
   node author.js -sm https://example.com/sitemap.xml

   This will extract URLs from the sitemap and process them like any other URL.

4. Process URLs from a local file:
   node author.js -f ./my-urls.txt

   This will read the file, extract URLs, and process them like any other input.

5. Download images from the most recent scan:
   node author.js --download-images

6. Include sitemap URLs in urls.txt:
   node author.js

   This script will process the sitemap, extract all URLs, and save HTML and image URLs.
`);
    process.exit(0);
}

// Helper function to fetch and parse a sitemap.xml file
async function fetchSitemapUrls(sitemapUrl) {
    try {
        console.log(`Fetching sitemap: ${sitemapUrl}`);
        const response = await axios.get(sitemapUrl);
        const xmlContent = response.data;

        // Parse the sitemap XML
        const parsedXml = await xml2js.parseStringPromise(xmlContent);
        const urls = parsedXml.urlset.url.map(entry => entry.loc[0]);
        console.log(`Extracted ${urls.length} URLs from sitemap.`);
        return urls;
    } catch (error) {
        console.error(`Error fetching or parsing sitemap: ${error.message}`);
        return [];
    }
}

// Helper function to get the latest scan folder based on timestamp
function getLatestScanFolder(baseDir) {
    if (!fs.existsSync(baseDir)) {
        return null;
    }

    const folders = fs.readdirSync(baseDir)
        .map(folder => path.join(baseDir, folder))
        .filter(folder => fs.lstatSync(folder).isDirectory())
        .sort((a, b) => fs.statSync(b).ctimeMs - fs.statSync(a).ctimeMs);

    return folders.length > 0 ? folders[0] : null;
}

// Helper function to generate a unique scan ID
function generateScanId() {
    return Math.random().toString(36).substr(2, 8); // 8-character alphanumeric ID
}

// Helper function to generate a unique output directory name with a scan ID and optional name
function generateUniqueOutputDir(baseDir = './output', readableName = '') {
    const timestamp = new Date().toISOString().replace(/[-:.]/g, '').replace('T', '_').slice(0, 15);
    const scanId = generateScanId();
    let folderName = `scan_${timestamp}_${scanId}`;
    if (readableName) {
        folderName += `_${readableName.replace(/\s+/g, '_')}`;
    }
    return path.join(baseDir, folderName);
}

// Helper function to ensure required directories exist
function ensureDirectories(outputDir) {
    const directories = ['html', 'images'];
    directories.forEach(subdir => {
        const dirPath = path.join(outputDir, subdir);
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
            console.log(`Created directory: ${dirPath}`);
        }
    });
}

// Helper function to read URLs from a file
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

// Function to clean quality information from image URLs
function cleanQualityInfo(url) {
    return url.replace(/\.(large|xsmall|medium|small|extra_large)\.medium_quality/, '');
}

// Function to fetch HTML, extract images, and save image URLs
async function processUrls(urls, outputDir, rateLimitMs) {
    const htmlDir = path.join(outputDir, 'html');
    const imagesTxtPath = path.join(outputDir, 'images.txt');
    const allImages = new Set(); // Use a Set to prevent duplicates

    for (const url of urls) {
        try {
            console.log(`Fetching HTML for: ${url}`);
            const response = await axios.get(url);
            const html = response.data;

            // Encode the URL to create a valid filename
            const encodedFileName = encodeURIComponent(url) + '.html';
            const filePath = path.join(htmlDir, encodedFileName);

            // Save the original URL as a comment in the HTML file
            const htmlWithComment = `<!-- ${url} -->\n${html}`;
            fs.writeFileSync(filePath, htmlWithComment, 'utf8');
            console.log(`Saved HTML to: ${filePath}`);

            // Extract images
            const $ = cheerio.load(html);
            const baseUrl = new URL(url);
            $('img[src]').each((_, element) => {
                const rawSrc = $(element).attr('src');
                if (rawSrc) {
                    try {
                        const resolvedUrl = new URL(rawSrc, baseUrl).href;
                        const cleanedUrl = cleanQualityInfo(resolvedUrl);
                        allImages.add(cleanedUrl);

                        // Check for 3_1 or 16_9 in the filename and add counterpart
                        if (cleanedUrl.includes('3_1')) {
                            allImages.add(cleanedUrl.replace('3_1', '16_9'));
                        } else if (cleanedUrl.includes('16_9')) {
                            allImages.add(cleanedUrl.replace('16_9', '3_1'));
                        }
                    } catch (error) {
                        console.error(`Error resolving image URL: ${rawSrc}`);
                    }
                }
            });

            if (rateLimitMs > 0) {
                await new Promise(resolve => setTimeout(resolve, rateLimitMs));
            }
        } catch (error) {
            console.error(`Error processing URL ${url}: ${error.message}`);
        }
    }

    // Save all image URLs to images.txt
    if (allImages.size > 0) {
        fs.writeFileSync(imagesTxtPath, Array.from(allImages).join('\n'), 'utf8');
        console.log(`Saved image URLs to: ${imagesTxtPath}`);
    } else {
        console.log('No images found.');
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

    let allUrls = [];

    if (sitemapIndex !== -1) {
        const sitemapUrl = args[sitemapIndex + 1];
        const sitemapUrls = await fetchSitemapUrls(sitemapUrl);
        allUrls = allUrls.concat(sitemapUrls);
    } else if (fileIndex !== -1) {
        const filePath = args[fileIndex + 1];
        allUrls = readUrlsFromFile(filePath);

        if (allUrls.length === 0) {
            console.error(`Error: No URLs found in file '${filePath}'.`);
            process.exit(1);
        }
    } else {
        const urls = readUrlsFromFile('urls.txt');

        if (urls.length === 0) {
            console.error(`Error: No URLs found in 'urls.txt'.`);
            console.log('Try node scan.cjs -h for help')
            process.exit(1);
        }

        // Check for sitemap URLs and process them
        const sitemapUrls = urls.filter(url => url.endsWith('sitemap.xml'));
        allUrls = urls.filter(url => !url.endsWith('sitemap.xml'));

        for (const sitemapUrl of sitemapUrls) {
            const extractedUrls = await fetchSitemapUrls(sitemapUrl);
            allUrls = allUrls.concat(extractedUrls);
        }
    }

    const uniqueOutputDir = generateUniqueOutputDir(baseOutputDir, readableName); // Create a new folder for this run
    ensureDirectories(uniqueOutputDir);

    console.log(`Processing URLs to fetch HTML, extract images, and save to '${uniqueOutputDir}'...`);
    await processUrls(allUrls, uniqueOutputDir, rateLimitMs);
    console.log(`Scan completed with ID: ${path.basename(uniqueOutputDir).split('_').pop()}`);

    console.log('Program completed.');
}

main();
