// @vitest-environment jsdom
//
// Escape at the app's window handler closes the topmost overlay, one per
// press. An Escape a handler nearer the focus has already taken (a menu, a
// viewer, a dialog closing itself calls preventDefault) is that handler's,
// and the overlay beneath it stays. The app's chords are not held to that: a
// terminal renderer prevents the default of every app chord it lets through,
// and the app still acts on them.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("./__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("./__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("./__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("./__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("./__tests__/xterm")).webLinksAddonModule());

import { mountApp, settle, stubAppEnvironment, unmountApp } from "./__tests__/app";
import { settingsPanel } from "./state/store.svelte";

stubAppEnvironment();

const ESCAPE = { key: "Escape", code: "Escape" } as const;
const SETTINGS = { key: ",", code: "Comma", ctrlKey: true } as const;

let taker: ((e: KeyboardEvent) => void) | null = null;

beforeEach(async () => {
  await mountApp();
});

afterEach(async () => {
  if (taker) document.removeEventListener("keydown", taker, true);
  taker = null;
  settingsPanel.open = false;
  await settle();
  await unmountApp();
});

/// A keydown from an element inside the page, so a capture listener on the
/// document runs before the event reaches the app's bubble-phase handler.
function pressInPage(init: KeyboardEventInit): KeyboardEvent {
  const inner = document.body.appendChild(document.createElement("div"));
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  inner.dispatchEvent(event);
  inner.remove();
  return event;
}

/// A capture-phase handler that takes `key` the way a menu or a renderer
/// does: it prevents the default and lets the event travel on.
function takeInCapture(key: string): void {
  taker = (e) => {
    if (e.key === key) e.preventDefault();
  };
  document.addEventListener("keydown", taker, true);
}

describe("Escape at the window", () => {
  test("closes the topmost overlay", async () => {
    settingsPanel.open = true;
    await settle();

    pressInPage(ESCAPE);
    await settle();

    expect(settingsPanel.open).toBe(false);
  });

  test("leaves the overlay alone when a handler already took the key", async () => {
    settingsPanel.open = true;
    await settle();
    takeInCapture("Escape");

    pressInPage(ESCAPE);
    await settle();

    expect(settingsPanel.open).toBe(true);
  });
});

describe("an app chord a handler already prevented", () => {
  test("still runs, as it does from a terminal renderer that prevents every chord it passes on", async () => {
    takeInCapture(",");

    pressInPage(SETTINGS);
    await settle();

    expect(settingsPanel.open).toBe(true);
  });
});
