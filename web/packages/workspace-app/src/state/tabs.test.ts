// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../api/client";
import { ApiError } from "../api/errors";
import { confirmState, resolveConfirm } from "./confirm.svelte";
import { pathPromptState, resolvePathPrompt } from "./store.svelte";
import { editorToolsPrefs } from "./editorTools.svelte";
import {
  closeTeamDialog,
  defaultTeamConfig,
  openTeamDialog,
  teamDialogState,
} from "./teamDialog.svelte";
import {
  activeTabInPane,
  activePane,
  allPaneTabs,
  applyTerminalRoster,
  beginMissingFileReopen,
  broadcastTerminalInput,
  canReopenClosedTab,
  clearTerminalSession,
  clearRecentlyClosedTabsForTest,
  closePane,
  ensureTerminalKeyboardProtocol,
  closeTab,
  closeTabsInPane,
  consumeLastCloseWasMoveOut,
  isTerminalMoving,
  markTerminalMovingOut,
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
  openLinkTarget,
  openFind,
  openTerminalInPane,
  paneActiveTabId,
  paneMode,
  paneModeEqualize,
  paneModeMoveFocus,
  paneModeOpenBrowser,
  paneModeOpenGraph,
  paneModeOpenTerminal,
  paneModeResize,
  paneModeSetGrab,
  paneModeSetHover,
  paneModeSplit,
  paneModeStageSpawn,
  paneModeSwap,
  paneModeSwapWith,
  paneSide,
  paneTabs,
  removeTerminalFromBroadcastGroup,
  registerDraftPromotionSink,
  registerTerminalCloseSink,
  registerTerminalInputSink,
  resolveDraftClose,
  markLocalTabDrop,
  markTerminalEnvNameRestarted,
  moveActiveTabToSide,
  moveTab,
  reattachTerminalInPane,
  renameTerminalTab,
  uniqueTerminalName,
  reopenClosedTab,
  reorderTab,
  restoreLayout,
  layoutHasPersistableStructure,
  saveDraftTabToWorkspace,
  saveTab,
  scheduleAutosave,
  serializeLayout,
  setActivePane,
  selectTabInPane,
  setTabCaret,
  setTerminalActivity,
  setTerminalActivityPulsing,
  setTerminalBroadcastBySession,
  setTerminalBroadcastEnabled,
  setTerminalBroadcastTarget,
  setWindowFocusColor,
  setTerminalSession,
  setTerminalSubmitAgent,
  shouldCloseTabAfterDragEnd,
  createTeamWorkLeadTerminal,
  clearTeamWorkPending,
  findTeamWorkPendingLead,
  setTeamWorkPendingConfig,
  teamWorkPendingConfig,
  splitPane,
  tabLabel,
  tabLabelInPane,
  TAB_TITLE_MAX_LENGTH,
  terminalBroadcastMemberIds,
  terminalEnvTabNameStale,
  terminalTabGroup,
  toggleActiveFileTabMode,
  toggleActiveTerminalBroadcastSelectAll,
  truncateTabTitle,
  type BrowserTab,
  type FileTab,
  type GraphTab,
  type LeafNode,
  type Tab,
  type TerminalTab,
} from "./tabs.svelte";

// The per-file caret index is a localStorage store (absent in the node test
// env); mock it so the tests assert the wiring (record on edit, restore on
// open) without a storage polyfill.
vi.mock("./caretIndex");
import { readCaret, recordCaret } from "./caretIndex";

function resetLayout(tabs: Tab[]): LeafNode {
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

    expect(write).toHaveBeenCalledWith("notes/a.md", "unsaved", null, 1, null);
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

  test("a terminal moving out records the move-out for the discard guard; a real close clears it", async () => {
    // A cross-window MOVE marks the tab moving-out (Pane.svelte drag-end) right
    // before closeTab; the empty-window discard guard reads this to suppress the
    // reap (the moved PTY lives on in the target window).
    const moving = terminalTab({ id: "term-move", terminalSessionId: "sess-move" });
    const pane = resetLayout([moving]);
    markTerminalMovingOut(moving.id);
    await closeTab(pane.id, moving.id, { force: true });
    expect(consumeLastCloseWasMoveOut()).toBe(true);
    // One-shot: a second read is false.
    expect(consumeLastCloseWasMoveOut()).toBe(false);
    isTerminalMoving(moving.id); // drain the residual marker (no close-sink in test)

    // A genuine close (not marked moving-out) records false → the discard reaps.
    const closing = terminalTab({ id: "term-close", terminalSessionId: "sess-close" });
    const pane2 = resetLayout([closing]);
    await closeTab(pane2.id, closing.id, { force: true });
    expect(consumeLastCloseWasMoveOut()).toBe(false);
  });

  test("draft tab close prompts for discard or save", async () => {
    const tab = fileTab({
      id: "draft-tab",
      path: ".Drafts/untitled-1/draft.md",
    });
    const pane = resetLayout([tab]);
    vi.spyOn(api, "inspectDraft").mockResolvedValue({
      path: ".Drafts/untitled-1/draft.md",
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

    expect(discard).toHaveBeenCalledWith(".Drafts/untitled-1/draft.md");
    expect(activePane().tabs).toHaveLength(0);
  });

  test("saving a draft notifies promotion sinks with the workspace path", async () => {
    const tab = fileTab({
      id: "draft-tab",
      path: ".Drafts/untitled-1/draft.md",
      content: "# draft\n",
      saved: "# draft\n",
      savedMtime: 1,
    });
    const pane = resetLayout([tab]);
    vi.spyOn(api, "inspectDraft").mockResolvedValue({
      path: ".Drafts/untitled-1/draft.md",
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
      ".Drafts/untitled-1/draft.md",
      "untitled-1.md",
    );
    expect(promotedPaths).toEqual(["untitled-1.md"]);
    expect(activePane().tabs).toHaveLength(0);
  });

  test("explicit draft save promotes and keeps the tab open on the workspace file", async () => {
    const tab = fileTab({
      id: "draft-tab",
      path: ".Drafts/untitled-1/draft.md",
      content: "# draft\n",
      saved: "# draft\n",
      savedMtime: 1,
    });
    resetLayout([tab]);
    vi.spyOn(api, "inspectDraft").mockResolvedValue({
      path: ".Drafts/untitled-1/draft.md",
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
      ".Drafts/untitled-1/draft.md",
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
      path: ".Drafts/untitled-1/draft.md",
      content: "# draft\n",
      saved: "# draft\n",
      savedMtime: 1,
    });
    resetLayout([tab]);
    vi.spyOn(api, "inspectDraft").mockResolvedValue({
      path: ".Drafts/untitled-1/draft.md",
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
      ".Drafts/untitled-1/draft.md",
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
      path: ".Drafts/untitled-empty/draft.md",
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
      path: ".Drafts/untitled-empty/draft.md",
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
    expect(discard).toHaveBeenCalledWith(".Drafts/untitled-empty/draft.md");
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

  test("reopening a closed draft mints a fresh draft, not the deleted path", async () => {
    // A closed draft's backing file is always gone after close (discarded,
    // promoted, or missing), so reopen must not re-add the dead path.
    const tab = fileTab({
      path: ".Drafts/untitled-1/draft.md",
      content: "# my recovered note\n",
      saved: "# my recovered note\n",
    });
    const pane = resetLayout([tab]);
    const createDraft = vi.spyOn(api, "createDraft").mockResolvedValue({
      path: ".Drafts/untitled-2/draft.md",
      name: "untitled-2",
    });
    const write = vi
      .spyOn(api, "write")
      .mockResolvedValue({ mtime: 1, mtime_ns: "1" });
    vi.spyOn(api, "readStream").mockResolvedValue({
      path: ".Drafts/untitled-2/draft.md",
      content: "# my recovered note\n",
      mtime: 1,
      writable: true,
    });

    await closeTab(pane.id, tab.id, { force: true });
    expect(canReopenClosedTab()).toBe(true);

    expect(reopenClosedTab()).toBe(true);
    // The recovery starts a fresh draft (createDraft runs synchronously,
    // before the first await) and never re-adds the just-deleted path.
    expect(createDraft).toHaveBeenCalledTimes(1);
    const deadPathReAdded = activePane().tabs.some(
      (t) => t.kind === "file" && t.path === ".Drafts/untitled-1/draft.md",
    );
    expect(deadPathReAdded).toBe(false);

    // Once the round-trip settles, the fresh draft is open, seeded with the
    // recovered buffer (content differs from the default seed).
    await vi.waitFor(() =>
      expect(
        activePane().tabs.some(
          (t) => t.kind === "file" && t.path === ".Drafts/untitled-2/draft.md",
        ),
      ).toBe(true),
    );
    expect(write).toHaveBeenCalledWith(
      ".Drafts/untitled-2/draft.md",
      "# my recovered note\n",
    );
  });

  describe("openInPane caret command", () => {
    // openInPane mutates the layout-proxied tab; read it back via activePane()
    // (the local `tab` reference is the pre-proxy object and stays stale).
    function reopenedFileTab(): FileTab {
      const t = activePane().tabs[0];
      if (t?.kind !== "file") throw new Error("expected a file tab");
      return t;
    }

    test("reopening a kept-alive tab with landAtTop commands the caret to top", async () => {
      const pane = resetLayout([
        fileTab({ path: "notes/a.md", caret: { from: 12, to: 12 } }),
      ]);
      await openInPane(pane.id, "notes/a.md", { landAtTop: true });
      const tab = reopenedFileTab();
      expect(tab.caret).toEqual({ from: 0, to: 0 });
      expect(tab.caretCommand).toEqual({ from: 0, to: 0 });
    });

    test("reopening with initialSelection commands the caret to the selection", async () => {
      const pane = resetLayout([
        fileTab({ path: "notes/a.md", caret: { from: 0, to: 0 } }),
      ]);
      await openInPane(pane.id, "notes/a.md", {
        initialSelection: { from: 7, to: 9 },
      });
      const tab = reopenedFileTab();
      expect(tab.caret).toEqual({ from: 7, to: 9 });
      expect(tab.caretCommand).toEqual({ from: 7, to: 9 });
    });

    test("a plain refocus leaves the caret untouched and issues no command", async () => {
      const pane = resetLayout([
        fileTab({ path: "notes/a.md", caret: { from: 5, to: 5 } }),
      ]);
      await openInPane(pane.id, "notes/a.md", {});
      const tab = reopenedFileTab();
      expect(tab.caret).toEqual({ from: 5, to: 5 });
      expect(tab.caretCommand).toBeUndefined();
    });
  });

  describe("slides files auto-open the Outline", () => {
    const SLIDES = "---\nchan:\n  kind: slides\n---\n\n# Slide 1\n";

    function firstFileTab(): FileTab {
      const t = activePane().tabs[0];
      if (t?.kind !== "file") throw new Error("expected a file tab");
      return t;
    }

    test("a fresh slides open auto-opens the Outline", async () => {
      vi.spyOn(api, "readStream").mockResolvedValue({
        path: "deck.md",
        content: SLIDES,
        mtime: 1,
        mtime_ns: "1",
        writable: true,
      });
      const pane = resetLayout([]);
      await openInPane(pane.id, "deck.md", {});
      expect(firstFileTab().outlineOpen).toBe(true);
    });

    test("a plain markdown open does not auto-open the Outline", async () => {
      vi.spyOn(api, "readStream").mockResolvedValue({
        path: "notes.md",
        content: "# just notes\n",
        mtime: 1,
        mtime_ns: "1",
        writable: true,
      });
      const pane = resetLayout([]);
      await openInPane(pane.id, "notes.md", {});
      expect(firstFileTab().outlineOpen).toBe(false);
    });

    test("refocusing a slides tab does not re-open a closed Outline", async () => {
      // A refocus reuses the existing tab without reloading, so the
      // auto-open hook never runs and the user's closed state stands.
      const pane = resetLayout([
        fileTab({ path: "deck.md", content: SLIDES, outlineOpen: false }),
      ]);
      await openInPane(pane.id, "deck.md", {});
      expect(firstFileTab().outlineOpen).toBe(false);
    });
  });

  describe("per-file caret persistence", () => {
    test("setTabCaret records the caret when the tab is not loading", () => {
      vi.mocked(recordCaret).mockClear();
      const tab = fileTab({ path: "notes/a.md", loading: false });
      setTabCaret(tab, 3, 8);
      expect(tab.caret).toEqual({ from: 3, to: 8 });
      expect(recordCaret).toHaveBeenCalledWith("notes/a.md", 3, 8);
    });

    test("setTabCaret does NOT record while the tab is still loading", () => {
      vi.mocked(recordCaret).mockClear();
      const tab = fileTab({ path: "notes/a.md", loading: true });
      setTabCaret(tab, 3, 8);
      expect(tab.caret).toEqual({ from: 3, to: 8 });
      expect(recordCaret).not.toHaveBeenCalled();
    });

    test("an implicit fresh open restores the saved caret after load", async () => {
      vi.mocked(readCaret).mockReturnValueOnce({ from: 4, to: 6 });
      vi.spyOn(api, "readStream").mockResolvedValue({
        path: "notes/b.md",
        content: "abcdefghij",
        mtime: 1,
        mtime_ns: "1",
        writable: true,
      });
      const pane = resetLayout([]);
      await openInPane(pane.id, "notes/b.md", {});
      const t = activePane().tabs[0];
      expect(t?.kind).toBe("file");
      if (t?.kind !== "file") return;
      expect(t.caretCommand).toEqual({ from: 4, to: 6 });
    });

    test("an explicit landAtTop open ignores the saved caret and lands at top", async () => {
      // restoreSavedCaretAfterLoad handles landAtTop before consulting
      // readCaret, so the saved caret never overrides the explicit top, and it
      // issues a caret command so the editor re-claims focus after the load.
      vi.mocked(readCaret).mockClear();
      vi.spyOn(api, "readStream").mockResolvedValue({
        path: "notes/c.md",
        content: "abcdefghij",
        mtime: 1,
        mtime_ns: "1",
        writable: true,
      });
      const pane = resetLayout([]);
      await openInPane(pane.id, "notes/c.md", { landAtTop: true });
      const t = activePane().tabs[0];
      expect(t?.kind).toBe("file");
      if (t?.kind !== "file") return;
      expect(t.caret).toEqual({ from: 0, to: 0 });
      expect(t.caretCommand).toEqual({ from: 0, to: 0 });
      expect(readCaret).not.toHaveBeenCalled();
    });

    test("a landAtTop open of an empty new file commands the caret so it claims focus (#A1)", async () => {
      // A brand-new `cs open <file>` streams in empty. The editor's own
      // caret-restore bails on a zero-length doc, so the open must issue a
      // post-load caret command to pull focus into the editor.
      vi.mocked(readCaret).mockClear();
      vi.spyOn(api, "readStream").mockResolvedValue({
        path: "notes/new.md",
        content: "",
        mtime: 1,
        mtime_ns: "1",
        writable: true,
      });
      const pane = resetLayout([]);
      await openInPane(pane.id, "notes/new.md", { landAtTop: true });
      const t = activePane().tabs[0];
      expect(t?.kind).toBe("file");
      if (t?.kind !== "file") return;
      expect(t.caretCommand).toEqual({ from: 0, to: 0 });
      expect(readCaret).not.toHaveBeenCalled();
    });
  });

  describe("auto-discard empty files on close", () => {
    test("discards an empty dirty file: deletes it then closes the tab", async () => {
      const remove = vi.spyOn(api, "remove").mockResolvedValue(undefined);
      const pane = resetLayout([
        fileTab({ path: "notes/a.md", content: "", saved: "old", openedEmpty: false }),
      ]);
      await closeTab(pane.id, "file-1");
      expect(remove).toHaveBeenCalledWith("notes/a.md");
      expect(activePane().tabs).toHaveLength(0);
    });

    test("discards a file that opened empty even when clean", async () => {
      const remove = vi.spyOn(api, "remove").mockResolvedValue(undefined);
      const pane = resetLayout([
        fileTab({ path: "notes/a.md", content: "", saved: "", openedEmpty: true }),
      ]);
      await closeTab(pane.id, "file-1");
      expect(remove).toHaveBeenCalledWith("notes/a.md");
      expect(activePane().tabs).toHaveLength(0);
    });

    test("does NOT discard a non-empty file (closes normally)", async () => {
      const remove = vi.spyOn(api, "remove").mockResolvedValue(undefined);
      const pane = resetLayout([
        fileTab({ path: "notes/a.md", content: "hello", saved: "hello", openedEmpty: false }),
      ]);
      await closeTab(pane.id, "file-1");
      expect(remove).not.toHaveBeenCalled();
      expect(activePane().tabs).toHaveLength(0);
    });

    test("does NOT discard an empty file that is clean and did not open empty", async () => {
      const remove = vi.spyOn(api, "remove").mockResolvedValue(undefined);
      const pane = resetLayout([
        fileTab({ path: "notes/a.md", content: "", saved: "", openedEmpty: false }),
      ]);
      await closeTab(pane.id, "file-1");
      expect(remove).not.toHaveBeenCalled();
    });

    test("does NOT discard a file that failed to load (error set), though blank", async () => {
      const remove = vi.spyOn(api, "remove").mockResolvedValue(undefined);
      const pane = resetLayout([
        fileTab({ path: "notes/a.md", content: "", saved: "", error: "load failed", openedEmpty: false }),
      ]);
      await closeTab(pane.id, "file-1");
      expect(remove).not.toHaveBeenCalled();
    });

    test("a force close never discards", async () => {
      const remove = vi.spyOn(api, "remove").mockResolvedValue(undefined);
      const pane = resetLayout([
        fileTab({ path: "notes/a.md", content: "", saved: "old", openedEmpty: false }),
      ]);
      await closeTab(pane.id, "file-1", { force: true });
      expect(remove).not.toHaveBeenCalled();
      expect(activePane().tabs).toHaveLength(0);
    });

    test("a failed deletion falls back to a normal close (tab not trapped)", async () => {
      vi.spyOn(api, "remove").mockRejectedValue(new Error("disk error"));
      const pane = resetLayout([
        fileTab({ path: "notes/a.md", content: "", saved: "", openedEmpty: true }),
      ]);
      await closeTab(pane.id, "file-1");
      expect(activePane().tabs).toHaveLength(0);
    });
  });

  test("reopens a closed File Browser tab with its expanded dirs + view state", async () => {
    // Close + reopen both run the tab through cloneTab; the browser
    // branch must carry the per-tab view state or Cmd+Shift+T snaps the
    // restored File Browser back to a collapsed root.
    const br: BrowserTab = {
      kind: "browser",
      id: "br-f3",
      title: "Files",
      inspectorOpen: true,
      selected: "notes/today.md",
      selectedPaths: ["notes/today.md", "notes/old.md"],
      showWorkspace: true,
      expanded: ["notes", "notes/sub", "archive"],
      scroll: 120,
      inspectorWidth: 280,
    };
    const originalExpanded = br.expanded;
    const pane: LeafNode = {
      kind: "leaf",
      id: "pane-test",
      tabs: [br],
      activeTabId: br.id,
    };
    layout.rootId = pane.id;
    layout.activePaneId = pane.id;
    layout.nodes = { [pane.id]: pane };
    layout.focusColor = "blue";

    await closeTab(pane.id, br.id, { force: true });
    expect(activePane().tabs).toHaveLength(0);
    expect(canReopenClosedTab()).toBe(true);

    expect(reopenClosedTab()).toBe(true);
    const reopened = activePane().tabs[0];
    if (reopened?.kind !== "browser") throw new Error("expected browser tab");
    expect(reopened.expanded).toEqual(["notes", "notes/sub", "archive"]);
    expect(reopened.selected).toBe("notes/today.md");
    expect(reopened.selectedPaths).toEqual(["notes/today.md", "notes/old.md"]);
    expect(reopened.showWorkspace).toBe(true);
    expect(reopened.scroll).toBe(120);
    expect(reopened.inspectorWidth).toBe(280);
    expect(reopened.inspectorOpen).toBe(true);
    // Carried arrays are copies, never aliases to the source tab's.
    expect(reopened.expanded).not.toBe(originalExpanded);
  });

  test("closing the last tab on the visible side clears only that side", async () => {
    const a = fileTab({ id: "side-a", path: "notes/a.md" });
    const b = fileTab({ id: "side-b", path: "notes/b.md" });
    const seed = resetLayout([a]);
    seed.bTabs = [b];
    seed.bActiveTabId = b.id;
    seed.side = "b";

    await closeTab(seed.id, b.id, { force: true });

    const live = layout.nodes[seed.id];
    if (live?.kind !== "leaf") throw new Error("expected leaf");
    expect(paneSide(live)).toBe("b");
    expect(paneTabs(live, "b")).toHaveLength(0);
    expect(paneActiveTabId(live, "b")).toBeNull();
    expect(paneTabs(live, "a").map((tab) => tab.id)).toEqual(["side-a"]);
    expect(paneActiveTabId(live, "a")).toBe("side-a");
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

  test("moves a B-side tab into another pane's visible A side", () => {
    const sourceA = fileTab({ id: "source-a", path: "notes/source-a.md" });
    const sourceB = fileTab({ id: "source-b", path: "notes/source-b.md" });
    const targetA = fileTab({ id: "target-a", path: "notes/target-a.md" });
    const left = resetLayout([sourceA]);
    left.bTabs = [sourceB];
    left.bActiveTabId = sourceB.id;
    left.side = "b";

    splitPane(left.id, "row", "after");
    const root = layout.nodes[layout.rootId];
    if (root?.kind !== "split") throw new Error("expected split");
    const right = layout.nodes[root.b];
    if (right?.kind !== "leaf") throw new Error("expected right leaf");
    right.tabs = [targetA];
    right.activeTabId = targetA.id;
    right.side = "a";

    moveTab(left.id, sourceB.id, right.id, 1, { fromSide: "b", toSide: "a" });

    const liveLeft = layout.nodes[left.id];
    const liveRight = layout.nodes[right.id];
    if (liveLeft?.kind !== "leaf" || liveRight?.kind !== "leaf") {
      throw new Error("expected live leaves");
    }
    expect(paneTabs(liveLeft, "a").map((tab) => tab.id)).toEqual(["source-a"]);
    expect(paneTabs(liveLeft, "b")).toEqual([]);
    expect(paneTabs(liveRight, "a").map((tab) => tab.id)).toEqual(["target-a", "source-b"]);
    expect(paneActiveTabId(liveRight, "a")).toBe("source-b");
    expect(paneSide(liveRight)).toBe("a");
    expect(layout.activePaneId).toBe(liveRight.id);
  });

  test("same-pane drag can move a tab from A to B without drag-end closing it", () => {
    const a1 = fileTab({ id: "a1", path: "notes/a1.md" });
    const a2 = fileTab({ id: "a2", path: "notes/a2.md" });
    const b1 = fileTab({ id: "b1", path: "notes/b1.md" });
    const pane = resetLayout([a1, a2]);
    pane.bTabs = [b1];
    pane.bActiveTabId = b1.id;
    pane.side = "b";

    markLocalTabDrop(pane.id, a2.id, "a");
    moveTab(pane.id, a2.id, pane.id, 1, { fromSide: "a", toSide: "b" });

    const live = layout.nodes[pane.id];
    if (live?.kind !== "leaf") throw new Error("expected live leaf");
    expect(paneTabs(live, "a").map((tab) => tab.id)).toEqual(["a1"]);
    expect(paneActiveTabId(live, "a")).toBe("a1");
    expect(paneTabs(live, "b").map((tab) => tab.id)).toEqual(["b1", "a2"]);
    expect(paneActiveTabId(live, "b")).toBe("a2");
    expect(paneSide(live)).toBe("b");
    expect(shouldCloseTabAfterDragEnd(live.id, a2.id, "move", "a")).toBe(false);
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

  test("a semantic workspace graph opens focused on the root node", () => {
    resetLayout([]);
    // Root node id is "" (server directory_node_id("")): seeding it as the
    // pending selection makes load() select it + open the inspector, so a
    // non-lens graph never opens with nothing selected.
    expect(openGraphInActivePane({ scopeId: "workspace" }).pendingSelectId).toBe("");
    expect(openGraphInActivePane({}).pendingSelectId).toBe("");
    // Lens opens keep their own focal node.
    expect(
      openGraphInActivePane({ scopeId: "mention:@@Alice", pendingSelectId: "@@Alice" })
        .pendingSelectId,
    ).toBe("@@Alice");
    // Non-workspace scope and non-semantic modes get no auto-root focus.
    expect(openGraphInActivePane({ scopeId: "dir:notes" }).pendingSelectId).toBeNull();
    expect(
      openGraphInActivePane({ mode: "language", scopeId: "workspace" }).pendingSelectId,
    ).toBeNull();
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

  test("hash round-trips slide preview state for file tabs", async () => {
    const file = fileTab({
      slidePreview: { open: true, index: 2, mode: "preview" },
    });
    resetLayout([file]);

    const snapshot = serializeLayout();
    const json = JSON.stringify(snapshot);
    expect(json).toContain('"spo":1');
    expect(json).toContain('"sp":2');
    expect(json).not.toContain('"spm"');

    await restoreLayout(snapshot!);

    const restored = activePane().tabs[0];
    expect(restored?.kind).toBe("file");
    if (restored?.kind !== "file") return;
    expect(restored.slidePreview).toEqual({
      open: true,
      index: 2,
      mode: "preview",
    });
  });

  test("hash round-trips slide play mode for file tabs", async () => {
    const file = fileTab({
      slidePreview: { open: true, index: 1, mode: "play" },
    });
    resetLayout([file]);

    const snapshot = serializeLayout();
    const json = JSON.stringify(snapshot);
    expect(json).toContain('"spo":1');
    expect(json).toContain('"sp":1');
    expect(json).toContain('"spm":"p"');

    await restoreLayout(snapshot!);

    const restored = activePane().tabs[0];
    expect(restored?.kind).toBe("file");
    if (restored?.kind !== "file") return;
    expect(restored.slidePreview).toEqual({
      open: true,
      index: 1,
      mode: "play",
    });
  });

  test("hash round-trips an open Outline via the ol bit", async () => {
    const file = fileTab({ outlineOpen: true });
    resetLayout([file]);

    const snapshot = serializeLayout();
    expect(JSON.stringify(snapshot)).toContain('"ol":1');

    await restoreLayout(snapshot!);

    const restored = activePane().tabs[0];
    expect(restored?.kind).toBe("file");
    if (restored?.kind !== "file") return;
    expect(restored.outlineOpen).toBe(true);
  });

  test("a closed Outline on a slides file stays closed across a reload", async () => {
    // Session restore never runs the auto-open hook, so a slides file whose
    // Outline the user closed reloads with it still closed even though the
    // content still parses as slides.
    vi.spyOn(api, "readStream").mockResolvedValue({
      path: "deck.md",
      content: "---\nchan:\n  kind: slides\n---\n\n# Slide 1\n",
      mtime: 1,
      mtime_ns: "1",
      writable: true,
    });
    const file = fileTab({ path: "deck.md", outlineOpen: false });
    resetLayout([file]);

    const snapshot = serializeLayout();
    expect(JSON.stringify(snapshot)).not.toContain('"ol"');

    await restoreLayout(snapshot!);

    const restored = activePane().tabs[0];
    expect(restored?.kind).toBe("file");
    if (restored?.kind !== "file") return;
    expect(restored.outlineOpen).toBe(false);
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

  // (Removed: "pane mode Team Work terminals share the draft title allocator".
  // The pane-mode Team Work bubble spawn (paneModeOpenTeamWorkTerminal) was
  // removed when the Team Work bubble was decoupled from arbitrary terminals -
  // it now renders only on a team LEAD terminal via the Cmd+P workflow. The
  // draft-title-allocator behavior stays covered by the regular pane-mode
  // terminal test above.)

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
    expect(created?.id).toBe(pane.activeTabId);
  });

  test("createTeamWorkLeadTerminal always spawns a fresh terminal (never reuses)", () => {
    const terminal: TerminalTab = {
      kind: "terminal",
      id: "term-1",
      title: "Terminal",
      createdAt: 1,
      broadcastEnabled: false,
      broadcastTargetIds: [],
    };
    const seed = resetLayout([terminal]);
    (layout.nodes[seed.id] as LeafNode).activeTabId = "term-1";

    const created = createTeamWorkLeadTerminal({ cwd: "notes" });

    const pane = layout.nodes[seed.id] as LeafNode;
    expect(pane.tabs).toHaveLength(2);
    const spawned = pane.tabs.find((t) => t.id === pane.activeTabId) as TerminalTab;
    expect(spawned.id).not.toBe("term-1");
    expect(spawned.kind).toBe("terminal");
    expect(spawned.cwd).toBe("notes");
    expect(created?.id).toBe(spawned.id);
  });

  test("uniqueTerminalName disambiguates collisions with a -N suffix", () => {
    resetLayout([
      terminalTab({ id: "a", title: "agent" }),
      terminalTab({ id: "b", title: "agent-2" }),
    ]);
    // Free when no clash; -2 on a clash; skips to -3 when -2 is taken too.
    expect(uniqueTerminalName("worker")).toBe("worker");
    expect(uniqueTerminalName("agent")).toBe("agent-3");
    // excludeTabId lets a tab keep its own name (rename to the same value).
    expect(uniqueTerminalName("agent", "a")).toBe("agent");
  });

  test("uniqueTerminalName dedups against terminals in OTHER windows", () => {
    resetLayout([terminalTab({ id: "local", title: "build" })]);
    // Two terminals live in another window (per the cross-window roster):
    // "Terminal-2" (group A) and "Terminal-1" (group B). A rename here must
    // avoid them tenant-wide, across groups (the bug: renaming to a name only
    // taken in another window used to collide).
    applyTerminalRoster([
      { id: "sess-x", tab_name: "Terminal-2", tab_group: "A", window_id: "other-win", broadcast: false },
      { id: "sess-y", tab_name: "Terminal-1", tab_group: "B", window_id: "other-win", broadcast: false },
    ]);
    expect(uniqueTerminalName("Terminal-2")).toBe("Terminal-2-2");
    expect(uniqueTerminalName("Terminal-1")).toBe("Terminal-1-2");
    // A name free tenant-wide passes through.
    expect(uniqueTerminalName("Terminal-9")).toBe("Terminal-9");
    applyTerminalRoster([]);
  });

  test("uniqueTerminalName excludes a moved session's own roster entry", () => {
    resetLayout([terminalTab({ id: "local", title: "shell" })]);
    // The moved terminal "build" is still live in the SOURCE window's roster
    // entry at drop time (a cross-window move closes the source only AFTER the
    // drop). Without excluding it, dedup would treat it as a conflict.
    applyTerminalRoster([
      { id: "moved-sess", tab_name: "build", tab_group: "G", window_id: "other-win", broadcast: false },
    ]);
    expect(uniqueTerminalName("build")).toBe("build-2");
    // Excluding the moved session itself -> the name passes through unchanged.
    expect(uniqueTerminalName("build", undefined, "moved-sess")).toBe("build");
    applyTerminalRoster([]);
  });

  test("reattachTerminalInPane keeps the name on a clash-free move (no suffix, env not stale)", () => {
    const pane = resetLayout([terminalTab({ id: "local", title: "shell" })]);
    // Moved terminal still present in the source window's roster at drop time.
    applyTerminalRoster([
      { id: "moved-sess", tab_name: "Terminal-2", tab_group: "G", window_id: "other-win", broadcast: false },
    ]);
    const tab = reattachTerminalInPane(pane.id, {
      terminalSessionId: "moved-sess",
      title: "Terminal-2",
      terminalEnvTabName: "Terminal-2",
    });
    expect(tab).not.toBeNull();
    expect(tab?.title).toBe("Terminal-2"); // Bug 1: no spurious -N
    expect(tab?.terminalEnvTabName).toBe("Terminal-2"); // Bug 2: env carried
    expect(terminalEnvTabNameStale(tab as TerminalTab)).toBe(false); // names match -> no warning
    applyTerminalRoster([]);
  });

  test("applyTerminalRoster reconciles a local tab whose session the server moved out of band", () => {
    // The lead's pre-existing tab is restarted out of band by a team-script
    // bootstrap: the server moves its session to "v0380" but this window's
    // tab.group still reads "default". The roster snapshot reconciles the
    // local group so broadcast scoping groups the lead with the workers
    // instead of stranding it alone in the stale group.
    const lead = terminalTab({
      id: "lead",
      title: "@@Lead",
      terminalSessionId: "lead-sess",
      group: "default",
    });
    const worker = terminalTab({
      id: "worker",
      title: "@@Boot",
      terminalSessionId: "worker-sess",
      group: "v0380",
    });
    resetLayout([lead, worker]);
    const tab = (id: string) =>
      activePane().tabs.find((c) => c.id === id) as TerminalTab;

    applyTerminalRoster([
      { id: "lead-sess", tab_name: "@@Lead", tab_group: "v0380", window_id: "w1", broadcast: false },
      { id: "worker-sess", tab_name: "@@Boot", tab_group: "v0380", window_id: "w1", broadcast: false },
    ]);

    expect(terminalTabGroup(tab("lead"))).toBe("v0380");
    expect(terminalTabGroup(tab("worker"))).toBe("v0380");
    applyTerminalRoster([]);
  });

  test("applyTerminalRoster leaves a matching group alone and skips sessions with no local tab", () => {
    const a = terminalTab({
      id: "a",
      title: "A",
      terminalSessionId: "sess-a",
      group: "team",
    });
    resetLayout([a]);
    const tab = (id: string) =>
      activePane().tabs.find((c) => c.id === id) as TerminalTab;

    // sess-a already matches; ghost-sess has no open local tab (must be a no-op,
    // not a crash).
    applyTerminalRoster([
      { id: "sess-a", tab_name: "A", tab_group: "team", window_id: "w1", broadcast: false },
      { id: "ghost-sess", tab_name: "Z", tab_group: "other", window_id: "w2", broadcast: false },
    ]);

    expect(terminalTabGroup(tab("a"))).toBe("team");
    applyTerminalRoster([]);
  });

  test("reattachTerminalInPane suffixes + flags stale env only on a real conflict", () => {
    // A DIFFERENT terminal already holds "Terminal-2" in this window.
    const pane = resetLayout([terminalTab({ id: "local", title: "Terminal-2" })]);
    const tab = reattachTerminalInPane(pane.id, {
      terminalSessionId: "moved-sess",
      title: "Terminal-2",
      terminalEnvTabName: "Terminal-2",
    });
    expect(tab?.title).toBe("Terminal-2-2"); // forced suffix on real conflict
    expect(tab?.terminalEnvTabName).toBe("Terminal-2"); // env is the original
    expect(terminalEnvTabNameStale(tab as TerminalTab)).toBe(true); // title != env -> warning fires
  });

  test("reattachTerminalInPane preserves an already-stale env across the move", () => {
    const pane = resetLayout([terminalTab({ id: "local", title: "shell" })]);
    // Source was renamed (title "deploy") but not restarted (env still "build").
    const tab = reattachTerminalInPane(pane.id, {
      terminalSessionId: "moved-sess",
      title: "deploy",
      terminalEnvTabName: "build",
    });
    expect(tab?.title).toBe("deploy"); // no conflict -> no suffix
    expect(tab?.terminalEnvTabName).toBe("build");
    expect(terminalEnvTabNameStale(tab as TerminalTab)).toBe(true); // deploy != build -> warning persists
  });

  test("setTerminalSession keeps the carried env on a reattach (same id), resets on a new id", () => {
    const pane = resetLayout([terminalTab({ id: "local", title: "Terminal-2" })]);
    const tab = reattachTerminalInPane(pane.id, {
      terminalSessionId: "moved-sess",
      title: "Terminal-2",
      terminalEnvTabName: "Terminal-2",
    }) as TerminalTab;
    // title suffixed to Terminal-2-2; env is the original Terminal-2.
    // The move handshake re-attaches to the SAME session id -> env unchanged.
    setTerminalSession(tab, "moved-sess");
    expect(tab.terminalEnvTabName).toBe("Terminal-2");
    expect(terminalEnvTabNameStale(tab)).toBe(true);
    // A DIFFERENT session id (cross-tenant fresh spawn) resets env to the title.
    setTerminalSession(tab, "fresh-sess");
    expect(tab.terminalEnvTabName).toBe("Terminal-2-2");
    expect(terminalEnvTabNameStale(tab)).toBe(false);
  });

  test("renameTerminalTab enforces a unique name (auto -N, never rejects)", () => {
    const seed = resetLayout([
      terminalTab({ id: "a", title: "agent" }),
      terminalTab({ id: "b", title: "Terminal-2" }),
    ]);
    const b = (layout.nodes[seed.id] as LeafNode).tabs.find(
      (t) => t.id === "b",
    ) as TerminalTab;
    renameTerminalTab(b, "agent");
    expect(b.title).toBe("agent-2");
    // Renaming to its own current name is a no-op (excludes itself).
    renameTerminalTab(b, "agent-2");
    expect(b.title).toBe("agent-2");
  });

  test("a passed creation name is deduped (cs --tab-name / team spawn)", () => {
    resetLayout([terminalTab({ id: "a", title: "build" })]);
    const seed = layout.activePaneId;
    const spawned = openTerminalInPane(seed, { title: "build" });
    expect(spawned?.title).toBe("build-2");
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
  test("splitting from side A leaves the new pane on side A", () => {
    const seed = resetLayout([fileTab({ id: "f", path: "a.md" })]);
    splitPane(seed.id, "row", "after");
    const root = layout.nodes[layout.rootId];
    if (root?.kind !== "split") throw new Error("expected split");
    const newPane = layout.nodes[root.b];
    if (newPane?.kind !== "leaf") throw new Error("expected leaf");
    expect(paneSide(newPane)).toBe("a");
    expect(paneTabs(newPane, "a")).toHaveLength(0);
    expect(paneTabs(newPane, "b")).toHaveLength(0);
  });

  test("splitting a side-B pane yields a clean side-A new pane", () => {
    const seed = resetLayout([fileTab({ id: "f", path: "a.md" })]);
    flipHybrid(seed.id);
    const live = layout.nodes[seed.id];
    if (live?.kind !== "leaf") throw new Error("expected leaf");
    expect(paneSide(live)).toBe("b");

    splitPane(seed.id, "row", "after");
    const root = layout.nodes[layout.rootId];
    if (root?.kind !== "split") throw new Error("expected split");
    const newPane = layout.nodes[root.b];
    if (newPane?.kind !== "leaf") throw new Error("expected leaf");
    expect(paneSide(newPane)).toBe("a");
    expect(paneTabs(newPane, "a")).toHaveLength(0);
    expect(paneTabs(newPane, "b")).toHaveLength(0);
    const original = layout.nodes[seed.id];
    if (original?.kind !== "leaf") throw new Error("expected leaf");
    expect(paneSide(original)).toBe("b");
  });
});

describe("Hybrid side flip", () => {
  test("first flip selects side B while preserving side A tabs", () => {
    const a = fileTab({ id: "side-a", path: "notes/a.md" });
    const seed = resetLayout([a]);
    expect(paneSide(seed)).toBe("a");

    flipHybrid(seed.id);

    const live = layout.nodes[seed.id];
    expect(live?.kind).toBe("leaf");
    if (live?.kind !== "leaf") return;
    expect(paneSide(live)).toBe("b");
    expect(paneTabs(live, "a").map((t) => t.id)).toEqual(["side-a"]);
    expect(paneActiveTabId(live, "a")).toBe("side-a");
    expect(paneTabs(live, "b")).toEqual([]);
    expect(paneActiveTabId(live, "b")).toBeNull();
    expect(live.theme).toBeUndefined();
  });

  test("flipping round-trips side while pane theme stays stable", () => {
    const a = fileTab({ id: "a1", path: "a.md" });
    const b = fileTab({ id: "b1", path: "b.md" });
    const seed = resetLayout([a]);
    seed.bTabs = [b];
    seed.bActiveTabId = b.id;

    flipHybrid(seed.id);
    let live = layout.nodes[seed.id];
    if (live?.kind !== "leaf") throw new Error("expected leaf");
    expect(paneSide(live)).toBe("b");
    expect(activeTabInPane(live)?.id).toBe("b1");
    live.theme = "dark";

    flipHybrid(seed.id);
    live = layout.nodes[seed.id];
    if (live?.kind !== "leaf") throw new Error("expected leaf");
    expect(paneSide(live)).toBe("a");
    expect(activeTabInPane(live)?.id).toBe("a1");
    expect(live.theme).toBe("dark");

    flipHybrid(seed.id);
    live = layout.nodes[seed.id];
    if (live?.kind !== "leaf") throw new Error("expected leaf");
    expect(paneSide(live)).toBe("b");
    expect(activeTabInPane(live)?.id).toBe("b1");
    expect(live.theme).toBe("dark");
  });

  test("flipHybrid toggles side without firing the wobble bus", async () => {
    const front = fileTab({ id: "fw", path: "wobble.md" });
    const seed = resetLayout([front]);
    const { paneWobble } = await import("./tabs.svelte");
    const beforeWobble = paneWobble.versions[seed.id] ?? 0;

    flipHybrid(seed.id);

    const live = layout.nodes[seed.id];
    if (live?.kind !== "leaf") throw new Error("expected leaf");
    expect(paneSide(live)).toBe("b");
    expect(paneWobble.versions[seed.id] ?? 0).toBe(beforeWobble);
  });

  test("flipHybrid no-ops when the pane id doesn't resolve to a leaf", () => {
    const seed = resetLayout([fileTab({ id: "x", path: "x.md" })]);
    flipHybrid("does-not-exist");
    const live = layout.nodes[seed.id];
    if (live?.kind !== "leaf") throw new Error("expected leaf");
    expect(paneSide(live)).toBe("a");
  });

  test("flipHybrid works on an empty pane", () => {
    const seed = resetLayout([]);

    flipHybrid(seed.id);

    const live = layout.nodes[seed.id];
    if (live?.kind !== "leaf") throw new Error("expected leaf");
    expect(paneSide(live)).toBe("b");
    expect(allPaneTabs(live)).toHaveLength(0);
    expect(paneActiveTabId(live)).toBeNull();
  });

  test("moveActiveTabToSide moves the visible active tab and switches side", () => {
    const a1 = fileTab({ id: "a1", path: "a1.md" });
    const a2 = fileTab({ id: "a2", path: "a2.md" });
    const seed = resetLayout([a1, a2]);
    seed.activeTabId = a2.id;

    expect(moveActiveTabToSide("b")).toBe(true);
    const live = layout.nodes[seed.id];
    if (live?.kind !== "leaf") throw new Error("expected leaf");
    expect(paneSide(live)).toBe("b");
    expect(paneTabs(live, "a").map((t) => t.id)).toEqual(["a1"]);
    expect(paneActiveTabId(live, "a")).toBe("a1");
    expect(paneTabs(live, "b").map((t) => t.id)).toEqual(["a2"]);
    expect(paneActiveTabId(live, "b")).toBe("a2");
    expect(activeTabInPane(live)?.id).toBe("a2");
    expect(moveActiveTabToSide("b")).toBe(false);
  });

  test("reopenClosedTab restores the side the tab was closed from", async () => {
    const a = fileTab({ id: "a", path: "a.md" });
    const b = fileTab({ id: "b", path: "b.md" });
    const seed = resetLayout([a]);
    seed.bTabs = [b];
    seed.bActiveTabId = b.id;
    seed.side = "b";

    await closeTab(seed.id, b.id, { force: true });
    let live = layout.nodes[seed.id];
    if (live?.kind !== "leaf") throw new Error("expected leaf");
    live.side = "a";
    expect(paneTabs(live, "b")).toHaveLength(0);

    expect(reopenClosedTab()).toBe(true);

    live = layout.nodes[seed.id];
    if (live?.kind !== "leaf") throw new Error("expected leaf");
    expect(paneSide(live)).toBe("b");
    expect(paneTabs(live, "a").map((tab) => tab.id)).toEqual(["a"]);
    expect(paneTabs(live, "b").map((tab) => tab.id)).toEqual(["b"]);
    expect(activeTabInPane(live)?.id).toBe("b");
  });

  test("selectTabInPane switches to the side containing the tab", () => {
    const a = fileTab({ id: "a", path: "a.md" });
    const b = fileTab({ id: "b", path: "b.md" });
    const seed = resetLayout([a]);
    seed.bTabs = [b];
    seed.bActiveTabId = null;

    selectTabInPane(seed.id, b.id);

    const live = layout.nodes[seed.id];
    if (live?.kind !== "leaf") throw new Error("expected leaf");
    expect(paneSide(live)).toBe("b");
    expect(paneActiveTabId(live, "b")).toBe("b");
    expect(activeTabInPane(live)?.id).toBe("b");
  });

  test("reorder and close operate on the visible side only", async () => {
    const a = fileTab({ id: "a", path: "a.md" });
    const b1 = fileTab({ id: "b1", path: "b1.md" });
    const b2 = fileTab({ id: "b2", path: "b2.md" });
    const seed = resetLayout([a]);
    seed.bTabs = [b1, b2];
    seed.bActiveTabId = b1.id;
    seed.side = "b";

    reorderTab(seed.id, b2.id, 0);
    let live = layout.nodes[seed.id];
    if (live?.kind !== "leaf") throw new Error("expected leaf");
    expect(paneTabs(live, "a").map((t) => t.id)).toEqual(["a"]);
    expect(paneTabs(live, "b").map((t) => t.id)).toEqual(["b2", "b1"]);
    expect(paneActiveTabId(live, "b")).toBe("b2");

    await closeTab(seed.id, b2.id, { force: true });
    live = layout.nodes[seed.id];
    if (live?.kind !== "leaf") throw new Error("expected leaf");
    expect(paneSide(live)).toBe("b");
    expect(paneTabs(live, "a").map((t) => t.id)).toEqual(["a"]);
    expect(paneTabs(live, "b").map((t) => t.id)).toEqual(["b1"]);
    expect(paneActiveTabId(live, "b")).toBe("b1");
  });

  test("serialize / restore round-trips A tabs, B tabs, visible side, and theme", async () => {
    const a = fileTab({ id: "front", path: "front.md" });
    const b = terminalTab({ id: "back-term", title: "Back Terminal" });
    const seed = resetLayout([a]);
    seed.bTabs = [b];
    seed.bActiveTabId = b.id;
    seed.side = "b";
    const live = layout.nodes[seed.id];
    if (live?.kind !== "leaf") throw new Error("expected leaf");
    live.theme = "dark";

    const snapshot = serializeLayout();
    expect(snapshot).not.toBeNull();
    if (!snapshot) return;
    const json = JSON.stringify(snapshot);
    expect(json).toContain("\"sb\":1");
    expect(json).toContain("\"bt\":");
    expect(json).toContain("\"ht\":\"d\"");
    expect(json).not.toContain("\"hb\":");
    expect(json).not.toContain("\"bm\":");

    await restoreLayout(snapshot);

    const restored = activePane();
    expect(paneSide(restored)).toBe("b");
    expect(restored.theme).toBe("dark");
    expect(paneTabs(restored, "a").map((t) => t.kind)).toEqual(["file"]);
    expect(paneTabs(restored, "b").map((t) => t.kind)).toEqual(["terminal"]);
    expect(activeTabInPane(restored)?.kind).toBe("terminal");
  });

  test("legacy `hb` and `bm` payloads are accepted as inert hints", async () => {
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
      bm: 1 as const,
      sb: 1 as const,
    };

    await restoreLayout(legacyLeaf as never);

    const restored = activePane();
    expect(restored.theme).toBe("dark");
    expect(paneSide(restored)).toBe("b");
    expect(paneTabs(restored, "a").map((t) => t.kind)).toEqual(["file"]);
    expect(paneTabs(restored, "b")).toEqual([]);
    expect(activeTabInPane(restored)).toBeNull();
  });

  test("focus changes never touch any pane's side; sides are per-pane", () => {
    const left = fileTab({ id: "left", path: "notes/left.md" });
    const right = fileTab({ id: "right", path: "notes/right.md" });
    const leftPane = resetLayout([left]);
    splitPane(leftPane.id, "row", "after");
    const root = layout.nodes[layout.rootId];
    if (root?.kind !== "split") throw new Error("expected split");
    const rightPaneId = root.b;
    const rightPane = layout.nodes[rightPaneId];
    if (rightPane?.kind !== "leaf") throw new Error("expected leaf");
    expect(paneSide(rightPane)).toBe("a");
    rightPane.tabs.push(right);
    rightPane.activeTabId = right.id;

    setActivePane(leftPane.id);
    flipHybrid(leftPane.id);
    const leftFlipped = layout.nodes[leftPane.id];
    if (leftFlipped?.kind !== "leaf") throw new Error("expected leaf");
    expect(paneSide(leftFlipped)).toBe("b");

    setActivePane(rightPaneId);
    const leftAfterFocus = layout.nodes[leftPane.id];
    if (leftAfterFocus?.kind !== "leaf") throw new Error("expected leaf");
    expect(paneSide(leftAfterFocus)).toBe("b");
    expect(paneSide(rightPane)).toBe("a");

    flipHybrid(rightPaneId);
    expect(paneSide(layout.nodes[leftPane.id] as LeafNode)).toBe("b");
    expect(paneSide(layout.nodes[rightPaneId] as LeafNode)).toBe("b");

    setActivePane(leftPane.id);
    setActivePane(rightPaneId);
    expect(paneSide(layout.nodes[leftPane.id] as LeafNode)).toBe("b");
    expect(paneSide(layout.nodes[rightPaneId] as LeafNode)).toBe("b");

    flipHybrid(leftPane.id);
    expect(paneSide(layout.nodes[leftPane.id] as LeafNode)).toBe("a");
    expect(paneSide(layout.nodes[rightPaneId] as LeafNode)).toBe("b");
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

describe("terminal keyboard-protocol survival", () => {
  test("server submit identity is transient and replaceable on every session frame", () => {
    const tab = terminalTab();
    setTerminalSubmitAgent(tab, "opencode");
    expect(tab.submitAgent).toBe("opencode");
    setTerminalSubmitAgent(tab, "gemini");
    expect(tab.submitAgent).toBe("gemini");
    setTerminalSubmitAgent(tab, undefined);
    expect(tab.submitAgent).toBeUndefined();
  });

  test("a fresh spawn creates a zero-state protocol on the tab", () => {
    const tab = terminalTab();

    const protocol = ensureTerminalKeyboardProtocol(tab, true);

    expect(protocol).toBe(tab.keyboardProtocol);
    expect(protocol.xtermModifyOtherKeys).toBe(0);
    expect(protocol.kitty.mainFlags).toBe(0);
  });

  test("a reattach keeps the protocol the program already negotiated", () => {
    const tab = terminalTab();
    const protocol = ensureTerminalKeyboardProtocol(tab, true);
    // The running agent announced modifyOtherKeys; this is what a
    // remount-on-reattach must not lose.
    protocol.xtermModifyOtherKeys = 1;

    // start() on a reattach passes fresh=false (terminalSessionId set).
    const reattached = ensureTerminalKeyboardProtocol(tab, false);

    expect(reattached).toBe(protocol);
    expect(reattached.xtermModifyOtherKeys).toBe(1);
  });

  test("a fresh spawn resets a stale protocol in place (same object)", () => {
    const tab = terminalTab();
    const protocol = ensureTerminalKeyboardProtocol(tab, true);
    protocol.xtermModifyOtherKeys = 1;
    protocol.kitty.mainFlags = 8;

    // A controlled restart / brand-new shell resets, keeping the same
    // reference the installed parser handlers hold.
    const afterRestart = ensureTerminalKeyboardProtocol(tab, true);

    expect(afterRestart).toBe(protocol);
    expect(afterRestart.xtermModifyOtherKeys).toBe(0);
    expect(afterRestart.kitty.mainFlags).toBe(0);
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
      lastAgentEchoSeq: 7,
      terminalActivity: true,
    });

    clearTerminalSession(tab);

    expect(tab.terminalSessionId).toBeUndefined();
    expect(tab.lastAgentEchoSeq).toBeUndefined();
    expect(tab.terminalActivity).toBeUndefined();
  });

  test("keeps terminal session ids out of shareable layout hashes", () => {
    resetLayout([
      terminalTab({
        terminalSessionId: "term_123",
      }),
    ]);

    const layoutSnapshot = serializeLayout();

    expect(JSON.stringify(layoutSnapshot)).not.toContain("term_123");
  });

  test("round-trips terminal session ids in session layouts", async () => {
    resetLayout([
      terminalTab({
        title: "build",
        terminalSessionId: "term_123",
      }),
    ]);
    const layoutSnapshot = serializeLayout({ terminalSessions: true });
    expect(JSON.stringify(layoutSnapshot)).toContain("term_123");

    await restoreLayout(layoutSnapshot!);

    const [tab] = activePane().tabs;
    expect(tab?.kind).toBe("terminal");
    if (tab?.kind !== "terminal") return;
    expect(tab.title).toBe("build");
    expect(tab.terminalSessionId).toBe("term_123");
  });

  test("round-trips terminal agent echo replay cursor only in session layouts", async () => {
    resetLayout([
      terminalTab({
        title: "build",
        terminalSessionId: "term_123",
        lastAgentEchoSeq: 12,
      }),
    ]);

    const hashSnapshot = serializeLayout();
    const sessionSnapshot = serializeLayout({ terminalSessions: true });

    expect(JSON.stringify(hashSnapshot)).not.toContain("\"tae\"");
    expect(JSON.stringify(sessionSnapshot)).toContain("\"tae\":12");

    await restoreLayout(sessionSnapshot!);

    const [tab] = activePane().tabs;
    expect(tab?.kind).toBe("terminal");
    if (tab?.kind !== "terminal") return;
    expect(tab.lastAgentEchoSeq).toBe(12);
  });

  test("round-trips the negotiated keyboard protocol in session layouts", async () => {
    const src = terminalTab({ title: "agent", terminalSessionId: "term_123" });
    // The agent negotiated xterm modifyOtherKeys; this is what a reload
    // reattaching past the replay window must keep so Shift+Enter inserts
    // a newline instead of submitting.
    ensureTerminalKeyboardProtocol(src, true).xtermModifyOtherKeys = 2;
    resetLayout([src]);

    const hashSnapshot = serializeLayout();
    const sessionSnapshot = serializeLayout({ terminalSessions: true });

    // The shareable hash never carries it (it rides with the live session).
    expect(JSON.stringify(hashSnapshot)).not.toContain("\"kp\"");
    expect(JSON.stringify(sessionSnapshot)).toContain("\"kp\"");

    await restoreLayout(sessionSnapshot!);

    const [tab] = activePane().tabs;
    expect(tab?.kind).toBe("terminal");
    if (tab?.kind !== "terminal") return;
    expect(tab.keyboardProtocol?.xtermModifyOtherKeys).toBe(2);
  });

  test("does not serialize the keyboard protocol for a fresh (sessionless) terminal", () => {
    const src = terminalTab({ title: "fresh" });
    ensureTerminalKeyboardProtocol(src, true).xtermModifyOtherKeys = 2;
    resetLayout([src]);
    // No tsid -> the kp rides with the live session only; nothing to persist.
    expect(JSON.stringify(serializeLayout({ terminalSessions: true }))).not.toContain("\"kp\"");
  });

  test("hydrates terminal session ids onto hash-restored terminal tabs", async () => {
    resetLayout([
      terminalTab({
        title: "build",
        terminalSessionId: "term_abc",
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
    expect(tab.lastAgentEchoSeq).toBeUndefined();
  });

  test("hydrates terminal session ids during restore before mount-time reads", async () => {
    resetLayout([
      terminalTab({
        title: "build",
        terminalSessionId: "term_pre_mount",
      }),
    ]);
    const sessionLayout = serializeLayout({ terminalSessions: true });
    const hashLayout = serializeLayout();

    const restored = restoreLayout(hashLayout!, sessionLayout);
    const [tab] = activePane().tabs;
    expect(tab?.kind).toBe("terminal");
    if (tab?.kind !== "terminal") return;
    expect(tab.terminalSessionId).toBe("term_pre_mount");

    await restored;
  });
});

describe("toggleActiveFileTabMode source<->rendered gate (#3/#7)", () => {
  test("markdown flips source <-> wysiwyg", () => {
    const tab = fileTab({ path: "notes/a.md", fileKind: "document", mode: "wysiwyg" });
    resetLayout([tab]);
    toggleActiveFileTabMode();
    expect(activePane().tabs[0]).toMatchObject({ mode: "source" });
    toggleActiveFileTabMode();
    expect(activePane().tabs[0]).toMatchObject({ mode: "wysiwyg" });
  });

  test("JSON flips source <-> pretty (not wysiwyg)", () => {
    const tab = fileTab({ path: "data/x.json", fileKind: "text", mode: "pretty" });
    resetLayout([tab]);
    toggleActiveFileTabMode();
    expect(activePane().tabs[0]).toMatchObject({ mode: "source" });
    toggleActiveFileTabMode();
    expect(activePane().tabs[0]).toMatchObject({ mode: "pretty" });
  });

  test("CSV flips source <-> table", () => {
    const tab = fileTab({ path: "rows.csv", fileKind: "text", mode: "table" });
    resetLayout([tab]);
    toggleActiveFileTabMode();
    expect(activePane().tabs[0]).toMatchObject({ mode: "source" });
    toggleActiveFileTabMode();
    expect(activePane().tabs[0]).toMatchObject({ mode: "table" });
  });

  test("plain-text source files (.rs) do NOT toggle: no invalid wysiwyg render", () => {
    const tab = fileTab({ path: "src/lib.rs", fileKind: "text", mode: "source" });
    resetLayout([tab]);
    toggleActiveFileTabMode();
    expect(activePane().tabs[0]).toMatchObject({ mode: "source" });
    // Even if a stale wysiwyg slipped in somehow, the gate refuses to render it.
    (activePane().tabs[0] as FileTab).mode = "source";
    toggleActiveFileTabMode();
    expect(activePane().tabs[0]).toMatchObject({ mode: "source" });
  });

  test("markdown toggle remaps the caret across the source<->wysiwyg boundary (#16)", () => {
    // The image markdown spans offsets 5..17; its rendered widget is a single
    // position, so a caret on it maps to/from the URL offset across the flip.
    const tab = fileTab({
      path: "notes/a.md",
      fileKind: "document",
      mode: "wysiwyg",
      content: "text ![](pic.png) more",
      caret: { from: 5, to: 5 },
    });
    resetLayout([tab]);
    // wysiwyg -> source: the caret at the image collapses into its URL.
    toggleActiveFileTabMode();
    expect(activePane().tabs[0]).toMatchObject({ mode: "source" });
    expect((activePane().tabs[0] as FileTab).caret).toEqual({ from: 9, to: 9 });
    // source -> wysiwyg: the URL caret maps back onto the image position.
    toggleActiveFileTabMode();
    expect(activePane().tabs[0]).toMatchObject({ mode: "wysiwyg" });
    expect((activePane().tabs[0] as FileTab).caret).toEqual({ from: 5, to: 5 });
  });

  test("non-markdown toggle (JSON) leaves the caret untouched (#16)", () => {
    // pretty<->source has no offset correspondence, so the caret is preserved
    // as-is rather than remapped through the markdown image logic.
    const tab = fileTab({
      path: "data/x.json",
      fileKind: "text",
      mode: "pretty",
      content: '{"a":1}',
      caret: { from: 3, to: 3 },
    });
    resetLayout([tab]);
    toggleActiveFileTabMode();
    expect(activePane().tabs[0]).toMatchObject({ mode: "source" });
    expect((activePane().tabs[0] as FileTab).caret).toEqual({ from: 3, to: 3 });
  });
});

describe("Team Work dialog reload-survival (#4)", () => {
  test("createTeamWorkLeadTerminal flags a pending lead with the default config", () => {
    resetLayout([]);
    const lead = createTeamWorkLeadTerminal({});
    expect(lead?.kind).toBe("terminal");
    if (lead?.kind !== "terminal") return;
    expect(lead.teamWorkPending).toEqual(defaultTeamConfig());
    // The pending lead is discoverable by its flag for the reopen-on-reload path.
    expect(findTeamWorkPendingLead()).toEqual({
      leadTabId: lead.id,
      leadPaneId: activePane().id,
    });
  });

  test("the pending config rides the session payload but NOT the shareable hash", () => {
    resetLayout([]);
    const lead = createTeamWorkLeadTerminal({});
    if (lead?.kind !== "terminal") return;
    const req = { leadTabId: lead.id, leadPaneId: activePane().id };
    // A member env can carry secrets, so it must never leak into the URL hash.
    setTeamWorkPendingConfig(req, {
      ...defaultTeamConfig(),
      teamDir: "secret-team",
      members: [
        { name: "Lead", command: "claude", env: "TOKEN=hunter2", isLead: true },
      ],
    });

    const hashSnapshot = serializeLayout();
    const sessionSnapshot = serializeLayout({ terminalSessions: true });

    expect(JSON.stringify(hashSnapshot)).not.toContain("twk");
    expect(JSON.stringify(hashSnapshot)).not.toContain("hunter2");
    expect(JSON.stringify(sessionSnapshot)).toContain("\"twk\"");
    expect(JSON.stringify(sessionSnapshot)).toContain("secret-team");
  });

  test("restores the pending lead + its config from a session layout", async () => {
    resetLayout([]);
    const lead = createTeamWorkLeadTerminal({});
    if (lead?.kind !== "terminal") return;
    const req = { leadTabId: lead.id, leadPaneId: activePane().id };
    setTeamWorkPendingConfig(req, { ...defaultTeamConfig(), teamDir: "alpha", size: 3 });

    const sessionSnapshot = serializeLayout({ terminalSessions: true });
    await restoreLayout(sessionSnapshot!);

    const [tab] = activePane().tabs;
    expect(tab?.kind).toBe("terminal");
    if (tab?.kind !== "terminal") return;
    expect(tab.teamWorkPending?.teamDir).toBe("alpha");
    expect(tab.teamWorkPending?.size).toBe(3);
    // The restored tab has a fresh id; the dialog relocates it by the flag.
    const pending = findTeamWorkPendingLead();
    expect(pending?.leadTabId).toBe(tab.id);
    expect(teamWorkPendingConfig(pending!)?.teamDir).toBe("alpha");
  });

  test("grafts the pending config onto a hash-restored lead (reload via URL hash)", async () => {
    resetLayout([]);
    const lead = createTeamWorkLeadTerminal({});
    if (lead?.kind !== "terminal") return;
    setTeamWorkPendingConfig(
      { leadTabId: lead.id, leadPaneId: activePane().id },
      { ...defaultTeamConfig(), teamDir: "beta" },
    );

    // A plain reload carries the hash (no twk); the session layout grafts it
    // back positionally, same as tsid.
    const hashSnapshot = serializeLayout();
    const sessionSnapshot = serializeLayout({ terminalSessions: true });
    await restoreLayout(hashSnapshot!, sessionSnapshot);

    const [tab] = activePane().tabs;
    if (tab?.kind !== "terminal") return;
    expect(tab.teamWorkPending?.teamDir).toBe("beta");
    expect(findTeamWorkPendingLead()?.leadTabId).toBe(tab.id);
  });

  test("reopen wiring: a restored pending lead drives openTeamDialog (store bootstrap path)", async () => {
    closeTeamDialog();
    resetLayout([]);
    const lead = createTeamWorkLeadTerminal({});
    if (lead?.kind !== "terminal") return;
    setTeamWorkPendingConfig(
      { leadTabId: lead.id, leadPaneId: activePane().id },
      { ...defaultTeamConfig(), teamDir: "gamma" },
    );

    // Simulate the reload: serialize the session, drop the dialog request (it's
    // in-memory, lost on reload), restore the layout fresh.
    const sessionSnapshot = serializeLayout({ terminalSessions: true });
    closeTeamDialog();
    expect(teamDialogState.request).toBeNull();
    await restoreLayout(sessionSnapshot!);

    // What store.svelte.ts does after restore in bootstrap:
    const pending = findTeamWorkPendingLead();
    expect(pending).not.toBeNull();
    if (pending) openTeamDialog(pending);

    const [tab] = activePane().tabs;
    expect(teamDialogState.request).toEqual({
      leadTabId: tab.id,
      leadPaneId: activePane().id,
    });
    expect(teamWorkPendingConfig(teamDialogState.request!)?.teamDir).toBe("gamma");
    closeTeamDialog();
  });

  test("clearTeamWorkPending drops the flag so a committed lead won't reopen", () => {
    resetLayout([]);
    const lead = createTeamWorkLeadTerminal({});
    if (lead?.kind !== "terminal") return;
    const req = { leadTabId: lead.id, leadPaneId: activePane().id };
    clearTeamWorkPending(req);
    // Assert through the live layout (the reactive accessors the dialog +
    // serializer use), not the factory's return reference.
    expect(teamWorkPendingConfig(req)).toBeNull();
    expect(findTeamWorkPendingLead()).toBeNull();
    // A committed lead's terminal carries no twk into the session payload.
    expect(JSON.stringify(serializeLayout({ terminalSessions: true }))).not.toContain("twk");
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
        authority_version: 7,
        disk_conflicted: false,
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
        authority_version: 7,
        disk_conflicted: false,
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
    expect(tab.authorityVersion).toBe(7);
    expect(tab.diskConflicted).toBe(false);
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

    setTerminalSession(tab, "term_live");
    expect(tab.terminalEnvTabName).toBe("build");
    expect(terminalEnvTabNameStale(tab)).toBe(false);

    renameTerminalTab(tab, "deploy");

    expect(terminalEnvTabNameStale(tab)).toBe(true);
    expect(tab.terminalEnvNamePromptDismissed).toBe(false);

    dismissTerminalEnvNamePrompt(tab);
    expect(tab.terminalEnvNamePromptDismissed).toBe(true);

    renameTerminalTab(tab, "ship");
    expect(tab.terminalEnvNamePromptDismissed).toBe(false);

    setTerminalSession(tab, "term_new");
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
      authorityVersion: 7,
    });
    resetLayout([tab]);
    const write = vi
      .spyOn(api, "write")
      .mockResolvedValue({
        mtime: 2,
        mtime_ns: "2000000002",
        authority_version: 8,
        disk_conflicted: false,
      });

    await saveTab(tab);

    expect(write).toHaveBeenCalledWith(
      "notes/a.md",
      "a\n\tb\n",
      "1000000001",
      1,
      7,
    );
    expect(tab.content).toBe("a\n\tb\n");
    expect(tab.saved).toBe("a\n\tb\n");
    expect(tab.savedMtimeNs).toBe("2000000002");
    expect(tab.authorityVersion).toBe(8);
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

  test("broadcast membership is scoped to the source's group", () => {
    const a = terminalTab({ id: "term-a", title: "A" });
    const b = terminalTab({ id: "term-b", title: "B" });
    const c = terminalTab({ id: "term-c", title: "C", group: "foobar" });
    const d = terminalTab({ id: "term-d", title: "D", group: "foobar" });
    resetLayout([a, b, c, d]);
    const tab = (id: string) =>
      activePane().tabs.find((candidate) => candidate.id === id) as TerminalTab;

    // Enable broadcast on one terminal in each group plus its peer.
    setTerminalBroadcastEnabled(tab("term-a"), true);
    setTerminalBroadcastEnabled(tab("term-b"), true);
    setTerminalBroadcastEnabled(tab("term-c"), true);
    setTerminalBroadcastEnabled(tab("term-d"), true);

    // The default-group source only sees default-group members; the
    // foobar-group source only sees foobar-group members.
    expect(terminalBroadcastMemberIds(tab("term-a")).sort()).toEqual([
      "term-a",
      "term-b",
    ]);
    expect(terminalBroadcastMemberIds(tab("term-c")).sort()).toEqual([
      "term-c",
      "term-d",
    ]);
  });

  test("broadcast fan-out does not cross group boundaries", () => {
    const a = terminalTab({ id: "term-a", title: "A" });
    const b = terminalTab({ id: "term-b", title: "B" });
    const c = terminalTab({ id: "term-c", title: "C", group: "foobar" });
    resetLayout([a, b, c]);
    const tab = (id: string) =>
      activePane().tabs.find((candidate) => candidate.id === id) as TerminalTab;
    const received: string[] = [];
    const unregisterA = registerTerminalInputSink("term-a", (data) => received.push(`a:${data}`));
    const unregisterB = registerTerminalInputSink("term-b", (data) => received.push(`b:${data}`));
    const unregisterC = registerTerminalInputSink("term-c", (data) => received.push(`c:${data}`));

    setTerminalBroadcastEnabled(tab("term-a"), true);
    setTerminalBroadcastEnabled(tab("term-b"), true);
    setTerminalBroadcastEnabled(tab("term-c"), true);

    // term-a (default) fans out only to its in-group peer term-b, never
    // to term-c in the foobar group.
    broadcastTerminalInput(tab("term-a"), "x");
    expect(received).toEqual(["b:x"]);

    unregisterA();
    unregisterB();
    unregisterC();
  });

  test("select-all on a grouped terminal flips only its group", () => {
    const a = terminalTab({ id: "term-a", title: "A", group: "foobar" });
    const b = terminalTab({ id: "term-b", title: "B", group: "foobar" });
    const c = terminalTab({ id: "term-c", title: "C" });
    resetLayout([a, b, c]); // term-a is the active terminal (foobar group)
    const tab = (id: string) =>
      activePane().tabs.find((candidate) => candidate.id === id) as TerminalTab;

    toggleActiveTerminalBroadcastSelectAll();

    expect(tab("term-a").broadcastEnabled).toBe(true);
    expect(tab("term-b").broadcastEnabled).toBe(true);
    // The default-group terminal is untouched by a foobar select-all.
    expect(tab("term-c").broadcastEnabled).toBe(false);
    expect(terminalBroadcastMemberIds(tab("term-a")).sort()).toEqual([
      "term-a",
      "term-b",
    ]);
  });

  test("select-all spans windows: same-group cross-window members toggle via the server", () => {
    const a = terminalTab({ id: "term-a", title: "A", terminalSessionId: "sess-a" });
    resetLayout([a]);
    // A same-group terminal in ANOTHER window (roster only, not local layout).
    applyTerminalRoster([
      { id: "sess-x", tab_name: "X", tab_group: "default", window_id: "other-win", broadcast: false },
    ]);
    const spy = vi
      .spyOn(api, "setTerminalSessionBroadcast")
      .mockResolvedValue(undefined);

    // Nothing on -> Select All turns on self AND the cross-window member.
    toggleActiveTerminalBroadcastSelectAll();
    expect((activePane().tabs[0] as TerminalTab).broadcastEnabled).toBe(true);
    expect(spy).toHaveBeenCalledWith("sess-x", true);

    // Simulate the cross member now on (the round-trip), then Deselect All
    // turns the whole group off, including the cross-window member.
    applyTerminalRoster([
      { id: "sess-x", tab_name: "X", tab_group: "default", window_id: "other-win", broadcast: true },
    ]);
    spy.mockClear();
    toggleActiveTerminalBroadcastSelectAll();
    expect((activePane().tabs[0] as TerminalTab).broadcastEnabled).toBe(false);
    expect(spy).toHaveBeenCalledWith("sess-x", false);

    spy.mockRestore();
    applyTerminalRoster([]);
  });

  test("setTerminalBroadcastBySession flips the matching local terminal only", () => {
    const a = terminalTab({ id: "term-a", title: "A", terminalSessionId: "sess-a" });
    resetLayout([a]);
    const tab = () => activePane().tabs[0] as TerminalTab;

    setTerminalBroadcastBySession("sess-a", true);
    expect(tab().broadcastEnabled).toBe(true);
    setTerminalBroadcastBySession("sess-a", false);
    expect(tab().broadcastEnabled).toBe(false);
    // Unknown session id is a no-op (no local tab hosts it).
    setTerminalBroadcastBySession("sess-nope", true);
    expect(tab().broadcastEnabled).toBe(false);
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

  test("mention: scope reads as 'mention=@@<name>'", () => {
    expect(graphTitle("semantic", "mention:@@Lead")).toBe("mention=@@Lead");
    // Mention without the leading @@ gets one prepended (then the prefix).
    expect(graphTitle("semantic", "mention:Lead")).toBe("mention=@@Lead");
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

describe("layoutHasPersistableStructure (terminal-only / empty-split persistence)", () => {
  test("persists a terminal-only single pane", () => {
    expect(
      layoutHasPersistableStructure({ k: "l", t: [{ k: "t", n: "Terminal", a: 1 }] }),
    ).toBe(true);
  });

  test("persists a split even when both panes are empty", () => {
    expect(
      layoutHasPersistableStructure({
        k: "s",
        d: "r",
        a: { k: "l", t: [] },
        b: { k: "l", t: [] },
      }),
    ).toBe(true);
  });

  test("persists a split of terminals", () => {
    expect(
      layoutHasPersistableStructure({
        k: "s",
        d: "r",
        a: { k: "l", t: [{ k: "t", n: "Terminal", a: 1 }] },
        b: { k: "l", t: [{ k: "t", n: "Terminal" }] },
      }),
    ).toBe(true);
  });

  test("does NOT persist a single empty pane (the default window)", () => {
    expect(layoutHasPersistableStructure({ k: "l", t: [] })).toBe(false);
  });

  test("does NOT persist a single durable-only pane (handled by the durable gate)", () => {
    expect(
      layoutHasPersistableStructure({ k: "l", t: [{ k: "f", p: "notes.md", a: 1 }] }),
    ).toBe(false);
  });

  test("returns false for a null layout", () => {
    expect(layoutHasPersistableStructure(null)).toBe(false);
  });
});

describe("openInPane content peek (open any plaintext, refuse binary)", () => {
  test("opens a non-extension-editable file the server serves as text", async () => {
    resetLayout([]);
    // The probe and the real load both hit the mock; both resolve as text, so
    // the odd-suffix file opens as a source tab (the server's content gate, the
    // same one `cs open` uses, accepted it).
    vi.spyOn(api, "readStream").mockResolvedValue({
      path: "src/app.unknownext",
      content: "plain text body\n",
      mtime: 1,
      mtime_ns: "1",
      writable: true,
    });
    await openInPane("pane-test", "src/app.unknownext");
    const openTabs = activePane().tabs;
    expect(openTabs).toHaveLength(1);
    const live = openTabs[0];
    if (live?.kind !== "file") throw new Error("expected a file tab");
    expect(live.path).toBe("src/app.unknownext");
    expect(live.content).toBe("plain text body\n");
    // Non-markdown plaintext opens in source mode, not wysiwyg.
    expect(live.fileKind).toBe("text");
  });

  test("refuses a binary file (415) without opening a tab", async () => {
    resetLayout([]);
    vi.spyOn(api, "readStream").mockRejectedValue(
      new ApiError(415, "file is not editable text"),
    );
    await openInPane("pane-test", "assets/logo.bin");
    // The binary file is refused: no tab opens (it stays view-only).
    expect(activePane().tabs).toHaveLength(0);
  });

  test("editable-by-extension files skip the peek and open directly", async () => {
    resetLayout([]);
    const read = vi.spyOn(api, "readStream").mockResolvedValue({
      path: "notes/a.md",
      content: "# hi\n",
      mtime: 1,
      mtime_ns: "1",
      writable: true,
    });
    await openInPane("pane-test", "notes/a.md");
    expect(activePane().tabs).toHaveLength(1);
    // A `.md` is editable by extension, so it never peeks: readStream is the
    // single real load, not a probe + a load.
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe("openLinkTarget resolves a wiki/link stem before opening", () => {
  test("opens the resolve-link path, not the raw `[[note]]` stem", async () => {
    resetLayout([]);
    // The pill rendered because resolve-link found `notes/note.md`; the
    // click must open THAT, not the extension-less stem the read route
    // would 404 on.
    const resolve = vi
      .spyOn(api, "resolveLink")
      .mockResolvedValue({ path: "notes/note.md", kind: "file" });
    const read = vi.spyOn(api, "readStream").mockResolvedValue({
      path: "notes/note.md",
      content: "# note\n",
      mtime: 1,
      mtime_ns: "1",
      writable: true,
    });

    await openLinkTarget("notes/note");

    expect(resolve).toHaveBeenCalledWith("notes/note");
    // readStream got the resolved `.md` path, never the bare stem.
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]?.[0]).toBe("notes/note.md");
    const tabs = activePane().tabs;
    expect(tabs).toHaveLength(1);
    const live = tabs[0];
    if (live?.kind !== "file") throw new Error("expected a file tab");
    expect(live.path).toBe("notes/note.md");
    expect(live.fileMissing).toBeNull();
  });

  test("a directory link opens the file browser at that folder, not the editor", async () => {
    resetLayout([]);
    const resolve = vi
      .spyOn(api, "resolveLink")
      .mockResolvedValue({ path: "team", kind: "file", is_dir: true });
    const read = vi.spyOn(api, "readStream").mockResolvedValue({
      path: "team",
      content: "",
      mtime: 1,
      mtime_ns: "1",
      writable: true,
    });

    await openLinkTarget("team");

    expect(resolve).toHaveBeenCalledWith("team");
    // A directory routes to the file browser: the editor read route is
    // never hit, so it can't reject the folder as "not a text file".
    expect(read).not.toHaveBeenCalled();
    const tabs = activePane().tabs;
    expect(tabs).toHaveLength(1);
    const live = tabs[0];
    if (live?.kind !== "browser") throw new Error("expected a browser tab");
    expect(live.selected).toBe("team");
  });

  test("falls back to the raw target when resolve fails (broken link still surfaces)", async () => {
    resetLayout([]);
    vi.spyOn(api, "resolveLink").mockRejectedValue(new ApiError(404, "not found"));
    const read = vi.spyOn(api, "readStream").mockResolvedValue({
      path: "notes/real.md",
      content: "x\n",
      mtime: 1,
      mtime_ns: "1",
      writable: true,
    });

    await openLinkTarget("notes/real.md");

    // Unresolvable resolve-link → open the raw target verbatim so the
    // normal open path (and its missing-file banner) takes over.
    expect(read).toHaveBeenCalledWith("notes/real.md", expect.anything());
    expect(activePane().tabs).toHaveLength(1);
  });
});

describe("excalidraw canvas mode", () => {
  function activeFileMode(): string | null {
    const t = activePane().tabs[0];
    return t?.kind === "file" ? t.mode : null;
  }

  test("Mod+E flips an excalidraw tab between canvas and source", () => {
    resetLayout([
      fileTab({ path: "draw/board.excalidraw", fileKind: "text", mode: "canvas" }),
    ]);
    // toggleActiveFileTabMode is the Mod+E chord's handler; the rendered
    // surface for .excalidraw is canvas, so it swaps canvas <-> source.
    toggleActiveFileTabMode();
    expect(activeFileMode()).toBe("source");
    toggleActiveFileTabMode();
    expect(activeFileMode()).toBe("canvas");
  });

  test("a fresh .excalidraw tab restores in canvas mode by default", async () => {
    vi.spyOn(api, "readStream").mockResolvedValue({
      path: "draw/board.excalidraw",
      content: "{}",
      mtime: 1,
      writable: true,
    });
    // No persisted mode: validateRestoredMode falls to defaultModeForPath,
    // which routes .excalidraw to canvas. fileKind is plain text.
    await restoreLayout({
      k: "l",
      t: [{ k: "f", p: "draw/board.excalidraw", a: 1 }],
      pc: "p",
    });
    const tab = activePane().tabs[0];
    expect(tab?.kind).toBe("file");
    if (tab?.kind !== "file") return;
    expect(tab.mode).toBe("canvas");
    expect(tab.fileKind).toBe("text");
  });

  test("a persisted canvas mode round-trips through serialize/restore", async () => {
    vi.spyOn(api, "readStream").mockResolvedValue({
      path: "draw/board.excalidraw",
      content: "{}",
      mtime: 1,
      writable: true,
    });
    resetLayout([
      fileTab({ path: "draw/board.excalidraw", fileKind: "text", mode: "canvas" }),
    ]);
    const snapshot = serializeLayout();
    await restoreLayout(snapshot!);
    expect(activeFileMode()).toBe("canvas");
  });

  test("a canvas mode persisted for a non-excalidraw path falls back", async () => {
    vi.spyOn(api, "readStream").mockResolvedValue({
      path: "notes/a.md",
      content: "# hi",
      mtime: 1,
      writable: true,
    });
    // isModeValidForPath gates canvas to .excalidraw, so a stale canvas
    // mode on a markdown path restores to the markdown default, not canvas.
    await restoreLayout({
      k: "l",
      t: [{ k: "f", p: "notes/a.md", m: "canvas", a: 1 }],
      pc: "p",
    });
    expect(activeFileMode()).toBe("wysiwyg");
  });
});
