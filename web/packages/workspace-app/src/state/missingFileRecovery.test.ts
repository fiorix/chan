// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../api/client";
import { ApiError } from "../api/errors";
import type { SearchHit } from "../api/types";
import {
  attemptInPlaceReopen,
  cancelMissingFileCheck,
  closeTab,
  commitPaneMode,
  conflictDialog,
  enterPaneMode,
  layout,
  paneMode,
  saveTab,
  scheduleMissingFileCheck,
  type FileTab,
  type LeafNode,
} from "./tabs.svelte";
import { fileTab, readTab, resetLayout } from "../__tests__/tabs";

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

describe("a watcher reload that lands during Hybrid Nav", () => {
  /// The server's compare-and-swap, as the write route implements it: a PUT
  /// whose expected version is not the one on disk is refused with a 409 and
  /// the current version, which is what raises the conflict modal.
  function casWrite(diskMtimeNs: string) {
    return vi
      .spyOn(api, "write")
      .mockImplementation(async (_path, _content, expectedMtimeNs) => {
        if ((expectedMtimeNs ?? null) !== diskMtimeNs) {
          throw new ApiError(409, "conflict", {
            current_mtime: 9,
            current_mtime_ns: diskMtimeNs,
          });
        }
        return { mtime: 10, mtime_ns: "10000000010" };
      });
  }

  function reloadSeed(): FileTab {
    return fileTab({
      id: "tab-hn",
      path: "notes/a.md",
      content: "mine",
      saved: "mine",
      savedMtime: 1,
      savedMtimeNs: "1000000001",
    });
  }

  function armReload(): void {
    vi.spyOn(api, "readStream").mockResolvedValue({
      path: "notes/a.md",
      content: "theirs",
      mtime: 9,
      mtime_ns: "9000000009",
      writable: true,
    });
    vi.spyOn(api, "search").mockResolvedValue([]);
  }

  function draftTab(): FileTab {
    const node = paneMode.draft?.nodes["pane-test"];
    if (!node || node.kind !== "leaf") throw new Error("no draft pane");
    const t = node.tabs[0];
    if (!t || t.kind !== "file") throw new Error("no draft file tab");
    return t;
  }

  test("does not let the draft's buffer overwrite the new file", async () => {
    // The check resolves through the live tree, so a clean tab reloads while
    // the mode is up and the live tab adopts the writer's bytes and version.
    // The draft keeps the buffer the user is typing into; if the commit hands
    // that buffer the reloaded version, the next save is accepted and the
    // writer's bytes are gone with nothing said.
    const seed = reloadSeed();
    resetLayout([seed]);
    armReload();
    const write = casWrite("9000000009");

    enterPaneMode();
    draftTab().content = "mine, and more";
    scheduleMissingFileCheck(seed.id, seed.path);
    await flushDebounce();
    commitPaneMode();

    const committed = readTab(seed.id);
    expect(committed?.content).toBe("mine, and more");
    await saveTab(committed as FileTab);

    expect(write).toHaveBeenCalled();
    expect(write.mock.calls[0]?.[2]).toBe("1000000001");
    expect(conflictDialog.open).toBe(true);
    expect(readTab(seed.id)?.externalChange, "and the banner says why").toBe(true);
  });

  test("adopts the reload when nothing was typed into the draft", async () => {
    // Same reload with nothing typed into the draft. The draft has no claim
    // on the buffer, the check already decided a clean buffer is safe to
    // replace, and the live tree holds what the user would have been looking
    // at: the commit takes the whole tuple rather than pairing the old bytes
    // with the new version.
    const seed = reloadSeed();
    resetLayout([seed]);
    armReload();
    casWrite("9000000009");

    enterPaneMode();
    scheduleMissingFileCheck(seed.id, seed.path);
    await flushDebounce();
    commitPaneMode();

    const committed = readTab(seed.id);
    expect(committed?.content).toBe("theirs");
    expect(committed?.saved).toBe("theirs");
    expect(committed?.savedMtimeNs).toBe("9000000009");
    expect(committed?.externalChange ?? false, "nothing to warn about").toBe(false);
  });
});
