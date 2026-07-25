// @vitest-environment jsdom

// sceneSync behavior pins: the capability probe, the push pump
// (coalescing + ack-based saved), snapshot/update fan-in through the
// canvas binding seam, presence, degrade-to-classic, the save funnel,
// and the tabs.svelte.ts delegate-array coexistence with docSync. The
// wire shapes match the serde pins in
// crates/chan-server/src/routes/scene.rs.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, sessionWindowId } from "../api/client";
import { setSocketFactory } from "../api/transport";
import {
  acquireSceneSession,
  isSceneSyncEligible,
  resetSceneSyncForTests,
  sceneSessionFor,
  sceneWsPath,
  type SceneCanvasBinding,
  type SceneSession,
  type WireAppState,
  type WireElement,
  type WireFiles,
} from "./sceneSync.svelte";
// Imported for the delegate-array coexistence pins: registers the doc
// delegates alongside the scene ones.
import { resetDocSyncForTests } from "./docSync.svelte";
import {
  isDocAttached,
  isDocSavePaused,
  layout,
  saveTab,
  type FileTab,
  type LeafNode,
} from "./tabs.svelte";

// ---- fake socket ------------------------------------------------------------

class FakeSocket {
  url: string;
  readyState = 0; // CONNECTING
  sent: string[] = [];
  closedByClient = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    sockets.push(this);
  }
  send(s: string): void {
    this.sent.push(s);
  }
  close(): void {
    this.closedByClient = true;
    this.readyState = 3;
  }
  // -- server-side test controls --
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  frame(f: unknown): void {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  frames(type?: string): Record<string, unknown>[] {
    const all = this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
    return type === undefined ? all : all.filter((f) => f.type === type);
  }
}

const sockets: FakeSocket[] = [];
const lastSocket = (): FakeSocket => sockets[sockets.length - 1]!;

// ---- fixtures ---------------------------------------------------------------

let nextTabId = 0;

const SCENE_BUFFER = JSON.stringify({
  type: "excalidraw",
  version: 2,
  source: "test",
  elements: [],
  appState: {},
  files: {},
});

function sceneTab(partial: Partial<FileTab> = {}): FileTab {
  nextTabId += 1;
  return {
    kind: "file",
    fileKind: "text",
    id: `scene-tab-${nextTabId}`,
    path: "boards/b.excalidraw",
    content: SCENE_BUFFER,
    saved: SCENE_BUFFER,
    savedMtime: 1,
    savedMtimeNs: "1000000000",
    mode: "canvas",
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
    id: "pane-scene-test",
    tabs,
    activeTabId: tabs[0]?.id ?? null,
  };
  layout.rootId = pane.id;
  layout.activePaneId = pane.id;
  layout.nodes = { [pane.id]: pane };
  layout.focusColor = "blue";
  return pane;
}

const MTIME = "1751234567890123456";

function elem(id: string, version = 1, extra: Record<string, unknown> = {}): WireElement {
  return {
    id,
    type: "rectangle",
    version,
    versionNonce: 1,
    index: "a1",
    isDeleted: false,
    ...extra,
  };
}

function snap(
  elements: WireElement[] = [],
  extra: Partial<{
    dirty: boolean;
    mtime_ns: string | null;
    cursors: unknown[];
    appState: WireAppState;
    files: WireFiles;
  }> = {},
): Record<string, unknown> {
  return {
    type: "snapshot",
    path: "boards/b.excalidraw",
    version: 0,
    elements,
    appState: {},
    files: {},
    dirty: false,
    mtime_ns: MTIME,
    cursors: [],
    ...extra,
  };
}

class FakeBinding implements SceneCanvasBinding {
  snapshots: { elements: WireElement[]; appState: WireAppState; files: WireFiles }[] = [];
  updates: { elements: WireElement[]; appState?: WireAppState; files?: WireFiles }[] = [];
  collabCalls = 0;
  pending: WireElement[] = [];
  session: SceneSession | null = null;
  applySnapshot(elements: WireElement[], appState: WireAppState, files: WireFiles): void {
    this.snapshots.push({ elements, appState, files });
  }
  applyUpdate(f: {
    elements: WireElement[];
    appState?: WireAppState;
    files?: WireFiles;
  }): void {
    this.updates.push(f);
  }
  collaboratorsChanged(): void {
    this.collabCalls += 1;
  }
  hasPendingLocal(): boolean {
    return this.pending.length > 0;
  }
  flushPendingLocal(): void {
    if (this.pending.length === 0 || !this.session) return;
    this.session.pushScene(this.pending.splice(0));
  }
}

/// Acquire + snapshot: a fully attached session with a bound canvas.
function attached(
  tab: FileTab,
  elements: WireElement[] = [],
): { session: SceneSession; binding: FakeBinding; sock: FakeSocket } {
  const session = acquireSceneSession(tab);
  expect(session).not.toBeNull();
  const sock = lastSocket();
  const binding = new FakeBinding();
  binding.session = session;
  session!.bindCanvas(binding);
  sock.open();
  sock.frame(snap(elements));
  return { session: session!, binding, sock };
}

async function flushMicro(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

beforeEach(() => {
  localStorage.setItem("chan.scenesync", "1");
  localStorage.setItem("chan.docsync", "1");
  sockets.length = 0;
  setSocketFactory((url) => new FakeSocket(url) as unknown as WebSocket);
});

afterEach(() => {
  resetSceneSyncForTests();
  resetDocSyncForTests();
  setSocketFactory(null);
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
});

// ---- eligibility ------------------------------------------------------------

describe("eligibility", () => {
  test("excalidraw canvas tabs qualify; other modes, kinds, drafts do not", () => {
    expect(isSceneSyncEligible(sceneTab())).toBe(true);
    expect(isSceneSyncEligible(sceneTab({ mode: "source" }))).toBe(false);
    expect(isSceneSyncEligible(sceneTab({ path: "notes/a.md" }))).toBe(false);
    expect(isSceneSyncEligible(sceneTab({ loading: true }))).toBe(false);
    expect(
      isSceneSyncEligible(
        sceneTab({ fileMissing: { path: "boards/b.excalidraw", fragment: null } }),
      ),
    ).toBe(false);
    expect(
      isSceneSyncEligible(sceneTab({ path: ".Drafts/untitled/draft.excalidraw" })),
    ).toBe(false);
    // Read-only tabs still attach: not an eligibility input.
    expect(isSceneSyncEligible(sceneTab({ readMode: true }))).toBe(true);
  });

  test("the flag defaults ON and localStorage '0' opts out", () => {
    localStorage.removeItem("chan.scenesync");
    expect(isSceneSyncEligible(sceneTab())).toBe(true);
    localStorage.setItem("chan.scenesync", "0");
    expect(isSceneSyncEligible(sceneTab())).toBe(false);
    expect(acquireSceneSession(sceneTab())).toBeNull();
  });

  test("oversized buffers refuse a session untracked", () => {
    const big = sceneTab({ content: "x".repeat(2 * 1024 * 1024 + 1) });
    expect(acquireSceneSession(big)).toBeNull();
  });

  test("the ws path pins the query parameter names", () => {
    expect(sceneWsPath("boards/b.excalidraw", "win-1")).toBe(
      "/api/scene/ws?path=boards%2Fb.excalidraw&w=win-1",
    );
  });
});

// ---- attach ----------------------------------------------------------------

describe("attach", () => {
  test("snapshot attaches: status, mtime stamp, binding fan-in with tombstones", () => {
    const tab = sceneTab();
    const dead = elem("gone", 3, { isDeleted: true });
    const { binding } = attached(tab, [elem("x"), dead]);
    expect(tab.doc?.state).toBe("attached");
    expect(tab.savedMtimeNs).toBe(MTIME);
    expect(tab.authorityVersion).toBe(0);
    expect(binding.snapshots).toHaveLength(1);
    expect(binding.snapshots[0]!.elements.map((e) => e.id)).toEqual(["x", "gone"]);
    expect(binding.collabCalls).toBeGreaterThan(0);
  });

  test("a canvas binding after the snapshot replays the shadow, updates included", () => {
    const tab = sceneTab();
    const session = acquireSceneSession(tab)!;
    const sock = lastSocket();
    sock.open();
    sock.frame(snap([elem("x")]));
    sock.frame({ type: "update", version: 1, elements: [elem("y", 2)] });
    expect(tab.doc?.state).toBe("attached");

    const binding = new FakeBinding();
    binding.session = session;
    session.bindCanvas(binding);
    expect(binding.snapshots).toHaveLength(1);
    expect(binding.snapshots[0]!.elements.map((e) => e.id).sort()).toEqual(["x", "y"]);
  });

  test("update frames reach a bound canvas verbatim", () => {
    const tab = sceneTab();
    const { binding, sock } = attached(tab);
    sock.frame({
      type: "update",
      version: 1,
      elements: [elem("y", 2)],
      appState: { gridSize: 20 },
      files: { f1: { dataURL: "data:x" } },
    });
    expect(binding.updates).toHaveLength(1);
    expect(binding.updates[0]!.elements[0]!.id).toBe("y");
    expect(binding.updates[0]!.appState).toEqual({ gridSize: 20 });
    expect(binding.updates[0]!.files).toEqual({ f1: { dataURL: "data:x" } });
  });
});

// ---- push pump --------------------------------------------------------------

describe("push pump", () => {
  test("pushScene sends, coalesces while in flight, drains on ack", () => {
    const tab = sceneTab();
    const { session, sock } = attached(tab);

    session.pushScene([elem("a", 1)]);
    expect(sock.frames("push")).toHaveLength(1);

    // In flight: two more pushes coalesce, same id keeps the latest.
    session.pushScene([elem("b", 1)], { gridSize: 10 });
    session.pushScene([elem("b", 2)], undefined, { f1: { dataURL: "data:x" } });
    expect(sock.frames("push")).toHaveLength(1);

    sock.frame({ type: "push-ok", version: 1 });
    const pushes = sock.frames("push");
    expect(pushes).toHaveLength(2);
    const drained = pushes[1]!;
    const els = drained.elements as WireElement[];
    expect(els).toHaveLength(1);
    expect(els[0]!.id).toBe("b");
    expect(els[0]!.version).toBe(2);
    expect(drained.appState).toEqual({ gridSize: 10 });
    expect(drained.files).toEqual({ f1: { dataURL: "data:x" } });
  });

  test("push-ok with nothing pending advances tab.saved to tab.content", () => {
    const tab = sceneTab();
    const { session, sock } = attached(tab);
    tab.content = SCENE_BUFFER.replace("[]", '[{"id":"a"}]');
    session.pushScene([elem("a", 1)]);
    expect(tab.saved).toBe(SCENE_BUFFER);

    sock.frame({ type: "push-ok", version: 1 });
    expect(tab.saved).toBe(tab.content);
  });

  test("pushes while the channel is down or read-only are dropped", () => {
    const tab = sceneTab({ readMode: true });
    const { session, sock } = attached(tab);
    session.pushScene([elem("a")]);
    expect(sock.frames("push")).toHaveLength(0);
  });
});

// ---- presence ---------------------------------------------------------------

describe("presence", () => {
  test("cursor frames count peer windows, repaint collaborators, and clean up", () => {
    const tab = sceneTab();
    const { session, binding, sock } = attached(tab);
    const paintsAfterAttach = binding.collabCalls;

    sock.frame({ type: "cursor", id: 7, w: "win-other", x: 4.5, y: 6, tool: "selection" });
    expect(session.peers()).toBe(1);
    expect(tab.doc?.peers).toBe(1);
    expect(binding.collabCalls).toBeGreaterThan(paintsAfterAttach);
    expect(session.peerCursorSnapshot().get(7)?.x).toBe(4.5);

    // Our own other-pane attachment does not count as a peer window.
    sock.frame({ type: "cursor", id: 9, w: sessionWindowId(), x: 0, y: 0 });
    expect(session.peers()).toBe(1);

    sock.frame({ type: "cursor-gone", id: 7 });
    expect(session.peers()).toBe(0);
    expect(tab.doc?.peers).toBe(0);
  });

  test("sendCursor throttles to the trailing edge", () => {
    vi.useFakeTimers();
    const tab = sceneTab();
    const { session, sock } = attached(tab);
    session.sendCursor(1, 1);
    session.sendCursor(2, 2);
    session.sendCursor(3, 3, "freedraw", ["a"]);
    expect(sock.frames("cursor")).toHaveLength(0);
    vi.advanceTimersByTime(150);
    const cursors = sock.frames("cursor");
    expect(cursors).toHaveLength(1);
    expect(cursors[0]!.x).toBe(3);
    expect(cursors[0]!.tool).toBe("freedraw");
    expect(cursors[0]!.selected).toEqual(["a"]);
  });
});

// ---- capability probe + degrade ----------------------------------------------

describe("probe and degrade", () => {
  test("a close before any frame latches scene sync off module-wide", () => {
    const tab = sceneTab();
    const session = acquireSceneSession(tab)!;
    const sock = lastSocket();
    sock.open();
    sock.drop();
    expect(tab.doc?.state).toBe("off");
    expect(session.ownsSaves()).toBe(false);
    // Latched: the next acquire refuses without dialing.
    expect(acquireSceneSession(sceneTab())).toBeNull();
  });

  test("repeated drops past the grace degrade; outage pauses classic saves", () => {
    vi.useFakeTimers();
    const tab = sceneTab();
    const { sock } = attached(tab);
    expect(tab.doc?.state).toBe("attached");

    sock.drop();
    expect(tab.doc?.state).toBe("reconnecting");
    expect(isDocAttached(tab)).toBe(true);

    // Redial 1 fails, redial 2 fails: attempts exceed the grace.
    vi.advanceTimersByTime(600);
    lastSocket().drop();
    expect(tab.doc?.state).toBe("reconnecting");
    vi.advanceTimersByTime(1200);
    lastSocket().drop();
    expect(tab.doc?.state).toBe("degraded");
    expect(isDocAttached(tab)).toBe(false);
    // Still-retrying connection outage: the classic PUT stays paused
    // (exercises the registered save-paused query through the array).
    expect(isDocSavePaused(tab)).toBe(true);

    // A later successful redial + snapshot heals to attached.
    vi.advanceTimersByTime(3000);
    const revived = lastSocket();
    revived.open();
    revived.frame(snap());
    expect(tab.doc?.state).toBe("attached");
  });

  test("a closed frame stops the session for good", () => {
    const tab = sceneTab();
    const { session, sock } = attached(tab);
    sock.frame({ type: "closed", reason: "reset" });
    expect(tab.doc?.state).toBe("off");
    expect(session.ownsSaves()).toBe(false);
  });

  test("a permanent error reason stops retries and degrades", () => {
    vi.useFakeTimers();
    const tab = sceneTab();
    const { sock } = attached(tab);
    sock.frame({ type: "error", message: "scene too big", reason: "doc-too-large" });
    expect(tab.doc?.state).toBe("degraded");
    const count = sockets.length;
    sock.drop();
    vi.advanceTimersByTime(10_000);
    expect(sockets.length).toBe(count);
    // Permanent stop, not a connection outage: classic saves resume.
    expect(isDocSavePaused(tab)).toBe(false);
  });
});

// ---- save funnel --------------------------------------------------------------

describe("save funnel", () => {
  test("flush resolves true at quiescence and false on flush error", async () => {
    const tab = sceneTab();
    const { session, sock } = attached(tab);

    // Clean and confirmed: resolves immediately.
    await expect(session.flush()).resolves.toBe(true);

    // Dirty authority: waits for the flush frame.
    sock.frame({ type: "update", version: 1, elements: [elem("y", 2)] });
    const pending = session.flush();
    sock.frame({ type: "flush", dirty: false, mtime_ns: "2000000000" });
    await expect(pending).resolves.toBe(true);
    expect(tab.savedMtimeNs).toBe("2000000000");

    // Flush error: resolves false and surfaces on the tab.
    sock.frame({ type: "update", version: 2, elements: [elem("z", 2)] });
    const failing = session.flush();
    sock.frame({ type: "flush", dirty: true, error: "disk full" });
    await expect(failing).resolves.toBe(false);
    expect(tab.error).toContain("disk full");
  });

  test("attached scene tabs save through the delegate arrays, never a PUT", async () => {
    const write = vi.spyOn(api, "write").mockResolvedValue({ mtime: 2, mtime_ns: "2" });
    const tab = sceneTab();
    resetLayout([tab]);
    attached(tab);
    await saveTab(tab);
    await flushMicro();
    expect(write).not.toHaveBeenCalled();
    expect(tab.error).toBeNull();
  });

  test("degraded scene tabs fall back to the classic PUT", async () => {
    const write = vi.spyOn(api, "write").mockResolvedValue({ mtime: 2, mtime_ns: "2" });
    const tab = sceneTab();
    resetLayout([tab]);
    const { session, sock } = attached(tab);
    sock.frame({ type: "closed", reason: "reset" });
    expect(session.ownsSaves()).toBe(false);
    tab.content = tab.content + "\n";
    await saveTab(tab);
    await flushMicro();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![4]).toBe(0);
  });
});

// ---- lifecycle ----------------------------------------------------------------

describe("lifecycle", () => {
  test("removed routes into the missing-file machinery", () => {
    const tab = sceneTab();
    resetLayout([tab]);
    const { sock } = attached(tab);
    sock.frame({ type: "removed" });
    expect(tab.savedMtimeNs).toBeNull();
    expect(tab.savedMtime).toBeNull();
    expect(tab.authorityVersion).toBeNull();
  });

  test("release lingers for a remount and immediate release detaches now", () => {
    vi.useFakeTimers();
    const tab = sceneTab();
    const { session, sock } = attached(tab);
    session.release();
    expect(sceneSessionFor(tab.id)).toBe(session);
    session.retain();
    vi.advanceTimersByTime(1000);
    expect(sceneSessionFor(tab.id)).toBe(session);
    expect(sock.closedByClient).toBe(false);

    session.release({ immediate: true });
    expect(sceneSessionFor(tab.id)).toBeUndefined();
    expect(sock.closedByClient).toBe(true);
    expect(tab.doc).toBeUndefined();
  });
});
