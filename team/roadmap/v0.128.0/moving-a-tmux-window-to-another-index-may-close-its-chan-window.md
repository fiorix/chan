# Moving a tmux window to another index may close its chan window

Status: raised on 2026-11-10 while fixing v0.127.0's tmux pane names, from a probe of tmux and a reading of chan; not run through chan. Accepted for v0.128.0 by the owner the same day ("sure i can test on the next iteration"). Not started.

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
