import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const sameGrid = (a, b) => a?.cols === b?.cols && a?.rows === b?.rows;
const validGrid = (a) => Number.isInteger(a?.cols) && a.cols > 0 && Number.isInteger(a?.rows) && a.rows > 0;
export const observationMs = 2100;

export function checkpointAfter(records, sequence) {
  return records.find((r) => r.sequence > sequence && r.kind === "checkpoint");
}

export function clockOffset(readings) {
  if (readings.length < 4) throw new Error("missing clock calibration");
  const lo = Math.max(...readings.map((r) => r.beforeMs - r.pageMs));
  const hi = Math.min(...readings.map((r) => r.afterMs - r.pageMs));
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi || hi - lo > 20) throw new Error("inconsistent or imprecise clocks");
  return { offsetMs: (lo + hi) / 2, uncertaintyMs: (hi - lo) / 2 };
}

// The run fixes its cell pitch at the initial visible checkpoint, before
// changing geometry. A stale sent grid cannot redefine that reference.
export function fittedGrid(view, pitch) {
  if (!validGrid(view.grid) || !view.screenBox || !view.padding) throw new Error("missing renderer geometry");
  if (!Number.isFinite(view.scrollbar) || view.scrollbar < 0) throw new Error("unmeasured scrollbar reservation");
  const { cellWidth, cellHeight } = pitch;
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
  const observed = run.observer !== false;
  if (observed) assert.ok(Number.isFinite(run.cellPitch?.cellWidth) && run.cellPitch.cellWidth > 0 &&
    Number.isFinite(run.cellPitch?.cellHeight) && run.cellPitch.cellHeight > 0, "missing reference cell pitch");
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
    assert.ok(step.endMs - step.settledMs >= observationMs, "settled observation too short");
    assert.equal(step.geometryChanged, false, "geometry changed after settlement");
    assert.ok(step.checkpoint.monoMs >= step.checkpointBeforeMs && step.checkpoint.monoMs <= step.checkpointAfterMs,
      "probe and driver clocks disagree");
    assert.ok(step.views.length > 0, "no final page grid");
    const fits = step.views.map((view) => {
      assert.ok(view.connected, "renderer disconnected");
      assert.equal(view.backend, run.backend, "backend fell back");
      const geometry = { page: view.page, visible: view.visible, grid: view.grid,
        paneBox: view.paneBox, hostBox: view.hostBox, screenBox: view.screenBox };
      if (!observed || !view.visible) return geometry;
      if (!validGrid(view.grid)) {
        findings.push({ step: step.label, kind: "shown-terminal-sent-no-grid", view });
        return geometry;
      }
      const expected = fittedGrid(view, run.cellPitch);
      if (Math.abs(view.screenBox.width / view.grid.cols - run.cellPitch.cellWidth) > 0.01 ||
          Math.abs(view.screenBox.height / view.grid.rows - run.cellPitch.cellHeight) > 0.01) {
        findings.push({ step: step.label, kind: "screen-disagrees-with-sent-grid", view, reference: run.cellPitch });
      }
      if (!sameGrid(view.grid, expected)) findings.push({ step: step.label, kind: "grid-does-not-fit-host", view, expected });
      return { page: view.page, visible: view.visible, grid: view.grid, expected,
        paneBox: view.paneBox, hostBox: view.hostBox, screenBox: view.screenBox };
    });
    // One PTY is shared by all pages: it cannot equal two different fits.
    // A stable checkpoint must match one visible participant, not all of them.
    const visible = step.views.filter((v) => v.visible);
    if (observed && visible.length && !visible.some((v) => sameGrid(v.grid, step.checkpoint))) {
      findings.push({ step: step.label, kind: "pty-grid-disagreement", views: visible, pty: step.checkpoint });
    }
    const late = run.probe.filter((r) => r.kind === "SIGWINCH" && r.monoMs > step.settledMs && r.monoMs <= step.endMs);
    const sizes = new Set(late.map((r) => `${r.cols}x${r.rows}`));
    if (late.length) findings.push({ step: step.label, kind: "resize-after-settlement", count: late.length });
    if (sizes.size > 1) findings.push({ step: step.label, kind: "alternating-settled-sizes", events: late });
    return { label: step.label, settledMs: step.settledMs, endMs: step.endMs, pty: step.checkpoint,
      lateSignals: late.length, fits, sharedPty: visible.length > 1,
      otherViewSizes: observed ? visible.filter((v) => !sameGrid(v.grid, step.checkpoint)).map((v) => ({ page: v.page, grid: v.grid })) : [] };
  });
  for (const page of pages) for (const record of page.records) {
    if (record.kind === "resize" && record.view.pane && !record.view.visible) {
      findings.push({ kind: "hidden-terminal-sent-resize", page: page.name, name: record.view.name,
        tab: record.view.tab, monoMs: record.monoMs, view: record.view });
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
    engine: run.engine, cycles: run.cycles, coView: run.coView, observer: observed, clocks: pages.map((p) => ({ page: p.name, ...p.clock })),
    findings, steps, resizes };
}

export function preflight() {
  const view = { page: "primary", name: "probe", connected: true, visible: true, backend: "xterm",
    pane: "pane-1", grid: { cols: 80, rows: 24 }, hostWidth: 800, hostHeight: 240,
    screenBox: { width: 800, height: 240 }, padding: { left: 0, right: 0, top: 0, bottom: 0 }, scrollbar: 0 };
  const checkpoint = { sequence: 3, kind: "checkpoint", monoMs: 4000, cols: 80, rows: 24 };
  const base = { completed: true, backend: "xterm", name: "probe", cycles: 1, coView: false,
    cellPitch: { cellWidth: 10, cellHeight: 10 },
    probe: [{ sequence: 1, kind: "start", monoMs: 0, cols: 100, rows: 24 },
      { sequence: 2, kind: "SIGWINCH", monoMs: 1000, cols: 80, rows: 24 }, checkpoint],
    pages: [{ name: "primary", overflow: false, calibrations: Array.from({ length: 4 }, () => ({ beforeMs: 0, pageMs: 0, afterMs: 0.2 })),
      records: [{ kind: "sample", pageMs: 900, views: [view] }, { kind: "sample", pageMs: 1100, views: [view] }] }],
    steps: [{ label: "split", settledMs: 1500, endMs: 4000, geometryChanged: false, checkpoint,
      checkpointBeforeMs: 3999, checkpointAfterMs: 4001, views: [view] }] };
  assert.equal(readSizeRun(base).verdict, "bounded-search-no-fault");
  const withScrollbar = structuredClone(base);
  withScrollbar.steps[0].views[0].hostWidth = 814;
  withScrollbar.steps[0].views[0].scrollbar = 14;
  assert.equal(readSizeRun(withScrollbar).verdict, "bounded-search-no-fault");
  withScrollbar.steps[0].views[0].scrollbar = 0;
  assert.equal(readSizeRun(withScrollbar).verdict, "fault-observed", "missing reserved gutter must be visible");
  const cases = {
    "wrong-pty": (r) => { r.steps[0].checkpoint.cols = 79; },
    "wrong-fit": (r) => { r.steps[0].views[0].hostWidth = 900; },
    "refit-without-send": (r) => { r.steps[0].views[0].hostWidth = 900; r.steps[0].views[0].screenBox.width = 900; },
    "screen-changed": (r) => { r.steps[0].views[0].screenBox.width = 900; },
    "hidden-send": (r) => { r.pages[0].records.push({ kind: "resize", pageMs: 2000, view: { ...view, visible: false } }); },
    "other-hidden-send": (r) => { r.pages[0].records.push({ kind: "resize", pageMs: 2000,
      view: { ...view, name: "anchor", tab: "term-anchor", visible: false } }); },
    "shown-without-grid": (r) => { r.steps[0].views[0].grid = null; },
    "late-alternation": (r) => {
      r.probe.splice(2, 0, { sequence: 3, kind: "SIGWINCH", monoMs: 2000, cols: 79, rows: 24 },
        { sequence: 4, kind: "SIGWINCH", monoMs: 2200, cols: 80, rows: 24 });
      r.probe[4].sequence = 5;
    },
    "one-late-signal": (r) => {
      r.probe.splice(2, 0, { sequence: 3, kind: "SIGWINCH", monoMs: 2000, cols: 80, rows: 24 });
      r.probe[3].sequence = 4;
    },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const run = structuredClone(base); mutate(run);
    const result = readSizeRun(run);
    const kind = { "wrong-pty": "pty-grid-disagreement", "wrong-fit": "grid-does-not-fit-host",
      "refit-without-send": "screen-disagrees-with-sent-grid", "screen-changed": "screen-disagrees-with-sent-grid",
      "hidden-send": "hidden-terminal-sent-resize", "other-hidden-send": "hidden-terminal-sent-resize",
      "shown-without-grid": "shown-terminal-sent-no-grid", "late-alternation": "alternating-settled-sizes",
      "one-late-signal": "resize-after-settlement" }[name];
    assert.ok(result.findings.some((f) => f.kind === kind), name);
    if (name === "other-hidden-send") assert.ok(result.findings.some((f) => f.name === "anchor" && f.tab === "term-anchor"), "hidden sender identity");
  }
  for (const mutate of [
    (r) => { r.completed = false; }, (r) => { r.steps[0].views = []; },
    (r) => { r.pages[0].overflow = true; }, (r) => { r.steps[0].views[0].connected = false; },
    (r) => { r.steps[0].geometryChanged = true; }, (r) => { r.probe[1].sequence = 4; },
    (r) => { r.steps[0].checkpointBeforeMs = 4001; },
    (r) => { r.pages[0].calibrations[0].beforeMs = 100; },
    (r) => { r.steps[0].views[0].scrollbar = null; },
    (r) => { r.steps[0].endMs = r.steps[0].settledMs + observationMs - 1; },
    (r) => { r.steps[0].views[0].backend = "ghostty"; },
    (r) => { r.probe[1].kind = "checkpoint"; },
    (r) => { r.pages[0].calibrations.forEach((c) => { c.afterMs = 21; }); },
    (r) => { r.probe[1].monoMs = -1; },
    (r) => { delete r.cellPitch; },
  ]) { const run = structuredClone(base); mutate(run); assert.throws(() => readSizeRun(run)); }
  const coView = structuredClone(base);
  coView.coView = true;
  coView.steps[0].views.push({ ...structuredClone(view), page: "second", grid: { cols: 70, rows: 24 }, hostWidth: 700, screenBox: { width: 700, height: 240 } });
  assert.equal(readSizeRun(coView).verdict, "bounded-search-no-fault", "shared PTY can follow one participant");
  coView.steps[0].checkpoint.cols = 60;
  assert.equal(readSizeRun(coView).verdict, "fault-observed", "shared PTY must match a participant");
  assert.equal(checkpointAfter([{ sequence: 3, kind: "checkpoint" }, { sequence: 4, kind: "SIGWINCH" }], 2)?.sequence, 3);
  assert.equal(checkpointAfter([{ sequence: 3, kind: "SIGWINCH" }, { sequence: 4, kind: "checkpoint" }], 2)?.sequence, 4, "checkpoint kind");
  assert.equal(checkpointAfter([{ sequence: 3, kind: "checkpoint" }], 3), undefined);
  const hidden = structuredClone(base);
  hidden.steps[0].views[0].visible = false;
  hidden.steps[0].views[0].grid = { cols: 70, rows: 20 };
  assert.equal(readSizeRun(hidden).verdict, "bounded-search-no-fault", "hidden stale grid is not judged");
  hidden.steps[0].views.push({ ...structuredClone(view), page: "second", visible: false });
  hidden.coView = true;
  assert.equal(readSizeRun(hidden).verdict, "bounded-search-no-fault", "two hidden grids are not judged");
  hidden.steps[0].views[0].grid = null;
  assert.equal(readSizeRun(hidden).verdict, "bounded-search-no-fault", "hidden absent grid is not judged");
  const unobserved = structuredClone(base);
  unobserved.observer = false;
  unobserved.steps[0].views[0].grid = null;
  assert.equal(readSizeRun(unobserved).verdict, "bounded-search-no-fault");
  cases["one-late-signal"](unobserved);
  assert.equal(readSizeRun(unobserved).verdict, "fault-observed", "PTY-only arm detects late signals");
  return { control: "passed", scrollbarControl: "passed", coViewControl: "passed", checkpointControl: "passed",
    unobservedControl: "passed", hiddenControl: "passed", faultCases: Object.keys(cases), refusalCases: 15 };
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
