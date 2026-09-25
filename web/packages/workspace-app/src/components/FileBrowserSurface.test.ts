// @vitest-environment jsdom
//
// FileBrowserSurface, mounted over the in-memory demo workspace. The surface's
// own menu (the hamburger, opened by the tab strip, the dock body or the
// overlay trigger) and the tree's row menu it hosts are driven here the way a
// user reaches them; Pane is mounted for the one hop it owns, the Flip.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import FileBrowserSurface from "./FileBrowserSurface.svelte";
import Pane from "./Pane.svelte";
import { installDemoWorkspace, uninstallDemoWorkspace } from "../demo/install";
import { trackTimers, type TimerTrack } from "../demo/timers";
import { chordFor } from "../state/shortcuts";
import {
  browserSelection,
  browserSidePanes,
  pathPromptState,
  refreshTree,
  resolvePathPrompt,
  refreshWorkspace,
  workspace,
} from "../state/store.svelte";
import { closeTabMenu, openTabMenu } from "../state/tabMenu.svelte";
import { layout, paneSide, type BrowserTab, type LeafNode } from "../state/tabs.svelte";

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
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

async function render(props: Record<string, unknown>): Promise<HTMLElement> {
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
  closeTabMenu();
  if (pathPromptState.open) resolvePathPrompt(null);
  for (const app of mounted.splice(0)) unmount(app);
  document.body.innerHTML = "";
  await settle(2);
  uninstallDemoWorkspace();
  timers.release();
});

describe("the tab variant", () => {
  test("has no header or trigger; the tab strip's right-click opens the menu", async () => {
    const tab = seat(browserTab());
    const target = await render({ variant: "tab", tab });

    expect(target.querySelector("header")).toBeNull();
    expect(document.body.querySelector(".hamburger-trigger")).toBeNull();
    expect(menu()).toBeNull();

    await openFromTabStrip(tab);
    expect(menu()).not.toBeNull();
  });

  test("the menu is the workspace rows, the stick toggles and Close, nothing else", async () => {
    const tab = seat(browserTab());
    await render({ variant: "tab", tab });
    await openFromTabStrip(tab);

    const root = workspace.info?.root ?? "";
    expect(root).not.toBe("");
    expect(menuRows()).toEqual([
      workspace.info?.label ?? "",
      root,
      "---",
      "Stick to left",
      "Stick to right",
      "---",
      `Close ${chordFor("app.tab.close") ?? ""}`.trim(),
    ]);
    const labelRow = menu()!.querySelector<HTMLElement>(".workspace-label-row")!;
    expect(labelRow.title).toBe(root);
    expect(labelRow.querySelector("input"), "the label is not editable").toBeNull();
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

    menuButton(workspace.info!.root).click();
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

    const row = [...target.querySelectorAll<HTMLElement>("[role='treeitem']")].find((el) =>
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
    const row = [...target.querySelectorAll<HTMLElement>("[role='treeitem']")].find(
      (el) => el.querySelector(".name")?.textContent?.trim() === name,
    );
    row!.querySelector<HTMLElement>(".name")!.click();
  }

  test("opens the inspector in a Files tab", async () => {
    const tab = seat(browserTab());
    const target = await render({ variant: "tab", tab });
    clickRow(target, "README.md");
    await settle();
    expect(tab.inspectorOpen).toBe(true);
  });

  test("opens the inspector in the overlay", async () => {
    const target = await render({ variant: "overlay" });
    expect(target.querySelector(".inspector")).toBeNull();
    clickRow(target, "README.md");
    await settle();
    expect(target.querySelector(".inspector")).not.toBeNull();
  });
});

describe("the tree's row menu", () => {
  async function rowMenu(target: HTMLElement, name: string): Promise<string[]> {
    const row = [...target.querySelectorAll<HTMLElement>("[role='treeitem']")].find(
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
    const rows = await rowMenu(target, "notes/");
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
    expect(rows.some((r) => /^New (File|Directory)/.test(r))).toBe(false);
    expect(rows.slice(-2)).toEqual(["---", "Flip"]);
  });
});

describe("the dock variant", () => {
  test("has no header; a right-click on its body opens the menu at the cursor", async () => {
    const target = await render({ variant: "dock", side: "left" });
    expect(target.querySelector("header")).toBeNull();
    expect(document.body.querySelector(".hamburger-trigger")).toBeNull();

    target
      .querySelector(".browser")!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 80 }));
    await settle();
    expect(menu()).not.toBeNull();
    expect(menu()!.style.left).toBe("120px");
    expect(menu()!.style.top).toBe("80px");
  });

  test("offers Open in File Browser before the stick toggles, and no Close", async () => {
    const target = await render({ variant: "dock", side: "left" });
    target.querySelector(".browser")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await settle();

    const rows = menuRows();
    expect(rows.slice(2)).toEqual(["Open in File Browser", "---", "Stick to left", "Stick to right"]);
  });

  test("Open in File Browser opens a tab on the selection with its ancestors expanded", async () => {
    seat(browserTab({ id: "existing" }));
    const target = await render({ variant: "dock", side: "left" });
    browserSelection.path = "notes/a.md";
    target.querySelector(".browser")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await settle();

    menuButton("Open in File Browser").click();
    await settle();
    const tabs = (layout.nodes[layout.activePaneId] as LeafNode).tabs;
    const opened = tabs.find((t) => t.kind === "browser" && t.id !== "existing") as BrowserTab;
    expect(opened).toBeDefined();
    expect(opened.inspectorOpen).toBe(true);
    expect(opened.expanded).toEqual(["notes"]);
    expect(opened.showWorkspace).toBe(false);
    expect(browserSelection.path).toBe("notes/a.md");
  });

  test("the workspace path row opens a tab on the workspace", async () => {
    seat(browserTab({ id: "existing" }));
    const target = await render({ variant: "dock", side: "right" });
    target.querySelector(".browser")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await settle();

    menuButton(workspace.info!.root).click();
    await settle();
    const tabs = (layout.nodes[layout.activePaneId] as LeafNode).tabs;
    const opened = tabs.find((t) => t.kind === "browser" && t.id !== "existing") as BrowserTab;
    expect(opened?.showWorkspace).toBe(true);
    expect(opened?.inspectorOpen).toBe(true);
    expect(browserSelection.showWorkspace).toBe(true);
  });

  test("the tree's row menu carries no Flip", async () => {
    const target = await render({ variant: "dock", side: "left" });
    const row = [...target.querySelectorAll<HTMLElement>("[role='treeitem']")].find((el) =>
      el.textContent?.includes("README.md"),
    );
    row!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }));
    await settle();
    const labels = [...document.body.querySelectorAll(".menu-row-label")].map((el) => el.textContent);
    expect(labels).toContain("Delete");
    expect(labels).not.toContain("Flip");
  });
});

describe("the overlay variant", () => {
  test("keeps a header with the maximize control and the menu trigger", async () => {
    const target = await render({ variant: "overlay" });
    const header = target.querySelector("header");
    expect(header).not.toBeNull();
    expect(header!.querySelector("button[aria-label='Maximize']")).not.toBeNull();
    const trigger = header!.querySelector<HTMLButtonElement>(".hamburger-trigger");
    expect(trigger).not.toBeNull();
    trigger!.click();
    await settle();
    expect(menuRows()).toContain("Stick to left");
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

    const row = [...target.querySelectorAll<HTMLElement>("[role='treeitem']")].find((el) =>
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
