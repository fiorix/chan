# `chan workspace forget` prints none of the host's answer and unregisters locally whatever it was

Status: accepted by the owner on 2026-09-29 for a later version than v0.101.0, so it is held under v0.102.0; raised during v0.101.0 on 2026-09-29 by the independent review of a removal that is still releasing (`dev/v0101-team/reviews/review-Runtime-20.md` in the development tree, finding 2, outside that range, with the lead's notes, which raise it at the landing); its fix round left it, since `crates/chan` was outside its boundary (`dev/v0101-team/reports/report-Runtime-38.md`, "The second review's six findings", its second). Read at `e07f3862f`; how `anyhow` displays an error that carries a context is the review's reading and not a line of this repository. Not run.

## Owner ruling

Accepted on 2026-09-29 for a later version. The owner accepted in one answer every recommendation the lead had put to them that day, and with that answer closed v0.101.0's intake under one rule: a raised item enters v0.101.0 only when it loses a user's data or weakens security and its fix is small and local, a test-only or infrastructure item only when it makes the release gate or a release job unreliable, and an item whose fix changes a contract or reopens excluded scope, or whose fault is a wrong state with a rare trigger, goes to v0.102.0. Under that rule this item goes to v0.102.0 with the three other residuals of a removal that is told to retry, [a-late-off-row-outlives-a-removal](a-late-off-row-outlives-a-removal.md), [a-launcher-delete-leaves-a-devserver-record-on](a-launcher-delete-leaves-a-devserver-record-on.md) and [a-forgets-tombstone-outlasts-its-answer](a-forgets-tombstone-outlasts-its-answer.md): each needs an earlier call on the root that has not let go, a rare trigger, and none touches a user's files. The repair of [a-removal-unregisters-by-the-name-it-is-given](../done/a-removal-unregisters-by-the-name-it-is-given.md), accepted for v0.101.0 the same day, fixes none of the four. This one's fix is small, and it changes the CLI's exit code and its documented rule that a forget does not depend on the teardown's outcome. When it was raised the lead recommended accepting it for v0.101.0, since the CLI can unregister a workspace locally after the host has answered that removal must be retried, leaving the host's in-memory library stale (`crates/chan/src/lib.rs:2421-2447`; `crates/chan-library/src/host.rs:3553-3557`). It is not part of v0.101.0.

## What was seen

Lines at `e07f3862f`. `chan workspace forget` asks the process that serves the workspace to remove it, over the desktop's handoff for the desktop's own `chan` (`unserve_running`, `crates/chan/src/lib.rs:2504-2524`), and otherwise, or when the handoff does not answer that it closed, over the control socket of the process its lock names (`:2526-2559`). On any error of that call it prints `chan: could not reach the server for <path> (<error>); treating as closed.` and then unregisters the workspace in its own process (`cmd_close`, `:2421-2447`; `remove_from_registry`, `:2394-2414`). The control socket's error carries the context `asking the server (pid N) to tear down` (`:2548-2555`), and by the review's reading the printed error is that context alone, so the host's answer, `removing <path>: workspace is still releasing; retry` (`crates/chan-server/src/control_socket.rs:1908-1919`), reaches no user. The host's own doc says that a registry edit made outside it leaves its in-memory library stale (`crates/chan-library/src/host.rs:3553-3557`); where the host's holder has the writer lock, the CLI's unregister fails at the lock, by the review's reading.

## Desired contract

`chan workspace forget` prints what the host answered, and a host's answer to retry leaves the registry as the host holds it.

## What to do

As suggestions: print the control socket's message, and skip the local unregister when the host answered that the workspace is still releasing, with an exit code that says so.

## Boundaries

`crates/chan/src/lib.rs` (`cmd_close`, `unserve_running`) and its tests.

## Acceptance

1. A `chan workspace forget` that the host answers still releasing prints the host's words and exits non-zero; pinned red first.
2. It leaves the workspace registered; pinned.
