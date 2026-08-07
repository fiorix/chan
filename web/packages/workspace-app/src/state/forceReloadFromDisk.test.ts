// @vitest-environment jsdom

// forceReloadFromDisk routing: a live-session (or conflicted) tab must
// resolve SERVER-side through /api/session-conflicts/resolve so the
// authority adopts the disk (the diverted GET would serve the stale
// authority right back); classic tabs re-fetch; a dirty buffer prompts
// before anything is discarded. overwriteDiskConflict is the banner's
// "Keep mine" half.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
  type MockInstance,
} from "vitest";
import { api } from "../api/client";
import { ApiError } from "../api/errors";
import type { FileResponse } from "../api/types";
import { resolveConfirm } from "./confirm.svelte";
import {
  forceReloadFromDisk,
  layout,
  overwriteDiskConflict,
  registerDocUnflushedQuery,
  type FileTab,
  type LeafNode,
} from "./tabs.svelte";

/// Per-test control over the doc-unflushed query (registered once,
/// module-global, like docSync's real registration).
const unflushedIds = new Set<string>();
registerDocUnflushedQuery((tabId) => unflushedIds.has(tabId));

let nextTabId = 0;

function fileTab(partial: Partial<FileTab> = {}): FileTab {
  nextTabId += 1;
  return {
    kind: "file",
    fileKind: "document",
    id: `frd-tab-${nextTabId}`,
    path: "notes/a.md",
    content: "hello",
    saved: "hello",
    savedMtime: 1,
    savedMtimeNs: "1000000000",
    mode: "source",
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
    id: "pane-frd",
    tabs,
    activeTabId: tabs[0]?.id ?? null,
  };
  layout.rootId = pane.id;
  layout.activePaneId = pane.id;
  layout.nodes = { [pane.id]: pane };
  layout.focusColor = "blue";
  return pane;
}

function readTab(id: string): FileTab | undefined {
  for (const node of Object.values(layout.nodes)) {
    if (node.kind !== "leaf") continue;
    const t = node.tabs.find((t) => t.id === id);
    if (t && t.kind === "file") return t;
  }
  return undefined;
}

const DISK: FileResponse = {
  path: "notes/a.md",
  content: "disk content",
  mtime: 2,
  mtime_ns: "2000000000",
  authority_version: 1,
  disk_conflicted: false,
  repo_root: null,
  writable: true,
};

let resolveSpy: MockInstance;
let readStreamSpy: MockInstance;

beforeEach(() => {
  resolveSpy = vi
    .spyOn(api, "resolveSessionConflict")
    .mockResolvedValue(DISK);
  readStreamSpy = vi.spyOn(api, "readStream").mockResolvedValue(DISK);
});

afterEach(() => {
  vi.restoreAllMocks();
  unflushedIds.clear();
});

describe("forceReloadFromDisk", () => {
  test("a conflicted tab resolves server-side after the destructive prompt", async () => {
    const tab = fileTab({ diskConflicted: true });
    resetLayout([tab]);
    const done = forceReloadFromDisk(tab.id);
    await Promise.resolve();
    resolveConfirm(true);
    await done;
    expect(resolveSpy).toHaveBeenCalledWith("notes/a.md", "reload");
    expect(readStreamSpy).not.toHaveBeenCalled();
    const t = readTab(tab.id)!;
    expect(t.content).toBe("disk content");
    expect(t.saved).toBe("disk content");
    expect(t.diskConflicted).toBe(false);
  });

  test("a declined prompt reloads nothing", async () => {
    const tab = fileTab({ content: "edited", saved: "hello" });
    resetLayout([tab]);
    const done = forceReloadFromDisk(tab.id);
    await Promise.resolve();
    resolveConfirm(false);
    await done;
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(readStreamSpy).not.toHaveBeenCalled();
    expect(readTab(tab.id)?.content).toBe("edited");
  });

  test("an attached clean tab resolves server-side without a prompt", async () => {
    const tab = fileTab({ doc: { state: "attached", peers: 0 } });
    resetLayout([tab]);
    await forceReloadFromDisk(tab.id);
    expect(resolveSpy).toHaveBeenCalledWith("notes/a.md", "reload");
    expect(readTab(tab.id)?.content).toBe("disk content");
  });

  test("a classic clean tab re-fetches; the resolve route is never touched", async () => {
    const tab = fileTab();
    resetLayout([tab]);
    await forceReloadFromDisk(tab.id);
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(readStreamSpy).toHaveBeenCalled();
    expect(readTab(tab.id)?.content).toBe("disk content");
  });

  test("a 404 (no live session) falls back to the classic re-fetch", async () => {
    resolveSpy.mockRejectedValue(new ApiError(404, "no live session"));
    const tab = fileTab({ doc: { state: "attached", peers: 0 } });
    resetLayout([tab]);
    await forceReloadFromDisk(tab.id);
    expect(readStreamSpy).toHaveBeenCalled();
    expect(readTab(tab.id)?.content).toBe("disk content");
  });

  test("a failed resolve on a LIVE session surfaces instead of re-fetching", async () => {
    // The diverted GET would re-serve the stale authority as if it
    // were a reload; the client must not fall back there.
    resolveSpy.mockRejectedValue(new ApiError(409, "could not be resolved"));
    const tab = fileTab({ doc: { state: "attached", peers: 0 } });
    resetLayout([tab]);
    await forceReloadFromDisk(tab.id);
    expect(readStreamSpy).not.toHaveBeenCalled();
    expect(readTab(tab.id)?.content).toBe("hello");
  });

  test("confirmed-but-unflushed authority edits still prompt", async () => {
    const tab = fileTab({ doc: { state: "attached", peers: 0 } });
    unflushedIds.add(tab.id);
    resetLayout([tab]);
    const done = forceReloadFromDisk(tab.id);
    await Promise.resolve();
    resolveConfirm(false);
    await done;
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(readStreamSpy).not.toHaveBeenCalled();
  });
});

describe("overwriteDiskConflict", () => {
  test("a conflicted tab overwrites server-side after the destructive prompt", async () => {
    const tab = fileTab({ diskConflicted: true });
    resetLayout([tab]);
    const done = overwriteDiskConflict(tab.id);
    await Promise.resolve();
    resolveConfirm(true);
    await done;
    expect(resolveSpy).toHaveBeenCalledWith("notes/a.md", "overwrite");
    expect(readTab(tab.id)?.diskConflicted).toBe(false);
  });

  test("a declined prompt overwrites nothing", async () => {
    const tab = fileTab({ diskConflicted: true });
    resetLayout([tab]);
    const done = overwriteDiskConflict(tab.id);
    await Promise.resolve();
    resolveConfirm(false);
    await done;
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  test("a non-conflicted tab is a no-op", async () => {
    const tab = fileTab();
    resetLayout([tab]);
    await overwriteDiskConflict(tab.id);
    expect(resolveSpy).not.toHaveBeenCalled();
  });
});
