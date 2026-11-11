import { describe, expect, test, vi } from "vitest";
import {
  createRepaintScheduler,
  type RefreshableTerminal,
  refreshTerminalRows,
  shouldUseWebglRenderer,
  webglRendererOverride,
  webglRendererSignal,
  WEBGL_RENDERER_OVERRIDE_KEY,
} from "./renderer";

describe("terminal renderer helpers", () => {
  test("repaints only visible rows through xterm refresh", () => {
    const calls: Array<[number, number]> = [];
    refreshTerminalRows({ rows: 24, refresh: (start, end) => calls.push([start, end]) });
    expect(calls).toEqual([[0, 23]]);
  });

  test("does not require refresh support", () => {
    expect(() => refreshTerminalRows({ rows: 1 })).not.toThrow();
  });

  // ghostty-web has no refresh(); its renderer repaints dirty rows only, so
  // the repaint is a forced full pass with the terminal as the scrollback
  // provider and the overlay scrollbar left to the frame loop.
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
    expect(calls).toEqual([[wasmTerm, true, 7, term, 0]]);
  });

  test("a ghostty terminal that has not opened has nothing to repaint", () => {
    const calls: unknown[][] = [];
    expect(() =>
      refreshTerminalRows({ rows: 24, renderer: { render: (...args: unknown[]) => void calls.push(args) } }),
    ).not.toThrow();
    expect(calls).toEqual([]);
  });

  test("uses each desktop renderer signal and keeps browsers on WebGL", () => {
    expect(shouldUseWebglRenderer(true, true)).toBe(true);
    expect(shouldUseWebglRenderer(true, false)).toBe(false);
    expect(shouldUseWebglRenderer(true, null)).toBe(false);
    expect(shouldUseWebglRenderer(false, false)).toBe(true);
  });

  test("an explicit override wins in both directions", () => {
    // The hatch permits a reading on either renderer without adding a second
    // platform rule beside the desktop's signal.
    expect(shouldUseWebglRenderer(true, false, true)).toBe(true);
    expect(shouldUseWebglRenderer(false, true, false)).toBe(false);
    expect(shouldUseWebglRenderer(true, false, null)).toBe(false);
  });

  test("reads both renderer signal values from the served shell", () => {
    const meta = document.createElement("meta");
    meta.setAttribute("name", "chan-webgl-renderer");
    document.head.append(meta);
    try {
      meta.setAttribute("content", "1");
      expect(webglRendererSignal()).toBe(true);
      meta.setAttribute("content", "0");
      expect(webglRendererSignal()).toBe(false);
      meta.setAttribute("content", "unknown");
      expect(webglRendererSignal()).toBeNull();
    } finally {
      meta.remove();
    }
    expect(webglRendererSignal()).toBeNull();
  });

  test("only the two documented values are an override", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
    });
    try {
      expect(webglRendererOverride()).toBeNull();
      for (const [raw, expected] of [
        ["1", true],
        ["0", false],
        ["true", null],
        ["", null],
      ] as const) {
        store.set(WEBGL_RENDERER_OVERRIDE_KEY, raw);
        expect(webglRendererOverride(), `for ${JSON.stringify(raw)}`).toBe(expected);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("a storage-denied context reports no override", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
    });
    try {
      expect(webglRendererOverride()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
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
