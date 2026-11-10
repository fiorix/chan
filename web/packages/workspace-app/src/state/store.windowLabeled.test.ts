// @vitest-environment jsdom
//
// The `window_labeled` frame the server sends this window's socket on a
// rename, driven through the store's frame handler: every surface keeps the
// caption for the pane tree's window name, and only a browser retitles its
// document.

import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { sessionWindowId } from "../api/client";
import { loadScopedLibrarySnapshot } from "../api/libraryCommand";
import { onWatchEvent } from "./store.svelte";
import { initWindowTitle, loadWindowTitle, windowName, __resetWindowTitle } from "./windowTitle.svelte";

vi.mock("../api/libraryCommand", () => ({ loadScopedLibrarySnapshot: vi.fn() }));

beforeEach(() => {
  window.history.replaceState({}, "", "/?w=window-a");
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected fetch"));
  document.title = "Chan";
  __resetWindowTitle();
  vi.mocked(loadScopedLibrarySnapshot).mockResolvedValue({
    library_id: "local",
    workspaces: [],
    windows: [{
      window_id: "window-a", kind: "terminal", ordinal: 2,
      label: "", title: "Unrelated terminal title",
      control: false, tmux: false, workspace_path: null,
      connected: true, hidden: false, launch_path: "/terminal/",
    }],
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  __resetWindowTitle();
  vi.mocked(loadScopedLibrarySnapshot).mockReset();
  vi.restoreAllMocks();
});

function hear(label: string, windowId = sessionWindowId()): void {
  onWatchEvent({ type: "window_command", window_id: windowId, command: "window_labeled", label });
}

function desktop(): void {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: { invoke: vi.fn() }, configurable: true });
}

function turn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("a desktop window's rename reaches its pane tree name and leaves the document title alone", async () => {
  desktop();
  await loadWindowTitle();
  expect(windowName()).toBe("Terminal Window 2");

  hear("deploy");
  await turn();
  expect(windowName()).toBe("Terminal Window 2 [deploy]");
  expect(document.title).toBe("Chan");

  hear("");
  await turn();
  expect(windowName()).toBe("Terminal Window 2");
  expect(document.title).toBe("Chan");
});

test("a browser window's rename retitles its tab and its pane tree name", async () => {
  await initWindowTitle();
  expect(document.title).toBe("Terminal Window 2");

  hear("deploy");
  await turn();
  expect(windowName()).toBe("Terminal Window 2 [deploy]");
  expect(document.title).toBe("Terminal Window 2 [deploy]");
});

test("a rename addressed to another window changes nothing", async () => {
  desktop();
  await loadWindowTitle();

  hear("deploy", "another-window");
  await turn();
  expect(windowName()).toBe("Terminal Window 2");
});
