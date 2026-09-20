// @vitest-environment jsdom
//
// On a workspace that has a PIN, Tab and Shift+Tab stay inside the screen
// lock: the traversal is cancelled and focus returns to the PIN field, the
// only thing on this surface that can be acted on.
//
// The overlay is mounted on its own rather than through App. App's boot loads
// the server-side screensaver state and overwrites `pin_set`, so the PIN
// branch never renders there and the mounted App fixture can only reach the
// no-PIN path, where the backdrop's own handler treats a key as the unlock
// gesture. Mounting the component directly holds a PIN-enabled state for as
// long as the test needs it.
//
// jsdom moves no focus of its own on Tab, so "focus did not move" proves
// nothing here. Each case therefore parks focus on the backdrop first and
// requires the handler to pull it back to the field, which is the call the
// product code makes.

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";

import ScreensaverOverlay from "./ScreensaverOverlay.svelte";
import { screensaver } from "../state/screensaver.svelte";
import { setCoverBlocking } from "../state/store.svelte";

const mounted: Array<Record<string, any>> = [];

afterEach(() => {
  for (const component of mounted.splice(0)) unmount(component);
  document.body.innerHTML = "";
  screensaver.locked = false;
  screensaver.pin_set = false;
  screensaver.loaded = false;
  screensaver.theme = "plain";
  setCoverBlocking("screensaver", false);
});

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await tick();
}

/// A locked workspace that has a PIN, with the unlock card already woken by
/// the first key. Returns the backdrop and the PIN field the trap has to keep
/// focus on.
async function lockedWithPin(): Promise<{
  backdrop: HTMLElement;
  input: HTMLInputElement;
}> {
  screensaver.loaded = true;
  screensaver.theme = "plain";
  screensaver.pin_set = true;
  screensaver.locked = true;
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(ScreensaverOverlay, { target }));
  await settle();

  const backdrop = document.body.querySelector<HTMLElement>(
    ".screensaver-backdrop",
  );
  expect(backdrop, "the lock is up").not.toBeNull();
  // The first key wakes the card; everything under test happens after it.
  backdrop!.dispatchEvent(
    new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }),
  );
  await settle();

  const input = document.body.querySelector<HTMLInputElement>(
    ".screensaver-pin",
  );
  expect(input, "a PIN workspace renders the PIN field").not.toBeNull();
  return { backdrop: backdrop!, input: input! };
}

/// Dispatch a Tab keydown from wherever the lock can receive one, with focus
/// parked on the backdrop so a handler that does nothing leaves it there.
function tabFrom(
  element: HTMLElement,
  backdrop: HTMLElement,
  shiftKey: boolean,
): KeyboardEvent {
  backdrop.focus();
  const event = new KeyboardEvent("keydown", {
    key: "Tab",
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  element.dispatchEvent(event);
  return event;
}

describe("the screen lock keeps focus on the PIN field", () => {
  test("the card wakes with the PIN field focused", async () => {
    // The precondition the two cases below rest on: this is the PIN branch,
    // not the no-PIN one the App fixture reaches.
    const { input } = await lockedWithPin();

    expect(document.activeElement).toBe(input);
  });

  test("Tab on the backdrop is cancelled and returns focus to the field", async () => {
    const { backdrop, input } = await lockedWithPin();

    const event = tabFrom(backdrop, backdrop, false);
    await settle();

    expect(event.defaultPrevented, "the traversal is cancelled").toBe(true);
    expect(document.activeElement, "focus is back on the PIN field").toBe(input);
    expect(screensaver.locked, "Tab is not an unlock").toBe(true);
  });

  test("Shift+Tab on the field is cancelled and keeps focus on the field", async () => {
    const { backdrop, input } = await lockedWithPin();

    const event = tabFrom(input, backdrop, true);
    await settle();

    expect(event.defaultPrevented, "the traversal is cancelled").toBe(true);
    expect(document.activeElement, "focus is back on the PIN field").toBe(input);
    expect(screensaver.locked, "Shift+Tab is not an unlock").toBe(true);
  });

  test("Tab on the field is cancelled and keeps focus on the field", async () => {
    const { backdrop, input } = await lockedWithPin();

    const event = tabFrom(input, backdrop, false);
    await settle();

    expect(event.defaultPrevented, "the traversal is cancelled").toBe(true);
    expect(document.activeElement, "focus is back on the PIN field").toBe(input);
    expect(screensaver.locked, "Tab is not an unlock").toBe(true);
  });
});
