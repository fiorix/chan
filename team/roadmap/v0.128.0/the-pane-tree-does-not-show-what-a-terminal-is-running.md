# The pane tree does not show what a terminal is running

Status: raised by the owner on 2026-11-10 and accepted for v0.128.0 the same day; not started. It follows the v0.127.0 fix that names each tmux pane by its own title, else its current command, and asks for the same reading in windows that are not tmux windows.

## What is there now

The pane tree (Cmd+Shift+A, `web/packages/workspace-app/src/components/PaneTreeOverlay.svelte`, model `state/paneTree.svelte.ts`) lists each terminal by its tab name: the session's name, which the user or `cs` sets, or `Terminal-N`. Nothing beside it says what runs in the terminal, so several shells in one window read alike until each is opened.

- **Program titles are not read.** A program sets its window title with OSC 0 or OSC 2 (`ESC ] 2 ; text BEL`), as shells do in their prompt hooks and editors do on open; chan's terminals handle no title event (nothing in `TerminalTab.svelte` or `src/terminal/` subscribes to one), and only chan's own OSC 7501 is taken out of the stream (`terminal/ghosttyStatusGuard.ts`, `terminal/xtermReports.ts`).
- **The foreground command is known on the server, and unused for this.** `crates/chan-library/src/terminal_sessions.rs` reads the PTY's foreground process group with `tcgetpgrp` (`foreground_program_group`, Unix only) to attribute program-status reports, and the tmux gate reads a process's name from `/proc/<pid>/comm` (`terminal_sessions/tmux_gate.rs`); neither feeds a name.
- **tmux windows** name each pane by its own `#{pane_title}`, else `#{pane_current_command}` while the title is still tmux's default (the v0.127.0 fix of the owner's pane names report); this item gives other windows the same reading.

## Desired contract

1. In a window that is not a tmux window, each terminal row of the pane tree shows, beside the tab's name, what runs in the terminal: the title the program running in it last set with OSC 0 or OSC 2, else the name of its foreground command (for example `zsh`, `vim`, `cargo`). A title set by a program that has since exited does not outlive it: the foreground command takes over until the next title.
2. It is read once, where the terminal's output is read, so every view of the terminal and every viewer of the window shows the same text, and it follows each change live while the pane tree is open.
3. The tab's own name is unchanged; the reading is shown beside it, secondary, and never renames the tab.
4. In privacy mode the reading is masked with the other labels the pane tree masks.

## Boundaries

- tmux windows keep their per-pane naming; nothing here changes how a tmux pane is named.
- No new tab-naming rule and no change to `cs` names.
- Where the platform cannot name the foreground command (Windows, if ConPTY gives no foreground process), the reading is the program title alone, and the item says so.

## Acceptance

1. Tests of the title reading: OSC 0 and OSC 2 with BEL and ST terminators, a sequence split across reads, a title from a program that has exited, and the foreground fallback on Linux and macOS; tests of the pane tree rows, live and at open, and under privacy mode.
2. A browser check in an isolated guest: in a plain window, a shell row reads its shell, `vim` makes it read `vim`, and `printf '\033]2;build\007'` makes it read `build`.
3. On chan-desktop on macOS (owner): the same in a real terminal.
