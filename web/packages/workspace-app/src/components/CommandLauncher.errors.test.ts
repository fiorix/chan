// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { loadSessionDeckDraft } from "@chan/web-shared/command-deck";

const scoped = vi.hoisted(() => ({ snapshot: null as unknown, run: vi.fn() }));
vi.mock("../state/commands/install", () => ({}));
vi.mock("../api/libraryCommand", () => ({
  loadScopedLibrarySnapshot: vi.fn(async () => scoped.snapshot),
  loadScopedWindowLiveTerminals: vi.fn(),
  checkScopedWindowPage: vi.fn(),
  runScopedLibraryAction: scoped.run,
}));

import CommandLauncher from "./CommandLauncher.svelte";
import AppStatusBar from "./AppStatusBar.svelte";
import { allCommands } from "../state/commands";
import "../state/commands/global";
import "../state/commands/editor";
import "../state/commands/browser";
import "../state/commands/terminal";
import "../state/commands/dashboard";
import "../state/commands/graph";
import * as statusBus from "../state/notify.svelte";
import {
  clearLauncherDraft, closeCommandLauncher, dismissStatus, hybridSurfaceThemes,
  launcherDraft, openCommandLauncher, persistLauncherDraft, ui,
} from "../state/store.svelte";
import { fileTab, resetLayout, terminalTab } from "../__tests__/tabs";
import type { Tab } from "../state/tabs.svelte";

Element.prototype.scrollIntoView = vi.fn();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

let target: HTMLElement;
let statusTarget: HTMLElement;
let app: Record<string, unknown>;
let bar: Record<string, unknown>;
let notified: MockInstance<typeof statusBus.notify>;

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) { await Promise.resolve(); await tick(); }
}

function row(title: string): HTMLButtonElement {
  const found = [...target.querySelectorAll<HTMLButtonElement>(".deck-result")]
    .find((button) => button.querySelector(".deck-result-title")?.textContent === title);
  expect(found, `command ${title} is available`).toBeDefined();
  return found!;
}

async function search(title: string): Promise<void> {
  const input = target.querySelector<HTMLInputElement>(".deck-input")!;
  input.value = title;
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await flush();
}

async function reopenAndReload(): Promise<void> {
  openCommandLauncher();
  await flush();
  expect(target.querySelector(".deck-operation")).toBeNull();
  persistLauncherDraft();
  unmount(app);
  Object.assign(launcherDraft, loadSessionDeckDraft("chan.command-launcher.v1:contextual", "contextual"));
  app = mount(CommandLauncher, { target });
  await flush();
  expect(target.querySelector(".deck-operation")).toBeNull();
}

beforeEach(() => {
  vi.useFakeTimers();
  sessionStorage.clear();
  scoped.snapshot = null;
  scoped.run.mockReset();
  closeCommandLauncher();
  clearLauncherDraft();
  dismissStatus();
  ui.terminalOnly = false;
  ui.terminalControl = false;
  resetLayout();
  notified = vi.spyOn(statusBus, "notify");
  target = document.createElement("div");
  statusTarget = document.createElement("div");
  document.body.append(target, statusTarget);
  app = mount(CommandLauncher, { target });
  bar = mount(AppStatusBar, { target: statusTarget });
});

afterEach(() => {
  unmount(app);
  unmount(bar);
  target.remove();
  statusTarget.remove();
  closeCommandLauncher();
  dismissStatus();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("scoped command rejection destinations", () => {
  it.each(["visible", "hidden", "cleared and reopened"])("reports a scoped rejection once when %s", async (surface) => {
    scoped.snapshot = {
      library_id: "lib-test", workspaces: [], windows: [{
        window_id: "w-other", kind: "workspace", title: "Notes", ordinal: 2,
        label: "Notes", workspace_path: "/work/notes", connected: true, hidden: false,
        control: false, launch_path: "/cap/windows/w-other/launch",
      }],
    };
    const pending = deferred<void>();
    vi.spyOn(window, "open").mockReturnValue({ close: vi.fn() } as unknown as Window);
    scoped.run.mockImplementation(() => pending.promise);
    openCommandLauncher();
    await flush();
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    await search("hide notes");
    row("Hide").click();
    await flush();
    expect(scoped.run).toHaveBeenCalledExactlyOnceWith({ action: "set_window_visibility", window_id: "w-other", hidden: true });
    expect(launcherDraft.operation?.kind).toBe("pending");
    if (surface !== "visible") closeCommandLauncher();
    await flush();
    if (surface === "cleared and reopened") { clearLauncherDraft(); openCommandLauncher(); }
    await flush();
    pending.reject(new Error(`Hide ${surface} refused`));
    await flush();
    if (surface === "visible") {
      expect(target.querySelector(".deck-operation")?.textContent).toContain(`Hide ${surface} refused`);
      expect(target.querySelectorAll(".deck-operation-icon.error")).toHaveLength(1);
      expect(notified).not.toHaveBeenCalled();
      expect(ui.status).toBeNull();
    } else {
      const sentence = `Hide: Hide ${surface} refused`;
      expect(notified).toHaveBeenCalledExactlyOnceWith(sentence);
      expect(ui.status).toBe(sentence);
      expect(statusTarget.querySelector('[aria-label="status message"]')?.textContent).toContain(sentence);
      expect(launcherDraft.operation).toBeNull();
      await reopenAndReload();
      expect(notified).toHaveBeenCalledTimes(1);
    }
  });
});

const themes = [
  ["app.theme.system", null, "system"],
  ["app.theme.light", null, "light"],
  ["app.theme.dark", null, "dark"],
  ["app.editor.surfaceTheme.light", "editor", "light"],
  ["app.editor.surfaceTheme.dark", "editor", "dark"],
  ["app.browser.surfaceTheme.light", "browser", "light"],
  ["app.browser.surfaceTheme.dark", "browser", "dark"],
  ["app.terminal.surfaceTheme.light", "terminal", "light"],
  ["app.terminal.surfaceTheme.dark", "terminal", "dark"],
  ["app.dashboard.surfaceTheme.light", "dashboard", "light"],
  ["app.dashboard.surfaceTheme.dark", "dashboard", "dark"],
  ["app.graph.surfaceTheme.light", "graph", "light"],
  ["app.graph.surfaceTheme.dark", "graph", "dark"],
] as const;

function surfaceTab(surface: typeof themes[number][1]): Tab | null {
  switch (surface) {
    case "editor": return fileTab();
    case "terminal": return terminalTab();
    case "browser": return { kind: "browser", id: "browser", title: "Files", inspectorOpen: false };
    case "dashboard": return { kind: "dashboard", id: "dashboard", title: "Dashboard" };
    case "graph": return {
      kind: "graph", id: "graph", title: "Graph", mode: "semantic", scopeId: "", depth: 1,
      expanded: {}, inspectorOpen: false, pendingSelectId: null,
      filters: { link: true, tag: true, mention: true, language: true, img: true, folder: true, markdown: true, source: true },
    };
    default: return null;
  }
}

describe("preference command rejection destinations", () => {
  it.each(themes)("%s rolls back and reports once after closing its deck", async (id, surface, choice) => {
    const command = allCommands().find((entry) => entry.id === id)!;
    expect(command).toBeDefined();
    const tab = surfaceTab(surface);
    resetLayout(tab ? [tab] : []);
    const previous = choice === "dark" ? "light" : "dark";
    ui.themeChoice = previous;
    ui.theme = previous;
    if (surface) hybridSurfaceThemes[surface] = previous;
    const patch = deferred<Response>();
    const writes: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (!String(input).includes("/api/config")) return new Response(null, { status: 404 });
      if (init?.method === "PATCH") {
        writes.push(JSON.parse(String(init.body)));
        return patch.promise;
      }
      return new Response(JSON.stringify({ revision: 1, preferences: { theme: previous }, workspaces: [] }));
    });
    openCommandLauncher();
    await flush();
    await search(command.title);
    row(command.title).click();
    await flush();
    expect(launcherDraft.visible).toBe(false);
    expect(surface ? hybridSurfaceThemes[surface] : ui.themeChoice).toBe(choice);
    expect(writes).toEqual([{
      expected_revision: 1,
      preferences: surface ? { hybrid_surface_themes: expect.objectContaining({ [surface]: choice }) } : { theme: choice },
    }]);
    const reason = `${id} write refused`;
    patch.resolve(new Response(JSON.stringify({ error: reason }), { status: 403 }));
    await flush();
    expect(surface ? hybridSurfaceThemes[surface] : ui.themeChoice).toBe(previous);
    const sentence = `${command.title}: ${reason}`;
    expect(notified).toHaveBeenCalledExactlyOnceWith(sentence);
    expect(ui.status).toBe(sentence);
    expect(statusTarget.querySelector('[aria-label="status message"]')?.textContent).toContain(sentence);
    expect(launcherDraft.operation).toBeNull();
    await reopenAndReload();
    expect(notified).toHaveBeenCalledTimes(1);
  });
});
