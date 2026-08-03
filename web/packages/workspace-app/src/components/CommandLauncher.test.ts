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
import { ApiError } from "../api/errors";
import {
  clearLauncherDraft,
  launcherDraft,
  launcherPanel,
  openCommandLauncher,
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

function snapshot(windowMode: "browser" | "desktop" | "native_watcher" = "browser") {
  return {
    library_id: "lib-local-test",
    role: "owner" as const,
    window_mode: windowMode,
    windows: [
      {
        window_id: "control-1",
        kind: "terminal" as const,
        title: "Control terminal",
        ordinal: 1,
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
}

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

function result(target: HTMLElement, title: string): HTMLButtonElement {
  const row = [...target.querySelectorAll<HTMLButtonElement>("button.deck-result")].find(
    (button) => button.querySelector(".deck-result-title")?.textContent === title,
  );
  if (!row) throw new Error(`missing ${title}; visible: ${titles(target).join(", ")}`);
  return row;
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
  launcherPanel.open = false;
  clearLauncherDraft();
  resetLayout();
  searchPanel.open = false;
  overlayStack.ids = [];
  overlayAtFlipRun = null;
  showFlip = false;
  scopedLibrary.load.mockResolvedValue(snapshot());
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

describe("inline contextual command deck", () => {
  test("renders nothing while closed", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(CommandLauncher, { target }) as Record<string, unknown>);
    await flush();
    expect(target.querySelector(".deck-shell")).toBeNull();
  });

  test("opens focused and empty with four persistent scope orbs", async () => {
    const target = openLauncher();
    await flush();
    expect(document.activeElement).toBe(input(target));
    expect(titles(target)).toEqual([]);
    expect(target.querySelectorAll(".deck-scope")).toHaveLength(4);
    expect(target.querySelector('[aria-label="Computers scope"]')?.hasAttribute("disabled")).toBe(
      false,
    );
  });

  test("ranks focused-tab matches first", async () => {
    setActiveBrowserTab();
    const target = openLauncher();
    await flush();
    await typeQuery(target, "files");
    expect(titles(target).slice(0, 2)).toEqual(["Zoom browser", "Alpha browser"]);
    expect(target.querySelector(".deck-result-path")?.textContent).toBe("Tab › File Browser");
  });

  test("typed search crosses into this library without opening a submenu", async () => {
    const target = openLauncher();
    await flush();
    await typeQuery(target, "control terminal");
    expect(titles(target)[0]).toBe("Control terminal");
    expect(target.querySelector(".deck-result-path")?.textContent).toContain("Computers › Focus");
  });

  test("a browser-owned new terminal gets a fresh launcher draft", async () => {
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
    result(target, "This library").click();
    await flush();

    expect(scopedLibrary.run).toHaveBeenCalledWith({ action: "new_terminal" });
    expect(popup?.sessionStorage.getItem("chan.command-launcher.v1:contextual")).toBeNull();
    expect(popup?.sessionStorage.getItem("chan.auth.token")).toBe("keep-me");
    expect(sessionStorage.getItem("chan.command-launcher.v1:contextual")).not.toBeNull();
  });

  test("a direct standalone tenant opens only same-tenant browser windows", async () => {
    scopedLibrary.load.mockRejectedValue(new ApiError(404, "not found"));
    sessionStorage.setItem("chan.token", "standalone-token");
    let popup:
      | {
          name: string;
          location: { href: string };
          focus: ReturnType<typeof vi.fn>;
          sessionStorage: Storage;
        }
      | undefined;
    vi.spyOn(window, "open").mockImplementation(() => {
      popup = {
        name: "",
        location: { href: "" },
        focus: vi.fn(),
        sessionStorage: clonedSessionStorage(sessionStorage),
      };
      return popup as unknown as Window;
    });

    const target = openLauncher();
    await flush();
    const computers = target.querySelector(
      '[aria-label="Computers scope"]',
    ) as HTMLButtonElement;
    expect(computers.disabled).toBe(false);
    computers.click();
    await tick();
    expect(titles(target)).toEqual(["New terminal", "New window"]);
    result(target, "New terminal").click();
    await tick();
    result(target, "This server").click();
    await flush();

    expect(scopedLibrary.run).not.toHaveBeenCalled();
    expect(popup?.name).toMatch(/^standalone-/);
    expect(popup?.location.href).toMatch(
      /^\/index\.html\?w=standalone-[^&]+&kind=terminal$/,
    );
    expect(popup?.sessionStorage.getItem("chan.command-launcher.v1:contextual")).toBeNull();
    expect(popup?.sessionStorage.getItem("chan.token")).toBe("standalone-token");
    expect(launcherPanel.open).toBe(false);
  });

  test("a read-only library capability exposes no window actions", async () => {
    const readonly = snapshot();
    scopedLibrary.load.mockResolvedValue({
      ...readonly,
      role: "readonly",
      windows: readonly.windows.map((window) => ({ ...window, can_act: false })),
      workspaces: readonly.workspaces.map((workspace) => ({ ...workspace, can_act: false })),
    });
    const target = openLauncher();
    await flush();
    const computers = target.querySelector(
      '[aria-label="Computers scope"]',
    ) as HTMLButtonElement;
    expect(computers.disabled).toBe(true);
    computers.click();
    await tick();

    expect(titles(target)).toEqual([]);
    expect(scopedLibrary.run).not.toHaveBeenCalled();
  });

  test("a native-watcher launch creates a record without opening a browser popup", async () => {
    scopedLibrary.load.mockResolvedValue(snapshot("native_watcher"));
    scopedLibrary.run.mockResolvedValue({ window: { window_id: "terminal-native" } });
    const open = vi.spyOn(window, "open");
    const target = openLauncher();
    await flush();
    (target.querySelector('[aria-label="Computers scope"]') as HTMLButtonElement).click();
    await tick();
    result(target, "New terminal").click();
    await tick();
    result(target, "This library").click();
    await flush();

    expect(scopedLibrary.run).toHaveBeenCalledWith({ action: "new_terminal" });
    expect(open).not.toHaveBeenCalled();
  });

  test("the Computers branch returns with ArrowLeft and a hidden draft resumes", async () => {
    const target = openLauncher();
    await flush();
    (target.querySelector('[aria-label="Computers scope"]') as HTMLButtonElement).click();
    await tick();
    result(target, "New window").click();
    await tick();
    expect(launcherDraft.path).toEqual(["new-window"]);
    expect(target.querySelector(".deck-placeholder")?.textContent).toBe("New window");
    expect(titles(target)).toEqual(["Project A"]);
    await key(target, "ArrowLeft");
    expect(launcherDraft.path).toEqual([]);

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

  test("leaves an underlying overlay on top before dispatching", async () => {
    showFlip = true;
    searchPanel.open = true;
    const target = openLauncher();
    await flush();
    syncOverlayStack();
    expect(overlayStack.ids).toEqual(["search", "launcher"]);

    await typeQuery(target, "Flip pane");
    await key(target, "Enter");

    expect(overlayAtFlipRun).toBe("search");
    expect(runFlip).not.toHaveBeenCalled();
    expect(overlayStack.ids).toEqual(["search"]);
  });

  test("restores focus to the invoking element when dismissed", async () => {
    const target = document.createElement("div");
    const invokingButton = document.createElement("button");
    document.body.append(invokingButton, target);
    mounted.push(mount(CommandLauncher, { target }) as Record<string, unknown>);
    invokingButton.focus();

    openCommandLauncher();
    await flush();
    expect(document.activeElement).toBe(input(target));

    await key(target, "Escape");
    await flush();
    expect(document.activeElement).toBe(invokingButton);
  });

  test("keeps the shared deck's motion and theme-aware scrim", () => {
    expect(deckRaw).toContain("padding: min(17vh, 136px) 16px 16px;");
    expect(deckRaw).toContain("--deck-scrim: rgba(0, 0, 0, 0.56);");
    expect(deckRaw).toContain(':global([data-theme="light"]) .deck-overlay');
    expect(deckRaw).toContain('filter id="chan-command-orb-blob"');
    expect(deckRaw).toMatch(/\.deck-shell \{[\s\S]{1,360}animation: deck-arrive/);
  });
});
