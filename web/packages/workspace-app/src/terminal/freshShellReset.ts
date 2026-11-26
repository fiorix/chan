/// The DEC private modes a fresh-shell reset clears when a tab's session id
/// changes, with the alternate-screen exit it keeps beside them, and that a
/// cut answer which starts no reset clears before its reassert. This list
/// must stay the server's whole tracked set (`TRACKED_PRIVATE_MODES` in
/// `crates/chan-library/src/terminal_sessions.rs`): a mode the server tracks
/// is a mode the fresh-shell reset clears. `TerminalTab.freshShellModes`
/// ties the two; change both together.
export const FRESH_SHELL_RESET_MODES: readonly number[] = [
  1, 9, 1000, 1001, 1002, 1003, 1004, 1005, 1006, 1015, 1016, 2004,
];

/// The alternate-screen exit the reset keeps alongside the tracked modes.
export const FRESH_SHELL_ALT_EXIT = 1049;

/// Every tracked mode cleared and nothing else: the screen, its contents
/// and the keyboard protocol stay.
export function trackedModesOffSequence(): string {
  return `\x1b[?${FRESH_SHELL_RESET_MODES.join(";")}l`;
}

/// The bytes the tab writes into the terminal before any replay when a fresh
/// shell replaces its session: every tracked mode cleared, then the
/// alternate-screen exit.
export function freshShellResetSequence(): string {
  return `${trackedModesOffSequence()}\x1b[?${FRESH_SHELL_ALT_EXIT}l`;
}
