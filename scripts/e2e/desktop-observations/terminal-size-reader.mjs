import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const sameGrid = (a, b) => a?.cols === b?.cols && a?.rows === b?.rows;
const validGrid = (a) => Number.isInteger(a?.cols) && a.cols > 0 && Number.isInteger(a?.rows) && a.rows > 0;

export function clockOffset(readings) {
  if (readings.length < 4) throw new Error("missing clock calibration");
  const lo = Math.max(...readings.map((r) => r.beforeMs - r.pageMs));
  const hi = Math.min(...readings.map((r) => r.afterMs - r.pageMs));
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi || hi - lo > 20) throw new Error("inconsistent or imprecise clocks");
  return { offsetMs: (lo + hi) / 2, uncertaintyMs: (hi - lo) / 2 };
}

// The renderer's screen box is sized in cells. Its pixels per reported cell
// and the DOM host's content box independently expose unused rows/columns.
export function fittedGrid(view) {
  if (!validGrid(view.grid) || !view.screenBox || !view.padding) throw new Error("missing renderer geometry");
  const cellWidth = view.screenBox.width / view.grid.cols;
  const cellHeight = view.screenBox.height / view.grid.rows;
  if (!(cellWidth > 0 && cellHeight > 0)) throw new Error("unmeasured renderer cells");
  const width = view.hostWidth - view.padding.left - view.padding.right - view.scrollbar;
  const height = view.hostHeight - view.padding.top - view.padding.bottom;
  return { cols: Math.max(2, Math.floor(width / cellWidth + 1e-6)),
    rows: Math.max(1, Math.floor(height / cellHeight + 1e-6)), cellWidth, cellHeight };
}

export function readSizeRun(run) {
  assert.equal(run.completed, true, "driver did not finish");
  assert.ok(run.steps.length > 0, "no layout steps");
  assert.ok(run.probe.length > 1, "probe has no liveness proof");
  assert.ok(run.probe.some((r) => r.kind === "SIGWINCH"), "no resize positive control");
  run.probe.forEach((r, i) => {
    assert.equal(r.sequence, i + 1, "missing probe event");
    assert.ok(validGrid(r), "invalid probe grid");
    if (i) assert.ok(r.monoMs >= run.probe[i - 1].monoMs, "probe clock reversed");
  });
  const pages = run.pages.map((page) => {
    assert.equal(page.overflow, false, "page record overflow");
    const clock = clockOffset(page.calibrations);
    return { ...page, clock, records: page.records.map((r) => ({ ...r, monoMs: r.pageMs + clock.offsetMs })) };
  });
  const findings = [];
  const steps = run.steps.map((step) => {
    assert.ok(step.endMs - step.settledMs >= 1900, "settled observation too short");
    assert.equal(step.geometryChanged, false, "geometry changed after settlement");
    assert.ok(step.checkpoint.monoMs >= step.checkpointBeforeMs && step.checkpoint.monoMs <= step.checkpointAfterMs,
      "probe and driver clocks disagree");
    assert.ok(step.views.length > 0, "no final page grid");
    const fits = step.views.map((view) => {
      assert.ok(view.connected && validGrid(view.grid), "renderer disconnected or unmeasured");
      assert.equal(view.backend, run.backend, "backend fell back");
      const expected = fittedGrid(view);
      if (view.visible && !sameGrid(view.grid, step.checkpoint)) findings.push({ step: step.label, kind: "pty-grid-disagreement", view, pty: step.checkpoint });
      if (view.visible && !sameGrid(view.grid, expected)) findings.push({ step: step.label, kind: "grid-does-not-fit-host", view, expected });
      return { page: view.page, visible: view.visible, grid: view.grid, expected,
        paneBox: view.paneBox, hostBox: view.hostBox, screenBox: view.screenBox };
    });
    const late = run.probe.filter((r) => r.kind === "SIGWINCH" && r.monoMs > step.settledMs && r.monoMs <= step.endMs);
    const sizes = new Set(late.map((r) => `${r.cols}x${r.rows}`));
    if (sizes.size > 1) findings.push({ step: step.label, kind: "alternating-settled-sizes", events: late });
    return { label: step.label, settledMs: step.settledMs, endMs: step.endMs, pty: step.checkpoint,
      lateSignals: late.length, fits };
  });
  for (const page of pages) for (const record of page.records) {
    if (record.kind === "resize" && record.view.name === run.name && record.view.pane && !record.view.visible) {
      findings.push({ kind: "hidden-terminal-sent-resize", page: page.name, monoMs: record.monoMs, view: record.view });
    }
  }
  // Preserve both page samples bracketing every delivered signal. An event
  // between samples is an interval observation, never an exact DOM reading.
  const resizes = run.probe.filter((r) => r.kind === "SIGWINCH").map((event) => ({
    ...event,
    pages: pages.map((page) => {
      const samples = page.records.filter((r) => r.kind === "sample");
      const before = samples.findLast((r) => r.monoMs <= event.monoMs);
      const after = samples.find((r) => r.monoMs >= event.monoMs);
      return { page: page.name, uncertaintyMs: page.clock.uncertaintyMs,
        before: before ? { monoMs: before.monoMs, views: before.views.filter((v) => v.name === run.name) } : null,
        after: after ? { monoMs: after.monoMs, views: after.views.filter((v) => v.name === run.name) } : null };
    }),
  }));
  return { verdict: findings.length ? "fault-observed" : "bounded-search-no-fault", backend: run.backend,
    engine: run.engine, cycles: run.cycles, coView: run.coView, clocks: pages.map((p) => ({ page: p.name, ...p.clock })),
    findings, steps, resizes };
}

export function preflight() {
  const view = { page: "primary", name: "probe", connected: true, visible: true, backend: "xterm",
    pane: "pane-1", grid: { cols: 80, rows: 24 }, hostWidth: 800, hostHeight: 240,
    screenBox: { width: 800, height: 240 }, padding: { left: 0, right: 0, top: 0, bottom: 0 }, scrollbar: 0 };
  const checkpoint = { sequence: 3, kind: "checkpoint", monoMs: 4000, cols: 80, rows: 24 };
  const base = { completed: true, backend: "xterm", name: "probe", cycles: 1, coView: false,
    probe: [{ sequence: 1, kind: "start", monoMs: 0, cols: 100, rows: 24 },
      { sequence: 2, kind: "SIGWINCH", monoMs: 1000, cols: 80, rows: 24 }, checkpoint],
    pages: [{ name: "primary", overflow: false, calibrations: Array.from({ length: 4 }, () => ({ beforeMs: 0, pageMs: 0, afterMs: 0.2 })),
      records: [{ kind: "sample", pageMs: 900, views: [view] }, { kind: "sample", pageMs: 1100, views: [view] }] }],
    steps: [{ label: "split", settledMs: 1500, endMs: 4000, geometryChanged: false, checkpoint,
      checkpointBeforeMs: 3999, checkpointAfterMs: 4001, views: [view] }] };
  assert.equal(readSizeRun(base).verdict, "bounded-search-no-fault");
  const cases = {
    "wrong-pty": (r) => { r.steps[0].checkpoint.cols = 79; },
    "wrong-fit": (r) => { r.steps[0].views[0].hostWidth = 900; },
    "hidden-send": (r) => { r.pages[0].records.push({ kind: "resize", pageMs: 2000, view: { ...view, visible: false } }); },
    "late-alternation": (r) => {
      r.probe.splice(2, 0, { sequence: 3, kind: "SIGWINCH", monoMs: 2000, cols: 79, rows: 24 },
        { sequence: 4, kind: "SIGWINCH", monoMs: 2200, cols: 80, rows: 24 });
      r.probe[4].sequence = 5;
    },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const run = structuredClone(base); mutate(run);
    assert.equal(readSizeRun(run).verdict, "fault-observed", name);
  }
  for (const mutate of [
    (r) => { r.completed = false; }, (r) => { r.steps[0].views = []; },
    (r) => { r.pages[0].overflow = true; }, (r) => { r.steps[0].views[0].grid = null; },
    (r) => { r.steps[0].geometryChanged = true; }, (r) => { r.probe[1].sequence = 4; },
    (r) => { r.steps[0].checkpointBeforeMs = 4001; },
    (r) => { r.pages[0].calibrations[0].beforeMs = 100; },
  ]) { const run = structuredClone(base); mutate(run); assert.throws(() => readSizeRun(run)); }
  return { control: "passed", faultCases: Object.keys(cases), refusalCases: 8 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "--preflight") console.log(JSON.stringify(preflight()));
  else {
    try {
      const result = readSizeRun(JSON.parse(readFileSync(process.argv[2], "utf8")));
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.verdict === "fault-observed" ? 10 : 0;
    } catch (error) { console.error(error.message); process.exitCode = 3; }
  }
}
