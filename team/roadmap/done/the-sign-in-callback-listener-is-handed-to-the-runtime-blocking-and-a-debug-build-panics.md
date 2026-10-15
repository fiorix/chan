# The sign-in callback listener is handed to the runtime blocking, and a debug build panics

Status: shipped in [v0.106.0](../../release/release-v0.106.0.md).

Record before the release: raised by the desktop seat on 2026-10-12 during the reproduction of the gateway cancel item, from a diagnosis in its guest; written down the same day and accepted by the lead as a prerequisite range of that item, since its reproduction cannot reach a callback in a debug build without it. Designed, built, reviewed and integrated the same day (see "Build record"); acceptance 1 to 3 met, 4 by the gateway cancel item's native run.

## What was seen

In the gateway cancel reproduction (a debug `chan-desktop` built at `4507fe5a0` in a Linux guest), the fixture's matching callback to the desktop's loopback listener failed, and the retained desktop log holds two panics with the fixed text `Registering a blocking socket with the tokio runtime is unsupported`, one per listener attempt, with `panicked at` and `tokio_allow_from_blocking_fd` beside each. Read at source: `desktop/src-tauri/src/auth.rs` lines 269 to 277 bind a standard-library TCP listener on the loopback for the sign-in callback and never set it nonblocking; line 491 hands it to `tokio::net::TcpListener::from_std`. The installed Tokio (1.52.2, `src/util/blocking_check.rs`) asserts in debug builds on Unix that such a socket is nonblocking (the check is `#[cfg(unix)]` and a `debug_assert!`; on Windows and in a build without debug assertions it is a no-op), so the debug desktop drops both callback listeners before any callback can reach them. A release build skips the assertion and keeps a blocking socket in the runtime's accept loop, which Tokio documents as unsupported. Record: `evidence/Desktop106/callback-panic-diagnosis.{log,status}` on the round's bus, with sanitized counts; no raw log or URL was exported.

Not established: whether a release build's blocking listener has ever misbehaved in use (the owner's sign-in flow works in the shipped desktop by his report); which versions of Tokio assert; whether any other listener the desktop or the CLI creates takes the same path.

## Desired contract

The callback listener is nonblocking before it is handed to the runtime, a failure to make it so propagates as a setup error, and a debug build reaches its callback like a release build.

## What to do

Set nonblocking mode in `bind_loopback_listener` before returning the listener, propagating the call's failure. A regression test adopts the helper's listener on a Tokio runtime and proves it accepts a loopback connection, red first on the assertion in a debug test build. Search the desktop crate and the CLI for other standard-library listeners or sockets handed to `from_std` and say for each whether it sets nonblocking. One paragraph of design to the review seat before the code; do not suppress the assertion or switch the reproduction to a release build to get past it.

## Boundaries

`desktop/src-tauri/src/auth.rs` (`bind_loopback_listener` and the handoff to the runtime) and its tests. Not changed: the sign-in flow, the pending slot, the callback's routes.

## Acceptance

1. A test that adopts the helper's listener on the runtime and accepts a loopback connection is red before the repair on the runtime's assertion and green after.
2. The search of the two crates for other `from_std` handoffs is recorded with its result and a positive control.
3. The desktop crate's tests, fmt and clippy are green at the commit in the owning guest, and the desktop build is green.
4. The gateway cancel reproduction runs on the repaired revision and names it.

## Lead's decision 2026-10-12

The desktop seat's design, read by the review seat: `set_nonblocking(true)` on the bound listener in `bind_loopback_listener` with its failure propagated as the helper's setup error, before any pending state is installed (the helper runs before the slot swap and the browser, so a refusal leaves nothing installed, as a refused bind does today); a Tokio test that adopts the actual helper's listener through `from_std` as the production task does and joins one loopback connect with one accept under a bound, red before the repair on the runtime's assertion at the test's own `from_std` line and nowhere earlier; the `from_std` search over the desktop crate and `crates/` (six lines, line 491 the control) and the review seat's wider searches (`AsyncFd`, raw descriptors, `From` conversions) finding no other socket adoption, which answers the third "Not established". The review seat's additions: the pin can go red only on a Unix target with debug assertions on, said in a comment on the test and in the hand-back, and the `set_nonblocking` error path stays unpinned for want of an injection point; a release build's blocking listener could, on a stale readiness, hold a worker thread in `accept` and keep the shutdown arm of the accept task's `select!` from running, which the repair ends, read from the code and Tokio's contract and never observed, a note for the changelog; the adoption's error arm, which leaves the slot installed and the browser opened with no listener until the TTL, stays as it is here and is counted by the gateway cancel's design among the parked waits a cancel must end.

## Build record 2026-10-12

The desktop seat's commit on its branch (`d22bb9da6`, `desktop/src-tauri/src/auth.rs`): `set_nonblocking(true)` on the bound listener in `bind_loopback_listener`, its failure propagated as the helper's setup error before any pending state is installed; the regression test adopting the actual helper's listener through `from_std` on a Tokio runtime and accepting one loopback connection, with a comment that it can go red only on a Unix target with debug assertions on. The test was red before the repair on the runtime's assertion at its own `from_std` line (the retained red run) and green at the fix; fmt, clippy with warnings denied, the whole desktop suite (586 tests) and the debug desktop and CLI build green at the commit in the seat's guest (286 s). The `set_nonblocking` error path has no pin, for want of an injection point. On the repaired revision the gateway cancel reproduction's second native attempt received its callbacks (acceptance 4), as that item's record says. Records: `evidence/Desktop106/cbnonb-gate.*` and `cbnonb-red.*`. The review seat ran the regression at the committed tip in its guest and the same test with the repair's three lines removed (red on the runtime's assertion at the test's own line), and accepted the range with no correction; it is landed on `v0106/int` with a changelog entry.

The desktop crate's whole suite at four threads on the integration tip `67919a62c` (this landing with the later ones) is green in the integration guest, 194 s, the gate held through the quiet window and run after it.
