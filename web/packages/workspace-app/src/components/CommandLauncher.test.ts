// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const scopedLibrary = vi.hoisted(() => ({
  load: vi.fn(),
  run: vi.fn(),
}));

vi.mock("../state/commands/install", () => ({}));
vi.mock("../api/libraryCommand", () => ({
  loadScopedLibrarySnapshot: scopedLibrary.load,
  runScopedLibraryAction: scopedLibrary.run,
}));

import CommandLauncher from "./CommandLauncher.svelte";
import deckRaw from "../../../web-shared/src/components/CommandDeck.svelte?raw";
import {
  clearLauncherDraft,
  launcherDraft,
  launcherPanel,
  overlayStack,
  searchPanel,
  syncOverlayStack,
  topOverlay,
} from "../state/store.svelte";
import { registerCommands } from "../state/commands";
import {
  layout,
  type BrowserTab,
  type ExtensionTab,
  type LeafNode,
  type TerminalTab,
} from "../state/tabs.svelte";

Element.prototype.scrollIntoView = vi.fn();

const runSearch = vi.fn();
const runNewFile = vi.fn();
const runBrowserAlpha = vi.fn();
const runBrowserZoom = vi.fn();
const runFlip = vi.fn();
let overlayAtFlipRun: ReturnType<typeof topOverlay> = null;
let showFlip = false;
// Off by default so the ordering assertions above keep their small, exact
// command sets; the scope tests flip it on to fill the Tab scope past the
// root deck's five rows.
let showBulk = false;

registerCommands([
  {
    id: "app.window.reload",
    title: "Search",
    category: "Global",
    requirement: "any",
    keywords: ["find"],
    available: () => true,
    run: runSearch,
  },
  {
    id: "app.file.new",
    title: "New file",
    category: "Editor",
    requirement: "any",
    keywords: ["create"],
    available: () => true,
    run: runNewFile,
  },
  {
    id: "app.browser.alpha",
    title: "Alpha browser",
    category: "File Browser",
    requirement: "any",
    keywords: ["files"],
    available: () => true,
    run: runBrowserAlpha,
  },
  {
    id: "app.browser.zoom",
    title: "Zoom browser",
    category: "File Browser",
    requirement: "any",
    keywords: ["files"],
    available: () => true,
    run: runBrowserZoom,
  },
  {
    id: "app.pane.flip",
    title: "Flip pane",
    category: "Global",
    requirement: "any",
    available: () => showFlip,
    run: () => {
      overlayAtFlipRun = topOverlay();
      if (overlayAtFlipRun === null) runFlip();
    },
  },
]);

const BULK_BROWSER_TITLES = [
  "Bulk five",
  "Bulk four",
  "Bulk one",
  "Bulk seven",
  "Bulk six",
  "Bulk three",
  "Bulk two",
];

registerCommands([
  ...BULK_BROWSER_TITLES.map((title, index) => ({
    id: `app.browser.bulk${index}`,
    title,
    category: "File Browser" as const,
    requirement: "any" as const,
    available: () => showBulk,
    run: () => {},
  })),
  {
    id: "app.tab.close",
    title: "Close tab",
    category: "Tabs",
    requirement: "any",
    available: () => showBulk,
    run: () => {},
  },
  {
    id: "app.terminal.copyCwd",
    title: "Copy path to $CWD",
    category: "Terminal",
    requirement: "any",
    available: () => showBulk,
    run: () => {},
  },
  {
    id: "app.terminal.restart",
    title: "Restart terminal",
    category: "Terminal",
    requirement: "any",
    available: () => showBulk,
    run: () => {},
  },
  {
    id: "extension.alpha",
    title: "Alpha app",
    category: "Apps",
    requirement: "any",
    available: () => showBulk,
    run: () => {},
  },
  {
    id: "extension.alpha.run",
    title: "Run alpha",
    category: "Apps",
    requirement: "any",
    available: () => showBulk,
    run: () => {},
  },
  {
    id: "extension.beta.run",
    title: "Run beta",
    category: "Apps",
    requirement: "any",
    available: () => showBulk,
    run: () => {},
  },
]);

const librarySnapshot = {
  library_id: "lib-local-test",
  role: "owner" as const,
  windows: [
    {
      window_id: "control-1",
      kind: "terminal" as const,
      title: "Control terminal",
      ordinal: 1,
      // A control row never carries a caption: the mint leaves it empty
      // (`WindowRegistry::create_control`) and the label route refuses to set
      // one on a control window.
      label: "",
      workspace_path: null,
      connected: true,
      hidden: false,
      control: true,
      can_act: true,
      launch_path: "/api/library/command-capabilities/cap/windows/control-1/launch",
    },
    {
      window_id: "w-captioned",
      kind: "workspace" as const,
      // The library composes `title` from its own perspective and the deck
      // never parses it; the caption is the separate `label`.
      title: "an intentionally unrelated title",
      ordinal: 2,
      label: "release checks",
      workspace_path: "/work/project-a",
      connected: true,
      hidden: false,
      control: false,
      can_act: true,
      launch_path: "/api/library/command-capabilities/cap/windows/w-captioned/launch",
    },
  ],
  workspaces: [
    {
      workspace_id: "project-a",
      path: "/work/project-a",
      label: "Project A",
      on: true,
      status: "running" as const,
      library_id: "lib-local-test",
      devserver_id: null,
      prefix: "project-a",
      can_act: true,
    },
  ],
};

const mounted: Array<Record<string, unknown>> = [];

function resetLayout(): LeafNode {
  const pane: LeafNode = {
    kind: "leaf",
    id: "command-launcher-pane",
    tabs: [],
    activeTabId: null,
  };
  layout.rootId = pane.id;
  layout.activePaneId = pane.id;
  layout.nodes = { [pane.id]: pane };
  layout.focusColor = "blue";
  return pane;
}

function setActiveBrowserTab(): void {
  const pane = resetLayout();
  const tab: BrowserTab = {
    kind: "browser",
    id: "browser-test",
    title: "Files",
    inspectorOpen: false,
  };
  pane.tabs = [tab];
  pane.activeTabId = tab.id;
}

// "Tabs" sorts before "Terminal" alphabetically, so a terminal is the surface
// that proves the app-first rank rather than plain category order.
function setActiveTerminalTab(): void {
  const pane = resetLayout();
  const tab: TerminalTab = {
    kind: "terminal",
    id: "terminal-test",
    title: "Shell",
    createdAt: 0,
    broadcastEnabled: false,
    broadcastTargetIds: [],
  };
  pane.tabs = [tab];
  pane.activeTabId = tab.id;
}

function setActiveExtensionTab(): void {
  const pane = resetLayout();
  const tab: ExtensionTab = {
    kind: "extension",
    id: "extension-test",
    title: "Alpha app",
    extensionId: "alpha",
  };
  pane.tabs = [tab];
  pane.activeTabId = tab.id;
}

async function flush(): Promise<void> {
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
}

function openLauncher(): HTMLElement {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(CommandLauncher, { target }) as Record<string, unknown>);
  launcherPanel.open = true;
  return target;
}

function dialog(target: HTMLElement): HTMLElement {
  return target.querySelector('[role="dialog"]') as HTMLElement;
}

function row(target: HTMLElement, title: string): HTMLButtonElement {
  const found = [...target.querySelectorAll<HTMLButtonElement>(".deck-result")].find(
    (candidate) => candidate.querySelector(".deck-result-title")?.textContent === title,
  );
  if (!found) throw new Error(`missing row ${title}; visible: ${titles(target).join(", ")}`);
  return found;
}

async function openTabScope(target: HTMLElement): Promise<void> {
  (target.querySelector('[aria-label="Tab scope"]') as HTMLButtonElement).click();
  await tick();
}

function input(target: HTMLElement): HTMLInputElement {
  return target.querySelector(".deck-input") as HTMLInputElement;
}

function titles(target: HTMLElement): string[] {
  return [...target.querySelectorAll(".deck-result-title")].map((node) => node.textContent ?? "");
}

function clonedSessionStorage(source: Storage): Storage {
  const values = new Map<string, string>();
  for (let index = 0; index < source.length; index += 1) {
    const key = source.key(index);
    if (key !== null) values.set(key, source.getItem(key) ?? "");
  }
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

async function typeQuery(target: HTMLElement, query: string): Promise<void> {
  const field = input(target);
  field.value = query;
  field.dispatchEvent(new InputEvent("input", { bubbles: true, data: query }));
  await tick();
}

async function key(target: HTMLElement, value: string): Promise<void> {
  dialog(target).dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true }));
  await tick();
}

beforeEach(() => {
  sessionStorage.clear();
  clearLauncherDraft();
  launcherPanel.open = false;
  resetLayout();
  searchPanel.open = false;
  overlayStack.ids = [];
  overlayAtFlipRun = null;
  showFlip = false;
  showBulk = false;
  scopedLibrary.load.mockResolvedValue(librarySnapshot);
  scopedLibrary.run.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const component of mounted.splice(0)) unmount(component);
  document.body.innerHTML = "";
  launcherPanel.open = false;
  searchPanel.open = false;
  overlayStack.ids = [];
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("contextual command deck", () => {
  test("renders nothing while closed", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(CommandLauncher, { target }) as Record<string, unknown>);
    await flush();
    expect(target.querySelector(".deck-shell")).toBeNull();
  });

  test("opens focused with contextual results and four persistent scope orbs", async () => {
    const target = openLauncher();
    await flush();
    expect(document.activeElement).toBe(input(target));
    expect(titles(target)).toEqual(["New file", "Alpha browser", "Zoom browser", "Search"]);
    expect(target.querySelectorAll(".deck-scope")).toHaveLength(4);
    expect(target.querySelector('[aria-label="Computers scope"]')?.hasAttribute("disabled")).toBe(false);
  });

  test("orders commands for the focused tab before pane and window commands", async () => {
    setActiveBrowserTab();
    const target = openLauncher();
    await flush();
    expect(titles(target).slice(0, 2)).toEqual(["Alpha browser", "Zoom browser"]);
    expect(target.querySelector(".deck-result-path")?.textContent).toBe("Tab › File Browser");
  });

  test("the Tab scope lists every command for the active application", async () => {
    showBulk = true;
    setActiveBrowserTab();
    const target = openLauncher();
    await flush();
    // The root deck stays a teaser, so the surface's own actions were only
    // ever reachable by guessing a search string.
    expect(titles(target)).toHaveLength(5);

    await openTabScope(target);
    const shown = titles(target);
    for (const title of [...BULK_BROWSER_TITLES, "Alpha browser", "Zoom browser", "Close tab"]) {
      expect(shown).toContain(title);
    }
    expect(shown).toHaveLength(10);
  });

  test("the active application's commands lead the generic tab commands", async () => {
    showBulk = true;
    setActiveTerminalTab();
    const target = openLauncher();
    await flush();
    await openTabScope(target);
    // Plain category order would put "Tabs" above "Terminal" and bury the
    // terminal's own actions, which is what made them search-only.
    expect(titles(target)).toEqual([
      "Copy path to $CWD",
      "Restart terminal",
      "Close tab",
    ]);
    expect(target.querySelector(".deck-result-path")?.textContent).toBe("Tab › Terminal");
  });

  test("an extension tab's Tab scope holds only that extension's commands", async () => {
    showBulk = true;
    setActiveExtensionTab();
    const target = openLauncher();
    await flush();
    await openTabScope(target);
    const shown = titles(target);
    expect(shown).toContain("Run alpha");
    // Another extension's command, and the entry that merely opens this one,
    // are spawn actions for the window rather than options of this tab.
    expect(shown).not.toContain("Run beta");
    expect(shown).not.toContain("Alpha app");
  });

  test("fuzzy search crosses into Computers leaves without opening a submenu", async () => {
    const target = openLauncher();
    await flush();
    await typeQuery(target, "control terminal");
    expect(titles(target)[0]).toBe("Control terminal");
    expect(target.querySelector(".deck-result-path")?.textContent).toContain(
      "Computers › Windows › Open",
    );
  });

  test("a verb query still reaches the action itself, not only its window", async () => {
    const target = openLauncher();
    await flush();
    // The window rows are branches now, so the flattened search list has to
    // carry every window's actions or a verb query would only ever descend.
    await typeQuery(target, "focus control terminal");
    expect(titles(target)[0]).toBe("Focus");
    expect(target.querySelector(".deck-result-path")?.textContent).toContain(
      "Computers › Windows › Control terminal",
    );
  });

  // The deck names a window exactly as the launcher and the OS titlebar do:
  // the generated "Window N" plus the user's caption in brackets, recomposed
  // from kind/ordinal/label rather than read off the library-composed title.
  test("names a captioned window the way every other surface spells it", async () => {
    const target = openLauncher();
    await flush();
    await typeQuery(target, "release checks");
    expect(titles(target)[0]).toBe("Window 2 [release checks]");
  });

  test("a new terminal does not inherit the invoking window's open launcher draft", async () => {
    sessionStorage.setItem("chan.auth.token", "keep-me");
    let popup:
      | {
          name: string;
          location: { href: string };
          focus: ReturnType<typeof vi.fn>;
          close: ReturnType<typeof vi.fn>;
          sessionStorage: Storage;
        }
      | undefined;
    vi.spyOn(window, "open").mockImplementation(() => {
      popup = {
        name: "",
        location: { href: "" },
        focus: vi.fn(),
        close: vi.fn(),
        sessionStorage: clonedSessionStorage(sessionStorage),
      };
      return popup as unknown as Window;
    });
    scopedLibrary.run.mockResolvedValue({
      window: {
        window_id: "terminal-2",
        launch_path: "/api/library/command-capabilities/cap/windows/terminal-2/launch",
      },
    });
    const target = openLauncher();
    await flush();
    await typeQuery(target, "shell");
    expect(titles(target)[0]).toBe("This library");
    await key(target, "ArrowDown");
    await key(target, "Enter");
    await flush();

    expect(scopedLibrary.run).toHaveBeenCalledWith({ action: "new_terminal" });
    expect(popup?.sessionStorage.getItem("chan.command-launcher.v1:contextual")).toBeNull();
    expect(popup?.sessionStorage.getItem("chan.auth.token")).toBe("keep-me");
    expect(sessionStorage.getItem("chan.command-launcher.v1:contextual")).not.toBeNull();
  });

  test("the Computers orb exposes branches and ArrowLeft returns from level two", async () => {
    const target = openLauncher();
    await flush();
    (target.querySelector('[aria-label="Computers scope"]') as HTMLButtonElement).click();
    await tick();
    // One Windows branch instead of a Focus/Hide/Show/Close quartet that
    // listed the same roster four times through four filters.
    expect(titles(target)).toEqual(["New terminal", "New window", "Windows"]);

    const newWindow = [...target.querySelectorAll<HTMLButtonElement>(".deck-result")].find(
      (row) => row.querySelector(".deck-result-title")?.textContent === "New window",
    );
    newWindow?.click();
    await tick();
    expect(launcherDraft.path).toEqual(["new-window"]);
    expect(titles(target)).toEqual(["Project A"]);

    await key(target, "ArrowLeft");
    expect(launcherDraft.path).toEqual([]);
    expect(titles(target)).toContain("New terminal");
  });

  async function openWindowList(target: HTMLElement): Promise<void> {
    (target.querySelector('[aria-label="Computers scope"]') as HTMLButtonElement).click();
    await tick();
    row(target, "Windows").click();
    await tick();
  }

  test("the Windows branch lists every window, open or hidden, as a target", async () => {
    scopedLibrary.load.mockResolvedValue({
      ...librarySnapshot,
      windows: [
        librarySnapshot.windows[0],
        { ...librarySnapshot.windows[1], hidden: true },
      ],
    });
    const target = openLauncher();
    await flush();
    await openWindowList(target);
    expect(launcherDraft.path).toEqual(["windows"]);
    expect(titles(target)).toEqual(["Control terminal", "Window 2 [release checks]"]);
    // Open versus hidden rides the breadcrumb: the deck is a flat listbox
    // with no section headers to group under.
    const paths = [...target.querySelectorAll(".deck-result-path")].map((n) => n.textContent ?? "");
    expect(paths[0]).toContain("Computers › Windows › Open");
    expect(paths[1]).toContain("Computers › Windows › Hidden");
  });

  test("a visible window offers Focus, Hide, and Close", async () => {
    const target = openLauncher();
    await flush();
    await openWindowList(target);
    row(target, "Window 2 [release checks]").click();
    await tick();
    expect(launcherDraft.path).toEqual(["windows", "w-captioned"]);
    expect(titles(target)).toEqual(["Focus", "Hide", "Close"]);
  });

  test("a hidden window shows rather than focuses, and never offers both", async () => {
    scopedLibrary.load.mockResolvedValue({
      ...librarySnapshot,
      windows: [
        librarySnapshot.windows[0],
        { ...librarySnapshot.windows[1], hidden: true },
      ],
    });
    const target = openLauncher();
    await flush();
    await openWindowList(target);
    row(target, "Window 2 [release checks]").click();
    await tick();
    // Show routes through the same focus call, which unhides and raises in one
    // step, so listing Focus beside it would be the same click twice.
    expect(titles(target)).toEqual(["Show", "Close"]);
  });

  test("a control terminal offers Focus alone, matching what the capability route allows", async () => {
    const target = openLauncher();
    await flush();
    await openWindowList(target);
    row(target, "Control terminal").click();
    await tick();
    // set_window_visibility and close_window both refuse a control terminal
    // server-side, so offering either here would only ever fail.
    expect(titles(target)).toEqual(["Focus"]);
  });

  test("a readonly grantee gets Focus and no mutation on any window", async () => {
    scopedLibrary.load.mockResolvedValue({ ...librarySnapshot, role: "readonly" as const });
    const target = openLauncher();
    await flush();
    (target.querySelector('[aria-label="Computers scope"]') as HTMLButtonElement).click();
    await tick();
    // No New terminal or New window either: those are owner-only already.
    expect(titles(target)).toEqual(["Windows"]);
    row(target, "Windows").click();
    await tick();
    row(target, "Window 2 [release checks]").click();
    await tick();
    expect(titles(target)).toEqual(["Focus"]);
  });

  test("ArrowLeft from a window's actions returns to the window list", async () => {
    const target = openLauncher();
    await flush();
    await openWindowList(target);
    row(target, "Window 2 [release checks]").click();
    await tick();
    await key(target, "ArrowLeft");
    expect(launcherDraft.path).toEqual(["windows"]);
    expect(titles(target)).toContain("Control terminal");
    await key(target, "ArrowLeft");
    expect(launcherDraft.path).toEqual([]);
    expect(titles(target)).toContain("Windows");
  });

  test("falls back to the window list when that window closes elsewhere", async () => {
    const target = openLauncher();
    await flush();
    await openWindowList(target);
    row(target, "Window 2 [release checks]").click();
    await tick();
    // The roster is polled while the deck is open, so the window can go while
    // its own actions are on screen.
    scopedLibrary.load.mockResolvedValue({
      ...librarySnapshot,
      windows: [librarySnapshot.windows[0]],
    });
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 2600));
    await flush();
    expect(launcherDraft.path).toEqual(["windows"]);
    expect(titles(target)).toEqual(["Control terminal"]);
  });

  test("ArrowUp enters the scope rail and horizontal arrows activate adjacent scopes", async () => {
    const target = openLauncher();
    await flush();
    await key(target, "ArrowUp");
    expect(target.querySelector(".deck-scope.focused")?.getAttribute("aria-label")).toBe("Tab scope");
    await key(target, "ArrowRight");
    expect(target.querySelector(".deck-scope.focused")?.getAttribute("aria-label")).toBe("Pane scope");
    expect(launcherDraft.scope).toBe("pane");
  });

  test("ArrowRight executes the highlighted contextual command and clears the draft", async () => {
    const target = openLauncher();
    await flush();
    await typeQuery(target, "Search");
    await key(target, "ArrowDown");
    await key(target, "ArrowRight");
    expect(runSearch).toHaveBeenCalledTimes(1);
    expect(launcherPanel.open).toBe(false);
    expect(launcherDraft.query).toBe("");
  });

  test("does not leak an execution key into the window keymap", async () => {
    const target = openLauncher();
    await flush();
    await typeQuery(target, "Search");
    const leaked = vi.fn();
    window.addEventListener("keydown", leaked);
    try {
      await key(target, "Enter");
    } finally {
      window.removeEventListener("keydown", leaked);
    }
    expect(runSearch).toHaveBeenCalledTimes(1);
    expect(leaked).not.toHaveBeenCalled();
  });

  test("Escape hides but preserves the draft for the next invocation", async () => {
    const target = openLauncher();
    await flush();
    await typeQuery(target, "project");
    await key(target, "Escape");
    expect(launcherPanel.open).toBe(false);
    expect(launcherDraft.query).toBe("project");
    launcherPanel.open = true;
    await flush();
    expect(input(target).value).toBe("project");
  });

  test("removes itself from the overlay stack before dispatching", async () => {
    showFlip = true;
    const target = openLauncher();
    await flush();
    syncOverlayStack();
    expect(topOverlay()).toBe("launcher");
    await typeQuery(target, "Flip pane");
    await key(target, "Enter");
    expect(overlayAtFlipRun).toBeNull();
    expect(runFlip).toHaveBeenCalledTimes(1);
  });

  test("uses a theme-aware dimming scrim, optical centering, and smooth capsule motion", () => {
    expect(deckRaw).toContain("padding: min(17vh, 136px) 16px 16px;");
    expect(deckRaw).toContain("--deck-scrim: rgba(0, 0, 0, 0.56);");
    expect(deckRaw).toContain(':global([data-theme="light"]) .deck-overlay');
    expect(deckRaw).toMatch(/\.deck-backdrop \{[\s\S]{1,300}background: var\(--deck-scrim\)/);
    expect(deckRaw).toMatch(/\.deck-backdrop \{[\s\S]{1,360}animation: scrim-in/);
    expect(deckRaw).toContain('filter id="chan-command-orb-blob"');
    expect(deckRaw).toMatch(/\.deck-shell \{[\s\S]{1,360}animation: deck-arrive/);
    expect(deckRaw).toMatch(/\.deck-scope \{[\s\S]{1,500}animation: orb-arrive/);
  });
});
