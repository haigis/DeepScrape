# DeepScrape API — Node 22 + Chromium for Puppeteer.
FROM node:22-slim

# Debian's chromium instead of Puppeteer's Chrome-for-Testing download:
# the build host's IP range gets 403s from Google's CDN, and an apt
# package is one less external download to break anywhere.
RUN apt-get update && apt-get install -y --no-install-recommends     chromium ca-certificates fonts-liberation wget     && rm -rf /var/lib/apt/lists/*

# Puppeteer drives the system chromium; never download a browser.
ENV PUPPETEER_SKIP_DOWNLOAD=1
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Run as a non-root user so Chrome can keep its sandbox.
#
# Chrome refuses to start as root unless --no-sandbox is passed, and that
# flag removes a real layer of isolation for a crawler whose whole job is
# loading pages from sites we do not control. Creating a user is cheaper
# than accepting that.
#
# The browser is installed as this user so the puppeteer cache lands in
# its home directory rather than /root, which it could not then read.
RUN groupadd --system --gid 1001 scanner     && useradd --system --uid 1001 --gid scanner --create-home scanner     && mkdir -p /data/output     && chown -R scanner:scanner /app /data

USER scanner

COPY --chown=scanner:scanner package*.json ./
RUN npm ci

COPY --chown=scanner:scanner . .

# Scan output lives on a mounted volume in production.
ENV OUTPUT_DIR=/data/output
EXPOSE 5700
CMD ["npm", "run", "api"]
