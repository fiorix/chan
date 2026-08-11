import { describe, expect, test, vi } from "vitest";
import {
  refreshTerminalRows,
  shouldUseWebglRenderer,
  webglRendererOverride,
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

  test("keeps Linux desktop on the DOM renderer", () => {
    expect(shouldUseWebglRenderer(true, "linux")).toBe(false);
    expect(shouldUseWebglRenderer(true, "mac")).toBe(true);
    expect(shouldUseWebglRenderer(false, "linux")).toBe(true);
  });

  test("an explicit override wins in both directions", () => {
    // The hatch exists so a Linux host can be asked for a reading on the
    // renderer that measures 100%; forcing it OFF matters too, as the way
    // back if it misbehaves on a host we cannot reproduce.
    expect(shouldUseWebglRenderer(true, "linux", true)).toBe(true);
    expect(shouldUseWebglRenderer(false, "mac", false)).toBe(false);
    expect(shouldUseWebglRenderer(true, "linux", null)).toBe(false);
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
