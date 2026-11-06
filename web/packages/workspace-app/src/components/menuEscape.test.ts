// @vitest-environment jsdom

import { afterEach, expect, test, vi } from "vitest";

import { menuEscape } from "./menuEscape";

const mounted: HTMLElement[] = [];

afterEach(() => {
  for (const element of mounted) element.remove();
  mounted.length = 0;
});

function standIn() {
  const bubble = document.createElement("div");
  const inside = document.createElement("input");
  const outside = document.createElement("button");
  bubble.append(inside);
  document.body.append(bubble, outside);
  mounted.push(bubble, outside);
  let open = true;
  const close = vi.fn(() => { open = false; });
  const handlers = menuEscape({
    open: () => open,
    inside: (target) => target instanceof Node && bubble.contains(target),
    close,
  });
  window.addEventListener("keydown", handlers.capture, true);
  window.addEventListener("keydown", handlers.bubble);
  return {
    inside,
    outside,
    close,
    closeMenu: () => { open = false; },
    cleanup: () => {
      window.removeEventListener("keydown", handlers.capture, true);
      window.removeEventListener("keydown", handlers.bubble);
    },
  };
}

function key(target: Element, name: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

test("capture closes on Escape outside before the target sees it", () => {
  const menu = standIn();
  try {
    const seen = vi.fn();
    menu.outside.addEventListener("keydown", seen);
    const event = key(menu.outside, "Escape");
    expect(menu.close).toHaveBeenCalledTimes(1);
    expect(seen).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  } finally {
    menu.cleanup();
  }
});

test("Escape inside reaches its field before bubble closes", () => {
  const menu = standIn();
  try {
    const seen = vi.fn();
    menu.inside.addEventListener("keydown", seen);
    const event = key(menu.inside, "Escape");
    expect(seen).toHaveBeenCalledTimes(1);
    expect(menu.close).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  } finally {
    menu.cleanup();
  }
});

test("other keys pass through both handlers", () => {
  const menu = standIn();
  try {
    const outside = vi.fn();
    const inside = vi.fn();
    menu.outside.addEventListener("keydown", outside);
    menu.inside.addEventListener("keydown", inside);
    expect(key(menu.outside, "x").defaultPrevented).toBe(false);
    expect(key(menu.inside, "x").defaultPrevented).toBe(false);
    expect(outside).toHaveBeenCalledTimes(1);
    expect(inside).toHaveBeenCalledTimes(1);
    expect(menu.close).not.toHaveBeenCalled();
  } finally {
    menu.cleanup();
  }
});

test("a closed menu passes Escape through both handlers", () => {
  const menu = standIn();
  try {
    menu.closeMenu();
    const outside = vi.fn();
    const inside = vi.fn();
    menu.outside.addEventListener("keydown", outside);
    menu.inside.addEventListener("keydown", inside);
    expect(key(menu.outside, "Escape").defaultPrevented).toBe(false);
    expect(key(menu.inside, "Escape").defaultPrevented).toBe(false);
    expect(outside).toHaveBeenCalledTimes(1);
    expect(inside).toHaveBeenCalledTimes(1);
    expect(menu.close).not.toHaveBeenCalled();
  } finally {
    menu.cleanup();
  }
});
