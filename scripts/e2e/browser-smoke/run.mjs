#!/usr/bin/env node
// Browser-smoke runner: build (unless SMOKE_SKIP_BUILD=1), seed a
// throwaway workspace, launch a chan test server + headless Chrome,
// run every check under checks/ in filename order, and write
// results.json + screenshots to the out dir. Nonzero exit on any
// failed (not skipped) check. See README.md for the check contract.

import { execFileSync, execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const execFileP = promisify(execFile);

// Self-install harness deps on first run (hands-off requirement).
if (!existsSync(join(HERE, "node_modules"))) {
  console.log("[smoke] installing harness dependencies...");
  execFileSync("npm", ["install", "--no-audit", "--no-fund"], {
    cwd: HERE,
    stdio: "inherit",
  });
}

const { default: puppeteer } = await import("puppeteer-core");
const { assertNoDuplicateBands, assertPdf } = await import("./lib/pdf.mjs");
const { startDelayProxy } = await import("./lib/delay-proxy.mjs");
const {
  defaultChrome,
  findControlSocket,
  launchServer,
  seedWorkspace,
  teardownServer,
} = await import("./lib/server.mjs");

const outDir =
  process.env.SMOKE_OUT_DIR ?? mkdtempSync(join(tmpdir(), "chan-browser-smoke-"));
mkdirSync(outDir, { recursive: true });
const downloadDir = join(outDir, "downloads");
mkdirSync(downloadDir, { recursive: true });

const chanBin = process.env.CHAN_BIN ?? join(REPO, "target", "debug", "chan");
const chromeBin = process.env.CHROME_BIN ?? defaultChrome();
if (!chromeBin) {
  console.error("no Chrome found; set CHROME_BIN");
  process.exit(2);
}

if (process.env.SMOKE_SKIP_BUILD !== "1") {
  console.log("[smoke] building web bundle...");
  execFileSync("npm", ["run", "build"], { cwd: join(REPO, "web"), stdio: "inherit" });
  console.log("[smoke] building chan binary...");
  execFileSync("cargo", ["build", "-p", "chan"], { cwd: REPO, stdio: "inherit" });
}
if (!existsSync(chanBin)) {
  console.error(`chan binary missing at ${chanBin}; build first or set CHAN_BIN`);
  process.exit(2);
}

const results = {
  startedAt: new Date().toISOString(),
  chanBin,
  chromeBin,
  outDir,
  checks: [],
};

console.log("[smoke] seeding workspace...");
const workspaceDir = seedWorkspace();
const server = launchServer(chanBin, workspaceDir, (line) => console.log(line));
let browser = null;
let failed = 0;

try {
  const serverUrl = await server.url;
  results.serverUrl = serverUrl.replace(/([?&]t=)[^&]+/, "$1<token>");
  console.log(`[smoke] server up: ${results.serverUrl}`);

  browser = await puppeteer.launch({
    executablePath: chromeBin,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1600,1000"],
    defaultViewport: { width: 1600, height: 1000 },
  });
  const page = await browser.newPage();
  const cdp = await page.createCDPSession();
  await cdp.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloadDir,
    eventsEnabled: true,
  });
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`[page:error] ${m.text()}`);
  });
  page.on("response", (r) => {
    if (r.status() >= 400) {
      console.log(`[page:http${r.status()}] ${r.request().method()} ${r.url()}`);
    }
  });

  await page.goto(serverUrl, { waitUntil: "networkidle2", timeout: 60_000 });
  await page.waitForSelector(".pane", { timeout: 30_000 });

  // Shared check context (see README.md).
  let currentCheck = null;
  const ctx = {
    page,
    browser,
    serverUrl,
    workspaceDir,
    outDir,
    downloadDir,
    chanBin,
    repoRoot: REPO,
    serverPid: server.child.pid,
    get controlSocket() {
      return findControlSocket(server.child.pid);
    },
    // Checks that drive their OWN page pass it as `target`; the default stays
    // the shared harness page.
    async shot(name, target = page) {
      const file = join(outDir, `${currentCheck.name}-${name}.png`);
      await target.screenshot({ path: file });
      currentCheck.screenshots.push(file);
      return file;
    },
    async pollFile(path, timeoutMs = 60_000) {
      const start = Date.now();
      let lastSize = -1;
      for (;;) {
        if (existsSync(path)) {
          const size = statSync(path).size;
          if (size > 0 && size === lastSize) return readFileSync(path);
          lastSize = size;
        }
        if (Date.now() - start > timeoutMs) {
          throw new Error(`file did not settle within ${timeoutMs}ms: ${path}`);
        }
        await new Promise((r) => setTimeout(r, 300));
      }
    },
    skip(reason) {
      const err = new Error(reason);
      err.smokeSkip = true;
      throw err;
    },
    assertPdf,
    assertNoDuplicateBands,
    exec: (bin, args, opts = {}) =>
      execFileP(bin, args, { timeout: 120_000, ...opts }),
    // A per-check latency shim: returns a rewritten server URL whose TCP
    // path (HTTP and WebSocket alike) crosses a delay proxy. The check
    // owns the handle and must close() it.
    async latencyProxy(latencyMs) {
      const target = new URL(serverUrl);
      const proxy = await startDelayProxy({
        targetPort: Number(target.port),
        latencyMs,
      });
      const url = new URL(serverUrl);
      url.port = String(proxy.port);
      return { url: url.toString(), setLatency: proxy.setLatency, close: proxy.close };
    },
  };

  // SMOKE_ONLY=50,55 runs just the checks whose filenames start with one
  // of the comma-separated prefixes; everything else still runs in order.
  const only = process.env.SMOKE_ONLY?.split(",").map((s) => s.trim()).filter(Boolean);
  const checkFiles = readdirSync(join(HERE, "checks"))
    .filter((f) => f.endsWith(".mjs"))
    .filter((f) => !only || only.some((p) => f.startsWith(p)))
    .sort();
  for (const file of checkFiles) {
    const mod = (await import(pathToFileURL(join(HERE, "checks", file)).href)).default;
    currentCheck = {
      name: mod.name,
      file,
      ok: false,
      skipped: false,
      screenshots: [],
      startedAt: new Date().toISOString(),
    };
    console.log(`[smoke] check: ${mod.name}`);
    const t0 = Date.now();
    try {
      currentCheck.details = (await mod.run(ctx)) ?? null;
      currentCheck.ok = true;
      console.log(`[smoke]   PASS (${Date.now() - t0}ms)`);
    } catch (e) {
      if (e.smokeSkip) {
        currentCheck.skipped = true;
        currentCheck.reason = e.message;
        console.log(`[smoke]   SKIP: ${e.message}`);
      } else {
        currentCheck.error = e.stack ?? String(e);
        failed++;
        console.error(`[smoke]   FAIL: ${e.message}`);
        try {
          await ctx.shot("failure");
        } catch {}
      }
    }
    currentCheck.durationMs = Date.now() - t0;
    results.checks.push(currentCheck);
  }
} catch (e) {
  results.fatal = e.stack ?? String(e);
  failed++;
  console.error(`[smoke] fatal: ${e.message}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  await teardownServer(chanBin, server.child, workspaceDir, (l) => console.log(l));
}

results.finishedAt = new Date().toISOString();
results.ok = failed === 0;
writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
console.log(`[smoke] results: ${join(outDir, "results.json")}`);
console.log(`[smoke] ${results.ok ? "ALL GREEN" : `${failed} FAILURE(S)`}`);
process.exit(results.ok ? 0 : 1);
