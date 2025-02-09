# DeepScrape - Web Crawler & Image Extractor

## Overview

**DeepScrape** is a command-line web crawler designed to fetch HTML pages, extract images, and process sitemap files. It supports rate limiting, readable folder naming, and automatic URL extraction from sitemap.xml files.

### Features

✅ **Fetch HTML Pages** – Saves web pages as `.html` files for later analysis.

✅ **Extract Image URLs** – Collects image URLs from web pages and stores them in `images.txt`.

✅ **Download Images (Optional)** – Allows downloading of extracted images.

✅ **Sitemap Processing** – Parses sitemap.xml files to automatically extract URLs.

✅ **Rate Limiting** – Prevents excessive requests with configurable delays.

✅ **Readable Folder Naming** – Organizes scans with timestamps and custom names.

## Installation

### Prerequisites

Ensure you have **Node.js** installed on your system.

```sh
node -v  # Check Node.js version
npm -v   # Check npm version
```

### Clone the Repository

```sh
git clone https://github.com/haigis/DeepScrape.git
cd DeepScrape
```

### Install Dependencies

```sh
npm install
```

## Usage

### Basic Scan

```sh
node scan.cjs
```

This will:

- Create a new folder under `output/` (e.g., `output/scan_YYYYMMDD_HHMMSS_<scanID>/`).
- Save HTML files in `html/`.
- Store extracted image URLs in `images.txt`.

### Options

#### 1. Show Help Menu

```sh
node scan.cjs -h
```

#### 2. Add a Readable Name to Scan Folder

```sh
node scan.cjs -n MyCustomScan
```

Example folder structure:

```
output/scan_YYYYMMDD_HHMMSS_<scanID>_MyCustomScan/
```

#### 3. Process URLs from a Sitemap

```sh
node scan.cjs -sm https://example.com/sitemap.xml
```

Extracts URLs from the sitemap and processes them.

#### 4. Process URLs from a Local File

```sh
node scan.cjs -f urls.txt
```

Reads URLs from `urls.txt` and scrapes each page.

#### 5. Download Images from the Last Scan

```sh
node scan.cjs --download-images
```

#### 6. Adjust Rate Limit (in milliseconds)

```sh
node scan.cjs --rate-limit 2000
```

Slows down requests to avoid detection (default: 1000ms).

## Output Structure

After running a scan, the output directory contains:

```
G:\github\DeepScrape\output\
│── scan_YYYYMMDD_HHMMSS_<scanID>/
│   │── html/          # Saved HTML files
│   │── images.txt     # Extracted image URLs
│   └── images/        # (Optional) Downloaded images
```

## Contributing

Feel free to submit **pull requests** or open **issues** for improvements!

## License

MIT License © 2024 Haigis/DeepScrape
