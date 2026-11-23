#!/usr/bin/env node
// Browser-smoke runner: build (unless SMOKE_SKIP_BUILD=1), seed a
// throwaway workspace, launch a chan test server + headless Chrome,
// run every check under checks/ in filename order, pin the destructive
// workspace-root-loss check last, and write results.json + screenshots to the
// out dir. Nonzero exit on any incomplete or failed selection. See README.md for
// the check contract.

import { execFileSync, execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { maskTokens } from "./lib/token-mask.mjs";
import { FailureRecord } from "./lib/failure-record.mjs";

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

const results = { startedAt: new Date().toISOString(), selectedChecks: [], checks: [] };
let outDir;
let currentCheck = null;
let currentRecorder = null;
let server = null;
let browser = null;
let finished = false;

function unrunnable(...lines) {
  throw new Error(lines.join("\n"));
}

// Setup and evidence errors cannot establish a product assertion. Inside a
// check, only an explicit environment tag or disconnected browser overrides FAIL.
function checkError(error, phase) {
  const environmental = phase !== "check" || error?.smokeEnvironment ||
    browser?.connected === false;
  const status = environmental ? "error" : "failed";
  const detail = maskTokens(error?.stack ?? String(error));
  currentCheck.errors ??= [];
  currentCheck.errors.push({ phase, status, detail });
  currentCheck.error = currentCheck.errors.map((entry) => `${entry.phase}: ${entry.detail}`).join("\n");
  if (currentCheck.status !== "error" && currentCheck.status !== "failed") {
    currentCheck.status = status;
  }
  currentCheck.ok = false;
  if (currentCheck.skipped) currentCheck.skipReason = currentCheck.reason;
  currentCheck.skipped = false;
  delete currentCheck.reason;
}

function recordFatal(error, phase) {
  const detail = maskTokens(error?.stack ?? String(error));
  results.fatal ??= detail;
  results.errorPhase ??= phase;
  if (currentCheck && !results.checks.includes(currentCheck)) {
    checkError(error, phase);
    results.checks.push(currentCheck);
  }
  console.error(`[smoke] ERROR (${phase}): ${detail}`);
}

function serialize(value) {
  return JSON.stringify(value, (_key, entry) =>
    typeof entry === "string" ? maskTokens(entry) : entry, 2);
}

function snapshotDetails(value) {
  return JSON.parse(serialize(value ?? null));
}

function writeResults(final = false) {
  const path = join(outDir, "results.json");
  results.ran = results.checks.filter((c) => c.ran).length;
  results.passed = results.checks.filter((c) => c.status === "passed").length;
  results.skipped = results.checks.filter((c) => c.skipped).length;
  results.failed = results.checks.filter((c) => c.status === "failed").length;
  results.errors = results.checks.filter((c) => c.status === "error").length;
  results.status = "running";
  results.ok = false;
  results.exitCode = null;
  results.currentCheck = currentCheck && !results.checks.includes(currentCheck) ? currentCheck.file : null;
  if (final) {
    results.finishedAt = new Date().toISOString();
    results.status = results.errorPhase !== undefined || results.errors ? "error" :
      results.failed ? "failed" : results.skipped ? "skipped" :
      results.passed > 0 && results.passed === results.selectedChecks.length ? "passed" : "error";
    if (results.errorPhase === "selection") results.status = "selection-error";
    results.ok = results.status === "passed";
    results.exitCode = results.ok ? 0 : results.status === "failed" ? 1 : 2;
  }
  // A killed writer must leave the preceding complete snapshot readable.
  writeFileSync(`${path}.tmp`, serialize(results));
  renameSync(`${path}.tmp`, path);
  return path;
}

function finish() {
  if (!outDir) process.exit(2);
  try {
    console.log(`[smoke] results: ${writeResults(true)}`);
  } catch (error) {
    console.error(`[smoke] ERROR (results): ${maskTokens(error?.stack ?? String(error))}`);
    process.exit(2);
  }
  const verdict = { passed: "ALL GREEN", failed: `${results.failed} FAILURE(S)`,
    skipped: "INCOMPLETE", error: "ERROR", "selection-error": "SELECTION ERROR" }[results.status];
  console.log(`[smoke] ${verdict} (${results.ran} ran; ${results.passed} passed, ${results.failed} failed, ${results.skipped} skipped, ${results.errors} errors)`);
  finished = true;
  process.exit(results.exitCode);
}

// A throw outside an awaited check still needs a non-success verdict. Kill
// only the runner's own children; asynchronous cleanup cannot precede exit.
function recordCrash(kind, error) {
  recordFatal(error, kind);
  try {
    if (currentCheck && currentRecorder) currentCheck.timeline = currentRecorder.write();
  } catch (writeError) {
    checkError(writeError, "timeline");
  }
  try { server?.child?.kill("SIGKILL"); } catch {}
  try { browser?.process()?.kill("SIGKILL"); } catch {}
  finish();
}

process.on("unhandledRejection", (e) => recordCrash("unhandled rejection", e));
process.on("uncaughtException", (e) => recordCrash("uncaught exception", e));
process.on("exit", (code) => {
  // A check can exit directly without producing a final verdict.
  if (!finished && !process.argv.includes("--deps-only")) process.exitCode = code || 2;
});

// The checks that start their own `chan devserver run` give it a throwaway
// CHAN_HOME and CHAN_NO_DEVSERVER_HANDOFF, and it still binds a discovery
// endpoint under $XDG_RUNTIME_DIR/chan-devserver, or, with that unset, under
// a per-uid directory in the shared temp dir. In the user's own runtime
// directory the endpoint joins the user's own devserver's in what this
// user's `chan serve` (`chan open`) and `chan close` discover, and while the
// user's devserver is down the suite's is the sole candidate a `chan serve`
// registers its workspace with. So a run refuses before it installs, builds
// or starts anything unless XDG_RUNTIME_DIR names some other directory.
// `--deps-only` starts no chan process and runs anywhere.
function sharedRuntimeDirReason() {
  const dir = process.env.XDG_RUNTIME_DIR;
  if (!dir) {
    return "XDG_RUNTIME_DIR is unset, so a devserver a check starts publishes its discovery endpoint in the per-uid directory under the shared temp dir";
  }
  const resolved = (path) => {
    try {
      return realpathSync(path);
    } catch {
      return null;
    }
  };
  const actual = resolved(dir);
  if (!actual || !statSync(actual).isDirectory()) {
    return `XDG_RUNTIME_DIR=${dir} is not a directory`;
  }
  const uid = process.getuid?.();
  if (uid === undefined) return null;
  const perUser = `/run/user/${uid}`;
  if (actual === (resolved(perUser) ?? perUser)) {
    return `XDG_RUNTIME_DIR=${dir} is this user's own runtime directory (${perUser}), where this user's own devservers publish their discovery endpoints`;
  }
  return null;
}

async function main() {
  if (!process.argv.includes("--deps-only")) {
    outDir = process.env.SMOKE_OUT_DIR ?? mkdtempSync(join(tmpdir(), "chan-browser-smoke-"));
    results.outDir = outDir;
    mkdirSync(outDir, { recursive: true });
    const reason = sharedRuntimeDirReason();
    if (reason) {
      unrunnable(
        `refusing to run: ${reason}`,
        "a devserver a check starts there is discovered by this user's own chan serve and chan close, and takes a chan serve's workspace while the user's own devserver is down",
        "give the run a private 0700 runtime dir: XDG_RUNTIME_DIR=\"$(mktemp -d)\" node scripts/e2e/browser-smoke/run.mjs, or run it in an isolated guest",
      );
    }
    // SMOKE_ONLY=50,55 runs just the checks whose filenames start with one of the
    // comma-separated prefixes; everything else still runs in order. Prefix
    // matching and ordinary run order are LEXICAL, not numeric. The destructive
    // workspace-root-loss check is the sole exception and always runs last: see
    // README.md. Resolved before anything is built or started so a filter that
    // selects nothing cannot spend a build and then report an empty green.
    const only = process.env.SMOKE_ONLY?.split(",").map((s) => s.trim()).filter(Boolean);
    const availableChecks = readdirSync(join(HERE, "checks")).filter((f) => f.endsWith(".mjs"));
    const missing = only?.filter((prefix) => !availableChecks.some((file) => file.startsWith(prefix))) ?? [];
    const checkFiles = availableChecks
      .filter((f) => !only || only.some((p) => f.startsWith(p)))
      .sort(compareCheckFiles);
    results.selectedChecks = checkFiles;
    writeResults();
    if (missing.length || checkFiles.length === 0) {
      results.errorPhase = "selection";
      unrunnable(`SMOKE_ONLY=${process.env.SMOKE_ONLY} has unmatched prefixes: ${missing.join(", ") || "(empty selection)"}`);
    }
  }

  // Self-install harness deps so a moved lock cannot keep an older browser driver.
  function installedTreeMatchesLock() {
    try {
      const lock = JSON.parse(readFileSync(join(HERE, "package-lock.json"), "utf8"));
      const installed = JSON.parse(readFileSync(join(HERE, "node_modules", ".package-lock.json"), "utf8"));
      const locked = lock.packages;
      const recorded = installed.packages;
      if (!locked || !recorded) return false;
      const keys = Object.keys(locked).filter((key) => key !== "");
      const recordedKeys = Object.keys(recorded).filter((key) => key !== "");
      if (keys.length === 0 || keys.length !== recordedKeys.length) return false;
      if (!keys.every((key) => {
        const version = locked[key]?.version;
        if (typeof version !== "string" || installed.packages?.[key]?.version !== version) return false;
        return true;
      })) return false;
      const direct = locked[""]?.dependencies;
      if (!direct || Object.keys(direct).length === 0) return false;
      return Object.keys(direct).every((name) => {
        const key = `node_modules/${name}`;
        const version = locked[key]?.version;
        const actual = JSON.parse(readFileSync(join(HERE, "node_modules", name, "package.json"), "utf8"));
        return actual.version === version;
      });
    } catch {
      return false;
    }
  }

  if (!existsSync(join(HERE, "node_modules")) || !installedTreeMatchesLock()) {
    console.log("[smoke] installing harness dependencies...");
    execFileSync("npm", ["ci", "--no-audit", "--no-fund"], {
      cwd: HERE,
      stdio: "inherit",
    });
  }
  const puppeteerVersion = JSON.parse(readFileSync(join(HERE, "node_modules", "puppeteer-core", "package.json"), "utf8")).version;
  console.log(`[smoke] puppeteer-core=${puppeteerVersion}`);

  const { default: puppeteer } = await import("puppeteer-core");

  if (process.argv.includes("--deps-only")) process.exit(0);
  const { assertNoDuplicateBands, assertPdf } = await import("./lib/pdf.mjs");
  const { startDelayProxy } = await import("./lib/delay-proxy.mjs");
  const {
    defaultChrome,
    findControlSocket,
    launchServer,
    seedWorkspace,
    teardownServer,
  } = await import("./lib/server.mjs");

  const checkFiles = results.selectedChecks;
  const downloadDir = join(outDir, "downloads");
  mkdirSync(downloadDir, { recursive: true });

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

  Object.assign(results, { chanBin, chromeBin });

  console.log("[smoke] seeding workspace...");
  const workspaceDir = seedWorkspace();
  // Checks that judge the server's own log read it here: the failure record's
  // events are bounded and drop their oldest under a noisy socket.
  const serverLineListeners = new Set();
  server = launchServer(chanBin, workspaceDir, (line) => {
    const masked = maskTokens(line);
    console.log(masked);
    currentRecorder?.mark("server:line", { line: masked });
    for (const listener of serverLineListeners) listener(masked);
  });
  try {
    const serverUrl = await server.url;
    results.serverUrl = maskTokens(serverUrl);
    console.log(`[smoke] server up: ${results.serverUrl}`);

    browser = await puppeteer.launch({
      executablePath: chromeBin,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1600,1000"],
      defaultViewport: { width: 1600, height: 1000 },
    });
    for (const launchPage of await browser.defaultBrowserContext().pages()) {
      await launchPage.close();
    }
    // The server is shared, but each check gets its own browser context below.
    const ctx = {
      page: null,
      browser: null,
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
      // Checks that drive another page pass it as `target`.
      async shot(name, target = ctx.page) {
        const file = join(outDir, `${currentCheck.name}-${name}.png`);
        await target.screenshot({ path: file });
        currentCheck.screenshots.push(file);
        return file;
      },
      mark(step, data = {}) {
        currentRecorder?.mark("check:step", { step, ...data });
      },
      evidenceEvents() {
        return currentRecorder?.events.slice() ?? [];
      },
      // Every line the shared server logs from this call until `stop`, masked,
      // in order and none dropped.
      watchServerLog() {
        const lines = [];
        const listener = (line) => lines.push(line);
        serverLineListeners.add(listener);
        return { lines, stop: () => serverLineListeners.delete(listener) };
      },
      pendingEvidence() {
        return currentRecorder?.pending() ?? [];
      },
      async observePage(page, label) {
        await currentRecorder?.observePage(page, label);
      },
      async capturePage(page, label) {
        const capture = { label };
        const bounded = async (promise) => {
          let timer;
          try {
            return await Promise.race([
              promise,
              new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error("diagnostic capture timed out")), 5000);
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        };
        try {
          capture.screenshot = await bounded(ctx.shot(`${label}-failure`, page));
        } catch (error) {
          capture.screenshotError = maskTokens(error.message);
        }
        try {
          capture.state = await bounded(page.evaluate(() => ({
            url: location.href,
            readyState: document.readyState,
            visibility: document.visibilityState,
            paneCount: document.querySelectorAll(".pane").length,
            bodyText: (document.body?.innerText ?? "").slice(0, 2000),
          })));
          capture.state.url = maskTokens(capture.state.url);
          capture.state.bodyText = maskTokens(capture.state.bodyText);
        } catch (error) {
          capture.stateError = maskTokens(error.message);
        }
        return capture;
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
      const windowId = `smoke-check-${file.split("-", 1)[0]}`;
      currentCheck = {
        name: file,
        status: "running",
        file,
        windowId,
        pagesClosed: 0,
        ran: false,
        ok: false,
        skipped: false,
        screenshots: [],
        startedAt: new Date().toISOString(),
      };
      const t0 = Date.now();
      writeResults();
      let checkBrowser = null;
      let phase = "setup";
      currentRecorder = new FailureRecord(file.replace(/\.mjs$/, ""), outDir);
      currentRecorder.startResources();
      const browserNewPage = browser.newPage.bind(browser);
      browser.newPage = async (...args) => {
        const page = await browserNewPage(...args);
        await currentRecorder?.observePage(page);
        return page;
      };
      try {
        phase = "import";
        const mod = (await import(pathToFileURL(join(HERE, "checks", file)).href)).default;
        if (typeof mod?.name !== "string" || typeof mod?.run !== "function") {
          throw new TypeError(`${file}: expected a default { name, run } export`);
        }
        currentCheck.name = mod.name;
        console.log(`[smoke] check: ${mod.name}`);
        phase = "setup";
        checkBrowser = await browser.createBrowserContext({
          downloadBehavior: { policy: "allow", downloadPath: downloadDir },
        });
        const contextNewPage = checkBrowser.newPage.bind(checkBrowser);
        checkBrowser.newPage = async (...args) => {
          const page = await contextNewPage(...args);
          await currentRecorder?.observePage(page);
          return page;
        };
        // Clipboard checks need the same grant in their own context. Grants
        // sent without a context id affect only Chrome's default context.
        await checkBrowser.overridePermissions(new URL(serverUrl).origin, [
          "clipboard-read", "clipboard-sanitized-write",
        ]);
        const page = await checkBrowser.newPage();
        ctx.page = page;
        ctx.browser = checkBrowser;
        page.on("console", (m) => {
          if (m.type() === "error") console.log(`[page:error] ${maskTokens(m.text())}`);
        });
        page.on("response", (r) => {
          if (r.status() >= 400) {
            console.log(`[page:http${r.status()}] ${r.request().method()} ${maskTokens(r.url())}`);
          }
        });

        // DOM readiness and server addressability are separate barriers.
        await page.goto(`${serverUrl}&w=${windowId}`, {
          waitUntil: "domcontentloaded", timeout: 60_000,
        });
        await page.waitForSelector(".pane", { timeout: 30_000 });
        currentCheck.controlSocketAvailable = Boolean(findControlSocket(server.child.pid));
        if (currentCheck.controlSocketAvailable) await ctx.waitWindowLive(windowId);
        phase = "check";
        currentCheck.ran = true;
        currentCheck.details = snapshotDetails(await mod.run(ctx));
        currentCheck.ok = true;
        currentCheck.status = "passed";
      } catch (e) {
        if (e?.smokeSkip && phase === "check") {
          currentCheck.status = "skipped";
          currentCheck.skipped = true;
          currentCheck.reason = e.message;
        } else {
          checkError(e, phase);
          if (e?.smokeDetails) {
            try { currentCheck.details = snapshotDetails(e.smokeDetails); }
            catch (error) { checkError(error, phase); }
          }
          try {
            await ctx.shot("failure");
          } catch {}
        }
      } finally {
        browser.newPage = browserNewPage;
        const closeErrors = [];
        if (checkBrowser) {
          try {
            const openPages = (await checkBrowser.pages()).length;
            await checkBrowser.close();
            currentCheck.pagesClosed += openPages;
          } catch (e) {
            closeErrors.push(e);
          }
        }
        // A check can use page.browser().newPage(), which opens in the default
        // context even when the page belongs to a private context.
        const defaultPages = await browser.defaultBrowserContext().pages().catch((e) => {
          closeErrors.push(e);
          return [];
        });
        for (const stray of defaultPages) {
          try {
            await stray.close();
            currentCheck.pagesClosed += 1;
          } catch (e) {
            closeErrors.push(e);
          }
        }
        for (const error of closeErrors) checkError(error, "cleanup");
        ctx.page = null;
        ctx.browser = null;
        try {
          currentRecorder.mark("check:result", { ok: currentCheck.ok, skipped: currentCheck.skipped, error: currentCheck.error ?? null });
          currentCheck.timeline = currentRecorder.write();
        } catch (error) {
          currentCheck.timelineError = maskTokens(error?.stack ?? String(error));
          checkError(error, "timeline");
        }
        currentRecorder = null;
      }
      currentCheck.durationMs = Date.now() - t0;
      results.checks.push(currentCheck);
      writeResults();
      const label = { passed: "PASS", skipped: "SKIP", failed: "FAIL", error: "ERROR" }[currentCheck.status];
      console.log(`[smoke]   ${label}: ${maskTokens(currentCheck.error ?? currentCheck.reason ?? `(${currentCheck.durationMs}ms)`)}`);
      currentCheck = null;
    }
  } catch (e) {
    recordFatal(e, "runtime");
  } finally {
    if (browser) {
      try { await browser.close(); } catch (error) { recordFatal(error, "browser cleanup"); }
    }
    try {
      await teardownServer(chanBin, server.child, workspaceDir, server.chanHome, (l) =>
        console.log(maskTokens(l)),
      );
    } catch (error) {
      recordFatal(error, "server cleanup");
    }
  }
}

try {
  await main();
} catch (error) {
  recordFatal(error, results.errorPhase ?? "startup");
}
finish();
