// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import FileEditorTab from "./FileEditorTab.svelte";
import { api } from "../api/client";
import { setSocketFactory } from "../api/transport";
import { demoSocketFactory } from "../demo/socket";
import { resetSceneSyncForTests } from "../state/sceneSync.svelte";
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
  layout, setTabContent, type FileTab, type SerNode,
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
    // The sibling's pane comes first in the layout, so a close of every tab
    // saves it before it reaches the shown board.
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
    await closeAllTabs();
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
  });

  /// A drawing on its board, attached to a session whose snapshot holds the
  /// file as it is.
  async function attachedDrawing() {
    const { pane, tab, reads } = await loadedTab("notes/live.excalidraw", DRAWING);
    const { board } = await mountBoard(tab);
    await board.start();
    await vi.waitFor(() => expect(sceneSockets).toHaveLength(1));
    const socket = sceneSockets[0]!;
    socket.open();
    socket.frame({
      type: "snapshot", path: tab.path, version: 1, elements: [ON_DISK], appState: {}, files: {},
      dirty: false, mtime_ns: "1000000000", cursors: [],
    });
    expect(tab.doc?.state).toBe("attached");
    return { pane, tab, board, socket, reads };
  }

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
    // flush writes the stroke into the buffer.
    const saving = saveTab(tab);
    await vi.waitFor(() => expect(socket.pushes()).toHaveLength(1));
    socket.frame({ type: "push-ok", version: 2 });
    await saving;
    await vi.waitFor(() => expect(tab.content).toContain('"stroke"'));

    expect(isDirty(tab)).toBe(false);
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

  test("a background this window picked stays on its board through a remount within the session's linger", async () => {
    const PICKED = "#123456";
    const { tab, board, socket } = await attachedDrawing();
    // The library's render of the snapshot's appState comes first, or it
    // shows that appState over the pick.
    await new Promise((resolve) => setTimeout(resolve, 10));
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

  test.each([
    ["refused while the socket is down", true],
    ["on the wire when the socket drops", false],
  ])("a background %s gives way to the reattach's snapshot and is not offered again", async (_when, refused) => {
    const PICKED = "#123456";
    const { tab, board, socket } = await attachedDrawing();
    // The library's render of the snapshot's appState comes first.
    await new Promise((resolve) => setTimeout(resolve, 10));
    vi.useFakeTimers();
    if (refused) socket.drop();
    board.pickBackground(PICKED);
    await vi.advanceTimersByTimeAsync(250);
    const beforeDrop = backgroundsPushed(socket);
    if (!refused) socket.drop();
    const next = await nextSocket();
    next.frame(snapshotOf(tab, { elements: [ON_DISK], appState: {} }));
    await vi.advanceTimersByTimeAsync(400);
    vi.useRealTimers();

    expect({
      beforeDrop,
      background: board.appState.viewBackgroundColor,
      buffer: tab.content.includes(PICKED),
      pushed: backgroundsPushed(next),
      dirty: isDirty(tab),
      state: tab.doc?.state,
    }).toEqual({
      beforeDrop: refused ? [] : [PICKED],
      background: "#ffffff",
      buffer: false,
      pushed: [],
      dirty: false,
      state: "attached",
    });
  });
});
