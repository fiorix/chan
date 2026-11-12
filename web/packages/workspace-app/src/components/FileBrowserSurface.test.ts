// @vitest-environment jsdom
//
// FileBrowserSurface, mounted over the in-memory demo workspace. The surface's
// own menu (the hamburger, opened by the tab strip or dock body) and the
// tree's row menu it hosts are driven here the way a
// user reaches them; Pane is mounted for the one hop it owns, the Flip.
//
// The menu types no action's words itself: each row is held to the title of
// the catalog command it runs, to the settings entry it flips, to the shortcut
// table's label for the launcher, or to a named exemption.

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

import { browserKeys, setBrowserVim } from "../state/browserKeys.svelte";
import { api } from "../api/client";
import FileBrowserSurface from "./FileBrowserSurface.svelte";
import Pane from "./Pane.svelte";
import { settingEntry } from "./settings/settingsIndex";
import { installDemoWorkspace, uninstallDemoWorkspace } from "../demo/install";
import { trackTimers, type TimerTrack } from "../demo/timers";
import { browserBindings } from "../state/browserKeymap";
import {
  commandById,
  commandContext,
  commandPlacement,
  commandState,
  commandUnavailableReason,
} from "../state/commands";
import { chordFor, SHORTCUTS } from "../state/shortcuts";
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
  tree,
} from "../state/store.svelte";
import { closeTabMenu, openTabMenu } from "../state/tabMenu.svelte";
import { layout, paneSide, type BrowserTab, type LeafNode } from "../state/tabs.svelte";
import { terminalTab } from "../__tests__/tabs";

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

function rowLabel(row: Element): string {
  return (row.querySelector(".menu-row-label")?.textContent ?? "").trim();
}

/// The menu's rows in order: a separator, or the row's label.
function menuRows(): string[] {
  const list = menu();
  if (!list) return [];
  return [...list.children].map((li) => (li.getAttribute("role") === "separator" ? "---" : rowLabel(li)));
}

function menuButton(label: string): HTMLButtonElement {
  const button = [...(menu()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
    (b) => rowLabel(b) === label,
  );
  if (!button) throw new Error(`no menu row ${label}`);
  return button;
}

function menuChord(label: string): string {
  return menuButton(label).querySelector(".chord")?.textContent ?? "";
}

/// Where a menu row takes its words: the title of a catalog command, the
/// label of a settings entry, the shortcut table's label for a chord the
/// catalog does not list, or words of its own with the reason it has them.
type Words =
  | { command: string }
  | { setting: string }
  | { shortcut: string }
  | { own: string; because: string };

function title(id: string): string {
  const command = commandById(id);
  if (!command) throw new Error(`no catalog command ${id}`);
  return command.title;
}

function wordsOf(source: Words | "---"): string {
  if (source === "---") return source;
  if ("command" in source) return title(source.command);
  if ("setting" in source) return settingEntry(source.setting).label;
  if ("shortcut" in source) {
    const shortcut = SHORTCUTS.find((candidate) => candidate.id === source.shortcut);
    if (!shortcut) throw new Error(`no shortcut ${source.shortcut}`);
    return shortcut.label;
  }
  return source.own;
}

const SELECTION_ACTIONS: Words = {
  own: "Selection actions",
  because: "opens the tree's row menu, whose rows are the catalog commands; a launcher row would list them twice",
};

const DETAILS = "app.browser.details";

/// The toolbar's Details button, found by the name its command gives it.
function detailsButton(target: HTMLElement): HTMLButtonElement {
  const button = target.querySelector<HTMLButtonElement>(
    `.browser-toolbar button[aria-label="${title(DETAILS)}"]`,
  );
  if (!button) throw new Error("no Details button in the toolbar");
  return button;
}

/// The browser tabs of the focused pane other than `except`.
function openedTabs(except: string): BrowserTab[] {
  const tabs = (layout.nodes[layout.activePaneId] as LeafNode).tabs;
  return tabs.filter((tab): tab is BrowserTab => tab.kind === "browser" && tab.id !== except);
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
      "New file or directory", "Upload", "Selection actions", "Select multiple", "---",
      "Hidden files", settingEntry("browser.vim").label, "Keyboard shortcuts (file browser)", "---",
      "Workspace details", "Left file browser dock", "Right file browser dock", "Close tab", "---",
      "Command launcher",
    ]);
    expect(menuChord("Selection actions")).toBe("Shift+F10");
    expect(menuChord("Select multiple")).toBe("F8");
    expect(menuChord("Close tab")).toBe(chordFor("app.tab.close") ?? "");
    expect(menuChord("Command launcher")).toBe(chordFor("app.launcher.toggle") ?? "");
  });

  test("Close closes the menu and hands the close to the host", async () => {
    const tab = seat(browserTab());
    const onClose = vi.fn();
    await render({ variant: "tab", tab, onClose });
    await openFromTabStrip(tab);

    menuButton("Close tab").click();
    await settle();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
  });

  test("Flip pane sits before Close tab where the host can flip, and flips through it", async () => {
    const tab = seat(browserTab());
    const onFlip = vi.fn();
    await render({ variant: "tab", tab, onFlip });
    await openFromTabStrip(tab);

    const rows = menuRows();
    expect(rows.slice(rows.indexOf("Right file browser dock") + 1)).toEqual([
      "Flip pane", "Close tab", "---", "Command launcher",
    ]);
    expect(menuChord("Flip pane")).toBe(chordFor("app.pane.flip") ?? "");

    menuButton("Flip pane").click();
    await settle();
    expect(onFlip).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
  });

  test("a dock row docks the browser to its side and shows a check while it is docked", async () => {
    const tab = seat(browserTab());
    await render({ variant: "tab", tab });

    await openFromTabStrip(tab);
    expect(menuButton("Left file browser dock").getAttribute("aria-checked")).toBe("false");
    menuButton("Left file browser dock").click();
    await settle();
    expect(browserSidePanes.left).toBe(true);
    expect(menu(), "the toggle closes the menu").toBeNull();

    closeTabMenu();
    await openFromTabStrip(tab);
    const left = menuButton("Left file browser dock");
    expect(left.getAttribute("role")).toBe("menuitemcheckbox");
    expect(left.getAttribute("aria-checked")).toBe("true");
    expect(left.querySelector(".lucide-check"), "a docked side draws its check").not.toBeNull();
    const right = menuButton("Right file browser dock");
    expect(right.getAttribute("aria-checked")).toBe("false");
    expect(right.querySelector(".lucide-check")).toBeNull();
    right.click();
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
    const flip = [...document.body.querySelectorAll<HTMLButtonElement>(".ctx button")].find(
      (b) => b.querySelector(".menu-row-label")?.textContent === "Flip pane",
    );
    expect(flip).toBeDefined();
    flip!.click();
    expect(onFlip).toHaveBeenCalledTimes(1);
  });
});

describe("the menu's words", () => {
  const HEAD: (Words | "---")[] = [
    { command: "app.browser.newFsEntry" },
    { command: "app.browser.uploadSelection" },
    SELECTION_ACTIONS,
    { command: "app.browser.selectMultiple" },
    "---",
  ];
  const KEYS: (Words | "---")[] = [
    { setting: "browser.vim" },
    { command: "app.browser.keyboardHelp" },
    "---",
  ];
  const DOCKS: Words[] = [
    { command: "app.browser.showWorkspaceInfo" },
    { command: "app.browser.toggleLeftDock" },
    { command: "app.browser.toggleRightDock" },
  ];
  const LAUNCHER: (Words | "---")[] = ["---", { shortcut: "app.launcher.toggle" }];

  test("every row of a tab's menu is a command's title, a setting's label, the launcher's shortcut label or a named exemption", async () => {
    const tab = seat(browserTab());
    await render({ variant: "tab", tab, onFlip: vi.fn() });
    await openFromTabStrip(tab);

    expect(menuRows()).toEqual(
      [
        ...HEAD,
        { command: "app.browser.hiddenFiles" },
        ...KEYS,
        ...DOCKS,
        { command: "app.pane.flip" },
        { command: "app.tab.close" },
        ...LAUNCHER,
      ].map(wordsOf),
    );
  });

  test("every row of a dock's menu is held the same way", async () => {
    const target = await render({ variant: "dock", side: "left" });
    target.querySelector(".browser")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await settle();

    expect(menuRows()).toEqual(
      [...HEAD, ...KEYS, { command: "app.browser.openInBrowser" }, ...DOCKS, ...LAUNCHER].map(wordsOf),
    );
  });

  test("the toolbar's New button is named by the command it runs", async () => {
    const target = await render({ variant: "tab", tab: seat(browserTab()) });
    const button = target.querySelector<HTMLButtonElement>(".new-button")!;

    expect(button.getAttribute("aria-label")).toBe(title("app.browser.newFsEntry"));
    expect(button.title).toBe(title("app.browser.newFsEntry"));
  });

  test("the toolbar's Details button is named by the command it runs, with the key that runs it", async () => {
    const target = await render({ variant: "tab", tab: seat(browserTab()) });
    const button = detailsButton(target);

    expect(title(DETAILS)).toBe("Details");
    expect(button.getAttribute("aria-label")).toBe(title(DETAILS));
    expect(button.title).toBe(`${title(DETAILS)} (Mod+Y)`);
  });

  // The keys that run a catalog command. Every other key moves the cursor
  // or the selection, which the catalog does not list.
  const KEY_COMMANDS: Record<string, string> = {
    open: "app.browser.open",
    rename: "app.browser.renameSelection",
    copy: "app.browser.copySelection",
    cut: "app.browser.cutSelection",
    paste: "app.browser.pasteSelection",
    delete: "app.browser.deleteSelection",
    selectMode: "app.browser.selectMultiple",
  };
  const KEY_WORDS: Record<string, string> = {
    previous: "Previous", next: "Next", parent: "Parent", child: "Child", first: "First", last: "Last",
    pagePrevious: "Page previous", pageNext: "Page next", menu: wordsOf(SELECTION_ACTIONS),
    filter: "Filter", toggle: "Toggle", selectAll: "Select all", clear: "Clear",
  };

  function keyList(target: HTMLElement): (string | null)[] {
    return [...target.querySelectorAll(".keyboard-help dt")].map((dt) => dt.textContent);
  }

  function keyWords(commands: Record<string, string>): string[] {
    return Object.keys(browserBindings).map((key) => (commands[key] ? title(commands[key]) : KEY_WORDS[key]!));
  }

  test("the key list words a key by the command it runs, and the rest by what the key does", async () => {
    const tab = seat(browserTab());
    const target = await render({ variant: "tab", tab });
    await openFromTabStrip(tab);
    menuButton(title("app.browser.keyboardHelp")).click();
    await settle();

    // In a tab the key that previews the selection shows its Details.
    expect(keyList(target)).toEqual(keyWords({ ...KEY_COMMANDS, preview: DETAILS }));
  });

  test("a dock's key list words the preview key by what it runs there", async () => {
    const target = await render({ variant: "dock", side: "left" });
    target.querySelector(".browser")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await settle();
    menuButton(title("app.browser.keyboardHelp")).click();
    await settle();

    // A dock has no Details: the key opens the selection in a tab.
    expect(keyList(target)).toEqual(keyWords({ ...KEY_COMMANDS, preview: "app.browser.openInBrowser" }));
  });
});

describe("Details", () => {
  function shown(target: HTMLElement): boolean {
    return target.querySelector(".inspector") !== null;
  }

  test("the button, the key and the command flip one switch, and each shows the others' change", async () => {
    const tab = seat(browserTab());
    const target = await render({ variant: "tab", tab });
    const command = commandById(DETAILS)!;
    const button = detailsButton(target);
    expect(command.kind).toBe("toggle");
    expect([commandState(DETAILS), button.getAttribute("aria-pressed"), shown(target)]).toEqual([false, "false", false]);

    button.click();
    await settle();
    expect([tab.inspectorOpen, commandState(DETAILS), button.getAttribute("aria-pressed"), shown(target)]).toEqual([
      true, true, "true", true,
    ]);

    command.run();
    await settle();
    expect([tab.inspectorOpen, commandState(DETAILS), button.getAttribute("aria-pressed"), shown(target)]).toEqual([
      false, false, "false", false,
    ]);

    const list = target.querySelector<HTMLElement>('[role="listbox"]')!;
    list.dispatchEvent(new KeyboardEvent("keydown", { key: "y", ctrlKey: true, bubbles: true, cancelable: true }));
    await settle();
    expect([commandState(DETAILS), shown(target)]).toEqual([true, true]);

    command.run();
    await settle();
    expect([button.getAttribute("aria-pressed"), shown(target)]).toEqual(["false", false]);
  });

  test("the command acts on the active file browser tab alone", async () => {
    const tab = seat(browserTab());
    await render({ variant: "tab", tab });
    const pane = layout.nodes[PANE] as LeafNode;
    pane.tabs.push({ kind: "browser", id: "fb-2", title: "Files 2", inspectorOpen: true });
    pane.activeTabId = "fb-2";
    const command = commandById(DETAILS)!;

    expect(commandState(DETAILS)).toBe(true);
    command.run();
    expect((pane.tabs[1] as BrowserTab).inspectorOpen).toBe(false);
    expect(tab.inspectorOpen).toBe(false);
    expect(commandState(DETAILS)).toBe(false);
  });

  test("the command is offered on a file browser tab, and elsewhere says which tab it needs", async () => {
    await render({ variant: "tab", tab: seat(browserTab()) });
    const command = commandById(DETAILS)!;

    expect(command.available(commandContext())).toBe(true);
    expect(commandPlacement(command)).toEqual({ scope: "app", surfaces: ["browser"], group: null });

    const pane = layout.nodes[PANE] as LeafNode;
    pane.tabs.push(terminalTab({ id: "term-1" }));
    pane.activeTabId = "term-1";
    expect(command.available(commandContext())).toBe(false);
    expect(commandUnavailableReason(command, commandContext())).toBe("Needs a file browser tab");
    expect(commandState(DETAILS)).toBeNull();
  });
});

describe("the menu's toggles and their commands", () => {
  function checked(label: string): string | null {
    const row = menuButton(label);
    expect(row.getAttribute("role"), label).toBe("menuitemcheckbox");
    expect(row.querySelector(".lucide-check") !== null, `${label} draws its check only while on`).toBe(
      row.getAttribute("aria-checked") === "true",
    );
    return row.getAttribute("aria-checked");
  }

  function names(target: HTMLElement): string[] {
    return [...target.querySelectorAll('[role="option"] .name')].map((el) => el.textContent!.trim());
  }

  test("Select multiple: the row and the command flip one switch, and each shows the other's change", async () => {
    const tab = seat(browserTab());
    const target = await render({ variant: "tab", tab });
    const command = commandById("app.browser.selectMultiple")!;
    expect(commandState(command.id)).toBe(false);

    await openFromTabStrip(tab);
    expect(checked(command.title)).toBe("false");
    menuButton(command.title).click();
    await settle();
    expect(commandState(command.id)).toBe(true);
    expect(target.querySelector(".selection-mode"), "the footer says rows are being marked").not.toBeNull();

    closeTabMenu();
    await openFromTabStrip(tab);
    expect(checked(command.title)).toBe("true");
    command.run();
    await settle();
    expect(checked(command.title)).toBe("false");
    expect(target.querySelector(".selection-mode")).toBeNull();
  });

  test("Hidden files: the row and the command hide and list the dot entries", async () => {
    const tab = seat(browserTab());
    const target = await render({ variant: "tab", tab });
    tree.entries.push({ path: ".cache", is_dir: true, mtime: null, size: 0 });
    await settle();
    const command = commandById("app.browser.hiddenFiles")!;
    expect(commandState(command.id)).toBe(true);
    expect(names(target)).toEqual([".cache", "notes", "README.md"]);

    await openFromTabStrip(tab);
    expect(checked(command.title)).toBe("true");
    menuButton(command.title).click();
    await settle();
    expect(commandState(command.id)).toBe(false);
    expect(names(target)).toEqual(["notes", "README.md"]);

    command.run();
    await settle();
    expect(names(target)).toEqual([".cache", "notes", "README.md"]);
    closeTabMenu();
    await openFromTabStrip(tab);
    expect(checked(command.title)).toBe("true");
  });

  test("Keyboard shortcuts: the row and the command show and hide the key list", async () => {
    const tab = seat(browserTab());
    const target = await render({ variant: "tab", tab });
    const command = commandById("app.browser.keyboardHelp")!;

    await openFromTabStrip(tab);
    expect(checked(command.title)).toBe("false");
    menuButton(command.title).click();
    await settle();
    expect(commandState(command.id)).toBe(true);
    expect(target.querySelector(".keyboard-help")).not.toBeNull();

    closeTabMenu();
    await openFromTabStrip(tab);
    expect(checked(command.title)).toBe("true");
    command.run();
    await settle();
    expect(target.querySelector(".keyboard-help")).toBeNull();
    expect(checked(command.title)).toBe("false");
  });

  test("the Vim row reads and flips the settings entry it is worded from", async () => {
    const tab = seat(browserTab());
    await render({ variant: "tab", tab });
    const vim = settingEntry("browser.vim");

    await openFromTabStrip(tab);
    expect(checked(vim.label)).toBe("false");
    menuButton(vim.label).click();
    await settle();
    expect(vim.read()).toBe(true);
    expect(browserKeys.vim).toBe(true);

    closeTabMenu();
    await openFromTabStrip(tab);
    expect(checked(vim.label)).toBe("true");
    expect(menuChord(title("app.browser.selectMultiple")), "the marking key follows the keymap").toBe("v");
  });

  test("a dock row is checked by the state its command reports", async () => {
    const tab = seat(browserTab());
    await render({ variant: "tab", tab });
    const left = commandById("app.browser.toggleLeftDock")!;

    await openFromTabStrip(tab);
    expect(checked(left.title)).toBe("false");
    left.run();
    await settle();
    expect(checked(left.title)).toBe("true");
  });

  test("a surface shown again starts from the defaults", async () => {
    const tab = seat(browserTab());
    await render({ variant: "tab", tab });
    commandById("app.browser.hiddenFiles")!.run();
    commandById("app.browser.selectMultiple")!.run();
    await settle();
    expect(commandState("app.browser.hiddenFiles")).toBe(false);

    for (const app of mounted.splice(0)) unmount(app);
    await settle(2);
    expect(commandState("app.browser.hiddenFiles")).toBe(true);
    expect(commandState("app.browser.selectMultiple")).toBe(false);
  });
});

describe("the launcher from the menu", () => {
  test("the launcher row closes the menu and asks for the launcher with the keyboard back on the list", async () => {
    const tab = seat(browserTab());
    const target = await render({ variant: "tab", tab });
    // What held the keyboard as the launcher was asked for is what the
    // launcher hands it back to when it closes.
    const heldAtOpen: (Element | null)[] = [];
    const onCommand = (e: Event): void => {
      if ((e as CustomEvent).detail?.name === "app.launcher.toggle") heldAtOpen.push(document.activeElement);
    };
    window.addEventListener("chan:command", onCommand);
    try {
      await openFromTabStrip(tab);
      menuButton(wordsOf({ shortcut: "app.launcher.toggle" })).click();
      await settle();
    } finally {
      window.removeEventListener("chan:command", onCommand);
    }

    expect(heldAtOpen).toEqual([target.querySelector('[role="listbox"]')]);
    expect(menu()).toBeNull();
  });
});

describe("the launcher's Open", () => {
  function open(): void {
    commandById("app.browser.open")!.run();
  }

  test("enters the selected directory, as Enter does", async () => {
    const tab = seat(browserTab({ selected: "notes" }));
    await render({ variant: "tab", tab });
    expect(tab.directory).toBe("");

    open();
    await settle();
    expect(tab.directory).toBe("notes");
  });

  test("is answered by the active file browser tab alone", async () => {
    const tab = seat(browserTab({ selected: "notes" }));
    await render({ variant: "tab", tab });
    // Another tab takes the pane: the surface is still mounted here, and the
    // launcher is no longer aimed at it.
    const pane = layout.nodes[PANE] as LeafNode;
    pane.tabs.push({ kind: "browser", id: "fb-2", title: "Files 2", inspectorOpen: false });
    pane.activeTabId = "fb-2";

    open();
    await settle();
    expect(tab.directory).toBe("");
  });
});

describe("the launcher's Open in new file browser", () => {
  function open(): void {
    commandById("app.browser.openInBrowser")!.run();
  }

  /// A seated tab listing the root, with `paths` selected in it.
  async function select(paths: string[]): Promise<BrowserTab> {
    const tab = seat(browserTab({ id: "existing", selected: paths.at(-1), selectedPaths: paths }));
    await render({ variant: "tab", tab });
    return tab;
  }

  test("reveals the selected file in a new tab, in its folder with Details shown", async () => {
    await select(["notes/a.md"]);

    open();
    const [opened] = openedTabs("existing");
    expect(opened).toMatchObject({ directory: "notes", selected: "notes/a.md", inspectorOpen: true });
    expect(opened!.showWorkspace).toBeFalsy();
  });

  test("reveals a selected directory in the folder that holds it", async () => {
    await select(["notes"]);

    open();
    expect(openedTabs("existing")[0]).toMatchObject({ directory: "", selected: "notes", inspectorOpen: true });
  });

  test("with nothing selected opens on the workspace, with its details", async () => {
    await select([]);

    open();
    const [opened] = openedTabs("existing");
    expect(opened).toMatchObject({ showWorkspace: true, inspectorOpen: true });
    expect(opened!.selected).toBeUndefined();
  });

  test("leaves the tab it was run from as it was", async () => {
    const tab = await select(["notes", "README.md"]);
    const source = fbTreeInstance("fb-tab-existing")!.selection;
    expect(source.paths).toEqual(["notes", "README.md"]);

    open();
    await settle();
    expect(source.paths).toEqual(["notes", "README.md"]);
    expect(source.showWorkspace).toBe(false);
    expect(tab.selectedPaths).toEqual(["notes", "README.md"]);
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
    detailsButton(target).click();
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

  test("the workspace's New graph here opens the workspace graph in a new tab", async () => {
    const target = await workspaceInspector();
    expect(await inspectorActions(target)).toContain("New graph here");
    [...target.querySelectorAll<HTMLButtonElement>(".inspector .action-menu-item")]
      .find((b) => b.textContent?.trim() === "New graph here")!
      .click();
    await settle();
    const graph = (layout.nodes[PANE] as LeafNode).tabs.find((t) => t.kind === "graph");
    expect(graph).toMatchObject({ mode: "semantic", scopeId: "workspace" });
  });

  test("a window without a workspace offers no graph from the inspector or the tree", async () => {
    caps.workspace = false;
    const target = await workspaceInspector();
    expect(await inspectorActions(target)).not.toContain("New graph here");

    const row = [...target.querySelectorAll<HTMLElement>("[role='treeitem'], [role='option']")].find(
      (el) => el.querySelector(".name")?.textContent?.trim() === "notes",
    );
    row!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }));
    await settle();
    const labels = [...document.body.querySelectorAll(".ctx .menu-row-label")].map((el) => el.textContent);
    expect(labels).toContain("Delete");
    expect(labels).not.toContain("New graph here");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    const readme = [...target.querySelectorAll<HTMLElement>("[role='treeitem'], [role='option']")].find(
      (el) => el.querySelector(".name")?.textContent?.trim() === "README.md",
    );
    readme!.querySelector<HTMLElement>(".name")!.click();
    await settle();
    const fileActions = await inspectorActions(target);
    expect(fileActions).toContain("Download");
    expect(fileActions).not.toContain("New graph here");
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

  test("a directory row offers one New file or directory entry, which opens the file-or-directory prompt there", async () => {
    const tab = seat(browserTab());
    const target = await render({ variant: "tab", tab, onFlip: vi.fn() });
    const rows = await rowMenu(target, "notes");
    expect(rows.filter((r) => /^New (file|directory)/.test(r)), "no separate New file or New directory").toEqual([
      "New file or directory",
    ]);

    const entry = [...document.body.querySelectorAll<HTMLButtonElement>(".ctx > button")].find(
      (b) => b.textContent?.trim() === "New file or directory",
    );
    entry!.click();
    await settle();
    expect(pathPromptState.open).toBe(true);
    expect(pathPromptState.kind).toBe("either");
    expect(pathPromptState.defaultValue).toBe("notes/");
    expect(document.body.querySelector(".ctx"), "the menu closed").toBeNull();
  });

  test("a file row has no create entry, and Flip pane and the launcher close the menu after a separator", async () => {
    const tab = seat(browserTab());
    const target = await render({ variant: "tab", tab, onFlip: vi.fn() });
    const rows = await rowMenu(target, "README.md");
    expect(document.body.querySelector(".ctx")!.parentElement, "portaled to the page body").toBe(document.body);
    expect(rows.some((r) => /^New (file|directory)/.test(r))).toBe(false);
    expect(rows.slice(-3)).toEqual(["---", "Flip pane", "Command launcher"]);
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

  test("offers Open in new file browser before the dock rows, and no Flip pane or Close tab", async () => {
    const target = await render({ variant: "dock", side: "left" });
    target.querySelector(".browser")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await settle();

    const rows = menuRows();
    expect(rows.slice(-6)).toEqual([
      "Open in new file browser", "Workspace details", "Left file browser dock", "Right file browser dock", "---",
      "Command launcher",
    ]);
    expect(rows).not.toContain("Close tab");
    expect(rows).not.toContain("Flip pane");
  });

  /// A left dock beside a seated tab, with `path` selected in the dock, and
  /// its Open in new file browser row clicked.
  async function openFromDock(path: string | null): Promise<BrowserTab> {
    seat(browserTab({ id: "existing" }));
    const target = await render({ variant: "dock", side: "left" });
    target.querySelector<HTMLElement>('[role="tree"]')!.focus();
    browserSelection.path = path;
    browserSelection.paths = path ? [path] : [];
    target.querySelector(".browser")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await settle();

    menuButton(title("app.browser.openInBrowser")).click();
    await settle();
    const opened = openedTabs("existing");
    expect(opened).toHaveLength(1);
    return opened[0]!;
  }

  test("Open in new file browser opens a tab in the selection's directory", async () => {
    const opened = await openFromDock("notes/a.md");

    expect(opened.inspectorOpen).toBe(true);
    expect(opened.directory).toBe("notes");
    expect(opened.selected).toBe("notes/a.md");
    expect(opened.showWorkspace).toBeFalsy();
    expect(fbTreeInstance("fb-dock-left")!.selection.path, "the dock keeps its selection").toBe("notes/a.md");
    expect(menu()).toBeNull();
  });

  test("Open in new file browser opens a selected directory itself", async () => {
    const opened = await openFromDock("notes");

    expect(opened.directory).toBe("notes");
    expect(opened.showWorkspace).toBeFalsy();
  });

  test("Open in new file browser with nothing selected opens a file browser on the root", async () => {
    const opened = await openFromDock(null);

    expect(opened.directory ?? "").toBe("");
    expect(opened.selected).toBeUndefined();
    expect(opened.showWorkspace).toBeFalsy();
  });

  test("the tab a dock opens shows Details by the screen's width, as a new file browser does", async () => {
    const width = window.innerWidth;
    try {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 500 });
      expect((await openFromDock("notes/a.md")).inspectorOpen).toBe(false);
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    }
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
    const labels = [...document.body.querySelectorAll(".ctx .menu-row-label")].map((el) => el.textContent);
    expect(labels).toContain("Delete");
    expect(labels).not.toContain("Flip pane");
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
    const flip = [...document.body.querySelectorAll<HTMLButtonElement>(".ctx button")].find(
      (b) => b.querySelector(".menu-row-label")?.textContent === "Flip pane",
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
