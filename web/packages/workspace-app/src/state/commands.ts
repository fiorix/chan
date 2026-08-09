// The command catalog: every launcher-invokable action as data. Each
// entry pairs a stable id with a title, a category for grouping, an
// availability predicate, and a run() thunk. Chorded commands reuse
// their SHORTCUTS id so the launcher can show the current chord via
// chordFor(id) and route run() back through the same dispatch the chord
// fires; chordless commands live only here and call their action
// directly. Categories match the groups the launcher renders.
//
// Entries register through registerCommands from per-category modules in
// state/commands/, each imported for its side effect by
// state/commands/install. Keeping one module per surface lets the
// command lanes own disjoint files; the launcher reads the merged,
// context-filtered list. This catalog is also the single command source
// the launcher and command-forwarding surfaces consume.

import { ui } from "./store.svelte";
import {
  activePane,
  activeTabInPane,
  paneActiveTabId,
  paneSide,
  type PaneSide,
} from "./tabs.svelte";
import { windowModeAllowsCommand } from "./windowMode";

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

/// The runtime context an availability predicate sees: the window-mode
/// gates (from the `?kind=` URL) plus the active surface.
export type CommandContext = {
  terminalOnly: boolean;
  terminalControl: boolean;
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
  /// Optional shortcut ids to render for this command instead of `id`.
  /// Used when a command is intentionally read-only but should advertise
  /// the same close path as another command.
  shortcutIds?: readonly string[];
  /// False keeps the chord visible but removes the assignment affordance.
  /// Defaults to true.
  shortcutEditable?: boolean;
  /// Extra terms the type-ahead matches beyond the title (synonyms, the
  /// surface name, related verbs).
  keywords?: readonly string[];
  /// lucide icon name, optional; the launcher falls back to a generic
  /// glyph when absent.
  icon?: string;
  /// Whether the command shows in the given context. Unavailable
  /// commands are hidden (not shown-disabled) for a clean Spotlight feel.
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
  /// action directly. `arg` is the launcher's verbatim remainder for
  /// acceptsArg commands; everything else ignores it.
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

/// Commands visible in `ctx`. The launcher owns display ordering.
export function availableCommands(ctx: CommandContext): Command[] {
  return allCommands().filter((c) => c.available(ctx));
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
