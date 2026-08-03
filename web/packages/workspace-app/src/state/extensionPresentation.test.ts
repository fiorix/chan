// @vitest-environment jsdom

import { describe, expect, test, vi } from "vitest";

import { extensionPresentationLayer } from "./extensionPresentation";

describe("extension presentation layer", () => {
  test("uses the top layer without reparenting the iframe wrapper", () => {
    const parent = document.createElement("section");
    const node = document.createElement("div");
    parent.appendChild(node);
    node.showPopover = vi.fn();
    node.hidePopover = vi.fn();

    const action = extensionPresentationLayer(node, false);
    action.update(true);
    expect(node.getAttribute("popover")).toBe("manual");
    expect(node.showPopover).toHaveBeenCalledOnce();
    expect(node.parentNode).toBe(parent);

    action.update(false);
    expect(node.hidePopover).toHaveBeenCalledOnce();
    expect(node.hasAttribute("popover")).toBe(false);
    expect(node.parentNode).toBe(parent);
  });
});
