#!/usr/bin/env node
// Drive the same one-page size sequence in the desktop's WebKitGTK page.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { installSizeObserver } from "./terminal-size-page.mjs";
import { checkpointAfter, observationMs, preflight, readFrameSurface, readSizeRun } from "./terminal-size-reader.mjs";

const exec = promisify(execFile);
const now = () => Number(process.hrtime.bigint()) / 1e6;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: {
  inspector: { type: "string" }, xid: { type: "string" }, output: { type: "string" },
  backend: { type: "string" },
  cycles: { type: "string", default: "3" }, "full-screen": { type: "boolean", default: false },
  verbose: { type: "boolean", short: "v", default: false },
} });
if (!values.inspector || !values.xid || !values.output || !/^[1-9]$/.test(values.cycles) ||
    (values.backend && !["xterm", "ghostty"].includes(values.backend))) {
  throw new Error("usage: terminal-size-native.mjs --inspector HOST:PORT --xid XID --output DIRECTORY [--backend xterm|ghostty] [--cycles 1..9] [--full-screen] [-v]");
}
const out = resolve(values.output);
if (!existsSync(join(out, "window-before.png"))) throw new Error("the native window has no screenshot proof");
const save = (name, value) => writeFileSync(join(out, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const probePath = join(out, "probe.jsonl");
const probe = () => existsSync(probePath) ? readFileSync(probePath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
const safe = (s) => String(s).replace(/https?:\/\/[^\s"'<>]+/g, "[private URL]");

class WebKitPage {
  constructor(socket) {
    this.socket = socket;
    this.pending = new Map();
    this.nextId = 1;
    this.target = null;
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.method === "Target.targetCreated" && message.params.targetInfo.type === "page" && !this.target) {
        this.target = message.params.targetInfo.targetId;
        this.ready?.();
      } else if (message.method === "Target.dispatchMessageFromTarget") {
        const inner = JSON.parse(message.params.message);
        const pending = this.pending.get(inner.id);
        if (!pending) return;
        this.pending.delete(inner.id);
        clearTimeout(pending.timer);
        if (inner.error || inner.result?.wasThrown) pending.reject(new Error(safe(JSON.stringify(inner))));
        else pending.resolve(inner.result?.result?.value);
      }
    };
    socket.onerror = () => this.failPending(new Error("WebKit inspector socket failed"));
    socket.onclose = () => this.failPending(new Error("WebKit inspector socket closed"));
  }
  failPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
  static async open(endpoint) {
    const response = await fetch(`http://${endpoint}/`, { signal: AbortSignal.timeout(5000) });
    const html = await response.text();
    const row = /<tr[^>]*>(.*?)<\/tr>/gs;
    const found = [...html.matchAll(row)].map(([, cells]) => {
      const path = /\/socket\/\d+\/\d+\/\w+/.exec(cells)?.[0];
      return path ? { path, text: cells.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() } : null;
    }).filter(Boolean).find((entry) => entry.text.includes("/workspace-"));
    if (!found) throw new Error("no native workspace page in the WebKit inspector");
    const socket = new WebSocket(`ws://${endpoint}${found.path}`);
    const page = new WebKitPage(socket);
    await Promise.race([
      new Promise((done) => { page.ready = done; }),
      delay(8000).then(() => { throw new Error("WebKit inspector page target did not answer"); }),
    ]);
    return page;
  }
  async expression(expression) {
    if (!this.target) throw new Error("WebKit inspector has no page target");
    const id = this.nextId++;
    const answer = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error("WebKit inspector evaluation timed out"));
      }, 8000);
      this.pending.set(id, { resolve, reject, timer });
    });
    const inner = JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } });
    this.socket.send(JSON.stringify({ id, method: "Target.sendMessageToTarget", params: { targetId: this.target, message: inner } }));
    return answer;
  }
  evaluate(fn, ...args) {
    return this.expression(`(${fn.toString()})(${args.map(JSON.stringify).join(",")})`);
  }
  close() { this.socket.close(); }
}

async function until(read, predicate, label, bound = 20_000) {
  const start = now();
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (now() - start > bound) throw new Error(`timeout: ${label}`);
    await delay(100);
  }
}

save("reader-preflight.json", preflight());
const run = { completed: false, backend: null, requestedBackend: values.backend ?? null,
  cycles: Number(values.cycles), coView: false,
  observer: true, fullScreen: values["full-screen"], native: true, pageClockStepMs: 1, name: "size-probe",
  engine: readFileSync(join(out, "engine-package.txt"), "utf8").trim(), tabMoveInput: "DOM DragEvent",
  pages: [], steps: [], actions: [], probe: [], errors: [] };
const bin = resolve(process.env.CHAN_BIN);
const desktop = resolve(process.env.CHAN_DESKTOP_BIN);
run.binarySha256 = createHash("sha256").update(readFileSync(desktop)).digest("hex");
run.source = process.env.OBS_SHA ?? (await exec("git", ["rev-parse", "HEAD"], { cwd: resolve(here, "../../..") })).stdout.trim();
const evidence = { name: "primary", calibrations: [], records: [], overflow: false };
run.pages.push(evidence);
let page;
let result;
const cs = async (args) => {
  try { return await exec(bin, ["shell", ...args], { env: process.env, timeout: 15_000 }); }
  catch (error) { throw new Error(safe(`${error.message}\n${error.stdout ?? ""}`)); }
};
const layout = async () => JSON.parse((await cs(["pane", "list", "--window", process.env.CHAN_WINDOW_ID, "--json"])).stdout);
const quoteProbe = (file) => `exec python3 ${quote(join(here, file))} --output ${quote(probePath)}`;
const snapshot = () => page.evaluate(() => window.__terminalSizeObserver.snapshot());
const views = async () => (await snapshot()).filter((row) => row.name === run.name && row.connected)
  .map((row) => ({ ...row, page: evidence.name }));
const geometry = (rows) => JSON.stringify(rows.map((row) => ({ pane: row.pane, visible: row.visible,
  paneBox: row.paneBox, hostBox: row.hostBox })));
async function calibrate() {
  for (let i = 0; i < 6; i++) {
    const beforeMs = now();
    const pageMs = await page.evaluate(() => performance.now());
    evidence.calibrations.push({ beforeMs, pageMs, afterMs: now() });
  }
}
async function flush() {
  const drained = await page.evaluate(() => window.__terminalSizeObserver.drain());
  evidence.records.push(...drained.records);
  evidence.overflow ||= drained.overflow;
}
async function observe(label) {
  let previous = null, stableSince = now();
  await until(views, (rows) => {
    const signature = geometry(rows);
    if (rows.length !== 1 || !rows[0].backend) { stableSince = now(); return false; }
    if (signature !== previous) { previous = signature; stableSince = now(); }
    return now() - stableSince >= 750;
  }, `${label} geometry settlement`);
  const settledMs = now();
  let geometryChanged = false;
  while (now() - settledMs < observationMs) {
    await delay(100);
    geometryChanged ||= geometry(await views()) !== previous;
  }
  const finalViews = await views();
  const last = probe().at(-1);
  if (!last || last.pid < 2) throw new Error("missing live probe identity");
  const checkpointBeforeMs = now();
  process.kill(last.pid, "SIGUSR1");
  const checkpoint = await until(async () => checkpointAfter(probe(), last.sequence), Boolean, "probe checkpoint");
  const checkpointAfterMs = now();
  const frameSurfaces = run.fullScreen ? [{ page: evidence.name,
    ...(await page.evaluate(readFrameSurface, evidence.probeTab)) }] : [];
  run.steps.push({ label, settledMs, endMs: now(), geometryChanged, views: finalViews,
    checkpoint, checkpointBeforeMs, checkpointAfterMs, ...(run.fullScreen ? { frameSurfaces } : {}) });
  await flush();
  if (values.verbose) console.error(`terminal-size-native: ${label}: PTY ${checkpoint.cols}x${checkpoint.rows}; page ${finalViews[0].grid?.cols}x${finalViews[0].grid?.rows} ${finalViews[0].visible ? "visible" : "hidden"}`);
}
async function selectTab(name) {
  await until(async () => page.evaluate((label) => {
    const tab = [...document.querySelectorAll(".tab")].find((entry) => entry.querySelector(".path")?.textContent?.trim() === label);
    tab?.click();
    return [...document.querySelectorAll(".tab.active .path")].some((entry) => entry.textContent?.trim() === label);
  }, name), Boolean, "tab selected");
}
async function move(target) {
  await page.evaluate(({ name, target }) => {
    const source = [...document.querySelectorAll(".tab")].find((entry) => entry.querySelector(".path")?.textContent?.trim() === name);
    const destination = document.querySelector(`.pane[data-pane-id="${CSS.escape(target)}"] .tabs`);
    if (!source || !destination) throw new Error("missing drag source or destination");
    const dataTransfer = new DataTransfer();
    const event = (kind) => new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer });
    source.dispatchEvent(event("dragstart"));
    destination.dispatchEvent(event("dragover"));
    destination.dispatchEvent(event("drop"));
    source.dispatchEvent(event("dragend"));
  }, { name: run.name, target });
  await until(views, (rows) => rows.some((row) => row.pane === target), "tab move");
}

async function writeBackend(backend) {
  if (!backend) return;
  const ghostty = backend === "ghostty";
  await page.evaluate(async (selected) => {
    const prefix = document.querySelector('meta[name="chan-prefix"]')?.getAttribute("content")?.replace(/\/+$/, "") ?? "";
    const token = new URLSearchParams(location.search).get("t") ?? sessionStorage.getItem("chan.token");
    if (!token) throw new Error("workspace page has no auth token");
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const got = await fetch(`${prefix}/api/config`, { headers });
    if (!got.ok) throw new Error(`GET /api/config -> ${got.status}`);
    const config = await got.json();
    const response = await fetch(`${prefix}/api/config`, { method: "PATCH", headers,
      body: JSON.stringify({ expected_revision: config.revision,
        preferences: { terminal: { ...config.preferences.terminal, ghostty: selected, secret_masking: false } } }) });
    if (!response.ok) throw new Error(`PATCH /api/config -> ${response.status}`);
  }, ghostty);
  await until(() => page.evaluate(async (selected) => {
    const prefix = document.querySelector('meta[name="chan-prefix"]')?.getAttribute("content")?.replace(/\/+$/, "") ?? "";
    const token = new URLSearchParams(location.search).get("t") ?? sessionStorage.getItem("chan.token");
    if (!token) throw new Error("workspace page has no auth token");
    const response = await fetch(`${prefix}/api/workspace`, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`GET /api/workspace -> ${response.status}`);
    return (await response.json()).preferences?.terminal?.ghostty === selected;
  }, ghostty), Boolean, "page terminal preference", 20_000);
}

try {
  page = await WebKitPage.open(values.inspector);
  await writeBackend(values.backend);
  if (values.backend) {
    await page.evaluate(() => { setTimeout(() => location.reload(), 0); return true; });
    page.close();
    await delay(500);
    page = await WebKitPage.open(values.inspector);
    await until(() => page.evaluate(() => document.readyState), (state) => state === "complete", "reloaded workspace page", 30_000);
  }
  await page.expression(`(${installSizeObserver.toString()})()`);
  await calibrate();
  const initial = await layout();
  const left = initial.activePaneId;
  const anchor = (paneId, name) => cs(["terminal", "new", "--window", process.env.CHAN_WINDOW_ID,
    "--pane", paneId, "--side", "a", "--tab-name", name]);
  await anchor(left, "size-anchor-left");
  const probeFile = run.fullScreen ? "terminal-size-fullscreen.py" : "terminal-size-probe.py";
  await cs(["terminal", "new", "--window", process.env.CHAN_WINDOW_ID, "--pane", left, "--side", "a",
    "--tab-name", run.name, "--command", quoteProbe(probeFile)]);
  await until(probe, (rows) => rows.length > 0, "probe started");
  await selectTab(run.name);
  const ids = await page.evaluate(() => [...document.querySelectorAll(".terminal-tab.active")]
    .map((entry) => entry.getAttribute("data-terminal-tab-id")));
  if (ids.length !== 1) throw new Error("probe DOM identity ambiguous");
  evidence.probeTab = ids[0];
  await observe("initial");
  const reference = run.steps[0].views.find((row) => row.visible && row.grid);
  if (!reference) throw new Error("missing visible reference cells");
  if (!["xterm", "ghostty"].includes(reference.backend)) throw new Error("unknown native renderer");
  run.backend = reference.backend;
  if (values.backend && run.backend !== values.backend) throw new Error("mounted renderer disagrees with requested backend");
  run.cellPitch = { cellWidth: reference.screenBox.width / reference.grid.cols,
    cellHeight: reference.screenBox.height / reference.grid.rows };
  async function act(label, action) {
    const startMs = now();
    await action();
    run.actions.push({ label, startMs, endMs: now() });
    await observe(label);
  }
  async function split(direction, paneId) {
    const response = await cs(["pane", "new", direction, "--window", process.env.CHAN_WINDOW_ID, "--pane", paneId]);
    const id = response.stdout.trim();
    await until(layout, (value) => value.panes.some((pane) => pane.id === id), "new pane");
    return id;
  }
  for (let cycle = 1; cycle <= run.cycles; cycle++) {
    let right, bottom;
    await act(`${cycle}/split-right`, async () => {
      right = await split("right", left); await anchor(right, `size-anchor-right-${cycle}`);
    });
    await act(`${cycle}/split-bottom`, async () => {
      bottom = await split("bottom", right); await anchor(bottom, `size-anchor-bottom-${cycle}`);
    });
    await act(`${cycle}/unequal-width`, () => cs(["pane", "resize", "0.12", "--window", process.env.CHAN_WINDOW_ID, "--pane", left]));
    await act(`${cycle}/move-bottom`, () => move(bottom));
    await act(`${cycle}/move-right`, () => move(right));
    await act(`${cycle}/close-bottom`, () => cs(["pane", "close", bottom, "--window", process.env.CHAN_WINDOW_ID, "--force"]));
    const cover = `size-cover-${cycle}`;
    await act(`${cycle}/hide-probe`, () => cs(["terminal", "new", "--window", process.env.CHAN_WINDOW_ID,
      "--pane", right, "--side", "a", "--tab-name", cover]));
    await act(`${cycle}/resize-hidden`, () => cs(["pane", "resize", "0.10", "--window", process.env.CHAN_WINDOW_ID, "--pane", right]));
    await act(`${cycle}/show-probe`, () => cs(["terminal", "close", "--tab-name", cover]));
    await act(`${cycle}/move-left`, () => move(left));
    await act(`${cycle}/close-right`, () => cs(["pane", "close", right, "--window", process.env.CHAN_WINDOW_ID, "--force"]));
  }
  await exec("import", ["-window", values.xid, join(out, "final.png")], { timeout: 10_000 });
  run.completed = true;
} catch (error) {
  run.errors.push(safe(error.message));
  if (page) await exec("import", ["-window", values.xid, join(out, "failure.png")], { timeout: 10_000 }).catch(() => {});
} finally {
  if (page) {
    try { await calibrate(); await flush(); } catch (error) { run.errors.push(safe(error.message)); run.completed = false; }
    page.close();
  }
  run.probe = probe();
  save("run.json", run);
  try { result = readSizeRun(run); }
  catch (error) { result = { verdict: "inconclusive", error: safe(error.message), driverErrors: run.errors }; }
  save("summary.json", result);
}
console.log(JSON.stringify({ verdict: result.verdict, backend: run.backend, findings: result.findings?.length ?? null,
  steps: run.steps.length, probeEvents: run.probe.length, output: out, errors: run.errors,
  redraws: result.redrawCount ?? null,
  frameSurfaces: result.steps?.flatMap((step) => step.frameSurfaces.map((surface) =>
    ({ step: step.label, kind: surface.kind, readable: surface.readable, farCorners: surface.farCorners }))) ?? [] }));
process.exitCode = result.verdict === "fault-observed" ? 10 : result.verdict === "bounded-search-no-fault" ? 0 : 3;
