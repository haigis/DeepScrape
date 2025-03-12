# **DeepScrape - Web Crawler & Image Extractor** 🚀

### **Version: 2.7** (Now with `--no-images` flag)

DeepScrape is a **powerful web crawler** that can:

- ✅ Fetch and save **HTML pages**
- ✅ Extract and save **image URLs**
- ✅ **Download** images *(or skip downloading with `--no-images`)*
- ✅ Generate **PDF snapshots** of fully rendered web pages
- ✅ Process **sitemap.xml** to extract URLs automatically
- ✅ Respect **rate limits** to avoid detection

---

## **📦 Installation**
### **1️⃣ Prerequisites**
- Install **Node.js** (>= v16)
- Install dependencies:
  ```sh
  npm install
  ```

### **2️⃣ Clone the Repository**
```sh
git clone https://github.com/haigis/DeepScrape.git
cd DeepScrape
```

---

## **🚀 Usage**

### **Basic Scan**
```sh
node deepscrape.cjs -n myscan
```
✅ Saves **HTML**, **images**, and **image URLs** in a unique folder.

### **Download Images** 🖼️
```sh
node deepscrape.cjs -n imagescan --download-images
```
✅ Extracts **image URLs** and **downloads all images**.

### **Generate PDFs** 📄
```sh
node deepscrape.cjs -n pdfscan --pdf
```
✅ Saves a **PDF snapshot** of each page.

### **Skip Image Downloads** 🚫🖼️
```sh
node deepscrape.cjs -n branch --pdf --no-images
```
✅ **No images downloaded** (but `images.txt` will still be saved).

### **Process a Sitemap** 🌍
```sh
node deepscrape.cjs -sm https://example.com/sitemap.xml
```
✅ **Extracts URLs** from the sitemap and processes them.

### **Set a Rate Limit** ⏳
```sh
node deepscrape.cjs -n slowcrawl --rate-limit 3000
```
✅ Adds a **3-second delay** between requests.

---

## **📂 Output Structure**
```
/output/scan_YYYYMMDD_HHMMSS_<scanID>/
│── html/
│   ├── example_com/
│   │   ├── index.html
│── images/
│   ├── example_com/
│   │   ├── images.txt  ✅ Image URLs
│   │   ├── img1.png    ✅ Image files (if downloaded)
│── pdf/
│   ├── example_com/
│   │   ├── index.pdf   ✅ PDF snapshots
```

---

## **💡 Contributing**
PRs are welcome! Open an **issue** if you find a bug.

---

## **📜 License**
MIT License © 2024 Haigis/DeepScrape
