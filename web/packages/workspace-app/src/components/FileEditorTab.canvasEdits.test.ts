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
import { EXCALIDRAW_VERSION } from "../__tests__/excalidrawLibrary";
import { trackTimers, type TimerTrack } from "../demo/timers";
import { refreshWorkspace } from "../state/store.svelte";
import {
  closeAllTabs, closeFileTabAfterMove, closeOtherTabsInPane, closePane,
  closeTab, closeTabsInPane, draftCloseState, resolveDraftClose, setMode, reconcileLayout, saveTab,
  clearRecentlyClosedTabsForTest, isDirty, reloadTabFromDisk, reopenClosedTab, scheduleAutosave,
  type FileTab, type SerNode,
} from "../state/tabs.svelte";

const { render, unmountRoot } = vi.hoisted(() => ({ render: vi.fn(), unmountRoot: vi.fn() }));
vi.mock("react-dom/client", () => ({ createRoot: () => ({ render, unmount: unmountRoot }) }));
vi.mock("react", () => ({ createElement: (_kind: unknown, props: unknown) => props }));
vi.mock("@excalidraw/excalidraw", () => ({
  Excalidraw: () => null,
  serializeAsJSON: (elements: unknown) => JSON.stringify({ elements, appState: {}, files: {} }),
  CaptureUpdateAction: { IMMEDIATELY: "IMMEDIATELY", EVENTUALLY: "EVENTUALLY", NEVER: "NEVER" },
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
type CanvasProps = { excalidrawAPI: (value: unknown) => void; onChange: () => void };
let canvasReady: Promise<CanvasProps>;

beforeEach(async () => {
  timers = trackTimers();
  disk = installDemoWorkspace({
    metadata: { workspaceRoot: "demo", label: "demo", generatedAt: 1, fileCount: 0, textCount: 0 },
    files: [],
  });
  await refreshWorkspace();
  render.mockReset();
  canvasReady = new Promise((resolve) => { render.mockImplementation(resolve); });
  unmountRoot.mockClear();
});

afterEach(async () => {
  resolveDraftClose("cancel");
  for (const component of mounted.splice(0)) await unmount(component);
  vi.useRealTimers();
  document.body.innerHTML = "";
  resetLayout();
  clearRecentlyClosedTabsForTest();
  uninstallDemoWorkspace();
  timers.release();
  vi.restoreAllMocks();
});

const PARTIAL = '{"type":"excalidraw","elements":[';
const DRAWING = JSON.stringify({ elements: [{ id: "on-disk", version: 1 }], appState: {}, files: {} });

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

  test("closing during a mounted canvas load and reopening writes no placeholder", async () => {
    const { pane, tab, component, loading, write, chunk } = await mountDuringLoad();
    await chunk();
    vi.advanceTimersByTime(50);
    await closeTab(pane.id, tab.id);
    await loading;
    await unmount(component);
    mounted.splice(mounted.indexOf(component), 1);
    expect(readTab(tab.id)).toBeUndefined();
    expect(reopenClosedTab()).toBe(true);
    const reopened = readTab(tab.id)!;
    const dirty = isDirty(reopened);
    scheduleAutosave(pane.id, reopened.id);
    await vi.advanceTimersByTimeAsync(800);

    expect({ dirty, writes: write.mock.calls, content: disk.get(tab.path)?.content }).toEqual({
      dirty: true, writes: [], content: DRAWING,
    });
    expect(reopened.content).toBe(PARTIAL);
    expect(reopened.error).toContain("JSON parse error");
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
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(FileEditorTab, { target, props: { tab, active: true, focused: true } }));
  const props = await canvasReady;
  let elements: unknown[] = [];
  props.excalidrawAPI({ getSceneElements: () => elements, getAppState: () => ({}), getFiles: () => ({}) });
  await tick();
  vi.useFakeTimers();
  elements = [{ id: "last-stroke", version: 1 }];
  props.onChange();
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
