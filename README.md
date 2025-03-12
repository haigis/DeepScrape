
# DeepScrape

**Version 7** - (Cookie Banner + WEBP Screenshot + Sitemap Support)

## Usage
```bash
node deepscrape.cjs [options]
```

### Options:
- `-h, --help` - Display help information
- `--no-images` - Skip downloading images from the page.
- `--rate-limit <ms>` - Delay between operations (default: 1000ms).
- `-n <name>` - (Optional) Name for the scan folder.
- `-ss` - Save a full-page WEBP screenshot for each URL (at 1440x900 in headless mode).
- `-sm <sitemap_url>` - Use the provided sitemap URL to read URLs instead of urls.txt.
- `-ign <ignore_urls>` - (Optional) Comma-separated list of URL prefixes to ignore (child pages will also be ignored).

## Examples

Minimal scan:
```bash
node deepscrape.cjs
```

Save screenshots in WEBP:
```bash
node deepscrape.cjs -ss -n MyScreens
```

No images, with screenshots:
```bash
node deepscrape.cjs -ss --no-images -n NoImages
```

Rate limit 3s:
```bash
node deepscrape.cjs --rate-limit 3000 -ss
```

Scan using sitemap and ignore URLs:
```bash
node deepscrape.cjs -sm https://example.com/sitemap.xml -ign "https://www.barclays.co.uk/branch-finder/,https://www.barclays.co.uk/contact-us/"
```

## Features
- ✅ Full-page WEBP screenshots (1440x900).
- ✅ Automatic cookie banner handling (configurable via cookie_selectors.json).
- ✅ Sitemap support for URL extraction.
- ✅ Customizable rate-limiting.
- ✅ Option to skip image downloads.
- ✅ Ignore specific URLs and their child pages.
- ✅ CLI progress bar with ETA.

## Configuration (cookie_selectors.json)
Cookie banner handling via JSON:
```json
{
  "barclays.co.uk": {
    "buttonTexts": ["Reject optional cookies"],
    "bannerSelector": "#cookieBannerContainer"
  },
  "nationwide.co.uk": {
    "buttonTexts": ["Allow essential cookies only"],
    "bannerSelector": "#cookieBannerContainer",
    "rejectSelector": "#onetrust-reject-all-handler"
  },
  "en.wikipedia.org": {
    "buttonTexts": ["Accept the cookies"],
    "bannerSelector": "#onetrust-banner-sdk"
  }
}
```

## Dependencies
```bash
npm install puppeteer axios cheerio sharp cli-progress
```

## Example Output Folder Structure
```
output/
└── www.barclays.co.uk
    └── premier-banking
        └── barclayloan
            ├── barclayloan.html
            ├── barclayloan.webp
            └── images
                ├── images.txt
                └── image1.jpg
```
