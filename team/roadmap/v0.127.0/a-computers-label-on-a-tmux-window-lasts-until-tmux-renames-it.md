# A Computers label on a tmux window lasts until tmux renames it

Status: left open by the tmux pane tree fix earlier in v0.127.0 (`48f47be29`), which made a tmux window's label follow the name tmux gives it; asked on 2026-11-10 whether a label given in Computers should stick, the owner ruled the same day: "the window i want to stick to our value, yes; the panes can have their own titles, equivalent to how our chan tabs have their names separate from the windows". Built on `fix/tmux-pane-names` (`7fba5fc90`) and merged into the integration branch as `7898f4fe3`. Each property is pinned by a test shown red without its fix.

## What was there

A tmux window's row is labelled with its tmux window's name, and since `48f47be29` every `%window-renamed` relabels it. With automatic rename tmux renames a window whenever its active pane's command changes, so a label the user gave the window in Computers was replaced at the next pane switch or command.

## Contract as built

1. A tmux window's row follows tmux's name for the window while the user has given it no label, as before.
2. A label given in Computers stands (`TmuxWindowMark::user_label`, `crates/chan-library/src/windows.rs`): tmux's renames reach neither the row, the pane tree's heading, the OS title nor a browser tab's title while it is set, and the window's page is sent nothing.
3. Clearing the label hands the row back to tmux at once, with the name the connection holds for the window (`tmux @N` for an unnamed one).
4. A window's page is told a label only when the label the row shows changed; setting the same label again sends nothing, for every kind of row.
5. Pane names are separate from the window's label and unaffected by it.

## Boundaries

- A tmux window's row is never saved, so the user's label lasts as long as the row: until the tmux window closes or the connection ends. A reconnect mints new rows labelled by tmux. The label is not pushed into tmux.
- Whose label a row carries is known to the process that owns the row and is not on the wire.

## Acceptance

1. Tests (met): the registry over follow, label, three tmux renames, the same label again, and a clear with a name, without one, with a long one and with no connection; the host with a live page, which hears no frame while a label stands and the next one after the clear. The tests of `48f47be29` pass unchanged.
2. The integration branch's gate and Windows cross-check green with the merge.
3. On chan-desktop (owner): label a `tmux -CC` window in Computers, switch panes and run commands in it, and the label stays in Computers, the pane tree's heading and the window's title; clear it and the window reads tmux's name again.
