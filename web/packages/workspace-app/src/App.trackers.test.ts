// @vitest-environment jsdom
//
// The app starts four trackers for its own life: the idle tracker behind the
// floating pills, the screensaver's activity tracker, the page width's resize
// watch and the system theme watch. An app that is unmounted stops all four.
// The app is mounted over the demo transport.

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("./__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("./__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("./__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("./__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("./__tests__/xterm")).webLinksAddonModule());

import { mountApp, stubAppEnvironment, unmountApp } from "./__tests__/app";
import { idle } from "./state/idle.svelte";
import { screensaver } from "./state/screensaver.svelte";

stubAppEnvironment();

/// The listeners on the system theme's media query, which jsdom does not
/// implement: the stub keeps the ones added and not yet removed.
const themeListeners = new Set<unknown>();
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener(_type: string, listener: unknown) {
      if (query === "(prefers-color-scheme: dark)") themeListeners.add(listener);
    },
    removeEventListener(_type: string, listener: unknown) {
      themeListeners.delete(listener);
    },
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }),
});

const saver = { ...screensaver };

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await unmountApp();
  Object.assign(screensaver, saver);
  idle.active = false;
  themeListeners.clear();
});

describe("an unmounted app", () => {
  test("no longer takes a click as activity for the floating pills", async () => {
    await mountApp();
    await unmountApp();
    idle.active = true;

    window.dispatchEvent(new MouseEvent("mousedown"));
    expect(idle.active).toBe(true);
  });

  test("no longer takes a key as activity for the screensaver", async () => {
    await mountApp();
    await unmountApp();
    vi.useFakeTimers();
    Object.assign(screensaver, { enabled: true, locked: false, timeout_secs: 1 });

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    vi.advanceTimersByTime(1_000);
    expect(screensaver.locked).toBe(false);
  });

  test("no longer applies the page width on a window resize", async () => {
    await mountApp();
    await unmountApp();
    const frame = vi.spyOn(globalThis, "requestAnimationFrame");

    window.dispatchEvent(new Event("resize"));
    expect(frame).not.toHaveBeenCalled();
  });

  test("no longer listens to the system theme", async () => {
    await mountApp();
    expect(themeListeners.size, "while mounted").toBe(1);

    await unmountApp();
    expect(themeListeners.size, "after the unmount").toBe(0);
  });
});
