import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { applyWindowLabel, initWindowTitle, loadWindowTitle, refreshWindowTitle, windowName, __resetWindowTitle } from "./windowTitle.svelte";
import { privacy } from "@chan/web-shared/privacy";
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
    tmux: false,
    launch_path: "/notes/",
    ...over,
  };
}

function snapshot(windows: ScopedLibraryWindow[]): ScopedLibrarySnapshot {
  return { library_id: "local", windows, workspaces: [] };
}

beforeEach(() => {
  document.title = "Chan";
  __resetWindowTitle();
  loadSnapshot.mockReset();
});

afterEach(() => {
  __resetWindowTitle();
  privacy.enabled = false;
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
  test("a rename received during the initial snapshot wins over its stale label", async () => {
    let resolve!: (value: ScopedLibrarySnapshot) => void;
    loadSnapshot.mockReturnValue(new Promise((done) => { resolve = done; }));
    const first = loadWindowTitle();
    const second = loadWindowTitle();
    expect(loadSnapshot).toHaveBeenCalledTimes(1);
    applyWindowLabel("latest");
    resolve(snapshot([scopedWindow({ label: "stale" })]));
    await Promise.all([first, second]);
    expect(windowName()).toBe("Window 3 [latest]");
  });

  // A frame missed while the socket was down leaves the held caption stale,
  // so a caption heard before a read must not outrank that read's snapshot.
  test("a later read's snapshot wins over a rename heard before it started", async () => {
    loadSnapshot.mockRejectedValueOnce(new Error("no live presence"));
    await initWindowTitle();
    expect(windowName()).toBeNull();
    applyWindowLabel("early");
    loadSnapshot.mockResolvedValueOnce(snapshot([scopedWindow({ label: "current" })]));
    await loadWindowTitle();
    expect(windowName()).toBe("Window 3 [current]");
  });

  test("the desktop loads a pane tree name on demand without changing the document title", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: { invoke: vi.fn() }, configurable: true,
    });
    try {
      loadSnapshot.mockResolvedValue(snapshot([scopedWindow({ control: true })]));
      await loadWindowTitle();
      expect(windowName()).toBe("Control terminal");
      expect(document.title).toBe("Chan");
      await loadWindowTitle();
      expect(loadSnapshot).toHaveBeenCalledTimes(1);
    } finally {
      Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    }
  });

  test("privacy conceals captions live and restores the latest caption", async () => {
    loadSnapshot.mockResolvedValue(snapshot([scopedWindow({ label: "private.example" })]));
    privacy.enabled = true;
    await initWindowTitle();
    expect(document.title).toBe("Chan (privacy mode)");
    applyWindowLabel("another.private.example");
    expect(document.title).toBe("Chan (privacy mode)");
    privacy.enabled = false;
    refreshWindowTitle();
    expect(document.title).toBe("Window 3 [another.private.example]");
  });

  // A control terminal's name is fixed and carries no caption, so privacy
  // mode has nothing to conceal in it; its generated name, "Terminal Window
  // 0", is one the window goes by nowhere else.
  test("privacy mode keeps a control terminal's fixed name in the window tab bar", async () => {
    loadSnapshot.mockResolvedValue(snapshot([scopedWindow({ kind: "terminal", ordinal: 0, control: true })]));
    privacy.enabled = true;
    await loadWindowTitle();
    expect(windowName()).toBe("Control terminal");
  });

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

// App.svelte runs `$effect(refreshWindowTitle)`, and the naming fields are
// reactive state, so the effect is where a loaded name would reach the
// document. These run the same effect.
describe("the document title effect", () => {
  function titleEffect(): () => void {
    const stop = $effect.root(() => {
      $effect(refreshWindowTitle);
    });
    flushSync();
    return stop;
  }

  test("follows the name in a browser as it loads and changes", async () => {
    loadSnapshot.mockResolvedValue(snapshot([scopedWindow({ label: "release checks" })]));
    const stop = titleEffect();
    try {
      expect(document.title).toBe("Chan");
      await loadWindowTitle();
      flushSync();
      expect(document.title).toBe("Window 3 [release checks]");
      applyWindowLabel("deploy");
      flushSync();
      expect(document.title).toBe("Window 3 [deploy]");
    } finally {
      stop();
    }
  });

  test("keeps the desktop's static title once the pane tree loads the name", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: { invoke: vi.fn() }, configurable: true,
    });
    loadSnapshot.mockResolvedValue(snapshot([scopedWindow({ label: "release checks" })]));
    const stop = titleEffect();
    try {
      await loadWindowTitle();
      flushSync();
      expect(windowName()).toBe("Window 3 [release checks]");
      expect(document.title).toBe("Chan");
      applyWindowLabel("deploy");
      flushSync();
      expect(windowName()).toBe("Window 3 [deploy]");
      expect(document.title).toBe("Chan");
      privacy.enabled = true;
      flushSync();
      expect(document.title).toBe("Chan (privacy mode)");
    } finally {
      stop();
      Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    }
  });
});
