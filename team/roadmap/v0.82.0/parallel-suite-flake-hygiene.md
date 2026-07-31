# Parallel-suite flake hygiene

Status: IMPLEMENTED and VERIFIED for v0.82.0.

## Recovery contract

The scene and document session state and registry mutexes recover a poisoned guard with `unwrap_or_else(|error| error.into_inner())`. `SurveyBus::finish_turn`, which is reachable from `SurveyTurnGuard::drop`, applies the same rule to its queue mutex. The other survey mutex failures remain ordinary handler errors and stay fail-fast.

This is a deliberate runtime behavior: a panic while holding a session or registry mutex does not make cleanup panic again and abort the process. Cleanup and later requests continue from whatever in-memory state the panicking writer left mid-update. `crates/chan-server/src/bus.rs` uses the same recovery policy for in-memory bookkeeping.

## Deterministic reconciliation input

`restamped_disk_adopt_keeps_durable_bytes_and_settles_its_echo` clears `flushed_mtime_ns` after its disk write and before its first reconcile. The test therefore cannot take the equal-mtime short circuit and does not depend on filesystem timestamp granularity. Its assertions and runtime are unchanged.

## Gateway timing rule

Idle-window assertions anchor elapsed time to activity that drives the bridge deadline rather than to a later receive poll:

- Client-only traffic measures from the last successful client send.
- The both-idle case measures from before the final client frame and its upstream echo.

Both assertions require the full `WS_TEST_IDLE`; neither uses a multiplicative factor, padding, or a wider timeout. These are the only two `.elapsed()` assertions in `gateway/`.

## Injected instant seam

`DiskEchoRing` production methods read `Instant::now()` and delegate to private `note_at`, `contains_at`, and `any_recent_write_at` methods. Ring unit tests drive those methods with explicit instants. Session tests use a `#[cfg(test)]` age seam between the live-entry reconcile and expired-entry reconcile, preserving the written/adopted TTL asymmetry without sleeping.

The owned disk-echo test surface has no TTL sleeps. The scene and document restore tests remain live-before and expired-after tests, and the adopted-content restore advances only 40 ms so a 60 s written entry would remain live.

## Verification

- Forced guard-held assertion failures abort both the scene and document test binaries before poison recovery. With recovery, the same mutations produce ordinary harness results with exactly one failed test and the remaining module tests reported.
- The discriminating single-threaded disk-echo filter improves from a 2.69 s before minimum to a 0.76 s after minimum. Whole-lib samples (66.92 s before minimum, 59.71 s after minimum) are context only: their 72 s before-sample spread and concurrent lane load are too noisy to decide acceptance. The gateway websocket filter shows no regression (5.40 s before minimum, 5.15 s after minimum).
- Scene sessions pass 67/67, document sessions pass 73/73, and the three restore tests pass in 20/20 repeated filter runs.
- The confirmed `N=84` gateway websocket loop passes 84/84 while an 11-minute `cargo test --workspace --exclude chan-desktop --lib` repeat loop runs concurrently in the lead's integration worktree. Every preserved run reports 3 passed and 0 failed.
- The required whole-binary x20 sanity count is 16 green and 4 unrelated timeout reds, with no owned failure. The original scene race is not claimed fixed by these statistics.

## Follow-ups

- `crates/chan-server/src/devserver.rs:6041` is the remaining chan-server sleep-then-assert site and needs the same injected-instant treatment in its owning surface.
- The original scene race remains unreproduced. The nondeterministic mtime input is removed, but the equal-mtime short circuit is an unproven mechanism rather than a demonstrated root cause. Any further diagnosis needs the rest of the chan-server test binary co-resident in the same process.
