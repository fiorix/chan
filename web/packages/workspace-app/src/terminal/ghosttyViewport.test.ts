import { describe, expect, test, vi } from "vitest";
import {
  GHOSTTY_MACOS_PIXEL_SCROLL_FACTOR,
  GhosttyViewportController,
  type GhosttyViewportContext,
} from "./ghosttyViewport";

const DOM_DELTA_PIXEL = 0;
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

/// Fake ghostty-web terminal with its real viewport semantics: scrollLines
/// and scrollToLine clamp into [0, scrollback], and write() parses
/// synchronously then forces scrollToBottom() whenever the viewport sits
/// away from the bottom. The script `appendedByWrite` says how many
/// scrollback lines each write adds (negative trims). resize() fires the
/// resize event for a grid that changed, as ghostty-web's does.
function fakeGhostty(viewportY: number, scrollback: number) {
  const state = { viewportY, scrollback };
  const clamp = (v: number) => Math.max(0, Math.min(state.scrollback, v));
  const resizeListeners = new Set<(size: { cols: number; rows: number }) => void>();
  const term = {
    appendedByWrite: [] as number[],
    cols: 80,
    rows: 24,
    onResize: vi.fn((listener: (size: { cols: number; rows: number }) => void) => {
      resizeListeners.add(listener);
      return { dispose: () => resizeListeners.delete(listener) };
    }),
    resize(cols: number, rows: number) {
      if (cols === term.cols && rows === term.rows) return;
      term.cols = cols;
      term.rows = rows;
      for (const listener of resizeListeners) listener({ cols, rows });
    },
    getViewportY: vi.fn(() => state.viewportY),
    getScrollbackLength: vi.fn(() => state.scrollback),
    scrollLines: vi.fn((amount: number) => {
      state.viewportY = clamp(state.viewportY - amount);
    }),
    scrollToLine: vi.fn((line: number) => {
      state.viewportY = clamp(line);
    }),
    write: vi.fn((_data: string | Uint8Array) => {
      state.scrollback = Math.max(
        0,
        state.scrollback + (term.appendedByWrite.shift() ?? 0),
      );
      if (state.viewportY !== 0) state.viewportY = 0;
    }),
  };
  return { state, term };
}

function context(overrides: Partial<GhosttyViewportContext> = {}) {
  return {
    os: () => "mac",
    hasMouseTracking: () => false,
    isAlternateScreen: () => false,
    cellHeight: () => 20,
    ...overrides,
  };
}

describe("GhosttyViewportController writes", () => {
  test("a bottom viewport keeps following output across repeated writes", () => {
    const { state, term } = fakeGhostty(0, 20);
    term.appendedByWrite.push(3, 4);
    const controller = new GhosttyViewportController(term, context());

    controller.write("chunk1");
    controller.write("chunk2");

    expect(term.write).toHaveBeenCalledTimes(2);
    expect(term.scrollToLine).not.toHaveBeenCalled();
    expect(term.scrollLines).not.toHaveBeenCalled();
    expect(state.viewportY).toBe(0);
    expect(state.scrollback).toBe(27);
  });

  test("an anchored viewport rebases by the appended scrollback", () => {
    const { state, term } = fakeGhostty(7, 20);
    term.appendedByWrite.push(3);
    const controller = new GhosttyViewportController(term, context());

    controller.write("output");

    expect(term.scrollToLine).toHaveBeenCalledWith(10);
    expect(state.viewportY).toBe(10);
  });

  test("in-place redraw chunks that add no lines do not move the viewport", () => {
    const { state, term } = fakeGhostty(7, 20);
    term.appendedByWrite.push(0, 0, 0);
    const controller = new GhosttyViewportController(term, context());

    controller.write("\x1b[2K\rredraw");
    controller.write("\x1b[2K\rredraw");
    controller.write("\x1b[2K\rredraw");

    expect(term.scrollToLine).toHaveBeenCalledTimes(3);
    expect(term.scrollToLine).toHaveBeenLastCalledWith(7);
    expect(state.viewportY).toBe(7);
  });

  test("a scrollback clear or trim clamps the restored viewport", () => {
    const { state, term } = fakeGhostty(7, 20);
    term.appendedByWrite.push(-17);
    const controller = new GhosttyViewportController(term, context());

    controller.write("\x1b[3J");

    expect(term.scrollToLine).toHaveBeenCalledWith(3);
    expect(state.viewportY).toBe(3);
  });

  test("output interleaved with an upward gesture moves only by gesture plus anchor rebase", () => {
    const { state, term } = fakeGhostty(0, 20);
    term.appendedByWrite.push(3, 3);
    const controller = new GhosttyViewportController(term, context());

    // Two-finger scroll up twice (deltaY -100px each, 20px rows, factor
    // 0.5 = 2.5 rows per event) with streaming output between events.
    controller.handleWheel({ deltaY: -100, deltaMode: DOM_DELTA_PIXEL });
    expect(state.viewportY).toBe(2.5);
    controller.write("stream");
    expect(state.viewportY).toBe(5.5);
    controller.handleWheel({ deltaY: -100, deltaMode: DOM_DELTA_PIXEL });
    expect(state.viewportY).toBe(8);
    controller.write("stream");
    expect(state.viewportY).toBe(11);

    // The gesture plus the exact rebase, nothing else: repeated output
    // never converged the anchored viewport on the oldest retained line.
    expect(term.scrollLines.mock.calls.flat()).toEqual([-2.5, -2.5]);
    expect(term.scrollToLine.mock.calls.flat()).toEqual([5.5, 11]);
    expect(state.viewportY).toBe(11);
    expect(state.scrollback).toBe(26);
  });

  test("output interleaved with a downward gesture can reach and keep the bottom", () => {
    const { state, term } = fakeGhostty(5, 20);
    term.appendedByWrite.push(3);
    const controller = new GhosttyViewportController(term, context());

    controller.handleWheel({ deltaY: 100, deltaMode: DOM_DELTA_PIXEL });
    expect(state.viewportY).toBe(2.5);
    controller.handleWheel({ deltaY: 100, deltaMode: DOM_DELTA_PIXEL });
    expect(state.viewportY).toBe(0);
    controller.write("stream");

    // Once the gesture lands on the bottom, following is native again:
    // no restore runs and the live bottom stays reachable under output.
    expect(term.scrollToLine).not.toHaveBeenCalled();
    expect(state.viewportY).toBe(0);
  });

  test("programmatic writes never enter the user wheel path", () => {
    const { term } = fakeGhostty(7, 20);
    term.appendedByWrite.push(2);
    const controller = new GhosttyViewportController(term, context());

    controller.write("output");

    expect(term.scrollLines).not.toHaveBeenCalled();
  });

  test("change observers hear every write, after the anchored restore, until stopped", () => {
    const { state, term } = fakeGhostty(7, 20);
    term.appendedByWrite.push(3, 0, 0);
    const controller = new GhosttyViewportController(term, context());
    const seen: Array<[string, number]> = [];
    const stop = controller.observeChanges((change) => seen.push([change, state.viewportY]));

    controller.write("anchored");
    state.viewportY = 0;
    controller.write("at the bottom");
    stop();
    controller.write("unobserved");

    // The anchored write is observed after its restore, not between the
    // write and the restore.
    expect(seen).toEqual([
      ["write", 10],
      ["write", 0],
    ]);
  });

  test("change observers hear every resize the terminal reports, whoever resized it", () => {
    const { term } = fakeGhostty(0, 20);
    const controller = new GhosttyViewportController(term, context());
    const seen: string[] = [];
    const stop = controller.observeChanges((change) => seen.push(change));

    // Through ghostty-web's own resize, not a method of the controller: the
    // fit, a broadcast grid and ghostty-web's option setter all end there.
    term.resize(60, 24);
    term.resize(60, 24);
    term.resize(60, 30);
    stop();
    term.resize(80, 24);

    // An unchanged grid fires no event.
    expect(seen).toEqual(["resize", "resize"]);
    expect(term.onResize).toHaveBeenCalledTimes(1);
  });
});

describe("GhosttyViewportController reveal", () => {
  // 100 rows of history on a ten-row screen.
  test.each([
    ["on the screen at the bottom", 0, 105, null],
    ["on the screen scrolled back", 30, 75, null],
    ["above the screen, centred", 0, 50, 55],
    ["below the screen, centred", 100, 60, 45],
    ["near the oldest row, clamped to the top", 0, 2, 100],
    ["near the newest row, clamped to the bottom", 100, 108, 0],
  ])("a row %s", (_name, from, row, to) => {
    const { term } = fakeGhostty(from, 100);
    term.rows = 10;
    new GhosttyViewportController(term, context()).reveal(row);
    if (to === null) expect(term.scrollToLine).not.toHaveBeenCalled();
    else expect(term.scrollToLine.mock.calls).toEqual([[to]]);
  });
});

describe("GhosttyViewportController wheel decision matrix", () => {
  const matrix: {
    name: string;
    overrides: Partial<GhosttyViewportContext>;
    deltaMode: number;
    claimed: boolean;
  }[] = [
    {
      name: "macOS pixel, primary buffer, no tracking: claimed and scaled",
      overrides: {},
      deltaMode: DOM_DELTA_PIXEL,
      claimed: true,
    },
    {
      name: "mouse tracking active: declined (report path owns the event)",
      overrides: { hasMouseTracking: () => true },
      deltaMode: DOM_DELTA_PIXEL,
      claimed: false,
    },
    {
      name: "alternate screen: declined (arrow synthesis owns the event)",
      overrides: { isAlternateScreen: () => true },
      deltaMode: DOM_DELTA_PIXEL,
      claimed: false,
    },
    {
      name: "line-mode delta: declined",
      overrides: {},
      deltaMode: DOM_DELTA_LINE,
      claimed: false,
    },
    {
      name: "page-mode delta: declined",
      overrides: {},
      deltaMode: DOM_DELTA_PAGE,
      claimed: false,
    },
    {
      name: "linux pixel: declined",
      overrides: { os: () => "linux" },
      deltaMode: DOM_DELTA_PIXEL,
      claimed: false,
    },
    {
      name: "windows pixel: declined",
      overrides: { os: () => "windows" },
      deltaMode: DOM_DELTA_PIXEL,
      claimed: false,
    },
  ];

  for (const row of matrix) {
    test(row.name, () => {
      const { term } = fakeGhostty(10, 20);
      const controller = new GhosttyViewportController(
        term,
        context(row.overrides),
      );

      expect(
        controller.handleWheel({ deltaY: 100, deltaMode: row.deltaMode }),
      ).toBe(row.claimed);
      expect(term.scrollLines.mock.calls.length).toBe(row.claimed ? 1 : 0);
    });
  }

  test("declines when cell metrics are unavailable, leaving native handling", () => {
    const { term } = fakeGhostty(10, 20);
    const controller = new GhosttyViewportController(
      term,
      context({ cellHeight: () => 0 }),
    );

    expect(
      controller.handleWheel({ deltaY: 100, deltaMode: DOM_DELTA_PIXEL }),
    ).toBe(false);
    expect(term.scrollLines).not.toHaveBeenCalled();
  });

  test("wheel input never writes to the terminal", () => {
    const { term } = fakeGhostty(10, 20);
    const controller = new GhosttyViewportController(term, context());

    controller.handleWheel({ deltaY: 100, deltaMode: DOM_DELTA_PIXEL });

    expect(term.write).not.toHaveBeenCalled();
  });
});

describe("GhosttyViewportController macOS pixel travel", () => {
  test("pins the calibrated 0.5 factor in both directions", () => {
    expect(GHOSTTY_MACOS_PIXEL_SCROLL_FACTOR).toBe(0.5);
    const { term } = fakeGhostty(10, 20);
    const controller = new GhosttyViewportController(term, context());

    controller.handleWheel({ deltaY: 100, deltaMode: DOM_DELTA_PIXEL });
    controller.handleWheel({ deltaY: -100, deltaMode: DOM_DELTA_PIXEL });

    // 100px at 20px rows with factor 0.5 is 2.5 rows; factor 1 would
    // move 5. A dead-zone implementation would move 0.
    expect(term.scrollLines.mock.calls.flat()).toEqual([2.5, -2.5]);
  });

  test("preserves fractional accumulation across small pixel deltas", () => {
    const { state, term } = fakeGhostty(10, 20);
    const controller = new GhosttyViewportController(term, context());

    // 8px per event is 0.2 scaled rows: below one row per event, so any
    // whole-row quantization would discard the gesture entirely.
    for (let i = 0; i < 5; i++) {
      controller.handleWheel({ deltaY: 8, deltaMode: DOM_DELTA_PIXEL });
    }

    expect(term.scrollLines.mock.calls.flat()).toEqual([
      0.2, 0.2, 0.2, 0.2, 0.2,
    ]);
    expect(state.viewportY).toBeCloseTo(9, 10);
  });

  test("a momentum-like decaying sequence accumulates continuous travel", () => {
    const { state, term } = fakeGhostty(10, 40);
    const controller = new GhosttyViewportController(term, context());

    for (const deltaY of [200, 120, 60, 20]) {
      controller.handleWheel({ deltaY, deltaMode: DOM_DELTA_PIXEL });
    }

    expect(term.scrollLines.mock.calls.flat()).toEqual([5, 3, 1.5, 0.5]);
    expect(state.viewportY).toBeCloseTo(0, 10);
  });

  test("a zero-delta event claims without moving the viewport", () => {
    const { state, term } = fakeGhostty(10, 20);
    const controller = new GhosttyViewportController(term, context());

    expect(
      controller.handleWheel({ deltaY: 0, deltaMode: DOM_DELTA_PIXEL }),
    ).toBe(true);
    expect(term.scrollLines).not.toHaveBeenCalled();
    expect(state.viewportY).toBe(10);
  });
});
