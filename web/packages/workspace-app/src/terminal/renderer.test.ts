import { describe, expect, test, vi } from "vitest";
import { createRepaintScheduler, type RefreshableTerminal, refreshTerminalRows } from "./renderer";

describe("terminal renderer helpers", () => {
  test("asks refresh() for the visible rows", () => {
    const calls: Array<[number, number]> = [];
    refreshTerminalRows({ rows: 24, refresh: (start, end) => calls.push([start, end]) });
    expect(calls).toEqual([[0, 23]]);
  });

  test("does not require refresh support", () => {
    expect(() => refreshTerminalRows({ rows: 1 })).not.toThrow();
  });

  // ghostty-web has no refresh(); its renderer repaints dirty rows only, so
  // the repaint is a forced full pass with the overlay scrollbar left to the
  // frame loop.
  test("forces a full ghostty render pass from the viewport offset", () => {
    const calls: unknown[][] = [];
    const wasmTerm = { core: true } as unknown as RefreshableTerminal["wasmTerm"];
    const term = {
      rows: 24,
      renderer: { render: (...args: unknown[]) => void calls.push(args) },
      wasmTerm,
      getViewportY: () => 7,
    };
    refreshTerminalRows(term);
    expect(calls).toEqual([[wasmTerm, true, 7, 0]]);
  });

  test("a ghostty terminal that has not opened has nothing to repaint", () => {
    const calls: unknown[][] = [];
    expect(() =>
      refreshTerminalRows({ rows: 24, renderer: { render: (...args: unknown[]) => void calls.push(args) } }),
    ).not.toThrow();
    expect(calls).toEqual([]);
  });
});

describe("the terminal repaint scheduler", () => {
  /// A page whose frames and fonts the test releases by hand: a hidden page
  /// runs no frame, so nothing fires until `frame()`.
  function page() {
    let next = 1;
    const frames = new Map<number, () => void>();
    let fontsReady: (() => void) | null = null;
    let fonts: Promise<void> | undefined;
    return {
      host: {
        requestFrame: (callback: () => void) => {
          frames.set(next, callback);
          return next++;
        },
        cancelFrame: (handle: number) => void frames.delete(handle),
        fontsReady: () => fonts,
      },
      pendingFrames: () => frames.size,
      frame() {
        const due = [...frames.values()];
        frames.clear();
        for (const callback of due) callback();
      },
      loadFonts() {
        fonts = new Promise<void>((resolve) => (fontsReady = resolve));
      },
      async fontsLoaded() {
        fontsReady?.();
        await fonts;
      },
    };
  }

  test("every repaint asked for while no frame runs is one repaint in the frame that does", () => {
    const hidden = page();
    const repaint = vi.fn();
    const scheduler = createRepaintScheduler(repaint, hidden.host);
    for (let asked = 0; asked < 544; asked++) scheduler.request();
    expect(hidden.pendingFrames()).toBe(1);
    expect(repaint).not.toHaveBeenCalled();
    hidden.frame();
    expect(repaint).toHaveBeenCalledTimes(1);
    expect(hidden.pendingFrames()).toBe(0);
  });

  test("a request after the frame ran schedules the next repaint", () => {
    const shown = page();
    const repaint = vi.fn();
    const scheduler = createRepaintScheduler(repaint, shown.host);
    scheduler.request();
    shown.frame();
    scheduler.request();
    expect(shown.pendingFrames()).toBe(1);
    shown.frame();
    expect(repaint).toHaveBeenCalledTimes(2);
  });

  test("a host that runs the frame before returning repaints on every request", () => {
    // jsdom's test stub runs the frame callback synchronously, as no browser
    // does; the handle it returns names a frame that already ran.
    const repaint = vi.fn();
    const requestFrame = vi.fn((callback: () => void) => {
      callback();
      return 0;
    });
    const scheduler = createRepaintScheduler(repaint, {
      requestFrame,
      cancelFrame: () => {},
      fontsReady: () => undefined,
    });
    for (let asked = 0; asked < 3; asked++) scheduler.request();
    expect(requestFrame).toHaveBeenCalledTimes(3);
    expect(repaint).toHaveBeenCalledTimes(3);
  });

  test("the fonts are waited on once however often a repaint is asked for", async () => {
    const loading = page();
    loading.loadFonts();
    const repaint = vi.fn();
    const scheduler = createRepaintScheduler(repaint, loading.host);
    for (let asked = 0; asked < 10; asked++) scheduler.request();
    await loading.fontsLoaded();
    expect(repaint).toHaveBeenCalledTimes(1);
    scheduler.request();
    await Promise.resolve();
    expect(repaint).toHaveBeenCalledTimes(2);
  });

  test("cancel drops the pending frame and the fonts wait, and a later request schedules again", async () => {
    const closing = page();
    closing.loadFonts();
    const repaint = vi.fn();
    const scheduler = createRepaintScheduler(repaint, closing.host);
    scheduler.request();
    scheduler.cancel();
    expect(closing.pendingFrames()).toBe(0);
    await closing.fontsLoaded();
    closing.frame();
    expect(repaint).not.toHaveBeenCalled();
    scheduler.request();
    closing.frame();
    await Promise.resolve();
    expect(repaint).toHaveBeenCalledTimes(2);
  });
});
