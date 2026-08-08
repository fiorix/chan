import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { applyWindowLabel, initWindowTitle, __resetWindowTitle } from "./windowTitle";
import { loadScopedLibrarySnapshot } from "../api/libraryCommand";
import type { ScopedLibraryWindow, ScopedLibrarySnapshot } from "../api/libraryCommand";

// Both are hoisted above the imports by vitest's transform.
vi.mock("../api/libraryCommand", () => ({
  loadScopedLibrarySnapshot: vi.fn(),
}));
vi.mock("../api/client", () => ({
  sessionWindowId: () => "w-me",
}));

const loadSnapshot = vi.mocked(loadScopedLibrarySnapshot);

function scopedWindow(over: Partial<ScopedLibraryWindow> = {}): ScopedLibraryWindow {
  return {
    window_id: "w-me",
    kind: "workspace",
    title: "an intentionally unrelated title",
    ordinal: 3,
    label: "",
    workspace_path: "/w/notes",
    connected: true,
    hidden: false,
    control: false,
    can_act: true,
    launch_path: "/notes/",
    ...over,
  };
}

function snapshot(windows: ScopedLibraryWindow[]): ScopedLibrarySnapshot {
  return { library_id: "local", role: "owner", windows, workspaces: [] };
}

beforeEach(() => {
  document.title = "Chan";
  __resetWindowTitle();
  loadSnapshot.mockReset();
});

afterEach(() => {
  __resetWindowTitle();
});

describe("browser tab title", () => {
  test("names the tab the way the launcher names the row", async () => {
    loadSnapshot.mockResolvedValue(snapshot([scopedWindow({ label: "release checks" })]));
    await initWindowTitle();
    expect(document.title).toBe("Window 3 [release checks]");
  });

  test("omits empty brackets when the window has no caption", async () => {
    loadSnapshot.mockResolvedValue(snapshot([scopedWindow()]));
    await initWindowTitle();
    expect(document.title).toBe("Window 3");
  });

  test("names a terminal window by its own form", async () => {
    loadSnapshot.mockResolvedValue(
      snapshot([scopedWindow({ kind: "terminal", ordinal: 2, label: "deploy shell" })]),
    );
    await initWindowTitle();
    expect(document.title).toBe("Terminal Window 2 [deploy shell]");
  });

  test("picks this window out of the snapshot, not the first row", async () => {
    loadSnapshot.mockResolvedValue(
      snapshot([
        scopedWindow({ window_id: "w-other", ordinal: 1, label: "someone else" }),
        scopedWindow({ ordinal: 3, label: "mine" }),
      ]),
    );
    await initWindowTitle();
    expect(document.title).toBe("Window 3 [mine]");
  });

  // The tab title is a convenience, never a correctness surface: a window with
  // no reachable library record must keep the document's static title rather
  // than surface an error the user cannot act on.
  test("leaves the static title alone when the capability cannot be minted", async () => {
    loadSnapshot.mockRejectedValue(new Error("no live presence"));
    await initWindowTitle();
    expect(document.title).toBe("Chan");
  });

  test("leaves the static title alone when this window has no record", async () => {
    loadSnapshot.mockResolvedValue(snapshot([scopedWindow({ window_id: "w-other" })]));
    await initWindowTitle();
    expect(document.title).toBe("Chan");
  });

  // A desktop webview's name is the OS titlebar, so the tab title is invisible
  // there and must not cost a capability mint per window.
  test("does not touch the library at all in a chan-desktop webview", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: { invoke: vi.fn() },
      configurable: true,
    });
    try {
      await initWindowTitle();
      expect(loadSnapshot).not.toHaveBeenCalled();
      expect(document.title).toBe("Chan");
    } finally {
      Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    }
  });
});

describe("live caption updates", () => {
  test("retitles when the leader sets a caption", async () => {
    loadSnapshot.mockResolvedValue(snapshot([scopedWindow()]));
    await initWindowTitle();
    applyWindowLabel("release checks");
    expect(document.title).toBe("Window 3 [release checks]");
  });

  test("drops the brackets when the leader clears the caption", async () => {
    loadSnapshot.mockResolvedValue(snapshot([scopedWindow({ label: "release checks" })]));
    await initWindowTitle();
    applyWindowLabel("");
    expect(document.title).toBe("Window 3");
  });

  // Without a boot snapshot there is no kind/ordinal to compose against, so a
  // stray frame must not invent a title.
  test("is inert before the naming fields are known", () => {
    applyWindowLabel("release checks");
    expect(document.title).toBe("Chan");
  });
});
