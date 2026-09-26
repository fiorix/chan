# The Linux gate has no Windows-target check for the crates the Windows arm compiles

Status: raised during v0.101.0 on 2026-09-26 by the lead from landing 17's main CI (`ef33cb0f3`, run 36270194197, `make ci-windows`), where `crates/chan-workspace`'s test build failed on a constant used only by a `#[cfg(unix)]` test; the full Linux gate was green on the same sha.

## Owner ruling

Accepted on 2026-09-26 as the lead recommended, as a CI-only step: `cargo clippy --tests --target x86_64-pc-windows-gnu` with warnings denied over the crates the Windows arm compiles, the crate list taken from the Makefile, in `make ci-linux` rather than `make pre-push`.

## What was seen

The Windows arm compiles some crates' tests under `-D warnings` (`check-chan-workspace-windows-tests` and the named chan-server tests in the Makefile). A test-module constant, helper or import whose only user is a `#[cfg(unix)]` test is dead code there and reds the arm, while the Linux gate, which runs the same crates' tests natively, sees the item used. The Unix-only stall tests (`root_stall`) make this shape common: the constant that failed belongs to the writer-lock probe's tests, and the desktop and devserver tests for a hung root have the same shape.

## Desired contract

A Unix-only test that strands a shared item goes red on the Linux gate, not first on the Windows runner: the crates the Windows arm compiles in tests are checked for the `x86_64-pc-windows-gnu` target with warnings denied, in the gate or in `make ci-linux`.

## What to do

The build container already carries the `x86_64-pc-windows-gnu` target and `x86_64-w64-mingw32-gcc`. Add a gate step or a `ci-linux` job that runs `cargo clippy --tests --target x86_64-pc-windows-gnu` (or `cargo check --tests` where clippy refuses the target) with `-D warnings` over the crates the Windows arm compiles, taking the crate list from the Makefile so the two cannot drift; decide whether it runs in `make pre-push` (one more check build, a few minutes on a warm target) or only in CI, as the canonical-tmpdir item decided for its symlinked run. Red first: the step on `ef33cb0f3` fails on exactly that error; at `5962b0637`, which compiles the constant on Unix only, it passes; a re-stranded item goes red on the new step alone.

## Boundaries

`Makefile`, `.github/workflows/ci.yml`, and the gate skill's step list; no test changes beyond the reproduction.
