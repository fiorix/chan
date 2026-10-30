// @vitest-environment jsdom
//
// The window commands a tmux connection sends its chan windows: `open_term_attach`
// opens a tab bound to an existing pane session (or focuses the tab that has
// it), and `release_term` drops the tab for a session that moved to the
// window minted for it, without ending the session.

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { preferences } from "../__tests__/standalone";

const openLibraryWindowById = vi.hoisted(() => vi.fn<(bridge: unknown, windowId: string) => Promise<boolean>>());
const closeTerminal = vi.hoisted(() => vi.fn<(id: string) => Promise<void>>());

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      config: () => Promise.resolve({ revision: 1, preferences: preferences(), workspaces: [] }),
      health: () => Promise.resolve({ instance: "a" }),
      terminalRoster: () => Promise.resolve({ sessions: [] }),
      getSession: () => Promise.resolve(null),
      putSession: () => Promise.resolve(),
      deleteSession: () => Promise.resolve(),
      closeTerminal: (id: string) => closeTerminal(id),
    },
    openWatchSocket: () => Object.assign(() => {}, { subscribeDir() {}, unsubscribeDir() {}, reportTransfers() {} }),
  };
});

vi.mock("../api/libraryWindows", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/libraryWindows")>()),
  openLibraryWindowById: (bridge: unknown, windowId: string) => openLibraryWindowById(bridge, windowId),
}));

type TauriWindow = { __TAURI_INTERNALS__?: unknown };

async function app() {
  const store = await import("./store.svelte");
  const tabs = await import("./tabs.svelte");
  const { resetLayout, terminalTab } = await import("../__tests__/tabs");
  const { sessionWindowId } = await import("../api/client");
  return { store, tabs, resetLayout, terminalTab, sessionWindowId };
}

beforeEach(() => {
  openLibraryWindowById.mockReset();
  closeTerminal.mockReset();
});

afterEach(() => {
  delete (window as TauriWindow).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

function terminals(tabs: Awaited<ReturnType<typeof app>>["tabs"]) {
  return tabs.allTerminalTabs().map((tab) => tab.terminalSessionId);
}

test("open_term_attach opens a tab bound to the session, and a second one focuses it", async () => {
  const { store, tabs, resetLayout, sessionWindowId } = await app();
  resetLayout();
  store.onWatchEvent({ type: "window_command", window_id: sessionWindowId(), command: "open_term_attach", session_id: "pane-a" });
  expect(terminals(tabs)).toEqual(["pane-a"]);
  const first = tabs.allTerminalTabs()[0]!;
  expect(first.pendingGlobalName, "a bound tab waits for no name").toBeFalsy();
  store.onWatchEvent({ type: "window_command", window_id: sessionWindowId(), command: "open_term_attach", session_id: "pane-b" });
  expect(terminals(tabs)).toEqual(["pane-a", "pane-b"]);
  store.onWatchEvent({ type: "window_command", window_id: sessionWindowId(), command: "open_term_attach", session_id: "pane-a" });
  expect(terminals(tabs), "no second tab for a session already shown").toEqual(["pane-a", "pane-b"]);
  expect(tabs.activePane().activeTabId).toBe(first.id);
  // A command for another window is not this window's.
  store.onWatchEvent({ type: "window_command", window_id: "w-other", command: "open_term_attach", session_id: "pane-c" });
  expect(terminals(tabs)).toEqual(["pane-a", "pane-b"]);
});

test("release_term on the desktop drops the tab without ending its session", async () => {
  (window as TauriWindow).__TAURI_INTERNALS__ = { invoke: async () => {} };
  const { store, tabs, resetLayout, terminalTab, sessionWindowId } = await app();
  resetLayout([
    terminalTab({ id: "ctl", title: "ctl", terminalSessionId: "control-1" }),
    terminalTab({ id: "other", title: "other", terminalSessionId: "shell-2" }),
  ]);
  store.onWatchEvent({ type: "window_command", window_id: sessionWindowId(), command: "release_term", session_id: "control-1", window: "w-ctl" });
  await vi.waitFor(() => expect(terminals(tabs)).toEqual(["shell-2"]));
  expect(closeTerminal, "the session lives on in its new window").not.toHaveBeenCalled();
  expect(openLibraryWindowById, "the desktop opens the window natively").not.toHaveBeenCalled();
  // An unknown session changes nothing.
  store.onWatchEvent({ type: "window_command", window_id: sessionWindowId(), command: "release_term", session_id: "nope", window: "w-ctl" });
  expect(terminals(tabs)).toEqual(["shell-2"]);
});

test("release_term in a browser opens the window first and keeps the tab when it cannot", async () => {
  const { store, tabs, resetLayout, terminalTab, sessionWindowId } = await app();
  resetLayout([terminalTab({ id: "ctl", title: "ctl", terminalSessionId: "control-1" })]);
  openLibraryWindowById.mockRejectedValueOnce(new Error("popup blocked"));
  store.onWatchEvent({ type: "window_command", window_id: sessionWindowId(), command: "release_term", session_id: "control-1", window: "w-ctl" });
  await vi.waitFor(() => expect(openLibraryWindowById).toHaveBeenCalledWith(expect.anything(), "w-ctl"));
  await Promise.resolve();
  await Promise.resolve();
  expect(terminals(tabs), "a refused popup keeps the tab").toEqual(["control-1"]);
  openLibraryWindowById.mockResolvedValueOnce(true);
  store.onWatchEvent({ type: "window_command", window_id: sessionWindowId(), command: "release_term", session_id: "control-1", window: "w-ctl" });
  await vi.waitFor(() => expect(terminals(tabs)).toEqual([]));
  expect(closeTerminal).not.toHaveBeenCalled();
});
