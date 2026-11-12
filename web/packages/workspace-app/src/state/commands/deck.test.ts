// The launcher's lists, built from a small catalog and a fake settings index:
// what an empty query shows and in what order, what a scope narrows it to,
// how a toggle, a choice and a setting are listed, and what a typed query
// adds. No component is mounted; the builders are plain functions.

import { rankDeckItems } from "@chan/web-shared/command-deck";
import { describe, expect, test, vi } from "vitest";
import type { SettingSpec } from "../../components/settings/settingsIndex";
import type { Command, CommandContext } from "../commands";
import {
  RECENT_LIMIT,
  UNAVAILABLE_LIMIT,
  branchRows,
  browseRows,
  deckCrumbs,
  isCatalogPath,
  searchRows,
  type DeckRow,
  type DeckSource,
} from "./deck";

function context(partial: Partial<CommandContext> = {}): CommandContext {
  return {
    terminalOnly: false,
    terminalControl: false,
    caps: { workspace: true, files: true, drafts: true, terminal: true },
    activeSurface: "terminal",
    activeSide: "a",
    activeTabId: "tab-1",
    activeExtensionId: null,
    ...partial,
  };
}

function command(partial: Partial<Command> & Pick<Command, "id" | "title">): Command {
  return {
    category: "Global",
    requirement: "any",
    scope: "window",
    available: () => true,
    run: vi.fn(),
    ...partial,
  };
}

const onTerminal = (ctx: CommandContext): boolean => ctx.activeSurface === "terminal";

/// A catalog with every scope, registered out of order.
function catalog(): Command[] {
  return [
    command({ id: "w.reload", title: "Reload window", order: 1 }),
    command({ id: "w.new", title: "New window", order: 0 }),
    command({ id: "w.panes", title: "Show panes and tabs" }),
    command({ id: "w.align", title: "Align panes" }),
    command({ id: "ws.search", title: "Search workspace", scope: "workspace", requirement: "workspace" }),
    command({ id: "s.open", title: "Settings", scope: "settings", kind: "open" }),
    command({ id: "p.kill", title: "Close pane", scope: "pane", group: "Pane", order: 6 }),
    command({ id: "p.split", title: "Split right", scope: "pane", group: "Pane", order: 0 }),
    command({ id: "t.next", title: "Next tab", scope: "pane", group: "Tab", order: 1 }),
    command({ id: "t.close", title: "Close tab", scope: "pane", group: "Tab", order: 0 }),
    command({ id: "n.open", title: "Open...", scope: "pane", group: "New tab", order: 2000, acceptsArg: true, keywords: ["Open"] }),
    command({ id: "n.term", title: "New terminal", scope: "pane", group: "New tab", order: 0 }),
    command({ id: "extension.echo", title: "Echo", scope: undefined, category: "Apps" }),
    command({ id: "a.restart", title: "Restart terminal", scope: "app", surface: "terminal", order: 2, available: onTerminal }),
    command({ id: "a.rename", title: "Rename terminal", scope: "app", surface: "terminal", order: 0, available: onTerminal }),
    command({ id: "a.copy", title: "Copy working directory path", scope: "app", surface: "terminal", available: onTerminal }),
    command({ id: "e.outline", title: "Outline", scope: "app", surface: "file", available: (ctx) => ctx.activeSurface === "file" }),
    command({ id: "e.new", title: "New file", scope: "app", surface: "file" }),
  ];
}

const SECTIONS = [
  { id: "global", label: "Global", category: "Global" as const },
  { id: "terminal", label: "Terminal", category: "Terminal" as const },
  { id: "shortcuts", label: "Keyboard Shortcuts", category: null },
  { id: "workspace", label: "This workspace", category: "Workspace" as const },
];

function source(partial: Partial<DeckSource> = {}): DeckSource {
  return {
    ctx: context(),
    commands: catalog(),
    app: { label: "Terminal" },
    settings: [],
    sections: SECTIONS,
    recent: [],
    chord: () => null,
    ...partial,
  };
}

const openSettings = vi.fn();

/// `Section: title`, the list as a reader scans it.
function outline(rows: readonly DeckRow[]): string[] {
  return rows.map((row) => `${row.section ?? "-"}: ${row.title}`);
}

function titled(rows: readonly DeckRow[], title: string): DeckRow {
  const row = rows.find((candidate) => candidate.title === title);
  if (!row) throw new Error(`no row ${title} among ${rows.map((r) => r.title).join(", ")}`);
  return row;
}

describe("browsing", () => {
  test("lists the app, the pane's three groups, the window, the workspace and Settings, in that order", () => {
    expect(outline(browseRows(source(), null, openSettings))).toEqual([
      "Terminal: Rename terminal",
      "Terminal: Restart terminal",
      "Terminal: Copy working directory path",
      "New tab: New terminal",
      "New tab: Echo",
      "New tab: Open...",
      "Tab: Close tab",
      "Tab: Next tab",
      "Pane: Split right",
      "Pane: Close pane",
      "Window: New window",
      "Window: Reload window",
      "Window: Align panes",
      "Window: Show panes and tabs",
      "Workspace: Search workspace",
      "Settings: Settings",
    ]);
  });

  test("a scope shows its own sections alone", () => {
    const src = source();
    expect(outline(browseRows(src, "app", openSettings))).toEqual([
      "Terminal: Rename terminal",
      "Terminal: Restart terminal",
      "Terminal: Copy working directory path",
    ]);
    expect(browseRows(src, "pane", openSettings).map((row) => row.section)).toEqual([
      "New tab", "New tab", "New tab", "Tab", "Tab", "Pane", "Pane",
    ]);
    expect(outline(browseRows(src, "workspace", openSettings))).toEqual(["Workspace: Search workspace"]);
    expect(browseRows(src, "computers", openSettings)).toEqual([]);
  });

  test("the app section follows the focused tab, and no tab means no app section", () => {
    const onEditor = source({ ctx: context({ activeSurface: "file" }), app: { label: "Editor" } });
    expect(outline(browseRows(onEditor, "app", openSettings))).toEqual([
      "Editor: New file",
      "Editor: Outline",
    ]);
    const noTab = source({ ctx: context({ activeSurface: null, activeTabId: null }), app: null });
    expect(browseRows(noTab, "app", openSettings)).toEqual([]);
    expect(browseRows(noTab, null, openSettings)[0]?.section).toBe("New tab");
  });

  test("a window without a workspace lists no workspace section", () => {
    const standalone = source({
      ctx: context({ caps: { workspace: false, files: true, drafts: true, terminal: true } }),
    });
    const sections = new Set(browseRows(standalone, null, openSettings).map((row) => row.section));
    expect(sections.has("Workspace")).toBe(false);
    expect(sections.has("Window")).toBe(true);
  });

  test("an extension's own commands are its tab's app section, under its name", () => {
    const commands = [
      ...catalog(),
      command({ id: "extension.echo.say", title: "Say hello", scope: undefined, category: "Apps" }),
      command({ id: "extension.other.run", title: "Run other", scope: undefined, category: "Apps" }),
    ];
    const onEcho = source({
      commands,
      ctx: context({ activeSurface: "extension", activeExtensionId: "echo" }),
      app: { label: "Echo" },
    });
    expect(outline(browseRows(onEcho, "app", openSettings))).toEqual(["Echo: Say hello"]);
    // Off that tab the command is not browsed, and a typed query still runs it.
    const onTerminalTab = source({ commands });
    expect(browseRows(onTerminalTab, null, openSettings).map((row) => row.title)).not.toContain("Say hello");
    const found = titled(searchRows(onTerminalTab, null, "say hello", openSettings), "Say hello");
    expect(found.disabled).toBeUndefined();
    expect(found.breadcrumb).toBe("Extension");
  });
});

describe("recent commands", () => {
  test("lead the unscoped list, most recent first, and only there", () => {
    const src = source({ recent: ["w.reload", "t.close"] });
    expect(outline(browseRows(src, null, openSettings)).slice(0, 3)).toEqual([
      "Recent: Reload window",
      "Recent: Close tab",
      "Terminal: Rename terminal",
    ]);
    expect(browseRows(src, "window", openSettings).map((row) => row.section)).not.toContain("Recent");
  });

  test("a recent row has an id of its own beside the command's row", () => {
    const rows = browseRows(source({ recent: ["w.reload"] }), null, openSettings);
    const ids = rows.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(rows.filter((row) => row.title === "Reload window")).toHaveLength(2);
  });

  test("skip a command that cannot run here and stop at the limit", () => {
    const recent = ["e.outline", "gone", "w.reload", "w.new", "w.panes", "w.align", "t.close", "t.next"];
    const rows = browseRows(source({ recent }), null, openSettings).filter((row) => row.section === "Recent");
    expect(RECENT_LIMIT).toBe(5);
    expect(rows.map((row) => row.title)).toEqual([
      "Reload window", "New window", "Show panes and tabs", "Align panes", "Close tab",
    ]);
  });
});

describe("what choosing a row does", () => {
  test("an action closes the launcher and runs, recorded as recent", () => {
    const run = vi.fn();
    const rows = browseRows(source({ commands: [command({ id: "w.x", title: "Do it", run })] }), "window", openSettings);
    const row = titled(rows, "Do it");
    expect({ kind: row.kind, after: row.after, recent: row.recent, value: row.value }).toEqual({
      kind: "action", after: "close", recent: "w.x", value: undefined,
    });
    row.run?.();
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("a toggle shows its state and changes in place", () => {
    let on = false;
    const toggle = command({
      id: "w.dock", title: "Left file browser dock", kind: "toggle",
      state: () => on, run: () => { on = !on; },
    });
    const read = () => titled(browseRows(source({ commands: [toggle] }), "window", openSettings), "Left file browser dock");
    expect({ kind: read().kind, value: read().value, after: read().after }).toEqual({
      kind: "toggle", value: "off", after: "stay",
    });
    read().run?.();
    expect(read().value).toBe("on");
  });

  test("an action that reports a value stays open on it", () => {
    let depth = 2;
    const step = command({ id: "g.more", title: "Increase depth", state: () => String(depth), run: () => { depth += 1; } });
    const row = titled(browseRows(source({ commands: [step] }), "window", openSettings), "Increase depth");
    expect({ kind: row.kind, value: row.value, after: row.after }).toEqual({ kind: "action", value: "2", after: "stay" });
  });

  test("a choice shows its current value and opens its options, checked where in effect", () => {
    let colour = "blue";
    const choice = command({
      id: "w.colour", title: "Focus border colour", kind: "choice",
      state: () => colour,
      options: () => ["blue", "green"].map((id) => ({ id, label: id, checked: colour === id, run: () => { colour = id; } })),
    });
    const src = source({ commands: [choice] });
    const row = titled(browseRows(src, "window", openSettings), "Focus border colour");
    expect({ kind: row.kind, value: row.value, next: row.next, run: row.run }).toEqual({
      kind: "choice", value: "blue", next: ["command:w.colour"], run: undefined,
    });
    expect(isCatalogPath(row.next!)).toBe(true);

    const options = branchRows(src, row.next!, openSettings)!;
    expect(options.map((option) => [option.title, option.checked, option.after])).toEqual([
      ["blue", true, "stay"],
      ["green", false, "stay"],
    ]);
    titled(options, "green").run?.();
    expect(branchRows(src, row.next!, openSettings)!.map((option) => option.checked)).toEqual([false, true]);
    expect(deckCrumbs(src, null, row.next!)).toEqual(["Window", "Focus border colour"]);
  });

  test("an option that is an action of its own closes the launcher", () => {
    const run = vi.fn();
    const profiles = command({
      id: "n.profile", title: "New terminal with profile", scope: "pane", group: "New tab", kind: "choice",
      options: () => [{ id: "zsh", label: "zsh", checked: false, dismiss: true, run }],
    });
    const src = source({ commands: [profiles] });
    const [option] = branchRows(src, ["command:n.profile"], openSettings)!;
    expect({ title: option!.title, after: option!.after, recent: option!.recent }).toEqual({
      title: "zsh", after: "close", recent: "n.profile",
    });
    expect(titled(searchRows(src, null, "zsh", openSettings), "New terminal with profile: zsh").after).toBe("close");
  });

  test("a destructive command is drawn as one and keeps its confirmation", () => {
    const confirm = { title: "Close?", message: "It goes.", actionLabel: "Close", danger: true };
    const row = titled(browseRows(source({ commands: [command({ id: "w.close", title: "Close window", confirm })] }), "window", openSettings), "Close window");
    expect(row.danger).toBe(true);
    expect(row.confirm).toEqual(confirm);
  });

  test("a branch that names nothing this window offers has no rows", () => {
    const src = source();
    expect(branchRows(src, ["command:nope"], openSettings)).toBeNull();
    expect(branchRows(src, ["command:w.reload"], openSettings), "an action is no branch").toBeNull();
    expect(branchRows(src, ["windows", "w-1"], openSettings), "a Computers path").toBeNull();
    expect(isCatalogPath(["windows", "w-1"])).toBe(false);
    expect(isCatalogPath([])).toBe(false);
  });
});

/// A settings index over plain values: a toggle and a choice the launcher
/// changes in place, a slider it opens the overlay on, a field this window
/// hides, and a dock toggle a command also changes.
function settings(values: Record<string, boolean | string | null>): SettingSpec[] {
  const toggle = (id: string, section: string, label: string, extra: Partial<SettingSpec> = {}): SettingSpec => ({
    id, section, label, kind: "toggle",
    read: () => values[id] ?? null,
    write: (value) => { values[id] = value; },
    available: () => true,
    ...extra,
  });
  return [
    {
      id: "global.theme", section: "global", label: "Theme", kind: "choice",
      options: [{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }],
      read: () => values["global.theme"] ?? null,
      write: (value) => { values["global.theme"] = value; },
      available: () => true,
    },
    toggle("global.privacy", "global", "Privacy mode on"),
    toggle("terminal.mouse", "terminal", "Mouse capture: Allow in new terminals"),
    {
      id: "terminal.scrollback", section: "terminal", label: "Scrollback", kind: "open",
      read: () => "10000 lines", available: () => true,
    },
    toggle("terminal.hidden", "terminal", "Hidden here", { available: () => false }),
    {
      id: "shortcuts.grid", section: "shortcuts", label: "Keyboard Shortcuts", kind: "open",
      read: () => "", available: () => true,
    },
    toggle("browser.left", "workspace", "Left file browser dock", { command: "w.dock" }),
  ];
}

describe("settings", () => {
  const values = (): Record<string, boolean | string | null> => ({
    "global.theme": "dark", "global.privacy": false, "terminal.mouse": true, "browser.left": false,
  });

  test("the Settings scope lists each rail section's fields in rail order, then Settings", () => {
    const rows = browseRows(source({ settings: settings(values()) }), "settings", openSettings);
    expect(outline(rows)).toEqual([
      "Global: Theme",
      "Global: Privacy mode on",
      "Terminal: Mouse capture: Allow in new terminals",
      "Terminal: Scrollback",
      "Keyboard Shortcuts: Keyboard Shortcuts",
      "This workspace: Left file browser dock",
      "Settings: Settings",
    ]);
    // A field with nothing to show has no value, as one that shows a state has.
    expect(rows.map((row) => row.value)).toEqual(["Dark", "off", "on", "10000 lines", undefined, "off", undefined]);
  });

  test("a toggle flips in place and reads back", () => {
    const state = values();
    const src = source({ settings: settings(state) });
    const row = titled(browseRows(src, "settings", openSettings), "Privacy mode on");
    expect({ kind: row.kind, after: row.after }).toEqual({ kind: "toggle", after: "stay" });
    row.run?.();
    expect(state["global.privacy"]).toBe(true);
    expect(titled(browseRows(src, "settings", openSettings), "Privacy mode on").value).toBe("on");
  });

  test("a toggle whose value has not loaded cannot be flipped", () => {
    const state = values();
    state["global.privacy"] = null;
    const row = titled(browseRows(source({ settings: settings(state) }), "settings", openSettings), "Privacy mode on");
    expect({ disabled: row.disabled, run: row.run, value: row.value }).toEqual({ disabled: true, run: undefined, value: undefined });
  });

  test("a choice opens its options with a check on the current one", () => {
    const state = values();
    const src = source({ settings: settings(state) });
    const row = titled(browseRows(src, "settings", openSettings), "Theme");
    expect({ kind: row.kind, next: row.next }).toEqual({ kind: "choice", next: ["setting:global.theme"] });
    const options = branchRows(src, row.next!, openSettings)!;
    expect(options.map((option) => [option.title, option.checked])).toEqual([
      ["System", false], ["Light", false], ["Dark", true],
    ]);
    titled(options, "Light").run?.();
    expect(state["global.theme"]).toBe("light");
    expect(deckCrumbs(src, "settings", row.next!)).toEqual(["Settings", "Global", "Theme"]);
  });

  test("any other field opens the overlay on itself", () => {
    const open = vi.fn();
    const row = titled(browseRows(source({ settings: settings(values()) }), "settings", open), "Scrollback");
    expect({ kind: row.kind, after: row.after }).toEqual({ kind: "action", after: "close" });
    row.run?.();
    expect(open).toHaveBeenCalledExactlyOnceWith("terminal", "terminal.scrollback");
  });

  test("Keyboard Shortcuts is the index's own entry, listed once", () => {
    const open = vi.fn();
    const rows = browseRows(source({ settings: settings(values()) }), "settings", open);
    expect(rows.filter((row) => row.title === "Keyboard Shortcuts")).toHaveLength(1);
    const row = titled(rows, "Keyboard Shortcuts");
    expect(row.after).toBe("close");
    row.run?.();
    expect(open).toHaveBeenCalledExactlyOnceWith("shortcuts", "shortcuts.grid");
  });

  test("the unscoped list offers the focused app's section as a branch when it has a field", () => {
    const src = source({ settings: settings(values()) });
    const summary = browseRows(src, null, openSettings).filter((row) => row.section === "Settings");
    expect(summary.map((row) => [row.title, row.kind])).toEqual([
      ["Settings", "action"],
      ["Terminal settings", "branch"],
    ]);
    const branch = titled(summary, "Terminal settings");
    expect(branch.next).toEqual(["settings:terminal"]);
    const fields = branchRows(src, branch.next!, openSettings)!;
    expect(fields.map((row) => row.title)).toEqual(["Mouse capture: Allow in new terminals", "Scrollback"]);
    expect(deckCrumbs(src, null, branch.next!)).toEqual(["Settings", "Terminal"]);

    // No field to show, no branch: an app with no section, and an empty index.
    const onGraph = source({ settings: settings(values()), ctx: context({ activeSurface: "graph" }), app: { label: "Graph" } });
    expect(browseRows(onGraph, null, openSettings).map((row) => row.title)).not.toContain("Graph settings");
    expect(browseRows(source(), null, openSettings).map((row) => row.title)).not.toContain("Terminal settings");
    expect(branchRows(source(), ["settings:terminal"], openSettings)).toBeNull();
  });

  test("a choice opened inside a section returns to that section", () => {
    const state = values();
    const specs = settings(state);
    specs[0] = { ...specs[0]!, section: "terminal" };
    const src = source({ settings: specs });
    const inSection = branchRows(src, ["settings:terminal"], openSettings)!;
    expect(titled(inSection, "Theme").next).toEqual(["settings:terminal", "setting:global.theme"]);
  });
});

describe("a typed query", () => {
  const titles = (rows: readonly DeckRow[]): string[] => rows.map((row) => row.title);

  test("is flat, each row saying where it lives", () => {
    const rows = searchRows(source(), null, "close", openSettings);
    expect(rows.every((row) => row.section === undefined)).toBe(true);
    expect(titled(rows, "Close tab").breadcrumb).toBe("Pane › Tab");
    expect(titled(rows, "Close pane").breadcrumb).toBe("Pane");
    expect(titled(searchRows(source(), null, "reload", openSettings), "Reload window").breadcrumb).toBe("Window");
    expect(titled(searchRows(source(), null, "restart", openSettings), "Restart terminal").breadcrumb).toBe("Terminal");
  });

  test("keeps to the active scope", () => {
    const all = titles(searchRows(source(), null, "new", openSettings));
    expect(all).toEqual(expect.arrayContaining(["New terminal", "New window", "New file"]));
    expect(titles(searchRows(source(), null, "terminal", openSettings))).toEqual(
      expect.arrayContaining(["New terminal", "Restart terminal", "Rename terminal"]),
    );
    expect(titles(searchRows(source(), "pane", "terminal", openSettings))).toEqual(["New terminal"]);
    // The App scope is the focused app's: the editor's New file runs from a
    // terminal tab, and is not the terminal's.
    expect(titles(searchRows(source(), null, "new file", openSettings))).toContain("New file");
    expect(titles(searchRows(source(), "app", "new file", openSettings))).toEqual([]);
  });

  test("lists a choice's options as leaves, so one step applies a value", () => {
    const state = { "global.theme": "light" } as Record<string, boolean | string | null>;
    const rows = searchRows(source({ settings: settings(state) }), null, "dark", openSettings);
    const leaf = titled(rows, "Theme: Dark");
    expect({ breadcrumb: leaf.breadcrumb, checked: leaf.checked, after: leaf.after }).toEqual({
      breadcrumb: "Settings › Global", checked: false, after: "stay",
    });
    leaf.run?.();
    expect(state["global.theme"]).toBe("dark");

    let colour = "blue";
    const choice = command({
      id: "w.colour", title: "Focus border colour", kind: "choice",
      options: () => ["blue", "green"].map((id) => ({ id, label: id, checked: colour === id, run: () => { colour = id; } })),
    });
    const found = searchRows(source({ commands: [choice] }), null, "green", openSettings);
    expect(titles(found)).toContain("Focus border colour: green");
    titled(found, "Focus border colour: green").run?.();
    expect(colour).toBe("green");
  });

  test("leaves a setting to the command that also changes it", () => {
    const dock = command({ id: "w.dock", title: "Left file browser dock", kind: "toggle", state: () => false });
    const specs = settings({ "browser.left": false });
    const both = searchRows(source({ commands: [dock], settings: specs }), null, "dock", openSettings);
    expect(both.filter((row) => row.title === "Left file browser dock").map((row) => row.id)).toEqual(["command:w.dock"]);

    // Where the command is not among the results, the setting is.
    const inSettings = searchRows(source({ commands: [dock], settings: specs }), "settings", "dock", openSettings);
    expect(inSettings.map((row) => row.id)).toContain("setting:browser.left");
    const gone = command({ ...dock, available: () => false });
    const withoutCommand = searchRows(source({ commands: [gone], settings: specs }), null, "dock", openSettings);
    expect(withoutCommand.map((row) => row.id)).toContain("setting:browser.left");
  });

  test("lists a command that cannot run here last, disabled, with the reason", () => {
    const src = source({
      ctx: context({ caps: { workspace: false, files: true, drafts: true, terminal: true } }),
    });
    const rows = searchRows(src, null, "o", openSettings);
    const firstDisabled = rows.findIndex((row) => row.disabled);
    expect(firstDisabled).toBeGreaterThan(0);
    expect(rows.slice(firstDisabled).every((row) => row.disabled)).toBe(true);
    const outlineRow = titled(rows, "Outline");
    expect({ disabled: outlineRow.disabled, subtitle: outlineRow.subtitle, run: outlineRow.run }).toEqual({
      disabled: true, subtitle: "Needs an editor tab", run: undefined,
    });
    expect(titled(rows, "Search workspace").subtitle).toBe("Needs a workspace window");
    // Browsing still hides them.
    expect(titles(browseRows(src, null, openSettings))).not.toContain("Outline");
  });

  test("lists a few unavailable commands at most, and none without a reason", () => {
    const many = Array.from({ length: 8 }, (_, index) =>
      command({ id: `x.${index}`, title: `Probe ${index}`, available: () => false, unavailableReason: () => "Needs a selection" }),
    );
    const silent = command({ id: "x.silent", title: "Probe silent", available: () => false });
    const rows = searchRows(source({ commands: [...many, silent] }), null, "probe", openSettings);
    expect(UNAVAILABLE_LIMIT).toBe(5);
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.disabled && row.subtitle === "Needs a selection")).toBe(true);
  });

  test("forwards a typed remainder to a command that takes one", () => {
    const run = vi.fn();
    const open = command({ id: "n.open", title: "Open...", scope: "pane", group: "New tab", acceptsArg: true, keywords: ["Open"], run });
    const other = command({ id: "w.other", title: "Other" });
    const rows = searchRows(source({ commands: [open, other] }), null, "open notes/My File.md", openSettings);
    expect(titles(rows)).toEqual(["Open notes/My File.md"]);
    rows[0]!.run?.();
    expect(run).toHaveBeenCalledExactlyOnceWith("notes/My File.md");
  });

  test("ranks the rows a caller adds with its own", () => {
    const extra: DeckRow = { id: "computers:x", title: "Reload station", breadcrumb: "Computers", searchText: "", scope: "computers" };
    expect(titles(searchRows(source(), null, "reload", openSettings, [extra]))).toEqual(
      expect.arrayContaining(["Reload window", "Reload station"]),
    );
  });
});

describe("the order of a typed query's hits", () => {
  const titles = (rows: readonly DeckRow[]): string[] => rows.map((row) => row.title);

  /// A row of this machine's, as the launcher adds them to a typed query.
  function machineRow(title: string, partial: Partial<DeckRow> = {}): DeckRow {
    return { id: `computers:${title}`, title, breadcrumb: "Windows", searchText: title, scope: "computers", ...partial };
  }

  test("`close` leads with Close tab, ahead of another window's Close", () => {
    // The ranking alone would lead with the shortest title, the other
    // window's.
    const others = [machineRow("Close W"), machineRow("Close Window 2")];
    expect(titles(rankDeckItems([...searchRows(source(), null, "close", openSettings), ...others], "close"))[0]).toBe("Close W");
    expect(titles(searchRows(source(), null, "close", openSettings, others))).toEqual([
      "Close tab",
      "Close pane",
      "Close W",
      "Close Window 2",
    ]);
  });

  test("lists hits of one kind by scope: the focused app, pane, window, workspace, another app, settings, this machine", () => {
    const commands = [
      command({ id: "w.close", title: "Close window" }),
      command({ id: "ws.close", title: "Close index", scope: "workspace", requirement: "workspace" }),
      command({ id: "p.kill", title: "Close pane", scope: "pane", group: "Pane" }),
      command({ id: "t.close", title: "Close tab", scope: "pane", group: "Tab" }),
      command({ id: "e.close", title: "Close outline", scope: "app", surface: "file" }),
      command({ id: "a.close", title: "Close find", scope: "app", surface: "terminal" }),
    ];
    const specs: SettingSpec[] = [{
      id: "terminal.close", section: "terminal", label: "Close on exit", kind: "open",
      read: () => "", available: () => true,
    }];
    const rows = searchRows(source({ commands, settings: specs }), null, "close", openSettings, [machineRow("Close W")]);
    expect(titles(rows)).toEqual([
      "Close find",
      "Close tab",
      "Close pane",
      "Close window",
      "Close index",
      "Close outline",
      "Close on exit",
      "Close W",
    ]);
  });

  test("keeps a better kind of hit ahead of a nearer scope", () => {
    const commands = [
      command({ id: "p.split", title: "Split right", scope: "pane", group: "Pane", keywords: ["deploy"] }),
      command({ id: "w.redeploy", title: "Redeploy" }),
    ];
    const rows = searchRows(source({ commands }), null, "deploy", openSettings, [machineRow("Deploy shell")]);
    // A title word's start, the inside of a title word, then a keyword.
    expect(titles(rows)).toEqual(["Deploy shell", "Redeploy", "Split right"]);
  });

  test("reads the kinds of hit as the ranking does, every word counted", () => {
    // One scope, so the ranking's own order must come through untouched.
    const commands = [
      command({ id: "k.5", title: "D-e-p-l-o-y" }),
      command({ id: "k.4", title: "Beta", keywords: ["redeployment"] }),
      command({ id: "k.3", title: "Alpha", keywords: ["deploy"] }),
      command({ id: "k.2", title: "Redeploy" }),
      command({ id: "k.1", title: "Deploy now" }),
    ];
    const src = source({ commands });
    const rows = searchRows(src, null, "deploy", openSettings);
    expect(titles(rows)).toEqual(["Deploy now", "Redeploy", "Alpha", "Beta", "D-e-p-l-o-y"]);
    expect(titles(rows)).toEqual(titles(rankDeckItems(rows, "deploy") as DeckRow[]));

    // Two words: both in the title beat one in the title and one in a
    // keyword, whatever the scopes.
    const two = [
      command({ id: "t.close", title: "Close tab", scope: "pane", group: "Tab", keywords: ["window"] }),
      command({ id: "w.close", title: "Close window" }),
    ];
    expect(titles(searchRows(source({ commands: two }), null, "close window", openSettings, [machineRow("Close Window 2")]))).toEqual([
      "Close window",
      "Close Window 2",
      "Close tab",
    ]);
  });

  test("leaves a row that cannot run after every row that can, and before the commands that cannot", () => {
    const commands = [
      command({ id: "t.close", title: "Close tab", scope: "pane", group: "Tab" }),
      command({ id: "p.split", title: "Split right", scope: "pane", group: "Pane", keywords: ["close"] }),
      command({ id: "x.close", title: "Close probe", available: () => false, unavailableReason: () => "Needs a selection" }),
    ];
    // A title hit that cannot run still follows a keyword hit that can.
    const held = machineRow("Close A", { disabled: true, subtitle: "Working" });
    const rows = searchRows(source({ commands }), null, "close", openSettings, [held, machineRow("Close Window 2")]);
    expect(rows.map((row) => [row.title, row.disabled === true])).toEqual([
      ["Close tab", false],
      ["Close Window 2", false],
      ["Split right", false],
      ["Close A", true],
      ["Close probe", true],
    ]);
  });
});

describe("where the launcher stands", () => {
  test("names the active scope, the focused app's by its name", () => {
    expect(deckCrumbs(source(), null, [])).toBeUndefined();
    expect(deckCrumbs(source(), "pane", [])).toEqual(["Pane"]);
    expect(deckCrumbs(source(), "app", [])).toEqual(["Terminal"]);
    expect(deckCrumbs(source({ app: null }), "app", [])).toEqual(["App"]);
    expect(deckCrumbs(source(), "tab", []), "a scope id no longer in use").toBeUndefined();
  });
});
