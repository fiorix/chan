// @vitest-environment jsdom

// docSync behavior pins: the pump (push / own-echo confirm / stale
// rebase), the attach algorithm (pending-diff merge, hard-resync
// rebase-by-diff), degradation and the redial of a dial that gets no
// frame, the session before its first frame, the save funnel
// (attached saves never PUT; flush failure degrades to classic), the
// dirty/saved consumer audit rows, presence plumbing, and two-editor
// convergence through a pure-TS authority. The wire shapes match the
// serde pins in crates/chan-server/src/routes/doc.rs (d117edb2).

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ChangeSet, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, redo, undo } from "@codemirror/commands";
import { api, sessionWindowId } from "../api/client";
import { ApiError } from "../api/errors";
import { setSocketFactory } from "../api/transport";
import { peersIn } from "../editor/collab/remoteCursors";
import {
  acquireDocSession,
  docSessionFor,
  DOC_ATTACH_TIMEOUT_MS,
  DOC_FALLBACK_SETTLE_MS,
  DOC_FLUSH_CAP_MS,
  DOC_FLUSH_TIMEOUT_MS,
  DOC_RELEASE_LINGER_MS,
  isDocSyncEligible,
  releaseDocSession,
  resetDocSyncForTests,
  type DocSession,
} from "./docSync.svelte";
import {
  cancelPaneMode,
  closeTab,
  commitPaneMode,
  conflictDialog,
  enterPaneMode,
  flagExternalChange,
  isDocAttached,
  isDocSavePaused,
  isDocUnflushed,
  isDirty,
  layout,
  overwriteConflictedTab,
  reloadConflictedTab,
  reloadTabFromDisk,
  reorderTab,
  saveTab,
  scheduleAutosave,
  scheduleMissingFileCheck,
  type FileTab,
  type LeafNode,
} from "./tabs.svelte";
import { fileTab as harnessFileTab, readTab, resetLayout } from "../__tests__/tabs";

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
    // Mirrors the browser: close() does not fire onclose synchronously;
    // tests drive the close event explicitly via drop().
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

/// A clean source-mode tab with an id of its own, so the tabs of one test
/// never share one.
function fileTab(partial: Partial<FileTab> = {}): FileTab {
  nextTabId += 1;
  return harnessFileTab({
    id: `doc-tab-${nextTabId}`,
    content: "hello",
    saved: "hello",
    savedMtimeNs: "1000000000",
    mode: "source",
    ...partial,
  });
}

const MTIME = "1751234567890123456";

function snap(
  doc: string,
  version = 0,
  extra: Partial<{
    dirty: boolean;
    mtime_ns: string | null;
    cursors: unknown[];
  }> = {},
): Record<string, unknown> {
  return {
    type: "snapshot",
    path: "notes/a.md",
    version,
    doc,
    dirty: false,
    mtime_ns: MTIME,
    cursors: [],
    ...extra,
  };
}

/// Mount a minimal editor wired the way FileEditorTab wires the real
/// ones: doc seeded from tab.content, session extension installed, and
/// an updateListener mirroring doc changes back to tab.content (the
/// bind:value path).
function mountEditor(
  tab: FileTab,
  session: DocSession,
  opts: { doc?: string } = {},
): { view: EditorView; cleanup(): void } {
  const target = document.createElement("div");
  document.body.append(target);
  const state = EditorState.create({
    doc: opts.doc ?? tab.content,
    extensions: [
      history(),
      session.extension(),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) tab.content = u.state.doc.toString();
      }),
    ],
  });
  const view = new EditorView({ state, parent: target });
  return {
    view,
    cleanup() {
      view.destroy();
      target.remove();
    },
  };
}

/// Flush the queueMicrotask chains (bindView, deferred attach/push).
async function flushMicro(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

/// Acquire + mount + snapshot: a fully attached session.
async function attached(
  tab: FileTab,
  doc = tab.content,
  version = 0,
): Promise<{ session: DocSession; view: EditorView; sock: FakeSocket; cleanup(): void }> {
  const session = acquireDocSession(tab);
  expect(session).not.toBeNull();
  const sock = lastSocket();
  const mounted = mountEditor(tab, session!);
  await flushMicro();
  sock.open();
  sock.frame(snap(doc, version));
  await flushMicro();
  return { session: session!, view: mounted.view, sock, cleanup: mounted.cleanup };
}

function type(view: EditorView, text: string, at?: number): void {
  const pos = at ?? view.state.doc.length;
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
  });
}

/// Serialized ChangeSet JSON for a peer edit, generated by CM itself
/// so the tests never drift from the real wire grammar.
function changesJSON(
  docLen: number,
  from: number,
  to: number,
  insert: string,
): unknown {
  return ChangeSet.of({ from, to, insert }, docLen).toJSON();
}

/// Echo the socket's LAST push back as the authority would: the
/// updates broadcast (own-clientID echo) followed by push-ok.
async function ackLastPush(sock: FakeSocket, baseVersion: number): Promise<void> {
  const pushes = sock.frames("push");
  const last = pushes[pushes.length - 1]!;
  const updates = last.updates as unknown[];
  sock.frame({ type: "updates", version: baseVersion, updates });
  sock.frame({ type: "push-ok", version: baseVersion + updates.length });
  await flushMicro();
}

beforeEach(() => {
  localStorage.setItem("chan.docsync", "1");
  sockets.length = 0;
  setSocketFactory((url) => new FakeSocket(url) as unknown as WebSocket);
});

afterEach(() => {
  resetDocSyncForTests();
  setSocketFactory(null);
  // Hybrid Nav is module state: a test that enters and does not commit
  // would leave the next one reading a draft instead of the layout.
  cancelPaneMode();
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
  conflictDialog.open = false;
});

// ---- eligibility ------------------------------------------------------------

describe("eligibility", () => {
  test("editable text in source/wysiwyg qualifies; other modes and kinds do not", () => {
    expect(isDocSyncEligible(fileTab())).toBe(true);
    expect(isDocSyncEligible(fileTab({ mode: "wysiwyg" }))).toBe(true);
    expect(isDocSyncEligible(fileTab({ mode: "pretty" }))).toBe(false);
    expect(isDocSyncEligible(fileTab({ mode: "table" }))).toBe(false);
    expect(isDocSyncEligible(fileTab({ loading: true }))).toBe(false);
    expect(
      isDocSyncEligible(fileTab({ fileMissing: { path: "notes/a.md", fragment: null } })),
    ).toBe(false);
    expect(isDocSyncEligible(fileTab({ path: "img/x.png" }))).toBe(false);
    expect(isDocSyncEligible(fileTab({ path: "b/scene.excalidraw" }))).toBe(false);
    // Read-only tabs still attach (read-only): not an eligibility input.
    expect(isDocSyncEligible(fileTab({ readMode: true }))).toBe(true);
  });

  test("the flag defaults ON and localStorage '0' opts out", () => {
    localStorage.removeItem("chan.docsync");
    expect(isDocSyncEligible(fileTab())).toBe(true);
    localStorage.setItem("chan.docsync", "0");
    expect(isDocSyncEligible(fileTab())).toBe(false);
    expect(acquireDocSession(fileTab())).toBeNull();
    localStorage.setItem("chan.docsync", "off");
    expect(acquireDocSession(fileTab())).toBeNull();
  });

  test("oversized content refuses a session untracked", () => {
    const big = fileTab({ content: "x".repeat(2 * 1024 * 1024 + 1) });
    expect(acquireDocSession(big)).toBeNull();
  });
});

// ---- attach ----------------------------------------------------------------

describe("attach", () => {
  test("clean tab attaches: shadow -> tab.saved, status attached, nothing pushed", async () => {
    const tab = fileTab();
    const { sock, view, cleanup } = await attached(tab, "hello");
    expect(tab.doc?.state).toBe("attached");
    expect(tab.saved).toBe("hello");
    expect(tab.savedMtimeNs).toBe(MTIME);
    expect(tab.authorityVersion).toBe(0);
    expect(view.state.doc.toString()).toBe("hello");
    expect(sock.frames("push")).toHaveLength(0);
    cleanup();
  });

  test("a clean tab whose file changed under it takes the snapshot and pushes nothing", async () => {
    // The tab loaded "hello" and holds nothing of its user's; the authority
    // holds what another writer made of the file since, which the tab's
    // banner says.
    const tab = fileTab({ externalChange: true });
    const { sock, view, cleanup } = await attached(tab, "hello there");
    expect({
      state: tab.doc?.state,
      editor: view.state.doc.toString(),
      buffer: tab.content,
      saved: tab.saved,
      pushes: sock.frames("push").length,
      banner: tab.externalChange,
    }).toEqual({
      state: "attached",
      editor: "hello there",
      buffer: "hello there",
      saved: "hello there",
      pushes: 0,
      banner: false,
    });
    cleanup();
  });

  test("a clean tab whose editor binds after the snapshot takes the snapshot then", async () => {
    const tab = fileTab();
    const session = acquireDocSession(tab)!;
    const sock = lastSocket();
    sock.open();
    sock.frame(snap("hello there"));
    await flushMicro();
    const { view, cleanup } = mountEditor(tab, session);
    await flushMicro();
    expect({
      editor: view.state.doc.toString(),
      buffer: tab.content,
      saved: tab.saved,
      pushes: sock.frames("push").length,
    }).toEqual({ editor: "hello there", buffer: "hello there", saved: "hello there", pushes: 0 });
    cleanup();
  });

  test("a clean tab with no editor stays clean through a second socket's snapshot", async () => {
    vi.useFakeTimers();
    const tab = fileTab();
    const session = acquireDocSession(tab)!;
    const first = lastSocket();
    first.open();
    first.frame(snap("hello there"));
    await flushMicro();
    first.drop();
    await vi.advanceTimersByTimeAsync(500);
    const second = lastSocket();
    expect(second).not.toBe(first);
    second.open();
    second.frame(snap("hello there, again", 4));
    await flushMicro();
    const { view, cleanup } = mountEditor(tab, session);
    await flushMicro();
    expect({
      editor: view.state.doc.toString(),
      buffer: tab.content,
      saved: tab.saved,
      pushes: second.frames("push").length,
    }).toEqual({ editor: "hello there, again", buffer: "hello there, again", saved: "hello there, again", pushes: 0 });
    cleanup();
  });

  test("a key typed between the snapshot and the attach is kept: the tab attaches as a dirty one", async () => {
    const tab = fileTab();
    const session = acquireDocSession(tab)!;
    const sock = lastSocket();
    sock.open();
    sock.frame(snap("hello"));
    await flushMicro();
    // The tab was clean when the snapshot landed and is not at the attach.
    tab.content = "hello!";
    const { view, cleanup } = mountEditor(tab, session);
    await flushMicro();
    expect(view.state.doc.toString()).toBe("hello!");
    expect(sock.frames("push")).toHaveLength(1);
    await ackLastPush(sock, 0);
    expect({ buffer: tab.content, saved: tab.saved }).toEqual({ buffer: "hello!", saved: "hello!" });
    cleanup();
  });

  test("a key typed between a snapshot of a file that changed and the attach is not pushed over it: the prompt asks", async () => {
    const tab = fileTab();
    const session = acquireDocSession(tab)!;
    const sock = lastSocket();
    sock.open();
    // Another writer made the file "hello there" after the tab loaded it.
    sock.frame(snap("hello there", 3));
    await flushMicro();
    tab.content = "hello!";
    const { view, cleanup } = mountEditor(tab, session);
    await flushMicro();

    expect({
      pushed: sockets.flatMap((socket) => socket.frames("push")).length,
      prompt: { open: conflictDialog.open, tab: conflictDialog.tabId, version: conflictDialog.currentAuthorityVersion },
      editor: view.state.doc.toString(),
      buffer: tab.content,
      saved: tab.saved,
      token: tab.savedMtimeNs,
      owns: isDocAttached(tab),
    }).toEqual({
      pushed: 0,
      prompt: { open: true, tab: tab.id, version: 3 },
      editor: "hello!",
      buffer: "hello!",
      saved: "hello",
      token: "1000000000",
      owns: false,
    });
    cleanup();
  });

  test("pre-attach local edits merge as a pending diff push, not a clobber", async () => {
    // The degraded-window shape: buffer is ahead of the authority.
    const tab = fileTab({ content: "hello world", saved: "hello" });
    const { sock, view, cleanup } = await attached(tab, "hello");
    expect(view.state.doc.toString()).toBe("hello world");
    // Dirty means unconfirmed: saved is the authority text until the
    // push confirms.
    expect(tab.saved).toBe("hello");
    const pushes = sock.frames("push");
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.version).toBe(0);
    await ackLastPush(sock, 0);
    expect(tab.saved).toBe("hello world");
    expect(tab.content).toBe("hello world");
    cleanup();
  });

  test("a not-yet-filled editor defers the attach instead of pushing a wipe", async () => {
    const tab = fileTab({ content: "hello" });
    const session = acquireDocSession(tab)!;
    // Editor mounted before the load fill: empty doc, non-empty buffer.
    const { view, cleanup } = mountEditor(tab, session, { doc: "" });
    await flushMicro();
    const sock = lastSocket();
    sock.open();
    sock.frame(snap("hello"));
    await flushMicro();
    expect(tab.doc?.state).toBe("connecting");
    expect(sock.frames("push")).toHaveLength(0);
    // The async fill lands; attach proceeds against the shadow.
    view.dispatch({ changes: { from: 0, insert: "hello" } });
    await flushMicro();
    expect(tab.doc?.state).toBe("attached");
    expect(sock.frames("push")).toHaveLength(0);
    expect(view.state.doc.toString()).toBe("hello");
    cleanup();
  });

  test("a CRLF document degrades to the classic path", async () => {
    const tab = fileTab({ content: "a\r\nb", saved: "a\r\nb" });
    const session = acquireDocSession(tab)!;
    const { cleanup } = mountEditor(tab, session, { doc: "a\nb" });
    await flushMicro();
    const sock = lastSocket();
    sock.open();
    sock.frame(snap("a\r\nb"));
    await flushMicro();
    expect(tab.doc?.state).toBe("degraded");
    expect(isDocAttached(tab)).toBe(false);
    cleanup();
  });
});

// ---- pump -------------------------------------------------------------------

describe("pump", () => {
  test("local edits push once and confirm on the own-clientID echo", async () => {
    const tab = fileTab();
    const { sock, view, cleanup } = await attached(tab, "hello");
    type(view, "!");
    await flushMicro();
    const pushes = sock.frames("push");
    expect(pushes).toHaveLength(1);
    const update = (pushes[0]!.updates as { clientID: string }[])[0]!;
    expect(update.clientID.startsWith("$")).toBe(false);
    expect(tab.content).toBe("hello!");
    expect(tab.saved).toBe("hello"); // unconfirmed yet
    await ackLastPush(sock, 0);
    expect(tab.saved).toBe("hello!");
    // Nothing new to send: the echo confirmed rather than re-applied.
    expect(view.state.doc.toString()).toBe("hello!");
    expect(sock.frames("push")).toHaveLength(1);
    cleanup();
  });

  test("one push in flight: edits during flight batch into the next push", async () => {
    const tab = fileTab();
    const { sock, view, cleanup } = await attached(tab, "hello");
    type(view, "a");
    await flushMicro();
    type(view, "b");
    await flushMicro();
    expect(sock.frames("push")).toHaveLength(1);
    await ackLastPush(sock, 0);
    const pushes = sock.frames("push");
    expect(pushes).toHaveLength(2);
    expect(pushes[1]!.version).toBe(1);
    await ackLastPush(sock, 1);
    expect(tab.saved).toBe("helloab");
    cleanup();
  });

  test("push-stale latches, rebases over the in-flight broadcast, re-pushes", async () => {
    const tab = fileTab();
    const { sock, view, cleanup } = await attached(tab, "hello");
    type(view, "L"); // local -> "helloL"
    await flushMicro();
    expect(sock.frames("push")).toHaveLength(1);
    // A peer committed first: our push is stale against version 1.
    sock.frame({ type: "push-stale", version: 1 });
    await flushMicro();
    expect(sock.frames("push")).toHaveLength(1); // latched, no blind re-push
    // The missed broadcast arrives (peer prefixed "P").
    sock.frame({
      type: "updates",
      version: 0,
      updates: [{ clientID: "peer-1", changes: changesJSON(5, 0, 0, "P") }],
    });
    await flushMicro();
    const pushes = sock.frames("push");
    expect(pushes).toHaveLength(2);
    expect(pushes[1]!.version).toBe(1);
    await ackLastPush(sock, 1);
    expect(view.state.doc.toString()).toBe("PhelloL");
    expect(tab.saved).toBe("PhelloL");
    cleanup();
  });

  test("remote updates apply to the view and never enter local undo", async () => {
    const tab = fileTab();
    const { sock, view, cleanup } = await attached(tab, "hello");
    // Peer prepends "X".
    sock.frame({
      type: "updates",
      version: 0,
      updates: [{ clientID: "peer-1", changes: changesJSON(5, 0, 0, "X") }],
    });
    await flushMicro();
    expect(view.state.doc.toString()).toBe("Xhello");
    expect(tab.saved).toBe("Xhello");
    // Local edit, then undo: only the local edit rewinds.
    type(view, "!");
    expect(view.state.doc.toString()).toBe("Xhello!");
    undo(view);
    expect(view.state.doc.toString()).toBe("Xhello");
    // Exhaustive undo never rewinds the peer edit.
    undo(view);
    expect(view.state.doc.toString()).toBe("Xhello");
    redo(view);
    expect(view.state.doc.toString()).toBe("Xhello!");
    cleanup();
  });

  test("read-only attaches receive updates but never send", async () => {
    const tab = fileTab({ readMode: true });
    const { sock, view, cleanup } = await attached(tab, "hello");
    expect(tab.doc?.state).toBe("attached");
    sock.frame({
      type: "updates",
      version: 0,
      updates: [{ clientID: "peer-1", changes: changesJSON(5, 5, 5, "!") }],
    });
    await flushMicro();
    expect(view.state.doc.toString()).toBe("hello!");
    // A programmatic dispatch would be sendable; the pump suppresses it.
    type(view, "x");
    await flushMicro();
    expect(sock.frames("push")).toHaveLength(0);
    expect(sock.frames("cursor")).toHaveLength(0);
    cleanup();
  });
});

// ---- resync -----------------------------------------------------------------

describe("resync", () => {
  test("a version gap hard-resyncs via a fresh snapshot dial", async () => {
    const tab = fileTab();
    const { sock, cleanup } = await attached(tab, "hello");
    const before = sockets.length;
    sock.frame({
      type: "updates",
      version: 7, // expected 0: someone desynced us
      updates: [{ clientID: "peer-1", changes: changesJSON(5, 5, 5, "!") }],
    });
    await flushMicro();
    expect(sockets.length).toBe(before + 1);
    const redial = lastSocket();
    // Fresh snapshot dial: no version rides the query.
    expect(redial.url).not.toContain("version=");
    redial.open();
    redial.frame(snap("hello!", 8));
    await flushMicro();
    expect(tab.doc?.state).toBe("attached");
    expect(tab.saved).toBe("hello!");
    cleanup();
  });

  test("snapshot mid-session rebases unconfirmed local edits by diff", async () => {
    const tab = fileTab();
    const { sock, view, cleanup } = await attached(tab, "hello");
    type(view, "L"); // unconfirmed local append -> "helloL"
    await flushMicro();
    expect(sock.frames("push")).toHaveLength(1);
    // The push is still pending when the server fans a newer snapshot
    // on this socket. Its later refusal, not the snapshot, retires it.
    sock.frame(snap("Phello", 7));
    await flushMicro();
    expect(view.state.doc.toString()).toBe("PhelloL");
    expect(tab.saved).toBe("Phello");
    expect(sock.frames("push")).toHaveLength(1);
    sock.frame({ type: "push-stale", version: 7 });
    await flushMicro();
    const pushes = sock.frames("push");
    expect(pushes).toHaveLength(2);
    expect(pushes[1]!.version).toBe(7);
    await ackLastPush(sock, 7);
    expect(tab.saved).toBe("PhelloL");
    cleanup();
  });

  test("a snapshot that already contains the unconfirmed edit does not duplicate it", async () => {
    const tab = fileTab();
    const { sock, view, cleanup } = await attached(tab, "hello");
    type(view, "L");
    await flushMicro();
    // The in-flight push COMMITTED server-side before the crash; the
    // resync snapshot already holds it.
    sock.frame(snap("helloL", 1));
    await flushMicro();
    expect(view.state.doc.toString()).toBe("helloL");
    expect(tab.saved).toBe("helloL");
    expect(sock.frames("push")).toHaveLength(1); // no re-push of applied text
    cleanup();
  });
});

// ---- degradation ------------------------------------------------------------

describe("degradation", () => {
  test("a fallback redial keeps its own attach window", async () => {
    vi.useFakeTimers();
    const tab = fileTab();
    const { session, sock, view, cleanup } = await attached(tab, "hello");
    type(view, "L");
    await flushMicro();
    expect(sock.frames("push")).toHaveLength(1);
    sock.drop();
    await vi.advanceTimersByTimeAsync(500);
    lastSocket().drop();
    await vi.advanceTimersByTimeAsync(1000);
    lastSocket().drop();
    expect(tab.doc?.state).toBe("degraded");

    await vi.advanceTimersByTimeAsync(2000);
    const retry = lastSocket();
    retry.open();
    expect(tab.doc?.state).toBe("degraded");
    await vi.advanceTimersByTimeAsync(1000);
    session.healAfterFallbackSave();
    const healed = lastSocket();
    expect(healed).not.toBe(retry);
    expect(retry.closedByClient).toBe(true);

    await vi.advanceTimersByTimeAsync(DOC_ATTACH_TIMEOUT_MS - 1000 + 1);
    expect(healed.closedByClient, "the previous dial must not close the new socket").toBe(false);
    await vi.advanceTimersByTimeAsync(999);
    expect(healed.closedByClient, "the new dial must still time out on its own deadline").toBe(true);
    cleanup();
  });

  test("socket drop: reconnect grace suppresses autosave, then degrades, then heals", async () => {
    vi.useFakeTimers();
    const tab = fileTab();
    const { sock, cleanup } = await attached(tab, "hello");
    sock.drop();
    expect(tab.doc?.state).toBe("reconnecting");
    expect(isDocAttached(tab)).toBe(true); // autosave stays suppressed
    await vi.advanceTimersByTimeAsync(500);
    lastSocket().drop();
    expect(tab.doc?.state).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(1000);
    lastSocket().drop();
    // Past the 2-attempt grace: classic autosave resumes.
    expect(tab.doc?.state).toBe("degraded");
    expect(isDocAttached(tab)).toBe(false);
    // Background retry keeps going and heals with a resync.
    await vi.advanceTimersByTimeAsync(2000);
    const healed = lastSocket();
    expect(healed).not.toBe(sock);
    healed.open();
    healed.frame(snap("hello", 3));
    await flushMicro();
    expect(tab.doc?.state).toBe("attached");
    cleanup();
  });

  test("an attach-failed error frame degrades without a retry loop", async () => {
    vi.useFakeTimers();
    const tab = fileTab();
    acquireDocSession(tab);
    const sock = lastSocket();
    sock.open();
    // The server refuses the attach with a frame before the close.
    sock.frame({ type: "error", message: "no such file", reason: "attach-failed" });
    sock.drop();
    expect(tab.doc?.state).toBe("degraded");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sockets.length).toBe(1); // no redial of a permanently bad attach
    // The stop is this session's alone: other tabs still attach.
    expect(acquireDocSession(fileTab())).not.toBeNull();
  });

  test("a first dial closed before any frame is dialed again after the backoff and attaches when one frames", async () => {
    vi.useFakeTimers();
    const tab = fileTab();
    const session = acquireDocSession(tab)!;
    const { view, cleanup } = mountEditor(tab, session);
    await flushMicro();
    lastSocket().drop();
    expect(tab.doc?.state).not.toBe("off");
    await vi.advanceTimersByTimeAsync(499);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);
    const retry = lastSocket();
    retry.open();
    retry.frame(snap("hello", 0));
    await flushMicro();
    expect(tab.doc?.state).toBe("attached");
    // A peer's change sent after the snapshot is in the tab's text.
    retry.frame({
      type: "updates",
      version: 0,
      updates: [{ clientID: "peer", changes: changesJSON(5, 5, 5, " there") }],
    });
    await flushMicro();
    expect({ editor: view.state.doc.toString(), buffer: tab.content }).toEqual({
      editor: "hello there",
      buffer: "hello there",
    });
    cleanup();
  });

  test("a first dial closed before any frame refuses no other tab a session", async () => {
    acquireDocSession(fileTab());
    lastSocket().drop();
    const other = fileTab({ path: "notes/b.md" });
    expect(isDocSyncEligible(other)).toBe(true);
    const session = acquireDocSession(other);
    expect(session).not.toBeNull();
    const sock = lastSocket();
    expect(new URL(sock.url).searchParams.get("path")).toBe("notes/b.md");
    sock.open();
    sock.frame(snap("hello", 0));
    await flushMicro();
    expect(other.doc?.state).toBe("attached");
  });

  test("frameless closes are dialed again on the backoff and no faster: eleven dials in a minute", async () => {
    vi.useFakeTimers();
    acquireDocSession(fileTab());
    // The dial after each close waits 500 ms doubling to 8 s, so the dials
    // of the first minute are made at 0, 0.5, 1.5, 3.5, 7.5 and then every
    // 8 s up to 55.5 s.
    const delays = [500, 1000, 2000, 4000, 8000, 8000, 8000, 8000, 8000, 8000];
    for (const [i, delay] of delays.entries()) {
      lastSocket().drop();
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(sockets, `dial ${i + 2} is not made before its delay`).toHaveLength(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets, `dial ${i + 2} is made at its delay`).toHaveLength(i + 2);
    }
    lastSocket().drop();
    await vi.advanceTimersByTimeAsync(4500);
    expect(sockets, "the twelfth dial falls past the minute").toHaveLength(11);
  });

  test("a dial with no frame inside the attach window is closed and dialed again", async () => {
    vi.useFakeTimers();
    const tab = fileTab();
    acquireDocSession(tab);
    const first = lastSocket();
    // The dial hangs: no frame at all. The client closes the socket
    // itself when the attach window runs out.
    await vi.advanceTimersByTimeAsync(DOC_ATTACH_TIMEOUT_MS + 50);
    expect(first.closedByClient).toBe(true);
    // A dial that timed out is dialed again like one the server closed.
    expect(tab.doc?.state).not.toBe("off");
    await vi.advanceTimersByTimeAsync(600);
    expect(sockets.length).toBe(2);
    const retry = lastSocket();
    retry.open();
    retry.frame(snap("hello", 0));
    await flushMicro();
    expect(tab.doc?.state).toBe("attached");
    // Other tabs still get sessions.
    expect(acquireDocSession(fileTab())).not.toBeNull();
  });

  test("a degraded session with no bound view heals to attached on the retry snapshot", async () => {
    vi.useFakeTimers();
    const tab = fileTab();
    const session = acquireDocSession(tab)!;
    // No editor mount at all: the session syncs its shadow, then the
    // channel dies past the grace.
    const first = lastSocket();
    first.open();
    first.frame(snap("hello", 0));
    await flushMicro();
    expect(tab.doc?.state).toBe("attached");
    first.drop();
    await vi.advanceTimersByTimeAsync(500);
    lastSocket().drop();
    await vi.advanceTimersByTimeAsync(1000);
    lastSocket().drop();
    expect(tab.doc?.state).toBe("degraded");
    // Background retry lands a snapshot while still unbound: the
    // session must heal, or a later bind would pump collab while the
    // classic PUT path stays armed side by side.
    await vi.advanceTimersByTimeAsync(2000);
    const healed = lastSocket();
    healed.open();
    healed.frame(snap("hello", 0));
    await flushMicro();
    expect(tab.doc?.state).toBe("attached");
    // The late bind attaches against the healed shadow as usual.
    const mounted = mountEditor(tab, session);
    await flushMicro();
    expect(tab.doc?.state).toBe("attached");
    expect(mounted.view.state.doc.toString()).toBe("hello");
    expect(healed.frames("push")).toHaveLength(0);
    mounted.cleanup();
  });

  test("registry-initiated closed frame turns the session off for good", async () => {
    vi.useFakeTimers();
    const tab = fileTab();
    const { sock, cleanup } = await attached(tab, "hello");
    const dials = sockets.length;
    sock.frame({ type: "closed", reason: "reset" });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(tab.doc?.state).toBe("off");
    expect(sockets.length).toBe(dials); // no redial
    cleanup();
  });

  test("closed{import} tears down exactly like reset (reason-agnostic)", async () => {
    vi.useFakeTimers();
    const tab = fileTab();
    const { sock, cleanup } = await attached(tab, "hello");
    const dials = sockets.length;
    sock.frame({ type: "closed", reason: "import" });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(tab.doc?.state).toBe("off");
    expect(sockets.length).toBe(dials);
    cleanup();
  });

  test("a no-workspace error (dial racing a reset swap) is dialed again", async () => {
    vi.useFakeTimers();
    const tab = fileTab();
    acquireDocSession(tab);
    const sock = lastSocket();
    sock.open();
    // The server answers the race with a frame before closing, and the
    // session redials once the cell swap settles.
    sock.frame({ type: "error", message: "workspace resetting", reason: "no-workspace" });
    sock.drop();
    expect(tab.doc?.state).not.toBe("off");
    await vi.advanceTimersByTimeAsync(600);
    expect(sockets.length).toBe(2);
    const retry = lastSocket();
    retry.open();
    retry.frame(snap("hello", 0));
    await flushMicro();
    expect(tab.doc?.state).toBe("attached");
  });
});

// ---- a session before its first frame -----------------------------------------

// No authority has spoken for the document yet, so the tab's text and tokens
// are those of its load and the classic save writes them.
describe("a session that has had no frame", () => {
  /// A dirty tab in the layout whose session has dialed and heard nothing,
  /// on a page where another tab's session has attached.
  function unframed() {
    const attachedElsewhere = fileTab({ path: "notes/b.md" });
    acquireDocSession(attachedElsewhere);
    lastSocket().open();
    lastSocket().frame(snap("hello", 0));
    const tab = fileTab({ content: "hello!", saved: "hello" });
    const pane = resetLayout([tab]);
    const t = readTab(tab.id)!;
    const write = vi
      .spyOn(api, "write")
      .mockResolvedValue({ mtime: 2, mtime_ns: "2000000000" });
    acquireDocSession(t);
    return { t, pane, write };
  }

  test("an asked save is written the classic way with the token of the tab's load", async () => {
    vi.useFakeTimers();
    const { t, write } = unframed();
    expect({ attached: isDocAttached(t), paused: isDocSavePaused(t) }).toEqual({
      attached: false,
      paused: false,
    });
    await saveTab(t);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]!.slice(0, 3)).toEqual(["notes/a.md", "hello!", "1000000000"]);
    expect({ saved: t.saved, token: t.savedMtimeNs, error: t.error }).toEqual({
      saved: "hello!",
      token: "2000000000",
      error: null,
    });
  });

  test("past the reconnect grace it still saves, asked or by autosave, and still dials", async () => {
    vi.useFakeTimers();
    const { t, pane, write } = unframed();
    const dials = sockets.length;
    lastSocket().drop();
    await vi.advanceTimersByTimeAsync(500);
    lastSocket().drop();
    await vi.advanceTimersByTimeAsync(1000);
    lastSocket().drop();
    expect(sockets).toHaveLength(dials + 2);
    expect({ attached: isDocAttached(t), paused: isDocSavePaused(t) }).toEqual({
      attached: false,
      paused: false,
    });
    await saveTab(t);
    expect(write).toHaveBeenCalledTimes(1);
    t.content = "hello!!";
    scheduleAutosave(pane.id, t.id);
    await vi.advanceTimersByTimeAsync(800);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1]!.slice(0, 3)).toEqual(["notes/a.md", "hello!!", "2000000000"]);
    // The third dial follows the third close by 2 s.
    await vi.advanceTimersByTimeAsync(1200);
    expect(sockets).toHaveLength(dials + 3);
  });

  test("it holds nothing the disk lacks, so a reload of its clean tab asks nothing", () => {
    const tab = fileTab();
    acquireDocSession(tab);
    expect(isDocUnflushed(tab.id)).toBe(false);
  });

  test("its first snapshot attaches the tab over the classic save, and what the buffer holds beyond it is pushed", async () => {
    vi.useFakeTimers();
    const { t, write } = unframed();
    const session = docSessionFor(t.id)!;
    const sock = lastSocket();
    const { view, cleanup } = mountEditor(t, session);
    await flushMicro();
    expect(isDocSavePaused(t), "the session withholds the classic save").toBe(false);
    await saveTab(t);
    expect(write).toHaveBeenCalledTimes(1);
    type(view, "?");
    await flushMicro();
    // The authority read the file the classic save wrote.
    sock.open();
    sock.frame(snap("hello!", 0));
    await flushMicro();
    expect({ state: t.doc?.state, saved: t.saved, token: t.savedMtimeNs, buffer: t.content }).toEqual({
      state: "attached",
      saved: "hello!",
      token: MTIME,
      buffer: "hello!?",
    });
    const pushes = sock.frames("push");
    expect(pushes).toHaveLength(1);
    await ackLastPush(sock, 0);
    expect({ saved: t.saved, buffer: t.content }).toEqual({ saved: "hello!?", buffer: "hello!?" });
    expect(write).toHaveBeenCalledTimes(1);
    cleanup();
  });
});

// ---- connection-outage save suppression (task-Web-Fable-3, option B) ----------

describe("the first attach of a tab that is not clean", () => {
  /// A tab in the layout that loaded "hello" and holds "hello!", with its
  /// editor mounted and its session dialing.
  async function edited() {
    const tab = fileTab({ content: "hello!", saved: "hello" });
    resetLayout([tab]);
    const t = readTab(tab.id)!;
    const session = acquireDocSession(t)!;
    const sock = lastSocket();
    const { view, cleanup } = mountEditor(t, session);
    await flushMicro();
    sock.open();
    return { t, session, sock, view, cleanup };
  }

  /// What the user and the authority are left with: the pushes sent on any
  /// socket, the prompt, the editor, the buffer, the saved text, the tab's
  /// token, and whether the session owns the tab's saves.
  const read = (t: FileTab, view: EditorView) => ({
    pushed: sockets.flatMap((socket) => socket.frames("push")).length,
    prompt: conflictDialog.open ? conflictDialog.tabId : null,
    editor: view.state.doc.toString(),
    buffer: t.content,
    saved: t.saved,
    token: t.savedMtimeNs,
    owns: isDocAttached(t),
  });
  const ASKED = { pushed: 0, editor: "hello!", buffer: "hello!", saved: "hello", token: "1000000000", owns: false };

  /// The prompt a classic save's conflict opened while the session dialed.
  function openPrompt(t: FileTab): void {
    Object.assign(conflictDialog, {
      open: true,
      tabId: t.id,
      path: t.path,
      currentMtime: null,
      currentMtimeNs: "5000000000",
      currentAuthorityVersion: null,
      diskConflicted: false,
    });
  }

  /// The dial a held session makes once it may attach, opened.
  function redial(before: number): FakeSocket {
    expect(sockets.length, "the session dials again").toBe(before + 1);
    const next = lastSocket();
    next.open();
    return next;
  }

  test("over a file that changed under it pushes nothing and shows the conflict prompt", async () => {
    const { t, sock, view, cleanup } = await edited();
    // Another writer made the file "hello there" after the tab loaded it.
    sock.frame(snap("hello there", 3));
    await flushMicro();

    expect({
      ...read(t, view),
      offers: { token: conflictDialog.currentMtimeNs, version: conflictDialog.currentAuthorityVersion },
      leftItsSocket: sock.closedByClient,
    }).toEqual({ ...ASKED, prompt: t.id, offers: { token: MTIME, version: 3 }, leftItsSocket: true });
    cleanup();
  });

  test("with no editor bound yet is judged at the snapshot: the tab stays the classic path's", async () => {
    const tab = fileTab({ content: "hello!", saved: "hello" });
    resetLayout([tab]);
    const t = readTab(tab.id)!;
    acquireDocSession(t);
    const sock = lastSocket();
    sock.open();
    sock.frame(snap("hello there", 3));
    await flushMicro();

    expect({
      prompt: conflictDialog.open ? conflictDialog.tabId : null,
      buffer: t.content,
      saved: t.saved,
      token: t.savedMtimeNs,
      owns: isDocAttached(t),
    }).toEqual({ prompt: t.id, buffer: "hello!", saved: "hello", token: "1000000000", owns: false });
  });

  test("Reload takes the other writer's text and ends attached, with nothing pushed", async () => {
    const { t, sock, view, cleanup } = await edited();
    sock.frame(snap("hello there", 3));
    await flushMicro();
    vi.spyOn(api, "readStream").mockResolvedValue({
      path: t.path,
      content: "hello there",
      mtime: 2,
      mtime_ns: MTIME,
      writable: true,
    });
    const dials = sockets.length;
    // The tab's host releases the session while the tab loads and takes
    // it again once the load has ended.
    releaseDocSession(t.id);
    await reloadConflictedTab();
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: t.content } });
    acquireDocSession(t);
    redial(dials).frame(snap("hello there", 3));
    await flushMicro();

    expect(read(t, view)).toEqual({
      pushed: 0,
      prompt: null,
      editor: "hello there",
      buffer: "hello there",
      saved: "hello there",
      token: MTIME,
      owns: true,
    });
    cleanup();
  });

  test("Overwrite writes the buffer over the other writer's text with the prompt's tokens and ends attached", async () => {
    const { t, sock, view, cleanup } = await edited();
    sock.frame(snap("hello there", 3));
    await flushMicro();
    const write = vi
      .spyOn(api, "write")
      .mockResolvedValue({ mtime: 3, mtime_ns: "3000000000", authority_version: 4 });
    const dials = sockets.length;
    await overwriteConflictedTab();
    redial(dials).frame(snap("hello!", 4, { mtime_ns: "3000000000" }));
    await flushMicro();

    expect({ written: write.mock.calls.map((call) => call.slice(0, 5)), ...read(t, view) }).toEqual({
      written: [["notes/a.md", "hello!", MTIME, null, 3]],
      pushed: 0,
      prompt: null,
      editor: "hello!",
      buffer: "hello!",
      saved: "hello!",
      token: "3000000000",
      owns: true,
    });
    cleanup();
  });

  test("with the conflict prompt open attaches nothing and leaves the prompt, the tab's tokens and the changed-on-disk flag as they are", async () => {
    const { t, sock, view, cleanup } = await edited();
    flagExternalChange(t.id);
    openPrompt(t);
    sock.frame(snap("hello there", 3));
    await flushMicro();

    expect({ ...read(t, view), offers: conflictDialog.currentMtimeNs, flag: t.externalChange }).toEqual({
      ...ASKED,
      prompt: t.id,
      offers: "5000000000",
      flag: true,
    });
    cleanup();
  });

  test("with the conflict prompt open over a file nobody else changed attaches nothing either", async () => {
    const { t, sock, view, cleanup } = await edited();
    openPrompt(t);
    // The snapshot is the text the tab loaded, so its edit could be pushed:
    // the prompt's buttons decide all the same.
    sock.frame(snap("hello", 0));
    await flushMicro();

    expect(read(t, view)).toEqual({ ...ASKED, prompt: t.id });
    cleanup();
  });

  test("Overwrite from a prompt that was open at the first frame ends attached, with the flag cleared", async () => {
    const { t, sock, view, cleanup } = await edited();
    flagExternalChange(t.id);
    openPrompt(t);
    sock.frame(snap("hello there", 3));
    await flushMicro();
    const write = vi.spyOn(api, "write").mockResolvedValue({ mtime: 6, mtime_ns: "6000000000" });
    const dials = sockets.length;
    await overwriteConflictedTab();
    redial(dials).frame(snap("hello!", 0, { mtime_ns: "6000000000" }));
    await flushMicro();

    expect({
      written: write.mock.calls.map((call) => call.slice(0, 5)),
      ...read(t, view),
      flag: t.externalChange,
    }).toEqual({
      written: [["notes/a.md", "hello!", "5000000000", null, null]],
      pushed: 0,
      prompt: null,
      editor: "hello!",
      buffer: "hello!",
      saved: "hello!",
      token: "6000000000",
      owns: true,
      flag: false,
    });
    cleanup();
  });

  /// A save of the tab on the wire: the write, held until `answer` is called.
  function saveOnTheWire(t: FileTab) {
    let answer: (result: { mtime: number; mtime_ns: string } | ApiError) => void = () => {};
    const write = vi.spyOn(api, "write").mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          answer = (result) => (result instanceof ApiError ? reject(result) : resolve(result));
        }),
    );
    const saving = saveTab(t);
    return { write, saving, answer: (result: Parameters<typeof answer>[0]) => answer(result) };
  }

  test("with a save of the tab on the wire waits for it, and a conflict the new session caused opens no prompt: the edit is pushed once", async () => {
    const { t, sock, view, cleanup } = await edited();
    const { write, saving, answer } = saveOnTheWire(t);
    await flushMicro();
    // Nobody else touched the file: the snapshot is the text the tab loaded.
    sock.frame(snap("hello", 0));
    await flushMicro();
    const atTheFrame = read(t, view);
    const dials = sockets.length;
    // The server made the session before it handled the write, and a write
    // that names no authority version is refused once a session exists.
    answer(
      new ApiError(428, "authority version required", {
        code: "write_conflict",
        current_mtime_ns: "1000000000",
        current_authority_version: 0,
      }),
    );
    await saving;
    const next = redial(dials);
    next.frame(snap("hello", 0, { mtime_ns: "1000000000" }));
    await flushMicro();

    expect({ writes: write.mock.calls.length, atTheFrame, attached: read(t, view) }).toEqual({
      writes: 1,
      atTheFrame: { ...ASKED, prompt: null },
      attached: { ...ASKED, pushed: 1, prompt: null, owns: true },
    });
    await ackLastPush(next, 0);
    expect(t.saved).toBe("hello!");
    cleanup();
  });

  test("with a save of the tab on the wire that lands, attaches clean and pushes nothing", async () => {
    const { t, sock, view, cleanup } = await edited();
    const { saving, answer } = saveOnTheWire(t);
    await flushMicro();
    sock.frame(snap("hello", 0));
    await flushMicro();
    const atTheFrame = read(t, view);
    const dials = sockets.length;
    answer({ mtime: 2, mtime_ns: "2000000000" });
    await saving;
    redial(dials).frame(snap("hello!", 1, { mtime_ns: "2000000000" }));
    await flushMicro();

    expect({ atTheFrame, attached: read(t, view) }).toEqual({
      atTheFrame: { ...ASKED, prompt: null },
      attached: {
        pushed: 0,
        prompt: null,
        editor: "hello!",
        buffer: "hello!",
        saved: "hello!",
        token: "2000000000",
        owns: true,
      },
    });
    cleanup();
  });

  test("a first frame that lands while the tab loads is not judged: the attach waits for the load and takes the file", async () => {
    const { t, sock, view, cleanup } = await edited();
    let finish = (): void => {};
    vi.spyOn(api, "readStream").mockImplementation(async (_path, options) => {
      options?.onChunk?.("hello th", { loadedBytes: 8, totalBytes: 11 });
      await new Promise<void>((resolve) => (finish = resolve));
      return { path: t.path, content: "hello there", mtime: 2, mtime_ns: MTIME, writable: true };
    });
    const dials = sockets.length;
    // A reload of the tab: its host releases the session while it loads.
    const loading = reloadTabFromDisk(t.id);
    releaseDocSession(t.id);
    await flushMicro();
    const midLoad = { loading: t.loading, buffer: t.content, saved: t.saved };
    sock.frame(snap("hello there", 3));
    await flushMicro();
    const atTheFrame = { prompt: conflictDialog.open, pushed: sock.frames("push").length, owns: isDocAttached(t) };
    // An editor mounted again mid-load takes the session back: no dial yet.
    acquireDocSession(t);
    const midLoadDials = sockets.length - dials;
    releaseDocSession(t.id);
    finish();
    await loading;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: t.content } });
    acquireDocSession(t);
    redial(dials).frame(snap("hello there", 3));
    await flushMicro();

    expect({ midLoad, atTheFrame, midLoadDials, attached: read(t, view) }).toEqual({
      midLoad: { loading: true, buffer: "hello th", saved: "" },
      atTheFrame: { prompt: false, pushed: 0, owns: false },
      midLoadDials: 0,
      attached: {
        pushed: 0,
        prompt: null,
        editor: "hello there",
        buffer: "hello there",
        saved: "hello there",
        token: MTIME,
        owns: true,
      },
    });
    cleanup();
  });

  test("over a file nobody else changed attaches with its edit as a push", async () => {
    const { t, sock, view, cleanup } = await edited();
    sock.frame(snap("hello", 0, { mtime_ns: "1000000000" }));
    await flushMicro();

    expect(read(t, view)).toEqual({ ...ASKED, pushed: 1, prompt: null, owns: true });
    cleanup();
  });
});

describe("connection-outage suppression", () => {
  /// Attach, make an unconfirmed local edit, then drop the socket past
  /// the grace so the session is degraded by a still-retrying dead-server
  /// outage (retryStopped false, socket down).
  async function outageDegraded(
    tab: FileTab,
  ): Promise<{ sock: FakeSocket; view: EditorView; cleanup(): void }> {
    const { sock, view, cleanup } = await attached(tab, "hello");
    type(view, "!"); // unconfirmed -> tab.content "hello!"
    await flushMicro();
    sock.drop();
    await vi.advanceTimersByTimeAsync(500);
    lastSocket().drop();
    await vi.advanceTimersByTimeAsync(1000);
    lastSocket().drop();
    return { sock, view, cleanup };
  }

  test("degraded-by-outage suppresses the doomed PUT and never sets tab.error", async () => {
    vi.useFakeTimers();
    const tab = fileTab();
    resetLayout([tab]);
    const t = readTab(tab.id)!;
    const writeSpy = vi.spyOn(api, "write");
    const { view, cleanup } = await outageDegraded(t);
    expect(t.doc?.state).toBe("degraded");
    expect(isDocSavePaused(t)).toBe(true);
    // A save (Cmd+S / close-time) must NOT PUT and must NOT set tab.error
    // (which would swap the editor for the error placeholder); the edit
    // stays in the buffer for the reattach diff-push.
    await saveTab(t);
    expect(writeSpy).not.toHaveBeenCalled();
    expect(t.error).toBeNull();
    expect(t.content).toBe("hello!");
    cleanup();
    void view;
  });

  test("scheduleAutosave stays quiet during an outage, re-arms once it heals", async () => {
    vi.useFakeTimers();
    const tab = fileTab();
    const pane = resetLayout([tab]);
    const t = readTab(tab.id)!;
    const writeSpy = vi
      .spyOn(api, "write")
      .mockResolvedValue({ mtime: 2, mtime_ns: "999" });
    const { cleanup } = await outageDegraded(t);
    scheduleAutosave(pane.id, t.id);
    await vi.advanceTimersByTimeAsync(1000);
    expect(writeSpy).not.toHaveBeenCalled();
    // Heal: an unresolved old push requires a fresh authority snapshot
    // before the buffered edit is offered again.
    await vi.advanceTimersByTimeAsync(2000);
    const healed = lastSocket();
    healed.open();
    expect(healed.url).not.toContain("version=");
    healed.frame(snap("hello"));
    await flushMicro();
    expect(t.doc?.state).toBe("attached");
    expect(isDocSavePaused(t)).toBe(true); // attached -> still paused (flush path)
    expect(healed.frames("push").length).toBeGreaterThan(0);
    expect(writeSpy).not.toHaveBeenCalled();
    cleanup();
  });

  test("a REACHABLE degrade holds the PUT for the in-flight push and stamps the freshest token", async () => {
    vi.useFakeTimers();
    const tab = fileTab();
    resetLayout([tab]);
    const t = readTab(tab.id)!;
    const writeSpy = vi
      .spyOn(api, "write")
      .mockResolvedValue({ mtime: 2, mtime_ns: "999" });
    const { sock, view, cleanup } = await attached(t, "hello");
    type(view, "!");
    await flushMicro();
    expect(sock.frames("push")).toHaveLength(1);
    // Total silence through the quiet window: the funnel degrades, but
    // the push is still on the wire, so the fallback holds the PUT
    // (single writer) instead of racing it with a stale token.
    const save = saveTab(t);
    await vi.advanceTimersByTimeAsync(DOC_FLUSH_TIMEOUT_MS + 50);
    expect(t.doc?.state).toBe("degraded");
    expect(isDocSavePaused(t)).toBe(false); // reachable -> not suppressed
    expect(writeSpy).not.toHaveBeenCalled();
    // The late burst lands inside the settle bound: broadcast + a fresh
    // flush token, then the push-ok releases the fallback. The PUT must
    // carry the burst's token, not the attach-time one.
    const pushes = sock.frames("push");
    sock.frame({ type: "updates", version: 0, updates: pushes[0]!.updates });
    sock.frame({ type: "flush", dirty: false, mtime_ns: "7777" });
    sock.frame({ type: "push-ok", version: 1 });
    await save;
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy.mock.calls[0]![2]).toBe("7777");
    // Degraded single-writer: the pump stays quiet while the classic
    // path owns saves (no push for further typing on ANY socket).
    const healDial = lastSocket();
    type(view, "x");
    await flushMicro();
    expect(sock.frames("push")).toHaveLength(1);
    expect(healDial.frames("push")).toHaveLength(0);
    cleanup();
  });

  test("a permanent stop (attach-failed) is not outage-paused; classic errors surface", async () => {
    vi.useFakeTimers();
    const tab = fileTab();
    resetLayout([tab]);
    const t = readTab(tab.id)!;
    acquireDocSession(t);
    const sock = lastSocket();
    sock.open();
    sock.frame({ type: "error", message: "no such file", reason: "attach-failed" });
    sock.drop();
    expect(t.doc?.state).toBe("degraded");
    expect(isDocSavePaused(t)).toBe(false); // retryStopped -> classic resumes
  });
});

// ---- save funnel (dirty-audit rows 1-3) --------------------------------------

describe("save funnel", () => {
  test("isDocAttached truth table (autosave suppression states)", () => {
    for (const s of ["attached", "connecting", "reconnecting"] as const) {
      expect(isDocAttached(fileTab({ doc: { state: s, peers: 0 } }))).toBe(true);
    }
    for (const s of ["dialing", "degraded", "off"] as const) {
      expect(isDocAttached(fileTab({ doc: { state: s, peers: 0 } }))).toBe(false);
    }
    expect(isDocAttached(fileTab())).toBe(false);
  });

  test("attached save flushes through the session: no PUT, no ConflictModal", async () => {
    const tab = fileTab();
    resetLayout([tab]);
    const t = readTab(tab.id)!;
    const writeSpy = vi.spyOn(api, "write");
    const { sock, view, cleanup } = await attached(t, "hello");
    type(view, "!");
    await flushMicro();
    await ackLastPush(sock, 0);
    const save = saveTab(t);
    await flushMicro();
    // The authority flushes on its debounce and reports clean.
    sock.frame({ type: "flush", dirty: false, mtime_ns: "42" });
    await save;
    expect(writeSpy).not.toHaveBeenCalled();
    expect(conflictDialog.open).toBe(false);
    expect(t.error).toBeNull();
    expect(t.savedMtimeNs).toBe("42");
    expect(t.saved).toBe("hello!");
    cleanup();
  });

  test("a late document ack after both bounds permits a later classic CAS PUT", async () => {
    vi.useFakeTimers();
    const tab = fileTab();
    resetLayout([tab]);
    const t = readTab(tab.id)!;
    const writeSpy = vi
      .spyOn(api, "write")
      .mockResolvedValue({ mtime: 2, mtime_ns: "999" });
    const { sock, view, cleanup } = await attached(t, "hello");
    type(view, "!");
    await flushMicro();
    // Silence ends both waits, leaving the first save withheld.
    const save = saveTab(t);
    await vi.advanceTimersByTimeAsync(DOC_FLUSH_TIMEOUT_MS + 50);
    await vi.advanceTimersByTimeAsync(DOC_FALLBACK_SETTLE_MS + 50);
    await save;
    expect(t.doc?.state).toBe("degraded");
    expect(writeSpy).not.toHaveBeenCalled();
    await ackLastPush(sock, 0);
    await saveTab(t);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy.mock.calls[0]![2]).toBe(MTIME);
    expect(writeSpy.mock.calls[0]![4]).toBe(1);
    expect(t.saved).toBe("hello!");
    expect(t.savedMtimeNs).toBe("999");
    cleanup();
  });

  test("a missing document ack beyond both save bounds withholds the PUT", async () => {
    vi.useFakeTimers();
    const tab = fileTab();
    const pane = resetLayout([tab]);
    const t = readTab(tab.id)!;
    const write = vi.spyOn(api, "write").mockResolvedValue({ mtime: 2, mtime_ns: "999" });
    const { view, cleanup } = await attached(t, "hello");
    type(view, "!");
    await flushMicro();
    const saving = saveTab(t);
    await vi.advanceTimersByTimeAsync(DOC_FLUSH_TIMEOUT_MS + DOC_FALLBACK_SETTLE_MS + 1);
    await saving;
    expect(write, "unresolved document push must not race a PUT").not.toHaveBeenCalled();
    expect(t.content).toBe("hello!");
    expect(t.saveError).toContain("push");
    expect(t.error).toBeNull();
    expect(isDirty(t)).toBe(true);
    expect(isDocUnflushed(t.id)).toBe(true);
    await saveTab(t);
    scheduleAutosave(pane.id, t.id);
    await vi.advanceTimersByTimeAsync(801);
    expect(write, "repeated save and autosave must stay withheld").not.toHaveBeenCalled();
    cleanup();
  });

  test("an ack after the settle timer fires but before its continuation permits fallback", async () => {
    vi.useFakeTimers();
    const tab = fileTab();
    resetLayout([tab]);
    const t = readTab(tab.id)!;
    const write = vi.spyOn(api, "write").mockResolvedValue({ mtime: 2, mtime_ns: "999" });
    const { sock, view, cleanup } = await attached(t, "hello");
    type(view, "!");
    await flushMicro();
    const saving = saveTab(t);
    await vi.advanceTimersByTimeAsync(DOC_FLUSH_TIMEOUT_MS);
    vi.advanceTimersByTime(DOC_FALLBACK_SETTLE_MS);
    const updates = sock.frames("push").at(-1)!.updates as unknown[];
    sock.frame({ type: "updates", version: 0, updates });
    sock.frame({ type: "push-ok", version: updates.length });
    await saving;

    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[4]).toBe(updates.length);
    cleanup();
  });

  test("a deliberate closed frame leaves an unanswered document push unsaved", async () => {
    const tab = fileTab();
    resetLayout([tab]);
    const t = readTab(tab.id)!;
    const write = vi.spyOn(api, "write");
    const { sock, view, cleanup } = await attached(t, "hello");
    type(view, "!");
    await flushMicro();
    expect(sock.frames("push")).toHaveLength(1);
    sock.frame({ type: "closed", reason: "reset" });
    await saveTab(t);

    expect(write, "retirement cannot settle an unanswered push").not.toHaveBeenCalled();
    expect(t.doc?.state).toBe("off");
    expect(t.content).toBe("hello!");
    expect(t.saveError).toContain("push");
    expect(t.error).toBeNull();
    expect(isDirty(t)).toBe(true);
    cleanup();
  });

  test("an unresolved document save marks the replacement tab after a reorder", async () => {
    vi.useFakeTimers();
    const tab = fileTab();
    resetLayout([tab, fileTab()]);
    const t = readTab(tab.id)!;
    const write = vi.spyOn(api, "write");
    const { view, cleanup } = await attached(t, "hello");
    type(view, "!");
    await flushMicro();
    const saving = saveTab(t);
    await vi.advanceTimersByTimeAsync(DOC_FLUSH_TIMEOUT_MS + 1);
    reorderTab("pane-test", t.id, 1);
    const moved = readTab(t.id)!;
    expect(moved).not.toBe(t);
    await vi.advanceTimersByTimeAsync(DOC_FALLBACK_SETTLE_MS + 1);
    await saving;
    expect({ reason: moved.saveError, dirty: isDirty(moved), buffer: moved.content }).toEqual({
      reason: "the previous live push has not been confirmed",
      dirty: true,
      buffer: "hello!",
    });
    expect(write).not.toHaveBeenCalled();
    cleanup();
  });

  test("a lost document socket waits for a fresh snapshot before live recovery", async () => {
    vi.useFakeTimers();
    const tab = fileTab();
    resetLayout([tab]);
    const t = readTab(tab.id)!;
    const write = vi.spyOn(api, "write");
    const { sock, view, cleanup } = await attached(t, "hello");
    type(view, "!");
    await flushMicro();
    const saving = saveTab(t);
    await vi.advanceTimersByTimeAsync(DOC_FLUSH_TIMEOUT_MS + DOC_FALLBACK_SETTLE_MS + 1);
    await saving;
    sock.frame(snap("hello", 0));
    expect(t.unresolvedLivePush).toBe(true);
    expect(write, "same-socket snapshot cannot settle the claim").not.toHaveBeenCalled();
    sock.drop();
    expect(t.unresolvedLivePush).toBe(true);
    expect(write, "socket close cannot settle the claim").not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    const back = lastSocket();
    expect(back.url).not.toContain("version=");
    back.open();
    back.frame(snap("hello", 0));
    await flushMicro();
    expect(back.frames("push")).toHaveLength(1);
    const recovered = saveTab(t);
    await ackLastPush(back, 0);
    back.frame({ type: "flush", dirty: false, mtime_ns: "9000000000" });
    await recovered;
    expect(write).not.toHaveBeenCalled();
    expect(t.saveError).toBeNull();
    expect(isDirty(t)).toBe(false);
    cleanup();
  });

  test("a slow-but-flowing funnel never degrades: frames past the quiet window keep it alive", async () => {
    vi.useFakeTimers();
    const tab = fileTab();
    resetLayout([tab]);
    const t = readTab(tab.id)!;
    const writeSpy = vi.spyOn(api, "write");
    const { sock, view, cleanup } = await attached(t, "hello");
    type(view, "!");
    await flushMicro();
    const save = saveTab(t);
    // High-RTT channel: the push confirm lands only at 3.5s, restarting
    // the quiet window...
    await vi.advanceTimersByTimeAsync(3500);
    await ackLastPush(sock, 0);
    // ...so 7s total is not a timeout; the authority's flush completes
    // the save with no degrade and no PUT.
    await vi.advanceTimersByTimeAsync(3500);
    sock.frame({ type: "flush", dirty: false, mtime_ns: "4242" });
    await save;
    expect(t.doc?.state).toBe("attached");
    expect(writeSpy).not.toHaveBeenCalled();
    expect(conflictDialog.open).toBe(false);
    expect(t.saved).toBe("hello!");
    expect(t.savedMtimeNs).toBe("4242");
    cleanup();
  });

  test("the absolute cap degrades a session that streams frames without confirming", async () => {
    vi.useFakeTimers();
    const tab = fileTab();
    resetLayout([tab]);
    const t = readTab(tab.id)!;
    const writeSpy = vi
      .spyOn(api, "write")
      .mockResolvedValue({ mtime: 2, mtime_ns: "999" });
    const { sock, view, cleanup } = await attached(t, "hello");
    type(view, "!");
    await flushMicro();
    await ackLastPush(sock, 0);
    const save = saveTab(t);
    // The authority keeps reporting dirty (its own disk flush never
    // lands clean): constant progress restarts the quiet window every
    // time, but the absolute cap still ends the wait.
    for (let elapsed = 0; elapsed < DOC_FLUSH_CAP_MS; elapsed += 2000) {
      sock.frame({ type: "flush", dirty: true, mtime_ns: MTIME });
      await vi.advanceTimersByTimeAsync(2000);
    }
    await vi.advanceTimersByTimeAsync(DOC_FALLBACK_SETTLE_MS + 50);
    await save;
    expect(t.doc?.state).toBe("degraded");
    expect(writeSpy).toHaveBeenCalledTimes(1);
    cleanup();
  });

  test("a successful fallback save heals the session back to attached", async () => {
    vi.useFakeTimers();
    const tab = fileTab();
    resetLayout([tab]);
    const t = readTab(tab.id)!;
    vi.spyOn(api, "write").mockResolvedValue({ mtime: 9, mtime_ns: "9000000000" });
    const { sock, view, cleanup } = await attached(t, "hello");
    type(view, "!");
    await flushMicro();
    // The flush times out, but an ack inside the settle bound permits
    // the classic PUT and its heal.
    const save = saveTab(t);
    await vi.advanceTimersByTimeAsync(DOC_FLUSH_TIMEOUT_MS + 50);
    await ackLastPush(sock, 0);
    await save;
    expect(t.doc?.state).toBe("degraded");
    // The successful fallback save triggered a heal: a fresh snapshot
    // dial that re-adopts the authority and promotes back to attached,
    // restoring funnel ownership of saves (single writer).
    const healed = lastSocket();
    expect(healed).not.toBe(sock);
    expect(sock.closedByClient).toBe(true);
    healed.open();
    healed.frame(snap("hello!", 3, { mtime_ns: "9000000000" }));
    await flushMicro();
    expect(t.doc?.state).toBe("attached");
    expect(isDocSavePaused(t)).toBe(true);
    expect(t.saved).toBe("hello!");
    cleanup();
  });

  test("a flush error frame resolves pending saves into the classic fallback", async () => {
    const tab = fileTab();
    resetLayout([tab]);
    const t = readTab(tab.id)!;
    const writeSpy = vi
      .spyOn(api, "write")
      .mockResolvedValue({ mtime: 2, mtime_ns: "999" });
    const { sock, view, cleanup } = await attached(t, "hello");
    type(view, "!");
    await flushMicro();
    await ackLastPush(sock, 0);
    const save = saveTab(t);
    await flushMicro();
    sock.frame({ type: "flush", dirty: true, error: "write failed" });
    await save;
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(t.doc?.state).toBe("degraded");
    cleanup();
  });

  test("a flush error keeps the editor and says the file is not saved until a flush lands", async () => {
    const tab = fileTab();
    resetLayout([tab]);
    const t = readTab(tab.id)!;
    const { sock, view, cleanup } = await attached(t, "hello");
    type(view, "!");
    await flushMicro();
    await ackLastPush(sock, 0);
    sock.frame({ type: "flush", dirty: true, error: "disk full" });
    await flushMicro();
    const failed = { error: t.error, saveError: t.saveError ?? null };
    sock.frame({ type: "flush", dirty: false, mtime_ns: "2000000000" });
    await flushMicro();
    expect({ failed, landed: t.saveError ?? null }).toEqual({
      failed: { error: null, saveError: "the server could not write it (disk full)" },
      landed: null,
    });
    cleanup();
  });

  test("a flush that lands leaves a save error the classic save wrote", async () => {
    const tab = fileTab();
    resetLayout([tab]);
    const t = readTab(tab.id)!;
    const { sock, cleanup } = await attached(t, "hello");
    t.saveError = "the classic save's reason";
    sock.frame({ type: "flush", dirty: false, mtime_ns: "2000000000" });
    await flushMicro();
    expect(t.saveError).toBe("the classic save's reason");
    cleanup();
  });

  test("scheduleAutosave's timer re-checks attachment before firing", async () => {
    vi.useFakeTimers();
    const tab = fileTab({ doc: { state: "attached", peers: 0 } });
    const pane = resetLayout([tab]);
    const t = readTab(tab.id)!;
    t.content = "hello edited";
    const writeSpy = vi
      .spyOn(api, "write")
      .mockResolvedValue({ mtime: 2, mtime_ns: "999" });
    scheduleAutosave(pane.id, t.id);
    await vi.advanceTimersByTimeAsync(1000);
    expect(writeSpy).not.toHaveBeenCalled();
    // Degraded: the same schedule now performs the classic save.
    t.doc = { state: "degraded", peers: 0 };
    scheduleAutosave(pane.id, t.id);
    await vi.advanceTimersByTimeAsync(1000);
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });
});

// ---- dirty/saved consumer audit ----------------------------------------------

describe("dirty consumers", () => {
  test("mirrorToSiblings skips attached siblings (their sync arrives as updates)", async () => {
    const origin = fileTab({ id: "origin", content: "classic edit", saved: "old" });
    const sibling = fileTab({
      id: "sibling",
      content: "authority text",
      saved: "authority text",
      doc: { state: "attached", peers: 1 },
    });
    resetLayout([origin, sibling]);
    const o = readTab("origin")!;
    const s = readTab("sibling")!;
    vi.spyOn(api, "write").mockResolvedValue({ mtime: 2, mtime_ns: "999" });
    await saveTab(o);
    expect(o.saved).toBe("classic edit");
    // The attached sibling was NOT forked from its confirmed shadow.
    expect(s.content).toBe("authority text");
    expect(s.saved).toBe("authority text");
  });

  test("empty-file discard on close releases the doc session BEFORE the remove", async () => {
    const tab = fileTab({ content: "", saved: "x", openedEmpty: true });
    const pane = resetLayout([tab]);
    const t = readTab(tab.id)!;
    const session = acquireDocSession(t);
    expect(session).not.toBeNull();
    let sessionAtRemove: DocSession | undefined = session!;
    vi.spyOn(api, "remove").mockImplementation(async () => {
      sessionAtRemove = docSessionFor(t.id);
    });
    await closeTab(pane.id, t.id);
    expect(sessionAtRemove).toBeUndefined();
    expect(readTab(tab.id)).toBeUndefined();
  });

  test("flagExternalChange no-ops while attached (no banner, live merge)", () => {
    const tab = fileTab({ doc: { state: "attached", peers: 0 } });
    resetLayout([tab]);
    flagExternalChange(tab.id);
    expect(readTab(tab.id)?.externalChange).toBeFalsy();
    readTab(tab.id)!.doc = { state: "degraded", peers: 0 };
    flagExternalChange(tab.id);
    expect(readTab(tab.id)?.externalChange).toBe(true);
  });

  test("scheduleMissingFileCheck no-ops while attached (the removed frame owns it)", async () => {
    vi.useFakeTimers();
    const tab = fileTab({ doc: { state: "attached", peers: 0 } });
    resetLayout([tab]);
    const readSpy = vi.spyOn(api, "readStream");
    scheduleMissingFileCheck(tab.id, tab.path);
    await vi.advanceTimersByTimeAsync(500);
    expect(readSpy).not.toHaveBeenCalled();
    expect(readTab(tab.id)?.fileMissing).toBeNull();
  });

  test("the removed frame routes into the missing-file machinery", async () => {
    const tab = fileTab();
    resetLayout([tab]);
    const t = readTab(tab.id)!;
    const { sock, cleanup } = await attached(t, "hello");
    sock.frame({ type: "removed" });
    await flushMicro();
    expect(t.fileMissing).not.toBeNull();
    expect(t.savedMtimeNs).toBeNull();
    expect(t.savedMtime).toBeNull();
    cleanup();
  });
});

// ---- presence -----------------------------------------------------------------

describe("presence", () => {
  test("peer cursors drive the tab peers count; self-window frames do not", async () => {
    const tab = fileTab();
    const { sock, view, cleanup } = await attached(tab, "hello");
    sock.frame({ type: "cursor", id: 1, w: "peer-win", anchor: 2, head: 2, version: 0 });
    await flushMicro();
    expect(tab.doc?.peers).toBe(1);
    expect(peersIn(view.state).size).toBe(1);
    // Another pane of THIS window is not a peer.
    sock.frame({
      type: "cursor",
      id: 2,
      w: sessionWindowId(),
      anchor: 0,
      head: 0,
      version: 0,
    });
    await flushMicro();
    expect(tab.doc?.peers).toBe(1);
    expect(peersIn(view.state).size).toBe(1);
    sock.frame({ type: "cursor-gone", id: 1 });
    await flushMicro();
    expect(tab.doc?.peers).toBe(0);
    expect(peersIn(view.state).size).toBe(0);
    cleanup();
  });

  test("snapshot cursors seed the presence field", async () => {
    const tab = fileTab();
    const { view, cleanup } = await attached(tab, "hello");
    const sock = lastSocket();
    sock.frame(
      snap("hello", 0, {
        cursors: [{ id: 9, w: "peer-win", anchor: 1, head: 3, version: 0 }],
      }),
    );
    await flushMicro();
    expect(tab.doc?.peers).toBe(1);
    expect(peersIn(view.state).size).toBe(1);
    cleanup();
  });

  test("outbound cursor frames are trailing-edge throttled", async () => {
    vi.useFakeTimers();
    const tab = fileTab();
    const { sock, view, cleanup } = await attached(tab, "hello");
    view.dispatch({ selection: { anchor: 1 } });
    view.dispatch({ selection: { anchor: 2 } });
    view.dispatch({ selection: { anchor: 3 } });
    expect(sock.frames("cursor")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(150);
    const cursors = sock.frames("cursor");
    expect(cursors).toHaveLength(1);
    expect(cursors[0]).toMatchObject({ type: "cursor", anchor: 3, head: 3 });
    cleanup();
  });
});

// ---- lifecycle ------------------------------------------------------------------

describe("lifecycle", () => {
  test("release lingers; re-acquire within the window keeps the session", async () => {
    vi.useFakeTimers();
    const tab = fileTab();
    const session = acquireDocSession(tab)!;
    releaseDocSession(tab.id);
    await vi.advanceTimersByTimeAsync(DOC_RELEASE_LINGER_MS - 100);
    expect(acquireDocSession(tab)).toBe(session);
    await vi.advanceTimersByTimeAsync(DOC_RELEASE_LINGER_MS * 4);
    expect(docSessionFor(tab.id)).toBe(session);
    releaseDocSession(tab.id);
    await vi.advanceTimersByTimeAsync(DOC_RELEASE_LINGER_MS + 50);
    expect(docSessionFor(tab.id)).toBeUndefined();
    expect(lastSocket().closedByClient).toBe(true);
    expect(tab.doc).toBeUndefined();
  });

  test("session token is stable across re-acquire, distinct across sessions", () => {
    // The editor memoizes its per-mount extension on `${token}:${mode}`;
    // a re-acquire (editor remount within the linger) must keep the same
    // token so the extension is not re-minted, while a genuinely new
    // session gets a fresh token.
    const tab = fileTab();
    const s1 = acquireDocSession(tab)!;
    const t1 = s1.token;
    expect(acquireDocSession(tab)!.token).toBe(t1); // re-acquire: same
    s1.release({ immediate: true });
    const s2 = acquireDocSession(fileTab())!;
    expect(s2.token).not.toBe(t1); // new session: distinct
  });

  test("immediate release destroys now", () => {
    const tab = fileTab();
    acquireDocSession(tab);
    releaseDocSession(tab.id, { immediate: true });
    expect(docSessionFor(tab.id)).toBeUndefined();
    expect(lastSocket().closedByClient).toBe(true);
  });
});

// ---- convergence through a pure-TS authority -----------------------------------

/// A minimal chan-server doc authority: version-gated pushes, full
/// echo broadcast (sender included), push-ok after the broadcast on
/// the same socket, push-stale on version mismatch. Pumped manually so
/// tests control interleaving.
class Authority {
  version = 0;
  clients: FakeSocket[] = [];
  private pumped = new Map<FakeSocket, number>();

  attach(sock: FakeSocket, doc: string): void {
    this.clients.push(sock);
    this.pumped.set(sock, sock.sent.length);
    sock.open();
    sock.frame(snap(doc, this.version));
  }

  /// Process every unhandled client->server frame on `sock`.
  pump(sock: FakeSocket): void {
    const from = this.pumped.get(sock) ?? 0;
    const frames = sock.sent.slice(from).map((s) => JSON.parse(s));
    this.pumped.set(sock, sock.sent.length);
    for (const f of frames) {
      if (f.type !== "push") continue;
      if (f.version !== this.version) {
        sock.frame({ type: "push-stale", version: this.version });
        continue;
      }
      const base = this.version;
      this.version += (f.updates as unknown[]).length;
      for (const c of this.clients) {
        c.frame({ type: "updates", version: base, updates: f.updates });
      }
      sock.frame({ type: "push-ok", version: this.version });
    }
  }
}

describe("convergence", () => {
  test("two editors on one path converge, including a concurrent-stale round", async () => {
    const authority = new Authority();
    const tabA = fileTab({ id: "conv-a", content: "base", saved: "base" });
    const tabB = fileTab({ id: "conv-b", content: "base", saved: "base" });

    const sessionA = acquireDocSession(tabA)!;
    const sockA = lastSocket();
    const a = mountEditor(tabA, sessionA);
    const sessionB = acquireDocSession(tabB)!;
    const sockB = lastSocket();
    const b = mountEditor(tabB, sessionB);
    await flushMicro();
    authority.attach(sockA, "base");
    authority.attach(sockB, "base");
    await flushMicro();
    expect(tabA.doc?.state).toBe("attached");
    expect(tabB.doc?.state).toBe("attached");

    // Sequential edits from both sides.
    type(a.view, "A", 0);
    await flushMicro();
    authority.pump(sockA);
    await flushMicro();
    type(b.view, "B"); // at end
    await flushMicro();
    authority.pump(sockB);
    await flushMicro();
    expect(a.view.state.doc.toString()).toBe("AbaseB");
    expect(b.view.state.doc.toString()).toBe("AbaseB");

    // Concurrent edits: both push at the same version; B goes stale,
    // rebases over A's broadcast, re-pushes.
    type(a.view, "1", 0);
    type(b.view, "2"); // at end
    await flushMicro();
    authority.pump(sockA); // A accepted + broadcast
    await flushMicro();
    authority.pump(sockB); // B stale -> latch -> rebase -> re-push
    await flushMicro();
    authority.pump(sockB); // accept B's rebased push
    await flushMicro();

    const docA = a.view.state.doc.toString();
    const docB = b.view.state.doc.toString();
    expect(docA).toBe(docB);
    expect(docA).toBe("1AbaseB2");
    expect(tabA.saved).toBe(docA);
    expect(tabB.saved).toBe(docB);

    a.cleanup();
    b.cleanup();
  });
});

// ---- conflicts --------------------------------------------------------------

describe("conflicts", () => {
  test("a conflict frame raises tab.diskConflicted; resolution clears it", async () => {
    const tab = fileTab();
    resetLayout([tab]);
    const { sock, cleanup } = await attached(tab);
    expect(readTab(tab.id)!.diskConflicted ?? false).toBe(false);

    sock.frame({ type: "conflict", active: true, disk_mtime_ns: MTIME });
    expect(readTab(tab.id)!.diskConflicted).toBe(true);

    sock.frame({ type: "conflict", active: false });
    expect(readTab(tab.id)!.diskConflicted).toBe(false);
    cleanup();
  });

  test("a conflicted snapshot marks the tab on attach", async () => {
    const tab = fileTab();
    resetLayout([tab]);
    const session = acquireDocSession(tab);
    expect(session).not.toBeNull();
    const sock = lastSocket();
    const mounted = mountEditor(tab, session!);
    await flushMicro();
    sock.open();
    sock.frame({ ...snap(tab.content, 0, { dirty: true }), conflicted: true });
    await flushMicro();
    expect(readTab(tab.id)!.diskConflicted).toBe(true);
    // A later clean snapshot (hard resync after resolution) clears it.
    sock.frame(snap(tab.content, 0));
    await flushMicro();
    expect(readTab(tab.id)!.diskConflicted).toBe(false);
    mounted.cleanup();
  });
});

// ---- a session whose tab was replaced under it ------------------------------
//
// Every reorder, cross-pane move and Hybrid Nav commit rebuilds a tab as a
// clone, and a session survives those without rebinding. A session that holds
// the object it was constructed with therefore writes its status onto a copy
// nobody renders or saves from, and the tab in the layout keeps whatever it
// was last mirrored with.

describe("a session follows its tab through a move", () => {
  function liveTab(id: string): FileTab {
    const pane = layout.nodes["pane-test"] as LeafNode;
    return pane.tabs.find((t) => t.id === id) as FileTab;
  }

  test("a status change after a reorder reaches the tab in the layout", async () => {
    const tab = fileTab();
    const other = fileTab();
    resetLayout([tab, other]);
    const { sock, cleanup } = await attached(tab);
    expect(liveTab(tab.id).doc?.state).toBe("attached");

    reorderTab("pane-test", tab.id, 1);
    // The clone is a different object; the session was not told.
    expect(liveTab(tab.id)).not.toBe(tab);

    sock.drop();
    await flushMicro();

    // Reconnecting or degraded, the point is that it moved off "attached".
    expect(liveTab(tab.id).doc?.state).not.toBe("attached");
    cleanup();
  });

  test("a status change during Hybrid Nav reaches the committed tab", async () => {
    // A commit replaces the tree with a clone of the draft taken at entry,
    // so a status the session mirrored while the draft was up lands on a
    // tab the commit throws away. The committed tab then keeps the
    // "attached" it entered with, and that frozen mirror is what tells the
    // classic save path to stand down.
    const write = vi.spyOn(api, "write").mockResolvedValue({ mtime: 2, mtime_ns: "2" });
    const tab = fileTab();
    resetLayout([tab]);
    const { session, cleanup } = await attached(tab);
    expect(liveTab(tab.id).doc?.state).toBe("attached");

    enterPaneMode();
    session.degrade();
    commitPaneMode();

    const moved = liveTab(tab.id);
    expect(isDocAttached(moved)).toBe(false);
    expect(isDocSavePaused(moved)).toBe(false);

    moved.content = moved.content + "\n";
    await saveTab(moved);
    await flushMicro();

    expect(write).toHaveBeenCalledTimes(1);
    cleanup();
  });

  test("a conflict frame during Hybrid Nav reaches the committed tab", async () => {
    // The session writes the conflict flag through the live tree, and the
    // commit replaces that tree with the draft's entry-time clone. The
    // server sends the transition once, so a flag lost here is not resent:
    // the banner never shows, the tab still reads attached so autosave
    // stands down, and the authority accepts pushes it will not flush.
    const tab = fileTab();
    resetLayout([tab]);
    const { sock, cleanup } = await attached(tab);
    expect(liveTab(tab.id).diskConflicted ?? false).toBe(false);

    enterPaneMode();
    sock.frame({ type: "conflict", active: true, disk_mtime_ns: MTIME });
    commitPaneMode();

    expect(liveTab(tab.id).diskConflicted).toBe(true);
    cleanup();
  });

  test("a degrade during the save's own flush reaches the moved tab's gate", async () => {
    // `performSaveOnce` awaits the delegate for as long as the flush takes.
    // A move in that window replaces the tab object, and the mirror the
    // degrade writes lands on the new one, so a gate still reading the
    // object the call was handed sees a frozen "attached" and skips the
    // PUT the delegate just asked for.
    const write = vi.spyOn(api, "write").mockResolvedValue({ mtime: 2, mtime_ns: "2" });
    const tab = fileTab();
    const other = fileTab();
    resetLayout([tab, other]);
    const handed = liveTab(tab.id);
    const { sock, view, cleanup } = await attached(handed, "hello");
    type(view, "!");
    await flushMicro();
    await ackLastPush(sock, 0);

    const saving = saveTab(handed);
    await flushMicro();
    reorderTab("pane-test", tab.id, 1);
    expect(liveTab(tab.id)).not.toBe(handed);
    // The flush fails, so the delegate degrades the session and falls
    // through to the classic path.
    sock.frame({ type: "flush", dirty: true, error: "write failed" });
    await saving;
    await flushMicro();

    expect(write).toHaveBeenCalledTimes(1);
    cleanup();
  });

  test("a degraded session after a reorder does not suppress the classic save", async () => {
    // isDocSavePaused answers true for anything isDocAttached answers true
    // for, so a tab frozen at "attached" over a session that has stopped
    // owning saves swallows the PUT and the buffer never reaches disk.
    const write = vi.spyOn(api, "write").mockResolvedValue({ mtime: 2, mtime_ns: "2" });
    const tab = fileTab();
    const other = fileTab();
    resetLayout([tab, other]);
    const { session, cleanup } = await attached(tab);

    reorderTab("pane-test", tab.id, 1);
    session.degrade();
    await flushMicro();

    const moved = liveTab(tab.id);
    expect(isDocAttached(moved)).toBe(false);
    expect(isDocSavePaused(moved)).toBe(false);

    moved.content = moved.content + "\n";
    await saveTab(moved);
    await flushMicro();

    expect(write).toHaveBeenCalledTimes(1);
    cleanup();
  });
});
