# `cs terminal close` acknowledges a close that did not happen

Status: raised for v0.100.0 from the v0.99.0 fix loop, where it was an operational observation repeated over several cycles and never reduced to a test. The team process this version returns to depends on these verbs.

## What was seen

After `cs terminal close` printed "closed 1 terminal session(s)" and the name left `cs terminal list`, `cs pane list` still showed the tab live; the name later came back with a new session id as a plain login shell, and every `cs terminal new` aimed at that pane side acknowledged "terminal request queued" and created nothing until a second close. Separately, the process behind a closed tab kept running: one closed agent launched a job 21 minutes after its tab was closed, and 14 such processes had to be stopped by pid over one cycle. Both verbs are chan's own, defined in `crates/chan-shell/src/cli.rs`; the observation is operational and was never reduced to a test, and the workaround (close twice, check `cs pane list`, stop the process by pid) lived in the fix loop's handoff notes.

## Desired contract

A close that reports success has ended the session and released the pane side, so a following `cs terminal new` on that side creates a terminal; a session that cannot be closed says so instead of reporting success.

## Boundaries

`crates/chan-shell/src/cli.rs` and the control path it drives, `crates/chan-library/src/terminal_sessions.rs` (session close and reaping), the window and pane bookkeeping in `crates/chan-server/src/routes/library.rs` and the workspace app's pane state.

## Acceptance

1. A reproduction exists first: a scripted close of a named tab that leaves the pane occupied, or a statement with evidence that it cannot be reproduced outside the agent harness.
2. A close that reports success is followed by a successful `cs terminal new` on the same pane side, pinned by a test.
3. A close that cannot end the session reports a failure the caller can act on.
4. The child process of a closed session is reaped, or the surviving-process case is documented with the verb that ends it.
