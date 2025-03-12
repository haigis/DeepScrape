
# DeepScrape

DeepScrape is a powerful web scraping toolkit built with Puppeteer, Axios, Cheerio, and Sharp, featuring:

## Features

- **Cookie Banner Dismissal:** Automatically closes cookie banners using configurable selectors.
- **Screenshot Capturing** in WEBP format.
- **Image Downloading** (can be disabled).
- **Sitemap support** for crawling URLs.
- **Spider mode** to recursively find links, check broken URLs, and generate reports.

## Installation

```bash
npm install axios cheerio puppeteer sharp cli-progress
```

## Usage

```bash
node deepscrape.cjs [options]
```

### Common Options

- `-h, --help` Display help.
- `--no-images` Skip downloading images.
- `--rate-limit <ms>` Delay between operations (default: 1000ms).
- `-n <name>` Name for the scan folder.
- `-ss` Save screenshots in WEBP format.
- `-sm <sitemap_url>` Use sitemap to fetch URLs.
- `-ign <ignore_urls>` Comma-separated URLs to ignore.
- `-u <url>` Scrape a single URL.
- `-f <filepath>` Custom file with URLs.
- `-spider <urls>` Spider mode.

## Spider mode example

```bash
node deepscrape.cjs -spider https://example.com -ss
```

Creates `spider_report.txt` and saves each page's HTML, images, and screenshots in organized folders.

## Cookie Banners

Configure selectors in `cookie_selectors.json`:

```json
{
  "example.com": {
    "rejectSelector": "#reject-btn"
  }
}
```

## Examples

- Basic scrape:

```bash
node deepscrape.cjs
```

- Scrape with screenshots, no images:

```bash
node deepscrape.cjs -ss --no-images -n NoImages
```

- Spider with screenshot:

```bash
node deepscrape.cjs -spider https://example.com -ss
```

## License

MIT License.
