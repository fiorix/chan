// The command catalog: every launcher-invokable action as data. Each
// entry pairs a stable id with the one title the action carries everywhere,
// the scope it acts in, what choosing it does, an availability predicate
// and a run() thunk. Chorded commands reuse their SHORTCUTS id so the
// launcher can show the current chord via chordFor(id) and route run() back
// through the same dispatch the chord fires; chordless commands live only
// here and call their action directly.
//
// Two axes place a command. `scope` says where it acts, which is the
// launcher scope that lists it; `group` and `order` say where inside the
// scope. `category` is the surface that owns it, which the Settings rail
// and the Keyboard Shortcuts grid group by; it does not decide the scope.
//
// Entries register through registerCommands from per-surface modules in
// state/commands/, each imported for its side effect by
// state/commands/install. This catalog is the single command source the
// launcher and the command-forwarding surfaces consume.

import { openCommandLauncher, setTransientStatus, ui } from "./store.svelte";
import {
  activePane,
  activeTabInPane,
  layout,
  paneActiveTabId,
  paneShowsTmux,
  paneSide,
  type PaneSide,
} from "./tabs.svelte";
import { windowCaps, type WindowCaps } from "./windowCaps";
import { TERMINAL_ONLY_COMMANDS, windowModeAllowsCommand } from "./windowMode";

export type CommandCategory =
  | "Global"
  | "Workspace"
  | "Search"
  | "Apps"
  | "Tabs"
  | "Panes"
  | "Editor"
  | "File Browser"
  | "Terminal"
  | "Dashboard"
  | "Graph";

/// The active surface is the kind of the focused pane's active tab, or
/// null when the pane is empty. Surface commands (Editor / Terminal /
/// File Browser / Graph / Dashboard) key their availability off this.
/// The literals mirror the Tab union's `kind` discriminants.
export type CommandSurface =
  | "file"
  | "terminal"
  | "graph"
  | "browser"
  | "dashboard"
  | "extension";

/// Where a command acts, which is also the launcher scope that lists it:
/// the focused tab's content (`app`), the pane and its tabs, the window, the
/// workspace, or a preference.
export type CommandScope = "app" | "pane" | "window" | "workspace" | "settings";

/// What choosing a command does: an `action` runs, a `toggle` flips the
/// thing it is named for, a `choice` offers its options, and an `open`
/// command raises a dialog or an overlay.
export type CommandKind = "action" | "toggle" | "choice" | "open";

/// One option of a `choice` command.
export type CommandOption = {
  /// Stable within its command.
  id: string;
  label: string;
  /// Whether this option is in effect. A choice between values checks one;
  /// a choice over a set, such as filters, checks each member that is on.
  checked: boolean;
  /// True when choosing the option is an action of its own, such as opening
  /// a tab, and not a value put in effect: the launcher closes on it as on
  /// any action, where it stays open on a value to show the check move.
  dismiss?: boolean;
  run: () => void | Promise<void>;
};

/// The sections of the Pane scope, in the order the launcher lists them.
export const PANE_GROUPS = ["New tab", "Tab", "Pane"] as const;

/// The name a surface's commands are listed under.
export const SURFACE_LABELS: Record<CommandSurface, string> = {
  file: "Editor",
  terminal: "Terminal",
  browser: "File browser",
  graph: "Graph",
  dashboard: "Dashboard",
  extension: "Extension",
};

/// The capability a command needs before it may appear or dispatch:
/// `any` for window/pane/tab/settings plumbing that works everywhere,
/// `terminal` for terminal lifecycle, `files` for the editor / File
/// Browser / file-operation family, `drafts` for the draft family
/// (create/inspect/discard/promote, served by both the workspace tenant
/// and a drafts-capable standalone tenant), and `workspace` for graph,
/// search, and every other index-backed surface. One table
/// drives both the catalog filter and the dispatch gate so they can
/// never disagree.
export type CommandRequirement =
  | "any"
  | "terminal"
  | "files"
  | "drafts"
  | "workspace";

/// Whether a window with `caps` satisfies `requirement`.
export function requirementAllows(
  requirement: CommandRequirement,
  caps: WindowCaps,
): boolean {
  switch (requirement) {
    case "any":
      return true;
    case "terminal":
      return caps.terminal;
    case "files":
      return caps.files;
    case "drafts":
      return caps.drafts;
    case "workspace":
      return caps.workspace;
  }
}

/// The runtime context an availability predicate sees: the window-mode
/// gates (from the `?kind=` URL), this window's fixed capability set, plus
/// the active surface.
export type CommandContext = {
  terminalOnly: boolean;
  terminalControl: boolean;
  caps: WindowCaps;
  activeSurface: CommandSurface | null;
  activeSide: PaneSide | null;
  activeTabId: string | null;
  /// The extension an `extension` surface is running, so the launcher can
  /// tell that extension's own commands from every other Apps entry. Null on
  /// every other surface.
  activeExtensionId: string | null;
};

export type Command = {
  /// Stable id. Chorded commands reuse their SHORTCUTS id so chordFor(id)
  /// resolves the current chord; chordless commands pick a unique id in
  /// the same `app.*` namespace.
  id: string;
  title: string;
  category: CommandCategory;
  /// Where the command acts, which is the launcher scope that lists it.
  scope: CommandScope;
  /// The tab kinds an `app` command acts on.
  surface?: CommandSurface | readonly CommandSurface[];
  /// The section inside the scope. A pane command names one of
  /// [`PANE_GROUPS`]; elsewhere absent means the scope's own section.
  group?: string;
  /// Position inside the group, ascending. Commands without one follow the
  /// ordered ones by title.
  order?: number;
  /// What choosing the command does. Absent means `action`.
  kind?: CommandKind;
  /// The current state: a toggle's on or off, a choice's current label, or
  /// the value an action steps. A command that reports one changes in
  /// place: the launcher stays open on it and shows the new state.
  state?: (ctx: CommandContext) => boolean | string | null;
  /// A choice's options, in the order the launcher lists them.
  options?: (ctx: CommandContext) => readonly CommandOption[];
  /// Why the command cannot run in `ctx`, in the launcher's words (`Needs a
  /// selection`), when the requirement and the surface do not already say.
  unavailableReason?: (ctx: CommandContext) => string | null;
  /// The capability this command needs; see [`CommandRequirement`]. Every
  /// command declares one explicitly so a window mode can be proven
  /// against the whole catalog.
  requirement: CommandRequirement;
  /// Optional shortcut ids to render for this command instead of `id`.
  /// Used when a command is intentionally read-only but should advertise
  /// the same close path as another command.
  shortcutIds?: readonly string[];
  /// False keeps the chord visible but removes the assignment affordance.
  /// Defaults to true.
  shortcutEditable?: boolean;
  /// Extra terms the type-ahead matches beyond the title: synonyms, related
  /// verbs, and every title the command has carried before, so a search by
  /// an old name still finds it.
  keywords?: readonly string[];
  /// lucide icon name, optional; the launcher falls back to a generic
  /// glyph when absent.
  icon?: string;
  /// Whether the command can run in the given context. The launcher hides
  /// an unavailable command while it browses and lists it disabled, with
  /// the reason, among typed results.
  available: (ctx: CommandContext) => boolean;
  /// Whether the launcher forwards a typed argument: with this set, a
  /// query like "Open notes/x.md" matches the command on its HEAD token
  /// and run() receives the verbatim remainder. A bare invocation (row
  /// picked with no remainder) passes undefined. Defaults to false.
  acceptsArg?: boolean;
  /// Optional launcher-owned safety gate. The shared deck renders it inline
  /// and requires a fresh Enter before run() is called.
  confirm?: {
    title: string;
    message: string;
    actionLabel: string;
    danger?: boolean;
  };
  /// Perform the action. Reuse-existing commands dispatch their id
  /// through the chan:command bridge; chordless commands call their
  /// action directly. A toggle's run flips it, and a choice's run opens the
  /// launcher on its options (see [`openChoice`]). `arg` is the launcher's
  /// verbatim remainder for acceptsArg commands; everything else ignores it.
  run: (arg?: string) => void;
};

// ---- registry ----------------------------------------------------------

const registry: Command[] = [];

/// Register a batch of commands. Called at module load from each
/// per-category module (imported for its side effect by
/// state/commands/install).
export function registerCommands(cmds: readonly Command[]): void {
  registry.push(...cmds);
}

/// Remove every registered command `match` selects. The extension catalog
/// replaces its rows through this on each refresh, so a row whose
/// extension went away does not stay behind.
export function unregisterCommands(match: (command: Command) => boolean): void {
  for (let index = registry.length - 1; index >= 0; index -= 1) {
    if (match(registry[index]!)) registry.splice(index, 1);
  }
}

/// All registered commands, de-duplicated by (id, category, title) so a
/// module re-evaluated under dev hot-reload can't stack duplicates.
/// Later registrations win, keeping the freshest run() closure.
export function allCommands(): Command[] {
  const byKey = new Map<string, Command>();
  for (const c of registry) {
    byKey.set(`${c.id}|${c.category}|${c.title}`, c);
  }
  return [...byKey.values()];
}

/// Commands visible in `ctx`: the requirement gate first (the same table
/// the dispatch gate consults), then the per-command predicate.
export function availableCommands(ctx: CommandContext): Command[] {
  return allCommands().filter(
    (c) => requirementAllows(c.requirement, ctx.caps) && c.available(ctx),
  );
}

/// The registered command with `id`. A menu row, a help row and a toolbar
/// button name their action through it, so its words are written once.
export function commandById(id: string): Command | undefined {
  return allCommands().find((c) => c.id === id);
}

/// The title of the command with `id`, as every surface that offers the
/// action words it. An id nothing registers reads as itself, which a test
/// over a menu's rows catches before a reader does.
export function commandTitle(id: string): string {
  return commandById(id)?.title ?? id;
}

/// The state the command with `id` reports in `ctx`: a toggle's on or off, a
/// choice's current label, and null when it reports none or is not
/// registered.
export function commandState(
  id: string,
  ctx: CommandContext = commandContext(),
): boolean | string | null {
  return commandById(id)?.state?.(ctx) ?? null;
}

/// Whether a dispatched command id may run in a window with `caps`.
///
/// Mirrors the catalog filter for ids that are registered. Some dispatchable
/// ids are NOT catalog entries: they are window-level actions fired by chords
/// and by the host's `chan:command` bridge with no launcher row to offer --
/// `app.tab.jump`, `app.launcher.toggle`, and `app.window.confirmClose`,
/// which is how the desktop's close button asks the window whether it may go. [`TERMINAL_ONLY_COMMANDS`] is exactly the set of
/// ids that need no workspace, so it classifies those; an id in neither table
/// fails closed, so a window with reduced capabilities never leaks a workspace
/// action it cannot honour.
export function dispatchAllowsCommand(id: string, caps: WindowCaps): boolean {
  if (caps.workspace) return true;
  const command = allCommands().find((c) => c.id === id);
  if (!command) return TERMINAL_ONLY_COMMANDS.has(id);
  return requirementAllows(command.requirement, caps);
}

// ---- placement ---------------------------------------------------------

/// Where the launcher lists a command.
export type CommandPlacement = {
  scope: CommandScope;
  /// The tab kinds an `app` command belongs to; empty in every other scope.
  surfaces: readonly CommandSurface[];
  /// The section heading. Null for an `app` command with no group of its
  /// own: its section is named after the app.
  group: string | null;
};

const SCOPE_GROUPS: Record<Exclude<CommandScope, "app">, string> = {
  pane: "Pane",
  window: "Window",
  workspace: "Workspace",
  settings: "Settings",
};

/// The ids the extension catalog registers start with this: `extension.<id>`
/// opens or focuses the app, and `extension.<id>.<command>` is one of that
/// app's own commands.
const EXTENSION_PREFIX = "extension.";

/// Resolve where the launcher lists `command`.
export function commandPlacement(command: Command): CommandPlacement {
  const { scope } = command;
  if (scope !== "app") {
    return { scope, surfaces: [], group: command.group ?? SCOPE_GROUPS[scope] };
  }
  const surface = command.surface ?? [];
  return {
    scope,
    surfaces: typeof surface === "string" ? [surface] : surface,
    group: command.group ?? null,
  };
}

/// Whether an `app` command belongs to the focused tab: the tab is one of
/// the command's surfaces and, on an extension tab, the command is that
/// extension's own.
export function commandOnActiveSurface(command: Command, ctx: CommandContext): boolean {
  const { scope, surfaces } = commandPlacement(command);
  if (scope !== "app" || ctx.activeSurface === null) return false;
  if (!surfaces.includes(ctx.activeSurface)) return false;
  if (ctx.activeSurface !== "extension" || !command.id.startsWith(EXTENSION_PREFIX)) return true;
  return (
    ctx.activeExtensionId !== null &&
    command.id.startsWith(`${EXTENSION_PREFIX}${ctx.activeExtensionId}.`)
  );
}

const REQUIREMENT_REASONS: Record<CommandRequirement, string> = {
  any: "Not available in this window",
  terminal: "Needs a terminal window",
  files: "Needs a file surface",
  drafts: "Needs a draft store",
  workspace: "Needs a workspace window",
};

const SURFACE_NOUNS: Record<CommandSurface, string> = {
  file: "an editor",
  terminal: "a terminal",
  browser: "a file browser",
  graph: "a graph",
  dashboard: "a dashboard",
  extension: "an extension",
};

/// Why a command that is not available in `ctx` cannot run: the capability
/// its window lacks, the tab it needs focused, or its own reason. Null when
/// none of the three says, and the launcher then leaves the command out.
export function commandUnavailableReason(command: Command, ctx: CommandContext): string | null {
  if (!requirementAllows(command.requirement, ctx.caps)) {
    return REQUIREMENT_REASONS[command.requirement];
  }
  const { scope, surfaces } = commandPlacement(command);
  if (scope === "app" && surfaces.length > 0 && !commandOnActiveSurface(command, ctx)) {
    return `Needs ${surfaces.map((surface) => SURFACE_NOUNS[surface]).join(" or ")} tab`;
  }
  return command.unavailableReason?.(ctx) ?? null;
}

/// The prefix of the launcher path level that lists a choice command's
/// options; the command's id follows it.
export const CHOICE_LEVEL = "command:";

/// The launcher path that lists a choice command's options.
export function choicePath(id: string): string[] {
  return [`${CHOICE_LEVEL}${id}`];
}

/// A choice command's run(): open the launcher on its options, so a chord
/// and the host bridge reach the list the launcher's own row opens.
export function openChoice(id: string): void {
  openCommandLauncher(choicePath(id));
}

// ---- context -----------------------------------------------------------

function activeCommandTarget(): {
  surface: CommandSurface | null;
  side: PaneSide | null;
  tabId: string | null;
  extensionId: string | null;
} {
  try {
    const pane = activePane();
    const side = paneSide(pane);
    const tab = activeTabInPane(pane, side);
    return {
      surface: tab ? tab.kind : null,
      side,
      tabId: paneActiveTabId(pane, side),
      extensionId: tab?.kind === "extension" ? tab.extensionId : null,
    };
  } catch {
    // activePane throws when the active node is not a leaf (mid-layout
    // transition); treat that as no active surface.
    return { surface: null, side: null, tabId: null, extensionId: null };
  }
}

/// Snapshot the current command context. Reads the reactive `ui` flags
/// and the active tab, so calling this inside a $derived tracks changes.
export function commandContext(): CommandContext {
  const target = activeCommandTarget();
  return {
    terminalOnly: ui.terminalOnly,
    terminalControl: ui.terminalControl,
    caps: windowCaps,
    activeSurface: target.surface,
    activeSide: target.side,
    activeTabId: target.tabId,
    activeExtensionId: target.extensionId,
  };
}

// ---- availability helpers ----------------------------------------------
//
// Shared predicates so every category module gates the same way instead
// of re-deriving the rules. Compose them inside a command's `available`.

/// Mirror runCommand's window-mode guard for a command that routes
/// through a runCommand id. Use for reuse-existing (chorded) commands.
export function allowedInWindow(id: string, ctx: CommandContext): boolean {
  return windowModeAllowsCommand(id, ctx);
}

/// Whether a Dashboard may open here: the window mode allows
/// `app.dashboard.open` (a control terminal draws no tab strip to switch back
/// from one), and the focused pane draws its strip, which a pane showing a
/// tmux pane does not, nor does any pane while Hybrid Nav stages a tmux
/// window's layout. The launcher row, Hybrid Nav's `b` and its cheatsheet row
/// all read this one rule, so the key is offered wherever the command is.
export function dashboardOpenAllowed(
  mode: Pick<CommandContext, "terminalOnly" | "terminalControl">,
): boolean {
  return (
    windowModeAllowsCommand("app.dashboard.open", mode) &&
    !paneShowsTmux(layout.nodes[layout.activePaneId])
  );
}

/// Visible only in a workspace window (never a standalone terminal).
export function workspaceOnly(ctx: CommandContext): boolean {
  return !ctx.terminalOnly;
}

/// Visible only when `surface` is the active tab's kind.
export function onSurface(
  ctx: CommandContext,
  surface: CommandSurface,
): boolean {
  return ctx.activeSurface === surface;
}

// ---- dispatch ----------------------------------------------------------

/// Fire a `chan:command` event so a catalog entry routes through the
/// same App.svelte dispatch a chord or the native host bridge fires.
/// Reuse-existing commands run() through this; runCommand re-applies the
/// window-mode guard, so a dispatch in a disallowed window is a no-op.
export function dispatchChanCommand(
  id: string,
  detail: Record<string, unknown> = {},
): void {
  window.dispatchEvent(
    new CustomEvent("chan:command", { detail: { name: id, ...detail } }),
  );
}

/// Run a config write and report the outcome as a transient pill, so a
/// launcher command that mutates state still gives feedback without an
/// inline settings panel.
export async function withStatus(
  fn: () => Promise<unknown>,
  ok: string,
  fail: string,
): Promise<void> {
  try {
    await fn();
    setTransientStatus(ok);
  } catch {
    setTransientStatus(fail);
  }
}
