# DeepScrape API — Node 22 + Chromium for Puppeteer.
FROM node:22-slim

# Chromium runtime dependencies.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 \
    libatk1.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 libgbm1 \
    libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 \
    libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 \
    libxrandr2 xdg-utils wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
# postinstall (if any) plus explicit browser download into the image.
RUN npm ci && npx puppeteer browsers install chrome

COPY . .

# Scan output lives on a mounted volume in production.
ENV OUTPUT_DIR=/data/output
EXPOSE 5700
CMD ["npm", "run", "api"]
