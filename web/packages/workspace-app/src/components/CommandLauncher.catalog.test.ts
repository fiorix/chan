// @vitest-environment jsdom
//
// What the launcher hands the deck: the scope rail, the sectioned list, the
// rows that change in place, the Settings rows and the typed results. A
// stand-in deck prints each row with its section, value and check, so these
// read the launcher's own output; the catalog, the settings index and the
// scoped library route are small fakes.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({
  specs: [] as unknown[],
  load: vi.fn(),
  run: vi.fn(),
}));

vi.mock("@chan/web-shared/CommandDeck.svelte", async () => import("./CommandLauncher.testDeck.svelte"));
vi.mock("../state/commands/install", () => ({}));
vi.mock("./settings/settingsIndex", () => ({ settingsIndex: () => fake.specs }));
vi.mock("../api/libraryCommand", () => ({
  loadScopedLibrarySnapshot: fake.load,
  loadScopedWindowLiveTerminals: vi.fn(),
  checkScopedWindowPage: vi.fn(async () => ({
    response: new Response("<html></html>"),
    readRefusal: async () => new Error("unexpected refusal"),
  })),
  runScopedLibraryAction: fake.run,
}));

import CommandLauncher from "./CommandLauncher.svelte";
import type { SettingSpec } from "./settings/settingsIndex";
import { loadSessionDeckDraft } from "@chan/web-shared/command-deck";
import { registerCommands, type CommandContext } from "../state/commands";
import * as statusBus from "../state/notify.svelte";
import { clearRecentCommands } from "../state/commands/recent.svelte";
import {
  clearLauncherDraft,
  closeCommandLauncher,
  closeSettings,
  launcherDraft,
  launcherPanel,
  openCommandLauncher,
  persistLauncherDraft,
  settingsPanel,
} from "../state/store.svelte";
import type { BrowserTab, TerminalTab } from "../state/tabs.svelte";
import { resetLayout } from "../__tests__/tabs";

const runAction = vi.fn();
const state = {
  dock: false,
  colour: "blue",
  filters: { tag: true, media: false },
  depth: 2,
};

const onTerminal = (ctx: CommandContext): boolean => ctx.activeSurface === "terminal";

registerCommands([
  {
    id: "cat.reload", title: "Reload window", category: "Global", scope: "window", order: 1,
    requirement: "any", available: () => true, run: runAction,
  },
  {
    id: "cat.dock", title: "Left file browser dock", category: "File Browser", scope: "window",
    order: 2, kind: "toggle", requirement: "any", available: () => true,
    // Plain state, outside the reactive graph, as a component-held value is.
    state: () => state.dock, run: () => { state.dock = !state.dock; },
  },
  {
    id: "cat.colour", title: "Focus border colour", category: "Panes", scope: "window", order: 3,
    kind: "choice", requirement: "any", available: () => true,
    state: () => state.colour,
    options: () => ["blue", "green"].map((id) => ({
      id, label: id, checked: state.colour === id, run: () => { state.colour = id; },
    })),
    run: () => openCommandLauncher(["command:cat.colour"]),
  },
  {
    id: "cat.filters", title: "Filters", category: "Graph", scope: "window", order: 4,
    kind: "choice", requirement: "any", available: () => true,
    options: () => (["tag", "media"] as const).map((id) => ({
      id, label: id, checked: state.filters[id], run: () => { state.filters[id] = !state.filters[id]; },
    })),
    run: () => {},
  },
  {
    id: "cat.depth", title: "Increase depth", category: "Graph", scope: "window", order: 5,
    requirement: "any", available: () => true,
    state: () => String(state.depth), run: () => { state.depth += 1; },
  },
  {
    id: "cat.close", title: "Close tab", category: "Tabs", scope: "pane", group: "Tab",
    requirement: "any", available: () => true, run: runAction,
  },
  {
    id: "cat.split", title: "Split right", category: "Panes", scope: "pane", group: "Pane",
    requirement: "any", available: () => true, run: runAction,
  },
  {
    id: "cat.term", title: "New terminal", category: "Apps", scope: "pane", group: "New tab",
    requirement: "any", available: () => true, run: runAction,
  },
  {
    id: "cat.restart", title: "Restart terminal", category: "Terminal", scope: "app",
    surface: "terminal", requirement: "any", available: onTerminal, run: runAction,
  },
  {
    id: "cat.search", title: "Search workspace", category: "Global", scope: "workspace",
    requirement: "workspace", available: () => true, run: runAction,
  },
  {
    id: "cat.settings", title: "Settings", category: "Global", scope: "settings", kind: "open",
    requirement: "any", available: () => true, run: runAction,
  },
  ...Array.from({ length: 7 }, (_, index) => ({
    id: `cat.select.${index}`, title: `Quux probe ${index}`, category: "File Browser" as const,
    scope: "app" as const, surface: "browser" as const, requirement: "any" as const,
    available: () => false, unavailableReason: () => "Needs a selection", run: runAction,
  })),
]);

const settingValues: Record<string, boolean | string> = {};

function settingSpecs(): SettingSpec[] {
  return [
    {
      id: "global.theme", section: "global", label: "Theme", kind: "choice",
      options: [{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }],
      read: () => settingValues["global.theme"] ?? null,
      write: (value) => { settingValues["global.theme"] = value; },
      available: () => true,
    },
    {
      id: "terminal.mouse", section: "terminal", label: "Mouse capture", kind: "toggle",
      read: () => settingValues["terminal.mouse"] ?? null,
      // A config write settles later than the click that asked for it.
      write: async (value) => {
        await Promise.resolve();
        settingValues["terminal.mouse"] = value;
      },
      available: () => true,
    },
    {
      id: "terminal.scrollback", section: "terminal", label: "Scrollback", kind: "open",
      read: () => "10000 lines", available: () => true,
    },
    {
      id: "shortcuts.grid", section: "shortcuts", label: "Keyboard Shortcuts", kind: "open",
      read: () => "", available: () => true,
    },
    {
      id: "browser.left", section: "browser", label: "Left file browser dock", kind: "toggle",
      read: () => state.dock, write: (value) => { state.dock = value === true; },
      available: () => true, command: "cat.dock",
    },
  ];
}

const librarySnapshot = {
  library_id: "lib-local-test",
  windows: [],
  workspaces: [
    {
      workspace_id: "project-a", path: "/work/project-a", label: "Project A", on: true,
      status: "running" as const, library_id: "lib-local-test", devserver_id: null, prefix: "project-a",
    },
  ],
};

/// A window of Project A, for the tests that need this machine to hold one.
const projectWindow = {
  window_id: "w-a", kind: "workspace" as const, title: "Project A Window 1", ordinal: 1, label: "",
  workspace_path: "/work/project-a", connected: true, hidden: false, control: false, tmux: false,
  origin: "browser" as const, launch_path: "/api/library/command-capabilities/cap/windows/w-a/launch",
};

const mounted: Array<Record<string, unknown>> = [];
let target: HTMLElement;

function setTerminalTab(): void {
  const pane = resetLayout([], { id: "catalog-pane" });
  const tab: TerminalTab = {
    kind: "terminal", id: "terminal-test", title: "Shell", createdAt: 0,
    broadcastEnabled: false, broadcastTargetIds: [],
  };
  pane.tabs = [tab];
  pane.activeTabId = tab.id;
}

function setBrowserTab(): void {
  const pane = resetLayout([], { id: "catalog-pane" });
  const tab: BrowserTab = { kind: "browser", id: "browser-test", title: "Files", inspectorOpen: false };
  pane.tabs = [tab];
  pane.activeTabId = tab.id;
}

async function flush(): Promise<void> {
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
}

async function open(): Promise<void> {
  openCommandLauncher();
  await flush();
}

function rows(): HTMLButtonElement[] {
  return [...target.querySelectorAll<HTMLButtonElement>(".probe-row")];
}

function titles(): string[] {
  return rows().map((row) => row.textContent ?? "");
}

function sections(): string[] {
  return [...new Set(rows().map((row) => row.dataset.section ?? ""))];
}

function row(title: string): HTMLButtonElement {
  const found = rows().find((candidate) => candidate.textContent === title);
  if (!found) throw new Error(`missing row ${title}; listed: ${titles().join(", ")}`);
  return found;
}

async function click(title: string): Promise<void> {
  row(title).click();
  await flush();
}

async function type(query: string): Promise<void> {
  const field = target.querySelector(".probe-query") as HTMLInputElement;
  field.value = query;
  field.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await flush();
}

async function scope(id: string): Promise<void> {
  (target.querySelector(`.probe-scope[data-id="${id}"]`) as HTMLButtonElement).click();
  await flush();
}

function crumbs(): string {
  return (target.querySelector(".probe") as HTMLElement).dataset.crumbs ?? "";
}

beforeEach(() => {
  sessionStorage.clear();
  clearRecentCommands();
  closeCommandLauncher();
  clearLauncherDraft();
  closeSettings();
  settingsPanel.target = null;
  Object.assign(state, { dock: false, colour: "blue", depth: 2 });
  state.filters = { tag: true, media: false };
  for (const key of Object.keys(settingValues)) delete settingValues[key];
  Object.assign(settingValues, { "global.theme": "light", "terminal.mouse": false });
  fake.specs = [];
  fake.load.mockResolvedValue(librarySnapshot);
  fake.run.mockResolvedValue(undefined);
  setTerminalTab();
  target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(CommandLauncher, { target }) as Record<string, unknown>);
});

afterEach(() => {
  for (const component of mounted.splice(0)) unmount(component);
  document.body.innerHTML = "";
  closeCommandLauncher();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("the scope rail", () => {
  const rail = () =>
    [...target.querySelectorAll<HTMLButtonElement>(".probe-scope")].map((orb) => [
      orb.dataset.id, orb.textContent, orb.dataset.caption, orb.dataset.available,
    ]);

  test("lists six scopes, the first named after the focused tab's app", async () => {
    await open();
    expect(rail()).toEqual([
      ["app", "Terminal", "", "true"],
      ["pane", "Pane", "", "true"],
      ["window", "Window", "", "true"],
      ["workspace", "Workspace", "", "true"],
      ["settings", "Settings", "", "true"],
      ["computers", "Computers", "", "true"],
    ]);
  });

  test("names a file browser in full and captions its orb Files", async () => {
    setBrowserTab();
    await open();
    expect(rail()[0]).toEqual(["app", "File browser", "Files", "true"]);
  });

  test("leaves the app orb unavailable with no tab", async () => {
    resetLayout([], { id: "catalog-pane" });
    await open();
    expect(rail()[0]).toEqual(["app", "App", "", "false"]);
  });

  test("a scope shows its own sections alone, and names itself in the crumbs", async () => {
    await open();
    expect(crumbs()).toBe("");
    await scope("pane");
    expect(sections()).toEqual(["New tab", "Tab", "Pane"]);
    expect(crumbs()).toBe("Pane");
    await scope("app");
    expect(titles()).toEqual(["Restart terminal"]);
    expect(crumbs()).toBe("Terminal");
  });
});

describe("browsing", () => {
  /// The rows as `section: title` lines.
  const outline = (): string[] =>
    rows().map((candidate) => `${candidate.dataset.section}: ${candidate.textContent}`);
  const computerRows = (): HTMLButtonElement[] =>
    rows().filter((candidate) => candidate.dataset.section === "Computers");

  test("sections run from the app to Computers", async () => {
    fake.load.mockResolvedValue({ ...librarySnapshot, windows: [projectWindow] });
    await open();
    expect(sections()).toEqual([
      "Terminal", "New tab", "Tab", "Pane", "Window", "Workspace", "Settings", "Computers",
    ]);
    // The list ends with the ways into this machine's tree, not the tree.
    expect(rows().slice(-3).map((r) => [r.textContent, r.dataset.kind, r.dataset.breadcrumb])).toEqual([
      ["New terminal window", "action", "Computers"],
      ["Workspaces", "branch", "Computers"],
      ["Windows", "branch", "Computers"],
    ]);
    expect(computerRows()).toHaveLength(3);
  });

  test("a type this machine holds none of has no row among the ways in", async () => {
    // The snapshot lists a workspace and no window.
    await open();
    expect(computerRows().map((r) => r.textContent)).toEqual(["New terminal window", "Workspaces"]);
  });

  test("no way in is listed before the library answers, and none inside a scope", async () => {
    let answer!: (snapshot: unknown) => void;
    fake.load.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    await open();
    expect(sections()).not.toContain("Computers");
    answer({ ...librarySnapshot, windows: [projectWindow] });
    await flush();
    expect(computerRows()).toHaveLength(3);
    await scope("window");
    expect(sections()).toEqual(["Window"]);
  });

  test("Workspaces opens the workspaces as the Computers scope lists them, and Back returns to the list", async () => {
    fake.load.mockResolvedValue({ ...librarySnapshot, windows: [projectWindow] });
    await open();
    await scope("computers");
    const inScope = rows()
      .filter((candidate) => candidate.dataset.section === "Workspaces")
      .map((candidate) => [candidate.dataset.id, candidate.textContent, candidate.dataset.value]);
    (target.querySelector(".probe-clear") as HTMLButtonElement).click();
    await flush();

    await click("Workspaces");
    expect(launcherDraft.path).toEqual(["type:workspaces"]);
    expect(launcherDraft.scope, "the branch is entered from every scope and stays there").toBeNull();
    expect(crumbs()).toBe("Computers > Workspaces");
    expect(outline()).toEqual(["This machine: Project A"]);
    expect(rows().map((r) => [r.dataset.id, r.textContent, r.dataset.value])).toEqual(inScope);

    // A workspace's page is one level further, and Back climbs one at a time.
    (target.querySelector('.probe-expand[data-id="computers:workspace:project-a"]') as HTMLButtonElement).click();
    await flush();
    expect(launcherDraft.path).toEqual(["type:workspaces", "workspace:project-a"]);
    expect(crumbs()).toBe("Computers > Workspaces > Project A");
    const back = target.querySelector(".probe-back") as HTMLButtonElement;
    back.click();
    await flush();
    expect(crumbs()).toBe("Computers > Workspaces");
    back.click();
    await flush();
    expect(launcherDraft.path).toEqual([]);
    expect(crumbs()).toBe("");
    expect(computerRows()).toHaveLength(3);
  });

  test("Windows opens the windows as the Computers scope lists them, with a new terminal window after", async () => {
    fake.load.mockResolvedValue({ ...librarySnapshot, windows: [projectWindow] });
    await open();
    await click("Windows");
    expect(launcherDraft.path).toEqual(["type:windows"]);
    expect(crumbs()).toBe("Computers > Windows");
    expect(outline()).toEqual(["This machine: Window 1", "New: New terminal window"]);
    expect(row("Window 1").dataset).toMatchObject({ subtitle: "Project A", expandable: "true" });
  });

  test("a query typed on a type's page searches that type alone", async () => {
    fake.load.mockResolvedValue({ ...librarySnapshot, windows: [projectWindow] });
    await open();
    await click("Windows");
    await type("project");
    expect(titles()).toEqual(expect.arrayContaining(["Window 1", "Focus Window 1", "Close Window 1"]));
    expect(titles()).not.toContain("Project A");
    expect(titles()).not.toContain("Workspaces");
  });

  test("the Computers scope lists the same rows under the tree's own sections", async () => {
    await open();
    await scope("computers");
    expect(rows().map((candidate) => `${candidate.dataset.section}: ${candidate.textContent}`)).toEqual([
      "Workspaces: Project A",
      "New: New terminal window",
    ]);
    expect(crumbs()).toBe("Computers");
  });

  test("a command that cannot run here is hidden", async () => {
    await open();
    expect(titles().filter((title) => title.startsWith("Quux probe"))).toEqual([]);
  });

  test("New terminal window runs at once, on this machine", async () => {
    vi.spyOn(window, "open").mockImplementation(
      () => ({ close: vi.fn(), focus: vi.fn(), closed: false, document: document.implementation.createHTMLDocument(), location: { href: "about:blank" } }) as unknown as Window,
    );
    await open();
    expect(row("New terminal window").dataset.kind).toBe("action");
    expect(row("New terminal window").dataset.breadcrumb).toBe("Computers");
    await click("New terminal window");
    expect(fake.run).toHaveBeenCalledExactlyOnceWith({ action: "new_terminal" });
  });

  test("a workspace opens a new window of itself, and its page holds the same action", async () => {
    vi.spyOn(window, "open").mockImplementation(
      () => ({ close: vi.fn(), focus: vi.fn(), closed: false, document: document.implementation.createHTMLDocument(), location: { href: "about:blank" } }) as unknown as Window,
    );
    await open();
    await scope("computers");
    expect(row("Project A").dataset).toMatchObject({ value: "on", expandable: "true", breadcrumb: "Workspaces" });
    (target.querySelector('.probe-expand[data-id="computers:workspace:project-a"]') as HTMLButtonElement).click();
    await flush();
    expect(crumbs()).toBe("Computers > Project A");
    expect(rows().map((candidate) => `${candidate.dataset.section}: ${candidate.textContent}`)).toEqual([
      "Actions: New window",
    ]);
    await click("New window");
    expect(fake.run).toHaveBeenCalledExactlyOnceWith({ action: "new_workspace_window", workspace_id: "project-a" });
  });

  test("this machine is found by its name, and its page lists what the window may do there", async () => {
    await open();
    await type("this machine");
    expect(row("This machine").dataset).toMatchObject({ kind: "branch", breadcrumb: "Computers" });
    await click("This machine");
    expect(crumbs()).toBe("Computers > This machine");
    expect(rows().map((candidate) => `${candidate.dataset.section}: ${candidate.textContent}`)).toEqual([
      "Actions: New terminal window",
      "Workspaces: Project A",
    ]);
  });
});

describe("rows that change in place", () => {
  test("a toggle flips with the launcher open and shows its new state", async () => {
    await open();
    expect(row("Left file browser dock").dataset.value).toBe("off");
    await click("Left file browser dock");
    expect(state.dock).toBe(true);
    expect(launcherPanel.open).toBe(true);
    expect(row("Left file browser dock").dataset.value).toBe("on");
    await click("Left file browser dock");
    expect(row("Left file browser dock").dataset.value).toBe("off");
  });

  test("an action that reports a value steps it with the launcher open", async () => {
    await open();
    await click("Increase depth");
    await click("Increase depth");
    expect(row("Increase depth").dataset.value).toBe("4");
    expect(launcherPanel.open).toBe(true);
  });

  test("a choice opens its options, and choosing one moves the check", async () => {
    await open();
    expect(row("Focus border colour").dataset.value).toBe("blue");
    await click("Focus border colour");
    expect(titles()).toEqual(["blue", "green"]);
    expect(crumbs()).toBe("Window > Focus border colour");
    expect(rows().map((r) => r.dataset.checked)).toEqual(["true", "false"]);

    await click("green");
    expect(state.colour).toBe("green");
    expect(launcherPanel.open).toBe(true);
    expect(rows().map((r) => r.dataset.checked)).toEqual(["false", "true"]);

    (target.querySelector(".probe-back") as HTMLButtonElement).click();
    await flush();
    expect(launcherDraft.path).toEqual([]);
    expect(row("Focus border colour").dataset.value).toBe("green");
  });

  test("a choice over a set checks each member that is on", async () => {
    await open();
    await click("Filters");
    expect(rows().map((r) => [r.textContent, r.dataset.checked])).toEqual([["tag", "true"], ["media", "false"]]);
    await click("media");
    expect(rows().map((r) => r.dataset.checked)).toEqual(["true", "true"]);
  });

  test("a choice entered from a typed query lists every option", async () => {
    await open();
    await type("focus border");
    await click("Focus border colour");
    expect(launcherDraft.query).toBe("");
    expect(titles()).toEqual(["blue", "green"]);
  });

  test("a choice run by its chord opens the launcher on its options", async () => {
    launcherDraft.query = "left over";
    openCommandLauncher(["command:cat.colour"]);
    await flush();
    expect(titles()).toEqual(["blue", "green"]);
    expect(launcherDraft.query).toBe("");
  });

  test("an action closes the launcher and runs", async () => {
    await open();
    await click("Reload window");
    expect(runAction).toHaveBeenCalledTimes(1);
    expect(launcherPanel.open).toBe(false);
  });

  test("a choice that leaves while its options show returns the launcher to the root", async () => {
    launcherDraft.path = ["command:cat.gone"];
    launcherPanel.open = true;
    await flush();
    expect(launcherDraft.path).toEqual([]);
    expect(launcherDraft.contextChanged).toBe(true);
    expect(titles()).toContain("Reload window");
  });
});

describe("recent commands", () => {
  test("a command run from the launcher leads the list at the next opening", async () => {
    await open();
    expect(sections()).not.toContain("Recent");
    await click("Reload window");
    await open();
    expect(sections()[0]).toBe("Recent");
    expect(rows()[0]?.textContent).toBe("Reload window");
    expect(rows()[0]?.dataset.id).toBe("recent:cat.reload");
  });

  test("a row changed in place joins the list at the next opening, not under the pointer", async () => {
    await open();
    const before = titles();
    await click("Left file browser dock");
    expect(titles()).toEqual(before);
    closeCommandLauncher();
    await flush();
    await open();
    expect(rows()[0]?.dataset.id).toBe("recent:cat.dock");
    expect(rows()[0]?.dataset.value).toBe("on");
  });

  test("an option chosen records its choice", async () => {
    await open();
    await click("Focus border colour");
    await click("green");
    closeCommandLauncher();
    await flush();
    await open();
    expect(rows()[0]?.dataset.id).toBe("recent:cat.colour");
    expect(rows()[0]?.dataset.kind).toBe("choice");
  });
});

describe("the Settings scope", () => {
  beforeEach(() => {
    fake.specs = settingSpecs();
  });

  test("lists the index by rail section, then the Settings row", async () => {
    await open();
    await scope("settings");
    expect(rows().map((r) => `${r.dataset.section}: ${r.textContent} = ${r.dataset.value}`)).toEqual([
      "Global: Theme = Light",
      "Terminal: Mouse capture = off",
      "Terminal: Scrollback = 10000 lines",
      "File browser: Left file browser dock = off",
      "Keyboard Shortcuts: Keyboard Shortcuts = ",
      "Settings: Settings = ",
    ]);
  });

  test("a toggle flips with the launcher open once its write settles", async () => {
    await open();
    await scope("settings");
    await click("Mouse capture");
    expect(settingValues["terminal.mouse"]).toBe(true);
    expect(launcherPanel.open).toBe(true);
    expect(row("Mouse capture").dataset.value).toBe("on");
  });

  test("a choice opens its options with a check on the current one", async () => {
    await open();
    await scope("settings");
    await click("Theme");
    expect(rows().map((r) => [r.textContent, r.dataset.checked])).toEqual([["Light", "true"], ["Dark", "false"]]);
    expect(crumbs()).toBe("Settings > Global > Theme");
    await click("Dark");
    expect(settingValues["global.theme"]).toBe("dark");
    expect(launcherPanel.open).toBe(true);
    expect(rows().map((r) => r.dataset.checked)).toEqual(["false", "true"]);
  });

  test("any other field opens Settings on that field and closes the launcher", async () => {
    await open();
    await scope("settings");
    await click("Scrollback");
    expect(launcherPanel.open).toBe(false);
    expect(settingsPanel.open).toBe(true);
    expect(settingsPanel.target).toEqual({ section: "terminal", field: "terminal.scrollback" });
  });

  test("Keyboard Shortcuts opens its section", async () => {
    await open();
    await scope("settings");
    await click("Keyboard Shortcuts");
    expect(launcherPanel.open).toBe(false);
    expect(settingsPanel.target).toEqual({ section: "shortcuts", field: "shortcuts.grid" });
  });

  test("a refused write goes through the deck's error path and the row reads the kept value", async () => {
    const notified = vi.spyOn(statusBus, "notify");
    fake.specs = settingSpecs().map((spec) =>
      spec.id === "terminal.mouse"
        ? { ...spec, write: async () => { throw new Error("configuration is locked"); } }
        : spec,
    );
    await open();
    await scope("settings");
    await click("Mouse capture");
    expect(notified).toHaveBeenCalledExactlyOnceWith("Mouse capture: configuration is locked");
    expect(row("Mouse capture").dataset.value).toBe("off");
    expect(launcherPanel.open).toBe(true);
  });

  test("a write that takes long holds the deck for a moment only, and its refusal still shows", async () => {
    const notified = vi.spyOn(statusBus, "notify");
    let refuse!: (error: Error) => void;
    fake.specs = settingSpecs().map((spec) =>
      spec.id === "terminal.mouse"
        ? { ...spec, write: () => new Promise<void>((_, reject) => { refuse = reject; }) }
        : spec,
    );
    await open();
    await scope("settings");
    const probe = target.querySelector(".probe") as HTMLElement;
    vi.useFakeTimers();
    try {
      row("Mouse capture").click();
      await vi.advanceTimersByTimeAsync(50);
      expect(probe.dataset.pending, "the deck waits on a write that has just started").toBe("1");
      await vi.advanceTimersByTimeAsync(1000);
      expect(probe.dataset.pending, "the deck is released while the write goes on").toBe("0");
      expect(notified).not.toHaveBeenCalled();

      refuse(new Error("model download failed"));
      await vi.advanceTimersByTimeAsync(0);
      expect(notified).toHaveBeenCalledExactlyOnceWith("Mouse capture: model download failed");
    } finally {
      vi.useRealTimers();
    }
  });

  test("the unscoped list offers the focused app's section as a branch", async () => {
    await open();
    expect(rows().filter((r) => r.dataset.section === "Settings").map((r) => [r.textContent, r.dataset.kind])).toEqual([
      ["Settings", "action"],
      ["Terminal settings", "branch"],
    ]);
    await click("Terminal settings");
    expect(titles()).toEqual(["Mouse capture", "Scrollback"]);
    expect(crumbs()).toBe("Settings > Terminal");
  });
});

describe("a typed query", () => {
  test("lists a setting's options as leaves that apply in one step", async () => {
    fake.specs = settingSpecs();
    await open();
    await type("dark");
    expect(row("Theme: Dark").dataset.checked).toBe("false");
    await click("Theme: Dark");
    expect(settingValues["global.theme"]).toBe("dark");
    expect(launcherPanel.open).toBe(true);
    expect(row("Theme: Dark").dataset.checked).toBe("true");
  });

  test("shows a setting a command also changes as the command alone", async () => {
    fake.specs = settingSpecs();
    await open();
    await type("left file browser dock");
    expect(rows().filter((r) => r.textContent === "Left file browser dock").map((r) => r.dataset.id)).toEqual([
      "command:cat.dock",
    ]);
  });

  test("lists commands that cannot run here last, dimmed, with the reason, five at most", async () => {
    await open();
    await type("quux");
    const listed = rows();
    expect(listed).toHaveLength(5);
    expect(listed.map((r) => [r.dataset.disabled, r.dataset.subtitle])).toEqual(
      Array.from({ length: 5 }, () => ["true", "Needs a file browser tab"]),
    );
    await type("o");
    const mixed = rows().map((r) => r.dataset.disabled);
    expect(mixed.indexOf("true")).toBeGreaterThan(0);
    expect(mixed.slice(mixed.indexOf("true")).every((disabled) => disabled === "true")).toBe(true);
    expect(mixed.filter((disabled) => disabled === "true")).toHaveLength(5);
  });

  test("a disabled row does not run", async () => {
    await open();
    await type("quux");
    rows()[0]!.click();
    await flush();
    expect(runAction).not.toHaveBeenCalled();
    expect(launcherPanel.open).toBe(true);
  });

  test("is flat: no row carries a section, this machine's among them", async () => {
    await open();
    await type("reload");
    expect(row("Reload window").dataset.section).toBe("");
    expect(row("Reload window").dataset.breadcrumb).toBe("Window");
    await type("terminal");
    expect(titles()).toEqual(expect.arrayContaining(["New terminal", "Restart terminal", "New terminal window"]));
    expect(sections()).toEqual([""]);
  });
});

describe("opening", () => {
  test("from closed starts at the root with no scope and keeps the query", async () => {
    await open();
    await scope("window");
    await click("Focus border colour");
    await type("gre");
    expect(launcherDraft.path).toEqual(["command:cat.colour"]);
    closeCommandLauncher();
    await flush();

    await open();
    expect(launcherDraft.path).toEqual([]);
    expect(launcherDraft.scope).toBeNull();
    expect(launcherDraft.query).toBe("gre");
    expect((target.querySelector(".probe-query") as HTMLInputElement).value).toBe("gre");
  });

  test("a second open while it is up changes nothing", async () => {
    await open();
    await scope("window");
    await click("Focus border colour");
    openCommandLauncher();
    await flush();
    expect(launcherDraft.path).toEqual(["command:cat.colour"]);
    expect(launcherDraft.scope).toBe("window");
  });

  test("a reload restores an open launcher as it stood", async () => {
    await open();
    await scope("window");
    await click("Focus border colour");
    persistLauncherDraft();
    for (const component of mounted.splice(0)) unmount(component);

    Object.assign(launcherDraft, loadSessionDeckDraft("chan.command-launcher.v1:contextual"));
    mounted.push(mount(CommandLauncher, { target }) as Record<string, unknown>);
    await flush();
    expect(launcherDraft.visible).toBe(true);
    expect(launcherDraft.scope).toBe("window");
    expect(titles()).toEqual(["blue", "green"]);
  });

  test("a restored scope this window does not list is dropped", async () => {
    launcherDraft.scope = "tab";
    launcherPanel.open = true;
    await flush();
    expect(launcherDraft.scope).toBeNull();
    expect(sections()).toContain("Window");
  });
});
