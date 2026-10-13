import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const sameGrid = (a, b) => a?.cols === b?.cols && a?.rows === b?.rows;
const validGrid = (a) => Number.isInteger(a?.cols) && a.cols > 0 && Number.isInteger(a?.rows) && a.rows > 0;
export const observationMs = 2100;
// Chrome's page clock in these runs advances in 0.1 ms steps. Keep a full
// step on either edge rather than assuming which way the clock rounds.
export const pageClockStepMs = 0.1;

export function checkpointAfter(records, sequence) {
  return records.find((r) => r.sequence > sequence && r.kind === "checkpoint");
}

export function clockOffset(readings) {
  if (readings.length < 4) throw new Error("missing clock calibration");
  const lo = Math.max(...readings.map((r) => r.beforeMs - r.pageMs - pageClockStepMs));
  const hi = Math.min(...readings.map((r) => r.afterMs - r.pageMs + pageClockStepMs));
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi || hi - lo > 20) throw new Error("inconsistent or imprecise clocks");
  return { offsetMs: (lo + hi) / 2, uncertaintyMs: (hi - lo) / 2, pageClockStepMs };
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

export function readFrameSurface(tabId, root = document, escape = CSS.escape) {
  const tab = root.querySelector(`[data-terminal-tab-id="${escape(tabId)}"]`);
  const rows = [...(tab?.querySelectorAll(".xterm-rows > div") ?? [])].map((row) => row.textContent ?? "");
  if (rows.some(Boolean)) return { kind: "xterm-dom", rowCount: rows.length,
    first: rows[0] ?? "", last: rows.at(-1) ?? "" };
  return { kind: tab?.querySelector("canvas") ? "canvas" : "unavailable" };
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
  const redraws = run.fullScreen ? run.probe.filter((r) => r.kind === "redraw") : [];
  if (run.fullScreen) {
    assert.equal(observed, true, "full-screen arm needs the page grid");
    assert.equal(run.coView, false, "full-screen arm needs one page");
    assert.ok(redraws.length > 0, "full-screen probe has no redraw");
    redraws.forEach((r, i) => assert.equal(r.redrawCount, i + 1, "missing redraw record"));
    run.probe.forEach((r, i) => {
      if (r.kind !== "start" && r.kind !== "SIGWINCH") return;
      const next = run.probe[i + 1];
      assert.equal(next?.kind, "redraw", "size event has no redraw");
      assert.equal(next.trigger, r.kind, "redraw trigger differs from size event");
    });
  }
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
    const lastRedraw = run.fullScreen && visible.length
      ? redraws.findLast((r) => r.sequence < step.checkpoint.sequence) : null;
    if (run.fullScreen && visible.length && (!lastRedraw || !sameGrid(lastRedraw, step.checkpoint) ||
        visible.some((v) => !sameGrid(lastRedraw, v.grid)))) {
      findings.push({ step: step.label, kind: "full-screen-stale-redraw", redraw: lastRedraw,
        pty: step.checkpoint, grids: visible.map((v) => ({ page: v.page, grid: v.grid })) });
    }
    const frameSurfaces = [];
    if (run.fullScreen && visible.length) {
      assert.equal(step.frameSurfaces?.length, run.pages.length, "missing frame surface reading");
    }
    if (run.fullScreen) for (const surface of step.frameSurfaces ?? []) {
      const view = visible.find((v) => v.page === surface.page);
      if (!view) continue;
      const readable = surface.kind === "xterm-dom" && surface.rowCount === view.grid?.rows &&
        surface.first.length >= view.grid.cols && surface.last.length >= view.grid.cols;
      const farCorners = readable ? surface.first[view.grid.cols - 1] === "+" &&
        surface.last[view.grid.cols - 1] === "+" : null;
      if (readable && !farCorners) findings.push({ step: step.label, kind: "full-screen-far-corner-missing",
        page: surface.page, surface });
      frameSurfaces.push({ page: surface.page, kind: surface.kind, readable, farCorners });
    }
    const late = run.probe.filter((r) => r.kind === "SIGWINCH" && r.monoMs > step.settledMs && r.monoMs <= step.endMs);
    const sizes = new Set(late.map((r) => `${r.cols}x${r.rows}`));
    if (late.length) findings.push({ step: step.label, kind: "resize-after-settlement", count: late.length });
    if (sizes.size > 1) findings.push({ step: step.label, kind: "alternating-settled-sizes", events: late });
    const lateRedraws = redraws.filter((r) => r.monoMs > step.settledMs && r.monoMs <= step.endMs);
    if (lateRedraws.length) findings.push({ step: step.label, kind: "redraw-after-settlement", count: lateRedraws.length });
    return { label: step.label, settledMs: step.settledMs, endMs: step.endMs, pty: step.checkpoint,
      lateSignals: late.length, lateRedraws: lateRedraws.length, redraw: lastRedraw, frameSurfaces,
      fits, sharedPty: visible.length > 1,
      otherViewSizes: observed ? visible.filter((v) => !sameGrid(v.grid, step.checkpoint)).map((v) => ({ page: v.page, grid: v.grid })) : [] };
  });
  const unjudgedHiddenDialWidths = [];
  for (const page of pages) for (const record of page.records) {
    if (record.kind === "resize" && !record.view.visible) {
      findings.push({ kind: "hidden-terminal-sent-resize", page: page.name, name: record.view.name,
        tab: record.view.tab, monoMs: record.monoMs, view: record.view });
    }
    if (record.kind !== "attach" || record.view.visible || !validGrid(record.view.grid)) continue;
    if (record.view.sizeIfUnset === false) {
      findings.push({ kind: "hidden-terminal-dialed-unconditionally", page: page.name, name: record.view.name,
        tab: record.view.tab, monoMs: record.monoMs, view: record.view });
    }
    if (record.view.name !== run.name) continue;
    const prior = run.probe.findLast((r) => r.monoMs < record.monoMs - page.clock.uncertaintyMs);
    if (prior?.cols === record.view.grid.cols || (!prior && !record.view.session)) {
      unjudgedHiddenDialWidths.push({ page: page.name, name: record.view.name, tab: record.view.tab,
        monoMs: record.monoMs, width: record.view.grid.cols, priorSequence: prior?.sequence,
        reason: prior ? "already-recorded-width" : "fresh-birth-without-prior" });
      continue;
    }
    const end = page.records.find((r) => r.pageMs > record.pageMs && r.view?.socket === record.view.socket &&
      (r.kind === "close" || (r.kind === "resize" && r.view.visible)));
    // Use the clock's whole uncertainty interval to establish order. The
    // width match is an observation, not attribution of a signal's cause.
    const signals = run.probe.filter((r) => r.kind === "SIGWINCH" && r.cols === record.view.grid.cols &&
      r.monoMs > record.monoMs + page.clock.uncertaintyMs &&
      (!end || r.monoMs < end.monoMs - page.clock.uncertaintyMs));
    if (signals.length) {
      findings.push({ kind: "pty-took-hidden-dial-width", page: page.name, name: record.view.name,
        tab: record.view.tab, view: record.view, monoMs: record.monoMs, priorSequence: prior?.sequence ?? null, signals });
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
    engine: run.engine, cycles: run.cycles, coView: run.coView, observer: observed, fullScreen: run.fullScreen === true,
    redrawCount: redraws.length, clocks: pages.map((p) => ({ page: p.name, ...p.clock })),
    unmeasuredHiddenDialQualifiers: pages.flatMap((p) => p.records.filter((r) => r.kind === "attach" &&
      !r.view.visible && validGrid(r.view.grid) && typeof r.view.sizeIfUnset !== "boolean")
      .map((r) => ({ page: p.name, tab: r.view.tab, monoMs: r.monoMs }))),
    unjudgedHiddenDialWidths, findings, steps, resizes };
}

export function staleFullScreenRun() {
  const view = { page: "primary", name: "probe", connected: true, visible: true, backend: "xterm",
    pane: "pane-1", tab: "term-probe", socket: 1, sizeIfUnset: false,
    grid: { cols: 80, rows: 24 }, hostWidth: 800, hostHeight: 240,
    screenBox: { width: 800, height: 240 }, padding: { left: 0, right: 0, top: 0, bottom: 0 }, scrollbar: 0 };
  const checkpoint = { sequence: 5, kind: "checkpoint", monoMs: 4000, cols: 80, rows: 24 };
  return { completed: true, backend: "xterm", name: "probe", cycles: 1, coView: false, observer: true, fullScreen: true,
    cellPitch: { cellWidth: 10, cellHeight: 10 },
    probe: [{ sequence: 1, kind: "start", monoMs: 0, cols: 100, rows: 24 },
      { sequence: 2, kind: "redraw", monoMs: 1, cols: 100, rows: 24, redrawCount: 1, trigger: "start" },
      { sequence: 3, kind: "SIGWINCH", monoMs: 1000, cols: 80, rows: 24 },
      { sequence: 4, kind: "redraw", monoMs: 1001, cols: 79, rows: 24, redrawCount: 2, trigger: "SIGWINCH" }, checkpoint],
    pages: [{ name: "primary", overflow: false,
      calibrations: Array.from({ length: 4 }, () => ({ beforeMs: 0, pageMs: 0, afterMs: 0.2 })),
      records: [{ kind: "sample", pageMs: 900, views: [view] }, { kind: "sample", pageMs: 1100, views: [view] }] }],
    steps: [{ label: "split", settledMs: 1500, endMs: 4000, geometryChanged: false, checkpoint,
      checkpointBeforeMs: 3999, checkpointAfterMs: 4001, views: [view], frameSurfaces: [{ page: "primary", kind: "canvas" }] }] };
}

export function preflight() {
  const view = { page: "primary", name: "probe", connected: true, visible: true, backend: "xterm",
    pane: "pane-1", tab: "term-probe", socket: 1, sizeIfUnset: false,
    grid: { cols: 80, rows: 24 }, hostWidth: 800, hostHeight: 240,
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
  const fullScreenStale = staleFullScreenRun();
  assert.ok(readSizeRun(fullScreenStale).findings.some((f) => f.kind === "full-screen-stale-redraw"),
    "full-screen stale redraw at a shown checkpoint");
  fullScreenStale.probe[3].cols = 80;
  assert.equal(readSizeRun(fullScreenStale).verdict, "bounded-search-no-fault", "matching full-screen redraw");
  const laterCorrectRedraw = staleFullScreenRun();
  laterCorrectRedraw.probe.push({ sequence: 6, kind: "SIGWINCH", monoMs: 4100, cols: 80, rows: 24 },
    { sequence: 7, kind: "redraw", monoMs: 4101, cols: 80, rows: 24, redrawCount: 3, trigger: "SIGWINCH" });
  assert.ok(readSizeRun(laterCorrectRedraw).findings.some((f) => f.kind === "full-screen-stale-redraw"),
    "full-screen redraw after checkpoint cannot replace stale frame");
  const redrawDiffersFromPty = structuredClone(fullScreenStale);
  redrawDiffersFromPty.steps[0].checkpoint.cols = 79;
  assert.ok(readSizeRun(redrawDiffersFromPty).findings.some((f) => f.kind === "full-screen-stale-redraw"),
    "full-screen redraw must match PTY size");
  const redrawDiffersFromPage = structuredClone(fullScreenStale);
  redrawDiffersFromPage.steps[0].views[0].grid.cols = 79;
  redrawDiffersFromPage.steps[0].views[0].hostWidth = 790;
  redrawDiffersFromPage.steps[0].views[0].screenBox.width = 790;
  assert.ok(readSizeRun(redrawDiffersFromPage).findings.some((f) => f.kind === "full-screen-stale-redraw"),
    "full-screen redraw must match page grid");
  const lateRedraw = structuredClone(fullScreenStale);
  lateRedraw.probe[3].monoMs = 2000;
  assert.ok(readSizeRun(lateRedraw).findings.some((f) => f.kind === "redraw-after-settlement"),
    "full-screen redraw after settlement");
  const noSizeRedraw = structuredClone(fullScreenStale);
  noSizeRedraw.probe.splice(3, 1);
  noSizeRedraw.probe[3].sequence = 4;
  noSizeRedraw.steps[0].checkpoint = noSizeRedraw.probe[3];
  assert.throws(() => readSizeRun(noSizeRedraw), /size event has no redraw/,
    "full-screen size event without redraw is refused");
  const missingRedrawRecord = structuredClone(fullScreenStale);
  missingRedrawRecord.probe[3].redrawCount = 3;
  assert.throws(() => readSizeRun(missingRedrawRecord), /missing redraw record/,
    "full-screen missing redraw record is refused");
  const border = `+${"-".repeat(78)}+`;
  const domRows = Array.from({ length: 24 }, (_, i) => ({ textContent: i === 0 || i === 23 ? border : "" }));
  const domTab = { querySelectorAll: () => domRows, querySelector: () => null };
  const domRoot = { querySelector: (selector) => {
    assert.equal(selector, '[data-terminal-tab-id="term-probe"]', "xterm DOM tab identity");
    return domTab;
  } };
  const domCorners = structuredClone(fullScreenStale);
  domCorners.steps[0].frameSurfaces[0] = { page: "primary", ...readFrameSurface("term-probe", domRoot, (s) => s) };
  assert.equal(readSizeRun(domCorners).steps[0].frameSurfaces[0].farCorners, true,
    "xterm DOM far corners are readable");
  domRows[23].textContent = `${border.slice(0, -1)} `;
  const domMissingCorner = structuredClone(domCorners);
  domMissingCorner.steps[0].frameSurfaces[0] = { page: "primary", ...readFrameSurface("term-probe", domRoot, (s) => s) };
  assert.ok(readSizeRun(domMissingCorner).findings.some((f) => f.kind === "full-screen-far-corner-missing"),
    "xterm DOM missing far corner");
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
    "detached-send": (r) => { r.pages[0].records.push({ kind: "resize", pageMs: 2000,
      view: { ...view, pane: null, visible: false } }); },
    "hidden-unconditional-dial": (r) => { r.pages[0].records.unshift({ kind: "attach", pageMs: 800,
      view: { ...view, name: "anchor", tab: "term-anchor", visible: false } }); },
    "hidden-dial-width": (r) => { r.pages[0].records.unshift({ kind: "attach", pageMs: 800,
      view: { ...view, visible: false, sizeIfUnset: true } }); },
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
      "detached-send": "hidden-terminal-sent-resize", "hidden-unconditional-dial": "hidden-terminal-dialed-unconditionally",
      "hidden-dial-width": "pty-took-hidden-dial-width",
      "shown-without-grid": "shown-terminal-sent-no-grid", "late-alternation": "alternating-settled-sizes",
      "one-late-signal": "resize-after-settlement" }[name];
    assert.ok(result.findings.some((f) => f.kind === kind), name);
    if (name === "other-hidden-send") assert.ok(result.findings.some((f) => f.name === "anchor" && f.tab === "term-anchor"), "hidden sender identity");
    if (name === "hidden-unconditional-dial") assert.ok(result.findings.some((f) => f.kind === kind &&
      f.name === "anchor" && f.tab === "term-anchor"), "hidden dial identity");
  }
  const conditional = structuredClone(base);
  cases["hidden-dial-width"](conditional);
  conditional.pages[0].records[0].view.grid = { cols: 70, rows: 24 };
  assert.equal(readSizeRun(conditional).verdict, "bounded-search-no-fault", "conditional hidden dial not applied");
  const historical = structuredClone(conditional);
  delete historical.pages[0].records[0].view.sizeIfUnset;
  assert.equal(readSizeRun(historical).verdict, "bounded-search-no-fault", "old dial qualifier is unknown");
  assert.equal(readSizeRun(historical).unmeasuredHiddenDialQualifiers.length, 1, "unknown qualifier is reported");
  conditional.pages[0].records[0].view.grid.cols = 80;
  conditional.pages[0].records.splice(1, 0, { kind: "resize", pageMs: 850, view });
  assert.equal(readSizeRun(conditional).verdict, "bounded-search-no-fault", "shown publication ends hidden dial reading");
  conditional.pages[0].records[1] = { kind: "close", pageMs: 850, view };
  assert.equal(readSizeRun(conditional).verdict, "bounded-search-no-fault", "closed socket ends hidden dial reading");
  const equalWidth = structuredClone(base);
  equalWidth.probe[0].cols = 80;
  cases["hidden-dial-width"](equalWidth);
  const equalWidthResult = readSizeRun(equalWidth);
  assert.equal(equalWidthResult.verdict, "bounded-search-no-fault", "equal-width hidden dial is unjudged");
  assert.equal(equalWidthResult.unjudgedHiddenDialWidths.length, 1, "equal-width hidden dial is reported unjudged");
  const birth = structuredClone(base);
  birth.probe = [{ sequence: 1, kind: "start", monoMs: 850, cols: 195, rows: 44 },
    { sequence: 2, kind: "SIGWINCH", monoMs: 950, cols: 195, rows: 43 },
    { sequence: 3, kind: "SIGWINCH", monoMs: 1100, cols: 195, rows: 44 },
    { sequence: 4, kind: "checkpoint", monoMs: 4000, cols: 195, rows: 44 }];
  birth.steps[0].checkpoint = birth.probe[3];
  birth.steps[0].views[0].visible = false;
  birth.pages[0].records = [{ kind: "attach", pageMs: 800,
    view: { ...view, visible: false, session: null, grid: { cols: 195, rows: 44 }, sizeIfUnset: true } },
    { kind: "sample", pageMs: 1200, views: [] }];
  const birthResult = readSizeRun(birth);
  assert.equal(birthResult.verdict, "bounded-search-no-fault", "fresh hidden birth is not a width fault");
  assert.equal(birthResult.unjudgedHiddenDialWidths.length, 1, "fresh hidden birth is reported unjudged");
  assert.equal(birthResult.unjudgedHiddenDialWidths[0].reason, "fresh-birth-without-prior");
  const reattach = structuredClone(birth);
  reattach.pages[0].records[0].view.session = "existing-session";
  assert.ok(readSizeRun(reattach).findings.some((f) => f.kind === "pty-took-hidden-dial-width" && f.priorSequence === null),
    "missing-history reattach still reads the signal");
  const lastPrior = structuredClone(base);
  lastPrior.probe.splice(2, 0, { sequence: 3, kind: "SIGWINCH", monoMs: 1200, cols: 100, rows: 24 });
  lastPrior.probe[3].sequence = 4;
  lastPrior.probe[3].cols = 100;
  lastPrior.steps[0].checkpoint = lastPrior.probe[3];
  lastPrior.steps[0].views[0].visible = false;
  lastPrior.pages[0].records.unshift({ kind: "attach", pageMs: 1100,
    view: { ...view, visible: false, session: "existing-session", grid: { cols: 100, rows: 24 }, sizeIfUnset: true } });
  assert.ok(readSizeRun(lastPrior).findings.some((f) => f.kind === "pty-took-hidden-dial-width"),
    "last prior width: the earlier candidate width does not mask a later take");
  const otherSocket = structuredClone(base);
  cases["hidden-dial-width"](otherSocket);
  otherSocket.pages[0].records.splice(1, 0, { kind: "resize", pageMs: 850,
    view: { ...view, socket: 2 } });
  assert.ok(readSizeRun(otherSocket).findings.some((f) => f.kind === "pty-took-hidden-dial-width"),
    "socket: another socket's frame does not end the width window");
  const hiddenFrame = structuredClone(base);
  cases["hidden-dial-width"](hiddenFrame);
  hiddenFrame.pages[0].records.splice(1, 0, { kind: "resize", pageMs: 850,
    view: { ...view, visible: false } });
  assert.ok(readSizeRun(hiddenFrame).findings.some((f) => f.kind === "pty-took-hidden-dial-width"),
    "end-any-frame: a hidden frame does not end the width window");
  const earlySignal = structuredClone(base);
  earlySignal.probe.splice(1, 0, { sequence: 2, kind: "SIGWINCH", monoMs: 700, cols: 100, rows: 24 });
  earlySignal.probe[2].sequence = 3;
  earlySignal.probe[3].sequence = 4;
  earlySignal.steps[0].checkpoint.sequence = 4;
  cases["hidden-dial-width"](earlySignal);
  earlySignal.pages[0].records[0].pageMs = 1100;
  earlySignal.pages[0].records[0].view.grid = { cols: 100, rows: 24 };
  assert.ok(!readSizeRun(earlySignal).findings.some((f) => f.kind === "pty-took-hidden-dial-width"),
    "lower-bound: a signal before the dial does not count");
  const noGrid = structuredClone(base);
  cases["hidden-dial-width"](noGrid);
  noGrid.pages[0].records[0].view.grid = null;
  assert.doesNotThrow(() => assert.ok(!readSizeRun(noGrid).findings.some((f) => f.kind === "pty-took-hidden-dial-width")),
    "no-grid: a hidden dial without a grid is unjudged");
  const quantized = structuredClone(base);
  quantized.pages[0].calibrations = [0, 0.05, 0, 0.05].map((beforeMs) => ({ beforeMs, pageMs: 0, afterMs: beforeMs + 0.01 }));
  assert.doesNotThrow(() => assert.equal(readSizeRun(quantized).verdict, "bounded-search-no-fault"),
    "clock step permits narrow disjoint brackets");
  assert.equal(clockOffset(base.pages[0].calibrations).uncertaintyMs, 0.2, "clock uncertainty includes page step");
  quantized.pages[0].calibrations[1] = { beforeMs: 0.4, pageMs: 0, afterMs: 0.41 };
  let refusalCases = 0;
  assert.throws(() => readSizeRun(quantized), /inconsistent or imprecise clocks/, "clock disjoint beyond page step");
  refusalCases++;
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
  ]) { const run = structuredClone(base); mutate(run); assert.throws(() => readSizeRun(run)); refusalCases++; }
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
    unobservedControl: "passed", hiddenControl: "passed", hiddenDialControl: "passed", clockStepControl: "passed",
    faultCases: Object.keys(cases), hiddenDialConjuncts: ["socket", "end-any-frame", "lower-bound", "no-grid"],
    equalWidthControl: "passed", hiddenDialGuardRows: 3, fullScreenStaleRows: 4, fullScreenReviewRows: 6,
    domCornerRows: 2, refusalCases };
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
