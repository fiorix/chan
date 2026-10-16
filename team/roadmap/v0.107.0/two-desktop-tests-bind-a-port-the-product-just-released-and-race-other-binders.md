# Two desktop tests bind a port the product just released and race other binders

Status: raised on 2026-10-16 by the lead from the hygiene seat's reading of the embedded port test's race; written down with its repair's shape; built by the hygiene seat after the embedded port item; owner the hygiene seat.

## What was seen

Read at source at `db5bcb237` by the hygiene seat while building [the-embedded-port-reuse-test-races-other-port-binders](the-embedded-port-reuse-test-races-other-port-binders.md). Two tests of the desktop crate check that the product released a loopback port by binding it themselves right after the release: `desktop/src-tauri/src/auth.rs` 1262, `fail_listener_for_test`, the helper of the failed-adoption tests, asserts `TcpListener::bind((LOCALHOST, port)).is_ok()` after the product drops its sign-in listener; `desktop/src-tauri/src/gateway.rs` 2136, `cancelled_slot_install_is_rechecked_and_drops_the_bound_port`, asserts the same after a refused publication drops its listener. Any binder in the process or on the machine can take the freed ephemeral port between the release and the test's bind. Measured in the hygiene guest for the embedded port test's identical window: a drop-and-rebind repeated 100,000 times in one process lost the port 2 times beside one binder thread and 7 beside two, about once in 50,000 attempts beside one thread and once in 14,000 beside two, more on a busy runner. The consequence is a false red in `cargo test -p chan-desktop`, including the AUR package's `check()` on GitHub's runner, which aborts the package build as the embedded port test's red did on 2026-10-15.

Not established: that either test has gone red on a runner; the embedded port test's one red is the sibling case.

## Desired contract

A test that checks the product released a port observes the release through the product, not through the port's availability, so no other binder can make it fail.

## What to do

A test seam that reports the listener's own destruction, a drop notifier owned with the listener or a `Weak` to its owner that no longer upgrades, read by the two tests in place of the bind; not the slot's state, which is a different fact (the gateway test already asserts it apart) and says nothing about a listener a task or a holder still owns. A check of the port's availability by bind or by connect races other binders the same way, and a retry does not apply when the port under test is the product's own. On Linux the operating-system fact can be kept without racing: the listener socket's inode recorded before the release, and no LISTEN entry on the port with that inode in `/proc/net/tcp` afterwards, since another binder's socket has another inode. Pin each repaired test red first under a binder thread that takes the freed port between the release and the old check, as the embedded port test's fixture does, then green with the seam; and show one product mutant per test that keeps the listener alive past the release (moved into a holder that outlives it) red with the seam, so a seam that always reports a drop cannot pass.

## Boundaries

`desktop/src-tauri/src/auth.rs` and `gateway.rs`, their tests, and the seam under `cfg(test)`. Not changed: the product's release of either listener.

## Acceptance

1. Both tests red first under a taking binder at the old check, green with the seam, twenty times each under the binder; one product mutant per test that keeps the listener alive past the release, red with the seam.
2. The desktop crate's suite green at the commit in the owning guest.
