# DeepScrape

DeepScrape is a powerful web scraping tool built using Node.js and Puppeteer. It supports spider crawling, cookie banner handling, and full-page screenshots.

## Features

- 🔍 **Spider Mode**: Crawl websites recursively, saving HTML, images, and screenshots.
- 🍪 **Cookie Banner Handling**: Automatically detects and dismisses cookie banners.
- 📸 **Screenshot Capture**: Captures full-page WEBP screenshots.
- 📂 **Sitemap Support**: Extract URLs from sitemaps for efficient crawling.
- ⏳ **Rate Limiting**: Control the delay between requests.

## Installation

1. Install [Node.js](https://nodejs.org/)
2. Clone or download this repository:
   ```sh
   git clone https://github.com/yourusername/DeepScrape.git
   cd DeepScrape
   ```
3. Install dependencies:
   ```sh
   npm install
   ```

## Usage

Basic usage:

```sh
node deepscrape.cjs -u https://example.com
```

### **Modes**

- **Single URL Scan**:

  ```sh
  node deepscrape.cjs -u https://example.com
  ```

- **Sitemap Scan**:

  ```sh
  node deepscrape.cjs -sm https://example.com/sitemap.xml
  ```

- **Spider Crawl** (Recursively follows same-domain links):

  ```sh
  node deepscrape.cjs -spider https://example.com
  ```

- **Batch Processing (From a File)**:

  ```sh
  node deepscrape.cjs -f urls.txt
  ```

- **Ignoring URLs**:
  ```sh
  node deepscrape.cjs -f urls.txt -ign "https://example.com/private"
  ```

## Options

```sh
-h, --help          Show help message.
-u <url>           Scrape a single URL.
-f <file>          Read URLs from a file.
-spider <url>      Spider (recursively) same-domain links.
-sm <sitemap>      Load URLs from a sitemap.
-ss                Save full-page screenshots.
--no-images        Skip downloading images.
--rate-limit <ms>  Set delay between requests.
```

## Output

Results are saved in the `output/` folder:

```
output/
├── scan_<timestamp>_<random>/
│   ├── example.com/
│   │   ├── index.html
│   │   ├── images/
│   │   ├── screenshots/
│   ├── spider_report.txt
```

## License

MIT License. Free to use and modify.
