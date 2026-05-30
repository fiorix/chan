// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../api/client";
import { confirmState, resolveConfirm } from "./confirm.svelte";
import { pathPromptState, resolvePathPrompt } from "./store.svelte";
import { editorToolsPrefs } from "./editorTools.svelte";
import {
  activePane,
  beginMissingFileReopen,
  broadcastTerminalInput,
  canReopenClosedTab,
  clearTerminalSession,
  clearRecentlyClosedTabsForTest,
  closePane,
  closeTab,
  closeTabsInPane,
  cancelPaneMode,
  commitPaneMode,
  detachTabToPaneEdge,
  dismissTerminalEnvNamePrompt,
  draftCloseState,
  enterPaneMode,
  enterPaneModeTransaction,
  flipHybrid,
  focusColorForWindow,
  browserTabLabel,
  graphTabLabel,
  graphTitle,
  hydrateTerminalSessionsFromLayout,
  isMissingFileError,
  layout,
  openBrowserInActivePane,
  openDashboardInActivePane,
  openGraphInActivePane,
  openInPane,
  openFind,
  openTerminalInPane,
  paneMode,
  paneModeEqualize,
  paneModeMoveFocus,
  paneModeOpenBrowser,
  paneModeOpenGraph,
  paneModeOpenTeamWorkTerminal,
  paneModeOpenTerminal,
  paneModeResize,
  paneModeSetGrab,
  paneModeSetHover,
  paneModeSplit,
  paneModeStageSpawn,
  paneModeSwap,
  paneModeSwapWith,
  removeTerminalFromBroadcastGroup,
  registerDraftPromotionSink,
  registerTerminalCloseSink,
  registerTerminalInputSink,
  resolveDraftClose,
  markLocalTabDrop,
  markTerminalEnvNameRestarted,
  moveTab,
  openActiveTeamWork,
  renameTerminalTab,
  reopenClosedTab,
  reorderTab,
  restoreLayout,
  saveDraftTabToWorkspace,
  saveTab,
  scheduleAutosave,
  serializeLayout,
  setActivePane,
  setTerminalActivity,
  setTerminalActivityPulsing,
  setTerminalBroadcastEnabled,
  setTerminalBroadcastTarget,
  setWindowFocusColor,
  setTerminalSession,
  shouldCloseTabAfterDragEnd,
  createTeamWorkLeadTerminal,
  splitPane,
  tabLabel,
  tabLabelInPane,
  TAB_TITLE_MAX_LENGTH,
  terminalBroadcastMemberIds,
  terminalEnvTabNameStale,
  toggleActiveTerminalBroadcastSelectAll,
  truncateTabTitle,
  type BrowserTab,
  type FileTab,
  type GraphTab,
  type LeafNode,
  type TerminalTab,
} from "./tabs.svelte";

function resetLayout(tabs: Array<FileTab | TerminalTab>): LeafNode {
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

function fileTab(partial: Partial<FileTab> = {}): FileTab {
  return {
    kind: "file",
    fileKind: "document",
    id: "file-1",
    path: "notes/a.md",
    content: "saved",
    saved: "saved",
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
    ...partial,
  };
}

function terminalTab(partial: Partial<TerminalTab> = {}): TerminalTab {
  return {
    kind: "terminal",
    id: "term-1",
    title: "Terminal",
    createdAt: 1,
    broadcastEnabled: false,
    broadcastTargetIds: [],
    ...partial,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  resolveConfirm(false);
  resolveDraftClose("cancel");
  resetLayout([]);
  cancelPaneMode();
  clearRecentlyClosedTabsForTest();
  editorToolsPrefs.stripTrailingWhitespaceOnSave = false;
});

describe("tab close confirmation", () => {
  test("saves a dirty file tab before closing", async () => {
    const tab = fileTab({ content: "unsaved" });
    const pane = resetLayout([tab]);
    const write = vi
      .spyOn(api, "write")
      .mockResolvedValue({ mtime: 2, mtime_ns: "2" });

    await closeTab(pane.id, tab.id);

    expect(write).toHaveBeenCalledWith("notes/a.md", "unsaved", null, 1);
    expect(confirmState.open).toBe(false);
    expect(activePane().tabs).toHaveLength(0);
  });

  test("keeps a dirty file tab open when save fails", async () => {
    const tab = fileTab({ content: "unsaved" });
    const pane = resetLayout([tab]);
    vi.spyOn(api, "write").mockRejectedValue(new Error("disk full"));

    await closeTab(pane.id, tab.id);

    expect(activePane().tabs).toHaveLength(1);
    const live = activePane().tabs[0];
    expect(live?.kind).toBe("file");
    if (live?.kind !== "file") return;
    expect(live.error).toContain("save failed");
  });

  test("prompts for live terminal tabs", async () => {
    const tab = terminalTab();
    const pane = resetLayout([tab]);
    const unregister = registerTerminalInputSink(tab.id, () => {});

    const close = closeTab(pane.id, tab.id);
    expect(confirmState.open).toBe(true);
    expect(confirmState.message).toContain("still running");
    resolveConfirm(false);
    await close;

    unregister();
    expect(activePane().tabs).toHaveLength(1);
  });

  test("keeps a terminal open when its close sink returns false", async () => {
    const tab = terminalTab();
    const pane = resetLayout([tab]);
    const closeSink = vi.fn().mockResolvedValue(false);
    const unregister = registerTerminalCloseSink(tab.id, closeSink);

    await closeTab(pane.id, tab.id, { force: true });

    unregister();
    expect(closeSink).toHaveBeenCalledTimes(1);
    expect(activePane().tabs).toHaveLength(1);
  });

  test("draft tab close prompts for discard or save", async () => {
    const tab = fileTab({
      id: "draft-tab",
      path: "Drafts/untitled-1/draft.md",
    });
    const pane = resetLayout([tab]);
    vi.spyOn(api, "inspectDraft").mockResolvedValue({
      path: "Drafts/untitled-1/draft.md",
      name: "untitled-1",
      file_count: 1,
      dir_count: 0,
      total_size: 7,
      has_attachments: false,
    });
    const discard = vi.spyOn(api, "discardDraft").mockResolvedValue(undefined);

    const close = closeTab(pane.id, tab.id);
    await vi.waitFor(() => expect(draftCloseState.open).toBe(true));
    expect(draftCloseState.target).toBe("untitled-1.md");
    resolveDraftClose("discard");
    await close;

    expect(discard).toHaveBeenCalledWith("Drafts/untitled-1/draft.md");
    expect(activePane().tabs).toHaveLength(0);
  });

  test("saving a draft notifies promotion sinks with the workspace path", async () => {
    const tab = fileTab({
      id: "draft-tab",
      path: "Drafts/untitled-1/draft.md",
      content: "# draft\n",
      saved: "# draft\n",
      savedMtime: 1,
    });
    const pane = resetLayout([tab]);
    vi.spyOn(api, "inspectDraft").mockResolvedValue({
      path: "Drafts/untitled-1/draft.md",
      name: "untitled-1",
      file_count: 1,
      dir_count: 0,
      total_size: 8,
      has_attachments: false,
    });
    const promote = vi.spyOn(api, "promoteDraft").mockResolvedValue({
      path: "untitled-1.md",
      name: "untitled-1",
      mode: "file",
    });
    const promotedPaths: string[] = [];
    const unregister = registerDraftPromotionSink((path) => {
      promotedPaths.push(path);
    });

    try {
      const close = closeTab(pane.id, tab.id);
      await vi.waitFor(() => expect(draftCloseState.open).toBe(true));
      resolveDraftClose("save");
      await close;
    } finally {
      unregister();
    }

    expect(promote).toHaveBeenCalledWith(
      "Drafts/untitled-1/draft.md",
      "untitled-1.md",
    );
    expect(promotedPaths).toEqual(["untitled-1.md"]);
    expect(activePane().tabs).toHaveLength(0);
  });

  test("explicit draft save promotes and keeps the tab open on the workspace file", async () => {
    const tab = fileTab({
      id: "draft-tab",
      path: "Drafts/untitled-1/draft.md",
      content: "# draft\n",
      saved: "# draft\n",
      savedMtime: 1,
    });
    resetLayout([tab]);
    vi.spyOn(api, "inspectDraft").mockResolvedValue({
      path: "Drafts/untitled-1/draft.md",
      name: "untitled-1",
      file_count: 1,
      dir_count: 0,
      total_size: 8,
      has_attachments: false,
    });
    const promote = vi.spyOn(api, "promoteDraft").mockResolvedValue({
      path: "notes/final.md",
      name: "final",
      mode: "file",
    });
    vi.spyOn(api, "readStream").mockResolvedValue({
      path: "notes/final.md",
      content: "# promoted\n",
      mtime: 3,
      mtime_ns: "3",
      writable: true,
    });

    // A lone draft.md routes through the PathPromptModal in file mode
    // (kind "file"), defaulting to `<name>.md`.
    const save = saveDraftTabToWorkspace(tab);
    await vi.waitFor(() => expect(pathPromptState.open).toBe(true));
    expect(pathPromptState.kind).toBe("file");
    expect(pathPromptState.defaultValue).toBe("untitled-1.md");
    expect(pathPromptState.notice).toBeNull();
    resolvePathPrompt("untitled-1.md");
    await save;

    expect(promote).toHaveBeenCalledWith(
      "Drafts/untitled-1/draft.md",
      "untitled-1.md",
    );
    expect(activePane().tabs).toHaveLength(1);
    const live = activePane().tabs[0];
    if (live?.kind !== "file") throw new Error("expected file tab");
    expect(live.path).toBe("notes/final.md");
    expect(live.content).toBe("# promoted\n");
    expect(live.saved).toBe("# promoted\n");
  });

  test("explicit draft workspace save uses the dir-only prompt + notice", async () => {
    const tab = fileTab({
      id: "draft-tab",
      path: "Drafts/untitled-1/draft.md",
      content: "# draft\n",
      saved: "# draft\n",
      savedMtime: 1,
    });
    resetLayout([tab]);
    vi.spyOn(api, "inspectDraft").mockResolvedValue({
      path: "Drafts/untitled-1/draft.md",
      name: "untitled-1",
      file_count: 2,
      dir_count: 0,
      total_size: 12,
      has_attachments: true,
    });
    const promote = vi.spyOn(api, "promoteDraft").mockResolvedValue({
      path: "notes/final",
      name: "final",
      mode: "directory_created",
    });
    const read = vi.spyOn(api, "readStream").mockResolvedValue({
      path: "notes/final/draft.md",
      content: "# promoted\n",
      mtime: 3,
      mtime_ns: "3",
      writable: true,
    });

    // A draft with attachments routes through PathPromptModal's
    // Dir-only (folder) mode, defaulting to `<name>/`, and carries the
    // notice telling the user the whole directory is saved as a dir.
    const save = saveDraftTabToWorkspace(tab);
    await vi.waitFor(() => expect(pathPromptState.open).toBe(true));
    expect(pathPromptState.kind).toBe("folder");
    expect(pathPromptState.defaultValue).toBe("untitled-1/");
    expect(pathPromptState.notice).toContain("whole draft directory");
    resolvePathPrompt("notes/final/");
    await save;

    expect(promote).toHaveBeenCalledWith(
      "Drafts/untitled-1/draft.md",
      "notes/final/",
    );
    expect(read.mock.calls[0][0]).toBe("notes/final/draft.md");
    const live = activePane().tabs[0];
    if (live?.kind !== "file") throw new Error("expected file tab");
    expect(live.path).toBe("notes/final/draft.md");
  });

  test("whitespace-only draft closes as empty without save prompt", async () => {
    const tab = fileTab({
      id: "draft-tab",
      path: "Drafts/untitled-empty/draft.md",
      content: " \n\n\t",
      saved: "",
      savedMtime: null,
    });
    const pane = resetLayout([tab]);
    const write = vi.spyOn(api, "write").mockResolvedValue({
      mtime: 2,
      mtime_ns: "2",
    });
    vi.spyOn(api, "inspectDraft").mockResolvedValue({
      path: "Drafts/untitled-empty/draft.md",
      name: "untitled-empty",
      file_count: 1,
      dir_count: 0,
      total_size: 4,
      has_attachments: false,
    });
    const discard = vi.spyOn(api, "discardDraft").mockResolvedValue(undefined);

    await closeTab(pane.id, tab.id);

    expect(write).not.toHaveBeenCalled();
    expect(draftCloseState.open).toBe(false);
    expect(discard).toHaveBeenCalledWith("Drafts/untitled-empty/draft.md");
    expect(activePane().tabs).toHaveLength(0);
  });

  test("reopens a closed dirty file tab with its in-memory buffer", async () => {
    const tab = fileTab({ content: "unsaved", saved: "saved", caret: { from: 3, to: 3 } });
    const pane = resetLayout([tab]);

    await closeTab(pane.id, tab.id, { force: true });
    expect(activePane().tabs).toHaveLength(0);
    expect(canReopenClosedTab()).toBe(true);

    expect(reopenClosedTab()).toBe(true);
    expect(activePane().tabs).toHaveLength(1);
    const reopened = activePane().tabs[0];
    expect(reopened?.kind).toBe("file");
    if (reopened?.kind !== "file") return;
    expect(reopened.content).toBe("unsaved");
    expect(reopened.saved).toBe("saved");
    expect(reopened.caret).toEqual({ from: 3, to: 3 });
    expect(activePane().activeTabId).toBe(reopened.id);
  });

  test("closing the last front tab clears the flip", async () => {
    // The flip is strictly tied to panes with >= 1 tab: a 0-tab pane
    // is never flipped. Closing the last front tab while flipped drops
    // the flip and lands the pane on its empty front (welcome), instead
    // of a stuck back-config surface the flip chord can't undo
    // (flipHybrid's empty-pane guard would block re-flipping it).
    const front = fileTab({ id: "front", path: "notes/front.md" });
    const seed = resetLayout([front]);
    flipHybrid(seed.id);
    let live = layout.nodes[seed.id];
    if (live?.kind !== "leaf") throw new Error("expected leaf");
    expect(live.showingBack).toBe(true);

    await closeTab(seed.id, "front", { force: true });

    live = layout.nodes[seed.id];
    if (live?.kind !== "leaf") throw new Error("expected leaf");
    expect(live.showingBack).toBe(false);
    expect(live.tabs).toHaveLength(0);
    expect(live.activeTabId).toBeNull();
  });

  test("closing the last tab in a Hybrid pane leaves the pane in place", async () => {
    // Closing the last tab in a non-root pane should leave the pane
    // standing with the empty-pane landing instead of auto-collapsing
    // the Hybrid structure into the sibling.
    const left = fileTab({ id: "left", path: "notes/left.md" });
    const right = fileTab({ id: "right", path: "notes/right.md" });
    const leftPane = resetLayout([left]);
    splitPane(leftPane.id, "row", "after");
    const rootBefore = layout.nodes[layout.rootId];
    expect(rootBefore?.kind).toBe("split");
    if (rootBefore?.kind !== "split") return;
    const rightPaneId = rootBefore.b;
    const rightPane = layout.nodes[rightPaneId];
    expect(rightPane?.kind).toBe("leaf");
    if (rightPane?.kind !== "leaf") return;
    rightPane.tabs.push(right);
    rightPane.activeTabId = right.id;

    await closeTab(rightPaneId, right.id, { force: true });

    // Hybrid structure survives: still a split with two leaves.
    const root = layout.nodes[layout.rootId];
    expect(root?.kind).toBe("split");
    if (root?.kind !== "split") return;
    const survivor = layout.nodes[rightPaneId];
    expect(survivor?.kind).toBe("leaf");
    if (survivor?.kind !== "leaf") return;
    expect(survivor.tabs).toHaveLength(0);
    expect(survivor.activeTabId).toBeNull();
  });
});

describe("tab drag and drop", () => {
  test("same-pane drag onto adjacent inactive tab reorders without closing source", () => {
    const active = fileTab({ id: "file-active", path: "notes/active.md" });
    const inactive = fileTab({ id: "file-inactive", path: "notes/inactive.md" });
    const pane = resetLayout([active, inactive]);
    pane.activeTabId = active.id;

    markLocalTabDrop(pane.id, active.id);
    reorderTab(pane.id, active.id, 1);

    expect(activePane().tabs.map((tab) => tab.id)).toEqual([inactive.id, active.id]);
    expect(activePane().activeTabId).toBe(active.id);
    expect(shouldCloseTabAfterDragEnd(pane.id, active.id, "move")).toBe(false);
    expect(activePane().tabs.map((tab) => tab.id)).toEqual([inactive.id, active.id]);
  });
});

describe("pane state", () => {
  test("serializes window focus color with layout state", async () => {
    resetLayout([terminalTab()]);
    setWindowFocusColor("pink");

    const snapshot = serializeLayout();
    expect(JSON.stringify(snapshot)).toContain("\"wc\":\"p\"");

    await restoreLayout(snapshot!);

    expect(focusColorForWindow()).toBe("pink");

    setWindowFocusColor("orange");
    const orangeSnapshot = serializeLayout();
    expect(JSON.stringify(orangeSnapshot)).toContain("\"wc\":\"o\"");

    await restoreLayout(orangeSnapshot!);

    expect(focusColorForWindow()).toBe("orange");
  });

  test("drops legacy per-pane focus color on restore", async () => {
    resetLayout([terminalTab()]);

    await restoreLayout({ k: "l", t: [{ k: "t", n: "Terminal", a: 1 }], pc: "p" });

    expect(focusColorForWindow()).toBe("blue");
  });

  test("can split before the active pane for left/up menu actions", () => {
    const pane = resetLayout([fileTab()]);

    splitPane(pane.id, "row", "before");

    const root = layout.nodes[layout.rootId];
    expect(root?.kind).toBe("split");
    if (root?.kind !== "split") return;
    expect(root.direction).toBe("row");
    expect(layout.nodes[root.a]?.kind).toBe("leaf");
    expect(root.b).toBe(pane.id);
    expect(layout.activePaneId).toBe(root.a);
  });

  test("detaches a tab into a new pane at the target edge", () => {
    const first = fileTab({ id: "file-a", path: "notes/a.md" });
    const second = fileTab({ id: "file-b", path: "notes/b.md" });
    const pane = resetLayout([first, second]);

    detachTabToPaneEdge(pane.id, second.id, pane.id, "right");

    const root = layout.nodes[layout.rootId];
    expect(root?.kind).toBe("split");
    if (root?.kind !== "split") return;
    expect(root.direction).toBe("row");
    const left = layout.nodes[root.a];
    const right = layout.nodes[root.b];
    expect(left?.kind).toBe("leaf");
    expect(right?.kind).toBe("leaf");
    if (left?.kind !== "leaf" || right?.kind !== "leaf") return;
    expect(left.tabs.map((tab) => tab.id)).toEqual([first.id]);
    expect(right.tabs.map((tab) => tab.id)).toEqual([second.id]);
    expect(layout.activePaneId).toBe(right.id);
  });

  test("moving a terminal preserves Team Work workspace state", () => {
    const terminal = terminalTab({
      id: "term-a",
      title: "@@Agent",
      terminalSessionId: "session-a",
      teamWork: {
        buffer: "queued prompt",
        open: true,
        phase: "active",
        workspaceName: "team-work-2",
        draftPath: "Drafts/team-work-2/draft.md",
        workspacePath: "Drafts/team-work-2",
        eventsPath: "Drafts/team-work-2/spool/events",
        processPath: "Drafts/team-work-2/spool/process.md",
        workspaceAbs: "/tmp/workspace/.chan/team-work-2",
        eventsAbs: "/tmp/workspace/.chan/team-work-2/spool/events",
        submissionSequence: 7,
        submitMode: "agent",
        agentTarget: "claude",
        collapsed: true,
        pageWidthRatio: 0.7,
      },
    });
    const pane = resetLayout([terminal]);
    splitPane(pane.id, "row", "after");
    const root = layout.nodes[layout.rootId];
    expect(root?.kind).toBe("split");
    if (root?.kind !== "split") return;

    moveTab(pane.id, terminal.id, root.b);

    const target = layout.nodes[root.b];
    expect(target?.kind).toBe("leaf");
    if (target?.kind !== "leaf") return;
    const moved = target.tabs[0];
    expect(moved?.kind).toBe("terminal");
    if (moved?.kind !== "terminal") return;
    expect(moved.teamWork).toMatchObject({
      buffer: "queued prompt",
      workspaceName: "team-work-2",
      eventsPath: "Drafts/team-work-2/spool/events",
      submissionSequence: 7,
      submitMode: "agent",
      agentTarget: "claude",
      collapsed: true,
      pageWidthRatio: 0.7,
    });
  });

  test("closeTabsInPane leaves every tab when a terminal close sink fails", async () => {
    const terminal = terminalTab({ id: "term-a" });
    const file = fileTab({ id: "file-a", path: "notes/a.md" });
    const pane = resetLayout([terminal, file]);
    const closeSink = vi.fn().mockResolvedValue(false);
    const unregister = registerTerminalCloseSink(terminal.id, closeSink);

    const closed = await closeTabsInPane(pane.id, { force: true });

    unregister();
    expect(closed).toBe(false);
    expect(closeSink).toHaveBeenCalledTimes(1);
    expect(activePane().tabs.map((tab) => tab.id)).toEqual(["term-a", "file-a"]);
    expect(activePane().activeTabId).toBe("term-a");
  });

  test("closeTabsInPane clears tabs without killing a non-root pane", async () => {
    const left = fileTab({ id: "file-a", path: "notes/a.md" });
    const leftPane = resetLayout([left]);
    splitPane(leftPane.id, "row", "after");
    const root = layout.nodes[layout.rootId];
    expect(root?.kind).toBe("split");
    if (root?.kind !== "split") return;

    const closed = await closeTabsInPane(leftPane.id, { force: true });

    expect(closed).toBe(true);
    expect(layout.nodes[layout.rootId]?.kind).toBe("split");
    const leftAfter = layout.nodes[leftPane.id];
    expect(leftAfter?.kind).toBe("leaf");
    if (leftAfter?.kind !== "leaf") return;
    expect(leftAfter.tabs).toHaveLength(0);
    expect(leftAfter.activeTabId).toBeNull();
  });

  test("closePane leaves the split tree intact when a terminal close sink fails", async () => {
    const terminal = terminalTab({ id: "term-a" });
    const leftPane = resetLayout([terminal]);
    splitPane(leftPane.id, "row", "after");
    const rootBefore = layout.nodes[layout.rootId];
    expect(rootBefore?.kind).toBe("split");
    if (rootBefore?.kind !== "split") return;
    const closeSink = vi.fn().mockResolvedValue(false);
    const unregister = registerTerminalCloseSink(terminal.id, closeSink);

    const closed = await closePane(leftPane.id, { force: true });

    unregister();
    expect(closed).toBe(false);
    expect(closeSink).toHaveBeenCalledTimes(1);
    expect(layout.nodes[layout.rootId]?.kind).toBe("split");
    const left = layout.nodes[leftPane.id];
    expect(left?.kind).toBe("leaf");
    if (left?.kind !== "leaf") return;
    expect(left.tabs.map((tab) => tab.id)).toEqual(["term-a"]);
  });

  test("detachTabToPaneEdge moves a browser or graph tab end-to-end", () => {
    // The DnD machinery is tab-kind agnostic. Lock in the contract:
    // detaching a Browser tab and a Graph tab via edge-drop produces
    // a new pane each, just like file tabs do.
    const file = fileTab({ id: "file-host", path: "notes/host.md" });
    const pane = resetLayout([file]);
    const browser = openBrowserInActivePane();
    const graph = openGraphInActivePane({
      mode: "filesystem",
      scopeId: "dir:notes",
    });

    detachTabToPaneEdge(pane.id, browser.id, pane.id, "right");
    const afterBrowser = layout.nodes[layout.rootId];
    expect(afterBrowser?.kind).toBe("split");
    if (afterBrowser?.kind !== "split") return;
    const browserPane = layout.nodes[afterBrowser.b];
    expect(browserPane?.kind).toBe("leaf");
    if (browserPane?.kind !== "leaf") return;
    expect(browserPane.tabs.map((t) => t.kind)).toEqual(["browser"]);

    // Re-detach the graph tab to the bottom of the original pane.
    detachTabToPaneEdge(pane.id, graph.id, pane.id, "bottom");
    const root = layout.nodes[layout.rootId];
    expect(root?.kind).toBe("split");
    if (root?.kind !== "split") return;
    // The original split (row, browser on the right) is now nested
    // under a new column split. Walk down to find the graph leaf.
    const allLeaves = Object.values(layout.nodes).filter(
      (n) => n.kind === "leaf",
    );
    const graphLeaf = allLeaves.find((n) => {
      if (n.kind !== "leaf") return false;
      return n.tabs.some((t) => t.kind === "graph");
    });
    expect(graphLeaf).toBeTruthy();
    if (graphLeaf?.kind !== "leaf") return;
    expect(graphLeaf.tabs[0]?.kind).toBe("graph");
  });

  test("collapses the source pane after detaching its last tab", () => {
    const left = fileTab({ id: "left", path: "notes/left.md" });
    const right = fileTab({ id: "right", path: "notes/right.md" });
    const leftPane = resetLayout([left]);
    splitPane(leftPane.id, "row", "after");
    const rootBefore = layout.nodes[layout.rootId];
    expect(rootBefore?.kind).toBe("split");
    if (rootBefore?.kind !== "split") return;
    const rightPaneId = rootBefore.b;
    const rightPane = layout.nodes[rightPaneId];
    expect(rightPane?.kind).toBe("leaf");
    if (rightPane?.kind !== "leaf") return;
    rightPane.tabs.push(right);
    rightPane.activeTabId = right.id;

    detachTabToPaneEdge(leftPane.id, left.id, rightPane.id, "bottom");

    const root = layout.nodes[layout.rootId];
    expect(root?.kind).toBe("split");
    if (root?.kind !== "split") return;
    expect(root.direction).toBe("column");
    const top = layout.nodes[root.a];
    const bottom = layout.nodes[root.b];
    expect(top?.kind).toBe("leaf");
    expect(bottom?.kind).toBe("leaf");
    if (top?.kind !== "leaf" || bottom?.kind !== "leaf") return;
    expect(top.tabs.map((tab) => tab.id)).toEqual([right.id]);
    expect(bottom.tabs.map((tab) => tab.id)).toEqual([left.id]);
    expect(layout.nodes[leftPane.id]).toBeUndefined();
  });

  test("opens graph and file browser as first-class tabs", () => {
    resetLayout([]);

    const graph = openGraphInActivePane({
      mode: "filesystem",
      scopeId: "dir:notes",
      pendingSelectId: "notes/today.md",
    });
    const browser = openBrowserInActivePane();

    expect(activePane().tabs.map((tab) => tab.kind)).toEqual(["graph", "browser"]);
    expect(graph.scopeId).toBe("dir:notes");
    expect(graph.pendingSelectId).toBe("notes/today.md");
    expect(browser.inspectorOpen).toBeTypeOf("boolean");
    expect(activePane().activeTabId).toBe(browser.id);
  });

  test("round-trips graph and file browser tab state", async () => {
    resetLayout([]);
    const graph = openGraphInActivePane({
      mode: "language",
      scopeId: "workspace",
      depth: 0,
    });
    graph.inspectorOpen = true;
    graph.filters.img = false;
    const browser = openBrowserInActivePane();
    browser.inspectorOpen = true;

    const snapshot = serializeLayout();
    await restoreLayout(snapshot!);

    const tabs = activePane().tabs;
    expect(tabs.map((tab) => tab.kind)).toEqual(["graph", "browser"]);
    const restoredGraph = tabs[0];
    expect(restoredGraph?.kind).toBe("graph");
    if (restoredGraph?.kind !== "graph") return;
    expect(restoredGraph.mode).toBe("language");
    expect(restoredGraph.depth).toBe(0);
    expect(restoredGraph.inspectorOpen).toBe(true);
    expect(restoredGraph.filters.img).toBe(false);

    const restoredBrowser = tabs[1];
    expect(restoredBrowser?.kind).toBe("browser");
    if (restoredBrowser?.kind !== "browser") return;
    expect(restoredBrowser.inspectorOpen).toBe(true);
  });

  test("round-trips per-tab BrowserTab view state", async () => {
    resetLayout([]);
    const browser = openBrowserInActivePane();
    browser.selected = "notes/today.md";
    browser.showWorkspace = false;
    browser.expanded = ["notes", "notes/2026"];
    browser.scroll = 320;

    const snapshot = serializeLayout();
    await restoreLayout(snapshot!);

    const tabs = activePane().tabs;
    expect(tabs.map((tab) => tab.kind)).toEqual(["browser"]);
    const restored = tabs[0];
    if (restored?.kind !== "browser") throw new Error("expected browser tab");
    expect(restored.selected).toBe("notes/today.md");
    expect(restored.expanded).toEqual(["notes", "notes/2026"]);
    expect(restored.scroll).toBe(320);
    // showWorkspace=false is the default; we omit `bd` in the hash so it
    // restores as undefined rather than `false`. Either is fine.
    expect(restored.showWorkspace ?? false).toBe(false);
  });

  test("two BrowserTab records carry independent state without leakage", () => {
    resetLayout([]);
    const tab1 = openBrowserInActivePane();
    const tab2 = openBrowserInActivePane();
    expect(tab1.id).not.toBe(tab2.id);

    tab1.selected = "index.md";
    tab1.expanded = ["docs"];
    tab1.scroll = 80;
    tab1.showWorkspace = false;

    tab2.selected = "notes/scratch.md";
    tab2.expanded = ["notes"];
    tab2.scroll = 240;
    tab2.showWorkspace = true;

    expect(tab1.selected).toBe("index.md");
    expect(tab2.selected).toBe("notes/scratch.md");
    expect(tab1.expanded).toEqual(["docs"]);
    expect(tab2.expanded).toEqual(["notes"]);
    expect(tab1.scroll).toBe(80);
    expect(tab2.scroll).toBe(240);
    expect(tab1.showWorkspace).toBe(false);
    expect(tab2.showWorkspace).toBe(true);
  });

  test("hash round-trips both BrowserTab records' per-tab state", async () => {
    resetLayout([]);
    const tab1 = openBrowserInActivePane();
    const tab2 = openBrowserInActivePane();
    tab1.selected = "a.md";
    tab1.expanded = ["dir-a"];
    tab2.selected = "b.md";
    tab2.expanded = ["dir-b"];
    tab2.scroll = 100;

    const snapshot = serializeLayout();
    await restoreLayout(snapshot!);

    const tabs = activePane().tabs.filter((t) => t.kind === "browser");
    expect(tabs.length).toBe(2);
    if (tabs[0]?.kind !== "browser" || tabs[1]?.kind !== "browser") return;
    expect(tabs[0].selected).toBe("a.md");
    expect(tabs[0].expanded).toEqual(["dir-a"]);
    expect(tabs[1].selected).toBe("b.md");
    expect(tabs[1].expanded).toEqual(["dir-b"]);
    expect(tabs[1].scroll).toBe(100);
  });

  test("hash round-trips a Dashboard tab", async () => {
    resetLayout([]);
    openDashboardInActivePane();
    expect(activePane().tabs.map((t) => t.kind)).toEqual(["dashboard"]);
    const originalActiveId = activePane().activeTabId;
    expect(originalActiveId).not.toBeNull();

    const snapshot = serializeLayout();
    await restoreLayout(snapshot!);

    const restored = activePane().tabs;
    expect(restored.map((t) => t.kind)).toEqual(["dashboard"]);
    const first = restored[0];
    if (first?.kind !== "dashboard") throw new Error("expected dashboard tab");
    expect(first.title).toBe("Dashboard");
    expect(activePane().activeTabId).toBe(first.id);
  });

  test("hash round-trips a Dashboard tab's carousel slide cursor", async () => {
    // The user-visible expectation is "the slide I left the carousel
    // on is the slide it opens to after a window reload". The
    // persisted field is `cs` in SerTab.
    resetLayout([]);
    openDashboardInActivePane();
    const live = activePane().tabs[0];
    if (live?.kind !== "dashboard") throw new Error("expected dashboard tab");
    live.carouselSlide = 2;

    const snapshot = serializeLayout();
    await restoreLayout(snapshot!);

    const restored = activePane().tabs[0];
    if (restored?.kind !== "dashboard")
      throw new Error("expected dashboard tab after restore");
    expect(restored.carouselSlide).toBe(2);
  });

  test("Dashboard tab with carouselSlide=0 omits the cs field in the hash", () => {
    // Default-slide tabs keep the hash compact; the field only
    // emits when the user has moved off the About slide.
    resetLayout([]);
    openDashboardInActivePane();
    const snapshot = serializeLayout();
    const json = JSON.stringify(snapshot);
    expect(json).not.toMatch(/"cs":/);
  });

  test("two BrowserTab records carry independent inspectorWidth", () => {
    resetLayout([]);
    const tab1 = openBrowserInActivePane();
    const tab2 = openBrowserInActivePane();
    tab1.inspectorWidth = 280;
    tab2.inspectorWidth = 420;
    expect(tab1.inspectorWidth).toBe(280);
    expect(tab2.inspectorWidth).toBe(420);
  });

  test("hash round-trips per-tab inspectorWidth on browser + graph + file", async () => {
    resetLayout([]);
    const browser1 = openBrowserInActivePane();
    const browser2 = openBrowserInActivePane();
    const graph1 = openGraphInActivePane({
      mode: "semantic",
      scopeId: "workspace",
      depth: 1,
    });
    const file1 = fileTab({ id: "f1", path: "notes/a.md" });
    file1.inspectorWidth = 510;
    file1.outlineWidth = 240;
    activePane().tabs.push(file1);
    browser1.inspectorWidth = 250;
    browser2.inspectorWidth = 400;
    graph1.inspectorWidth = 360;

    const snapshot = serializeLayout();
    await restoreLayout(snapshot!);

    const tabs = activePane().tabs;
    const browsers = tabs.filter((t) => t.kind === "browser");
    expect(browsers.length).toBe(2);
    if (browsers[0]?.kind !== "browser" || browsers[1]?.kind !== "browser") return;
    expect(browsers[0].inspectorWidth).toBe(250);
    expect(browsers[1].inspectorWidth).toBe(400);

    const graphs = tabs.filter((t) => t.kind === "graph");
    expect(graphs.length).toBe(1);
    if (graphs[0]?.kind !== "graph") return;
    expect(graphs[0].inspectorWidth).toBe(360);

    const files = tabs.filter((t) => t.kind === "file");
    expect(files.length).toBe(1);
    if (files[0]?.kind !== "file") return;
    expect(files[0].inspectorWidth).toBe(510);
    expect(files[0].outlineWidth).toBe(240);
  });

  test("pane mode discards draft changes on cancel", () => {
    const left = fileTab({ id: "left", path: "notes/left.md" });
    const right = fileTab({ id: "right", path: "notes/right.md" });
    const leftPane = resetLayout([left]);
    splitPane(leftPane.id, "row", "after");
    const root = layout.nodes[layout.rootId];
    expect(root?.kind).toBe("split");
    if (root?.kind !== "split") return;
    const rightPane = layout.nodes[root.b];
    expect(rightPane?.kind).toBe("leaf");
    if (rightPane?.kind !== "leaf") return;
    rightPane.tabs.push(right);
    rightPane.activeTabId = right.id;
    layout.activePaneId = leftPane.id;

    enterPaneMode();
    paneModeMoveFocus("right");
    paneModeResize("row", true, 0.1);
    expect(paneMode.draft?.activePaneId).toBe(rightPane.id);
    expect(root.ratio).toBe(0.5);

    cancelPaneMode();

    expect(paneMode.active).toBe(false);
    expect(layout.activePaneId).toBe(leftPane.id);
    expect(root.ratio).toBe(0.5);
  });

  test("pane mode spawn keys add tabs to the draft and Esc rolls them back", () => {
    const left = fileTab({ id: "left", path: "notes/left.md" });
    const leftPane = resetLayout([left]);
    layout.activePaneId = leftPane.id;

    enterPaneMode();
    paneModeOpenTerminal();
    paneModeOpenBrowser();
    paneModeOpenGraph();

    // Draft sees the three new tabs; the real layout is untouched.
    const draftPane = paneMode.draft?.nodes[leftPane.id];
    expect(draftPane?.kind).toBe("leaf");
    if (draftPane?.kind !== "leaf") return;
    expect(draftPane.tabs.map((t) => t.kind)).toEqual([
      "file",
      "terminal",
      "browser",
      "graph",
    ]);
    expect(layout.nodes[leftPane.id]?.kind).toBe("leaf");
    expect((layout.nodes[leftPane.id] as LeafNode).tabs).toHaveLength(1);

    cancelPaneMode();
    expect((layout.nodes[leftPane.id] as LeafNode).tabs).toHaveLength(1);
  });

  test("pane mode commits the draft's spawned tabs into the real layout", () => {
    const left = fileTab({ id: "left", path: "notes/left.md" });
    const leftPane = resetLayout([left]);
    layout.activePaneId = leftPane.id;

    enterPaneMode();
    paneModeOpenTerminal();
    paneModeOpenBrowser();
    commitPaneMode();

    const committed = layout.nodes[leftPane.id];
    expect(committed?.kind).toBe("leaf");
    if (committed?.kind !== "leaf") return;
    expect(committed.tabs.map((t) => t.kind)).toEqual([
      "file",
      "terminal",
      "browser",
    ]);
    // Focus moves to the freshly-spawned browser tab (last in =
    // paneModeOpenBrowser's activeTabId assignment carries through
    // the commit).
    expect(committed.activeTabId).toBe(
      committed.tabs.find((t) => t.kind === "browser")?.id,
    );
  });

  test("pane mode terminal spawns get distinct names across draft panes", () => {
    resetLayout([]);

    enterPaneMode();
    paneModeSplit("row");
    paneModeSplit("row");
    paneModeOpenTerminal();
    paneModeMoveFocus("left");
    paneModeOpenTerminal();
    paneModeMoveFocus("left");
    paneModeOpenTerminal();
    commitPaneMode();

    const terminals = Object.values(layout.nodes)
      .filter((node): node is LeafNode => node.kind === "leaf")
      .flatMap((node) => node.tabs)
      .filter((tab): tab is TerminalTab => tab.kind === "terminal");

    expect(terminals.map((tab) => tab.title).sort()).toEqual([
      "Terminal-1",
      "Terminal-2",
      "Terminal-3",
    ]);
    expect(new Set(terminals.map((tab) => tab.id)).size).toBe(3);
    expect(terminals.every((tab) => tab.broadcastEnabled === false)).toBe(true);
  });

  test("pane mode Team Work terminals share the draft title allocator", () => {
    resetLayout([]);

    enterPaneMode();
    paneModeSplit("row");
    paneModeOpenTeamWorkTerminal();
    paneModeMoveFocus("left");
    paneModeOpenTeamWorkTerminal();
    commitPaneMode();

    const terminals = Object.values(layout.nodes)
      .filter((node): node is LeafNode => node.kind === "leaf")
      .flatMap((node) => node.tabs)
      .filter((tab): tab is TerminalTab => tab.kind === "terminal");

    expect(terminals.map((tab) => tab.title).sort()).toEqual([
      "Terminal-1",
      "Terminal-2",
    ]);
    expect(terminals.every((tab) => tab.teamWork?.open === true)).toBe(true);
  });

  test("File Browser and Graph spawns always add a new tab", () => {
    // Every spawn affordance creates a fresh tab with its own state
    // so users can compare two browser/graph views side-by-side.
    const tab = fileTab({ id: "f", path: "notes/x.md" });
    const pane = resetLayout([tab]);
    openBrowserInActivePane();
    openGraphInActivePane();
    const before = activePane().tabs.length;

    enterPaneMode();
    paneModeOpenBrowser();
    paneModeOpenGraph();
    commitPaneMode();

    const after = activePane().tabs.length;
    expect(after).toBe(before + 2);
    expect(pane.id).toBe(activePane().id);

    const browsers = activePane().tabs.filter((t) => t.kind === "browser");
    const graphs = activePane().tabs.filter((t) => t.kind === "graph");
    expect(browsers).toHaveLength(2);
    expect(graphs).toHaveLength(2);
    // Each spawn carries its own identity, so the second browser
    // and second graph live alongside their predecessors with
    // independent ids.
    expect(new Set(browsers.map((t) => t.id)).size).toBe(2);
    expect(new Set(graphs.map((t) => t.id)).size).toBe(2);
  });

  test("paneModeOpenTerminal/Browser/Graph honor a SpawnContext", () => {
    const f = fileTab({ id: "f", path: "notes/sub/a.md" });
    resetLayout([f]);

    // Context with file + parent dir: terminal cwd = parent dir,
    // browser inspector pops, graph scopes to file:* with the file
    // pre-selected so its inspector opens on mount.
    enterPaneMode();
    paneModeOpenTerminal({ dir: "notes/sub", file: "notes/sub/a.md" });
    paneModeOpenBrowser({ dir: "notes/sub", file: "notes/sub/a.md" });
    paneModeOpenGraph({ dir: "notes/sub", file: "notes/sub/a.md" });
    commitPaneMode();

    const tabs = activePane().tabs;
    const terminal = tabs.find((t) => t.kind === "terminal") as TerminalTab;
    const browser = tabs.find((t) => t.kind === "browser");
    const graph = tabs.find((t) => t.kind === "graph");
    expect(terminal.cwd).toBe("notes/sub");
    expect(browser?.kind).toBe("browser");
    if (browser?.kind === "browser") {
      expect(browser.inspectorOpen).toBe(true);
    }
    expect(graph?.kind).toBe("graph");
    if (graph?.kind === "graph") {
      expect(graph.scopeId).toBe("file:notes/sub/a.md");
      expect(graph.pendingSelectId).toBe("notes/sub/a.md");
    }
  });

  test("paneModeOpenGraph with a dir-only context scopes to dir:*", () => {
    const f = fileTab({ id: "f", path: "notes/x.md" });
    resetLayout([f]);

    enterPaneMode();
    paneModeOpenGraph({ dir: "notes" });
    commitPaneMode();

    const graph = activePane().tabs.find((t) => t.kind === "graph");
    expect(graph?.kind).toBe("graph");
    if (graph?.kind === "graph") {
      expect(graph.scopeId).toBe("dir:notes");
      // The dir is itself the pre-selected node so the inspector pops on mount.
      expect(graph.pendingSelectId).toBe("notes");
    }
  });

  test("paneModeOpen* with empty context preserves workspace-root defaults", () => {
    const f = fileTab({ id: "f", path: "notes/x.md" });
    resetLayout([f]);

    enterPaneMode();
    paneModeOpenTerminal({ dir: "" });
    paneModeOpenGraph({ dir: "" });
    commitPaneMode();

    const tabs = activePane().tabs;
    const terminal = tabs.find((t) => t.kind === "terminal") as TerminalTab;
    const graph = tabs.find((t) => t.kind === "graph");
    expect(terminal.cwd).toBeUndefined();
    expect(graph?.kind).toBe("graph");
    if (graph?.kind === "graph") {
      expect(graph.scopeId).toBe("workspace");
      expect(graph.pendingSelectId).toBeNull();
    }
  });

  test("paneModeStageSpawn stores intent without modifying the draft", () => {
    const f = fileTab({ id: "f", path: "notes/x.md" });
    const seed = resetLayout([f]);

    enterPaneMode();
    paneModeStageSpawn("terminal", { dir: "notes" });

    // Draft pane should still have just the original file tab -     // the spawn intent is staged, not applied.
    const draftPane = paneMode.draft?.nodes[seed.id];
    expect(draftPane?.kind).toBe("leaf");
    if (draftPane?.kind === "leaf") {
      expect(draftPane.tabs).toHaveLength(1);
      expect(draftPane.tabs[0]?.kind).toBe("file");
    }
    expect(paneMode.spawnIntent).toEqual({
      kind: "terminal",
      ctx: { dir: "notes" },
    });

    cancelPaneMode();
  });

  test("staged spawn fires on commit and lands on the focused pane", () => {
    const f = fileTab({ id: "f", path: "notes/x.md" });
    const seed = resetLayout([f]);

    enterPaneMode();
    paneModeStageSpawn("graph", { file: "notes/x.md", dir: "notes" });
    commitPaneMode();

    const live = layout.nodes[seed.id];
    expect(live?.kind).toBe("leaf");
    if (live?.kind === "leaf") {
      const graph = live.tabs.find((t) => t.kind === "graph");
      expect(graph?.kind).toBe("graph");
      if (graph?.kind === "graph") {
        expect(graph.scopeId).toBe("file:notes/x.md");
        expect(graph.pendingSelectId).toBe("notes/x.md");
      }
    }
    // Intent is cleared on commit.
    expect(paneMode.spawnIntent).toBeNull();
  });

  test("staging a second key replaces the intent", () => {
    const f = fileTab({ id: "f", path: "notes/x.md" });
    const seed = resetLayout([f]);

    enterPaneMode();
    paneModeStageSpawn("terminal", { dir: "" });
    paneModeStageSpawn("browser", { dir: "notes" });
    commitPaneMode();

    const live = layout.nodes[seed.id];
    expect(live?.kind).toBe("leaf");
    if (live?.kind === "leaf") {
      // Browser spawned, no terminal - replacement, not stacking.
      expect(live.tabs.filter((t) => t.kind === "terminal")).toHaveLength(0);
      expect(live.tabs.filter((t) => t.kind === "browser")).toHaveLength(1);
    }
  });

  test("Esc / cancel discards a staged spawn", () => {
    const f = fileTab({ id: "f", path: "notes/x.md" });
    const seed = resetLayout([f]);
    const initialTabCount = (layout.nodes[seed.id] as LeafNode).tabs.length;

    enterPaneMode();
    paneModeStageSpawn("terminal", { dir: "notes" });
    cancelPaneMode();

    const live = layout.nodes[seed.id];
    expect(live?.kind).toBe("leaf");
    if (live?.kind === "leaf") {
      expect(live.tabs).toHaveLength(initialTabCount);
      expect(live.tabs.find((t) => t.kind === "terminal")).toBeUndefined();
    }
    expect(paneMode.spawnIntent).toBeNull();
  });

  test("paneModeStageSpawn is a no-op outside Pane Mode", () => {
    resetLayout([fileTab({ id: "f", path: "notes/x.md" })]);
    paneModeStageSpawn("terminal", { dir: "" });
    expect(paneMode.spawnIntent).toBeNull();
  });

  test("createTeamWorkLeadTerminal spawns a terminal in an empty pane and returns it", () => {
    const seed = resetLayout([]);

    const created = createTeamWorkLeadTerminal();

    const pane = layout.nodes[seed.id] as LeafNode;
    expect(pane.tabs).toHaveLength(1);
    const terminal = pane.tabs[0];
    expect(terminal.kind).toBe("terminal");
    if (terminal.kind === "terminal") {
      expect(terminal.teamWork?.open).toBe(true);
      expect(terminal.teamWork?.mode).toBe("wysiwyg");
    }
    expect(pane.activeTabId).toBe(terminal.id);
    // The factory returns the freshly-created tab so the Team dialog
    // can delete it on Cancel.
    expect(created?.id).toBe(terminal.id);
  });

  test("createTeamWorkLeadTerminal spawns fresh in the active pane even when a terminal exists elsewhere", () => {
    // A pre-existing terminal elsewhere in the tab list is left
    // untouched. Cmd+P always opens a fresh Team Work terminal
    // instead of switching to it.
    const doc = fileTab({ id: "doc-1", path: "notes/x.md" });
    const terminal: TerminalTab = {
      kind: "terminal",
      id: "term-existing",
      title: "Terminal",
      createdAt: 1,
      broadcastEnabled: false,
      broadcastTargetIds: [],
    };
    const seed = resetLayout([doc, terminal]);
    (layout.nodes[seed.id] as LeafNode).activeTabId = doc.id;

    const created = createTeamWorkLeadTerminal();

    const pane = layout.nodes[seed.id] as LeafNode;
    // Fresh terminal spawned + active; existing one untouched.
    expect(pane.tabs).toHaveLength(3);
    expect(pane.activeTabId).not.toBe(doc.id);
    expect(pane.activeTabId).not.toBe("term-existing");
    const active = pane.tabs.find((t) => t.id === pane.activeTabId);
    expect(active?.kind).toBe("terminal");
    expect((active as TerminalTab).teamWork?.open).toBe(true);
    expect(created?.id).toBe(pane.activeTabId);
  });

  test("createTeamWorkLeadTerminal always spawns a fresh Team Work terminal", () => {
    const terminal: TerminalTab = {
      kind: "terminal",
      id: "term-1",
      title: "Terminal",
      createdAt: 1,
      broadcastEnabled: false,
      broadcastTargetIds: [],
      teamWork: { buffer: "draft", heightPx: 200, open: true, mode: "source" },
    };
    const seed = resetLayout([terminal]);
    (layout.nodes[seed.id] as LeafNode).activeTabId = "term-1";

    const created = createTeamWorkLeadTerminal({ cwd: "notes" });

    const pane = layout.nodes[seed.id] as LeafNode;
    expect(pane.tabs).toHaveLength(2);
    const live = pane.tabs.find((t) => t.id === "term-1") as TerminalTab;
    expect(live.teamWork?.buffer).toBe("draft");
    expect(live.teamWork?.mode).toBe("source");
    const spawned = pane.tabs.find((t) => t.id === pane.activeTabId) as TerminalTab;
    expect(spawned.id).not.toBe("term-1");
    expect(spawned.kind).toBe("terminal");
    expect(spawned.cwd).toBe("notes");
    expect(spawned.teamWork?.open).toBe(true);
    expect(spawned.teamWork?.mode).toBe("wysiwyg");
    expect(created?.id).toBe(spawned.id);
  });

  test("openActiveTeamWork blurs the focused xterm helper textarea", () => {
    // Between the Team Work chord and the editor child mounting +
    // focusing, xterm-helper-textarea still owns focus. Keystrokes
    // typed there fire `term.onData` and reach the live PTY, leaving
    // the dispatched buffer short its first character. Blurring the
    // helper textarea parks focus on `<body>` so the racing keystroke
    // is dropped instead of going to the shell.
    const terminal: TerminalTab = {
      kind: "terminal",
      id: "term-blur",
      title: "Terminal",
      createdAt: 1,
      broadcastEnabled: false,
      broadcastTargetIds: [],
    };
    const seed = resetLayout([terminal]);
    (layout.nodes[seed.id] as LeafNode).activeTabId = "term-blur";

    const xtermRoot = document.createElement("div");
    xtermRoot.className = "xterm";
    const helper = document.createElement("textarea");
    helper.className = "xterm-helper-textarea";
    xtermRoot.appendChild(helper);
    document.body.appendChild(xtermRoot);
    helper.focus();
    expect(document.activeElement).toBe(helper);

    openActiveTeamWork();

    expect(document.activeElement).not.toBe(helper);
    const pane = layout.nodes[seed.id] as LeafNode;
    const live = pane.tabs.find((t) => t.id === "term-blur") as TerminalTab;
    expect(live.teamWork?.open).toBe(true);

    document.body.removeChild(xtermRoot);
  });

  test("openActiveTeamWork leaves non-xterm focus alone", () => {
    // The blur is scoped to xterm-owned elements. A user invoking
    // the prompt from a code editor or any other input keeps their
    // focus until the editor child takes over; we don't want to
    // strip focus globally.
    const terminal: TerminalTab = {
      kind: "terminal",
      id: "term-keep",
      title: "Terminal",
      createdAt: 1,
      broadcastEnabled: false,
      broadcastTargetIds: [],
    };
    const seed = resetLayout([terminal]);
    (layout.nodes[seed.id] as LeafNode).activeTabId = "term-keep";

    const someInput = document.createElement("input");
    document.body.appendChild(someInput);
    someInput.focus();
    expect(document.activeElement).toBe(someInput);

    openActiveTeamWork();

    expect(document.activeElement).toBe(someInput);

    document.body.removeChild(someInput);
  });

  test("repeated openBrowserInActivePane / openGraphInActivePane stack", () => {
    const tab = fileTab({ id: "g", path: "notes/y.md" });
    resetLayout([tab]);

    const first = openBrowserInActivePane();
    const second = openBrowserInActivePane();
    expect(first.id).not.toBe(second.id);
    expect(
      activePane().tabs.filter((t) => t.kind === "browser"),
    ).toHaveLength(2);

    const g1 = openGraphInActivePane({ scopeId: "dir:notes" });
    const g2 = openGraphInActivePane({ scopeId: "dir:notes" });
    expect(g1.id).not.toBe(g2.id);
    // Same scope is fine; each instance keeps its own filters
    // and pending-select state.
    expect(g1.scopeId).toBe(g2.scopeId);
    expect(
      activePane().tabs.filter((t) => t.kind === "graph"),
    ).toHaveLength(2);
  });

  test("openBrowserInActivePane assigns enumerated titles", () => {
    resetLayout([]);

    const first = openBrowserInActivePane();
    const second = openBrowserInActivePane();
    const third = openBrowserInActivePane();

    expect(first.title).toBe("Files");
    expect(second.title).toBe("Files 2");
    expect(third.title).toBe("Files 3");
  });

  test("openBrowserInActivePane threads the select option into the new tab", () => {
    resetLayout([]);

    const tab = openBrowserInActivePane({ select: "notes/x.md" });

    expect(tab.selected).toBe("notes/x.md");
  });

  test("openBrowserInActivePane with no select leaves selected undefined", () => {
    resetLayout([]);

    const tab = openBrowserInActivePane();

    expect(tab.selected).toBeUndefined();
  });

  test("pane mode split inserts a new pane to the right/down in the draft", () => {
    const left = fileTab({ id: "left", path: "notes/left.md" });
    const root = resetLayout([left]);
    layout.activePaneId = root.id;

    enterPaneMode();
    paneModeSplit("row");
    // Draft now has a split node at the root, focus on the new pane.
    const draft = paneMode.draft;
    expect(draft).not.toBeNull();
    if (!draft) return;
    const draftRoot = draft.nodes[draft.rootId];
    expect(draftRoot?.kind).toBe("split");
    if (draftRoot?.kind !== "split") return;
    expect(draftRoot.direction).toBe("row");
    // The original pane sits on the left ("a"); the new pane is "b"
    // and grabs focus (placement: "after").
    expect(draftRoot.a).toBe(root.id);
    expect(draftRoot.b).toBe(draft.activePaneId);
    // Real layout is still a single pane.
    expect(layout.nodes[layout.rootId]?.kind).toBe("leaf");

    commitPaneMode();
    const committedRoot = layout.nodes[layout.rootId];
    expect(committedRoot?.kind).toBe("split");
    if (committedRoot?.kind !== "split") return;
    expect(committedRoot.direction).toBe("row");
  });

  test("pane mode commits draft focus resize equalize and swaps", () => {
    const left = fileTab({ id: "left", path: "notes/left.md" });
    const right = fileTab({ id: "right", path: "notes/right.md" });
    const leftPane = resetLayout([left]);
    splitPane(leftPane.id, "row", "after");
    const root = layout.nodes[layout.rootId];
    expect(root?.kind).toBe("split");
    if (root?.kind !== "split") return;
    const rightPane = layout.nodes[root.b];
    expect(rightPane?.kind).toBe("leaf");
    if (rightPane?.kind !== "leaf") return;
    rightPane.tabs.push(right);
    rightPane.activeTabId = right.id;
    layout.activePaneId = leftPane.id;

    enterPaneMode();
    paneModeResize("row", true, 0.1);
    paneModeMoveFocus("right");
    paneModeSwap("left");
    paneModeEqualize();
    commitPaneMode();

    const committedRoot = layout.nodes[layout.rootId];
    expect(committedRoot?.kind).toBe("split");
    if (committedRoot?.kind !== "split") return;
    expect(committedRoot.ratio).toBe(0.5);
    const committedLeft = layout.nodes[committedRoot.a];
    const committedRight = layout.nodes[committedRoot.b];
    expect(committedLeft?.kind).toBe("leaf");
    expect(committedRight?.kind).toBe("leaf");
    if (committedLeft?.kind !== "leaf" || committedRight?.kind !== "leaf") return;
    expect(committedLeft.tabs[0]?.id).toBe("right");
    expect(committedRight.tabs[0]?.id).toBe("left");
    expect(layout.activePaneId).toBe(committedLeft.id);
  });
});

describe("Hybrid NAV transaction mode", () => {
  function setupTwoPanes(): { leftPane: LeafNode; rightPane: LeafNode } {
    const left = fileTab({ id: "left", path: "notes/left.md" });
    const right = fileTab({ id: "right", path: "notes/right.md" });
    const leftPane = resetLayout([left]);
    splitPane(leftPane.id, "row", "after");
    const root = layout.nodes[layout.rootId];
    if (root?.kind !== "split") throw new Error("expected split");
    const rightPane = layout.nodes[root.b];
    if (rightPane?.kind !== "leaf") throw new Error("expected leaf");
    rightPane.tabs.push(right);
    rightPane.activeTabId = right.id;
    return { leftPane, rightPane };
  }

  test("enterPaneModeTransaction with grab activates transaction mode + sets grab pane", () => {
    const { leftPane } = setupTwoPanes();

    enterPaneModeTransaction(leftPane.id);

    expect(paneMode.active).toBe(true);
    expect(paneMode.transactionMode).toBe(true);
    expect(paneMode.grabPaneId).toBe(leftPane.id);
    expect(paneMode.hoverPaneId).toBeNull();
    expect(paneMode.draft).not.toBeNull();

    cancelPaneMode();
  });

  test("enterPaneModeTransaction(null) activates transaction mode with no grab", () => {
    setupTwoPanes();

    enterPaneModeTransaction(null);

    expect(paneMode.transactionMode).toBe(true);
    expect(paneMode.grabPaneId).toBeNull();

    cancelPaneMode();
  });

  test("paneModeSwapWith swaps two arbitrary panes' contents", () => {
    const { leftPane, rightPane } = setupTwoPanes();

    enterPaneModeTransaction(leftPane.id);
    paneModeSwapWith(leftPane.id, rightPane.id);
    commitPaneMode();

    const leftAfter = layout.nodes[leftPane.id];
    const rightAfter = layout.nodes[rightPane.id];
    if (leftAfter?.kind !== "leaf" || rightAfter?.kind !== "leaf") {
      throw new Error("expected leaves after swap");
    }
    expect(leftAfter.tabs[0]?.id).toBe("right");
    expect(rightAfter.tabs[0]?.id).toBe("left");
  });

  test("paneModeSwapWith is a no-op outside pane mode", () => {
    const { leftPane, rightPane } = setupTwoPanes();

    paneModeSwapWith(leftPane.id, rightPane.id);

    const leftAfter = layout.nodes[leftPane.id];
    const rightAfter = layout.nodes[rightPane.id];
    if (leftAfter?.kind !== "leaf" || rightAfter?.kind !== "leaf") {
      throw new Error("expected leaves");
    }
    expect(leftAfter.tabs[0]?.id).toBe("left");
    expect(rightAfter.tabs[0]?.id).toBe("right");
  });

  test("paneModeSwapWith is a no-op when grab and drop are the same pane", () => {
    const { leftPane } = setupTwoPanes();

    enterPaneModeTransaction(leftPane.id);
    paneModeSwapWith(leftPane.id, leftPane.id);

    const draftLeft = paneMode.draft?.nodes[leftPane.id];
    if (draftLeft?.kind !== "leaf") throw new Error("expected leaf in draft");
    expect(draftLeft.tabs[0]?.id).toBe("left");

    cancelPaneMode();
  });

  test("paneModeSetGrab and paneModeSetHover only mutate state while transactionMode is on", () => {
    const { leftPane, rightPane } = setupTwoPanes();

    paneModeSetGrab(leftPane.id);
    paneModeSetHover(rightPane.id);
    expect(paneMode.grabPaneId).toBeNull();
    expect(paneMode.hoverPaneId).toBeNull();

    enterPaneMode();
    paneModeSetGrab(leftPane.id);
    paneModeSetHover(rightPane.id);
    expect(paneMode.grabPaneId).toBeNull();
    expect(paneMode.hoverPaneId).toBeNull();
    cancelPaneMode();

    enterPaneModeTransaction(null);
    paneModeSetGrab(leftPane.id);
    paneModeSetHover(rightPane.id);
    expect(paneMode.grabPaneId).toBe(leftPane.id);
    expect(paneMode.hoverPaneId).toBe(rightPane.id);
    cancelPaneMode();
  });

  test("cancelPaneMode clears transaction state alongside the draft", () => {
    const { leftPane, rightPane } = setupTwoPanes();

    enterPaneModeTransaction(leftPane.id);
    paneModeSetHover(rightPane.id);
    cancelPaneMode();

    expect(paneMode.active).toBe(false);
    expect(paneMode.transactionMode).toBe(false);
    expect(paneMode.grabPaneId).toBeNull();
    expect(paneMode.hoverPaneId).toBeNull();
  });

  test("commitPaneMode persists the swap and clears transaction state", () => {
    const { leftPane, rightPane } = setupTwoPanes();

    enterPaneModeTransaction(leftPane.id);
    paneModeSwapWith(leftPane.id, rightPane.id);
    commitPaneMode();

    expect(paneMode.active).toBe(false);
    expect(paneMode.transactionMode).toBe(false);
    expect(paneMode.grabPaneId).toBeNull();
    expect(paneMode.hoverPaneId).toBeNull();
    const leftAfter = layout.nodes[leftPane.id];
    if (leftAfter?.kind !== "leaf") throw new Error("expected leaf");
    expect(leftAfter.tabs[0]?.id).toBe("right");
  });
});

describe("splitPane side preservation", () => {
  test("splitting from the front side leaves the new pane on the front", () => {
    const seed = resetLayout([fileTab({ id: "f", path: "a.md" })]);
    splitPane(seed.id, "row", "after");
    const root = layout.nodes[layout.rootId];
    if (root?.kind !== "split") throw new Error("expected split");
    const newPane = layout.nodes[root.b];
    if (newPane?.kind !== "leaf") throw new Error("expected leaf");
    expect(newPane.showingBack).toBeFalsy();
    expect(newPane.back).toBeUndefined();
  });

  test("splitting a flipped pane yields a clean, unflipped new pane", () => {
    // The new pane is born empty, and flip is strictly tied to panes
    // with >= 1 tab, so it must NOT inherit showingBack/back. Copying
    // the flip onto an empty new pane creates a stuck 0-tab pane the
    // flip chord cannot undo, whose orientation leaks across panes.
    const seed = resetLayout([fileTab({ id: "f", path: "a.md" })]);
    flipHybrid(seed.id);
    const live = layout.nodes[seed.id];
    if (live?.kind !== "leaf") throw new Error("expected leaf");
    expect(live.showingBack).toBe(true);

    splitPane(seed.id, "row", "after");
    const root = layout.nodes[layout.rootId];
    if (root?.kind !== "split") throw new Error("expected split");
    const newPane = layout.nodes[root.b];
    if (newPane?.kind !== "leaf") throw new Error("expected leaf");
    expect(newPane.showingBack).toBeFalsy();
    expect(newPane.back).toBeUndefined();
    // Original pane keeps its own flip.
    const original = layout.nodes[seed.id];
    if (original?.kind !== "leaf") throw new Error("expected leaf");
    expect(original.showingBack).toBe(true);
  });
});

describe("Hybrid flip", () => {
  test("first flip materialises back marker; pane.theme is preserved", () => {
    const front = fileTab({ id: "front", path: "notes/front.md" });
    const seed = resetLayout([front]);
    expect(seed.back).toBeUndefined();

    flipHybrid(seed.id);

    // Read the live pane through layout.nodes - $state proxies live
    // there, and the plain `seed` returned by resetLayout isn't the
    // reactive view.
    const live = layout.nodes[seed.id];
    expect(live?.kind).toBe("leaf");
    if (live?.kind !== "leaf") return;
    expect(live.showingBack).toBe(true);
    // `pane.tabs` always describes the FRONT; flipping does not swap
    // tab collections.
    expect(live.tabs.map((t) => t.id)).toEqual(["front"]);
    expect(live.activeTabId).toBe("front");
    // `pane.theme` is a single per-Hybrid value; flip does not invert it.
    // Theme stays at the user's last explicit choice (undefined here).
    expect(live.theme).toBeUndefined();
    // back is materialised as an empty marker so menu gating
    // (`pane.back !== undefined`) can identify this as a Hybrid pane.
    expect(live.back).toEqual({});
  });

  test("flipping back round-trips showingBack; pane.theme is single + stable", () => {
    const front = fileTab({ id: "f1", path: "a.md" });
    const seed = resetLayout([front]);

    flipHybrid(seed.id);
    let live = layout.nodes[seed.id];
    if (live?.kind !== "leaf") throw new Error("expected leaf");
    expect(live.showingBack).toBe(true);
    // pane.theme is a single per-Hybrid value shared by both sides.
    // The user picks dark; the same value is in force after flipping back.
    live.theme = "dark";

    flipHybrid(seed.id);
    live = layout.nodes[seed.id];
    if (live?.kind !== "leaf") throw new Error("expected leaf");
    expect(live.showingBack).toBe(false);
    expect(live.tabs.map((t) => t.id)).toEqual(["f1"]);
    // Theme is unchanged across the flip.
    expect(live.theme).toBe("dark");
    // The `back` marker survives across flips; it signals "Hybrid" and
    // its shape is an empty object.
    expect(live.back).toEqual({});

    flipHybrid(seed.id);
    live = layout.nodes[seed.id];
    if (live?.kind !== "leaf") throw new Error("expected leaf");
    expect(live.showingBack).toBe(true);
    expect(live.tabs.map((t) => t.id)).toEqual(["f1"]);
    expect(live.theme).toBe("dark");
  });

  test("flipHybrid bumps the flip bus", async () => {
    // The flip bus triggers the orientation-change animation (Y-axis
    // rotation), distinct from the structural wobble (scale bounce used
    // for split/close/swap). The wobble bus must stay untouched on flip
    // so the two signals don't compound.
    const front = fileTab({ id: "fw", path: "wobble.md" });
    const seed = resetLayout([front]);
    const { paneFlip, paneWobble } = await import("./tabs.svelte");
    const beforeFlip = paneFlip.versions[seed.id] ?? 0;
    const beforeWobble = paneWobble.versions[seed.id] ?? 0;

    flipHybrid(seed.id);

    expect(paneFlip.versions[seed.id]).toBe(beforeFlip + 1);
    expect(paneWobble.versions[seed.id]).toBe(beforeWobble);
  });

  test("flipHybrid no-ops when the pane id doesn't resolve to a leaf", () => {
    const seed = resetLayout([fileTab({ id: "x", path: "x.md" })]);
    flipHybrid("does-not-exist");
    const live = layout.nodes[seed.id];
    if (live?.kind !== "leaf") throw new Error("expected leaf");
    expect(live.showingBack).toBeFalsy();
    expect(live.back).toBeUndefined();
  });

  test("flipHybrid is a no-op on an empty pane", async () => {
    // Guard reads `tabs.length === 0` before mutating state or bumping
    // the flip bus, so an empty pane never animates or flips.
    const seed = resetLayout([]);
    const { paneFlip } = await import("./tabs.svelte");
    const beforeFlip = paneFlip.versions[seed.id] ?? 0;

    flipHybrid(seed.id);

    const live = layout.nodes[seed.id];
    if (live?.kind !== "leaf") throw new Error("expected leaf");
    expect(live.tabs).toHaveLength(0);
    expect(live.showingBack).toBeFalsy();
    expect(live.back).toBeUndefined();
    expect(paneFlip.versions[seed.id] ?? 0).toBe(beforeFlip);
  });

  test("serialize / restore round-trips theme + showingBack + back marker", async () => {
    const front = fileTab({ id: "front", path: "front.md" });
    const seed = resetLayout([front]);

    flipHybrid(seed.id);
    const live = layout.nodes[seed.id];
    if (live?.kind !== "leaf") throw new Error("expected leaf");
    live.theme = "dark";

    const snapshot = serializeLayout();
    expect(snapshot).not.toBeNull();
    if (!snapshot) return;
    const json = JSON.stringify(snapshot);
    expect(json).toContain("\"sb\":1");
    expect(json).toContain("\"ht\":\"d\"");
    // No `bt` (back-side tabs) emitted.
    expect(json).not.toContain("\"bt\":");
    // No `hb` (back-side theme) emitted.
    expect(json).not.toContain("\"hb\":");
    // A flipped pane emits `bm` so the back marker survives the
    // round-trip even without a per-side theme.
    expect(json).toContain("\"bm\":1");

    await restoreLayout(snapshot);

    const restored = activePane();
    expect(restored.showingBack).toBe(true);
    expect(restored.theme).toBe("dark");
    expect(restored.tabs.map((t) => t.kind)).toEqual(["file"]);
    // `bm` round-trips the Hybrid marker; menu gating reads
    // `pane.back !== undefined`, so we assert it's set on restore.
    expect(restored.back).toEqual({});
  });

  test("legacy `hb` payload is accepted on rehydrate and dropped", async () => {
    // Old serializers emitted both `ht` (front) and `hb` (back)
    // per-side theme overrides. The front-side is canonical: `ht`
    // survives, `hb` is dropped. The presence of `hb` also implies
    // the pane was a Hybrid, so the back marker materialises.
    const front = fileTab({ id: "legacy-front", path: "legacy.md" });
    resetLayout([front]);

    const legacyLeaf = {
      k: "l" as const,
      t: [
        {
          id: "legacy-front",
          k: "f" as const,
          p: "legacy.md",
          a: 1 as const,
        },
      ],
      f: 1 as const,
      ht: "d" as const,
      hb: "l" as const,
      sb: 1 as const,
    };

    await restoreLayout(legacyLeaf as never);

    const restored = activePane();
    // Front-side theme wins; back-side `hb` ignored.
    expect(restored.theme).toBe("dark");
    expect(restored.showingBack).toBe(true);
    // Back marker materialises because the pane was a Hybrid.
    expect(restored.back).toEqual({});
  });

  test("focus changes never touch any pane's flip; flips are per-pane", () => {
    // The flip is a strictly per-pane boolean that ONLY flipHybrid
    // writes; setActivePane leaves every pane's flip untouched, so two
    // panes can be independently flipped and focus moves between them
    // preserve both states.
    const left = fileTab({ id: "left", path: "notes/left.md" });
    const right = fileTab({ id: "right", path: "notes/right.md" });
    const leftPane = resetLayout([left]);
    splitPane(leftPane.id, "row", "after");
    const root = layout.nodes[layout.rootId];
    if (root?.kind !== "split") throw new Error("expected split");
    const rightPaneId = root.b;
    const rightPane = layout.nodes[rightPaneId];
    if (rightPane?.kind !== "leaf") throw new Error("expected leaf");
    // The split's new pane is born clean: NOT flipped, even though
    // it was created while the focus was on a flipped pane.
    expect(rightPane.showingBack).toBeFalsy();
    rightPane.tabs.push(right);
    rightPane.activeTabId = right.id;

    // Flip the left pane.
    setActivePane(leftPane.id);
    flipHybrid(leftPane.id);
    const leftFlipped = layout.nodes[leftPane.id];
    if (leftFlipped?.kind !== "leaf") throw new Error("expected leaf");
    expect(leftFlipped.showingBack).toBe(true);

    // Focus the right pane: the left pane STAYS flipped (no coupling).
    setActivePane(rightPaneId);
    const leftAfterFocus = layout.nodes[leftPane.id];
    if (leftAfterFocus?.kind !== "leaf") throw new Error("expected leaf");
    expect(leftAfterFocus.showingBack).toBe(true);

    // Flip the right pane too: now BOTH panes are independently flipped.
    flipHybrid(rightPaneId);
    expect((layout.nodes[leftPane.id] as LeafNode).showingBack).toBe(true);
    expect((layout.nodes[rightPaneId] as LeafNode).showingBack).toBe(true);

    // Focus bouncing between them changes nothing.
    setActivePane(leftPane.id);
    setActivePane(rightPaneId);
    expect((layout.nodes[leftPane.id] as LeafNode).showingBack).toBe(true);
    expect((layout.nodes[rightPaneId] as LeafNode).showingBack).toBe(true);

    // Flipping one back is local to that pane.
    flipHybrid(leftPane.id);
    expect((layout.nodes[leftPane.id] as LeafNode).showingBack).toBe(false);
    expect((layout.nodes[rightPaneId] as LeafNode).showingBack).toBe(true);
  });
});

describe("find state", () => {
  test("reopening an already open find bar bumps the focus nonce", () => {
    const tab = fileTab();
    resetLayout([tab]);

    openFind(tab.id);
    const opened = activePane().tabs[0] as FileTab;
    expect(opened.find?.open).toBe(true);
    expect(opened.find?.focusNonce).toBe(1);

    openFind(tab.id);
    expect(opened.find?.open).toBe(true);
    expect(opened.find?.focusNonce).toBe(2);
  });
});

describe("terminal session serialization", () => {
  test("terminal activity marker is ephemeral session state", () => {
    const tab = terminalTab();

    setTerminalActivity(tab, true);
    expect(tab.terminalActivity).toBe(true);

    setTerminalActivity(tab, false);
    expect(tab.terminalActivity).toBeUndefined();
  });

  test("terminal rename staleness resets after restart marker update", () => {
    const tab = terminalTab({
      terminalSessionId: "term_123",
      terminalEnvTabName: "first",
    });

    renameTerminalTab(tab, "second");
    expect(terminalEnvTabNameStale(tab)).toBe(true);

    dismissTerminalEnvNamePrompt(tab);
    expect(tab.terminalEnvNamePromptDismissed).toBe(true);

    markTerminalEnvNameRestarted(tab);
    expect(terminalEnvTabNameStale(tab)).toBe(false);
    expect(tab.terminalEnvNamePromptDismissed).toBe(false);

    renameTerminalTab(tab, "third");
    expect(terminalEnvTabNameStale(tab)).toBe(true);
    expect(tab.terminalEnvNamePromptDismissed).toBe(false);
  });

  test("clearing a terminal session clears activity state", () => {
    const tab = terminalTab({
      terminalSessionId: "term_123",
      lastSeq: 99,
      terminalActivity: true,
    });

    clearTerminalSession(tab);

    expect(tab.terminalSessionId).toBeUndefined();
    expect(tab.lastSeq).toBeUndefined();
    expect(tab.terminalActivity).toBeUndefined();
  });

  test("keeps terminal session ids out of shareable layout hashes", () => {
    resetLayout([
      terminalTab({
        terminalSessionId: "term_123",
        lastSeq: 99,
      }),
    ]);

    const layoutSnapshot = serializeLayout();

    expect(JSON.stringify(layoutSnapshot)).not.toContain("term_123");
    expect(JSON.stringify(layoutSnapshot)).not.toContain("99");
  });

  test("round-trips terminal session ids without reload cursors", async () => {
    resetLayout([
      terminalTab({
        title: "build",
        terminalSessionId: "term_123",
        lastSeq: 99,
      }),
    ]);
    const layoutSnapshot = serializeLayout({ terminalSessions: true });
    expect(JSON.stringify(layoutSnapshot)).toContain("term_123");
    expect(JSON.stringify(layoutSnapshot)).not.toContain("99");

    await restoreLayout(layoutSnapshot!);

    const [tab] = activePane().tabs;
    expect(tab?.kind).toBe("terminal");
    if (tab?.kind !== "terminal") return;
    expect(tab.title).toBe("build");
    expect(tab.mcpEnv).toBe(true);
    expect(tab.sessionMcpEnv).toBe(true);
    expect(tab.terminalSessionId).toBe("term_123");
    expect(tab.lastSeq).toBeUndefined();
  });

  test("ignores legacy terminal sequence cursors on reload", async () => {
    await restoreLayout({
      k: "l",
      t: [{ k: "t", n: "build", tsid: "term_legacy", tseq: 99, a: 1 }],
      f: 1,
    });

    const [tab] = activePane().tabs;
    expect(tab?.kind).toBe("terminal");
    if (tab?.kind !== "terminal") return;
    expect(tab.terminalSessionId).toBe("term_legacy");
    expect(tab.lastSeq).toBeUndefined();
  });

  test("persists terminal MCP env opt-out only in session layouts", async () => {
    resetLayout([
      terminalTab({
        title: "plain",
        mcpEnv: false,
        sessionMcpEnv: false,
        terminalSessionId: "term_plain",
        lastSeq: 7,
      }),
    ]);

    const shareable = serializeLayout();
    expect(JSON.stringify(shareable)).not.toContain("\"me\"");
    expect(JSON.stringify(shareable)).not.toContain("\"sme\"");

    const sessionSnapshot = serializeLayout({ terminalSessions: true });
    expect(JSON.stringify(sessionSnapshot)).toContain("\"me\":0");
    expect(JSON.stringify(sessionSnapshot)).toContain("\"sme\":0");

    await restoreLayout(sessionSnapshot!);

    const [tab] = activePane().tabs;
    expect(tab?.kind).toBe("terminal");
    if (tab?.kind !== "terminal") return;
    expect(tab.mcpEnv).toBe(false);
    expect(tab.sessionMcpEnv).toBe(false);
    expect(tab.terminalSessionId).toBe("term_plain");
  });

  test("persists Team Work drafts only in session layouts", async () => {
    resetLayout([
      terminalTab({
        title: "prompt",
        teamWork: {
          buffer: "## plan\n\nship it",
          heightPx: 420,
          open: true,
          mode: "source",
        },
      }),
    ]);

    const shareable = serializeLayout();
    expect(JSON.stringify(shareable)).not.toContain("ship it");

    const sessionSnapshot = serializeLayout({ terminalSessions: true });
    expect(JSON.stringify(sessionSnapshot)).toContain("ship it");
    expect(JSON.stringify(sessionSnapshot)).toContain("\"rph\":420");
    expect(JSON.stringify(sessionSnapshot)).toContain("\"rpo\":1");
    expect(JSON.stringify(sessionSnapshot)).toContain("\"rpm\":\"s\"");

    await restoreLayout(sessionSnapshot!);

    const [tab] = activePane().tabs;
    expect(tab?.kind).toBe("terminal");
    if (tab?.kind !== "terminal") return;
    expect(tab.teamWork).toEqual({
      buffer: "## plan\n\nship it",
      heightPx: 420,
      open: true,
      mode: "source",
    });
  });

  test("round-trips Team Work workspace identity via session layout", async () => {
    resetLayout([
      terminalTab({
        title: "prompt",
        teamWork: {
          buffer: "",
          open: true,
          workspaceName: "team-work-2",
          submissionSequence: 3,
        },
      }),
    ]);

    const shareable = serializeLayout();
    expect(JSON.stringify(shareable)).not.toContain("team-work-2");

    const sessionSnapshot = serializeLayout({ terminalSessions: true });
    expect(JSON.stringify(sessionSnapshot)).toContain("\"rpn\":\"team-work-2\"");
    expect(JSON.stringify(sessionSnapshot)).toContain("\"rpsq\":3");

    await restoreLayout(sessionSnapshot!);

    const [tab] = activePane().tabs;
    expect(tab?.kind).toBe("terminal");
    if (tab?.kind !== "terminal") return;
    expect(tab.teamWork?.workspaceName).toBe("team-work-2");
    expect(tab.teamWork?.submissionSequence).toBe(3);
  });

  test("round-trips Team Work submitMode via SerTab.rpsm", async () => {
    // Per-prompt shell-vs-agent toggle survives session restore.
    // Agent mode emits the short-form "a"; shell mode omits the
    // field entirely so the persisted shape stays compact.
    resetLayout([
      terminalTab({
        terminalSessionId: "term_rpsm",
        teamWork: {
          buffer: "ship it",
          heightPx: 200,
          open: true,
          mode: "wysiwyg",
          submitMode: "agent",
        },
      }),
    ]);

    const sessionSnapshot = serializeLayout({ terminalSessions: true });
    expect(JSON.stringify(sessionSnapshot)).toContain("\"rpsm\":\"a\"");

    await restoreLayout(sessionSnapshot!);

    const [tab] = activePane().tabs;
    expect(tab?.kind).toBe("terminal");
    if (tab?.kind !== "terminal") return;
    expect(tab.teamWork?.submitMode).toBe("agent");
  });

  test("round-trips Team Work agent picker via SerTab.rpa", async () => {
    resetLayout([
      terminalTab({
        terminalSessionId: "term_rpa",
        teamWork: {
          buffer: "ship it",
          heightPx: 200,
          open: true,
          mode: "wysiwyg",
          agentTarget: "codex",
          submitMode: "agent",
        },
      }),
    ]);

    const sessionSnapshot = serializeLayout({ terminalSessions: true });
    expect(JSON.stringify(sessionSnapshot)).toContain("\"rpa\":\"x\"");

    await restoreLayout(sessionSnapshot!);

    const [tab] = activePane().tabs;
    expect(tab?.kind).toBe("terminal");
    if (tab?.kind !== "terminal") return;
    expect(tab.teamWork?.agentTarget).toBe("codex");
    expect(tab.teamWork?.submitMode).toBe("agent");
  });

  test("omits rpsm from SerTab when submitMode is shell or absent", async () => {
    // Shell is the default; omitting the field keeps the persisted
    // shape compact. Absence reads as shell.
    resetLayout([
      terminalTab({
        terminalSessionId: "term_rpsm_default",
        teamWork: {
          buffer: "default prompt",
          heightPx: 200,
          open: true,
          mode: "wysiwyg",
        },
      }),
    ]);

    const sessionSnapshot = serializeLayout({ terminalSessions: true });
    expect(JSON.stringify(sessionSnapshot)).not.toContain("\"rpsm\"");

    resetLayout([
      terminalTab({
        terminalSessionId: "term_rpsm_shell",
        teamWork: {
          buffer: "explicit shell",
          heightPx: 200,
          open: true,
          mode: "wysiwyg",
          submitMode: "shell",
        },
      }),
    ]);

    const sessionSnapshot2 = serializeLayout({ terminalSessions: true });
    expect(JSON.stringify(sessionSnapshot2)).not.toContain("\"rpsm\"");
  });

  test("round-trips per-prompt page-width via SerTab.rppw", async () => {
    // Each Team Work prompt carries its own page-width ratio so
    // narrowing one prompt does not cascade onto a sibling tile.
    // The value persists across session restore.
    resetLayout([
      terminalTab({
        terminalSessionId: "term_rppw",
        teamWork: {
          buffer: "narrow prompt draft",
          heightPx: 320,
          open: true,
          mode: "wysiwyg",
          pageWidthRatio: 0.55,
        },
      }),
    ]);

    const shareable = serializeLayout();
    expect(JSON.stringify(shareable)).not.toContain("\"rppw\"");

    const sessionSnapshot = serializeLayout({ terminalSessions: true });
    expect(JSON.stringify(sessionSnapshot)).toContain("\"rppw\":0.55");

    await restoreLayout(sessionSnapshot!);

    const [tab] = activePane().tabs;
    expect(tab?.kind).toBe("terminal");
    if (tab?.kind !== "terminal") return;
    expect(tab.teamWork?.pageWidthRatio).toBe(0.55);
  });

  test("omits rppw from SerTab when pageWidthRatio is unset or 100%", async () => {
    // 1.0 is the "no cap" sentinel; it rounds to absent so
    // the persisted shape stays short for the common case.
    resetLayout([
      terminalTab({
        terminalSessionId: "term_full",
        teamWork: {
          buffer: "default prompt",
          heightPx: 320,
          open: true,
          mode: "wysiwyg",
          pageWidthRatio: 1.0,
        },
      }),
    ]);

    const sessionSnapshot = serializeLayout({ terminalSessions: true });
    expect(JSON.stringify(sessionSnapshot)).not.toContain("\"rppw\"");
  });

  test("hydrates terminal session ids onto hash-restored terminal tabs", async () => {
    resetLayout([
      terminalTab({
        title: "build",
        terminalSessionId: "term_abc",
        lastSeq: 42,
      }),
    ]);
    const sessionLayout = serializeLayout({ terminalSessions: true });
    const hashLayout = serializeLayout();

    await restoreLayout(hashLayout!);
    hydrateTerminalSessionsFromLayout(sessionLayout);

    const [tab] = activePane().tabs;
    expect(tab?.kind).toBe("terminal");
    if (tab?.kind !== "terminal") return;
    expect(tab.title).toBe("build");
    expect(tab.terminalSessionId).toBe("term_abc");
    expect(tab.lastSeq).toBeUndefined();
  });

  test("hydrates terminal session ids during restore before mount-time reads", async () => {
    resetLayout([
      terminalTab({
        title: "build",
        terminalSessionId: "term_pre_mount",
        lastSeq: 77,
      }),
    ]);
    const sessionLayout = serializeLayout({ terminalSessions: true });
    const hashLayout = serializeLayout();

    const restored = restoreLayout(hashLayout!, sessionLayout);
    const [tab] = activePane().tabs;
    expect(tab?.kind).toBe("terminal");
    if (tab?.kind !== "terminal") return;
    expect(tab.terminalSessionId).toBe("term_pre_mount");
    expect(tab.lastSeq).toBeUndefined();

    await restored;
  });
});

describe("tab labels", () => {
  test("keeps unique basenames plain", () => {
    const a = fileTab({ id: "a", path: "notes/foo.md" });
    const b = fileTab({ id: "b", path: "notes/bar.md" });
    const tabs = [a, b];

    expect(tabLabelInPane(a, tabs)).toBe("foo.md");
    expect(tabLabelInPane(b, tabs)).toBe("bar.md");
  });

  test("uses direct parent segments for shallow duplicates", () => {
    const a = fileTab({ id: "a", path: "a/foo.md" });
    const b = fileTab({ id: "b", path: "b/foo.md" });
    const tabs = [a, b];

    expect(tabLabelInPane(a, tabs)).toBe("a/foo.md");
    expect(tabLabelInPane(b, tabs)).toBe("b/foo.md");
  });

  test("drops shared prefix before choosing a divergent ancestor", () => {
    const a = fileTab({ id: "a", path: "a/x/foo.md" });
    const b = fileTab({ id: "b", path: "a/y/foo.md" });
    const tabs = [a, b];

    expect(tabLabelInPane(a, tabs)).toBe("x/foo.md");
    expect(tabLabelInPane(b, tabs)).toBe("y/foo.md");
  });

  test("drops deeper shared prefixes", () => {
    const a = fileTab({ id: "a", path: "a/x/p/foo.md" });
    const b = fileTab({ id: "b", path: "a/x/q/foo.md" });
    const tabs = [a, b];

    expect(tabLabelInPane(a, tabs)).toBe("p/foo.md");
    expect(tabLabelInPane(b, tabs)).toBe("q/foo.md");
  });

  test("collapses deeper divergent tails", () => {
    const a = fileTab({ id: "a", path: "a/x/p/foo.md" });
    const b = fileTab({ id: "b", path: "a/y/q/foo.md" });
    const tabs = [a, b];

    expect(tabLabelInPane(a, tabs)).toBe("x/[...]/foo.md");
    expect(tabLabelInPane(b, tabs)).toBe("y/[...]/foo.md");
  });

  test("re-collapses when the conflicting tab leaves the pane", () => {
    const a = fileTab({ id: "a", path: "a/foo.md" });
    const b = fileTab({ id: "b", path: "b/foo.md" });
    const tabs = [a, b];

    expect(tabLabelInPane(a, tabs)).toBe("a/foo.md");
    expect(tabLabelInPane(a, [a])).toBe("foo.md");
  });
});

describe("file tab loading", () => {
  test("focuses a loading tab before the file fetch resolves", async () => {
    resetLayout([]);
    let resolveRead: (value: Awaited<ReturnType<typeof api.readStream>>) => void = () => {};
    vi.spyOn(api, "readStream").mockReturnValue(
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
    );

    const opened = openInPane(activePane().id, "notes/slow.md");
    const pane = activePane();
    const [tab] = pane.tabs;

    expect(tab?.kind).toBe("file");
    if (tab?.kind !== "file") return;
    expect(pane.activeTabId).toBe(tab.id);
    expect(tab.loading).toBe(true);
    expect(tab.content).toBe("");

    resolveRead({
      path: "notes/slow.md",
      content: "# loaded",
      mtime: 10,
      writable: true,
    });
    await opened;

    expect(tab.loading).toBe(false);
    expect(tab.content).toBe("# loaded");
    expect(tab.error).toBeNull();
  });

  test("accumulates streamed chunks while keeping the tab loading", async () => {
    resetLayout([]);
    let finish: () => void = () => {};
    vi.spyOn(api, "readStream").mockImplementation(async (_path, opts) => {
      opts?.onMeta?.({
        path: "notes/slow.md",
        mtime: 10,
        mtime_ns: "10",
        writable: true,
        size: 9,
      });
      opts?.onChunk?.("# part", { loadedBytes: 6, totalBytes: 9 });
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      opts?.onChunk?.("ial", { loadedBytes: 9, totalBytes: 9 });
      return {
        path: "notes/slow.md",
        content: "# partial",
        mtime: 10,
        mtime_ns: "10",
        writable: true,
      };
    });

    const opened = openInPane(activePane().id, "notes/slow.md");
    const pane = activePane();
    const [tab] = pane.tabs;
    expect(tab?.kind).toBe("file");
    if (tab?.kind !== "file") return;

    await vi.waitFor(() => expect(tab.content).toBe("# part"));
    expect(tab.loading).toBe(true);
    expect(tab.loadProgress).toEqual({ loadedBytes: 6, totalBytes: 9 });

    finish();
    await opened;
    expect(tab.loading).toBe(false);
    expect(tab.content).toBe("# partial");
    expect(tab.saved).toBe("# partial");
    expect(tab.savedMtimeNs).toBe("10");
    expect(tab.loadProgress).toBeUndefined();
  });

  test("keeps load failures inside the destination tab", async () => {
    resetLayout([]);
    vi.spyOn(api, "readStream").mockRejectedValue(new Error("read failed"));

    await openInPane(activePane().id, "notes/bad.md");
    const pane = activePane();
    const [tab] = pane.tabs;

    expect(tab?.kind).toBe("file");
    if (tab?.kind !== "file") return;
    expect(pane.activeTabId).toBe(tab.id);
    expect(tab.loading).toBe(false);
    expect(tab.error).toBe("read failed");
    expect(tab.fileMissing).toBeNull();
  });

  test("classifies missing files as a recovery state", async () => {
    resetLayout([]);
    vi.spyOn(api, "readStream").mockRejectedValue(
      new Error("io error: No such file or directory (os error 2)"),
    );

    await openInPane(activePane().id, "notes/moved.md");
    const pane = activePane();
    const [tab] = pane.tabs;

    expect(tab?.kind).toBe("file");
    if (tab?.kind !== "file") return;
    expect(tab.loading).toBe(false);
    expect(tab.error).toBeNull();
    expect(tab.fileMissing).toEqual({ path: "notes/moved.md", fragment: null });
  });

  test("recognizes common missing-file error strings", () => {
    expect(isMissingFileError(new Error("ENOENT: no such file or directory"))).toBe(
      true,
    );
    expect(isMissingFileError(new Error("permission denied"))).toBe(false);
  });

  test("rebinds a missing tab to the next opened file after re-open starts", async () => {
    const tab = fileTab({
      id: "missing",
      path: "notes/old.md",
      content: "old content",
      saved: "old content",
      fileMissing: { path: "notes/old.md", fragment: "old content" },
    });
    resetLayout([tab]);
    vi.spyOn(api, "readStream").mockResolvedValue({
      path: "notes/new.md",
      content: "new content",
      mtime: 22,
      writable: true,
    });

    beginMissingFileReopen(tab.id);
    await openInPane(activePane().id, "notes/new.md");

    expect(activePane().tabs).toHaveLength(1);
    const [reopened] = activePane().tabs;
    expect(reopened?.kind).toBe("file");
    if (reopened?.kind !== "file") return;
    expect(reopened.path).toBe("notes/new.md");
    expect(reopened.content).toBe("new content");
    expect(reopened.saved).toBe("new content");
    expect(reopened.fileMissing).toBeNull();
    expect(reopened.error).toBeNull();
  });
});

describe("terminal tab naming", () => {
  test("opens new terminals with enumerated names", () => {
    const pane = resetLayout([
      terminalTab({ id: "term-existing", title: "Terminal-3" }),
      terminalTab({ id: "term-build", title: "build" }),
    ]);

    openTerminalInPane(pane.id);

    const created = activePane().tabs.at(-1);
    expect(created?.kind).toBe("terminal");
    if (created?.kind !== "terminal") return;
    expect(created.title).toBe("Terminal-4");
  });

  test("tracks stale CHAN_TAB_NAME after renaming a live terminal", () => {
    const tab = terminalTab({ title: "build" });
    resetLayout([tab]);

    setTerminalSession(tab, "term_live", 0, true);
    expect(tab.terminalEnvTabName).toBe("build");
    expect(terminalEnvTabNameStale(tab)).toBe(false);

    renameTerminalTab(tab, "deploy");

    expect(terminalEnvTabNameStale(tab)).toBe(true);
    expect(tab.terminalEnvNamePromptDismissed).toBe(false);

    dismissTerminalEnvNamePrompt(tab);
    expect(tab.terminalEnvNamePromptDismissed).toBe(true);

    renameTerminalTab(tab, "ship");
    expect(tab.terminalEnvNamePromptDismissed).toBe(false);

    setTerminalSession(tab, "term_new", 0, true);
    expect(tab.terminalEnvTabName).toBe("ship");
    expect(terminalEnvTabNameStale(tab)).toBe(false);
  });
});

describe("autosave", () => {
  test("does not save partial content while a stream is loading", async () => {
    vi.useFakeTimers();
    const tab = fileTab({
      content: "# partial",
      saved: "",
      loading: true,
    });
    const pane = resetLayout([tab]);
    const write = vi.spyOn(api, "write").mockResolvedValue({
      mtime: 2,
      mtime_ns: "2000000002",
    });

    scheduleAutosave(pane.id, tab.id);
    await vi.advanceTimersByTimeAsync(800);

    expect(write).not.toHaveBeenCalled();
  });

  test("strips trailing whitespace on save when the preference is enabled", async () => {
    editorToolsPrefs.stripTrailingWhitespaceOnSave = true;
    const tab = fileTab({
      content: "a  \n\tb\t\n",
      saved: "",
      savedMtime: 1,
      savedMtimeNs: "1000000001",
    });
    resetLayout([tab]);
    const write = vi
      .spyOn(api, "write")
      .mockResolvedValue({ mtime: 2, mtime_ns: "2000000002" });

    await saveTab(tab);

    expect(write).toHaveBeenCalledWith("notes/a.md", "a\n\tb\n", "1000000001", 1);
    expect(tab.content).toBe("a\n\tb\n");
    expect(tab.saved).toBe("a\n\tb\n");
    expect(tab.savedMtimeNs).toBe("2000000002");
  });

  test("serializes overlapping saves and keeps edits after an in-flight save dirty", async () => {
    vi.useFakeTimers();
    const tab = fileTab({
      content: "v1",
      saved: "base",
      savedMtime: 1,
      savedMtimeNs: "1000000001",
    });
    const pane = resetLayout([tab]);
    const calls: string[] = [];
    const tokens: Array<string | null | undefined> = [];
    const pending: Array<(value: { mtime: number; mtime_ns: string }) => void> = [];
    vi.spyOn(api, "write").mockImplementation(async (_path, content, expectedMtimeNs) => {
      calls.push(content);
      tokens.push(expectedMtimeNs);
      return new Promise((resolve) => pending.push(resolve));
    });

    const firstSave = saveTab(tab);
    await Promise.resolve();
    expect(calls).toEqual(["v1"]);

    tab.content = "v2";
    scheduleAutosave(pane.id, tab.id);
    await vi.advanceTimersByTimeAsync(800);
    expect(calls).toEqual(["v1"]);

    pending.shift()!({ mtime: 2, mtime_ns: "2000000002" });
    await vi.waitFor(() => expect(calls).toEqual(["v1", "v2"]));

    pending.shift()!({ mtime: 3, mtime_ns: "3000000003" });
    await firstSave;
    expect(tokens).toEqual(["1000000001", "2000000002"]);
    expect(tab.saved).toBe("v2");
    expect(tab.savedMtime).toBe(3);
    expect(tab.savedMtimeNs).toBe("3000000003");
  });
});

describe("terminal broadcast groups", () => {
  test("target selection updates the single window-wide group", () => {
    const a = terminalTab({ id: "term-a", title: "A" });
    const b = terminalTab({ id: "term-b", title: "B" });
    const c = terminalTab({ id: "term-c", title: "C" });
    resetLayout([a, b, c]);
    const tab = (id: string) =>
      activePane().tabs.find((candidate) => candidate.id === id) as TerminalTab;

    setTerminalBroadcastEnabled(tab("term-a"), true);
    setTerminalBroadcastTarget(tab("term-a"), "term-b", true);

    expect(terminalBroadcastMemberIds(tab("term-a")).sort()).toEqual(["term-a", "term-b"]);
    expect(terminalBroadcastMemberIds(tab("term-b")).sort()).toEqual(["term-a", "term-b"]);
    expect(tab("term-c").broadcastEnabled).toBe(false);

    setTerminalBroadcastTarget(tab("term-b"), "term-c", true);

    expect(terminalBroadcastMemberIds(tab("term-a")).sort()).toEqual([
      "term-a",
      "term-b",
      "term-c",
    ]);
    expect(terminalBroadcastMemberIds(tab("term-b")).sort()).toEqual([
      "term-a",
      "term-b",
      "term-c",
    ]);
    expect(tab("term-c").broadcastEnabled).toBe(true);
  });

  test("select-all toggle flips the whole group on the active terminal", () => {
    const a = terminalTab({ id: "term-a", title: "A" });
    const b = terminalTab({ id: "term-b", title: "B" });
    const c = terminalTab({ id: "term-c", title: "C" });
    resetLayout([a, b, c]); // term-a is the active terminal
    const tab = (id: string) =>
      activePane().tabs.find((candidate) => candidate.id === id) as TerminalTab;

    // Nothing selected -> first toggle SELECTS ALL (self + every peer).
    toggleActiveTerminalBroadcastSelectAll();
    expect(tab("term-a").broadcastEnabled).toBe(true);
    expect(terminalBroadcastMemberIds(tab("term-a")).sort()).toEqual([
      "term-a",
      "term-b",
      "term-c",
    ]);

    // All selected -> second toggle DESELECTS ALL.
    toggleActiveTerminalBroadcastSelectAll();
    expect(tab("term-a").broadcastEnabled).toBe(false);
    expect(terminalBroadcastMemberIds(tab("term-a"))).not.toContain("term-b");
    expect(terminalBroadcastMemberIds(tab("term-a"))).not.toContain("term-c");
  });

  test("peer removal updates the group", () => {
    const a = terminalTab({ id: "term-a", title: "A" });
    const b = terminalTab({ id: "term-b", title: "B" });
    const c = terminalTab({ id: "term-c", title: "C" });
    resetLayout([a, b, c]);
    const tab = (id: string) =>
      activePane().tabs.find((candidate) => candidate.id === id) as TerminalTab;

    setTerminalBroadcastEnabled(tab("term-a"), true);
    setTerminalBroadcastTarget(tab("term-a"), "term-b", true);
    setTerminalBroadcastTarget(tab("term-a"), "term-c", true);

    removeTerminalFromBroadcastGroup(tab("term-a"), "term-c");

    expect(terminalBroadcastMemberIds(tab("term-a")).sort()).toEqual(["term-a", "term-b"]);
    expect(terminalBroadcastMemberIds(tab("term-b")).sort()).toEqual(["term-a", "term-b"]);
    expect(tab("term-c").broadcastEnabled).toBe(false);

    removeTerminalFromBroadcastGroup(tab("term-a"), "term-b");

    expect(tab("term-a").broadcastEnabled).toBe(true);
    expect(tab("term-b").broadcastEnabled).toBe(false);
    expect(tab("term-c").broadcastEnabled).toBe(false);
  });

  test("removed terminal can rejoin through its own always-live toggle", () => {
    const a = terminalTab({ id: "term-a", title: "A" });
    const b = terminalTab({ id: "term-b", title: "B" });
    const c = terminalTab({ id: "term-c", title: "C" });
    resetLayout([a, b, c]);
    const tab = (id: string) =>
      activePane().tabs.find((candidate) => candidate.id === id) as TerminalTab;

    setTerminalBroadcastEnabled(tab("term-a"), true);
    setTerminalBroadcastEnabled(tab("term-b"), true);
    setTerminalBroadcastEnabled(tab("term-c"), true);

    removeTerminalFromBroadcastGroup(tab("term-a"), "term-b");

    expect(tab("term-b").broadcastEnabled).toBe(false);
    expect(terminalBroadcastMemberIds(tab("term-b")).sort()).toEqual(["term-a", "term-c"]);

    setTerminalBroadcastEnabled(tab("term-b"), true);

    expect(tab("term-b").broadcastEnabled).toBe(true);
    expect(terminalBroadcastMemberIds(tab("term-a")).sort()).toEqual([
      "term-a",
      "term-b",
      "term-c",
    ]);
  });

  test("broadcast fans out to every in-group peer", () => {
    const a = terminalTab({ id: "term-a", title: "A" });
    const b = terminalTab({ id: "term-b", title: "B" });
    const c = terminalTab({ id: "term-c", title: "C" });
    resetLayout([a, b, c]);
    const tab = (id: string) =>
      activePane().tabs.find((candidate) => candidate.id === id) as TerminalTab;
    const received: string[] = [];
    const unregisterA = registerTerminalInputSink("term-a", (data) => received.push(`a:${data}`));
    const unregisterB = registerTerminalInputSink("term-b", (data) => received.push(`b:${data}`));
    const unregisterC = registerTerminalInputSink("term-c", (data) => received.push(`c:${data}`));

    setTerminalBroadcastEnabled(tab("term-a"), true);
    setTerminalBroadcastTarget(tab("term-a"), "term-b", true);
    setTerminalBroadcastTarget(tab("term-a"), "term-c", true);

    broadcastTerminalInput(tab("term-a"), "one");
    expect(received).toEqual(["b:one", "c:one"]);
    expect(terminalBroadcastMemberIds(tab("term-c")).sort()).toEqual([
      "term-a",
      "term-b",
      "term-c",
    ]);

    setTerminalBroadcastEnabled(tab("term-c"), false);
    broadcastTerminalInput(tab("term-a"), "two");
    expect(received).toEqual(["b:one", "c:one", "b:two"]);

    unregisterA();
    unregisterB();
    unregisterC();
  });

  test("select-all and deselect-all keep membership binary", () => {
    const a = terminalTab({ id: "term-a", title: "A" });
    const b = terminalTab({ id: "term-b", title: "B" });
    const c = terminalTab({ id: "term-c", title: "C" });
    resetLayout([a, b, c]);
    const tab = (id: string) =>
      activePane().tabs.find((candidate) => candidate.id === id) as TerminalTab;

    setTerminalBroadcastEnabled(tab("term-a"), true);
    for (const target of ["term-b", "term-c"]) {
      setTerminalBroadcastTarget(tab("term-a"), target, true);
    }
    expect(terminalBroadcastMemberIds(tab("term-a")).sort()).toEqual([
      "term-a",
      "term-b",
      "term-c",
    ]);

    for (const target of ["term-b", "term-c"]) {
      setTerminalBroadcastTarget(tab("term-a"), target, false);
    }
    expect(terminalBroadcastMemberIds(tab("term-a")).sort()).toEqual(["term-a"]);
    expect(tab("term-b").broadcastEnabled).toBe(false);
    expect(tab("term-c").broadcastEnabled).toBe(false);

    setTerminalBroadcastEnabled(tab("term-c"), true);
    expect(terminalBroadcastMemberIds(tab("term-a")).sort()).toEqual(["term-a", "term-c"]);
  });

  test("broadcast skips target ids outside this window layout", () => {
    const a = terminalTab({
      id: "term-a",
      title: "A",
      broadcastEnabled: true,
      broadcastTargetIds: ["term-a", "term-b"],
    });
    resetLayout([a]);
    const received: string[] = [];
    const unregisterA = registerTerminalInputSink("term-a", (data) => received.push(`a:${data}`));
    // Simulates another window: a live sink id exists, but no tab with
    // that id is present in this window's layout registry.
    const unregisterB = registerTerminalInputSink("term-b", (data) => received.push(`b:${data}`));

    broadcastTerminalInput(a, "one");

    expect(received).toEqual([]);

    unregisterA();
    unregisterB();
  });
});

describe("truncateTabTitle", () => {
  test("empty string passes through", () => {
    expect(truncateTabTitle("")).toBe("");
  });

  test("short names render as-is", () => {
    expect(truncateTabTitle("short.md")).toBe("short.md");
  });

  test("name at the cap renders as-is (no elision)", () => {
    const at = "exactly15chars.";
    expect(at.length).toBe(TAB_TITLE_MAX_LENGTH);
    expect(truncateTabTitle(at)).toBe(at);
  });

  test("16-char name triggers elision and lands at exactly 15", () => {
    const src = "sixteen-chars-md"; // 16 chars
    const out = truncateTabTitle(src);
    expect(out).toBe("sixtee[..]rs-md");
    expect(out.length).toBe(TAB_TITLE_MAX_LENGTH);
  });

  test("long filename preserves the extension via the tail bias", () => {
    // `.svelte` is the marquee long-extension case.
    const src = "verylongfilename.svelte"; // 23 chars
    const out = truncateTabTitle(src);
    expect(out).toBe("verylo[..]velte");
    expect(out.length).toBe(TAB_TITLE_MAX_LENGTH);
  });

  test("multi-codepoint characters survive without splitting", () => {
    // Star emoji (`⭐`) is BMP, but `🌟` (glowing star) is supplementary
    // and needs a surrogate pair. We seed the head + tail with one
    // so a naive `slice` on code units would split it.
    const src = "🌟abcdefghij🌟klmnop";
    const out = truncateTabTitle(src);
    // 6 head code points + `[..]` + 5 tail code points = 15
    // visible characters, with the surrogate pairs preserved
    // intact.
    expect(Array.from(out)).toHaveLength(TAB_TITLE_MAX_LENGTH);
    expect(out.startsWith("🌟abcde")).toBe(true);
    expect(out.endsWith("lmnop")).toBe(true);
  });
});

describe("graphTitle", () => {
  // Titles carry a `kind=` prefix (`path=` / `tag=` / `contact=` / `lang=`)
  // so the tab strip surfaces the lens shape next to the payload.
  test("workspace scope reads as 'path=workspace'", () => {
    expect(graphTitle("semantic", "workspace")).toBe("path=workspace");
    expect(graphTitle("filesystem", "workspace")).toBe("path=workspace");
    expect(graphTitle("semantic", "global")).toBe("path=workspace");
  });

  test("file: scope reads as 'path=<basename>'", () => {
    expect(graphTitle("semantic", "file:notes/sub/foo.md")).toBe("path=foo.md");
    expect(graphTitle("semantic", "file:README.md")).toBe("path=README.md");
    // File at the workspace root with no path falls back to 'path=workspace'.
    expect(graphTitle("semantic", "file:")).toBe("path=workspace");
  });

  test("dir: scope reads as 'path=<basename>/'", () => {
    expect(graphTitle("semantic", "dir:notes/sub")).toBe("path=sub/");
    expect(graphTitle("semantic", "dir:notes")).toBe("path=notes/");
    // dir: with no path is treated as the workspace root.
    expect(graphTitle("semantic", "dir:")).toBe("path=workspace");
  });

  test("tag: scope reads as 'tag=#<name>'", () => {
    expect(graphTitle("semantic", "tag:#search")).toBe("tag=#search");
    // Tag without the leading # gets one prepended (then the kind prefix).
    expect(graphTitle("semantic", "tag:foo")).toBe("tag=#foo");
  });

  test("contact: scope reads as 'contact=<basename>'", () => {
    expect(graphTitle("semantic", "contact:alice")).toBe("contact=alice");
    // Workspace-relative contact paths peel to the file basename.
    expect(graphTitle("semantic", "contact:Contacts/alice.md")).toBe("contact=alice.md");
  });

  test("language: scope reads as 'lang=<name>'", () => {
    expect(graphTitle("semantic", "language:rust")).toBe("lang=rust");
    expect(graphTitle("semantic", "language:typescript")).toBe("lang=typescript");
  });

  test("git_repo: scope renders the repo basename", () => {
    expect(graphTitle("semantic", "git_repo:project/chan")).toBe("chan");
  });

  test("language mode keeps its dedicated label regardless of scope", () => {
    expect(graphTitle("language", "workspace")).toBe("Languages");
    expect(graphTitle("language", "file:foo.md")).toBe("Languages");
  });

  test("unknown prefix peels the payload after the first colon", () => {
    expect(graphTitle("semantic", "weird:abc")).toBe("abc");
    // Truly unknown shape (no colon) falls through to the raw value.
    expect(graphTitle("semantic", "raw-thing")).toBe("raw-thing");
  });
});

describe("browserTabLabel", () => {
  function browserTab(overrides: Partial<BrowserTab> = {}): BrowserTab {
    return {
      kind: "browser",
      id: "br-1",
      title: "Files",
      inspectorOpen: false,
      ...overrides,
    };
  }

  test("no selection renders workspace label + trailing slash", () => {
    expect(browserTabLabel(browserTab({ selected: null }), { workspaceName: "chan" })).toBe("chan/");
    expect(browserTabLabel(browserTab({ selected: undefined }), { workspaceName: "chan" })).toBe("chan/");
    expect(browserTabLabel(browserTab({ selected: "" }), { workspaceName: "chan" })).toBe("chan/");
    expect(browserTabLabel(browserTab({ selected: "   " }), { workspaceName: "chan" })).toBe("chan/");
  });

  test("no selection without workspace label falls back to tab title + slash", () => {
    expect(browserTabLabel(browserTab({ selected: null }))).toBe("Files/");
    expect(browserTabLabel(browserTab({ selected: "" }))).toBe("Files/");
  });

  test("file at workspace root renders workspace label + slash", () => {
    expect(
      browserTabLabel(browserTab({ selected: "README.md" }), {
        workspaceName: "notes",
        selectedIsDir: false,
      }),
    ).toBe("notes/");
  });

  test("file inside a subdir renders the parent dir + slash", () => {
    expect(
      browserTabLabel(browserTab({ selected: "foo/bar/baz.md" }), {
        workspaceName: "notes",
        selectedIsDir: false,
      }),
    ).toBe("bar/");
    expect(
      browserTabLabel(browserTab({ selected: "notes/today.md" }), {
        workspaceName: "workspace",
        selectedIsDir: false,
      }),
    ).toBe("notes/");
  });

  test("directory selection renders that dir + slash", () => {
    expect(
      browserTabLabel(browserTab({ selected: "notes/sub" }), {
        workspaceName: "workspace",
        selectedIsDir: true,
      }),
    ).toBe("sub/");
    expect(
      browserTabLabel(browserTab({ selected: "notes/sub/" }), {
        workspaceName: "workspace",
        selectedIsDir: true,
      }),
    ).toBe("sub/");
  });

  test("trailing slash without explicit isDir falls back to dir semantics", () => {
    expect(browserTabLabel(browserTab({ selected: "notes/sub/" }))).toBe("sub/");
  });

  test("two browser tabs with different selections produce different labels", () => {
    const a = browserTab({ id: "br-a", selected: "a.md" });
    const b = browserTab({ id: "br-b", selected: "notes/b.md" });
    expect(browserTabLabel(a, { workspaceName: "workspace", selectedIsDir: false })).toBe("workspace/");
    expect(browserTabLabel(b, { workspaceName: "workspace", selectedIsDir: false })).toBe("notes/");
  });

  test("tabLabel routes browser tabs through browserTabLabel", () => {
    expect(
      tabLabel(browserTab({ selected: "notes/today.md" }), {
        workspaceName: "workspace",
        selectedIsDir: false,
      }),
    ).toBe("notes/");
    expect(tabLabel(browserTab({ selected: null }), { workspaceName: "workspace" })).toBe("workspace/");
  });
});

describe("graphTabLabel", () => {
  function graphTab(overrides: Partial<GraphTab> = {}): GraphTab {
    return {
      kind: "graph",
      id: "g-1",
      title: "workspace",
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
      ...overrides,
    };
  }

  test("no selection falls back to the scope-derived title", () => {
    expect(graphTabLabel(graphTab({ title: "workspace" }))).toBe("workspace");
    expect(graphTabLabel(graphTab({ title: "foo.md" }))).toBe("foo.md");
    expect(graphTabLabel(graphTab({ selectedNodeLabel: null }))).toBe("workspace");
    expect(graphTabLabel(graphTab({ selectedNodeLabel: "   " }))).toBe("workspace");
  });

  test("selection label wins over the scope title", () => {
    // Titles without an `=` (bare-string shape) fall back to the raw
    // selectedNodeLabel.
    expect(
      graphTabLabel(
        graphTab({
          title: "workspace",
          selectedNodeId: "notes/foo.md",
          selectedNodeLabel: "foo.md",
        }),
      ),
    ).toBe("foo.md");
    expect(
      graphTabLabel(
        graphTab({
          title: "workspace",
          selectedNodeId: "#search",
          selectedNodeLabel: "#search",
        }),
      ),
    ).toBe("#search");
  });

  test("kind= prefix from graphTitle survives node selection", () => {
    // The tab strip keeps showing path= / tag= / contact= / lang=
    // even after the user taps a node. graphTitle() seeds tab.title
    // with that prefix; graphTabLabel preserves it.
    expect(
      graphTabLabel(
        graphTab({
          title: "path=workspace",
          selectedNodeId: "notes/foo.md",
          selectedNodeLabel: "foo.md",
        }),
      ),
    ).toBe("path=foo.md");
    expect(
      graphTabLabel(
        graphTab({
          title: "tag=#search",
          selectedNodeId: "notes/a.md",
          selectedNodeLabel: "a.md",
        }),
      ),
    ).toBe("tag=a.md");
    expect(
      graphTabLabel(
        graphTab({
          title: "contact=alice.md",
          selectedNodeId: "notes/b.md",
          selectedNodeLabel: "b.md",
        }),
      ),
    ).toBe("contact=b.md");
    expect(
      graphTabLabel(
        graphTab({
          title: "lang=Rust",
          selectedNodeId: "crates/foo/src/lib.rs",
          selectedNodeLabel: "lib.rs",
        }),
      ),
    ).toBe("lang=lib.rs");
    // `Languages` top-level overview (mode === "language") has no
    // `=`; selection still renders the bare label.
    expect(
      graphTabLabel(
        graphTab({
          title: "Languages",
          mode: "language",
          selectedNodeLabel: "Rust",
        }),
      ),
    ).toBe("Rust");
  });

  test("tabLabel routes graph tabs through graphTabLabel", () => {
    expect(
      tabLabel(graphTab({ title: "workspace", selectedNodeLabel: "Miguel" })),
    ).toBe("Miguel");
    expect(tabLabel(graphTab({ title: "foo.md" }))).toBe("foo.md");
    expect(
      tabLabel(graphTab({ title: "path=workspace", selectedNodeLabel: "Miguel" })),
    ).toBe("path=Miguel");
  });
});

describe("terminal unseen-output dot pulse", () => {
  test("pulse tracks active output; output stop holds the dot solid; seeing clears both", () => {
    const tab = terminalTab();
    // Output arriving at an unfocused terminal: dot shows + pulses.
    setTerminalActivity(tab, true);
    setTerminalActivityPulsing(tab, true);
    expect(tab.terminalActivity).toBe(true);
    expect(tab.terminalActivityPulsing).toBe(true);
    // Output stops but is still unseen: pulse off, dot stays solid.
    setTerminalActivityPulsing(tab, false);
    expect(tab.terminalActivity).toBe(true);
    expect(tab.terminalActivityPulsing).toBeUndefined();
    // Seeing the terminal clears BOTH (the dot is gone, not left mid-pulse).
    setTerminalActivityPulsing(tab, true);
    setTerminalActivity(tab, false);
    expect(tab.terminalActivity).toBeUndefined();
    expect(tab.terminalActivityPulsing).toBeUndefined();
  });
});
