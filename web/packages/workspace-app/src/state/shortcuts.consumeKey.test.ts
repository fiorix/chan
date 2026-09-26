// @vitest-environment jsdom
//
// consumeKey takes a key for the capture-phase handler that answered it: the
// default is prevented, and no listener past that handler sees the key, not
// the focused element and not the app's bubble-phase window handler.

import { afterEach, describe, expect, test, vi } from "vitest";
import { consumeKey } from "./shortcuts";

const listeners: Array<[EventTarget, (e: Event) => void, boolean]> = [];

function listen(target: EventTarget, fn: (e: Event) => void, capture: boolean): void {
  target.addEventListener("keydown", fn, capture);
  listeners.push([target, fn, capture]);
}

afterEach(() => {
  for (const [target, fn, capture] of listeners.splice(0)) target.removeEventListener("keydown", fn, capture);
  document.body.innerHTML = "";
});

describe("consumeKey", () => {
  test("prevents the default and stops the key at the capture-phase handler", () => {
    const focused = document.body.appendChild(document.createElement("input"));
    const atTarget = vi.fn();
    const windowHandler = vi.fn();
    listen(document, (e) => consumeKey(e as KeyboardEvent), true);
    listen(focused, atTarget, false);
    listen(document, windowHandler, false);

    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    focused.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(atTarget).not.toHaveBeenCalled();
    expect(windowHandler).not.toHaveBeenCalled();
  });
});
