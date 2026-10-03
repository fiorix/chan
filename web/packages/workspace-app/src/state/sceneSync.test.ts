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
  SCENE_ATTACH_TIMEOUT_MS,
  SCENE_FLUSH_TIMEOUT_MS,
  SCENE_FALLBACK_SETTLE_MS,
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
  activeLayout,
  cancelPaneMode,
  closePane,
  closeTab,
  commitPaneMode,
  enterPaneMode,
  isDocAttached,
  isDocSavePaused,
  isDocUnflushed,
  isDirty,
  reorderTab,
  saveTab,
  scheduleAutosave,
  type FileTab,
  type LeafNode,
} from "./tabs.svelte";
import { fileTab, readTab, resetLayout as harnessResetLayout } from "../__tests__/tabs";

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
  return fileTab({
    fileKind: "text",
    id: `scene-tab-${nextTabId}`,
    path: "boards/b.excalidraw",
    content: SCENE_BUFFER,
    saved: SCENE_BUFFER,
    savedMtimeNs: "1000000000",
    mode: "canvas",
    ...partial,
  });
}

function resetLayout(tabs: FileTab[]): LeafNode {
  return harnessResetLayout(tabs, { id: "pane-scene-test" });
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
  snapshots: { elements: WireElement[]; appState: WireAppState | undefined; files: WireFiles }[] = [];
  updates: { elements: WireElement[]; appState?: WireAppState; files?: WireFiles }[] = [];
  collabCalls = 0;
  pending: WireElement[] = [];
  // The canvas's other two marks: `knownFiles` excludes a file from every
  // later push once it is added, and `lastAuthorityAppStateJson` does the
  // same for the appState. Here "still pending" stands for "not marked".
  pendingFiles: WireFiles = {};
  pendingAppState: WireAppState | null = null;
  session: SceneSession | null = null;
  applySnapshot(elements: WireElement[], appState: WireAppState | undefined, files: WireFiles): void {
    this.snapshots.push({ elements, appState, files });
    this.adopt(elements, appState, files);
  }
  applyUpdate(f: {
    elements: WireElement[];
    appState?: WireAppState;
    files?: WireFiles;
  }): void {
    this.updates.push(f);
    this.adopt(f.elements, f.appState, f.files);
  }
  /// The canvas's adopt of a frame moves its three marks: an element the
  /// frame holds at the same or a newer version is noted as the authority's,
  /// a file the frame names is known, and a handed appState becomes both what
  /// the next push offers and the authority's, so none of them stays pending.
  private adopt(elements: WireElement[], appState?: WireAppState, files?: WireFiles): void {
    const held = new Map(elements.map((el) => [el.id, Number(el.version)]));
    this.pending = this.pending.filter((el) => !(Number(el.version) <= (held.get(el.id) ?? -1)));
    if (files !== undefined) {
      this.pendingFiles = Object.fromEntries(Object.entries(this.pendingFiles).filter(([k]) => !(k in files)));
    }
    if (appState !== undefined) this.pendingAppState = null;
  }
  collaboratorsChanged(): void {
    this.collabCalls += 1;
  }
  hasPendingLocal(): boolean {
    return this.pending.length > 0;
  }
  flushPendingLocal(): void {
    if (!this.session) return;
    const files = Object.keys(this.pendingFiles).length > 0 ? this.pendingFiles : undefined;
    const appState = this.pendingAppState ?? undefined;
    if (this.pending.length === 0 && files === undefined && appState === undefined) return;
    // Mirrors the canvas: the deltas stay pending unless the session took
    // them, which is what lets a dropped push survive to the reconnect.
    if (this.session.pushScene(this.pending, appState, files)) {
      this.pending = [];
      this.pendingFiles = {};
      this.pendingAppState = null;
    }
  }
  forgetBroadcast(elements: WireElement[], appState?: WireAppState, files?: WireFiles): void {
    // The canvas drops the broadcast mark, which puts the element back in
    // its delta set; here the pending list is that set. The file keys and
    // the appState come back the same way, until an adopt moves them.
    this.pending.push(...elements);
    if (files !== undefined) this.pendingFiles = { ...this.pendingFiles, ...files };
    if (appState !== undefined) this.pendingAppState = appState;
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

/// A canvas that binds in place of `old`, as after a remount, with the
/// session's replay recorded on it.
function rebind(session: SceneSession, old: FakeBinding): FakeBinding {
  session.unbindCanvas(old);
  const next = new FakeBinding();
  next.session = session;
  session.bindCanvas(next);
  return next;
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
  test("a fallback redial keeps its own attach window", async () => {
    vi.useFakeTimers();
    const tab = sceneTab();
    const { session, sock } = attached(tab);
    sock.drop();
    await vi.advanceTimersByTimeAsync(500);
    lastSocket().drop();
    await vi.advanceTimersByTimeAsync(1000);
    lastSocket().drop();
    expect(tab.doc?.state).toBe("degraded");

    await vi.advanceTimersByTimeAsync(2000);
    const retry = lastSocket();
    retry.open();
    await vi.advanceTimersByTimeAsync(1000);
    session.healAfterFallbackSave();
    const healed = lastSocket();
    expect(healed).not.toBe(retry);
    expect(retry.closedByClient).toBe(true);

    await vi.advanceTimersByTimeAsync(SCENE_ATTACH_TIMEOUT_MS - 1000 + 1);
    expect(healed.closedByClient, "the previous dial must not close the new socket").toBe(false);
    await vi.advanceTimersByTimeAsync(999);
    expect(healed.closedByClient, "the new dial must still time out on its own deadline").toBe(true);
  });

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

    // Flush error: resolves false and says so on the save line.
    sock.frame({ type: "update", version: 2, elements: [elem("z", 2)] });
    const failing = session.flush();
    sock.frame({ type: "flush", dirty: true, error: "disk full" });
    await expect(failing).resolves.toBe(false);
    expect(tab.saveError).toContain("disk full");
  });

  test("a flush error keeps the board and says the file is not saved until a flush lands", () => {
    const tab = sceneTab();
    const { sock } = attached(tab);
    sock.frame({ type: "update", version: 1, elements: [elem("y", 2)] });
    sock.frame({ type: "flush", dirty: true, error: "disk full" });
    const failed = { error: tab.error, saveError: tab.saveError ?? null };
    sock.frame({ type: "flush", dirty: false, mtime_ns: "2000000000" });
    expect({ failed, landed: tab.saveError ?? null }).toEqual({
      failed: { error: null, saveError: "the server could not write it (disk full)" },
      landed: null,
    });
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

  test("a save whose flush fails sends its PUT after the push on the wire, with the version it stamps", async () => {
    vi.useFakeTimers();
    try {
      const write = vi.spyOn(api, "write").mockResolvedValue({ mtime: 2, mtime_ns: "2" });
      const [tab] = installTabs([sceneTab()]);
      const { session, sock } = attached(tab);
      session.pushScene([elem("a", 2)]);
      tab.content = tab.content + "\n";
      const saving = saveTab(tab);
      // The flush never answers, so the save degrades once its bound passes.
      await vi.advanceTimersByTimeAsync(SCENE_FLUSH_TIMEOUT_MS + 1);
      const beforeAck = write.mock.calls.length;
      sock.frame({ type: "push-ok", version: 7 });
      await vi.advanceTimersByTimeAsync(0);
      await saving;
      expect({ beforeAck, calls: write.mock.calls.length, version: write.mock.calls[0]?.[4] }).toEqual({
        beforeAck: 0,
        calls: 1,
        version: 7,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("a delayed scene ack beyond both save bounds withholds the PUT", async () => {
    vi.useFakeTimers();
    const write = vi.spyOn(api, "write").mockResolvedValue({ mtime: 2, mtime_ns: "2" });
    const [tab] = installTabs([sceneTab()]);
    const { session, sock } = attached(tab);
    session.pushScene([elem("late", 2)]);
    tab.content = sceneBufferWith("late");
    const saving = saveTab(tab);
    await vi.advanceTimersByTimeAsync(SCENE_FLUSH_TIMEOUT_MS + SCENE_FALLBACK_SETTLE_MS + 1);
    await saving;
    expect(write, "unresolved scene push must not race a PUT").not.toHaveBeenCalled();
    expect(tab.content).toContain("late");
    expect(tab.saveError).toContain("push");
    expect(tab.error).toBeNull();
    expect(isDirty(tab)).toBe(true);
    expect(isDocUnflushed(tab.id)).toBe(true);
    await saveTab(tab);
    expect(write, "repeated save must stay withheld").not.toHaveBeenCalled();
    scheduleAutosave("pane-scene-test", tab.id);
    await vi.advanceTimersByTimeAsync(801);
    expect(write, "autosave must stay withheld").not.toHaveBeenCalled();
    sock.frame({ type: "push-ok", version: 1 });
    await saveTab(tab);
    expect(write).toHaveBeenCalledTimes(1);
  });

  test("a queued second scene push keeps fallback withheld after the first ack", async () => {
    vi.useFakeTimers();
    const write = vi.spyOn(api, "write").mockResolvedValue({ mtime: 2, mtime_ns: "2" });
    const [tab] = installTabs([sceneTab()]);
    const { session, sock } = attached(tab);
    session.pushScene([elem("first", 2)]);
    session.pushScene([elem("second", 2)]);
    tab.content = sceneBufferWith("second");
    const saving = saveTab(tab);
    await vi.advanceTimersByTimeAsync(SCENE_FLUSH_TIMEOUT_MS + SCENE_FALLBACK_SETTLE_MS + 1);
    await saving;
    sock.frame({ type: "push-ok", version: 1 });
    expect(sock.frames("push")).toHaveLength(2);
    await saveTab(tab);
    expect(write, "first ack cannot settle a queued second push").not.toHaveBeenCalled();
    sock.frame({ type: "push-ok", version: 2 });
    await saveTab(tab);
    expect(write).toHaveBeenCalledTimes(1);
  });

  test("an ack after the settle timer fires but before its continuation permits fallback", async () => {
    vi.useFakeTimers();
    const write = vi.spyOn(api, "write").mockResolvedValue({ mtime: 2, mtime_ns: "2" });
    const [tab] = installTabs([sceneTab()]);
    const { session, sock } = attached(tab);
    session.pushScene([elem("boundary", 2)]);
    tab.content = sceneBufferWith("boundary");
    const saving = saveTab(tab);
    await vi.advanceTimersByTimeAsync(SCENE_FLUSH_TIMEOUT_MS);
    vi.advanceTimersByTime(SCENE_FALLBACK_SETTLE_MS);
    sock.frame({ type: "push-ok", version: 7 });
    await saving;

    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[4]).toBe(7);
  });

  test("a deliberate closed frame leaves an unanswered scene push unsaved", async () => {
    const write = vi.spyOn(api, "write");
    const [tab] = installTabs([sceneTab()]);
    const { session, sock } = attached(tab);
    session.pushScene([elem("retired", 2)]);
    tab.content = sceneBufferWith("retired");
    sock.frame({ type: "closed", reason: "reset" });
    await saveTab(tab);

    expect(write, "retirement cannot settle an unanswered push").not.toHaveBeenCalled();
    expect(tab.doc?.state).toBe("off");
    expect(tab.content).toContain("retired");
    expect(tab.saveError).toContain("push");
    expect(tab.error).toBeNull();
    expect(isDirty(tab)).toBe(true);
  });

  test("a save timeout marks the tab committed by pane mode", async () => {
    vi.useFakeTimers();
    const write = vi.spyOn(api, "write");
    const [tab] = installTabs([sceneTab()]);
    const { session } = attached(tab);
    session.pushScene([elem("moved", 2)]);
    tab.content = sceneBufferWith("moved");
    const saving = saveTab(tab);
    await vi.advanceTimersByTimeAsync(SCENE_FLUSH_TIMEOUT_MS);
    enterPaneMode();
    commitPaneMode();
    const moved = readTab(tab.id)!;
    expect(moved).not.toBe(tab);
    await vi.advanceTimersByTimeAsync(SCENE_FALLBACK_SETTLE_MS);
    await saving;

    expect(write).not.toHaveBeenCalled();
    expect(moved.content).toContain("moved");
    expect(moved.saveError).toContain("push");
    expect(isDirty(moved)).toBe(true);
  });

  test("a lost scene socket retains its claim until a fresh snapshot and live flush", async () => {
    vi.useFakeTimers();
    const write = vi.spyOn(api, "write");
    const [tab] = installTabs([sceneTab()]);
    const { session, sock, binding } = attached(tab);
    session.pushScene([elem("local", 2)]);
    tab.content = sceneBufferWith("local");
    const saving = saveTab(tab);
    await vi.advanceTimersByTimeAsync(SCENE_FLUSH_TIMEOUT_MS + SCENE_FALLBACK_SETTLE_MS + 1);
    await saving;
    sock.frame(snap([]));
    expect(tab.unresolvedLivePush).toBe(true);
    expect(write, "same-socket snapshot cannot settle the claim").not.toHaveBeenCalled();
    sock.drop();
    expect(binding.pending.map((e) => e.id)).toContain("local");
    expect(tab.unresolvedLivePush).toBe(true);
    expect(write, "socket close cannot settle the claim").not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    const back = lastSocket();
    back.open();
    back.frame(snap([]));
    expect(back.frames("push")).toHaveLength(1);
    const recovered = saveTab(tab);
    back.frame({ type: "push-ok", version: 1 });
    back.frame({ type: "flush", dirty: false, mtime_ns: "9000000000" });
    await recovered;
    expect(write).not.toHaveBeenCalled();
    expect(tab.saveError).toBeNull();
    expect(isDirty(tab)).toBe(false);
  });
});

// The authority acks a push at once and writes the file after its debounce,
// and it acks a push that changed nothing and writes nothing after it. So the
// ack says which it was, and a save that waited on the push answers saved only
// once the file holds it.
describe("a save that waits on this window's own push", () => {
  /// A save waiting on the session's flush, and what it has answered so far:
  /// null until it answers.
  function waitingSave(session: SceneSession): () => boolean | null {
    let answer: boolean | null = null;
    void session.flush().then((ok) => {
      answer = ok;
    });
    return () => answer;
  }

  test("answers at the authority's flush frame when the push changed the scene, not at its ack", async () => {
    const [tab] = installTabs([sceneTab()]);
    const { session, sock } = attached(tab!);
    session.pushScene([elem("mine", 2)]);
    const answer = waitingSave(session);
    sock.frame({ type: "push-ok", version: 1, changed: true });
    await flushMicro();
    const atAck = answer();
    sock.frame({ type: "flush", dirty: false, mtime_ns: "2000000000" });
    await flushMicro();

    expect({ atAck, atFlush: answer() }).toEqual({ atAck: null, atFlush: true });
  });

  test.each([
    ["changed nothing", { changed: false }],
    ["does not say whether it changed anything", {}],
  ])("answers at the ack of a push that %s", async (_what, said) => {
    const [tab] = installTabs([sceneTab()]);
    const { session, sock } = attached(tab!);
    session.pushScene([elem("mine", 2)]);
    const answer = waitingSave(session);
    sock.frame({ type: "push-ok", version: 0, ...said });
    await flushMicro();

    expect(answer()).toBe(true);
  });

  test("still waits for the flush frame of a peer's edit when its own push changed nothing", async () => {
    const [tab] = installTabs([sceneTab()]);
    const { session, sock } = attached(tab!);
    sock.frame({ type: "update", version: 1, elements: [elem("peer", 2)] });
    session.pushScene([elem("mine", 2)]);
    const answer = waitingSave(session);
    sock.frame({ type: "push-ok", version: 1, changed: false });
    await flushMicro();
    const atAck = answer();
    sock.frame({ type: "flush", dirty: false, mtime_ns: "2000000000" });
    await flushMicro();

    expect({ atAck, atFlush: answer() }).toEqual({ atAck: null, atFlush: true });
  });
});

// A tab can hold a session and no board: a restored drawing nobody brought to
// the front, or a board whose library never reported its init. Its buffer is
// as old as its load while the session keeps stamping the authority's tokens
// on the tab, so a classic write of it would pass the server's check and
// delete every element a peer drew since.
describe("a save of a drawing whose session has no canvas", () => {
  /// A tab attached with no canvas bound, over an authority a peer has
  /// drawn on since the tab's load and has not written.
  function unboundOverPeerEdit() {
    const write = vi.spyOn(api, "write").mockResolvedValue({ mtime: 2, mtime_ns: "2" });
    const [tab] = installTabs([sceneTab()]);
    const session = acquireSceneSession(tab!)!;
    const sock = lastSocket();
    sock.open();
    sock.frame(snap());
    sock.frame({ type: "update", version: 1, elements: [elem("peer", 2)] });
    return { tab: tab!, session, sock, write };
  }

  test("writes nothing when its flush fails by an error frame, and says the file was not saved", async () => {
    const { tab, session, sock, write } = unboundOverPeerEdit();
    const saving = saveTab(tab);
    sock.frame({ type: "flush", dirty: true, error: "disk full" });
    await saving;
    await flushMicro();

    expect({ writes: write.mock.calls.length, said: tab.saveError }).toEqual({
      writes: 0,
      said: "the server could not write it (disk full)",
    });
    expect({ state: tab.doc?.state, owns: session.ownsSaves(), unflushed: isDocUnflushed(tab.id) }).toEqual({
      state: "attached",
      owns: true,
      unflushed: true,
    });
  });

  test("writes nothing when its flush times out, says why, and saves once the authority has written", async () => {
    vi.useFakeTimers();
    const { tab, sock, write } = unboundOverPeerEdit();
    const saving = saveTab(tab);
    await vi.advanceTimersByTimeAsync(SCENE_FLUSH_TIMEOUT_MS + SCENE_FALLBACK_SETTLE_MS + 1);
    await saving;
    expect({ writes: write.mock.calls.length, said: tab.saveError }).toEqual({
      writes: 0,
      said: "the server has not written it, and this tab has no board open to save it from",
    });

    sock.frame({ type: "flush", dirty: false, mtime_ns: "2000000000" });
    await saveTab(tab);
    expect({ writes: write.mock.calls.length, said: tab.saveError ?? null }).toEqual({ writes: 0, said: null });
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

  // A pane's close leaves each session to its host's lingering release, so a
  // board torn down with the pane can still hand over what it commits. A
  // forced one drops that, as a forced tab close does.
  test.each([
    ["a pane's close leaves its tab's session attached", undefined, false],
    ["a forced pane close detaches its tab's session at once", { force: true }, true],
  ])("%s", async (_what, opts, detached) => {
    const [tab] = installTabs([sceneTab()]);
    const { sock } = attached(tab!);
    await closePane("pane-scene-test", opts);

    expect({ gone: readTab(tab!.id) === undefined, detached: sock.closedByClient }).toEqual({ gone: true, detached });
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

  test("a push the authority took and has not written reports unflushed until its flush frame", () => {
    const [tab] = installTabs([sceneTab()]);
    const { session, sock } = attached(tab!);
    session.pushScene([elem("a", 2)]);
    sock.frame({ type: "push-ok", version: 1, changed: true });
    const acked = isDocUnflushed(tab!.id);
    sock.frame({ type: "flush", dirty: false, mtime_ns: "2000000000" });

    expect({ acked, written: isDocUnflushed(tab!.id) }).toEqual({ acked: true, written: false });
  });

  test("a push that changed nothing reports nothing unflushed once it is acked", () => {
    const [tab] = installTabs([sceneTab()]);
    const { session, sock } = attached(tab!);
    session.pushScene([elem("a", 2)]);
    sock.frame({ type: "push-ok", version: 0, changed: false });

    expect(isDocUnflushed(tab!.id)).toBe(false);
  });
});

describe("the saved mark after the canvas mirrors its board", () => {
  // The buffer as the canvas writes it after a peer's element reached the board.
  const MIRRORED = sceneBufferWith("peer");

  test("moves when nothing of this window is unconfirmed", () => {
    const [tab] = installTabs([sceneTab()]);
    const { session } = attached(tab!);
    tab!.content = MIRRORED;
    session.bufferMirrored();

    expect(tab!.saved).toBe(MIRRORED);
  });

  test("stays while an element of this window is not handed over", () => {
    const [tab] = installTabs([sceneTab()]);
    const { session, binding } = attached(tab!);
    binding.pending.push(elem("mine", 2));
    tab!.content = MIRRORED;
    session.bufferMirrored();

    expect(tab!.saved).toBe(SCENE_BUFFER);
  });

  test("stays while a push of this window is on the wire or queued behind it", () => {
    const [tab] = installTabs([sceneTab()]);
    const { session, binding, sock } = attached(tab!);
    binding.pending.push(elem("mine", 2));
    binding.flushPendingLocal();
    binding.pending.push(elem("mine", 3));
    binding.flushPendingLocal();
    tab!.content = MIRRORED;
    session.bufferMirrored();
    const whileQueued = tab!.saved;
    sock.frame({ type: "push-ok", version: 1 });
    session.bufferMirrored();

    expect({ pushes: sock.frames("push").length, whileQueued, onTheWire: tab!.saved }).toEqual({
      pushes: 2,
      whileQueued: SCENE_BUFFER,
      onTheWire: SCENE_BUFFER,
    });
  });

  test.each([
    ["degraded", (session: SceneSession) => session.degrade()],
    ["reconnecting", (_session: SceneSession, sock: FakeSocket) => sock.drop()],
  ])("stays while the session is %s", (state, leave) => {
    vi.useFakeTimers();
    const [tab] = installTabs([sceneTab()]);
    const { session, sock } = attached(tab!);
    leave(session, sock);
    tab!.content = MIRRORED;
    session.bufferMirrored();

    expect({ state: tab!.doc?.state, saved: tab!.saved }).toEqual({ state, saved: SCENE_BUFFER });
  });

  test("a frame does not move it, since the buffer may hold an appState this window has not pushed", () => {
    const [tab] = installTabs([sceneTab()]);
    const { binding, sock } = attached(tab!);
    binding.pendingAppState = { gridModeEnabled: true };
    tab!.content = MIRRORED;
    sock.frame({ type: "update", version: 1, elements: [elem("peer", 2)] });

    expect(tab!.saved).toBe(SCENE_BUFFER);
  });
});

// While Hybrid Nav is up the app renders the draft, so a board mirrors into
// the draft's tab, and the commit puts that buffer over the saved text of the
// tab the session marked meanwhile, the one the mode was entered with.
describe("the saved mark through a Hybrid Nav commit", () => {
  /// The tab the app renders while the mode is up: the draft's copy.
  function renderedTab(id: string): FileTab {
    for (const node of Object.values(activeLayout().nodes)) {
      if (node.kind !== "leaf") continue;
      const tab = node.tabs.find((t) => t.id === id);
      if (tab?.kind === "file") return tab;
    }
    throw new Error(`no rendered tab ${id}`);
  }

  /// What the board's flush does with `buffer` during the mode: write it
  /// into the rendered tab and tell the session.
  function mirror(session: SceneSession, tabId: string, buffer: string): void {
    renderedTab(tabId).content = buffer;
    session.bufferMirrored();
  }

  test("a peer's element mirrored during the mode reads saved after the commit, and the tab's close closes it", async () => {
    const [tab] = installTabs([sceneTab()]);
    const { session, sock } = attached(tab!);
    enterPaneMode();
    sock.frame({ type: "update", version: 1, elements: [elem("peer", 2)] });
    mirror(session, tab!.id, sceneBufferWith("peer"));
    // The authority has written the peer's edit.
    sock.frame({ type: "flush", dirty: false, mtime_ns: "2000000000" });
    commitPaneMode();
    const committed = readTab(tab!.id)!;
    const dirty = isDirty(committed);
    await closeTab("pane-scene-test", tab!.id);

    expect(committed.content).toBe(sceneBufferWith("peer"));
    expect({ dirty, closed: readTab(tab!.id) === undefined }).toEqual({ dirty: false, closed: true });
  });

  test.each([
    ["on the wire", (binding: FakeBinding) => binding.flushPendingLocal()],
    ["not handed over", () => {}],
  ])("a stroke of this window's that is %s reads unsaved after the commit", (_where, hand) => {
    const [tab] = installTabs([sceneTab()]);
    const { session, binding } = attached(tab!);
    enterPaneMode();
    binding.pending.push(elem("mine", 2));
    hand(binding);
    mirror(session, tab!.id, sceneBufferWith("mine"));
    commitPaneMode();

    expect(isDirty(readTab(tab!.id)!)).toBe(true);
  });

  test("a stroke on the wire at the commit reads saved at its ack", () => {
    const [tab] = installTabs([sceneTab()]);
    const { session, binding, sock } = attached(tab!);
    enterPaneMode();
    binding.pending.push(elem("mine", 2));
    binding.flushPendingLocal();
    mirror(session, tab!.id, sceneBufferWith("mine"));
    commitPaneMode();
    sock.frame({ type: "push-ok", version: 1 });

    expect(isDirty(readTab(tab!.id)!)).toBe(false);
  });

  test("a session whose canvas is gone leaves the mark of a buffer nothing mirrored", () => {
    const [tab] = installTabs([sceneTab()]);
    const { session, binding } = attached(tab!);
    session.unbindCanvas(binding);
    enterPaneMode();
    // No board writes this buffer, so the session cannot speak for it.
    renderedTab(tab!.id).content = sceneBufferWith("typed");
    commitPaneMode();

    expect(isDirty(readTab(tab!.id)!)).toBe(true);
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

describe("a push the authority never accepted", () => {
  /// Drive one push, drop the socket before its ack, and run the redial to
  /// the snapshot that opens the next epoch. Returns the reconnected socket.
  function dropAndRedial(snapshot: Record<string, unknown> = snap([])): FakeSocket {
    lastSocket().drop();
    vi.advanceTimersByTime(600);
    const beforeRedial = sockets.length;
    for (let i = 0; i < 40 && sockets.length === beforeRedial; i += 1) {
      vi.advanceTimersByTime(250);
    }
    const back = lastSocket();
    back.open();
    back.frame(snapshot);
    return back;
  }

  test("offers its files again", () => {
    // Paste an image and blip the socket before the ack. The element is
    // handed back, so the authority gets it on the reconnect, but a file
    // key that stays marked is excluded from every later push: the
    // authority ends up holding an element that references a file it does
    // not have, which is a broken image for every other participant and
    // after any reload. The snapshot cannot repair it either, because
    // applying one only adds the keys the authority already has.
    vi.useFakeTimers();
    const [tab] = installTabs([sceneTab()]);
    const { binding } = attached(tab!);

    binding.pending.push(elem("pasted", 2));
    binding.pendingFiles = { "file-a": { dataURL: "data:image/png;base64,AAA" } };
    binding.flushPendingLocal();
    expect(lastSocket().frames("push")).toHaveLength(1);

    const back = dropAndRedial();

    const ids = back
      .frames("push")
      .flatMap((f) => (f.elements as WireElement[]).map((e) => e.id));
    expect(ids, "the element half already works").toContain("pasted");
    const keys = back
      .frames("push")
      .flatMap((f) => Object.keys((f.files ?? {}) as WireFiles));
    expect(keys, "the pasted file reaches the authority").toContain("file-a");
    vi.useRealTimers();
  });

  test("gives up its appState to the reattach's snapshot and pushes its element", () => {
    // Same drop with an appState change riding the push. The session hands
    // the canvas the reattach's snapshot before it asks for a push, and the
    // adopt makes the snapshot's appState both what the next push offers and
    // the authority's, so the change is not offered again. The element the
    // snapshot lacks is.
    vi.useFakeTimers();
    const [tab] = installTabs([sceneTab()]);
    const { binding } = attached(tab!);

    binding.pending.push(elem("a", 2));
    binding.pendingAppState = { gridModeEnabled: true };
    binding.flushPendingLocal();
    expect(lastSocket().frames("push")).toHaveLength(1);

    const back = dropAndRedial(snap([], { appState: { gridModeEnabled: false } }));

    expect({
      elements: back.frames("push").flatMap((f) => (f.elements as WireElement[]).map((e) => e.id)),
      appStates: back.frames("push").flatMap((f) => (f.appState === undefined ? [] : [f.appState])),
      adopted: binding.snapshots.at(-1)?.appState,
      pending: binding.pendingAppState,
    }).toEqual({ elements: ["a"], appStates: [], adopted: { gridModeEnabled: false }, pending: null });
    vi.useRealTimers();
  });

  test("hands the canvas the appState an update's withhold kept from it", () => {
    // Here the claim that kept a peer's appState off the board is dropped
    // with its socket before the authority reads it, so the peer's appState
    // is what stands, and the next socket's snapshot carries it.
    vi.useFakeTimers();
    const [tab] = installTabs([sceneTab()]);
    const { binding, sock } = attached(tab!);
    binding.pendingAppState = { viewBackgroundColor: "#111111" };
    binding.flushPendingLocal();
    sock.frame({ type: "update", version: 1, elements: [], appState: { viewBackgroundColor: "#222222" } });

    dropAndRedial(snap([], { appState: { viewBackgroundColor: "#222222" } }));

    expect(binding.snapshots.at(-1)?.appState).toEqual({ viewBackgroundColor: "#222222" });
    vi.useRealTimers();
  });
});

describe("an update that crosses this window's appState claim", () => {
  // The authority applies a push after every update it fanned before the
  // push arrived, so while this window's appState claim is on the wire or
  // queued, an update's appState is one the claim replaces.
  const MINE = { viewBackgroundColor: "#111111" };
  const PEERS = { viewBackgroundColor: "#222222" };
  const LATER = { viewBackgroundColor: "#333333" };
  const handed = (binding: FakeBinding) =>
    binding.updates.map((u) => ({ ids: u.elements.map((e) => e.id), appState: u.appState, files: u.files }));

  test("hands its elements and files and withholds its appState until the claim's ack", () => {
    const [tab] = installTabs([sceneTab()]);
    const { binding, sock } = attached(tab!);
    binding.pendingAppState = MINE;
    binding.flushPendingLocal();
    const files = { "file-p": { dataURL: "data:image/png;base64,AAA" } };
    sock.frame({ type: "update", version: 1, elements: [elem("peer", 2)], appState: PEERS, files });
    sock.frame({ type: "push-ok", version: 2 });
    sock.frame({ type: "update", version: 3, elements: [], appState: LATER });

    expect(handed(binding)).toEqual([
      { ids: ["peer"], appState: undefined, files },
      { ids: [], appState: LATER, files: undefined },
    ]);
  });

  test("withholds its appState while the claim waits behind a push on the wire", () => {
    const [tab] = installTabs([sceneTab()]);
    const { binding, sock } = attached(tab!);
    binding.pending.push(elem("mine", 2));
    binding.flushPendingLocal();
    binding.pendingAppState = MINE;
    binding.flushPendingLocal();
    sock.frame({ type: "update", version: 1, elements: [], appState: PEERS });

    expect({ pushes: sock.frames("push").length, handed: handed(binding) }).toEqual({
      pushes: 1,
      handed: [{ ids: [], appState: undefined, files: undefined }],
    });
  });

  test("hands an update's appState again once a drop has released the claim", () => {
    vi.useFakeTimers();
    const [tab] = installTabs([sceneTab()]);
    const { binding, sock } = attached(tab!);
    binding.pendingAppState = MINE;
    binding.flushPendingLocal();
    sock.frame({ type: "update", version: 1, elements: [], appState: PEERS });
    sock.drop();
    const before = sockets.length;
    for (let i = 0; i < 40 && sockets.length === before; i += 1) vi.advanceTimersByTime(250);
    const back = lastSocket();
    back.open();
    back.frame(snap([], { appState: PEERS }));
    back.frame({ type: "update", version: 2, elements: [], appState: LATER });
    vi.useRealTimers();

    expect(handed(binding)).toEqual([
      { ids: [], appState: undefined, files: undefined },
      { ids: [], appState: LATER, files: undefined },
    ]);
  });
});

describe("the scene a later bind replays", () => {
  const MINE = { viewBackgroundColor: "#111111" };
  const PEERS = { viewBackgroundColor: "#222222" };

  test("leaves out a push the session refused", () => {
    const [tab] = installTabs([sceneTab()]);
    const { session, binding } = attached(tab!);
    session.degrade();
    binding.pending.push(elem("refused", 2));
    binding.pendingAppState = MINE;
    binding.pendingFiles = { "file-r": { dataURL: "data:image/png;base64,AAA" } };
    binding.flushPendingLocal();
    const replay = rebind(session, binding).snapshots[0];

    expect({
      refused: binding.pending.map((e) => e.id),
      elements: replay?.elements.map((e) => e.id),
      appState: replay?.appState,
      files: Object.keys(replay?.files ?? {}),
    }).toEqual({ refused: ["refused"], elements: [], appState: {}, files: [] });
  });

  test("holds the appState and files this window pushed", () => {
    const [tab] = installTabs([sceneTab()]);
    const { session, binding, sock } = attached(tab!);
    binding.pendingAppState = MINE;
    binding.pendingFiles = { "file-m": { dataURL: "data:image/png;base64,AAA" } };
    binding.flushPendingLocal();
    sock.frame({ type: "push-ok", version: 1 });
    const replay = rebind(session, binding).snapshots[0];

    expect({ appState: replay?.appState, files: Object.keys(replay?.files ?? {}) }).toEqual({
      appState: MINE,
      files: ["file-m"],
    });
  });

  test.each(["on the wire", "queued behind a push on the wire"])(
    "holds this window's appState claim, %s, over an update that crossed it",
    (where) => {
      const [tab] = installTabs([sceneTab()]);
      const { session, binding, sock } = attached(tab!);
      if (where !== "on the wire") {
        binding.pending.push(elem("mine", 2));
        binding.flushPendingLocal();
      }
      binding.pendingAppState = MINE;
      binding.flushPendingLocal();
      sock.frame({ type: "update", version: 1, elements: [], appState: PEERS });
      sock.frame({ type: "push-ok", version: 2 });
      if (where !== "on the wire") sock.frame({ type: "push-ok", version: 3 });

      expect(rebind(session, binding).snapshots[0]?.appState).toEqual(MINE);
    },
  );
});

describe("a socket's snapshot comes before anything else on it", () => {
  // Every dial answers with a snapshot taken when the socket attached, so a
  // push sent before it lands is applied by the authority after it, and the
  // snapshot then hands the canvas back a push the authority is applying.
  const idsOf = (sock: FakeSocket) =>
    sock.frames("push").map((p) => (p.elements as WireElement[]).map((e) => e.id));

  /// Drop the socket and step the redial's backoff until a new one opens.
  function redial(): FakeSocket {
    lastSocket().drop();
    const before = sockets.length;
    for (let i = 0; i < 40 && sockets.length === before; i += 1) vi.advanceTimersByTime(250);
    expect(sockets.length).toBeGreaterThan(before);
    const back = lastSocket();
    back.open();
    return back;
  }

  test("a push after a drop waits for the new socket's snapshot and then goes once", () => {
    vi.useFakeTimers();
    const [tab] = installTabs([sceneTab()]);
    const { binding } = attached(tab!);
    const back = redial();
    binding.pending.push(elem("drawn", 2));
    binding.flushPendingLocal();
    const beforeSnapshot = idsOf(back);
    back.frame(snap([]));
    vi.useRealTimers();

    expect({ beforeSnapshot, after: idsOf(back) }).toEqual({ beforeSnapshot: [], after: [["drawn"]] });
  });

  test("a push after a heal's redial waits for the new socket's snapshot", async () => {
    vi.spyOn(api, "write").mockResolvedValue({ mtime: 2, mtime_ns: "2" });
    const [tab] = installTabs([sceneTab()]);
    const { session, binding } = attached(tab!);
    session.degrade();
    const before = sockets.length;
    tab!.content = tab!.content + "\n";
    await saveTab(tab!);
    await flushMicro();
    const back = lastSocket();
    back.open();
    binding.pending.push(elem("drawn", 2));
    binding.flushPendingLocal();
    const beforeSnapshot = idsOf(back);
    back.frame(snap([]));

    expect({ redialed: sockets.length > before, beforeSnapshot, after: idsOf(back) }).toEqual({
      redialed: true,
      beforeSnapshot: [],
      after: [["drawn"]],
    });
  });

  test("a bind after a drop replays nothing until the new socket's snapshot, which reaches it", () => {
    vi.useFakeTimers();
    const [tab] = installTabs([sceneTab()]);
    const { session, binding, sock } = attached(tab!);
    binding.pending.push(elem("never-accepted", 2));
    binding.flushPendingLocal();
    sock.drop();
    const next = rebind(session, binding);
    const beforeSnapshot = next.snapshots.length;
    const before = sockets.length;
    for (let i = 0; i < 40 && sockets.length === before; i += 1) vi.advanceTimersByTime(250);
    lastSocket().open();
    lastSocket().frame(snap([elem("authority", 3)]));
    vi.useRealTimers();

    expect({ beforeSnapshot, replays: next.snapshots.map((s) => s.elements.map((e) => e.id)) }).toEqual({
      beforeSnapshot: 0,
      replays: [["authority"]],
    });
  });

  test("an unbound canvas keeps its unacknowledged scene through a fresh socket snapshot", async () => {
    vi.useFakeTimers();
    const write = vi.spyOn(api, "write");
    const [tab] = installTabs([sceneTab()]);
    const { session, binding, sock } = attached(tab!);
    const local = elem("local", 2);
    const appState = { viewBackgroundColor: "#123456" };
    const files = { "local-file": { dataURL: "data:image/png;base64,AAA" } };
    session.pushScene([local], appState, files);
    tab!.content = sceneBufferWith("local");
    session.unbindCanvas(binding);
    sock.drop();

    const before = sockets.length;
    for (let i = 0; i < 40 && sockets.length === before; i += 1) vi.advanceTimersByTime(250);
    const back = lastSocket();
    back.open();
    back.frame(snap([elem("peer", 3)]));
    const saving = saveTab(tab!);
    await vi.advanceTimersByTimeAsync(SCENE_FLUSH_TIMEOUT_MS + 1);
    await saving;
    expect(write, "an unbound claim cannot fall back to PUT").not.toHaveBeenCalled();
    expect(tab!.saveError).toContain("push");
    const next = new FakeBinding();
    next.session = session;
    session.bindCanvas(next);

    expect(next.snapshots[0]?.elements.map((el) => el.id)).toEqual(["peer", "local"]);
    expect(next.snapshots[0]?.appState).toEqual(appState);
    expect(next.snapshots[0]?.files).toHaveProperty("local-file");
    expect(back.frames("push")).toEqual([
      expect.objectContaining({ elements: [local], appState, files }),
    ]);
    expect(tab!.content).toContain("local");
    back.frame({ type: "push-ok", version: 1 });
    back.frame({ type: "flush", dirty: false, mtime_ns: "9000000000" });
    await saveTab(tab!);
    expect(tab!.saveError).toBeNull();
    vi.useRealTimers();
  });
});

describe("a snapshot the server fans on a socket that had its own", () => {
  // A conflict's resolution fans a snapshot to every attachment on the socket
  // it has. The authority applies a push it reads after that snapshot and
  // acks it on the same socket, so the snapshot ends none of this window's
  // pushes.
  const MINE = { viewBackgroundColor: "#111111" };
  const PEERS = { viewBackgroundColor: "#222222" };
  const idsOf = (sock: FakeSocket) =>
    sock.frames("push").map((p) => (p.elements as WireElement[]).map((e) => e.id));

  test("keeps the push on the wire: its ack is that push's, and a drop after the next push hands that one back", () => {
    vi.useFakeTimers();
    const [tab] = installTabs([sceneTab()]);
    const { binding, sock } = attached(tab!);
    binding.pending.push(elem("x", 2));
    binding.flushPendingLocal();
    binding.pending.push(elem("y", 2));
    binding.flushPendingLocal();
    sock.frame(snap([]));
    const afterFan = idsOf(sock);
    sock.frame({ type: "push-ok", version: 1 });
    const afterAck = idsOf(sock);
    sock.drop();
    vi.useRealTimers();

    expect({ afterFan, afterAck, handedBack: binding.pending.map((e) => e.id) }).toEqual({
      afterFan: [["x"]],
      afterAck: [["x"], ["y"]],
      handedBack: ["y"],
    });
  });

  test("withholds its appState while this window's claim stands, and a later bind replays the claim", () => {
    const [tab] = installTabs([sceneTab()]);
    const { session, binding, sock } = attached(tab!);
    binding.pendingAppState = MINE;
    binding.flushPendingLocal();
    sock.frame(snap([], { appState: PEERS }));
    const handed = binding.snapshots.at(-1)?.appState;
    sock.frame({ type: "push-ok", version: 1 });

    expect({
      handed,
      pushes: sock.frames("push").length,
      replayed: rebind(session, binding).snapshots[0]?.appState,
    }).toEqual({ handed: undefined, pushes: 1, replayed: MINE });
  });

  test("leaves a claimed element it lacks in the scene a later bind replays", () => {
    const [tab] = installTabs([sceneTab()]);
    const { session, binding, sock } = attached(tab!);
    binding.pending.push(elem("drawn", 2));
    binding.flushPendingLocal();
    sock.frame(snap([elem("peer", 3)]));
    sock.frame({ type: "push-ok", version: 1 });

    expect(rebind(session, binding).snapshots[0]?.elements.map((e) => e.id)).toEqual(["peer", "drawn"]);
  });

  test("puts its own element in the scene a later bind replays where it is newer than the claim", () => {
    const [tab] = installTabs([sceneTab()]);
    const { session, binding, sock } = attached(tab!, [elem("x", 1)]);
    binding.pending.push(elem("x", 2));
    binding.flushPendingLocal();
    sock.frame(snap([elem("x", 3)]));
    sock.frame({ type: "push-ok", version: 1 });

    expect(rebind(session, binding).snapshots[0]?.elements.map((e) => [e.id, e.version])).toEqual([["x", 3]]);
  });

  test("leaves a claimed file in the scene a later bind replays", () => {
    const [tab] = installTabs([sceneTab()]);
    const { session, binding, sock } = attached(tab!);
    binding.pendingFiles = { "file-m": { dataURL: "data:image/png;base64,AAA" } };
    binding.flushPendingLocal();
    sock.frame(snap([], { files: { "file-p": { dataURL: "data:image/png;base64,BBB" } } }));
    sock.frame({ type: "push-ok", version: 1 });

    expect(Object.keys(rebind(session, binding).snapshots[0]?.files ?? {}).sort()).toEqual(["file-m", "file-p"]);
  });

  test("takes the appState claim queued behind the push on the wire as the one that stands", () => {
    const QUEUED = { viewBackgroundColor: "#333333" };
    const [tab] = installTabs([sceneTab()]);
    const { session, binding, sock } = attached(tab!);
    binding.pendingAppState = MINE;
    binding.flushPendingLocal();
    binding.pendingAppState = QUEUED;
    binding.flushPendingLocal();
    sock.frame(snap([], { appState: PEERS }));
    const handed = binding.snapshots.at(-1)?.appState;
    sock.frame({ type: "push-ok", version: 1 });
    sock.frame({ type: "push-ok", version: 2 });

    expect({ handed, replayed: rebind(session, binding).snapshots[0]?.appState }).toEqual({
      handed: undefined,
      replayed: QUEUED,
    });
  });

  test("hands its appState to the board when no claim of this window stands", () => {
    const [tab] = installTabs([sceneTab()]);
    const { binding, sock } = attached(tab!);
    sock.frame(snap([], { appState: PEERS }));

    expect(binding.snapshots.map((s) => s.appState)).toEqual([{}, PEERS]);
  });

  test("attaches a degraded session whose socket stayed open and pushes what it refused", () => {
    const [tab] = installTabs([sceneTab()]);
    const { session, binding, sock } = attached(tab!);
    session.degrade();
    binding.pending.push(elem("drawn", 2));
    binding.flushPendingLocal();
    const whileDegraded = idsOf(sock);
    sock.frame(snap([]));

    expect({ whileDegraded, state: tab!.doc?.state, after: idsOf(sock) }).toEqual({
      whileDegraded: [],
      state: "attached",
      after: [["drawn"]],
    });
  });

  /// This window claims x at version 5 with nonce 20, and the later snapshot
  /// holds x deleted at version 5 with `snapshotNonce`: what of x the scene a
  /// canvas binding after the ack replays holds.
  function replayedOnATie(snapshotNonce: number): { versionNonce: unknown; isDeleted: unknown } {
    const [tab] = installTabs([sceneTab()]);
    const { session, binding, sock } = attached(tab!, [elem("x", 4)]);
    binding.pending.push(elem("x", 5, { versionNonce: 20 }));
    binding.flushPendingLocal();
    sock.frame(snap([elem("x", 5, { versionNonce: snapshotNonce, isDeleted: true })]));
    sock.frame({ type: "push-ok", version: 1 });
    const x = rebind(session, binding).snapshots[0]?.elements.find((e) => e.id === "x");
    return { versionNonce: x?.versionNonce, isDeleted: x?.isDeleted };
  }

  test("on a tie of versions leaves the snapshot's element, whose nonce is the lower, in the scene a later bind replays", () => {
    expect(replayedOnATie(10)).toEqual({ versionNonce: 10, isDeleted: true });
  });

  test("on a tie of versions leaves the claim's element, whose nonce is the lower, in the scene a later bind replays", () => {
    expect(replayedOnATie(30)).toEqual({ versionNonce: 20, isDeleted: false });
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
