// @vitest-environment jsdom
//
// A window with no workspace behind it is served by the slim terminal tenant,
// which mounts no /api/preflight (workspace onboarding) and no /api/screensaver
// routes (per-workspace config), and no search routes either. The app must not
// reach for them there. The gate is the capability, not the narrower
// terminal-only flag: a standalone window that browses files has no workspace
// either. Such a window follows the launcher's light or dark choice, and it
// closes itself once emptied, arming that rule on its first tab rather than
// at the end of bootstrap: a window a routed `cs open` minted boots with no
// tab at all and must not close before its content arrives.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Read at module load, so the window must be a standalone one before any app
// module runs. `seed=0` is a window a routed open minted: it boots empty.
vi.hoisted(() => {
  window.history.replaceState({}, "", "/?kind=terminal&w=w-standalone&seed=0");
});

vi.mock("@xterm/xterm", async () => (await import("./__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("./__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("./__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("./__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("./__tests__/xterm")).webLinksAddonModule());

const themeWatch = vi.hoisted(() => ({ opened: 0, closed: 0 }));

vi.mock("./api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api/client")>();
  return {
    ...actual,
    openLocalThemeWatch: () => {
      themeWatch.opened += 1;
      return () => {
        themeWatch.closed += 1;
      };
    },
  };
});

import { api } from "./api/client";
import { mountApp, press, settle, stubAppEnvironment, unmountApp } from "./__tests__/app";
import { searchPanel, ui } from "./state/store.svelte";
import { openTerminalInActivePane } from "./state/tabs.svelte";
import { windowCaps } from "./state/windowCaps";

stubAppEnvironment();

beforeEach(() => {
  themeWatch.opened = 0;
  themeWatch.closed = 0;
  vi.spyOn(api, "preflight");
  vi.spyOn(api, "screensaverState");
});

afterEach(async () => {
  await unmountApp();
  searchPanel.open = false;
  ui.terminalArmed = false;
  vi.restoreAllMocks();
});

describe("a window with no workspace", () => {
  test("is the window under test", () => {
    expect(windowCaps.workspace).toBe(false);
  });

  test("asks for no preflight and no screen lock", async () => {
    await mountApp();
    await settle();

    expect(api.preflight).not.toHaveBeenCalled();
    expect(api.screensaverState).not.toHaveBeenCalled();
  });

  test("drops the search chord, since its tenant serves no search", async () => {
    await mountApp();
    press({ key: "s", code: "KeyS", ctrlKey: true, altKey: true });
    await settle();

    expect(searchPanel.open).toBe(false);
  });

  test("follows the launcher's theme, and stops when unmounted", async () => {
    await mountApp();
    expect(themeWatch.opened).toBe(1);

    await unmountApp();
    expect(themeWatch.closed).toBe(1);
  });

  test("arms close-when-empty on its first tab, not at boot", async () => {
    await mountApp();
    await settle();
    expect(ui.terminalArmed).toBe(false);

    openTerminalInActivePane({});
    await settle();
    expect(ui.terminalArmed).toBe(true);
  });
});
