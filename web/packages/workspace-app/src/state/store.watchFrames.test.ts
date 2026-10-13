// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../api/client";
import { draftClientPath } from "../api/fileIdentity";
import { setFetchImpl } from "../api/transport";
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
  refreshTreeForPath,
  refreshWorkspace,
  teardown,
  tree,
} from "./store.svelte";

let disk: MockWorkspaceStore;
let timers: TimerTrack;
type ListEntries = Awaited<ReturnType<typeof api.list>>;

function heldList() {
  let resolve!: (entries: ListEntries) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<ListEntries>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function changed(path: string, type: "watch" | "fs" = "watch"): void {
  onWatchEvent({ type, event: { kind: "Created", path } });
}

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
  teardown();
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
  test("a failed relist preserves the tree without an unhandled rejection and retries on the next event", async () => {
    await loadTreeDir("notes");
    const entries = tree.entries;
    disk.create("notes/new.md", false, "x");
    const workspace = await api.workspace();
    vi.useFakeTimers();
    setFetchImpl(null);
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("listing failed"))
      .mockImplementation(async (input) => {
        const url = new URL(String(input), window.location.href);
        const payload = url.pathname === "/api/workspace" ? workspace : disk.list("notes");
        return new Response(JSON.stringify(payload));
      });
    const list = vi.spyOn(api, "list");
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    // Rejected promises reach Node's process in jsdom, not its window.
    const runner = globalThis as unknown as {
      process: {
        on: (event: "unhandledRejection", fn: (reason: unknown) => void) => void;
        off: (event: "unhandledRejection", fn: (reason: unknown) => void) => void;
      };
    };
    runner.process.on("unhandledRejection", onUnhandled);
    try {
      const frame = { type: "watch", event: { kind: "Created", path: "notes/new.md" } };
      onWatchEvent(frame);
      await vi.advanceTimersByTimeAsync(100);
      expect(list).toHaveBeenCalledExactlyOnceWith("notes");
      expect(fetch).toHaveBeenNthCalledWith(1, "/api/fs?dir=notes", expect.objectContaining({ method: "GET" }));
      expect(tree.entries, "a failed relist keeps the tree array").toBe(entries);
      expect(unhandled, "the relist handles a rejected listing").toEqual([]);

      onWatchEvent(frame);
      await vi.advanceTimersByTimeAsync(250);
      expect(list).toHaveBeenCalledTimes(2);
      expect(list).toHaveBeenNthCalledWith(2, "notes");
      expect(tree.entries.some((entry) => entry.path === "notes/new.md"), "the next event retries the listing").toBe(true);
    } finally {
      // Let the workspace debounce clear its module-owned timer handle.
      await vi.advanceTimersByTimeAsync(250);
      runner.process.off("unhandledRejection", onUnhandled);
    }
  });

  test("a watch creation sorts directories first and files among their siblings", async () => {
    await loadTreeDir("notes");
    disk.create("notes/aa.md", false, "x");
    disk.create("notes/z-folder", true);
    // The demo backend sorts too; an unordered reply isolates the store's sort.
    const list = vi.spyOn(api, "list").mockResolvedValueOnce(disk.list("notes").reverse());
    vi.useFakeTimers();
    try {
      onWatchEvent({ type: "watch", event: { kind: "Created", path: "notes/aa.md" } });
      await vi.advanceTimersByTimeAsync(100);
      expect(
        tree.entries.filter((entry) => entry.path.startsWith("notes/")).map((entry) => entry.path),
        "the relisted siblings put directories first and insert the new file in lexical order",
      ).toEqual(["notes/z-folder", "notes/a.md", "notes/aa.md", "notes/b.md"]);
      expect(list).toHaveBeenCalledExactlyOnceWith("notes");
    } finally {
      await vi.advanceTimersByTimeAsync(250);
    }
  });

  test("an event below a never-loaded directory leaves every tree row untouched", async () => {
    browserSidePanes.left = true;
    const entries = tree.entries;
    const rows = [...entries];
    const list = vi.spyOn(api, "list");
    const workspace = vi.spyOn(api, "workspace");
    vi.useFakeTimers();
    disk.create("notes/unopened.md", false, "x");
    onWatchEvent({ type: "watch", event: { kind: "Created", path: "notes/unopened.md" } });
    await vi.advanceTimersByTimeAsync(501);
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
    await vi.advanceTimersByTimeAsync(501);
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
    vi.useFakeTimers();
    const timers = vi.spyOn(globalThis, "setTimeout");
    const list = vi.spyOn(api, "list");
    disk.move("notes/a.md", "notes/renamed.md");
    onWatchEvent({ type: "watch", event: { kind: "Renamed", path: "notes/a.md", to: "notes/renamed.md" } });
    expect(timers.mock.calls.filter(([, delay]) => delay === 100), "one timer for the same parent").toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(tree.entries.some((entry) => entry.path === "notes/a.md"), "old row").toBe(false);
    expect(tree.entries.some((entry) => entry.path === "notes/renamed.md"), "new row").toBe(true);
    expect(list.mock.calls.filter(([dir]) => dir === "notes"), "one frame, one listing").toHaveLength(1);
  });
  test("frames during a held watch listing leave one dirty follow-up", async () => {
    await loadTreeDir("notes");
    const first = heldList();
    const old = disk.list("notes");
    const list = vi.spyOn(api, "list").mockReturnValueOnce(first.promise).mockImplementation(async () => disk.list("notes"));
    vi.useFakeTimers();
    changed("notes/first.md");
    await vi.advanceTimersByTimeAsync(100);
    expect(list).toHaveBeenCalledTimes(1);
    disk.create("notes/last.md", false, "last");
    for (let i = 0; i < 12; i++) changed("notes/last.md", i % 2 ? "fs" : "watch");
    await vi.advanceTimersByTimeAsync(300);
    expect(list, "one request stays in flight").toHaveBeenCalledTimes(1);
    first.resolve(old);
    await vi.advanceTimersByTimeAsync(250);
    expect(list, "all held frames share one follow-up").toHaveBeenCalledTimes(2);
    expect(tree.entries.some((entry) => entry.path === "notes/last.md")).toBe(true);
  });

  test("a frame during first load lists once after that load succeeds", async () => {
    const first = heldList();
    const list = vi.spyOn(api, "list").mockReturnValueOnce(first.promise).mockImplementation(async () => disk.list("notes"));
    vi.useFakeTimers();
    const load = loadTreeDir("notes");
    disk.create("notes/after.md", false, "x");
    changed("notes/after.md");
    await vi.advanceTimersByTimeAsync(501);
    expect(list, "the first load owns the first request").toHaveBeenCalledTimes(1);
    first.resolve(disk.list("notes").filter((entry) => entry.path !== "notes/after.md"));
    await load;
    await vi.advanceTimersByTimeAsync(250);
    expect(list, "the frame requests a fresh snapshot").toHaveBeenCalledTimes(2);
    expect(tree.entries.some((entry) => entry.path === "notes/after.md")).toBe(true);
  });

  test("a failed first load drops watch dirt until a person retries", async () => {
    const first = heldList();
    const list = vi.spyOn(api, "list").mockReturnValueOnce(first.promise).mockImplementation(async () => disk.list("notes"));
    vi.useFakeTimers();
    const load = loadTreeDir("notes");
    changed("notes/after.md");
    first.reject(new Error("first load failed"));
    await expect(load).rejects.toThrow("first load failed");
    await vi.advanceTimersByTimeAsync(501);
    expect(list, "watch does not automatically retry an errored directory").toHaveBeenCalledTimes(1);
    await loadTreeDir("notes");
    expect(list).toHaveBeenCalledTimes(2);
  });

  test("the quiet deadline follows the last frame", async () => {
    await loadTreeDir("notes");
    const list = vi.spyOn(api, "list");
    vi.useFakeTimers();
    changed("notes/a.md");
    await vi.advanceTimersByTimeAsync(20);
    changed("notes/a.md", "fs");
    await vi.advanceTimersByTimeAsync(20);
    changed("notes/a.md");
    await vi.advanceTimersByTimeAsync(99);
    expect(list, "no request before 100 ms of quiet").not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(list).toHaveBeenCalledExactlyOnceWith("notes");
  });

  test("a continuous burst starts a listing by the first frame's cap", async () => {
    await loadTreeDir("notes");
    const list = vi.spyOn(api, "list");
    vi.useFakeTimers();
    for (let i = 0; i < 5; i++) {
      changed("notes/a.md");
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(list, "churn cannot move the 250 ms cap").toHaveBeenCalledExactlyOnceWith("notes");
  });

  test("two quiet bursts keep 250 ms between listing starts", async () => {
    await loadTreeDir("notes");
    const list = vi.spyOn(api, "list");
    vi.useFakeTimers();
    changed("notes/a.md");
    await vi.advanceTimersByTimeAsync(100);
    expect(list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(50);
    changed("notes/b.md");
    await vi.advanceTimersByTimeAsync(199);
    expect(list, "second start waits for spacing").toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(list).toHaveBeenCalledTimes(2);
  });

  test("a failed watch request releases its directory for a later frame", async () => {
    await loadTreeDir("notes");
    const first = heldList();
    const list = vi.spyOn(api, "list").mockReturnValueOnce(first.promise).mockImplementation(async () => disk.list("notes"));
    vi.useFakeTimers();
    changed("notes/a.md");
    await vi.advanceTimersByTimeAsync(100);
    first.reject(new Error("watch failed"));
    await vi.advanceTimersByTimeAsync(1);
    changed("notes/b.md");
    await vi.advanceTimersByTimeAsync(249);
    expect(list).toHaveBeenCalledTimes(2);
  });

  test("a held directory does not block a different loaded directory", async () => {
    disk.create("archive", true);
    await refreshTree();
    await loadTreeDir("notes");
    await loadTreeDir("archive");
    const first = heldList();
    const list = vi.spyOn(api, "list").mockImplementation((dir) => dir === "notes" ? first.promise : Promise.resolve(disk.list(dir ?? "")));
    vi.useFakeTimers();
    changed("notes/a.md");
    await vi.advanceTimersByTimeAsync(100);
    changed("archive/new.md");
    await vi.advanceTimersByTimeAsync(100);
    expect(list.mock.calls.map(([dir]) => dir)).toEqual(["notes", "archive"]);
    first.resolve(disk.list("notes"));
    await vi.advanceTimersByTimeAsync(0);
  });

  test("a newer direct listing makes a held watch response stale", async () => {
    await loadTreeDir("notes");
    const first = heldList();
    const old = disk.list("notes");
    const list = vi.spyOn(api, "list").mockReturnValueOnce(first.promise).mockImplementation(async () => disk.list("notes"));
    vi.useFakeTimers();
    changed("notes/a.md");
    await vi.advanceTimersByTimeAsync(100);
    disk.create("notes/direct.md", false, "x");
    await refreshTreeForPath("notes/direct.md");
    expect(tree.entries.some((entry) => entry.path === "notes/direct.md")).toBe(true);
    first.resolve(old);
    await vi.advanceTimersByTimeAsync(0);
    expect(tree.entries.some((entry) => entry.path === "notes/direct.md"), "stale watch response cannot overwrite direct listing").toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    expect(list, "a newer watch response follows the dropped response").toHaveBeenCalledTimes(3);
  });

  test("refresh drops a held watch response and a timer for an unloaded parent", async () => {
    await loadTreeDir("notes");
    const first = heldList();
    disk.create("old.md", false, "x");
    const old = disk.list("");
    disk.remove("old.md");
    const list = vi.spyOn(api, "list").mockImplementationOnce(() => first.promise).mockImplementation(async (dir) => disk.list(dir ?? ""));
    vi.useFakeTimers();
    changed("a.md");
    await vi.advanceTimersByTimeAsync(100);
    changed("notes/b.md");
    disk.create("new.md", false, "x");
    await refreshTree();
    first.resolve(old);
    await vi.advanceTimersByTimeAsync(501);
    expect(tree.entries.some((entry) => entry.path === "old.md"), "old watch response is inert").toBe(false);
    expect(tree.entries.some((entry) => entry.path === "new.md")).toBe(true);
    expect(list.mock.calls.filter(([dir]) => dir === ""), "refresh cancels the old root coordinator").toHaveLength(2);
    expect(list.mock.calls.filter(([dir]) => dir === "notes"), "unloaded parent's timer is cancelled").toHaveLength(0);
  });

  test("teardown clears timers and makes a held response inert", async () => {
    await loadTreeDir("notes");
    const first = heldList();
    disk.create("old.md", false, "x");
    const old = disk.list("");
    disk.remove("old.md");
    const list = vi.spyOn(api, "list").mockReturnValueOnce(first.promise).mockImplementation(async (dir) => disk.list(dir ?? ""));
    vi.useFakeTimers();
    changed("a.md");
    await vi.advanceTimersByTimeAsync(100);
    changed("notes/b.md");
    teardown();
    first.resolve(old);
    await vi.advanceTimersByTimeAsync(501);
    expect(tree.entries.some((entry) => entry.path === "old.md"), "late response is inert").toBe(false);
    expect(list.mock.calls.filter(([dir]) => dir === "notes"), "teardown cancels the pending timer").toHaveLength(0);
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
