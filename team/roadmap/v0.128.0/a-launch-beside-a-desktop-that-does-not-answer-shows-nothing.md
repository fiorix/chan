# A launch beside a desktop that does not answer shows nothing

Status: raised on 2026-11-10 by the review of v0.127.0's single-instance guard before its GA; accepted for v0.128.0 by the owner the same day. Not started.

## What is there now

One desktop runs per user: a GUI launch claims the per-user handoff endpoint first, and one that finds it held asks the holder to come forward and exits (`desktop/src-tauri/src/single_instance.rs`). When the holder does not answer (its main thread is stuck, or the process is stopped), a launch with no options first waits the handoff's 3 s reply budget for its offer to open a terminal (`Request::reply_budget`, `crates/chan-server/src/handoff.rs`), then asks the holder to come forward for `ASK_BOUND`, 5 s, then logs "another chan-desktop holds the handoff endpoint but does not answer; this launch exits rather than start a second desktop" and exits 1. Started from the Dock, the Start menu or a launcher, that line goes nowhere the user reads: nothing appears and nothing says why. Before v0.127.0 the second process booted and the user had a working window.

Two more launches end the same way, with exit 1 and a log line alone. A desktop whose handoff listener could not start keeps the endpoint claimed and answers nobody, so every later launch beside it exits after the 5 s. And a launch beside a desktop that says it is shutting down waits `DRAIN_GRACE`, 20 s, for the endpoint and exits 1 if that desktop still holds it.

## Desired contract

1. A launch that exits because the running desktop does not answer, or is still shutting down past the wait, says so where the user can see it: a native message naming chan, that a running copy is not answering, and what to do (quit or end that process, then start chan again).
2. The exit status and the log line stay as they are; no second desktop starts.
3. A launch from a terminal keeps the stderr line, and needs no dialog there if a terminal launch can be told apart; otherwise it shows the same message.

## Boundaries

- The guard's `Unanswered` and `StillShuttingDown` arms on macOS, Windows and Linux. The guard runs before the Tauri app is built, so the message cannot use an app handle.
- Not a way to recover or end the stuck desktop.

## Acceptance

1. The decision is already pinned (`a_held_endpoint_whose_desktop_does_not_answer_exits_non_zero`); a test pins that the two arms that exit 1 call the message hook and the other arms do not.
2. On each platform (the owner on macOS, the Windows VM, a Linux desktop): with the running desktop stopped (`kill -STOP`, or a suspended process on Windows), a launch from the Dock, the Start menu or a launcher shows the message within ten seconds and exits; one process remains.
3. The manual's install page says what a launch does beside a desktop that does not answer.
