# Moving a tmux window to another index may close its chan window

Status: shipped in [v0.128.0](../../release/release-v0.128.0.md).

Record before the release: raised on 2026-11-10 while fixing v0.127.0's tmux pane names, from a probe of tmux and a reading of chan; not run through chan. Accepted for v0.128.0 by the owner the same day ("sure i can test on the next iteration"). Built on 2026-11-11 (captures on three tmux versions, the connection asking tmux whether a closed window lives on); the owner's confirmation on chan-desktop is in batch 3.

## What is there now

A probe of tmux 3.8 in control mode showed that `move-window` to another index reports the move as `%window-add` followed by `%window-close`, both for the moved window's own id. chan's connection takes an add for a window it already holds as nothing new (`window_seen`, `crates/chan-library/src/terminal_sessions/tmux_connection.rs`) and a close as the window going away (`window_closed`), which closes the window's chan window and ends its pane sessions. Read that way, moving a tmux window to another index closes its chan window while the tmux window lives on, and nothing reopens it until the next reconnect. The reading has not been run through chan, and tmux versions older than 3.8 were not probed.

## Desired contract

1. A tmux window that moves to another index, or to another session and back (`move-window`, `swap-window`, a renumber), keeps its chan window and its panes' sessions.
2. A tmux window that really closes still closes its chan window.

## Boundaries

- The connection's handling of a window's add and close notifications. What tmux sends is taken as given, per version.

## Acceptance

1. First the reading: on chan-desktop (owner), in a `tmux -CC` session with two windows, run `tmux move-window -t 5` in one and note whether its chan window stays; and a capture of what tmux 3.2, 3.6 and 3.8 send for `move-window`, `swap-window` and a renumber, kept as fixtures.
2. If the chan window closes: connection tests fed those fixtures, red at the v0.127.0 code, and a fix under which the window and its sessions survive each move and a real close still closes.
3. If it stays: the item closes with the reading and a test that pins it.

## Built, 2026-11-11

Read first: captures of what a `tmux -CC` client receives on tmux 3.2a, 3.6a (Ubuntu 26.04) and 3.8 for `move-window` to another index, `swap-window`, `move-window -r`, `kill-window`, killing a window's only pane, a kill under `renumber-windows`, and a move to another session and back, kept as fixtures under `crates/chan-library/tests/fixtures/tmux-windows/`. A move within the session is `%window-add` then `%window-close` for the window's id on every version, and chan closed its chan window and ended its pane sessions; through a devserver in a guest the v0.127.0 code drops the moved window's chan window on 3.6a and 3.8. Swap and renumber send nothing and keep ids. The notification names do not separate a move from a close across versions (3.8 reports a kill as a bare `%window-close`; before 3.8 a kill and a move to another session are both `%unlinked-window-close`).

Fix: a close notification for a held window asks tmux for the window's pane list; tmux answers for a window that lives on in any session and refuses for one that is gone, and only the refusal closes the chan window and its pane sessions. A question a full command queue refuses is asked when a reply frees a slot. Connection tests replay every capture and hold chan to tmux's answer (red at the v0.127.0 code for the moves on every version, green after); six mutations of the guards fail their own assertions. The manual's tmux section and `crates/chan-library/design.md` say which changes keep a window. Owner's check on chan-desktop (acceptance 1's first sentence): batch 3, section F. Merged as 5302255d3.

The owner's Mac reading passed on 2026-11-11 (`dev/owner-mac-checks-v0128.md`, section J, built at 811bd5eb8): every step reported passing.
