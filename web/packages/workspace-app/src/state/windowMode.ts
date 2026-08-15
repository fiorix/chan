// Window-mode command gates. The `?kind=` window URL puts a window into
// terminal-only mode, or the stricter control-terminal sub-mode; these
// sets say which command ids stay valid there. App.svelte's runCommand
// consults them before dispatch, and the command launcher consults the
// same predicate, so a hidden launcher command and a dropped dispatch
// can never disagree.

/// Commands that remain valid in a window holding terminals and nothing
/// else. Everything outside this set needs a workspace or at least a
/// filesystem (editor / graph / file browser / dashboard / rich-prompt /
/// drafts / search), so it is dropped before the dispatch switch when
/// `ui.terminalOnly` is set. A window that has a filesystem is gated by the
/// catalog's requirement table instead; this set also classifies the
/// window-level ids that have no catalog row (see `dispatchAllowsCommand`). Terminal lifecycle,
/// the command launcher, Settings, pane/tab navigation, pane flip, broadcast,
/// and the screensaver lock all work without a workspace and stay live.
export const TERMINAL_ONLY_COMMANDS: ReadonlySet<string> = new Set<string>([
  "app.launcher.toggle",
  "app.settings.open",
  "app.window.reload",
  "app.pane.mode",
  "app.pane.flip",
  "app.terminal.toggle",
  "app.terminal.broadcastToggle",
  "app.screensaver.lock",
  "app.pane.next",
  "app.pane.prev",
  "app.pane.closeTabs",
  "app.pane.kill",
  "app.pane.splitRight",
  "app.pane.splitDown",
  "app.tab.next",
  "app.tab.prev",
  "app.tab.jump",
  "app.tab.close",
  "app.tab.sendToA",
  "app.tab.sendToB",
  "app.window.new",
  "app.window.close",
  "app.window.confirmClose",
  "app.window.hide",
  "app.find.open",
  "app.find.next",
  "app.find.prev",
  "app.find.close",
]);

/// The control terminal is a singleton: on top of the terminal-only
/// filter, block the commands that would break the one-PTY invariant,
/// namely spawning more terminals (Cmd+T) or splitting the pane into an
/// empty second pane (which, with the welcome tile gone in terminal-only
/// mode, would strand a blank pane). Reopening the script PTY is the
/// connect flow's job, not the user's.
export const CONTROL_TERMINAL_BLOCKED: ReadonlySet<string> = new Set<string>([
  "app.terminal.toggle",
  "app.pane.splitRight",
  "app.pane.splitDown",
]);

/// Whether `id` may run in the given window mode. Mirrors runCommand's
/// own guard: a terminal-only window drops everything outside
/// TERMINAL_ONLY_COMMANDS, and a control terminal additionally drops the
/// one-PTY-breaking commands. A workspace window allows everything.
export function windowModeAllowsCommand(
  id: string,
  mode: { terminalOnly: boolean; terminalControl: boolean },
): boolean {
  if (mode.terminalOnly && !TERMINAL_ONLY_COMMANDS.has(id)) return false;
  if (mode.terminalControl && CONTROL_TERMINAL_BLOCKED.has(id)) return false;
  return true;
}

/// Whether a terminal in the given window mode may persist a scrollback
/// snapshot to localStorage. A control terminal never may: its scrollback
/// carries the `CHAN_DEVSERVER_TOKEN=` marker the desktop re-scrapes, and a
/// persisted copy would keep that credential on disk for days. Losing the
/// snapshot costs the control window only a full replay from the server
/// ring (single-shot local runner, one PTY). TerminalTab's captureSnapshot
/// consults this; a pure rule so it is testable without mounting.
export function windowModeAllowsSnapshot(mode: {
  terminalControl: boolean;
}): boolean {
  return !mode.terminalControl;
}
