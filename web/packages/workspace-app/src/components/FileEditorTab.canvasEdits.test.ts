// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import FileEditorTab from "./FileEditorTab.svelte";
import { api } from "../api/client";
import { fileTab, readTab, resetLayout } from "../__tests__/tabs";
import { installEditorDom } from "../__tests__/wysiwyg";
import { installDemoWorkspace, uninstallDemoWorkspace } from "../demo/install";
import { trackTimers, type TimerTrack } from "../demo/timers";
import { refreshWorkspace } from "../state/store.svelte";
import {
  closeAllTabs, closeFileTabAfterMove, closeOtherTabsInPane, closePane,
  closeTab, closeTabsInPane, draftCloseState, resolveDraftClose, setMode,
  type FileTab,
} from "../state/tabs.svelte";

const { render, unmountRoot } = vi.hoisted(() => ({ render: vi.fn(), unmountRoot: vi.fn() }));
vi.mock("react-dom/client", () => ({ createRoot: () => ({ render, unmount: unmountRoot }) }));
vi.mock("react", () => ({ createElement: (_kind: unknown, props: unknown) => props }));
vi.mock("@excalidraw/excalidraw", () => ({
  Excalidraw: () => null,
  serializeAsJSON: (elements: unknown) => JSON.stringify({ elements, appState: {}, files: {} }),
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
  uninstallDemoWorkspace();
  timers.release();
  vi.restoreAllMocks();
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
});
