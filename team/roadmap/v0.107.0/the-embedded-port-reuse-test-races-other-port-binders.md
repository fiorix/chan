# The embedded port reuse test races other port binders

Status: built on 2026-10-16 on the seat's branch; the sections Bounded retry under a concurrent binder 2026-10-16 and A missed take starts the attempt over 2026-10-16 hold the evidence; it closes at the GA as shipped.

Record before the release: raised by the lead after the v0.106.0 GA on 2026-10-15 from the `ci.yml` run 38766941193 on `main` (the tag's fast-forward push), red once in the AUR chan-desktop build's `check()` on `embedded::tests::embedded_port::saved_port_is_reused_when_free`; written down, not designed, not accepted for build; owner the desktop seat.

## What is open

The test (`desktop/src-tauri/src/embedded.rs`, the `embedded_port` module) binds an ephemeral port, drops the listener, then asks `bind_embedded_port(Some(port))` to reuse it and asserts no fallback. Between the drop and the rebind any other test of the same binary (the crate's tests run in parallel and several bind ports) or any process on the machine can take the port, and the product falls back as designed, so the assertion fails on timing alone. Seen once, on GitHub's runner inside makepkg's `check()`; 640 tests passed beside it; the same job was green in both `ci.yml` runs on the GA branch. A red in that `check()` aborts the AUR package build and, in the downstream workflow, the package's publication.

## What to do

Retry the drop-and-rebind on a fresh port a bounded number of times when another binder took it, or run the two port tests serially in their own binary; the design is the next round's. The pin is the test itself, green under a concurrent binder in the same process.

## Boundaries

`bind_embedded_port`'s fallback stays; the AUR `check()` keeps running the crate's tests.

## Acceptance

1. The test green twenty times in a loop with another thread binding and releasing ephemeral ports beside it.
2. The desktop crate's suite green in the AUR chan-desktop build's `check()` on GitHub's runner.

## Bounded retry under a concurrent binder 2026-10-16

Evidence paths below are under `dev/v0107-team/evidence/Hygiene107/portrace/` in the round's bus; each job's per-run logs are in its exported archive under `artifacts/`. All runs are in the hygiene guest (Linux, Ubuntu 24.04, 2 CPUs, 8 GiB) at `db5bcb237` with the repair applied, debug build, each test run alone by its exact name with `--test-threads=2`, every log showing its one test ran. The probes and mutants ran on the repair before one rustfmt line break (`final.patch`); the committed bytes (`final-v2.patch`) differ from it by whitespace alone (`v1-v2-whitespace.txt`, beside a positive control).

The shape is the item's first option, a bounded retry on a fresh port. The test frees an ephemeral port and asks `bind_embedded_port` to reuse it, up to eight attempts, each on a fresh port. An attempt whose port another binder took ends in the product's fallback, the product working as designed, and the next attempt starts over; a product that never reuses a free port falls back on all eight and fails the test. The second option, the two port tests serially in their own binary, is not taken: `chan-desktop` is a bin crate and `bind_embedded_port` is private to it, so a separate test binary needs a product change the boundary rules out, and running serially still leaves other processes on the machine (the AUR `check()` shares GitHub's runner) free to take the port. Ruled by the lead on 2026-10-16. `bind_embedded_port`, its fallback and `occupied_port_falls_back` are unchanged.

The fixture is `PortBinder`, a thread that binds and drops ephemeral loopback ports in a tight loop for the test's life (acceptance 1's binder) and, on request, takes one freed port and holds it until the thread stops. The test has it take the freed port of its first attempt, so every run loses an attempt to another binder, then requires that an attempt fell back and that a later attempt reused its port. An attempt whose take misses, because another binder holds the port at that instant, starts over on a fresh port before the product is asked, so only a taken port can end a run (the next section). The taking binder is the pin; the random loop beside it is load. Its rate, measured so nobody mistakes it for the pin (`probes.{log,status}`, rc 0): the base test's body run alone twenty times beside the random binder, 0 red of 20; the drop and rebind repeated 100,000 times in one process lost its port 0 times with no binder, 2 times with one binder thread and 7 times with two. The race is real in-process, and a random binder alone reaches it a few times in 100,000 attempts, so it shows no red in a loop of twenty.

Red first, the repair, and one mutant per guard:

- The base test's body under the taking binder: 20 red of 20, each at `assert!(!fell_back)`, the take confirmed in each run (`probes`).
- The repaired test under the same fixture: 20 green of 20; `occupied_port_falls_back` 20 green of 20 (`probes`).
- The retry removed (`REUSE_ATTEMPTS` 1): 20 red of 20 at "no attempt of 1 reused its freed port" (`mutant-m1-retry`).
- `bind_embedded_port` never reusing a free port (the saved port's listener dropped and the fallback taken): 20 red of 20 at "no attempt of 8 reused its freed port", so the retry does not mask a product that never reuses; `occupied_port_falls_back` 5 green of 5 under it (`mutant-m2-product`).
- The binder answering a take without holding the port: a first construction that drops the port after answering was red 19 of 20; in the one green run the product's rebind still met the held port and that attempt did fall back to it, which the guard reports truthfully (`mutant-m3-binder`). The faithful construction releases the port before it answers: 20 red of 20 at "the taken port sent its attempt to the fallback" (`mutant-m3b-binder-release`).

Each mutation was applied to the guest checkout, built, run and restored to the base file's hash before the next job (every job's `restore` step and `final_status=[]`); none is committed. Constructed controls of the driver: a selector naming no test exits 0 with no test run, which the driver counts apart from a pass (`probes`, `no_such_test`).

At the repair's tree, the same bytes as the commit's `embedded.rs` (`pretree2.{log,status}`, rc 0): `cargo fmt --check` exit 0; `cargo clippy --locked -p chan-desktop --all-targets -j2 -- -D warnings` with `RUSTFLAGS=-Dwarnings` exit 0; `cargo test --locked -p chan-desktop --all-targets -j2 -- --test-threads=2` exit 0, 642 passed, 0 failed, 0 ignored, the reuse test among them beside the crate's other port binders; then the reuse test alone 20 green of 20 and `occupied_port_falls_back` 20 green of 20. An earlier `pretree` stopped at `cargo fmt --check` on the one line break above (`pretree-fmt.log`, one hunk). The committed own-gate is in the hand-back.

Acceptance 1 is met: the test green twenty times in a loop with another thread binding and releasing ephemeral ports beside it, and red twenty of twenty under the same fixture before the repair. Acceptance 2, the desktop crate's suite in the AUR chan-desktop build's `check()` on GitHub's runner (`cargo test --frozen --release -p chan-desktop`), is the candidate's downstream dry run and the lead's; not run here.

Limits: Linux only and a debug build; the fixture uses std threads, channels and loopback sockets only, and its macOS, Windows and release-build runs are the CI's and the AUR's. Two other tests of the crate assert that a port the product released binds again (`auth.rs` `fail_listener_for_test`, `gateway.rs` `cancelled_slot_install_is_rechecked_and_drops_the_bound_port`) and share the race; a retry does not apply to them, and the lead raises them as a row of their own.

## A missed take starts the attempt over 2026-10-16

The review seat's read of the range (`reviews/review-Review107-24-portrace-range.md`, its P1) found that a take can miss: when another binder holds the freed port at the instant of the take and lets it go before the product's rebind, the take answers false, the product reuses the port, and the run ends with no port taken, red at the test's `assert!(taken)`. The review constructed it in a standalone crate holding `bind_embedded_port` and the fixture verbatim, red 20 of 20 with one ambient bind held across the first take. `PortBinder`'s own loop cannot cause it; another test thread or process can, at a rate of the order measured above. Ruled by the lead on 2026-10-16: an attempt whose take missed starts over on a fresh port before the product is asked.

The change: `reuse_a_freed_port` takes `impl FnMut(u16) -> bool` and asks the product only when the take answers true; a false starts the attempt over on a fresh port within the same eight attempts, and the count it returns is the attempts the product sent to its fallback. The reuse test's closure returns whether the binder holds a port; its `assert!(taken)`, which the helper makes always true, is removed, and `assert!(lost >= 1)` stays. A second test, `a_missed_take_starts_the_attempt_over`, pins the change: its first attempt holds the freed port with an ambient bind across the binder's take, which misses, and the bind drops before the attempt starts over; the test requires the miss and a fallback before the reuse. `bind_embedded_port` and `occupied_port_falls_back` are unchanged.

Evidence under `dev/v0107-team/evidence/Hygiene107/portrace/`, in the hygiene guest at `b8ccbc9af` with `p1.patch` applied, the commit's bytes (`p1-run-all.sh`; every job rc 0, each restored to the base file's hash after it):

- `p1-probes`: the reuse test 20 green of 20 under the binder, the new test 20 green of 20, `occupied_port_falls_back` 20 green of 20; `cargo fmt --check` exit 0, `cargo clippy --locked -p chan-desktop --all-targets -j2 -- -D warnings` exit 0, `cargo test --locked -p chan-desktop --all-targets -j2 -- --test-threads=2` exit 0, 643 passed, 0 failed, 0 ignored.
- The helper asking the product after a missed take (`mutant-p1-m4-missed-take`, the shape before this change): the new test red 20 of 20 at "the taken port sent its attempt to the fallback"; the reuse test 20 green, since its takes do not miss.
- The retry removed (`mutant-p1-m1-retry`): both tests red 20 of 20 at "no attempt of 1 reused its freed port".
- `bind_embedded_port` never reusing a free port (`mutant-p1-m2-product`): both tests red 20 of 20 at "no attempt of 8 reused its freed port".
- The binder releasing the port before it answers (`mutant-p1-m3b-binder-release`): the reuse test red 20 of 20 at "the taken port sent its attempt to the fallback".
