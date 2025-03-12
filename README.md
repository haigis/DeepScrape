
# DeepScrape - Version 8

## Overview

DeepScrape is an advanced web scraping tool that provides comprehensive features for automated data collection and website crawling.

## Features Explained

### 1. Cookie Banner Handling
Automatically dismisses cookie consent banners using custom selectors defined per domain in `cookie_selectors.json`. Ensures clean screenshots and HTML.

Example configuration:
```json
{
  "example.com": {
    "rejectSelector": "#reject-btn"
  }
}
```

### 2. Screenshot Capture (WEBP)
Captures full-page screenshots in high-quality WEBP format. Perfect for visual archiving and analysis.

### 3. Spider Mode 🕷️
Recursively explores a website, following internal links, checking for broken links (HTTP status codes), and creates a detailed report (`spider_report.txt`).

### 4. Sitemap Support
Automatically fetches URLs from XML sitemaps, simplifying bulk website scraping.

### 5. Image Downloading
Automatically identifies and downloads images from each webpage.

### 6. Taxonomy-Based Output
Content is organized neatly in folders based on URL taxonomy, ensuring logical and structured data storage.

## Installation

```bash
npm install axios cheerio puppeteer sharp cli-progress
```

## Usage

```bash
node deepscrape.cjs [options]
```

### Command-Line Options

- `-h, --help` Display this help message.
- `--no-images` Skip image downloads.
- `--rate-limit <ms>` Delay between requests (default: 1000ms).
- `-n <name>` Name the output folder.
- `-ss` Capture screenshots in WEBP.
- `-sm <sitemap_url>` Read URLs from a sitemap instead of a file.
- `-ign <urls>` Ignore URLs (comma-separated prefixes).
- `-u <url>` Scrape a single URL.
- `-f <filepath>` Scrape URLs from a custom file.
- `-spider <urls>` Spider recursively from given URLs.

### Spider Mode Example

Spider a website with screenshots and no images:

```bash
node deepscrape.cjs -spider https://www.example.com -ss --no-images
```

This will:

- Recursively explore internal links.
- Check and report link statuses.
- Save HTML and screenshots.

### Cookie Banner Configuration (`cookie_selectors.json`)

Define CSS selectors per domain to dismiss cookie banners automatically:

```json
{
  "example.com": {
    "rejectSelector": "#reject-cookies-btn"
  },
  "another.com": {
    "rejectSelector": ".cookie-reject-btn"
  }
}
```

### Examples

- **Minimal scan:**

```bash
node deepscrape.cjs
```

- **Screenshot enabled, no images:**

```bash
node deepscrape.cjs -ss --no-images
```

- **Spider with Screenshot:**

```bash
node deepscrape.cjs -spider https://www.nationwide.co.uk -ss
```

- **Spider multiple URLs with screenshots:**

```bash
node deepscrape.cjs -spider https://site1.com,https://site2.com -ss
```

## Output Structure

```
output/
└── scan_<timestamp>_<id>/
    ├── domain.com
    │   ├── page.html
    │   ├── images/
    │   └── image files...
    └── spider_report.txt
```

## Known Issues

- Ensure `cookie_selectors.json` exists and is correctly formatted.

## License

MIT License
