// @vitest-environment jsdom
//
// Each Hybrid surface's body carries its own light or dark theme, set in
// Settings independently of the app theme, and the pane around it carries
// none. A Pane is mounted over the demo workspace with one tab of a surface
// at a time; the assertions read the data-theme on the body and on the pane.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("./GraphCanvas.svelte", async () =>
  (await import("../__tests__/graphPanel")).canvasProbeModule(),
);
vi.mock("../api/client", async (importOriginal) =>
  (await import("../__tests__/graphPanel")).graphApiModule(
    await importOriginal<typeof import("../api/client")>(),
  ),
);

import Pane from "./Pane.svelte";
// Build-time contract: App.svelte's theme token blocks match any [data-theme] subtree, not only a pane; vitest drops component CSS.
import app from "../App.svelte?raw";
import type { HybridSurfaceKind } from "../api/types";
import { graphTab, installGraphDom, resetGraphServer } from "../__tests__/graphPanel";
import { installEditorDom } from "../__tests__/wysiwyg";
import { installDemoWorkspace, uninstallDemoWorkspace } from "../demo/install";
import { trackTimers, type TimerTrack } from "../demo/timers";
import { hybridSurfaceThemes, refreshTree, refreshWorkspace, ui } from "../state/store.svelte";
import { layout, type LeafNode, type Tab } from "../state/tabs.svelte";

installGraphDom();
installEditorDom();

const PANE = "surface-theme-pane";
const DOC = "# A\n";
const mounted: Array<Record<string, unknown>> = [];
const startTheme = ui.theme;
let timers: TimerTrack;

beforeEach(async () => {
  timers = trackTimers();
  resetGraphServer();
  installDemoWorkspace({
    metadata: { workspaceRoot: "demo", label: "demo", generatedAt: 1_700_000_000_000, fileCount: 1, textCount: 1 },
    files: [{ path: "notes/a.md", kind: "document", size: DOC.length, mtime: 100, content: DOC }],
  });
  await refreshWorkspace();
  await refreshTree();
  ui.theme = "light";
});

afterEach(async () => {
  for (const app of mounted.splice(0)) unmount(app);
  document.body.innerHTML = "";
  for (const kind of Object.keys(hybridSurfaceThemes) as HybridSurfaceKind[]) delete hybridSurfaceThemes[kind];
  ui.theme = startTheme;
  await settle(2);
  uninstallDemoWorkspace();
  timers.release();
});

async function settle(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await tick();
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function renderPane(tab: Tab): Promise<HTMLElement> {
  layout.nodes = { [PANE]: { kind: "leaf", id: PANE, tabs: [tab], activeTabId: tab.id } };
  layout.rootId = PANE;
  layout.activePaneId = PANE;
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(Pane, { target, props: { pane: layout.nodes[PANE] as LeafNode } }));
  await settle();
  return target;
}

const SURFACES: Array<[HybridSurfaceKind, string, () => Tab]> = [
  [
    "editor",
    ".editor-tab",
    () => ({
      kind: "file",
      fileKind: "document",
      id: "file-1",
      path: "notes/a.md",
      content: DOC,
      saved: DOC,
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
    }),
  ],
  ["browser", ".browser", () => ({ kind: "browser", id: "fb-1", title: "Files", inspectorOpen: false })],
  ["graph", ".graph-tab", () => graphTab()],
  ["dashboard", ".dashboard", () => ({ kind: "dashboard", id: "dash-1", title: "Dashboard" })],
];

describe("a surface's body theme", () => {
  for (const [kind, body, tab] of SURFACES) {
    test(`the ${kind} body carries its own theme, and the pane carries none`, async () => {
      hybridSurfaceThemes[kind] = "dark";
      const target = await renderPane(tab());
      const el = target.querySelector<HTMLElement>(body);
      expect(el, `${kind} body rendered`).not.toBeNull();
      expect(el!.dataset.theme).toBe("dark");
      expect(target.querySelector(".pane")!.hasAttribute("data-theme")).toBe(false);

      delete hybridSurfaceThemes[kind];
      await settle(2);
      expect(el!.hasAttribute("data-theme"), "inherits the app theme again").toBe(false);
    });
  }

  test("an override for one surface leaves the others inheriting", async () => {
    hybridSurfaceThemes.terminal = "dark";
    const target = await renderPane(SURFACES[0]![2]());
    expect(target.querySelector(".editor-tab")!.hasAttribute("data-theme")).toBe(false);
  });

  test("the pane renders no per-surface configuration section", async () => {
    const target = await renderPane(SURFACES[0]![2]());
    expect(target.querySelector(".hybrid-config")).toBeNull();
  });
});

describe("the theme token blocks", () => {
  test("apply to any themed subtree, not only a pane", () => {
    expect(app).toContain(':global([data-theme="dark"])');
    expect(app).toContain(':global([data-theme="light"])');
    expect(app).not.toContain(':global(.pane[data-theme="dark"])');
    expect(app).not.toContain(':global(.pane[data-theme="light"])');
  });
});
