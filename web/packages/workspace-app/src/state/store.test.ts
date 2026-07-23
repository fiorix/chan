// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  __testApplyTreeExpandedReloadSnapshot,
  __testReadLayoutReloadSnapshot,
  __testSetBootstrapHydrated,
  __testResetSessionDiscarded,
  __testApplyOverlaysFromHash,
  browserSelection,
  discardWindowSession,
  fileOps,
  graphReloadSignal,
  onWatchEvent,
  openFsGraphForDirectory,
  openFsGraphForFile,
  persistStateToHash,
  persistTreeExpanded,
  resolveSpawnContext,
  revealPathInBrowser,
  scheduleSessionSave,
  scopeFsGraphFromHere,
  searchPanel,
  tree,
  treeExpanded,
  fbTreeInstances,
  ensureFbTreeInstance,
  fbTreeInstance,
  disposeFbTreeInstance,
  fbDirSubscriberCount,
  expandAllFoldersForInstance,
  collapseAllFoldersForInstance,
  isFullyExpandedForInstance,
  revealAndSelect,
} from "./store.svelte";
import {
  activePane,
  layout,
  paneMode,
  removeExplicitlyClosedTerminalTab,
  reproveRestoredPrompt,
  resolvePromptCancelled,
  type BrowserTab,
  type DashboardTab,
  type FileTab,
  type GraphTab,
  type LeafNode,
  type TerminalTab,
} from "./tabs.svelte";
import { richPrompt } from "./richPrompt.svelte";
import {
  surveyFor,
  surveyState,
} from "./survey.svelte";
import type { TreeEntry } from "../api/types";

function setTerminalLayout(tab: Partial<TerminalTab> = {}): void {
  const terminal: TerminalTab = {
    kind: "terminal",
    id: "term-1",
    title: "Terminal",
    createdAt: 1,
    broadcastEnabled: false,
    broadcastTargetIds: [],
    ...tab,
  };
  const pane: LeafNode = {
    kind: "leaf",
    id: "pane-test",
    tabs: [terminal],
    activeTabId: terminal.id,
  };
  layout.rootId = pane.id;
  layout.activePaneId = pane.id;
  layout.nodes = { [pane.id]: pane };
}

/// Add a durable (non-terminal) tab to the active pane so the window persists
/// even when its terminal carries no reattachable session. A terminal-only
/// window persists only when its terminal has a live tsid to reattach; a
/// tsid-less terminal-only window serializes to null (deleted, not saved), so
/// tests that expect a PUT without a tsid need this.
function addDashboardTab(id = "dash-1"): void {
  const dashboard: DashboardTab = { kind: "dashboard", id, title: "Dashboard" };
  activePane().tabs.push(dashboard);
}

afterEach(() => {
  __testSetBootstrapHydrated(true);
  __testResetSessionDiscarded();
  const pane: LeafNode = {
    kind: "leaf",
    id: "pane-reset",
    tabs: [],
    activeTabId: null,
  };
  layout.rootId = pane.id;
  layout.activePaneId = pane.id;
  layout.nodes = { [pane.id]: pane };
  searchPanel.open = false;
  searchPanel.inspectorOpen = false;
  searchPanel.query = "";
  graphReloadSignal.nonce = 0;
  browserSelection.path = null;
  browserSelection.showWorkspace = false;
  tree.loadedDirs = {};
  tree.loadingDirs = {};
  tree.dirErrors = {};
  treeExpanded.map = { "": true };
  fbTreeInstances.byId = {};
  richPrompt.byTab = {};
  surveyState.byTab = {};
  surveyState.windowWide = null;
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("session persistence bootstrap guard", () => {
  test("does not save a tsid-less layout while bootstrap hydration is pending", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        status: 204,
      }),
    );
    setTerminalLayout({ terminalSessionId: undefined });
    // Pair the terminal with a durable tab so the window persists (a
    // terminal-only window is ephemeral and would DELETE rather than PUT).
    addDashboardTab();

    __testSetBootstrapHydrated(false);
    scheduleSessionSave();
    await vi.runAllTimersAsync();
    expect(fetchSpy).not.toHaveBeenCalled();

    activeTerminal().terminalSessionId = "term_after_hydrate";
    __testSetBootstrapHydrated(true);
    scheduleSessionSave();
    await vi.runAllTimersAsync();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0]!;
    expect(init?.method).toBe("PUT");
    expect(String(init?.body)).toContain("term_after_hydrate");

    fetchSpy.mockRestore();
    vi.useRealTimers();
  });

  test("deletes the session blob when the window empties out instead of saving null", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    __testSetBootstrapHydrated(true);

    // 1) Window has durable content (a dashboard tab) plus a toggled folder:
    //    persists a layout payload via PUT.
    setTerminalLayout({ terminalSessionId: "term_alive" });
    addDashboardTab();
    treeExpanded.map = { "": true, docs: true };
    scheduleSessionSave();
    await vi.runAllTimersAsync();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]![1]?.method).toBe("PUT");

    // 2) User closes all tabs -- layout serializes to null. Even though a
    //    folder is still expanded, the now-empty window must DELETE its
    //    blob (not write a treeExpanded-only / null payload) so it stops
    //    appearing as a saved window.
    const empty: LeafNode = { kind: "leaf", id: "p-empty", tabs: [], activeTabId: null };
    layout.rootId = empty.id;
    layout.activePaneId = empty.id;
    layout.nodes = { [empty.id]: empty };
    scheduleSessionSave();
    await vi.runAllTimersAsync();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [url, init] = fetchSpy.mock.calls[1]!;
    expect(init?.method).toBe("DELETE");
    expect(String(url)).toContain("/api/session");

    fetchSpy.mockRestore();
    vi.useRealTimers();
  });

  test("a terminal-only window persists its blob (live tsid reattaches; tsid-less keeps the structure for fresh shells)", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    __testSetBootstrapHydrated(true);

    // 1) Durable window (a terminal alongside a dashboard) persists via PUT.
    setTerminalLayout({ terminalSessionId: "term_live" });
    addDashboardTab();
    treeExpanded.map = { "": true, docs: true };
    scheduleSessionSave();
    await vi.runAllTimersAsync();
    expect(fetchSpy.mock.calls.at(-1)?.[1]?.method).toBe("PUT");

    // 2) Remove the durable tab, leaving only the LIVE terminal. Its tsid
    //    reattaches the surviving PTY on a close->reopen, so a terminal-only
    //    window IS durable now: it PUTs the on-disk blob (carrying the tsid)
    //    instead of deleting it. This is the standalone-terminal reconnect fix
    //    -- the old code deleted here, which is why reconnect spawned fresh shells.
    const pane = activePane();
    pane.tabs = pane.tabs.filter((t) => t.kind === "terminal");
    pane.activeTabId = pane.tabs[0]?.id ?? null;
    scheduleSessionSave();
    await vi.runAllTimersAsync();
    {
      const [url, init] = fetchSpy.mock.calls.at(-1)!;
      expect(init?.method).toBe("PUT");
      expect(String(url)).toContain("/api/session");
    }

    // 3) The terminal's session ends (tsid cleared): nothing to reattach, but
    //    the pane STRUCTURE is still worth keeping, so the window PUTs its blob
    //    (without session ids) and restores with a FRESH shell instead of coming
    //    back empty. A truly empty window (no panes/tabs) still deletes -- covered
    //    by the empty-window test above.
    const term = activePane().tabs[0] as TerminalTab;
    term.terminalSessionId = undefined;
    scheduleSessionSave();
    await vi.runAllTimersAsync();
    {
      const [url, init] = fetchSpy.mock.calls.at(-1)!;
      expect(init?.method).toBe("PUT");
      expect(String(url)).toContain("/api/session");
    }

    fetchSpy.mockRestore();
    vi.useRealTimers();
  });

  test("discardWindowSession deletes the blob synchronously and suppresses later saves", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    __testSetBootstrapHydrated(true);

    // A live terminal window that would otherwise persist (PUT + snapshot).
    setTerminalLayout({ terminalSessionId: "term_live" });
    scheduleSessionSave();
    await vi.runAllTimersAsync();
    expect(JSON.stringify(__testReadLayoutReloadSnapshot())).toContain("term_live");
    fetchSpy.mockClear();

    // Discard intent: an immediate keepalive DELETE (the server's reap trigger)
    // and the sessionStorage mirror cleared -- no waiting on the debounce or a
    // `pagehide` a buried window may never fire.
    discardWindowSession();
    const [url, init] = fetchSpy.mock.calls.at(-1)!;
    expect(init?.method).toBe("DELETE");
    expect((init as RequestInit)?.keepalive).toBe(true);
    expect(String(url)).toContain("/api/session");
    expect(__testReadLayoutReloadSnapshot()).toBeNull();

    // A later save is suppressed: the window stays discarded, no PUT resurrects
    // the blob.
    fetchSpy.mockClear();
    scheduleSessionSave();
    await vi.runAllTimersAsync();
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
    vi.useRealTimers();
  });

  test("discardWindowSession({reap:false}) marks the DELETE &moved=1; default reaps", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    __testSetBootstrapHydrated(true);
    setTerminalLayout({ terminalSessionId: "term_live" });

    // Default discard: a plain DELETE -- the server reaps the window's sessions.
    discardWindowSession();
    expect(String(fetchSpy.mock.calls.at(-1)![0])).not.toContain("moved=1");
    expect(fetchSpy.mock.calls.at(-1)![1]?.method).toBe("DELETE");
    __testResetSessionDiscarded();
    fetchSpy.mockClear();

    // Move-out discard: still DELETE the blob, but `&moved=1` tells the server
    // NOT to reap -- the terminal moved to another window and stays live there.
    discardWindowSession({ reap: false });
    const [url, init] = fetchSpy.mock.calls.at(-1)!;
    expect(init?.method).toBe("DELETE");
    expect(String(url)).toContain("/api/session");
    expect(String(url)).toContain("moved=1");

    fetchSpy.mockRestore();
  });
});

describe("all-terminal reload reattach snapshot", () => {
  test("a reattachable-terminal window mirrors to sessionStorage too; a terminal-free durable window clears it", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    __testSetBootstrapHydrated(true);

    // 1) Terminal (live tsid) + dashboard. The on-disk blob is PUT (durable),
    //    AND because a reattachable terminal is present the layout is also
    //    mirrored into sessionStorage (with the tsid) as the race-free same-tab
    //    Cmd+R fast path -- the blob's keepalive PUT can race a fast reload's GET.
    setTerminalLayout({ terminalSessionId: "tsid-keepalive" });
    addDashboardTab();
    scheduleSessionSave();
    await vi.runAllTimersAsync();
    expect(fetchSpy.mock.calls.at(-1)?.[1]?.method).toBe("PUT");
    expect(JSON.stringify(__testReadLayoutReloadSnapshot())).toContain("tsid-keepalive");

    // 2) Remove the durable tab → terminal-only window. Still reattachable, so
    //    it PUTs the on-disk blob (the close->reopen source) and keeps the
    //    sessionStorage mirror.
    const pane = activePane();
    pane.tabs = pane.tabs.filter((t) => t.kind === "terminal");
    pane.activeTabId = pane.tabs[0]?.id ?? null;
    scheduleSessionSave();
    await vi.runAllTimersAsync();
    expect(fetchSpy.mock.calls.at(-1)?.[1]?.method).toBe("PUT");
    expect(JSON.stringify(__testReadLayoutReloadSnapshot())).toContain("tsid-keepalive");

    // 3) Replace with a durable window that has NO terminal (dashboard only).
    //    It reloads from the on-disk blob alone, so the sessionStorage mirror
    //    is cleared -- there is nothing to reattach race-free.
    const dashOnly: LeafNode = {
      kind: "leaf",
      id: "pane-dash-only",
      tabs: [{ kind: "dashboard", id: "dash-only", title: "Dashboard" }],
      activeTabId: "dash-only",
    };
    layout.rootId = dashOnly.id;
    layout.activePaneId = dashOnly.id;
    layout.nodes = { [dashOnly.id]: dashOnly };
    scheduleSessionSave();
    await vi.runAllTimersAsync();
    expect(fetchSpy.mock.calls.at(-1)?.[1]?.method).toBe("PUT");
    expect(__testReadLayoutReloadSnapshot()).toBeNull();

    fetchSpy.mockRestore();
    vi.useRealTimers();
  });

  test("a tsid-less terminal (not yet connected) is NOT snapshotted: no stray PTY on restore", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    __testSetBootstrapHydrated(true);

    // A terminal with NO session id -- it hasn't connected / been assigned a
    // tsid yet. Nothing to reattach, so the reload snapshot must stay empty;
    // otherwise a reload would restore a tsid-less terminal and spawn a stray
    // fresh PTY.
    setTerminalLayout({ terminalSessionId: undefined });
    scheduleSessionSave();
    await vi.runAllTimersAsync();
    expect(__testReadLayoutReloadSnapshot()).toBeNull();

    fetchSpy.mockRestore();
    vi.useRealTimers();
  });
});

describe("rich prompt recall + reload re-prove", () => {
  test("resolvePromptCancelled: removed→recalled, drained, and stale ids no-op", () => {
    setTerminalLayout({ terminalSessionId: "t1" });
    const term = activeTerminal();

    // removed:true → the message was pulled before the PTY → recalled.
    term.pendingPrompt = { id: "m1", phase: "queued", depth: 2 };
    resolvePromptCancelled(term, "m1", true);
    expect(term.pendingPrompt?.phase).toBe("recalled");

    // removed:false → it raced a drain (already delivered) → drained.
    term.pendingPrompt = { id: "m2", phase: "queued" };
    resolvePromptCancelled(term, "m2", false);
    expect(term.pendingPrompt?.phase).toBe("drained");

    // A foreign/stale id never flips a message it doesn't own.
    term.pendingPrompt = { id: "m3", phase: "queued" };
    resolvePromptCancelled(term, "not-mine", true);
    expect(term.pendingPrompt?.phase).toBe("queued");
  });

  test("reproveRestoredPrompt: still-queued keeps + positions; drained clears; non-pending left alone", () => {
    setTerminalLayout({ terminalSessionId: "t1" });
    const term = activeTerminal();

    // Restored id still in the FIFO at index 1 → queued at position 2.
    term.pendingPrompt = { id: "m1", phase: "queued" };
    reproveRestoredPrompt(term, ["m0", "m1", "m2"]);
    expect(term.pendingPrompt?.phase).toBe("queued");
    expect(term.pendingPrompt?.depth).toBe(2);

    // Restored id no longer queued (drained before the reload) → cleared.
    term.pendingPrompt = { id: "gone", phase: "queued" };
    reproveRestoredPrompt(term, ["m0", "m1"]);
    expect(term.pendingPrompt).toBeUndefined();

    // No pending → no-op (and no throw).
    term.pendingPrompt = undefined;
    reproveRestoredPrompt(term, ["m0"]);
    expect(term.pendingPrompt).toBeUndefined();

    // A terminal phase is the bubble's to resolve -- reprove leaves it.
    term.pendingPrompt = { id: "d1", phase: "delivered" };
    reproveRestoredPrompt(term, []);
    expect(term.pendingPrompt?.phase).toBe("delivered");
  });

  test("a queued message is persisted (pp) in the session PUT so it survives reload", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    __testSetBootstrapHydrated(true);

    setTerminalLayout({ terminalSessionId: "t1" });
    addDashboardTab(); // durable, so the window persists (PUT, not DELETE)
    activeTerminal().pendingPrompt = { id: "msg-xyz", phase: "queued", depth: 2 };
    scheduleSessionSave();
    await vi.runAllTimersAsync();

    const [, init] = fetchSpy.mock.calls.at(-1)!;
    expect(init?.method).toBe("PUT");
    const body = String(init?.body);
    expect(body).toContain('"pp"');
    expect(body).toContain("msg-xyz");

    fetchSpy.mockRestore();
    vi.useRealTimers();
  });
});

describe("explicitly-closed terminal tab self-clean", () => {
  test("removes the dead terminal tab and moves the active tab to the survivor", () => {
    setTerminalLayout({ terminalSessionId: "t1" });
    addDashboardTab();
    const pane = activePane();
    const terminalId = pane.tabs[0]!.id;
    pane.activeTabId = terminalId;

    removeExplicitlyClosedTerminalTab(terminalId);

    expect(pane.tabs.map((t) => t.kind)).toEqual(["dashboard"]);
    expect(pane.activeTabId).toBe(pane.tabs[0]!.id);
  });

  test("removing the only terminal empties the pane (the window then self-cleans)", () => {
    setTerminalLayout({ terminalSessionId: "t1" });
    const pane = activePane();
    const terminalId = pane.tabs[0]!.id;

    removeExplicitlyClosedTerminalTab(terminalId);

    // Empty terminal-only window: serializeSession returns null for this
    // layout (see the ephemeral test above), so the debounced save deletes
    // the blob.
    expect(pane.tabs).toEqual([]);
    expect(pane.activeTabId).toBeNull();
  });

  test("is a no-op for an unknown tab id", () => {
    setTerminalLayout({ terminalSessionId: "t1" });
    const pane = activePane();
    const before = pane.tabs.length;
    removeExplicitlyClosedTerminalTab("no-such-tab");
    expect(pane.tabs.length).toBe(before);
  });
});

describe("file browser expansion reload persistence", () => {
  test("mirrors expanded directories into sessionStorage for same-screen reload", () => {
    vi.useFakeTimers();
    window.history.replaceState(null, "", "/");
    treeExpanded.map = {
      "": true,
      docs: true,
      "docs/api": true,
      collapsed: false,
    };

    persistTreeExpanded();
    treeExpanded.map = { "": true };

    expect(__testApplyTreeExpandedReloadSnapshot()).toBe(true);
    expect(treeExpanded.map).toEqual({
      "": true,
      docs: true,
      "docs/api": true,
    });

    vi.clearAllTimers();
    vi.useRealTimers();
  });

  test("reload restore mutates the existing expansion map in place", () => {
    window.history.replaceState(null, "", "/");
    treeExpanded.map = { "": true, docs: true };
    persistTreeExpanded();

    const captured = treeExpanded.map;
    delete captured.docs;
    captured[""] = true;

    expect(__testApplyTreeExpandedReloadSnapshot()).toBe(true);
    expect(treeExpanded.map).toBe(captured);
    expect(captured[""]).toBe(true);
    expect(captured.docs).toBe(true);
  });
});

function activeTerminal(): TerminalTab {
  const node = layout.nodes[layout.activePaneId];
  if (!node || node.kind !== "leaf") throw new Error("expected active leaf");
  const tab = node.tabs[0];
  if (!tab || tab.kind !== "terminal") throw new Error("expected terminal tab");
  return tab;
}

describe("graph watcher reload signal", () => {
  test("increments only while a graph tab is open", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = url.includes("/api/graph")
        ? { nodes: [], edges: [] }
        : url.includes("/api/workspace")
          ? { name: "test", root: "/tmp/test", preferences: {} }
          : [];
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    // No graph tab open: the watcher signal stays put. The reload
    // gate is `hasGraphTab()`, not a graphOverlay flag.
    const empty: LeafNode = { kind: "leaf", id: "p", tabs: [], activeTabId: null };
    layout.rootId = "p";
    layout.activePaneId = "p";
    layout.nodes = { p: empty };
    onWatchEvent({ kind: "modified", event: { path: "notes/a.md" } });
    await Promise.resolve();
    expect(graphReloadSignal.nonce).toBe(0);

    // Open a graph tab: now watcher events bump the reload signal.
    openFsGraphForDirectory("");
    onWatchEvent({ kind: "modified", event: { path: "notes/a.md" } });
    await Promise.resolve();
    expect(graphReloadSignal.nonce).toBe(1);

    vi.clearAllTimers();
    fetchSpy.mockRestore();
    vi.useRealTimers();
  });
});

describe("window commands", () => {
  test("open_browser enter expands the target directory", () => {
    window.history.replaceState(null, "", "/?w=window-a");
    tree.loadedDirs = { "notes/sub": true };

    onWatchEvent({
      type: "window_command",
      window_id: "window-a",
      command: "open_browser",
      path: "notes/sub",
      enter: true,
    });

    expect(browserSelection.path).toBe("notes/sub");
    expect(activePane().tabs.some((tab) => tab.kind === "browser")).toBe(true);
    expect(treeExpanded.map[""]).toBe(true);
    expect(treeExpanded.map["notes"]).toBe(true);
    expect(treeExpanded.map["notes/sub"]).toBe(true);
  });

  test("open_browser select keeps file selection behavior", () => {
    window.history.replaceState(null, "", "/?w=window-a");

    onWatchEvent({
      type: "window_command",
      window_id: "window-a",
      command: "open_browser",
      path: "notes",
      select: "notes/photo.png",
    });

    expect(browserSelection.path).toBe("notes/photo.png");
    expect(activePane().tabs.some((tab) => tab.kind === "browser")).toBe(true);
    expect(treeExpanded.map[""]).toBe(true);
    expect(treeExpanded.map["notes"]).toBe(true);
  });

  test("open_graph_link opens a graph tab through the existing link parser", () => {
    window.history.replaceState(null, "", "/?w=window-a");
    const link =
      "chan://graph?s=dir%3Acrates%2Fchan-tunnel-proto%2Fsrc&m=s&f=2ltmaifds&n=crates%2Fchan-tunnel-proto%2Fsrc%2Fh2_duplex.rs";

    onWatchEvent({
      type: "window_command",
      window_id: "window-a",
      command: "open_graph_link",
      link,
    });

    const tab = activePane().tabs.at(-1);
    expect(tab?.kind).toBe("graph");
    const graph = tab as GraphTab;
    expect(graph.mode).toBe("semantic");
    expect(graph.scopeId).toBe("dir:crates/chan-tunnel-proto/src");
    expect(graph.pendingSelectId).toBe("crates/chan-tunnel-proto/src/h2_duplex.rs");
  });

  test("revealPathInBrowser always OPENS a File Browser tab (never focuses the dock / an existing tab)", () => {
    // With a docked File Browser, reveal-in-browser must never focus
    // the dock (or silently reuse another pane's browser tab) - it
    // always OPENS a File Browser tab in the active pane. Reusing an
    // existing tab was the root cause where a reveal from a graph tab
    // produced no visible tab.
    const leftBrowser: BrowserTab = {
      kind: "browser",
      id: "browser-left",
      title: "Files",
      inspectorOpen: false,
    };
    const left: LeafNode = {
      kind: "leaf",
      id: "pane-left",
      tabs: [leftBrowser],
      activeTabId: leftBrowser.id,
    };
    const rightTerminal: TerminalTab = {
      kind: "terminal",
      id: "term-right",
      title: "Terminal",
      createdAt: 1,
      broadcastEnabled: false,
      broadcastTargetIds: [],
    };
    const right: LeafNode = {
      kind: "leaf",
      id: "pane-right",
      tabs: [rightTerminal],
      activeTabId: rightTerminal.id,
    };
    layout.rootId = "root";
    layout.activePaneId = right.id;
    layout.nodes = {
      root: { kind: "split", id: "root", direction: "row", a: left.id, b: right.id, ratio: 0.5 },
      [left.id]: left,
      [right.id]: right,
    };
    // openBrowserInActivePane resolves the active pane via activeLayout();
    // ensure pane-mode isn't active so it reads this layout, not a draft.
    paneMode.active = false;

    const tab = revealPathInBrowser("notes/today.md", { inspectorOpen: true });

    // A NEW browser tab opens in the ACTIVE pane (right); the existing
    // leftBrowser is left untouched (not reused/focused). Read panes back
    // from `layout.nodes` (the $state proxy) - assigning `layout.nodes`
    // deep-proxies the panes, so the push lands on the proxy, not the raw
    // local consts.
    const leftAfter = layout.nodes[left.id] as LeafNode;
    const rightAfter = layout.nodes[right.id] as LeafNode;
    expect(tab.kind).toBe("browser");
    expect(tab.id).not.toBe(leftBrowser.id);
    expect(layout.activePaneId).toBe(right.id);
    expect(leftAfter.tabs).toHaveLength(1);
    expect(rightAfter.tabs).toHaveLength(2);
    expect(rightAfter.activeTabId).toBe(tab.id);
    expect(tab.selected).toBe("notes/today.md");
    expect(tab.expanded).toEqual(["notes"]);
    expect(tab.inspectorOpen).toBe(true);
    expect(browserSelection.path).toBe("notes/today.md");
  });

  test("download routes to fileOps.downloadPathWithProgress with the server-resolved is_dir", () => {
    window.history.replaceState(null, "", "/?w=window-a");
    const spy = vi
      .spyOn(fileOps, "downloadPathWithProgress")
      .mockImplementation(() => {});

    onWatchEvent({
      type: "window_command",
      window_id: "window-a",
      command: "download",
      path: "notes/a.md",
      is_dir: false,
    });
    expect(spy).toHaveBeenCalledWith("notes/a.md", false);

    // The workspace root downloads as a dir (zip), mirroring the root pill.
    onWatchEvent({
      type: "window_command",
      window_id: "window-a",
      command: "download",
      path: "",
      is_dir: true,
    });
    expect(spy).toHaveBeenCalledWith("", true);
    spy.mockRestore();
  });

  test("upload raises a file picker (the Inspector input's twin), no upload until files are picked", () => {
    window.history.replaceState(null, "", "/?w=window-a");
    const clickSpy = vi
      .spyOn(HTMLInputElement.prototype, "click")
      .mockImplementation(() => {});
    const uploadSpy = vi
      .spyOn(fileOps, "uploadFilesTo")
      .mockImplementation(async () => {});

    onWatchEvent({
      type: "window_command",
      window_id: "window-a",
      command: "upload",
      path: "notes",
    });

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(uploadSpy).not.toHaveBeenCalled();
    clickSpy.mockRestore();
    uploadSpy.mockRestore();
  });

  test("upload (desktop) opens the native picker and uploads the picked bytes", async () => {
    window.history.replaceState(null, "", "/?w=window-a");
    // Stub the Tauri global so isTauriDesktop() is true and pick_upload_files
    // returns one file; raiseUploadPicker must take the native-picker branch
    // (a programmatic <input> click is the no-op WKWebView bug we're fixing).
    const tauriWindow = window as unknown as {
      __TAURI__?: { core: { invoke: (cmd: string) => Promise<unknown> } };
    };
    tauriWindow.__TAURI__ = {
      core: {
        invoke: async (cmd: string) =>
          cmd === "pick_upload_files" ? [{ name: "a.md", bytes: [104, 105] }] : undefined,
      },
    };
    const clickSpy = vi
      .spyOn(HTMLInputElement.prototype, "click")
      .mockImplementation(() => {});
    const uploadSpy = vi.spyOn(fileOps, "uploadFilesTo").mockImplementation(async () => {});
    try {
      onWatchEvent({
        type: "window_command",
        window_id: "window-a",
        command: "upload",
        path: "notes",
      });
      await vi.waitFor(() => expect(uploadSpy).toHaveBeenCalledTimes(1));
      // Native branch only -- never the gesture-less <input> click.
      expect(clickSpy).not.toHaveBeenCalled();
      const [destDir, dropped] = uploadSpy.mock.calls[0]!;
      expect(destDir).toBe("notes");
      const files = Array.from(dropped as FileList | File[]);
      expect(files).toHaveLength(1);
      expect(files[0]).toBeInstanceOf(File);
      expect(files[0]!.name).toBe("a.md");
      expect(files[0]!.size).toBe(2);
    } finally {
      delete tauriWindow.__TAURI__;
      clickSpy.mockRestore();
      uploadSpy.mockRestore();
    }
  });

  test("upload / download for a DIFFERENT window are ignored", () => {
    window.history.replaceState(null, "", "/?w=window-a");
    const dl = vi.spyOn(fileOps, "downloadPathWithProgress").mockImplementation(() => {});
    const clickSpy = vi
      .spyOn(HTMLInputElement.prototype, "click")
      .mockImplementation(() => {});

    onWatchEvent({
      type: "window_command",
      window_id: "window-OTHER",
      command: "download",
      path: "notes/a.md",
      is_dir: false,
    });
    onWatchEvent({
      type: "window_command",
      window_id: "window-OTHER",
      command: "upload",
      path: "notes",
    });
    expect(dl).not.toHaveBeenCalled();
    expect(clickSpy).not.toHaveBeenCalled();
    dl.mockRestore();
    clickSpy.mockRestore();
  });

  test("close_survey for a tab target closes the survey and leaves the composer visible", async () => {
    window.history.replaceState(null, "", "/?w=window-a");
    setTerminalLayout({
      title: "@@Target",
      richPromptDraftPath: ".Drafts/rich-target/draft.md",
    });
    richPrompt.byTab["term-1"] = true;

    onWatchEvent({
      type: "window_command",
      window_id: "window-a",
      command: "open_survey",
      tabName: "@@Target",
      survey: {
        surveyId: "survey-1",
        title: null,
        bodyMarkdown: "Pick one",
        options: ["A"],
      },
    });
    await Promise.resolve();
    expect(surveyFor("term-1")?.surveyId).toBe("survey-1");

    onWatchEvent({
      type: "window_command",
      window_id: "window-a",
      command: "close_survey",
      surveyId: "survey-1",
      reason: "timed_out",
      tabName: "@@Target",
    });
    await Promise.resolve();

    expect(surveyFor("term-1")).toBeNull();
    // The Rich Prompt composer is independent of the survey, so it stays open.
    expect(richPrompt.byTab["term-1"]).toBe(true);
  });

  test("close_survey without tabName closes only the window-wide group survey", async () => {
    window.history.replaceState(null, "", "/?w=window-a");
    setTerminalLayout({ title: "@@Target" });

    onWatchEvent({
      type: "window_command",
      window_id: "window-a",
      command: "open_survey",
      survey: {
        surveyId: "survey-group",
        title: null,
        bodyMarkdown: "Group pick",
        options: ["A"],
      },
    });
    onWatchEvent({
      type: "window_command",
      window_id: "window-a",
      command: "open_survey",
      tabName: "@@Target",
      survey: {
        surveyId: "survey-tab",
        title: null,
        bodyMarkdown: "Tab pick",
        options: ["B"],
      },
    });
    await Promise.resolve();
    expect(surveyFor(null)?.surveyId).toBe("survey-group");
    expect(surveyFor("term-1")?.surveyId).toBe("survey-tab");

    onWatchEvent({
      type: "window_command",
      window_id: "window-a",
      command: "close_survey",
      surveyId: "survey-group",
      reason: "answered_elsewhere",
    });
    await Promise.resolve();

    expect(surveyFor(null)).toBeNull();
    expect(surveyFor("term-1")?.surveyId).toBe("survey-tab");
  });

  test("a group close_survey does NOT force-hide independent composers", async () => {
    window.history.replaceState(null, "", "/?w=window-a");
    setTerminalLayout({
      title: "@@GroupMember",
      richPromptDraftPath: ".Drafts/group-draft/draft.md",
    });
    // An independent Rich Prompt composer is open, unrelated to any survey.
    richPrompt.byTab["term-1"] = true;

    onWatchEvent({
      type: "window_command",
      window_id: "window-a",
      command: "open_survey",
      survey: {
        surveyId: "survey-group",
        title: null,
        bodyMarkdown: "Group pick",
        options: ["A"],
      },
    });
    await Promise.resolve();

    onWatchEvent({
      type: "window_command",
      window_id: "window-a",
      command: "close_survey",
      surveyId: "survey-group",
      reason: "answered_elsewhere",
    });
    await Promise.resolve();

    // The survey overlay closes, but the composer is not the survey's reply
    // surface, so it is left open (no over-reach, no saved-draft dialog).
    expect(surveyFor(null)).toBeNull();
    expect(richPrompt.byTab["term-1"]).toBe(true);
  });
});

describe("legacy overlay hash retirement", () => {
  test("legacy graph= / files= bookmarks are ignored on restore", () => {
    // Graph + browser surfaces are first-class tabs restored via the
    // layout `s` key. Old `graph=` / `files=` bookmarks must degrade
    // gracefully: never reopen the dead overlays, never crash.
    window.history.replaceState(
      null,
      "",
      "/#graph=file:README.md|3|||fs&files=1:notes.md",
    );
    // Must not throw and must not open any graph/browser surface: the
    // legacy keys are no longer in HASH_KEYS, so they're ignored (and
    // the overlay state they used to workspace is gone entirely).
    expect(() => __testApplyOverlaysFromHash()).not.toThrow();
    expect(
      activePane().tabs.some((t) => t.kind === "graph" || t.kind === "browser"),
    ).toBe(false);
  });

  test("persistence strips retired + unknown legacy hash keys, keeps live keys", () => {
    // Unknown keys (`assistant`, `scopes`) and retired overlay keys
    // (`graph`, `files`, `settings`) all fall out of HASH_KEYS so
    // dropUnknownHashKeys strips them. The live `search` key survives.
    const removedOverlayKey = "assist" + "ant";
    window.history.replaceState(
      null,
      "",
      `/#${removedOverlayKey}=open&scopes=2&graph=workspace&files=1:notes.md&settings=1&search=1:hello`,
    );
    searchPanel.open = true;
    searchPanel.query = "hello";
    searchPanel.inspectorOpen = true;

    persistStateToHash();

    expect(window.location.hash).toBe("#search=1%3Ahello");
  });
});

describe("filesystem graph entrypoints", () => {
  function activeGraphTab(): GraphTab {
    const tab = activePane().tabs.find((candidate) => candidate.id === activePane().activeTabId);
    expect(tab?.kind).toBe("graph");
    return tab as GraphTab;
  }

  test("file browser graph entrypoints scope to the file's parent or the directory itself", () => {
    openFsGraphForFile("notes/a.md");

    let graph = activeGraphTab();
    expect(graph.mode).toBe("filesystem");
    // File trigger scopes to the parent directory, with the
    // originating file auto-selected so its inspector pops.
    expect(graph.scopeId).toBe("dir:notes");
    expect(graph.pendingSelectId).toBe("notes/a.md");

    openFsGraphForDirectory("notes");

    graph = activeGraphTab();
    // The directory "Graph from here" opens the RICH semantic
    // graph (all layers, with client-side directory expand/collapse),
    // not the directories-only filesystem mode.
    expect(graph.mode).toBe("semantic");
    // Directory trigger scopes to that subtree directly.
    expect(graph.scopeId).toBe("dir:notes");
    expect(graph.pendingSelectId).toBe("notes");
  });

  test("file at workspace root falls back to workspace scope; workspace root directory likewise", () => {
    openFsGraphForFile("README.md");

    let graph = activeGraphTab();
    expect(graph.mode).toBe("filesystem");
    // No parent directory above a root-level file: workspace scope is
    // the meaningful neighbourhood.
    expect(graph.scopeId).toBe("workspace");
    expect(graph.pendingSelectId).toBe("README.md");

    openFsGraphForDirectory("");

    graph = activeGraphTab();
    // Workspace-root "Graph from here" is the rich semantic
    // graph too (workspace scope, all layers).
    expect(graph.mode).toBe("semantic");
    expect(graph.scopeId).toBe("workspace");
  });

  test("filesystem graph scope action pivots to files and directories", () => {
    scopeFsGraphFromHere("notes", true);

    let graph = activeGraphTab();
    expect(graph.mode).toBe("filesystem");
    expect(graph.scopeId).toBe("dir:notes");
    expect(graph.depth).toBe(1);
    expect(graph.pendingSelectId).toBe("notes");

    scopeFsGraphFromHere("notes/a.md", false);

    graph = activeGraphTab();
    expect(graph.mode).toBe("filesystem");
    expect(graph.scopeId).toBe("file:notes/a.md");
    expect(graph.depth).toBe(1);
    expect(graph.pendingSelectId).toBe("notes/a.md");
  });
});

describe("external-change banner", () => {
  function placeFileTab(path: string, content: string): FileTab {
    const tab: FileTab = {
      kind: "file",
      fileKind: "document",
      id: `file-${path}`,
      path,
      content,
      saved: content,
      savedMtime: 1,
      mode: "wysiwyg",
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
    };
    const pane: LeafNode = {
      kind: "leaf",
      id: "pane-ext",
      tabs: [tab],
      activeTabId: tab.id,
    };
    layout.rootId = pane.id;
    layout.activePaneId = pane.id;
    layout.nodes = { [pane.id]: pane };
    // Return the LIVE (proxied) tab from the layout $state, not the raw
    // literal - flagExternalChange mutates through the proxy.
    return (layout.nodes[pane.id] as LeafNode).tabs[0] as FileTab;
  }

  test("a watch event flags the open tab but never reloads or clears its content", () => {
    // Regression guard: the watcher used to silently reload a clean
    // buffer, which replaced the doc and snapped the caret to line 1
    // mid-edit. The watch path now only raises the dismissable banner
    // (externalChange) and leaves the buffer untouched.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = url.includes("/api/workspace")
        ? { name: "test", root: "/tmp/test", preferences: {} }
        : [];
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const tab = placeFileTab("notes/a.md", "hello, still typing");

    onWatchEvent({ kind: "modified", event: { path: "notes/a.md" } });

    // flagExternalChange runs synchronously in the watch loop.
    expect(tab.externalChange).toBe(true);
    // The buffer is untouched: no silent reload, the caret stays put.
    expect(tab.content).toBe("hello, still typing");

    fetchSpy.mockRestore();
  });
});

describe("resolveSpawnContext", () => {
  function placeTabs(tabs: Array<FileTab | TerminalTab | GraphTab | BrowserTab>): void {
    const pane: LeafNode = {
      kind: "leaf",
      id: "pane-spawn",
      tabs,
      activeTabId: tabs[0]?.id ?? null,
    };
    layout.rootId = pane.id;
    layout.activePaneId = pane.id;
    layout.nodes = { [pane.id]: pane };
  }

  function makeFileTab(path: string): FileTab {
    return {
      kind: "file",
      fileKind: "document",
      id: `file-${path}`,
      path,
      content: "",
      saved: "",
      savedMtime: 1,
      mode: "wysiwyg",
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
    };
  }

  test("empty pane falls back to workspace root", () => {
    placeTabs([]);
    expect(resolveSpawnContext()).toEqual({ dir: "" });
  });

  test("file editor source -> parent dir + file", () => {
    placeTabs([makeFileTab("notes/sub/a.md")]);
    expect(resolveSpawnContext()).toEqual({
      dir: "notes/sub",
      file: "notes/sub/a.md",
    });
  });

  test("root-level file -> workspace root + file", () => {
    placeTabs([makeFileTab("README.md")]);
    expect(resolveSpawnContext()).toEqual({ dir: "", file: "README.md" });
  });

  test("terminal with cwd -> cwd as dir", () => {
    const terminal: TerminalTab = {
      kind: "terminal",
      id: "term-1",
      title: "Terminal",
      createdAt: 1,
      broadcastEnabled: false,
      broadcastTargetIds: [],
      cwd: "notes/sub",
    };
    placeTabs([terminal]);
    expect(resolveSpawnContext()).toEqual({ dir: "notes/sub" });
  });

  test("terminal without cwd -> workspace root", () => {
    const terminal: TerminalTab = {
      kind: "terminal",
      id: "term-1",
      title: "Terminal",
      createdAt: 1,
      broadcastEnabled: false,
      broadcastTargetIds: [],
    };
    placeTabs([terminal]);
    expect(resolveSpawnContext()).toEqual({ dir: "" });
  });

  test("browser selection of a file -> parent + file", () => {
    placeTabs([
      { kind: "browser", id: "br-1", title: "Files", inspectorOpen: false },
    ]);
    tree.entries = [
      { path: "notes/a.md", is_dir: false, mtime: 1, size: 0 } as TreeEntry,
    ];
    browserSelection.path = "notes/a.md";
    expect(resolveSpawnContext()).toEqual({
      dir: "notes",
      file: "notes/a.md",
    });
  });

  test("browser selection of a directory -> dir only", () => {
    placeTabs([
      { kind: "browser", id: "br-1", title: "Files", inspectorOpen: false },
    ]);
    tree.entries = [
      { path: "notes", is_dir: true, mtime: null, size: 0 } as TreeEntry,
    ];
    browserSelection.path = "notes";
    expect(resolveSpawnContext()).toEqual({ dir: "notes" });
  });

  test("browser with no selection -> workspace root", () => {
    placeTabs([
      { kind: "browser", id: "br-1", title: "Files", inspectorOpen: false },
    ]);
    browserSelection.path = null;
    expect(resolveSpawnContext()).toEqual({ dir: "" });
  });

  test("graph file: scope -> parent + file", () => {
    placeTabs([
      {
        kind: "graph",
        id: "g-1",
        title: "File Graph",
        mode: "semantic",
        scopeId: "file:notes/a.md",
        depth: 1,
        expanded: { "": true },
        filters: {
          link: true,
          tag: true,
          mention: true,
          language: true,
          img: true,
          folder: true,
          markdown: true,
          source: true,
        },
        inspectorOpen: false,
        pendingSelectId: null,
      },
    ]);
    expect(resolveSpawnContext()).toEqual({
      dir: "notes",
      file: "notes/a.md",
    });
  });

  test("graph dir: scope -> dir only", () => {
    placeTabs([
      {
        kind: "graph",
        id: "g-1",
        title: "Dir Graph",
        mode: "semantic",
        scopeId: "dir:notes/sub",
        depth: 1,
        expanded: { "": true },
        filters: {
          link: true,
          tag: true,
          mention: true,
          language: true,
          img: true,
          folder: true,
          markdown: true,
          source: true,
        },
        inspectorOpen: false,
        pendingSelectId: null,
      },
    ]);
    expect(resolveSpawnContext()).toEqual({ dir: "notes/sub" });
  });

  test("graph workspace scope -> workspace root", () => {
    placeTabs([
      {
        kind: "graph",
        id: "g-1",
        title: "Graph",
        mode: "semantic",
        scopeId: "workspace",
        depth: 1,
        expanded: { "": true },
        filters: {
          link: true,
          tag: true,
          mention: true,
          language: true,
          img: true,
          folder: true,
          markdown: true,
          source: true,
        },
        inspectorOpen: false,
        pendingSelectId: null,
      },
    ]);
    expect(resolveSpawnContext()).toEqual({ dir: "" });
  });

  test("graph tag: scope -> workspace root (no useful path anchor)", () => {
    placeTabs([
      {
        kind: "graph",
        id: "g-1",
        title: "Tag Graph",
        mode: "semantic",
        scopeId: "tag:foo",
        depth: 1,
        expanded: { "": true },
        filters: {
          link: true,
          tag: true,
          mention: true,
          language: true,
          img: true,
          folder: true,
          markdown: true,
          source: true,
        },
        inspectorOpen: false,
        pendingSelectId: null,
      },
    ]);
    expect(resolveSpawnContext()).toEqual({ dir: "" });
  });
});

// Per-File-Browser-instance tree metadata. The registry is the keyed
// structure that lets two simultaneously-visible instances keep
// independent expand/collapse state. These tests pin the
// create/read/dispose contract and the cross-instance subscription refcount.
describe("per-instance file browser tree registry", () => {
  test("ensureFbTreeInstance creates a root-expanded record, idempotent", () => {
    const a = ensureFbTreeInstance("pane-1");
    expect(a.expanded).toEqual({ "": true });
    expect(a.subscribedDirs).toEqual({ "": true });
    expect(a.selected).toBeNull();

    a.expanded["notes"] = true;
    // Re-ensure returns the SAME record (no clobber on remount).
    const again = ensureFbTreeInstance("pane-1");
    expect(again).toBe(a);
    expect(again.expanded["notes"]).toBe(true);
  });

  test("instances are independent: expanding one does not touch another", () => {
    const a = ensureFbTreeInstance("pane-1");
    const b = ensureFbTreeInstance("pane-2");
    a.expanded["docs"] = true;
    expect(b.expanded["docs"]).toBeUndefined();
    expect(fbTreeInstance("pane-2")?.expanded).toEqual({ "": true });
  });

  test("fbTreeInstance returns null for an unknown id", () => {
    expect(fbTreeInstance("nope")).toBeNull();
  });

  test("disposeFbTreeInstance forgets the record", () => {
    ensureFbTreeInstance("pane-1");
    expect(fbTreeInstance("pane-1")).not.toBeNull();
    disposeFbTreeInstance("pane-1");
    expect(fbTreeInstance("pane-1")).toBeNull();
    // Disposing an unknown id is a safe no-op.
    expect(() => disposeFbTreeInstance("pane-1")).not.toThrow();
  });

  test("fbDirSubscriberCount is the cross-instance refcount", () => {
    const a = ensureFbTreeInstance("pane-1");
    const b = ensureFbTreeInstance("pane-2");
    // Both implicitly subscribe to the root scope.
    expect(fbDirSubscriberCount("")).toBe(2);
    expect(fbDirSubscriberCount("notes")).toBe(0);

    a.subscribedDirs["notes"] = true;
    expect(fbDirSubscriberCount("notes")).toBe(1);
    b.subscribedDirs["notes"] = true;
    expect(fbDirSubscriberCount("notes")).toBe(2);

    // Last instance to drop the dir takes the count back to zero (the
    // transition that maps to an `unsub` frame).
    delete a.subscribedDirs["notes"];
    delete b.subscribedDirs["notes"];
    expect(fbDirSubscriberCount("notes")).toBe(0);

    disposeFbTreeInstance("pane-2");
    expect(fbDirSubscriberCount("")).toBe(1);
  });
});

// FileTree renders + toggles off the per-instance map, so the expand-all /
// collapse-all / full-expansion helpers target one instance. A dock side
// and a tab (two instances) must not toggle each other; a programmatic
// reveal fans out to every live surface.
describe("per-instance expansion helpers", () => {
  function seedTree(): void {
    const dirs = ["docs", "docs/api", "notes"];
    tree.entries = dirs.map(
      (path): TreeEntry => ({
        path,
        is_dir: true,
        size: 0,
        mtime: null,
      }),
    );
  }

  test("expand-all / collapse-all target only the named instance", () => {
    seedTree();
    const dock = ensureFbTreeInstance("fb-dock-left");
    const tab = ensureFbTreeInstance("fb-tab-1");

    expandAllFoldersForInstance("fb-dock-left");
    expect(dock.expanded).toEqual({
      "": true,
      docs: true,
      "docs/api": true,
      notes: true,
    });
    // The sibling instance is untouched: per-instance independence.
    expect(tab.expanded).toEqual({ "": true });
    expect(isFullyExpandedForInstance("fb-dock-left")).toBe(true);
    expect(isFullyExpandedForInstance("fb-tab-1")).toBe(false);

    collapseAllFoldersForInstance("fb-dock-left");
    expect(dock.expanded).toEqual({ "": true });
    expect(isFullyExpandedForInstance("fb-dock-left")).toBe(false);
  });

  test("isFullyExpandedForInstance is false for an unregistered instance", () => {
    seedTree();
    expect(isFullyExpandedForInstance("fb-overlay")).toBe(false);
  });

  test("revealAndSelect fans ancestor expansion across all live instances", () => {
    const dock = ensureFbTreeInstance("fb-dock-left");
    const tab = ensureFbTreeInstance("fb-tab-1");

    revealAndSelect("docs/api/spec.md");

    // Both surfaces reveal the new entry's ancestor chain (not the file),
    // matching the pre-migration "all surfaces share a reveal" behavior.
    expect(dock.expanded).toEqual({ "": true, docs: true, "docs/api": true });
    expect(tab.expanded).toEqual({ "": true, docs: true, "docs/api": true });
    expect(browserSelection.path).toBe("docs/api/spec.md");
  });
});
