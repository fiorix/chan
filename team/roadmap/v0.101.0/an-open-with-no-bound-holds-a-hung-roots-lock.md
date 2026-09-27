# An open with no time limit of its own holds a hung root's lock, and a close of that root waits behind it

Status: raised for a decision on 2026-09-27 by the plan for the fix round of the hung root's open and revalidation (`dev/v0101-team/followups/followup-Services-Lead-9.md` in the development tree, section 2, its table of the surfaces that wait on a root lock), with the independent review that read who waits on a root lock (`dev/v0101-team/reviews/review-Services-13.md`, finding 1). Both read a range that has not landed, in which the open's blocking work owned the root lock, and marked the consequence inferred. Read again at `d1fe06c86`, where the root lock is the caller's and nothing of that range is present; not run. Recommendation: accept for v0.101.0, as the bound the devserver's own mount already has.

## What was seen

At this sha the root lock belongs to the caller. `open_or_get_registered_workspace` computes the root's key, takes the root's lock in the caller's frame and holds it across the open on the blocking pool, or, for a root already mounted, across the revalidation's stat (`crates/chan-library/src/host.rs:1393-1407`; the open at `:1306-1362`, the revalidation at `:1425-1438`). A close by root and a removal take the same lock first (`close_workspace_for_root_impl`, `:3143-3151`; `remove_workspace_for_root`, `:3244-3250`). The lock is a local of the caller's future (`host.rs:1400`), so it goes when the caller stops waiting, and the blocking call it waited on keeps running (`crates/chan-library/design.md:28`).

The devserver's own mount stops waiting at its bound: each attempt awaits the open inside `time_bound_mount`, 60 s (`WORKSPACE_MOUNT_TIMEOUT`, `crates/chan-server/src/devserver.rs:391-394`; `time_bound_mount`, `:813-820`, used at `:1125-1132`). Three callers have no time limit of their own:

- The launcher's add and on await the open with none (`handle_add_workspace`, `crates/chan-server/src/routes/library.rs:1859-1863`; `handle_workspace_on`, `:1905-1909`), and the revalidation's comment says the same of a mounted root's stat: nothing bounds it, and the launcher's add and on have no bound beyond their client (`host.rs:1420-1424`).
- The desktop's embedded open awaits it with none (`open_workspace`, `desktop/src-tauri/src/embedded.rs:299-327`, reached from `serve::start`, `desktop/src-tauri/src/serve.rs:75-87`); its eight attempts with a 150 ms backoff apply to a returned `WorkspaceLocked`, not to an await that never returns (`embedded.rs:307-322`).

So when a root answers its key and then never answers the open or the stat, such a caller holds the root's lock for as long as it waits, and a close or a removal of that root waits behind it: the launcher's off and delete (`routes/library.rs:1955`, `:1981-1984`), `chan close` and `chan workspace forget` over the control socket (`crates/chan-server/src/control_socket.rs:1886-1893`), the devserver's forget (`forget_workspace`, `devserver.rs:1439`) and the desktop's off (`stop_handle`, `serve.rs:146-155`). A close of a mounted root otherwise asks nothing of the root's filesystem, finding its runtime by the keys the host stored (`close_workspace_for_root_locked`, `host.rs:3174-3188`), yet it waits behind a stat that holds the lock. For the launcher's two routes the wait ends when the handler's future is dropped, and whether the server drops it when the browser disconnects was not established; the desktop's open has no client that can go away. That the close then does not answer is inferred, and not run.

[a-hung-root-takes-a-thread-per-expired-caller](a-hung-root-takes-a-thread-per-expired-caller.md) is about the blocking threads that callers leave behind when they stop waiting; this item is about the callers that never stop.

## Desired contract

Every caller that holds a root's lock across a call to the root's filesystem stops waiting within a time limit, as the devserver's own mount does, and answers a refusal that names the root that did not answer; a close or a removal of that root then waits behind it for at most that limit.

## What to do

Give the launcher's add and on and the desktop's embedded open the bound the devserver's mount has: await the host's open inside a time limit and answer its expiry with a refusal that names the root, as `within_mount_bound` does (`devserver.rs:1033-1051`). Decide the limit, the devserver's 60 s or one constant shared by all three. The blocking call keeps running past the bound, and the threads such calls hold are [a-hung-root-takes-a-thread-per-expired-caller](a-hung-root-takes-a-thread-per-expired-caller.md)'s. Red first: with the stall seam letting the key through and holding the open (`root_stall`, `crates/chan-workspace/src/paths.rs:449`, `stall_after` at `:504`), a launcher add whose open hangs and then a close of the root, which answers within the bound and its own work; today it waits as long as the add.

## Boundaries

`crates/chan-server/src/routes/library.rs` (`handle_add_workspace`, `handle_workspace_on`) and `desktop/src-tauri/src/embedded.rs` (`open_workspace`), or the host's `open_or_get_registered_workspace` if the bound belongs there, with their tests and the lock paragraph of `crates/chan-library/design.md`. The devserver's mount keeps its bound.

## Acceptance

1. With a root that answers its key and hangs on the open, a launcher add and on answer a refusal at the bound, and a close and a removal of that root answer after it; pinned red first through the assembled launcher router.
2. The same for the desktop's embedded open, pinned at `open_workspace`.
3. The same for a mounted root whose revalidation hangs.
4. `crates/chan-library/design.md` names the bound of every caller that holds a root's lock.
