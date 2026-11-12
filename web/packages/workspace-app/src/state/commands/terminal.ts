// Terminal surface commands: available when a terminal tab is the active
// surface, excluding the control-terminal singleton whose chrome and
// lifecycle belong to the connect flow. They are listed in the order the
// terminal's two menus offer them, the tab menu's and then the body menu's.
// What the tab object holds (name, group, broadcast, Details, secret masking)
// is changed on the active terminal tab directly, and its state is read for
// the tab the context names; what needs the live renderer or its PTY
// (restart, find, copy, paste, the working directory) dispatches a
// chan:command the focused TerminalTab answers with the function its own
// menu row calls. The terminal's theme and its engine are fields of the
// Settings overlay and reach the launcher through the settings index.
// Register with registerCommands. See state/commands.ts for the Command
// shape and helpers.

import {
  registerCommands,
  dispatchChanCommand,
  onSurface,
  openChoice,
  type CommandContext,
} from "../commands";
import { uiPrompt } from "../store.svelte";
import {
  activeTerminalTab,
  allTerminalTabs,
  renameTerminalTab,
  setTabInspectorOpen,
  terminalBroadcastTargets,
  terminalSecretMaskingOn,
  terminalTabName,
  toggleTerminalSecretMasking,
  type TerminalBroadcastTarget,
  type TerminalTab,
} from "../tabs.svelte";
import {
  isRichPromptToolbarOpen,
  isRichPromptVisible,
  toggleRichPromptToolbar,
} from "../richPrompt.svelte";

function onTerminal(ctx: CommandContext): boolean {
  return onSurface(ctx, "terminal") && !ctx.terminalControl;
}

function onWorkspaceTerminal(ctx: CommandContext): boolean {
  return onTerminal(ctx) && !ctx.terminalOnly;
}

/// The terminal tab a context names as the focused one, null when it names
/// none. State is read through the context and not from the layout's active
/// pane, so a terminal's own menu can ask about its terminal by name.
function terminalIn(ctx: CommandContext): TerminalTab | null {
  if (ctx.activeSurface !== "terminal" || ctx.activeTabId === null) return null;
  return allTerminalTabs().find((tab) => tab.id === ctx.activeTabId) ?? null;
}

/// The value a toggle's state reads off the context's terminal tab, null
/// when the context names none.
function terminalState(
  read: (tab: TerminalTab) => boolean,
): (ctx: CommandContext) => boolean | null {
  return (ctx) => {
    const tab = terminalIn(ctx);
    return tab ? read(tab) : null;
  };
}

async function renameActiveTerminal(): Promise<void> {
  const t = activeTerminalTab();
  if (!t) return;
  const name = await uiPrompt("Terminal name", terminalTabName(t));
  if (name !== null) renameTerminalTab(t, name);
}

/// Propose the active terminal's complete live metadata pair. The server
/// settles the name while changing the group atomically; the running shell's
/// spawn environment stays immutable and the tab surfaces that divergence.
async function setActiveTerminalGroup(): Promise<void> {
  const t = activeTerminalTab();
  if (!t) return;
  const group = await uiPrompt("Terminal group");
  if (group === null) return;
  renameTerminalTab(t, terminalTabName(t), group);
}

/// Whether the whole broadcast group is on: every same-group terminal of
/// this window and every member another window's page holds. The rule the
/// toggle itself flips on, so the row reads on exactly when choosing it
/// would turn the group off.
function groupBroadcastOn(tab: TerminalTab): boolean {
  const targets = terminalBroadcastTargets(tab);
  return targets.length > 0 && targets.every((target) => target.on);
}

/// A broadcast target as a flat list names it. The terminal's menu marks its
/// own row the same way.
function broadcastTargetLabel(target: TerminalBroadcastTarget): string {
  return target.self ? `${target.name} (self)` : target.name;
}

registerCommands([
  {
    id: "app.terminal.setName",
    title: "Rename terminal",
    category: "Terminal",
    scope: "app",
    surface: "terminal",
    order: 0,
    kind: "open",
    requirement: "terminal",
    keywords: ["Set terminal name", "name", "title"],
    available: onTerminal,
    run: () => void renameActiveTerminal(),
  },
  {
    id: "app.terminal.setGroup",
    title: "Set terminal group",
    category: "Terminal",
    scope: "app",
    surface: "terminal",
    order: 1,
    kind: "open",
    requirement: "terminal",
    keywords: ["group", "broadcast"],
    available: onTerminal,
    run: () => void setActiveTerminalGroup(),
  },
  {
    id: "app.terminal.restart",
    title: "Restart terminal",
    category: "Terminal",
    scope: "app",
    surface: "terminal",
    order: 2,
    requirement: "terminal",
    keywords: ["restart", "respawn", "reload", "new session"],
    // An exited terminal has no live shell to stop, so restart needs no
    // confirmation.
    get confirm() {
      if (!activeTerminalTab()?.terminalSessionId) return undefined;
      return {
        title: "Restart this terminal?",
        message: "The current shell process will stop and a new shell will start.",
        actionLabel: "Restart",
        danger: true,
      };
    },
    available: onTerminal,
    run: () => dispatchChanCommand("app.terminal.restart"),
  },
  {
    id: "app.terminal.broadcastToggle",
    title: "Group broadcast",
    category: "Terminal",
    scope: "app",
    surface: "terminal",
    order: 3,
    kind: "toggle",
    requirement: "terminal",
    keywords: [
      "Toggle group broadcast",
      "Select All",
      "Deselect All",
      "broadcast",
      "group",
      "input",
    ],
    available: onTerminal,
    state: terminalState(groupBroadcastOn),
    run: () => dispatchChanCommand("app.terminal.broadcastToggle"),
  },
  {
    // One row per terminal the active one can broadcast to, with a check on
    // each that is on, as the tab menu lists them.
    id: "app.terminal.broadcastTargets",
    title: "Broadcast targets",
    category: "Terminal",
    scope: "app",
    surface: "terminal",
    order: 4,
    kind: "choice",
    requirement: "terminal",
    keywords: ["broadcast input on/off", "broadcast", "input", "group", "terminals"],
    available: onTerminal,
    state: (ctx) => {
      const tab = terminalIn(ctx);
      if (!tab) return null;
      const targets = terminalBroadcastTargets(tab);
      return `${targets.filter((target) => target.on).length} of ${targets.length}`;
    },
    options: (ctx) => {
      const tab = terminalIn(ctx);
      if (!tab) return [];
      return terminalBroadcastTargets(tab).map((target) => ({
        id: target.id,
        label: broadcastTargetLabel(target),
        checked: target.on,
        run: () => target.set(!target.on),
      }));
    },
    run: () => openChoice("app.terminal.broadcastTargets"),
  },
  {
    id: "app.terminal.details",
    title: "Details",
    category: "Terminal",
    scope: "app",
    surface: "terminal",
    order: 5,
    kind: "toggle",
    requirement: "terminal",
    keywords: ["Toggle details", "inspector", "info", "program status"],
    available: onTerminal,
    state: terminalState((tab) => tab.inspectorOpen === true),
    run: () => {
      const tab = activeTerminalTab();
      if (tab) setTabInspectorOpen(tab, !tab.inspectorOpen);
    },
  },
  {
    // Reads on while Privacy mode holds masking on too, where choosing it
    // changes nothing and the status line says why.
    id: "app.terminal.secretMasking.toggle",
    title: "Secret masking (this terminal)",
    category: "Terminal",
    scope: "app",
    surface: "terminal",
    order: 6,
    kind: "toggle",
    requirement: "terminal",
    keywords: [
      "Toggle secret masking for this terminal",
      "secret",
      "mask",
      "credential",
      "screen share",
      "demo",
    ],
    available: onTerminal,
    state: terminalState(terminalSecretMaskingOn),
    run: () => {
      const tab = activeTerminalTab();
      if (tab) toggleTerminalSecretMasking(tab);
    },
  },
  {
    // The terminal's own find bar, under the id whose chord opens it from a
    // focused terminal. The page's find command opens the same bar when the
    // desktop sends it; the terminal's row is this one. It takes the order
    // the editor's Find holds, so the find steps the editor's module lists
    // on both tabs, just past that order, follow it here too.
    id: "terminal.find",
    title: "Find",
    category: "Terminal",
    scope: "app",
    surface: "terminal",
    order: 8,
    kind: "open",
    requirement: "terminal",
    keywords: ["Find in terminal", "search", "find bar", "scrollback"],
    icon: "search",
    available: onTerminal,
    run: () => dispatchChanCommand("terminal.find"),
  },
  {
    // The copy chord is the terminal's own key and copies a selection only.
    // Choosing the command is asking for a result, so with nothing selected
    // it copies the scrollback, as the menu row does. A chord the user
    // assigned to the command is the copy key under another spelling: run
    // by one, the command tells the terminal a chord asked, and the terminal
    // copies the selection alone.
    id: "terminal.copy",
    title: "Copy",
    category: "Terminal",
    scope: "app",
    surface: "terminal",
    order: 9,
    requirement: "terminal",
    keywords: ["Copy selection", "clipboard", "selection", "scrollback"],
    available: onTerminal,
    run: (_arg, via) =>
      dispatchChanCommand("terminal.copy", via === "chord" ? { chord: true } : {}),
  },
  {
    id: "terminal.paste",
    title: "Paste",
    category: "Terminal",
    scope: "app",
    surface: "terminal",
    order: 10,
    requirement: "terminal",
    keywords: ["clipboard", "insert"],
    available: onTerminal,
    run: () => dispatchChanCommand("terminal.paste"),
  },
  {
    id: "app.terminal.copyScrollback",
    title: "Copy scrollback",
    category: "Terminal",
    scope: "app",
    surface: "terminal",
    order: 11,
    requirement: "terminal",
    keywords: ["clipboard", "history", "output", "buffer"],
    available: onTerminal,
    run: () => dispatchChanCommand("app.terminal.copyScrollback"),
  },
  {
    id: "terminal.richPrompt",
    title: "Rich Prompt",
    category: "Terminal",
    scope: "app",
    surface: "terminal",
    order: 12,
    kind: "toggle",
    // Rich Prompt drafts into the tenant's drafts store.
    requirement: "drafts",
    keywords: ["Show/Hide Rich Prompt", "Show Rich Prompt", "Hide Rich Prompt", "prompt", "composer"],
    available: onWorkspaceTerminal,
    state: terminalState((tab) => isRichPromptVisible(tab.id)),
    run: () => dispatchChanCommand("terminal.richPrompt"),
  },
  {
    id: "terminal.richPromptToolbar",
    title: "Rich Prompt style toolbar",
    category: "Terminal",
    scope: "app",
    surface: "terminal",
    order: 13,
    kind: "toggle",
    // The toolbar lives in the Rich Prompt, so the command is offered only
    // while the active terminal shows it.
    requirement: "drafts",
    keywords: [
      "Toggle Rich Prompt style toolbar",
      "Show Style Toolbar",
      "Hide Style Toolbar",
      "style",
      "toolbar",
      "format",
      "markdown",
    ],
    available: (ctx) => {
      const t = activeTerminalTab();
      return onWorkspaceTerminal(ctx) && t !== null && isRichPromptVisible(t.id);
    },
    unavailableReason: () => "Needs the Rich Prompt shown",
    state: terminalState((tab) => isRichPromptToolbarOpen(tab.id)),
    run: () => {
      const t = activeTerminalTab();
      if (t) toggleRichPromptToolbar(t.id);
    },
  },
  {
    id: "app.terminal.copyCwd",
    title: "Copy working directory path",
    category: "Terminal",
    scope: "app",
    surface: "terminal",
    requirement: "terminal",
    keywords: ["Copy path to $CWD", "cwd", "path", "directory", "clipboard"],
    // The copy prefers the live absolute cwd the PTY reports and only falls
    // back to the workspace-relative form, so it works in a standalone
    // terminal too.
    available: onTerminal,
    run: () => dispatchChanCommand("app.terminal.copyCwd"),
  },
  {
    id: "app.terminal.newFsEntry",
    title: "New file or directory here",
    category: "Terminal",
    scope: "app",
    surface: "terminal",
    kind: "open",
    // Creates entries through the file routes, keyed off the live cwd.
    requirement: "files",
    keywords: ["New file or directory ($CWD)", "new", "file", "directory", "folder", "cwd"],
    available: onWorkspaceTerminal,
    run: () => dispatchChanCommand("app.terminal.newFsEntry"),
  },
]);
