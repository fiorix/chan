// @vitest-environment jsdom
//
// Real panes and browser surfaces decide the command target. The demo
// transport supplies the listings; command effects are observed at their
// clipboard, picker and filesystem boundaries.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/xterm")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/xterm")).webglAddonModule());

import { demoData, mountApp, press, settle, stubAppEnvironment, unmountApp } from "../__tests__/app";
import { api } from "../api/client";
import { fileTab } from "../__tests__/tabs";
import { commandById, commandContext, commandUnavailableReason } from "../state/commands";
import { commandSurfaceId } from "../state/commands/browser";
import {
  browserSelection, browserSidePanes, fbActiveInstanceId, fbClipboard, fbClipboardClear,
  fbTreeInstance, fileOps, loadTreeDir, fbClipboardSet,
} from "../state/store.svelte";
import {
  activeBrowserTab, activeFileTab, cancelPaneMode, layout, paneMode, restoreLayout,
  type BrowserTab, type LeafNode, type Tab,
} from "../state/tabs.svelte";

stubAppEnvironment();

const LEFT = "commands-left";
const RIGHT = "commands-right";
const LEFT_TAB = "files-left";
const RIGHT_TAB = "files-right";
const LEFT_PATH = "docs/a.md";
const RIGHT_PATH = "notes/b.md";
const clipboard = vi.fn(async (_text: string) => {});
const files = [
  ...[LEFT_PATH, RIGHT_PATH, "notes/c.md"].map((path) => ({
    path, kind: "document" as const, size: 4, mtime: 100, content: "body",
  })),
  { path: "docs/photo.png", kind: "media" as const, size: 4, mtime: 100 },
];

beforeEach(async () => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: clipboard } });
  clipboard.mockClear();
  await mountApp(demoData(files));
  vi.spyOn(fileOps, "downloadPathWithProgress").mockImplementation(() => {});
  vi.spyOn(fileOps, "createFileOrDir").mockResolvedValue(undefined);
  vi.spyOn(fileOps, "uploadFilesTo").mockResolvedValue(undefined);
});

afterEach(async () => {
  cancelPaneMode();
  fbClipboardClear();
  await unmountApp();
  browserSelection.path = null;
  browserSelection.paths = [];
  vi.restoreAllMocks();
});

function browserTab(id: string, path: string): BrowserTab {
  return {
    kind: "browser", id, title: "Files", inspectorOpen: false,
    directory: path.slice(0, path.lastIndexOf("/")), selected: path, selectedPaths: [path],
  };
}

async function settleLong(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function element(selector: string, root: ParentNode = document): HTMLElement {
  const found = root.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`missing ${selector}`);
  return found;
}

function pane(id: string): HTMLElement { return element(`.pane[data-pane-id="${id}"]`); }
function browser(id: string): HTMLElement { return element(".browser", pane(id)); }
function dock(): HTMLElement { return element(".browser.dock"); }
function row(root: ParentNode, path: string): HTMLElement { return element(`[aria-selected][title="demo/${path}"]`, root); }

// Include pointer activation and the browser's mousedown default: jsdom
// dispatches listeners but does not focus the pressed element itself.
async function click(el: HTMLElement): Promise<void> {
  el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
  const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
  el.dispatchEvent(down);
  await settle();
  if (!down.defaultPrevented) {
    const target = el.closest<HTMLElement>("[tabindex], button, input, textarea, select, a[href]");
    if (target) target.focus();
    else (document.activeElement as HTMLElement | null)?.blur();
  }
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  await settleLong();
}

async function layOut(left: Tab[] = [browserTab(LEFT_TAB, LEFT_PATH)]): Promise<void> {
  layout.nodes = {
    root: { kind: "split", id: "root", direction: "column", a: LEFT, b: RIGHT, ratio: 0.5 },
    [LEFT]: { kind: "leaf", id: LEFT, tabs: left, activeTabId: left[0]?.id ?? null },
    [RIGHT]: { kind: "leaf", id: RIGHT, tabs: [browserTab(RIGHT_TAB, RIGHT_PATH)], activeTabId: RIGHT_TAB },
  };
  layout.rootId = "root";
  layout.activePaneId = LEFT;
  await settleLong();
  await vi.waitFor(() => expect(row(browser(RIGHT), RIGHT_PATH)).toBeTruthy());
}

async function showDock(): Promise<void> {
  browserSidePanes.left = true;
  await settleLong();
  await loadTreeDir("docs");
  const directory = row(dock(), "docs");
  if (directory.getAttribute("aria-expanded") !== "true") await click(element(".twirl", directory));
  await vi.waitFor(() => expect(row(dock(), LEFT_PATH)).toBeTruthy());
}

async function run(id: string): Promise<void> {
  const command = commandById(id);
  if (!command) throw new Error(`missing command ${id}`);
  expect(command.available(commandContext()), `${id} is offered`).toBe(true);
  await command.run();
  await settleLong();
}

async function expectCommandsTarget(id: string, path: string): Promise<void> {
  expect(fbActiveInstanceId()).toBe(id);
  expect(commandSurfaceId()).toBe(id);
  clipboard.mockClear();
  vi.mocked(fileOps.downloadPathWithProgress).mockClear();
  vi.mocked(fileOps.createFileOrDir).mockClear();
  vi.mocked(fileOps.uploadFilesTo).mockClear();
  await run("app.browser.copyPath");
  expect(clipboard).toHaveBeenCalledExactlyOnceWith(path);
  await run("app.browser.downloadSelection");
  expect(fileOps.downloadPathWithProgress).toHaveBeenCalledExactlyOnceWith(path, false);
  await run("app.browser.newFsEntry");
  const directory = path.slice(0, path.lastIndexOf("/"));
  expect(fileOps.createFileOrDir).toHaveBeenCalledExactlyOnceWith(directory);
  await run("app.browser.uploadSelection");
  const pickers = [...document.querySelectorAll<HTMLInputElement>('input[type="file"]')];
  const picker = pickers.at(-1);
  expect(picker, "Upload raised a picker").toBeTruthy();
  Object.defineProperty(picker!, "files", { configurable: true, value: [new File(["x"], "picked.txt")] });
  picker!.dispatchEvent(new Event("change"));
  await settleLong();
  expect(fileOps.uploadFilesTo).toHaveBeenCalledExactlyOnceWith(directory, expect.any(Array), undefined);
}

const paths = ["label", "strip", "pane", "Next pane", "Previous pane", "Hybrid Nav"] as const;
async function focusRight(path: typeof paths[number]): Promise<void> {
  if (path === "label") await click(element(".tabs .tab", pane(RIGHT)));
  else if (path === "strip") await click(element(".tabs .dead-zone", pane(RIGHT)));
  else if (path === "pane") await click(element(".pane-card", pane(RIGHT)));
  else if (path === "Next pane") press({ key: "]", code: "BracketRight", altKey: true });
  else if (path === "Previous pane") press({ key: "[", code: "BracketLeft", altKey: true });
  else {
    press({ key: ".", code: "Period", ctrlKey: true });
    press({ key: "h", code: "KeyH" });
    await settleLong();
    expect(paneMode.active).toBe(true);
    press({ key: "ArrowDown", code: "ArrowDown" });
    press({ key: "Enter", code: "Enter" });
  }
  await settleLong();
  expect(layout.activePaneId).toBe(RIGHT);
}

describe.each(["tab", "dock"] as const)("commands follow a focused browser tab after the %s", (origin) => {
  test.each(paths)("%s", async (path) => {
    await layOut();
    if (origin === "dock") {
      await showDock();
      await click(row(dock(), LEFT_PATH));
    } else await click(row(browser(LEFT), LEFT_PATH));
    await expectCommandsTarget(origin === "dock" ? "fb-dock-left" : `fb-tab-${LEFT_TAB}`, LEFT_PATH);
    await focusRight(path);
    await expectCommandsTarget(`fb-tab-${RIGHT_TAB}`, RIGHT_PATH);
  });
});

test.each(["label", "strip", "pane"] as const)("a %s press returns commands from a dock to the already focused pane", async (path) => {
  await layOut();
  await focusRight("label");
  await showDock();
  await click(row(dock(), LEFT_PATH));
  await focusRight(path);
  await expectCommandsTarget(`fb-tab-${RIGHT_TAB}`, RIGHT_PATH);
});

test("Next tab selects a browser through the real command and mounted pane", async () => {
  await layOut([browserTab(LEFT_TAB, LEFT_PATH), browserTab("files-next", RIGHT_PATH)]);
  await showDock();
  await click(row(dock(), LEFT_PATH));
  await run("app.tab.next");
  await expectCommandsTarget("fb-tab-files-next", RIGHT_PATH);
});

test("Open in new file browser makes the new tab the command surface", async () => {
  await layOut();
  await showDock();
  await click(row(dock(), LEFT_PATH));
  await run("app.browser.openInBrowser");
  const tab = activeBrowserTab();
  expect(tab?.id).not.toBe(LEFT_TAB);
  await expectCommandsTarget(`fb-tab-${tab!.id}`, LEFT_PATH);
});

test.each(["press", "focus"] as const)("a %s in the dock takes the command surface", async (gesture) => {
  await layOut();
  await showDock();
  await click(row(dock(), LEFT_PATH));
  await focusRight("label");
  if (gesture === "press") await click(row(dock(), LEFT_PATH));
  else element('[role="tree"]', dock()).focus();
  await settleLong();
  await expectCommandsTarget("fb-dock-left", LEFT_PATH);
});

test("Open opens the dock selection it was offered for", async () => {
  await layOut();
  await focusRight("label");
  await showDock();
  await click(row(dock(), LEFT_PATH));
  expect(activeBrowserTab()?.selected).toBe(RIGHT_PATH);
  await run("app.browser.open");
  expect(activeFileTab()?.path).toBe(LEFT_PATH);
  const opened = Object.values(layout.nodes).flatMap((node) => node.kind === "leaf" ? node.tabs : []).filter((tab) => tab.kind === "file");
  expect(opened.map((tab) => tab.path), "only the command surface answers Open").toEqual([LEFT_PATH]);
});

test("Open is not offered for a dock image beside a tab's editable selection", async () => {
  await layOut();
  await focusRight("label");
  await showDock();
  await click(element('[aria-selected][title="demo/docs/photo.png (view-only)"]', dock()));
  expect(activeBrowserTab()?.selected).toBe(RIGHT_PATH);
  expect(commandById("app.browser.open")!.available(commandContext())).toBe(false);
  expect(commandById("app.browser.viewMedia")!.available(commandContext())).toBe(true);
});

test("an empty dock never borrows the active tab's selection", async () => {
  await layOut();
  await focusRight("label");
  await showDock();
  await click(row(dock(), LEFT_PATH));
  await run("app.browser.clearSelection");
  expect(fbTreeInstance("fb-dock-left")?.selection.path).toBeNull();
  expect(activeBrowserTab()?.selected).toBe(RIGHT_PATH);
  for (const id of ["open", "copyPath", "downloadSelection", "renameSelection", "deleteSelection", "copySelection", "cutSelection", "viewMedia", "exportPdf", "clearSelection"]) {
    expect(commandById(`app.browser.${id}`)!.available(commandContext()), `${id} with an empty dock`).toBe(false);
  }
  clipboard.mockClear();
  vi.mocked(fileOps.downloadPathWithProgress).mockClear();
  for (const id of ["copyPath", "downloadSelection", "copySelection", "cutSelection"]) await commandById(`app.browser.${id}`)!.run();
  expect(clipboard).not.toHaveBeenCalled();
  expect(fileOps.downloadPathWithProgress).not.toHaveBeenCalled();
  expect(fbClipboard.mode).toBeNull();
  await run("app.browser.newFsEntry");
  expect(fileOps.createFileOrDir).toHaveBeenLastCalledWith("");
});

test("Open in new file browser with an empty dock opens the root, not the active tab's selection", async () => {
  await layOut();
  await focusRight("label");
  await showDock();
  await click(row(dock(), LEFT_PATH));
  await run("app.browser.clearSelection");
  await run("app.browser.openInBrowser");
  expect(activeBrowserTab()).toMatchObject({ directory: "", selectedPaths: [] });
  expect(activeBrowserTab()?.selected).toBeUndefined();
});

test("a detached selection does not give commands a surface", async () => {
  expect(fbActiveInstanceId()).toBeNull();
  // Filesystem actions can finish with no browser mounted. Their detached
  // selection is retained by the store but does not name a command target.
  browserSelection.path = LEFT_PATH;
  browserSelection.paths = [LEFT_PATH];
  await layOut([]);
  expect(commandSurfaceId()).toBeNull();
  await commandById("app.browser.copyPath")!.run();
  await commandById("app.browser.copySelection")!.run();
  expect(clipboard).not.toHaveBeenCalled();
  expect(fbClipboard.mode).toBeNull();
  await run("app.browser.newFsEntry");
  expect(fileOps.createFileOrDir).toHaveBeenCalledExactlyOnceWith("");
});

test("disposing the targeted dock does not fall back to the still-visible tab", async () => {
  await layOut();
  await focusRight("label");
  await showDock();
  await click(row(dock(), LEFT_PATH));
  const paste = commandById("app.browser.pasteSelection")!;
  expect(paste.available(commandContext())).toBe(false);
  expect(commandUnavailableReason(paste, commandContext())).toBe("Needs a copied or cut selection");
  await run("app.browser.copySelection");
  expect(paste.available(commandContext())).toBe(true);
  browserSidePanes.left = false;
  await settleLong();
  expect(activeBrowserTab()?.selected).toBe(RIGHT_PATH);
  expect(fbActiveInstanceId()).toBeNull();
  expect(commandSurfaceId()).toBeNull();
  expect(commandById("app.browser.open")!.available(commandContext())).toBe(false);
  const upload = commandById("app.browser.uploadSelection")!;
  expect(upload.available(commandContext()), "Upload needs a browser to answer it").toBe(false);
  expect(commandUnavailableReason(upload, commandContext())).toBe("Focus a file browser");
  const pickers = document.querySelectorAll('input[type="file"]').length;
  await upload.run();
  await settleLong();
  expect(document.querySelectorAll('input[type="file"]')).toHaveLength(pickers);
  expect(paste.available(commandContext()), "Paste needs its recorded destination browser").toBe(false);
  expect(commandUnavailableReason(paste, commandContext())).toBe("Focus a file browser");
  const transfer = vi.spyOn(api, "fsTransfer");
  await paste.run();
  await settleLong();
  expect(transfer).not.toHaveBeenCalled();
});

test("pressing a browser pane's Hybrid Nav preview does not activate an unmounted surface", async () => {
  await layOut();
  press({ key: ".", code: "Period", ctrlKey: true });
  press({ key: "h", code: "KeyH" });
  await settleLong();
  expect(paneMode.active).toBe(true);
  expect(document.querySelector(".pane .browser")).toBeNull();
  expect(fbActiveInstanceId()).toBeNull();
  await click(element(".pane-card", pane(RIGHT)));
  expect(fbActiveInstanceId()).toBeNull();
  expect(fbTreeInstance(`fb-tab-${RIGHT_TAB}`)).toBeNull();
});

test.each([false, true])("Paste retains its originating surface while awaiting the transfer, dock closed %s", async (closeDock) => {
  await layOut();
  await showDock();
  await click(row(dock(), LEFT_PATH));
  const original = fbTreeInstance("fb-dock-left")!.selection;
  const transfer = api.fsTransfer;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const request = vi.spyOn(api, "fsTransfer").mockImplementation(async (...args) => {
    await held;
    return transfer(...args);
  });
  fbClipboardSet("copy", [RIGHT_PATH]);
  try {
    await run("app.browser.pasteSelection");
    expect(request).toHaveBeenCalledExactlyOnceWith("copy", [RIGHT_PATH], "docs");
    await focusRight("label");
    if (closeDock) { browserSidePanes.left = false; await settleLong(); }
  } finally {
    release();
  }
  await vi.waitFor(() => expect(original.path).toBe("docs/b.md"));
  expect(fbTreeInstance(`fb-tab-${RIGHT_TAB}`)?.selection.path).toBe(RIGHT_PATH);
  expect(activeBrowserTab()?.selected).toBe(RIGHT_PATH);
  expect(fbActiveInstanceId()).toBe(`fb-tab-${RIGHT_TAB}`);
});

test.each([false, true])("restoring the focused browser tab gives it the keyboard and commands, prior dock %s", async (priorDock) => {
  if (priorDock) {
    await showDock();
    await click(row(dock(), LEFT_PATH));
  }
  expect(fbActiveInstanceId()).toBe(priorDock ? "fb-dock-left" : null);
  await restoreLayout({ k: "s", d: "c",
    a: { k: "l", t: [{ k: "b", bs: LEFT_PATH, bp: "docs", a: 1 }] },
    b: { k: "l", f: 1, t: [{ k: "b", bs: RIGHT_PATH, bp: "notes", a: 1 }] },
  });
  await settleLong();

  expect(document.querySelectorAll(".pane .browser")).toHaveLength(2);
  expect(browser(layout.activePaneId).contains(document.activeElement), "the restored focused browser holds the keyboard").toBe(true);
  expect(document.activeElement?.getAttribute("role")).toBe("listbox");
  const tab = activeBrowserTab();
  if (!tab) throw new Error("no active restored browser tab");
  expect(tab.selected).toBe(RIGHT_PATH);
  await expectCommandsTarget(`fb-tab-${tab.id}`, RIGHT_PATH);
});

describe("passive browser tabs leave the command surface alone", () => {
  test("a background pane with no previous surface", async () => {
    expect(fbActiveInstanceId()).toBeNull();
    await layOut([]);
    expect(fbActiveInstanceId()).toBeNull();
    expect(commandSurfaceId()).toBeNull();
  });

  test("a background pane with a dock already targeted", async () => {
    await showDock();
    await click(row(dock(), LEFT_PATH));
    await layOut([]);
    expect(fbActiveInstanceId()).toBe("fb-dock-left");
    expect(fbTreeInstance("fb-dock-left")?.selection.path).toBe(LEFT_PATH);
  });

  test("a tab on the hidden side with no previous surface", async () => {
    layout.nodes = { [LEFT]: {
      kind: "leaf", id: LEFT, tabs: [], activeTabId: null,
      bTabs: [browserTab(RIGHT_TAB, RIGHT_PATH)], bActiveTabId: RIGHT_TAB, side: "a",
    } };
    layout.rootId = LEFT;
    layout.activePaneId = LEFT;
    await settleLong();
    expect(document.querySelector(".pane .browser")).toBeNull();
    expect(fbActiveInstanceId()).toBeNull();
  });

  test("a hidden-side tab keeps the dock's selection when its sibling unmounts", async () => {
    await layOut();
    await showDock();
    await click(row(dock(), LEFT_PATH));
    const right = layout.nodes[RIGHT] as LeafNode;
    right.bTabs = [browserTab("hidden-browser", "notes/c.md")];
    right.bActiveTabId = "hidden-browser";
    right.tabs = [fileTab({ id: "other", path: RIGHT_PATH })];
    right.activeTabId = "other";
    await settleLong();
    expect(fbActiveInstanceId()).toBe("fb-dock-left");
    expect(right.bTabs[0]).toMatchObject({ selected: "notes/c.md", selectedPaths: ["notes/c.md"] });
    expect(fbTreeInstance("fb-dock-left")?.selection.path).toBe(LEFT_PATH);
  });

  test.each([false, true])("a session restore of a background and hidden browser, prior dock %s", async (priorDock) => {
    if (priorDock) {
      await showDock();
      await click(row(dock(), LEFT_PATH));
    }
    await restoreLayout({ k: "s", d: "c",
      a: { k: "l", f: 1, t: [], bt: [{ k: "b", bs: LEFT_PATH, bp: "docs", a: 1 }] },
      b: { k: "l", t: [{ k: "b", bs: RIGHT_PATH, bp: "notes", a: 1 }] },
    });
    await settleLong();
    expect(document.querySelectorAll(".pane .browser")).toHaveLength(1);
    expect(fbActiveInstanceId()).toBe(priorDock ? "fb-dock-left" : null);
  });
});
