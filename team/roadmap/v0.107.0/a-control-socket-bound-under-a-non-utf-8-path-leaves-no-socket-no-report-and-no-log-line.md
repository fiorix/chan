# A control socket bound under a non-UTF-8 path leaves no socket, no report and no log line

Status: carried into v0.107.0 at the v0.106.0 GA on 2026-10-15, still raised for a decision.

Record before the release: raised by the review seat on 2026-10-13 in its read of the fallback socket notice's range (`reviews/review-Review106-sockfb-notice-range-1.md`, its N3, in the round's bus); written down the same day by the lead as a row of its own; read at source by the review seat and not constructed; no owner yet; not ordered in the v0.106.0 round

## What was seen

When a tenant's control socket binds at a path that is not valid UTF-8, the bind succeeds and the path cannot be exported: a terminal that server spawns gets neither `CHAN_CONTROL_SOCKET` nor `CHAN_CONTROL_SOCKET_ERROR`, as the pin `non_utf8_bound_path_has_no_failure_report` holds. `cs` in that terminal prints the generic sentence, which points to the server's start-up log, and the log holds no line about it, since the bind succeeded. The person has nothing to find. The case is older than the notice and pinned as it is.

Not established: that anyone has met it; a runtime directory under a non-UTF-8 path is unusual. Not constructed in a running server.

## Desired contract

A server that binds a control socket it cannot export says so once, where the generic sentence sends the reader.

## What to do

Read the bind path's export at source and construct the case in a guest, with a runtime directory whose name is not UTF-8. If it is as read, a warning at the bind that names the path lossily and the consequence would close it; the design goes to the review seat before code.

## Boundaries

The control socket's start-up path in `crates/chan-server/src/lib.rs` and the spawn environment in `crates/chan-library/src/terminal_sessions.rs`. Not changed: the owner rule, the path's length rule, the notice's sentences.

## Acceptance

1. The case constructed, with what the terminal holds, what `cs` prints and what the log holds.
2. If built: the log line pinned, red first.

## The pin's macOS arm 2026-10-14

`non_utf8_bound_path_has_no_failure_report` cannot construct its directory on macOS (`create_dir` is refused with `EILSEQ`), which the rc1 dry run's macOS job showed; the pin is now gated to Linux, so its coverage is Linux's alone; the repair and its platform statement are in [Two control-socket diagnostics tests assume a Linux filesystem](../done/two-control-socket-diagnostics-tests-assume-a-linux-filesystem.md).
