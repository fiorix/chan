# The sign-in callback listener is handed to the runtime blocking, and a debug build panics

Status: raised by the desktop seat on 2026-10-12 during the reproduction of the gateway cancel item, from a diagnosis in its guest; written down the same day and accepted by the lead as a prerequisite range of that item, since its reproduction cannot reach a callback in a debug build without it. Not yet designed for review.

## What was seen

In the gateway cancel reproduction (a debug `chan-desktop` built at `4507fe5a0` in a Linux guest), the fixture's matching callback to the desktop's loopback listener failed, and the retained desktop log holds two panics with the fixed text `Registering a blocking socket with the tokio runtime is unsupported`, one per listener attempt, with `panicked at` and `tokio_allow_from_blocking_fd` beside each. Read at source: `desktop/src-tauri/src/auth.rs` lines 269 to 277 bind a standard-library TCP listener on the loopback for the sign-in callback and never set it nonblocking; line 491 hands it to `tokio::net::TcpListener::from_std`. The installed Tokio (1.52.2, `src/util/blocking_check.rs`) asserts in debug builds that such a socket is nonblocking, so the debug desktop drops both callback listeners before any callback can reach them. A release build skips the assertion and keeps a blocking socket in the runtime's accept loop, which Tokio documents as unsupported. Record: `evidence/Desktop106/callback-panic-diagnosis.{log,status}` on the round's bus, with sanitized counts; no raw log or URL was exported.

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
