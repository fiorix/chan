// The launcher's screen flip picks its turn from the screen's shape, the way a
// workspace pane's side flip does: a tall area turns about the vertical axis,
// a wide one about the horizontal, and a square one either way at random,
// starting and ending a half turn back.

import { describe, expect, test, vi } from "vitest";
import { flipAxisForElement, flipTransforms } from "./flip";

function fakeEl(width: number, height: number): HTMLElement {
  const el = document.createElement("div");
  el.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      width,
      height,
      toJSON: () => ({}),
    }) as DOMRect;
  return el;
}

describe("flip axis", () => {
  test("tall areas turn vertically, wide areas horizontally", () => {
    expect(flipAxisForElement(fakeEl(120, 320))).toBe("vertical");
    expect(flipAxisForElement(fakeEl(320, 120))).toBe("horizontal");
  });

  test("a square area chooses either axis", () => {
    const random = vi.spyOn(Math, "random");
    try {
      random.mockReturnValue(0.2);
      expect(flipAxisForElement(fakeEl(200, 200))).toBe("vertical");
      random.mockReturnValue(0.8);
      expect(flipAxisForElement(fakeEl(200, 200))).toBe("horizontal");
    } finally {
      random.mockRestore();
    }
  });

  test("a missing element reads as square", () => {
    const random = vi.spyOn(Math, "random");
    try {
      random.mockReturnValue(0.2);
      expect(flipAxisForElement(null)).toBe("vertical");
    } finally {
      random.mockRestore();
    }
  });

  test("transforms follow the axis", () => {
    expect(flipTransforms("vertical")).toEqual({
      start: "rotateY(-180deg)",
      back: "rotateY(-180deg)",
    });
    expect(flipTransforms("horizontal")).toEqual({
      start: "rotateX(-180deg)",
      back: "rotateX(-180deg)",
    });
  });
});
