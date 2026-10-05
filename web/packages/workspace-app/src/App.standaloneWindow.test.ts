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
const host = vi.hoisted(() => ({ desktop: false }));

vi.mock("./api/desktop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api/desktop")>()),
  isTauriDesktop: () => host.desktop,
  requestCloseWindow: vi.fn(async () => {}),
}));

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

import { api, sessionWindowId } from "./api/client";
import { requestCloseWindow } from "./api/desktop";
import { mountApp, press, settle, stubAppEnvironment, unmountApp } from "./__tests__/app";
import { json, recordRequests, stopRecordingRequests } from "./__tests__/fetch";
import { fileTab, resetLayout } from "./__tests__/tabs";
import { __testResetSessionDiscarded, __testSetBootstrapHydrated, onWatchEvent, searchPanel, stopSessionSyncRefetch, ui } from "./state/store.svelte";
import { hasAnyTab, openTerminalInActivePane } from "./state/tabs.svelte";
import { windowCaps } from "./state/windowCaps";

stubAppEnvironment();

beforeEach(() => {
  vi.clearAllMocks();
  host.desktop = false;
  themeWatch.opened = 0;
  themeWatch.closed = 0;
  vi.spyOn(api, "preflight");
  vi.spyOn(api, "screensaverState");
});

afterEach(async () => {
  vi.useRealTimers();
  stopRecordingRequests();
  await unmountApp();
  searchPanel.open = false;
  ui.terminalArmed = false;
  vi.restoreAllMocks();
});

async function applyUnattachedPeerLayout(): Promise<void> {
  __testResetSessionDiscarded();
  __testSetBootstrapHydrated(true);
  stopSessionSyncRefetch();
  vi.useFakeTimers();
  const getSession = vi.spyOn(api, "getSession").mockResolvedValue({
    layout: { k: "l", t: [{ k: "t", n: "not yet connected" }] },
  });
  onWatchEvent({ kind: "session_changed", w: sessionWindowId(), client: "peer-client" });
  await vi.advanceTimersByTimeAsync(500);
  await settle();
  expect(getSession).toHaveBeenCalled();
}

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

  test("an apply that empties a desktop window leaves it open and sends no DELETE", async () => {
    await mountApp();
    resetLayout([fileTab({ id: "local", path: "README.md", content: "hello", saved: "hello" })]);
    await settle();
    expect(ui.terminalArmed).toBe(true);
    host.desktop = true;
    const requests = recordRequests(() => json({}));
    await applyUnattachedPeerLayout();

    expect(hasAnyTab()).toBe(false);
    expect(requestCloseWindow).not.toHaveBeenCalled();
    expect(requests.filter(({ method }) => method === "DELETE")).toHaveLength(0);
  });

  test("a user emptying a desktop window closes and discards it", async () => {
    await mountApp();
    resetLayout([fileTab({ id: "local", path: "README.md", content: "hello", saved: "hello" })]);
    await settle();
    host.desktop = true;
    const requests = recordRequests(() => json({}));

    resetLayout([]);
    await settle();

    expect(requestCloseWindow).toHaveBeenCalledTimes(1);
    expect(requests.filter(({ method }) => method === "DELETE")).toHaveLength(1);
  });

  test("a user emptying a refilled desktop window closes and discards it", async () => {
    await mountApp();
    resetLayout([fileTab({ id: "local", path: "README.md", content: "hello", saved: "hello" })]);
    await settle();
    host.desktop = true;
    const requests = recordRequests(() => json({}));
    await applyUnattachedPeerLayout();
    expect(hasAnyTab()).toBe(false);
    vi.mocked(requestCloseWindow).mockClear();
    requests.length = 0;

    resetLayout([fileTab({ id: "replacement", path: "README.md", content: "hello", saved: "hello" })]);
    await settle();
    resetLayout([]);
    await settle();

    expect(requestCloseWindow).toHaveBeenCalledTimes(1);
    expect(requests.filter(({ method }) => method === "DELETE")).toHaveLength(1);
  });
});
