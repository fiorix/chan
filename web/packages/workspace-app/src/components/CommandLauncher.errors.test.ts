// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { loadSessionDeckDraft } from "@chan/web-shared/command-deck";

const scoped = vi.hoisted(() => ({ snapshot: null as unknown, run: vi.fn() }));
const settings = vi.hoisted(() => ({ specs: [] as unknown[] }));
vi.mock("../state/commands/install", () => ({}));
vi.mock("./settings/settingsIndex", () => ({ settingsIndex: () => settings.specs }));
vi.mock("../api/libraryCommand", () => ({
  loadScopedLibrarySnapshot: vi.fn(async () => scoped.snapshot),
  loadScopedWindowLiveTerminals: vi.fn(),
  checkScopedWindowPage: vi.fn(),
  runScopedLibraryAction: scoped.run,
}));

import CommandLauncher from "./CommandLauncher.svelte";
import AppStatusBar from "./AppStatusBar.svelte";
import type { SettingSpec } from "./settings/settingsIndex";
import * as statusBus from "../state/notify.svelte";
import {
  clearLauncherDraft, closeCommandLauncher, dismissStatus, hybridSurfaceThemes,
  launcherDraft, openCommandLauncher, persistLauncherDraft, setHybridSurfaceTheme,
  setThemeChoice, ui,
} from "../state/store.svelte";
import { resetLayout } from "../__tests__/tabs";

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
  Object.assign(launcherDraft, loadSessionDeckDraft("chan.command-launcher.v1:contextual"));
  app = mount(CommandLauncher, { target });
  await flush();
  expect(target.querySelector(".deck-operation")).toBeNull();
}

beforeEach(() => {
  vi.useFakeTimers();
  sessionStorage.clear();
  scoped.snapshot = null;
  scoped.run.mockReset();
  settings.specs = [];
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
        control: false, tmux: false, launch_path: "/cap/windows/w-other/launch",
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

// The theme fields as the settings index lists them, over the store's own
// writers: a refused write rolls the choice back and rejects.
const themes = [
  ["Theme", null, "system"],
  ["Theme", null, "light"],
  ["Theme", null, "dark"],
  ["Editor body theme", "editor", "light"],
  ["Editor body theme", "editor", "dark"],
  ["File browser body theme", "browser", "light"],
  ["File browser body theme", "browser", "dark"],
  ["Terminal body theme", "terminal", "light"],
  ["Terminal body theme", "terminal", "dark"],
  ["Dashboard body theme", "dashboard", "light"],
  ["Dashboard body theme", "dashboard", "dark"],
  ["Graph body theme", "graph", "light"],
  ["Graph body theme", "graph", "dark"],
] as const;

type ThemeSurface = Exclude<typeof themes[number][1], null>;

const OPTION_WORDS = { system: "System", light: "Light", dark: "Dark" } as const;

function themeSpecs(): SettingSpec[] {
  const surfaces: [string, ThemeSurface][] = [
    ["Editor body theme", "editor"],
    ["File browser body theme", "browser"],
    ["Terminal body theme", "terminal"],
    ["Dashboard body theme", "dashboard"],
    ["Graph body theme", "graph"],
  ];
  return [
    {
      id: "global.theme", section: "global", label: "Theme", kind: "choice",
      options: (["system", "light", "dark"] as const).map((value) => ({ value, label: OPTION_WORDS[value] })),
      read: () => ui.themeChoice,
      write: (value) => setThemeChoice(value as "system" | "light" | "dark"),
      available: () => true,
    },
    ...surfaces.map(([label, surface]): SettingSpec => ({
      id: `${surface}.body_theme`, section: "global", label, kind: "choice",
      options: (["light", "dark"] as const).map((value) => ({ value, label: OPTION_WORDS[value] })),
      read: () => hybridSurfaceThemes[surface] ?? null,
      write: (value) => setHybridSurfaceTheme(surface, value as "light" | "dark"),
      available: () => true,
    })),
  ];
}

describe("setting rejection destinations", () => {
  /// Choose `title` among the typed results and leave its config write
  /// unanswered: the returned handle answers it.
  async function chooseWithPendingWrite(title: string, previous: "light" | "dark") {
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
    await search(title);
    row(title).click();
    await flush();
    return { patch, writes };
  }

  it.each(themes)("%s (%s, %s) rolls back and reports once after its deck closes", async (label, surface, choice) => {
    settings.specs = themeSpecs();
    const previous = choice === "dark" ? "light" : "dark";
    ui.themeChoice = previous;
    ui.theme = previous;
    if (surface) hybridSurfaceThemes[surface] = previous;
    const title = `${label}: ${OPTION_WORDS[choice]}`;
    const { patch, writes } = await chooseWithPendingWrite(title, previous);
    // The choice applies in place: the deck stays up over the new theme.
    expect(launcherDraft.visible).toBe(true);
    expect(surface ? hybridSurfaceThemes[surface] : ui.themeChoice).toBe(choice);
    expect(writes).toEqual([{
      expected_revision: 1,
      preferences: surface ? { hybrid_surface_themes: expect.objectContaining({ [surface]: choice }) } : { theme: choice },
    }]);
    closeCommandLauncher();
    await flush();
    const reason = `${label} write refused`;
    patch.resolve(new Response(JSON.stringify({ error: reason }), { status: 403 }));
    await flush();
    expect(surface ? hybridSurfaceThemes[surface] : ui.themeChoice).toBe(previous);
    const sentence = `${title}: ${reason}`;
    expect(notified).toHaveBeenCalledExactlyOnceWith(sentence);
    expect(ui.status).toBe(sentence);
    expect(statusTarget.querySelector('[aria-label="status message"]')?.textContent).toContain(sentence);
    expect(launcherDraft.operation).toBeNull();
    await reopenAndReload();
    expect(notified).toHaveBeenCalledTimes(1);
  });

  it("a write refused while the deck is still up shows on the deck's card", async () => {
    settings.specs = themeSpecs();
    ui.themeChoice = "light";
    ui.theme = "light";
    const { patch } = await chooseWithPendingWrite("Theme: Dark", "light");
    patch.resolve(new Response(JSON.stringify({ error: "theme write refused" }), { status: 403 }));
    await flush();
    expect(ui.themeChoice).toBe("light");
    expect(target.querySelector(".deck-operation")?.textContent).toContain("theme write refused");
    expect(target.querySelectorAll(".deck-operation-icon.error")).toHaveLength(1);
    expect(notified).not.toHaveBeenCalled();
    expect(ui.status).toBeNull();
  });
});
