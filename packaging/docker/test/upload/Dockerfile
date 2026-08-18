# Headless-Chrome browser-upload tester (D4).
#
# Drives a real browser file upload against a running chan server to prove the
# BROWSER path is not gated by chan-desktop's Tauri upload ACL (that ACL gates
# the desktop client only; a browser POSTs /api/fs/upload directly).
#
# Uses Debian's chromium package + puppeteer-core (no chromium download at npm
# install time, and the system package pulls its own shared libs).
#
#   docker build -f packaging/docker/test/upload/Dockerfile -t chan-upload-test:dev \
#       packaging/docker/test/upload
FROM node:20-bookworm-slim

RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        chromium ca-certificates fonts-liberation tini && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY upload-test.mjs ./

# puppeteer-core launches the distro chromium; the test passes --no-sandbox
# because the container has no user-namespace sandbox.
ENV CHROMIUM_PATH=/usr/bin/chromium
# tini reaps the chromium subprocesses so a finished run exits cleanly.
ENTRYPOINT ["tini", "--", "node", "upload-test.mjs"]
