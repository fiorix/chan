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
  path.join(srcRoot, "pages", "devserver.html"),
  path.join(srcRoot, "pages", "gateway.html"),
  path.join(srcRoot, "guides.css"),
  path.join(srcRoot, "pages", "install.html"),
  path.join(srcRoot, "docs.json"),
  path.join(srcRoot, "manual.css"),
  path.join(srcRoot, "pages", "animations.html"),
  path.join(srcRoot, "animation-credits.json"),
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
  const docSets = await readDocSets();
  const animationsTemplate = await fs.readFile(path.join(srcRoot, "pages", "animations.html"), "utf8");
  const animationCredits = JSON.parse(await fs.readFile(path.join(srcRoot, "animation-credits.json"), "utf8"));
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
  const homeHead = '<link rel="stylesheet" href="/assets/home.css" />';
  // Documentation pages share the landing page's labels and links (home.css)
  // and add their own layout and components (manual.css).
  const docHead = `${homeHead}\n<link rel="stylesheet" href="/assets/manual.css" />`;
  await writePage(
    "index.html",
    renderPage(baseTemplate, {
      active: "home",
      bodyClass: "home-page entry-page",
      title: "chan - a supercharged terminal emulator",
      description:
        "Chan is a supercharged terminal emulator: scriptable, multiplexed, the same locally and on remote machines, with workspaces and agent teams. Free and open source on macOS, Windows, Linux, and FreeBSD.",
      content: fillTemplate(homeTemplate, { version, ...sharedTemplateValues }),
      headExtra: homeHead,
    }),
  );

  for (const guide of [
    { slug: "devserver", title: "Chan devserver - ssh, Eternal Terminal, and remote tools", description: "Connect over ssh or Eternal Terminal. Move files, forward remote ports to your desktop, and manage collaborative workspace sessions with cs." },
    { slug: "gateway", title: "Chan gateway - Always-on environments on your domain", description: "Provision managed devservers with your tools and PATs. Use OAuth2 access, admission control, live policy, and a scalable proxy fleet on your infrastructure." },
  ]) {
    const template = await fs.readFile(path.join(srcRoot, "pages", `${guide.slug}.html`), "utf8");
    await writePage(
      `${guide.slug}/index.html`,
      renderPage(baseTemplate, {
        active: "guide",
        bodyClass: "home-page guide-page",
        title: guide.title,
        description: guide.description,
        content: fillTemplate(template, sharedTemplateValues),
        headExtra: '<link rel="stylesheet" href="/assets/home.css" />\n<link rel="stylesheet" href="/assets/guides.css" />',
      }),
    );
  }

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

  const docHeads = { "launcher-demo": launcherDemoHead };
  for (const set of docSets) {
    for (const [index, page] of set.pages.entries()) {
      const template = await fs.readFile(path.join(srcRoot, page.slug ? path.join(set.source, `${page.slug}.html`) : set.index), "utf8");
      const content = await addIntrinsicSizes(
        stripCapturePlaceholders(
          fillTemplate(template, {
            version,
            ...sharedTemplateValues,
            manualChapters: renderDocChapters(set),
          }),
        ),
      );
      if (page.head && !docHeads[page.head]) throw new Error(`docs.json: unknown head "${page.head}" on ${docUrl(set, page)}`);
      await writePage(
        `${docUrl(set, page).slice(1)}index.html`,
        renderPage(baseTemplate, {
          active: set.id,
          bodyClass: "manual-page",
          title: page.slug ? `${page.title} - ${set.title}` : set.title,
          description: page.description,
          content: renderDoc(set, index, content),
          headExtra: [docHead, page.head ? docHeads[page.head] : ""].filter(Boolean).join("\n"),
        }),
      );
    }
  }

  await writePage(
    "animations/index.html",
    renderPage(baseTemplate, {
      active: "animations",
      bodyClass: "animations-page",
      title: "Workspace animations and credits - chan",
      description: "Explore the animations in chan's empty workspace, try live previews, and meet the artists behind the original sketches and shaders.",
      content: fillTemplate(animationsTemplate, {
        animationCredits: animationCredits.map((animation) => `    <article id="${escapeAttribute(animation.id)}" class="animation-credit">
      <h3><a href="?a=${escapeAttribute(animation.id)}#preview" data-animation-preview="${escapeAttribute(animation.id)}">${escapeHtml(animation.name)}</a></h3>
      <p>${escapeHtml(animation.credit)}</p>
      <ul>${animation.references.map((reference) => `<li><a href="${escapeAttribute(reference.url)}">${escapeHtml(reference.label)}</a></li>`).join("")}</ul>
    </article>`).join("\n"),
      }),
      headExtra: '<link rel="stylesheet" href="/assets/animation-gallery.css" />\n<script type="module" src="/assets/animation-gallery.js"></script>',
    }),
  );

  // Isolate the devserver-form demo's launcher stores and styles from its guide.
  await writePage(
    "manual/demo/devserver/index.html",
    fillTemplate(demoEmbedTemplate, {
      title: "Add devserver demo",
      variant: "devserver",
    }),
  );

  await writePage(
    "demo/computers/index.html",
    fillTemplate(demoEmbedTemplate, {
      title: "Computers screen preview",
      variant: "populated",
    }),
  );

  await buildLauncherDemo();
  await buildAnimationGallery();
  await buildSiteMotion();
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
  await fs.copyFile(path.join(srcRoot, "home.css"), path.join(distRoot, "assets", "home.css"));
  await fs.copyFile(path.join(srcRoot, "guides.css"), path.join(distRoot, "assets", "guides.css"));
  await fs.copyFile(path.join(srcRoot, "manual.css"), path.join(distRoot, "assets", "manual.css"));
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
    backgroundAnimation: active === "home" ? "morph" : "waves",
    content,
    description: escapeHtml(description),
    headExtra,
    siteNav: renderSiteNav(active),
    title: escapeHtml(title),
  });
}

// A documentation set is a base path, a sidebar label and groups of pages.
// The flat `pages` list carries each page's group and fixes the reading order
// that the sidebar and the previous and next links follow.
async function readDocSets() {
  const { sets } = JSON.parse(await fs.readFile(path.join(srcRoot, "docs.json"), "utf8"));
  return sets.map((set) => ({
    ...set,
    pages: set.groups.flatMap((group) => group.pages.map((page) => ({ ...page, group: group.title }))),
  }));
}

function docUrl(set, page) {
  return `${set.base}${page.slug ? `${page.slug}/` : ""}`;
}

function docSlug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function renderDocChapters(set) {
  return set.groups
    .map((group) => {
      const cards = group.pages
        .filter((page) => page.slug)
        .map((page) => `<a class="manual-chapter" href="${docUrl(set, page)}"><strong>${escapeHtml(page.title)}</strong><span>${escapeHtml(page.description)}</span></a>`);
      if (!cards.length) return "";
      return `<section class="manual-chapter-group">
  <p class="section-label">${escapeHtml(group.title)}</p>
  <div class="manual-chapters">
${cards.join("\n")}
  </div>
</section>`;
    })
    .join("\n");
}

function renderDoc(set, index, content) {
  const page = set.pages[index];
  const headings = [...content.matchAll(/<h([23])(?: id="[^"]+")?><a class="heading-anchor" href="#([^"]+)">(.*?)<\/a><\/h\1>/gs)];
  const contents = page.slug && headings.length > 1
    ? `<nav class="manual-toc" aria-label="On this page"><strong>On this page</strong><ul>${headings.map(([, level, id, title]) => `<li${level === "3" ? ' class="toc-sub"' : ""}><a href="#${id}">${title}</a></li>`).join("")}</ul></nav>`
    : "";
  const adjacent = (offset, label) => {
    const target = set.pages[index + offset];
    return target ? `<a href="${docUrl(set, target)}" rel="${offset < 0 ? "prev" : "next"}"><span>${label}</span>${escapeHtml(target.title)}</a>` : "<span></span>";
  };
  const navId = `${set.id}-nav`;
  const groups = set.groups
    .map((group) => {
      const headingId = `${navId}-${docSlug(group.title)}`;
      const links = group.pages.map((chapter) => `<li><a href="${docUrl(set, chapter)}"${chapter.slug === page.slug ? ' aria-current="page"' : ""}>${escapeHtml(chapter.title)}</a></li>`);
      return `<p class="manual-nav-heading" id="${headingId}">${escapeHtml(group.title)}</p>
      <ol aria-labelledby="${headingId}">${links.join("\n")}</ol>`;
    })
    .join("\n      ");
  return `<a class="manual-skip" href="#manual-content">Skip to content</a>
<div class="manual-layout">
  <nav class="manual-nav" aria-label="${escapeHtml(set.label)} sections">
    <a class="manual-nav-title" href="${set.base}">${escapeHtml(set.label)}</a>
    <input class="manual-nav-toggle" type="checkbox" id="${navId}-toggle" />
    <label class="manual-nav-current" for="${navId}-toggle"><span>${escapeHtml(page.group)}</span>${escapeHtml(page.title)}</label>
    <div class="manual-nav-groups">
      ${groups}
    </div>
  </nav>
  <article class="manual-content${contents ? "" : " no-toc"}" id="manual-content" tabindex="-1">
    <header class="page-head">
      <p class="manual-eyebrow"><a href="${set.base}">${escapeHtml(set.label)}</a><span aria-hidden="true">/</span>${escapeHtml(page.group)}</p>
      <h1>${page.slug ? escapeHtml(page.title) : escapeHtml(set.label)}</h1>
      <p class="manual-lede">${escapeHtml(page.description)}</p>
    </header>
${contents}
${content}
    <nav class="manual-pagination" aria-label="Adjacent ${escapeHtml(set.label.toLowerCase())} sections">
      ${adjacent(-1, "Previous")}
      ${adjacent(1, "Next")}
    </nav>
  </article>
</div>`;
}

// A figure whose capture is still to be made holds a placeholder that says
// what to shoot. The published page leaves such a figure out, caption
// included; CHAN_SITE_PLACEHOLDERS=1 keeps them for a draft preview.
const keepCapturePlaceholders = process.env.CHAN_SITE_PLACEHOLDERS === "1";

function stripCapturePlaceholders(html) {
  if (keepCapturePlaceholders) return html;
  // A figure's id is an anchor other pages and old links may name, so it
  // stays on the page when the figure goes.
  return html.replace(
    /[ \t]*<figure class="inline-shot"(?: id="([^"]+)")?>\s*<div class="shot-placeholder-frame" data-shot="[^"]+"[^>]*>[\s\S]*?<\/div>\s*(?:<figcaption>[\s\S]*?<\/figcaption>\s*)?<\/figure>\n?/g,
    (_figure, id) => (id ? `<span id="${id}"></span>\n` : ""),
  );
}

// Give each local image, and each video with a local poster, its intrinsic
// width and height, so the page reserves the right box before the media loads
// and a video keeps its source aspect.
async function addIntrinsicSizes(html) {
  const sizes = new Map();
  const tags = [...html.matchAll(/<(img|video)\b[^>]*>/g)].filter(([tag]) => !/\swidth="/.test(tag));
  for (const [tag, name] of tags) {
    const source = tag.match(name === "img" ? /\ssrc="(\/assets\/[^"]+)"/ : /\sposter="(\/assets\/[^"]+)"/)?.[1];
    if (!source || sizes.has(tag)) continue;
    const size = await imageSize(path.join(siteRoot, source));
    if (size) sizes.set(tag, tag.replace(/\s*\/?>$/, (end) => ` width="${size.width}" height="${size.height}"${end}`));
  }
  let sized = html;
  for (const [tag, replacement] of sizes) sized = sized.split(tag).join(replacement);
  return sized;
}

async function imageSize(file) {
  let data;
  try {
    data = await fs.readFile(file);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  if (data.length > 24 && data.readUInt32BE(0) === 0x89504e47) {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (data.length > 4 && data.readUInt16BE(0) === 0xffd8) {
    // Walk the JPEG segments to the frame header, which holds the size.
    let offset = 2;
    while (offset + 9 < data.length && data[offset] === 0xff) {
      const marker = data[offset + 1];
      const frame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (frame) return { width: data.readUInt16BE(offset + 7), height: data.readUInt16BE(offset + 5) };
      offset += 2 + data.readUInt16BE(offset + 2);
    }
  }
  return null;
}

async function buildLauncherDemo() {
  await viteBuild({
    configFile: false,
    root: siteRoot,
    // Everything the launcher build emits lives under /assets/, and the
    // bundle resolves its asset urls against this base.
    base: "/assets/",
    plugins: [svelte()],
    resolve: {
      alias: {
        "@chan/launcher/demo": path.join(repoRoot, "web/packages/launcher/src/LauncherDemo.svelte"),
        "@chan/launcher/styles.css": path.join(repoRoot, "web/packages/launcher/src/styles.css"),
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

  // Scope the launcher bundle's global CSS (`:root` variable blocks, `body`
  // rules) to its frame so the embed can never restyle the marketing page
  // around it.
  await scopeDemoCss("launcher-demo.css", ".launcher-demo-frame");
}

async function buildSiteMotion() {
  await viteBuild({
    configFile: false,
    root: siteRoot,
    base: "/assets/",
    plugins: [svelte()],
    build: {
      emptyOutDir: false,
      outDir: path.join(distRoot, "assets"),
      rollupOptions: {
        input: { "site-motion": path.join(srcRoot, "site-motion.ts") },
        output: {
          entryFileNames: "[name].js",
          chunkFileNames: "site-motion-[name]-[hash].js",
          assetFileNames: "site-motion.[ext]",
        },
      },
    },
  });
}

async function buildAnimationGallery() {
  await viteBuild({
    configFile: false,
    root: siteRoot,
    base: "/assets/",
    plugins: [svelte()],
    build: {
      emptyOutDir: false,
      outDir: path.join(distRoot, "assets"),
      rollupOptions: {
        input: path.join(srcRoot, "animation-gallery.ts"),
        output: {
          entryFileNames: "animation-gallery.js",
          chunkFileNames: "animation-gallery-[name]-[hash].js",
          assetFileNames: "animation-gallery.[ext]",
        },
      },
    },
  });
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
    ["animations", "/animations/", "Animations"],
    ["github", githubRepoUrl, "GitHub"],
  ];
  return links
    .map(([key, href, label]) => {
      const classes = [key === active ? "active" : "", key === "github" ? "nav-secondary" : ""].filter(Boolean);
      const attrs = (classes.length ? ` class="${classes.join(" ")}"` : "") + (key === active ? ' aria-current="page"' : "");
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

  const htmlByDistPath = new Map();
  for (const htmlFile of htmlFiles) {
    htmlByDistPath.set(path.relative(distRoot, htmlFile).split(path.sep).join("/"), await fs.readFile(htmlFile, "utf8"));
  }
  const idsByDistPath = new Map([...htmlByDistPath].map(([rel, html]) => [rel, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]))]));
  for (const htmlFile of htmlFiles) {
    const rel = path.relative(distRoot, htmlFile).split(path.sep).join("/");
    validateLocalLinks(htmlFile, htmlByDistPath.get(rel), allDistPaths, idsByDistPath);
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

  if (!keepCapturePlaceholders) {
    for (const [rel, html] of htmlByDistPath) {
      if (html.includes("data-shot=")) throw new Error(`${rel} publishes a capture placeholder`);
    }
  }

  for (const required of ["index.html", "devserver/index.html", "gateway/index.html", "install/index.html", "manual/index.html", "manual/demo/devserver/index.html", "demo/computers/index.html", "animations/index.html", "install.sh", "install.ps1", "CNAME"]) {
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

function validateLocalLinks(htmlFile, html, allDistPaths, idsByDistPath) {
  const pagePath = path.relative(distRoot, htmlFile).split(path.sep).join("/");
  const pageUrl = urlForOutput(pagePath);
  const attrPattern = /\b(?:href|src)="([^"]+)"/g;
  for (const match of html.matchAll(attrPattern)) {
    validatePublicLink(htmlFile, match[1]);
    const target = normalizeLink(pageUrl, match[1]);
    const distPath = target ? distPathForUrl(target) : pagePath;
    if (target && !allDistPaths.has(distPath)) {
      throw new Error(`${path.relative(repoRoot, htmlFile)} links to missing ${match[1]}`);
    }
    // A fragment on a page of this site must name an id that page has, so a
    // section that moves cannot leave a link pointing at nothing.
    const fragment = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(match[1]) ? "" : decodeURIComponent(match[1].split("#")[1] ?? "");
    if (fragment && idsByDistPath.has(distPath) && !idsByDistPath.get(distPath).has(fragment)) {
      throw new Error(`${path.relative(repoRoot, htmlFile)} links to missing anchor ${match[1]}`);
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
    /\bIDE\b/,
    /workspace manager/i,
    /a new kind of/i,
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
