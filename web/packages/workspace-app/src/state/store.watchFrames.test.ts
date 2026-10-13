// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../api/client";
import { draftClientPath } from "../api/fileIdentity";
import { fileTab, readTab, resetLayout } from "../__tests__/tabs";
import { installDemoWorkspace, uninstallDemoWorkspace } from "../demo/install";
import type { MockWorkspaceStore } from "../demo/store";
import { trackTimers, type TimerTrack } from "../demo/timers";
import {
  browserSelection,
  browserSidePanes,
  fileOps,
  loadTreeDir,
  onWatchEvent,
  refreshTree,
  refreshWorkspace,
  tree,
} from "./store.svelte";

let disk: MockWorkspaceStore;
let timers: TimerTrack;

beforeEach(async () => {
  timers = trackTimers();
  window.history.replaceState(null, "", "/?w=window-a");
  disk = installDemoWorkspace({
    metadata: {
      workspaceRoot: "demo",
      label: "demo",
      generatedAt: 1_700_000_000_000,
      fileCount: 2,
      textCount: 2,
    },
    files: [
      { path: "notes/a.md", kind: "document", size: 5, mtime: 100, content: "hello" },
      { path: "notes/b.md", kind: "document", size: 5, mtime: 100, content: "hello" },
    ],
  });
  await refreshWorkspace();
  await refreshTree();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetLayout();
  browserSidePanes.left = false;
  browserSidePanes.right = false;
  browserSelection.path = null;
  window.history.replaceState(null, "", "/");
  timers.release();
  uninstallDemoWorkspace();
});

describe("file tree watch relists", () => {
  test("an event below a never-loaded directory leaves every tree row untouched", async () => {
    browserSidePanes.left = true;
    const entries = tree.entries;
    const rows = [...entries];
    const list = vi.spyOn(api, "list");
    const workspace = vi.spyOn(api, "workspace");
    vi.useFakeTimers();
    disk.create("notes/unopened.md", false, "x");
    onWatchEvent({ type: "watch", event: { kind: "Created", path: "notes/unopened.md" } });
    await vi.advanceTimersByTimeAsync(251);
    expect(workspace, "the frame scheduled its workspace refresh").toHaveBeenCalled();
    expect(list, "an unopened parent needs no listing").not.toHaveBeenCalled();
    expect(tree.entries, "an unopened parent keeps the tree array").toBe(entries);
    rows.forEach((row, index) => expect(tree.entries[index], `row ${index} keeps its object`).toBe(row));
  });

  test("a draft frame never relists the file tree", async () => {
    const draft = draftClientPath({ path: "untitled/a.md", draft_id: "life-1" });
    // A cached parent must not turn a marked draft path into a tree request.
    tree.loadedDirs = { ...tree.loadedDirs, [draft.slice(0, draft.lastIndexOf("/"))]: true };
    const entries = tree.entries;
    const list = vi.spyOn(api, "list");
    const workspace = vi.spyOn(api, "workspace");
    vi.useFakeTimers();
    onWatchEvent({
      type: "watch",
      event: { kind: "Modified", path: draft },
    });
    await vi.advanceTimersByTimeAsync(251);
    expect(workspace, "the frame scheduled its workspace refresh").toHaveBeenCalled();
    expect(list, "draft edits do not relist the tree").not.toHaveBeenCalled();
    expect(tree.entries, "draft edits keep the tree array").toBe(entries);
  });

  test.each([
    ["dock", "watch"],
    ["dock", "fs"],
    ["browser tab", "watch"],
    ["browser tab", "fs"],
    ["no browser", "watch"],
    ["no browser", "fs"],
  ] as const)("a root creation reaches the %s from a %s frame", async (surface, type) => {
    if (surface === "dock") {
      browserSidePanes.left = true;
      browserSelection.path = "notes/a.md";
    } else if (surface === "browser tab") {
      resetLayout([{ kind: "browser", id: "files", title: "Files", inspectorOpen: false, selected: "notes/a.md" }]);
    }
    disk.create("root-new.md", false, "x");
    onWatchEvent({ type, dir: "", event: { kind: "Created", path: "root-new.md" } });
    await vi.waitFor(() => {
      expect(tree.entries.some((entry) => entry.path === "root-new.md"), `${surface} root row from ${type}`).toBe(true);
    });
  });

  test("a root file rename replaces the old row", async () => {
    disk.create("root-old.md", false, "x");
    await refreshTree();
    disk.move("root-old.md", "root-new.md");
    onWatchEvent({ type: "watch", event: { kind: "Renamed", path: "root-old.md", to: "root-new.md" } });
    await vi.waitFor(() => {
      expect(tree.entries.some((entry) => entry.path === "root-old.md"), "old root row").toBe(false);
      expect(tree.entries.some((entry) => entry.path === "root-new.md"), "new root row").toBe(true);
    });
  });

  test("a root file removal removes its row", async () => {
    disk.create("root-old.md", false, "x");
    await refreshTree();
    disk.remove("root-old.md");
    onWatchEvent({ type: "watch", event: { kind: "Removed", path: "root-old.md" } });
    await vi.waitFor(() => {
      expect(tree.entries.some((entry) => entry.path === "root-old.md"), "removed root row").toBe(false);
    });
  });

  test("a loaded directory outside the selection relists", async () => {
    browserSidePanes.left = true;
    browserSelection.path = "notes/a.md";
    disk.create("archive", true);
    await refreshTree();
    await loadTreeDir("archive");
    disk.create("archive/new.md", false, "x");
    onWatchEvent({ type: "watch", event: { kind: "Created", path: "archive/new.md" } });
    await vi.waitFor(() => {
      expect(tree.entries.some((entry) => entry.path === "archive/new.md"), "loaded directory outside selection").toBe(true);
    });
  });

  test("a previously loaded directory keeps current while no browser shows it", async () => {
    await loadTreeDir("notes");
    disk.create("notes/cached.md", false, "x");
    onWatchEvent({ type: "watch", event: { kind: "Created", path: "notes/cached.md" } });
    await vi.waitFor(() => {
      expect(tree.entries.some((entry) => entry.path === "notes/cached.md"), "cached collapsed directory").toBe(true);
    });
  });

  test("a rename across loaded parents relists both sides", async () => {
    disk.create("archive", true);
    await refreshTree();
    await loadTreeDir("notes");
    await loadTreeDir("archive");
    disk.move("notes/a.md", "archive/a.md");
    onWatchEvent({ type: "watch", event: { kind: "Renamed", path: "notes/a.md", to: "archive/a.md" } });
    await vi.waitFor(() => {
      expect(tree.entries.some((entry) => entry.path === "notes/a.md"), "old parent's row").toBe(false);
      expect(tree.entries.some((entry) => entry.path === "archive/a.md"), "new parent's row").toBe(true);
    });
  });

  test("one same-parent rename frame lists the directory once", async () => {
    await loadTreeDir("notes");
    const list = vi.spyOn(api, "list");
    disk.move("notes/a.md", "notes/renamed.md");
    onWatchEvent({ type: "watch", event: { kind: "Renamed", path: "notes/a.md", to: "notes/renamed.md" } });
    await vi.waitFor(() => {
      expect(tree.entries.some((entry) => entry.path === "notes/a.md"), "old row").toBe(false);
      expect(tree.entries.some((entry) => entry.path === "notes/renamed.md"), "new row").toBe(true);
    });
    expect(list.mock.calls.filter(([dir]) => dir === "notes"), "one frame, one listing").toHaveLength(1);
  });
});

describe("a watch frame that names its writer", () => {
  test("a transfer echo keeps an open note intact until its tab moves", async () => {
    resetLayout([fileTab({
      id: "moving",
      path: "notes/a.md",
      content: "hello",
      saved: "hello",
      savedMtime: 100,
      savedMtimeNs: "100",
    })]);
    let answer!: (response: Awaited<ReturnType<typeof api.fsTransfer>>) => void;
    const response = new Promise<Awaited<ReturnType<typeof api.fsTransfer>>>((resolve) => {
      answer = resolve;
    });
    const request = vi.spyOn(api, "fsTransfer").mockReturnValue(response);
    const transfer = fileOps.moveManyTo(["notes/a.md"], "archive");
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());

    disk.move("notes/a.md", "archive/a.md");
    vi.useFakeTimers();
    onWatchEvent({
      type: "watch",
      event: { kind: "Renamed", path: "notes/a.md", to: "archive/a.md" },
      source_w: "window-a",
    });
    await vi.advanceTimersByTimeAsync(151);
    answer({ moved: [{ from: "notes/a.md", to: "archive/a.md" }], skipped: [], conflicts: [] });
    await transfer;

    const tab = readTab("moving");
    expect(tab?.path, "the tab follows the transfer").toBe("archive/a.md");
    expect(tab?.content, "the open text survives the echo").toBe("hello");
    expect(tab?.saved, "the saved text survives the echo").toBe("hello");
    expect(tab?.savedMtime, "the saved mtime survives the echo").toBe(100);
    expect(tab?.savedMtimeNs, "the saved nanosecond token survives the echo").toBe("100");
    expect(tab?.fileMissing, "the moved tab is not missing").toBeNull();
  });

  test("this window raises no banner on its tab, and another window does", () => {
    resetLayout([fileTab({ id: "open", path: "notes/a.md", content: "hello", saved: "hello" })]);
    onWatchEvent({ type: "watch", event: { kind: "Created", path: "notes/a.md" }, source_w: "window-a" });
    expect(readTab("open")?.externalChange, "this window's own echo").not.toBe(true);

    onWatchEvent({ type: "watch", event: { kind: "Created", path: "notes/a.md" }, source_w: "window-b" });
    expect(readTab("open")?.externalChange, "another window's change").toBe(true);
  });

  test("a note another window moved is marked missing and stays open", async () => {
    resetLayout([fileTab({ id: "moved", path: "notes/a.md", content: "hello", saved: "hello" })]);
    disk.move("notes/a.md", "notes/moved.md");
    onWatchEvent({
      type: "watch",
      event: { kind: "Renamed", path: "notes/a.md", to: "notes/moved.md" },
      source_w: "window-b",
    });
    await vi.waitFor(() => {
      const tab = readTab("moved");
      expect(tab, "moved tab stays open").toBeDefined();
      expect(tab?.fileMissing, "moved").not.toBeNull();
    }, { timeout: 4000 });
  });

  test("a note another window deleted is marked missing and stays open", async () => {
    resetLayout([fileTab({ id: "deleted", path: "notes/b.md", content: "hello", saved: "hello" })]);
    disk.remove("notes/b.md");
    onWatchEvent({ type: "watch", event: { kind: "Removed", path: "notes/b.md" }, source_w: "window-b" });
    await vi.waitFor(() => {
      const tab = readTab("deleted");
      expect(tab, "deleted tab stays open").toBeDefined();
      expect(tab?.fileMissing, "deleted").not.toBeNull();
    }, { timeout: 4000 });
  });

  test("another window's frame relists the directory of its path", async () => {
    await loadTreeDir("notes");
    disk.create("notes/new.md", false, "x");
    onWatchEvent({ type: "fs", dir: "notes", event: { kind: "Created", path: "notes/new.md" }, source_w: "window-b" });
    await vi.waitFor(() => {
      expect(tree.entries.some((entry) => entry.path === "notes/new.md"), "another window's change").toBe(true);
    }, { timeout: 4000 });
  });

  test("this window's own frame relists the directory of its path", async () => {
    await loadTreeDir("notes");
    disk.create("notes/own.md", false, "x");
    onWatchEvent({ type: "fs", dir: "notes", event: { kind: "Created", path: "notes/own.md" }, source_w: "window-a" });
    await vi.waitFor(() => {
      expect(tree.entries.some((entry) => entry.path === "notes/own.md"), "this window's own echo").toBe(true);
    }, { timeout: 4000 });
  });
});
