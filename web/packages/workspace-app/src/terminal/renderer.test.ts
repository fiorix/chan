import { describe, expect, test, vi } from "vitest";
import {
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
