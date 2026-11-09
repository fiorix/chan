import { readFileSync } from "node:fs";
import type { GhosttyCell } from "ghostty-web";
import { beforeAll, describe, expect, test } from "vitest";
import { ABI, GhosttyVt, LAYOUT, type MatchRange, type VtSearch, VtTerminal } from "./ghosttyVt";

const VENDORED = "vendor/ghostty-vt/ghostty-vt.wasm";

let vendored: WebAssembly.Module;

beforeAll(async () => {
  vendored = await WebAssembly.compile(readFileSync(VENDORED));
});

async function terminal(cols: number, rows: number, scrollbackLimit = 1000): Promise<VtTerminal> {
  const vt = new GhosttyVt(await WebAssembly.instantiate(vendored, {}));
  return vt.createTerminal(cols, rows, { scrollbackLimit }) as unknown as VtTerminal;
}

/// Writes `n` lines, each ended by CRLF, a thousand at a time.
function lines(t: VtTerminal, n: number, line: (i: number) => string): void {
  for (let from = 0; from < n; from += 1000) {
    const count = Math.min(1000, n - from);
    t.write(Array.from({ length: count }, (_, i) => line(from + i) + "\r\n").join(""));
  }
}

const range = (startRow: number, startCol: number, endRow: number, endCol: number): MatchRange => ({
  startRow,
  startCol,
  endRow,
  endCol,
});

/// Steps the search to completion; bounded, so a scan that never completes
/// fails rather than hangs.
function scan(s: VtSearch): void {
  for (let i = 0; i < 100_000; i++) if (s.step(1) === "complete") return;
  throw new Error("the search did not complete");
}

function text(cells: GhosttyCell[] | null): string {
  return (cells ?? [])
    .map((c) => (c.width === 0 ? "" : c.codepoint ? String.fromCodePoint(c.codepoint) : " "))
    .join("")
    .trimEnd();
}

/// Twelve lines on an 80x5 terminal, every third one with an upper-case
/// ERROR: four matches of "error" at column 7, three of them in history.
async function errorTerminal(): Promise<VtTerminal> {
  const t = await terminal(80, 5);
  lines(t, 12, (i) => `line ${i} ${i % 3 === 0 ? "ERROR here" : "fine"}`);
  return t;
}

const ERRORS = [range(9, 7, 9, 11), range(6, 7, 6, 11), range(3, 7, 3, 11), range(0, 7, 0, 11)];

/// The binding's privates a test reaches for: the wasm instance and the
/// core handle of a terminal or a search.
type Raw = {
  wasm: {
    fn: Record<string, (...args: number[]) => number>;
    view(): DataView;
    alloc(len: number): number;
    free(ptr: number, len: number): void;
  };
  handle: number;
};
const raw = (o: unknown): Raw => o as Raw;

/// The blocks and opaque slots taken from `t`'s allocator from here on and
/// not given back yet, each described by its size.
function liveAllocations(t: VtTerminal): Map<number, string> {
  const fn = raw(t).wasm.fn;
  const live = new Map<number, string>();
  const { ghostty_wasm_alloc: alloc, ghostty_wasm_free: free } = fn;
  const { ghostty_wasm_alloc_opaque: allocOpaque, ghostty_wasm_free_opaque: freeOpaque } = fn;
  fn.ghostty_wasm_alloc = (len) => {
    const ptr = alloc(len);
    if (ptr) live.set(ptr, `${len} bytes`);
    return ptr;
  };
  fn.ghostty_wasm_free = (ptr, len) => {
    live.delete(ptr);
    return free(ptr, len);
  };
  fn.ghostty_wasm_alloc_opaque = () => {
    const ptr = allocOpaque();
    if (ptr) live.set(ptr, "an opaque slot");
    return ptr;
  };
  fn.ghostty_wasm_free_opaque = (ptr) => {
    live.delete(ptr);
    return freeOpaque(ptr);
  };
  return live;
}

describe("a search over the binding's terminal", () => {
  test("lists matches newest first and selects them in that order, wrapping", async () => {
    const t = await errorTerminal();
    const s = t.createSearch();
    expect(s.state(), "idle at creation").toEqual({ total: 0, index: null, active: null, complete: true });
    s.setNeedle("error");
    expect(s.state(), "a needle waits for the scan").toEqual({ total: 0, index: null, active: null, complete: false });
    scan(s);
    expect(t.getScrollbackLength()).toBe(8);
    expect(s.state()).toEqual({ total: 4, index: null, active: null, complete: true });
    expect(s.matchesBetween(0, 9, 10)).toEqual(ERRORS);
    const seen: [number | null, MatchRange | null][] = [];
    for (let i = 0; i < 5; i++) {
      expect(s.selectNext()).toBe(true);
      const state = s.state();
      seen.push([state.index, state.active]);
    }
    expect(seen).toEqual([[0, ERRORS[0]], [1, ERRORS[1]], [2, ERRORS[2]], [3, ERRORS[3]], [0, ERRORS[0]]]);
    expect(s.selectPrev()).toBe(true);
    expect(s.state()).toEqual({ total: 4, index: 3, active: ERRORS[3], complete: true });
    s.free();
  });

  test("matchesBetween keeps to the rows that touch the window and to the cap", async () => {
    const t = await errorTerminal();
    const s = t.createSearch();
    s.setNeedle("error");
    scan(s);
    expect(s.matchesBetween(3, 6, 10)).toEqual([ERRORS[1], ERRORS[2]]);
    expect(s.matchesBetween(0, 9, 2)).toEqual([ERRORS[0], ERRORS[1]]);
    expect(s.matchesBetween(4, 5, 10)).toEqual([]);
    expect(s.matchesBetween(9, 20, 10)).toEqual([ERRORS[0]]);
    expect(s.matchesBetween(0, 9, 0)).toEqual([]);
    s.free();
  });

  test("the same needle keeps the results and another one restarts the scan", async () => {
    const t = await errorTerminal();
    const s = t.createSearch();
    s.setNeedle("error");
    scan(s);
    s.selectNext();
    s.selectNext();
    s.setNeedle("ERROR");
    expect(s.state()).toEqual({ total: 4, index: 1, active: ERRORS[1], complete: true });
    s.setNeedle("fine");
    expect(s.state()).toEqual({ total: 0, index: null, active: null, complete: false });
    scan(s);
    expect(s.state()).toEqual({ total: 8, index: null, active: null, complete: true });
    s.free();
  });

  test("new output keeps the selected match on its text while its index grows", async () => {
    const t = await errorTerminal();
    const s = t.createSearch();
    s.setNeedle("error");
    scan(s);
    for (let i = 0; i < 4; i++) s.selectNext();
    expect(s.state()).toMatchObject({ index: 3, active: ERRORS[3] });
    t.write("new ERROR one\r\nnew error two\r\n");
    // No feed yet: the state reads the terminal as it is now, not the last
    // feed's count of four.
    expect(s.state()).toMatchObject({ total: 6, index: 5, active: ERRORS[3] });
    scan(s);
    expect(s.state()).toEqual({ total: 6, index: 5, active: ERRORS[3], complete: true });
    expect(s.matchesBetween(12, 13, 10)).toEqual([range(13, 4, 13, 8), range(12, 4, 12, 8)]);
    s.free();
  });

  test("a read feeds the core only when the terminal changed since the last feed", async () => {
    const t = await errorTerminal();
    const s = t.createSearch();
    s.setNeedle("error");
    scan(s);
    const { wasm } = raw(s);
    const real = wasm.fn.ghostty_search_feed;
    let feeds = 0;
    wasm.fn.ghostty_search_feed = (...args) => {
      feeds++;
      return real(...args);
    };
    try {
      s.state();
      s.matchesBetween(0, 20, 10);
      expect(feeds, "nothing changed").toBe(0);
      t.write("x");
      s.state();
      s.matchesBetween(0, 20, 10);
      expect(feeds, "one write, one feed").toBe(1);
      t.write("y");
      s.feed();
      s.state();
      expect(feeds, "an explicit feed is the one").toBe(2);
      t.resize(81, 5);
      s.state();
      expect(feeds, "a resize changes the terminal").toBe(3);
      t.write("z");
      expect(s.selectNext()).toBe(true);
      s.state();
      expect(feeds, "a select catches up on its own").toBe(3);
      t.write("w");
      expect(s.step(1)).toBe("complete");
      s.state();
      expect(feeds, "a step feeds when the search asks").toBe(4);
    } finally {
      wasm.fn.ghostty_search_feed = real;
    }
    s.free();
  });

  test("a needle across a soft wrap spans two rows", async () => {
    const t = await terminal(20, 5);
    t.write("x".repeat(17) + "needle\r\n");
    const s = t.createSearch();
    s.setNeedle("needle");
    scan(s);
    const wrapped = range(0, 17, 1, 2);
    expect(s.state().total).toBe(1);
    expect(s.selectNext()).toBe(true);
    expect(s.state().active).toEqual(wrapped);
    expect(s.matchesBetween(0, 0, 10), "touching by its first row").toEqual([wrapped]);
    expect(s.matchesBetween(1, 1, 10), "touching by its last row").toEqual([wrapped]);
    expect(s.matchesBetween(2, 4, 10)).toEqual([]);
    s.free();
  });

  test("columns count a wide character as two cells", async () => {
    const t = await terminal(40, 5);
    t.write("中文 target\r\n");
    const s = t.createSearch();
    s.setNeedle("target");
    scan(s);
    expect(s.selectNext()).toBe(true);
    expect(s.state()).toEqual({ total: 1, index: 0, active: range(0, 5, 0, 10), complete: true });
    s.free();
  });

  test("the alternate screen has its own matches and the primary's come back", async () => {
    const t = await errorTerminal();
    const s = t.createSearch();
    s.setNeedle("error");
    scan(s);
    s.selectNext();
    s.selectNext();
    expect(s.state()).toMatchObject({ total: 4, index: 1, active: ERRORS[1] });
    t.write("\x1b[?1049h\x1b[Hvim buffer error ERROR\r\n");
    s.feed();
    scan(s);
    // Alternate-screen rows are its own, with no history before them.
    expect(t.getScrollbackLength()).toBe(0);
    expect(s.state()).toEqual({ total: 2, index: null, active: null, complete: true });
    expect(s.matchesBetween(0, 4, 10)).toEqual([range(0, 17, 0, 21), range(0, 11, 0, 15)]);
    expect(s.selectNext()).toBe(true);
    expect(s.state()).toMatchObject({ index: 0, active: range(0, 17, 0, 21) });
    t.write("\x1b[?1049l");
    s.feed();
    scan(s);
    expect(s.state()).toEqual({ total: 4, index: 1, active: ERRORS[1], complete: true });
    s.free();
  });

  test("ASCII letters compare case-insensitively and other letters byte-exact", async () => {
    const t = await terminal(40, 5);
    t.write("Élan élan ELAN elan\r\n");
    const s = t.createSearch();
    const totals: Record<string, number> = {};
    for (const needle of ["elan", "élan", "Élan", "ÉLAN", "ÉLÁN"]) {
      s.setNeedle(needle);
      scan(s);
      totals[needle] = s.state().total;
    }
    expect(totals).toEqual({ elan: 2, "élan": 1, "Élan": 1, "ÉLAN": 1, "ÉLÁN": 0 });
    s.setNeedle("elan");
    scan(s);
    expect(s.matchesBetween(0, 0, 10)).toEqual([range(0, 15, 0, 18), range(0, 10, 0, 13)]);
    s.setNeedle("élan");
    scan(s);
    expect(s.matchesBetween(0, 0, 10)).toEqual([range(0, 5, 0, 8)]);
    s.free();
  });

  test("pruned history drops the matches it held and shifts the rows of the rest", async () => {
    const t = await terminal(80, 5, 1000);
    t.write("early needle\r\n");
    lines(t, 899, (i) => `filler ${i} ${"x".repeat(40)}`);
    t.write("late needle\r\n");
    const s = t.createSearch();
    s.setNeedle("needle");
    scan(s);
    expect(s.state().total).toBe(2);
    expect(s.selectNext()).toBe(true);
    expect(s.state()).toMatchObject({ index: 0, active: range(900, 5, 900, 10) });
    // Write until the core prunes a page of history.
    const before = t.getScrollbackLength();
    let last = before;
    let added = 0;
    for (;;) {
      t.write(`filler ${added} ${"y".repeat(40)}\r\n`);
      added++;
      const now = t.getScrollbackLength();
      if (now < last) break;
      last = now;
      if (added > 5000) throw new Error("the history was never pruned");
    }
    const pruned = before + added - t.getScrollbackLength();
    expect(pruned).toBeGreaterThan(0);
    // No feed yet: the state reads the rows as they are now, not the match
    // snapshot the prune invalidated.
    const after = s.state();
    expect(after.total, "the early match went with its page").toBe(1);
    expect(after.index).toBe(0);
    expect(after.active).toEqual(range(900 - pruned, 5, 900 - pruned, 10));
    s.feed();
    scan(s);
    expect(s.state(), "a feed changes nothing").toEqual({ ...after, complete: true });
    s.free();
  });

  test("a resize drops the selected match and scans again, to the same matches on their reflowed rows", async () => {
    // Find relies on this: after a resize there is no active match to move a
    // highlight to, and a select starts the walk over.
    const t = await terminal(20, 6);
    t.write(
      [
        "first needle a",
        `${"x".repeat(10)} needle b ${"y".repeat(12)}`,
        `${"z".repeat(17)}needle c`,
        "needle d",
      ].map((line) => `${line}\r\n`).join(""),
    );
    const s = t.createSearch();
    s.setNeedle("needle");
    scan(s);
    s.selectNext();
    s.selectNext();
    expect(s.state()).toMatchObject({ total: 4, index: 1, active: range(3, 17, 4, 2) });
    for (const [cols, rows] of [
      [12, 6],
      [12, 8],
      [33, 6],
    ] as const) {
      t.resize(cols, rows);
      s.feed();
      expect(s.state(), `${cols}x${rows}, rows only or reflowing`).toMatchObject({ index: null, active: null, complete: false });
      scan(s);
      const fresh = t.createSearch();
      fresh.setNeedle("needle");
      scan(fresh);
      expect(s.state()).toEqual({ total: 4, index: null, active: null, complete: true });
      expect(s.matchesBetween(0, 100, 10)).toEqual(fresh.matchesBetween(0, 100, 10));
      fresh.free();
      // Selected again, so the next resize has a match to drop.
      expect(s.selectNext()).toBe(true);
      expect(s.state().index).toBe(0);
    }
    // A select toward newer output from no selection lands on the oldest.
    t.resize(20, 6);
    s.feed();
    scan(s);
    expect(s.selectPrev()).toBe(true);
    expect(s.state()).toMatchObject({ index: 3, active: range(0, 6, 0, 11) });
    s.free();
  });

  test("an empty needle returns the search to idle", async () => {
    const t = await errorTerminal();
    const s = t.createSearch();
    s.setNeedle("error");
    scan(s);
    s.selectNext();
    s.setNeedle("");
    expect(s.state()).toEqual({ total: 0, index: null, active: null, complete: true });
    expect(s.matchesBetween(0, 9, 10)).toEqual([]);
    expect(s.selectNext()).toBe(false);
    expect(s.step(1)).toBe("complete");
    s.free();
  });

  test("a terminal freed before its search leaves the search inert", async () => {
    const t = await errorTerminal();
    const s = t.createSearch();
    s.setNeedle("error");
    scan(s);
    s.selectNext();
    t.free();
    expect(s.state()).toEqual({ total: 0, index: null, active: null, complete: true });
    expect(s.matchesBetween(0, 9, 10)).toEqual([]);
    expect(s.selectNext()).toBe(false);
    expect(s.selectPrev()).toBe(false);
    expect(s.step(1)).toBe("complete");
    expect(() => s.feed()).not.toThrow();
    expect(() => s.setNeedle("fine")).not.toThrow();
    expect(() => s.free()).not.toThrow();
    expect(() => s.free(), "freeing again").not.toThrow();
    expect(() => t.createSearch(), "a freed terminal has no search").toThrow(/creating search failed/);
  });

  test("a search freed before its terminal, and twice", async () => {
    const t = await errorTerminal();
    const s = t.createSearch();
    s.setNeedle("error");
    scan(s);
    s.free();
    expect(() => s.free()).not.toThrow();
    expect(s.state()).toEqual({ total: 0, index: null, active: null, complete: true });
    t.write("more\r\n");
    expect(text(t.getLine(0))).toBe("line 9 ERROR here");
    t.free();
  });
});

describe("a search the core fails to make", () => {
  test("a search made keeps one block, its scratch area, until it is freed", async () => {
    const t = await errorTerminal();
    const live = liveAllocations(t);
    const s = t.createSearch();
    expect([...live.values()]).toEqual(["48 bytes"]);
    s.free();
    expect([...live.values()]).toEqual([]);
  });

  test.each([
    // upstream's GHOSTTY_OUT_OF_MEMORY
    ["refuses it", (t: VtTerminal) => void (raw(t).wasm.fn.ghostty_search_new = () => -1), /creating search failed \(-1\)/],
    [
      "traps",
      (t: VtTerminal) =>
        void (raw(t).wasm.fn.ghostty_search_new = () => {
          throw new WebAssembly.RuntimeError("unreachable");
        }),
      /unreachable/,
    ],
    ["has no terminal", (t: VtTerminal) => t.free(), /creating search failed/],
  ])("a core that %s keeps none of the memory the search took", async (_, arrange, error) => {
    const t = await errorTerminal();
    arrange(t);
    const live = liveAllocations(t);
    expect(() => t.createSearch()).toThrow(error);
    expect([...live.values()], "every block the failed search took is back").toEqual([]);
  });
});

describe("the scroll policy", () => {
  /// The row of history row 0 in upstream's viewport, null when the viewport
  /// does not show it.
  function viewportRowOfHistoryTop(t: VtTerminal): number | null {
    const { wasm, handle } = raw(t);
    const P = LAYOUT.GhosttyPoint;
    const C = LAYOUT.GhosttyPointCoordinate;
    const block = wasm.alloc(48);
    const point = block;
    const ref = block + P.size;
    const coord = ref + LAYOUT.GhosttyGridRef.size;
    try {
      const view = wasm.view();
      view.setInt32(point + P.fields.tag, ABI.GhosttyPointTag.HISTORY, true);
      view.setUint16(point + P.fields.value + C.fields.x, 0, true);
      view.setUint32(point + P.fields.value + C.fields.y, 0, true);
      expect(wasm.fn.ghostty_terminal_grid_ref(handle, point, ref)).toBe(ABI.GhosttyResult.SUCCESS);
      const result = wasm.fn.ghostty_terminal_point_from_grid_ref(handle, ref, ABI.GhosttyPointTag.VIEWPORT, coord);
      if (result === ABI.GhosttyResult.NO_VALUE) return null;
      expect(result).toBe(ABI.GhosttyResult.SUCCESS);
      return wasm.view().getUint32(coord + C.fields.y, true);
    } finally {
      wasm.free(block, 48);
    }
  }

  function scrollPolicy(s: VtSearch): number {
    const { wasm, handle } = raw(s);
    const out = wasm.alloc(4);
    try {
      expect(wasm.fn.ghostty_search_get(handle, ABI.GhosttySearchData.SELECT_SCROLL, out)).toBe(ABI.GhosttyResult.SUCCESS);
      return wasm.view().getInt32(out, true);
    } finally {
      wasm.free(out, 4);
    }
  }

  function setScrollPolicy(s: VtSearch, policy: number): void {
    const { wasm, handle } = raw(s);
    const value = wasm.alloc(4);
    try {
      wasm.view().setInt32(value, policy, true);
      expect(wasm.fn.ghostty_search_set(handle, ABI.GhosttySearchOption.SELECT_SCROLL, value)).toBe(ABI.GhosttyResult.SUCCESS);
    } finally {
      wasm.free(value, 4);
    }
  }

  async function needleInHistory() {
    const t = await terminal(40, 5);
    t.write("old needle line\r\n");
    lines(t, 30, (i) => `filler ${i}`);
    const s = t.createSearch();
    s.setNeedle("needle");
    scan(s);
    expect(s.state().total).toBe(1);
    expect(viewportRowOfHistoryTop(t), "the viewport starts at the bottom").toBeNull();
    return { t, s };
  }

  test("a search is created with NONE, so selecting leaves upstream's viewport at the bottom", async () => {
    const { t, s } = await needleInHistory();
    expect(scrollPolicy(s)).toBe(ABI.GhosttySearchScroll.NONE);
    expect(s.selectNext()).toBe(true);
    expect(s.state().active).toEqual(range(0, 4, 0, 9));
    expect(viewportRowOfHistoryTop(t)).toBeNull();
    t.write("after\r\n");
    expect(viewportRowOfHistoryTop(t)).toBeNull();
    expect(text(t.getLine(0)), "the render state is still the active screen").toBe("filler 27");
    s.free();
  });

  test("with the core's default, IF_NEEDED, a select scrolls the viewport and the render state follows", async () => {
    const { t, s } = await needleInHistory();
    setScrollPolicy(s, ABI.GhosttySearchScroll.IF_NEEDED);
    expect(s.selectNext()).toBe(true);
    expect(s.state().active).toEqual(range(0, 4, 0, 9));
    expect(viewportRowOfHistoryTop(t)).toBe(0);
    t.write("after\r\n");
    expect(viewportRowOfHistoryTop(t), "a write does not bring it back").toBe(0);
    expect(text(t.getLine(0)), "the render state shows history as the active screen").toBe("old needle line");
    s.free();
  });
});

describe("a large scrollback", () => {
  test("a tiny step budget returns running before complete and ends on the full count", async () => {
    const t = await terminal(120, 40, 20_000);
    lines(t, 25_000, (i) => `${i} some build output text ${i % 4 === 0 ? "warning: unused" : "ok"} padding padding`);
    expect(t.getScrollbackLength()).toBeGreaterThan(15_000);
    const s = t.createSearch();
    s.setNeedle("warning");
    const results: string[] = [];
    for (let i = 0; i < 1_000_000; i++) {
      const result = s.step(0);
      results.push(result);
      if (result === "complete") break;
    }
    expect(results[0]).toBe("running");
    expect(results.at(-1)).toBe("complete");
    expect(results.length).toBeGreaterThan(2);
    const expected = (t.plainText() ?? "").split("\n").filter((line) => line.includes("warning")).length;
    expect(expected).toBeGreaterThan(4000);
    expect(s.state()).toEqual({ total: expected, index: null, active: null, complete: true });
    expect(s.step(0), "nothing left to scan").toBe("complete");
    // A blocking scan from scratch finds the same.
    const control = t.createSearch();
    control.setNeedle("warning");
    expect(control.step(Infinity)).toBe("complete");
    expect(control.state().total).toBe(expected);
    expect(control.selectNext()).toBe(true);
    // The last line's CRLF leaves the cursor on an empty row below it, so
    // line 24,999 is the row above the last one; 24,996 is the last warning.
    const lastLine = t.getScrollbackLength() + 40 - 2;
    expect(control.state().active).toEqual(range(lastLine - 3, 29, lastLine - 3, 35));
    control.free();
    s.free();
  });
});
