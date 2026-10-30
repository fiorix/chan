import { describe, expect, it } from "vitest";
import {
  TERMINAL_BACKGROUND_OPACITY_MAX,
  TERMINAL_BACKGROUND_OPACITY_MIN,
  TERMINAL_OPACITY_VAR,
  clampBackgroundOpacity,
  effectiveBackgroundOpacity,
  markTerminalOpacityRoot,
  transparentColor,
  windowIsTransparent,
} from "./backgroundOpacity";

describe("clampBackgroundOpacity", () => {
  it("keeps in-range values and rounds", () => {
    expect(clampBackgroundOpacity(80)).toBe(80);
    expect(clampBackgroundOpacity(79.6)).toBe(80);
  });

  it("clamps to the slider bounds", () => {
    expect(clampBackgroundOpacity(0)).toBe(TERMINAL_BACKGROUND_OPACITY_MIN);
    expect(clampBackgroundOpacity(-5)).toBe(TERMINAL_BACKGROUND_OPACITY_MIN);
    expect(clampBackgroundOpacity(250)).toBe(TERMINAL_BACKGROUND_OPACITY_MAX);
  });

  it("reads a missing or malformed value as opaque", () => {
    expect(clampBackgroundOpacity(undefined)).toBe(100);
    expect(clampBackgroundOpacity("50")).toBe(100);
    expect(clampBackgroundOpacity(Number.NaN)).toBe(100);
  });
});

describe("windowIsTransparent", () => {
  it("reads the desktop's flag off the URL", () => {
    expect(windowIsTransparent("http://127.0.0.1:1/terminal/?w=a&transparent=1")).toBe(true);
  });

  it("is false without the flag or with another value", () => {
    expect(windowIsTransparent("http://127.0.0.1:1/terminal/?w=a")).toBe(false);
    expect(windowIsTransparent("http://127.0.0.1:1/terminal/?transparent=0")).toBe(false);
    expect(windowIsTransparent("not a url")).toBe(false);
  });
});

function fakeRoot() {
  const props = new Map<string, string>();
  return {
    props,
    root: {
      dataset: {} as Record<string, string | undefined>,
      style: {
        setProperty: (name: string, value: string) => void props.set(name, value),
        removeProperty: (name: string) => {
          const old = props.get(name) ?? "";
          props.delete(name);
          return old;
        },
      },
    },
  };
}

describe("markTerminalOpacityRoot", () => {
  it("marks a transparent window and makes the body see-through below 100", () => {
    const { root, props } = fakeRoot();
    markTerminalOpacityRoot(root, true, 70);
    expect(root.dataset.transparentWindow).toBe("");
    expect(root.dataset.terminalSeeThrough).toBe("");
    expect(props.get(TERMINAL_OPACITY_VAR)).toBe("70%");
  });

  it("keeps the body opaque at 100 but stays marked transparent", () => {
    const { root, props } = fakeRoot();
    markTerminalOpacityRoot(root, true, 70);
    markTerminalOpacityRoot(root, true, 100);
    expect(root.dataset.transparentWindow).toBe("");
    expect(root.dataset.terminalSeeThrough).toBeUndefined();
    expect(props.get(TERMINAL_OPACITY_VAR)).toBe("100%");
  });

  it("clears everything in an opaque window", () => {
    const { root, props } = fakeRoot();
    root.dataset.transparentWindow = "";
    root.dataset.terminalSeeThrough = "";
    props.set(TERMINAL_OPACITY_VAR, "50%");
    markTerminalOpacityRoot(root, false, 50);
    expect(root.dataset.transparentWindow).toBeUndefined();
    expect(root.dataset.terminalSeeThrough).toBeUndefined();
    expect(props.has(TERMINAL_OPACITY_VAR)).toBe(false);
  });
});

describe("transparentColor", () => {
  it("keeps the RGB of a hex colour", () => {
    expect(transparentColor("#1c1c1e")).toBe("rgba(28, 28, 30, 0)");
    expect(transparentColor(" #FFF ")).toBe("rgba(255, 255, 255, 0)");
  });

  it("keeps the RGB of an rgb() or rgba() colour", () => {
    expect(transparentColor("rgb(1, 2, 3)")).toBe("rgba(1, 2, 3, 0)");
    expect(transparentColor("rgba(4,5,6,0.5)")).toBe("rgba(4, 5, 6, 0)");
  });

  it("falls back to transparent black", () => {
    expect(transparentColor("canvastext")).toBe("rgba(0, 0, 0, 0)");
  });
});

describe("effectiveBackgroundOpacity", () => {
  it("never goes see-through in an opaque window", () => {
    expect(effectiveBackgroundOpacity(40, false)).toBeNull();
  });

  it("is opaque at 100 even in a transparent window", () => {
    expect(effectiveBackgroundOpacity(100, true)).toBeNull();
    expect(effectiveBackgroundOpacity(undefined, true)).toBeNull();
  });

  it("returns the clamped percent in a transparent window", () => {
    expect(effectiveBackgroundOpacity(75, true)).toBe(75);
    expect(effectiveBackgroundOpacity(1, true)).toBe(TERMINAL_BACKGROUND_OPACITY_MIN);
  });
});
