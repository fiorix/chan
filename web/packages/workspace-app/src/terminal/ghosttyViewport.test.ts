import { describe, expect, test, vi } from "vitest";
import {
  GHOSTTY_MACOS_PIXEL_SCROLL_FACTOR,
  GhosttyViewportController,
  type GhosttyViewportContext,
} from "./ghosttyViewport";

const DOM_DELTA_PIXEL = 0;
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

/// A widget double with the public viewport. Scripted history growth
/// covers the adapter's wheel decisions; ghosttyViewport.change.test.ts
/// checks the ownership against the real widget.
function fakeGhostty(viewportY: number, scrollback: number) {
  const state = { viewportY, scrollback };
  const clamp = (v: number) => Math.max(0, Math.min(state.scrollback, v));
  const term = {
    appendedByWrite: [] as number[],
    cols: 80,
    rows: 24,
    viewport: {
      get offset() { return state.viewportY; },
      followOutput: "at-bottom" as const,
      scrollTo: vi.fn((offset: number) => { state.viewportY = clamp(offset); }),
      scrollBy: vi.fn((rows: number) => { state.viewportY = clamp(state.viewportY + rows); }),
      scrollToBottom: vi.fn(() => { state.viewportY = 0; }),
    },
    getScrollbackLength: vi.fn(() => state.scrollback),
    write: vi.fn((_data: string | Uint8Array) => {
      const before = state.scrollback;
      state.scrollback = Math.max(0, before + (term.appendedByWrite.shift() ?? 0));
      const growth = state.viewportY >= 1 ? Math.max(0, state.scrollback - before) : 0;
      state.viewportY = clamp(state.viewportY + growth);
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
    expect(term.viewport.scrollTo).not.toHaveBeenCalled();
    expect(term.viewport.scrollBy).not.toHaveBeenCalled();
    expect(state.viewportY).toBe(0);
    expect(state.scrollback).toBe(27);
  });

  test("an anchored viewport rebases by the appended scrollback", () => {
    const { state, term } = fakeGhostty(7, 20);
    term.appendedByWrite.push(3);
    const controller = new GhosttyViewportController(term, context());

    controller.write("output");

    expect(term.viewport.scrollTo).not.toHaveBeenCalled();
    expect(state.viewportY).toBe(10);
  });

  // A pixel scroll leaves the offset a fraction of a row back. Less than a
  // row back the view shows no history row: the bottom view, its prompt and
  // cursor, which follows output as at the bottom, while the fraction the
  // gesture gathered is kept for the next wheel delta to add to. A whole
  // row or more back the view is anchored.
  test("a view at the bottom follows output natively", () => {
    const { state, term } = fakeGhostty(0, 20);
    term.appendedByWrite.push(3, 1);
    const controller = new GhosttyViewportController(term, context());

    controller.write("line\r\n");
    controller.write("more\r\n");

    expect(term.viewport.scrollTo).not.toHaveBeenCalled();
    expect(state.viewportY).toBe(0);
    expect(state.scrollback).toBe(24);
  });

  test.each([0.3, 0.999])("a view %s rows back follows output and keeps its fraction", (offset) => {
    const { state, term } = fakeGhostty(offset, 20);
    term.appendedByWrite.push(3, 1);
    const controller = new GhosttyViewportController(term, context());

    controller.write("line\r\n");
    expect(state.viewportY).toBe(offset);
    controller.write("more\r\n");

    // The same fraction, not the bottom and not the fraction plus the
    // appended rows: the view still shows no history row.
    expect(term.viewport.scrollTo).not.toHaveBeenCalled();
    expect(state.viewportY).toBe(offset);
    expect(Math.floor(state.viewportY)).toBe(0);
    expect(state.scrollback).toBe(24);
  });

  test("a slow gesture under streaming output gathers its fraction until it leaves the bottom", () => {
    const { state, term } = fakeGhostty(0, 20);
    const controller = new GhosttyViewportController(term, context());
    // 20px rows and the 0.5 factor: an 8px delta is 0.2 of a row up.
    const gentle = { deltaY: -8, deltaMode: DOM_DELTA_PIXEL };

    for (let i = 1; i <= 5; i++) {
      controller.handleWheel(gentle);
      term.appendedByWrite.push(1);
      controller.write(`line ${i}\r\n`);
      if (i < 5) expect(Math.floor(state.viewportY), `after delta ${i}`).toBe(0);
    }
    // Five deltas reach a whole row: that write already anchored the view,
    // and the next one keeps it on its rows as output grows the history.
    expect(state.viewportY).toBe(2);
    term.appendedByWrite.push(2);
    controller.write("two more\r\n\r\n");
    expect(state.viewportY).toBe(4);
  });

  test.each([
    [1, 5],
    [1.5, 5.5],
  ])("a view %s rows back stays anchored on its rows under output", (offset, anchored) => {
    const { state, term } = fakeGhostty(offset, 20);
    term.appendedByWrite.push(3, 1);
    const controller = new GhosttyViewportController(term, context());

    controller.write("line\r\n");
    controller.write("more\r\n");

    expect(term.viewport.scrollTo).not.toHaveBeenCalled();
    expect(state.viewportY).toBe(anchored);
  });

  test("in-place redraw chunks that add no lines do not move the viewport", () => {
    const { state, term } = fakeGhostty(7, 20);
    term.appendedByWrite.push(0, 0, 0);
    const controller = new GhosttyViewportController(term, context());

    controller.write("\x1b[2K\rredraw");
    controller.write("\x1b[2K\rredraw");
    controller.write("\x1b[2K\rredraw");

    expect(term.viewport.scrollTo).not.toHaveBeenCalled();
    expect(state.viewportY).toBe(7);
  });

  test("a scrollback clear or trim clamps the viewport", () => {
    const { state, term } = fakeGhostty(7, 20);
    term.appendedByWrite.push(-17);
    const controller = new GhosttyViewportController(term, context());

    controller.write("\x1b[3J");

    expect(term.viewport.scrollTo).not.toHaveBeenCalled();
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
    expect(term.viewport.scrollBy.mock.calls.flat()).toEqual([2.5, 2.5]);
    expect(term.viewport.scrollTo).not.toHaveBeenCalled();
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
    expect(term.viewport.scrollTo).not.toHaveBeenCalled();
    expect(state.viewportY).toBe(0);
  });

  test("programmatic writes never enter the user wheel path", () => {
    const { term } = fakeGhostty(7, 20);
    term.appendedByWrite.push(2);
    const controller = new GhosttyViewportController(term, context());

    controller.write("output");

    expect(term.viewport.scrollBy).not.toHaveBeenCalled();
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
      expect(term.viewport.scrollBy.mock.calls.length).toBe(row.claimed ? 1 : 0);
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
    expect(term.viewport.scrollBy).not.toHaveBeenCalled();
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
    expect(term.viewport.scrollBy.mock.calls.flat()).toEqual([-2.5, 2.5]);
  });

  test("preserves fractional accumulation across small pixel deltas", () => {
    const { state, term } = fakeGhostty(10, 20);
    const controller = new GhosttyViewportController(term, context());

    // 8px per event is 0.2 scaled rows: below one row per event, so any
    // whole-row quantization would discard the gesture entirely.
    for (let i = 0; i < 5; i++) {
      controller.handleWheel({ deltaY: 8, deltaMode: DOM_DELTA_PIXEL });
    }

    expect(term.viewport.scrollBy.mock.calls.flat()).toEqual([
      -0.2, -0.2, -0.2, -0.2, -0.2,
    ]);
    expect(state.viewportY).toBeCloseTo(9, 10);
  });

  test("a momentum-like decaying sequence accumulates continuous travel", () => {
    const { state, term } = fakeGhostty(10, 40);
    const controller = new GhosttyViewportController(term, context());

    for (const deltaY of [200, 120, 60, 20]) {
      controller.handleWheel({ deltaY, deltaMode: DOM_DELTA_PIXEL });
    }

    expect(term.viewport.scrollBy.mock.calls.flat()).toEqual([-5, -3, -1.5, -0.5]);
    expect(state.viewportY).toBeCloseTo(0, 10);
  });

  test("a zero-delta event claims without moving the viewport", () => {
    const { state, term } = fakeGhostty(10, 20);
    const controller = new GhosttyViewportController(term, context());

    expect(
      controller.handleWheel({ deltaY: 0, deltaMode: DOM_DELTA_PIXEL }),
    ).toBe(true);
    expect(term.viewport.scrollBy).not.toHaveBeenCalled();
    expect(state.viewportY).toBe(10);
  });
});
