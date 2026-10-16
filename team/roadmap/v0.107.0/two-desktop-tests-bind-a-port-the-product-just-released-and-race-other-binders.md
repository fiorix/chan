# Two desktop tests bind a port the product just released and race other binders

Status: built on 2026-10-16 on the seat's branch; the sections Queued-client probe 2026-10-16 and The probe takes a reset only 2026-10-16 hold the evidence; it closes at the GA as shipped.

## What was seen

Read at source at `db5bcb237` by the hygiene seat while building [the-embedded-port-reuse-test-races-other-port-binders](the-embedded-port-reuse-test-races-other-port-binders.md). Two tests of the desktop crate check that the product released a loopback port by binding it themselves right after the release: `desktop/src-tauri/src/auth.rs` 1262, `fail_listener_for_test`, the helper of the failed-adoption tests, asserts `TcpListener::bind((LOCALHOST, port)).is_ok()` after the product drops its sign-in listener; `desktop/src-tauri/src/gateway.rs` 2136, `cancelled_slot_install_is_rechecked_and_drops_the_bound_port`, asserts the same after a refused publication drops its listener. Any binder in the process or on the machine can take the freed ephemeral port between the release and the test's bind. Measured in the hygiene guest for the embedded port test's identical window: a drop-and-rebind repeated 100,000 times in one process lost the port 2 times beside one binder thread and 7 beside two, about once in 50,000 attempts beside one thread and once in 14,000 beside two, more on a busy runner. The consequence is a false red in `cargo test -p chan-desktop`, including the AUR package's `check()` on GitHub's runner, which aborts the package build as the embedded port test's red did on 2026-10-15.

Not established: that either test has gone red on a runner; the embedded port test's one red is the sibling case.

## Desired contract

A test that checks the product released a port observes the release through the product, not through the port's availability, so no other binder can make it fail.

## What to do

Observe the release through the listener's own socket. While the product holds the listener, connect a client it never accepts, so the connection waits in that socket's accept queue; after the release, a bounded read on the client returns a reset when the listener is destroyed, and waits while the listener, or a duplicate of its descriptor, still listens. An end of file is a client the product accepted and closed, which says nothing about its listener, so the probe fails on it. Another binder on the port has a socket of its own and cannot answer for it, and the probe needs no change to the product's types. A check of the port's availability by bind or by connect after the release races other binders, and a retry does not apply when the port under test is the product's own; a `cfg(test)` drop notifier or `Weak` tied to the Rust object misses a duplicate of the descriptor that keeps the socket listening. Pin each repaired test red first under a binder thread that takes the freed port between the release and the old check, then green with the probe while the test itself takes the freed port on every run; and show one product mutant per test that keeps the listener alive past the release (moved into a holder that outlives it, or a duplicate of it kept) red with the probe, so a probe that always reports a release cannot pass.

## Boundaries

`desktop/src-tauri/src/auth.rs` and `gateway.rs`, their tests, and the seam under `cfg(test)`. Not changed: the product's release of either listener.

## Acceptance

1. Both tests red first under a taking binder at the old check, green with the seam, twenty times each under the binder; one product mutant per test that keeps the listener alive past the release, red with the seam.
2. The desktop crate's suite green at the commit in the owning guest.

## Queued-client probe 2026-10-16

Evidence paths below are under `dev/v0107-team/evidence/Hygiene107/dskport/` in the round's bus. The two tests are `gateway::tests::cancelled_slot_install_is_rechecked_and_drops_the_bound_port` and `gateway::tests::listener_failure_clears_current_wait_but_preserves_pat_and_successor`, which reaches the release through `auth::tests::fail_listener_for_test` twice. Read at source: the gateway test's listener is a local of `launch_signin`, dropped when the refused publication returns; the helper's listener is dropped by the test's refusing adoption hook inside `adopt_listener`. Both are a plain `std::net::TcpListener` moved by value through `bind_loopback_listener`, `launch_signin`, `serve_signin_listener` and `adopt_listener`, so a `cfg(test)` drop notifier or `Weak` could be tied to the listener only by changing that type in the product, and a duplicate of the descriptor kept in a holder would keep the socket listening while the object such a seam watches drops.

The reading that set the shape (`probe-reset.{py,job.sh,log,status}`, rc 0): a loopback listener as std binds it, one client connected and never accepted, one bounded read on the client. The listener closed: reset 2000 of 2000, the slowest read 11 microseconds. The listener closed and another socket bound and listening on the same port at once: the rebind succeeded 2000 of 2000 and the client still read reset 2000 of 2000. A duplicate of the descriptor kept past the close, and the listener kept open: the 2 s bound expired 40 of 40 each. Ruled by the lead on 2026-10-16: the queued-client probe in place of the named seam shapes, the in-test take, test code only.

The change, test code only (`auth.rs` and `gateway.rs`; the product's release of either listener unchanged): `auth::tests` gains `queue_client_for_test`, which connects a client while the product holds the listener; `take_freed_port_for_test`, which binds the freed port as another binder would; and `assert_listener_destroyed`, which reads one byte from the queued client with a 10 s bound and accepts a reset or an abort as the listener's destruction, fails naming the product when it accepted and closed the client (an end of file), fails naming the leak when the bound expires, and fails on any other outcome. The gateway test connects inside its `after_install` hook, where the listener is bound and the slot installed, and carries the client out with the port; the auth helper connects right after `bind_loopback_listener`, before the hand-over. After the release each takes the freed port itself and then probes, so a binder on the port is present on every run. The gateway test's other assertions keep proving facts apart from the listener: `!take_pending_for_test()` that the slot is cleared, and `view("gw-keychain").is_none()` that the manager row is gone.

Runs in the hygiene guest (Linux, 2 CPUs, 8 GiB) at `8f1143d6c` (the row imported) with guest-only patches, each run alone by its exact name with `--test-threads=2`, every log showing its one test ran, the source restored to the commit's tree after each job:

- Red first (`thread-take.{log,status}`, rc 0; `thread-take-base.patch` on the tests as they stand): a binder thread takes the freed port between the release and the old `bind(port).is_ok()` check; both tests red 20 of 20 at the old assertions ("refused publication drops the real listener", "failed adoption releases its real port"). The same with the take on the test's own thread (`take-base.{log,status}`, rc 0): 20 of 20 red each, both tests green unpatched.
- The probe (`pretree.{log,status}`, rc 0; `final.patch`, the commit's bytes): both tests green 20 of 20 with the freed port taken on every run; `cargo fmt --check` exit 0, `cargo clippy --locked -p chan-desktop --all-targets -j2 -- -D warnings` exit 0 with `RUSTFLAGS=-Dwarnings`, `cargo test --locked -p chan-desktop --all-targets -j2 -- --test-threads=2` exit 0, 643 passed, 0 failed, 0 ignored.
- Keep-alive product mutants (`mutants.{log,status}`, rc 0), one per test: `launch_signin`'s refused path moving the listener into a static holder (`m-gateway-holder.patch`) sends the gateway test red 20 of 20 at "refused publication drops the real listener: the listener still listens 10 s after its release"; `serve_signin_listener` keeping a `try_clone` in a static holder before adoption (`m-auth-dup.patch`) sends the failed-adoption test red 20 of 20 at "failed adoption releases its real port: the listener still listens 10 s after its release", the duplicate case an object-level seam cannot see.

The probe's mechanism, reset on close of a listener's queued connections, is measured on Linux here; the first macOS and Windows runs are the next `ci.yml` dispatch's. Both run the desktop crate's tests: the `macos` job runs `make ci-macos`, whose `cargo test --all-targets` covers the workspace and `desktop/src-tauri` with it, and the `windows` job runs `make ci-windows`, whose `cargo test -p chan-library -p chan-desktop --all-targets` names the crate.

Acceptance 1 is met: both tests red first under a binder thread at the old check, green with the probe twenty times each with the freed port taken, and one keep-alive product mutant per test red with the probe. Acceptance 2: the desktop crate's suite green at the commit's tree above; the committed own-gate is in the hand-back.

## The probe takes a reset only 2026-10-16

The review seat's read of the range (`reviews/review-Review107-38-dskport-range.md`, its P1) found the probe's end-of-file arm dead in both tests and open to a leak: a queued client that was never accepted is reset (2000 of 2000 above), while an end of file is what a client the product accepted and closed reads, whatever became of the listener; a product that accepts the queued client, closes it and keeps its listener passed the probe as first written. Ruled by the lead on 2026-10-16: the probe takes a reset only. `assert_listener_destroyed` fails on an end of file naming the product ("the product accepted the queued client"); a reset or an abort is the listener's destruction, the bound expiring is a leak, and anything else fails.

Evidence (`p1.{log,status}`, rc 0; `p1-fix.patch`, the commit's bytes; `m-accept.patch`, guest-only: `launch_signin`'s refused path accepts the queued client, closes it and keeps the listener in a static holder), the gateway test being the one the third mutant reaches:

- The gap, the mutant under the probe as first written: the gateway test green 5 of 5, the leak passing.
- The mutant under the probe as committed: red 20 of 20 at "refused publication drops the real listener: the product accepted the queued client".
- The probe as committed: both tests green 20 of 20 with the freed port taken on every run; `cargo fmt --check` exit 0; `cargo clippy --locked -p chan-desktop --all-targets -j2 -- -D warnings` exit 0 with `RUSTFLAGS=-Dwarnings`; `cargo test --locked -p chan-desktop --all-targets -j2 -- --test-threads=2` exit 0, 643 passed, 0 failed, 0 ignored.

On macOS and Windows, whose first runs of the probe are the next `ci.yml` dispatch's, a queued client that read an end of file, or no reset within the bound, fails the probe with its message, so a platform that behaved otherwise would fail loudly rather than pass.
