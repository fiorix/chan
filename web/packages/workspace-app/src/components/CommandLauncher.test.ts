// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const scopedLibrary = vi.hoisted(() => ({
  load: vi.fn(),
  run: vi.fn(),
  liveTerminals: vi.fn(),
}));

vi.mock("../state/commands/install", () => ({}));
vi.mock("../api/libraryCommand", () => ({
  loadScopedLibrarySnapshot: scopedLibrary.load,
  loadScopedWindowLiveTerminals: scopedLibrary.liveTerminals,
  checkScopedWindowPage: vi.fn(async () => ({
    response: new Response("<html></html>"),
    readRefusal: async () => new Error("unexpected refusal"),
  })),
  runScopedLibraryAction: scopedLibrary.run,
}));

import CommandLauncher from "./CommandLauncher.svelte";
import { ApiError } from "../api/errors";
import * as statusBus from "../state/notify.svelte";
import {
  clearLauncherDraft,
  closeCommandLauncher,
  launcherDraft,
  launcherPanel,
  openCommandLauncher,
  overlayStack,
  searchPanel,
  syncOverlayStack,
  topOverlay,
} from "../state/store.svelte";
import { registerCommands } from "../state/commands";
import { clearRecentCommands } from "../state/commands/recent.svelte";
import {
  type BrowserTab,
  type ExtensionTab,
  type LeafNode,
  type TerminalTab,
} from "../state/tabs.svelte";
import { fileTab as harnessFileTab, resetLayout as harnessResetLayout } from "../__tests__/tabs";

Element.prototype.scrollIntoView = vi.fn();

const runSearch = vi.fn();
const runNewFile = vi.fn();
const runBrowserAlpha = vi.fn();
const runBrowserZoom = vi.fn();
const runFlip = vi.fn();
let overlayAtFlipRun: ReturnType<typeof topOverlay> = null;
let showFlip = false;
// Optional command sets keep the small ordering assertions exact.
let showBulk = false;
let showFullApplications = false;

const APPLICATION_TITLES = {
  Terminal: ["Rich Prompt", "Details", ...Array.from({ length: 8 }, (_, i) => `Terminal option ${i}`)],
  Editor: ["Preview slide deck", "Reload from disk", ...Array.from({ length: 8 }, (_, i) => `Editor option ${i}`)],
};

registerCommands((["Terminal", "Editor"] as const).flatMap((category) => APPLICATION_TITLES[category].map((title, i) => ({
  id: `app.${category.toLowerCase()}.complete${i}`, title, category, requirement: "any" as const,
  scope: "app" as const, surface: category === "Terminal" ? "terminal" as const : "file" as const,
  keywords: ["unbounded-match"], available: () => showFullApplications, run: () => {},
}))));

registerCommands([
  {
    id: "app.window.reload",
    title: "Search",
    category: "Global",
    scope: "window",
    requirement: "any",
    keywords: ["find"],
    available: () => true,
    run: runSearch,
  },
  {
    id: "app.file.new",
    title: "New file",
    category: "Editor",
    scope: "app",
    surface: "file",
    requirement: "any",
    keywords: ["create"],
    available: () => true,
    run: runNewFile,
  },
  {
    id: "app.browser.alpha",
    title: "Alpha browser",
    category: "File Browser",
    scope: "app",
    surface: "browser",
    requirement: "any",
    keywords: ["files"],
    available: () => true,
    run: runBrowserAlpha,
  },
  {
    id: "app.browser.zoom",
    title: "Zoom browser",
    category: "File Browser",
    scope: "app",
    surface: "browser",
    requirement: "any",
    keywords: ["files"],
    available: () => true,
    run: runBrowserZoom,
  },
  {
    id: "app.pane.flip",
    title: "Flip pane",
    category: "Panes",
    scope: "pane",
    group: "Pane",
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
    scope: "app" as const,
    surface: "browser" as const,
    requirement: "any" as const,
    available: () => showBulk,
    run: () => {},
  })),
  {
    id: "app.tab.close",
    title: "Close tab",
    category: "Tabs",
    scope: "pane",
    group: "Tab",
    requirement: "any",
    available: () => showBulk,
    run: () => {},
  },
  {
    id: "app.terminal.copyCwd",
    title: "Copy working directory path",
    category: "Terminal",
    scope: "app",
    surface: "terminal",
    requirement: "any",
    available: () => showBulk,
    run: () => {},
  },
  {
    id: "app.terminal.restart",
    title: "Restart terminal",
    category: "Terminal",
    scope: "app",
    surface: "terminal",
    requirement: "any",
    available: () => showBulk,
    run: () => {},
  },
  // The extension catalog's two shapes: the app's own entry is a spawner,
  // and a command of the app belongs to that app's tab.
  {
    id: "extension.alpha",
    title: "Alpha app",
    category: "Apps",
    scope: "pane",
    group: "New tab",
    requirement: "any",
    available: () => showBulk,
    run: () => {},
  },
  {
    id: "extension.alpha.run",
    title: "Run alpha",
    category: "Apps",
    scope: "app",
    surface: "extension",
    requirement: "any",
    available: () => showBulk,
    run: () => {},
  },
  {
    id: "extension.beta.run",
    title: "Run beta",
    category: "Apps",
    scope: "app",
    surface: "extension",
    requirement: "any",
    available: () => showBulk,
    run: () => {},
  },
]);

const librarySnapshot = {
  library_id: "lib-local-test",
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
      tmux: false,
      origin: "browser" as const,
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
      tmux: false,
      origin: "browser" as const,
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
    },
  ],
};

const mounted: Array<Record<string, unknown>> = [];

function resetLayout(): LeafNode {
  return harnessResetLayout([], { id: "command-launcher-pane" });
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

/// Apply the App scope, whose orb is named after the focused tab's app.
async function openAppScope(target: HTMLElement, app: string): Promise<void> {
  (target.querySelector(`[aria-label="${app} scope"]`) as HTMLButtonElement).click();
  await tick();
}

function input(target: HTMLElement): HTMLInputElement {
  return target.querySelector(".deck-input") as HTMLInputElement;
}

function titles(target: HTMLElement): string[] {
  return [...target.querySelectorAll(".deck-result-title")].map((node) => node.textContent ?? "");
}

function operation(target: HTMLElement): string {
  return target.querySelector(".deck-operation")?.textContent ?? "";
}

function sectionTitles(target: HTMLElement): string[] {
  return [...target.querySelectorAll(".deck-section-title")].map((node) => node.textContent ?? "");
}

/// A row's second line: its subtitle, or the breadcrumb a flat row shows.
function secondLine(target: HTMLElement, title: string): string {
  return row(target, title).querySelector(".deck-result-subtitle, .deck-result-path")?.textContent ?? "";
}

/// What a row's right column says of its state.
function valueOf(target: HTMLElement, title: string): string {
  return row(target, title).querySelector(".deck-result-value")?.textContent ?? "";
}

/// Where the deck says it stands, beside the query.
function crumbs(target: HTMLElement): string[] {
  return [...target.querySelectorAll(".deck-crumb")].map((node) => node.textContent ?? "");
}

function decision(target: HTMLElement, label: string): HTMLButtonElement {
  const found = [...target.querySelectorAll<HTMLButtonElement>(".deck-decisions button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (!found) throw new Error(`missing decision ${label}; card: ${operation(target)}`);
  return found;
}

/// The browser close path acquires the target window's named context before
/// the server mutation, which jsdom has no real window for.
function stubPopup(): void {
  vi.spyOn(window, "open").mockImplementation(
    () => ({ close: vi.fn(), focus: vi.fn(), closed: false, document: document.implementation.createHTMLDocument(), location: { href: "about:blank" } }) as unknown as Window,
  );
}

function deferredCount(): { promise: Promise<unknown>; resolve: (value: unknown) => void } {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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

const CAPTIONED = "Window 2 [release checks]";

function selectedTitle(target: HTMLElement): string | null {
  return target.querySelector('[role="option"][aria-selected="true"] .deck-result-title')?.textContent ?? null;
}

/// Walk the selection down to a row, as the arrow keys do.
async function selectRow(target: HTMLElement, title: string): Promise<void> {
  const rows = titles(target).length;
  for (let step = 0; step < rows && selectedTitle(target) !== title; step += 1) {
    await key(target, "ArrowDown");
  }
  if (selectedTitle(target) !== title) {
    throw new Error(`cannot select ${title}; visible: ${titles(target).join(", ")}`);
  }
}

/// Right on a row: the page of an object that Enter would act on.
async function openPage(target: HTMLElement, title: string): Promise<void> {
  await selectRow(target, title);
  await key(target, "ArrowRight");
}

async function openComputers(target: HTMLElement): Promise<void> {
  (target.querySelector('[aria-label="Computers scope"]') as HTMLButtonElement).click();
  await tick();
}

/// A window's page, reached from the Computers scope.
async function openWindowPage(target: HTMLElement, title = CAPTIONED): Promise<void> {
  await openComputers(target);
  await openPage(target, title);
}

beforeEach(() => {
  sessionStorage.clear();
  // A command an earlier test ran would lead the next test's list.
  clearRecentCommands();
  clearLauncherDraft();
  launcherPanel.open = false;
  resetLayout();
  searchPanel.open = false;
  overlayStack.ids = [];
  overlayAtFlipRun = null;
  showFlip = false;
  showBulk = false;
  showFullApplications = false;
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
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("contextual command deck", () => {
  test("renders nothing while closed", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(CommandLauncher, { target }) as Record<string, unknown>);
    await flush();
    expect(target.querySelector(".deck-shell")).toBeNull();
  });

  test("opens focused with the window's commands, this machine's rows and six scope orbs", async () => {
    const target = openLauncher();
    await flush();
    expect(document.activeElement).toBe(input(target));
    // No tab is focused, so no app's commands are listed: the editor's and
    // the file browser's wait for their tab. This machine closes the list
    // with the ways into its tree.
    expect(titles(target)).toEqual(["Search", "New terminal window", "Workspaces", "Windows"]);
    expect([...target.querySelectorAll(".deck-scope")].map((orb) => orb.getAttribute("aria-label"))).toEqual([
      "App scope", "Pane scope", "Window scope", "Workspace scope", "Settings scope", "Computers scope",
    ]);
    expect(target.querySelector('[aria-label="App scope"]')?.hasAttribute("disabled")).toBe(true);
    expect(target.querySelector('[aria-label="Computers scope"]')?.hasAttribute("disabled")).toBe(false);
  });

  /// The Computers orb as the deck draws it now. A closed deck draws none.
  const computersOrb = (target: HTMLElement): "enabled" | "disabled" | "absent" => {
    const orb = target.querySelector('[aria-label="Computers scope"]');
    if (!orb) return "absent";
    return orb.hasAttribute("disabled") ? "disabled" : "enabled";
  };

  test("the Computers orb is enabled while the first request to the scoped route is unanswered", async () => {
    scopedLibrary.load.mockImplementationOnce(() => new Promise(() => {}));
    const target = openLauncher();
    await flush();

    expect(
      { orb: computersOrb(target), requests: scopedLibrary.load.mock.calls.length },
      "the orb before the route's first answer",
    ).toEqual({ orb: "enabled", requests: 1 });
  });

  test("the Computers orb stays disabled through a later request once the scoped route has refused", async () => {
    // The library is there and this window was not granted it. The deck asks
    // again at each open, and this second request never answers.
    scopedLibrary.load
      .mockRejectedValueOnce(new ApiError(403, "window has no live presence"))
      .mockImplementationOnce(() => new Promise(() => {}));
    const target = openLauncher();
    await flush();
    const afterAnswer = computersOrb(target);
    launcherPanel.open = false;
    await flush();
    launcherPanel.open = true;
    await flush();

    expect(
      { afterAnswer, duringRequest: computersOrb(target), requests: scopedLibrary.load.mock.calls.length },
      "the orb after a refusal and during the request that follows it",
    ).toEqual({ afterAnswer: "disabled", duringRequest: "disabled", requests: 2 });
  });

  test.each([404, 405])("the rail leaves the Computers scope out once the scoped route has answered %s", async (status) => {
    // A standalone tenant has no scoped route: no library stands behind the
    // window. The deck asks again at each open, and this second request
    // never answers.
    scopedLibrary.load
      .mockRejectedValueOnce(new ApiError(status, "no launcher route"))
      .mockImplementationOnce(() => new Promise(() => {}));
    const target = openLauncher();
    await flush();
    const afterAnswer = computersOrb(target);
    expect(titles(target), "the list holds no Computers row either").toEqual(["Search"]);
    launcherPanel.open = false;
    await flush();
    launcherPanel.open = true;
    await flush();

    expect(
      { afterAnswer, duringRequest: computersOrb(target), requests: scopedLibrary.load.mock.calls.length },
      "the orb after the answer and during the request that follows it",
    ).toEqual({ afterAnswer: "absent", duringRequest: "absent", requests: 2 });
    expect([...target.querySelectorAll(".deck-scope")].map((orb) => orb.getAttribute("aria-label"))).toEqual([
      "App scope", "Pane scope", "Window scope", "Workspace scope", "Settings scope",
    ]);
  });

  test("a scoped route that answers after all brings the Computers scope back", async () => {
    scopedLibrary.load.mockRejectedValueOnce(new ApiError(404, "no launcher route"));
    const target = openLauncher();
    await flush();
    expect(computersOrb(target)).toBe("absent");
    launcherPanel.open = false;
    await flush();
    launcherPanel.open = true;
    await flush();
    expect(computersOrb(target)).toBe("enabled");
  });

  test("orders commands for the focused tab before pane and window commands", async () => {
    setActiveBrowserTab();
    const target = openLauncher();
    await flush();
    expect(titles(target).slice(0, 2)).toEqual(["Alpha browser", "Zoom browser"]);
    expect(target.querySelector('[aria-label="File browser scope"]')).not.toBeNull();
  });

  test("the App scope lists every command of the focused app, and nothing of the pane's", async () => {
    showBulk = true;
    setActiveBrowserTab();
    const target = openLauncher();
    await flush();
    const own = [...BULK_BROWSER_TITLES, "Alpha browser", "Zoom browser"].sort((a, b) => a.localeCompare(b));
    // The app's commands lead; the pane's follow, spawners first, then the
    // tab's own.
    expect(titles(target).slice(0, 11)).toEqual([...own, "Alpha app", "Close tab"]);

    await openAppScope(target, "File browser");
    expect(titles(target)).toEqual(own);
  });

  test("the Pane scope lists the spawners, then the tab's commands", async () => {
    showBulk = true;
    setActiveTerminalTab();
    const target = openLauncher();
    await flush();
    (target.querySelector('[aria-label="Pane scope"]') as HTMLButtonElement).click();
    await tick();
    expect(titles(target)).toEqual(["Alpha app", "Close tab"]);
    await openAppScope(target, "Terminal");
    expect(titles(target)).toEqual(["Copy working directory path", "Restart terminal"]);
  });

  for (const application of ["Terminal", "Editor"] as const) {
    test(`the root lists every ${application} command before pane and window commands`, async () => {
      showBulk = true;
      showFullApplications = true;
      if (application === "Terminal") setActiveTerminalTab();
      else {
        const pane = resetLayout();
        const tab = harnessFileTab({ id: "editor-test", path: "README.md" });
        pane.tabs = [tab];
        pane.activeTabId = tab.id;
      }
      const target = openLauncher();
      await flush();
      const root = titles(target);
      const expected = [...APPLICATION_TITLES[application], ...(application === "Terminal" ? ["Copy working directory path", "Restart terminal"] : ["New file"])].sort((a, b) => a.localeCompare(b));
      expect(root.slice(0, expected.length)).toEqual(expected);
      expect(root[expected.length]).toBe("Alpha app");
      expect(launcherDraft.scope).toBeNull();
      await openAppScope(target, application);
      expect(titles(target)).toEqual(expected);
    });
  }

  test("root search lists every matching command beyond nine", async () => {
    showFullApplications = true;
    const target = openLauncher();
    await flush();
    await typeQuery(target, "unbounded-match");
    expect(titles(target).sort()).toEqual(Object.values(APPLICATION_TITLES).flat().sort());
    expect(titles(target)).toHaveLength(20);
  });

  test("an extension tab's App scope holds only that extension's commands", async () => {
    showBulk = true;
    setActiveExtensionTab();
    const target = openLauncher();
    await flush();
    // The orb is named after the extension, which the tab's title carries.
    await openAppScope(target, "Alpha app");
    // Another extension's command belongs to its own tab, and the entry that
    // merely opens this one is a spawner of the pane.
    expect(titles(target)).toEqual(["Run alpha"]);
  });

  test("another extension's command is found by a typed query from any tab", async () => {
    showBulk = true;
    setActiveExtensionTab();
    const target = openLauncher();
    await flush();
    await typeQuery(target, "run beta");
    expect(titles(target)[0]).toBe("Run beta");
    expect(row(target, "Run beta").hasAttribute("disabled")).toBe(false);
  });

  test("a typed query reaches this machine's windows from every scope, each saying where it lives", async () => {
    const target = openLauncher();
    await flush();
    await typeQuery(target, "control terminal");
    expect(titles(target)[0]).toBe("Control terminal");
    expect(secondLine(target, "Control terminal")).toBe("Computers › Windows");
  });

  test("a verb query reaches the action itself, titled with its window", async () => {
    const target = openLauncher();
    await flush();
    // The typed list carries every window's actions, so a verb acts in one
    // Enter instead of only finding the window.
    await typeQuery(target, "focus control terminal");
    expect(titles(target)[0]).toBe("Focus Control terminal");
    expect(secondLine(target, "Focus Control terminal")).toBe("Computers › Windows");
  });

  test("`close` leads with the tab's own Close, ahead of another window's", async () => {
    showBulk = true;
    setActiveTerminalTab();
    const target = openLauncher();
    await flush();
    await typeQuery(target, "close");
    expect(titles(target)).toEqual(["Close tab", `Close ${CAPTIONED}`]);
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
          document: Document;
          closed: boolean;
          location: { href: string };
          focus: ReturnType<typeof vi.fn>;
          close: ReturnType<typeof vi.fn>;
          sessionStorage: Storage;
        }
      | undefined;
    vi.spyOn(window, "open").mockImplementation(() => {
      popup = {
        name: "",
        document: document.implementation.createHTMLDocument(),
        closed: false,
        location: { href: "about:blank" },
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
    expect(titles(target)[0]).toBe("New terminal window");
    await key(target, "Enter");
    await flush();

    expect(scopedLibrary.run).toHaveBeenCalledWith({ action: "new_terminal" });
    expect(popup?.sessionStorage.getItem("chan.command-launcher.v1:contextual")).toBeNull();
    expect(popup?.sessionStorage.getItem("chan.auth.token")).toBe("keep-me");
    expect(sessionStorage.getItem("chan.command-launcher.v1:contextual")).not.toBeNull();
  });

  test("the Computers scope lists this machine's workspaces and windows, and ArrowLeft returns from a page", async () => {
    const target = openLauncher();
    await flush();
    // Among every scope the machine's rows sit under one heading.
    expect(sectionTitles(target)).toEqual(["Window", "Computers"]);
    await openComputers(target);
    // The scope lists them as the Computers screen does: objects first, each
    // under its type, and a new terminal window that runs at once.
    expect(sectionTitles(target)).toEqual(["Workspaces", "Windows", "New"]);
    expect(titles(target)).toEqual(["Project A", "Control terminal", CAPTIONED, "New terminal window"]);
    expect(valueOf(target, "Project A")).toBe("on");
    expect(secondLine(target, CAPTIONED)).toBe("Project A");

    await openPage(target, "Project A");
    expect(launcherDraft.path).toEqual(["workspace:project-a"]);
    expect(crumbs(target)).toEqual(["Computers", "Project A"]);
    expect(sectionTitles(target)).toEqual(["Actions", "Windows"]);
    expect(titles(target)).toEqual(["New window", CAPTIONED]);

    await key(target, "ArrowLeft");
    expect(launcherDraft.path).toEqual([]);
    expect(titles(target)).toContain("New terminal window");
  });

  test("a workspace's row opens a new window of it, in one step", async () => {
    stubPopup();
    scopedLibrary.run.mockResolvedValue({
      window: {
        window_id: "w-new",
        launch_path: "/api/library/command-capabilities/cap/windows/w-new/launch",
      },
    });
    const target = openLauncher();
    await flush();
    await openComputers(target);
    row(target, "Project A").click();
    await flush();
    expect(scopedLibrary.run).toHaveBeenCalledExactlyOnceWith({
      action: "new_workspace_window",
      workspace_id: "project-a",
    });
  });

  test("a window's row runs the first action this surface offers on it", async () => {
    const popup = { closed: false, location: { href: "https://chan.test/project-a/?w=w-captioned" }, document: document.implementation.createHTMLDocument(), focus: vi.fn(), close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const target = openLauncher();
    await flush();
    await openComputers(target);
    row(target, CAPTIONED).click();
    await flush();
    expect(window.open).toHaveBeenCalledExactlyOnceWith("", "w-captioned");
    expect(popup.focus).toHaveBeenCalled();
    expect(scopedLibrary.run).not.toHaveBeenCalled();
  });

  function workspaceRow(workspace_id: string, path: string, label: string) {
    return { ...librarySnapshot.workspaces[0], workspace_id, prefix: workspace_id, path, label };
  }

  test("a mount that cannot read its root is listed with its reason, and offers no new window", async () => {
    scopedLibrary.load.mockResolvedValue({
      ...librarySnapshot,
      workspaces: [
        ...librarySnapshot.workspaces,
        {
          ...workspaceRow("project-b", "/work/project-b", "Project B"),
          status: "unavailable" as const,
          error: "workspace root does not exist: /work/project-b",
        },
      ],
    });
    const target = openLauncher();
    await flush();
    await openComputers(target);
    expect(sectionTitles(target)).toEqual(["Needs attention", "Workspaces", "Windows", "New"]);
    expect(valueOf(target, "Project B")).toBe("degraded");
    expect(secondLine(target, "Project B")).toBe("workspace root does not exist: /work/project-b");

    // The library refuses to mint a window over that tenant, so the row
    // opens its page, where New window says why it cannot run.
    row(target, "Project B").click();
    await flush();
    expect(launcherDraft.path).toEqual(["workspace:project-b"]);
    expect(titles(target)).toEqual(["New window"]);
    expect(row(target, "New window").hasAttribute("disabled")).toBe(true);
    expect(secondLine(target, "New window")).toBe("workspace root does not exist: /work/project-b");
    expect(scopedLibrary.run).not.toHaveBeenCalled();
  });

  test.each([
    ["starting", "on", "Working…"],
    ["locked", "locked", "Workspace is open in another Chan process"],
    ["error", "on, failed", "Workspace unavailable"],
  ] as const)("a %s workspace reads %s and says why it opens no window", async (status, state, reason) => {
    scopedLibrary.load.mockResolvedValue({
      ...librarySnapshot,
      workspaces: [{ ...workspaceRow("project-b", "/work/project-b", "Project B"), status }],
    });
    const target = openLauncher();
    await flush();
    await openComputers(target);
    expect(valueOf(target, "Project B")).toBe(state);
    row(target, "Project B").click();
    await flush();
    expect(titles(target)).toEqual(["New window"]);
    expect(row(target, "New window").hasAttribute("disabled")).toBe(true);
    expect(secondLine(target, "New window")).toBe(reason);
  });

  test("a workspace that is off cannot be opened from a window, and says where to turn it on", async () => {
    scopedLibrary.load.mockResolvedValue({
      ...librarySnapshot,
      workspaces: [{ ...workspaceRow("project-b", "/work/project-b", "Project B"), on: false, status: "stopped" as const }],
    });
    const target = openLauncher();
    await flush();
    await openComputers(target);
    expect(valueOf(target, "Project B")).toBe("off");
    expect(row(target, "Project B").hasAttribute("disabled")).toBe(true);
    expect(secondLine(target, "Project B")).toBe("Turn the workspace on from the Computers screen");
  });

  test("the Computers scope lists every window, open or hidden, and says which is hidden", async () => {
    scopedLibrary.load.mockResolvedValue({
      ...librarySnapshot,
      windows: [
        librarySnapshot.windows[0],
        { ...librarySnapshot.windows[1], hidden: true },
      ],
    });
    const target = openLauncher();
    await flush();
    await openComputers(target);
    expect(titles(target)).toEqual(["Project A", "Control terminal", CAPTIONED, "New terminal window"]);
    expect(valueOf(target, "Control terminal")).toBe("");
    expect(valueOf(target, CAPTIONED)).toBe("hidden");
  });

  test("a window whose workspace row is listed twice is listed once", async () => {
    scopedLibrary.load.mockResolvedValue({
      ...librarySnapshot,
      workspaces: [
        librarySnapshot.workspaces[0],
        workspaceRow("project-a-again", "/work/project-a", "Project A again"),
      ],
    });
    const target = openLauncher();
    await flush();
    await openComputers(target);
    expect(titles(target).filter((title) => title === CAPTIONED)).toHaveLength(1);
    await typeQuery(target, "release checks");
    expect(titles(target).filter((title) => title === CAPTIONED)).toHaveLength(1);
  });

  function workspaceWindow(window_id: string, ordinal: number, workspace_path: string) {
    return { ...librarySnapshot.windows[1], window_id, ordinal, label: "", workspace_path };
  }

  /// The workspace each window row names on its second line.
  function windowWorkspaces(target: HTMLElement, windows: readonly string[]): string[] {
    return windows.map((title) => secondLine(target, title));
  }

  // A root is spelled as its host spells it, so the deck does not cut a
  // window's path where a row already names that workspace.
  test("a window is named by the row that lists its workspace, on a Windows host too", async () => {
    scopedLibrary.load.mockResolvedValue({
      ...librarySnapshot,
      windows: [
        workspaceWindow("w-windows", 1, "C:\\work\\project-a"),
        workspaceWindow("w-unix", 2, "/work/project-b"),
      ],
      workspaces: [
        workspaceRow("other", "D:\\other", "Other"),
        workspaceRow("project-a", "C:\\work\\project-a", "Project A"),
        workspaceRow("project-b", "/work/project-b", "Project B"),
      ],
    });
    const target = openLauncher();
    await flush();
    await openComputers(target);
    expect(windowWorkspaces(target, ["Window 1", "Window 2"])).toEqual(["Project A", "Project B"]);
  });

  test("a window whose row has no label is named by that row's root, cut at / alone", async () => {
    scopedLibrary.load.mockResolvedValue({
      ...librarySnapshot,
      windows: [
        workspaceWindow("w-windows", 1, "C:\\work\\project-a"),
        workspaceWindow("w-unix", 2, "/work/project-b"),
      ],
      workspaces: [
        workspaceRow("project-a", "C:\\work\\project-a", ""),
        workspaceRow("project-b", "/work/project-b", ""),
      ],
    });
    const target = openLauncher();
    await flush();
    await openComputers(target);
    expect(windowWorkspaces(target, ["Window 1", "Window 2"])).toEqual([
      "C:\\work\\project-a",
      "project-b",
    ]);
  });

  test("a window whose workspace no row lists is named by its own path, cut at / alone", async () => {
    scopedLibrary.load.mockResolvedValue({
      ...librarySnapshot,
      windows: [
        workspaceWindow("w-backslash", 1, "/srv/back\\slash/"),
        workspaceWindow("w-windows", 2, "C:\\work\\project-c"),
        workspaceWindow("w-root", 3, "/"),
      ],
      workspaces: [workspaceRow("other", "/srv/other", "Other")],
    });
    const target = openLauncher();
    await flush();
    await openComputers(target);
    expect(windowWorkspaces(target, ["Window 1", "Window 2", "Window 3"])).toEqual([
      "back\\slash",
      "C:\\work\\project-c",
      "Workspace",
    ]);
  });

  test("a visible window's page offers Focus, Hide, and Close, in the cards' words", async () => {
    const target = openLauncher();
    await flush();
    await openWindowPage(target);
    expect(launcherDraft.path).toEqual(["window:w-captioned"]);
    expect(crumbs(target)).toEqual(["Computers", CAPTIONED]);
    expect(titles(target)).toEqual(["Focus window", "Hide window", "Close window"]);
  });

  /// A roster whose captioned window this host's registry does not hold.
  function unmanagedRoster(hidden: boolean) {
    return {
      ...librarySnapshot,
      windows: [
        librarySnapshot.windows[0],
        { ...librarySnapshot.windows[1], hidden, managed: false },
      ],
    };
  }

  /// Make this page a chan-desktop webview and hand back its native invoke.
  function enterDesktop(): ReturnType<typeof vi.fn> {
    const invoke = vi.fn();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: { invoke },
      configurable: true,
    });
    return invoke;
  }

  /// The window rows of the Computers scope.
  function listedWindows(target: HTMLElement): string[] {
    return titles(target).filter((title) => title === "Control terminal" || title.includes("Window "));
  }

  // An unmanaged window is offered Focus where the surface can raise it, which
  // is a visible one in chan-desktop, and has no entry anywhere else. The four
  // cases are the four inputs of that rule.
  test("a visible unmanaged window offers Focus alone in the desktop, and Focus raises it natively", async () => {
    const invoke = enterDesktop();
    const open = vi.spyOn(window, "open");
    scopedLibrary.load.mockResolvedValue(unmanagedRoster(false));
    const target = openLauncher();
    await flush();
    await openComputers(target);
    expect(listedWindows(target)).toEqual(["Control terminal", CAPTIONED]);
    await openPage(target, CAPTIONED);
    expect(titles(target)).toEqual(["Focus window"]);

    row(target, "Focus window").click();
    await flush();
    expect(invoke).toHaveBeenCalledWith("focus_library_window", { windowId: "w-captioned" });
    expect(open).not.toHaveBeenCalled();
  });

  for (const [desktop, hidden] of [
    [true, true],
    [false, false],
    [false, true],
  ] as const) {
    test(`a ${hidden ? "hidden" : "visible"} unmanaged window has no deck entry in ${desktop ? "the desktop" : "a browser"}`, async () => {
      if (desktop) enterDesktop();
      scopedLibrary.load.mockResolvedValue(unmanagedRoster(hidden));
      const target = openLauncher();
      await flush();
      await openComputers(target);
      expect(listedWindows(target)).toEqual(["Control terminal"]);
      // Its workspace's page does not list it either.
      await openPage(target, "Project A");
      expect(titles(target)).toEqual(["New window"]);
    });
  }

  test("a window the registry holds keeps Focus, Hide, and Close", async () => {
    scopedLibrary.load.mockResolvedValue({
      ...librarySnapshot,
      windows: [librarySnapshot.windows[0], { ...librarySnapshot.windows[1], managed: true }],
    });
    const target = openLauncher();
    await flush();
    await openWindowPage(target);
    expect(titles(target)).toEqual(["Focus window", "Hide window", "Close window"]);
  });

  /// What typed search lists for the captioned window, sorted: its own row and
  /// the actions titled with it.
  function captionedWindowHits(target: HTMLElement): string[] {
    return titles(target).filter((title) => title.endsWith(CAPTIONED)).sort();
  }

  // Typed search lists every window's actions beside the window, so the rule
  // is pinned there too.
  test("typed search lists a window's row and each of its actions", async () => {
    const target = openLauncher();
    await flush();
    await typeQuery(target, "release checks");
    expect(captionedWindowHits(target)).toEqual([
      `Close ${CAPTIONED}`,
      `Focus ${CAPTIONED}`,
      `Hide ${CAPTIONED}`,
      CAPTIONED,
    ]);
    // The window leads its own actions, and each action names its workspace.
    expect(titles(target)[0]).toBe(CAPTIONED);
    expect(secondLine(target, `Hide ${CAPTIONED}`)).toBe("Project A");
  });

  test("typed search lists nothing for a visible unmanaged window in a browser", async () => {
    scopedLibrary.load.mockResolvedValue(unmanagedRoster(false));
    const target = openLauncher();
    await flush();
    await typeQuery(target, "release checks");
    expect(captionedWindowHits(target)).toEqual([]);
  });

  test("typed search lists a visible unmanaged window with Focus alone in the desktop", async () => {
    enterDesktop();
    scopedLibrary.load.mockResolvedValue(unmanagedRoster(false));
    const target = openLauncher();
    await flush();
    await typeQuery(target, "release checks");
    expect(captionedWindowHits(target)).toEqual([`Focus ${CAPTIONED}`, CAPTIONED]);
  });

  test("a query typed on a page searches under it", async () => {
    const target = openLauncher();
    await flush();
    await openComputers(target);
    await openPage(target, "Project A");
    await typeQuery(target, "hide");
    expect(titles(target)).toEqual([`Hide ${CAPTIONED}`]);
    await typeQuery(target, "control");
    expect(titles(target), "another workspace's or a loose window is not under this page").toEqual([]);
  });

  test("a page opened from a typed row starts on its own list, not on the query that found it", async () => {
    const target = openLauncher();
    await flush();
    await typeQuery(target, "release checks");
    // The caret stands at the end of what was typed, where Right opens.
    const field = input(target);
    field.setSelectionRange(field.value.length, field.value.length);
    await key(target, "ArrowRight");
    expect(launcherDraft.path).toEqual(["window:w-captioned"]);
    expect(launcherDraft.query).toBe("");
    expect(titles(target)).toEqual(["Focus window", "Hide window", "Close window"]);
  });

  test("the Close card names the live terminal count, read when it is raised", async () => {
    scopedLibrary.liveTerminals.mockResolvedValue(3);
    const target = openLauncher();
    await flush();
    await openWindowPage(target);
    row(target, "Close window").click();
    await flush();

    // The figure comes from the capability count route at confirm time; the
    // polled snapshot carries no count to read.
    expect(scopedLibrary.liveTerminals).toHaveBeenCalledWith("w-captioned");
    expect(operation(target)).toContain(`Close ${CAPTIONED}?`);
    expect(operation(target)).toContain("3 terminal sessions in this window will stop.");
    expect(scopedLibrary.run).not.toHaveBeenCalled();
  });

  test("the Close card warns in general terms when the count cannot be read", async () => {
    scopedLibrary.liveTerminals.mockRejectedValue(new ApiError(503, "busy"));
    const target = openLauncher();
    await flush();
    await openWindowPage(target);
    row(target, "Close window").click();
    await flush();
    expect(operation(target)).toContain("Open sessions in this window may stop.");
  });

  test("Close reads the count again and asks a second time when it moved", async () => {
    stubPopup();
    scopedLibrary.liveTerminals
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(2);
    const target = openLauncher();
    await flush();
    await openWindowPage(target);
    row(target, "Close window").click();
    await flush();
    expect(operation(target)).toContain("This window will close.");

    decision(target, "Close").click();
    await flush();
    expect(scopedLibrary.run).not.toHaveBeenCalled();
    expect(operation(target)).toContain("2 terminal sessions in this window will stop.");

    decision(target, "Close").click();
    await flush();
    expect(scopedLibrary.run).toHaveBeenCalledWith({
      action: "close_window",
      window_id: "w-captioned",
    });
    expect(scopedLibrary.liveTerminals).toHaveBeenCalledTimes(3);

    // Let the deck's success card run its course inside this test: its timer
    // dismisses the launcher, and a later test would otherwise lose the deck
    // out from under it.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await flush();
    expect(launcherPanel.open).toBe(false);
  });

  test("a typed Close asks the same question before it closes", async () => {
    stubPopup();
    scopedLibrary.liveTerminals.mockResolvedValue(1);
    const target = openLauncher();
    await flush();
    await typeQuery(target, "close release");
    row(target, `Close ${CAPTIONED}`).click();
    await flush();
    expect(operation(target)).toContain("1 terminal session in this window will stop.");
    expect(scopedLibrary.run).not.toHaveBeenCalled();
    decision(target, "Close").click();
    await flush();
    expect(scopedLibrary.run).toHaveBeenCalledExactlyOnceWith({ action: "close_window", window_id: "w-captioned" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await flush();
    expect(launcherPanel.open).toBe(false);
    expect(launcherDraft.query, "a command that ran clears the query").toBe("");
  });

  test("typing under a Close card leaves the query alone, so the card's row stays listed for its action", async () => {
    stubPopup();
    scopedLibrary.liveTerminals.mockResolvedValue(1);
    const target = openLauncher();
    await flush();
    await typeQuery(target, "close release");
    row(target, `Close ${CAPTIONED}`).click();
    await flush();
    expect(operation(target)).toContain("1 terminal session in this window will stop.");
    // Keys typed now, as a browser delivers them: text goes into a field
    // only while the field can be edited.
    const field = input(target);
    for (const character of "zzz") {
      const down = new KeyboardEvent("keydown", { key: character, bubbles: true, cancelable: true });
      field.dispatchEvent(down);
      if (down.defaultPrevented || field.readOnly) continue;
      field.value += character;
      field.dispatchEvent(new InputEvent("input", { bubbles: true, data: character }));
    }
    await flush();
    expect(launcherDraft.query).toBe("close release");
    expect(operation(target), "the card stays").toContain("1 terminal session in this window will stop.");
    decision(target, "Close").click();
    await flush();
    expect(scopedLibrary.run).toHaveBeenCalledExactlyOnceWith({ action: "close_window", window_id: "w-captioned" });
  });

  /// The roster follows a scoped action as the library's does: Hide marks the
  /// window hidden and Close removes it, and the next snapshot says so.
  function rosterFollowsActions(): void {
    let windows: Array<(typeof librarySnapshot.windows)[number]> = [...librarySnapshot.windows];
    scopedLibrary.load.mockImplementation(async () => ({ ...librarySnapshot, windows }));
    scopedLibrary.run.mockImplementation(
      async (action: { action: string; window_id?: string; hidden?: boolean }) => {
        if (action.action === "close_window") {
          windows = windows.filter((window) => window.window_id !== action.window_id);
        } else if (action.action === "set_window_visibility") {
          windows = windows.map((window) =>
            window.window_id === action.window_id
              ? { ...window, hidden: action.hidden === true }
              : window,
          );
        }
      },
    );
  }

  // A command's own success changes what the deck lists: a hidden window stops
  // offering Hide and a closed one leaves the roster. The deck falls back and
  // clears the card while the command is still settling.
  test("Hide shows its success and closes the deck when the roster drops its entry", async () => {
    stubPopup();
    rosterFollowsActions();
    const target = openLauncher();
    await flush();
    await openWindowPage(target);
    row(target, "Hide window").click();
    await flush();
    expect(scopedLibrary.run).toHaveBeenCalledWith({
      action: "set_window_visibility",
      window_id: "w-captioned",
      hidden: true,
    });
    expect(operation(target), "the success card").toContain("Done");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await flush();
    expect(launcherPanel.open).toBe(false);
  });

  test.each<[string, (target: HTMLElement) => Promise<void>]>([
    ["a click on the scrim", async (target) => {
      (target.querySelector(".deck-backdrop") as HTMLButtonElement).click();
    }],
    ["the window hiding the launcher", async () => closeCommandLauncher()],
    ["Escape on its card, then out of the page and the launcher", async (target) => {
      await key(target, "Escape");
      expect(launcherPanel.open, "the first Escape releases the card").toBe(true);
      await key(target, "Escape");
      await key(target, "Escape");
    }],
  ])("Hide dismissed by %s leaves the launcher opened after it alone when it succeeds", async (_how, dismiss) => {
    stubPopup();
    let finishHide!: () => void;
    scopedLibrary.run.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishHide = () => resolve();
        }),
    );
    const target = openLauncher();
    await flush();
    await openWindowPage(target);
    row(target, "Hide window").click();
    await flush();
    expect(operation(target), "the action holds the card").toContain("Working");
    await dismiss(target);
    await flush();
    expect(launcherPanel.open).toBe(false);

    openCommandLauncher();
    await flush();
    await typeQuery(target, "project");
    finishHide();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await flush();
    expect(launcherPanel.open, "the launcher opened since stays open").toBe(true);
    expect(launcherDraft.query, "with what was typed into it").toBe("project");
    expect(input(target).value).toBe("project");
    expect(operation(target), "and no card of the earlier action").toBe("");
  });

  test("Close shows its success and closes the deck when the roster drops the window", async () => {
    stubPopup();
    rosterFollowsActions();
    scopedLibrary.liveTerminals.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
    const target = openLauncher();
    await flush();
    await openWindowPage(target);
    row(target, "Close window").click();
    await flush();
    decision(target, "Close").click();
    await flush();
    expect(scopedLibrary.run).toHaveBeenCalledWith({
      action: "close_window",
      window_id: "w-captioned",
    });
    expect(operation(target), "the success card").toContain("Done");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await flush();
    expect(launcherPanel.open).toBe(false);
  });

  test("a reading a later card replaced does not close the window", async () => {
    stubPopup();
    const recheck = deferredCount();
    const reopened = deferredCount();
    scopedLibrary.liveTerminals
      .mockResolvedValueOnce(5)
      .mockImplementationOnce(() => recheck.promise)
      .mockImplementationOnce(() => reopened.promise);
    const target = openLauncher();
    await flush();
    await openWindowPage(target);
    row(target, "Close window").click();
    await flush();
    expect(operation(target)).toContain("5 terminal sessions in this window will stop.");

    // Confirm, dismiss the working card inside the recheck's latency, then ask
    // again: the second card is prepared while the first recheck is still out.
    decision(target, "Close").click();
    await tick();
    await key(target, "Escape");
    row(target, "Close window").click();
    await tick();

    reopened.resolve(7);
    await flush();
    expect(operation(target)).toContain("7 terminal sessions in this window will stop.");

    // The overtaken recheck still matches its own older reading. It must not
    // close the window under the card that now names a different number.
    recheck.resolve(5);
    await flush();
    expect(scopedLibrary.run).not.toHaveBeenCalled();
    expect(operation(target)).toContain("7 terminal sessions in this window will stop.");
  });

  test("a Close card restored from a saved draft asks again before it closes", async () => {
    stubPopup();
    scopedLibrary.liveTerminals.mockResolvedValue(1);
    const target = openLauncher();
    await flush();
    await openWindowPage(target);
    // Nothing in this page read a count for the card a reload brought back.
    launcherDraft.operation = {
      kind: "confirm",
      itemId: "computers:close:w-captioned",
      title: `Close ${CAPTIONED}?`,
      message: "This window will close.",
      actionLabel: "Close",
      danger: true,
      selected: "cancel",
    };
    await tick();
    decision(target, "Close").click();
    await flush();
    expect(scopedLibrary.run).not.toHaveBeenCalled();
    expect(operation(target)).toContain("1 terminal session in this window will stop.");
  });

  test("a window that leaves the roster takes its Close count with it", async () => {
    stubPopup();
    scopedLibrary.liveTerminals.mockResolvedValue(2);
    const target = openLauncher();
    await flush();
    await openWindowPage(target);
    row(target, "Close window").click();
    await flush();
    expect(operation(target)).toContain("2 terminal sessions in this window will stop.");
    await key(target, "Escape");

    // The window goes and comes back while this always-mounted launcher is
    // hidden and shown; each showing reads the roster.
    scopedLibrary.load.mockResolvedValue({ ...librarySnapshot, windows: [librarySnapshot.windows[0]] });
    launcherPanel.open = false;
    await flush();
    launcherPanel.open = true;
    await flush();
    expect(titles(target)).not.toContain(CAPTIONED);
    scopedLibrary.load.mockResolvedValue(librarySnapshot);
    launcherPanel.open = false;
    await flush();
    launcherPanel.open = true;
    await flush();

    await openPage(target, CAPTIONED);
    launcherDraft.operation = {
      kind: "confirm",
      itemId: "computers:close:w-captioned",
      title: `Close ${CAPTIONED}?`,
      message: "2 terminal sessions in this window will stop.",
      actionLabel: "Close",
      danger: true,
      selected: "cancel",
    };
    await tick();

    // Nothing recorded a count for the roster's new entry, so Close asks
    // again instead of matching the reading the departed window left behind.
    decision(target, "Close").click();
    await flush();
    expect(scopedLibrary.run).not.toHaveBeenCalled();
    expect(operation(target)).toContain("2 terminal sessions in this window will stop.");
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
    await openWindowPage(target);
    // Show routes through the same focus call, which unhides and raises in one
    // step, so listing Focus beside it would be the same click twice.
    expect(titles(target)).toEqual(["Show window", "Close window"]);
  });

  test.each(["native", "unknown"] as const)("hidden %s deck Show changes visibility without a target popup or page check", async (origin) => {
    const record = { ...librarySnapshot.windows[1], hidden: true, connected: false, holders: [], ...(origin === "native" ? { origin: "native" as const } : { origin: undefined }) };
    scopedLibrary.load.mockResolvedValue({ ...librarySnapshot, windows: [librarySnapshot.windows[0], record] });
    const popup = vi.spyOn(window, "open").mockReturnValue(null);
    const { checkScopedWindowPage } = await import("../api/libraryCommand");
    const target = openLauncher();
    await flush();
    await openWindowPage(target);
    expect(titles(target)).toEqual(["Show window", "Open window", "Close window"]);
    row(target, "Show window").click();
    await flush();
    expect(scopedLibrary.run).toHaveBeenCalledExactlyOnceWith({ action: "set_window_visibility", window_id: "w-captioned", hidden: false });
    expect(popup).not.toHaveBeenCalled();
    expect(checkScopedWindowPage).not.toHaveBeenCalled();
    // Show leaves at once, as Focus and Open do, with no success card.
    expect(launcherPanel.open).toBe(false);
  });

  test.each(["native", "unknown"] as const)("visible %s deck row offers explicit Open without Focus", async (origin) => {
    const record = { ...librarySnapshot.windows[1], ...(origin === "native" ? { origin: "native" as const } : { origin: undefined }) };
    scopedLibrary.load.mockResolvedValue({ ...librarySnapshot, windows: [librarySnapshot.windows[0], record] });
    const target = openLauncher();
    await flush();
    await openWindowPage(target);
    expect(titles(target)).toEqual(["Open window", "Hide window", "Close window"]);
  });

  test("explicit Open of a hidden native record acquires its named browser popup without unhiding", async () => {
    const record = { ...librarySnapshot.windows[1], hidden: true, connected: false, holders: [], origin: "native" as const };
    scopedLibrary.load.mockResolvedValue({ ...librarySnapshot, windows: [librarySnapshot.windows[0], record] });
    const popup = { closed: false, location: { href: "about:blank" }, document: document.implementation.createHTMLDocument(), focus: vi.fn(), close: vi.fn() };
    const open = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const target = openLauncher();
    await flush();
    await openWindowPage(target);
    row(target, "Open window").click();
    await flush();
    expect(open).toHaveBeenCalledExactlyOnceWith("", "w-captioned");
    expect(popup.location.href).toContain("/w-captioned/launch?h=");
    expect(scopedLibrary.run).not.toHaveBeenCalled();
  });

  test("Focus reads a snapshot of its own before it navigates a disconnected window", async () => {
    const shown = {
      ...librarySnapshot,
      windows: [librarySnapshot.windows[0], { ...librarySnapshot.windows[1], connected: false }],
    };
    let answerRead: ((snapshot: unknown) => void) | undefined;
    scopedLibrary.load.mockImplementation((signal?: AbortSignal) =>
      signal ? new Promise((resolve) => { answerRead = resolve; }) : Promise.resolve(shown));
    const navigate = vi.fn();
    const popup = {
      close: vi.fn(),
      focus: vi.fn(),
      closed: false,
      document: document.implementation.createHTMLDocument(),
      location: {
        get href() { return "https://chan.test/project-a/?w=w-captioned"; },
        set href(url: string) { navigate(url); },
      },
    };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const target = openLauncher();
    await flush();
    await openWindowPage(target);
    row(target, "Focus window").click();
    await flush();

    expect(scopedLibrary.load).toHaveBeenCalledWith(expect.any(AbortSignal));
    answerRead?.({
      ...shown,
      windows: [shown.windows[0], { ...shown.windows[1], connected: true }],
    });
    await flush();
    expect(navigate).not.toHaveBeenCalled();
    expect(popup.focus).toHaveBeenCalled();
  });

  test("a control terminal offers Focus alone, matching what the capability route allows", async () => {
    const target = openLauncher();
    await flush();
    await openWindowPage(target, "Control terminal");
    // set_window_visibility and close_window both refuse a control terminal
    // server-side, so offering either here would only ever fail.
    expect(titles(target)).toEqual(["Focus window"]);
  });

  test("ArrowLeft goes back one page at a time", async () => {
    const target = openLauncher();
    await flush();
    await openComputers(target);
    await openPage(target, "Project A");
    await openPage(target, CAPTIONED);
    expect(launcherDraft.path).toEqual(["workspace:project-a", "window:w-captioned"]);
    expect(crumbs(target)).toEqual(["Computers", "Project A", CAPTIONED]);
    // Under its workspace's name the window does not repeat it.
    expect(titles(target)).toEqual(["Focus window", "Hide window", "Close window"]);
    await key(target, "ArrowLeft");
    expect(launcherDraft.path).toEqual(["workspace:project-a"]);
    expect(titles(target)).toContain("New window");
    await key(target, "ArrowLeft");
    expect(launcherDraft.path).toEqual([]);
    expect(launcherDraft.scope).toBe("computers");
    expect(titles(target)).toContain("New terminal window");
  });

  test("falls back to the list when that window closes elsewhere", async () => {
    const target = openLauncher();
    await flush();
    await openWindowPage(target);
    // The roster is polled while the deck is open, so the window can go while
    // its own actions are on screen.
    scopedLibrary.load.mockResolvedValue({
      ...librarySnapshot,
      windows: [librarySnapshot.windows[0]],
    });
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 2600));
    await flush();
    expect(launcherDraft.path).toEqual([]);
    expect(titles(target)).toEqual(["Project A", "Control terminal", "New terminal window"]);
    expect(launcherDraft.contextChanged).toBe(true);
  });

  test("falls back to the workspace's page when a window opened from it closes elsewhere", async () => {
    const target = openLauncher();
    await flush();
    await openComputers(target);
    await openPage(target, "Project A");
    await openPage(target, CAPTIONED);
    scopedLibrary.load.mockResolvedValue({
      ...librarySnapshot,
      windows: [librarySnapshot.windows[0]],
    });
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 2600));
    await flush();
    expect(launcherDraft.path).toEqual(["workspace:project-a"]);
    expect(titles(target)).toEqual(["New window"]);
  });

  // A draft restored after a reload can name a window that stays in the
  // roster and offers nothing here, or a page under a name this deck no
  // longer uses. Neither has a row in the list.
  test.each([
    ["a window with no action", ["window:w-captioned"]],
    ["a branch the deck no longer has", ["windows", "w-captioned"]],
  ])("a draft whose path names %s returns to the deck's root", async (_what, path) => {
    scopedLibrary.load.mockResolvedValue(unmanagedRoster(false));
    launcherDraft.scope = "computers";
    launcherDraft.path = path;
    const target = openLauncher();
    await flush();
    expect(launcherDraft.path).toEqual([]);
    expect(titles(target)).toEqual(["Project A", "Control terminal", "New terminal window"]);
    expect(launcherDraft.contextChanged).toBe(true);
  });

  test("an orb applies its scope and the list narrows to it", async () => {
    showFlip = true;
    const target = openLauncher();
    await flush();
    (target.querySelector('[aria-label="Window scope"]') as HTMLButtonElement).click();
    await tick();
    expect(launcherDraft.scope).toBe("window");
    expect(titles(target)).toEqual(["Search"]);
    (target.querySelector('[aria-label="Pane scope"]') as HTMLButtonElement).click();
    await tick();
    expect(launcherDraft.scope).toBe("pane");
    expect(titles(target)).toEqual(["Flip pane"]);
  });

  test("Enter runs the highlighted command and clears the draft", async () => {
    const target = openLauncher();
    await flush();
    await typeQuery(target, "Search");
    await key(target, "Enter");
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

  test("the window's chord closes the launcher from the query and keeps the draft", async () => {
    const toggleChord = (event: KeyboardEvent): boolean =>
      event.ctrlKey && event.altKey && event.key.toLowerCase() === "k";
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(CommandLauncher, { target, props: { toggleChord } }) as Record<string, unknown>);
    launcherPanel.open = true;
    await flush();
    await typeQuery(target, "project");
    const leaked = vi.fn();
    window.addEventListener("keydown", leaked);
    const chord = new KeyboardEvent("keydown", {
      key: "k", code: "KeyK", ctrlKey: true, altKey: true, bubbles: true, cancelable: true,
    });
    try {
      input(target).dispatchEvent(chord);
      await flush();
    } finally {
      window.removeEventListener("keydown", leaked);
    }
    expect(launcherPanel.open).toBe(false);
    expect(chord.defaultPrevented).toBe(true);
    expect(leaked, "the window's own listener is not reached a second time").not.toHaveBeenCalled();
    expect(launcherDraft.query).toBe("project");
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

  test("the deck draws the list under its section headings, in order", async () => {
    showBulk = true;
    setActiveTerminalTab();
    const target = openLauncher();
    await flush();
    // Settings holds the branch into the terminal's own section of the
    // settings index.
    expect([...target.querySelectorAll(".deck-section-title")].map((node) => node.textContent)).toEqual([
      "Terminal", "New tab", "Tab", "Window", "Settings", "Computers",
    ]);
    expect(titles(target)).toContain("Terminal settings");
    // A typed query is flat: rows from every section interleave by rank.
    await typeQuery(target, "restart");
    expect(target.querySelectorAll(".deck-section-title")).toHaveLength(0);
    expect(titles(target)[0]).toBe("Restart terminal");
  });

  test("Tab steps through the scopes this window offers", async () => {
    showFlip = true;
    const target = openLauncher();
    await flush();
    // No tab is focused, so the App scope is skipped.
    await key(target, "Tab");
    expect(launcherDraft.scope).toBe("pane");
    expect(titles(target)).toEqual(["Flip pane"]);
    await key(target, "Tab");
    expect(launcherDraft.scope).toBe("window");
    expect(titles(target)).toEqual(["Search"]);
  });

  test("Escape leaves a page before it closes the launcher", async () => {
    const target = openLauncher();
    await flush();
    await openComputers(target);
    await openPage(target, "Project A");
    expect(launcherDraft.path).toEqual(["workspace:project-a"]);
    await key(target, "Escape");
    expect(launcherDraft.path).toEqual([]);
    expect(launcherPanel.open).toBe(true);
    await key(target, "Escape");
    expect(launcherPanel.open).toBe(false);
  });

  test("Workspaces and Windows open from the list of every scope, and Escape or Backspace comes back", async () => {
    const target = openLauncher();
    await flush();
    await selectRow(target, "Workspaces");
    await key(target, "Enter");
    expect(launcherDraft.path).toEqual(["type:workspaces"]);
    expect(crumbs(target)).toEqual(["Computers", "Workspaces"]);
    expect(sectionTitles(target)).toEqual(["This machine"]);
    expect(titles(target)).toEqual(["Project A"]);

    // One level further, then back out a level at a time.
    await openPage(target, "Project A");
    expect(crumbs(target)).toEqual(["Computers", "Workspaces", "Project A"]);
    await key(target, "Escape");
    expect(launcherDraft.path).toEqual(["type:workspaces"]);
    await key(target, "Escape");
    expect(launcherDraft.path).toEqual([]);
    expect(launcherPanel.open, "Escape left the branch, not the launcher").toBe(true);
    expect(launcherDraft.scope).toBeNull();
    expect(titles(target)).toEqual(["Search", "New terminal window", "Workspaces", "Windows"]);

    // Right enters a branch as Enter does, and Backspace leaves it.
    await selectRow(target, "Windows");
    await key(target, "ArrowRight");
    expect(launcherDraft.path).toEqual(["type:windows"]);
    expect(crumbs(target)).toEqual(["Computers", "Windows"]);
    expect(titles(target)).toEqual(["Control terminal", CAPTIONED, "New terminal window"]);
    await key(target, "Backspace");
    expect(launcherDraft.path).toEqual([]);
    expect(launcherPanel.open).toBe(true);
    await key(target, "Escape");
    expect(launcherPanel.open).toBe(false);
  });

  test("a type's page restores after a reload, once the library answers", async () => {
    launcherDraft.path = ["type:windows"];
    const target = openLauncher();
    await flush();
    expect(launcherDraft.path).toEqual(["type:windows"]);
    expect(crumbs(target)).toEqual(["Computers", "Windows"]);
    expect(titles(target)).toEqual(["Control terminal", CAPTIONED, "New terminal window"]);
    expect(launcherDraft.contextChanged, "nothing moved under the reader").toBe(false);
  });
});

describe("the way to every computer", () => {
  /// Mount the launcher in a window whose app has a screen that lists every
  /// computer, and open it.
  function openBeside(show: (query: string) => void | Promise<void>): HTMLElement {
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(CommandLauncher, { target, props: { allComputers: show } }) as Record<string, unknown>);
    launcherPanel.open = true;
    return target;
  }

  test("the Computers scope ends with All computers... where the window's app has that screen", async () => {
    const target = openBeside(vi.fn());
    await flush();
    // The list of every scope ends with it too, a fourth row under Computers.
    expect(titles(target)).toEqual([
      "Search", "New terminal window", "Workspaces", "Windows", "All computers...",
    ]);
    expect(sectionTitles(target)).toEqual(["Window", "Computers"]);
    await openComputers(target);
    expect(sectionTitles(target)).toEqual(["Workspaces", "Windows", "New", "Chan Desktop"]);
    expect(titles(target)).toEqual([
      "Project A", "Control terminal", CAPTIONED, "New terminal window", "All computers...",
    ]);
    // A page lists one object, and no way out of the library.
    await openPage(target, "Project A");
    expect(titles(target)).not.toContain("All computers...");
  });

  test("the row that ends the list of every scope shows that screen, with nothing to search for", async () => {
    const show = vi.fn();
    const target = openBeside(show);
    await flush();
    await selectRow(target, "All computers...");
    expect(titles(target).at(-1)).toBe(selectedTitle(target));
    await key(target, "Enter");
    await flush();
    expect(show).toHaveBeenCalledExactlyOnceWith("");
    expect(launcherPanel.open).toBe(false);
    expect([launcherDraft.scope, launcherDraft.path, launcherDraft.query]).toEqual([null, [], ""]);
  });

  test("a window whose app has no such screen lists no such row", async () => {
    const target = openLauncher();
    await flush();
    expect(titles(target)).toEqual(["Search", "New terminal window", "Workspaces", "Windows"]);
    await openComputers(target);
    expect(sectionTitles(target)).toEqual(["Workspaces", "Windows", "New"]);
    await typeQuery(target, "geekom");
    expect(titles(target)).toEqual([]);
  });

  test("it shows that screen over the closed launcher, with nothing to search for when it was browsed to", async () => {
    const show = vi.fn();
    const target = openBeside(show);
    await flush();
    await openComputers(target);
    row(target, "All computers...").click();
    await flush();
    expect(show).toHaveBeenCalledExactlyOnceWith("");
    expect(launcherPanel.open).toBe(false);
    expect([launcherDraft.scope, launcherDraft.query]).toEqual([null, ""]);
  });

  test("a typed list of the scope ends with it whatever was typed, and it carries the query", async () => {
    const show = vi.fn();
    const target = openBeside(show);
    await flush();
    await openComputers(target);
    await typeQuery(target, "release checks");
    expect(titles(target)[0]).toBe(CAPTIONED);
    expect(titles(target).at(-1)).toBe("All computers...");
    // Nothing on this machine is named so, and the list is not empty.
    await typeQuery(target, "geekom shell");
    expect(titles(target)).toEqual(["All computers..."]);
    await key(target, "Enter");
    await flush();
    expect(show).toHaveBeenCalledExactlyOnceWith("geekom shell");
    expect(launcherPanel.open).toBe(false);
    expect(launcherDraft.query).toBe("");
  });

  test("among every scope the row is found by its own words, which are not carried", async () => {
    const show = vi.fn();
    const target = openBeside(show);
    await flush();
    await typeQuery(target, "geekom");
    expect(titles(target)).not.toContain("All computers...");
    await typeQuery(target, "all comp");
    expect(secondLine(target, "All computers...")).toBe("Computers › Chan Desktop");
    row(target, "All computers...").click();
    await flush();
    expect(show).toHaveBeenCalledExactlyOnceWith("");
  });

  test("a refusal to show the screen is reported once the launcher has closed", async () => {
    const notified = vi.spyOn(statusBus, "notify");
    const show = vi.fn().mockRejectedValue(new Error("the installed app refused this action"));
    const target = openBeside(show);
    await flush();
    await openComputers(target);
    row(target, "All computers...").click();
    await flush();
    expect(launcherPanel.open).toBe(false);
    expect(notified).toHaveBeenCalledExactlyOnceWith("All computers...: the installed app refused this action");
  });
});
