#!/usr/bin/env node

import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  { path: "/assets/demo-workspace.json", status: 404 },
  { path: "/assets/home/videos/terminal-commands.mp4", status: 200 },
  { path: "/install.ps1", status: 404 },
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
    await assertWorkspaceDemoDisabled();
  } finally {
    await close(server);
  }
  console.log(`smoked marketing dist routes on 127.0.0.1:${port}`);
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

async function assertWorkspaceDemoDisabled() {
  const assetDir = path.join(distRoot, "assets");
  const entries = await fs.readdir(assetDir);
  const forbidden = entries.filter((entry) => entry.startsWith("workspace-demo."));
  if (forbidden.length) {
    throw new Error(`workspace demo assets must stay disabled: ${forbidden.join(", ")}`);
  }
  const launcher = await fs.readFile(path.join(assetDir, "launcher-demo.js"), "utf8");
  for (const marker of ["workspace-demo", "openWorkspaceDemo"]) {
    if (launcher.includes(marker)) {
      throw new Error(`launcher demo must not open workspace demo: found ${marker}`);
    }
  }
}

main().catch((err) => {
  console.error(`dist smoke failed: ${err.message}`);
  process.exitCode = 1;
});
