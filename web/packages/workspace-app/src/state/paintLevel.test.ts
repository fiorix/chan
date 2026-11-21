// @vitest-environment jsdom
//
// Which surfaces a full-window cover hides. The surfaces that are not the
// keyboard's owners ask this before they answer a key or take focus.

import { afterEach, describe, expect, test, vi } from "vitest";
import { COVER_ROOT_ATTR, coverPaintsOver } from "./paintLevel";

function layer(z: number, parent: HTMLElement = document.body): HTMLElement {
  const element = parent.appendChild(document.createElement("div"));
  element.style.position = "fixed";
  element.style.zIndex = String(z);
  return element;
}

function cover(z: number): HTMLElement {
  const root = layer(z);
  root.setAttribute(COVER_ROOT_ATTR, "reconnect");
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("coverPaintsOver", () => {
  test("a cover over the element, or at its level, paints over it", () => {
    const popover = layer(30000);
    const at = cover(30000);
    expect(coverPaintsOver(popover), "at its level").toBe(true);
    at.remove();
    cover(39000);
    expect(coverPaintsOver(popover), "over it").toBe(true);
  });

  test("a cover under the element does not", () => {
    const viewer = layer(38000);
    cover(30000);
    expect(coverPaintsOver(viewer)).toBe(false);
  });

  test("a cover is not over what is inside it, and a higher cover is", () => {
    const own = cover(30000);
    const field = own.appendChild(document.createElement("input"));
    expect(coverPaintsOver(field), "its own root").toBe(false);
    cover(39000);
    expect(coverPaintsOver(field), "the cover above it").toBe(true);
  });

  test("with no cover up it reads no style, since every key asks", () => {
    const popover = layer(30000);
    const style = vi.spyOn(window, "getComputedStyle");
    expect(coverPaintsOver(popover)).toBe(false);
    expect(style).not.toHaveBeenCalled();
  });
});
