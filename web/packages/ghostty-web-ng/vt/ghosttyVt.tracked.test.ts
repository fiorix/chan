// The binding's tracked cells (libghostty-vt's tracked grid references) and
// its word of a resize before the core takes it, over the vendored core.

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, test } from "vitest";
import { GhosttyVt, type VtTerminal, type VtTrackedCell } from "./ghosttyVt";

const VENDORED = "vendor/ghostty-vt/ghostty-vt.wasm";

let vendored: WebAssembly.Module;

beforeAll(async () => {
  vendored = await WebAssembly.compile(readFileSync(VENDORED));
});

async function terminal(cols: number, rows: number, scrollbackLimit = 1000): Promise<VtTerminal> {
  const vt = new GhosttyVt(await WebAssembly.instantiate(vendored, {}));
  return vt.createTerminal(cols, rows, { scrollbackLimit }) as unknown as VtTerminal;
}

/// The handles of the tracked references the core holds for `t` from here
/// on: each one made and not freed yet.
function tracked(t: VtTerminal): Set<number> {
  const wasm = (t as unknown as { wasm: { fn: Record<string, (...args: number[]) => number>; view(): DataView } }).wasm;
  const live = new Set<number>();
  const { ghostty_terminal_grid_ref_track: track, ghostty_tracked_grid_ref_free: free } = wasm.fn;
  wasm.fn.ghostty_terminal_grid_ref_track = (terminal, point, out) => {
    const result = track!(terminal, point, out);
    if (result === 0) live.add(wasm.view().getUint32(out, true));
    return result;
  };
  wasm.fn.ghostty_tracked_grid_ref_free = (ref) => {
    live.delete(ref);
    return free!(ref);
  };
  return live;
}

/// Needles on short lines and on lines that wrap at 20 columns, "needle c"
/// across a wrap from row 3, column 17 to row 4, column 2, on a 20x6
/// screen with history above it.
const WRAPPED = [
  "first needle a",
  `${"x".repeat(10)} needle b ${"y".repeat(12)}`,
  `${"z".repeat(17)}needle c`,
  "needle d",
].map((line) => `${line}\r\n`).join("");

/// The text between two tracked cells, its soft wraps joined.
function between(t: VtTerminal, first: VtTrackedCell, last: VtTrackedCell): string | null {
  const a = first.point();
  const b = last.point();
  if (!a || !b) return null;
  return t.plainText({ startRow: a.row, startCol: a.col, endRow: b.row, endCol: b.col })?.replace(/\n/g, "") ?? null;
}

describe("a tracked cell", () => {
  test("follows its text through reflows narrower and wider, a rows-only resize and new output", async () => {
    const t = await terminal(20, 6);
    t.write(WRAPPED);
    const first = t.trackCell(3, 17)!;
    const last = t.trackCell(4, 2)!;
    expect(first.point()).toEqual({ row: 3, col: 17 });
    expect(between(t, first, last)).toBe("needle");
    const seen: Array<unknown> = [];
    for (const [cols, rows] of [
      [12, 6],
      [12, 8],
      [33, 6],
      [8, 3],
      [20, 6],
    ] as const) {
      t.resize(cols, rows);
      expect(between(t, first, last), `${cols}x${rows}`).toBe("needle");
      seen.push(first.point());
    }
    expect(new Set(seen.map((p) => JSON.stringify(p))).size, "the reflows moved it").toBeGreaterThan(2);
    expect(first.point(), "back at 20 columns, back where it was").toEqual({ row: 3, col: 17 });
    t.write("more\r\nand more\r\n");
    expect(first.point(), "output below it moves nothing").toEqual({ row: 3, col: 17 });
    expect(between(t, first, last)).toBe("needle");
  });

  test("names no cell once its row is pruned, and moveTo tracks another", async () => {
    const t = await terminal(80, 5, 1000);
    t.write("early needle\r\n");
    const early = t.trackCell(0, 6)!;
    const before = t.getScrollbackLength();
    let last = before;
    for (let added = 0; ; added++) {
      t.write(`filler ${added} ${"y".repeat(40)}\r\n`);
      const now = t.getScrollbackLength();
      if (now < last) break;
      last = now;
      if (added > 5000) throw new Error("the history was never pruned");
    }
    expect(early.point(), "its page went").toBeNull();
    expect(early.moveTo(3, 0)).toBe(true);
    expect(early.point()).toEqual({ row: 3, col: 0 });
    early.free();
  });

  test("is refused outside the screen, and a refused move keeps the cell it had", async () => {
    const t = await terminal(20, 6);
    t.write(WRAPPED);
    const rows = t.getScrollbackLength() + t.rows;
    expect(t.trackCell(rows, 0), "below the last row").toBeNull();
    expect(t.trackCell(0, 20), "past the last column").toBeNull();
    expect(t.trackCell(-1, 0)).toBeNull();
    const cell = t.trackCell(3, 17)!;
    expect(cell.moveTo(rows, 0)).toBe(false);
    expect(cell.moveTo(0, -1)).toBe(false);
    expect(cell.point()).toEqual({ row: 3, col: 17 });
    cell.free();
  });

  test("on the alternate screen a crop leaves it on the row's last column", async () => {
    // The alternate screen crops its rows on a resize rather than reflowing.
    const t = await terminal(40, 5);
    t.write(`\x1b[?1049h\x1b[H${"x".repeat(33)}needle\r\n`);
    const cell = t.trackCell(0, 33)!;
    t.resize(36, 5);
    expect(cell.point(), "still inside the row").toEqual({ row: 0, col: 33 });
    t.resize(30, 5);
    expect(cell.point()).toEqual({ row: 0, col: 29 });
    t.resize(40, 5);
    expect(cell.point(), "a crop is not undone").toEqual({ row: 0, col: 29 });
    cell.free();
  });

  test("is freed once, and the terminal frees the cells still tracked when it goes", async () => {
    const t = await terminal(20, 6);
    t.write(WRAPPED);
    const live = tracked(t);
    const a = t.trackCell(0, 6)!;
    const b = t.trackCell(3, 17)!;
    const c = t.trackCell(5, 0)!;
    expect(live.size).toBe(3);
    expect(b.moveTo(1, 11), "a move is not a new reference").toBe(true);
    expect(live.size).toBe(3);
    a.free();
    a.free();
    expect(live.size).toBe(2);
    expect((t as unknown as { trackedCells: Set<unknown> }).trackedCells.size, "the terminal lets go of a freed cell").toBe(2);
    expect(a.point()).toBeNull();
    expect(a.moveTo(0, 6)).toBe(false);
    t.free();
    expect(live.size, "the terminal freed b and c").toBe(0);
    for (const cell of [b, c]) {
      expect(cell.point()).toBeNull();
      expect(cell.moveTo(0, 0)).toBe(false);
      expect(() => cell.free()).not.toThrow();
    }
    expect(live.size).toBe(0);
    expect(t.trackCell(0, 0), "a freed terminal tracks nothing").toBeNull();
  });
});

describe("beforeResize", () => {
  test("calls its listener before the core takes the new size, with the size it leaves", async () => {
    const t = await terminal(20, 6);
    t.write(WRAPPED);
    const scrollback = t.getScrollbackLength();
    const heard: unknown[] = [];
    const stop = t.beforeResize((from) => heard.push({ from, cols: t.cols, rows: t.rows, scrollback: t.getScrollbackLength() }));
    t.resize(12, 6);
    expect(heard).toEqual([{ from: { cols: 20, rows: 6 }, cols: 20, rows: 6, scrollback }]);
    expect(t.getScrollbackLength(), "the reflow came after").toBeGreaterThan(scrollback);
    t.resize(12, 6);
    expect(heard, "the same size again is no resize").toHaveLength(1);
    t.resize(12, 8);
    expect(heard.at(-1)).toMatchObject({ from: { cols: 12, rows: 6 } });
    stop();
    t.resize(20, 6);
    expect(heard).toHaveLength(2);
  });
});
