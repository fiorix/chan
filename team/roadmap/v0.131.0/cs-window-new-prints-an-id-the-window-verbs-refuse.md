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

## Built, 2026-11-14

The desktop replies to `DesktopWindowOp::New` with the id the window registry stores, `w-<hex>`, for a workspace window (`new_workspace_window`, `desktop/src-tauri/src/window_ops.rs`) and a standalone terminal window (`spawn_local_terminal_window`, `desktop/src-tauri/src/serve.rs`); the op's comment in `crates/chan-library/src/desktop_window_ops.rs` says what the reply is. No other caller reads the value; a v0.130.0 `cs` prints the bare id, which its own `--window` verbs take, and a script that strips `local::` keeps working. A devserver's terminal has no desktop sender and answers `NO_DESKTOP` before the op, so the change reaches local windows only. Merged into the integration branch as `af97d535e`, after an independent review that accepted it (`dev/v0131-team/reviews/review-winid-1.md`).

Proofs, in a desktop guest (Ubuntu 26.04, WebKitGTK under Xvfb; `dev/winid/report.md`, `dev/winid/evidence/`): the two new tests in `window_ops.rs` red on the unfixed sources (stored `["w-..."]` against replied `["local::w-..."]`, `test-base.log`) and green with the fix, the whole `window_ops::` group 8 of 8; the driver `scripts/e2e/desktop-observations/window-new-id.sh` exits 1 against the unfixed desktop and 0 against the fixed one. For the committed driver that is one base run (`walk-base-165258.log`) and two fix runs (`walk-fix-165312.log`, `walk-fix-165318.log`); two earlier walk logs came from an earlier revision of the driver and are not counted. `cargo clippy` for chan-desktop and chan-library with all targets, rustdoc for both and `cargo fmt --check` were green. Not run with this change alone: the Windows-target clippy and the desktop tests as uid 1000, which run with the next milestone's full gate.

Left for the row on the race ([its row](cs-window-new-returns-before-the-window-can-take-commands.md)): `spawn_throwaway_terminal_window` still returns the native label (its one reader is a log field), and the driver's delay is an upper bound with about 0.3 s of polling in it.
