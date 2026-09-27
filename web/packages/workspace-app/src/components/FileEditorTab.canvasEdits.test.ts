// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import FileEditorTab from "./FileEditorTab.svelte";
import { api } from "../api/client";
import { ApiError } from "../api/errors";
import { fileTab, readTab, resetLayout } from "../__tests__/tabs";
import { installEditorDom } from "../__tests__/wysiwyg";
import { installDemoWorkspace, uninstallDemoWorkspace } from "../demo/install";
import { EXCALIDRAW_VERSION, excalidrawBoard, type BoardProps } from "../__tests__/excalidrawLibrary";
import { trackTimers, type TimerTrack } from "../demo/timers";
import { applyLocalTheme, effectiveHybridSurfaceTheme, refreshWorkspace } from "../state/store.svelte";
import {
  closeAllTabs, closeFileTabAfterMove, closeOtherTabsInPane, closePane,
  closeTab, closeTabsInPane, draftCloseState, resolveDraftClose, setMode, reconcileLayout, saveTab,
  clearRecentlyClosedTabsForTest, isDirty, reloadTabFromDisk, reopenClosedTab, scheduleAutosave, setTabReadMode,
  type FileTab, type SerNode,
} from "../state/tabs.svelte";

const { render, unmountRoot, beforeLibrary } = vi.hoisted(() => ({
  render: vi.fn(),
  unmountRoot: vi.fn(),
  beforeLibrary: { run: null as (() => void) | null },
}));
vi.mock("react-dom/client", () => ({ createRoot: () => ({ render, unmount: unmountRoot }) }));
vi.mock("react", () => ({ createElement: (_kind: unknown, props: unknown) => props }));
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
vi.mock("../state/sceneSync.svelte", async (original) => ({
  ...await original<typeof import("../state/sceneSync.svelte")>(),
  isSceneSyncEligible: () => false,
}));
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
  canvasReady = new Promise((resolve) => { render.mockImplementation(resolve); });
  unmountRoot.mockClear();
});

afterEach(async () => {
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
      complete = (content) => resolve({ content } as Awaited<ReturnType<typeof api.readStream>>);
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
  canvasReady = new Promise((resolve) => { render.mockImplementation(resolve); });
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(FileEditorTab, { target, props: { tab, active: true, focused: true } });
  mounted.push(component);
  await canvasReady;
  const lastRender = () => render.mock.calls.at(-1)![0] as BoardProps;
  return { target, component, board: excalidrawBoard(lastRender), lastRender };
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
  return { pane, tab, target, strokeAt: Date.now() - 50 };
}

describe("pending drawing edits", () => {
  test("a mode switch carries the pending stroke into Source", async () => {
    const { tab, target } = await draw();
    setMode(tab, "source");
    await tick();
    expect(tab.content).toContain("last-stroke");
    const view = EditorView.findFromDOM(target.querySelector<HTMLElement>(".cm-content")!);
    expect(view?.state.doc.toString()).toBe(tab.content);
  });

  test.each(["single tab", "workspace tabs", "other tabs", "pane tabs", "pane", "moved tab"])(
    "closing %s saves the pending stroke before removal", async (method) => {
      const { pane, tab } = await draw();
      pane.tabs.push(fileTab({ id: "keep", mode: "source" }));
      if (method === "single tab") await closeTab(pane.id, tab.id);
      else if (method === "workspace tabs") await closeAllTabs();
      else if (method === "other tabs") await closeOtherTabsInPane(pane.id, "keep");
      else if (method === "pane tabs") await closeTabsInPane(pane.id);
      else if (method === "pane") await closePane(pane.id);
      else await closeFileTabAfterMove(pane.id, tab.id);

      expect(disk.get(tab.path)?.content).toContain("last-stroke");
      expect(readTab(tab.id)).toBeUndefined();
    },
  );

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
