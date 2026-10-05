// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../api/client";
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

  test("a note another window moved or deleted is marked missing and stays open", async () => {
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

    resetLayout([fileTab({ id: "deleted", path: "notes/b.md", content: "hello", saved: "hello" })]);
    disk.remove("notes/b.md");
    onWatchEvent({ type: "watch", event: { kind: "Removed", path: "notes/b.md" }, source_w: "window-b" });
    await vi.waitFor(() => {
      const tab = readTab("deleted");
      expect(tab, "deleted tab stays open").toBeDefined();
      expect(tab?.fileMissing, "deleted").not.toBeNull();
    }, { timeout: 4000 });
  });

  test("a frame that names a writer relists the directory of its path", async () => {
    browserSidePanes.left = true;
    await loadTreeDir("notes");
    disk.create("notes/new.md", false, "x");
    onWatchEvent({ type: "fs", dir: "notes", event: { kind: "Created", path: "notes/new.md" }, source_w: "window-b" });
    await vi.waitFor(() => {
      expect(tree.entries.some((entry) => entry.path === "notes/new.md"), "another window's change").toBe(true);
    }, { timeout: 4000 });

    disk.create("notes/own.md", false, "x");
    onWatchEvent({ type: "fs", dir: "notes", event: { kind: "Created", path: "notes/own.md" }, source_w: "window-a" });
    await vi.waitFor(() => {
      expect(tree.entries.some((entry) => entry.path === "notes/own.md"), "this window's own echo").toBe(true);
    }, { timeout: 4000 });
  });
});
