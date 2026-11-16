# A fresh shell after a dead full-screen program keeps some of its input modes

Status: accepted for v0.132.0 by the owner on 2026-11-16, by survey ("Take all my recommendations (recommended)", answering `dev/v0131-team/reports/owner-candidates-6.md`); not started.

Record: note 3 of the third terminal milestone review of v0.131.0 (`dev/v0131-team/reviews/terminal-milestone-3.md`), entry T117 of the round's terminal regression list (`dev/v0131-team/terminal-regressions.md`), and item 1 of `owner-candidates-6.md`. The client's reset always left these modes out; v0.131.0's [reattach row](../v0.131.0/a-reattach-replays-the-normal-screen-into-a-full-screen-program-and-drops-its-mouse-modes.md) grew the server's tracked set to twelve modes and left the reset as it was. Rare; nothing is lost.

## What is there now

Read at `f453b0b2e`, by reading; not run.

- A reattach that names a session the server neither holds nor remembers as ended gets a fresh shell under a new id (`crates/chan-library/src/terminal_sessions.rs:3329-3362`), as after a server restart that did not restore the session. The full-screen program that ran there is gone, and the tab's terminal still holds the input modes it set.
- The tab resets them when the session frame names an id other than the one it held (`web/packages/workspace-app/src/components/TerminalTab.svelte:1806-1823`): it resets the keyboard protocol and writes `\e[?1000;1002;1003;1004;1006;1015l\e[?1049l` into the terminal, at the session frame, before any replay. A same-id resume keeps the program's modes.
- The server's tracked set, which a reattach's prelude re-asserts, is twelve modes (`TRACKED_PRIVATE_MODES`, `crates/chan-library/src/terminal_sessions.rs:199-213`): 1 (application cursor keys), 9, 1000, 1001, 1002, 1003, 1004, 1005, 1006, 1015, 1016 and 2004 (bracketed paste). The reset leaves out 1, 9, 1001, 1005, 1016 and 2004.
- What that leaves: on xterm.js, which takes mode 9 as X10 mouse tracking (`web/packages/workspace-app/src/terminal/mouseModeFilter.ts:33-40` lists the modes that turn on mouse reporting there), a dead program that set 9 leaves clicks in the new shell sending `\e[M...` reports into it. A leftover 2004 wraps pastes for a shell that never asked for bracketed paste, and a leftover mode 1 sends arrows in the application form. Few programs set 9, 1001, 1005 or 1016, and common shells set bracketed paste themselves.
- The mounted test of the reset (`web/packages/workspace-app/src/components/TerminalTab.ghosttySession.test.ts:129-149`) takes the reset's own list as its parameters (1000, 1002, 1003, 1004, 1006, 1015 and 1049) and reads ghostty's core.

## Desired contract

1. When a fresh shell replaces a tab's session, the client resets every mode in the server's tracked set (1, 9, 1000, 1001, 1002, 1003, 1004, 1005, 1006, 1015, 1016 and 2004), with the alternate-screen exit and the keyboard protocol reset it makes today. The reset names the server's set: a mode the server tracks is a mode the fresh-shell reset clears.
2. The reset lands before any output of the new shell, so it cannot undo a mode the new shell sets in its own output, such as a shell's bracketed paste at its first prompt.
3. A same-id resume keeps the running program's modes, as today.

## Boundaries

- The reset in `TerminalTab.svelte` and its tests. One list may serve the client and the server, or a test may tie the two.
- The server's tracked set and its attach prelude stay as they are.
- The reset names the whole set on both backends, including a mode a backend does not honour.

## Acceptance

1. The mounted reset test takes the server's set as its parameters, on both backends: each mode set by the dead program, kept on a same-id resume and cleared for a fresh shell. Red at the base for 1, 9, 1001, 1005, 1016 and 2004. For a mode a backend's core does not record, the case reads the reset's bytes written to that backend instead, and says so.
2. The order, as a mounted test on both backends: the fresh shell's first output, after the session frame, sets 2004 and mode 1; both are on once the attach has settled. Moving the reset after the replay turns it red.
3. Dropping any mode from the reset turns its case red, and restoring it turns the case green.
4. The reset's list cannot drift from `TRACKED_PRIVATE_MODES` unseen: a test compares the two, or both come from one list.
