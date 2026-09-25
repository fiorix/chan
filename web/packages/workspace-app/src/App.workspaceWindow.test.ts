// @vitest-environment jsdom
//
// What App starts in a workspace window. It reads the workspace's preflight
// and its screen lock, installs the lock's activity tracker and mounts its
// cover, locks on the host's lock command (which has no chord), and routes
// the search chord to the search overlay. It never follows
// the launcher's theme (that is a standalone window's) and never arms
// close-when-empty. The per-library focus-colour watch lives only on the root
// launcher router, which the desktop's hosts mount and a standalone `chan
// serve` does not, so a browser window never opens it: there the handshake
// would 404 into an endless reconnect loop.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("./__tests__/xterm")).xterm);
vi.mock("@xterm/addon-fit", async () => (await import("./__tests__/xterm")).fit);
vi.mock("@xterm/addon-search", async () => (await import("./__tests__/xterm")).search);
vi.mock("@xterm/addon-serialize", async () => (await import("./__tests__/xterm")).serialize);
vi.mock("@xterm/addon-web-links", async () => (await import("./__tests__/xterm")).webLinks);

const host = vi.hoisted(() => ({
  desktop: false,
  colorWatch: null as ((color: string | null) => void) | null,
  colorWatchClosed: 0,
  themeWatchOpened: 0,
}));

vi.mock("./api/desktop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api/desktop")>()),
  isTauriDesktop: () => host.desktop,
}));

vi.mock("./api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api/client")>();
  return {
    ...actual,
    openLocalColorWatch: (onColor: (color: string | null) => void) => {
      host.colorWatch = onColor;
      return () => {
        host.colorWatchClosed += 1;
      };
    },
    openLocalThemeWatch: () => {
      host.themeWatchOpened += 1;
      return () => {};
    },
  };
});

vi.mock("./state/screensaver.svelte", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./state/screensaver.svelte")>();
  return { ...actual, installScreensaverTracker: vi.fn(actual.installScreensaverTracker) };
});

import { api } from "./api/client";
import { hostCommand, mountApp, press, settle, stubAppEnvironment, unmountApp } from "./__tests__/app";
import { installScreensaverTracker, lockNow, screensaver } from "./state/screensaver.svelte";
import { SHORTCUTS } from "./state/shortcuts";
import { searchPanel, ui } from "./state/store.svelte";
import { cancelPaneMode } from "./state/tabs.svelte";

stubAppEnvironment();

beforeEach(() => {
  host.desktop = false;
  host.colorWatch = null;
  host.colorWatchClosed = 0;
  host.themeWatchOpened = 0;
  vi.spyOn(api, "preflight");
  vi.spyOn(api, "screensaverState");
});

afterEach(async () => {
  await unmountApp();
  searchPanel.open = false;
  screensaver.locked = false;
  document.documentElement.style.removeProperty("--pane-highlight-color");
  vi.clearAllMocks();
});

describe("a workspace window", () => {
  test("reads its preflight", async () => {
    await mountApp();
    await settle();
    expect(api.preflight).toHaveBeenCalled();
  });

  test("installs the screen lock's tracker, loads the lock and covers the window when it locks", async () => {
    const target = await mountApp();
    await settle();
    expect(installScreensaverTracker).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(api.screensaverState).toHaveBeenCalled());
    await vi.waitFor(() => expect(screensaver.loaded).toBe(true));

    lockNow();
    await settle();
    expect(target.querySelector(".screensaver-backdrop")).not.toBeNull();
  });

  test("locks on the host's lock command, which no chord or Hybrid Nav key reaches", async () => {
    await mountApp();
    await vi.waitFor(() => expect(screensaver.loaded).toBe(true));
    expect(SHORTCUTS.find((shortcut) => shortcut.id === "app.screensaver.lock")).toBeUndefined();

    press({ key: "l", code: "KeyL", ctrlKey: true });
    press({ key: "l", code: "KeyL", metaKey: true });
    press({ key: ".", code: "Period", ctrlKey: true });
    press({ key: "l", code: "KeyL" });
    cancelPaneMode();
    await settle();
    expect(screensaver.locked).toBe(false);

    hostCommand("app.screensaver.lock");
    await settle();
    expect(screensaver.locked).toBe(true);
  });

  test("opens the search overlay from the search chord", async () => {
    await mountApp();
    press({ key: "s", code: "KeyS", ctrlKey: true, altKey: true });
    await settle();
    expect(searchPanel.open).toBe(true);
  });

  test("never follows the launcher's theme and never arms close-when-empty", async () => {
    await mountApp();
    await settle();
    expect(host.themeWatchOpened).toBe(0);
    expect(ui.terminalArmed).toBe(false);
  });
});

describe("the library's focus-colour watch", () => {
  test("is not opened in a browser", async () => {
    await mountApp();
    expect(host.colorWatch).toBeNull();
  });

  test("is followed under chan-desktop, and closed on unmount", async () => {
    host.desktop = true;
    await mountApp();
    expect(host.colorWatch).not.toBeNull();

    host.colorWatch!("#ff8800");
    expect(document.documentElement.style.getPropertyValue("--pane-highlight-color")).toBe("#ff8800");
    await unmountApp();
    expect(host.colorWatchClosed).toBe(1);
  });
});
