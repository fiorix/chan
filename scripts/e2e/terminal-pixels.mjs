#!/usr/bin/env node
/**
 * Measure what the terminal grid actually paints in the real Windows webview.
 *
 * WHY this exists beside terminal-pixels.py rather than inside it: the Python
 * driver mounts the page in WebKitGTK through python-gobject, and neither the
 * typelib nor a system python exists on a Windows box. The page under test is
 * the same one -- terminal-pixels/index.html and harness.mjs are shared
 * verbatim -- so only the host and the snapshot path are rewritten here. Every
 * threshold, region and assertion is the Python driver's, restated once so the
 * two platforms are held to one bar.
 *
 * WHY Edge by default: chan-desktop renders in WebView2, and WebView2 is the
 * Edge runtime -- the same Chromium build, the same DirectWrite font stack,
 * the same GPU path. Edge is the copy that can be driven headlessly from a
 * script, and the engine's own version is printed with the results rather
 * than assumed, because the runtime updates itself underneath a checkout.
 *
 * What Edge does not reproduce is Tauri's own WebView2 browser arguments.
 * --webview2 closes that gap by hosting the page in the real shell: it
 * launches the built chan-desktop.exe with a debugging port injected through
 * WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS and navigates its webview to the
 * harness. The app's own build is irrelevant there; it is being used as a
 * WebView2 host configured the way the product configures one.
 *
 * The Windows matrix is NOT the Linux one. shouldUseWebglRenderer(true,
 * "windows") is true, so the desktop app ships xterm's WebGL renderer here and
 * the DOM renderer Linux ships is the reference arm. The font chain diverges
 * too: `os-default` leads with Cascadia Mono, so the two font preferences
 * resolve to different faces instead of the same one.
 *
 * Usage:
 *   node scripts/e2e/terminal-pixels.mjs [--out DIR] [--include-renderers]
 *                                        [--only SUBSTRING] [--webview2]
 *
 * Exit status: 0 pass, 1 fail, 2 skipped because no webview host was found.
 * A skip is not a pass; report it as a skip.
 *
 * Needs an installed web/node_modules, a desktop session (the window is real),
 * and either Edge or the WebView2 runtime.
 */

import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const WEB = path.join(REPO, "web");
const WORKSPACE_APP = path.join(WEB, "packages/workspace-app");
const TERMINAL_TAB = path.join(WORKSPACE_APP, "src/components/TerminalTab.svelte");
const FONTS_CSS = path.join(WORKSPACE_APP, "src/fonts.css");
const GHOSTTY_COMPAT = path.join(WORKSPACE_APP, "src/terminal/ghosttyCompat.ts");
const PAGE_DIR = path.join(HERE, "terminal-pixels");

// The host element's size in index.html. The viewport is driven to exactly
// this size so the snapshot is the grid and nothing around it.
const HOST_W = 800;
const HOST_H = 560;

// TerminalTab's default when preferences carry no font_size.
const FONT_SIZE = 14;

// A pixel counts as ink when any channel is this far from the terminal
// background. Antialiased glyph edges land well above it and the engine's
// colour management moves the background by a unit or two.
const INK_THRESHOLD = 24;

// What the shipped renderers have to clear. A rule that breaks at a cell
// boundary and a block rectangle with a seam are the same defect, so the
// rules are held to the same bar as the fill.
const MIN_RULE_CONTINUITY = 0.995;
const MIN_BLOCK_COVERAGE = 0.995;

// Nothing is written in the blank region, so anything painted there is either
// stale pixels or an overlay drawing over content.
const MAX_BLANK_INK = 0.001;

/** The chain TerminalTab hands the renderer on Windows for this preference.
 *
 * Read from the component rather than restated, and it mirrors the
 * component's promotion rule: opting into Source Code Pro puts the face at
 * the head of the same chain unless it already leads it.
 */
function windowsFontChain(pref) {
  const text = fs.readFileSync(TERMINAL_TAB, "utf8");
  const match = text.match(/windows:\s*\n?\s*'([^']*)'/);
  if (!match) throw new Error(`${TERMINAL_TAB}: no windows font chain found`);
  const chain = match[1];
  const sourceCodePro = '"Source Code Pro"';
  if (pref === "source-code-pro" && !chain.startsWith(sourceCodePro)) {
    return `${sourceCodePro}, ${chain}`;
  }
  return chain;
}

/** The app's own @font-face rule, for injection into the page. */
function fontFaceBlock() {
  const text = fs.readFileSync(FONTS_CSS, "utf8");
  const match = text.match(/@font-face\s*\{[\s\S]*?\}/);
  if (!match) throw new Error(`${FONTS_CSS}: no @font-face rule found`);
  return `<style>\n${match[0]}\n</style>`;
}

/** Compile the product's own ghostty adapters into `outDir`.
 *
 * Compiled rather than reimplemented: this harness exists to measure what
 * TerminalTab paints, and a second copy of the alignment and custom-glyph
 * code would measure the copy.
 */
async function buildProductModules(outDir) {
  // The package's own entry point rather than the .bin shim: the shim is a
  // .cmd on Windows, and spawning one needs a shell, which then has to escape
  // paths that contain spaces.
  const tsc = path.join(WEB, "node_modules/typescript/bin/tsc");
  if (!fs.existsSync(tsc)) {
    throw new Error(`missing ${tsc}; run \`npm install\` under web/`);
  }
  const child = spawn(
    process.execPath,
    [
      tsc,
      GHOSTTY_COMPAT,
      "--outDir", outDir,
      "--target", "es2022",
      "--module", "esnext",
      "--moduleResolution", "bundler",
      "--lib", "es2022,dom",
      "--skipLibCheck",
    ],
    { cwd: WORKSPACE_APP, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  await once(child, "close");
  if (!fs.existsSync(path.join(outDir, "ghosttyCompat.js"))) {
    throw new Error(`tsc emitted no ghosttyCompat.js\n${output}`);
  }
}

// WebAssembly.instantiateStreaming rejects a wasm served as octet-stream, and
// a module script served as one never executes.
const CONTENT_TYPES = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
};

/** Serve the page, the product modules and the vendors on loopback.
 *
 * One mount per package rather than one for node_modules, so a stray path in
 * the page cannot serve the whole dependency tree over the socket. Mounts
 * rather than the Python driver's symlink tree: creating a symlink on Windows
 * needs Developer Mode or an elevated process, and the harness must not.
 */
async function serve(productDir, page) {
  const mounts = [
    ["/fonts/", path.join(WORKSPACE_APP, "src/fonts")],
    ["/vendor/xterm/", path.join(WEB, "node_modules/@xterm/xterm")],
    ["/vendor/addon-webgl/", path.join(WEB, "node_modules/@xterm/addon-webgl")],
    ["/vendor/ghostty-web/", path.join(WEB, "node_modules/ghostty-web")],
    ["/product/", productDir],
  ];
  for (const [, root] of mounts) {
    if (!fs.existsSync(root)) {
      throw new Error(`missing ${root}; run \`npm install\` under web/`);
    }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const pathname = decodeURIComponent(url.pathname);
    if (pathname === "/" || pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(page);
      return;
    }
    if (pathname === "/harness.mjs") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(fs.readFileSync(path.join(PAGE_DIR, "harness.mjs")));
      return;
    }
    for (const [prefix, root] of mounts) {
      if (!pathname.startsWith(prefix)) continue;
      const file = path.resolve(root, pathname.slice(prefix.length));
      // A resolved path that escaped its mount is a traversal attempt, and
      // this server is answering a page that loads its own URLs.
      if (file !== root && !file.startsWith(root + path.sep)) break;
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) break;
      res.writeHead(200, {
        "content-type":
          CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
      });
      res.end(fs.readFileSync(file));
      return;
    }
    res.writeHead(404).end("not found");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { port: server.address().port, close: () => server.close() };
}

/** Where the webview host lives on this box.
 *
 * Not msedgewebview2.exe: the runtime is a hosted component and refuses to
 * come up standalone, so the only way to measure real WebView2 is to launch
 * something that embeds it. chan-desktop is that something.
 */
function findHost(useWebView2) {
  if (useWebView2) {
    for (const profile of ["release", "debug"]) {
      const exe = path.join(REPO, "target", profile, "chan-desktop.exe");
      if (fs.existsSync(exe)) return { kind: "webview2", exe };
    }
    return null;
  }
  const candidates = [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ];
  const exe = candidates.find((candidate) => fs.existsSync(candidate));
  return exe ? { kind: "edge", exe } : null;
}

/** A loopback port that was free a moment ago.
 *
 * WebView2 takes its debugging port as a browser argument and never writes a
 * DevToolsActivePort file, so unlike the Edge path the number has to be
 * chosen up front.
 */
async function freePort() {
  const probe = http.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  probe.close();
  await once(probe, "close");
  return port;
}

/** A CDP session over the browser's debugging socket. */
class Devtools {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    // A load that fails reports itself as an event, not as a reply to
    // anything the driver asked for. Without them the only symptom is a
    // scenario that never reports, which says nothing about why.
    this.failures = [];
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.method === "Network.loadingFailed") {
        this.failures.push(message.params.errorText);
        return;
      }
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    });
  }

  static async attach(port) {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
    const page = targets.find((t) => t.type === "page");
    if (!page) throw new Error("the browser exposed no page target");
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await once(socket, "open");
    return new Devtools(socket);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text);
    }
    return result.result.value;
  }
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on("error", reject);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Launch the engine in app mode and attach to it.
 *
 * App mode rather than a normal window because a tab strip and a toolbar
 * would shrink the viewport below the host, and the host is what gets
 * snapshotted.
 */
async function launch(host, profileDir) {
  if (host.kind === "webview2") return launchDesktop(host.exe, profileDir);
  const child = spawn(
    host.exe,
    [
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      "--app=about:blank",
      // Opened with room for the frame so fitViewport usually has nothing to
      // correct; the host is measured from its own origin, so surplus costs
      // only the pixels the snapshot carries past it.
      `--window-size=${HOST_W + 120},${HOST_H + 200}`,
      "--window-position=0,0",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-sync",
      "--hide-scrollbars",
    ],
    { stdio: "ignore" },
  );

  // The chosen port lands in the profile as soon as the socket is up. Polling
  // the file beats guessing a free port, which races another process between
  // the probe and the launch.
  const portFile = path.join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (fs.existsSync(portFile)) {
      const first = fs.readFileSync(portFile, "utf8").split("\n")[0].trim();
      if (first) return { child, port: Number(first) };
    }
    await sleep(100);
  }
  child.kill();
  throw new Error("the browser never published a debugging port");
}

/** Host the page in the desktop app's own WebView2.
 *
 * The app is a webview host here and nothing more -- the harness navigates
 * its window away from the workspace before measuring, so which commit built
 * chan-desktop.exe does not enter the numbers. What does enter them is the
 * WebView2 configuration Tauri creates, which is the point of this arm.
 */
async function launchDesktop(exe, profileDir) {
  const port = await freePort();
  const child = spawn(exe, [], {
    stdio: "ignore",
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --hide-scrollbars`,
      WEBVIEW2_USER_DATA_FOLDER: profileDir,
    },
  });

  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`).catch(
      () => null,
    );
    if (targets?.some((target) => target.type === "page")) return { child, port };
    await sleep(250);
  }
  child.kill();
  throw new Error(
    `${exe} never exposed a WebView2 page on port ${port};` +
      " check that the build runs on this box",
  );
}

/** Grow the window until the viewport covers the whole host element.
 *
 * At least the host, not exactly it: the window is sized in outer pixels, the
 * frame's thickness is a shell decision, and on a scaled display the two are
 * not even in the same unit, so an exact fit is not something the driver can
 * demand. It does not need one. The host is pinned at the viewport's top-left
 * and every measurement is taken relative to its own origin, so surplus
 * viewport around it is never sampled -- the Python driver makes the same
 * bargain when it requires the snapshot to be no smaller than the host.
 *
 * Emulation.setDeviceMetricsOverride would fit the viewport in one call, but
 * it re-rasterises at a synthetic scale factor, and the box's real one is the
 * thing under measurement.
 */
async function fitViewport(cdp) {
  // WebView2 serves a narrower Browser domain than Edge does; when window
  // bounds are not on offer the driver can only take the window it was given
  // and check it is big enough.
  const windowId = await cdp
    .send("Browser.getWindowForTarget")
    .then((result) => result.windowId)
    .catch(() => null);
  let viewport = { width: 0, height: 0 };
  // Re-read after the last widening rather than only before it, or a window
  // that reached the host on the final attempt is rejected for the size it
  // no longer has.
  for (let attempt = 0; attempt <= 4; attempt += 1) {
    viewport = await readViewport(cdp);
    if (viewport.width >= HOST_W && viewport.height >= HOST_H) return;
    if (attempt === 4 || windowId === null) break;
    const { bounds } = await cdp.send("Browser.getWindowBounds", { windowId });
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: {
        width: bounds.width + Math.max(0, HOST_W - viewport.width),
        height: bounds.height + Math.max(0, HOST_H - viewport.height),
      },
    });
    await sleep(150);
  }
  throw new Error(
    `the viewport settled at ${viewport.width}x${viewport.height}, smaller` +
      ` than the ${HOST_W}x${HOST_H} host; the sampled cells would not be` +
      " the pattern's",
  );
}

/** Wait for the host to stop navigating on its own.
 *
 * The desktop app performs its own startup navigation, and a scenario sent
 * into the middle of it is cancelled -- the webview lands on
 * chrome-error://chromewebdata and the scenario times out with nothing to
 * show for it. Settling on a URL that has stopped changing is the signal that
 * the shell has finished and the driver may take the window over.
 */
async function settle(cdp) {
  let previous = null;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const href = await cdp.evaluate("location.href").catch(() => null);
    if (href !== null && href === previous) return;
    previous = href;
    await sleep(500);
  }
}

async function readViewport(cdp) {
  const raw = await cdp.evaluate(
    "JSON.stringify([window.innerWidth, window.innerHeight, window.devicePixelRatio])",
  );
  const [width, height, devicePixelRatio] = JSON.parse(raw);
  return { width, height, devicePixelRatio };
}

/** Paint one scenario in the webview; return (image, report).
 *
 * Every scenario starts from about:blank. Two scenario URLs differ only in
 * their fragment, and navigating between those is a same-document navigation:
 * the page never reloads, the harness module never re-runs, and the title
 * still holds the PREVIOUS scenario's report -- which the driver would then
 * measure a stale frame against and pass. Clearing to about:blank forces the
 * document away, and the title is confirmed clear before the real navigation
 * so a report can only be this scenario's.
 */
async function render(cdp, url, png) {
  await cdp.send("Page.navigate", { url: "about:blank" });
  const cleared = Date.now() + 10000;
  for (;;) {
    const title = await cdp.evaluate("document.title").catch(() => "");
    if (!title.startsWith("chan-pixels")) break;
    if (Date.now() > cleared) throw new Error("the page never left the last scenario");
    await sleep(50);
  }
  await cdp.send("Page.navigate", { url });

  let report = null;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const title = await cdp.evaluate("document.title").catch(() => "");
    if (title && title.startsWith("chan-pixels-error ")) {
      throw new Error(`the page failed: ${title.slice("chan-pixels-error ".length)}`);
    }
    if (title && title.startsWith("chan-pixels ")) {
      report = JSON.parse(title.slice("chan-pixels ".length));
      break;
    }
    await sleep(100);
  }
  if (!report) {
    // Where it actually is, not just that it is late: a shell that refuses
    // the navigation outright leaves the webview on its own page, and that
    // looks identical to a slow scenario from the title alone.
    const where = await cdp
      .evaluate("JSON.stringify([location.href, document.title])")
      .catch((err) => `unreadable (${err.message})`);
    const failed = cdp.failures.length
      ? `; loads failed: ${[...new Set(cdp.failures)].join(", ")}`
      : "";
    throw new Error(
      `the webview produced no report within 30s; it is at ${where}${failed}`,
    );
  }

  // One settle beat after the page reports ready, so the frame it painted has
  // been composited before the snapshot reads it back.
  await sleep(400);
  const shot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
  });
  const buffer = Buffer.from(shot.data, "base64");
  fs.writeFileSync(png, buffer);
  return { image: decodePng(buffer), report, viewport: await readViewport(cdp) };
}

/** Decode the 8-bit non-interlaced PNG the compositor hands back.
 *
 * Hand-rolled because the harness must run off a bare checkout: web/ carries
 * no image decoder, and pulling one in for four filter types would put a
 * dependency between a contributor and a measurement.
 */
function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      const colorType = data[9];
      const interlace = data[12];
      if (depth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
        throw new Error(
          `unsupported PNG: depth ${depth}, colour type ${colorType},` +
            ` interlace ${interlace}`,
        );
      }
      channels = colorType === 6 ? 4 : 3;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prior = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? out[x - channels] : 0;
      const up = prior ? prior[x] : 0;
      const upLeft = prior && x >= channels ? prior[x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) value += paeth(left, up, upLeft);
      else if (filter !== 0) throw new Error(`unknown PNG filter ${filter}`);
      out[x] = value & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Ink lookups over a snapshot, relative to the terminal's own grid. */
class Pixels {
  constructor(image, report, viewport) {
    this.image = image;
    // The page reports CSS pixels and the compositor hands back device ones.
    // On Linux the two are the same number; on a scaled Windows display they
    // are not, and a driver that ignored the ratio would sample the wrong
    // cells. The ratio is taken from the snapshot against the viewport that
    // produced it rather than trusted from the page, so a capture that came
    // back at some other scale surfaces here instead of as a bogus gap.
    this.scale = image.width / viewport.width;
    if (Math.abs(this.scale - report.devicePixelRatio) > 0.01) {
      throw new Error(
        `the snapshot is ${image.width}px wide for a ${viewport.width}px` +
          ` viewport (ratio ${this.scale.toFixed(3)}) but the page reports a` +
          ` device pixel ratio of ${report.devicePixelRatio}`,
      );
    }
    if (image.height < HOST_H * this.scale - 1) {
      throw new Error(
        `the snapshot is ${image.height}px tall, short of the host's` +
          ` ${Math.round(HOST_H * this.scale)}px`,
      );
    }
    this.originX = report.originX * this.scale;
    this.originY = report.originY * this.scale;
    this.cellW = report.cellWidth * this.scale;
    this.cellH = report.cellHeight * this.scale;
    // The background is read from the snapshot rather than from the theme
    // string: the engine's colour management shifts it, and a hardcoded
    // reference would count that shift as ink over the whole grid. The
    // sample is the host's own bottom-right corner, which the pattern never
    // reaches -- not the snapshot's, which on a viewport wider than the host
    // is the page behind it and a different colour entirely.
    this.background = this.rgb(
      Math.round(HOST_W * this.scale) - 2,
      Math.round(HOST_H * this.scale) - 2,
    );
  }

  rgb(x, y) {
    const { pixels, channels, width } = this.image;
    const offset = (y * width + x) * channels;
    return [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
  }

  isInk(x, y) {
    const pixel = this.rgb(x, y);
    for (let i = 0; i < 3; i += 1) {
      if (Math.abs(pixel[i] - this.background[i]) > INK_THRESHOLD) return true;
    }
    return false;
  }

  /** The pixel box of a cell span, clamped to the snapshot. */
  cellRect(firstCol, firstRow, cols, rows) {
    return [
      Math.max(0, Math.round(this.originX + firstCol * this.cellW)),
      Math.max(0, Math.round(this.originY + firstRow * this.cellH)),
      Math.min(this.image.width, Math.round(this.originX + (firstCol + cols) * this.cellW)),
      Math.min(this.image.height, Math.round(this.originY + (firstRow + rows) * this.cellH)),
    ];
  }

  /** Widen a box, clamped to the snapshot. */
  grow([left, top, right, bottom], dx, dy) {
    return [
      Math.max(0, Math.round(left - dx)),
      Math.max(0, Math.round(top - dy)),
      Math.min(this.image.width, Math.round(right + dx)),
      Math.min(this.image.height, Math.round(bottom + dy)),
    ];
  }

  /** Which scanlines of a box carry any ink, top to bottom. */
  inkedRows([left, top, right, bottom]) {
    const flags = [];
    for (let y = top; y < bottom; y += 1) {
      let hit = false;
      for (let x = left; x < right && !hit; x += 1) hit = this.isInk(x, y);
      flags.push(hit);
    }
    return flags;
  }

  /** Which columns of a box carry any ink, left to right. */
  inkedCols([left, top, right, bottom]) {
    const flags = [];
    for (let x = left; x < right; x += 1) {
      let hit = false;
      for (let y = top; y < bottom && !hit; y += 1) hit = this.isInk(x, y);
      flags.push(hit);
    }
    return flags;
  }

  /** The fraction of a box that is ink. */
  coverage([left, top, right, bottom]) {
    const total = (right - left) * (bottom - top);
    if (total <= 0) return 0;
    let hits = 0;
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) if (this.isInk(x, y)) hits += 1;
    }
    return hits / total;
  }
}

/** The runs of false in a scanline mask, as [offset, length] pairs. */
function gapBands(flags) {
  const bands = [];
  let start = null;
  flags.forEach((flag, index) => {
    if (!flag && start === null) start = index;
    else if (flag && start !== null) {
      bands.push([start, index - start]);
      start = null;
    }
  });
  if (start !== null) bands.push([start, flags.length - start]);
  return bands;
}

/** The pixel box of a region given as an inclusive cell span. */
function spanRect(pixels, region) {
  return pixels.cellRect(
    region.firstCol,
    region.firstRow,
    region.lastCol - region.firstCol + 1,
    region.lastRow - region.firstRow + 1,
  );
}

/** Every number the scenario's own regions support.
 *
 * A scenario declares what it painted, so the new-tab arm (which paints a
 * prompt and nothing else) yields only the blank check rather than reading
 * rule continuity off cells that were never drawn in.
 */
function measure(pixels, report) {
  const { regions } = report;
  const numbers = {};

  // Half a cell past each end of the rule spans: that reaches the middle of
  // each corner cell, which is where the corner's stroke begins, so the two
  // corner joins are measured and the corner's background half is not.
  if (regions.rule) {
    const { col, firstRow, lastRow } = regions.rule;
    const rect = pixels.cellRect(col, firstRow, 1, lastRow - firstRow + 1);
    const rows = pixels.inkedRows(pixels.grow(rect, 0, pixels.cellH / 2));
    numbers.rule_continuity = rows.filter(Boolean).length / Math.max(1, rows.length);
    numbers.rule_gaps = gapBands(rows);
  }

  if (regions.top) {
    const { row, firstCol, lastCol } = regions.top;
    const rect = pixels.cellRect(firstCol, row, lastCol - firstCol + 1, 1);
    const cols = pixels.inkedCols(pixels.grow(rect, pixels.cellW / 2, 0));
    numbers.top_continuity = cols.filter(Boolean).length / Math.max(1, cols.length);
    numbers.top_gaps = gapBands(cols);
  }

  if (regions.block) {
    // Inset by one device pixel per side. The driver places the rectangle by
    // scaling the grid origin and cell pitch the page reported, in floating
    // point; the renderer snaps each cell edge to a whole device pixel and
    // accumulates its own rounding down the grid. At a device pixel ratio of
    // 1 the two agree exactly and the inset costs nothing. At 1.5 they can
    // land a pixel apart, and the outer boundary is the only place that
    // difference can show -- measured without the inset, a block whose ink is
    // 128 contiguous rows tall inside a 128px rect scores 99.2% and fails on
    // registration rather than on a seam.
    //
    // This does not soften TG-03. The defect it exists to catch is an
    // unpainted strip at EVERY cell boundary, which is interior to the
    // rectangle and untouched by a one-pixel inset: the DOM renderer arms
    // still score in the high eighties against this same measurement.
    const rect = pixels.grow(spanRect(pixels, regions.block), -1, -1);
    numbers.block_coverage = pixels.coverage(rect);
    numbers.block_gaps = gapBands(pixels.inkedRows(rect));
  }

  if (regions.blank) {
    numbers.blank_ink = pixels.coverage(spanRect(pixels, regions.blank));
  }

  return numbers;
}

/** One cell of the shipped matrix: a backend, a font preference. */
class Scenario {
  constructor(backend, font, { renderer = "dom", newTab = false } = {}) {
    this.backend = backend;
    this.font = font;
    // Only meaningful for the xterm backend; ghostty owns its renderer.
    this.renderer = renderer;
    this.newTab = newTab;
  }

  get name() {
    let suffix = this.renderer === "dom" ? "" : ` +${this.renderer}`;
    if (this.newTab) suffix += " (second tab)";
    return `${this.font}, ${this.backend}${suffix}`;
  }

  get slug() {
    return (
      `${this.backend}-${this.font}` +
      (this.renderer === "dom" ? "" : `-${this.renderer}`) +
      (this.newTab ? "-newtab" : "")
    );
  }

  url(port) {
    const config = {
      backend: this.backend,
      font: this.font,
      fontFamily: windowsFontChain(this.font),
      fontSize: FONT_SIZE,
      newTab: this.newTab,
      renderer: this.renderer,
    };
    return `http://127.0.0.1:${port}/index.html#${encodeURIComponent(JSON.stringify(config))}`;
  }
}

// The shipped Windows matrix, in the order the settings present it, then the
// same backends opening a second tab while the first still holds its content.
// The xterm arms carry the WebGL renderer because that is what
// shouldUseWebglRenderer turns on for a Windows desktop.
const SCENARIOS = [
  new Scenario("xterm", "os-default", { renderer: "webgl" }),
  new Scenario("xterm", "source-code-pro", { renderer: "webgl" }),
  new Scenario("ghostty", "os-default"),
  new Scenario("ghostty", "source-code-pro"),
  new Scenario("xterm", "os-default", { renderer: "webgl", newTab: true }),
  new Scenario("ghostty", "os-default", { newTab: true }),
];

// Not shipped on Windows. Runs only under --include-renderers, to measure
// what the DOM renderer -- the one the Linux desktop falls back to -- paints
// on this rasteriser, which is the only arm directly comparable to the Linux
// numbers.
const RENDERER_SCENARIOS = [
  new Scenario("xterm", "os-default"),
  new Scenario("xterm", "source-code-pro"),
];

/** Print one scenario's numbers; return the assertions it failed. */
function reportScenario(scenario, report, numbers) {
  const failures = [];
  const catalog = [
    ["vertical rule joins across cells", "rule_continuity", MIN_RULE_CONTINUITY, "min", "rule_gaps"],
    ["horizontal rule joins across cells", "top_continuity", MIN_RULE_CONTINUITY, "min", "top_gaps"],
    ["solid block tiles without a seam", "block_coverage", MIN_BLOCK_COVERAGE, "min", "block_gaps"],
    ["nothing paints where nothing was written", "blank_ink", MAX_BLANK_INK, "max", null],
  ];
  const percent = (value) => `${(value * 100).toFixed(1)}%`;
  for (const [label, key, bound, direction, gapsKey] of catalog) {
    if (!(key in numbers)) continue;
    const value = numbers[key];
    const ok = direction === "min" ? value >= bound : value <= bound;
    const comparator = direction === "min" ? ">=" : "<=";
    console.log(
      `  ${ok ? "ok" : "FAIL"}  ${label}: ${percent(value)} (want ${comparator} ${percent(bound)})`,
    );
    const gaps = numbers[gapsKey] ?? [];
    if (gaps.length && !ok) {
      const shown = gaps.slice(0, 6).map(([off, len]) => `${off}+${len}px`).join(", ");
      const more = gaps.length <= 6 ? "" : `, +${gaps.length - 6} more`;
      console.log(`        gaps at ${shown}${more}`);
    }
    if (!ok) failures.push(`${scenario.name}: ${label}`);
  }

  const cell = `${report.cellWidth.toFixed(2)}x${report.cellHeight.toFixed(2)}`;
  console.log(
    `        renderer ${report.renderer}, cell ${cell}px, dpr ${report.devicePixelRatio},` +
      ` grid ${report.cols}x${report.rows},` +
      ` Source Code Pro ${report.faceLoaded ? "loaded" : "MISSING"}`,
  );
  for (const warning of report.warnings) console.log(`        warning: ${warning}`);
  return failures;
}

function parseArgs(argv) {
  const args = {
    out: "target/e2e/terminal-pixels",
    includeRenderers: false,
    only: "",
    webview2: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--include-renderers") args.includeRenderers = true;
    else if (arg === "--webview2") args.webview2 = true;
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--only") args.only = argv[++i];
    else throw new Error(`unknown argument ${arg}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const out = path.isAbsolute(args.out) ? args.out : path.join(REPO, args.out);
  fs.mkdirSync(out, { recursive: true });

  let scenarios = SCENARIOS.concat(args.includeRenderers ? RENDERER_SCENARIOS : []);
  if (args.only) scenarios = scenarios.filter((s) => s.slug.includes(args.only));
  if (!scenarios.length) throw new Error(`--only ${args.only} matched no scenario`);

  const host = findHost(args.webview2);
  if (!host) {
    console.error(
      args.webview2
        ? "SKIP: no target/{release,debug}/chan-desktop.exe to host WebView2"
        : "SKIP: no Edge installation found",
    );
    console.error("SKIP: a skipped check is not a pass");
    return 2;
  }
  console.log(`host: ${host.kind} (${host.exe})`);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "chan-terminal-pixels-"));
  const failures = [];
  let child = null;
  let server = null;
  try {
    const productDir = path.join(work, "product");
    await buildProductModules(productDir);
    const page = fs
      .readFileSync(path.join(PAGE_DIR, "index.html"), "utf8")
      .replace("<!--CHAN_FONT_FACE-->", fontFaceBlock());
    server = await serve(productDir, page);

    const launched = await launch(host, path.join(work, "profile"));
    child = launched.child;
    const cdp = await Devtools.attach(launched.port);
    await cdp.send("Page.enable");
    await cdp.send("Network.enable");
    // The engine updates itself underneath a checkout, so the build that
    // produced these numbers is recorded with them rather than looked up
    // afterwards from whatever is on disk by then.
    const version = await cdp.send("Browser.getVersion").catch(() => null);
    if (version) console.log(`engine: ${version.product}`);
    await settle(cdp);
    await fitViewport(cdp);

    for (const scenario of scenarios) {
      const png = path.join(out, `${scenario.slug}.png`);
      console.log(`\n${scenario.name}`);
      const { image, report, viewport } = await render(
        cdp,
        scenario.url(server.port),
        png,
      );
      const numbers = measure(new Pixels(image, report, viewport), report);
      failures.push(...reportScenario(scenario, report, numbers));
      console.log(`        ${png}`);
    }
  } finally {
    // The browser's profile lives under the work directory and it holds its
    // lock files open, so the process has to be gone before the tree can go.
    // Cleanup never throws: a failure here would replace whatever the run was
    // actually reporting with a filesystem error.
    if (child) {
      // The whole tree, not just the process that was spawned: both hosts
      // fan out into renderer and GPU children that keep the profile's lock
      // files open, and killing only the parent leaves them holding it.
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
      await Promise.race([once(child, "close"), sleep(5000)]).catch(() => {});
      await sleep(500);
    }
    if (server) server.close();
    try {
      // Created by this run and positively identified: a mkdtemp path that
      // still holds the modules it was built with.
      if (fs.existsSync(path.join(work, "product/ghosttyCompat.js"))) {
        fs.rmSync(work, { recursive: true, force: true, maxRetries: 5 });
      }
    } catch (err) {
      console.error(`warning: could not remove ${work} (${err.code})`);
    }
  }

  if (failures.length) {
    console.log(`\nFAIL: ${failures.length} assertion(s)`);
    for (const failure of failures) console.log(`  ${failure}`);
    console.log(`PNGs preserved under ${out}`);
    return 1;
  }
  console.log(`\nPASS: every scenario paints a gap-free grid (${out})`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`error: ${err.message}`);
    process.exit(1);
  },
);
