# DeepScrape

**DeepScrape** is a powerful web scraper that extracts HTML, screenshots, and links from websites. It supports spider crawling, sitemap parsing, and batch processing from files.

## Features

- 🌍 Scrape single URLs
- 🕷️ Spider Crawl: Recursively scrape internal links
- 📑 Parse and scrape URLs from sitemaps
- 📂 Batch process multiple URLs from a file
- 🖼 Capture webpage screenshots (optional)
- 🚀 Save HTML with corrected relative paths
- 🔗 Store discovered and broken links

## Installation

### Prerequisites

- Node.js v22+
- Puppeteer
- Express.js

### Install Dependencies

```bash
npm install
```

## Usage

### Start the API

```bash
npm run api
```

### API Endpoints

#### Scrape a Single URL

```http
POST /scrape
Content-Type: application/json

{
  "url": "https://example.com",
  "screenshot": true,
  "downloadImages": false,
  "rateLimit": 1000
}
```

#### Spider Crawl (Recursive Scraping)

```http
POST /scrape/spider
Content-Type: application/json

{
  "url": "https://example.com",
  "maxDepth": 2,
  "screenshot": true,
  "downloadImages": false,
  "rateLimit": 1000
}
```

#### Scrape from a Sitemap

```http
POST /scrape/sitemap
Content-Type: application/json

{
  "sitemapUrl": "https://example.com/sitemap.xml",
  "ignoreUrls": ["login", "register"],
  "screenshot": true,
  "downloadImages": false,
  "rateLimit": 1000
}
```

#### Scrape URLs from a File

```http
POST /scrape/file
Content-Type: application/json

{
  "filePath": "urls.txt",
  "ignoreUrls": [],
  "screenshot": true,
  "downloadImages": false,
  "rateLimit": 1000
}
```

## Output Structure

```
output/
├── example.com/
│   ├── 14-03-2025/
│   │   ├── index.html
│   │   ├── page1.html
│   │   ├── page1.webp (screenshot)
│   │   ├── all-links.txt
│   │   ├── broken-links.txt
│   │   ├── incoming-links.txt
```

## License

MIT License

---

For more details, visit [GitHub Repository](https://github.com/your-repo/DeepScrape).