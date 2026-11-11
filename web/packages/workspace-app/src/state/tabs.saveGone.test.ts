// @vitest-environment jsdom
//
// A save that meets its file gone. The server refuses a conditional write to
// a missing file as the write conflict, with no time on disk in its body; the
// tab then says its file was moved or deleted and keeps every edit, and no
// external-edit prompt opens. A save that meets a file another program
// changed still prompts.

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../api/client";
import { ApiError } from "../api/errors";
import { confirmState, resolveConfirm } from "./confirm.svelte";
import {
  closeTab,
  conflictDialog,
  dismissConflict,
  saveMissingTabHere,
  saveTab,
  scheduleMissingFileCheck,
} from "./tabs.svelte";
import { fileTab, readTab, resetLayout } from "../__tests__/tabs";

const PATH = "notes/a.md";
const TYPED = "the edits only this tab holds";

/// The refusal the server sends for a write whose file is gone: the time on
/// disk is null and its nanosecond form is left out.
function goneRefusal(): ApiError {
  return new ApiError(409, "file changed on disk since it was read", {
    error: "file changed on disk since it was read",
    code: "write_conflict",
    current_mtime: null,
    disk_conflicted: false,
  });
}

/// The refusal for a file another program wrote since the tab read it.
function editedRefusal(): ApiError {
  return new ApiError(409, "file changed on disk since it was read", {
    error: "file changed on disk since it was read",
    code: "write_conflict",
    current_mtime: 200,
    current_mtime_ns: "200000000000",
    disk_conflicted: false,
  });
}

const NOT_FOUND = new ApiError(404, "not found: notes/a.md");

function dirtyTab(over: Parameters<typeof fileTab>[0] = {}) {
  return fileTab({ id: "gone-tab", path: PATH, content: TYPED, saved: "old", savedMtimeNs: "100000000000", ...over });
}

afterEach(() => {
  if (confirmState.open) resolveConfirm(false);
  dismissConflict();
  vi.restoreAllMocks();
});

describe("a save whose file is gone", () => {
  test("marks the tab missing and keeps its edits, with no prompt", async () => {
    const tab = dirtyTab();
    resetLayout([tab]);
    vi.spyOn(api, "write").mockRejectedValue(goneRefusal());
    const read = vi.spyOn(api, "read").mockRejectedValue(NOT_FOUND);
    vi.spyOn(api, "search").mockResolvedValue([]);

    await saveTab(tab);

    expect(conflictDialog.open, "no external-edit prompt").toBe(false);
    expect(read, "the refusal is confirmed by a read").toHaveBeenCalledWith(PATH);
    const after = readTab(tab.id)!;
    expect(after.fileMissing?.path).toBe(PATH);
    expect(after.content, "every edit is still in the tab").toBe(TYPED);
    expect(after.saved).toBe("old");
  });

  test("closes an external-edit prompt for the tab when the tab is marked missing", async () => {
    const tab = dirtyTab();
    const other = fileTab({ id: "other-tab", path: "notes/b.md", content: "b2", saved: "b1" });
    resetLayout([tab, other]);
    vi.spyOn(api, "write").mockRejectedValue(editedRefusal());
    await saveTab(tab);
    expect(conflictDialog.open).toBe(true);
    expect(conflictDialog.tabId).toBe(tab.id);

    // The watcher reports the file removed; its probe finds nothing there.
    vi.spyOn(api, "read").mockRejectedValue(NOT_FOUND);
    vi.spyOn(api, "search").mockResolvedValue([]);
    scheduleMissingFileCheck(tab.id, PATH);
    await vi.waitFor(() => expect(readTab(tab.id)?.fileMissing).not.toBeNull());

    expect(conflictDialog.open, "no prompt stands over the missing tab").toBe(false);
    expect(readTab(tab.id)!.content).toBe(TYPED);
  });

  test("leaves the prompt of another tab open", async () => {
    const tab = dirtyTab();
    const other = fileTab({ id: "other-tab", path: "notes/b.md", content: "b2", saved: "b1" });
    resetLayout([tab, other]);
    vi.spyOn(api, "write").mockRejectedValue(editedRefusal());
    await saveTab(other);
    expect(conflictDialog.tabId).toBe(other.id);

    vi.spyOn(api, "read").mockRejectedValue(NOT_FOUND);
    vi.spyOn(api, "search").mockResolvedValue([]);
    scheduleMissingFileCheck(tab.id, PATH);
    await vi.waitFor(() => expect(readTab(tab.id)?.fileMissing).not.toBeNull());

    expect(conflictDialog.open).toBe(true);
    expect(conflictDialog.tabId).toBe(other.id);
  });

  test("Save here writes the edits back with no time on disk, which recreates the file", async () => {
    const tab = dirtyTab({ fileMissing: { path: PATH, fragment: null } });
    resetLayout([tab]);
    vi.spyOn(api, "read").mockRejectedValue(NOT_FOUND);
    const write = vi.spyOn(api, "write").mockResolvedValue({ mtime: 300, mtime_ns: "300000000000" });

    await saveMissingTabHere(tab.id);

    expect(write).toHaveBeenCalledTimes(1);
    const [path, content, expectedMtimeNs, expectedMtime] = write.mock.calls[0]!;
    expect({ path, content, expectedMtimeNs, expectedMtime }).toEqual({
      path: PATH,
      content: TYPED,
      expectedMtimeNs: null,
      expectedMtime: null,
    });
    const after = readTab(tab.id)!;
    expect(after.fileMissing, "the tab is the file's again").toBeNull();
    expect(after.saved).toBe(TYPED);
    expect(after.savedMtimeNs).toBe("300000000000");
  });

  test("Save here over a file that came back is the ordinary save, which prompts", async () => {
    const tab = dirtyTab({ fileMissing: { path: PATH, fragment: null } });
    resetLayout([tab]);
    vi.spyOn(api, "read").mockResolvedValue({ path: PATH, content: "theirs", mtime: 200, writable: true });
    const write = vi.spyOn(api, "write").mockRejectedValue(editedRefusal());

    await saveMissingTabHere(tab.id);

    expect(write.mock.calls[0]?.[2], "the write names the time the tab read").toBe("100000000000");
    expect(conflictDialog.open).toBe(true);
    expect(conflictDialog.kind).toBe("classic");
    expect(readTab(tab.id)!.content).toBe(TYPED);
  });

  test("Close asks before it throws the edits away", async () => {
    const tab = dirtyTab();
    const pane = resetLayout([tab]);
    vi.spyOn(api, "write").mockRejectedValue(goneRefusal());
    vi.spyOn(api, "read").mockRejectedValue(NOT_FOUND);
    vi.spyOn(api, "search").mockResolvedValue([]);

    const closing = closeTab(pane.id, tab.id);
    await vi.waitFor(() => expect(confirmState.open, "the close asks").toBe(true));
    expect(confirmState.title).toBe("Close without saving?");
    expect(confirmState.message).toContain("a.md was not saved because its file was moved or deleted.");
    expect(confirmState.cancelLabel).toBe("Keep editing");
    resolveConfirm(false);
    await closing;

    expect(readTab(tab.id)?.content, "Keep editing keeps the tab").toBe(TYPED);
    expect(conflictDialog.open).toBe(false);
  });
});

describe("a save that meets a file that is there", () => {
  test("an external edit still opens the external-edit prompt", async () => {
    const tab = dirtyTab();
    resetLayout([tab]);
    vi.spyOn(api, "write").mockRejectedValue(editedRefusal());
    const read = vi.spyOn(api, "read");

    await saveTab(tab);

    expect(read, "a refusal naming the time on disk needs no read").not.toHaveBeenCalled();
    expect(conflictDialog.open).toBe(true);
    expect(conflictDialog.kind).toBe("classic");
    expect(conflictDialog.currentMtimeNs).toBe("200000000000");
    expect(readTab(tab.id)!.fileMissing).toBeNull();
  });

  test("a refusal with no time on disk for a file the read finds is an external edit", async () => {
    const tab = dirtyTab();
    resetLayout([tab]);
    vi.spyOn(api, "write").mockRejectedValue(goneRefusal());
    vi.spyOn(api, "read").mockResolvedValue({ path: PATH, content: "back", mtime: 250, writable: true });

    await saveTab(tab);

    expect(conflictDialog.open).toBe(true);
    expect(conflictDialog.kind).toBe("classic");
    expect(readTab(tab.id)!.fileMissing).toBeNull();
  });
});
