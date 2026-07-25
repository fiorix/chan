// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../api/client";
import type { SearchHit } from "../api/types";
import {
  attemptInPlaceReopen,
  cancelMissingFileCheck,
  closeTab,
  layout,
  scheduleMissingFileCheck,
  type FileTab,
  type LeafNode,
} from "./tabs.svelte";

/// Wait long enough for `scheduleMissingFileCheck`'s 150 ms
/// debounce + the awaited api.read / api.search calls to
/// settle. Real timers because fake-timer flushing doesn't
/// reliably drain the multi-level await chain inside
/// `resolveMissingFileCheck`.
async function flushDebounce(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 250));
}

function recoveryHit(path: string): SearchHit {
  return { path, is_dir: false, mtime: null, size: 0 };
}

/// Read a tab fresh from the $state proxy. Svelte 5 proxies
/// don't reflect mutations onto the raw object reference
/// captured BEFORE the put-into-layout step; always read via
/// the proxy after async work.
function readTab(id: string): FileTab | undefined {
  for (const node of Object.values(layout.nodes)) {
    if (node.kind !== "leaf") continue;
    const t = node.tabs.find((t) => t.id === id);
    if (t && t.kind === "file") return t;
  }
  return undefined;
}

function fileTab(partial: Partial<FileTab> = {}): FileTab {
  return {
    kind: "file",
    fileKind: "document",
    id: "file-1",
    path: "notes/a.md",
    content: "saved",
    saved: "saved",
    savedMtime: 1,
    mode: "wysiwyg",
    loading: false,
    error: null,
    fileMissing: null,
    inspectorOpen: false,
    outlineOpen: false,
    repoRoot: null,
    readMode: false,
    fsWritable: true,
    styleToolbarOpen: false,
    syntaxHighlight: true,
    highlightTrailingWhitespace: false,
    codeBlocksCollapsed: false,
    ...partial,
  };
}

function resetLayout(tabs: FileTab[]): LeafNode {
  const pane: LeafNode = {
    kind: "leaf",
    id: "pane-test",
    tabs,
    activeTabId: tabs[0]?.id ?? null,
  };
  layout.rootId = pane.id;
  layout.activePaneId = pane.id;
  layout.nodes = { [pane.id]: pane };
  layout.focusColor = "blue";
  return pane;
}

const ENOENT = new Error("io error: No such file or directory (os error 2)");

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("scheduleMissingFileCheck - debounced watcher reaction", () => {
  test("does NOT mark fileMissing when the file is back within the debounce window", async () => {
    const seed = fileTab({ id: "tab-a", path: "notes/a.md" });
    resetLayout([seed]);
    const readSpy = vi
      .spyOn(api, "readStream")
      .mockResolvedValue({ path: seed.path, content: "still here", mtime: 7, writable: true });
    // Search spy so the suggest path doesn't fire unrelated.
    vi.spyOn(api, "search").mockResolvedValue([]);

    scheduleMissingFileCheck(seed.id, seed.path);
    expect(readTab(seed.id)?.fileMissing).toBeNull(); // no immediate flash

    await flushDebounce();

    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(readSpy.mock.calls[0]?.[0]).toBe(seed.path);
    const after = readTab(seed.id);
    expect(after?.fileMissing).toBeNull();
    expect(after?.content).toBe("still here");
  });

  test("marks fileMissing only AFTER the debounce confirms the file is gone", async () => {
    const seed = fileTab({ id: "tab-b", path: "notes/gone.md", content: "x", saved: "x" });
    resetLayout([seed]);
    vi.spyOn(api, "readStream").mockRejectedValue(ENOENT);
    vi.spyOn(api, "search").mockResolvedValue([]);

    scheduleMissingFileCheck(seed.id, seed.path);
    expect(readTab(seed.id)?.fileMissing).toBeNull(); // no immediate flash

    await flushDebounce();

    const after = readTab(seed.id);
    expect(after?.fileMissing).not.toBeNull();
    expect(after?.fileMissing?.path).toBe(seed.path);
  });

  test("debounces overlapping watcher events to a single re-check", async () => {
    const seed = fileTab({ id: "tab-c", path: "notes/spammy.md" });
    resetLayout([seed]);
    const readSpy = vi
      .spyOn(api, "readStream")
      .mockResolvedValue({ path: seed.path, content: "ok", mtime: 1, writable: true });
    vi.spyOn(api, "search").mockResolvedValue([]);

    scheduleMissingFileCheck(seed.id, seed.path);
    scheduleMissingFileCheck(seed.id, seed.path);
    scheduleMissingFileCheck(seed.id, seed.path);

    await flushDebounce();

    expect(readSpy).toHaveBeenCalledTimes(1);
  });

  test("cancelMissingFileCheck silences a pending check (e.g. a Created frame followed Removed)", async () => {
    const seed = fileTab({ id: "tab-d", path: "notes/back.md" });
    resetLayout([seed]);
    const readSpy = vi.spyOn(api, "read");
    vi.spyOn(api, "search").mockResolvedValue([]);

    scheduleMissingFileCheck(seed.id, seed.path);
    cancelMissingFileCheck(seed.id);

    await flushDebounce();

    expect(readSpy).not.toHaveBeenCalled();
    expect(readTab(seed.id)?.fileMissing).toBeNull();
  });

  test("does NOT clobber a dirty buffer when the file is still on disk", async () => {
    const seed = fileTab({
      id: "tab-e",
      path: "notes/wip.md",
      content: "user has been typing here", // dirty
      saved: "older saved content",
    });
    resetLayout([seed]);
    vi.spyOn(api, "read").mockResolvedValue({
      path: seed.path,
      content: "disk version",
      mtime: 9,
      writable: true,
    });
    vi.spyOn(api, "search").mockResolvedValue([]);

    scheduleMissingFileCheck(seed.id, seed.path);
    await flushDebounce();

    // Dirty branch: probe existence + clear any fileMissing,
    // DO NOT overwrite buffer.
    const after = readTab(seed.id);
    expect(after?.content).toBe("user has been typing here");
    expect(after?.saved).toBe("older saved content");
    expect(after?.fileMissing).toBeNull();
  });
});

describe("Find-suggest lookup", () => {
  test("populates suggestedPath with a unique basename match at a different path", async () => {
    const seed = fileTab({ id: "tab-f", path: "notes/a.md" });
    resetLayout([seed]);
    vi.spyOn(api, "readStream").mockRejectedValue(ENOENT);
    const searchSpy = vi
      .spyOn(api, "search")
      .mockResolvedValue([recoveryHit("archive/a.md")]);

    scheduleMissingFileCheck(seed.id, seed.path);
    await flushDebounce();

    expect(searchSpy).toHaveBeenCalledWith("a.md", 5);
    expect(readTab(seed.id)?.fileMissing?.suggestedPath).toBe("archive/a.md");
  });

  test("leaves suggestedPath null when multiple basename matches exist (ambiguous)", async () => {
    const seed = fileTab({ id: "tab-g", path: "notes/a.md" });
    resetLayout([seed]);
    vi.spyOn(api, "readStream").mockRejectedValue(ENOENT);
    vi.spyOn(api, "search").mockResolvedValue([
      recoveryHit("archive/a.md"),
      recoveryHit("drafts/a.md"),
    ]);

    scheduleMissingFileCheck(seed.id, seed.path);
    await flushDebounce();

    const after = readTab(seed.id);
    expect(after?.fileMissing).not.toBeNull();
    expect(after?.fileMissing?.suggestedPath ?? null).toBeNull();
  });

  test("ignores the original path if it reappears during recovery", async () => {
    const seed = fileTab({ id: "tab-h", path: "notes/specific.md" });
    resetLayout([seed]);
    vi.spyOn(api, "readStream").mockRejectedValue(ENOENT);
    vi.spyOn(api, "search").mockResolvedValue([
      recoveryHit("notes/specific.md"),
    ]);

    scheduleMissingFileCheck(seed.id, seed.path);
    await flushDebounce();

    const after = readTab(seed.id);
    expect(after?.fileMissing).not.toBeNull();
    expect(after?.fileMissing?.suggestedPath ?? null).toBeNull();
  });
});

describe("attemptInPlaceReopen - Re-open button behaviour", () => {
  test("clears fileMissing when the original path is readable again", async () => {
    const seed = fileTab({
      id: "tab-i",
      path: "notes/recovered.md",
      fileMissing: { path: "notes/recovered.md", fragment: null },
    });
    resetLayout([seed]);
    vi.spyOn(api, "readStream").mockResolvedValue({
      path: seed.path,
      content: "back from the dead",
      mtime: 11,
      writable: true,
    });

    const ok = await attemptInPlaceReopen(seed.id);

    expect(ok).toBe(true);
    const after = readTab(seed.id);
    expect(after?.fileMissing).toBeNull();
    expect(after?.content).toBe("back from the dead");
    expect(after?.saved).toBe("back from the dead");
  });

  test("returns false when the file is still gone (caller falls through to FB navigation)", async () => {
    const seed = fileTab({
      id: "tab-j",
      path: "notes/still-gone.md",
      fileMissing: { path: "notes/still-gone.md", fragment: null },
    });
    resetLayout([seed]);
    vi.spyOn(api, "readStream").mockRejectedValue(ENOENT);

    const ok = await attemptInPlaceReopen(seed.id);

    expect(ok).toBe(false);
    expect(readTab(seed.id)?.fileMissing).not.toBeNull();
  });
});

describe("closeTab - a draft whose file vanished is not trapped open", () => {
  // Regression: drafts are now in-root files (`.Drafts/...`), so a shell
  // `mv`/`rm` puts a draft tab into the missing-file overlay. The draft
  // close flow must NOT call inspectDraft (it would 404 and return false,
  // trapping the tab so no Cmd+W / Ctrl+D / X could dismiss it).
  test("closes the tab without inspecting the gone draft", async () => {
    const seed = fileTab({
      id: "tab-draft-gone",
      path: ".Drafts/untitled-3/draft.md",
      content: "scratch",
      saved: "scratch",
      fileMissing: { path: ".Drafts/untitled-3/draft.md", fragment: null },
    });
    const pane = resetLayout([seed]);
    const inspectSpy = vi.spyOn(api, "inspectDraft");
    const discardSpy = vi.spyOn(api, "discardDraft");

    await closeTab(pane.id, seed.id);

    // Read the live $state proxy, not the pre-insert `pane` reference.
    const livePane = layout.nodes[pane.id] as LeafNode;
    expect(readTab(seed.id)).toBeUndefined();
    expect(livePane.tabs.length).toBe(0);
    // Nothing to save or discard: the draft is already gone on disk.
    expect(inspectSpy).not.toHaveBeenCalled();
    expect(discardSpy).not.toHaveBeenCalled();
  });
});
