import { afterEach, describe, expect, test, vi } from "vitest";

import {
  buryLibraryWindow,
  createLibraryWindow,
  focusLibraryWindow,
  type LibraryWindowBridge,
} from "./libraryWindows";
import type { ScopedLibraryWindow } from "./libraryCommand";

type W = Window & typeof globalThis & { __TAURI_INTERNALS__?: unknown };

/// A popup handle shaped like the browser one the deck drives: the browser
/// path reads `location.href` to decide whether the named window is fresh,
/// then names, navigates, and focuses it.
interface FakePopup {
  location: { href: string };
  name: string;
  focus: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function fakePopup(href = "about:blank"): FakePopup {
  return { location: { href }, name: "", focus: vi.fn(), close: vi.fn() };
}

function asDesktop(invoke: (cmd: string, args?: unknown) => Promise<unknown>): void {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: { invoke },
    configurable: true,
  });
}

function bridge(overrides: Partial<LibraryWindowBridge> = {}): LibraryWindowBridge {
  return {
    runAction: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
    currentWindowId: () => "w-self",
    ...overrides,
  };
}

function scopedWindow(overrides: Partial<ScopedLibraryWindow> = {}): ScopedLibraryWindow {
  return {
    window_id: "w-other",
    kind: "terminal",
    title: "Terminal",
    ordinal: 1,
    label: "",
    workspace_path: null,
    connected: true,
    hidden: false,
    control: false,
    can_act: true,
    launch_path: "/lib-0a1b/index.html?w=w-other",
    ...overrides,
  };
}

afterEach(() => {
  delete (window as W).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

/// `window.open` returns null in every chan-desktop webview, gateway-served and
/// local alike, so neither library-window path may reach a popup there. These
/// drive the real functions and observe `window.open` itself rather than
/// inspecting source order, because the reverted attempt proved a branch can
/// take the desktop path and still be wrong.
describe("chan-desktop native library windows", () => {
  test("creating a terminal invokes the native command and never opens a popup", async () => {
    const open = vi.spyOn(window, "open");
    const invoke = vi.fn().mockResolvedValue(null);
    asDesktop(invoke);
    const host = bridge();

    await createLibraryWindow(host, { action: "new_terminal" });

    expect(open).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("create_library_window", {
      kind: "terminal",
      workspaceId: null,
    });
    // The scoped HTTP action mints a browser-origin record the desktop watcher
    // refuses to open, so the native path must not also run it.
    expect(host.runAction).not.toHaveBeenCalled();
    expect(host.refresh).toHaveBeenCalled();
  });

  test("creating a workspace window carries the workspace id, not a path", async () => {
    const open = vi.spyOn(window, "open");
    const invoke = vi.fn().mockResolvedValue(null);
    asDesktop(invoke);

    await createLibraryWindow(bridge(), {
      action: "new_workspace_window",
      workspace_id: "notes-1a2b3c4d",
    });

    expect(open).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("create_library_window", {
      kind: "workspace",
      workspaceId: "notes-1a2b3c4d",
    });
  });

  test("focusing invokes the native command and never opens a popup", async () => {
    const open = vi.spyOn(window, "open");
    const invoke = vi.fn().mockResolvedValue(null);
    asDesktop(invoke);
    const host = bridge();

    await focusLibraryWindow(host, scopedWindow({ hidden: true }));

    expect(open).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("focus_library_window", { windowId: "w-other" });
    // The native command persists hidden=false itself, so a second unhide over
    // HTTP would be a duplicated authority, not a safety net.
    expect(host.runAction).not.toHaveBeenCalled();
    expect(host.refresh).toHaveBeenCalled();
  });

  test("hiding and closing another window need no popup handle", async () => {
    const open = vi.spyOn(window, "open");
    asDesktop(vi.fn().mockResolvedValue(null));
    const host = bridge();

    await buryLibraryWindow(host, scopedWindow(), false);
    await buryLibraryWindow(host, scopedWindow(), true);

    expect(open).not.toHaveBeenCalled();
    expect(host.runAction).toHaveBeenNthCalledWith(1, {
      action: "set_window_visibility",
      window_id: "w-other",
      hidden: true,
    });
    expect(host.runAction).toHaveBeenNthCalledWith(2, {
      action: "close_window",
      window_id: "w-other",
    });
  });

  test("a refused native create rejects instead of reporting success", async () => {
    asDesktop(vi.fn().mockRejectedValue(new Error("not allowed")));
    const host = bridge();

    await expect(createLibraryWindow(host, { action: "new_terminal" })).rejects.toThrow(
      "not allowed",
    );
    expect(host.refresh).not.toHaveBeenCalled();
  });
});

/// The browser path is the one this change must leave alone. These fail if the
/// desktop branch ever swallows it.
describe("browser library windows still use window.open", () => {
  test("creating opens a popup before the action and navigates it", async () => {
    const popup = fakePopup();
    const open = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const host = bridge({
      runAction: vi.fn().mockResolvedValue({ window: scopedWindow() }),
    });

    await createLibraryWindow(host, { action: "new_terminal" });

    expect(open).toHaveBeenCalledWith("", "_blank");
    expect(host.runAction).toHaveBeenCalledWith({ action: "new_terminal" });
    expect(popup.name).toBe("w-other");
    expect(popup.location.href).toBe("/lib-0a1b/index.html?w=w-other");
    expect(popup.focus).toHaveBeenCalled();
  });

  test("a blocked popup throws and a failed action closes the popup", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    await expect(createLibraryWindow(bridge(), { action: "new_terminal" })).rejects.toThrow(
      /blocked/i,
    );

    const popup = fakePopup();
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const host = bridge({ runAction: vi.fn().mockRejectedValue(new Error("boom")) });
    await expect(createLibraryWindow(host, { action: "new_terminal" })).rejects.toThrow("boom");
    expect(popup.close).toHaveBeenCalled();
  });

  test("focusing a hidden window unhides it over HTTP and raises the popup", async () => {
    const popup = fakePopup();
    const open = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const host = bridge();

    await focusLibraryWindow(host, scopedWindow({ hidden: true }));

    expect(open).toHaveBeenCalledWith("", "w-other");
    expect(host.runAction).toHaveBeenCalledWith({
      action: "set_window_visibility",
      window_id: "w-other",
      hidden: false,
    });
    expect(popup.location.href).toBe("/lib-0a1b/index.html?w=w-other");
    expect(popup.focus).toHaveBeenCalled();
  });

  test("focusing this window reuses it instead of opening a popup", async () => {
    const open = vi.spyOn(window, "open");
    const host = bridge();

    await focusLibraryWindow(host, scopedWindow({ window_id: "w-self" }));

    expect(open).not.toHaveBeenCalled();
  });
});
