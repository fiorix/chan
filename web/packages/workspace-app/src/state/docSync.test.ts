// @vitest-environment jsdom

// docSync behavior pins: the pump (push / own-echo confirm / stale
// rebase), the attach algorithm (pending-diff merge, hard-resync
// rebase-by-diff), degradation + capability probe, the save funnel
// (attached saves never PUT; flush failure degrades to classic), the
// dirty/saved consumer audit rows, presence plumbing, and two-editor
// convergence through a pure-TS authority. The wire shapes match the
// serde pins in crates/chan-server/src/routes/doc.rs (d117edb2).

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ChangeSet, EditorState, Text } from "@codemirror/state";
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
  DOC_SNAPSHOT_TIMEOUT_MS,
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
  dismissConflict,
  enterPaneMode,
  flagExternalChange,
  isDocAttached,
  isClassicSaveRunning,
  isDocSavePaused,
  isDocUnflushed,
  isDirty,
  layout,
  overwriteDiskConflict,
  overwriteConflictedTab,
  registerPendingEditFlush,
  rekeyTabsForRename,
  reloadConflictedTab,
  reorderTab,
  saveTab,
  scheduleAutosave,
  scheduleMissingFileCheck,
  type FileTab,
  type LeafNode,
} from "./tabs.svelte";
import { draftPath } from "../__tests__/drafts";
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

/// The first message of every accepted upgrade of the document socket, as
/// its bytes on the wire: the server sends it before it attaches the session.
const HELLO = '{"type":"hello"}';

function hello(sock: FakeSocket): void {
  sock.onmessage?.({ data: HELLO });
}

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

function authorityAfterPushes(sock: FakeSocket, initial: string): string {
  let text = Text.of(initial.split("\n"));
  for (const frame of sock.frames("push")) {
    for (const update of frame.updates as { changes: unknown }[]) {
      text = ChangeSet.fromJSON(update.changes).apply(text);
    }
  }
  return text.toString();
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

  test("a draft's document opens no session: it is read and written over the files route alone", () => {
    expect.soft(isDocSyncEligible(fileTab({ path: draftPath("untitled") }))).toBe(false);
    // A workspace folder named `.Drafts` holds ordinary documents.
    expect.soft(isDocSyncEligible(fileTab({ path: ".Drafts/untitled/draft.md" }))).toBe(true);
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
  test("a changed first snapshot is judged without a mounted editor", async () => {
    const tab = fileTab({ content: "hello", saved: "hello" });
    acquireDocSession(tab);
    const sock = lastSocket();
    sock.open();
    sock.frame(snap("hello there"));
    await flushMicro();
    expect(sock.frames("push")).toHaveLength(0);
    expect(tab.content).toBe("hello there");
    expect(tab.saved).toBe("hello there");
  });

  test("a pending first attach without an editor refuses a save until collab can push", async () => {
    vi.useFakeTimers();
    const tab = fileTab({ content: "hello!", saved: "hello" });
    const write = vi.spyOn(api, "write").mockResolvedValue({ mtime: 2, mtime_ns: "2000000000" });
    const session = acquireDocSession(tab)!;
    const sock = lastSocket();
    sock.open();
    sock.frame(snap("hello"));
    await saveTab(tab);
    await vi.advanceTimersByTimeAsync(DOC_FLUSH_TIMEOUT_MS + 1);
    expect(write).not.toHaveBeenCalled();
    expect(sock.frames("push")).toHaveLength(0);
    expect(tab.saveError).toContain("Waiting for this editor");
    session.degrade();
    await saveTab(tab);
    expect(write).not.toHaveBeenCalled();
    expect(tab.saveError).toContain("Waiting for this editor");
    const { cleanup } = mountEditor(tab, session);
    await flushMicro();
    expect(sock.frames("push")).toHaveLength(1);
    expect(tab.saveError).toBeNull();
    cleanup();
  });

  test("a clean adoption follows a peer update before the editor binds", async () => {
    const tab = fileTab();
    const session = acquireDocSession(tab)!;
    const sock = lastSocket();
    sock.open();
    sock.frame(snap("hello there"));
    sock.frame({
      type: "updates",
      version: 0,
      updates: [{ clientID: "peer-1", changes: changesJSON(11, 11, 11, "!") }],
    });
    expect(tab.doc?.firstAttachChoice).toBe(false);
    expect(tab.content).toBe("hello there!");
    expect(tab.saved).toBe("hello there!");
    const { view, cleanup } = mountEditor(tab, session);
    await flushMicro();
    expect(sock.frames("push")).toHaveLength(0);
    expect(tab.doc?.firstAttachChoice).toBe(false);
    expect(tab.content).toBe("hello there!");
    expect(tab.saved).toBe("hello there!");
    expect(view.state.doc.toString()).toBe("hello there!");
    cleanup();
  });

  test("an unmounted Overwrite asks again if the authority advances before bind", async () => {
    const tab = fileTab({ content: "hello!", saved: "hello" });
    const session = acquireDocSession(tab)!;
    const sock = lastSocket();
    sock.open();
    sock.frame(snap("hello there"));
    expect(session.chooseFirstAttach("overwrite")).toBe(true);
    expect(tab.doc?.firstAttachChoice).toBe(false);
    sock.frame({
      type: "updates",
      version: 0,
      updates: [{ clientID: "peer-1", changes: changesJSON(11, 0, 0, "P") }],
    });
    const { view, cleanup } = mountEditor(tab, session);
    await flushMicro();
    expect(sock.frames("push")).toHaveLength(0);
    expect(tab.doc?.firstAttachChoice).toBe(true);
    expect(tab.content).toBe("hello!");
    expect(tab.saved).toBe("hello there");
    expect(view.state.doc.toString()).toBe("hello!");
    cleanup();
  });

  test("a reload during release linger supplies the first snapshot's base", async () => {
    const tab = fileTab({ content: "hello", saved: "hello" });
    const session = acquireDocSession(tab);
    releaseDocSession(tab.id);
    tab.content = "reloaded";
    tab.saved = "reloaded";
    expect(acquireDocSession(tab)).toBe(session);
    const sock = lastSocket();
    sock.open();
    sock.frame(snap("reloaded elsewhere"));
    await flushMicro();
    expect(sock.frames("push")).toHaveLength(0);
    expect(tab.content).toBe("reloaded elsewhere");
    expect(tab.saved).toBe("reloaded elsewhere");
  });

  test("a clean first attach adopts a changed authority without overwriting it", async () => {
    const tab = fileTab({ content: "hello", saved: "hello" });
    const { sock, view, cleanup } = await attached(tab, "hello there");
    expect(authorityAfterPushes(sock, "hello there")).toBe("hello there");
    expect(sock.frames("push")).toHaveLength(0);
    expect(view.state.doc.toString()).toBe("hello there");
    expect(tab.content).toBe("hello there");
    expect(tab.saved).toBe("hello there");
    cleanup();
  });

  test("a dirty first attach asks before replacing a changed authority", async () => {
    const tab = fileTab({ content: "hello!", saved: "hello" });
    const { sock, view, cleanup } = await attached(tab, "hello there");
    expect(authorityAfterPushes(sock, "hello there")).toBe("hello there");
    expect(sock.frames("push")).toHaveLength(0);
    expect(conflictDialog.open).toBe(true);
    expect(conflictDialog.tabId).toBe(tab.id);
    expect(view.state.doc.toString()).toBe("hello!");
    expect(tab.content).toBe("hello!");
    expect(tab.saved).toBe("hello");
    cleanup();
  });

  test("Cancel stays dismissed across local and peer edits until an explicit save", async () => {
    const tab = fileTab({ content: "hello!", saved: "hello" });
    resetLayout([tab]);
    const live = readTab(tab.id)!;
    const { sock, view, cleanup } = await attached(live, "hello there");
    expect(conflictDialog.open).toBe(true);
    dismissConflict();
    type(view, "?");
    await flushMicro();
    expect(live.doc?.firstAttachChoice).toBe(true);
    expect(conflictDialog.open).toBe(false);
    sock.frame({
      type: "updates",
      version: 0,
      updates: [{ clientID: "peer-1", changes: changesJSON(11, 11, 11, ".") }],
    });
    await flushMicro();
    expect(conflictDialog.open).toBe(false);
    expect(sock.frames("push")).toHaveLength(0);
    await saveTab(live);
    expect(conflictDialog.open).toBe(true);
    expect(conflictDialog.tabId).toBe(live.id);
    cleanup();
  });

  test("a disk reload resets the first-attach base before a newer snapshot", async () => {
    const tab = fileTab({ content: "hello!", saved: "hello" });
    const session = acquireDocSession(tab)!;
    const first = lastSocket();
    first.open();
    first.frame(snap("hello there"));
    expect(tab.doc?.firstAttachChoice).toBe(true);
    session.discardFirstAttachChoice();
    tab.content = "disk reload";
    tab.saved = "disk reload";
    await flushMicro();
    const second = lastSocket();
    expect(second).not.toBe(first);
    second.open();
    second.frame(snap("newer peer edit", 1));
    await flushMicro();
    expect(tab.doc?.firstAttachChoice).toBe(false);
    expect(tab.content).toBe("newer peer edit");
    expect(tab.saved).toBe("newer peer edit");
    expect(second.frames("push")).toHaveLength(0);
  });

  test("Reload discards local editor text even when its commit hook throws", async () => {
    const tab = fileTab({ content: "hello!", saved: "hello" });
    resetLayout([tab]);
    const live = readTab(tab.id)!;
    const { sock, view, cleanup } = await attached(live, "hello there");
    const unregister = registerPendingEditFlush(live.id, () => {
      throw new Error("editor commit failed");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await reloadConflictedTab();
    await flushMicro();
    expect(live.doc?.firstAttachChoice).toBe(false);
    expect(conflictDialog.open).toBe(false);
    expect(view.state.doc.toString()).toBe("hello there");
    expect(live.content).toBe("hello there");
    expect(live.saved).toBe("hello there");
    expect(sock.frames("push")).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
    unregister();
    cleanup();
  });

  test("a snapshot already equal to the dirty buffer attaches without a choice", async () => {
    const tab = fileTab({ content: "hello!", saved: "hello" });
    const { sock, view, cleanup } = await attached(tab, "hello!");
    expect(sock.frames("push")).toHaveLength(0);
    expect(conflictDialog.open).toBe(false);
    expect(tab.doc?.state).toBe("attached");
    expect(tab.saved).toBe("hello!");
    expect(view.state.doc.toString()).toBe("hello!");
    cleanup();
  });

  test("Reload takes the changed authority after a dirty first snapshot", async () => {
    const tab = fileTab({ content: "hello!", saved: "hello" });
    resetLayout([tab]);
    const live = readTab(tab.id)!;
    const { sock, view, cleanup } = await attached(live, "hello there");
    await reloadConflictedTab();
    await flushMicro();
    expect(sock.frames("push")).toHaveLength(0);
    expect(conflictDialog.open).toBe(false);
    expect(live.doc?.state).toBe("attached");
    expect(view.state.doc.toString()).toBe("hello there");
    expect(live.content).toBe("hello there");
    expect(live.saved).toBe("hello there");
    cleanup();
  });

  test("Overwrite sends the held buffer through the document socket", async () => {
    const tab = fileTab({ content: "hello!", saved: "hello" });
    resetLayout([tab]);
    const live = readTab(tab.id)!;
    const { sock, view, cleanup } = await attached(live, "hello there");
    await overwriteConflictedTab();
    await flushMicro();
    expect(sock.frames("push")).toHaveLength(1);
    expect(authorityAfterPushes(sock, "hello there")).toBe("hello!");
    expect(view.state.doc.toString()).toBe("hello!");
    expect(live.saved).toBe("hello there");
    await ackLastPush(sock, 0);
    expect(live.saved).toBe("hello!");
    expect(conflictDialog.open).toBe(false);
    cleanup();
  });

  test("a peer edit after Overwrite's click rebases beside the local edit", async () => {
    const tab = fileTab({ content: "hello!", saved: "hello" });
    resetLayout([tab]);
    const live = readTab(tab.id)!;
    const { sock, view, cleanup } = await attached(live, "hello there");
    await overwriteConflictedTab();
    expect(sock.frames("push")).toHaveLength(1);
    sock.frame({ type: "push-stale", version: 1 });
    sock.frame({
      type: "updates",
      version: 0,
      updates: [{ clientID: "peer-1", changes: changesJSON(11, 0, 0, "P") }],
    });
    await flushMicro();
    const second = sock.frames("push")[1]!;
    expect(second.version).toBe(1);
    const applied = ChangeSet.fromJSON((second.updates as { changes: unknown }[])[0]!.changes)
      .apply(Text.of(["Phello there"])).toString();
    expect(applied).toBe("Phello!");
    await ackLastPush(sock, 1);
    expect(view.state.doc.toString()).toBe("Phello!");
    expect(live.saved).toBe("Phello!");
    sock.frame({
      type: "updates",
      version: 2,
      updates: [{ clientID: "peer-2", changes: changesJSON(7, 7, 7, "?") }],
    });
    expect(view.state.doc.toString()).toBe("Phello!?");
    cleanup();
  });

  test("a failed flush after Overwrite keeps the accepted authority and error", async () => {
    const tab = fileTab({ content: "hello!", saved: "hello" });
    resetLayout([tab]);
    const live = readTab(tab.id)!;
    const write = vi.spyOn(api, "write");
    const { sock, cleanup } = await attached(live, "hello there");
    await overwriteConflictedTab();
    await ackLastPush(sock, 0);
    sock.frame({ type: "flush", dirty: true, error: "disk full" });
    expect(live.doc?.firstAttachChoice).toBe(false);
    expect(live.content).toBe("hello!");
    expect(live.saved).toBe("hello!");
    expect(live.saveError).toContain("disk full");
    expect(write).not.toHaveBeenCalled();
    cleanup();
  });

  test("two dirty tabs remain held when only one owns the modal", async () => {
    const first = fileTab({ content: "hello!", saved: "hello" });
    const second = fileTab({ path: "notes/b.md", content: "hello?", saved: "hello" });
    resetLayout([first, second]);
    const a = readTab(first.id)!;
    const b = readTab(second.id)!;
    const one = await attached(a, "hello there");
    const two = await attached(b, "hello elsewhere");
    expect(conflictDialog.tabId).toBe(a.id);
    expect(b.doc?.firstAttachChoice).toBe(true);
    expect(b.saveError).toContain("choose Reload or Overwrite");
    dismissConflict();
    await saveTab(b);
    expect(conflictDialog.tabId).toBe(b.id);
    expect(one.sock.frames("push")).toHaveLength(0);
    expect(two.sock.frames("push")).toHaveLength(0);
    one.cleanup();
    two.cleanup();
  });

  test("a held tab refuses explicit and timed saves without either write channel", async () => {
    vi.useFakeTimers();
    const tab = fileTab({ content: "hello!", saved: "hello" });
    const pane = resetLayout([tab]);
    const live = readTab(tab.id)!;
    const write = vi.spyOn(api, "write");
    const { sock, cleanup } = await attached(live, "hello there");
    await saveTab(live);
    scheduleAutosave(pane.id, live.id);
    await vi.advanceTimersByTimeAsync(DOC_FLUSH_TIMEOUT_MS + DOC_SNAPSHOT_TIMEOUT_MS + 1);
    expect(write).not.toHaveBeenCalled();
    expect(sock.frames("push")).toHaveLength(0);
    expect(live.doc?.firstAttachChoice).toBe(true);
    expect(live.saveError).toContain("choose Reload or Overwrite");
    cleanup();
  });

  test("Overwrite while the socket is down keeps the buffer and asks again", async () => {
    const tab = fileTab({ content: "hello!", saved: "hello" });
    resetLayout([tab]);
    const live = readTab(tab.id)!;
    const { sock, cleanup } = await attached(live, "hello there");
    sock.drop();
    await overwriteConflictedTab();
    expect(sock.frames("push")).toHaveLength(0);
    expect(live.doc?.firstAttachChoice).toBe(true);
    expect(live.content).toBe("hello!");
    expect(live.saved).toBe("hello");
    expect(live.saveError).toContain("Reconnect before");
    expect(conflictDialog.tabId).toBe(live.id);
    cleanup();
  });

  test("a classic save in flight postpones new document acquisition", async () => {
    const tab = fileTab({ content: "hello!", saved: "hello" });
    resetLayout([tab]);
    const live = readTab(tab.id)!;
    let finish!: (value: { mtime: number; mtime_ns: string }) => void;
    const response = new Promise<{ mtime: number; mtime_ns: string }>((resolve) => { finish = resolve; });
    vi.spyOn(api, "write").mockReturnValue(response);
    const save = saveTab(live);
    expect(isClassicSaveRunning(live.id)).toBe(true);
    expect(acquireDocSession(live)).toBeNull();
    expect(sockets).toHaveLength(0);
    finish({ mtime: 2, mtime_ns: "2000000000" });
    await save;
    expect(isClassicSaveRunning(live.id)).toBe(false);
    expect(acquireDocSession(live)).not.toBeNull();
    expect(sockets).toHaveLength(1);
  });

  test("a rename during a classic save cannot acquire the new document path early", async () => {
    const tab = fileTab({ content: "hello!", saved: "hello" });
    resetLayout([tab]);
    const live = readTab(tab.id)!;
    let finish!: (value: { mtime: number; mtime_ns: string }) => void;
    vi.spyOn(api, "write").mockReturnValue(new Promise<{ mtime: number; mtime_ns: string }>((resolve) => { finish = resolve; }));
    const save = saveTab(live);
    rekeyTabsForRename("notes/a.md", "notes/renamed.md");
    expect(live.path).toBe("notes/renamed.md");
    expect(isClassicSaveRunning(live.id)).toBe(true);
    expect(acquireDocSession(live)).toBeNull();
    expect(sockets).toHaveLength(0);
    finish({ mtime: 2, mtime_ns: "2000000000" });
    await save;
    expect(isClassicSaveRunning(live.id)).toBe(false);
    expect(acquireDocSession(live)?.path).toBe("notes/renamed.md");
    expect(sockets).toHaveLength(1);
  });

  test("a closed frame ends the held choice and the next classic refusal opens a classic prompt", async () => {
    const tab = fileTab({ content: "hello!", saved: "hello" });
    resetLayout([tab]);
    const live = readTab(tab.id)!;
    const write = vi.spyOn(api, "write").mockRejectedValue(
      new ApiError(428, "write conflict", { code: "write_conflict", current_mtime_ns: "3000000000" }),
    );
    const { sock, cleanup } = await attached(live, "hello there");
    sock.frame({ type: "closed", reason: "reset" });
    await saveTab(live);
    expect(live.doc?.firstAttachChoice).toBe(false);
    expect(live.content).toBe("hello!");
    expect(live.saved).toBe("hello");
    expect(live.savedMtimeNs).toBe("1000000000");
    expect(write).toHaveBeenCalledTimes(1);
    expect(conflictDialog.kind).toBe("classic");
    expect(conflictDialog.tabId).toBe(live.id);
    cleanup();
  });

  test("a closed held tab can autosave to a classic prompt without a key press", async () => {
    vi.useFakeTimers();
    const tab = fileTab({ content: "hello!", saved: "hello" });
    const pane = resetLayout([tab]);
    const live = readTab(tab.id)!;
    const write = vi.spyOn(api, "write").mockRejectedValue(
      new ApiError(428, "write conflict", { code: "write_conflict", current_mtime_ns: "3000000000" }),
    );
    const { sock, cleanup } = await attached(live, "hello there");
    sock.frame({ type: "closed", reason: "reset" });
    expect(isDocSavePaused(live)).toBe(false);
    scheduleAutosave(pane.id, live.id);
    await vi.advanceTimersByTimeAsync(801);
    expect(write).toHaveBeenCalledTimes(1);
    expect(conflictDialog.kind).toBe("classic");
    expect(conflictDialog.tabId).toBe(live.id);
    expect(live.content).toBe("hello!");
    cleanup();
  });

  test("a peer update before a delayed view bind reopens snapshot judgment", async () => {
    const tab = fileTab({ content: "hello!", saved: "hello" });
    const session = acquireDocSession(tab)!;
    const sock = lastSocket();
    sock.open();
    sock.frame(snap("hello"));
    sock.frame({
      type: "updates",
      version: 0,
      updates: [{ clientID: "peer-1", changes: changesJSON(5, 0, 0, "X") }],
    });
    expect(tab.doc?.firstAttachChoice).toBe(true);
    expect(tab.content).toBe("hello!");
    expect(tab.saved).toBe("hello");
    const { view, cleanup } = mountEditor(tab, session);
    await flushMicro();
    expect(sock.frames("push")).toHaveLength(0);
    expect(tab.doc?.firstAttachChoice).toBe(true);
    expect(view.state.doc.toString()).toBe("hello!");
    expect(tab.content).toBe("hello!");
    expect(tab.saved).toBe("hello");
    cleanup();
  });

  test("a throwing editor commit cannot send a first-snapshot push", async () => {
    const tab = fileTab({ content: "hello!", saved: "hello" });
    const unregister = registerPendingEditFlush(tab.id, () => {
      throw new Error("editor commit failed");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const session = acquireDocSession(tab)!;
    const { cleanup } = mountEditor(tab, session);
    const sock = lastSocket();
    sock.open();
    sock.frame(snap("hello"));
    await flushMicro();
    expect(sock.frames("push")).toHaveLength(0);
    expect(tab.doc?.firstAttachChoice).toBe(true);
    expect(warn).toHaveBeenCalled();
    unregister();
    cleanup();
  });

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

describe("unanswered earlier push", () => {
  async function retryAfterUnansweredPush(authority: string): Promise<{
    tab: FileTab;
    sock: FakeSocket;
    cleanup(): void;
  }> {
    const tab = fileTab();
    const old = await attached(tab, "hello");
    type(old.view, "!");
    await flushMicro();
    expect(old.sock.frames("push")).toHaveLength(1);
    releaseDocSession(tab.id, { immediate: true });
    old.cleanup();
    expect(tab.unresolvedLivePush).toBe(true);
    const session = acquireDocSession(tab)!;
    const mounted = mountEditor(tab, session);
    const sock = lastSocket();
    sock.open();
    sock.frame(snap(authority, authority === "hello" ? 0 : 1));
    await flushMicro();
    return { tab, sock, cleanup: mounted.cleanup };
  }

  test("a snapshot containing our push attaches without another push", async () => {
    const { tab, sock, cleanup } = await retryAfterUnansweredPush("hello!");
    expect(tab.doc?.firstAttachChoice).toBe(false);
    expect(tab.unresolvedLivePush).toBe(false);
    expect(tab.saved).toBe("hello!");
    expect(sock.frames("push")).toHaveLength(0);
    cleanup();
  });

  test("a snapshot at the old base retries the still-local edit once", async () => {
    const { tab, sock, cleanup } = await retryAfterUnansweredPush("hello");
    expect(tab.doc?.firstAttachChoice).toBe(false);
    expect(tab.unresolvedLivePush).toBe(false);
    expect(sock.frames("push")).toHaveLength(1);
    expect(authorityAfterPushes(sock, "hello")).toBe("hello!");
    cleanup();
  });

  test("a third version asks rather than treating the old push as authority", async () => {
    const { tab, sock, cleanup } = await retryAfterUnansweredPush("hello there");
    expect(tab.doc?.firstAttachChoice).toBe(true);
    expect(tab.unresolvedLivePush).toBe(false);
    expect(tab.content).toBe("hello!");
    expect(sock.frames("push")).toHaveLength(0);
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
  test("a fresh redial with an attached editor bounds its next snapshot", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tab = fileTab();
    const { sock, cleanup } = await attached(tab, "hello");
    sock.frame({
      type: "updates",
      version: 7,
      updates: [{ clientID: "peer-1", changes: changesJSON(5, 5, 5, "!") }],
    });
    await flushMicro();
    const redial = lastSocket();
    expect(redial.url).not.toContain("version=");
    redial.open();
    expect(tab.doc?.state).toBe("attached");
    hello(redial);
    await vi.advanceTimersByTimeAsync(DOC_SNAPSHOT_TIMEOUT_MS);
    const snapshotWarnings = warn.mock.calls.filter(([message]) => message === "[chan] doc session: no snapshot after the hello, degrading");
    expect({ state: tab.doc?.state, closed: redial.closedByClient, dials: sockets.length, warned: snapshotWarnings }).toEqual({
      state: "degraded",
      closed: false,
      dials: 2,
      warned: [["[chan] doc session: no snapshot after the hello, degrading", "notes/a.md"]],
    });
    cleanup();
  });

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

// ---- the server's first frame ------------------------------------------------

// Guards, on fake time alone: the session has no arm for the hello, and each
// case holds what being a socket's first frame does and does not do.
describe("the server's hello, the first frame of a document socket", () => {
  /// A first dial whose socket has opened and heard the hello.
  function greeted(): { tab: FileTab; sock: FakeSocket } {
    vi.useFakeTimers();
    const tab = fileTab();
    expect(acquireDocSession(tab)).not.toBeNull();
    const sock = lastSocket();
    sock.open();
    hello(sock);
    return { tab, sock };
  }

  function silence(): { warn: ReturnType<typeof vi.spyOn>; error: ReturnType<typeof vi.spyOn> } {
    return {
      warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
      error: vi.spyOn(console, "error").mockImplementation(() => {}),
    };
  }

  test("a silent attach degrades at the snapshot bound and a late snapshot attaches", async () => {
    const { warn } = silence();
    const { tab, sock } = greeted();
    await vi.advanceTimersByTimeAsync(DOC_SNAPSHOT_TIMEOUT_MS - 1);
    expect({ state: tab.doc?.state, paused: isDocSavePaused(tab) }).toEqual({ state: "connecting", paused: true });
    await vi.advanceTimersByTimeAsync(1);
    expect({
      state: tab.doc?.state,
      paused: isDocSavePaused(tab),
      closedByClient: sock.closedByClient,
      dials: sockets.length,
      warned: warn.mock.calls,
    }).toEqual({
      state: "degraded",
      paused: false,
      closedByClient: false,
      dials: 1,
      warned: [["[chan] doc session: no snapshot after the hello, degrading", "notes/a.md"]],
    });
    sock.frame(snap("hello", 4));
    await flushMicro();
    expect({ state: tab.doc?.state, version: tab.authorityVersion, dials: sockets.length }).toEqual({
      state: "attached", version: 4, dials: 1,
    });
  });

  test("a snapshot inside the bound leaves no later timeout", async () => {
    const { warn, error } = silence();
    const { tab, sock } = greeted();
    await vi.advanceTimersByTimeAsync(DOC_SNAPSHOT_TIMEOUT_MS - 1);
    sock.frame(snap("hello", 4));
    await flushMicro();
    await vi.advanceTimersByTimeAsync(DOC_SNAPSHOT_TIMEOUT_MS * 2);
    expect({
      state: tab.doc?.state,
      version: tab.authorityVersion,
      closedByClient: sock.closedByClient,
      dials: sockets.length,
      warned: warn.mock.calls,
      errors: error.mock.calls,
    }).toEqual({ state: "attached", version: 4, closedByClient: false, dials: 1, warned: [], errors: [] });
  });

  test("it ends the attach window: past it the client has neither closed the socket nor redialed", async () => {
    const { sock } = greeted();
    await vi.advanceTimersByTimeAsync(DOC_ATTACH_TIMEOUT_MS * 3);
    expect({ closedByClient: sock.closedByClient, dials: sockets.length }).toEqual({ closedByClient: false, dials: 1 });
  });

  test("it sets the latch: a close after it and before a snapshot turns nothing off, and the session redials", async () => {
    const { tab, sock } = greeted();
    sock.drop();
    expect(tab.doc?.state).toBe("connecting");
    await vi.advanceTimersByTimeAsync(600);
    expect({ state: tab.doc?.state, dials: sockets.length, redial: lastSocket() !== sock }).toEqual({
      state: "connecting",
      dials: 2,
      redial: true,
    });
    // Nothing is latched for the page: another tab still gets a session.
    expect(acquireDocSession(fileTab())).not.toBeNull();
  });

  test("it changes no status and the socket has sent nothing", () => {
    const { tab, sock } = greeted();
    expect({ state: tab.doc?.state, ownsSaves: isDocAttached(tab), sent: sock.sent }).toEqual({
      state: "connecting",
      ownsSaves: true,
      sent: [],
    });
  });

  test("it logs nothing", () => {
    const { warn, error } = silence();
    greeted();
    expect({ warned: warn.mock.calls, errors: error.mock.calls }).toEqual({ warned: [], errors: [] });
  });

  test("a snapshot that comes after the attach window attaches the session, as a first frame does", async () => {
    const { tab, sock } = greeted();
    await vi.advanceTimersByTimeAsync(DOC_ATTACH_TIMEOUT_MS + 1000);
    sock.frame(snap("hello", 4));
    await flushMicro();
    expect({
      state: tab.doc?.state,
      version: tab.authorityVersion ?? null,
      closedByClient: sock.closedByClient,
      dials: sockets.length,
    }).toEqual({ state: "attached", version: 4, closedByClient: false, dials: 1 });
  });

  test("a no-workspace error after it redials and attaches at the next snapshot, as that error alone does", async () => {
    const { warn } = silence();
    const { tab, sock } = greeted();
    sock.frame({ type: "error", message: "workspace resetting", reason: "no-workspace" });
    sock.drop();
    expect(tab.doc?.state).toBe("connecting");
    await vi.advanceTimersByTimeAsync(600);
    expect(sockets.length).toBe(2);
    const retry = lastSocket();
    retry.open();
    hello(retry);
    retry.frame(snap("hello", 0));
    await flushMicro();
    expect({ state: tab.doc?.state, dials: sockets.length, warned: warn.mock.calls }).toEqual({
      state: "attached",
      dials: 2,
      warned: [["[chan] doc session error", "notes/a.md", "no-workspace", "workspace resetting"]],
    });
  });

  test("an attach-failed error after it degrades with no redial and leaves the latch, as that error alone does", async () => {
    const { warn } = silence();
    const { tab, sock } = greeted();
    sock.frame({ type: "error", message: "no such file", reason: "attach-failed" });
    sock.drop();
    expect(tab.doc?.state).toBe("degraded");
    await vi.advanceTimersByTimeAsync(30_000);
    expect({ state: tab.doc?.state, dials: sockets.length, warned: warn.mock.calls }).toEqual({
      state: "degraded",
      dials: 1,
      warned: [["[chan] doc session error", "notes/a.md", "attach-failed", "no such file"]],
    });
    expect(acquireDocSession(fileTab())).not.toBeNull();
  });

  test("on a resumed socket it leaves the session attached, sends nothing more and keeps the socket past the attach window", async () => {
    vi.useFakeTimers();
    const { warn, error } = silence();
    const tab = fileTab();
    const { sock, cleanup } = await attached(tab, "hello", 3);
    // Nothing is unconfirmed, so the redial names the version it holds and
    // the session is attached at the socket's open.
    sock.drop();
    expect(tab.doc?.state).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(600);
    const resumed = lastSocket();
    expect({ redial: resumed !== sock, version: new URL(resumed.url).searchParams.get("version") }).toEqual({
      redial: true,
      version: "3",
    });
    resumed.open();
    expect(tab.doc?.state).toBe("attached");
    const sentAtOpen = [...resumed.sent];

    hello(resumed);
    await flushMicro();
    await vi.advanceTimersByTimeAsync(DOC_SNAPSHOT_TIMEOUT_MS + DOC_ATTACH_TIMEOUT_MS);
    expect({
      state: tab.doc?.state,
      sent: resumed.sent,
      closedByClient: resumed.closedByClient,
      dials: sockets.length,
      warned: warn.mock.calls,
      errors: error.mock.calls,
    }).toEqual({ state: "attached", sent: sentAtOpen, closedByClient: false, dials: 2, warned: [], errors: [] });
    cleanup();
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
  test("a held conflicted snapshot cannot resolve disk with the local buffer absent", async () => {
    const tab = fileTab({ content: "hello!", saved: "hello" });
    resetLayout([tab]);
    const live = readTab(tab.id)!;
    const resolve = vi.spyOn(api, "resolveSessionConflict");
    const session = acquireDocSession(live)!;
    const { cleanup } = mountEditor(live, session);
    const sock = lastSocket();
    sock.open();
    sock.frame({ ...snap("hello there", 0, { dirty: true }), conflicted: true });
    await flushMicro();
    expect(live.doc?.firstAttachChoice).toBe(true);
    expect(live.diskConflicted).toBe(false);
    await overwriteDiskConflict(live.id);
    expect(resolve).not.toHaveBeenCalled();
    expect(live.content).toBe("hello!");
    expect(sock.frames("push")).toHaveLength(0);
    await overwriteConflictedTab();
    expect(sock.frames("push")).toHaveLength(1);
    expect(authorityAfterPushes(sock, "hello there")).toBe("hello!");
    expect(live.diskConflicted).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
    cleanup();
  });
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
