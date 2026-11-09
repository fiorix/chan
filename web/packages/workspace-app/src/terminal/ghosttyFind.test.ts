// @vitest-environment jsdom
//
// GhosttyFind over the binding's terminal on the vendored core, ghostty-web's
// own SelectionManager and chan's viewport controller. The viewport is a
// stand-in with ghostty-web's semantics (an offset of lines scrolled back from
// the bottom, clamped to the history, back to 0 after a write; a resize that
// hands the core the new grid, fires the resize event and repaints), and
// frames run when a case says so. The scan budget is 0, one unit of the
// core's work per frame, so a scan's progress is the same on any machine.

import { readFileSync } from "node:fs";
import { SelectionManager, type Terminal } from "ghostty-web";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { type FindCount, type FrameScheduler, GhosttyFind } from "./ghosttyFind";
import { GhosttyViewportController } from "./ghosttyViewport";
import { GhosttyVt, type MatchRange, type VtSearch, VtTerminal } from "./ghosttyVt";

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

async function fixture(lines: string[], { cols = 40, rows = 10, scrollbackLimit = 10_000 } = {}) {
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
    budgetMs: 0,
  });
  return { core, view, viewport, manager: manager as unknown as Manager, frames, counts, created, find, painted };
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
  // A needle on every line ending in 5 of 3,000: 300 matches, the newest on
  // row 2995 and the oldest on row 5. One unit of the core's scan a frame
  // leaves the first frames with the newest matches only, and the core
  // wraps among those.
  const LONG = numbered(3000, (i) => i % 10 === 5);
  /// The k-th match from the newest, counting from 1 as the bar does.
  const nth = (k: number) => needleAt(2995 - 10 * (k - 1));

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

  test("a resize drops the steps that wait, so none starts the walk over or moves the viewport", async () => {
    // Enter walked to the oldest match found so far and pressed three more
    // times. Each waiting step would land from no match selected after the
    // resize, the first on the newest match and the rest past it.
    const { frames, find, view, viewport, manager, counts } = await waitingPastTheOldestFound();
    find.step("needle", "older");
    find.step("needle", "older");
    const reveal = vi.spyOn(viewport, "reveal");
    const viewportY = view.viewportY;
    expect(viewportY, "the walk scrolled back").toBeGreaterThan(0);
    // The lines are too short to wrap at 30 columns, so every match keeps
    // its row; the core still forgets its selected match and scans again.
    view.resize(30, 10);
    expect(selected(manager)).toBeNull();
    frames.frame();
    expect(selected(manager), "the rescan's first frame selects nothing").toBeNull();
    expect(counts.at(-1)).toMatchObject({ index: null, partial: true });
    frames.settle();
    expect(selected(manager)).toBeNull();
    expect(counts.at(-1)).toEqual({ index: null, total: 300, partial: false });
    expect(reveal).not.toHaveBeenCalled();
    expect(view.viewportY).toBe(viewportY);
    // The next Enter starts the walk over, at the newest match.
    find.step("needle", "older");
    expect(selected(manager)).toEqual(nth(1));
    expect(counts.at(-1)).toEqual({ index: 1, total: 300, partial: false });
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

  /// A needle on row 0 and on row 900 of a thousand-line history on an
  /// 80x5 screen, the newer one selected.
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

  test("drops the highlight find wrote before ghostty-web repaints the reflowed grid", async () => {
    const { core, view, manager, painted } = await walked();
    view.resize(12, 6);
    expect(textAt(core, NEEDLE_D), "the reflow gave the highlight's rows other text").not.toBe("needle");
    expect(painted).toEqual([null]);
    expect(selected(manager)).toBeNull();
  });

  test("is fed on the next frame, where the highlight agrees with the core: no match is active", async () => {
    // The core forgets its selected match on any resize and scans again, so
    // there is no match to move the highlight to; the count keeps the total
    // and has no index.
    const { view, manager, frames, counts, created } = await walked();
    for (const [cols, rows] of [
      [12, 6],
      [33, 6],
      [20, 4],
    ] as const) {
      view.resize(cols, rows);
      expect(frames.pending(), `${cols}x${rows}: a frame is asked for`).toBe(1);
      frames.frame();
      const active = created[0]!.state().active;
      expect(active).toBeNull();
      expect(selected(manager)).toEqual(active);
      frames.settle();
      expect(counts.at(-1)).toEqual({ index: null, total: 6, partial: false });
    }
  });

  test("leaves the viewport where the resize put it", async () => {
    const { view, frames } = await walked();
    view.viewportY = 2;
    view.resize(12, 6);
    frames.settle();
    expect(view.viewportY).toBe(2);
    view.resize(20, 6);
    frames.settle();
    expect(view.viewportY).toBe(2);
  });

  test("a step after it starts the walk over and highlights the match on its reflowed rows", async () => {
    const { core, view, manager, frames, find, counts, created } = await walked();
    view.resize(12, 6);
    frames.settle();
    find.step("needle", "older");
    expect(selected(manager), "the newest match at 12 columns").toEqual(range(16, 0, 16, 5));
    expect(counts.at(-1)).toEqual({ index: 1, total: 6, partial: false });
    view.resize(33, 6);
    frames.settle();
    find.step("needle", "newer");
    const oldest = created[0]!.state().active;
    expect(oldest).toEqual(range(0, 6, 0, 11));
    expect(selected(manager)).toEqual(oldest);
    expect(textAt(core, oldest)).toBe("needle");
    expect(counts.at(-1)).toEqual({ index: 6, total: 6, partial: false });
  });

  test("keeps a selection the user made", async () => {
    const { view, manager, frames, painted } = await walked();
    manager.selectionStart = { col: 0, absoluteRow: 2 };
    manager.selectionEnd = { col: 3, absoluteRow: 2 };
    view.resize(12, 6);
    frames.settle();
    expect(painted).toEqual([range(2, 0, 2, 3)]);
    expect(selected(manager)).toEqual(range(2, 0, 2, 3));
  });

  test("with the bar closed asks for nothing", async () => {
    const { view, frames, counts } = await fixture(WRAPPED, { cols: 20, rows: 6 });
    view.resize(12, 6);
    expect(frames.pending()).toBe(0);
    expect(counts).toEqual([]);
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
    const { frames, find, counts, created, viewport } = await fixture(numbered(3000, (i) => i % 10 === 5));
    const observers = (viewport as unknown as { changeObservers: Set<unknown> }).changeObservers;
    expect(observers.size).toBe(1);
    find.find("needle");
    frames.frame();
    expect(frames.pending(), "mid-scan").toBe(1);
    const free = vi.spyOn(created[0]!, "free");
    const seen = counts.length;

    find.dispose();
    expect(frames.pending()).toBe(0);
    expect(free).toHaveBeenCalledTimes(1);
    expect(observers.size).toBe(0);
    viewport.write("needle late\r\n");
    expect(frames.pending()).toBe(0);
    expect(counts).toHaveLength(seen);
  });
});

describe("attach", () => {
  test("is null for a terminal on another core", () => {
    const viewport = { observeChanges: () => () => {}, reveal() {} };
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
