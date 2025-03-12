# DeepScrape - Web Crawler, Image Extractor & PDF Renderer

## Overview

**DeepScrape** is a command-line **web crawler** designed to:

- Fetch **HTML pages**
- Extract **image URLs**
- **Download images** (optional)
- **Process sitemaps** automatically
- **Save PDFs of fully rendered pages**
- **Limit request rate** to avoid detection

**Why Use DeepScrape?**

✔ **Organized Output** – Saves files into structured folders  
✔ **Sitemap Support** – Automatically extracts URLs from sitemaps  
✔ **PDF Rendering** – Captures fully rendered pages with Puppeteer  
✔ **Rate Limiting** – Prevents excessive requests  
✔ **Simple CLI** – Easy-to-use commands

---

## 📥 Installation

### Prerequisites

Ensure **Node.js** is installed:

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

---

## 🚀 Usage

### Basic Web Scrape

```sh
node deepscrape.cjs
```

This will:

✅ Create a new folder in `output/` (e.g., `output/scan_YYYYMMDD_HHMMSS_<scanID>/`).  
✅ Save HTML files in `html/`.  
✅ Extract image URLs into `images.txt`.

---

## 🔧 Command Options

### 1️⃣ Show Help Menu

```sh
node deepscrape.cjs -h
```

### 2️⃣ Add a Custom Scan Name

```sh
node deepscrape.cjs -n MyCustomScan
```

Example folder:

```
output/scan_YYYYMMDD_HHMMSS_<scanID>_MyCustomScan/
```

### 3️⃣ Process a Sitemap

```sh
node deepscrape.cjs -sm https://example.com/sitemap.xml
```

This extracts URLs from a **sitemap.xml** and processes them.

### 4️⃣ Process URLs from a File

```sh
node deepscrape.cjs -f urls.txt
```

Scrapes all URLs listed in `urls.txt`.

### 5️⃣ Save PDFs of Rendered Pages

```sh
node deepscrape.cjs --pdf -n pdfscan
```

This will:

✅ Load each page in **Puppeteer**  
✅ Save it as a **PDF** inside the `pdf/` folder

### 6️⃣ Download Images from the Last Scan

```sh
node deepscrape.cjs --download-images
```

### 7️⃣ Set a Rate Limit (in ms)

```sh
node deepscrape.cjs --rate-limit 2000
```

(Default: **1000ms** delay between requests)

---

## 📂 Output Structure

After running DeepScrape, results are stored inside an **organized folder**:

```
output/
│── scan_YYYYMMDD_HHMMSS_<scanID>_MyCustomScan/
│   │── html/          # Saved HTML files
│   │── images.txt     # Extracted image URLs
│   │── images/        # (Optional) Downloaded images
│   └── pdf/           # (Optional) Rendered PDFs
```

---

## 👨‍💻 Contributing

✔ Open an **issue** for bug reports  
✔ Submit **pull requests** for improvements

---

## 📜 License

MIT License © 2024 Haigis/DeepScrape

---

### 🚀 Next Steps

- **Commit & Push Version 2.5 to GitHub**

```sh
git add .
git commit -m "DeepScrape v2.5 - PDF support, fixes, improvements"
git push origin main
```

- **Update the release on GitHub** with the latest version.
