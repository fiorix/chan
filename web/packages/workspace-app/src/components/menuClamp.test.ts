import { beforeAll, describe, expect, test } from "vitest";
import { clampToViewport, triggerMenuX } from "./menuClamp";

describe("triggerMenuX", () => {
  test("opens right from a left-edge Hybrid hamburger", () => {
    expect(triggerMenuX({ left: 6, right: 30 }, 250)).toBe(6);
  });

  test("aligns the menu right edge on normal right-side chrome", () => {
    expect(triggerMenuX({ left: 760, right: 784 }, 250)).toBe(534);
  });
});

describe("clampToViewport", () => {
  // Fixed viewport so the edge math is deterministic (jsdom has no
  // visualViewport, so the helper falls back to innerHeight).
  beforeAll(() => {
    Object.defineProperty(window, "innerWidth", {
      value: 1000,
      configurable: true,
    });
    Object.defineProperty(window, "innerHeight", {
      value: 800,
      configurable: true,
    });
  });

  test("leaves an anchor that already fits untouched", () => {
    expect(clampToViewport(250, 210, { x: 100, y: 100 })).toEqual({
      left: 100,
      top: 100,
    });
  });

  test("flips back from the right edge", () => {
    // 900 + 250 = 1150 overflows 1000 - 8, so anchor the right edge.
    expect(clampToViewport(250, 210, { x: 900, y: 100 }).left).toBe(650);
  });

  test("flips up from the bottom edge", () => {
    // 700 + 210 = 910 overflows 800 - 8, so anchor the bottom edge.
    expect(clampToViewport(250, 210, { x: 100, y: 700 }).top).toBe(490);
  });

  test("flips up to above a band, not over it", () => {
    // A link menu opens under the pointer's band (690 to 700); flipped, its
    // bottom edge sits at the band's top, so the pointer is never under it.
    expect(clampToViewport(250, 210, { x: 100, y: 700, flipY: 690 }).top).toBe(480);
  });

  test("floors a top-left underflow anchor to the margin", () => {
    // A trigger rect measured mid-transform can land past the top/left
    // edge; nothing above catches that, so both floor to the margin.
    expect(clampToViewport(250, 210, { x: -300, y: -50 })).toEqual({
      left: 8,
      top: 8,
    });
  });

  test("floors a slightly-negative anchor to the margin", () => {
    expect(clampToViewport(250, 210, { x: 2, y: 3 })).toEqual({
      left: 8,
      top: 8,
    });
  });
});
