// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../api/client";
import { ApiError } from "../api/errors";
import { fileTab, readTab, resetLayout, terminalTab } from "../__tests__/tabs";
import { confirmState, resolveConfirm } from "./confirm.svelte";
import * as notifications from "./notify.svelte";
import {
  closeFileTabAfterMove,
  closePane,
  closeTab,
  conflictDialog,
  dismissConflict,
  draftCloseState,
  forceReloadFromDisk,
  isDirty,
  registerTerminalInputSink,
  rekeyTabsForRename,
  reloadTabFromDisk,
  resolveDraftClose,
  scheduleAutosave,
  setTabContent,
} from "./tabs.svelte";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  resolveConfirm(false);
  resolveDraftClose("cancel");
  dismissConflict();
  resetLayout([]);
});

// What a typo in source mode leaves: a trailing comma.
const BROKEN = '{ "type": "excalidraw", "elements": [], }';
const SAVED = '{ "type": "excalidraw", "elements": [] }';

/// What the parser says of `BROKEN`, as the save's check reports it.
function parseReason(src: string): string {
  try {
    JSON.parse(src);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("the buffer parses");
}

/// A drawing in source mode with no live session, holding `content` over
/// what was last saved, with its writes recorded.
function drawingTab(path: string, content = BROKEN, id = "board-1") {
  return fileTab({ id, path, fileKind: "text", mode: "source", content, saved: SAVED });
}

function stubWrites() {
  return vi.spyOn(api, "write").mockResolvedValue({ mtime: 2, mtime_ns: "2" });
}

function written(write: ReturnType<typeof stubWrites>): string[][] {
  return write.mock.calls.map((call) => [call[0], call[1] as string]);
}

/// Every turn a close's save queued has run: a close that is going to ask
/// has asked by then. That holds while every step between the conflict
/// opening its dialog and a close asking is a microtask; an await that
/// takes a timer there would let a question arrive after the read.
async function settled(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await new Promise((r) => setTimeout(r, 0));
}

describe("the close of a drawing whose save is refused", () => {
  test("an unanswered live push keeps a clean-looking buffer open until the user decides", async () => {
    const tab = fileTab({
      id: "unanswered-live-push",
      content: "same text",
      saved: "same text",
      unresolvedLivePush: true,
      unresolvedLiveSave: true,
      saveError: "the previous live push has not been confirmed",
    });
    const pane = resetLayout([tab]);
    const write = vi.spyOn(api, "write");
    const close = closeTab(pane.id, tab.id);
    await vi.waitFor(() => expect(confirmState.open).toBe(true));
    expect(confirmState.message).toContain("previous live push has not been confirmed");
    expect(write).not.toHaveBeenCalled();
    resolveConfirm(false);
    await close;
    expect(readTab(tab.id)).toBeDefined();
  });

  test("asks, naming the file and the reason, and keeps editing on a no", async () => {
    const pane = resetLayout([drawingTab("notes/board.excalidraw")]);
    const write = stubWrites();

    const close = closeTab(pane.id, "board-1");
    await vi.waitFor(() => expect(confirmState.open).toBe(true));
    expect({
      title: confirmState.title,
      message: confirmState.message,
      confirm: confirmState.confirmLabel,
      cancel: confirmState.cancelLabel,
      destructive: confirmState.destructive,
    }).toEqual({
      title: "Close without saving?",
      message: `board.excalidraw was not saved because the drawing does not parse (${parseReason(BROKEN)}). Its changes will be lost.`,
      confirm: "Close without saving",
      cancel: "Keep editing",
      destructive: true,
    });
    resolveConfirm(false);
    await close;

    const tab = readTab("board-1");
    expect({ open: tab !== undefined, content: tab?.content, dirty: tab ? isDirty(tab) : null, written: written(write) }).toEqual({
      open: true, content: BROKEN, dirty: true, written: [],
    });
  });

  test("closes without writing on a yes", async () => {
    const pane = resetLayout([drawingTab("notes/board.excalidraw")]);
    const write = stubWrites();

    const close = closeTab(pane.id, "board-1");
    await vi.waitFor(() => expect(confirmState.open).toBe(true));
    resolveConfirm(true);
    await close;

    expect({ open: readTab("board-1") !== undefined, written: written(write) }).toEqual({ open: false, written: [] });
  });

  test("of a pane saves every other tab and asks once for the refused ones", async () => {
    const pane = resetLayout([
      drawingTab("boards/a.excalidraw", BROKEN, "board-a"),
      drawingTab("boards/b.excalidraw", BROKEN, "board-b"),
      fileTab({ id: "notes-1", path: "notes/a.md", content: "edited", saved: "saved" }),
    ]);
    const write = stubWrites();

    const close = closePane(pane.id);
    await vi.waitFor(() => expect(confirmState.open).toBe(true));
    expect({ written: written(write), message: confirmState.message }).toEqual({
      written: [["notes/a.md", "edited"]],
      message: "2 files were not saved: a.excalidraw and b.excalidraw. Their changes will be lost.",
    });
    resolveConfirm(false);
    await close;

    expect(["board-a", "board-b", "notes-1"].map((id) => readTab(id)?.content)).toEqual([BROKEN, BROKEN, "edited"]);
  });

  test("with a running terminal in the same close, the dialog speaks of closing and names both", async () => {
    const pane = resetLayout([drawingTab("notes/board.excalidraw"), terminalTab({ id: "term-1", title: "build" })]);
    stubWrites();
    const unregister = registerTerminalInputSink("term-1", () => {});

    const close = closePane(pane.id);
    await vi.waitFor(() => expect(confirmState.open).toBe(true));
    expect({
      title: confirmState.title,
      message: confirmState.message,
      confirm: confirmState.confirmLabel,
      cancel: confirmState.cancelLabel,
      destructive: confirmState.destructive,
    }).toEqual({
      title: "Close tabs?",
      message: `board.excalidraw was not saved because the drawing does not parse (${parseReason(BROKEN)}). Its changes will be lost. build is still running.`,
      confirm: "Close",
      cancel: "Cancel",
      destructive: true,
    });
    resolveConfirm(false);
    await close;
    unregister();
  });

  test("names three refused files in one sentence", async () => {
    const pane = resetLayout([
      drawingTab("boards/a.excalidraw", BROKEN, "board-a"),
      drawingTab("boards/b.excalidraw", BROKEN, "board-b"),
      drawingTab("boards/c.excalidraw", BROKEN, "board-c"),
    ]);
    stubWrites();

    const close = closePane(pane.id);
    await vi.waitFor(() => expect(confirmState.open).toBe(true));
    expect(confirmState.message).toBe("3 files were not saved: a.excalidraw, b.excalidraw and c.excalidraw. Their changes will be lost.");
    resolveConfirm(false);
    await close;
  });

  test("a tab still dirty after a conflict is not asked about and stays open", async () => {
    // The conflict dialog is what speaks for this tab.
    const typed = '{ "type": "excalidraw", "elements": [1] }';
    const pane = resetLayout([drawingTab("notes/board.excalidraw", typed)]);
    vi.spyOn(api, "write").mockRejectedValue(
      new ApiError(409, "conflict", { current_mtime: 5, current_mtime_ns: "5" }),
    );

    const close = closeTab(pane.id, "board-1");
    await vi.waitFor(() => expect(conflictDialog.open).toBe(true));
    await settled();

    expect({ asked: confirmState.open, open: readTab("board-1") !== undefined }).toEqual({ asked: false, open: true });
    resolveConfirm(false);
    await close;
  });

  test("a drawing fixed after a refusal whose save meets a conflict is not asked about", async () => {
    const pane = resetLayout([drawingTab("notes/board.excalidraw")]);
    stubWrites();
    vi.useFakeTimers();
    scheduleAutosave(pane.id, "board-1");
    await vi.advanceTimersByTimeAsync(900);
    vi.useRealTimers();
    setTabContent(readTab("board-1")!, '{ "type": "excalidraw", "elements": [1] }');
    vi.spyOn(api, "write").mockRejectedValue(
      new ApiError(409, "conflict", { current_mtime: 5, current_mtime_ns: "5" }),
    );

    const close = closeTab(pane.id, "board-1");
    await vi.waitFor(() => expect(conflictDialog.open).toBe(true));
    await settled();

    expect({ asked: confirmState.open, open: readTab("board-1") !== undefined }).toEqual({ asked: false, open: true });
    resolveConfirm(false);
    await close;
  });
});

describe("a refused drawing that does not close says why", () => {
  test("a draft is not closed, and a notice says that it was not saved", async () => {
    const path = ".Drafts/untitled/untitled.excalidraw";
    const pane = resetLayout([drawingTab(path)]);
    const write = stubWrites();
    const notice = vi.spyOn(notifications, "notify");
    const inspect = vi.spyOn(api, "inspectDraft");

    await closeTab(pane.id, "board-1");

    expect({
      notices: notice.mock.calls,
      content: readTab("board-1")?.content,
      written: written(write),
      inspected: inspect.mock.calls.length,
      draftDialog: draftCloseState.open,
    }).toEqual({
      notices: [["untitled.excalidraw was not saved."]],
      content: BROKEN,
      written: [],
      inspected: 0,
      draftDialog: false,
    });
  });

  test("a draft whose refused edits are undone closes through its own dialog, with no notice", async () => {
    const path = ".Drafts/untitled/untitled.excalidraw";
    const pane = resetLayout([drawingTab(path)]);
    const write = stubWrites();
    vi.useFakeTimers();
    scheduleAutosave(pane.id, "board-1");
    await vi.advanceTimersByTimeAsync(900);
    vi.useRealTimers();
    setTabContent(readTab("board-1")!, SAVED);
    const notice = vi.spyOn(notifications, "notify");
    vi.spyOn(api, "inspectDraft").mockResolvedValue({
      path,
      name: "untitled",
      file_count: 1,
      dir_count: 0,
      total_size: SAVED.length,
      has_attachments: false,
    });

    const close = closeTab(pane.id, "board-1");
    await vi.waitFor(() => expect(draftCloseState.open).toBe(true));
    resolveDraftClose("cancel");
    await close;

    expect({ notices: notice.mock.calls, written: written(write) }).toEqual({ notices: [], written: [] });
  });

  test("a move to another window leaves it here, and a notice says that it was not saved", async () => {
    const pane = resetLayout([drawingTab("notes/board.excalidraw")]);
    const write = stubWrites();
    const notice = vi.spyOn(notifications, "notify");

    await closeFileTabAfterMove(pane.id, "board-1");

    expect({ open: readTab("board-1") !== undefined, notices: notice.mock.calls, written: written(write) }).toEqual({
      open: true,
      notices: [["board.excalidraw was not saved and stays in this window."]],
      written: [],
    });
  });
});

describe("the reason a drawing was not saved", () => {
  test("goes when a rename takes the tab out of the check and its next save writes", async () => {
    const pane = resetLayout([drawingTab("notes/board.excalidraw")]);
    const write = stubWrites();
    vi.useFakeTimers();
    scheduleAutosave(pane.id, "board-1");
    await vi.advanceTimersByTimeAsync(900);
    rekeyTabsForRename("notes/board.excalidraw", "notes/board.json");
    scheduleAutosave(pane.id, "board-1");
    await vi.advanceTimersByTimeAsync(900);

    const tab = readTab("board-1")!;
    expect({ written: written(write), saveError: tab.saveError, dirty: isDirty(tab) }).toEqual({
      written: [["notes/board.json", BROKEN]], saveError: null, dirty: false,
    });
  });

  test("goes with the hold at a load, which replaces the text", async () => {
    const pane = resetLayout([drawingTab("notes/board.excalidraw")]);
    stubWrites();
    vi.useFakeTimers();
    scheduleAutosave(pane.id, "board-1");
    await vi.advanceTimersByTimeAsync(900);
    vi.useRealTimers();
    vi.spyOn(api, "readStream").mockResolvedValue({ path: "notes/board.excalidraw", content: SAVED, mtime: 3, mtime_ns: "3000000000" } as never);
    await reloadTabFromDisk("board-1");
    setTabContent(readTab("board-1")!, '{ "type": "excalidraw", "elements": [2] }');

    const tab = readTab("board-1")!;
    expect({ reason: tab.saveError, held: tab.refusedUnwritten }).toEqual({ reason: null, held: false });
  });

  test("goes with the hold when a conflict's resolution is adopted", async () => {
    const pane = resetLayout([{ ...drawingTab("notes/board.excalidraw"), diskConflicted: true }]);
    stubWrites();
    vi.useFakeTimers();
    scheduleAutosave(pane.id, "board-1");
    await vi.advanceTimersByTimeAsync(900);
    vi.useRealTimers();
    vi.spyOn(api, "resolveSessionConflict").mockResolvedValue({
      path: "notes/board.excalidraw", content: SAVED, mtime: 4, mtime_ns: "4000000000", authority_version: 2, disk_conflicted: false, writable: true,
    } as never);
    const reload = forceReloadFromDisk("board-1");
    await vi.waitFor(() => expect(confirmState.open).toBe(true));
    resolveConfirm(true);
    await reload;
    setTabContent(readTab("board-1")!, '{ "type": "excalidraw", "elements": [2] }');

    const tab = readTab("board-1")!;
    expect({ reason: tab.saveError, held: tab.refusedUnwritten }).toEqual({ reason: null, held: false });
  });
});
