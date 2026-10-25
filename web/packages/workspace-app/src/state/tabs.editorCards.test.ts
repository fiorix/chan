// @vitest-environment jsdom
//
// A new editor tab opens its available cards on a wide screen. Saved card
// choices restore only on tabs that offer the card, and a moved tab keeps its
// choices.

import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const caps = vi.hoisted(() => ({ workspace: true }));

vi.mock("./windowCaps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./windowCaps")>()),
  windowCaps: {
    get workspace() {
      return caps.workspace;
    },
    files: true,
    drafts: true,
    terminal: true,
  },
}));

import { sessionWindowId } from "../api/client";
import { installDemoWorkspace, uninstallDemoWorkspace } from "../demo/install";
import { trackTimers, type TimerTrack } from "../demo/timers";
import { __testSetBootstrapHydrated, onWatchEvent, refreshTree, refreshWorkspace } from "./store.svelte";
import { layout, openInActivePane, openInPane, restoreLayout, serializeLayout, setTabStyleToolbarOpen, type FileTab, type LeafNode } from "./tabs.svelte";

const PANE = "editor-cards-pane";
const README = "# Readme\n\nSome text.\n";
const DECK = "---\nchan:\n  kind: slides\n---\n\n# One\n";
const ORIGINAL_WIDTH = window.innerWidth;
let timers: TimerTrack;

function setWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
}

function emptyPane(): void {
  for (const k of Object.keys(layout.nodes)) delete layout.nodes[k];
  layout.nodes[PANE] = { kind: "leaf", id: PANE, tabs: [], activeTabId: null };
  layout.rootId = PANE;
  layout.activePaneId = PANE;
}

function fileNamed(path: string): FileTab {
  const root = layout.nodes[layout.rootId!] as LeafNode;
  const tab = root.tabs.find((t): t is FileTab => t.kind === "file" && t.path === path);
  expect(tab, `${path} has a tab`).toBeDefined();
  return tab!;
}

function readme(): FileTab {
  return fileNamed("README.md");
}

function cards(tab: FileTab): { outline: boolean; details: boolean } {
  return { outline: tab.outlineOpen, details: tab.inspectorOpen };
}

async function settle(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await tick();
    await new Promise((r) => setTimeout(r, 0));
  }
}

beforeEach(async () => {
  timers = trackTimers();
  caps.workspace = true;
  installDemoWorkspace({
    metadata: { workspaceRoot: "demo", label: "demo", generatedAt: 1_700_000_000_000, fileCount: 6, textCount: 6 },
    files: [
      { path: "README.md", kind: "document", size: README.length, mtime: 100, content: README },
      { path: "deck.md", kind: "document", size: DECK.length, mtime: 100, content: DECK },
      { path: "board.excalidraw", kind: "text", size: 2, mtime: 100, content: "{}" },
      { path: "data.json", kind: "text", size: 2, mtime: 100, content: "{}" },
      { path: "data.csv", kind: "text", size: 4, mtime: 100, content: "a,b\n" },
      { path: "app.py", kind: "text", size: 5, mtime: 100, content: "x = 1" },
    ],
  });
  await refreshWorkspace();
  await refreshTree();
  emptyPane();
});

afterEach(async () => {
  setWidth(ORIGINAL_WIDTH);
  await settle(2);
  uninstallDemoWorkspace();
  timers.release();
});

describe("a new editor tab", () => {
  test.each([
    [1280, { outline: true, details: true }],
    [768, { outline: true, details: true }],
    [767, { outline: false, details: false }],
    [390, { outline: false, details: false }],
  ])("opened from the tree, search, the launcher or a link at %ipx", async (width, expected) => {
    setWidth(width);
    await openInActivePane("README.md");
    await settle();
    expect(cards(readme())).toEqual(expected);
  });

  test.each([
    [1280, { outline: true, details: true }],
    [390, { outline: false, details: false }],
  ])("opened by cs open at %ipx", async (width, expected) => {
    setWidth(width);
    // Window commands wait for the boot hydration a mounted app performs.
    __testSetBootstrapHydrated(true);
    onWatchEvent({ type: "window_command", window_id: sessionWindowId(), command: "open_file", path: "README.md" });
    await settle();
    expect(cards(readme())).toEqual(expected);
  });

  test("in a files-capable standalone window opens Outline and Details", async () => {
    setWidth(1280);
    caps.workspace = false;
    await openInActivePane("README.md");
    await settle();
    expect(cards(readme())).toEqual({ outline: true, details: true });
  });

  test.each(["board.excalidraw", "data.json", "data.csv", "app.py"])(
    "%s opens without an Outline at a desktop width",
    async (path) => {
      setWidth(1280);
      await openInActivePane(path);
      await settle();
      expect(cards(fileNamed(path))).toEqual({ outline: false, details: true });
    },
  );

  test("a canvas tab cannot open a style toolbar", async () => {
    await openInActivePane("board.excalidraw");
    const tab = fileNamed("board.excalidraw");
    setTabStyleToolbarOpen(tab, true);
    expect(tab.styleToolbarOpen).toBe(false);
  });

  test.each([
    [1280, { outline: false, details: false }],
    [390, { outline: true, details: true }],
  ])("moved from another window at %ipx keeps the Outline and the Details it had there", async (width, expected) => {
    setWidth(width);
    await openInPane(PANE, "README.md", { inspectorOpen: expected.details, outlineOpen: expected.outline });
    await settle();
    expect(cards(readme())).toEqual(expected);
  });

  test("a slide deck moved from another window with its Outline closed keeps it closed", async () => {
    setWidth(390);
    await openInPane(PANE, "deck.md", { inspectorOpen: false, outlineOpen: false });
    await settle();
    expect(cards(fileNamed("deck.md"))).toEqual({ outline: false, details: false });
  });

  test("a slide deck opened at a phone's width opens its Outline", async () => {
    setWidth(390);
    await openInActivePane("deck.md");
    await settle();
    expect(cards(fileNamed("deck.md"))).toEqual({ outline: true, details: false });
  });
});

describe("a restored editor tab", () => {
  test.each([
    ["saved closed", {}, { outline: false, details: false }],
    ["saved open", { o: 1 as const, ol: 1 as const }, { outline: true, details: true }],
  ])("keeps the cards it was %s, at a desktop width", async (_label, bits, expected) => {
    setWidth(1280);
    await restoreLayout({ k: "l", f: 1, t: [{ p: "README.md", m: "wysiwyg", a: 1, ...bits }] });
    await settle();
    expect(cards(readme())).toEqual(expected);
  });

  test("a tab opened at a desktop width is saved with both cards and restores them", async () => {
    setWidth(1280);
    await openInActivePane("README.md");
    await settle();
    const saved = serializeLayout();
    expect(saved?.k).toBe("l");
    expect(saved && saved.k === "l" ? saved.t[0] : null).toMatchObject({ p: "README.md", o: 1, ol: 1 });
    setWidth(390);
    await restoreLayout(saved!);
    await settle();
    expect(cards(readme())).toEqual({ outline: true, details: true });
  });

  test("a saved open Outline restores closed on an Excalidraw tab", async () => {
    setWidth(1280);
    await restoreLayout({ k: "l", f: 1, t: [{ p: "board.excalidraw", m: "canvas", a: 1, ol: 1 }] });
    await settle();
    expect(cards(fileNamed("board.excalidraw"))).toEqual({ outline: false, details: false });
  });
});
