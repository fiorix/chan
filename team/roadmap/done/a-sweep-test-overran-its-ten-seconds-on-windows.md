# A test of chan-library ran out its own ten-second bound once on a hosted Windows runner

Status: shipped in [v0.101.0](../../release/release-v0.101.0.md).

Record before the release: accepted for v0.101.0 by the owner on 2026-09-29; raised for a decision on 2026-09-28 by the lead, from main CI's run for landing 31, whose `make ci-windows` job failed on this test on its first attempt and passed on its second, on the same commit (`dev/v0101-team/evidence/int/ci-36443211816/README.md` in the development tree, with the log's excerpt beside it). Read in the job's log and in code at `ada0ecc4c`; not reproduced on the development box.

## Owner ruling

Accepted on 2026-09-29 for v0.101.0. The owner accepted in one answer every recommendation the lead had put to them that day, and with that answer closed v0.101.0's intake under one rule: a raised item enters v0.101.0 only when it loses a user's data or weakens security and its fix is small and local, a test-only or infrastructure item only when it makes the release gate or a release job unreliable, and an item whose fix changes a contract or reopens excluded scope, or whose fault is a wrong state with a rare trigger, goes to v0.102.0. This item enters as a test-only item that makes a release job unreliable: the test was red once in main CI's Windows job on unchanged code, and a false red on a release's run costs more than the change. The shape is the one the lead recommended when the item was raised: the test's bound starts at the root check, or is larger, with what each costs.

## What was seen

**The test.** `host::tests::a_mount_built_before_the_last_sweep_shuts_its_runtime_down` wraps its whole body in a ten-second `tokio::time::timeout` on the real clock (`crates/chan-library/src/host.rs:6236-6269`, the bound at `:6241`, its `unwrap` at `:6268`). The body builds a host over a registered workspace, starts a mount, waits on a probe until the mount enters its root check, runs the host's last shutdown sweep, releases the check, and asserts that the mount is refused and its runtime shut down (`:6242-6265`). Before its root check the mount resolves the root's key, builds its tenant and takes the mount permit (`open_workspace_with_permit`, `:1568-1635`); at the check the probe sends `entered` and waits at most three seconds for the release (`:1649-1656`).

**The run.** Main CI run 36443211816 on `90854b079`, job 108998746252, attempt 1: chan-library's lib suite passed 408 tests and failed this one. Its thread panicked at the timeout's `unwrap` with `Elapsed(())`: the ten seconds had run out. A blocking worker panicked at the probe's `entered.send(()).unwrap()`: the mount reached its root check after the test had given up. The job run again on the same commit was green (job 109017532459). Neither the test nor the path it drives changed in that landing, and the test was green on Windows in the main CI runs of the four landings before; nor have they changed from that commit to this tip, whose changes to `host.rs` are the fd-store import, the lookup it shares with the window feed and their tests (the lines above are the same at both but for the test's, `:6151-6179` there).

**Here.** On the test binary built at `fe2708e45`, whose path is the same, the test passed 200 runs as it is and 200 pinned to one CPU, and the whole suite passed 10 times on one CPU with 8 test threads; alone the test takes about 30 ms (the README). What took ten seconds on the runner before the root check is not shown.

[a-mount-retry-test-races-a-wall-clock](a-mount-retry-test-races-a-wall-clock.md), which has landed, gave another test of the same file the same kind of repair; this is a different test.

## Desired contract

The test fails when the path it drives hangs, and not when a runner is slow before that path's root check.

## What to do

The lead's two ways, each with its cost:

- **Start the bound at the root check:** await the probe's `entered` with no bound of the test's own, or a much larger one, and keep ten seconds for the sweep, the release and the refusal. It keeps what the bound catches from the root check on; a hang in the key's hop, the tenant's build or the permit then holds the test until the harness's own limit, which `cargo test` does not set (inferred) and the CI job's timeout does.
- **A larger bound on the whole body:** the smallest change; a hang anywhere in the body then takes that long to fail, and how large is enough for a hosted runner is not measured.

Either way the probe's own three seconds for the release are unchanged.

## Boundaries

The test and its helpers in `crates/chan-library/src/host.rs`. No production code.

## Acceptance

1. The test's bound starts at the root check or is larger, with a comment that says why.
2. The test passes 200 runs as it is and 200 pinned to one CPU, and `make ci-windows`'s steps for chan-library pass.

## What shipped

The build is on the integration branch and not on `main`, in ranges the lead accepted, with the combined gate green on Linux at the integration's tip. This record was written on 2026-10-02 from a reading of the code at that tip; what the acceptance of its range found beyond the code is in the round's records and was not read for it.

A test-only change: in `a_mount_built_before_the_last_sweep_shuts_its_runtime_down` (`crates/chan-library/src/host.rs`) the ten-second bound starts once the root check holds the publication and covers the shutdown sweep, the release and the assertions after it, with the host's setup, the probe and the spawned mount outside it. So a hang before the root check waits for the job's own limit, the cost the item states. The test is in the tree; the runs the second acceptance point asks for were recorded in the round and are not reproduced by the tree; no native Windows run has been made here. No changelog line, the change being a test's.
