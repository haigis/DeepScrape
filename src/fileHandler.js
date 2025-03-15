import fs from 'fs';
import path from 'path';

/**
 * Ensures the given directory exists, creating it if necessary.
 * @param {string} baseDir - The base directory.
 * @param {string} relativePath - The relative path inside the base directory.
 * @returns {string} The full path to the ensured directory.
 */
export function ensureDir(baseDir, relativePath) {
    if (!relativePath) {
        throw new Error("❌ Invalid relativePath provided to ensureDir: " + relativePath);
    }

    const fullPath = path.join(baseDir, relativePath);
    if (!fs.existsSync(fullPath)) {
        fs.mkdirSync(fullPath, { recursive: true });
    }
    return fullPath;
}

/**
 * Generates an output directory structure using UK date format.
 * Example:
 * output/
 * ├── www.example.com/
 * │   ├── 15-03-2025/
 *
 * @param {string} baseUrl - The website URL.
 * @returns {string} The generated directory path.
 */
export function generateOutputDir(baseUrl) {
    try {
        const now = new Date();
        const domain = new URL(baseUrl).hostname;
        const datePart = now.toLocaleDateString('en-GB').replace(/\//g, '-'); // 15-03-2025
        return path.join('output', domain, datePart);
    } catch (error) {
        console.error("❌ Error in generateOutputDir():", error);
        return "output/unknown"; // Prevents returning undefined
    }
}

/**
 * Converts a URL into a structured folder path.
 * Example:
 *  - Input: https://www.example.com/path/to/page
 *  - Output: www.example.com/path/to/page
 * @param {string} url - The URL to convert into a folder path.
 * @returns {string} The folder path representation of the URL.
 */
export function buildFolderPath(url) {
    try {
        const { hostname, pathname } = new URL(url);
        const segments = pathname.split('/').filter(Boolean);
        return path.join(hostname, ...segments);
    } catch (error) {
        console.error(`❌ Error parsing URL for folder path: ${url}`, error.message);
        return 'unknown_site';
    }
}

/**
 * Fixes relative paths in HTML content by converting them to absolute URLs.
 * Example:
 * - Converts `<img src="/image.png">` to `<img src="https://www.example.com/image.png">`
 * @param {string} html - The HTML content.
 * @param {string} baseUrl - The base URL to resolve relative paths.
 * @returns {string} Updated HTML with absolute paths.
 */
export function fixRelativePaths(html, baseUrl) {
    return html.replace(/(src|href)="(?!http)(.*?)"/g, (_, attr, link) => {
        try {
            return `${attr}="${new URL(link, baseUrl).href}"`;
        } catch (error) {
            console.warn(`⚠️ Could not resolve relative path: ${link} for base ${baseUrl}`);
            return `${attr}="${link}"`;
        }
    });
}
