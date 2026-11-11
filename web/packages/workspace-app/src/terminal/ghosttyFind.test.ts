// @vitest-environment jsdom
//
// GhosttyFind over the binding's terminal on the vendored core, ghostty-web's
// own SelectionManager and chan's viewport controller. The viewport is a
// stand-in with ghostty-web's semantics (an offset of lines scrolled back from
// the bottom, clamped to the history, back to 0 after a write; a resize that
// hands the core the new grid, fires the resize event and repaints), and
// frames run and the clock moves only when a case says so. The scan budget
// is 0, one unit of the core's work per frame, so a scan's progress is the
// same on any machine. Find times its feeds on the same clock, so a feed
// costs nothing unless a case makes it move during one.

import { readFileSync } from "node:fs";
import { SelectionManager, type Terminal } from "ghostty-web";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { FIND_COST_PRIORS, FIND_FRAME_BUDGET_MS, FIND_SCAN_BUDGET_MS, FIND_WAIT_CAP_MS, type FindCount, type FrameScheduler, GhosttyFind } from "./ghosttyFind";
import { GhosttyViewportController } from "./ghosttyViewport";
import { GhosttyVt, type MatchRange, type VtSearch, VtTerminal } from "./ghosttyVt";
import { SCROLLBACK_MB_DEFAULT, scrollbackLinesFromMb } from "./scrollback";

const VENDORED = "vendor/ghostty-vt/ghostty-vt.wasm";

let vendored: WebAssembly.Module;

beforeAll(async () => {
  vendored = await WebAssembly.compile(readFileSync(VENDORED));
});

type Anchor = { col: number; absoluteRow: number };

/// The selection manager's members a case reads and sets.
type Manager = {
  selectionStart: Anchor | null;
  selectionEnd: Anchor | null;
  getDirtySelectionRows(): Set<number>;
};

/// Frames that run only when a case runs them.
function manualFrames() {
  const queue = new Map<number, () => void>();
  let next = 1;
  const frames: FrameScheduler & { pending(): number; frame(): void; settle(): number } = {
    request(run) {
      const id = next++;
      queue.set(id, run);
      return id;
    },
    cancel(id) {
      queue.delete(id);
    },
    pending: () => queue.size,
    /// Runs the frames requested so far.
    frame() {
      const runs = [...queue.values()];
      queue.clear();
      for (const run of runs) run();
    },
    /// Runs frames until none is requested; returns how many ran.
    settle() {
      let ran = 0;
      while (queue.size) {
        if (++ran > 10_000) throw new Error("find never stopped requesting frames");
        frames.frame();
      }
      return ran;
    },
  };
  return frames;
}

/// A clock in milliseconds that moves only when a case moves it.
function manualClock() {
  let at = 0;
  return {
    now: () => at,
    set(ms: number) {
      at = ms;
    },
  };
}

async function fixture(lines: string[], { cols = 40, rows = 10, scrollbackLimit = 10_000, budgetMs = 0 } = {}) {
  const vt = new GhosttyVt(await WebAssembly.instantiate(vendored, {}));
  const core = vt.createTerminal(cols, rows, { scrollbackLimit }) as unknown as VtTerminal;
  if (lines.length) core.write(lines.map((line) => `${line}\r\n`).join(""));
  const clamp = (y: number) => Math.max(0, Math.min(core.getScrollbackLength(), y));
  const resizeListeners = new Set<(size: { cols: number; rows: number }) => void>();
  /// The selection each resize's repaint drew.
  const painted: Array<MatchRange | null> = [];
  const view = {
    cols,
    rows,
    viewportY: 0,
    getViewportY: () => view.viewportY,
    getScrollbackLength: () => core.getScrollbackLength(),
    scrollLines(amount: number) {
      view.viewportY = clamp(view.viewportY - amount);
    },
    scrollToLine(line: number) {
      view.viewportY = clamp(line);
    },
    write(data: string | Uint8Array) {
      core.write(data);
      view.viewportY = 0;
    },
    onResize(listener: (size: { cols: number; rows: number }) => void) {
      resizeListeners.add(listener);
      return { dispose: () => resizeListeners.delete(listener) };
    },
    /// ghostty-web's resize: the core takes the grid, the event fires, and
    /// the whole grid is repainted with the selection held then. The
    /// viewport offset stays as it was.
    resize(newCols: number, newRows: number) {
      if (newCols === view.cols && newRows === view.rows) return;
      view.cols = newCols;
      view.rows = newRows;
      core.resize(newCols, newRows);
      for (const listener of resizeListeners) listener({ cols: newCols, rows: newRows });
      painted.push(selected(manager as unknown as Manager));
    },
  };
  const viewport = new GhosttyViewportController(view, {
    os: () => "linux",
    hasMouseTracking: () => false,
    isAlternateScreen: () => core.isAlternateScreen(),
    cellHeight: () => 16,
  });
  const canvas = document.createElement("canvas");
  const renderer = { getCanvas: () => canvas, getMetrics: () => ({ width: 8, height: 16, baseline: 12 }) };
  const manager = new SelectionManager(
    view as unknown as Terminal,
    renderer as unknown as ConstructorParameters<typeof SelectionManager>[1],
    core as unknown as ConstructorParameters<typeof SelectionManager>[2],
    document.createElement("textarea"),
  );
  const frames = manualFrames();
  const clock = manualClock();
  const counts: FindCount[] = [];
  const created: VtSearch[] = [];
  const createSearch = core.createSearch.bind(core);
  vi.spyOn(core, "createSearch").mockImplementation(() => {
    const search = createSearch();
    created.push(search);
    return search;
  });
  const find = new GhosttyFind(core, {
    viewport,
    selection: manager as unknown as ConstructorParameters<typeof GhosttyFind>[1]["selection"],
    onCount: (count) => counts.push(count),
    frames,
    budgetMs,
    clock: clock.now,
  });
  return { core, view, viewport, manager: manager as unknown as Manager, frames, clock, counts, created, find, painted };
}

/// The selection as a match range, null when nothing is selected.
function selected(manager: Manager): MatchRange | null {
  const start = manager.selectionStart;
  const end = manager.selectionEnd;
  if (!start || !end) return null;
  return { startRow: start.absoluteRow, startCol: start.col, endRow: end.absoluteRow, endCol: end.col };
}

const range = (startRow: number, startCol: number, endRow: number, endCol: number): MatchRange => ({
  startRow,
  startCol,
  endRow,
  endCol,
});

/// `line <i>` on every line, each with a needle when `needle(i)` says so: row
/// i of the buffer holds line i, and a needle after `line <i> ` starts at the
/// column after that prefix.
function numbered(n: number, needle: (i: number) => boolean = () => false): string[] {
  return Array.from({ length: n }, (_, i) => `line <${i}>${needle(i) ? " needle" : ""}`);
}
const needleAt = (row: number) => range(row, `line <${row}> `.length, row, `line <${row}> `.length + 5);

/// Six rows on a ten-row screen: needles on rows 1, 3 and 5, no history.
const SHORT = ["a", "needle b", "c", "needle d", "e", "needle f"];
const SHORT_MATCH = (row: number) => range(row, 0, row, 5);

// A needle on every line ending in 5 of 3,000: 300 matches, the newest on
// row 2995 and the oldest on row 5. One unit of the core's scan a frame
// leaves the first frames with the newest matches only, and the core wraps
// among those.
const LONG = numbered(3000, (i) => i % 10 === 5);
/// The k-th match from the newest, counting from 1 as the bar does.
const nth = (k: number) => needleAt(2995 - 10 * (k - 1));

/// A needle on row 0 and on row 900 of a thousand-line history on an 80x5
/// screen, the newer one selected.
async function prunable() {
  const lines = ["early needle", ...Array.from({ length: 899 }, (_, i) => `filler ${i} ${"x".repeat(40)}`), "late needle"];
  const f = await fixture(lines, { cols: 80, rows: 5, scrollbackLimit: 1000 });
  f.find.find("needle");
  f.frames.settle();
  expect(selected(f.manager)).toEqual(range(900, 5, 900, 10));
  return f;
}

/// Writes lines until the core prunes history; returns how many rows went.
function prune(core: VtTerminal, viewport: GhosttyViewportController): number {
  const before = core.getScrollbackLength();
  let added = 0;
  for (let last = before; ; ) {
    viewport.write(`filler ${added} ${"y".repeat(40)}\r\n`);
    added++;
    const now = core.getScrollbackLength();
    if (now < last) break;
    last = now;
    if (added > 5000) throw new Error("the history was never pruned");
  }
  const pruned = before + added - core.getScrollbackLength();
  expect(pruned).toBeGreaterThan(0);
  return pruned;
}

describe("a query", () => {
  test("selects its newest match on the first frame that finds one and counts on until the scan ends", async () => {
    const { manager, frames, counts, find, view } = await fixture(numbered(3000, (i) => i % 10 === 5));
    find.find("needle");
    expect(counts, "nothing is read before a frame").toEqual([]);

    frames.frame();
    expect(selected(manager)).toEqual(needleAt(2995));
    const first = counts.at(-1)!;
    expect(first).toMatchObject({ index: 1, partial: true });
    expect(first.total).toBeGreaterThan(0);
    expect(first.total).toBeLessThan(300);
    expect(frames.pending(), "the scan goes on").toBe(1);

    expect(frames.settle()).toBeGreaterThan(1);
    expect(counts.at(-1)).toEqual({ index: 1, total: 300, partial: false });
    expect(selected(manager), "the selection stays on the newest match").toEqual(needleAt(2995));
    // On the screen already: rows 2991 to 3000 are in view.
    expect(view.viewportY).toBe(0);
  });

  test("with no match reads 0 of 0, with a plus while the scan runs", async () => {
    const { frames, counts, find, manager } = await fixture(numbered(3000));
    find.find("absent");
    frames.frame();
    expect(counts.at(-1)).toEqual({ index: 0, total: 0, partial: true });
    frames.settle();
    expect(counts.at(-1)).toEqual({ index: 0, total: 0, partial: false });
    expect(selected(manager)).toBeNull();
  });

  test("a changed query drops the old highlight and selects the new query's newest match", async () => {
    const { frames, find, manager, counts } = await fixture(["alpha one", "beta", "alpha two", "gamma"]);
    find.find("alpha");
    frames.settle();
    expect(selected(manager)).toEqual(range(2, 0, 2, 4));
    find.find("beta");
    frames.settle();
    expect(selected(manager)).toEqual(range(1, 0, 1, 3));
    expect(counts.at(-1)).toEqual({ index: 1, total: 1, partial: false });
    find.find("delta");
    frames.settle();
    expect(selected(manager), "no match, no highlight").toBeNull();
    expect(counts.at(-1)).toEqual({ index: 0, total: 0, partial: false });
  });

  test("a needle across a soft wrap is selected over both rows", async () => {
    const { frames, find, manager } = await fixture(["x".repeat(17) + "needle"], { cols: 20 });
    find.find("needle");
    frames.settle();
    expect(selected(manager)).toEqual(range(0, 17, 1, 2));
  });
});

describe("a step", () => {
  test("walks to older matches and back to newer ones, both wrapping", async () => {
    const { frames, find, manager, counts } = await fixture(SHORT);
    find.find("needle");
    frames.settle();
    const walk: Array<[number | null, MatchRange | null]> = [[counts.at(-1)!.index, selected(manager)]];
    for (const direction of ["older", "older", "older", "newer", "newer"] as const) {
      find.step("needle", direction);
      walk.push([counts.at(-1)!.index, selected(manager)]);
    }
    expect(walk).toEqual([
      [1, SHORT_MATCH(5)],
      [2, SHORT_MATCH(3)],
      [3, SHORT_MATCH(1)],
      [1, SHORT_MATCH(5)],
      [3, SHORT_MATCH(1)],
      [2, SHORT_MATCH(3)],
    ]);
    expect(counts.at(-1)!.total).toBe(3);
  });

  test("with another query searches for it first and lands on its newest match", async () => {
    // As after the bar reopens with the query it kept.
    const { find, manager, counts } = await fixture(SHORT);
    find.step("needle", "older");
    expect(selected(manager)).toEqual(SHORT_MATCH(5));
    expect(counts.at(-1)).toMatchObject({ index: 1 });
  });

  test("marks the rows of the highlight it moves for repaint", async () => {
    // At the bottom of the buffer ghostty-web repaints only rows marked so.
    const { frames, find, manager } = await fixture(SHORT);
    find.find("needle");
    frames.settle();
    manager.getDirtySelectionRows().clear();
    find.step("needle", "older");
    expect(selected(manager)).toEqual(SHORT_MATCH(3));
    expect([...manager.getDirtySelectionRows()]).toContain(5);
  });
});

describe("a step while the scan runs", () => {
  test("Shift+Enter right after the bar reopens waits for the scan and lands on the oldest match", async () => {
    const { frames, find, manager, counts } = await fixture(LONG);
    find.find("needle");
    frames.settle();
    find.step("needle", "older");
    find.close();
    const seen = counts.length;

    // The reopened bar keeps its query, and Shift+Enter is its first step.
    find.step("needle", "newer");
    expect(selected(manager), "no match before the scan completes").toBeNull();
    const shown: Array<MatchRange | null> = [];
    while (frames.pending()) {
      frames.frame();
      shown.push(selected(manager));
    }
    expect(shown.length, "the scan took frames").toBeGreaterThan(2);
    expect(shown.slice(0, -1).filter((s) => s !== null), "no match highlighted on the way").toEqual([]);
    expect(selected(manager)).toEqual(needleAt(5));
    const after = counts.slice(seen);
    expect(after.at(-1)).toEqual({ index: 300, total: 300, partial: false });
    expect(after.length).toBeGreaterThan(2);
    for (const count of after.slice(0, -1)) {
      expect(count, "partial with no index while the step waits").toMatchObject({ index: null, partial: true });
    }
  });

  test("Shift+Enter at the newest match waits for the scan instead of wrapping to the oldest found so far", async () => {
    const { frames, find, manager, counts } = await fixture(LONG);
    find.find("needle");
    frames.frame();
    expect(selected(manager)).toEqual(nth(1));
    const found = counts.at(-1)!.total;
    find.step("needle", "newer");
    expect(selected(manager), "the step waits").toEqual(nth(1));
    expect(counts.at(-1)).toEqual({ index: 1, total: found, partial: true });
    frames.settle();
    expect(selected(manager)).toEqual(needleAt(5));
    expect(counts.at(-1)).toEqual({ index: 300, total: 300, partial: false });
  });

  /// LONG on its first frame, walked older to the oldest match found so far.
  async function atTheOldestFound() {
    const f = await fixture(LONG);
    f.find.find("needle");
    f.frames.frame();
    const found = f.counts.at(-1)!.total;
    expect(f.counts.at(-1)).toEqual({ index: 1, total: found, partial: true });
    expect(found).toBeGreaterThan(2);
    // A step that stays among the matches found so far applies at once.
    for (let k = 2; k <= found; k++) {
      f.find.step("needle", "older");
      expect(selected(f.manager)).toEqual(nth(k));
      expect(f.counts.at(-1)).toEqual({ index: k, total: found, partial: true });
    }
    f.find.step("needle", "newer");
    expect(selected(f.manager)).toEqual(nth(found - 1));
    f.find.step("needle", "older");
    expect(selected(f.manager)).toEqual(nth(found));
    return { ...f, found };
  }

  /// atTheOldestFound with one more Enter, which waits.
  async function waitingPastTheOldestFound() {
    const f = await atTheOldestFound();
    f.find.step("needle", "older");
    expect(selected(f.manager), "the step waits rather than wrap to the newest").toEqual(nth(f.found));
    expect(f.counts.at(-1)).toEqual({ index: f.found, total: f.found, partial: true });
    return f;
  }

  test("Enter at the oldest match found so far waits for the next older one instead of wrapping to the newest", async () => {
    const { frames, manager, counts, found } = await waitingPastTheOldestFound();
    let ran = 0;
    while (selected(manager)?.startRow === nth(found).startRow) {
      expect(frames.pending(), "the scan goes on while the step waits").toBe(1);
      frames.frame();
      ran++;
    }
    expect(ran).toBeGreaterThan(0);
    expect(selected(manager), "the next older match").toEqual(nth(found + 1));
    expect(counts.at(-1)).toMatchObject({ index: found + 1 });
    frames.settle();
    expect(counts.at(-1)).toEqual({ index: found + 1, total: 300, partial: false });
  });

  test("steps pressed while one waits apply in the order pressed once the scan allows them", async () => {
    const { frames, find, manager, counts } = await fixture(LONG);
    // As after the bar reopens: Shift+Enter three times, then Enter.
    find.step("needle", "newer");
    find.step("needle", "newer");
    find.step("needle", "newer");
    find.step("needle", "older");
    expect(selected(manager)).toBeNull();
    frames.settle();
    // As on a finished scan: the oldest match, two newer, one older again.
    expect(selected(manager)).toEqual(nth(299));
    expect(counts.at(-1)).toEqual({ index: 299, total: 300, partial: false });
  });

  test("closing the bar drops a step that waits", async () => {
    const { frames, find, manager, counts } = await waitingPastTheOldestFound();
    find.close();
    expect(frames.pending()).toBe(0);
    expect(selected(manager)).toBeNull();
    // Reopened, Enter lands at once on the newest match, not one past it.
    find.step("needle", "older");
    expect(selected(manager)).toEqual(nth(1));
    expect(counts.at(-1)).toMatchObject({ index: 1, partial: true });
    frames.settle();
    expect(selected(manager)).toEqual(nth(1));
    expect(counts.at(-1)).toEqual({ index: 1, total: 300, partial: false });
  });

  test("a new query drops a step that waits", async () => {
    const { frames, find, manager, counts } = await waitingPastTheOldestFound();
    // Rows 29, 290 to 299 and 2900 to 2999 hold it; 2999 is the newest.
    find.find("line <29");
    frames.settle();
    expect(selected(manager)).toEqual(range(2999, 0, 2999, 7));
    expect(counts.at(-1)).toEqual({ index: 1, total: 111, partial: false });
  });

  test("a resize keeps the steps that wait behind the match it keeps, and they apply from it", async () => {
    // Enter walked to the oldest match found so far and pressed three more
    // times; the first of those waits for the scan and the others behind it.
    const { frames, find, view, viewport, manager, counts, found } = await waitingPastTheOldestFound();
    find.step("needle", "older");
    find.step("needle", "older");
    const viewportY = view.viewportY;
    expect(viewport.shows(nth(found).startRow), "the walk scrolled to it").toBe(true);
    // The lines are too short to wrap at 30 columns, so every match keeps
    // its row; the core still forgets its selected match and scans again.
    view.resize(30, 10);
    expect(selected(manager), "the highlight stays on the kept match").toEqual(nth(found));
    expect(view.viewportY, "on the screen, so the viewport stays").toBe(viewportY);
    frames.frame();
    expect(selected(manager)).toEqual(nth(found));
    expect(counts.at(-1)).toMatchObject({ index: null, partial: true });
    frames.settle();
    // Selected again, then the three steps from it, each in its turn.
    expect(selected(manager)).toEqual(nth(found + 3));
    expect(counts.at(-1)).toEqual({ index: found + 3, total: 300, partial: false });
    expect(viewport.shows(nth(found + 3).startRow), "the last step scrolled to its match").toBe(true);
    find.step("needle", "older");
    expect(selected(manager)).toEqual(nth(found + 4));
  });

  test("a resize keeps a new query's selection of its newest match and drops the steps pressed behind it", async () => {
    const { frames, find, view, manager, counts } = await fixture(LONG);
    find.find("needle");
    find.step("needle", "older");
    expect(selected(manager), "nothing scanned yet").toBeNull();
    view.resize(30, 10);
    frames.frame();
    expect(selected(manager)).toEqual(nth(1));
    expect(counts.at(-1)).toMatchObject({ index: 1, partial: true });
    frames.settle();
    expect(selected(manager)).toEqual(nth(1));
    expect(counts.at(-1)).toEqual({ index: 1, total: 300, partial: false });
  });

  test("a selection the user makes while a step waits stays theirs, and the step moves the count", async () => {
    const { frames, find, manager, counts } = await fixture(LONG);
    find.step("needle", "newer");
    expect(selected(manager)).toBeNull();
    manager.selectionStart = { col: 0, absoluteRow: 2998 };
    manager.selectionEnd = { col: 3, absoluteRow: 2998 };
    frames.settle();
    expect(selected(manager)).toEqual(range(2998, 0, 2998, 3));
    expect(counts.at(-1)).toEqual({ index: 300, total: 300, partial: false });
    // The next step is asked for over the user's selection, as any is.
    find.step("needle", "newer");
    expect(selected(manager)).toEqual(nth(299));
  });

  test("a step that waited highlights over the selection there was when it was pressed", async () => {
    const { frames, find, manager } = await fixture(LONG);
    manager.selectionStart = { col: 0, absoluteRow: 2998 };
    manager.selectionEnd = { col: 3, absoluteRow: 2998 };
    find.step("needle", "newer");
    expect(selected(manager), "nothing moves while it waits").toEqual(range(2998, 0, 2998, 3));
    frames.settle();
    expect(selected(manager)).toEqual(needleAt(5));
  });

  test("a step whose scan completes just inside its cap lands at completion on the oldest match", async () => {
    const { frames, find, manager, counts, clock } = await fixture(LONG);
    // As after the bar reopens: Shift+Enter, then every frame of the scan a
    // millisecond short of the cap.
    find.step("needle", "newer");
    clock.set(FIND_WAIT_CAP_MS - 1);
    const shown: Array<MatchRange | null> = [];
    while (frames.pending()) {
      frames.frame();
      shown.push(selected(manager));
    }
    expect(shown.length, "the scan took frames").toBeGreaterThan(2);
    expect(shown.slice(0, -1).filter((s) => s !== null), "no match highlighted on the way").toEqual([]);
    expect(selected(manager)).toEqual(needleAt(5));
    expect(counts.at(-1)).toEqual({ index: 300, total: 300, partial: false });
  });

  test("steps queued behind a capped step apply in order, each as the scan or its own cap allows", async () => {
    const { frames, find, manager, counts, clock } = await fixture(LONG);
    // As after the bar reopens: Shift+Enter, then Enter 600 ms later.
    find.step("needle", "newer");
    clock.set(600);
    find.step("needle", "older");
    expect(selected(manager)).toBeNull();
    clock.set(FIND_WAIT_CAP_MS);
    frames.frame();
    // Shift+Enter's cap ran out: it lands on the oldest match found so far.
    // Enter from there would wrap to the newest, and its cap has 600 ms to
    // go, so it waits for the scan to find the next older match.
    const found = counts.at(-1)!.total;
    expect(found).toBeGreaterThan(1);
    expect(found).toBeLessThan(300);
    expect(selected(manager)).toEqual(nth(found));
    expect(counts.at(-1)).toEqual({ index: found, total: found, partial: true });
    frames.frame();
    expect(selected(manager)).toEqual(nth(found + 1));
    expect(counts.at(-1)).toMatchObject({ index: found + 1 });
  });
});

describe("a step while output outpaces the scan", () => {
  // An 80x10 screen keeping 3,000 lines of history, a needle on every line
  // ending in 5, and 3,500 lines of the same written before each frame:
  // more than the history holds, so the scan never completes while the
  // output lasts.
  const KEPT = 3000;
  const PER_FRAME = 3500;
  /// The clock's step from frame to frame.
  const TICK = 100;

  /// The history searched, the bar closed and reopened with Shift+Enter as
  /// its first step, which waits; `outputFrame` writes a frame of output
  /// and runs the frame.
  async function waitingUnderOutput() {
    const f = await fixture(numbered(KEPT, (i) => i % 10 === 5), { cols: 80, scrollbackLimit: KEPT });
    f.find.find("needle");
    f.frames.settle();
    f.find.close();
    let next = KEPT;
    const outputFrame = () => {
      const lines = Array.from({ length: PER_FRAME }, (_, k) => `line <${next + k}>${(next + k) % 10 === 5 ? " needle" : ""}`);
      next += PER_FRAME;
      f.viewport.write(lines.map((line) => `${line}\r\n`).join(""));
      f.frames.frame();
    };
    f.find.step("needle", "newer");
    expect(selected(f.manager)).toBeNull();
    return { ...f, outputFrame };
  }

  test("a step that would wrap lands among the matches found so far once its cap runs out, and not before", async () => {
    const { clock, created, find, manager, counts, frames, viewport, core, outputFrame } = await waitingUnderOutput();
    const reveal = vi.spyOn(viewport, "reveal");
    for (let at = 0; at < FIND_WAIT_CAP_MS; at += TICK) {
      clock.set(at);
      outputFrame();
      expect(created.at(-1)!.state().complete, `${at} ms: the scan runs`).toBe(false);
      expect(selected(manager), `${at} ms: the step waits`).toBeNull();
      expect(counts.at(-1), `${at} ms`).toMatchObject({ index: null, partial: true });
    }
    clock.set(FIND_WAIT_CAP_MS - 1);
    outputFrame();
    expect(created.at(-1)!.state().complete).toBe(false);
    expect(selected(manager), "a millisecond short of the cap").toBeNull();

    clock.set(FIND_WAIT_CAP_MS);
    outputFrame();
    const landed = selected(manager);
    expect(landed, "the step lands once its cap runs out").not.toBeNull();
    const state = created.at(-1)!.state();
    expect(state.complete, "the scan still runs").toBe(false);
    expect(landed).toEqual(state.active);
    expect(core.plainText(landed!)).toBe("needle");
    expect(counts.at(-1)).toEqual({ index: state.total, total: state.total, partial: true });
    expect(reveal).toHaveBeenCalledWith(landed!.startRow);
    expect(frames.pending(), "the scan goes on").toBe(1);
    // The next press applies at once: it does not wrap.
    find.step("needle", "newer");
    expect(counts.at(-1)).toEqual({ index: state.total - 1, total: state.total, partial: true });
  });

  test("a resize drops a step that waits, so its cap running out lands nothing", async () => {
    const { clock, view, viewport, manager, counts, frames, outputFrame } = await waitingUnderOutput();
    const reveal = vi.spyOn(viewport, "reveal");
    clock.set(TICK);
    outputFrame();
    // The lines are too short to wrap at 60 columns.
    view.resize(60, 10);
    for (let at = FIND_WAIT_CAP_MS; at <= 2 * FIND_WAIT_CAP_MS; at += TICK) {
      clock.set(at);
      outputFrame();
      expect(selected(manager), `${at} ms`).toBeNull();
      expect(counts.at(-1), `${at} ms`).toMatchObject({ index: null, partial: true });
    }
    frames.settle();
    expect(selected(manager)).toBeNull();
    expect(counts.at(-1)).toMatchObject({ index: null, partial: false });
    expect(reveal).not.toHaveBeenCalled();
  });
});

describe("reveal", () => {
  // 200 numbered lines on a ten-row screen: rows 191 to 200 are the active
  // screen, 191 rows of history above them.
  const SCROLLBACK = 191;
  // Scrolled back 50 lines, the screen shows rows 141 to 150.
  test.each([
    ["on the screen at the bottom", 0, 195, 0],
    ["on a screen scrolled back", 50, 145, 50],
    ["on the top row of a scrolled screen", 50, 141, 50],
    ["on the bottom row of a scrolled screen", 50, 150, 50],
    ["just above a scrolled screen, centred", 50, 140, SCROLLBACK - 140 + 5],
    ["just below a scrolled screen, centred", 50, 151, SCROLLBACK - 151 + 5],
    ["above the screen, centred", 0, 100, SCROLLBACK - 100 + 5],
    ["below the screen, centred", SCROLLBACK, 150, SCROLLBACK - 150 + 5],
    ["near the top, clamped to the top", 0, 2, SCROLLBACK],
    ["near the bottom, clamped to the bottom", SCROLLBACK, 199, 0],
  ])("a match %s", async (_name, from, row, to) => {
    const { core, frames, find, manager, view } = await fixture(numbered(200));
    expect(core.getScrollbackLength()).toBe(SCROLLBACK);
    view.viewportY = from;
    find.find(`<${row}>`);
    frames.settle();
    expect(selected(manager)?.startRow).toBe(row);
    expect(view.viewportY).toBe(to);
    // Wherever the viewport ends, the match is on the screen.
    const onScreen = row - SCROLLBACK + view.viewportY;
    expect(onScreen).toBeGreaterThanOrEqual(0);
    expect(onScreen).toBeLessThan(10);
  });

  test("on the alternate screen the highlight is on the screen's own rows", async () => {
    // The alternate screen has no history, so ghostty-web's offset clamps
    // to 0 there and a match is always on the screen.
    const { core, frames, find, manager, viewport } = await fixture(numbered(30, (i) => i === 25));
    find.find("needle");
    frames.settle();
    expect(selected(manager)).toEqual(needleAt(25));
    viewport.write("\x1b[?1049h\x1b[2J\x1b[Hfirst\r\nsecond needle\r\n");
    frames.settle();
    expect(core.getScrollbackLength()).toBe(0);
    expect(selected(manager), "the primary's highlight goes with its screen").toBeNull();
    find.step("needle", "older");
    expect(selected(manager)).toEqual(range(1, 7, 1, 12));
    // Back on the primary screen the core selects the primary's match
    // again, and the highlight follows it.
    viewport.write("\x1b[?1049l");
    frames.settle();
    expect(core.getScrollbackLength()).toBe(21);
    expect(selected(manager)).toEqual(needleAt(25));
  });
});

describe("output while the bar is open", () => {
  test("is fed once a frame however many writes came, and the count follows", async () => {
    const { frames, find, manager, counts, created, viewport } = await fixture(SHORT);
    find.find("needle");
    frames.settle();
    const feed = vi.spyOn(created[0]!, "feed");
    viewport.write("needle g\r\n");
    viewport.write("needle h\r\n");
    expect(frames.pending()).toBe(1);
    frames.frame();
    expect(feed).toHaveBeenCalledTimes(1);
    frames.settle();
    // The core keeps the selection on its text; two newer matches arrived.
    expect(counts.at(-1)).toEqual({ index: 3, total: 5, partial: false });
    expect(selected(manager)).toEqual(SHORT_MATCH(5));
  });

  test("moves the highlight with its match when the history is pruned", async () => {
    const { core, frames, manager, viewport } = await prunable();
    const pruned = prune(core, viewport);
    frames.settle();
    expect(selected(manager)).toEqual(range(900 - pruned, 5, 900 - pruned, 10));
  });

  test("leaves a selection the user made alone when its match moves", async () => {
    const { core, frames, manager, viewport } = await prunable();
    manager.selectionStart = { col: 0, absoluteRow: 2 };
    manager.selectionEnd = { col: 3, absoluteRow: 4 };
    prune(core, viewport);
    frames.settle();
    expect(selected(manager)).toEqual(range(2, 0, 4, 3));
  });
});

describe("a resize while the bar is open", () => {
  /// Needles on short lines and on lines that wrap at 20 columns, one of
  /// them across the wrap, on a 20x6 screen with history above it.
  const WRAPPED = [
    "first needle a",
    `${"x".repeat(10)} needle b ${"y".repeat(12)}`,
    "plain line",
    `${"z".repeat(17)}needle c`,
    `needle d ${"w".repeat(20)}`,
    "short",
    `${"q".repeat(25)} needle e`,
    "needle f",
    "tail one",
    "tail two",
  ];
  const NEEDLE_D = range(6, 0, 6, 5);

  /// WRAPPED found and walked two matches older, to needle d.
  async function walked() {
    const f = await fixture(WRAPPED, { cols: 20, rows: 6 });
    f.find.find("needle");
    f.frames.settle();
    f.find.step("needle", "older");
    f.find.step("needle", "older");
    f.frames.settle();
    expect(f.frames.pending()).toBe(0);
    expect(selected(f.manager)).toEqual(NEEDLE_D);
    expect(f.counts.at(-1)).toEqual({ index: 3, total: 6, partial: false });
    return f;
  }

  /// The text under a range, its soft wraps joined.
  const textAt = (core: VtTerminal, at: MatchRange | null) => (at ? core.plainText(at)?.replace(/\n/g, "") : null);

  /// The matches of `needle` in `core` as it is now, newest first, by a
  /// search of their own: where a kept match should be after a reflow.
  function fresh(core: VtTerminal, needle = "needle"): MatchRange[] {
    // Past the fixture's spy, so the cases' `created` lists find's only.
    const search = VtTerminal.prototype.createSearch.call(core);
    search.setNeedle(needle);
    for (let i = 0; search.step(1) !== "complete"; i++) if (i > 100_000) throw new Error("the search did not complete");
    const all = search.matchesBetween(0, Number.MAX_SAFE_INTEGER, 1000);
    search.free();
    return all;
  }

  /// A narrower grid that reflows needle d's line, a wider one, and one
  /// that changes the rows only.
  const SIZES = [
    [12, 6],
    [33, 6],
    [33, 4],
  ] as const;

  test("moves the highlight to the match's place in the new grid before ghostty-web repaints", async () => {
    const { core, view, manager, frames, painted } = await walked();
    for (const [cols, rows] of SIZES) {
      view.resize(cols, rows);
      const third = fresh(core)[2]!;
      expect(painted.at(-1), `${cols}x${rows}: the repaint draws it`).toEqual(third);
      expect(textAt(core, third)).toBe("needle");
      expect(core.plainText({ ...third, endRow: third.startRow, endCol: third.startCol + 7 }), "needle d's").toBe("needle d");
      frames.settle();
      expect(selected(manager)).toEqual(third);
    }
  });

  test("selects the match again once the rescan finds it, and the count has its index back", async () => {
    const { core, view, manager, frames, counts, created } = await walked();
    for (const [cols, rows] of SIZES) {
      view.resize(cols, rows);
      frames.settle();
      const third = fresh(core)[2]!;
      expect(created[0]!.state().active, `${cols}x${rows}: the core's own selection`).toEqual(third);
      expect(selected(manager)).toEqual(third);
      expect(counts.at(-1)).toEqual({ index: 3, total: 6, partial: false });
    }
  });

  test("a step after it goes on from the match it kept", async () => {
    const { core, view, manager, frames, find, counts } = await walked();
    view.resize(12, 6);
    frames.settle();
    const matches = fresh(core);
    find.step("needle", "older");
    expect(selected(manager)).toEqual(matches[3]);
    expect(counts.at(-1)).toEqual({ index: 4, total: 6, partial: false });
    find.step("needle", "newer");
    find.step("needle", "newer");
    expect(selected(manager)).toEqual(matches[1]);
    expect(counts.at(-1)).toEqual({ index: 2, total: 6, partial: false });
  });

  test("keeps a selection the user made, and still selects the kept match again for the count", async () => {
    const { core, view, manager, frames, painted, find, counts } = await walked();
    manager.selectionStart = { col: 0, absoluteRow: 2 };
    manager.selectionEnd = { col: 3, absoluteRow: 2 };
    view.resize(12, 6);
    frames.settle();
    expect(painted).toEqual([range(2, 0, 2, 3)]);
    expect(selected(manager)).toEqual(range(2, 0, 2, 3));
    expect(counts.at(-1)).toEqual({ index: 3, total: 6, partial: false });
    // The next step is asked for over the user's selection, as any is.
    find.step("needle", "older");
    expect(selected(manager)).toEqual(fresh(core)[3]);
  });

  test("leaves the viewport where it was when the match was off the screen", async () => {
    const { core, view, frames, viewport } = await walked();
    view.viewportY = 2;
    expect(viewport.shows(NEEDLE_D.startRow), "scrolled past it").toBe(false);
    view.resize(12, 6);
    frames.settle();
    expect(view.viewportY).toBe(2);
    expect(viewport.shows(fresh(core)[2]!.startRow)).toBe(false);
    view.resize(20, 6);
    frames.settle();
    expect(view.viewportY).toBe(2);
  });

  test("with the bar closed asks for nothing", async () => {
    const { view, frames, counts } = await fixture(WRAPPED, { cols: 20, rows: 6 });
    view.resize(12, 6);
    expect(frames.pending()).toBe(0);
    expect(counts).toEqual([]);
  });

  test("keeps a match on the screen when the reflow takes it off", async () => {
    // Eleven short lines of history, the needle on the screen's top row and
    // eight lines of 35 characters below it. At 20 columns each of those
    // wraps, the screen fills with them, and the needle's row moves up
    // into the history.
    const lines = [...numbered(11), "top needle", ...Array.from({ length: 8 }, (_, i) => `${i} ${"x".repeat(33)}`)];
    const { core, view, viewport, frames, find, manager, counts } = await fixture(lines);
    find.find("needle");
    frames.settle();
    expect(selected(manager)).toEqual(range(11, 4, 11, 9));
    expect(view.viewportY).toBe(0);
    expect(viewport.shows(11)).toBe(true);
    const reveal = vi.spyOn(viewport, "reveal");
    view.resize(20, 10);
    const kept = selected(manager)!;
    expect(textAt(core, kept)).toBe("needle");
    expect(reveal).toHaveBeenCalledWith(kept.startRow);
    expect(view.viewportY, "scrolled back to it").toBeGreaterThan(0);
    expect(viewport.shows(kept.startRow)).toBe(true);
    frames.settle();
    expect(selected(manager)).toEqual(kept);
    expect(viewport.shows(kept.startRow)).toBe(true);
    expect(counts.at(-1)).toEqual({ index: 1, total: 1, partial: false });
  });

  test("while the rescan runs the count has the total found so far and no index, and the highlight stays", async () => {
    // 20,000 lines, a needle on every one ending in 5: at 12 columns every
    // line wraps, every match moves, and the rescan takes frames.
    const { core, view, frames, find, manager, counts } = await fixture(numbered(20_000, (i) => i % 10 === 5), { scrollbackLimit: 100_000 });
    find.find("needle");
    frames.settle();
    for (let k = 2; k <= 5; k++) find.step("needle", "older");
    expect(selected(manager)).toEqual(needleAt(19_955));
    expect(counts.at(-1)).toEqual({ index: 5, total: 2000, partial: false });
    view.resize(12, 10);
    const kept = selected(manager)!;
    expect(kept).not.toEqual(needleAt(19_955));
    expect(textAt(core, kept)).toBe("needle");
    const shown: FindCount[] = [];
    for (let i = 0; frames.pending(); i++) {
      if (i > 10_000) throw new Error("the rescan never completed");
      frames.frame();
      shown.push(counts.at(-1)!);
      expect(selected(manager), `frame ${i}`).toEqual(kept);
    }
    const landed = shown.findIndex((c) => c.index !== null);
    expect(landed, "frames with no index first").toBeGreaterThan(1);
    expect(shown.slice(0, landed).map((c) => [c.index, c.partial])).toEqual(shown.slice(0, landed).map(() => [null, true]));
    expect(shown[landed], "selected again while the scan still runs").toMatchObject({ index: 5, partial: true });
    expect(shown.slice(landed).map((c) => c.index), "and keeps its index").toEqual(shown.slice(landed).map(() => 5));
    expect(counts.at(-1)).toEqual({ index: 5, total: 2000, partial: false });
    expect(kept).toEqual(fresh(core)[4]);
  });

  test("a step pressed while it rescans waits behind the kept match and applies from it", async () => {
    const { core, view, frames, find, manager, counts } = await fixture(LONG);
    find.find("needle");
    frames.settle();
    for (let k = 2; k <= 5; k++) find.step("needle", "older");
    // At 12 columns every line wraps; the walk back to the fifth match takes
    // five selects, one a frame.
    view.resize(12, 10);
    const kept = selected(manager);
    find.step("needle", "older");
    expect(selected(manager), "the step waits").toEqual(kept);
    frames.frame();
    expect(selected(manager)).toEqual(kept);
    expect(counts.at(-1)).toMatchObject({ index: null });
    frames.settle();
    const sixth = fresh(core)[5]!;
    expect(selected(manager)).toEqual(sixth);
    // "line <2945> " fills the row above it.
    expect(textAt(core, { ...sixth, startRow: sixth.startRow - 1, startCol: 0 })).toBe("line <2945> needle");
    expect(counts.at(-1)).toEqual({ index: 6, total: 300, partial: false });
  });

  test("a walk that has not reached the match when its cap runs out loses it, and the search scans again", async () => {
    const { core, view, frames, find, manager, counts, clock, created } = await fixture(LONG);
    find.find("needle");
    frames.settle();
    for (let k = 2; k <= 150; k++) find.step("needle", "older");
    expect(counts.at(-1)).toEqual({ index: 150, total: 300, partial: false });
    // At 12 columns the rescan of LONG completes on its first frame, so the
    // walk to the 150th match starts at the newest and takes 150 selects,
    // one a frame.
    view.resize(12, 10);
    const kept = selected(manager);
    frames.frame();
    expect(created[0]!.state(), "walking").toMatchObject({ index: 0, complete: true });
    frames.frame();
    expect(selected(manager)).toEqual(kept);
    expect(counts.at(-1)).toMatchObject({ index: null });
    clock.set(FIND_WAIT_CAP_MS);
    frames.frame();
    expect(selected(manager)).toBeNull();
    frames.settle();
    expect(created[0]!.state().index, "no match selected").toBeNull();
    expect(counts.at(-1)).toEqual({ index: null, total: 300, partial: false });
    find.step("needle", "older");
    expect(selected(manager), "the next step starts over").toEqual(fresh(core)[0]);
    expect(counts.at(-1)).toEqual({ index: 1, total: 300, partial: false });
  });

  test("a selection the core kept through the resize is taken as it is, with no walk", async () => {
    // libghostty-vt 1.0 forgets its selected match on every resize. A core
    // that kept it would have it selected when find's frame reads it; the
    // case selects it on the search itself before that frame.
    const { view, frames, manager, counts, created } = await walked();
    view.resize(12, 6);
    const kept = selected(manager)!;
    const search = created[0]!;
    for (let i = 0; search.state().active?.startRow !== kept.startRow || search.state().active?.startCol !== kept.startCol; i++) {
      if (i > 6) throw new Error("the search never selected the kept match");
      search.selectNext();
    }
    const next = vi.spyOn(search, "selectNext");
    const prev = vi.spyOn(search, "selectPrev");
    frames.frame();
    expect(counts.at(-1), "the index back on the first frame").toMatchObject({ index: 3 });
    frames.settle();
    expect(next).not.toHaveBeenCalled();
    expect(prev).not.toHaveBeenCalled();
    expect(selected(manager)).toEqual(kept);
    expect(counts.at(-1)).toEqual({ index: 3, total: 6, partial: false });
  });

  test("walks back to the kept match from the nearer end of the list", async () => {
    const { view, frames, find, counts, created } = await fixture(LONG);
    find.find("needle");
    frames.settle();
    // Newer from the newest wraps to the oldest; four more reach the 296th.
    for (let k = 0; k < 5; k++) find.step("needle", "newer");
    expect(counts.at(-1)).toEqual({ index: 296, total: 300, partial: false });
    // At 12 columns the rescan completes on its first frame, and the 296th is
    // five newer steps from the oldest against 296 older ones from the newest.
    view.resize(12, 10);
    const next = vi.spyOn(created[0]!, "selectNext");
    const prev = vi.spyOn(created[0]!, "selectPrev");
    frames.settle();
    expect(next).not.toHaveBeenCalled();
    expect(prev).toHaveBeenCalledTimes(5);
    expect(counts.at(-1)).toEqual({ index: 296, total: 300, partial: false });
  });

  test("a kept match overwritten while the walk runs is lost once the walk has gone round", async () => {
    const { viewport, view, frames, find, manager, counts } = await fixture(SHORT);
    find.find("needle");
    frames.settle();
    find.step("needle", "older");
    expect(selected(manager)).toEqual(SHORT_MATCH(3));
    // The rows keep their places at 30 columns; with one select a frame the
    // walk from the newest needs two.
    view.resize(30, 10);
    frames.frame();
    // A program writes over row 3 before the walk reaches it.
    viewport.write("\x1b[4;1Hxxxxxx");
    frames.settle();
    expect(selected(manager)).toBeNull();
    expect(counts.at(-1)).toEqual({ index: null, total: 2, partial: false });
    find.step("needle", "older");
    expect(selected(manager)).toEqual(SHORT_MATCH(5));
    expect(counts.at(-1)).toEqual({ index: 1, total: 2, partial: false });
  });

  test("a resize during the walk sends it back to waiting for the rescan to find the match", async () => {
    // 20,000 lines, a needle on every one ending in 5. The rescan at 12
    // columns finds the 101st match on its second frame and the walk starts
    // there; a second resize makes the core forget the walk's place.
    const { view, frames, find, manager, counts, created } = await fixture(numbered(20_000, (i) => i % 10 === 5), { scrollbackLimit: 100_000 });
    find.find("needle");
    frames.settle();
    for (let k = 2; k <= 101; k++) find.step("needle", "older");
    expect(counts.at(-1)).toEqual({ index: 101, total: 2000, partial: false });
    view.resize(12, 10);
    for (let i = 0; created[0]!.state().index === null; i++) {
      if (i > 100) throw new Error("the walk never started");
      frames.frame();
    }
    view.resize(30, 10);
    frames.frame();
    expect(created[0]!.state(), "no select before the rescan finds it again").toMatchObject({ index: null, complete: false });
    frames.settle();
    expect(selected(manager)).toEqual(needleAt(19_995 - 1000));
    expect(counts.at(-1)).toEqual({ index: 101, total: 2000, partial: false });
  });

  test("a match below a scrolled-back screen stays off it when the screen grows", async () => {
    // 200 numbered lines on a ten-row screen: rows 191 to 200 are the
    // screen, 191 rows of history above them.
    const { view, viewport, frames, find, manager } = await fixture(numbered(200));
    find.find("<150>");
    frames.settle();
    expect(selected(manager)?.startRow).toBe(150);
    // Scrolled back to where the match is the row just below the screen.
    view.viewportY = 51;
    expect(viewport.shows(150)).toBe(false);
    expect(viewport.shows(149)).toBe(true);
    // Four more rows: ghostty-web counts them before the core takes them.
    view.resize(40, 14);
    expect(view.viewportY).toBe(51);
    frames.settle();
    expect(view.viewportY).toBe(51);
    expect(selected(manager)?.startRow).toBe(150);
  });

  test.each([
    ["before the resize reaches find", true],
    ["while the rescan runs", false],
  ])("a match whose row was pruned %s is lost, and the next step starts over", async (_name, pruneFirst) => {
    const { core, view, viewport, frames, find, manager, counts, painted } = await prunable();
    find.step("needle", "older");
    expect(selected(manager)).toEqual(range(0, 6, 0, 11));
    expect(counts.at(-1)).toEqual({ index: 2, total: 2, partial: false });
    const pruned = pruneFirst ? prune(core, viewport) : 0;
    // The lines are too short to wrap at 60 columns.
    view.resize(60, 5);
    expect(painted).toEqual([pruneFirst ? null : range(0, 6, 0, 11)]);
    const late = pruneFirst ? pruned : prune(core, viewport);
    frames.settle();
    expect(selected(manager)).toBeNull();
    expect(counts.at(-1)).toEqual({ index: null, total: 1, partial: false });
    find.step("needle", "older");
    expect(selected(manager)).toEqual(range(900 - late, 5, 900 - late, 10));
    expect(counts.at(-1)).toEqual({ index: 1, total: 1, partial: false });
  });

  test("a match the resize cuts is lost once the scan finds no match there", async () => {
    // The alternate screen crops its rows on a resize rather than reflowing
    // them: at 36 columns the newer needle has lost its last three letters.
    const { view, viewport, frames, find, manager, counts, painted } = await fixture([], { cols: 40, rows: 5 });
    viewport.write(`\x1b[?1049h\x1b[Hab needle cd\r\n${"x".repeat(32)} needle\r\n`);
    find.find("needle");
    frames.settle();
    expect(selected(manager)).toEqual(range(1, 33, 1, 38));
    expect(counts.at(-1)).toEqual({ index: 1, total: 2, partial: false });
    view.resize(36, 5);
    expect(painted, "the highlight goes with the kept cells, the last one cropped to the edge").toEqual([range(1, 33, 1, 35)]);
    frames.settle();
    expect(selected(manager)).toBeNull();
    expect(counts.at(-1)).toEqual({ index: null, total: 1, partial: false });
    // A lost match stays lost: the next resize has nothing to keep.
    view.resize(40, 5);
    expect(painted.at(-1)).toBeNull();
    frames.settle();
    expect(selected(manager)).toBeNull();
    find.step("needle", "older");
    expect(selected(manager)).toEqual(range(0, 3, 0, 8));
    expect(counts.at(-1)).toEqual({ index: 1, total: 1, partial: false });
  });

  test("a resize right after a new query keeps nothing of the old query's match", async () => {
    const { view, frames, find, manager, counts, painted } = await fixture(SHORT);
    find.find("needle");
    frames.settle();
    expect(selected(manager)).toEqual(SHORT_MATCH(5));
    find.find("c");
    view.resize(30, 10);
    expect(painted, "the old highlight goes").toEqual([null]);
    frames.settle();
    expect(selected(manager)).toEqual(range(2, 0, 2, 0));
    expect(counts.at(-1)).toEqual({ index: 1, total: 1, partial: false });
  });
});

describe("output a feed would take too long to take in", () => {
  /// At 200 columns, with the costs assumed before any is measured and next
  /// to nothing held to check, a backlog of this many rows predicts exactly
  /// the frame's budget.
  const COLS = 200;
  const LIMIT = FIND_FRAME_BUDGET_MS / (COLS * FIND_COST_PRIORS.read);

  /// A 200x10 terminal with a 60,000-line history, or `scrollbackLimit`,
  /// holding `lines`.
  const wide = (lines: string[], scrollbackLimit = 60_000, budgetMs = 0) => fixture(lines, { cols: COLS, rows: 10, scrollbackLimit, budgetMs });

  /// Writes `n` rows through the viewport, a thousand a write, with no
  /// needle unless `line` puts one in.
  function filler(viewport: GhosttyViewportController, n: number, line = (i: number) => `filler ${i}`): void {
    for (let from = 0; from < n; from += 1000) {
      const count = Math.min(1000, n - from);
      viewport.write(Array.from({ length: count }, (_, i) => `${line(from + i)}\r\n`).join(""));
    }
  }

  /// Every match in the buffer now, newest first, from a scan of its own.
  function truth(core: VtTerminal, needle = "needle"): MatchRange[] {
    const search = VtTerminal.prototype.createSearch.call(core);
    search.setNeedle(needle);
    for (let i = 0; search.step(1) !== "complete"; i++) if (i > 100_000) throw new Error("the search did not complete");
    const all = search.matchesBetween(0, Number.MAX_SAFE_INTEGER, 100_000);
    search.free();
    return all;
  }

  const textAt = (core: VtTerminal, at: MatchRange) => core.plainText(at)?.replace(/\n/g, "");

  /// Makes each feed of find's search take `cost.ms(rows)` on the case's
  /// clock, `rows` the history rows added since the last feed; the case
  /// changes `cost.ms` as it goes.
  function costly(f: Awaited<ReturnType<typeof wide>>, ms: (rows: number) => number) {
    const search = f.created[0]!;
    const feed = search.feed.bind(search);
    const cost = { ms };
    let history = f.core.getScrollbackLength();
    vi.spyOn(search, "feed").mockImplementation(() => {
      const now = f.core.getScrollbackLength();
      f.clock.set(f.clock.now() + cost.ms(now - history));
      history = now;
      feed();
    });
    return cost;
  }

  /// A frame with `rows` filler rows written before it; true when find
  /// restarted its search instead of feeding it.
  function frameAfter(f: Awaited<ReturnType<typeof wide>>, rows: number, line?: (i: number) => string): boolean {
    const restart = vi.spyOn(f.created[0]!, "restart");
    restart.mockClear();
    filler(f.viewport, rows, line);
    f.frames.frame();
    return restart.mock.calls.length > 0;
  }

  test("a backlog predicted to fit the frame is fed, and one predicted over it restarts the scan", async () => {
    const under = await wide(["needle a", "needle b"]);
    under.find.find("needle");
    under.frames.settle();
    expect(frameAfter(under, Math.floor(LIMIT) - 500)).toBe(false);
    const over = await wide(["needle a", "needle b"]);
    over.find.find("needle");
    over.frames.settle();
    expect(frameAfter(over, Math.ceil(LIMIT) + 500)).toBe(true);
    expect(over.counts.at(-1), "the rescan has only begun").toMatchObject({ partial: true });
    over.frames.settle();
    expect(over.counts.at(-1)).toEqual({ index: 1, total: 2, partial: false });
  });

  test("feeds measured cheaper than assumed do not lower the read under the assumed cost", async () => {
    const f = await wide(["needle a"]);
    f.find.find("needle");
    f.frames.settle();
    // A tenth of the assumed cost.
    costly(f, (rows) => (rows * COLS * FIND_COST_PRIORS.read) / 10);
    for (let i = 0; i < 4; i++) expect(frameAfter(f, 1000)).toBe(false);
    expect(frameAfter(f, Math.floor(LIMIT) - 500), "under the threshold").toBe(false);
    expect(frameAfter(f, Math.ceil(LIMIT) + 500), "over it, as at the assumed cost").toBe(true);
  });

  test("small feeds measured cheaper than assumed do not lower the check under its assumed cost", async () => {
    // 50,000 matches in a 50,000-line history at 200 columns: a feed's check
    // assumed at 10 ms, a completing unit's at 15. 10,000 more rows predict
    // 18 ms at the assumed check, dearer than the completion, and restart;
    // with the check measured near nothing they would predict 8 and feed.
    const f = await wide(numbered(50_000, () => true), 80_000);
    f.find.find("needle");
    f.frames.settle();
    costly(f, () => 0.01);
    for (let i = 0; i < 6; i++) expect(frameAfter(f, 10), `small cheap feed ${i}`).toBe(false);
    expect(frameAfter(f, 10_000)).toBe(true);
  });

  test("completing units measured cheaper than assumed do not lower the completion under its assumed cost", async () => {
    // 40,000 matches in a 40,000-line history at 200 columns: the completing
    // unit's check assumed at 9.6 ms leaves the step 2.4 ms of the frame.
    const f = await wide(numbered(40_000, () => true), 60_000, FIND_SCAN_BUDGET_MS);
    const wasm = (f.core as unknown as { wasm: { fn: Record<string, (...args: number[]) => number> } }).wasm;
    const feed = wasm.fn.ghostty_search_feed!;
    // Every unit that feeds the scan, the completing one among them, takes
    // 0.01 ms on the case's clock: a check measured near nothing.
    wasm.fn.ghostty_search_feed = (...args) => {
      f.clock.set(f.clock.now() + 0.01);
      return feed(...args);
    };
    f.find.find("needle");
    f.frames.settle();
    wasm.fn.ghostty_search_feed = feed;
    const held = f.counts.at(-1)!.total;
    const completion = held * f.core.getScrollbackLength() * COLS * FIND_COST_PRIORS.complete;
    const step = vi.spyOn(f.created[0]!, "step");
    expect(frameAfter(f, 10)).toBe(false);
    expect(step.mock.calls[0]![0]).toBeCloseTo(FIND_FRAME_BUDGET_MS - completion, 1);
  });

  test("one feed that ran long raises the read estimate by a quarter at most", async () => {
    // With nothing to check, 11,000 rows at 200 columns predict 8.8 ms at
    // the assumed read cost, 11 ms a quarter above it and 13.2 ms half above.
    const f = await wide(["needle a"]);
    f.find.find("needle");
    f.frames.settle();
    const cost = costly(f, () => 100);
    expect(frameAfter(f, 1000), "the long feed").toBe(false);
    cost.ms = () => 0.01;
    expect(frameAfter(f, 11_000)).toBe(false);
  });

  test("cheap feeds under the predicted check do not lower the read", async () => {
    // 20,000 matches at 200 columns, the history growing to 62,000 lines:
    // the predicted check grows from 1.6 to 4.1 ms. Each 6,000-row feed
    // takes 1 ms, under its check, which would measure its read as nothing;
    // the read stays at its assumed cost, and 12,000 more rows still predict
    // 13.7 ms, over the budget and the completion, and restart. Had the feeds
    // lowered the read, they would predict 7.9 ms.
    const f = await wide(numbered(20_000, () => true), 80_000);
    f.find.find("needle");
    f.frames.settle();
    costly(f, () => 1);
    for (let i = 0; i < 5; i++) expect(frameAfter(f, 6_000), `cheap feed ${i}`).toBe(false);
    expect(frameAfter(f, 12_000)).toBe(true);
  });

  test("a check under the learning floor is not learned: small slow feeds below about 2 ms of work teach nothing", async () => {
    // 5,000 matches in a 10,000-line history at 200 columns: 1e10 matches
    // times cells, a check assumed at 0.2 ms. Twenty small feeds of 20 ms
    // would each raise it by a quarter, to about 17 ms, and restart the next
    // feed; under the floor they do not.
    const f = await wide(numbered(10_000, (i) => i % 2 === 0), 20_000);
    f.find.find("needle");
    f.frames.settle();
    costly(f, () => 20);
    for (let i = 0; i < 20; i++) expect(frameAfter(f, 10), `slow small feed ${i}`).toBe(false);
    expect(frameAfter(f, 100)).toBe(false);
  });

  test("a feed under the clock's grain, measured as no time, teaches nothing", async () => {
    // Three feeds of twice the budget raise the read to about 1.95 times its
    // assumed cost, where 10,000 rows at 200 columns predict 15.6 ms and
    // restart; four feeds the clock reads as no time leave it there, where
    // learned as cheap they would lower it to about 1.05 times, 8.4 ms.
    const f = await wide(["needle a"]);
    f.find.find("needle");
    f.frames.settle();
    const cost = costly(f, () => 2 * FIND_FRAME_BUDGET_MS);
    for (let i = 0; i < 3; i++) expect(frameAfter(f, 1000), `slow feed ${i}`).toBe(false);
    cost.ms = () => 0;
    for (let i = 0; i < 4; i++) expect(frameAfter(f, 1000), `feed under the grain ${i}`).toBe(false);
    expect(frameAfter(f, 10_000)).toBe(true);
  });

  test("feeds that keep costing more than assumed restart a backlog of a size fed before, though one slow feed alone does not", async () => {
    const f = await wide(["needle a"]);
    f.find.find("needle");
    f.frames.settle();
    const cost = costly(f, () => 100);
    expect(frameAfter(f, 1000), "the slow feed").toBe(false);
    cost.ms = () => 0.01;
    expect(frameAfter(f, 1000), "measured once, raised by a quarter").toBe(false);
    // Each 1,000-row feed now takes twice the frame's budget.
    cost.ms = () => 2 * FIND_FRAME_BUDGET_MS;
    const restarted: boolean[] = [];
    for (let i = 0; i < 24 && !restarted.includes(true); i++) restarted.push(frameAfter(f, 1000));
    expect(restarted.indexOf(true), "after several feeds, not on the first").toBeGreaterThan(2);
  });

  test("a running scan's cheaper feeds do not lower what a complete scan's feed is predicted to cost", async () => {
    const f = await wide(["needle a"]);
    f.find.find("needle");
    f.frames.settle();
    // A complete scan's feed of 1,000 rows takes twice the budget; a running
    // scan's, which drops nothing the output pruned, next to nothing.
    const search = f.created[0]!;
    costly(f, () => (search.caughtUp() ? 2 * FIND_FRAME_BUDGET_MS : 0.01));
    let frames = 0;
    while (!frameAfter(f, 1000)) if (++frames > 20) throw new Error("never restarted");
    // Small backlogs while the rescan runs are fed, each one cheap.
    for (let i = 0; i < 6; i++) expect(frameAfter(f, 100), `running feed ${i}`).toBe(false);
    f.frames.settle();
    expect(search.caughtUp()).toBe(true);
    expect(frameAfter(f, 1000), "the complete scan's cost is still the one measured").toBe(true);
  });

  test("a step pressed with a backlog predicted over the budget restarts rather than feeds", async () => {
    const f = await wide(["needle a", "needle b"]);
    f.find.find("needle");
    f.frames.settle();
    const restart = vi.spyOn(f.created[0]!, "restart");
    filler(f.viewport, Math.ceil(LIMIT) + 500);
    f.find.step("needle", "older");
    expect(restart, "before any frame").toHaveBeenCalledTimes(1);
    f.frames.settle();
    // From the kept match, needle b, one older.
    expect(selected(f.manager)).toEqual(range(0, 0, 0, 5));
    expect(f.counts.at(-1)).toEqual({ index: 2, total: 2, partial: false });
  });

  test("a backlog that spans the whole history is fed: the core starts its history search over by itself", async () => {
    // The 20,000-line history at 200 columns predicts over the budget when
    // read whole; a backlog past it leaves the backlog cell's row pruned.
    expect(20_000 * COLS * FIND_COST_PRIORS.read).toBeGreaterThan(FIND_FRAME_BUDGET_MS);
    const f = await wide(["needle a"], 20_000);
    filler(f.viewport, 20_000);
    f.find.find("needle");
    f.frames.settle();
    expect(frameAfter(f, 25_000)).toBe(false);
    f.frames.settle();
    expect(f.counts.at(-1)).toEqual({ index: 0, total: 0, partial: false });
  });

  test("after a resize it feeds: the core scans again from scratch by itself", async () => {
    const f = await wide(["needle a"]);
    f.find.find("needle");
    f.frames.settle();
    const restart = vi.spyOn(f.created[0]!, "restart");
    filler(f.viewport, Math.ceil(LIMIT) + 500);
    // Rows only, so the backlog's cells stay over the budget.
    f.view.resize(COLS, 12);
    f.frames.frame();
    expect(restart).not.toHaveBeenCalled();
  });

  test("a new query starts from the assumed costs again: how often the needle matches decides them", async () => {
    const f = await wide(["needle a", "other b"]);
    f.find.find("needle");
    f.frames.settle();
    costly(f, () => 2 * FIND_FRAME_BUDGET_MS);
    let frames = 0;
    while (!frameAfter(f, 1000)) if (++frames > 20) throw new Error("never restarted");
    f.frames.settle();
    expect(frameAfter(f, 1000), "1,000 rows still cost what was measured").toBe(true);
    f.frames.settle();
    f.find.find("other");
    f.frames.settle();
    expect(frameAfter(f, 1000), "at the assumed cost").toBe(false);
  });

  test("at the default scrollback the whole history at 200 columns fits the frame at the assumed cost, so no write restarts", async () => {
    const lines = scrollbackLinesFromMb(SCROLLBACK_MB_DEFAULT);
    const f = await wide(numbered(lines, (i) => i % 2 === 0), lines);
    f.find.find("needle");
    f.frames.settle();
    // Feeds that cost what the prior assumes keep it where it is.
    costly(f, (rows) => rows * COLS * FIND_COST_PRIORS.read);
    for (const rows of [500, 2_000, 9_000, lines - 100, 2 * lines]) expect(frameAfter(f, rows), `${rows} rows`).toBe(false);
  });

  test("the scan's step leaves room in the frame for the check of the unit that completes it", async () => {
    // 40,000 matches in a 40,000-line history at 200 columns: the completing
    // unit's check is assumed to take most of the frame.
    const f = await wide(numbered(40_000, () => true), 60_000, FIND_SCAN_BUDGET_MS);
    f.find.find("needle");
    f.frames.settle();
    const held = f.counts.at(-1)!.total;
    const completion = held * f.core.getScrollbackLength() * COLS * FIND_COST_PRIORS.complete;
    expect(completion).toBeGreaterThan(FIND_FRAME_BUDGET_MS - FIND_SCAN_BUDGET_MS);
    expect(completion).toBeLessThan(FIND_FRAME_BUDGET_MS);
    const step = vi.spyOn(f.created[0]!, "step");
    expect(frameAfter(f, 10)).toBe(false);
    expect(step).toHaveBeenCalledTimes(1);
    expect(step.mock.calls[0]![0]).toBeCloseTo(FIND_FRAME_BUDGET_MS - completion, 1);
  });

  test("a complete scan's feed over the budget is fed, not restarted, when the rescan's completion would cost more", async () => {
    // 50,000 matches in a 50,000-line history at 200 columns: a feed's check
    // is assumed at 10 ms and a completing unit's at 15. With 10,000 more
    // rows to read the feed predicts 18 ms, over the budget and over the
    // completion, so it restarts; once a completing unit has taken 30 ms
    // the completion predicts dearer than the feed, so it feeds.
    for (const slow of [false, true]) {
      const f = await wide(numbered(50_000, () => true));
      const wasm = (f.core as unknown as { wasm: { fn: Record<string, (...args: number[]) => number> } }).wasm;
      const feed = wasm.fn.ghostty_search_feed!;
      // Every unit that feeds the scan, the completing one among them,
      // takes 30 ms on the case's clock.
      if (slow) {
        wasm.fn.ghostty_search_feed = (...args) => {
          f.clock.set(f.clock.now() + 30);
          return feed(...args);
        };
      }
      f.find.find("needle");
      f.frames.settle();
      wasm.fn.ghostty_search_feed = feed;
      expect(frameAfter(f, 10_000), slow ? "the completion measured dearer" : "at the assumed costs").toBe(!slow);
    }
  });

  /// 50,000 matches in a 50,000-line history at 200 columns, the completing
  /// unit's check assumed at 15 ms, over the budget with any reading; a
  /// backlog of 10,000 rows makes the complete scan's feed predict 18 ms,
  /// dearer than that, so the search restarts, holding as many matches.
  async function restartedBig(budgetMs = 0) {
    const f = await wide(numbered(50_000, () => true), 80_000, budgetMs);
    f.find.find("needle");
    f.frames.settle();
    expect(frameAfter(f, 10_000)).toBe(true);
    expect(f.created[0]!.caughtUp()).toBe(false);
    return f;
  }

  test("a running scan restarts for a read of a scan step or more whose completion would not fit, and feeds smaller ones", async () => {
    const f = await restartedBig();
    // 6,000 rows read in 4.8 ms at the assumed cost: a step's budget or
    // more, and with the completion over the frame's.
    for (let i = 0; i < 3; i++) expect(frameAfter(f, 6_000), `big write ${i}`).toBe(true);
    // 100 rows read in 0.08 ms: a restart would throw the scan away to save
    // next to nothing.
    for (let i = 0; i < 3; i++) expect(frameAfter(f, 100), `small write ${i}`).toBe(false);
    f.frames.settle();
    expect(f.counts.at(-1)).toEqual({ index: 1, total: truth(f.core).length, partial: false });
  });

  test("a running scan whose completion is predicted over the budget feeds writes that add no rows, and completes", async () => {
    const f = await restartedBig();
    const search = f.created[0]!;
    const restart = vi.spyOn(search, "restart");
    restart.mockClear();
    // A spinner: a write every frame that moves no row into the history.
    let frames = 0;
    for (; !search.caughtUp(); frames++) {
      if (frames > 5000) throw new Error("the scan never completed");
      f.viewport.write(`\r${"|/-\\"[frames % 4]}`);
      f.frames.frame();
    }
    expect(restart).not.toHaveBeenCalled();
    expect(frames).toBeGreaterThan(10);
    f.frames.settle();
    expect(f.counts.at(-1)).toEqual({ index: 1, total: truth(f.core).length, partial: false });
  });

  test("with the completion predicted over the budget the scan's step runs its whole budget", async () => {
    // As restartedBig, with the scan budget: the restart's frame steps the
    // rescan, whose completing unit is assumed at 15 ms, over the frame.
    const f = await wide(numbered(50_000, () => true), 80_000, FIND_SCAN_BUDGET_MS);
    f.find.find("needle");
    f.frames.settle();
    const step = vi.spyOn(f.created[0]!, "step");
    expect(frameAfter(f, 10_000)).toBe(true);
    expect(step).toHaveBeenCalledTimes(1);
    expect(step.mock.calls[0]![0]).toBe(FIND_SCAN_BUDGET_MS);
  });

  test("with under a millisecond left beside the completion the scan's step still gets one", async () => {
    // 43,000 matches in a 43,000-line history at 200 columns: the completing
    // unit's check is assumed at 11.1 ms, leaving 0.9 ms of the frame.
    const f = await wide(numbered(43_000, () => true), 60_000, FIND_SCAN_BUDGET_MS);
    f.find.find("needle");
    f.frames.settle();
    const held = f.counts.at(-1)!.total;
    const completion = held * f.core.getScrollbackLength() * COLS * FIND_COST_PRIORS.complete;
    expect(FIND_FRAME_BUDGET_MS - completion).toBeLessThan(1);
    expect(FIND_FRAME_BUDGET_MS - completion).toBeGreaterThan(0);
    const step = vi.spyOn(f.created[0]!, "step");
    expect(frameAfter(f, 10)).toBe(false);
    expect(step.mock.calls[0]![0]).toBe(1);
  });

  test("small feeds of a complete scan that take long raise the check its next feed predicts", async () => {
    // 50,000 matches in a 50,000-line history at 200 columns: a feed's check
    // is assumed at 10 ms and a completing unit's at 15. A backlog of 4,700
    // rows reads in about 3.8 ms: a feed predicts 13.8 ms, over the budget
    // but under the completion, and is fed; after a slow small feed raises
    // the check by a quarter, to 12.5, it predicts 16.3, over the
    // completion, and restarts.
    const backlog = 4_700;
    for (const slow of [false, true]) {
      const f = await wide(numbered(50_000, () => true));
      f.find.find("needle");
      f.frames.settle();
      if (slow) {
        const cost = costly(f, () => 20);
        expect(frameAfter(f, 10), "the slow small feed").toBe(false);
        cost.ms = () => 0.01;
      }
      expect(frameAfter(f, backlog), slow ? "after the slow feed" : "at the assumed check").toBe(slow);
    }
  });

  describe("across a restart", () => {
    /// 20,000 lines with a needle on every one ending in 5, the fifth newest
    /// selected; the rescan after a restart takes frames.
    async function selectedFifth(scrollbackLimit = 60_000) {
      const f = await wide(numbered(20_000, (i) => i % 10 === 5), scrollbackLimit);
      f.find.find("needle");
      f.frames.settle();
      for (let k = 2; k <= 5; k++) f.find.step("needle", "older");
      expect(selected(f.manager)).toEqual(needleAt(19_955));
      expect(f.counts.at(-1)).toEqual({ index: 5, total: 2000, partial: false });
      return f;
    }

    test("the count is partial with no index and never more than the buffer holds, and the kept match gets its index back", async () => {
      const f = await selectedFifth();
      const kept = selected(f.manager);
      expect(frameAfter(f, Math.ceil(LIMIT) + 500)).toBe(true);
      const total = truth(f.core).length;
      const shown: FindCount[] = [f.counts.at(-1)!];
      for (let i = 0; f.frames.pending(); i++) {
        if (i > 10_000) throw new Error("the rescan never completed");
        f.frames.frame();
        shown.push(f.counts.at(-1)!);
        expect(selected(f.manager), `frame ${i}`).toEqual(kept);
      }
      // Until the rescan finds the match again the count has no index: "0
      // of 0+" while the filler has given it nothing, then "? of n+".
      const landed = shown.findIndex((c) => c.index !== null && c.total > 0);
      expect(landed, "frames with no index first").toBeGreaterThan(1);
      expect(shown.slice(0, landed).every((c) => c.partial && (c.index === null || c.total === 0))).toBe(true);
      expect(shown.slice(0, landed).some((c) => c.index === null && c.total > 0), "some matches found, none selected").toBe(true);
      expect(shown.every((c) => c.total <= total)).toBe(true);
      expect(shown.slice(landed).map((c) => c.index), "the filler added no newer match").toEqual(shown.slice(landed).map(() => 5));
      expect(f.counts.at(-1)).toEqual({ index: 5, total, partial: false });
    });

    test("a step pressed while it rescans waits behind the kept match and applies from it", async () => {
      const f = await selectedFifth();
      expect(frameAfter(f, Math.ceil(LIMIT) + 500)).toBe(true);
      const kept = selected(f.manager);
      f.find.step("needle", "older");
      expect(selected(f.manager), "the step waits").toEqual(kept);
      f.frames.settle();
      expect(selected(f.manager)).toEqual(needleAt(19_945));
      expect(f.counts.at(-1)).toEqual({ index: 6, total: 2000, partial: false });
    });

    test("a selection the user made stays theirs, and the kept match still gets its index back", async () => {
      const f = await selectedFifth();
      f.manager.selectionStart = { col: 0, absoluteRow: 3 };
      f.manager.selectionEnd = { col: 4, absoluteRow: 3 };
      expect(frameAfter(f, Math.ceil(LIMIT) + 500)).toBe(true);
      f.frames.settle();
      expect(selected(f.manager)).toEqual(range(3, 0, 3, 4));
      expect(f.counts.at(-1)).toEqual({ index: 5, total: 2000, partial: false });
    });

    test("a match the backlog pruned is lost: no highlight and no index until the next step, which starts over", async () => {
      // A 20,000-line history, full: the backlog prunes its oldest rows.
      const f = await wide(numbered(20_000, (i) => i % 10 === 5), 20_000);
      f.find.find("needle");
      f.frames.settle();
      // The oldest match of all: newer from nothing selected, once complete.
      f.find.step("needle", "newer");
      const oldest = selected(f.manager)!;
      expect(f.counts.at(-1)).toMatchObject({ index: f.counts.at(-1)!.total, partial: false });
      expect(frameAfter(f, Math.ceil(LIMIT) + 500)).toBe(true);
      expect(selected(f.manager), "gone with its row").toBeNull();
      f.frames.settle();
      const all = truth(f.core);
      expect(all).not.toContainEqual(oldest);
      expect(f.counts.at(-1)).toEqual({ index: null, total: all.length, partial: false });
      f.find.step("needle", "older");
      expect(selected(f.manager)).toEqual(all[0]);
      expect(f.counts.at(-1)).toEqual({ index: 1, total: all.length, partial: false });
    });

    test("a step pressed when the backlog pruned the match drops its highlight at once, with nothing found yet to land on", async () => {
      const f = await wide(numbered(20_000, (i) => i % 10 === 5), 20_000);
      f.find.find("needle");
      f.frames.settle();
      f.find.step("needle", "newer");
      expect(selected(f.manager)).not.toBeNull();
      filler(f.viewport, Math.ceil(LIMIT) + 500);
      f.find.step("needle", "older");
      expect(selected(f.manager), "no frame has run").toBeNull();
      expect(f.frames.pending()).toBe(1);
    });

    test("the highlight follows the kept match while pruned history moves its rows during the rescan", async () => {
      // A full 20,000-line history: each write prunes its oldest rows.
      const f = await selectedFifth(20_000);
      const history = () => f.core.getScrollbackLength();
      expect(frameAfter(f, Math.ceil(LIMIT) + 500)).toBe(true);
      for (let i = 0; i < 5; i++) {
        filler(f.viewport, 200);
        f.frames.frame();
        const now = selected(f.manager)!;
        expect(textAt(f.core, now), `frame ${i}, history ${history()}`).toBe("needle");
        expect(now.startRow).toBeLessThan(19_955 - Math.ceil(LIMIT));
      }
      f.frames.settle();
      expect(textAt(f.core, selected(f.manager)!)).toBe("needle");
      expect(f.counts.at(-1)).toMatchObject({ index: 5, partial: false });
    });

    test("output that restarts the search frame after frame holds a step behind the kept match no longer than the cap from the first restart", async () => {
      const f = await selectedFifth();
      const kept = selected(f.manager);
      // Feeds that take twice the budget teach find that 1,000 rows do, so
      // from some frame on every 1,000-row frame restarts.
      costly(f, () => 2 * FIND_FRAME_BUDGET_MS);
      let first = 0;
      while (!frameAfter(f, 1000)) if (++first > 20) throw new Error("never restarted");
      const pressed = f.clock.now();
      f.find.step("needle", "older");
      // Output with a needle on every tenth line, so each rescan's first
      // unit finds some.
      const shown: FindCount[] = [];
      for (let i = 1; f.clock.now() < pressed + FIND_WAIT_CAP_MS + 200; i++) {
        f.clock.set(pressed + 100 * i);
        expect(frameAfter(f, 1000, (n) => `output ${n}${n % 10 === 0 ? " needle" : ""}`), `frame ${i} restarts`).toBe(true);
        shown.push(f.counts.at(-1)!);
      }
      // The rescan never reached the kept match before the cap, so it was
      // lost, and the step, past its own cap, landed on the newest match
      // found so far: older from no match selected.
      const landed = shown.findIndex((c) => c.index !== null && c.total > 0);
      expect(landed, "not before the cap").toBeGreaterThanOrEqual(FIND_WAIT_CAP_MS / 100 - 1);
      expect(shown[landed]).toMatchObject({ index: 1, partial: true });
      expect(selected(f.manager)).not.toEqual(kept);
      expect(textAt(f.core, selected(f.manager)!)).toBe("needle");
    });
  });
});

describe("the tracked cells", () => {
  /// The cells the core tracks for `core`, by their handles: each one made
  /// and not freed yet; `made` counts every one made.
  function tracked(core: VtTerminal): Set<number> & { made: number } {
    const wasm = (core as unknown as { wasm: { fn: Record<string, (...args: number[]) => number>; view(): DataView } }).wasm;
    const live = Object.assign(new Set<number>(), { made: 0 });
    const { ghostty_terminal_grid_ref_track: track, ghostty_tracked_grid_ref_free: free } = wasm.fn;
    wasm.fn.ghostty_terminal_grid_ref_track = (terminal, point, out) => {
      const result = track!(terminal, point, out);
      if (result === 0) {
        live.add(wasm.view().getUint32(out, true));
        live.made++;
      }
      return result;
    };
    wasm.fn.ghostty_tracked_grid_ref_free = (ref) => {
      live.delete(ref);
      return free!(ref);
    };
    return live;
  }

  test("are three, the kept match's two and the backlog's, moved through a search's life and gone with the search and the terminal", async () => {
    const { core, frames, find, view, viewport } = await fixture(SHORT);
    const live = tracked(core);
    find.find("needle");
    frames.settle();
    expect(live.size, "the newest match's first and last cells, and the backlog's").toBe(3);
    find.step("needle", "older");
    find.step("needle", "older");
    viewport.write("more output\r\n");
    view.resize(30, 10);
    frames.settle();
    expect(live.size).toBe(3);
    expect(live.made, "moved from match to match and feed to feed, not made again").toBe(3);
    find.close();
    expect(live.size, "freed with the search").toBe(0);
    find.find("needle");
    frames.settle();
    expect(live.size).toBe(3);
    find.dispose();
    expect(live.size, "freed when the terminal goes").toBe(0);
  });

  test("a terminal freed while the bar is open frees them too", async () => {
    const { core, frames, find } = await fixture(SHORT);
    const live = tracked(core);
    find.find("needle");
    frames.settle();
    expect(live.size).toBe(3);
    core.free();
    expect(live.size).toBe(0);
    expect(() => find.dispose()).not.toThrow();
    expect(live.size).toBe(0);
  });
});

describe("closing", () => {
  test("clears the highlight it wrote", async () => {
    const { frames, find, manager } = await fixture(SHORT);
    find.find("needle");
    frames.settle();
    expect(selected(manager)).toEqual(SHORT_MATCH(5));
    find.close();
    expect(selected(manager)).toBeNull();
  });

  test("keeps a selection the user made since", async () => {
    const { frames, find, manager } = await fixture(SHORT);
    find.find("needle");
    frames.settle();
    manager.selectionStart = { col: 0, absoluteRow: 0 };
    manager.selectionEnd = { col: 1, absoluteRow: 0 };
    find.close();
    expect(selected(manager)).toEqual(range(0, 0, 0, 1));
  });

  test("an empty query closes the search too", async () => {
    const { frames, find, manager, created } = await fixture(SHORT);
    find.find("needle");
    frames.settle();
    const free = vi.spyOn(created[0]!, "free");
    find.find("");
    expect(free).toHaveBeenCalledTimes(1);
    expect(selected(manager)).toBeNull();
    // The next query starts a search of its own.
    find.find("needle");
    frames.settle();
    expect(created).toHaveLength(2);
    expect(selected(manager)).toEqual(SHORT_MATCH(5));
  });
});

describe("dispose", () => {
  test("stops the scan, frees the search and stops watching changes", async () => {
    const { core, frames, find, counts, created, viewport } = await fixture(numbered(3000, (i) => i % 10 === 5));
    const observers = (viewport as unknown as { changeObservers: Set<unknown> }).changeObservers;
    const resizing = (core as unknown as { resizeListeners: Set<unknown> }).resizeListeners;
    expect(observers.size).toBe(1);
    expect(resizing.size).toBe(1);
    find.find("needle");
    frames.frame();
    expect(frames.pending(), "mid-scan").toBe(1);
    const free = vi.spyOn(created[0]!, "free");
    const seen = counts.length;

    find.dispose();
    expect(frames.pending()).toBe(0);
    expect(free).toHaveBeenCalledTimes(1);
    expect(observers.size).toBe(0);
    expect(resizing.size, "nor the core's resizes").toBe(0);
    viewport.write("needle late\r\n");
    expect(frames.pending()).toBe(0);
    expect(counts).toHaveLength(seen);
  });
});

describe("attach", () => {
  test("is null for a terminal on another core", () => {
    const viewport = { observeChanges: () => () => {}, reveal() {}, shows: () => false };
    const term = { wasmTerm: {} } as unknown as Terminal;
    expect(GhosttyFind.attach(term, viewport, () => {})).toBeNull();
  });

  test("finds through the binding's terminal and ghostty-web's selection manager", async () => {
    const { core, manager, view, viewport } = await fixture(SHORT);
    const term = { wasmTerm: core, selectionManager: manager } as unknown as Terminal;
    const counts: FindCount[] = [];
    const find = GhosttyFind.attach(term, viewport, (count) => counts.push(count));
    expect(find).not.toBeNull();
    find!.step("needle", "older");
    expect(selected(manager)).toEqual(SHORT_MATCH(5));
    expect(counts.at(-1)).toMatchObject({ index: 1 });
    expect(view.viewportY).toBe(0);
    find!.dispose();
  });
});
