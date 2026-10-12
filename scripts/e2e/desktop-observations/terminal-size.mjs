#!/usr/bin/env node
// Bounded terminal-size observation. Product sources and resize traffic stay
// unchanged; splits use public commands, moves use Chrome's HTML drag input.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import { defaultChrome, findControlSocket, launchServer, seedWorkspace, teardownServer } from "../browser-smoke/lib/server.mjs";
import { writeTerminalPrefs } from "../browser-smoke/lib/terminal-prefs.mjs";
import { installSizeObserver } from "./terminal-size-page.mjs";
import { preflight, readSizeRun } from "./terminal-size-reader.mjs";

const exec = promisify(execFile);
const now = () => Number(process.hrtime.bigint()) / 1e6;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(new URL("../browser-smoke/package.json", import.meta.url));
const { values } = parseArgs({ options: {
  backend: { type: "string" }, output: { type: "string" }, cycles: { type: "string", default: "3" },
  "co-view": { type: "boolean", default: false }, verbose: { type: "boolean", short: "v", default: false },
} });
if (!["xterm", "ghostty"].includes(values.backend) || !values.output || !/^[1-9]$/.test(values.cycles)) {
  throw new Error("usage: terminal-size.mjs --backend xterm|ghostty --output NEW_DIRECTORY [--cycles 1..9] [--co-view] [-v]");
}
const out = resolve(values.output);
mkdirSync(out, { recursive: false, mode: 0o700 });
const save = (name, value) => writeFileSync(join(out, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const safe = (s) => String(s).replace(/https?:\/\/[^\s"'<>]+/g, (url) => {
  try { const parsed = new URL(url); return parsed.origin + parsed.pathname; } catch { return "[URL]"; }
});
const bin = resolve(process.env.CHAN_BIN ?? "target/debug/chan");
const chrome = process.env.CHROME_BIN ?? defaultChrome();
if (!existsSync(bin) || !chrome) { console.error("missing chan or Chrome; provision the guest first"); process.exit(2); }
save("reader-preflight.json", preflight());
const run = { completed: false, backend: values.backend, cycles: Number(values.cycles), coView: values["co-view"],
  name: "size-probe", pages: [], steps: [], actions: [], probe: [], errors: [] };
const workspace = seedWorkspace();
const privateLog = [];
const server = launchServer(bin, workspace, (line) => privateLog.push(line));
let browser;
let readerResult;
const pages = [];
const probePath = join(out, "probe.jsonl");
const probe = () => existsSync(probePath) ? readFileSync(probePath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
async function until(read, predicate, label, bound = 20_000) {
  const start = now();
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (now() - start > bound) throw new Error(`timeout: ${label}`);
    await delay(100);
  }
}
async function calibrate(page, evidence) {
  for (let i = 0; i < 6; i++) {
    const beforeMs = now();
    const pageMs = await page.evaluate(() => performance.now());
    evidence.calibrations.push({ beforeMs, pageMs, afterMs: now() });
  }
}
async function flush(page, evidence) {
  const got = await page.evaluate(() => window.__terminalSizeObserver.drain());
  evidence.records.push(...got.records); evidence.overflow ||= got.overflow;
}
async function views() {
  return (await Promise.all(pages.map(async ({ page, evidence }) => {
    const rows = await page.evaluate(() => window.__terminalSizeObserver.snapshot());
    return rows.filter((r) => r.name === run.name && r.connected).map((r) => ({ ...r, page: evidence.name }));
  }))).flat();
}
const geometry = (rows) => JSON.stringify(rows.map((r) => ({ page: r.page, pane: r.pane, visible: r.visible,
  paneBox: r.paneBox, hostBox: r.hostBox })).sort((a, b) => a.page.localeCompare(b.page)));
async function observe(label) {
  let previous = null, stableSince = now();
  await until(views, (rows) => {
    const signature = geometry(rows);
    if (rows.length !== pages.length || rows.some((r) => !r.backend)) { stableSince = now(); return false; }
    if (signature !== previous) { previous = signature; stableSince = now(); }
    return now() - stableSince >= 750;
  }, `${label} geometry settlement`);
  const settledMs = now();
  let geometryChanged = false;
  while (now() - settledMs < 2100) {
    await delay(100);
    geometryChanged ||= geometry(await views()) !== previous;
  }
  const finalViews = await views();
  const last = probe().at(-1);
  if (!last || last.pid < 2) throw new Error("missing live probe identity");
  const checkpointBeforeMs = now();
  process.kill(last.pid, "SIGUSR1");
  const checkpoint = await until(async () => probe().at(-1),
    (r) => r.sequence > last.sequence && r.kind === "checkpoint", "probe checkpoint");
  const checkpointAfterMs = now();
  run.steps.push({ label, settledMs, endMs: now(), geometryChanged, views: finalViews,
    checkpoint, checkpointBeforeMs, checkpointAfterMs });
  for (const { page, evidence } of pages) await flush(page, evidence);
  if (values.verbose) console.log(`${label}: PTY ${checkpoint.cols}x${checkpoint.rows}; ${finalViews.map((v) => `${v.page} ${v.grid?.cols}x${v.grid?.rows} ${v.visible ? "visible" : "hidden"}`).join(", ")}`);
}

try {
  const url = new URL(await server.url);
  const token = url.searchParams.get("t") ?? "";
  const windowId = "terminal-size-observation";
  url.searchParams.set("w", windowId);
  const socket = await until(async () => findControlSocket(server.child.pid), Boolean, "private control socket");
  const env = { ...process.env, CHAN_HOME: server.chanHome, CHAN_CONTROL_SOCKET: socket, CHAN_WINDOW_ID: windowId };
  const cs = async (args) => {
    try { return await exec(bin, ["shell", ...args], { env, cwd: workspace, timeout: 15_000 }); }
    catch (error) { throw new Error(safe(`${error.message}\n${error.stdout ?? ""}`)); }
  };
  const layout = async () => JSON.parse((await cs(["pane", "list", "--window", windowId, "--json"])).stdout);
  const { default: puppeteer } = await import(pathToFileURL(require.resolve("puppeteer-core")).href);
  browser = await puppeteer.launch({ executablePath: chrome, headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1600,1000"],
    defaultViewport: { width: 1600, height: 1000 } });
  run.engine = await browser.version();
  run.binarySha256 = createHash("sha256").update(readFileSync(bin)).digest("hex");
  run.source = (await exec("git", ["rev-parse", "HEAD"], { cwd: resolve(here, "../../..") })).stdout.trim();
  async function openPage(name, width, height) {
    const page = await browser.newPage();
    const evidence = { name, calibrations: [], records: [], overflow: false };
    run.pages.push(evidence); pages.push({ page, evidence });
    await page.setViewport({ width, height });
    await page.evaluateOnNewDocument(installSizeObserver);
    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector(".pane", { timeout: 30_000 });
    await calibrate(page, evidence);
    return page;
  }
  const page = await openPage("primary", 1600, 1000);
  await until(async () => { try { return await layout(); } catch { return null; } }, Boolean, "window addressable");
  await writeTerminalPrefs(page, token, { ghostty: values.backend === "ghostty", secret_masking: false });
  const initial = await layout();
  const left = initial.activePaneId;
  const anchor = (paneId, name) => cs(["terminal", "new", "--window", windowId, "--pane", paneId,
    "--side", "a", "--tab-name", name]);
  // Moving the last tab removes its empty source pane. Keep a shell in each
  // source so the measured move retains the intended unequal geometry.
  await anchor(left, "size-anchor-left");
  const command = `exec python3 ${quote(join(here, "terminal-size-probe.py"))} --output ${quote(probePath)}`;
  await cs(["terminal", "new", "--window", windowId, "--pane", left, "--side", "a", "--tab-name", run.name, "--command", command]);
  await until(async () => probe(), (rows) => rows.length > 0, "probe started");
  if (run.coView) await openPage("co-viewer", 1050, 750);
  await page.bringToFront();
  await page.setDragInterception(true);
  await observe("initial");
  async function act(label, action) {
    const startMs = now();
    await action();
    run.actions.push({ label, startMs, endMs: now() });
    await observe(label);
  }
  async function split(direction, paneId) {
    const result = await cs(["pane", "new", direction, "--window", windowId, "--pane", paneId]);
    const id = result.stdout.trim();
    await until(layout, (v) => v.panes.some((p) => p.id === id), "new pane");
    return id;
  }
  async function move(target) {
    const positions = await page.evaluate(({ name, target }) => {
      const source = [...document.querySelectorAll(".tab")].find((e) => e.querySelector(".path")?.textContent?.trim() === name);
      const destination = document.querySelector(`.pane[data-pane-id="${CSS.escape(target)}"] .tabs`);
      if (!source || !destination) throw new Error("missing drag source or destination");
      const a = source.getBoundingClientRect(), b = destination.getBoundingClientRect();
      return { a: { x: a.x + a.width / 2, y: a.y + a.height / 2 },
        b: { x: b.x + b.width / 2, y: b.y + b.height / 2 } };
    }, { name: run.name, target });
    await page.mouse.dragAndDrop(positions.a, positions.b, { delay: 80 });
    await until(views, (rows) => rows.some((r) => r.page === "primary" && r.pane === target), "tab move");
  }
  for (let cycle = 1; cycle <= run.cycles; cycle++) {
    let right, bottom;
    await act(`${cycle}/split-right`, async () => {
      right = await split("right", left); await anchor(right, `size-anchor-right-${cycle}`);
    });
    await act(`${cycle}/split-bottom`, async () => {
      bottom = await split("bottom", right); await anchor(bottom, `size-anchor-bottom-${cycle}`);
    });
    await act(`${cycle}/unequal-width`, () => cs(["pane", "resize", "0.12", "--window", windowId, "--pane", left]));
    await act(`${cycle}/move-bottom`, () => move(bottom));
    await act(`${cycle}/move-right`, () => move(right));
    await act(`${cycle}/close-bottom`, () => cs(["pane", "close", bottom, "--window", windowId, "--force"]));
    const cover = `size-cover-${cycle}`;
    await act(`${cycle}/hide-probe`, () => cs(["terminal", "new", "--window", windowId, "--pane", right, "--side", "a", "--tab-name", cover]));
    await act(`${cycle}/resize-hidden`, () => cs(["pane", "resize", "0.10", "--window", windowId, "--pane", right]));
    await act(`${cycle}/show-probe`, () => cs(["terminal", "close", "--tab-name", cover]));
    await act(`${cycle}/move-left`, () => move(left));
    await act(`${cycle}/close-right`, () => cs(["pane", "close", right, "--window", windowId, "--force"]));
  }
  await page.screenshot({ path: join(out, "final.png") });
  run.completed = true;
} catch (error) {
  run.errors.push(safe(error.message));
  if (pages[0]) await pages[0].page.screenshot({ path: join(out, "failure.png") }).catch(() => {});
} finally {
  for (const { page, evidence } of pages) {
    try { await calibrate(page, evidence); await flush(page, evidence); }
    catch (error) { run.errors.push(safe(error.message)); run.completed = false; }
  }
  run.probe = probe();
  if (browser) await browser.close().catch((error) => { run.errors.push(safe(error.message)); run.completed = false; });
  await teardownServer(bin, server.child, workspace, server.chanHome, (line) => privateLog.push(line));
  run.cleanup = { serverExited: server.child.exitCode !== null || server.child.signalCode !== null,
    workspaceRemoved: !existsSync(workspace), homeRemoved: !existsSync(server.chanHome) };
  if (Object.values(run.cleanup).some((ok) => !ok)) run.completed = false;
  writeFileSync(join(out, "server-private.log"), privateLog.join("\n"), { mode: 0o600 });
  save("run.json", run);
  try { readerResult = readSizeRun(run); }
  catch (error) { readerResult = { verdict: "inconclusive", error: safe(error.message), driverErrors: run.errors }; }
  save("summary.json", readerResult);
}
console.log(JSON.stringify({ verdict: readerResult.verdict, findings: readerResult.findings?.length ?? null,
  steps: run.steps.length, probeEvents: run.probe.length, output: out, errors: run.errors }));
process.exitCode = readerResult.verdict === "fault-observed" ? 1 : readerResult.verdict === "bounded-search-no-fault" ? 0 : 3;
