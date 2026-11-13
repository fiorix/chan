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

vi.mock("../state/fileActionExecutors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/fileActionExecutors")>()),
  exportPathToPdf: vi.fn(async () => {}),
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
import { exportPathToPdf } from "../state/fileActionExecutors";
import { filesContext } from "../state/fileContext.svelte";
import {
  browserSelection,
  fbSelectSingle,
  fbTreeInstance,
  fileOps,
  loadTreeDir,
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
import {
  activeBrowserTab,
  closeTab,
  layout,
  paneSide,
  reopenClosedTab,
  selectTabInPane,
  type BrowserTab,
  type LeafNode,
} from "../state/tabs.svelte";
import { fileTab, terminalTab } from "../__tests__/tabs";

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
  // Every test seats a tab under one id, and a tab's view switches last as
  // long as a layout holds the tab: close them all, so the next test's tab
  // is a new one.
  layout.nodes = { [PANE]: { kind: "leaf", id: PANE, tabs: [], activeTabId: null } };
  layout.rootId = PANE;
  layout.activePaneId = PANE;
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
      "Hidden files", settingEntry("browser.vim").label, "Keyboard shortcuts (file browser)", "Details", "---",
      "Workspace details", "Left file browser dock", "Right file browser dock", "Close tab", "---",
      "Command launcher",
    ]);
    expect(menuChord("Selection actions")).toBe("Shift+F10");
    expect(menuChord("Select multiple")).toBe("F8");
    expect(menuChord("Details")).toBe("Mod+Y");
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
  const KEYS: Words[] = [
    { setting: "browser.vim" },
    { command: "app.browser.keyboardHelp" },
  ];
  const DOCKS: Words[] = [
    { command: "app.browser.showWorkspaceInfo" },
    { command: "app.browser.toggleLeftDock" },
    { command: "app.browser.toggleRightDock" },
  ];
  const LAUNCHER: (Words | "---")[] = ["---", { shortcut: "app.launcher.toggle" }];
  const SEP: "---" = "---";

  test("every row of a tab's menu is a command's title, a setting's label, the launcher's shortcut label or a named exemption", async () => {
    const tab = seat(browserTab());
    await render({ variant: "tab", tab, onFlip: vi.fn() });
    await openFromTabStrip(tab);

    expect(menuRows()).toEqual(
      [
        ...HEAD,
        { command: "app.browser.hiddenFiles" },
        ...KEYS,
        { command: DETAILS },
        SEP,
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
      [...HEAD, ...KEYS, SEP, { command: "app.browser.openInBrowser" }, ...DOCKS, ...LAUNCHER].map(wordsOf),
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

  /// The menu's Details row, which a tab's menu draws with a check.
  function detailsRow(): HTMLButtonElement {
    const row = menuButton(title(DETAILS));
    expect(row.getAttribute("role")).toBe("menuitemcheckbox");
    expect(row.querySelector(".lucide-check") !== null, "the row draws its check only while on").toBe(
      row.getAttribute("aria-checked") === "true",
    );
    return row;
  }

  test("the menu's row is the command's title with the button's key, and shows and hides the panel", async () => {
    const tab = seat(browserTab());
    const target = await render({ variant: "tab", tab });
    const button = detailsButton(target);
    await openFromTabStrip(tab);

    expect(rowLabel(detailsRow())).toBe(title(DETAILS));
    expect(button.title).toBe(`${title(DETAILS)} (${menuChord(title(DETAILS))})`);
    expect(detailsRow().getAttribute("aria-checked")).toBe("false");

    detailsRow().click();
    await settle();
    expect(menu(), "the row closes the menu").toBeNull();
    expect([tab.inspectorOpen, commandState(DETAILS), button.getAttribute("aria-pressed"), shown(target)]).toEqual([
      true, true, "true", true,
    ]);

    closeTabMenu();
    await openFromTabStrip(tab);
    detailsRow().click();
    await settle();
    expect([tab.inspectorOpen, commandState(DETAILS), button.getAttribute("aria-pressed"), shown(target)]).toEqual([
      false, false, "false", false,
    ]);
  });

  test("the menu's row is checked while the panel is shown, whoever showed it", async () => {
    const tab = seat(browserTab());
    const target = await render({ variant: "tab", tab });
    const command = commandById(DETAILS)!;
    const checkedNow = async (): Promise<string | null> => {
      closeTabMenu();
      await openFromTabStrip(tab);
      return detailsRow().getAttribute("aria-checked");
    };

    detailsButton(target).click();
    await settle();
    expect(await checkedNow(), "after the button").toBe("true");

    command.run();
    await settle();
    expect(await checkedNow(), "after the command").toBe("false");

    target.querySelector<HTMLElement>('[role="listbox"]')!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "y", ctrlKey: true, bubbles: true, cancelable: true }),
    );
    await settle();
    expect(await checkedNow(), "after the key").toBe("true");

    target.querySelector<HTMLButtonElement>(".inspector button.close")!.click();
    await settle();
    expect(shown(target), "the panel's own close hid it").toBe(false);
    expect(await checkedNow(), "after the panel's close").toBe("false");
  });

  // A dock draws no panel, and the command acts on the active tab, which a
  // dock is not: a row there would flip another tab's panel or nothing.
  test("a dock's menu has no Details row, even while the command is offered for the active tab", async () => {
    seat(browserTab());
    const target = await render({ variant: "dock", side: "left" });
    expect(commandById(DETAILS)!.available(commandContext()), "the active tab is a file browser").toBe(true);

    target.querySelector(".browser")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await settle();
    expect(menu(), "the dock's menu is open").not.toBeNull();
    expect(menuRows()).not.toContain(title(DETAILS));
    expect(target.querySelector(".inspector")).toBeNull();
  });

  // The panel acts on the selection by its path, the server's copy. Saving
  // an open file first is its editor's panel's alone.
  test("Download and Export to PDF ask for the selection's path at once, with no save of an editor tab on it", async () => {
    const tab = seat(browserTab({ inspectorOpen: true }));
    (layout.nodes[PANE] as LeafNode).tabs.push(
      fileTab({ id: "open-readme", path: "README.md", content: "typed", saved: "hi" }),
    );
    const target = await render({ variant: "tab", tab });
    const write = vi.spyOn(api, "write");
    const download = vi.spyOn(fileOps, "downloadPathWithProgress").mockImplementation(() => {});
    vi.mocked(exportPathToPdf).mockClear();
    /// Opens the caret menu and presses the action of the command `id`.
    const press = async (id: string): Promise<void> => {
      target.querySelector<HTMLButtonElement>(".inspector .pill-caret")!.click();
      await settle(2);
      const found = [...target.querySelectorAll<HTMLButtonElement>(".inspector .action-menu-item")].find(
        (el) => el.textContent?.trim() === title(id),
      );
      if (!found) throw new Error(`no Details action ${title(id)}`);
      found.click();
      await settle(2);
    };

    [...target.querySelectorAll<HTMLElement>("[role='treeitem'], [role='option']")]
      .find((el) => el.querySelector(".name")?.textContent?.trim() === "README.md")!
      .querySelector<HTMLElement>(".name")!
      .click();
    await settle();
    await press("app.browser.downloadSelection");
    await press("app.browser.exportPdf");

    expect(download.mock.calls).toEqual([["README.md", false]]);
    expect(vi.mocked(exportPathToPdf).mock.calls).toEqual([["README.md"]]);
    expect(write, "no save was asked").not.toHaveBeenCalled();
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

});

// The three switches are a tab's own for as long as the tab is open. A pane
// draws one surface for whichever of its tabs is active, so the surface goes
// with every tab switch and the switches must not go with it.
describe("a tab's switches", () => {
  const HIDDEN = "app.browser.hiddenFiles";
  const MULTIPLE = "app.browser.selectMultiple";
  const KEYS = "app.browser.keyboardHelp";

  function names(target: HTMLElement): string[] {
    return [...target.querySelectorAll('[role="option"] .name')].map((el) => el.textContent!.trim());
  }

  /// What the active file browser tab's three switches read, as the catalog
  /// reports them: hidden files, select multiple, key list.
  function switches(): Array<string | boolean | null> {
    return [HIDDEN, MULTIPLE, KEYS].map((id) => commandState(id));
  }

  /// A pane holding two file browser tabs and a terminal, the first tab
  /// shown, with a dot entry in the workspace to list or hide.
  async function paneOfTabs(): Promise<{ target: HTMLElement; pane: LeafNode }> {
    seat(browserTab());
    const pane = layout.nodes[PANE] as LeafNode;
    pane.tabs.push(browserTab({ id: "fb-2", title: "Files 2" }), terminalTab({ id: "term-1" }));
    tree.entries.push({ path: ".cache", is_dir: true, mtime: null, size: 0 });
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(Pane, { target, props: { pane } }));
    await settle();
    return { target, pane };
  }

  async function show(pane: LeafNode, id: string): Promise<void> {
    selectTabInPane(pane.id, id);
    await settle();
  }

  test("last while the pane shows its other tabs, each tab keeping its own", async () => {
    const { target, pane } = await paneOfTabs();
    expect([switches(), names(target)]).toEqual([[true, false, false], [".cache", "notes", "README.md"]]);
    commandById(HIDDEN)!.run();
    commandById(KEYS)!.run();
    await settle();
    expect([switches(), names(target)]).toEqual([[false, false, true], ["notes", "README.md"]]);

    await show(pane, "fb-2");
    expect([switches(), names(target)], "the second tab reads its own").toEqual([
      [true, false, false],
      [".cache", "notes", "README.md"],
    ]);
    commandById(MULTIPLE)!.run();
    await settle();

    await show(pane, "fb-1");
    expect([switches(), names(target)], "back on the first").toEqual([[false, false, true], ["notes", "README.md"]]);
    expect(target.querySelector(".keyboard-help"), "its key list is shown again").not.toBeNull();

    await show(pane, "term-1");
    expect(target.querySelector(".browser"), "no surface is drawn").toBeNull();
    await show(pane, "fb-2");
    expect(switches(), "the second, after a tab that is no file browser").toEqual([true, true, false]);
    expect(target.querySelector(".selection-mode")).not.toBeNull();
  });

  test("go when the tab closes, shown or not, and a reopened tab starts from the defaults", async () => {
    const { pane } = await paneOfTabs();
    commandById(HIDDEN)!.run();
    await show(pane, "fb-2");
    commandById(MULTIPLE)!.run();
    await settle();

    // The first tab closes in the background, the second while shown.
    await closeTab(pane.id, "fb-1");
    await closeTab(pane.id, "fb-2");
    await settle();
    expect(pane.tabs.map((tab) => tab.id)).toEqual(["term-1"]);

    expect(reopenClosedTab()).toBe(true);
    await settle();
    expect([activeBrowserTab()?.id, switches()]).toEqual(["fb-2", [true, false, false]]);
    expect(reopenClosedTab()).toBe(true);
    await settle();
    expect([activeBrowserTab()?.id, switches()]).toEqual(["fb-1", [true, false, false]]);
  });

  test("a dock's last as long as the dock is shown", async () => {
    const target = await render({ variant: "dock", side: "left" });
    target.querySelector<HTMLButtonElement>(".keyboard-status")!.click();
    await settle();
    expect(target.querySelector(".keyboard-help")).not.toBeNull();

    for (const app of mounted.splice(0)) unmount(app);
    await settle(2);
    const again = await render({ variant: "dock", side: "left" });
    expect(again.querySelector(".keyboard-help"), "a dock shown again starts from the defaults").toBeNull();
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

// The menu's Upload and the launcher's Upload pick one directory: the one the
// surface is in, which its New and Paste choose too. Neither replaces a
// file; that is the Upload of the file's own row menu.
describe("Upload from the menu and from the launcher", () => {
  const UPLOAD = "app.browser.uploadSelection";
  const HOME = "notes/sub";

  beforeEach(async () => {
    uninstallDemoWorkspace();
    installDemoWorkspace({
      metadata: { workspaceRoot: "demo", label: "demo", generatedAt: 1_700_000_000_000, fileCount: 3, textCount: 3 },
      files: [
        { path: "notes/a.md", kind: "document", size: 5, mtime: 100, content: "hello" },
        { path: "notes/sub/b.md", kind: "document", size: 5, mtime: 100, content: "deep" },
        { path: "README.md", kind: "document", size: 5, mtime: 100, content: "hi" },
      ],
    });
    await refreshWorkspace();
    await refreshTree();
    await loadTreeDir("notes");
    vi.spyOn(fileOps, "uploadFilesTo").mockResolvedValue(undefined);
    vi.spyOn(fileOps, "replaceFileAt").mockResolvedValue(undefined);
  });

  afterEach(() => {
    filesContext.current = null;
  });

  /// Where the upload `act` asks for goes: the directory its picker
  /// uploads into, the file it replaces, or no picker at all, and how many
  /// pickers it raised where that is more than one.
  async function target(act: () => void | Promise<void>): Promise<string> {
    const into = vi.mocked(fileOps.uploadFilesTo);
    const over = vi.mocked(fileOps.replaceFileAt);
    into.mockClear();
    over.mockClear();
    const before = document.querySelectorAll('input[type="file"]').length;
    await act();
    const inputs = [...document.querySelectorAll<HTMLInputElement>('input[type="file"]')];
    const raised = inputs.length - before;
    if (raised === 0) return "no picker";
    const input = inputs[inputs.length - 1]!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["x"], "x.txt")] });
    input.dispatchEvent(new Event("change"));
    const extra = raised > 1 ? ` (${raised} pickers)` : "";
    if (over.mock.calls.length > 0) return `replace ${over.mock.calls[0]![0]}${extra}`;
    return `${input.multiple ? "many" : "one"} into ${into.mock.calls[0]?.[0]}${extra}`;
  }

  type Case = {
    name: string;
    variant: "tab" | "dock";
    standalone?: boolean;
    selected: string | null;
    expected: string;
  };
  const CASES: Case[] = [
    { name: "a list with a file selected", variant: "tab", selected: "notes/a.md", expected: "notes" },
    { name: "a list with a directory selected", variant: "tab", selected: "notes/sub", expected: "notes" },
    { name: "a list with nothing selected", variant: "tab", selected: null, expected: "notes" },
    { name: "a tree with a directory selected", variant: "dock", selected: "notes", expected: "notes" },
    { name: "a tree with a file selected", variant: "dock", selected: "notes/a.md", expected: "notes" },
    { name: "a tree with nothing selected", variant: "dock", selected: null, expected: "" },
    { name: "a standalone window's list with nothing selected", variant: "tab", standalone: true, selected: null, expected: "notes" },
    { name: "a standalone window's tree with a directory selected", variant: "dock", standalone: true, selected: "notes", expected: "notes" },
    // The tree's root is the filesystem's: nothing selected starts at home.
    { name: "a standalone window's tree with nothing selected", variant: "dock", standalone: true, selected: null, expected: HOME },
  ];

  test.each(CASES)("$name: the row and the command upload many files into one directory", async (c) => {
    if (c.standalone) {
      caps.workspace = false;
      filesContext.current = { rootDisplay: "/", rootWire: "", homeWire: HOME, identity: "files" };
    }
    // The command is offered on a file browser tab; a dock's selection is
    // the one it acts on while the dock holds the keyboard.
    const tab = seat(browserTab({ directory: "notes" }));
    const surface = c.variant === "tab" ? await render({ variant: "tab", tab }) : await render({ variant: "dock", side: "left" });
    const id = c.variant === "tab" ? `fb-tab-${tab.id}` : "fb-dock-left";
    surface.querySelector(".browser")!.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    fbSelectSingle(c.selected, fbTreeInstance(id)!.selection);
    await settle();
    const command = commandById(UPLOAD)!;
    expect(command.available(commandContext()), "the command is offered").toBe(true);

    const fromRow = await target(async () => {
      if (c.variant === "tab") await openFromTabStrip(tab);
      else {
        surface.querySelector(".browser")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
        await settle();
      }
      menuButton(title(UPLOAD)).click();
    });
    const fromCommand = await target(() => command.run());

    expect({ fromRow, fromCommand }).toEqual({ fromRow: `many into ${c.expected}`, fromCommand: `many into ${c.expected}` });
  });

  test("the command is answered by the surface the selection commands act on, and by it alone", async () => {
    const tab = seat(browserTab({ directory: "notes/sub" }));
    const list = await render({ variant: "tab", tab });
    const dock = await render({ variant: "dock", side: "left" });
    fbSelectSingle("notes", fbTreeInstance("fb-dock-left")!.selection);
    const command = commandById(UPLOAD)!;

    dock.querySelector(".browser")!.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(await target(() => command.run()), "the dock holds the keyboard").toBe("many into notes");

    list.querySelector(".browser")!.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(await target(() => command.run()), "the tab holds the keyboard").toBe("many into notes/sub");
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
    expect(graph, "the graph, on the workspace's own node").toMatchObject({ kind: "graph", pendingSelectId: "" });
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
    // Seated in the focused pane, the tree holds the keyboard from the mount.
    const target = await render({ variant: "tab", tab, focused: true });
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
