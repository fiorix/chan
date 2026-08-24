#!/usr/bin/env node
import { promises as fs } from "node:fs";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { build as viteBuild } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { gatewayServices } from "./gateway-services.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const siteRoot = path.resolve(path.dirname(scriptPath), "..");
const repoRoot = path.resolve(siteRoot, "..", "..", "..");
const srcRoot = path.join(siteRoot, "src");
const distRoot = path.join(siteRoot, "dist");
const githubRepoUrl = "https://github.com/fiorix/chan";
const cliMetadataBase = "https://chan.app/dl/cli";
const releasesMetadataPath = "/dl/releases.json";
// Raw CLI archives and the desktop .deb/.rpm assets still ship in /dl metadata,
// but the install page presents the shell installer and managed repositories
// instead of direct links, so they are not required page hooks.
const requiredDownloadIds = [
  // chan-desktop
  "desktop-macos-dmg",
  "desktop-linux-appimage",
  "desktop-linux-appimage-arm64",
  // chan-gateway: one .deb per service per arch, single-sourced from the
  // Makefile's GATEWAY_RELEASE_CRATES (see ./gateway-services.mjs). These ids
  // must match the install.html download buttons (validated below) and the ids
  // generate-release-metadata.mjs emits.
  ...gatewayServices.flatMap((service) =>
    ["amd64", "arm64"].map((arch) => `gateway-${service}-deb-${arch}`),
  ),
];

const requiredInputs = [
  path.join(srcRoot, "templates", "base.html"),
  path.join(srcRoot, "templates", "demo-embed.html"),
  path.join(srcRoot, "pages", "home.html"),
  path.join(srcRoot, "pages", "install.html"),
  path.join(srcRoot, "pages", "manual.html"),
  path.join(srcRoot, "install.sh"),
  path.join(srcRoot, "install.ps1"),
  path.join(srcRoot, "styles.css"),
  path.join(srcRoot, "site.js"),
  path.join(siteRoot, "chan-favicon.png"),
  path.join(siteRoot, "chan-mark.png"),
];

async function main() {
  await Promise.all(requiredInputs.map(assertFile));

  const version = await readWorkspaceVersion();
  const baseTemplate = await fs.readFile(path.join(srcRoot, "templates", "base.html"), "utf8");
  const homeTemplate = await fs.readFile(path.join(srcRoot, "pages", "home.html"), "utf8");
  const installTemplate = await fs.readFile(path.join(srcRoot, "pages", "install.html"), "utf8");
  const manualTemplate = await fs.readFile(path.join(srcRoot, "pages", "manual.html"), "utf8");
  const demoEmbedTemplate = await fs.readFile(path.join(srcRoot, "templates", "demo-embed.html"), "utf8");

  await fs.rm(distRoot, { recursive: true, force: true });
  await fs.mkdir(path.join(distRoot, "assets"), { recursive: true });

  await copyStaticAssets();
  await copyInstaller();
  await fs.writeFile(path.join(distRoot, "CNAME"), "chan.app\n");

  const sharedTemplateValues = {
    copyButton: renderCopyButton(),
    githubReleasesUrl: githubRepoUrl + "/releases",
  };
  const launcherDemoHead =
    '<link rel="stylesheet" href="/assets/launcher-demo.css" />\n<script type="module" src="/assets/launcher-demo.js"></script>';
  await writePage(
    "index.html",
    renderPage(baseTemplate, {
      active: "home",
      bodyClass: "home-page",
      title: "chan - a new kind of IDE",
      description:
        "Chan is a new kind of IDE: drive AI agents to ship faster. Local and remote, on macOS, Windows, and Linux, on x86 and arm64.",
      content: fillTemplate(homeTemplate, { version, ...sharedTemplateValues }),
    }),
  );

  await writePage(
    "install/index.html",
    renderPage(baseTemplate, {
      active: "install",
      bodyClass: "install-page",
      title: "Install chan",
      description: "Install Chan Desktop or the standalone chan CLI.",
      content: fillTemplate(installTemplate, { version, ...sharedTemplateValues }),
    }),
  );

  await writePage(
    "manual/index.html",
    renderPage(baseTemplate, {
      active: "manual",
      bodyClass: "manual-page",
      title: "Chan manual",
      description: "What chan is and how to get productive with it: terminals, workspaces, the command launcher, devservers, and the editor.",
      content: fillTemplate(manualTemplate, { version, ...sharedTemplateValues }),
      headExtra: launcherDemoHead,
    }),
  );

  // The manual's devserver-form demo rides in an iframe: a LauncherDemo mount
  // is one-per-page (module-level launcher stores), so the second instance
  // gets its own bare document instead of a second mount on /manual/.
  await writePage(
    "manual/demo/devserver/index.html",
    fillTemplate(demoEmbedTemplate, {
      title: "Add devserver demo",
      variant: "devserver",
    }),
  );

  await buildLauncherDemo();
  await validateDist(version);
  console.log(`built marketing dist for chan ${version}`);
}

async function assertFile(file) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error(`${file} is not a file`);
  } catch (err) {
    throw new Error(`missing required input: ${path.relative(repoRoot, file)} (${err.message})`);
  }
}

async function readWorkspaceVersion() {
  const cargoToml = await fs.readFile(path.join(repoRoot, "Cargo.toml"), "utf8");
  const match = cargoToml.match(/^\[workspace\.package\][\s\S]*?^version\s*=\s*"([^"]+)"/m);
  if (!match) throw new Error("workspace package version not found in Cargo.toml");
  return match[1];
}

async function copyStaticAssets() {
  await fs.copyFile(path.join(siteRoot, "chan-favicon.png"), path.join(distRoot, "chan-favicon.png"));
  await fs.copyFile(path.join(siteRoot, "chan-mark.png"), path.join(distRoot, "chan-mark.png"));
  await fs.copyFile(path.join(srcRoot, "styles.css"), path.join(distRoot, "assets", "site.css"));
  await fs.copyFile(path.join(srcRoot, "site.js"), path.join(distRoot, "assets", "site.js"));
  await copyDir(path.join(siteRoot, "assets"), path.join(distRoot, "assets"));
}

async function copyInstaller() {
  const shellSource = path.join(srcRoot, "install.sh");
  const shellTarget = path.join(distRoot, "install.sh");
  await fs.copyFile(shellSource, shellTarget);
  await fs.chmod(shellTarget, 0o755);
  await fs.copyFile(path.join(srcRoot, "install.ps1"), path.join(distRoot, "install.ps1"));
}

async function copyDir(source, target) {
  const entries = await fs.readdir(source, { withFileTypes: true });
  await fs.mkdir(target, { recursive: true });
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      await copyDir(from, to);
    } else if (entry.isFile()) {
      await fs.copyFile(from, to);
    }
  }
}

async function writePage(output, html) {
  const target = path.join(distRoot, output);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, html);
}

function renderPage(template, { active, bodyClass, title, description, content, headExtra = "" }) {
  return fillTemplate(template, {
    bodyClass,
    content,
    description: escapeHtml(description),
    headExtra,
    siteNav: renderSiteNav(active),
    title: escapeHtml(title),
  });
}

async function buildLauncherDemo() {
  await viteBuild({
    configFile: false,
    root: siteRoot,
    // Everything the demo build emits lives under /assets/; the dynamic
    // chunk loader resolves CSS preloads and asset urls against this base.
    base: "/assets/",
    plugins: [svelte()],
    resolve: {
      alias: {
        "@chan/launcher/demo": path.join(repoRoot, "web/packages/launcher/src/LauncherDemo.svelte"),
        "@chan/launcher/styles.css": path.join(repoRoot, "web/packages/launcher/src/styles.css"),
        "@chan/workspace-app/demo": path.join(
          repoRoot,
          "web/packages/workspace-app/src/WorkspaceDemo.svelte",
        ),
        "@chan/workspace-app/demo-data": path.join(
          repoRoot,
          "web/packages/workspace-app/src/demo/data.ts",
        ),
      },
    },
    build: {
      emptyOutDir: false,
      minify: false,
      outDir: path.join(distRoot, "assets"),
      rollupOptions: {
        input: path.join(srcRoot, "launcher-demo.ts"),
        output: {
          entryFileNames: "launcher-demo.js",
          chunkFileNames: "[name].js",
          assetFileNames: "[name].[ext]",
        },
      },
    },
  });

  // Scope each demo bundle's global CSS (`:root` variable blocks, `body`
  // rules) to its own frame so loading a demo chunk can never restyle the
  // marketing page around it.
  await scopeDemoCss("launcher-demo.css", ".launcher-demo-frame");
}

async function scopeDemoCss(fileName, frameSelector) {
  const cssPath = path.join(distRoot, "assets", fileName);
  let css;
  try {
    css = await fs.readFile(cssPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }
  css = css
    .replaceAll(':root[data-theme="light"]', `${frameSelector}[data-theme="light"]`)
    .replaceAll(":root", frameSelector)
    .replace(/(^|})\s*body\s*{/g, `$1 ${frameSelector} {`);
  await fs.writeFile(cssPath, css);
}

function renderSiteNav(active) {
  const links = [
    ["install", "/install/", "Install"],
    ["manual", "/manual/", "Manual"],
    ["github", githubRepoUrl, "GitHub"],
  ];
  return links
    .map(([key, href, label]) => {
      const attrs = key === active ? ' class="active" aria-current="page"' : "";
      return `<a${attrs} href="${href}">${label}</a>`;
    })
    .join("\n        ");
}

function renderCopyButton() {
  return `<button type="button" aria-label="Copy"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg></button>`;
}

function fillTemplate(template, values) {
  let rendered = template;
  for (const [key, value] of Object.entries(values)) {
    rendered = rendered.split(`{{${key}}}`).join(String(value));
  }
  const missing = rendered.match(/{{[a-zA-Z0-9_]+}}/g);
  if (missing) throw new Error(`unfilled template values: ${[...new Set(missing)].join(", ")}`);
  return rendered;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("'", "&#39;");
}

async function validateDist(version) {
  const files = await collectFiles(distRoot);
  const htmlFiles = files.filter((file) => file.endsWith(".html"));
  const allDistPaths = new Set(files.map((file) => path.relative(distRoot, file).split(path.sep).join("/")));
  const textByDistPath = new Map();

  for (const htmlFile of htmlFiles) {
    const html = await fs.readFile(htmlFile, "utf8");
    validateLocalLinks(htmlFile, html, allDistPaths);
  }

  const textFiles = files.filter((file) => /\.(html|css|js|sh|ps1|txt|xml)$/.test(file) || path.basename(file) === "CNAME");
  for (const file of textFiles) {
    const rel = path.relative(distRoot, file).split(path.sep).join("/");
    const text = await fs.readFile(file, "utf8");
    textByDistPath.set(rel, text);
    // The stale-copy sweep polices the site's own public copy: the pages,
    // the installer, and assets/site.{js,css}. All other js/css under
    // assets/ is bundler output (the launcher demo and its vendored
    // dependencies), which legitimately contains phrases like "backward
    // compatibility" or "legacy" in code and comments.
    const bundledAsset =
      rel.startsWith("assets/") && /\.(js|css)$/.test(rel) && !rel.startsWith("assets/site.");
    if (!bundledAsset) {
      validateNoStalePublicCopy(file, text);
    }
  }

  for (const required of ["index.html", "install/index.html", "manual/index.html", "manual/demo/devserver/index.html", "install.sh", "install.ps1", "CNAME"]) {
    if (!allDistPaths.has(required)) throw new Error(`dist is missing ${required}`);
  }

  validateReleaseDownloadContract(textByDistPath);
}

async function collectFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

function validateLocalLinks(htmlFile, html, allDistPaths) {
  const pageUrl = urlForOutput(path.relative(distRoot, htmlFile).split(path.sep).join("/"));
  const attrPattern = /\b(?:href|src)="([^"]+)"/g;
  for (const match of html.matchAll(attrPattern)) {
    validatePublicLink(htmlFile, match[1]);
    const target = normalizeLink(pageUrl, match[1]);
    if (!target) continue;
    const distPath = distPathForUrl(target);
    if (!allDistPaths.has(distPath)) {
      throw new Error(`${path.relative(repoRoot, htmlFile)} links to missing ${match[1]}`);
    }
  }
}

function validatePublicLink(htmlFile, raw) {
  const forbidden = [
    /(?:https?:\/\/chan\.app)?\/dl\/latest\//i,
    /github\.com\/fiorix\/chan\/releases\/latest\/download/i,
    /github\.com\/chan-writer\/chan/i,
  ];
  for (const pattern of forbidden) {
    if (pattern.test(raw)) {
      throw new Error(`${path.relative(repoRoot, htmlFile)} links to stale release route: ${raw}`);
    }
  }
}

function normalizeLink(pageUrl, raw) {
  if (
    raw.startsWith("#") ||
    raw.startsWith("mailto:") ||
    raw.startsWith("http://") ||
    raw.startsWith("https://") ||
    raw.startsWith("data:")
  ) {
    return null;
  }
  const clean = raw.split("#")[0].split("?")[0];
  if (!clean) return null;
  if (clean.startsWith("/")) return clean;
  const base = pageUrl.endsWith("/") ? pageUrl : `${path.posix.dirname(pageUrl)}/`;
  return path.posix.normalize(path.posix.join(base, clean));
}

function urlForOutput(output) {
  if (output === "index.html") return "/";
  if (output.endsWith("/index.html")) return `/${output.slice(0, -"index.html".length)}`;
  return `/${output}`;
}

function distPathForUrl(url) {
  if (url.endsWith("/")) return path.posix.join(url.slice(1), "index.html");
  return url.slice(1);
}

function validateNoStalePublicCopy(file, text) {
  const forbidden = [
    /\bCLI[- ]only\b/i,
    /assistant pane/i,
    /in-app assistant/i,
    /no telemetry/i,
    /\blegacy\b/i,
    /\bmigrations?\b/i,
    /backward[- ]compatibility/i,
    /\bbackcompat\b/i,
    /github\.com\/chan-writer\/chan/i,
    /chan\.app\/dl\/(?:latest|v[0-9])/i,
    /(?:^|[\s"'(])\/dl\/(?:latest|v[0-9][^\s"'<>)]*)/i,
  ];
  for (const pattern of forbidden) {
    if (pattern.test(text)) {
      throw new Error(`${path.relative(repoRoot, file)} contains stale public copy: ${pattern}`);
    }
  }
}

function validateReleaseDownloadContract(textByDistPath) {
  const html = [...textByDistPath.entries()]
    .filter(([file]) => file.endsWith(".html"))
    .map(([, text]) => text)
    .join("\n");

  if (/github\.com\/fiorix\/chan\/releases\/latest\/download/i.test(html)) {
    throw new Error("generated pages must not use GitHub latest-download URLs");
  }
  if (/github\.com\/fiorix\/chan\/releases\/download\/v\d+\.\d+\.\d+\//i.test(html)) {
    throw new Error("generated pages must not infer concrete release asset URLs");
  }
  for (const id of requiredDownloadIds) {
    if (!html.includes(`data-release-download="${id}"`)) {
      throw new Error(`generated pages are missing metadata download hook: ${id}`);
    }
  }

  const siteJs = textByDistPath.get("assets/site.js") ?? "";
  if (!siteJs.includes(releasesMetadataPath)) {
    throw new Error(`site.js must read release metadata from ${releasesMetadataPath}`);
  }
  if (!siteJs.includes(`${githubRepoUrl}/releases`)) {
    throw new Error("site.js must keep GitHub Releases as the metadata failure fallback");
  }

  const installer = textByDistPath.get("install.sh") ?? "";
  const expectedMetadataBase = `DEFAULT_METADATA_BASE="${cliMetadataBase}"`;
  if (!installer.includes(expectedMetadataBase)) {
    throw new Error(`install.sh must default metadata base to ${cliMetadataBase}`);
  }
  if (installer.includes("/releases/latest/download")) {
    throw new Error("install.sh must not depend on GitHub latest-download URLs");
  }
  const windowsInstaller = textByDistPath.get("install.ps1") ?? "";
  if (!windowsInstaller.includes(`$DefaultMetadataBase = "${cliMetadataBase}"`)) {
    throw new Error(`install.ps1 must default metadata base to ${cliMetadataBase}`);
  }
  if (!html.includes("irm https://chan.app/install.ps1 | iex")) {
    throw new Error("generated pages must present the Windows PowerShell installer");
  }
}

main().catch((err) => {
  console.error(`site build failed: ${err.message}`);
  process.exitCode = 1;
});
