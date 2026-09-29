# A close or a removal over the control socket runs to its end whatever its client does

Status: raised for a decision on 2026-09-28 from the work on a hung root's blocking calls: the report of the caller's root lock (`dev/v0101-team/reports/report-Services-26.md` in the development tree, "Every root-lock wait and its caller bound" and "Corrections and next order") and its independent review (`dev/v0101-team/reviews/review-Services-15.md`, question 3). Read in code at `7957bccef`; what it holds on a root that stops answering is inferred, and nothing was run. Recommendation: a later version.

## What was seen

`chan close` and `chan workspace forget` ask the process that serves a workspace over its control socket (`crates/chan/src/lib.rs:2538-2545`). The socket's handler drops the connection's reader, spawns the close or the removal as a task of its own and waits for it, and bounds only the reply's write, at five seconds (`crates/chan-server/src/control_socket.rs:1051-1069`; `handle_unserve`, `:1878-1912`), so its client's going away, by an end of file or a Ctrl-C, does not cancel it. The handler's comment gives the reason: the unmount drops the tenant's accept task and its connections, and the operation must still finish and answer (`:1052-1055`).

The close and the removal hold the root's lock for their whole length (`close_workspace_for_root_impl`, `crates/chan-library/src/host.rs:3261-3272`; `remove_workspace_for_root`, `:3362-3368`). On a root that has stopped answering, a close waits on its own hop, the registry lookup of a root that is not mounted (`:3314-3320`) or the teardown of a mounted tenant, which a close awaits past its deadline (`crates/chan-library/design.md:44`), and a removal waits also on its unregister (`host.rs:3404-3428`). So such a close or removal holds the root's lock until the root answers or the process ends, and every later open, close and removal of that root waits behind it (`:1459`, `:3268`, `:3368`), whatever the `chan` that asked for it does. A caller that gives up elsewhere lets the lock go with its future; the socket's task is never given up. Inferred from the code; not run.

Read again at `e07f3862f` on 2026-09-29, when a close's and a removal's own hops took permits ([a-hung-root-takes-a-thread-per-expired-caller](a-hung-root-takes-a-thread-per-expired-caller.md)): a close or a removal of a root no runtime holds now asks the root which row it is only when no row goes by the keys the row stores (`closing_row`, `crates/chan-library/src/host.rs:3506-3539`), so a `chan close` of a root that did not move behind a symlink no longer waits in that lookup; one sent by the path a moved root resolves to now still does, under the root's lock, and so do the desktop's handoff's close and forget, which send that path and never give up either, by the independent review of that work (`dev/v0101-team/reviews/review-Runtime-19.md`, finding 2). A second close of that path waits at the root's lock behind the first (`crates/chan-library/design.md:30`), and a removal waits on its unregister as before (`host.rs:3663-3700`).

## Desired contract

A close or a removal asked over the control socket of a root that has stopped answering answers its client within a bound and does not hold the root's lock past it, while a close of the socket's own tenant still finishes its unmount.

## What to do

A later version, by the recommendation. A code map first of what the detached operation can wait on. Then, as suggestions: a bound around the operation's waits on the root, answering the client with a refusal that names the root, as the devserver's mount bound does; or a cancellation that the client's end asks for before the unmount begins and not after. Red first, with the stall seam holding a root's registry lookup: a `chan close` whose client leaves, then an on of that root that answers.

## Boundaries

`crates/chan-server/src/control_socket.rs` (the close's detached task and `handle_unserve`), and the host's close and removal by root if the bound belongs there, with their tests and `crates/chan-library/design.md`.

## Acceptance

1. A close and a removal over the control socket of a root that stops answering in its lookup answer within the bound, and a later open of that root is not held behind them, pinned red first.
2. A close of the socket's own tenant still finishes its unmount and answers.
