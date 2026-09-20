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
import { setSocketFactory } from "../api/transport";
import type { FileResponse } from "../api/types";
import { confirmState, resolveConfirm } from "./confirm.svelte";
import { acquireSceneSession, resetSceneSyncForTests } from "./sceneSync.svelte";
import {
  forceReloadFromDisk,
  layout,
  overwriteDiskConflict,
  registerLiveSessionKind,
  type FileTab,
  type LeafNode,
} from "./tabs.svelte";

/// Per-test control over the unflushed query (registered once,
/// module-global, like the real ones). A kind registers all five members,
/// so the four this fixture has no opinion on are written as the no-ops
/// they are rather than left out.
const unflushedIds = new Set<string>();
registerLiveSessionKind({
  save: async () => "classic",
  release: () => {},
  savePaused: () => false,
  unflushed: (tabId) => unflushedIds.has(tabId),
  fallbackSaved: () => {},
});

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

// ---- a live canvas session --------------------------------------------------
//
// The query above is this file's own stand-in for docSync's registration. The
// case below needs the REAL one: sceneSync fills three of the five
// live-session slots and registers no unflushed query at all, so a canvas tab
// holding a push the authority has not acknowledged answers "nothing
// unflushed" and the destructive reload runs with no warning.

const SCENE_BUFFER = JSON.stringify({
  type: "excalidraw",
  version: 2,
  source: "test",
  elements: [],
  appState: {},
  files: {},
});

class FakeSceneSocket {
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    sceneSockets.push(this);
  }
  send(s: string): void {
    this.sent.push(s);
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  frame(f: unknown): void {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
  frames(type: string): Record<string, unknown>[] {
    return this.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((f) => f.type === type);
  }
}

const sceneSockets: FakeSceneSocket[] = [];

function sceneTab(): FileTab {
  return fileTab({
    path: "boards/b.excalidraw",
    mode: "canvas",
    content: SCENE_BUFFER,
    saved: SCENE_BUFFER,
  });
}

describe("a canvas tab whose push the authority has not acknowledged", () => {
  beforeEach(() => {
    localStorage.setItem("chan.scenesync", "1");
    sceneSockets.length = 0;
    setSocketFactory((url) => new FakeSceneSocket(url) as unknown as WebSocket);
  });

  afterEach(() => {
    resetSceneSyncForTests();
    setSocketFactory(null);
    localStorage.clear();
  });

  test("warns before the reload discards it", async () => {
    const tab = sceneTab();
    resetLayout([tab]);
    const session = acquireSceneSession(tab)!;
    const sock = sceneSockets[sceneSockets.length - 1]!;
    sock.open();
    sock.frame({
      type: "snapshot",
      path: tab.path,
      version: 0,
      elements: [],
      appState: {},
      files: {},
      dirty: false,
      mtime_ns: "1751234567890123456",
      cursors: [],
    });

    session.pushScene([
      { id: "a", type: "rectangle", version: 2, versionNonce: 1, isDeleted: false },
    ]);
    // On the wire and unacknowledged: no push-ok has come back.
    expect(sock.frames("push")).toHaveLength(1);
    // The buffer itself is clean, so the prompt has exactly one reason to
    // fire and the assertions below cannot pass for another one.
    expect(tab.content).toBe(tab.saved);
    expect(tab.diskConflicted).toBeFalsy();

    const done = forceReloadFromDisk(tab.id);
    await Promise.resolve();
    const prompted = confirmState.open;
    resolveConfirm(false);
    await done;

    // Soft: the missing prompt is the defect and the two lines under it are
    // what the user loses because of it.
    expect.soft(prompted).toBe(true);
    expect.soft(resolveSpy).not.toHaveBeenCalled();
    expect.soft(readTab(tab.id)?.content).toBe(SCENE_BUFFER);
  });
});

