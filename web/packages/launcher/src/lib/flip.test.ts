// The launcher's screen flip picks its turn from the screen's shape, the way a
// workspace pane's side flip does: a tall area turns about the vertical axis,
// a wide one about the horizontal, and a square one either way at random,
// starting and ending a half turn back. Its back face stays off the screen at
// rest through a visibility gate in ScreenFlip's stylesheet, which jsdom never
// applies, so that gate is pinned in the stylesheet's text.

import { describe, expect, test, vi } from "vitest";
import { flipAxisForElement, flipTransforms } from "./flip";
import shellSource from "../components/ScreenFlip.svelte?raw";

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

// Source-text contract: the back face's visibility gate is component CSS, which WebKitGTK obeys and jsdom never applies.
test("the back face never paints at rest", () => {
  // WebKitGTK, the Linux desktop webview, ignores backface-visibility, so an
  // opaque back face left to that hint alone covers the whole screen and the
  // launcher renders as a bare mirrored label. The rest state is a visibility
  // gate, and the handover sits at the easing's 90deg crossing rather than at
  // half the duration.
  const backFace =
    shellSource.match(/\.screen-flip-inner::before \{[\s\S]*?\n  \}/)?.[0] ??
    "";
  // Anchored: `backface-visibility: hidden;` ends with the same text, so a
  // substring check passes on the very declaration this pin outlives.
  expect(backFace).toMatch(/^\s+visibility: hidden;$/m);
  expect(shellSource).toMatch(
    /\.screen-flip\.flipActive \.screen-flip-inner::before \{\s*animation: launcher-back-face-turn 520ms/,
  );
  expect(shellSource).toMatch(/@keyframes launcher-back-face-turn/);
  expect(shellSource).toMatch(/0%,\s*14\.43% \{\s*visibility: visible;/);
  expect(shellSource).toMatch(/14\.44%,\s*100% \{\s*visibility: hidden;/);

  // Reduced motion drops the turn, so it must drop the handover too or the
  // back face is left painted with no animation to clear it.
  const reducedMotion =
    shellSource.match(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n  \}/,
    )?.[0] ?? "";
  expect(reducedMotion).toContain(
    ".screen-flip.flipActive .screen-flip-inner::before",
  );

  // The animationend cleanup substring-matches the keyframe name, so no other
  // keyframe may contain it.
  const keyframes = [...shellSource.matchAll(/@keyframes ([\w-]+)/g)].map(
    (m) => m[1],
  );
  expect(
    keyframes.filter((name) => name.includes("launcher-screen-flip")),
  ).toEqual(["launcher-screen-flip"]);
});
