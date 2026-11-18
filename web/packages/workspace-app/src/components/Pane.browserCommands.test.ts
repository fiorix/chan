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

import { demoData, hostCommand, mountApp, press, settle, stubAppEnvironment, unmountApp } from "../__tests__/app";
import { api } from "../api/client";
import { updateGlobalConfigSerial } from "../api/preferenceWrite";
import { fileTab, terminalTab } from "../__tests__/tabs";
import { xterm } from "../__tests__/xterm";
import { commandById, commandContext, commandUnavailableReason } from "../state/commands";
import { commandSurfaceId } from "../state/commands/browser";
import {
  browserSelection, browserSidePanes, closeSettings, fbActiveInstanceId, fbClipboard, fbClipboardClear,
  fbTreeInstance, fileOps, loadTreeDir, fbClipboardSet, openSettings, searchPanel, setBrowserSidePane, settingsPanel,
} from "../state/store.svelte";
import {
  activeBrowserTab, activeFileTab, cancelPaneMode, enterPaneMode, layout, paneMode, restoreLayout,
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
  closeSettings();
  searchPanel.open = false;
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
function sideDock(side: "left" | "right"): HTMLElement {
  return element(`.browser-side-pane.${side} .browser.dock`);
}
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

async function showDock(side: "left" | "right" = "left"): Promise<void> {
  setBrowserSidePane(side, true);
  // Drain the persisted write the preference mirror reads back: an
  // unpersisted open is closed again by the next workspace refresh.
  await updateGlobalConfigSerial(() => null);
  const root = sideDock(side);
  await vi.waitFor(() => {
    expect(root.querySelector('[aria-selected][title$="/docs"]'), "docs row listed").toBeTruthy();
  });
  await settleLong();
  await loadTreeDir("docs");
  const directory = row(root, "docs");
  if (directory.getAttribute("aria-expanded") !== "true") await click(element(".twirl", directory));
  await vi.waitFor(() => expect(row(root, LEFT_PATH)).toBeTruthy());
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

async function focusSettingsControl(): Promise<HTMLElement> {
  openSettings();
  await settleLong();
  const control = element('[aria-label="Settings sections"] .section-tab');
  control.focus();
  await settleLong();
  expect(fbActiveInstanceId(), "focusing settings moves no target").toBe("fb-dock-left");
  return control;
}

describe("closing the targeted dock hands the target to the focused pane", () => {
  async function targetDock(): Promise<void> {
    await layOut();
    await focusRight("label");
    await showDock();
    await click(row(dock(), LEFT_PATH));
    expect(fbActiveInstanceId(), "the dock holds the target").toBe("fb-dock-left");
    await run("app.browser.copySelection");
  }

  async function expectHandedToTab(): Promise<void> {
    expect(commandSurfaceId(), "the tab takes the target").toBe(`fb-tab-${RIGHT_TAB}`);
    expect(fbActiveInstanceId()).toBe(`fb-tab-${RIGHT_TAB}`);
    await expectCommandsTarget(`fb-tab-${RIGHT_TAB}`, RIGHT_PATH);
    const transfer = vi.spyOn(api, "fsTransfer");
    await run("app.browser.pasteSelection");
    await settleLong();
    expect(transfer, "paste lands in the tab's folder").toHaveBeenCalledWith("copy", [LEFT_PATH], "notes");
    await vi.waitFor(() => expect(fbTreeInstance(`fb-tab-${RIGHT_TAB}`)?.selection.paths).toContain("notes/a.md"));
  }

  async function closeDockFromChord(): Promise<void> {
    // Enter pane mode through the same function the Mod+. chord dispatches;
    // the ">" keypress below is the chord under test, read straight off e.key.
    enterPaneMode();
    await settleLong();
    expect(paneMode.active, "pane mode entered").toBe(true);
    press({ key: ">", code: "Period", shiftKey: true });
    await settleLong();
    expect(browserSidePanes.left, "left dock closed").toBe(false);
  }

  async function closeDockFromLauncher(): Promise<void> {
    hostCommand("app.launcher.toggle");
    await settleLong();
    const dialog = document.querySelector('[role="dialog"][aria-label="Command launcher"]');
    expect(dialog, "the launcher opened").toBeTruthy();
    await vi.waitFor(() => {
      const rows = [...dialog!.querySelectorAll(".deck-result")];
      if (!rows.some((row) => row.querySelector(".deck-result-title")?.textContent === "Left file browser dock")) {
        throw new Error("no dock row yet");
      }
    });
    const target = [...dialog!.querySelectorAll<HTMLElement>(".deck-result")].find(
      (row) => row.querySelector(".deck-result-title")?.textContent === "Left file browser dock",
    )!;
    target.click();
    await settleLong();
    if (document.querySelector('[role="dialog"][aria-label="Command launcher"]')) {
      press({ key: "Escape", code: "Escape" });
      await settleLong();
    }
    expect(document.querySelector('[role="dialog"][aria-label="Command launcher"]'), "launcher closed").toBeNull();
    expect(browserSidePanes.left, "left dock closed").toBe(false);
  }

  async function closeDockFromMenu(): Promise<void> {
    await click(element('.browser.dock .browser-toolbar button[aria-label="Menu"]'));
    const menuRow = [...document.querySelectorAll<HTMLButtonElement>(".hamburger-menu button")].find(
      (button) => button.querySelector(".menu-row-label")?.textContent?.trim() === "Left file browser dock",
    );
    expect(menuRow, "the dock menu names its toggle").toBeTruthy();
    menuRow!.click();
    await settleLong();
    expect(browserSidePanes.left, "left dock closed").toBe(false);
  }

  // Characterization: pins the chord path, whose remount focuses on its own.
  test("dock chord", async () => {
    await targetDock();
    await closeDockFromChord();
    await expectHandedToTab();
  });

  test("launcher toggle", async () => {
    await targetDock();
    await closeDockFromLauncher();
    await expectHandedToTab();
  });

  test("dock menu row", async () => {
    await targetDock();
    await closeDockFromMenu();
    await expectHandedToTab();
  });

  // Characterization: pins the no-fallback shape with a terminal active.
  test("terminal active in the focused pane: the target is empty", async () => {
    await layOut([terminalTab({ id: "term-1" })]);
    await showDock();
    await click(row(dock(), LEFT_PATH));
    expect(fbActiveInstanceId(), "the dock holds the target").toBe("fb-dock-left");
    await closeDockFromMenu();
    expect(activeBrowserTab()).toBeNull();
    expect(fbActiveInstanceId(), "no fallback without a file browser tab").toBeNull();
    expect(commandSurfaceId()).toBeNull();
    const upload = commandById("app.browser.uploadSelection")!;
    expect(upload.available(commandContext())).toBe(false);
    // Not on a browser surface: the placement reason names the tab the
    // command needs, before the command's own reason is even read.
    expect(commandUnavailableReason(upload, commandContext())).toBe("Needs a file browser tab");
  });

  test("the keyboard returns to the tab's tree", async () => {
    await targetDock();
    // The menu path, not the chord: the chord's commit clones the layout and
    // the tab remounts into focus on its own, while the menu path leaves the
    // return to the handover's pulse alone.
    await closeDockFromMenu();
    expect(document.activeElement === document.body, "focus left the body").toBe(false);
    expect(element(".browser", pane(RIGHT)).contains(document.activeElement), "focus is inside the tab's tree").toBe(true);
  });

  test("the keyboard returns to the terminal's input", async () => {
    xterm.textareaFocus = true;
    try {
      await layOut([terminalTab({ id: "term-1" })]);
      await showDock();
      await click(row(dock(), LEFT_PATH));
      expect(fbActiveInstanceId(), "the dock holds the target").toBe("fb-dock-left");
      await closeDockFromMenu();
      expect(commandSurfaceId()).toBeNull();
      const textarea = xterm.terminals.at(-1)?.textarea;
      expect(textarea, "the terminal opened a textarea").toBeTruthy();
      await vi.waitFor(() => expect(document.activeElement).toBe(textarea));
    } finally {
      xterm.textareaFocus = false;
    }
  });

  test("a dock closing while another surface is the target changes nothing (characterization)", async () => {
    await layOut();
    await focusRight("label");
    await click(row(browser(RIGHT), RIGHT_PATH));
    expect(fbActiveInstanceId(), "the tab holds the target").toBe(`fb-tab-${RIGHT_TAB}`);
    await showDock();
    await click(row(browser(RIGHT), RIGHT_PATH));
    expect(fbActiveInstanceId(), "showing the dock moves nothing").toBe(`fb-tab-${RIGHT_TAB}`);
    const focused = document.activeElement;
    await closeDockFromLauncher();
    expect(fbActiveInstanceId(), "the target stays").toBe(`fb-tab-${RIGHT_TAB}`);
    expect(document.activeElement, "the close moves no keyboard").toBe(focused);
    expect(commandSurfaceId()).toBe(`fb-tab-${RIGHT_TAB}`);
    expect(fbTreeInstance(`fb-tab-${RIGHT_TAB}`)?.selection.path).toBe(RIGHT_PATH);
  });

  test("closing the untargeted dock changes nothing", async () => {
    await layOut();
    await showDock("right");
    await showDock("left");
    await click(row(sideDock("right"), LEFT_PATH));
    expect(fbActiveInstanceId(), "the right dock holds the target").toBe("fb-dock-right");
    (document.activeElement as HTMLElement | null)?.blur();
    await settleLong();
    expect(document.activeElement, "keyboard parked on the body").toBe(document.body);
    setBrowserSidePane("left", false);
    await settleLong();
    expect(browserSidePanes.left, "left dock closed").toBe(false);
    expect(fbActiveInstanceId(), "the target stays").toBe("fb-dock-right");
    expect(document.activeElement, "the close moves no keyboard").toBe(document.body);
    expect(fbTreeInstance("fb-dock-right")?.selection.path).toBe(LEFT_PATH);
  });

  test("launcher toggle returns the keyboard to the tab's tree", async () => {
    await targetDock();
    await closeDockFromLauncher();
    expect(document.activeElement === document.body, "focus left the body").toBe(false);
    expect(element(".browser", pane(RIGHT)).contains(document.activeElement), "focus is inside the tab's tree").toBe(true);
  });

  test("launcher toggle returns the keyboard to the terminal's input", async () => {
    xterm.textareaFocus = true;
    try {
      await layOut([terminalTab({ id: "term-1" })]);
      await showDock();
      await click(row(dock(), LEFT_PATH));
      expect(fbActiveInstanceId(), "the dock holds the target").toBe("fb-dock-left");
      await closeDockFromLauncher();
      expect(commandSurfaceId()).toBeNull();
      const textarea = xterm.terminals.at(-1)?.textarea;
      expect(textarea, "the terminal opened a textarea").toBeTruthy();
      await vi.waitFor(() => expect(document.activeElement).toBe(textarea));
    } finally {
      xterm.textareaFocus = false;
    }
  });

  test("a close with Settings focused moves no keyboard and empties the target", async () => {
    await targetDock();
    const control = await focusSettingsControl();
    await closeDockFromLauncher();
    expect(browserSidePanes.left, "left dock closed").toBe(false);
    expect(document.activeElement, "focus stays on the Settings control").toBe(control);
    expect(fbActiveInstanceId(), "no fallback without a focused file browser").toBeNull();
    expect(commandSurfaceId()).toBeNull();
  });

  test("a close with a body-level launcher opener returns the keyboard to it", async () => {
    await targetDock();
    const field = document.createElement("input");
    field.setAttribute("type", "text");
    document.body.append(field);
    try {
      field.focus();
      await settleLong();
      expect(fbActiveInstanceId(), "focusing outside moves no target").toBe("fb-dock-left");
      await closeDockFromLauncher();
      expect(browserSidePanes.left, "left dock closed").toBe(false);
      expect(document.activeElement, "focus returns to the body-level opener").toBe(field);
      expect(fbActiveInstanceId(), "no fallback without a focused file browser").toBeNull();
    } finally {
      field.remove();
    }
  });

  test("a toggle command with Settings focused moves no keyboard", async () => {
    // A user-assigned chord dispatches the toggle command with no overlay
    // check; running the command below is that path, not the launcher or
    // menu rows above.
    await targetDock();
    const control = await focusSettingsControl();
    await run("app.browser.toggleLeftDock");
    expect(browserSidePanes.left, "left dock closed").toBe(false);
    expect(document.activeElement, "focus stays on the Settings control").toBe(control);
    expect(fbActiveInstanceId(), "no fallback without a focused file browser").toBeNull();
  });

  async function remountWithChord(): Promise<void> {
    await unmountApp();
    await mountApp(demoData(files), {
      preferences: { shortcuts: { "app.browser.toggleLeftDock": { web: "Ctrl+Alt+Y" } } },
    });
  }

  async function focusEditorFontSize(): Promise<HTMLElement> {
    openSettings();
    await settleLong();
    const editor = [...document.querySelectorAll<HTMLElement>('[aria-label="Settings sections"] .section-tab')]
      .find((tab) => tab.textContent?.trim() === "Editor");
    expect(editor, "Editor section listed").toBeTruthy();
    editor!.click();
    await settleLong();
    const field = await vi.waitFor(() => {
      const input = document.querySelector<HTMLElement>(".editor-font-size");
      expect(input, "Editor font size field rendered").toBeTruthy();
      return input!;
    });
    field.focus();
    await settleLong();
    expect(fbActiveInstanceId(), "focusing settings moves no target").toBe("fb-dock-left");
    return field;
  }

  test("a chord with the keyboard on the body under Search moves nothing", async () => {
    await remountWithChord();
    await targetDock();
    searchPanel.open = true;
    await settleLong();
    const field = await vi.waitFor(() => {
      const input = document.querySelector<HTMLElement>(".search .head input");
      expect(input, "Search input rendered").toBeTruthy();
      return input!;
    });
    field.focus();
    await settleLong();
    expect(fbActiveInstanceId(), "focusing Search moves no target").toBe("fb-dock-left");
    field.blur();
    await settleLong();
    expect(document.activeElement, "blur parked the keyboard on the body").toBe(document.body);
    press({ key: "y", code: "KeyY", ctrlKey: true, altKey: true });
    await settleLong();
    expect(browserSidePanes.left, "left dock closed").toBe(false);
    expect(document.activeElement, "focus stays on the body under Search").toBe(document.body);
    expect(fbActiveInstanceId(), "no fallback without a focused file browser").toBeNull();
  });

  test("a chord with the keyboard on the body under Settings moves nothing", async () => {
    await remountWithChord();
    await targetDock();
    const field = await focusEditorFontSize();
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    await settleLong();
    expect(document.activeElement, "Enter blurred the field to the body").toBe(document.body);
    press({ key: "y", code: "KeyY", ctrlKey: true, altKey: true });
    await settleLong();
    expect(browserSidePanes.left, "left dock closed").toBe(false);
    expect(document.activeElement, "focus stays on the body under Settings").toBe(document.body);
    expect(fbActiveInstanceId(), "no fallback without a focused file browser").toBeNull();
  });

  test("an assigned chord pressed from inside the dock hands over", async () => {
    await remountWithChord();
    await targetDock();
    expect(document.activeElement === document.body, "focus starts out of the body").toBe(false);
    expect(element(".browser-side-pane.left").contains(document.activeElement), "focus starts inside the dock").toBe(true);
    press({ key: "y", code: "KeyY", ctrlKey: true, altKey: true });
    await settleLong();
    expect(browserSidePanes.left, "left dock closed").toBe(false);
    expect(element(".browser", pane(RIGHT)).contains(document.activeElement), "focus is inside the tab's tree").toBe(true);
    expect(commandSurfaceId(), "the tab takes the target").toBe(`fb-tab-${RIGHT_TAB}`);
  });

  test("a launcher opened from the body hands over on close", async () => {
    await targetDock();
    (document.activeElement as HTMLElement | null)?.blur();
    await settleLong();
    expect(document.activeElement, "keyboard parked on the body").toBe(document.body);
    await closeDockFromLauncher();
    expect(browserSidePanes.left, "left dock closed").toBe(false);
    expect(element(".browser", pane(RIGHT)).contains(document.activeElement), "focus is inside the tab's tree").toBe(true);
    expect(commandSurfaceId(), "the tab takes the target").toBe(`fb-tab-${RIGHT_TAB}`);
  });

  test("a dock menu row with the keyboard on the body hands over", async () => {
    await targetDock();
    await click(element('.browser.dock .browser-toolbar button[aria-label="Menu"]'));
    const row = [...document.querySelectorAll<HTMLButtonElement>(".hamburger-menu button")].find(
      (button) => button.querySelector(".menu-row-label")?.textContent?.trim() === "Left file browser dock",
    );
    expect(row, "the dock menu names its toggle").toBeTruthy();
    (document.activeElement as HTMLElement | null)?.blur();
    await settleLong();
    expect(document.activeElement, "keyboard parked on the body").toBe(document.body);
    row!.click();
    await settleLong();
    expect(browserSidePanes.left, "left dock closed").toBe(false);
    expect(element(".browser", pane(RIGHT)).contains(document.activeElement), "focus is inside the tab's tree").toBe(true);
    expect(commandSurfaceId(), "the tab takes the target").toBe(`fb-tab-${RIGHT_TAB}`);
  });

  test("a fresh mount starts with no overlay", async () => {
    await layOut();
    expect(settingsPanel.open, "Settings closed by the previous teardown").toBe(false);
    expect(searchPanel.open, "Search closed by the previous teardown").toBe(false);
    expect(document.querySelector('[aria-label="Settings sections"]'), "no settings surface mounted").toBeNull();
  });

  test("a no-pulse close leaves Upload and Paste refusing", async () => {
    // The Files-tab-with-no-target state is still reachable: a close that
    // moves no keyboard empties the target through the dock's dispose
    // while the tab stays active.
    await targetDock();
    await focusSettingsControl();
    await run("app.browser.toggleLeftDock");
    expect(browserSidePanes.left, "left dock closed").toBe(false);
    expect(fbActiveInstanceId(), "target emptied").toBeNull();
    expect(activeBrowserTab()?.selected).toBe(RIGHT_PATH);
    const upload = commandById("app.browser.uploadSelection")!;
    expect(upload.available(commandContext())).toBe(false);
    expect(commandUnavailableReason(upload, commandContext())).toBe("Focus a file browser");
    fbClipboardSet("copy", [RIGHT_PATH]);
    const paste = commandById("app.browser.pasteSelection")!;
    expect(paste.available(commandContext())).toBe(false);
    expect(commandUnavailableReason(paste, commandContext())).toBe("Focus a file browser");
    const transfer = vi.spyOn(api, "fsTransfer");
    await paste.run();
    expect(transfer, "Paste sends no transfer").not.toHaveBeenCalled();
    await upload.run();
    await settleLong();
    expect(document.querySelector('input[type="file"]'), "Upload raises no picker").toBeNull();
  });

  test("a paste in flight from the dock lands where it was aimed", async () => {
    await layOut();
    await focusRight("label");
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
    const paste = commandById("app.browser.pasteSelection")!;
    expect(paste.available(commandContext()), "paste is offered").toBe(true);
    try {
      void paste.run();
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
      expect(request).toHaveBeenCalledWith("copy", [RIGHT_PATH], "docs");
      await closeDockFromLauncher();
      expect(browserSidePanes.left, "the targeted dock closed mid-flight").toBe(false);
    } finally {
      release();
    }
    await vi.waitFor(() => expect(original.path).toBe("docs/b.md"));
    expect(commandSurfaceId(), "the focused pane's tab takes the target").toBe(`fb-tab-${RIGHT_TAB}`);
  });
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
