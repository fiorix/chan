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
  cancelPaneMode,
  commitPaneMode,
  enterPaneMode,
  isDocAttached,
  isDocSavePaused,
  isDocUnflushed,
  layout,
  reorderTab,
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

/// Read a tab back through the $state proxy. `layout` is $state, so it
/// wraps every tab it is handed: a write through the raw object and a
/// write through the proxy do not meet.
function readTab(id: string): FileTab | undefined {
  for (const node of Object.values(layout.nodes)) {
    if (node.kind !== "leaf") continue;
    const t = node.tabs.find((t) => t.id === id);
    if (t && t.kind === "file") return t;
  }
  return undefined;
}

/// Install these tabs and hand back the objects the layout holds. Every
/// component reads its tab from the layout, so the proxy is the only
/// object production hands to a session or to saveTab; a test holding
/// the raw object it built exercises a shape the app does not have.
function installTabs(tabs: FileTab[]): FileTab[] {
  resetLayout(tabs);
  return tabs.map((t) => readTab(t.id)!);
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
    // Mirrors the canvas: the deltas stay pending unless the session took
    // them, which is what lets a dropped push survive to the reconnect.
    if (this.session.pushScene(this.pending)) this.pending = [];
  }
  forgetBroadcast(elements: WireElement[]): void {
    // The canvas drops the broadcast mark, which puts the element back in
    // its delta set; here the pending list is that set.
    this.pending.push(...elements);
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
  // Hybrid Nav is module state: a test that enters and does not commit
  // would leave the next one reading a draft instead of the layout.
  cancelPaneMode();
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
    const [tab] = installTabs([sceneTab()]);
    attached(tab);
    await saveTab(tab);
    await flushMicro();
    expect(write).not.toHaveBeenCalled();
    expect(tab.error).toBeNull();
  });

  test("degraded scene tabs fall back to the classic PUT", async () => {
    const write = vi.spyOn(api, "write").mockResolvedValue({ mtime: 2, mtime_ns: "2" });
    const [tab] = installTabs([sceneTab()]);
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
    const [tab] = installTabs([sceneTab()]);
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

// ---- one writer, and the whole live-session contract -------------------------

describe("a degraded session has exactly one writer", () => {
  test("pushScene stops sending once the session degrades", () => {
    const [tab] = installTabs([sceneTab()]);
    const { session, sock } = attached(tab);
    expect(sock.frames("push")).toHaveLength(0);

    // Degrade with the channel still up: the classic autosave PUT takes over
    // (isDocAttached goes false) while this socket stays usable.
    session.degrade();
    expect(isDocAttached(tab)).toBe(false);

    session.pushScene([elem("a", 2)]);

    expect(sock.frames("push")).toHaveLength(0);
  });

  test("a classic save hands ownership back to a degraded session", async () => {
    vi.spyOn(api, "write").mockResolvedValue({ mtime: 2, mtime_ns: "2" });
    const [tab] = installTabs([sceneTab()]);
    const { session } = attached(tab);
    session.degrade();
    expect(session.ownsSaves()).toBe(false);

    tab.content = tab.content + "\n";
    await saveTab(tab);
    await flushMicro();

    expect(session.ownsSaves()).toBe(true);
  });
});


// ---- a session whose tab was replaced under it -------------------------------
//
// A move rebuilds a tab as a clone and a Hybrid Nav commit replaces the whole
// tree, while the session survives both without rebinding. Everything the
// session writes has to land on the object the layout holds, or the canvas
// reads a status its session left behind.

describe("a scene session follows its tab through a move", () => {
  test("a status change after a reorder reaches the tab in the layout", () => {
    const [tab] = installTabs([sceneTab(), sceneTab()]);
    const { session } = attached(tab!);
    expect(readTab(tab!.id)!.doc?.state).toBe("attached");

    reorderTab("pane-scene-test", tab!.id, 1);
    // The clone is a different object; the session was not told.
    expect(readTab(tab!.id)).not.toBe(tab);

    session.degrade();

    expect(readTab(tab!.id)!.doc?.state).toBe("degraded");
  });

  test("a status change during Hybrid Nav reaches the committed tab", async () => {
    // A commit replaces the tree with a clone of the draft taken at entry, so
    // a status mirrored while the draft was up lands on a tab the commit
    // throws away, and the committed tab keeps the "attached" it entered with.
    const write = vi.spyOn(api, "write").mockResolvedValue({ mtime: 2, mtime_ns: "2" });
    const [tab] = installTabs([sceneTab()]);
    const { session } = attached(tab!);
    expect(readTab(tab!.id)!.doc?.state).toBe("attached");

    enterPaneMode();
    session.degrade();
    commitPaneMode();

    const moved = readTab(tab!.id)!;
    expect(isDocAttached(moved)).toBe(false);
    expect(isDocSavePaused(moved)).toBe(false);

    moved.content = moved.content + "\n";
    await saveTab(moved);
    await flushMicro();

    expect(write).toHaveBeenCalledTimes(1);
  });
});

describe("the force-reload prompt can see unflushed scene state", () => {
  test("a canvas tab with an unconfirmed push reports unflushed", () => {
    const [tab] = installTabs([sceneTab()]);
    const { session, sock } = attached(tab);

    session.pushScene([elem("a", 2)]);
    expect(sock.frames("push")).toHaveLength(1);

    // No push-ok has landed, so the authority holds state the disk does not.
    expect(isDocUnflushed(tab.id)).toBe(true);
  });
});

// ---- does the classic PUT rescue the element? -------------------------------
//
// The server is not a participant in the loss: a push is the only way an
// element enters the authority, reattach is one-way, and while a session is
// live the classic PUT is diverted into that same authority, applied and
// flushed. So "lost from the file" turns entirely on whether the SPA sends the
// element down either channel during the outage.
//
// The canvas mirrors every serialize into `tab.content` whether or not a
// session is bound (the buffer half is pinned in ExcalidrawCanvas.test.ts), so
// the element is in the buffer the classic PUT would carry. What decides the
// case is whether that PUT fires, and these two arms are the two outages.

/// The scene buffer the canvas would have written after an element was drawn.
function sceneBufferWith(elementId: string): string {
  return JSON.stringify({
    type: "excalidraw",
    version: 2,
    source: "test",
    elements: [elem(elementId, 2)],
    appState: {},
    files: {},
  });
}

describe("an element drawn while the channel is down", () => {
  test("reaches the authority on the reconnect", () => {
    vi.useFakeTimers();
    const [tab] = installTabs([sceneTab()]);
    const { binding } = attached(tab!);

    // Past the reconnect grace: degraded, socket down, redial running.
    lastSocket().drop();
    vi.advanceTimersByTime(600);
    lastSocket().drop();
    vi.advanceTimersByTime(1200);
    lastSocket().drop();
    expect(readTab(tab!.id)!.doc?.state).toBe("degraded");

    // The user draws. Nothing can carry it right now, and the canvas has
    // to keep it: a push marked as sent here is the element that is lost.
    binding.pending.push(elem("drawn-during-outage", 2));
    binding.flushPendingLocal();
    expect(binding.hasPendingLocal()).toBe(true);

    // The redial lands and the authority answers with its snapshot. The
    // backoff doubles per attempt, so step until a new socket appears
    // rather than guessing a delay.
    const beforeRedial = sockets.length;
    for (let i = 0; i < 40 && sockets.length === beforeRedial; i += 1) {
      vi.advanceTimersByTime(250);
    }
    expect(sockets.length).toBeGreaterThan(beforeRedial);
    const back = lastSocket();
    back.open();
    back.frame(snap([]));

    expect(back.frames("push")).toHaveLength(1);
    expect(
      (back.frames("push")[0]!.elements as WireElement[]).map((e) => e.id),
    ).toEqual(["drawn-during-outage"]);
    expect(binding.hasPendingLocal()).toBe(false);
    vi.useRealTimers();
  });
});

describe("a push coalesced behind another", () => {
  // RED BY DESIGN until the coalescing branch stops claiming a payload it
  // can still discard.
  //
  // `pushScene` answers true when it folds elements into `queued`, and the
  // canvas reads true as "the authority has this" and marks them broadcast.
  // But `onSocketClosed` and `onSnapshot` both drop `queued`, and nothing
  // rewinds the broadcast marks, so those elements are never offered again:
  // they sit on the canvas, never reached the authority, and the next
  // push-ok finds nothing pending and advances `saved`, so the tab reads
  // clean. Draw A, draw B inside A's ack window, blip the socket.
  test("is re-offered after the drop that discarded it", () => {
    vi.useFakeTimers();
    const [tab] = installTabs([sceneTab()]);
    const { binding } = attached(tab!);

    binding.pending.push(elem("a", 2));
    binding.flushPendingLocal();
    expect(lastSocket().frames("push")).toHaveLength(1);

    // B lands inside A's ack window, so it is coalesced, not sent.
    binding.pending.push(elem("b", 2));
    binding.flushPendingLocal();
    expect(lastSocket().frames("push")).toHaveLength(1);

    // The socket blips before either is acked; the queue goes with it.
    lastSocket().drop();
    vi.advanceTimersByTime(600);
    const beforeRedial = sockets.length;
    for (let i = 0; i < 40 && sockets.length === beforeRedial; i += 1) {
      vi.advanceTimersByTime(250);
    }
    const back = lastSocket();
    back.open();
    back.frame(snap([]));

    const ids = back
      .frames("push")
      .flatMap((f) => (f.elements as WireElement[]).map((e) => e.id));
    expect(ids, "the coalesced element reaches the authority").toContain("b");
    vi.useRealTimers();
  });
});

describe("the classic PUT during an outage", () => {
  test("a still-retrying socket outage sends nothing at all", async () => {
    vi.useFakeTimers();
    const write = vi.spyOn(api, "write").mockResolvedValue({ mtime: 2, mtime_ns: "2" });
    const [tab] = installTabs([sceneTab()]);
    const { sock } = attached(tab);

    // Past the reconnect grace: degraded, socket down, redial still running.
    sock.drop();
    vi.advanceTimersByTime(600);
    lastSocket().drop();
    vi.advanceTimersByTime(1200);
    lastSocket().drop();
    expect(tab.doc?.state).toBe("degraded");
    expect(isDocSavePaused(tab)).toBe(true);

    tab.content = sceneBufferWith("drawn-during-outage");
    await saveTab(tab);
    await flushMicro();

    // Neither channel carried it: the push was dropped and the PUT is
    // suppressed because it would hit the same unreachable server.
    expect(write).not.toHaveBeenCalled();
  });

  test("a degraded session whose socket is up PUTs the element", async () => {
    const write = vi.spyOn(api, "write").mockResolvedValue({ mtime: 2, mtime_ns: "2" });
    const [tab] = installTabs([sceneTab()]);
    const { session } = attached(tab);
    session.degrade();
    expect(isDocSavePaused(tab)).toBe(false);

    tab.content = sceneBufferWith("drawn-during-outage");
    await saveTab(tab);
    await flushMicro();

    expect(write).toHaveBeenCalledTimes(1);
    expect(String(write.mock.calls[0]![1])).toContain("drawn-during-outage");
  });
});

