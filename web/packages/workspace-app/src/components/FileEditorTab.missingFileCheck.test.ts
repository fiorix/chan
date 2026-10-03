// @vitest-environment jsdom
//
// The watcher's missing-file check reloads a tab whose buffer is clean. A
// board writes a stroke into its tab's buffer only once its wait has run out,
// so the check commits the tab's waiting input before it reads the buffer.

import { mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import FileEditorTab from "./FileEditorTab.svelte";
import { api } from "../api/client";
import { fileTab, readTab, resetLayout } from "../__tests__/tabs";
import { installEditorDom } from "../__tests__/wysiwyg";
import { installDemoWorkspace, uninstallDemoWorkspace } from "../demo/install";
import { excalidrawBoard } from "../__tests__/excalidrawLibrary";
import { trackTimers, type TimerTrack } from "../demo/timers";
import { refreshWorkspace } from "../state/store.svelte";
import { clearRecentlyClosedTabsForTest, isDirty, scheduleMissingFileCheck } from "../state/tabs.svelte";

const { render } = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock("react-dom/client", () => ({ createRoot: () => ({ render, unmount: () => {} }) }));
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
vi.mock("../editor/excalidrawAssets", () => ({ configureExcalidrawAssets: () => {} }));
// The check is the classic path's: a live session's `removed` frame stands in
// for it on an attached tab.
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
const PATH = "notes/board.excalidraw";
const mounted: ReturnType<typeof mount>[] = [];
let timers: TimerTrack;
let disk: ReturnType<typeof installDemoWorkspace>;

beforeEach(async () => {
  timers = trackTimers();
  disk = installDemoWorkspace({
    metadata: { workspaceRoot: "demo", label: "demo", generatedAt: 1, fileCount: 0, textCount: 0 },
    files: [],
  });
  await refreshWorkspace();
  render.mockReset();
});

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  vi.useRealTimers();
  document.body.innerHTML = "";
  resetLayout();
  clearRecentlyClosedTabsForTest();
  uninstallDemoWorkspace();
  timers.release();
  vi.restoreAllMocks();
});

/// A drawing on its board with a stroke drawn 10 ms ago, inside the board's
/// 200 ms wait, so the stroke is on the board and not in the tab's buffer.
async function draw() {
  const initial = fileTab({ path: PATH, fileKind: "text", mode: "canvas", content: INITIAL, saved: INITIAL });
  initial.savedMtime = disk.write(PATH, INITIAL).mtime;
  resetLayout([initial]);
  const tab = readTab(initial.id)!;
  const rendered = new Promise<void>((resolve) => {
    render.mockImplementation(() => resolve());
  });
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(FileEditorTab, { target, props: { tab, active: true, focused: true } }));
  await rendered;
  const board = excalidrawBoard(() => render.mock.calls.at(-1)![0] as unknown);
  vi.useFakeTimers();
  await board.start();
  board.stroke({ id: "last-stroke", version: 1 });
  vi.advanceTimersByTime(10);
  expect(tab.content).toBe(tab.saved);
  return { tab, board, strokeAt: Date.now() - 10 };
}

describe("the watcher's missing-file check on a drawing", () => {
  test("a stroke waiting when the check runs is in the buffer after it, and nothing is loaded over it", async () => {
    const { tab, board, strokeAt } = await draw();
    const loads = vi.spyOn(api, "readStream");

    // The file is still there, as after a writer that replaces it by a rename.
    scheduleMissingFileCheck(tab.id, tab.path);
    await vi.advanceTimersByTimeAsync(150);
    for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0);

    expect(Date.now() - strokeAt).toBeLessThan(200);
    expect({ stroke: tab.content.includes("last-stroke"), dirty: isDirty(tab) }).toEqual({ stroke: true, dirty: true });
    expect({ loads: loads.mock.calls.length, missing: tab.fileMissing, onBoard: board.elements }).toEqual({
      loads: 0,
      missing: null,
      onBoard: [{ id: "last-stroke", version: 1 }],
    });
  });
});
