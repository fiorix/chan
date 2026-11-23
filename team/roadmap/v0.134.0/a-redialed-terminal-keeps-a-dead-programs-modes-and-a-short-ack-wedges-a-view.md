# A redialed terminal keeps a dead program's modes, and a short ack wedges a view

Status: accepted for v0.134.0 by the owner on 2026-11-23, to be built with the Ghostty migration's M4; not started.

Record: two findings of a review of the terminal stream and wake changes v0.133.0 shipped without a cumulative read (in the development tree, `dev/ghostty-web-ng-team/reviews/review-base-1.md`, B3 and the server half of B1), by reading; not reproduced yet. The client half of B1 (a throwing consumer leaving the ack short) is fixed with the migration's write-path change.

## What is there now

Read at `f5657caab`.

- A socket that is replaced while its widget survives (a sleep against a remote devserver, a network drop) redials with `Resume::Since`. When the ring has moved past the cursor with a mode reset inside the lost span, or the session restarted while the socket was down, the server sends the enables-only prelude, not the recovery suffix a live socket gets (`crates/chan-library/src/terminal_sessions.rs`, `crates/chan-server/src/routes/terminal.rs`), and the client resets only on a new session id or a replay cut. The view can keep the dead program's alternate screen, mouse tracking, focus reporting or bracketed paste, so mouse and focus reports reach the shell as text.
- A view released after 5 s without ack progress, or lagged, recovers only when its ack reaches what was sent (`pacing.rs`). An ack that stays short waits with no bound while pongs keep flowing, so neither the read deadline nor the wake probe redials.

## Desired contract

1. A redial that resumes with lost bytes, or across a restart, gets the same recovery suffix as a live socket's recovery, so no mode of a dead program survives it.
2. A released view whose ack stays short is bounded: the server closes the socket after a stated time, and the client redials from its cursor.

## Acceptance

1. Server tests, red at the base: the recovery suffix on a `Since` resume with `missed_bytes > 0` and across a restart; the bounded close of a short-acked released view.
2. A mounted client test: a reconnect with lost bytes leaves no alternate screen or mouse tracking from the dead program.
3. The terminal browser suite green in a guest at the tip.
