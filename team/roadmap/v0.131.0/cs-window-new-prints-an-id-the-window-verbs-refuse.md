# cs window new prints an id the window verbs refuse

Status: accepted for v0.131.0 by the owner on 2026-11-14 and built in another session on his word (branch `fix/cs-window-new-id`, one commit `749c730b1` on `826adee91`); taken into the integration branch after an independent review.

Record: found on 2026-11-14 by the owner's Mac agent while it took the home page captures for the site lane (`dev/sitehome/captures-home-v0.130.0-take2/take2/REPORT.md`, items 4 and 8). The owner asked the release agent to merge the fix (`dev/winid/handoff-release-agent.md`).

## What is there now

Read at `826adee91`, in 0.130.0: `cs window new` prints the desktop's native label for the new window, `local::w-<hex>`. Every `--window` verb checks its id against the session registry, which holds the bare `w-<hex>` (`require_connected_window`, `crates/chan-server/src/control_socket.rs`), so `cs open README.md --window "$w"` answers `window "local::w-..." is not connected` however long one waits, and the same for `cs pane list --window`.

## Desired contract

1. `cs window new` prints the id the session registry stores for the new window, for a workspace window and a standalone terminal window, so every `--window` verb takes it.
2. Nothing else the desktop returns for a window op changes.

## Boundaries

- The desktop's reply to `DesktopWindowOp::New` (`new_workspace_window` in `desktop/src-tauri/src/window_ops.rs`, `spawn_local_terminal_window` in `desktop/src-tauri/src/serve.rs`) and the op's comment in `crates/chan-library/src/desktop_window_ops.rs`.
- Not here: the second during which the printed id is refused until the new page connects ([its row](cs-window-new-returns-before-the-window-can-take-commands.md)).

## Acceptance

1. Tests that `cs window new`'s reply is the id the registry stores, for both kinds of window, red on the code without the change.
2. A desktop reading in a guest: the id `cs window new` prints is taken by `cs pane list --window`, at the base refused.
