# The pane tree does not show what a terminal is running

Status: raised by the owner on 2026-11-10 and accepted for v0.128.0 the same day; built on 2026-11-11 (the server reading, its wire and the pane tree's web half); acceptance 3, the owner's check on chan-desktop on macOS, is pending. It follows the v0.127.0 fix that names each tmux pane by its own title, else its current command, and asks for the same reading in windows that are not tmux windows.

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

## Built, 2026-11-11

The server reads each terminal's program once, beside the output it already reads: a dedicated OSC 0 and OSC 2 observer after the tmux gate keeps the title the foreground program last set (BEL and ST terminators, sequences split across reads, bounded), and a sampler names the foreground command from `/proc/<pgid>/comm` on Linux and the linked `sysinfo` elsewhere, one batch per sweep (500 ms where the read is bounded, 1 s where it enumerates the table). A title is attributed to the raw foreground group at admission and expires on an observed transition, so a title set by a program that has exited gives way to the next foreground command; a job shorter than a sample can leave its title unread, recorded as a limit. The reading is kept per session incarnation, cleared on exit and restart, never persisted and never added to `cs` identity; tmux panes publish the empty pair and keep their tmux names. On the terminal socket the `session` prelude carries `program: {title, command}` (both nullable, always present) and a `program` frame replaces the whole pair, at most one changed pair per 150 ms per attachment, with the cleared pair delivered before `exit`; `renamed` and the status frames are unchanged, and older pages ignore the field and the frame. Proven by the library's scanner and sampler tests with real job-control PTYs, the server's socket tests (two viewers, late and hidden and resumed attaches, the snapshot and subscription race, output flood and equality suppression, broadcast lag, restart, a clear before exit, rename separation) and their mutations, and by the design notes in `design.md` and `crates/chan-library/design.md`.

The workspace app keeps the server's reading on each terminal tab: the `session` prelude sets it for every attachment, a `program` frame replaces the whole pair only when it names the tab's session and current generation, and the session's end clears it; it is never saved, moved to another window or carried into a reopened tab. The pane tree shows it beside each terminal's name, in the row and secondary in weight, as the program's title, else its foreground command, and nothing on a tmux pane, whose name already comes from tmux; the tab name, the filter and the tooltip are unchanged. Privacy mode shows the fixed text Hidden with the reading nowhere in the row, and the latest reading returns when it is off. Proven by vitest over the frames, the model, the overlay and the clone, move and persistence policies (twelve mutations, each red), and by browser-smoke check 220 in headless Chrome on both terminal backends: a bare bash reads `bash`, `vim` reads `vim`, the shell's OSC 2 reads `build` beside the unchanged name, a job's title goes with the job, a second page reads the same text from its attach prelude, and privacy mode masks it, red at the base and under three of four page mutations (the tmux exclusion is the server's empty pair in a browser and is proven in vitest). The manual's terminal page describes the reading with its attribution limits and Windows' title-only form.

Open: acceptance 3, the same reading in a real terminal on chan-desktop on macOS, is the owner's check. Two readings kept for the owner: each foreground change shows an empty reading for a moment (the server clears the old command at a group transition and publishes the new name after the next lookup), so the tree blinks off and on; and check 220 needs vim in its guest, which the browser rootfs recipe does not install.

The owner's Mac reading passed on 2026-11-11 (`dev/owner-mac-checks-v0128.md`, section G, built at 811bd5eb8): every step reported passing.
