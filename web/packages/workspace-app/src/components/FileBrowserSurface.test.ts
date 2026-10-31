// @vitest-environment jsdom
//
// FileBrowserSurface, mounted over the in-memory demo workspace. The surface's
// own menu (the hamburger, opened by the tab strip or dock body) and the
// tree's row menu it hosts are driven here the way a
// user reaches them; Pane is mounted for the one hop it owns, the Flip.

import { mount, tick, unmount, type ComponentProps } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const caps = vi.hoisted(() => ({ workspace: true }));

vi.mock("../state/windowCaps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/windowCaps")>()),
  windowCaps: {
    get workspace() {
      return caps.workspace;
    },
    files: true,
    drafts: true,
    terminal: true,
  },
}));

import { setBrowserVim } from "../state/browserKeys.svelte";
import { api } from "../api/client";
import FileBrowserSurface from "./FileBrowserSurface.svelte";
import Pane from "./Pane.svelte";
import { installDemoWorkspace, uninstallDemoWorkspace } from "../demo/install";
import { trackTimers, type TimerTrack } from "../demo/timers";
import { chordFor } from "../state/shortcuts";
import {
  browserSelection,
  fbTreeInstance,
  fileOps,
  fbClipboard,
  fbClipboardClear,
  browserSidePanes,
  pathPromptState,
  refreshTree,
  resolvePathPrompt,
  refreshWorkspace,
} from "../state/store.svelte";
import { closeTabMenu, openTabMenu } from "../state/tabMenu.svelte";
import { layout, paneSide, type BrowserTab, type LeafNode } from "../state/tabs.svelte";

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
// A selected row scrolls itself into view; jsdom has no layout to scroll.
Element.prototype.scrollIntoView = () => {};
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false;
    },
  }),
});

const PANE = "fb-surface-pane";
const mounted: Array<Record<string, unknown>> = [];
let timers: TimerTrack;

function browserTab(over: Partial<BrowserTab> = {}): BrowserTab {
  return { kind: "browser", id: "fb-1", title: "Files", inspectorOpen: false, ...over };
}

/// Seats the tab in a one-pane layout and returns the live (proxied) copy.
function seat(tab: BrowserTab): BrowserTab {
  layout.nodes = { [PANE]: { kind: "leaf", id: PANE, tabs: [tab], activeTabId: tab.id } };
  layout.rootId = PANE;
  layout.activePaneId = PANE;
  return (layout.nodes[PANE] as LeafNode).tabs[0] as BrowserTab;
}

async function settle(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await tick();
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function render(props: ComponentProps<typeof FileBrowserSurface>): Promise<HTMLElement> {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(FileBrowserSurface, { target, props }));
  await settle();
  return target;
}

function menu(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(".hamburger-menu");
}

/// The menu's rows in order: a separator, or the row's visible text.
function menuRows(): string[] {
  const list = menu();
  if (!list) return [];
  return [...list.children].map((li) =>
    li.getAttribute("role") === "separator" ? "---" : (li.textContent ?? "").replace(/\s+/g, " ").trim(),
  );
}

function menuButton(label: string): HTMLButtonElement {
  const button = [...(menu()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) =>
    (b.textContent ?? "").includes(label),
  );
  if (!button) throw new Error(`no menu row ${label}`);
  return button;
}

async function openFromTabStrip(tab: BrowserTab): Promise<void> {
  openTabMenu(tab.id, { left: 40, top: 30, right: 40, bottom: 30 });
  await settle();
}

beforeEach(async () => {
  timers = trackTimers();
  setBrowserVim(false);
  fbClipboardClear();
  installDemoWorkspace({
    metadata: {
      workspaceRoot: "demo",
      label: "demo",
      generatedAt: 1_700_000_000_000,
      fileCount: 2,
      textCount: 2,
    },
    files: [
      { path: "notes/a.md", kind: "document", size: 5, mtime: 100, content: "hello" },
      { path: "README.md", kind: "document", size: 5, mtime: 100, content: "hi" },
    ],
  });
  await refreshWorkspace();
  await refreshTree();
  browserSelection.path = null;
  browserSelection.showWorkspace = false;
  browserSidePanes.left = false;
  browserSidePanes.right = false;
});

afterEach(async () => {
  vi.restoreAllMocks();
  caps.workspace = true;
  closeTabMenu();
  if (pathPromptState.open) resolvePathPrompt(null);
  for (const app of mounted.splice(0)) unmount(app);
  document.body.innerHTML = "";
  await settle(2);
  uninstallDemoWorkspace();
  timers.release();
});

describe("the tab variant", () => {
  test("has a toolbar menu; the tab strip's right-click also opens it", async () => {
    const tab = seat(browserTab());
    const target = await render({ variant: "tab", tab });

    expect(target.querySelector("header")).toBeNull();
    expect(document.body.querySelector(".hamburger-trigger")).not.toBeNull();
    expect(menu()).toBeNull();

    await openFromTabStrip(tab);
    expect(menu()).not.toBeNull();
  });

  test("the menu exposes creation, selection, keymap, workspace and docking actions", async () => {
    const tab = seat(browserTab());
    await render({ variant: "tab", tab });
    await openFromTabStrip(tab);
    expect(menuRows()).toEqual([
      "New file or directory", "Upload files", "Selection actions Shift+F10", "Select multiple F8", "---",
      "Show hidden files", "Vim keyboard navigation", "Keyboard shortcuts", "---", "Workspace details",
      "Stick to left", "Stick to right", `Close ${chordFor("app.tab.close") ?? ""}`.trim(),
    ]);
  });

  test("Close closes the menu and hands the close to the host", async () => {
    const tab = seat(browserTab());
    const onClose = vi.fn();
    await render({ variant: "tab", tab, onClose });
    await openFromTabStrip(tab);

    menuButton("Close").click();
    await settle();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
  });

  test("the stick toggles dock the browser to a side and read back as unstick", async () => {
    const tab = seat(browserTab());
    await render({ variant: "tab", tab });

    await openFromTabStrip(tab);
    menuButton("Stick to left").click();
    await settle();
    expect(browserSidePanes.left).toBe(true);
    expect(menu(), "the toggle closes the menu").toBeNull();

    closeTabMenu();
    await openFromTabStrip(tab);
    expect(menuRows()).toContain("Unstick left");
    menuButton("Stick to right").click();
    await settle();
    expect(browserSidePanes.right).toBe(true);
  });

  test("the workspace path row shows the workspace in the inspector", async () => {
    const tab = seat(browserTab());
    const target = await render({ variant: "tab", tab });
    browserSelection.path = "notes/a.md";
    await openFromTabStrip(tab);

    menuButton("Workspace details").click();
    await settle();
    expect(browserSelection.path).toBeNull();
    expect(browserSelection.showWorkspace).toBe(true);
    expect(tab.inspectorOpen).toBe(true);
    expect(target.querySelector(".inspector"), "the inspector opened").not.toBeNull();
    expect(menu()).toBeNull();
  });

  test("the tree's row menu flips the pane through the host", async () => {
    const tab = seat(browserTab());
    const onFlip = vi.fn();
    const target = await render({ variant: "tab", tab, onFlip });

    const row = [...target.querySelectorAll<HTMLElement>("[role='treeitem'], [role='option']")].find((el) =>
      el.textContent?.includes("README.md"),
    );
    expect(row, "the tree listed the workspace").toBeDefined();
    row!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }));
    await settle();
    const flip = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.querySelector(".menu-row-label")?.textContent === "Flip",
    );
    expect(flip).toBeDefined();
    flip!.click();
    expect(onFlip).toHaveBeenCalledTimes(1);
  });
});

describe("clicking a row", () => {
  function clickRow(target: HTMLElement, name: string): void {
    const row = [...target.querySelectorAll<HTMLElement>("[role='treeitem'], [role='option']")].find(
      (el) => el.querySelector(".name")?.textContent?.trim() === name,
    );
    row!.querySelector<HTMLElement>(".name")!.click();
  }

  test("keeps details closed until explicitly opened", async () => {
    const tab = seat(browserTab());
    const target = await render({ variant: "tab", tab });
    expect(target.querySelector(".inspector")).toBeNull();
    clickRow(target, "README.md");
    await settle();
    expect(tab.inspectorOpen).toBe(false);
    expect(target.querySelector(".inspector")).toBeNull();
    target.querySelector<HTMLButtonElement>('[aria-label="Toggle details"]')!.click();
    await settle();
    expect(tab.inspectorOpen).toBe(true);
    expect(target.querySelector(".inspector")).not.toBeNull();
  });
});

describe("graphs from the browser", () => {
  async function workspaceInspector(): Promise<HTMLElement> {
    const tab = seat(browserTab());
    const target = await render({ variant: "tab", tab });
    await openFromTabStrip(tab);
    menuButton("Workspace details").click();
    await settle();
    return target;
  }

  async function inspectorActions(target: HTMLElement): Promise<string[]> {
    const caret = target.querySelector<HTMLButtonElement>(".inspector .pill-caret");
    caret?.click();
    await settle(2);
    return [...target.querySelectorAll(".inspector .action-menu-item")].map((b) => b.textContent?.trim() ?? "");
  }

  test("the workspace's Graph from here opens the workspace graph in a new tab", async () => {
    const target = await workspaceInspector();
    expect(await inspectorActions(target)).toContain("Graph from here");
    [...target.querySelectorAll<HTMLButtonElement>(".inspector .action-menu-item")]
      .find((b) => b.textContent?.trim() === "Graph from here")!
      .click();
    await settle();
    const graph = (layout.nodes[PANE] as LeafNode).tabs.find((t) => t.kind === "graph");
    expect(graph).toMatchObject({ mode: "semantic", scopeId: "workspace" });
  });

  test("a window without a workspace offers no graph from the inspector or the tree", async () => {
    caps.workspace = false;
    const target = await workspaceInspector();
    expect(await inspectorActions(target)).not.toContain("Graph from here");

    const row = [...target.querySelectorAll<HTMLElement>("[role='treeitem'], [role='option']")].find(
      (el) => el.querySelector(".name")?.textContent?.trim() === "notes",
    );
    row!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }));
    await settle();
    const labels = [...document.body.querySelectorAll(".ctx .menu-row-label")].map((el) => el.textContent);
    expect(labels).toContain("Delete");
    expect(labels).not.toContain("New Graph");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    const readme = [...target.querySelectorAll<HTMLElement>("[role='treeitem'], [role='option']")].find(
      (el) => el.querySelector(".name")?.textContent?.trim() === "README.md",
    );
    readme!.querySelector<HTMLElement>(".name")!.click();
    await settle();
    const fileActions = await inspectorActions(target);
    expect(fileActions).toContain("Download file");
    expect(fileActions).not.toContain("Graph from here");
  });
});

describe("the tree's row menu", () => {
  async function rowMenu(target: HTMLElement, name: string): Promise<string[]> {
    const row = [...target.querySelectorAll<HTMLElement>("[role='treeitem'], [role='option']")].find(
      (el) => el.querySelector(".name")?.textContent?.trim() === name,
    );
    expect(row, `the tree listed ${name}`).toBeDefined();
    row!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }));
    await settle();
    return [...document.body.querySelectorAll(".ctx > button, .ctx > .ctx-sep")].map((el) =>
      el.classList.contains("ctx-sep")
        ? "---"
        : (el.querySelector(".menu-row-label") ?? el).textContent!.replace(/\s+/g, " ").trim(),
    );
  }

  test("a directory row offers one New File or Directory entry, which opens the file-or-directory prompt there", async () => {
    const tab = seat(browserTab());
    const target = await render({ variant: "tab", tab, onFlip: vi.fn() });
    const rows = await rowMenu(target, "notes");
    expect(rows.filter((r) => /^New (File|Directory)/.test(r)), "no separate New File or New Directory").toEqual([
      "New File or Directory",
    ]);

    const entry = [...document.body.querySelectorAll<HTMLButtonElement>(".ctx > button")].find(
      (b) => b.textContent?.trim() === "New File or Directory",
    );
    entry!.click();
    await settle();
    expect(pathPromptState.open).toBe(true);
    expect(pathPromptState.kind).toBe("either");
    expect(pathPromptState.defaultValue).toBe("notes/");
    expect(document.body.querySelector(".ctx"), "the menu closed").toBeNull();
  });

  test("a file row has no create entry, and Flip is the last row after a separator", async () => {
    const tab = seat(browserTab());
    const target = await render({ variant: "tab", tab, onFlip: vi.fn() });
    const rows = await rowMenu(target, "README.md");
    expect(document.body.querySelector(".ctx")!.parentElement, "portaled to the page body").toBe(document.body);
    expect(rows.some((r) => /^New (File|Directory)/.test(r))).toBe(false);
    expect(rows.slice(-2)).toEqual(["---", "Flip"]);
  });
});

describe("the dock variant", () => {
  test("has no header; a right-click on its body opens the menu at the cursor", async () => {
    const target = await render({ variant: "dock", side: "left" });
    expect(target.querySelector("header")).toBeNull();
    expect(document.body.querySelector(".hamburger-trigger")).not.toBeNull();

    target
      .querySelector(".browser")!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 80 }));
    await settle();
    expect(menu()).not.toBeNull();
    expect(menu()!.parentElement, "portaled to the page body").toBe(document.body);
    expect(menu()!.style.left).toBe("120px");
    expect(menu()!.style.top).toBe("80px");
  });

  test("offers Open in File Browser before the stick toggles, and no Close", async () => {
    const target = await render({ variant: "dock", side: "left" });
    target.querySelector(".browser")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await settle();

    const rows = menuRows();
    expect(rows.slice(-4)).toEqual(["Open in File Browser", "Workspace details", "Stick to left", "Stick to right"]);
    expect(rows.some((row) => row.startsWith("Close"))).toBe(false);
  });

  test("Open in File Browser opens a tab in the selection's directory", async () => {
    seat(browserTab({ id: "existing" }));
    const target = await render({ variant: "dock", side: "left" });
    target.querySelector<HTMLElement>('[role="tree"]')!.focus();
    browserSelection.path = "notes/a.md";
    target.querySelector(".browser")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await settle();

    menuButton("Open in File Browser").click();
    await settle();
    const tabs = (layout.nodes[layout.activePaneId] as LeafNode).tabs;
    const opened = tabs.find((t) => t.kind === "browser" && t.id !== "existing") as BrowserTab;
    expect(opened).toBeDefined();
    expect(opened.inspectorOpen).toBe(true);
    expect(opened.directory).toBe("notes");
    expect(opened.showWorkspace).toBeFalsy();
    expect(browserSelection.path).toBe("notes/a.md");
  });

  test("the workspace path row opens a tab on the workspace", async () => {
    seat(browserTab({ id: "existing" }));
    const target = await render({ variant: "dock", side: "right" });
    target.querySelector(".browser")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await settle();

    menuButton("Workspace details").click();
    await settle();
    const tabs = (layout.nodes[layout.activePaneId] as LeafNode).tabs;
    const opened = tabs.find((t) => t.kind === "browser" && t.id !== "existing") as BrowserTab;
    expect(opened?.showWorkspace).toBe(true);
    expect(opened?.inspectorOpen).toBe(true);
    expect(browserSelection.showWorkspace).toBe(true);
  });

  test("the tree's row menu carries no Flip", async () => {
    const target = await render({ variant: "dock", side: "left" });
    const row = [...target.querySelectorAll<HTMLElement>("[role='treeitem'], [role='option']")].find((el) =>
      el.textContent?.includes("README.md"),
    );
    row!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }));
    await settle();
    const labels = [...document.body.querySelectorAll(".menu-row-label")].map((el) => el.textContent);
    expect(labels).toContain("Delete");
    expect(labels).not.toContain("Flip");
  });
});

describe("a Files tab inside a pane", () => {
  test("the row menu's Flip flips the pane", async () => {
    seat(browserTab());
    const live = layout.nodes[PANE] as LeafNode;
    const before = paneSide(live);
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(Pane, { target, props: { pane: live } }));
    await settle();

    const row = [...target.querySelectorAll<HTMLElement>("[role='treeitem'], [role='option']")].find((el) =>
      el.textContent?.includes("README.md"),
    );
    expect(row, "the pane's browser listed the workspace").toBeDefined();
    row!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }));
    await settle();
    const flip = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.querySelector(".menu-row-label")?.textContent === "Flip",
    );
    flip!.click();
    await settle();
    expect(paneSide(layout.nodes[PANE] as LeafNode)).not.toBe(before);
  });
});

describe("directory navigation and keyboard interaction", () => {
  function list(target: HTMLElement): HTMLElement { return target.querySelector<HTMLElement>('[role="listbox"]')!; }
  function names(target: HTMLElement): string[] { return [...target.querySelectorAll('[role="option"] .name')].map((el) => el.textContent!.trim()); }
  async function key(target: HTMLElement, key: string, modifiers: KeyboardEventInit = {}): Promise<KeyboardEvent> {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers });
    target.dispatchEvent(event);
    await settle();
    return event;
  }

  test("arrows, ranges, independent marks, select all, and accessible focus share the displayed order", async () => {
    const tab = seat(browserTab());
    const target = await render({ variant: "tab", tab });
    const widget = list(target);
    widget.focus();
    await key(widget, "Home");
    expect(tab.selected).toBe("notes");
    await key(widget, "ArrowDown", { shiftKey: true });
    expect(tab.selectedPaths).toEqual(["notes", "README.md"]);
    expect(target.querySelectorAll('[aria-selected="true"]')).toHaveLength(2);
    const cursor = document.getElementById(widget.getAttribute("aria-activedescendant")!);
    expect(cursor?.textContent).toContain("README.md");
    expect(document.activeElement).toBe(widget);
    expect(target.querySelectorAll('[role="option"] button:not([tabindex="-1"])')).toHaveLength(0);
    await key(widget, "F8");
    await key(widget, "ArrowUp");
    expect(tab.selectedPaths).toEqual(["notes", "README.md"]);
    await key(widget, " ");
    expect(tab.selectedPaths).toEqual(["README.md"]);
    expect(tab.selected).toBe("notes");
    await key(widget, "a", { ctrlKey: true });
    expect(tab.selectedPaths).toEqual(["notes", "README.md"]);
    expect((await key(widget, "Tab")).defaultPrevented).toBe(false);
  });

  test("keyboard menus move focus, dismiss back to the list, and rename the focused file", async () => {
    const target = await render({ variant: "tab", tab: seat(browserTab()) });
    const widget = list(target);
    await key(widget, "End");
    await key(widget, "F10", { shiftKey: true });
    const actions = document.querySelector<HTMLElement>('.ctx')!;
    expect(actions.contains(document.activeElement)).toBe(true);
    const first = document.activeElement;
    await key(actions, "ArrowDown");
    expect(document.activeElement).not.toBe(first);
    await key(actions, "Escape");
    expect(document.querySelector('.ctx')).toBeNull();
    expect(document.activeElement).toBe(widget);
    await key(widget, "F2");
    expect(pathPromptState.open).toBe(true);
    expect(pathPromptState.defaultValue).toBe("README.md");
  });

  test("Enter navigates folders, Back restores selection, and filtering keeps focus in its input", async () => {
    const tab = seat(browserTab());
    const target = await render({ variant: "tab", tab });
    const widget = list(target);
    await key(widget, "Home");
    await key(widget, "Enter");
    expect(tab.directory).toBe("notes");
    expect(names(target)).toEqual(["a.md"]);
    expect(target.querySelector('[aria-current="location"]')?.textContent).toBe("notes");
    target.querySelector<HTMLButtonElement>('[aria-label="Back"]')!.click();
    await settle();
    expect(tab.directory).toBe("");
    expect(tab.selected).toBe("notes");
    await key(widget, "/");
    const input = target.querySelector<HTMLInputElement>('[aria-label="Filter this folder"]')!;
    expect(document.activeElement).toBe(input);
    input.value = "read";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect(names(target)).toEqual(["README.md"]);
    expect(document.activeElement).toBe(input);
    await key(input, "Escape");
    expect(names(target)).toEqual(["notes", "README.md"]);
    expect(document.activeElement).toBe(widget);
  });

  test("optional Vim is scoped to the widget and resets its prefix on focus loss", async () => {
    const tab = seat(browserTab());
    const target = await render({ variant: "tab", tab });
    const widget = list(target);
    setBrowserVim(true);
    await key(widget, "G");
    expect(tab.selected).toBe("README.md");
    await key(widget, "g");
    const input = target.querySelector<HTMLInputElement>('[aria-label="Filter this folder"]')!;
    input.focus();
    expect((await key(input, "j")).defaultPrevented).toBe(false);
    expect(tab.selected).toBe("README.md");
    widget.focus();
    await key(widget, "g");
    expect(tab.selected).toBe("README.md");
    await key(widget, "g");
    expect(tab.selected).toBe("notes");
    await key(widget, "j");
    await key(widget, "y");
    expect(fbClipboard.paths).toEqual(["README.md"]);
  });

  test("a dock and a tab keep separate selections and copy from the focused surface", async () => {
    const tab = seat(browserTab());
    const target = await render({ variant: "tab", tab });
    const dock = await render({ variant: "dock", side: "left" });
    const widget = list(target);
    widget.focus();
    await key(widget, "End");
    const dockTree = dock.querySelector<HTMLElement>('[role="tree"]')!;
    dockTree.focus();
    await key(dockTree, "Home");
    expect(tab.selected).toBe("README.md");
    expect(fbTreeInstance("fb-dock-left")!.selection.path).toBe("notes");
    await key(dockTree, "c", { ctrlKey: true });
    expect(fbClipboard.paths).toEqual(["notes"]);
    widget.focus();
    await key(widget, "c", { ctrlKey: true });
    expect(fbClipboard.paths).toEqual(["README.md"]);
    expect(dock.querySelector('[aria-selected="true"]')?.textContent).toContain("notes");
  });
});

test("the toolbar menu supports keyboard movement and returns focus to its trigger", async () => {
  const target = await render({ variant: "tab", tab: seat(browserTab()) });
  const trigger = target.querySelector<HTMLButtonElement>(".hamburger-trigger")!;
  trigger.focus(); trigger.click();
  await settle();
  expect(menu()!.contains(document.activeElement)).toBe(true);
  const first = document.activeElement;
  document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", {key:"ArrowDown",bubbles:true,cancelable:true}));
  expect(document.activeElement).not.toBe(first);
  document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape",bubbles:true,cancelable:true}));
  await settle();
  expect(menu()).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

test("a rename finishing after focus moves keeps the result on its original surface", async () => {
  const tab = seat(browserTab({selected:"README.md"}));
  const target = await render({ variant: "tab", tab });
  const dock = await render({ variant: "dock", side:"left" });
  target.querySelector<HTMLElement>('[role="listbox"]')!.focus();
  const pending = fileOps.rename("README.md");
  await settle();
  dock.querySelector<HTMLElement>('[role="tree"]')!.focus();
  browserSelection.path = "notes";
  browserSelection.paths = ["notes"];
  resolvePathPrompt("notes/RENAMED.md");
  await pending;
  await settle();
  expect(tab.selected).toBe("notes/RENAMED.md");
  expect(tab.directory).toBe("notes");
  expect(document.activeElement).toBe(dock.querySelector('[role="tree"]'));
  expect(fbTreeInstance("fb-dock-left")!.selection.path).toBe("notes");
});

test("a root refresh reloads the open directory without losing its selection", async () => {
  const tab = seat(browserTab({directory:"notes",selected:"notes/a.md",selectedPaths:["notes/a.md"]}));
  const target = await render({variant:"tab",tab});
  expect(target.querySelector('[role="option"] .name')?.textContent).toBe("a.md");
  await refreshTree();
  await settle();
  expect(target.querySelector('[role="option"] .name')?.textContent).toBe("a.md");
  expect(tab.selectedPaths).toEqual(["notes/a.md"]);
  expect(tab.selected).toBe("notes/a.md");
});

test("a failed directory listing stays bounded and offers an explicit retry", async () => {
  const list = api.list;
  const calls = vi.spyOn(api,"list").mockImplementation((dir) => dir === "notes" ? Promise.reject(new Error("permission denied")) : list(dir));
  const target = await render({variant:"tab",tab:seat(browserTab({directory:"notes"}))});
  await settle(12);
  expect(calls.mock.calls.filter(([dir]) => dir === "notes")).toHaveLength(1);
  expect(target.textContent).toContain("permission denied");
  expect(target.querySelector(".retry")?.textContent).toContain("Retry");
});
