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
import { layout, type BrowserTab, type LeafNode } from "../state/tabs.svelte";

Element.prototype.scrollIntoView = vi.fn();

const runSearch = vi.fn();
const runNewFile = vi.fn();
const runBrowserAlpha = vi.fn();
const runBrowserZoom = vi.fn();
const runFlip = vi.fn();
let overlayAtFlipRun: ReturnType<typeof topOverlay> = null;
let showFlip = false;

registerCommands([
  {
    id: "app.window.reload",
    title: "Search",
    category: "Global",
    keywords: ["find"],
    available: () => true,
    run: runSearch,
  },
  {
    id: "app.file.new",
    title: "New file",
    category: "Editor",
    keywords: ["create"],
    available: () => true,
    run: runNewFile,
  },
  {
    id: "app.browser.alpha",
    title: "Alpha browser",
    category: "File Browser",
    keywords: ["files"],
    available: () => true,
    run: runBrowserAlpha,
  },
  {
    id: "app.browser.zoom",
    title: "Zoom browser",
    category: "File Browser",
    keywords: ["files"],
    available: () => true,
    run: runBrowserZoom,
  },
  {
    id: "app.pane.flip",
    title: "Flip pane",
    category: "Global",
    available: () => showFlip,
    run: () => {
      overlayAtFlipRun = topOverlay();
      if (overlayAtFlipRun === null) runFlip();
    },
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
      label: "devserver",
      workspace_path: null,
      connected: true,
      hidden: false,
      control: true,
      can_act: true,
      launch_path: "/api/library/command-capabilities/cap/windows/control-1/launch",
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

  test("fuzzy search crosses into Computers leaves without opening a submenu", async () => {
    const target = openLauncher();
    await flush();
    await typeQuery(target, "control terminal");
    expect(titles(target)[0]).toBe("Control terminal — devserver");
    expect(target.querySelector(".deck-result-path")?.textContent).toContain("Computers › Focus");
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
    expect(titles(target)).toEqual(["New terminal", "New window", "Focus", "Hide", "Show"]);

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

  test("uses a transparent backdrop and smooth capsule/orb motion", () => {
    expect(deckRaw).toMatch(/\.deck-backdrop \{[\s\S]{1,220}background: transparent/);
    expect(deckRaw).toContain('filter id="chan-command-orb-blob"');
    expect(deckRaw).toMatch(/\.deck-shell \{[\s\S]{1,360}animation: deck-arrive/);
    expect(deckRaw).toMatch(/\.deck-scope \{[\s\S]{1,500}animation: orb-arrive/);
  });
});
