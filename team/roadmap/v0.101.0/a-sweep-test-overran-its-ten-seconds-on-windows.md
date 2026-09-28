# A test of chan-library ran out its own ten-second bound once on a hosted Windows runner

Status: raised for a decision on 2026-09-28 by the lead, from main CI's run for landing 31, whose `make ci-windows` job failed on this test on its first attempt and passed on its second, on the same commit (`dev/v0101-team/evidence/int/ci-36443211816/README.md` in the development tree, with the log's excerpt beside it). Read in the job's log and in code at `ada0ecc4c`; not reproduced on the development box. Recommendation, the lead's: accept for v0.101.0 as a small order: the test's bound starts at the root check, or is larger, with what each costs.

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
