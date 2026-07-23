// @vitest-environment jsdom

// docSync behavior pins: the pump (push / own-echo confirm / stale
// rebase), the attach algorithm (pending-diff merge, hard-resync
// rebase-by-diff), degradation + capability probe, the save funnel
// (attached saves never PUT; flush failure degrades to classic), the
// dirty/saved consumer audit rows, presence plumbing, and two-editor
// convergence through a pure-TS authority. The wire shapes match the
// serde pins in crates/chan-server/src/routes/doc.rs (d117edb2).

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ChangeSet, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, redo, undo } from "@codemirror/commands";
import { api, sessionWindowId } from "../api/client";
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
  closeTab,
  conflictDialog,
  flagExternalChange,
  isDocAttached,
  isDocSavePaused,
  layout,
  saveTab,
  scheduleAutosave,
  scheduleMissingFileCheck,
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

function fileTab(partial: Partial<FileTab> = {}): FileTab {
  nextTabId += 1;
  return {
    kind: "file",
    fileKind: "document",
    id: `doc-tab-${nextTabId}`,
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
    id: "pane-test",
    tabs,
    activeTabId: tabs[0]?.id ?? null,
  };
  layout.rootId = pane.id;
  layout.activePaneId = pane.id;
  layout.nodes = { [pane.id]: pane };
  layout.focusColor = "blue";
  return pane;
}

/// Read a tab back through the $state proxy (mutations through raw
/// references captured before the layout insert do not reflect).
function readTab(id: string): FileTab | undefined {
  for (const node of Object.values(layout.nodes)) {
    if (node.kind !== "leaf") continue;
    const t = node.tabs.find((t) => t.id === id);
    if (t && t.kind === "file") return t;
  }
  return undefined;
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
    expect(view.state.doc.toString()).toBe("hello");
    expect(sock.frames("push")).toHaveLength(0);
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
    // The push is never acked; the server hard-resyncs us at a newer
    // version whose text includes a peer prefix.
    sock.frame(snap("Phello", 7));
    await flushMicro();
    expect(view.state.doc.toString()).toBe("PhelloL");
    expect(tab.saved).toBe("Phello");
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
    // The server refuses the attach with a frame BEFORE the close, so
    // the capability probe never reads this as an old server.
    sock.frame({ type: "error", message: "no such file", reason: "attach-failed" });
    sock.drop();
    expect(tab.doc?.state).toBe("degraded");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sockets.length).toBe(1); // no redial of a permanently bad attach
    // The module-wide latch is untouched: other tabs still attach.
    expect(acquireDocSession(fileTab())).not.toBeNull();
  });

  test("capability probe: first close before any frame latches doc sync off", async () => {
    const tab = fileTab();
    const session = acquireDocSession(tab);
    expect(session).not.toBeNull();
    lastSocket().drop();
    expect(tab.doc?.state).toBe("off");
    // Module-wide latch: further acquires are refused outright.
    expect(acquireDocSession(fileTab())).toBeNull();
  });

  test("an attach TIMEOUT close does not latch capability off; the dial retries", async () => {
    vi.useFakeTimers();
    const tab = fileTab();
    acquireDocSession(tab);
    const first = lastSocket();
    // The dial hangs: no frame at all. The client closes the socket
    // itself when the attach window runs out.
    await vi.advanceTimersByTimeAsync(DOC_ATTACH_TIMEOUT_MS + 50);
    expect(first.closedByClient).toBe(true);
    // A self-inflicted timeout close proves nothing about the server:
    // the module latch must stay unknown and the session must redial.
    expect(tab.doc?.state).not.toBe("off");
    await vi.advanceTimersByTimeAsync(600);
    expect(sockets.length).toBe(2);
    const retry = lastSocket();
    retry.open();
    retry.frame(snap("hello", 0));
    await flushMicro();
    expect(tab.doc?.state).toBe("attached");
    // Other tabs still get sessions: nothing was latched module-wide.
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

  test("a no-workspace error (dial racing a reset swap) retries, never latches", async () => {
    vi.useFakeTimers();
    const tab = fileTab();
    acquireDocSession(tab);
    const sock = lastSocket();
    sock.open();
    // The server answers the race with a FRAME before closing, so the
    // capability probe must not read this as a pre-doc-sync server and
    // the session must redial once the cell swap settles.
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

// ---- connection-outage save suppression (task-Web-Fable-3, option B) ----------

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
    // Heal: the pending reconnect dial fires; the resumed socket (collab
    // still installed) reattaches and re-pushes the buffered edit instead
    // of losing it - no classic PUT ever fires.
    await vi.advanceTimersByTimeAsync(2000);
    const healed = lastSocket();
    healed.open();
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
    for (const s of ["degraded", "off"] as const) {
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

  test("flush timeout degrades the session and falls back to a classic CAS PUT", async () => {
    vi.useFakeTimers();
    const tab = fileTab();
    resetLayout([tab]);
    const t = readTab(tab.id)!;
    const writeSpy = vi
      .spyOn(api, "write")
      .mockResolvedValue({ mtime: 2, mtime_ns: "999" });
    const { view, cleanup } = await attached(t, "hello");
    type(view, "!");
    await flushMicro();
    // Push never acked; the flush cannot confirm. The channel stays
    // silent through the quiet window AND the fallback settle bound, so
    // the PUT finally fires with the last token that ever arrived.
    const save = saveTab(t);
    await vi.advanceTimersByTimeAsync(DOC_FLUSH_TIMEOUT_MS + 50);
    await vi.advanceTimersByTimeAsync(DOC_FALLBACK_SETTLE_MS + 50);
    await save;
    expect(t.doc?.state).toBe("degraded");
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy.mock.calls[0]![2]).toBe(MTIME);
    expect(t.saved).toBe("hello!");
    expect(t.savedMtimeNs).toBe("999");
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
    // Silence degrades the funnel and the settle bound expires
    // unanswered; the classic PUT lands.
    const save = saveTab(t);
    await vi.advanceTimersByTimeAsync(DOC_FLUSH_TIMEOUT_MS + 50);
    await vi.advanceTimersByTimeAsync(DOC_FALLBACK_SETTLE_MS + 50);
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
