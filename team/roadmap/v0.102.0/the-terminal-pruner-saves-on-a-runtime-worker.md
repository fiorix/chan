# The terminal pruner saves the window registry under the chan home on a runtime worker

Status: accepted by the owner on 2026-09-27 for a later version than v0.101.0, so it is held under v0.102.0; raised during v0.101.0 on 2026-09-27 by the independent review of the Files watch bound ([a-quit-can-hang-on-a-standalone-files-watch](../done/a-quit-can-hang-on-a-standalone-files-watch.md); `dev/v0101-team/reviews/review-Services-10.md` in the development tree, finding 4), which read the code at `24731ad21`; read again in code at `b1ef073ae`, where the path holds. The hang on a chan home that stopped answering is inferred and not reproduced.

## Owner ruling

Accepted on 2026-09-27 for a later version, as the lead recommended: the owner accepted in one answer every recommendation the lead had put to them that day, and for this item the recommendation was a later version. It is not part of v0.101.0.

## What was seen

The shared terminal tenant's pruner is a runtime task with a minute tick that reaps exited sessions (`spawn_pruner`, `crates/chan-library/src/terminal_sessions.rs:3318-3336`). Reaping a detached session whose shell exited fires the tenant's window reaper (`reap_exited`, `:3216-3254`, the call at `:3248-3250`), which removes the standalone terminal's row from the window registry (`crates/chan-library/src/host.rs:1711-1729`), and the removal saves the registry inline, an atomic write of the whole store (`remove_terminal`, `crates/chan-library/src/windows.rs:560-579`; `save_best_effort`, `:652-681`). The store is a file under the chan home: `windows.json` beside the devserver's configuration (`crates/chan-server/src/devserver.rs:2112-2119`, under `devserver_state_dir`, `:309-321`), and the same file under the desktop's chan home (the comment at `desktop/src-tauri/src/embedded.rs:101`).

So with the chan home on a mount that stopped answering, a tick can block inside that save on a runtime worker. At a quit, the task owner gives the pruner its five-second grace and then aborts it, but an abort takes effect only at the task's next yield, as the review read tokio, so it cannot interrupt a tick inside that save, and the await after the abort (`crates/chan-library/src/tenant.rs:266-277`) then waits, and with it the terminal tenant's shutdown and the drain, until the mount answers. The owner's contract for the quit is about a mounted root, so this is outside it unless the chan home shares the mount with a workspace. The review did not check whether another write under the chan home on the quit path would block first.

## Desired contract

No wait of the quit drain depends on the chan home's filesystem: a save the drain can meet runs off the runtime worker or within a bound.

## What to do

Move the registry's save off the runtime worker, onto the blocking pool or a writer thread of the registry's own, or bound it, and read the other writes under the chan home that the quit path can meet for the same shape. Pin it with the save held while the host drains. Red first: with the save held, the drain does not return.

## Boundaries

`crates/chan-library/src/terminal_sessions.rs` (the pruner), `crates/chan-library/src/host.rs` (the window reaper), `crates/chan-library/src/windows.rs` (the save), and their tests. The design documents say what the drain waits for if that changes.

## Acceptance

1. With the registry's save held inside the pruner's tick, the host's drain returns within its bound, pinned by state and not by time alone.
2. A reap in a healthy home still saves the registry, and the row is gone from it.
