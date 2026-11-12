// Terminal surface commands: available when a terminal tab is the active
// surface, excluding the control-terminal singleton whose chrome and
// lifecycle belong to the connect flow. Group broadcast, rename and set
// group act on the active terminal tab directly; the live-PTY actions
// dispatch a chan:command that the owning app/TerminalTab path handles,
// since live CWD, session lifecycle, and secret masking live outside this
// catalog. The terminal's theme and its engine are fields of the Settings
// overlay and reach the launcher through the settings index. Register with
// registerCommands. See state/commands.ts for the Command shape and helpers.

import {
  registerCommands,
  dispatchChanCommand,
  onSurface,
  type CommandContext,
} from "../commands";
import { uiPrompt } from "../store.svelte";
import {
  activeTerminalTab,
  allTerminalTabs,
  crossWindowBroadcastMembers,
  renameTerminalTab,
  setTabInspectorOpen,
  terminalBroadcastMemberIds,
  terminalTabGroup,
  terminalTabName,
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

/// The active terminal tab's value for a toggle's state, null when no
/// terminal tab is active.
function terminalState(read: (tab: TerminalTab) => boolean): () => boolean | null {
  return () => {
    const tab = activeTerminalTab();
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
  const group = terminalTabGroup(tab);
  const local = allTerminalTabs().filter((t) => terminalTabGroup(t) === group);
  const cross = crossWindowBroadcastMembers(tab);
  if (local.length === 0 && cross.length === 0) return false;
  const selected = new Set(terminalBroadcastMemberIds(tab));
  return (
    local.every((t) => (t.id === tab.id ? tab.broadcastEnabled : selected.has(t.id))) &&
    cross.every((member) => member.broadcast)
  );
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
    keywords: ["Toggle group broadcast", "broadcast", "group", "select all", "input"],
    available: onTerminal,
    state: terminalState(groupBroadcastOn),
    run: () => dispatchChanCommand("app.terminal.broadcastToggle"),
  },
  {
    id: "app.terminal.details",
    title: "Details",
    category: "Terminal",
    scope: "app",
    surface: "terminal",
    order: 4,
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
    // The terminal's own component holds whether its masking is on, so the
    // catalog cannot read it: this flips it and reports no state.
    id: "app.terminal.secretMasking.toggle",
    title: "Secret masking (this terminal)",
    category: "Terminal",
    scope: "app",
    surface: "terminal",
    order: 5,
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
    run: () => dispatchChanCommand("app.terminal.secretMasking.toggle"),
  },
  {
    id: "terminal.richPrompt",
    title: "Rich Prompt",
    category: "Terminal",
    scope: "app",
    surface: "terminal",
    order: 9,
    kind: "toggle",
    // Rich Prompt drafts into the tenant's drafts store.
    requirement: "drafts",
    keywords: ["Show/Hide Rich Prompt", "prompt", "composer"],
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
    order: 10,
    kind: "toggle",
    // The toolbar lives in the Rich Prompt, so the command is offered only
    // while the active terminal shows it.
    requirement: "drafts",
    keywords: ["Toggle Rich Prompt style toolbar", "style", "toolbar", "format", "markdown"],
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
