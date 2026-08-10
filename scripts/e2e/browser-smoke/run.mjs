#!/usr/bin/env node
// Browser-smoke runner: build (unless SMOKE_SKIP_BUILD=1), seed a
// throwaway workspace, launch a chan test server + headless Chrome,
// run every check under checks/ in filename order, pin the destructive
// workspace-root-loss check last, and write results.json + screenshots to the
// out dir. Nonzero exit on any failed (not skipped) check. See README.md for
// the check contract.

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
const DESTRUCTIVE_TAIL_CHECK = "98-workspace-root-loss.mjs";

function compareCheckFiles(left, right) {
  if (left === right) return 0;
  if (left === DESTRUCTIVE_TAIL_CHECK) return 1;
  if (right === DESTRUCTIVE_TAIL_CHECK) return -1;
  return left.localeCompare(right);
}

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

// Exit 2, distinct from 0 and 1, whenever the environment cannot exercise the
// suite at all. A caller reading only 0-or-nonzero still sees a failure, and
// one that tells the two apart learns it has an environment to fix rather than
// a defect to chase. The absence of a run is never a pass. Every bail below
// runs before the server is launched, so nothing needs tearing down.
function unrunnable(...lines) {
  for (const line of lines) console.error(`SKIP: ${line}`);
  console.error("SKIP: a skipped check is not a pass");
  process.exit(2);
}

// SMOKE_ONLY=50,55 runs just the checks whose filenames start with one of the
// comma-separated prefixes; everything else still runs in order. Prefix
// matching and ordinary run order are LEXICAL, not numeric. The destructive
// workspace-root-loss check is the sole exception and always runs last: see
// README.md. Resolved before anything is built or started so a filter that
// selects nothing cannot spend a build and then report an empty green.
const only = process.env.SMOKE_ONLY?.split(",").map((s) => s.trim()).filter(Boolean);
const checkFiles = readdirSync(join(HERE, "checks"))
  .filter((f) => f.endsWith(".mjs"))
  .filter((f) => !only || only.some((p) => f.startsWith(p)))
  .sort(compareCheckFiles);
if (checkFiles.length === 0) {
  unrunnable(`SMOKE_ONLY=${process.env.SMOKE_ONLY} selected no check`);
}

const chanBin = process.env.CHAN_BIN ?? join(REPO, "target", "debug", "chan");
const chromeBin = process.env.CHROME_BIN ?? defaultChrome();
if (!chromeBin) {
  unrunnable("no Chrome found; set CHROME_BIN", "install one: make browser-smoke-deps");
}

// A Chrome that is present but cannot start is the build container's default
// state, not an exotic case: the browser links against libnss3 and libasound2
// and the rootfs carries neither, so the dynamic linker kills it at exec.
// Probing it here, before any build, keeps that missing environment out of the
// failure column it would otherwise land in as a puppeteer launch error.
try {
  execFileSync(chromeBin, ["--version"], { stdio: "pipe", timeout: 30_000 });
} catch (e) {
  const detail = (e.stderr?.toString() || e.message || "").trim();
  unrunnable(
    `Chrome at ${chromeBin} will not start: ${detail}`,
    "install its libraries: make browser-smoke-deps",
  );
}

if (process.env.SMOKE_SKIP_BUILD !== "1") {
  console.log("[smoke] building web bundle...");
  execFileSync("npm", ["run", "build"], { cwd: join(REPO, "web"), stdio: "inherit" });
  console.log("[smoke] building chan binary...");
  execFileSync("cargo", ["build", "-p", "chan"], { cwd: REPO, stdio: "inherit" });
  console.log("[smoke] building echo extension fixture...");
  execFileSync("cargo", ["build", "-p", "chan-server", "--example", "echo-extension"], {
    cwd: REPO,
    stdio: "inherit",
  });
}
if (!existsSync(chanBin)) {
  unrunnable(`chan binary missing at ${chanBin}; build first or set CHAN_BIN`);
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

  // The app keeps background transports and capability polling alive. DOM
  // load plus the shell selector below is the explicit readiness barrier.
  await page.goto(serverUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
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
    // The server's sandboxed CHAN_HOME (throwaway ~/.chan replacement);
    // checks that exercise settings writes assert against the toml files
    // in here, never the host's real global config.
    chanHome: server.chanHome,
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
    // A window is addressable from outside the page only once its session has
    // registered with the server, and that is NOT the same event as the DOM
    // mounting: `.pane` renders from the client's own state, while `cs` and
    // `chan shell` reach a window through the server's session registry
    // (`dispatch_if_live`). A check that opens a window and then drives it by
    // id has to wait for the second event or it races a `window "..." is not
    // connected` refusal. `pane list` is a read-only round trip through that
    // same liveness path, so it succeeds exactly when the window is
    // addressable, which makes it the property rather than a proxy for it.
    async waitWindowLive(windowId, timeoutMs = 30_000) {
      const socket = findControlSocket(server.child.pid);
      if (!socket) throw new Error("control socket not found for the server pid");
      const start = Date.now();
      let lastError = "never attempted";
      for (;;) {
        try {
          await execFileP(chanBin, ["shell", "pane", "list", "--window", windowId, "--json"], {
            cwd: workspaceDir,
            env: { ...process.env, CHAN_CONTROL_SOCKET: socket, CHAN_WINDOW_ID: windowId },
            timeout: 15_000,
          });
          return;
        } catch (e) {
          lastError = e.stderr?.toString().trim() || e.message;
        }
        if (Date.now() - start > timeoutMs) {
          throw new Error(
            `window ${windowId} not addressable within ${timeoutMs}ms: ${lastError}`,
          );
        }
        await new Promise((r) => setTimeout(r, 200));
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
  await teardownServer(chanBin, server.child, workspaceDir, server.chanHome, (l) =>
    console.log(l),
  );
}

results.finishedAt = new Date().toISOString();
results.ok = failed === 0;
// A skipped check did not run, so it cannot have passed. It does not fail the
// run (its precondition is absent, not broken), but it is named on the verdict
// line rather than left for whoever thinks to open results.json: "ALL GREEN"
// over a suite that quietly skipped half of itself is the reading this suite
// exists to prevent.
const skipped = results.checks.filter((c) => c.skipped);
results.skipped = skipped.length;
writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
console.log(`[smoke] results: ${join(outDir, "results.json")}`);
const verdict = results.ok ? "ALL GREEN" : `${failed} FAILURE(S)`;
const ran = results.checks.length - skipped.length;
console.log(
  skipped.length === 0
    ? `[smoke] ${verdict} (${ran} ran)`
    : `[smoke] ${verdict} (${ran} ran, ${skipped.length} SKIPPED: ${skipped
        .map((c) => c.name)
        .join(", ")})`,
);
process.exit(results.ok ? 0 : 1);
