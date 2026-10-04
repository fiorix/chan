// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import FileEditorTab from "./FileEditorTab.svelte";
import { api, sessionWindowId } from "../api/client";
import { setSocketFactory } from "../api/transport";
import { demoSocketFactory } from "../demo/socket";
import { resetSceneSyncForTests, sceneSessionFor } from "../state/sceneSync.svelte";
import { applySessionRoster } from "../state/session.svelte";
import { ApiError } from "../api/errors";
import { confirmState, resolveConfirm } from "../state/confirm.svelte";
import { bufferKey, SESSION_ID } from "../state/editorBuffer";
import { fileTab, readTab, resetLayout } from "../__tests__/tabs";
import { installEditorDom } from "../__tests__/wysiwyg";
import { installDemoWorkspace, uninstallDemoWorkspace } from "../demo/install";
import { EXCALIDRAW_VERSION, boardPropsFromRender, excalidrawBoard, type BoardProps } from "../__tests__/excalidrawLibrary";
import { trackTimers, type TimerTrack } from "../demo/timers";
import { applyLocalTheme, effectiveHybridSurfaceTheme, onWatchEvent, refreshWorkspace } from "../state/store.svelte";
import {
  closeFileTabAfterMove, closePane, detachTabToPaneEdge,
  closeTab, closeTabsInPane, draftCloseState, resolveDraftClose, setMode, reconcileLayout, saveTab,
  clearRecentlyClosedTabsForTest, isDirty, reloadTabFromDisk, reopenClosedTab, scheduleAutosave, setTabReadMode,
  forceReloadFromDisk, refreshTabFromDisk, layout, moveTab, rekeyTabsForRename, setTabContent, splitPane,
  conflictDialog, isDocUnflushed, reloadConflictedTab, overwriteConflictedTab, overwriteDiskConflict, applyFsWritable,
  type FileTab, type SerNode,
} from "../state/tabs.svelte";

const { render, unmountRoot, beforeLibrary, scene } = vi.hoisted(() => ({
  render: vi.fn(),
  unmountRoot: vi.fn(),
  beforeLibrary: { run: null as (() => void) | null },
  // Whether a drawing may take a live scene session: off unless a test turns
  // it on.
  scene: { live: false },
}));
vi.mock("react-dom/client", () => ({ createRoot: () => ({ render, unmount: unmountRoot }) }));
vi.mock("react", () => ({
  Component: class {
    props: unknown;
    state: Record<string, unknown> = {};
    constructor(props: unknown) { this.props = props; }
  },
  createElement: (type: unknown, props: Record<string, unknown>, child?: unknown) =>
    ({ type, props: child === undefined ? props : { ...props, children: child } }),
}));
vi.mock("@excalidraw/excalidraw", async () => (await import("../__tests__/excalidrawLibrary")).excalidrawModule);
// The canvas configures the library's assets after it is created and before
// it imports the library, so `beforeLibrary.run` is a step taken in that gap.
vi.mock("../editor/excalidrawAssets", () => ({
  configureExcalidrawAssets: () => {
    const run = beforeLibrary.run;
    beforeLibrary.run = null;
    run?.();
  },
}));
vi.mock("../state/sceneSync.svelte", async (original) => {
  const actual = await original<typeof import("../state/sceneSync.svelte")>();
  return { ...actual, isSceneSyncEligible: (tab: FileTab) => scene.live && actual.isSceneSyncEligible(tab) };
});
vi.mock("../state/docSync.svelte", async (original) => ({
  ...await original<typeof import("../state/docSync.svelte")>(),
  isDocSyncEligible: () => false,
}));

installEditorDom();
const INITIAL = '{"type":"excalidraw","version":2,"source":"chan","elements":[],"appState":{},"files":{}}';
const mounted: ReturnType<typeof mount>[] = [];
let timers: TimerTrack;
let disk: ReturnType<typeof installDemoWorkspace>;
type CanvasProps = BoardProps;
let canvasReady: Promise<CanvasProps>;

beforeEach(async () => {
  timers = trackTimers();
  disk = installDemoWorkspace({
    metadata: { workspaceRoot: "demo", label: "demo", generatedAt: 1, fileCount: 0, textCount: 0 },
    files: [],
  });
  await refreshWorkspace();
  render.mockReset();
  beforeLibrary.run = null;
  canvasReady = new Promise((resolve) => {
    render.mockImplementation((element: unknown) => resolve(boardPropsFromRender(element)));
  });
  unmountRoot.mockClear();
});

afterEach(async () => {
  resolveConfirm(false);
  resolveDraftClose("cancel");
  for (const component of mounted.splice(0)) await unmount(component);
  vi.useRealTimers();
  applyLocalTheme(null);
  document.body.innerHTML = "";
  resetLayout();
  clearRecentlyClosedTabsForTest();
  uninstallDemoWorkspace();
  timers.release();
  vi.restoreAllMocks();
});

const PARTIAL = '{"type":"excalidraw","elements":[';
const ON_DISK = { id: "on-disk", version: 1 };
const DRAWING = JSON.stringify({ elements: [ON_DISK], appState: {}, files: {} });
// A drawing another program wrote: the stand-in's serializer never reproduces
// its bytes, as the library's does not reproduce a file it did not write.
const FOREIGN = JSON.stringify(
  { type: "excalidraw", version: 2, source: "https://elsewhere.example", elements: [ON_DISK], appState: {}, files: {} },
  null,
  2,
);

/// Hold every read of the tab's file until the test answers it: `chunk`
/// streams bytes into the read in flight, `finish` completes it.
function holdReads() {
  let options: Parameters<typeof api.readStream>[1];
  let complete: (content: string) => void = () => {};
  vi.spyOn(api, "readStream").mockImplementation((_path, o) => {
    options = o;
    return new Promise((resolve, reject) => {
      complete = (content) => resolve({ content, writable: true } as Awaited<ReturnType<typeof api.readStream>>);
      o?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  });
  return {
    chunk: async (bytes: string) => {
      options?.onChunk?.(bytes, { loadedBytes: bytes.length, totalBytes: null });
      await tick();
    },
    finish: async (content: string) => {
      complete(content);
      await vi.advanceTimersByTimeAsync(0);
      await tick();
    },
  };
}

/// A loaded canvas tab over `content` on disk, with its reads held and its
/// writes recorded.
async function loadedTab(path: string, content: string, over: Partial<FileTab> = {}) {
  const initial = fileTab({ path, fileKind: "text", mode: "canvas", content, saved: content, ...over });
  initial.savedMtime = disk.write(path, content).mtime;
  const pane = resetLayout([initial]);
  const tab = readTab(initial.id)!;
  return { pane, tab, write: vi.spyOn(api, "write"), reads: holdReads() };
}

/// Mount the tab's editor and hand its board to the library stand-in.
async function mountBoard(tab: FileTab) {
  canvasReady = new Promise((resolve) => {
    render.mockImplementation((element: unknown) => resolve(boardPropsFromRender(element)));
  });
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(FileEditorTab, { target, props: { tab, active: true, focused: true } });
  mounted.push(component);
  await canvasReady;
  const lastElement = () => render.mock.calls.at(-1)![0] as unknown;
  const lastRender = () => boardPropsFromRender(lastElement());
  return { target, component, board: excalidrawBoard(lastElement), lastRender };
}

async function mountDuringLoad(exists = true) {
  const initial = fileTab({
    path: "notes/loading.excalidraw", fileKind: "text", mode: "canvas",
    content: DRAWING, saved: DRAWING,
  });
  if (exists) disk.write(initial.path, DRAWING);
  const pane = resetLayout([initial]);
  const tab = readTab(initial.id)!;
  let readOptions: Parameters<typeof api.readStream>[1];
  let rejectRead!: (reason: unknown) => void;
  vi.spyOn(api, "readStream").mockImplementation((_path, options) => {
    readOptions = options;
    return new Promise((_resolve, reject) => {
      rejectRead = reject;
      options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  });
  const loading = reloadTabFromDisk(tab.id);
  const write = vi.spyOn(api, "write");
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(FileEditorTab, { target, props: { tab, active: true, focused: true } });
  mounted.push(component);
  const props = await canvasReady;
  let elements: unknown[] = [];
  props.excalidrawAPI({
    getSceneElements: () => elements, getAppState: () => ({}), getFiles: () => ({}),
    updateScene: (scene: { elements: unknown[] }) => { elements = scene.elements; props.onChange(); },
  });
  await tick();
  vi.useFakeTimers();
  // The library reports a change after mounting even without a stroke.
  props.onChange();
  expect(tab.loading).toBe(true);
  expect(target.querySelector(".excalidraw-host")).not.toBeNull();
  return {
    pane, tab, target, component, loading, write, rejectRead,
    chunk: async () => {
      readOptions?.onChunk?.(PARTIAL, { loadedBytes: PARTIAL.length, totalBytes: DRAWING.length });
      await tick();
    },
  };
}

describe("drawing loads", () => {
  test("a rejected drawing autosave keeps the board and reports the failure", async () => {
    const { pane, tab, write } = await loadedTab("notes/board.excalidraw", DRAWING, { content: FOREIGN, saved: DRAWING });
    const { target, board } = await mountBoard(tab);
    await board.start();
    write.mockRejectedValue(new Error("disk full"));
    vi.useFakeTimers();
    scheduleAutosave(pane.id, tab.id);
    await vi.advanceTimersByTimeAsync(900);
    await tick();
    expect(target.querySelector(".excalidraw-host")).not.toBeNull();
    expect(target.querySelector(".error-placeholder")).toBeNull();
    expect(target.querySelector(".editor-toolbar .error")?.textContent).toContain("Not saved: the save request failed (disk full)");
    expect(tab.refusedUnwritten).toBeFalsy();
  });
  test("a failed load under a mounted canvas leaves the drawing clean and unwritten", async () => {
    const { pane, tab, target, loading, write, rejectRead, chunk } = await mountDuringLoad();
    await chunk();
    vi.advanceTimersByTime(50);
    rejectRead(new Error("stream interrupted"));
    await loading;
    await tick();
    expect(target.querySelector(".excalidraw-host")).toBeNull();
    const dirty = isDirty(tab);
    scheduleAutosave(pane.id, tab.id);
    await vi.advanceTimersByTimeAsync(800);

    expect({ dirty, writes: write.mock.calls, content: disk.get(tab.path)?.content }).toEqual({
      dirty: false, writes: [], content: DRAWING,
    });
    expect(tab.error).toBe("stream interrupted");
  });

  test("a missing file under a mounted canvas stays missing and unwritten", async () => {
    const { pane, tab, target, loading, write, rejectRead } = await mountDuringLoad(false);
    vi.advanceTimersByTime(50);
    rejectRead(new ApiError(404, "file not found"));
    await loading;
    await tick();
    expect(target.querySelector(".excalidraw-host")).toBeNull();
    const dirty = isDirty(tab);
    scheduleAutosave(pane.id, tab.id);
    await vi.advanceTimersByTimeAsync(800);

    expect({ dirty, writes: write.mock.calls, file: disk.get(tab.path) }).toEqual({
      dirty: false, writes: [], file: undefined,
    });
    expect(tab.fileMissing?.path).toBe(tab.path);
  });

  test("a close during a load and a reopen load the drawing again and write nothing", async () => {
    const { pane, tab, write, reads } = await loadedTab("notes/loading.excalidraw", DRAWING);
    const loading = reloadTabFromDisk(tab.id);
    const first = await mountBoard(tab);
    vi.useFakeTimers();
    await first.board.start();
    await reads.chunk(PARTIAL);
    vi.advanceTimersByTime(50);
    await closeTab(pane.id, tab.id);
    await loading;
    await unmount(first.component);
    mounted.splice(mounted.indexOf(first.component), 1);
    expect(reopenClosedTab()).toBe(true);
    const reopened = readTab(tab.id)!;
    const second = await mountBoard(reopened);
    await second.board.start();
    await reads.finish(DRAWING);
    await vi.advanceTimersByTimeAsync(200);
    const dirty = isDirty(reopened);
    scheduleAutosave(pane.id, reopened.id);
    await vi.advanceTimersByTimeAsync(800);

    expect({ board: second.board.elements, dirty, writes: write.mock.calls, content: disk.get(tab.path)?.content }).toEqual({
      board: [ON_DISK], dirty: false, writes: [], content: DRAWING,
    });
    expect({ loading: reopened.loading, content: reopened.content }).toEqual({ loading: false, content: DRAWING });
  });
});

async function draw(over: Partial<FileTab> = {}) {
  const initial = fileTab({
    path: "notes/board.excalidraw", fileKind: "text", mode: "canvas",
    content: INITIAL, saved: INITIAL, ...over,
  });
  initial.savedMtime = disk.write(initial.path, initial.saved).mtime;
  const pane = resetLayout([initial]);
  const tab = readTab(initial.id)!;
  const { target, board } = await mountBoard(tab);
  vi.useFakeTimers();
  await board.start();
  board.stroke({ id: "last-stroke", version: 1 });
  vi.advanceTimersByTime(50);
  expect(tab.content).toBe(tab.saved);
  return { pane, tab, target, board, strokeAt: Date.now() - 50 };
}

/// What the control client prints for a `cs pane` operation: the window
/// command the server relays, answered through the window's reply. It waits
/// only on tasks due now, so a stroke's pending serialize stays pending.
async function paneExec(op: Record<string, unknown>) {
  const reply = vi.spyOn(api, "windowReply").mockResolvedValue(undefined);
  reply.mockClear();
  onWatchEvent({
    type: "window_command", window_id: sessionWindowId(), command: "pane_exec", request_id: "pane-exec", op,
  });
  for (let i = 0; i < 20 && reply.mock.calls.length === 0; i++) await vi.advanceTimersByTimeAsync(0);
  expect(reply).toHaveBeenCalledTimes(1);
  const { ok, summary, blocked } = reply.mock.calls[0]![0].payload as {
    ok: boolean; summary: string; blocked: { tab: string; reason: string }[];
  };
  return { ok, summary, blocked };
}

describe("pending drawing edits", () => {
  test("a refresh leaves a stroke waiting in a drawing's buffer", async () => {
    const { tab, strokeAt } = await draw();
    const read = vi.spyOn(api, "readStream");

    await refreshTabFromDisk(tab.id);

    expect({
      inDebounce: Date.now() - strokeAt < 200,
      reads: read.mock.calls.length,
      loading: tab.loading,
      stroke: tab.content.includes("last-stroke"),
      dirty: isDirty(tab),
    }).toEqual({ inDebounce: true, reads: 0, loading: false, stroke: true, dirty: true });
  });

  test("Reload from disk asks before discarding a waiting stroke", async () => {
    const { tab, strokeAt } = await draw();
    const read = vi.spyOn(api, "readStream");

    const reload = forceReloadFromDisk(tab.id);
    await Promise.resolve();
    const asked = { open: confirmState.open, title: confirmState.title };
    resolveConfirm(false);
    await reload;

    expect({
      inDebounce: Date.now() - strokeAt < 200,
      asked,
      reads: read.mock.calls.length,
      stroke: tab.content.includes("last-stroke"),
      dirty: isDirty(tab),
    }).toEqual({
      inDebounce: true, asked: { open: true, title: "Reload from disk?" },
      reads: 0, stroke: true, dirty: true,
    });
  });

  test("accepting Reload from disk replaces the pending stroke", async () => {
    const { tab, board } = await draw();
    const read = vi.spyOn(api, "readStream");

    const reload = forceReloadFromDisk(tab.id);
    expect(confirmState.title).toBe("Reload from disk?");
    expect(read).not.toHaveBeenCalled();
    resolveConfirm(true);
    await reload;
    await tick();

    expect({ reads: read.mock.calls.length, buffer: tab.content, elements: board.elements })
      .toEqual({ reads: 1, buffer: INITIAL, elements: [] });
  });

  test("a clean drawing refreshes and reloads without a question", async () => {
    const initial = fileTab({
      path: "notes/clean.excalidraw", fileKind: "text", mode: "canvas", content: INITIAL, saved: INITIAL,
    });
    initial.savedMtime = disk.write(initial.path, INITIAL).mtime;
    resetLayout([initial]);
    const tab = readTab(initial.id)!;
    const { board } = await mountBoard(tab);
    vi.useFakeTimers();
    await board.start();
    vi.advanceTimersByTime(50);
    const read = vi.spyOn(api, "readStream");

    await refreshTabFromDisk(tab.id);
    await forceReloadFromDisk(tab.id);

    expect({ reads: read.mock.calls.length, asked: confirmState.open, dirty: isDirty(tab) })
      .toEqual({ reads: 2, asked: false, dirty: false });
  });

  test("a mode switch carries the pending stroke into Source", async () => {
    const { tab, target } = await draw();
    setMode(tab, "source");
    await tick();
    expect(tab.content).toContain("last-stroke");
    const view = EditorView.findFromDOM(target.querySelector<HTMLElement>(".cm-content")!);
    expect(view?.state.doc.toString()).toBe(tab.content);
  });

  test.each(["single tab", "pane tabs", "pane", "moved tab"])(
    "closing %s saves the pending stroke before removal", async (method) => {
      const { pane, tab } = await draw();
      pane.tabs.push(fileTab({ id: "keep", mode: "source" }));
      if (method === "single tab") await closeTab(pane.id, tab.id);
      else if (method === "pane tabs") await closeTabsInPane(pane.id);
      else if (method === "pane") await closePane(pane.id);
      else await closeFileTabAfterMove(pane.id, tab.id);

      expect(disk.get(tab.path)?.content).toContain("last-stroke");
      expect(readTab(tab.id)).toBeUndefined();
    },
  );

  test("a move to another pane carries the pending stroke", async () => {
    const { pane, tab, strokeAt } = await draw();
    const other = splitPane(pane.id, "row")!;
    moveTab(pane.id, tab.id, other);
    const node = layout.nodes[other];
    const moved = node?.kind === "leaf" ? node.tabs.find((t) => t.id === tab.id) : undefined;

    expect({
      carried: moved?.kind === "file" ? moved.content.includes("last-stroke") : "not moved",
      inDebounce: Date.now() - strokeAt < 200,
    }).toEqual({ carried: true, inDebounce: true });
  });

  test("a drop on another pane's edge carries the pending stroke", async () => {
    const { pane, tab, strokeAt } = await draw();
    const other = splitPane(pane.id, "row")!;
    detachTabToPaneEdge(pane.id, tab.id, other, "right");
    const node = layout.nodes[layout.activePaneId];
    const dropped = node?.kind === "leaf" && node.id !== pane.id && node.id !== other
      ? node.tabs.find((t) => t.id === tab.id)
      : undefined;

    expect({
      carried: dropped?.kind === "file" ? dropped.content.includes("last-stroke") : "not dropped",
      inDebounce: Date.now() - strokeAt < 200,
    }).toEqual({ carried: true, inDebounce: true });
  });

  const PANE_CLOSES: [kind: string, blockedSummary: string][] = [
    ["close_tab", "blocked 1 tab"],
    ["close_pane", "blocked 1 tab(s)"],
    ["close_all", "blocked 1 tab(s)"],
  ];

  test.each(PANE_CLOSES)(
    "an unforced %s reports a pending stroke unsaved and closes nothing, and the same op closes it once it is saved", async (kind, blockedSummary) => {
      const { pane, tab, strokeAt } = await draw();
      const op = { kind, pane_id: pane.id, tab_id: tab.id };
      const asked = await paneExec(op);
      const askedInDebounce = Date.now() - strokeAt < 200;
      const open = readTab(tab.id) !== undefined;

      expect({ asked, askedInDebounce, open }).toEqual({
        asked: { ok: false, summary: blockedSummary, blocked: [{ tab: "board.excalidraw", reason: "unsaved changes" }] },
        askedInDebounce: true,
        open: true,
      });
      scheduleAutosave(pane.id, tab.id);
      await vi.advanceTimersByTimeAsync(800);
      const again = await paneExec(op);
      expect({ ok: again.ok, closed: readTab(tab.id) === undefined }).toEqual({ ok: true, closed: true });
      expect(disk.get(tab.path)?.content).toContain("last-stroke");
    },
  );

  test.each(PANE_CLOSES.map(([kind]) => kind))("a forced %s closes a drawing with a pending stroke and writes nothing", async (kind) => {
    const { pane, tab } = await draw();
    const write = vi.spyOn(api, "write");
    const closed = await paneExec({ kind, pane_id: pane.id, tab_id: tab.id, force: true });
    await vi.advanceTimersByTimeAsync(1000);

    expect({ ok: closed.ok, blocked: closed.blocked, gone: readTab(tab.id) === undefined, writes: write.mock.calls.length })
      .toEqual({ ok: true, blocked: [], gone: true, writes: 0 });
    expect(disk.get(tab.path)?.content).not.toContain("last-stroke");
  });

  test("a pending stroke keeps an initially empty drawing from being deleted", async () => {
    const { pane, tab } = await draw({ content: "", saved: "", openedEmpty: true });
    const remove = vi.spyOn(api, "remove");
    await closeTab(pane.id, tab.id);

    expect(remove).not.toHaveBeenCalled();
    expect(disk.get(tab.path)?.content).toContain("last-stroke");
    expect(readTab(tab.id)).toBeUndefined();
  });

  test("a pending stroke saves a drawing draft before the close decision", async () => {
    const { pane, tab, strokeAt } = await draw({ path: ".Drafts/drawing/diagram.excalidraw" });
    vi.spyOn(api, "inspectDraft").mockResolvedValue({
      path: tab.path, name: "drawing", file_count: 1, dir_count: 0, total_size: 100, has_attachments: false,
    });
    const discard = vi.spyOn(api, "discardDraft").mockResolvedValue(undefined);
    const closing = closeTab(pane.id, tab.id);
    try {
      await vi.waitFor(() => expect(draftCloseState.open || discard.mock.calls.length > 0).toBe(true));
      expect(Date.now() - strokeAt).toBeLessThan(200);
      expect(disk.get(tab.path)?.content).toContain("last-stroke");
      expect(discard).not.toHaveBeenCalled();
      expect(draftCloseState.open).toBe(true);
    } finally {
      resolveDraftClose("cancel");
      await closing;
    }
  });

  test.each(["kept pane", "rebuilt pane"])("a peer close preserves the pending stroke in a %s", async (topology) => {
    const { tab } = await draw();
    const remote: SerNode = topology === "kept pane"
      ? { k: "l", t: [] }
      : { k: "s", d: "r", a: { k: "l", t: [] }, b: { k: "l", t: [] } };

    expect(reconcileLayout(remote)).toBe("diverged");
    const kept = readTab(tab.id)!;
    expect(kept.content).toContain("last-stroke");
    await saveTab(kept);
    expect(disk.get(tab.path)?.content).toContain("last-stroke");
    expect(reconcileLayout(remote)).toBe("applied");
    expect(readTab(tab.id)).toBeUndefined();
  });
});

describe("the drawing library stand-in", () => {
  // Reads the installed package's manifest, not source: the stand-in keeps the
  // order of events of the version it was read from.
  test("models the installed version of the drawing library", () => {
    const manifest = readFileSync("../../node_modules/@excalidraw/excalidraw/package.json", "utf8");
    expect(JSON.parse(manifest).version).toBe(EXCALIDRAW_VERSION);
  });
});

describe("a drawing library failure", () => {
  const MESSAGE = "The drawing library failed. Changes drawn since the board last paused may be lost. Switch to Source and back, or close and reopen the tab to reload the drawing.";

  test("a failure with a stroke waiting keeps the saved buffer and writes nothing", async () => {
    const { pane, tab, write } = await loadedTab("notes/board.excalidraw", DRAWING);
    const { board } = await mountBoard(tab);
    vi.useFakeTimers();
    await board.start();
    await vi.advanceTimersByTimeAsync(200);
    board.stroke({ id: "waiting", version: 1 });
    board.fail();
    await tick();
    await vi.advanceTimersByTimeAsync(200);
    const afterWait = { buffer: tab.content, dirty: isDirty(tab) };
    scheduleAutosave(pane.id, tab.id);
    await vi.advanceTimersByTimeAsync(800);

    expect(afterWait, "failed library must not publish an empty scene").toEqual({ buffer: DRAWING, dirty: false });
    expect({ writes: write.mock.calls.length, disk: disk.get(tab.path)?.content }).toEqual({ writes: 0, disk: DRAWING });
  });

  test("a failure prevents theme and read-only changes from rendering the library again", async () => {
    const { tab, write } = await loadedTab("notes/board.excalidraw", DRAWING);
    const { board } = await mountBoard(tab);
    await board.start();
    board.fail();
    await tick();
    const count = render.mock.calls.length;
    applyLocalTheme(effectiveHybridSurfaceTheme("editor") === "dark" ? "light" : "dark");
    await tick();
    setTabReadMode(tab, true);
    await tick();
    setTabReadMode(tab, false);
    await tick();

    expect(render.mock.calls.length, "failed library must not render again").toBe(count);
    expect({ buffer: tab.content, writes: write.mock.calls.length }).toEqual({ buffer: DRAWING, writes: 0 });
  });

  test("a failure after seeding shows the loss and recovery alert", async () => {
    const { tab } = await loadedTab("notes/board.excalidraw", DRAWING);
    const { target, board } = await mountBoard(tab);
    await board.start();
    board.fail();
    await tick();

    expect(target.querySelector('[role="alert"]')?.textContent?.trim()).toBe(MESSAGE);
  });

  test("a failure before API handover shows the alert without publishing", async () => {
    const { tab, write } = await loadedTab("notes/board.excalidraw", DRAWING);
    const { target, board } = await mountBoard(tab);
    board.fail();
    await tick();

    expect(target.querySelector('[role="alert"]')?.textContent?.trim()).toBe(MESSAGE);
    expect({ buffer: tab.content, writes: write.mock.calls.length }).toEqual({ buffer: DRAWING, writes: 0 });
  });

  test("a new mount after failure restores the buffer without writing", async () => {
    const { pane, tab, write } = await loadedTab("notes/board.excalidraw", DRAWING);
    const first = await mountBoard(tab);
    vi.useFakeTimers();
    await first.board.start();
    await vi.advanceTimersByTimeAsync(200);
    first.board.fail();
    await tick();
    await unmount(first.component);
    mounted.splice(mounted.indexOf(first.component), 1);
    const second = await mountBoard(tab);
    await second.board.start();
    await vi.advanceTimersByTimeAsync(200);
    scheduleAutosave(pane.id, tab.id);
    await vi.advanceTimersByTimeAsync(800);

    expect({ board: second.board.elements, buffer: tab.content, writes: write.mock.calls.length })
      .toEqual({ board: [ON_DISK], buffer: DRAWING, writes: 0 });
  });
});

describe("a drawing nobody drew on", () => {
  test("a load that lands before the library's init shows the drawing and writes nothing", async () => {
    const { pane, tab, write, reads } = await loadedTab("notes/late.excalidraw", DRAWING);
    const loading = reloadTabFromDisk(tab.id);
    const { board } = await mountBoard(tab);
    vi.useFakeTimers();
    await reads.finish(DRAWING);
    await loading;
    expect(tab.loading).toBe(false);
    await board.start();
    await vi.advanceTimersByTimeAsync(200);
    const dirty = isDirty(tab);
    scheduleAutosave(pane.id, tab.id);
    await vi.advanceTimersByTimeAsync(800);

    expect({ board: board.elements, dirty, writes: write.mock.calls, content: disk.get(tab.path)?.content }).toEqual({
      board: [ON_DISK], dirty: false, writes: [], content: DRAWING,
    });
  });

  test("a drawing opened and not touched is never dirty and writes nothing", async () => {
    const { pane, tab, write } = await loadedTab("notes/board.excalidraw", FOREIGN);
    const { board } = await mountBoard(tab);
    vi.useFakeTimers();
    await board.start();
    await vi.advanceTimersByTimeAsync(200);
    const dirty = isDirty(tab);
    scheduleAutosave(pane.id, tab.id);
    await vi.advanceTimersByTimeAsync(800);

    expect({ dirty, writes: write.mock.calls, content: disk.get(tab.path)?.content }).toEqual({
      dirty: false, writes: [], content: FOREIGN,
    });
  });

  test("a close inside the first debounce writes nothing and asks nothing", async () => {
    const { pane, tab, write } = await loadedTab("notes/board.excalidraw", FOREIGN);
    const { board } = await mountBoard(tab);
    vi.useFakeTimers();
    await board.start();
    vi.advanceTimersByTime(50);
    await closeTab(pane.id, tab.id);

    expect({ writes: write.mock.calls, content: disk.get(tab.path)?.content, open: readTab(tab.id) }).toEqual({
      writes: [], content: FOREIGN, open: undefined,
    });
  });

  test("an empty file opened in the canvas is discarded on close", async () => {
    const { pane, tab, write } = await loadedTab("notes/empty.excalidraw", "", { openedEmpty: true });
    const { board } = await mountBoard(tab);
    vi.useFakeTimers();
    await board.start();
    await vi.advanceTimersByTimeAsync(200);
    await closeTab(pane.id, tab.id);

    expect({ writes: write.mock.calls, file: disk.get(tab.path), open: readTab(tab.id) }).toEqual({
      writes: [], file: undefined, open: undefined,
    });
  });

  test("a new diagram draft is discarded on close without a dialog", async () => {
    const { pane, tab, write } = await loadedTab(".Drafts/drawing/diagram.excalidraw", INITIAL);
    vi.spyOn(api, "inspectDraft").mockResolvedValue({
      path: tab.path, name: "drawing", file_count: 1, dir_count: 0, total_size: 100, has_attachments: false,
    });
    const discard = vi.spyOn(api, "discardDraft").mockResolvedValue(undefined);
    const { board } = await mountBoard(tab);
    vi.useFakeTimers();
    await board.start();
    await vi.advanceTimersByTimeAsync(200);
    const closing = closeTab(pane.id, tab.id);
    try {
      await vi.waitFor(() => expect(draftCloseState.open || discard.mock.calls.length > 0).toBe(true));
      expect({ writes: write.mock.calls, discarded: discard.mock.calls.length, dialog: draftCloseState.open }).toEqual({
        writes: [], discarded: 1, dialog: false,
      });
    } finally {
      resolveDraftClose("cancel");
      await closing;
    }
  });

  test("a stroke inside the first debounce is saved by the timer", async () => {
    const { pane, tab } = await loadedTab("notes/board.excalidraw", FOREIGN);
    const { board } = await mountBoard(tab);
    vi.useFakeTimers();
    await board.start();
    vi.advanceTimersByTime(50);
    board.stroke({ id: "first-stroke", version: 1 });
    await vi.advanceTimersByTimeAsync(200);
    expect(isDirty(tab)).toBe(true);
    scheduleAutosave(pane.id, tab.id);
    await vi.advanceTimersByTimeAsync(800);

    expect(disk.get(tab.path)?.content).toContain("first-stroke");
  });

  const PICTURE_FILES = { picture: { id: "picture", mimeType: "image/png", dataURL: "data:image/png;base64,AAAA", created: 1 } };
  const PICTURE = { id: "image", type: "image", version: 1, versionNonce: 5, fileId: "picture", status: "saved", isDeleted: false };
  const PICTURE_DRAWING = JSON.stringify({ elements: [PICTURE], appState: {}, files: PICTURE_FILES }, null, 2);
  const elementsOf = (json: string | undefined) =>
    (JSON.parse(json ?? "{}") as { elements?: Array<{ id: string; status?: string }> }).elements?.map((el) => [el.id, el.status]);

  test("an image the library marks as failing to decode leaves the drawing clean and unwritten", async () => {
    const { pane, tab, write } = await loadedTab("notes/picture.excalidraw", PICTURE_DRAWING);
    const { board } = await mountBoard(tab);
    vi.useFakeTimers();
    await board.start();
    await vi.advanceTimersByTimeAsync(200);
    board.failImageDecode("picture");
    await vi.advanceTimersByTimeAsync(200);
    const dirty = isDirty(tab);
    scheduleAutosave(pane.id, tab.id);
    await vi.advanceTimersByTimeAsync(800);

    expect({
      marked: (board.elements as Array<{ status?: string }>).map((el) => el.status),
      dirty,
      writes: write.mock.calls.length,
      content: disk.get(tab.path)?.content,
    }).toEqual({ marked: ["error"], dirty: false, writes: 0, content: PICTURE_DRAWING });
  });

  test("a stroke drawn after the library's mark is written, with the mark", async () => {
    const { pane, tab } = await loadedTab("notes/picture.excalidraw", PICTURE_DRAWING);
    const { board } = await mountBoard(tab);
    vi.useFakeTimers();
    await board.start();
    await vi.advanceTimersByTimeAsync(200);
    board.failImageDecode("picture");
    await vi.advanceTimersByTimeAsync(200);
    board.stroke({ id: "stroke", type: "line", version: 1 });
    await vi.advanceTimersByTimeAsync(200);
    const dirty = isDirty(tab);
    scheduleAutosave(pane.id, tab.id);
    await vi.advanceTimersByTimeAsync(800);

    expect({ dirty, written: elementsOf(disk.get(tab.path)?.content) }).toEqual({
      dirty: true, written: [["image", "error"], ["stroke", undefined]],
    });
  });

  test("an image the user moved in the same debounce as the library's mark is written", async () => {
    const { tab } = await loadedTab("notes/picture.excalidraw", PICTURE_DRAWING);
    const { board } = await mountBoard(tab);
    vi.useFakeTimers();
    await board.start();
    await vi.advanceTimersByTimeAsync(200);
    // The user's move, as the library makes it: the same element, one
    // version on. The library's mark then moves the version once more.
    const onBoard = board.elements as Array<Record<string, unknown>>;
    onBoard[0] = { ...onBoard[0], x: 40, version: 2 };
    board.failImageDecode("picture");
    await vi.advanceTimersByTimeAsync(200);

    expect({
      dirty: isDirty(tab),
      image: (JSON.parse(tab.content) as { elements: Array<Record<string, unknown>> }).elements.map((el) => [el.x, el.status, el.version]),
    }).toEqual({ dirty: true, image: [[40, "error", 3]] });
  });

  test("a stroke in the same debounce as the library's mark is written", async () => {
    const { tab } = await loadedTab("notes/picture.excalidraw", PICTURE_DRAWING);
    const { board } = await mountBoard(tab);
    vi.useFakeTimers();
    await board.start();
    await vi.advanceTimersByTimeAsync(200);
    board.failImageDecode("picture");
    board.stroke({ id: "stroke", type: "line", version: 1 });
    await vi.advanceTimersByTimeAsync(200);

    expect({ dirty: isDirty(tab), buffer: elementsOf(tab.content) }).toEqual({
      dirty: true, buffer: [["image", "error"], ["stroke", undefined]],
    });
  });
});

describe("a board during its tab's load", () => {
  test("a board mounted during its tab's load becomes editable when the load ends", async () => {
    const { tab, reads } = await loadedTab("notes/loading.excalidraw", DRAWING);
    const loading = reloadTabFromDisk(tab.id);
    const { board, lastRender } = await mountBoard(tab);
    vi.useFakeTimers();
    await board.start();
    expect(lastRender().viewModeEnabled).toBe(true);
    await reads.finish(DRAWING);
    await loading;

    expect({ viewMode: lastRender().viewModeEnabled, board: board.elements }).toEqual({ viewMode: false, board: [ON_DISK] });
  });

  test("a reload keeps the drawing on screen, locked and unpublished, and seeds again when it ends", async () => {
    const reloaded = { id: "reloaded", version: 3 };
    const RELOADED = JSON.stringify({ elements: [reloaded], appState: {}, files: {} });
    const { pane, tab, write, reads } = await loadedTab("notes/board.excalidraw", DRAWING);
    const { board, lastRender } = await mountBoard(tab);
    vi.useFakeTimers();
    await board.start();
    const loading = reloadTabFromDisk(tab.id);
    await reads.chunk(RELOADED.slice(0, 10));
    await vi.advanceTimersByTimeAsync(200);
    const during = { viewMode: lastRender().viewModeEnabled, board: board.elements, content: tab.content };
    await reads.finish(RELOADED);
    await loading;
    await vi.advanceTimersByTimeAsync(200);
    const after = { viewMode: lastRender().viewModeEnabled, board: board.elements, dirty: isDirty(tab) };
    scheduleAutosave(pane.id, tab.id);
    await vi.advanceTimersByTimeAsync(800);

    expect({ during, after, writes: write.mock.calls }).toEqual({
      during: { viewMode: true, board: [ON_DISK], content: RELOADED.slice(0, 10) },
      after: { viewMode: false, board: [reloaded], dirty: false },
      writes: [],
    });
  });
});

const STROKE = { id: "stroke", version: 1 };

/// What the board shows and what the tab writes: untouched through a debounce
/// and an autosave, then after one stroke and another autosave.
async function untouchedThenStroke(
  pane: { id: string },
  tab: FileTab,
  board: { readonly elements: unknown[]; stroke(element: unknown): void },
  write: { mock: { calls: unknown[] } },
) {
  await vi.advanceTimersByTimeAsync(200);
  const dirty = isDirty(tab);
  scheduleAutosave(pane.id, tab.id);
  await vi.advanceTimersByTimeAsync(800);
  const untouched = { board: board.elements, dirty, writes: write.mock.calls.length };
  board.stroke(STROKE);
  await vi.advanceTimersByTimeAsync(200);
  scheduleAutosave(pane.id, tab.id);
  await vi.advanceTimersByTimeAsync(800);
  const written = JSON.parse(disk.get(tab.path)?.content ?? "{}") as { elements: unknown[]; appState: unknown };
  return { untouched, written };
}

describe("a board seeded from the buffer it holds", () => {
  test("a buffer's round trip before the library's first change leaves the drawing on the board and under a stroke", async () => {
    const { pane, tab, write, reads } = await loadedTab("notes/board.excalidraw", DRAWING, { readMode: true });
    let loading: Promise<void> | undefined;
    beforeLibrary.run = () => { loading = reloadTabFromDisk(tab.id); };
    const { board } = await mountBoard(tab);
    vi.useFakeTimers();
    await reads.finish(DRAWING);
    await loading;
    await board.start();
    setTabReadMode(tab, false);
    await tick();
    const { untouched, written } = await untouchedThenStroke(pane, tab, board, write);

    expect({ untouched, written: written.elements }).toEqual({
      untouched: { board: [ON_DISK], dirty: false, writes: 0 },
      written: [ON_DISK, STROKE],
    });
  });

  test("a board rendered again for a theme change before the library's App mounted is built from the drawing and keeps it", async () => {
    const { pane, tab, write } = await loadedTab("notes/board.excalidraw", DRAWING);
    const { board } = await mountBoard(tab);
    vi.useFakeTimers();
    applyLocalTheme(effectiveHybridSurfaceTheme("editor") === "dark" ? "light" : "dark");
    await tick();
    await board.start();
    const built = board.mountedWith?.initialData?.elements;
    const { untouched, written } = await untouchedThenStroke(pane, tab, board, write);

    expect({ built, untouched, written: written.elements }).toEqual({
      built: [ON_DISK],
      untouched: { board: [ON_DISK], dirty: false, writes: 0 },
      written: [ON_DISK, STROKE],
    });
  });

  test("a board rendered again for two read-only flips before the library's App mounted is built from the drawing and keeps it", async () => {
    const { pane, tab, write } = await loadedTab("notes/board.excalidraw", DRAWING);
    const { board } = await mountBoard(tab);
    vi.useFakeTimers();
    setTabReadMode(tab, true);
    await tick();
    setTabReadMode(tab, false);
    await tick();
    await board.start();
    const built = board.mountedWith?.initialData?.elements;
    const { untouched, written } = await untouchedThenStroke(pane, tab, board, write);

    expect({ built, untouched, written: written.elements }).toEqual({
      built: [ON_DISK],
      untouched: { board: [ON_DISK], dirty: false, writes: 0 },
      written: [ON_DISK, STROKE],
    });
  });

  test("a drawing's background and grid, loaded after its board rendered, are shown and kept under a stroke", async () => {
    const backdrop = { gridSize: 20, gridStep: 5, gridModeEnabled: true, viewBackgroundColor: "#ffc9c9" };
    // Written as another program writes it, so that the library's serialization
    // of the same scene is other bytes and publishing it would dirty the tab.
    const BACKDROP = JSON.stringify(
      { type: "excalidraw", version: 2, source: "https://elsewhere.example", elements: [ON_DISK], appState: backdrop, files: {} },
      null,
      2,
    );
    const { pane, tab, write, reads } = await loadedTab("notes/backdrop.excalidraw", BACKDROP);
    const loading = reloadTabFromDisk(tab.id);
    const { board } = await mountBoard(tab);
    vi.useFakeTimers();
    await board.start();
    await reads.finish(BACKDROP);
    await loading;
    const shown = board.appState;
    const { untouched, written } = await untouchedThenStroke(pane, tab, board, write);

    expect({ shown, untouched, written: written.appState }).toEqual({
      shown: backdrop,
      untouched: { board: [ON_DISK], dirty: false, writes: 0 },
      written: backdrop,
    });
  });

  test("a drawing loaded after its board rendered is restored as the library's init restores it", async () => {
    const RAW = JSON.stringify({ elements: [{ id: "bare" }, { id: "marquee", type: "selection", version: 1 }], appState: {}, files: {} });
    const { pane, tab, write, reads } = await loadedTab("notes/raw.excalidraw", RAW);
    const loading = reloadTabFromDisk(tab.id);
    const { board } = await mountBoard(tab);
    vi.useFakeTimers();
    await board.start();
    await reads.finish(RAW);
    await loading;
    await vi.advanceTimersByTimeAsync(200);
    const dirty = isDirty(tab);
    scheduleAutosave(pane.id, tab.id);
    await vi.advanceTimersByTimeAsync(800);

    expect({ board: board.elements, dirty, writes: write.mock.calls.length }).toEqual({
      board: [{ id: "bare", version: 1 }], dirty: false, writes: 0,
    });
  });

  test("a load that ends between the API handover and the library's init shows the drawing and writes nothing", async () => {
    const { pane, tab, write, reads } = await loadedTab("notes/late.excalidraw", DRAWING);
    const loading = reloadTabFromDisk(tab.id);
    const { board } = await mountBoard(tab);
    vi.useFakeTimers();
    await board.handOver();
    await reads.finish(DRAWING);
    await loading;
    await board.init();
    await vi.advanceTimersByTimeAsync(200);
    const dirty = isDirty(tab);
    scheduleAutosave(pane.id, tab.id);
    await vi.advanceTimersByTimeAsync(800);

    expect({ board: board.elements, dirty, writes: write.mock.calls.length }).toEqual({
      board: [ON_DISK], dirty: false, writes: 0,
    });
  });
});

const TINTED = { gridSize: 20, gridStep: 5, gridModeEnabled: true, viewBackgroundColor: "#ffc9c9" };

/// A drawing another program wrote, holding `elements`, `appState` and `files`.
function foreign(elements: unknown[], appState: unknown, files: unknown = {}): string {
  return JSON.stringify(
    { type: "excalidraw", version: 2, source: "https://elsewhere.example", elements, appState, files },
    null,
    2,
  );
}

const TINTED_FILE = foreign([ON_DISK], TINTED);

describe("a seed the library has not shown yet", () => {
  test("a load that ends after the board's init, flushed by a pending timer before the library renders, publishes nothing", async () => {
    const { pane, tab, write, reads } = await loadedTab("notes/tinted.excalidraw", TINTED_FILE);
    const loading = reloadTabFromDisk(tab.id);
    const { board } = await mountBoard(tab);
    vi.useFakeTimers();
    await board.start();
    board.holdRenders();
    vi.advanceTimersByTime(100);
    await reads.finish(TINTED_FILE);
    await loading;
    await vi.advanceTimersByTimeAsync(100);
    const inGap = isDirty(tab);
    await board.render();
    await vi.advanceTimersByTimeAsync(200);
    const dirty = isDirty(tab);
    scheduleAutosave(pane.id, tab.id);
    await vi.advanceTimersByTimeAsync(800);

    expect({ inGap, dirty, writes: write.mock.calls, content: disk.get(tab.path)?.content }).toEqual({
      inGap: false, dirty: false, writes: [], content: TINTED_FILE,
    });
  });

  test("a close between a seed and the library's render writes nothing", async () => {
    const { pane, tab, write, reads } = await loadedTab("notes/tinted.excalidraw", TINTED_FILE);
    const loading = reloadTabFromDisk(tab.id);
    const { board } = await mountBoard(tab);
    vi.useFakeTimers();
    await board.start();
    board.holdRenders();
    vi.advanceTimersByTime(100);
    await reads.finish(TINTED_FILE);
    await loading;
    await closeTab(pane.id, tab.id);

    expect({ writes: write.mock.calls, content: disk.get(tab.path)?.content, open: readTab(tab.id) }).toEqual({
      writes: [], content: TINTED_FILE, open: undefined,
    });
  });

  test("a sibling's save mirrored into a clean pane publishes nothing there, and a close of both writes the sibling's alone", async () => {
    const path = "notes/tinted.excalidraw";
    const BLUE_FILE = foreign([ON_DISK], { ...TINTED, viewBackgroundColor: "#a5d8ff" });
    const GREEN_FILE = foreign([ON_DISK], { ...TINTED, viewBackgroundColor: "#b2f2bb" });
    const savedMtime = disk.write(path, TINTED_FILE).mtime;
    const shown = fileTab({ id: "shown", path, fileKind: "text", mode: "canvas", content: TINTED_FILE, saved: TINTED_FILE, savedMtime });
    const sibling = fileTab({ id: "sibling", path, fileKind: "text", mode: "source", content: TINTED_FILE, saved: TINTED_FILE, savedMtime });
    layout.nodes = {
      root: { kind: "split", id: "root", direction: "row", ratio: 0.5, a: "pane-sibling", b: "pane-shown" },
      "pane-sibling": { kind: "leaf", id: "pane-sibling", tabs: [sibling], activeTabId: sibling.id },
      "pane-shown": { kind: "leaf", id: "pane-shown", tabs: [shown], activeTabId: shown.id },
    } as typeof layout.nodes;
    layout.rootId = "root";
    layout.activePaneId = "pane-shown";
    const tab = readTab(shown.id)!;
    const other = readTab(sibling.id)!;
    const write = vi.spyOn(api, "write");
    const { board } = await mountBoard(tab);
    vi.useFakeTimers();
    await board.start();
    await vi.advanceTimersByTimeAsync(200);
    board.zoomTo(1.5);
    board.holdRenders();
    vi.advanceTimersByTime(100);
    setTabContent(other, BLUE_FILE);
    await saveTab(other);
    await vi.advanceTimersByTimeAsync(100);
    const mirrored = isDirty(tab);
    await board.render();
    await vi.advanceTimersByTimeAsync(200);
    board.zoomTo(1.25);
    setTabContent(other, GREEN_FILE);
    // The sibling's pane closes first, so its save lands while the shown board
    // is still mounted, and the shown pane's own close follows it.
    await closeTabsInPane("pane-sibling");
    await closeTabsInPane("pane-shown");
    const written = write.mock.calls.map((call) => (call[1] === BLUE_FILE ? "blue" : call[1] === GREEN_FILE ? "green" : call[1]));

    expect({ mirrored, written, open: [readTab(shown.id), readTab(sibling.id)] }).toEqual({
      mirrored: false, written: ["blue", "green"], open: [undefined, undefined],
    });
  });

  test("the seed at the library's first change keeps what it handed until the library shows it", async () => {
    const { tab, write, reads } = await loadedTab("notes/tinted.excalidraw", TINTED_FILE, { readMode: true });
    let loading: Promise<void> | undefined;
    beforeLibrary.run = () => { loading = reloadTabFromDisk(tab.id); };
    const { board } = await mountBoard(tab);
    vi.useFakeTimers();
    await reads.finish(TINTED_FILE);
    await loading;
    board.holdRenders();
    await board.start();
    await vi.advanceTimersByTimeAsync(200);
    const inGap = isDirty(tab);
    await board.render();
    await vi.advanceTimersByTimeAsync(200);

    expect({ inGap, dirty: isDirty(tab), writes: write.mock.calls.length }).toEqual({ inGap: false, dirty: false, writes: 0 });
  });

  test("a seed applies only what the serializer keeps, so a read-only board stays read-only and keeps its zoom", async () => {
    const { tab, reads } = await loadedTab("notes/tinted.excalidraw", TINTED_FILE, { readMode: true });
    const { board } = await mountBoard(tab);
    vi.useFakeTimers();
    await board.start();
    board.zoomTo(2);
    const loading = reloadTabFromDisk(tab.id);
    await reads.finish(TINTED_FILE);
    await loading;
    await vi.advanceTimersByTimeAsync(200);

    expect({ view: board.view, shown: board.appState }).toEqual({
      view: { viewModeEnabled: true, zoom: { value: 2 } }, shown: TINTED,
    });
  });

  test("a scene with files, loaded after its board rendered, puts its files on the board and writes nothing", async () => {
    const files = { picture: { id: "picture", mimeType: "image/png", dataURL: "data:image/png;base64,AAAA", created: 1 } };
    const PICTURE_FILE = foreign([{ id: "image", type: "image", version: 1, fileId: "picture" }], {}, files);
    const { pane, tab, write, reads } = await loadedTab("notes/picture.excalidraw", PICTURE_FILE);
    const loading = reloadTabFromDisk(tab.id);
    const { board } = await mountBoard(tab);
    vi.useFakeTimers();
    await board.start();
    await reads.finish(PICTURE_FILE);
    await loading;
    await vi.advanceTimersByTimeAsync(200);
    const dirty = isDirty(tab);
    scheduleAutosave(pane.id, tab.id);
    await vi.advanceTimersByTimeAsync(800);

    expect({ files: board.files, dirty, writes: write.mock.calls.length }).toEqual({ files, dirty: false, writes: 0 });
  });

  test("a board rendered again for one read-only flip before the library's App mounted is built from the drawing", async () => {
    const { tab } = await loadedTab("notes/board.excalidraw", DRAWING);
    const { board } = await mountBoard(tab);
    vi.useFakeTimers();
    setTabReadMode(tab, true);
    await tick();
    await board.start();

    expect({ renders: render.mock.calls.length, built: board.mountedWith?.initialData?.elements }).toEqual({
      renders: 2, built: [ON_DISK],
    });
  });

  test("a background the user picks after a seed is written", async () => {
    const { pane, tab, reads } = await loadedTab("notes/tinted.excalidraw", TINTED_FILE);
    const loading = reloadTabFromDisk(tab.id);
    const { board } = await mountBoard(tab);
    vi.useFakeTimers();
    await board.start();
    await reads.finish(TINTED_FILE);
    await loading;
    await vi.advanceTimersByTimeAsync(200);
    board.pickBackground("#b2f2bb");
    await vi.advanceTimersByTimeAsync(200);
    scheduleAutosave(pane.id, tab.id);
    await vi.advanceTimersByTimeAsync(800);

    expect((JSON.parse(disk.get(tab.path)?.content ?? "{}") as { appState?: unknown }).appState).toEqual({
      ...TINTED, viewBackgroundColor: "#b2f2bb",
    });
  });

  test("a change the library reports before it shows a seed, flushed by its timer, publishes nothing", async () => {
    const { pane, tab, write, reads } = await loadedTab("notes/tinted.excalidraw", TINTED_FILE);
    const loading = reloadTabFromDisk(tab.id);
    const { board } = await mountBoard(tab);
    vi.useFakeTimers();
    await board.start();
    board.holdRenders();
    vi.advanceTimersByTime(100);
    await reads.finish(TINTED_FILE);
    await loading;
    // A click or a key renders apart from the seed's update: the library
    // reports that change while its state still shows the board's earlier
    // background and grid.
    board.zoomTo(1.5);
    await vi.advanceTimersByTimeAsync(200);
    const inGap = isDirty(tab);
    await board.render();
    await vi.advanceTimersByTimeAsync(200);
    const dirty = isDirty(tab);
    scheduleAutosave(pane.id, tab.id);
    await vi.advanceTimersByTimeAsync(800);

    expect({ inGap, dirty, shown: board.appState, writes: write.mock.calls, content: disk.get(tab.path)?.content }).toEqual({
      inGap: false, dirty: false, shown: TINTED, writes: [], content: TINTED_FILE,
    });
  });
});

describe("a live drawing", () => {
  /// A scene session's socket that answers only what a test feeds it.
  class SceneSocket {
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    sent: Record<string, unknown>[] = [];
    constructor(readonly url: string) {
      sceneSockets.push(this);
    }
    send(data: string): void {
      this.sent.push(JSON.parse(data) as Record<string, unknown>);
    }
    close(): void {
      this.readyState = 3;
    }
    open(): void {
      this.readyState = 1;
      this.onopen?.();
    }
    frame(f: unknown): void {
      this.onmessage?.({ data: JSON.stringify(f) });
    }
    pushes(): Record<string, unknown>[] {
      return this.sent.filter((f) => f.type === "push");
    }
    drop(): void {
      this.readyState = 3;
      this.onclose?.();
    }
  }
  const sceneSockets: SceneSocket[] = [];
  const PEER = { id: "peer", type: "rectangle", version: 1, versionNonce: 7, isDeleted: false };
  const STROKE = { id: "stroke", type: "rectangle", version: 1, versionNonce: 3, isDeleted: false };

  beforeEach(() => {
    scene.live = true;
    sceneSockets.length = 0;
    resetSceneSyncForTests();
    setSocketFactory((url) =>
      url.includes("/api/scene/ws") ? (new SceneSocket(url) as unknown as WebSocket) : demoSocketFactory(url),
    );
  });

  afterEach(() => {
    scene.live = false;
    resetSceneSyncForTests();
    setSocketFactory(demoSocketFactory);
    applySessionRoster({ participants: [], leader: null });
  });

  /// A drawing on its board, attached to a session whose snapshot holds the
  /// file as it is. The library shows a seed's and a snapshot's appState at a
  /// render it schedules for a later task. With `shown`, those renders are
  /// held and run here, in their order, so the board shows the snapshot's
  /// appState when this answers and no test waits for a task to see it.
  async function attachedDrawing({ shown = false } = {}) {
    const { pane, tab, reads } = await loadedTab("notes/live.excalidraw", DRAWING);
    const { board } = await mountBoard(tab);
    if (shown) board.holdRenders();
    await board.start();
    await vi.waitFor(() => expect(sceneSockets).toHaveLength(1));
    const socket = sceneSockets[0]!;
    socket.open();
    socket.frame({
      type: "snapshot", path: tab.path, version: 1, elements: [ON_DISK], appState: {}, files: {},
      dirty: false, mtime_ns: "1000000000", cursors: [],
    });
    expect(tab.doc?.state).toBe("attached");
    if (shown) await board.render();
    return { pane, tab, board, socket, reads };
  }

  test("a failed live board pushes no scene part after a late change callback", async () => {
    const { tab, board, socket } = await attachedDrawing();
    const rendered = () => boardPropsFromRender(render.mock.calls.at(-1)![0]);
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(200);
    board.pickBackground("#b2f2bb");
    board.fail();
    await tick();
    socket.frame({ type: "update", version: 2, elements: [PEER] });
    expect(board.elements, "failed board must drop later live frames").toEqual([]);
    rendered().onChange();
    await vi.advanceTimersByTimeAsync(200);

    expect(socket.pushes(), "failed library must not push elements, files or appState").toEqual([]);
    expect(tab.content).toBe(DRAWING);
  });

  test("Reload from disk sends a waiting live stroke before asking", async () => {
    const { tab, board, socket } = await attachedDrawing();
    const resolved = vi.spyOn(api, "resolveSessionConflict")
      .mockRejectedValue(new ApiError(409, "scene session conflict could not be resolved"));
    vi.useFakeTimers();
    board.stroke(STROKE);
    vi.advanceTimersByTime(50);
    const reload = forceReloadFromDisk(tab.id);

    expect({ asked: confirmState.title, pushes: socket.pushes().length, resolved: resolved.mock.calls.length })
      .toEqual({ asked: "Reload from disk?", pushes: 1, resolved: 0 });
    resolveConfirm(true);
    await reload;
    await tick();
    expect(resolved).toHaveBeenCalledWith(tab.path, "reload");
    expect(tab.content).toContain('"stroke"');
    expect(board.elements).toContainEqual(STROKE);
  });

  test("a peer's edit leaves the drawing saved, and its close closes it", async () => {
    const { pane, tab, socket } = await attachedDrawing();
    socket.frame({ type: "update", version: 2, elements: [PEER] });
    await vi.waitFor(() => expect(tab.content).toContain('"peer"'));
    const edited = { dirty: isDirty(tab), pushes: socket.pushes().length };
    // The authority has written the peer's edit.
    socket.frame({ type: "flush", dirty: false, mtime_ns: "2000000000" });
    await closeTab(pane.id, tab.id);

    expect({ edited, closed: readTab(tab.id) === undefined }).toEqual({
      edited: { dirty: false, pushes: 0 },
      closed: true,
    });
  });

  test("a stroke a save pushes before the board's flush reads saved once that flush mirrors it", async () => {
    const { tab, board, socket } = await attachedDrawing();
    board.stroke(STROKE);
    // The save hands the stroke over at once, and its ack lands before the
    // board's flush writes the stroke into the buffer. The save itself ends
    // at the authority's write of the stroke, not at that ack.
    let saved = false;
    const saving = saveTab(tab).then(() => {
      saved = true;
    });
    await vi.waitFor(() => expect(socket.pushes()).toHaveLength(1));
    socket.frame({ type: "push-ok", version: 2, changed: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const atAck = saved;
    socket.frame({ type: "flush", dirty: false, mtime_ns: "2000000000" });
    await saving;
    await vi.waitFor(() => expect(tab.content).toContain('"stroke"'));

    expect({ atAck, dirty: isDirty(tab) }).toEqual({ atAck: false, dirty: false });
  });

  test("a stroke on the wire keeps the drawing unsaved through a peer's edit until its ack", async () => {
    const { tab, board, socket } = await attachedDrawing();
    board.stroke(STROKE);
    await vi.waitFor(() => expect(socket.pushes()).toHaveLength(1));
    socket.frame({ type: "update", version: 2, elements: [PEER] });
    await vi.waitFor(() => expect(tab.content).toContain('"peer"'));
    const beforeAck = isDirty(tab);
    socket.frame({ type: "push-ok", version: 3 });

    expect({ beforeAck, afterAck: isDirty(tab) }).toEqual({ beforeAck: true, afterAck: false });
  });

  test("a timed-out live push keeps the mounted drawing and its unsaved reason", async () => {
    const { tab, board, socket } = await attachedDrawing();
    vi.useFakeTimers();
    board.stroke(STROKE);
    const saving = saveTab(tab);
    await vi.advanceTimersByTimeAsync(6001);
    await saving;
    await tick();
    vi.useRealTimers();

    expect({
      mounted: document.querySelector(".excalidraw-host") !== null,
      buffer: tab.content.includes('"stroke"'),
      reason: document.querySelector(".editor-toolbar .error")?.textContent?.trim(),
      fatal: tab.error,
      dirty: isDirty(tab),
      pushes: socket.pushes().length,
    }).toEqual({
      mounted: true,
      buffer: true,
      reason: "Not saved: the previous live push has not been confirmed",
      fatal: null,
      dirty: true,
      pushes: 1,
    });
  });

  test("an unforced close_tab reports a pending stroke unsaved and pushes it, and the same op closes it after its ack", async () => {
    const { pane, tab, board, socket } = await attachedDrawing();
    vi.useFakeTimers();
    board.stroke(STROKE);
    const op = { kind: "close_tab", pane_id: pane.id, tab_id: tab.id };
    const asked = await paneExec(op);
    const pushed = socket.pushes().map((f) => (f.elements as { id: string }[]).map((e) => e.id));
    socket.frame({ type: "push-ok", version: 2 });
    const again = await paneExec(op);

    expect({ asked, pushed, closed: again.ok && readTab(tab.id) === undefined }).toEqual({
      asked: { ok: false, summary: "blocked 1 tab", blocked: [{ tab: "live.excalidraw", reason: "unsaved changes" }] },
      pushed: [["stroke"]],
      closed: true,
    });
  });

  // The board stays mounted here after its tab is gone, so each close is read
  // once the board's wait and a scene session's linger have both run out.
  test.each(["close_tab", "close_pane", "close_all"])("a forced %s pushes nothing of a pending stroke", async (kind) => {
    const { pane, tab, board, socket } = await attachedDrawing();
    vi.useFakeTimers();
    board.stroke(STROKE);
    const closed = await paneExec({ kind, pane_id: pane.id, tab_id: tab.id, force: true });
    await vi.advanceTimersByTimeAsync(1000);

    expect({ ok: closed.ok, gone: readTab(tab.id) === undefined, pushes: socket.pushes() })
      .toEqual({ ok: true, gone: true, pushes: [] });
  });

  // An unforced close commits every tab's input and checks it in the task its
  // frame arrives in, and closes in the turns after, so what can still wait
  // when the tabs go is a stroke drawn after that check.
  test.each(["close_pane", "close_all"])("an unforced %s delivers a stroke drawn after its check", async (kind) => {
    const { pane, tab, board, socket } = await attachedDrawing();
    vi.useFakeTimers();
    const closing = paneExec({ kind, pane_id: pane.id });
    board.stroke(STROKE);
    const closed = await closing;
    await vi.advanceTimersByTimeAsync(1000);

    expect({
      closed,
      gone: readTab(tab.id) === undefined,
      pushed: socket.pushes().map((f) => (f.elements as { id: string }[]).map((e) => e.id)),
    }).toEqual({
      closed: { ok: true, summary: kind === "close_pane" ? `closed pane ${pane.id}` : "closed 1 tab(s)", blocked: [] },
      gone: true,
      pushed: [["stroke"]],
    });
  });

  const BACKGROUND = "#abcdef";
  /// What the authority holds beyond the file: the file's element one version
  /// on, a peer's element and a peer's background.
  const AUTHORITY = { elements: [{ ...ON_DISK, version: 2 }, PEER], appState: { viewBackgroundColor: BACKGROUND } };
  const snapshotOf = (tab: FileTab, scene: { elements: unknown[]; appState: Record<string, unknown> }) => ({
    type: "snapshot", path: tab.path, version: 1, ...scene, files: {}, dirty: false, mtime_ns: "1000000000", cursors: [],
  });

  /// A drawing on a board the library has not handed over yet, over a session
  /// whose socket is open and has sent nothing.
  async function openingDrawing() {
    const { tab } = await loadedTab("notes/live.excalidraw", DRAWING);
    const { board } = await mountBoard(tab);
    await vi.waitFor(() => expect(sceneSockets).toHaveLength(1));
    const socket = sceneSockets[0]!;
    socket.open();
    return { tab, board, socket };
  }

  /// What the board shows once its first flush has run, and every push it
  /// made. Runs on fake time and hands back real timers.
  async function settled(tab: FileTab, board: ReturnType<typeof excalidrawBoard>, socket: SceneSocket) {
    await vi.advanceTimersByTimeAsync(400);
    vi.useRealTimers();
    return {
      board: board.elements.map((e) => `${(e as { id: string }).id}@${(e as { version: number }).version}`).sort(),
      background: board.appState.viewBackgroundColor,
      pushes: socket.pushes().map(({ elements, appState }) => ({ elements, appState })),
      dirty: isDirty(tab),
    };
  }
  const SHOWS_THE_AUTHORITY = { board: ["on-disk@2", "peer@1"], background: BACKGROUND, pushes: [], dirty: false };

  test("a snapshot the session holds when the library hands its API over is on the board after the init", async () => {
    const { tab, board, socket } = await openingDrawing();
    socket.frame(snapshotOf(tab, AUTHORITY));
    vi.useFakeTimers();
    await board.start();

    expect(await settled(tab, board, socket)).toEqual(SHOWS_THE_AUTHORITY);
  });

  test("a snapshot between the library's handover and its init is on the board after the init", async () => {
    const { tab, board, socket } = await openingDrawing();
    vi.useFakeTimers();
    await board.handOver();
    await vi.advanceTimersByTimeAsync(0);
    socket.frame(snapshotOf(tab, AUTHORITY));
    await board.init();

    expect(await settled(tab, board, socket)).toEqual(SHOWS_THE_AUTHORITY);
  });

  test.each(["a snapshot", "an update"])(
    "%s between the init's apply and its first change is on the board after the seed",
    async (kind) => {
      const { tab, board, socket } = await openingDrawing();
      // An update follows the snapshot every attach begins with: here one of
      // the file as it is.
      if (kind === "an update") socket.frame(snapshotOf(tab, { elements: [ON_DISK], appState: {} }));
      vi.useFakeTimers();
      await board.handOver();
      await vi.advanceTimersByTimeAsync(0);
      await board.init(() =>
        socket.frame(kind === "a snapshot" ? snapshotOf(tab, AUTHORITY) : { type: "update", version: 2, ...AUTHORITY }),
      );

      expect(await settled(tab, board, socket)).toEqual(SHOWS_THE_AUTHORITY);
    },
  );

  test("a board that binds before its socket's snapshot pushes nothing before it and shows the authority after it", async () => {
    const { tab, board, socket } = await openingDrawing();
    vi.useFakeTimers();
    await board.start();
    await vi.advanceTimersByTimeAsync(250);
    const beforeSnapshot = socket.pushes().length;
    socket.frame(snapshotOf(tab, AUTHORITY));

    expect({ beforeSnapshot, ...(await settled(tab, board, socket)) }).toEqual({ beforeSnapshot: 0, ...SHOWS_THE_AUTHORITY });
  });

  test("a live tab whose load ends after the library's init binds at its seed and shows the authority", async () => {
    const { tab, reads } = await loadedTab("notes/live.excalidraw", DRAWING);
    const loading = reloadTabFromDisk(tab.id);
    const { board } = await mountBoard(tab);
    vi.useFakeTimers();
    await board.start();
    await reads.finish(DRAWING);
    await loading;
    await vi.advanceTimersByTimeAsync(0);
    expect(sceneSockets).toHaveLength(1);
    const socket = sceneSockets[0]!;
    socket.open();
    socket.frame(snapshotOf(tab, AUTHORITY));

    expect(await settled(tab, board, socket)).toEqual(SHOWS_THE_AUTHORITY);
  });

  test("a background this window picked stays on its board through a remount within the session's linger", async () => {
    const PICKED = "#123456";
    // The library's render of the snapshot's appState comes first, or it
    // shows that appState over the pick.
    const { tab, board, socket } = await attachedDrawing({ shown: true });
    board.pickBackground(PICKED);
    await vi.waitFor(() => expect(socket.pushes()).toHaveLength(1));
    socket.frame({ type: "push-ok", version: 2 });
    await vi.waitFor(() => expect(tab.content).toContain(PICKED));
    // A move between panes mounts the tab's editor again, and the session's
    // linger carries the session over to the new one.
    await unmount(mounted.pop()!);
    const { board: next } = await mountBoard(readTab(tab.id)!);
    const before = socket.pushes().length;
    vi.useFakeTimers();
    await next.start();
    await vi.advanceTimersByTimeAsync(400);
    vi.useRealTimers();

    expect({
      background: next.appState.viewBackgroundColor,
      reverting: socket
        .pushes()
        .slice(before)
        .filter((p) => p.appState !== undefined && (p.appState as Record<string, unknown>).viewBackgroundColor !== PICKED),
      sockets: sceneSockets.length,
    }).toEqual({ background: PICKED, reverting: [], sockets: 1 });
  });

  const shownIds = (board: ReturnType<typeof excalidrawBoard>) =>
    board.elements.map((e) => (e as { id: string }).id).sort();

  test("a reload within the session's linger shows what the session holds and pushes nothing of the file's", async () => {
    const { tab, board, socket, reads } = await attachedDrawing();
    socket.frame({ type: "update", version: 2, elements: [PEER], appState: { viewBackgroundColor: BACKGROUND } });
    await vi.waitFor(() => expect(board.appState.viewBackgroundColor).toBe(BACKGROUND));
    vi.useFakeTimers();
    // The read answers the file, which holds neither the peer's element nor
    // its background. The board reseeds from it when the load ends and binds
    // again after that, and the bind's replay puts the session's scene back.
    const loading = reloadTabFromDisk(tab.id);
    await vi.advanceTimersByTimeAsync(0);
    await reads.finish(DRAWING);
    await loading;
    await vi.advanceTimersByTimeAsync(400);
    vi.useRealTimers();

    expect({
      board: shownIds(board),
      background: board.appState.viewBackgroundColor,
      pushes: socket.pushes(),
      sockets: sceneSockets.length,
    }).toEqual({ board: ["on-disk", "peer"], background: BACKGROUND, pushes: [], sockets: 1 });
  });

  test("a buffer written without the board, as a conflict's resolution writes it, reseeds a bound board with no replay over it", async () => {
    const { tab, board, socket } = await attachedDrawing();
    socket.frame({ type: "update", version: 2, elements: [PEER] });
    await vi.waitFor(() => expect(tab.content).toContain('"peer"'));
    tab.content = DRAWING;
    tab.saved = DRAWING;
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect({ board: shownIds(board), pushes: socket.pushes() }).toEqual({ board: ["on-disk"], pushes: [] });
  });

  test("a bound board reseeded from another buffer offers neither the background it showed before, when a save asks at once, nor the buffer's at its flush", async () => {
    const { tab, board, socket } = await attachedDrawing({ shown: true });
    vi.useFakeTimers();
    board.pickBackground(PICKED);
    await vi.advanceTimersByTimeAsync(250);
    expect(socket.pushes()).toHaveLength(1);
    socket.frame({ type: "push-ok", version: 2 });
    await vi.advanceTimersByTimeAsync(0);
    expect(tab.content).toContain(PICKED);
    // A conflict's resolution writes the buffer without the board, and a
    // save asks the session for what is local before the board's next flush.
    const RESOLVED = JSON.stringify({ elements: [ON_DISK], appState: { viewBackgroundColor: BACKGROUND }, files: {} });
    tab.content = RESOLVED;
    tab.saved = RESOLVED;
    await tick();
    void saveTab(tab);
    await vi.advanceTimersByTimeAsync(100);
    const atTheSave = socket.pushes().slice(1).map((p) => p.appState);
    // The board's own flush follows: what it seeded with is no change.
    await vi.advanceTimersByTimeAsync(400);
    const atTheFlush = socket.pushes().slice(1).map((p) => p.appState);
    vi.useRealTimers();

    expect({ atTheSave, atTheFlush, shown: board.appState.viewBackgroundColor }).toEqual({
      atTheSave: [],
      atTheFlush: [],
      shown: BACKGROUND,
    });
  });

  /// The backgrounds the pushes on `socket` carried.
  const backgroundsPushed = (socket: SceneSocket) =>
    socket
      .pushes()
      .flatMap((p) => (p.appState === undefined ? [] : [(p.appState as Record<string, unknown>).viewBackgroundColor]));

  /// Step the session's redial on fake time until its next socket opens.
  async function nextSocket(): Promise<SceneSocket> {
    const before = sceneSockets.length;
    for (let i = 0; i < 40 && sceneSockets.length === before; i += 1) await vi.advanceTimersByTimeAsync(250);
    expect(sceneSockets.length).toBeGreaterThan(before);
    const next = sceneSockets.at(-1)!;
    next.open();
    return next;
  }

  const PICKED = "#123456";
  type Attached = Awaited<ReturnType<typeof attachedDrawing>>;
  /// Each way a background this window picked misses the authority: the
  /// backgrounds pushed before the next snapshot, whether a push whose
  /// outcome nobody knows keeps the tab unsaved past the ack, and the way
  /// itself, which picks the background on fake time, lets the board's flush
  /// offer it, and answers the socket the next snapshot lands on.
  const MISSES: [string, unknown[], boolean, (at: Attached) => Promise<SceneSocket>][] = [
    [
      "refused while the socket is down",
      [],
      false,
      async ({ board, socket }) => {
        socket.drop();
        board.pickBackground(PICKED);
        await vi.advanceTimersByTimeAsync(250);
        return nextSocket();
      },
    ],
    [
      "on the wire when the socket drops",
      [PICKED],
      true,
      async ({ board, socket }) => {
        board.pickBackground(PICKED);
        await vi.advanceTimersByTimeAsync(250);
        socket.drop();
        return nextSocket();
      },
    ],
    [
      "refused between a new socket's opening and its snapshot",
      [],
      false,
      async ({ board, socket }) => {
        socket.drop();
        const next = await nextSocket();
        board.pickBackground(PICKED);
        await vi.advanceTimersByTimeAsync(250);
        return next;
      },
    ],
    [
      "refused while the session is degraded with its socket open",
      [],
      false,
      async ({ tab, board, socket }) => {
        sceneSessionFor(tab.id)!.degrade();
        board.pickBackground(PICKED);
        await vi.advanceTimersByTimeAsync(250);
        return socket;
      },
    ],
  ];

  /// What a pick that no authority confirmed reads as once the next snapshot
  /// has been applied, whether the tab reads unsaved once the authority has
  /// acked the push that offers it, and what it reads as once the authority
  /// has written the file. The snapshot holds a peer's background, picked
  /// meanwhile. A push that was on the wire at a drop has no known outcome,
  /// so its tab reads unsaved until that write.
  async function throughSnapshot(read: () => Record<string, unknown>, tab: FileTab, on: SceneSocket) {
    const waiting = read();
    on.frame({ type: "push-ok", version: 2, changed: true });
    await vi.advanceTimersByTimeAsync(0);
    const ackedDirty = isDirty(tab);
    on.frame({ type: "flush", dirty: false, mtime_ns: "2000000000" });
    await vi.advanceTimersByTimeAsync(0);
    const written = read();
    vi.useRealTimers();
    return { waiting, ackedDirty, written };
  }
  const reading = (tab: FileTab, board: ReturnType<typeof excalidrawBoard>, on: SceneSocket, from = 0) => () => ({
    background: board.appState.viewBackgroundColor,
    buffer: tab.content.includes(PICKED),
    offered: backgroundsPushed(on).slice(from),
    dirty: isDirty(tab),
    state: tab.doc?.state,
  });
  const KEEPS_THE_PICK = {
    waiting: { background: PICKED, buffer: true, offered: [PICKED], dirty: true, state: "attached" },
    written: { background: PICKED, buffer: true, offered: [PICKED], dirty: false, state: "attached" },
  };

  test.each(MISSES)(
    "a background %s stays over the next snapshot, is offered after it and reads unsaved until the authority has it",
    async (_way, sentBefore, unknownOutcome, miss) => {
      // The library's render of the snapshot's appState comes first.
      const at = await attachedDrawing({ shown: true });
      vi.useFakeTimers();
      const on = await miss(at);
      const before = sceneSockets.flatMap((socket) => backgroundsPushed(socket));
      const read = reading(at.tab, at.board, on, backgroundsPushed(on).length);
      on.frame(snapshotOf(at.tab, { elements: [ON_DISK], appState: { viewBackgroundColor: BACKGROUND } }));
      await vi.advanceTimersByTimeAsync(400);

      expect({ before, ...(await throughSnapshot(read, at.tab, on)) }).toEqual({
        before: sentBefore,
        ackedDirty: unknownOutcome,
        ...KEEPS_THE_PICK,
      });
    },
  );

  test("a background picked while the socket is down leaves a peer's grid on the board and in the push that offers it", async () => {
    const { tab, board, socket } = await attachedDrawing({ shown: true });
    vi.useFakeTimers();
    socket.drop();
    board.pickBackground(PICKED);
    await vi.advanceTimersByTimeAsync(250);
    const next = await nextSocket();
    // A peer turned the grid on while this window was away.
    next.frame(snapshotOf(tab, { elements: [ON_DISK], appState: { gridModeEnabled: true } }));
    await vi.advanceTimersByTimeAsync(400);
    vi.useRealTimers();

    expect({
      board: { grid: board.appState.gridModeEnabled, background: board.appState.viewBackgroundColor },
      pushed: next.pushes().map((p) => p.appState),
    }).toEqual({
      board: { grid: true, background: PICKED },
      pushed: [{ gridModeEnabled: true, viewBackgroundColor: PICKED }],
    });
  });

  test("a background no authority confirmed follows its tab through a rename", async () => {
    const { tab, board, socket } = await attachedDrawing({ shown: true });
    vi.useFakeTimers();
    socket.drop();
    board.pickBackground(PICKED);
    await vi.advanceTimersByTimeAsync(250);
    // A rename releases the session of the old path at once, and the tab's
    // host acquires one for the new path, which dials.
    rekeyTabsForRename(tab.path, "notes/renamed.excalidraw");
    await vi.advanceTimersByTimeAsync(0);
    const next = sceneSockets.at(-1)!;
    next.open();
    const read = reading(tab, board, next);
    next.frame(snapshotOf(tab, { elements: [ON_DISK], appState: { viewBackgroundColor: BACKGROUND } }));
    await vi.advanceTimersByTimeAsync(400);

    expect({
      sockets: sceneSockets.map((s) => s.url.includes("renamed")),
      ...(await throughSnapshot(read, tab, next)),
    }).toEqual({ sockets: [false, true], ackedDirty: false, ...KEEPS_THE_PICK });
  });

  test("a background picked on a degraded session and reloaded away stays away", async () => {
    const { tab, board, socket, reads } = await attachedDrawing({ shown: true });
    vi.useFakeTimers();
    sceneSessionFor(tab.id)!.degrade();
    board.pickBackground(PICKED);
    await vi.advanceTimersByTimeAsync(250);
    // The tab reads its file again, and the read ends inside the session's
    // linger, so the board binds again to the session it had.
    const loading = reloadTabFromDisk(tab.id);
    await vi.advanceTimersByTimeAsync(0);
    await reads.finish(DRAWING);
    await loading;
    await vi.advanceTimersByTimeAsync(400);
    const reloaded = { background: board.appState.viewBackgroundColor, buffer: tab.content.includes(PICKED) };
    // The session heals at the next snapshot on its socket.
    socket.frame(snapshotOf(tab, { elements: [ON_DISK], appState: {} }));
    await vi.advanceTimersByTimeAsync(400);
    vi.useRealTimers();

    expect({
      reloaded,
      offered: backgroundsPushed(socket),
      background: board.appState.viewBackgroundColor,
      sockets: sceneSockets.length,
    }).toEqual({ reloaded: { background: "#ffffff", buffer: false }, offered: [], background: "#ffffff", sockets: 1 });
  });

  // A reload the server's resolve route answers runs no load: the tab takes
  // the disk's scene from the route's answer and keeps its session.
  describe("a background picked on a board that had adopted, then reloaded away through the resolve route", () => {
    /// The route's answer to a reload: the scene the file holds, which the
    /// authority has adopted.
    function answerWithTheDisk(tab: FileTab) {
      return vi.spyOn(api, "resolveSessionConflict").mockResolvedValue({
        path: tab.path,
        content: DRAWING,
        mtime: 2,
        mtime_ns: "2000000000",
        authority_version: 2,
        disk_conflicted: false,
        writable: true,
      } as Awaited<ReturnType<typeof api.resolveSessionConflict>>);
    }

    /// The board, the buffer and whether the session still holds something
    /// of this window's that the disk lacks, which a claim is.
    const state = (tab: FileTab, board: Awaited<ReturnType<typeof attachedDrawing>>["board"]) => ({
      background: board.appState.viewBackgroundColor,
      buffer: tab.content.includes(PICKED),
      held: isDocUnflushed(tab.id),
    });
    const GONE = { background: "#ffffff", buffer: false, held: false };

    test("stays away after Reload from disk inside the reconnect grace: on the board, in the claim and in every push after the reattach", async () => {
      const { tab, board, socket } = await attachedDrawing({ shown: true });
      const asked = answerWithTheDisk(tab);
      vi.useFakeTimers();
      // The pick is made between two sockets, so no push carries it.
      socket.drop();
      board.pickBackground(PICKED);
      await vi.advanceTimersByTimeAsync(250);
      const picked = { session: tab.doc?.state, ...state(tab, board) };
      const reload = forceReloadFromDisk(tab.id);
      await vi.advanceTimersByTimeAsync(0);
      resolveConfirm(true);
      await reload;
      await vi.advanceTimersByTimeAsync(200);
      const reloaded = state(tab, board);
      const next = await nextSocket();
      next.frame(snapshotOf(tab, { elements: [ON_DISK], appState: {} }));
      await vi.advanceTimersByTimeAsync(400);
      vi.useRealTimers();

      expect({ picked, asked: asked.mock.calls, reloaded, reattached: state(tab, board), pushed: next.pushes() }).toEqual({
        picked: { session: "reconnecting", background: PICKED, buffer: true, held: true },
        asked: [[tab.path, "reload"]],
        reloaded: GONE,
        reattached: GONE,
        pushed: [],
      });
    });

    test("stays away after the conflict prompt's Reload on a degraded session that holds a conflict", async () => {
      const { tab, board } = await attachedDrawing({ shown: true });
      const asked = answerWithTheDisk(tab);
      vi.useFakeTimers();
      sceneSessionFor(tab.id)!.degrade();
      board.pickBackground(PICKED);
      await vi.advanceTimersByTimeAsync(250);
      const picked = { session: tab.doc?.state, ...state(tab, board) };
      Object.assign(conflictDialog, { open: true, tabId: tab.id, path: tab.path, diskConflicted: true });
      await reloadConflictedTab();
      await vi.advanceTimersByTimeAsync(200);
      const reloaded = state(tab, board);
      // The resolution's answer heals the session, which dials for a snapshot.
      expect(sceneSockets).toHaveLength(2);
      const next = sceneSockets.at(-1)!;
      next.open();
      next.frame(snapshotOf(tab, { elements: [ON_DISK], appState: {} }));
      await vi.advanceTimersByTimeAsync(400);
      vi.useRealTimers();

      expect({ picked, asked: asked.mock.calls, reloaded, reattached: state(tab, board), pushed: next.pushes() }).toEqual({
        picked: { session: "degraded", background: PICKED, buffer: true, held: true },
        asked: [[tab.path, "reload"]],
        reloaded: GONE,
        reattached: GONE,
        pushed: [],
      });
    });
  });

  // A resolution that keeps the tab's version tells the session nothing, so a
  // claim the session holds stands through it.
  describe("a background picked on a degraded session that holds a conflict, then kept by an overwrite", () => {
    /// The route's answer to an overwrite: the authority's scene, which the
    /// pick never reached.
    function answerWithTheAuthority(tab: FileTab) {
      return vi.spyOn(api, "resolveSessionConflict").mockResolvedValue({
        path: tab.path,
        content: DRAWING,
        mtime: 2,
        mtime_ns: "2000000000",
        authority_version: 2,
        disk_conflicted: false,
        writable: true,
      } as Awaited<ReturnType<typeof api.resolveSessionConflict>>);
    }

    test.each([
      [
        "the conflict prompt's Overwrite",
        async (tab: FileTab) => {
          Object.assign(conflictDialog, { open: true, tabId: tab.id, path: tab.path, diskConflicted: true });
          await overwriteConflictedTab();
        },
      ],
      [
        "the conflict banner's Keep mine",
        async (tab: FileTab) => {
          tab.diskConflicted = true;
          const kept = overwriteDiskConflict(tab.id);
          await vi.advanceTimersByTimeAsync(0);
          resolveConfirm(true);
          await kept;
        },
      ],
    ])("stays the session's claim through %s, and is offered after the reattach", async (_name, overwrite) => {
      const { tab, board } = await attachedDrawing({ shown: true });
      const asked = answerWithTheAuthority(tab);
      vi.useFakeTimers();
      sceneSessionFor(tab.id)!.degrade();
      board.pickBackground(PICKED);
      await vi.advanceTimersByTimeAsync(250);
      const picked = { session: tab.doc?.state, held: isDocUnflushed(tab.id) };
      await overwrite(tab);
      await vi.advanceTimersByTimeAsync(200);
      const held = isDocUnflushed(tab.id);
      // The resolution's answer heals the session, which dials for a snapshot.
      expect(sceneSockets).toHaveLength(2);
      const next = sceneSockets.at(-1)!;
      next.open();
      next.frame(snapshotOf(tab, { elements: [ON_DISK], appState: {} }));
      await vi.advanceTimersByTimeAsync(400);
      vi.useRealTimers();

      expect({
        picked,
        asked: asked.mock.calls,
        held,
        background: board.appState.viewBackgroundColor,
        offered: backgroundsPushed(next),
      }).toEqual({
        picked: { session: "degraded", held: true },
        asked: [[tab.path, "overwrite"]],
        held: true,
        background: PICKED,
        offered: [PICKED],
      });
    });
  });

  test("a background claim is dropped when its tab turns read only, and the board takes the authority's", async () => {
    const { tab, board, socket } = await attachedDrawing({ shown: true });
    vi.useFakeTimers();
    socket.drop();
    board.pickBackground(PICKED);
    await vi.advanceTimersByTimeAsync(250);
    setTabReadMode(tab, true);
    await vi.advanceTimersByTimeAsync(100);
    const readOnly = board.appState.viewBackgroundColor;
    const next = await nextSocket();
    // A peer picked a background meanwhile.
    next.frame(snapshotOf(tab, { elements: [ON_DISK], appState: { viewBackgroundColor: BACKGROUND } }));
    await vi.advanceTimersByTimeAsync(400);
    vi.useRealTimers();

    expect({
      readOnly,
      background: board.appState.viewBackgroundColor,
      offered: sceneSockets.flatMap((s) => backgroundsPushed(s)),
      buffer: tab.content.includes(PICKED),
      dirty: isDirty(tab),
    }).toEqual({ readOnly: "#ffffff", background: BACKGROUND, offered: [], buffer: false, dirty: false });
  });

  test("a background claim is dropped when its file loses its write bit, and the board takes the authority's", async () => {
    const { tab, board, socket } = await attachedDrawing({ shown: true });
    vi.useFakeTimers();
    socket.drop();
    board.pickBackground(PICKED);
    await vi.advanceTimersByTimeAsync(250);
    // A watcher frame carries the bit: the file turned read only on disk.
    applyFsWritable(tab.id, false);
    await vi.advanceTimersByTimeAsync(100);
    const readOnly = board.appState.viewBackgroundColor;
    const next = await nextSocket();
    // A peer picked a background meanwhile.
    next.frame(snapshotOf(tab, { elements: [ON_DISK], appState: { viewBackgroundColor: BACKGROUND } }));
    await vi.advanceTimersByTimeAsync(400);
    vi.useRealTimers();

    expect({
      readOnly,
      background: board.appState.viewBackgroundColor,
      offered: sceneSockets.flatMap((s) => backgroundsPushed(s)),
      buffer: tab.content.includes(PICKED),
      dirty: isDirty(tab),
    }).toEqual({ readOnly: "#ffffff", background: BACKGROUND, offered: [], buffer: false, dirty: false });
  });

  test.each([
    ["a peer's update", (_tab: FileTab) => ({ type: "update", version: 2, elements: [], appState: { gridSize: 40 } })],
    ["a snapshot the server fans", (tab: FileTab) => snapshotOf(tab, { elements: [ON_DISK], appState: { gridSize: 40 } })],
  ] as const)(
    "a pick the board has not offered yet stays on it through the appState of %s, and the board's next flush offers it",
    async (_frame, frame) => {
      const { tab, board, socket } = await attachedDrawing({ shown: true });
      vi.useFakeTimers();
      // A stroke's push is on the wire, unacked, and a background queues
      // behind it.
      board.stroke(STROKE);
      await vi.advanceTimersByTimeAsync(200);
      board.pickBackground(PICKED);
      await vi.advanceTimersByTimeAsync(200);
      const queued = socket.pushes().map((push) => "appState" in push);
      // The grid is switched on inside the board's wait, and the frame lands
      // before that wait ends.
      board.switchGrid(true);
      await vi.advanceTimersByTimeAsync(50);
      socket.frame(frame(tab));
      await vi.advanceTimersByTimeAsync(400);
      const waiting = { board: board.appState, pushes: socket.pushes().length, dirty: isDirty(tab) };
      socket.frame({ type: "push-ok", version: 3 });
      const drained = socket.pushes()[1];
      socket.frame({ type: "push-ok", version: 4 });
      await vi.advanceTimersByTimeAsync(400);
      vi.useRealTimers();

      const BOARD = { gridSize: 40, gridStep: 5, gridModeEnabled: true, viewBackgroundColor: PICKED };
      expect({ queued, waiting, drained, pushes: socket.pushes().length, board: board.appState, dirty: isDirty(tab) }).toEqual({
        queued: [false],
        waiting: { board: BOARD, pushes: 1, dirty: true },
        drained: {
          type: "push",
          elements: [],
          appState: { gridSize: 40, gridModeEnabled: true, viewBackgroundColor: PICKED },
        },
        pushes: 2,
        board: BOARD,
        dirty: false,
      });
    },
  );

  test("a pick the board has not offered yet stays on it through a reconnect's first snapshot, and that snapshot's flush offers it", async () => {
    const { tab, board, socket } = await attachedDrawing({ shown: true });
    vi.useFakeTimers();
    socket.drop();
    const next = await nextSocket();
    // The grid is switched on inside the board's wait, and the new socket's
    // first snapshot lands before that wait ends.
    board.switchGrid(true);
    await vi.advanceTimersByTimeAsync(50);
    next.frame(snapshotOf(tab, { elements: [ON_DISK], appState: {} }));
    await vi.advanceTimersByTimeAsync(400);
    const offered = { board: board.appState, old: socket.pushes(), pushes: next.pushes(), dirty: isDirty(tab) };
    next.frame({ type: "push-ok", version: 2 });
    await vi.advanceTimersByTimeAsync(400);
    vi.useRealTimers();

    const BOARD = { gridSize: 20, gridStep: 5, gridModeEnabled: true, viewBackgroundColor: "#ffffff" };
    expect({ offered, pushes: next.pushes().length, board: board.appState, dirty: isDirty(tab) }).toEqual({
      offered: {
        board: BOARD,
        old: [],
        pushes: [{ type: "push", elements: [], appState: { gridModeEnabled: true } }],
        dirty: true,
      },
      pushes: 1,
      board: BOARD,
      dirty: false,
    });
  });

  test("a pick the board has not offered yet, with nothing of this window's on the wire, stays on it through a peer's appState, and the board's next flush offers it", async () => {
    const { tab, board, socket } = await attachedDrawing({ shown: true });
    vi.useFakeTimers();
    // The grid is switched on inside the board's wait, and the peer's update
    // lands before that wait ends. The update offers nothing itself.
    board.switchGrid(true);
    await vi.advanceTimersByTimeAsync(50);
    socket.frame({ type: "update", version: 2, elements: [], appState: { gridSize: 40 } });
    const landed = socket.pushes().length;
    await vi.advanceTimersByTimeAsync(400);
    const offered = { board: board.appState, pushes: socket.pushes(), dirty: isDirty(tab) };
    socket.frame({ type: "push-ok", version: 3 });
    await vi.advanceTimersByTimeAsync(400);
    vi.useRealTimers();

    const BOARD = { gridSize: 40, gridStep: 5, gridModeEnabled: true, viewBackgroundColor: "#ffffff" };
    expect({ landed, offered, pushes: socket.pushes().length, board: board.appState, dirty: isDirty(tab) }).toEqual({
      landed: 0,
      offered: {
        board: BOARD,
        pushes: [{ type: "push", elements: [], appState: { gridSize: 40, gridModeEnabled: true } }],
        dirty: true,
      },
      pushes: 1,
      board: BOARD,
      dirty: false,
    });
  });

  /// A peer's background and a grid size nobody here picked, and what a board
  /// that keeps its own pick over them shows and pushes.
  const PEERS_APP_STATE = { viewBackgroundColor: BACKGROUND, gridSize: 40 };
  const PICK_OVER_PEERS = { gridSize: 40, gridStep: 5, gridModeEnabled: false, viewBackgroundColor: PICKED };
  const CLAIM_PUSH = { type: "push", elements: [], appState: { viewBackgroundColor: PICKED, gridSize: 40 } };
  /// The pick's color and the peer's, whichever the tab's buffer holds.
  const buffered = (tab: FileTab) => [PICKED, BACKGROUND].filter((color) => tab.content.includes(color));

  test.each([
    ["inside the board's wait", 50],
    ["after the board's flush", 250],
  ] as const)(
    "a background picked %s on a board before its session's first snapshot stays over that snapshot's and is pushed after it",
    async (_when, wait) => {
      const { tab, board, socket } = await openingDrawing();
      vi.useFakeTimers();
      await board.start();
      await vi.advanceTimersByTimeAsync(250);
      // The server's first frame carries no scene: the board shows the buffer
      // it seeded from until the snapshot lands.
      socket.frame({ type: "hello" });
      board.pickBackground(PICKED);
      await vi.advanceTimersByTimeAsync(wait);
      const picked = { background: board.appState.viewBackgroundColor, pushes: socket.pushes() };
      socket.frame(snapshotOf(tab, { elements: [ON_DISK], appState: PEERS_APP_STATE }));
      await vi.advanceTimersByTimeAsync(400);
      const waiting = { pushes: socket.pushes(), buffer: buffered(tab), dirty: isDirty(tab) };
      const shown = board.appState;
      socket.frame({ type: "push-ok", version: 2 });
      await vi.advanceTimersByTimeAsync(400);
      vi.useRealTimers();

      expect(picked, "the pick is on the board and nothing is pushed before the first snapshot").toEqual({
        background: PICKED,
        pushes: [],
      });
      expect(shown, "the board keeps the pick over the first snapshot and takes its other key").toEqual(PICK_OVER_PEERS);
      expect(waiting, "the pick made before the first snapshot is pushed once, written and unsaved").toEqual({
        pushes: [CLAIM_PUSH],
        buffer: [PICKED],
        dirty: true,
      });
      expect(
        { pushes: socket.pushes().length, board: board.appState, dirty: isDirty(tab) },
        "the ack saves the tab with the pick made before the first snapshot",
      ).toEqual({ pushes: 1, board: PICK_OVER_PEERS, dirty: false });
    },
  );

  test("a background picked inside the board's wait before its tab turns read only is replaced by a peer's appState", async () => {
    const { tab, board, socket } = await attachedDrawing({ shown: true });
    vi.useFakeTimers();
    board.pickBackground(PICKED);
    await vi.advanceTimersByTimeAsync(50);
    setTabReadMode(tab, true);
    socket.frame({ type: "update", version: 2, elements: [], appState: { viewBackgroundColor: BACKGROUND } });
    await vi.advanceTimersByTimeAsync(400);
    vi.useRealTimers();

    expect({ background: board.appState.viewBackgroundColor, pushes: socket.pushes() }).toEqual({
      background: BACKGROUND,
      pushes: [],
    });
  });

  test("a background on the wire at a drop with no board bound ends as it does with one", async () => {
    const { tab, board, socket } = await attachedDrawing({ shown: true });
    vi.useFakeTimers();
    board.pickBackground(PICKED);
    await vi.advanceTimersByTimeAsync(250);
    await unmount(mounted.pop()!);
    const { board: rebound } = await mountBoard(tab);
    socket.drop();
    const next = await nextSocket();
    const before = backgroundsPushed(socket);
    // The board binds after the snapshot has landed, so the session replays it.
    next.frame(snapshotOf(tab, { elements: [ON_DISK], appState: { viewBackgroundColor: BACKGROUND } }));
    await rebound.start();
    await vi.advanceTimersByTimeAsync(400);

    expect({ before, ...(await throughSnapshot(reading(tab, rebound, next), tab, next)) }).toEqual({
      before: [PICKED],
      ackedDirty: true,
      ...KEEPS_THE_PICK,
    });
  });

  test("a board first shown while its session is between sockets pushes nothing and takes a peer's background from the next snapshot", async () => {
    const { tab } = await loadedTab("notes/live.excalidraw", DRAWING);
    // A tab restored behind another has a session and no board: the host
    // loads the canvas when the tab is first shown.
    const target = document.createElement("div");
    document.body.append(target);
    const hidden = mount(FileEditorTab, { target, props: { tab, active: false, focused: false } });
    await vi.waitFor(() => expect(sceneSockets).toHaveLength(1));
    const socket = sceneSockets[0]!;
    socket.open();
    socket.frame(snapshotOf(tab, { elements: [ON_DISK], appState: {} }));
    expect(tab.doc?.state).toBe("attached");
    vi.useFakeTimers();
    socket.drop();
    // The pane shows the tab: its editor mounts in front, inside the
    // session's linger, and the board seeds from the buffer of the load.
    await unmount(hidden);
    const { board } = await mountBoard(tab);
    await board.start();
    const next = await nextSocket();
    // A peer picked a background while this window was away.
    next.frame(snapshotOf(tab, { elements: [ON_DISK], appState: { viewBackgroundColor: BACKGROUND } }));
    await vi.advanceTimersByTimeAsync(400);
    vi.useRealTimers();

    expect({
      sockets: sceneSockets.length,
      pushes: sceneSockets.flatMap((s) => s.pushes()),
      background: board.appState.viewBackgroundColor,
      dirty: isDirty(tab),
    }).toEqual({ sockets: 2, pushes: [], background: BACKGROUND, dirty: false });
  });

  test("a background picked on a board first shown between sockets stays over the next snapshot's and is pushed after it", async () => {
    const { tab } = await loadedTab("notes/live.excalidraw", DRAWING);
    const target = document.createElement("div");
    document.body.append(target);
    const hidden = mount(FileEditorTab, { target, props: { tab, active: false, focused: false } });
    await vi.waitFor(() => expect(sceneSockets).toHaveLength(1));
    const socket = sceneSockets[0]!;
    socket.open();
    socket.frame(snapshotOf(tab, { elements: [ON_DISK], appState: {} }));
    expect(tab.doc?.state).toBe("attached");
    vi.useFakeTimers();
    socket.drop();
    await unmount(hidden);
    const { board } = await mountBoard(tab);
    // The library's render of the seed's appState comes first, or it shows
    // that appState over the pick.
    board.holdRenders();
    await board.start();
    await board.render();
    // The board shows the buffer it seeded from, and the pick is its user's
    // change to it.
    board.pickBackground(PICKED);
    await vi.advanceTimersByTimeAsync(250);
    const picked = { background: board.appState.viewBackgroundColor, buffer: tab.content.includes(PICKED) };
    const next = await nextSocket();
    // A peer picked a background and a grid size while this window was away.
    next.frame(snapshotOf(tab, { elements: [ON_DISK], appState: PEERS_APP_STATE }));
    await vi.advanceTimersByTimeAsync(400);
    const waiting = {
      old: socket.pushes(),
      pushes: sceneSockets.flatMap((s) => s.pushes()),
      buffer: buffered(tab),
      dirty: isDirty(tab),
    };
    const shown = board.appState;
    next.frame({ type: "push-ok", version: 2 });
    await vi.advanceTimersByTimeAsync(400);
    vi.useRealTimers();

    expect(picked, "the pick is on the board and in the buffer before the next socket").toEqual({
      background: PICKED,
      buffer: true,
    });
    expect(shown, "the board keeps the pick over the next socket's snapshot and takes its other key").toEqual(
      PICK_OVER_PEERS,
    );
    expect(waiting, "the pick made between two sockets is pushed once on the new one, written and unsaved").toEqual({
      old: [],
      pushes: [CLAIM_PUSH],
      buffer: [PICKED],
      dirty: true,
    });
    expect(
      { pushes: sceneSockets.flatMap((s) => s.pushes()).length, board: board.appState, dirty: isDirty(tab) },
      "the ack saves the tab with the pick made between two sockets",
    ).toEqual({ pushes: 1, board: PICK_OVER_PEERS, dirty: false });
  });

  /// The element ids of each push on `socket`.
  const idsPushed = (socket: SceneSocket) =>
    socket.pushes().map((p) => (p.elements as { id: string }[]).map((e) => e.id));

  test("a snapshot fanned on the socket over a push on the wire loses no stroke to a drop after that push's ack", async () => {
    const X = { id: "x", type: "rectangle", version: 1, versionNonce: 3, isDeleted: false };
    const Y = { id: "y", type: "rectangle", version: 1, versionNonce: 4, isDeleted: false };
    const { tab, board, socket } = await attachedDrawing({ shown: true });
    vi.useFakeTimers();
    board.stroke(X);
    await vi.advanceTimersByTimeAsync(250);
    board.stroke(Y);
    await vi.advanceTimersByTimeAsync(250);
    // A conflict's resolution fans a snapshot that overtakes the push on the
    // wire; the authority reads and acks that push after it.
    socket.frame(snapshotOf(tab, { elements: [ON_DISK], appState: {} }));
    await vi.advanceTimersByTimeAsync(0);
    const afterFan = idsPushed(socket);
    socket.frame({ type: "push-ok", version: 2 });
    socket.drop();
    const next = await nextSocket();
    // The authority applied the first push and never read the second.
    next.frame(snapshotOf(tab, { elements: [ON_DISK, X], appState: {} }));
    await vi.advanceTimersByTimeAsync(400);
    vi.useRealTimers();

    expect({ afterFan, pushedAgain: idsPushed(next) }).toEqual({ afterFan: [["x"]], pushedAgain: [["y"]] });
  });

  test("a stroke on the wire survives an unbound fresh snapshot and canvas remount", async () => {
    const X = { id: "x", type: "rectangle", version: 1, versionNonce: 3, isDeleted: false };
    const { tab, board, socket } = await attachedDrawing();
    vi.useFakeTimers();
    board.stroke(X);
    await vi.advanceTimersByTimeAsync(250);
    await unmount(mounted.pop()!);
    const { board: rebound } = await mountBoard(tab);
    socket.drop();
    const next = await nextSocket();
    next.frame(snapshotOf(tab, { elements: [ON_DISK], appState: {} }));
    await rebound.start();
    await vi.advanceTimersByTimeAsync(400);
    vi.useRealTimers();

    expect({
      first: idsPushed(socket),
      replayedStroke: idsPushed(next).some((ids) => ids.includes("x")),
      board: shownIds(rebound),
      buffer: tab.content.includes('"x"'),
      dirty: isDirty(tab),
    }).toEqual({ first: [["x"]], replayedStroke: true, board: ["on-disk", "x"], buffer: true, dirty: true });
  });

  test("a snapshot fanned on the socket over a background on the wire leaves the pick on the board and in the buffer", async () => {
    const PICKED = "#123456";
    const { tab, board, socket } = await attachedDrawing({ shown: true });
    vi.useFakeTimers();
    board.pickBackground(PICKED);
    await vi.advanceTimersByTimeAsync(250);
    socket.frame(snapshotOf(tab, { elements: [ON_DISK], appState: {} }));
    socket.frame({ type: "push-ok", version: 2 });
    await vi.advanceTimersByTimeAsync(400);
    vi.useRealTimers();

    expect({
      pushed: backgroundsPushed(socket),
      background: board.appState.viewBackgroundColor,
      buffer: tab.content.includes(PICKED),
      dirty: isDirty(tab),
    }).toEqual({ pushed: [PICKED], background: PICKED, buffer: true, dirty: false });
  });

  test("a roster frame does not replay the session's scene over a background picked inside the debounce", async () => {
    const PICKED = "#123456";
    const { tab, board, socket } = await openingDrawing();
    // A peer's pointer is known when the board binds, so the bind's replay
    // names that peer through the session's roster.
    socket.frame({
      ...snapshotOf(tab, { elements: [ON_DISK], appState: {} }),
      cursors: [{ id: 7, w: "win-peer", x: 1, y: 2 }],
    });
    vi.useFakeTimers();
    await board.start();
    await vi.advanceTimersByTimeAsync(400);
    board.pickBackground(PICKED);
    applySessionRoster({
      participants: [{ window_id: "win-peer", name: "Peer", role: "follower", status: "live" }],
      leader: null,
    });
    await vi.advanceTimersByTimeAsync(400);
    vi.useRealTimers();

    expect({ background: board.appState.viewBackgroundColor, pushed: backgroundsPushed(socket) }).toEqual({
      background: PICKED,
      pushed: [PICKED],
    });
  });

  test("an image the library marks as failing to decode is not pushed, and a stroke after it is", async () => {
    const files = { picture: { id: "picture", mimeType: "image/png", dataURL: "data:image/png;base64,AAAA", created: 1 } };
    const image = { id: "image", type: "image", version: 1, versionNonce: 5, fileId: "picture", status: "saved", isDeleted: false };
    const { tab } = await loadedTab("notes/live-picture.excalidraw", JSON.stringify({ elements: [image], appState: {}, files }));
    const { board } = await mountBoard(tab);
    await board.start();
    await vi.waitFor(() => expect(sceneSockets).toHaveLength(1));
    const socket = sceneSockets[0]!;
    socket.open();
    socket.frame({
      type: "snapshot", path: tab.path, version: 1, elements: [image], appState: {}, files,
      dirty: false, mtime_ns: "1000000000", cursors: [],
    });
    expect(tab.doc?.state).toBe("attached");
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(200);
    board.failImageDecode("picture");
    await vi.advanceTimersByTimeAsync(200);
    const afterMark = { pushes: socket.pushes().length, dirty: isDirty(tab) };
    board.stroke(STROKE);
    await vi.advanceTimersByTimeAsync(200);

    expect({
      afterMark,
      pushed: socket.pushes().map((push) => (push.elements as Array<{ id: string }>).map((el) => el.id)),
    }).toEqual({ afterMark: { pushes: 0, dirty: false }, pushed: [["stroke"]] });
  });

  const FILES = { picture: { id: "picture", mimeType: "image/png", dataURL: "data:image/png;base64,AAAA", created: 1 } };
  const IMAGE = { id: "image", type: "image", version: 1, versionNonce: 5, fileId: "picture", status: "saved", isDeleted: false };
  const pictureSnapshot = (tab: FileTab, elements: unknown[], files: unknown = FILES) => ({
    type: "snapshot", path: tab.path, version: 1, elements, appState: {}, files, dirty: false, mtime_ns: "1000000000", cursors: [],
  });

  /// A drawing of one image on its board, over a session whose socket is open
  /// and has sent nothing.
  async function openingPicture(image: Record<string, unknown> = IMAGE) {
    const { tab } = await loadedTab(
      "notes/live-picture.excalidraw",
      JSON.stringify({ elements: [image], appState: {}, files: FILES }),
    );
    const { board } = await mountBoard(tab);
    await board.start();
    await vi.waitFor(() => expect(sceneSockets).toHaveLength(1));
    const socket = sceneSockets[0]!;
    socket.open();
    return { tab, board, socket };
  }

  /// The same drawing attached to a session whose snapshot holds `held`, on
  /// the test's clock and past the board's first debounce.
  async function attachedPicture(held: unknown[] = [IMAGE], image: Record<string, unknown> = IMAGE) {
    const { tab, board, socket } = await openingPicture(image);
    socket.frame(pictureSnapshot(tab, held));
    expect(tab.doc?.state).toBe("attached");
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(200);
    return { tab, board, socket };
  }

  /// The board's elements, each as its id, its status and its version.
  const shownMarks = (board: ReturnType<typeof excalidrawBoard>) =>
    (board.elements as Array<Record<string, unknown>>).map((el) => [el.id, el.status, el.version]);

  test("a snapshot adopted after the library's mark offers nothing of the image, and a stroke after it is pushed alone", async () => {
    const { tab, board, socket } = await attachedPicture();
    board.failImageDecode("picture");
    await vi.advanceTimersByTimeAsync(200);
    // The server fans a snapshot on the socket at a conflict's resolution. It
    // carries the image as the authority holds it, one version behind the
    // board's marked copy, which the reconcile keeps.
    socket.frame(pictureSnapshot(tab, [IMAGE]));
    await vi.advanceTimersByTimeAsync(200);
    const afterAdopt = idsPushed(socket);
    board.stroke(STROKE);
    await vi.advanceTimersByTimeAsync(200);

    expect({ shown: shownMarks(board), afterAdopt, pushed: idsPushed(socket) }).toEqual({
      shown: [["image", "error", 2], ["stroke", undefined, 1]],
      afterAdopt: [],
      pushed: [["stroke"]],
    });
  });

  test("a deleted copy of an image the library marks is not pushed", async () => {
    // The authority holds a deleted copy of the image, as a peer's delete
    // leaves one, and the library marks every image of the file that failed.
    const COPY = { ...IMAGE, id: "copy", versionNonce: 6, isDeleted: true };
    const { tab, board, socket } = await attachedPicture([IMAGE, COPY]);
    board.failImageDecode("picture");
    await vi.advanceTimersByTimeAsync(200);

    expect({ shown: shownMarks(board), pushed: idsPushed(socket), dirty: isDirty(tab) }).toEqual({
      shown: [["image", "error", 2], ["copy", "error", 2]],
      pushed: [],
      dirty: false,
    });
  });

  test("an image the authority does not hold is offered, though the library marked it before the snapshot", async () => {
    const { tab, board, socket } = await openingPicture();
    vi.useFakeTimers();
    board.failImageDecode("picture");
    // The board's flush runs before the socket's snapshot, when the session
    // takes no push.
    await vi.advanceTimersByTimeAsync(200);
    const beforeSnapshot = socket.pushes().length;
    socket.frame(pictureSnapshot(tab, [], {}));
    await vi.advanceTimersByTimeAsync(200);

    expect({
      beforeSnapshot,
      pushed: socket.pushes().map((push) => ({
        elements: (push.elements as Array<Record<string, unknown>>).map((el) => [el.id, el.status]),
        files: Object.keys((push.files ?? {}) as Record<string, unknown>),
      })),
    }).toEqual({ beforeSnapshot: 0, pushed: [{ elements: [["image", "error"]], files: ["picture"] }] });
  });

  test.each([
    ["no mark", IMAGE, false],
    ["the library's mark, set on this board", IMAGE, true],
    ["a mark the authority holds", { ...IMAGE, status: "error" }, false],
  ])("the user's move of an image carrying %s is pushed", async (_mark, image, fails) => {
    const { board, socket } = await attachedPicture([image], image);
    if (fails) {
      board.failImageDecode("picture");
      await vi.advanceTimersByTimeAsync(200);
    }
    // The user's move, as the library makes it: the same element, one
    // version on, and the change reported.
    const onBoard = board.elements as Array<Record<string, unknown>>;
    onBoard[0] = { ...onBoard[0], x: 40, version: Number(onBoard[0]!.version) + 1 };
    boardPropsFromRender(render.mock.calls.at(-1)![0]).onChange();
    await vi.advanceTimersByTimeAsync(200);

    expect(
      socket.pushes().map((push) => (push.elements as Array<Record<string, unknown>>).map((el) => [el.id, el.x])),
    ).toEqual([[["image", 40]]]);
  });

  test("a second move of an image the library marked is pushed, once the authority holds the marked copy", async () => {
    const { board, socket } = await attachedPicture();
    board.failImageDecode("picture");
    await vi.advanceTimersByTimeAsync(200);
    const move = async (x: number) => {
      const onBoard = board.elements as Array<Record<string, unknown>>;
      onBoard[0] = { ...onBoard[0], x, version: Number(onBoard[0]!.version) + 1 };
      boardPropsFromRender(render.mock.calls.at(-1)![0]).onChange();
      await vi.advanceTimersByTimeAsync(200);
    };
    await move(40);
    // The first move carried the mark to the authority.
    socket.frame({ type: "push-ok", version: 2 });
    await move(80);

    expect(
      socket.pushes().map((push) => (push.elements as Array<Record<string, unknown>>).map((el) => [el.id, el.x, el.status])),
    ).toEqual([[["image", 40, "error"]], [["image", 80, "error"]]]);
  });

  test("an image the library marks before the socket's snapshot, inside the debounce, is not pushed at the snapshot", async () => {
    const { tab, board, socket } = await openingPicture();
    vi.useFakeTimers();
    board.failImageDecode("picture");
    // The session pushes what the board holds as soon as it has adopted the
    // snapshot, before the board's flush has run.
    socket.frame(pictureSnapshot(tab, [IMAGE]));
    const atSnapshot = idsPushed(socket);
    await vi.advanceTimersByTimeAsync(400);

    expect({ shown: shownMarks(board), atSnapshot, pushed: idsPushed(socket), dirty: isDirty(tab) }).toEqual({
      shown: [["image", "error", 2]],
      atSnapshot: [],
      pushed: [],
      dirty: false,
    });
  });

  describe("Restore of an entry an earlier page load left", () => {
    const PATH = "notes/live.excalidraw";
    const MINE = { id: "mine", type: "rectangle", version: 1, versionNonce: 5, isDeleted: false };

    /// Leave a recovery entry for the drawing, as an earlier page load does:
    /// its scene then, in the library's serialization.
    function strand(elements: unknown[], appState: Record<string, unknown> = { viewBackgroundColor: "#ffffff" }): void {
      strandText(JSON.stringify({ type: "excalidraw", version: 2, source: "chan", elements, appState, files: {} }));
    }

    /// Leave a recovery entry that holds `content`, whatever it is.
    function strandText(content: string): void {
      localStorage.setItem(
        bufferKey(PATH),
        JSON.stringify({ content, updatedAt: Date.now(), path: PATH, sessionId: "an-earlier-load" }),
      );
    }

    /// What the recovery banner says, and null when none is shown.
    const bannerText = () => document.querySelector(".recovery-banner-text")?.textContent?.trim() ?? null;
    const stored = () => localStorage.getItem(bufferKey(PATH)) !== null;
    const UNREADABLE = "The unsaved changes cannot be read as a drawing, so nothing was restored.";
    const NOTHING_NEWER =
      "Nothing was restored: the unsaved changes hold no element newer than this board's, and Restore on a live drawing leaves its grid, background and deleted elements as they are.";

    /// Press Restore, on fake time from the press on, so that a test reads
    /// the board at once and again after the board's wait.
    async function restore(): Promise<void> {
      await vi.waitFor(() => expect(document.querySelector(".recovery-banner-restore")).not.toBeNull());
      vi.useFakeTimers();
      document.querySelector<HTMLButtonElement>(".recovery-banner-restore")!.click();
      await tick();
    }

    const pushed = (socket: SceneSocket) =>
      socket.pushes().map(({ elements, appState }) => ({
        elements: (elements as { id: string; version: number }[]).map((e) => `${e.id}@${e.version}`),
        appState,
      }));

    afterEach(() => localStorage.removeItem(bufferKey(PATH)));

    test("on a live board keeps a peer's background and element and pushes what the entry holds beyond them", async () => {
      // The entry holds the file's element, a stroke that never reached the
      // authority, and the background of its time.
      strand([ON_DISK, MINE]);
      const { tab, board, socket } = await attachedDrawing();
      // A peer picks a background and draws after the entry's stamp.
      socket.frame({ type: "update", version: 2, elements: [PEER], appState: { viewBackgroundColor: BACKGROUND } });
      await vi.waitFor(() => expect(board.appState.viewBackgroundColor).toBe(BACKGROUND));
      await vi.waitFor(() => expect(tab.content).toContain('"peer"'));

      await restore();
      const read = () => ({
        board: shownIds(board),
        background: board.appState.viewBackgroundColor,
        pushed: pushed(socket),
        buffer: ["mine", "peer", BACKGROUND].filter((part) => tab.content.includes(part)),
        dirty: isDirty(tab),
        banner: document.querySelector(".recovery-banner") !== null,
      });
      const atOnce = read();
      await vi.advanceTimersByTimeAsync(400);
      const afterTheWait = read();
      // The ack moves the tab's saved text, which is when its open asks
      // again whether an entry is stored for it.
      socket.frame({ type: "push-ok", version: 3 });
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();

      const RESTORED = {
        board: ["mine", "on-disk", "peer"],
        background: BACKGROUND,
        pushed: [{ elements: ["mine@1"], appState: undefined }],
        buffer: ["mine", "peer", BACKGROUND],
        dirty: true,
        banner: false,
      };
      expect({ atOnce, afterTheWait, acked: { dirty: isDirty(tab), banner: read().banner } }).toEqual({
        atOnce: RESTORED,
        afterTheWait: RESTORED,
        acked: { dirty: false, banner: false },
      });
    });

    test.each([
      ["between sockets", (socket: SceneSocket, _tabId: string) => socket.drop()],
      ["degraded", (_socket: SceneSocket, tabId: string) => sceneSessionFor(tabId)!.degrade()],
    ])("on a live board whose session is %s, the store holds the restored scene when Restore returns", async (_name, refuse) => {
      // The session takes no push, so what Restore put on the board is in
      // this page's memory and nowhere else unless the store holds it.
      strand([ON_DISK, MINE]);
      const { tab, board, socket } = await attachedDrawing();
      refuse(socket, tab.id);

      // Time is fake from the press on and is not advanced: this reads what
      // the store holds before the recovery write's debounce can run.
      await restore();
      const raw = localStorage.getItem(bufferKey(PATH));
      const held = raw === null ? null : (JSON.parse(raw) as { content: string; sessionId: string });
      vi.useRealTimers();

      expect({
        board: shownIds(board),
        pushed: pushed(socket),
        buffer: tab.content.includes('"mine"'),
        stored:
          held === null
            ? null
            : { isTheBuffer: held.content === tab.content, load: held.sessionId === SESSION_ID ? "this" : "an earlier" },
      }).toEqual({
        board: ["mine", "on-disk"],
        pushed: [],
        buffer: true,
        stored: { isTheBuffer: true, load: "this" },
      });
    });

    test("on a live board leaves a peer's delete and a peer's newer copy, and takes the entry's newer copy", async () => {
      const GONE = { id: "gone", type: "rectangle", version: 1, versionNonce: 1, isDeleted: false };
      const THEIRS = { id: "theirs", type: "rectangle", version: 1, versionNonce: 1, isDeleted: false, x: 1 };
      const OURS = { id: "ours", type: "rectangle", version: 3, versionNonce: 1, isDeleted: false, x: 3 };
      strand([ON_DISK, GONE, THEIRS, OURS]);
      const { board, socket } = await attachedDrawing();
      // After the entry's stamp a peer deletes one element and edits two: one
      // past the entry's copy, one short of it.
      socket.frame({
        type: "update",
        version: 2,
        elements: [
          { ...GONE, version: 2, isDeleted: true },
          { ...THEIRS, version: 2, x: 2 },
          { ...OURS, version: 2, x: 2 },
        ],
      });
      await vi.waitFor(() => expect(shownIds(board)).toContain("theirs"));

      await restore();
      await vi.advanceTimersByTimeAsync(400);
      vi.useRealTimers();
      const shown = Object.fromEntries(
        (board.elements as { id: string; version: number; isDeleted?: boolean }[]).map((e) => [e.id, e.isDeleted ? "deleted" : e.version]),
      );

      expect({ shown, pushed: pushed(socket) }).toEqual({
        shown: { "on-disk": 1, gone: "deleted", theirs: 2, ours: 3 },
        pushed: [{ elements: ["ours@3"], appState: undefined }],
      });
    });

    test("on a live board leaves an element the board holds at the entry's version, whichever nonce is lower", async () => {
      // The library's reconcile alone would take the copy with the lower
      // nonce, which no push would then offer.
      const AUTHORITYS = { id: "tie", type: "rectangle", version: 2, versionNonce: 9, isDeleted: false, x: 9 };
      strand([ON_DISK, { ...AUTHORITYS, versionNonce: 1, x: 1 }]);
      const { board, socket } = await attachedDrawing();
      socket.frame({ type: "update", version: 2, elements: [AUTHORITYS] });
      await vi.waitFor(() => expect(shownIds(board)).toContain("tie"));

      await restore();
      await vi.advanceTimersByTimeAsync(400);
      vi.useRealTimers();

      // Nothing of the entry is taken, so it stays stored and offered.
      expect({
        tie: (board.elements as { id: string; x?: number }[]).find((e) => e.id === "tie")?.x,
        pushed: pushed(socket),
        banner: bannerText(),
        stored: stored(),
      }).toEqual({ tie: 9, pushed: [], banner: NOTHING_NEWER, stored: true });
    });

    test("on a live board keeps an entry that differs by its background alone, and says what Restore leaves", async () => {
      // A background picked before the reload that no authority confirmed.
      strand([ON_DISK], { viewBackgroundColor: "#fedcba" });
      const { board, socket } = await attachedDrawing();

      await restore();
      await vi.advanceTimersByTimeAsync(400);
      vi.useRealTimers();

      expect({
        background: board.appState.viewBackgroundColor,
        pushed: pushed(socket),
        banner: bannerText(),
        stored: stored(),
      }).toEqual({ background: "#ffffff", pushed: [], banner: NOTHING_NEWER, stored: true });
    });

    test("on a live board keeps an entry that cannot be read as a drawing, and says so", async () => {
      strandText('{"type":"excalidraw","elements":[');
      const { board, socket } = await attachedDrawing();

      await restore();
      await vi.advanceTimersByTimeAsync(400);
      vi.useRealTimers();

      expect({ board: shownIds(board), pushed: pushed(socket), banner: bannerText(), stored: stored() }).toEqual({
        board: ["on-disk"],
        pushed: [],
        banner: UNREADABLE,
        stored: true,
      });
    });

    test("on a board whose session the server closed for good puts the entry's scene in place of the board's", async () => {
      // The session object stays the tab's after the close and has no
      // authority left. The entry lacks the file's element and holds a
      // background of its own, and Restore takes it whole.
      strand([MINE], { viewBackgroundColor: "#fedcba" });
      // The library's render of the snapshot's appState comes first, or it
      // shows that appState over the entry's.
      const { tab, board, socket } = await attachedDrawing({ shown: true });
      socket.frame({ type: "closed" });
      expect(tab.doc?.state).toBe("off");

      await restore();
      await vi.advanceTimersByTimeAsync(400);
      vi.useRealTimers();

      expect({
        board: shownIds(board),
        background: board.appState.viewBackgroundColor,
        buffer: tab.content.includes('"on-disk"'),
        pushed: pushed(socket),
        banner: bannerText(),
      }).toEqual({ board: ["mine"], background: "#fedcba", buffer: false, pushed: [], banner: null });
    });

    test("on a board whose session stopped on a permanent error puts the entry's scene in place of the board's", async () => {
      // The server refused the attach for good: the session stays the tab's,
      // stops dialing and has no authority left. The entry lacks the file's
      // element and holds a background of its own, and Restore takes it whole.
      strand([MINE], { viewBackgroundColor: "#fedcba" });
      const { tab, board, socket } = await attachedDrawing({ shown: true });
      socket.frame({ type: "error", reason: "attach-failed", message: "refused" });
      expect(tab.doc?.state).toBe("degraded");

      await restore();
      await vi.advanceTimersByTimeAsync(400);
      vi.useRealTimers();

      expect({
        board: shownIds(board),
        background: board.appState.viewBackgroundColor,
        buffer: tab.content.includes('"on-disk"'),
        pushed: pushed(socket),
        banner: bannerText(),
      }).toEqual({ board: ["mine"], background: "#fedcba", buffer: false, pushed: [], banner: null });
    });

    test("on a board whose session's socket answered an error and no snapshot puts the entry's scene in place of the board's", async () => {
      // The server answered the dial with an error and no snapshot, so the
      // board holds the buffer's scene and nothing a peer made. The entry
      // lacks the file's element and holds a background of its own, and
      // Restore takes it whole.
      strand([MINE], { viewBackgroundColor: "#fedcba" });
      const { tab } = await loadedTab(PATH, DRAWING);
      const { board } = await mountBoard(tab);
      board.holdRenders();
      await board.start();
      await vi.waitFor(() => expect(sceneSockets).toHaveLength(1));
      const socket = sceneSockets[0]!;
      socket.open();
      socket.frame({ type: "error", message: "workspace resetting", reason: "no-workspace" });
      await board.render();

      await restore();
      await vi.advanceTimersByTimeAsync(400);
      vi.useRealTimers();

      expect({
        board: shownIds(board),
        background: board.appState.viewBackgroundColor,
        buffer: tab.content.includes('"on-disk"'),
        pushed: pushed(socket),
        banner: bannerText(),
      }).toEqual({ board: ["mine"], background: "#fedcba", buffer: false, pushed: [], banner: null });
    });

    test("on a board whose session has had no frame puts the entry's scene in place of the board's", async () => {
      // The session dials and no authority has answered, so the board holds
      // the buffer's scene and nothing a peer made. The entry lacks the file's
      // element and holds a background of its own, and Restore takes it whole.
      strand([MINE], { viewBackgroundColor: "#fedcba" });
      const { tab } = await loadedTab(PATH, DRAWING);
      const { board } = await mountBoard(tab);
      // The library's render of the seed's appState comes first, or it shows
      // that appState over the entry's.
      board.holdRenders();
      await board.start();
      await vi.waitFor(() => expect(sceneSockets).toHaveLength(1));
      const socket = sceneSockets[0]!;
      socket.open();
      await board.render();

      await restore();
      await vi.advanceTimersByTimeAsync(400);
      vi.useRealTimers();

      expect({
        board: shownIds(board),
        background: board.appState.viewBackgroundColor,
        buffer: tab.content.includes('"on-disk"'),
        pushed: pushed(socket),
        banner: bannerText(),
      }).toEqual({ board: ["mine"], background: "#fedcba", buffer: false, pushed: [], banner: null });
    });

    test("on a board whose session has had no frame, the session's first snapshot is then reconciled over the restored board", async () => {
      // Restore put the entry in the board's place while no authority had
      // answered. Its scene then comes as it does to any board: the file's
      // element, which the entry lacks, is on the board again, the entry's
      // own element is offered, and the authority's background takes the
      // place of the entry's, since a board that had adopted nothing left
      // the session no claim.
      strand([MINE], { viewBackgroundColor: "#fedcba" });
      const { tab } = await loadedTab(PATH, DRAWING);
      const { board } = await mountBoard(tab);
      board.holdRenders();
      await board.start();
      await vi.waitFor(() => expect(sceneSockets).toHaveLength(1));
      const socket = sceneSockets[0]!;
      socket.open();
      await board.render();
      await restore();
      await vi.advanceTimersByTimeAsync(400);
      const restored = { board: shownIds(board), background: board.appState.viewBackgroundColor };

      socket.frame({
        type: "snapshot", path: tab.path, version: 1, elements: [ON_DISK],
        appState: { viewBackgroundColor: "#abcdef" }, files: {},
        dirty: false, mtime_ns: "1000000000", cursors: [],
      });
      await board.render();
      await vi.advanceTimersByTimeAsync(400);
      vi.useRealTimers();

      expect({
        restored,
        state: tab.doc?.state,
        board: shownIds(board),
        background: board.appState.viewBackgroundColor,
        pushed: pushed(socket),
      }).toEqual({
        restored: { board: ["mine"], background: "#fedcba" },
        state: "attached",
        board: ["mine", "on-disk"],
        background: "#abcdef",
        pushed: [{ elements: ["mine@1"], appState: undefined }],
      });
    });

    test("on a board with no live session puts the entry's scene in place of the board's", async () => {
      scene.live = false;
      // The entry lacks the file's element: its user deleted it before the
      // reload, and a board with no authority takes the entry whole.
      strand([MINE]);
      const { tab } = await loadedTab(PATH, DRAWING);
      const { board } = await mountBoard(tab);
      await board.start();

      await restore();
      await vi.advanceTimersByTimeAsync(400);
      vi.useRealTimers();

      expect({ board: shownIds(board), sockets: sceneSockets.length, buffer: tab.content.includes('"on-disk"') }).toEqual({
        board: ["mine"],
        sockets: 0,
        buffer: false,
      });
    });
  });

  describe("a drawing whose file holds one id on two elements", () => {
    const FIRST = { id: "twice", type: "rectangle", version: 1, versionNonce: 1, isDeleted: false, x: 0 };
    const SECOND = { ...FIRST, versionNonce: 2, x: 40 };
    const TWICE = JSON.stringify({ elements: [FIRST, SECOND], appState: {}, files: {} });

    /// Load the tab again from its file, which nothing has written since it
    /// was opened, and let the board's flush after the seed run.
    async function reloadTheSameFile(tab: FileTab, reads: ReturnType<typeof holdReads>) {
      vi.useFakeTimers();
      const loading = reloadTabFromDisk(tab.id);
      await vi.advanceTimersByTimeAsync(0);
      await reads.finish(TWICE);
      await loading;
      await vi.advanceTimersByTimeAsync(400);
      vi.useRealTimers();
    }

    test("two seeds of its buffer put the same ids on the board", async () => {
      scene.live = false;
      const { tab, reads } = await loadedTab("notes/twice.excalidraw", TWICE);
      const { board } = await mountBoard(tab);
      await board.start();
      const first = shownIds(board);
      await reloadTheSameFile(tab, reads);

      expect({ distinct: new Set(first).size, second: shownIds(board) }).toEqual({ distinct: 2, second: first });
    });

    test("a reload pushes no element, and the authority holds as many after it as before", async () => {
      const { tab, reads } = await loadedTab("notes/twice.excalidraw", TWICE);
      const { board } = await mountBoard(tab);
      await board.start();
      await vi.waitFor(() => expect(sceneSockets).toHaveLength(1));
      const socket = sceneSockets[0]!;
      socket.open();
      // The authority keeps the first element of a repeated id, so the board
      // holds one element its snapshot lacks and offers it once.
      socket.frame(snapshotOf(tab, { elements: [FIRST], appState: {} }));
      await vi.waitFor(() => expect(socket.pushes()).toHaveLength(1));
      socket.frame({ type: "push-ok", version: 2 });
      // What the authority holds: its snapshot's element and each one pushed.
      const held = () => new Set([FIRST.id, ...idsPushed(socket).flat()]).size;
      const before = { pushes: socket.pushes().length, held: held() };
      await reloadTheSameFile(tab, reads);

      expect({ before, after: { pushes: socket.pushes().length, held: held() }, board: shownIds(board).length }).toEqual({
        before: { pushes: 1, held: 2 },
        after: { pushes: 1, held: 2 },
        board: 2,
      });
    });
  });
});
