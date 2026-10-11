#!/usr/bin/env node

import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const scriptPath = fileURLToPath(import.meta.url);
const siteRoot = path.resolve(path.dirname(scriptPath), "..");
const distRoot = path.join(siteRoot, "dist");

const checks = [
  { path: "/", status: 200, includes: "data-carousel" },
  { path: "/", status: 200, includes: 'src="/assets/home/videos/workspace-animation.mp4"' },
  { path: "/", status: 200, includes: 'src="/assets/home/videos/terminal-commands.mp4"' },
  { path: "/", status: 200, excludes: 'src="/assets/home/team-spawn.png"' },
  { path: "/", status: 200, includes: "A new kind of" },
  { path: "/", status: 200, excludes: "launcher-demo.js" },
  { path: "/", status: 200, includes: 'href="/install/">Install' },
  { path: "/", status: 200, includes: 'href="/animations/">Animations' },
  { path: "/", status: 200, excludes: "animation-gallery.js" },
  { path: "/animations/", status: 200, includes: "Room for motion." },
  { path: "/animations/", status: 200, includes: 'src="/assets/animation-gallery.js"' },
  { path: "/animations/", status: 200, includes: 'href="https://x.com/hisadan/status/1937852456584814776"' },
  { path: "/animations/", status: 200, includes: 'href="https://21st.dev/@efferd/components/dotted-surface"' },
  { path: "/animations/", status: 200, includes: 'href="https://discourse.threejs.org/t/twisted-torus-parametric/56492"' },
  { path: "/assets/animation-gallery.js", status: 200 },
  { path: "/assets/animation-gallery.css", status: 200 },
  { path: "/manual/install/", status: 200, includes: 'id="launcher-demo"' },
  { path: "/manual/install/", status: 200, includes: 'src="/assets/launcher-demo.js"' },
  { path: "/manual/devserver/", status: 200, includes: 'src="/manual/demo/devserver/"' },
  { path: "/manual/demo/devserver/", status: 200, includes: 'data-variant="devserver"' },
  { path: "/install/", status: 200, includes: "Install Chan" },
  { path: "/install/", status: 200, before: ['id="desktop"', 'id="server"'] },
  { path: "/install/", status: 200, includes: "curl -fsSL https://chan.app/install.sh | sh" },
  { path: "/install/", status: 200, includes: 'data-release-download="desktop-linux-appimage"' },
  { path: "/install/", status: 200, includes: 'data-release-download="gateway-profile-deb-amd64"' },
  { path: "/install/", status: 200, includes: "ppa:fiorix/chan" },
  { path: "/install/", status: 200, includes: "dnf copr enable fiorix/chan" },
  { path: "/install/", status: 200, includes: "paru -S chan-desktop" },
  { path: "/install/", status: 200, includes: "sudo apt install chan</b>" },
  { path: "/install/", status: 200, includes: "sudo dnf install chan</b>" },
  { path: "/install/", status: 200, includes: "paru -S chan</b>" },
  { path: "/install/", status: 200, excludes: 'data-release-download="cli-macos-arm64"' },
  { path: "/install/", status: 200, excludes: 'data-release-download="cli-windows-x64"' },
  { path: "/install/", status: 200, excludes: 'data-release-download="cli-linux-x64"' },
  { path: "/install/", status: 200, excludes: 'data-release-download="desktop-linux-rpm-amd64"' },
  { path: "/install/", status: 200, excludes: 'data-release-download="cli-linux-deb-amd64"' },
  {
    path: "/install.sh",
    status: 200,
    includes: 'DEFAULT_METADATA_BASE="https://chan.app/dl/cli"',
  },
  {
    path: "/install.ps1",
    status: 200,
    includes: '$DefaultMetadataBase = "https://chan.app/dl/cli"',
  },
  { path: "/assets/home/videos/terminal-commands.mp4", status: 200 },
];

async function main() {
  await assertDistReady();
  const server = createServer(handleRequest);
  await listen(server);
  const { port } = server.address();
  try {
    for (const check of checks) {
      await runCheck(port, check);
    }
    await checkManual(port);
  } finally {
    await close(server);
  }
  console.log(`smoked marketing dist routes on 127.0.0.1:${port}`);
}

async function checkManual(port) {
  const sections = ["", "install", "navigation", "devserver", "terminal", "editor", "files", "graph", "dashboard", "search", "settings", "screensavers"];
  const routes = sections.map((slug) => `/manual/${slug ? `${slug}/` : ""}`);
  const documents = new Map();
  try {
    for (const route of routes) {
      const response = await fetch(`http://127.0.0.1:${port}${route}`);
      assert.equal(response.status, 200, route);
      const dom = new JSDOM(await response.text(), { url: `http://127.0.0.1:${port}${route}` });
      documents.set(route, dom);
      const doc = dom.window.document;
      assert.equal(doc.querySelectorAll("h1").length, 1, `${route}: one page title`);
      const ids = [...doc.querySelectorAll("[id]")].map((el) => el.id);
      assert.equal(new Set(ids).size, ids.length, `${route}: unique anchors`);
      const nav = doc.querySelector('nav[aria-label="Manual sections"]');
      assert.ok(nav, `${route}: manual navigation`);
      assert.deepEqual([...nav.querySelectorAll("li a")].map((a) => a.getAttribute("href")), routes, `${route}: section order`);
      const active = nav.querySelectorAll('[aria-current="page"]');
      assert.equal(active.length, 1, `${route}: one active section`);
      assert.equal(active[0].getAttribute("href"), route, `${route}: correct active section`);
      const index = routes.indexOf(route);
      assert.equal(doc.querySelector('[rel="prev"]')?.getAttribute("href"), routes[index - 1], `${route}: previous section`);
      assert.equal(doc.querySelector('[rel="next"]')?.getAttribute("href"), routes[index + 1], `${route}: next section`);
      assert.ok(doc.querySelector("#manual-content .manual-block p"), `${route}: static content without JavaScript`);
      if (route !== "/manual/install/") {
        assert.equal(doc.querySelector('script[src="/assets/launcher-demo.js"]'), null, `${route}: no unused launcher bundle`);
      }
    }
    for (const [route, dom] of documents) {
      for (const link of dom.window.document.querySelectorAll("a[href]")) {
        const target = new URL(link.href);
        if (target.origin !== dom.window.location.origin || !target.hash) continue;
        const targetDoc = documents.get(target.pathname)?.window.document;
        if (!targetDoc) continue;
        assert.ok(targetDoc.getElementById(decodeURIComponent(target.hash.slice(1))), `${route}: missing anchor ${link.getAttribute("href")}`);
      }
    }
  } finally {
    for (const dom of documents.values()) dom.window.close();
  }
}

async function assertDistReady() {
  const stat = await fs.stat(distRoot).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error("marketing dist is missing; run npm run build first");
  }
}

async function handleRequest(req, res) {
  try {
    const file = resolveRequestPath(req.url ?? "/");
    if (!file) {
      res.writeHead(404).end("not found");
      return;
    }
    const body = await fs.readFile(file);
    res.writeHead(200, { "content-type": contentType(file) });
    res.end(body);
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "EISDIR") {
      res.writeHead(404).end("not found");
    } else {
      res.writeHead(500).end("error");
    }
  }
}

function resolveRequestPath(rawUrl) {
  const url = new URL(rawUrl, "http://127.0.0.1");
  const decoded = decodeURIComponent(url.pathname);
  const relative = decoded.endsWith("/")
    ? path.posix.join(decoded.slice(1), "index.html")
    : decoded.slice(1);
  const candidate = path.resolve(distRoot, relative);
  if (candidate !== distRoot && !candidate.startsWith(`${distRoot}${path.sep}`)) {
    return null;
  }
  return candidate;
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".mp4")) return "video/mp4";
  if (file.endsWith(".sh")) return "text/x-shellscript; charset=utf-8";
  if (file.endsWith(".ps1")) return "text/plain; charset=utf-8";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".ico")) return "image/x-icon";
  return "application/octet-stream";
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function runCheck(port, check) {
  const url = `http://127.0.0.1:${port}${check.path}`;
  const response = await fetch(url);
  if (response.status !== check.status) {
    throw new Error(`${check.path} returned HTTP ${response.status}, expected ${check.status}`);
  }
  if (check.includes || check.excludes || check.before) {
    const body = await response.text();
    if (check.includes && !body.includes(check.includes)) {
      throw new Error(`${check.path} did not contain ${JSON.stringify(check.includes)}`);
    }
    if (check.excludes && body.includes(check.excludes)) {
      throw new Error(`${check.path} must not contain ${JSON.stringify(check.excludes)}`);
    }
    if (check.before) {
      const [first, second] = check.before;
      const firstOffset = body.indexOf(first);
      const secondOffset = body.indexOf(second);
      if (firstOffset < 0 || secondOffset < 0 || firstOffset >= secondOffset) {
        throw new Error(
          `${check.path} must contain ${JSON.stringify(first)} before ${JSON.stringify(second)}`,
        );
      }
    }
  }
}

main().catch((err) => {
  console.error(`dist smoke failed: ${err.message}`);
  process.exitCode = 1;
});
