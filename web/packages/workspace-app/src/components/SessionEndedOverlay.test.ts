// @vitest-environment jsdom
//
// A hidden window's record persists and can be shown again from Computers; a
// closed window is a discard, which removes its record and ends its
// terminals, so only the hidden cover points back to Computers.

import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, test } from "vitest";

import { __resetWindowLifecycle, markWindowDiscarded, markWindowHidden } from "../state/windowLifecycle.svelte";
import SessionEndedOverlay from "./SessionEndedOverlay.svelte";

let view: Record<string, unknown> | null = null;

afterEach(() => {
  if (view) unmount(view);
  view = null;
  __resetWindowLifecycle();
  document.body.innerHTML = "";
});

function subline(): string | undefined {
  const target = document.body.appendChild(document.createElement("div"));
  view = mount(SessionEndedOverlay, { target });
  flushSync();
  return target.querySelector(".subline")?.textContent ?? undefined;
}

test("a hidden window's cover says to reopen it from Computers", () => {
  markWindowHidden();
  expect(subline()).toBe("the leader hid this window; reopen it from Computers");
});

test("a closed window's cover says it cannot be reopened", () => {
  markWindowDiscarded();
  const text = subline();
  expect(text).toBe("the leader closed this window and ended its terminals; it cannot be reopened");
  expect(text).not.toContain("Computers");
});
