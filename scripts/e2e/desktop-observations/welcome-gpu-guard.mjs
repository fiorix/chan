#!/usr/bin/env node
// Observe the real welcome through WebKitGTK's inspector and read paired CPU samples on the GPU-less arm.
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const catalogPath = resolve(here, "../../../web/packages/workspace-app/src/components/emptyPaneAnimations.ts");
const now = () => performance.timeOrigin + performance.now();
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });

function catalog() {
  const source = readFileSync(catalogPath, "utf8");
  const block = source.split("export const EMPTY_PANE_ANIMATIONS = [")[1]?.split("] as const;")[0];
  if (!block) throw new Error("cannot locate the animation catalog");
  const ids = [...block.matchAll(/\bid:\s*"([^"]+)"/g)].map(([, key]) => key);
  const choices = [...block.matchAll(/\{\s*id:\s*"([^"]+)",\s*runner:\s*"(2d|webgl2)"/g)].map(([, key, runner]) => ({ key, runner }));
  if (choices.length === 0 || choices.length !== ids.length ||
      new Set(choices.map(({ key }) => key)).size !== choices.length ||
      !choices.some(({ runner }) => runner === "webgl2") ||
      !choices.some(({ runner }) => runner === "2d")) {
    throw new Error("the animation catalog is empty, duplicated or missing a runner");
  }
  return choices;
}

class SlowProbeError extends Error {}
class HardwareRefusalError extends Error {}
class GpuHintRefusalError extends Error {}

function parseProbe(raw, key) {
  let probe;
  try { probe = JSON.parse(raw); } catch { throw new Error(`invalid probe attribute for ${key}`); }
  const elapsed = probe?.resolvedAtEpochMs - probe?.requestedAtEpochMs;
  if (probe?.choice !== key || probe.windowMs !== 1500 ||
      !Number.isFinite(probe.callbackFps) || probe.callbackFps < 0 ||
      !Number.isFinite(probe.medianCostMs) || probe.medianCostMs < 0 ||
      !["keep", "swap"].includes(probe.decision) ||
      !Number.isFinite(probe.requestedAtEpochMs) || !Number.isFinite(probe.resolvedAtEpochMs) ||
      elapsed < 1200) {
    throw new Error(`incomplete probe attribute for ${key}`);
  }
  if (elapsed > 6000) throw new SlowProbeError(`first draw took ${elapsed.toFixed(0)} ms for ${key}`);
  return probe;
}

function mappedPaths(maps) {
  return [...new Set(maps.split("\n").map((line) => line.trim().split(/\s+/).at(-1))
    .filter((path) => /(?:libgallium-[^/]*\.so|\/dri\/[^/]*\.so)(?:\.|$)/i.test(path)))];
}

function parseDrmFdinfo(text) {
  const fields = Object.fromEntries(text.split("\n").filter((line) => line.includes(":"))
    .map((line) => { const at = line.indexOf(":"); return [line.slice(0, at), line.slice(at + 1).trim()]; }));
  const engines = Object.fromEntries(Object.entries(fields).filter(([key, value]) =>
    /^drm-engine-[\w-]+$/.test(key) && /^\d+ ns$/.test(value))
    .map(([key, value]) => [key, value.split(" ")[0]]));
  return { driver: fields["drm-driver"] ?? null, clientId: fields["drm-client-id"] ?? null,
    pdev: fields["drm-pdev"] ?? null, engines };
}

function selectProcessRows(desktopPid, westonPid, rows) {
  const processes = new Map();
  for (const { pid, ppid, cmdline } of rows) {
    const executable = basename(cmdline.split("\0")[0]);
    processes.set(pid, { pid, ppid, executable,
      webkit: executable === "WebKitWebProcess" || executable === "WebKitGPUProcess" });
  }
  const descendsFromDesktop = (pid) => {
    const seen = new Set();
    while (processes.has(pid) && !seen.has(pid)) {
      if (pid === desktopPid) return true;
      seen.add(pid);
      pid = processes.get(pid).ppid;
    }
    return false;
  };
  return [...new Set([westonPid, ...[...processes].filter(([pid]) => descendsFromDesktop(pid)).map(([pid]) => pid)])]
    .map((pid) => processes.get(pid) ?? { pid, executable: null, webkit: false });
}

function processRows(desktopPid, westonPid) {
  const rows = [];
  for (const entry of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    try {
      const status = readFileSync(`/proc/${entry}/status`, "utf8");
      const ppid = Number(status.match(/^PPid:\s+(\d+)/m)?.[1]);
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8");
      rows.push({ pid: Number(entry), ppid, cmdline });
    } catch { /* Processes can exit while /proc is read. */ }
  }
  return selectProcessRows(desktopPid, westonPid, rows)
    .map(({ pid, executable, webkit }) => {
      try {
        const maps = readFileSync(`/proc/${pid}/maps`, "utf8");
        const enginePaths = [...new Set(maps.split("\n").map((line) => line.trim().split(/\s+/).at(-1))
          .filter((path) => /libwebkit2gtk-4\.1\.so/.test(path)))];
        const holders = readdirSync(`/proc/${pid}/fd`).flatMap((fd) => {
          try {
            const node = readlinkSync(`/proc/${pid}/fd/${fd}`);
            if (!/^\/dev\/dri\/(?:renderD\d+|card\d+)$/.test(node)) return [];
            return [{ fd, node, ...parseDrmFdinfo(readFileSync(`/proc/${pid}/fdinfo/${fd}`, "utf8")) }];
          } catch { return []; }
        });
        return { pid, executable, webkit, paths: mappedPaths(maps), enginePaths, holders };
      } catch { return null; }
    }).filter(Boolean);
}

function classifyIdentification(before, after, renderer) {
  const webkit = after.filter((row) => row.webkit);
  const holders = after.flatMap((row) => row.holders.map((holder) => ({ pid: row.pid, ...holder })));
  const earlier = new Map(before.flatMap((row) => row.holders.map((holder) =>
    [`${row.pid}:${holder.node}:${holder.pdev ?? ""}:${holder.clientId ?? holder.fd}`, holder])));
  const advancing = webkit.flatMap((row) => row.holders.map((holder) => ({ pid: row.pid, ...holder }))).flatMap((holder) => {
    if (!/^\/dev\/dri\/renderD\d+$/.test(holder.node)) return [];
    const prior = earlier.get(`${holder.pid}:${holder.node}:${holder.pdev ?? ""}:${holder.clientId ?? holder.fd}`);
    if (prior && prior.driver !== holder.driver) return [];
    return Object.entries(holder.engines).flatMap(([engine, value]) => {
      const old = BigInt(prior?.engines[engine] ?? "0");
      return BigInt(value) > old ?
        [{ pid: holder.pid, node: holder.node, driver: holder.driver, clientId: holder.clientId,
          engine, deltaNs: String(BigInt(value) - old) }] : [];
    });
  });
  const software = /llvmpipe|softpipe|swrast|swiftshader|software/i.test(renderer ?? "");
  const kind = software ? "software" : renderer && webkit.length && advancing.length ? "hardware" : "unknown";
  return { kind, renderer, processes: after, holders, advancing,
    webkit: webkit.map(({ pid, executable, enginePaths }) => ({ pid, executable, enginePaths })) };
}

function requireHardware(identification) {
  if (identification.kind !== "hardware") throw new HardwareRefusalError(`hardware control refused: ${identification.kind} GL driver`);
  return identification;
}

const SNAPSHOT = `(() => {
  const root = document.querySelector('.welcome');
  const running = document.getAnimations().filter((animation) => animation.playState === 'running');
  return { ready: document.readyState === 'complete', welcome: !!root,
    selected: root?.dataset.animationId ?? null,
    persisted: sessionStorage.getItem('chan.empty-pane-animation'),
    gpuMeta: document.querySelector('meta[name="chan-gpu"]')?.content ?? null,
    contextRequests: window.__welcomeContextRecord?.requests ?? null,
    probe: root?.getAttribute('data-gpu-probe') ?? null,
    canvasCount: root?.querySelectorAll('canvas').length ?? 0,
    visible: document.visibilityState, focused: document.hasFocus(),
    editor: !!document.querySelector('.cm-editor'),
    runningAnimations: running.length,
    cursorBlinkAnimations: running.filter((animation) => animation.animationName === 'cm-blink2' &&
      animation.effect?.target?.classList?.contains('cm-cursorLayer')).length,
    pageEpochMs: performance.timeOrigin + performance.now(), pageLoadMs: performance.timeOrigin };
})()`;

const INSTALL_CONTEXT_RECORD = `(() => {
  if (document.querySelector('.welcome canvas')) return 'late';
  if (window.__welcomeContextRecord) return 'installed';
  const native = HTMLCanvasElement.prototype.getContext;
  const record = { requests: [] };
  window.__welcomeContextRecord = record;
  HTMLCanvasElement.prototype.getContext = function(kind, ...args) {
    const context = native.call(this, kind, ...args);
    if (this.closest('.welcome')) record.requests.push({ kind, answered: context !== null });
    return context;
  };
  return 'installed';
})()`;

const RENDERER = `(() => {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
  if (!gl) return null;
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = String(gl.getParameter(info?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER));
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return renderer;
})()`;

class NativePage {
  constructor(inspector, windowId, socket, workspace, verbose) {
    this.inspector = inspector;
    this.windowId = windowId;
    this.socket = socket;
    this.workspace = workspace;
    this.verbose = verbose;
  }
  async evaluate(expression) {
    const { stdout } = await exec(process.execPath, [join(here, "inspect.mjs"), this.inspector, "eval", "/workspace-", expression], { timeout: 12000 });
    return JSON.parse(stdout);
  }
  async seedReload(key, reading = "gpu-less") {
    if (this.verbose) console.error(`welcome-gpu-guard: seed and reload ${key}`);
    const chosen = JSON.stringify(key);
    const oldLoad = await this.evaluate("performance.timeOrigin");
    await this.evaluate(`sessionStorage.setItem('chan.empty-pane-animation', ${chosen}); setTimeout(() => location.reload(), 0); true`);
    if (reading !== "gpu-less") return;
    const deadline = now() + 20000;
    while (now() < deadline) {
      try {
        const result = await this.evaluate(`performance.timeOrigin === ${oldLoad} ? 'old' : ${INSTALL_CONTEXT_RECORD}`);
        if (result === "installed") return;
        if (result === "late") throw new Error(`welcome canvas mounted before context record for ${key}`);
      } catch (error) {
        if (/welcome canvas mounted/.test(String(error))) throw error;
      }
      await delay(50);
    }
    throw new Error(`reload did not install the context record for ${key}`);
  }
  snapshot() { return this.evaluate(SNAPSHOT); }
  async openEditor() {
    await exec(process.env.CHAN_BIN, ["shell", "open", join(this.workspace, "a.md")], {
      env: { ...process.env, CHAN_WINDOW_ID: this.windowId, CHAN_CONTROL_SOCKET: this.socket,
        CHAN_WORKSPACE_PATH: this.workspace }, timeout: 20000,
    });
    await this.evaluate("document.activeElement?.blur(); true");
  }
  async beginIdentification(clock = now, sleep = delay) {
    const desktopPid = Number(process.env.OBS_DESKTOP_PID);
    const westonPid = Number(process.env.OBS_WESTON_PID);
    if (!desktopPid || !westonPid) throw new Error("control process IDs are missing");
    const renderer = await this.evaluate(RENDERER);
    const before = await waitForWebProcess(() => processRows(desktopPid, westonPid), clock, sleep);
    return { renderer, before };
  }
  async identify(start) {
    const after = processRows(Number(process.env.OBS_DESKTOP_PID), Number(process.env.OBS_WESTON_PID));
    return classifyIdentification(start.before, after, start.renderer);
  }
}

class FixturePage {
  constructor(choices, fixture) {
    this.choices = choices;
    this.fixture = fixture;
    this.epoch = 1800000000000;
    this.selected = null;
    this.persisted = null;
    this.gpuMeta = null;
    this.contextRequests = null;
    this.root = { dataset: {} };
    this.editor = false;
  }
  clock = () => this.epoch;
  sleep = async (ms) => { this.epoch += ms; };
  async seedReload(key, reading = "gpu-less") {
    const choice = this.choices.find((row) => row.key === key);
    if (!choice) throw new Error(`unknown fixture choice ${key}`);
    this.editor = false;
    this.gpuMeta = Object.hasOwn(this.fixture, "gpuMeta") ? this.fixture.gpuMeta : reading === "control" ? "1" : "0";
    this.selected = reading === "gpu-less" && choice.runner === "webgl2" ?
      this.choices.find((row) => row.runner === "2d").key : key;
    this.persisted = this.selected;
    this.contextRequests = [{ kind: reading === "gpu-less" ? "2d" : choice.runner, answered: true }];
    if (reading === "gpu-less" && choice.runner === "webgl2" && this.fixture.gpuLessWebglRequest) {
      this.contextRequests.push({ kind: "webgl2", answered: false });
    }
    this.root.dataset.gpuProbe = null;
    if (reading === "control" && choice.runner === "webgl2") {
      const requestedAtEpochMs = this.epoch + 200;
      const resolvedAtEpochMs = requestedAtEpochMs + (this.fixture.slowKey === key ? 7000 : 1500);
      this.root.dataset.gpuProbe = JSON.stringify({ choice: key, windowMs: 1500, ...this.fixture.probe,
        requestedAtEpochMs, resolvedAtEpochMs });
      if (this.fixture.probe.decision === "swap") {
        const index = this.choices.findIndex((row) => row.key === key);
        this.selected = [...this.choices.slice(index + 1), ...this.choices.slice(0, index)]
          .find((row) => row.runner === "2d").key;
        this.persisted = this.selected;
      }
    }
    this.epoch += this.fixture.slowKey === key ? 9000 : 3800;
  }
  async snapshot() {
    const cursorBlink = this.editor && this.fixture.editorCursorBlink ? 1 : 0;
    return { ready: true, welcome: !this.editor, selected: this.selected, persisted: this.persisted,
      gpuMeta: this.gpuMeta, contextRequests: this.contextRequests, probe: this.root.dataset.gpuProbe,
      canvasCount: this.editor ? 0 : 1, visible: "visible", focused: this.fixture.focused ?? true,
      editor: this.editor, runningAnimations: cursorBlink, cursorBlinkAnimations: cursorBlink,
      pageEpochMs: this.epoch, pageLoadMs: this.epoch - 3800 };
  }
  async openEditor() { this.editor = true; this.epoch += 1000; }
  async beginIdentification() { return this.fixture.identificationStart ?? {}; }
  async identify() { return this.fixture.identification; }
}

async function until(page, description, predicate, sleep, clock) {
  const deadline = clock() + 20000;
  let state;
  do {
    state = await page.snapshot();
    if (predicate(state)) return state;
    await sleep(250);
  } while (clock() < deadline);
  throw new Error(`timed out waiting for ${description}; last snapshot ${JSON.stringify(state)}`);
}

async function waitForWebProcess(scan, clock, sleep) {
  const deadline = clock() + 10000;
  let rows;
  do {
    rows = scan();
    if (rows.some((row) => row.webkit)) return rows;
    if (clock() >= deadline) return rows;
    await sleep(500);
  } while (true);
}

function ready(state, reading = "gpu-less") {
  return state.ready && state.welcome && state.canvasCount === 1 &&
    state.visible === "visible" && (reading === "control" || state.focused);
}

async function interval(page, key, sleep, clock) {
  const before = await page.snapshot();
  if (!ready(before) || before.selected !== key || before.persisted !== key || before.runningAnimations !== 0) throw new Error(`unstable start for ${key}`);
  const beginEpochMs = clock();
  await sleep(8000);
  const endEpochMs = clock();
  const after = await page.snapshot();
  if (!ready(after) || after.selected !== key || after.persisted !== key || after.runningAnimations !== 0) throw new Error(`unstable end for ${key}`);
  return { beginEpochMs, endEpochMs, before, after };
}

function gpuLessFault(state, choices) {
  const shown = choices.find((choice) => choice.key === state.selected);
  if (!shown || shown.runner !== "2d") return "a WebGL choice is shown";
  if (state.persisted !== state.selected) return "shown and persisted choices differ";
  if (state.probe !== null) return "a GPU probe ran";
  if (!state.contextRequests?.some((request) => request.kind === "2d" && request.answered)) return "the welcome holds no 2D context";
  if (state.contextRequests.some((request) => request.kind === "webgl2")) return "the welcome requested WebGL2";
  return null;
}

async function drive(page, output, choices, reading = "gpu-less", sleep = delay, clock = now, dryRun = false) {
  const data = { completed: false, reading, catalog: choices, webgl: [], twoD: [], baseline: null, identification: null };
  const persist = () => save(join(output, "observations.json"), data);
  const isReady = (state) => ready(state, reading);
  persist();
  for (const { key } of choices.filter(({ runner }) => runner === "webgl2")) {
    const identifying = reading === "control" && data.identification?.kind !== "hardware";
    const start = identifying ? await page.beginIdentification() : null;
    await page.seedReload(key, reading);
    if (reading === "gpu-less") {
      const early = await page.snapshot();
      if (early.gpuMeta !== "0") throw new GpuHintRefusalError(`native GPU-less reading has chan-gpu=${early.gpuMeta}`);
      const shown = await until(page, `2D welcome for ${key}`, (row) => isReady(row) && row.contextRequests?.length > 0, sleep, clock);
      const fault = gpuLessFault(shown, choices);
      if (fault) {
        data.webgl.push({ key, status: "fault", reason: fault, gpuMeta: shown.gpuMeta, shown: shown.selected,
          persisted: shown.persisted, contextRequests: shown.contextRequests, probe: shown.probe });
        persist();
        continue;
      }
      await sleep(1500);
      const settled = await until(page, `animation flash to end for ${key}`,
        (row) => isReady(row) && row.selected === shown.selected && row.runningAnimations === 0, sleep, clock);
      const settledFault = gpuLessFault(settled, choices);
      if (settledFault) {
        data.webgl.push({ key, status: "fault", reason: settledFault, gpuMeta: settled.gpuMeta, shown: settled.selected,
          persisted: settled.persisted, contextRequests: settled.contextRequests, probe: settled.probe });
        persist();
        continue;
      }
      const stable = await interval(page, shown.selected, sleep, clock);
      const stableFault = gpuLessFault(stable.before, choices) ?? gpuLessFault(stable.after, choices);
      data.webgl.push({ key, status: stableFault ? "fault" : "not-offered", reason: stableFault,
        gpuMeta: settled.gpuMeta, shown: shown.selected, persisted: settled.persisted,
        contextRequests: settled.contextRequests, stable });
      persist();
      console.error(`welcome-gpu-guard: ${key} not offered; shown ${shown.selected}`);
      continue;
    }
    const state = await until(page, `probe for ${key}`, (row) => {
      if (!isReady(row) || row.probe === null) return false;
      try { return JSON.parse(row.probe).choice === key; } catch { return false; }
    }, sleep, clock);
    if (state.gpuMeta !== "1") throw new GpuHintRefusalError(`native hardware reading has chan-gpu=${state.gpuMeta}`);
    if (reading === "control" && data.webgl.length === 0) {
      console.error(`CONTROL FIRST SNAPSHOT: ${JSON.stringify({ visible: state.visible, focused: state.focused,
        gpuMeta: state.gpuMeta,
        callbackFps: JSON.parse(state.probe).callbackFps, selected: state.selected })}`);
    }
    let probe;
    try { probe = parseProbe(state.probe, key); }
    catch (error) {
      if (!(error instanceof SlowProbeError)) throw error;
      data.webgl.push({ key, status: "no-reading", reason: error.message });
      persist();
      console.error(`welcome-gpu-guard: no reading for ${key}: ${error.message}`);
      continue;
    }
    if (Math.abs(state.pageEpochMs - clock()) > 1000) throw new Error(`page/driver clocks disagree for ${key}`);
    if (identifying) {
      data.identification = await page.identify(start);
      console.error(`CONTROL IDENTIFICATION: ${JSON.stringify(data.identification)}`);
      if (!dryRun && (data.identification.kind === "software" || data.webgl.length >= 2)) requireHardware(data.identification);
      persist();
    }
    const expected = probe.decision === "swap" ?
      [...choices.slice(choices.findIndex((row) => row.key === key) + 1), ...choices.slice(0, choices.findIndex((row) => row.key === key))]
        .find((row) => row.runner === "2d").key : key;
    await until(page, `settled ${key}`, (row) => isReady(row) &&
      (reading === "control" || row.selected === expected) && row.probe === state.probe, sleep, clock);
    await sleep(1500);
    const settled = await until(page, `animation flash to end for ${key}`, (row) => isReady(row) &&
      (reading === "control" || row.selected === expected) && row.runningAnimations === 0, sleep, clock);
    const stable = reading === "control" ? null : await interval(page, expected, sleep, clock);
    data.webgl.push({ key, gpuMeta: state.gpuMeta, probe, selected: settled.selected, swappedTo: probe.decision === "swap" ? expected : null,
      probeCpuInterval: { beginEpochMs: probe.requestedAtEpochMs, endEpochMs: probe.resolvedAtEpochMs }, stable });
    persist();
    console.error(`welcome-gpu-guard: observed ${key}: ${probe.decision} ${probe.callbackFps.toFixed(2)} fps ${probe.medianCostMs} ms`);
    if (dryRun && data.webgl.length === 3) {
      console.error("CONTROL DRY RUN: three choices driven; inconclusive by design");
      return data;
    }
  }
  if (reading === "control") {
    data.completed = true;
    persist();
    return data;
  }
  for (const { key } of choices.filter(({ runner }) => runner === "2d")) {
    await page.seedReload(key, reading);
    const shown = await until(page, `2D choice ${key}`, (row) => isReady(row) && row.selected === key && row.contextRequests?.length > 0, sleep, clock);
    if (shown.gpuMeta !== "0") throw new GpuHintRefusalError(`native GPU-less reading has chan-gpu=${shown.gpuMeta}`);
    const fault = gpuLessFault(shown, choices);
    if (fault) throw new Error(`2D choice ${key}: ${fault}`);
    await sleep(1500);
    await until(page, `animation flash to end for ${key}`, (row) => isReady(row) && row.selected === key && row.runningAnimations === 0, sleep, clock);
    const stable = await interval(page, key, sleep, clock);
    if (gpuLessFault(stable.before, choices) || gpuLessFault(stable.after, choices)) throw new Error(`2D choice ${key} changed context`);
    data.twoD.push({ key, stable });
    persist();
  }
  await page.openEditor();
  await until(page, "editor baseline", (row) => row.ready && !row.welcome && row.editor && row.canvasCount === 0 &&
    row.visible === "visible" && row.focused && row.runningAnimations === row.cursorBlinkAnimations &&
    row.cursorBlinkAnimations <= 1, sleep, clock);
  await sleep(1500);
  const before = await page.snapshot();
  const beginEpochMs = clock();
  await sleep(8000);
  const endEpochMs = clock();
  const after = await page.snapshot();
  if ([before, after].some((row) => !row.editor || row.welcome || row.canvasCount !== 0 ||
      row.runningAnimations !== row.cursorBlinkAnimations || row.cursorBlinkAnimations > 1) ||
      before.cursorBlinkAnimations !== after.cursorBlinkAnimations) throw new Error("editor baseline changed");
  data.baseline = { beginEpochMs, endEpochMs, before, after };
  data.completed = true;
  persist();
  return data;
}

function counters(text) {
  return Object.fromEntries(text.split("\n").filter(Boolean).map((line) => {
    const [key, value] = line.split(/\s+/);
    return [key, Number(value)];
  }));
}

function pair(samples, interval, minSeconds) {
  const inside = samples.filter((row) => row.epochMs >= interval.beginEpochMs && row.epochMs <= interval.endEpochMs);
  if (inside.length < 2) throw new Error("missing host CPU pair inside a page-stable interval");
  const first = inside[0], last = inside.at(-1);
  const elapsed = (last.epochMs - first.epochMs) / 1000;
  if (elapsed < minSeconds) throw new Error(`host CPU pair covers only ${elapsed.toFixed(3)}s`);
  if (first["cpu.max"] !== "200000 100000" || last["cpu.max"] !== "200000 100000") throw new Error("wrong guest CPU quota");
  const a = counters(first["cpu.stat"]), b = counters(last["cpu.stat"]);
  if (!(b.usage_usec >= a.usage_usec)) throw new Error("CPU counter reset");
  if (first["memory.events"] && last["memory.events"] &&
      counters(last["memory.events"]).oom_kill !== counters(first["memory.events"]).oom_kill) throw new Error("guest OOM kill during interval");
  return { cpuSeconds: (b.usage_usec - a.usage_usec) / 1e6,
    cpuSecondsPerSecond: (b.usage_usec - a.usage_usec) / 1e6 / elapsed,
    sampledSeconds: elapsed, firstEpochMs: first.epochMs, lastEpochMs: last.epochMs };
}

function read(data, rawSamples, reading = "gpu-less") {
  const expected = catalog();
  if (!data.completed || data.reading !== reading || JSON.stringify(data.catalog) !== JSON.stringify(expected) ||
      data.webgl.length !== expected.filter((row) => row.runner === "webgl2").length ||
      data.twoD.length !== (reading === "control" ? 0 : expected.filter((row) => row.runner === "2d").length) ||
      (reading === "gpu-less" && !data.baseline)) throw new Error("incomplete catalog observation");
  const noReading = data.webgl.filter((row) => row.status === "no-reading").map(({ key }) => key);
  if (reading === "control") {
    if (data.identification?.kind !== "hardware" ||
        !data.identification.renderer || /llvmpipe|softpipe|swrast|swiftshader|software/i.test(data.identification.renderer) ||
        !data.identification.advancing?.length ||
        !data.identification.webkit?.length) {
      throw new Error("control has no identified hardware GL driver");
    }
    const webgl = data.webgl.map((row, index) => {
      if (row.key !== expected.filter((item) => item.runner === "webgl2")[index].key) throw new Error("WebGL row order changed");
      if (row.status === "no-reading") return { key: row.key, decision: "no-reading", reason: row.reason };
      if (row.gpuMeta !== "1" || row.probe?.choice !== row.key || row.probe.windowMs !== 1500) throw new Error("WebGL row probe or GPU hint changed");
      return { key: row.key, rate: row.probe.callbackFps, medianCostMs: row.probe.medianCostMs,
        decision: row.probe.decision, selected: row.selected, swappedTo: row.swappedTo,
        probeWindowMs: row.probe.resolvedAtEpochMs - row.probe.requestedAtEpochMs };
    });
    const failures = webgl.filter((row) => row.decision !== "no-reading" &&
      (row.decision !== "keep" || row.selected !== row.key || row.swappedTo));
    return { reading, identification: data.identification, webgl, noReading,
      failures: failures.map(({ key }) => key), verdict: failures.length ? "fault" : noReading.length ? "inconclusive" : "pass" };
  }
  const samples = rawSamples.filter((row) => row.time_ns && row["cpu.stat"]).map((row) => ({
    ...row, epochMs: Number(row.time_ns) / 1e6,
  }));
  if (samples.length < 2 || samples.some((row, index) => index && row.epochMs <= samples[index - 1].epochMs)) throw new Error("missing or unordered host samples");
  if (rawSamples.some((row) => row.phase === "stop")) throw new Error("host monitor stopped the guest step");
  const webgl = data.webgl.map((row, index) => {
    if (row.key !== expected.filter((item) => item.runner === "webgl2")[index].key) throw new Error("WebGL row order changed");
    if (row.gpuMeta !== "0") throw new GpuHintRefusalError(`GPU hint changed for ${row.key}: ${row.gpuMeta}`);
    if (row.status === "fault") return { key: row.key, decision: "fault", reason: row.reason,
      shown: row.shown, persisted: row.persisted, contextRequests: row.contextRequests, probe: row.probe };
    if (row.status !== "not-offered") throw new Error(`incomplete 2D replacement for ${row.key}`);
    const fault = !expected.some((item) => item.key === row.shown && item.runner === "2d") ? "a WebGL choice is shown" :
      row.persisted !== row.shown ? "shown and persisted choices differ" :
      row.probe != null ? "a GPU probe ran" :
      !row.contextRequests?.some((request) => request.kind === "2d" && request.answered) ? "the welcome holds no 2D context" :
      row.contextRequests.some((request) => request.kind === "webgl2") ? "the welcome requested WebGL2" : null;
    if (fault) return { key: row.key, decision: "fault", reason: fault,
      shown: row.shown, persisted: row.persisted, contextRequests: row.contextRequests, probe: row.probe };
    return { key: row.key, decision: "not-offered", shown: row.shown, persisted: row.persisted,
      contextRequests: row.contextRequests, cpu: pair(samples, row.stable, 6) };
  });
  const twoD = data.twoD.map((row, index) => {
    if (row.key !== expected.filter((item) => item.runner === "2d")[index].key) throw new Error("2D row order changed");
    return { key: row.key, cpu: pair(samples, row.stable, 6) };
  });
  const slowest2D = twoD.reduce((worst, row) => row.cpu.cpuSecondsPerSecond > worst.cpu.cpuSecondsPerSecond ? row : worst);
  const bound = slowest2D.cpu.cpuSecondsPerSecond + 0.15;
  const baseline = pair(samples, data.baseline, 6);
  const failures = webgl.filter((row) => row.decision === "fault" || row.cpu.cpuSecondsPerSecond > 0.940);
  const overBound2D = twoD.filter((row) => row.cpu.cpuSecondsPerSecond > 0.940);
  return { reading, webgl, twoD, slowest2D, baseline, bound, acceptanceBound: 0.940, noReading,
    failures: [...failures, ...overBound2D].map(({ key }) => key),
    verdict: failures.length || overBound2D.length ? "fault" : "pass" };
}

function constructedSamples(data, hotWebglKey = null, hot2DKey = null) {
  const intervals = [
    ...data.webgl.filter((row) => row.stable).map((row) => ({ ...row.stable, rate: row.key === hotWebglKey ? 1.2 : 0.4 })),
    ...data.twoD.map((row) => ({ ...row.stable, rate: row.key === hot2DKey ? 1.2 : row.key === "quadratic-bloom" ? 0.5 : 0.3 })),
    { ...data.baseline, rate: 0.15 },
  ];
  const first = Math.floor(Math.min(...intervals.map((row) => row.beginEpochMs)) / 500) * 500 - 500;
  const last = Math.ceil(Math.max(...intervals.map((row) => row.endEpochMs)) / 500) * 500 + 500;
  let usage = 0;
  const samples = [];
  for (let t = first; t <= last; t += 500) {
    const current = intervals.find((row) => row.beginEpochMs <= t && t < row.endEpochMs);
    usage += (current?.rate ?? 0.1) * 500000;
    samples.push({ time_ns: String(BigInt(t) * 1000000n), "cpu.max": "200000 100000",
      "cpu.stat": `usage_usec ${Math.round(usage)}\n`, "memory.events": "oom_kill 0\n" });
  }
  return samples;
}

async function constructed(output) {
  const choices = catalog();
  const fixture = { probe: { callbackFps: 8, medianCostMs: 30, decision: "swap" }, editorCursorBlink: true };
  const page = new FixturePage(choices, fixture);
  const data = await drive(page, output, choices, "gpu-less", page.sleep, page.clock);
  const samples = constructedSamples(data);
  save(join(output, "constructed-samples.json"), samples);
  const summary = read(data, samples);
  if (summary.verdict !== "pass" || summary.slowest2D.key !== "quadratic-bloom" ||
      summary.webgl.some((row) => row.decision !== "not-offered" || row.shown !== "radial-ribbons")) {
    throw new Error("constructed GPU-less replacement did not hold");
  }
  save(join(output, "constructed-summary.json"), summary);
  const faultDir = join(output, "fault");
  mkdirSync(faultDir);
  const faultPage = new FixturePage(choices, { ...fixture, gpuLessWebglRequest: true });
  const faultData = await drive(faultPage, faultDir, choices, "gpu-less", faultPage.sleep, faultPage.clock);
  if (faultData.webgl.some((row) => row.status !== "fault") ||
      read(faultData, constructedSamples(faultData)).verdict !== "fault") {
    throw new Error("a WebGL request was not recorded as a fault by the driver");
  }
  const bad = structuredClone(data);
  bad.webgl[0].status = "fault";
  bad.webgl[0].reason = "a WebGL choice is shown";
  if (read(bad, samples).verdict !== "fault") throw new Error("constructed fault was missed");
  const badContext = structuredClone(data);
  badContext.webgl[0].contextRequests.push({ kind: "webgl2", answered: false });
  if (read(badContext, samples).verdict !== "fault") throw new Error("WebGL request fault was missed");
  const badShown = structuredClone(data);
  badShown.webgl[0].shown = choices.find((row) => row.runner === "webgl2").key;
  badShown.webgl[0].persisted = badShown.webgl[0].shown;
  if (read(badShown, samples).verdict !== "fault") throw new Error("shown WebGL fault was missed");
  const badPersisted = structuredClone(data);
  badPersisted.webgl[0].persisted = "sixfold-vortex";
  if (read(badPersisted, samples).verdict !== "fault") throw new Error("unpersisted replacement fault was missed");
  const badProbe = structuredClone(data);
  badProbe.webgl[0].probe = "{}";
  if (read(badProbe, samples).verdict !== "fault") throw new Error("GPU probe fault was missed");
  if (read(data, constructedSamples(data, data.webgl[0].key)).verdict !== "fault") throw new Error("hot shown choice was accepted");
  if (read(data, constructedSamples(data, null, data.twoD[0].key)).verdict !== "fault") throw new Error("hot 2D catalog was accepted");
  const missingDir = join(output, "missing-meta");
  mkdirSync(missingDir);
  const missingPage = new FixturePage(choices, { ...fixture, gpuMeta: null });
  try { await drive(missingPage, missingDir, choices, "gpu-less", missingPage.sleep, missingPage.clock);
    throw new Error("missing GPU meta was accepted"); }
  catch (error) { if (!(error instanceof GpuHintRefusalError)) throw error; }
  if (JSON.parse(readFileSync(join(missingDir, "observations.json"), "utf8")).webgl.length !== 0) {
    throw new Error("missing GPU meta produced a WebGL row");
  }
  try { read(data, []); throw new Error("missing samples were accepted"); }
  catch (error) { if (error.message === "missing samples were accepted") throw error; }
  const controlDir = join(output, "control");
  mkdirSync(controlDir);
  const hostMaps = "7f00-7f01 r-xp 0 00:00 0 /usr/lib/libgallium-26.2.0-arch3.1.so\n" +
    "7f01-7f02 r-xp 0 00:00 0 /usr/lib/dri/libdril_dri.so\n";
  const paths = mappedPaths(hostMaps);
  if (paths.length !== 2) throw new Error("host map context paths were lost");
  const fdinfo = (ns) => parseDrmFdinfo(`pos:\t0\ndrm-driver: amdgpu\ndrm-client-id: 17\n` +
    (ns === null ? "" : `drm-engine-gfx: ${ns} ns\n`));
  const selected = selectProcessRows(98, 99, [
    { pid: 98, ppid: 1, cmdline: "/usr/bin/chan-desktop\0" },
    { pid: 99, ppid: 1, cmdline: "/usr/bin/weston\0" },
    { pid: 100, ppid: 98, cmdline: "/usr/libexec/WebKitWebProcess\0" },
    { pid: 101, ppid: 100, cmdline: "/usr/libexec/WebKitGPUProcess\0" },
    { pid: 102, ppid: 98, cmdline: "/usr/libexec/WebKitNetworkProcess\0" },
    { pid: 103, ppid: 1, cmdline: "/usr/libexec/WebKitWebProcess\0" },
  ]);
  const byPid = new Map(selected.map((row) => [row.pid, row]));
  const uiWithWebKitMap = { ...byPid.get(98), enginePaths: ["/usr/lib/libwebkit2gtk-4.1.so.0"] };
  if (!byPid.has(98) || uiWithWebKitMap.webkit) throw new Error("desktop UI process was classified as WebKit");
  console.error("CONSTRUCTED desktop UI with WebKit map: not WebKit");
  if (!byPid.has(102) || byPid.get(102).webkit) throw new Error("WebKitNetworkProcess was classified as WebKit rendering");
  console.error("CONSTRUCTED WebKit network process: not WebKit rendering");
  if (byPid.has(103)) throw new Error("WebKitWebProcess outside the desktop tree was admitted");
  console.error("CONSTRUCTED external WebKit web process: excluded");
  if (!byPid.get(100)?.webkit || !byPid.get(101)?.webkit || !byPid.has(99)) {
    throw new Error("desktop WebKit renderers or compositor were lost");
  }
  const snapshot = (ns, node = "/dev/dri/renderD128", executable = "WebKitWebProcess", holderPid = 100) => {
    const holder = (pid) => node && pid === holderPid ? [{ fd: "9", node, ...fdinfo(ns) }] : [];
    return [
      { pid: 99, executable: "weston", webkit: false, paths, enginePaths: [], holders: holder(99) },
      { pid: 98, executable: "chan-desktop", webkit: false, paths,
        enginePaths: ["/usr/lib/libwebkit2gtk-4.1.so.0"], holders: holder(98) },
      { pid: 100, executable, webkit: executable === "WebKitWebProcess" || executable === "WebKitGPUProcess",
        paths, enginePaths: ["/usr/lib/libwebkit2gtk-4.1.so.0"], holders: holder(100) },
    ];
  };
  const hardware = classifyIdentification(snapshot(100), snapshot(300), "Apple GPU");
  const still = classifyIdentification(snapshot(100), snapshot(100), "Apple GPU");
  const software = classifyIdentification(snapshot(100), snapshot(300), "llvmpipe (LLVM 19)");
  const noRender = classifyIdentification(snapshot(100, "/dev/dri/card0"), snapshot(300, "/dev/dri/card0"), "Apple GPU");
  const compositorOnly = classifyIdentification(snapshot(100, undefined, undefined, 99), snapshot(300, undefined, undefined, 99), "Apple GPU");
  const uiOnly = classifyIdentification(snapshot(100, undefined, undefined, 98), snapshot(300, undefined, undefined, 98), "Apple GPU");
  const gpuProcess = classifyIdentification(snapshot(100, undefined, "WebKitGPUProcess"), snapshot(300, undefined, "WebKitGPUProcess"), "Apple GPU");
  const noRenderer = classifyIdentification(snapshot(100), snapshot(300), null);
  const firstUse = classifyIdentification(snapshot(null), snapshot(2500), "Apple GPU");
  const newClient = classifyIdentification(snapshot(null, undefined, undefined, null), snapshot(2500), "Apple GPU");
  if (hardware.kind !== "hardware" || hardware.advancing[0]?.deltaNs !== "200") throw new Error("moving DRM engine was not hardware");
  if (gpuProcess.kind !== "hardware") throw new Error("moving WebKit GPU process was not hardware");
  if (compositorOnly.kind !== "unknown") throw new Error("compositor-only counter proved hardware");
  if (uiOnly.kind !== "unknown") throw new Error("UI-only counter proved hardware");
  if (noRenderer.kind !== "unknown") throw new Error("a missing renderer proved hardware");
  if (firstUse.kind !== "hardware" || firstUse.advancing[0]?.deltaNs !== "2500") throw new Error("new engine line in the window was lost");
  if (newClient.kind !== "hardware" || newClient.advancing[0]?.deltaNs !== "2500") throw new Error("new client in the window was lost");
  if (still.kind !== "unknown") throw new Error("still DRM counter was accepted");
  if (noRender.kind !== "unknown") throw new Error("card-only holder was accepted as a render node");
  if (software.kind !== "software") throw new Error("software renderer with moving counter was accepted");
  for (const [name, reading] of [["still counter", still], ["no render-node holder", noRender],
    ["compositor-only", compositorOnly], ["UI-only", uiOnly], ["missing renderer", noRenderer],
    ["software with moving counter", software]]) {
    try { requireHardware(reading); throw new Error(`${name} was accepted`); }
    catch (error) { if (!(error instanceof HardwareRefusalError)) throw error; }
    console.error(`CONSTRUCTED ${name}: ${reading.kind} refusal`);
  }
  const mixed = classifyIdentification(snapshot(100).map((row) => ({ ...row,
    paths: [...paths, "/usr/lib/dri/swrast_dri.so", "/usr/lib/dri/radeonsi_dri.so"] })), snapshot(300),
  "AMD Radeon Software Rasterizer");
  if (mixed.kind !== "software") throw new Error("mixed mapping or renderer bypassed software refusal");
  console.error("CONSTRUCTED mixed mapping and renderer: software refusal");
  const noWeb = classifyIdentification(snapshot(100, "/dev/dri/renderD128", "WebKitNetworkProcess"),
    snapshot(300, "/dev/dri/renderD128", "WebKitNetworkProcess"), "Apple GPU");
  if (noWeb.kind !== "unknown") throw new Error("missing WebKit process was accepted");
  console.error("CONSTRUCTED no WebKit process: unknown refusal");
  let tick = 0, scans = 0;
  const deadlineRows = await waitForWebProcess(() => { scans++; return []; }, () => tick, async (ms) => { tick += ms; });
  if (deadlineRows.length || tick !== 10000 || scans !== 21) throw new Error("identify deadline did not stop at ten seconds");
  console.error("CONSTRUCTED identify deadline: empty at 10000 ms");
  const controlFixture = { probe: { callbackFps: 60, medianCostMs: 4, decision: "keep" },
    identification: hardware, focused: false };
  const controlPage = new FixturePage(choices, controlFixture);
  const control = await drive(controlPage, controlDir, choices, "control", controlPage.sleep, controlPage.clock);
  const controlSummary = read(control, [], "control");
  if (controlSummary.verdict !== "pass" || controlSummary.webgl.some((row) => row.decision !== "keep")) throw new Error("constructed control did not hold");
  save(join(controlDir, "summary.json"), controlSummary);
  console.error("CONSTRUCTED unfocused control readiness: pass");
  const dryDir = join(output, "dry-control");
  mkdirSync(dryDir);
  const dryPage = new FixturePage(choices, controlFixture);
  const dryControl = await drive(dryPage, dryDir, choices, "control", dryPage.sleep, dryPage.clock, true);
  if (dryControl.completed || dryControl.webgl.length !== 3) throw new Error("control dry run exceeded three choices");
  console.error("CONSTRUCTED control dry-run bound: three choices, incomplete by design");
  const unknownControl = structuredClone(control);
  unknownControl.identification.kind = "unknown";
  try { read(unknownControl, [], "control"); throw new Error("read accepted unknown identification"); }
  catch (error) { if (!/control has no identified hardware/.test(error.message)) throw error; }
  console.error("CONSTRUCTED read identification: unknown refused directly");
  const wrongMode = structuredClone(data);
  wrongMode.reading = "control";
  try { read(wrongMode, samples, "gpu-less"); throw new Error("read accepted a mismatched mode"); }
  catch (error) { if (!/incomplete catalog observation/.test(error.message)) throw error; }
  console.error("CONSTRUCTED read mode: mismatch refused");
  try { await exec(process.execPath, [fileURLToPath(import.meta.url), "constructed-refusal"], { timeout: 5000 });
    throw new Error("hardware refusal exited zero"); }
  catch (error) { if (error.code !== 2 || !/CANNOT RUN/.test(error.stderr ?? "")) throw error; }
  console.error("CONSTRUCTED hardware refusal exit: 2");
  const falseSwap = structuredClone(control);
  falseSwap.webgl[0].probe.decision = "swap";
  if (read(falseSwap, [], "control").verdict !== "fault") throw new Error("control false swap was missed");
  const hiddenSwap = structuredClone(control);
  hiddenSwap.webgl[0].selected = choices.find((row) => row.runner === "2d").key;
  if (read(hiddenSwap, [], "control").verdict !== "fault") throw new Error("control selection swap was missed");
  const softwareDir = join(output, "software");
  mkdirSync(softwareDir);
  const softwarePage = new FixturePage(choices, { ...controlFixture,
    identification: software });
  try { await drive(softwarePage, softwareDir, choices, "control", softwarePage.sleep, softwarePage.clock); throw new Error("software control was accepted"); }
  catch (error) { if (!/hardware control refused: software/.test(error.message)) throw error; }
  if (JSON.parse(readFileSync(join(softwareDir, "observations.json"), "utf8")).webgl.length !== 0) {
    throw new Error("software identification produced a WebGL row");
  }
  const unknownDir = join(output, "unknown-control");
  mkdirSync(unknownDir);
  const unknownPage = new FixturePage(choices, { ...controlFixture, identification: still });
  try { await drive(unknownPage, unknownDir, choices, "control", unknownPage.sleep, unknownPage.clock);
    throw new Error("unknown identification was accepted"); }
  catch (error) { if (!(error instanceof HardwareRefusalError)) throw error; }
  const unknownRows = JSON.parse(readFileSync(join(unknownDir, "observations.json"), "utf8")).webgl;
  if (unknownRows.length !== 2 || unknownRows.some((row) => row.probe?.decision !== "keep")) {
    throw new Error("unknown identification did not refuse at the third WebGL choice");
  }
  const slowControlDir = join(output, "slow-control");
  mkdirSync(slowControlDir);
  const slowControlPage = new FixturePage(choices, { ...controlFixture, slowKey: choices.find((row) => row.runner === "webgl2").key });
  const slowControl = await drive(slowControlPage, slowControlDir, choices, "control", slowControlPage.sleep, slowControlPage.clock);
  const slowControlSummary = read(slowControl, [], "control");
  if (slowControlSummary.verdict !== "inconclusive" || slowControlSummary.noReading.length !== 1 ||
      slowControlSummary.webgl.filter((row) => row.decision === "keep").length !== control.webgl.length - 1) {
    throw new Error("slow control draw did not preserve the other readings");
  }
  save(join(slowControlDir, "summary.json"), slowControlSummary);
  console.log(`CONSTRUCTED PASS: ${data.webgl.length} WebGL choices not offered, ${data.twoD.length} 2D choices, GPU-less CPU pairing, executable-qualified DRM control, GPU hint and software/unknown refusals, deadline, read guards and slow control continuation`);
}

try {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "drive") {
    const [inspector, windowId, socket, workspace, output, reading = "gpu-less"] = args;
    const dryRun = args.includes("--dry-run");
    if (![inspector, windowId, socket, workspace, output].every(Boolean)) throw new Error("drive needs inspector, window, socket, workspace and output");
    if (!["gpu-less", "control"].includes(reading)) throw new Error("unknown reading mode");
    if (dryRun && reading !== "control") throw new Error("dry run needs control mode");
    await drive(new NativePage(inspector, windowId, socket, workspace, args.includes("-v")), output, catalog(), reading, delay, now, dryRun);
    if (dryRun) process.exitCode = 3;
    else console.log(reading === "control" ? "COLLECTION COMPLETE: run the control reader" : "COLLECTION COMPLETE: host CPU samples still need the reader");
  } else if (mode === "read") {
    const [output, sampleFile, reading = "gpu-less"] = args;
    if (!output || !sampleFile || !["gpu-less", "control"].includes(reading)) throw new Error("read needs observation directory, sample file and reading mode");
    const data = JSON.parse(readFileSync(join(output, "observations.json"), "utf8"));
    const raw = reading === "control" ? "" : readFileSync(sampleFile, "utf8").trim();
    const samples = reading === "control" ? [] : raw.startsWith("[") ? JSON.parse(raw) : raw.split("\n").map(JSON.parse);
    const summary = read(data, samples, reading);
    save(join(output, "summary.json"), summary);
    console.log(`VERDICT ${summary.verdict.toUpperCase()}: ${summary.failures.length} faults, ${summary.noReading.length} no readings`);
    if (summary.verdict === "fault") process.exitCode = 10;
    if (summary.verdict === "inconclusive") process.exitCode = 3;
  } else if (mode === "constructed") {
    if (!args[0]) throw new Error("constructed needs an output directory");
    await constructed(args[0]);
  } else if (mode === "constructed-refusal") {
    requireHardware({ kind: "unknown" });
  } else {
    throw new Error("usage: welcome-gpu-guard.mjs drive|read|constructed ...");
  }
} catch (error) {
  const refused = error instanceof HardwareRefusalError || error instanceof GpuHintRefusalError;
  console.error(`${refused ? "CANNOT RUN" : "INCONCLUSIVE"}: ${error.stack ?? error}`);
  process.exitCode = refused ? 2 : 3;
}
