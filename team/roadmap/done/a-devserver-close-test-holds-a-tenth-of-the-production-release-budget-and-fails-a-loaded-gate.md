# A devserver close test holds a tenth of the production release budget and fails a loaded gate

Status: shipped in [v0.131.0](../../release/release-v0.131.0.md): the devserver's lifecycle tests beside an abandoned filesystem open run every step they assert under production's 5 s release budget, and only the held mounted close keeps a 500 ms budget inside a 2 s bound, so a loaded gate host no longer turns the unmounted close red on a budget production never uses; production's budgets and close path are unchanged (`e6254f885` and `c90327022` on `v0131/winlint`, merged as `0dffa6bf1`). Read by matched 20-run series in a guest under a one-CPU cap with 16 test threads and 24 busy loops: the close arm red in 1 of 20 at the base and 0 of 20 at the tip, the removal and the mounted close 0 of 20 on both, both mounted-arm mutations red, and `cargo test -p chan-server` green in the gate guest. The series bound the red rate only to their 20 runs.

Record before the release: accepted for v0.131.0 by the owner on 2026-11-14 (`dev/v0131/decisions.md`, point 11: "as you recommend"), to be repaired at the round's opening; not started.

Record: a follow-up of v0.130.0 with no row (its release record, "Follow-ups", the load-sensitive tests): `devserver::tests::a_close_finishes_beside_an_abandoned_filesystem_open` was red once under `make pre-push` in that round's gate 3 (`close_workspace_for_root` unwrap: `Core(WorkspaceAlreadyOpen)`) and 30 of 30 alone in the gate guest at the same sha (`dev/v0130/status.md`, gate 3 and `flake-abandoned-open-1`). The decisions document for v0.131.0 sorted it as a row of its own, to repair at the opening because it protects every gate of the round; the owner took that recommendation.

## What is there now

Read at `f7457becb`.

- The test and its two siblings (`a_removal_finishes_beside_an_abandoned_filesystem_open`, `a_mounted_close_beside_an_abandoned_revalidation_answers_still_releasing`) share `lifecycle_beside_abandoned_root_call` (`crates/chan-server/src/devserver.rs`, from line 12297). It sets the host's shutdown release budget to 500 ms (`test_set_shutdown_release_budget`) for the whole run, where production uses `WORKSPACE_SHUTDOWN_RELEASE_TIMEOUT`, 5 s (`crates/chan-library/src/host.rs:57`).
- The comment beside the override says the budget is shortened so that a mounted close reaches its bound in half a second. The unmounted close and the removal run under the same 500 ms. By reading, a loaded host can push a release that production would wait for past that budget, and the close then answers `WorkspaceAlreadyOpen`, the gate's red; not traced.

## Desired contract

1. The two unmounted arms finish beside an abandoned filesystem open on a loaded host as they do on a quiet one: no budget shorter than production's bounds a step whose outcome the test asserts.
2. The mounted arm still proves that a close reaching its bound answers that the workspace is still releasing, with nothing mounted, and still finishes in well under the production bound.
3. Production's budgets and the close path are unchanged.

## Boundaries

- The test helper and the tests in `devserver.rs`, and the host's test-only budget setter if the repair needs a narrower form of it.
- Not here: the workspace app's vitest pool timing out under load, and the gate's ordering of `make web`, which the gate kit already handles.

## Acceptance

1. The repaired arms green under a CPU cap that turns the current test red: the red at the base and the green at the tip, each measured (`scripts/e2e/one-cpu-test-series.sh` or a capped loop in a guest), with the red-run rate stated.
2. A mutation that breaks what the mounted arm asserts (a close that waits past its bound, or answers released while a clone holds the workspace) still turns it red.
3. `cargo test -p chan-server` green in the gate.

## Built, 2026-11-14

The unmounted close and removal use the production release budget throughout the helper. Only the mounted close beside a held revalidation receives a 500 ms release budget, inside a 2 s outer bound. The helper restores `WORKSPACE_SHUTDOWN_RELEASE_TIMEOUT` before checking the outcome, releasing the held call, reopening or performing final cleanup. Its strict outcomes remain: unmounted close answers `NotFound`, removal answers `Completed`, and the held mounted close answers `WorkspaceAlreadyOpen` with no mounted prefix.

The host's test override is a replaceable `Mutex<Option<Duration>>`. Each dispatched teardown captures its budget, so restoration affects later operations without extending the held teardown's deadline. The override field, initialization, getter branch and setter retain their `cfg(any(test, feature = "test-util"))` boundaries. Production's 5 s release budget and close path are unchanged. A library-only `cargo check --locked -p chan-library --lib --no-default-features --message-format=json` returned 0 with exactly one `chan_library` compiler artifact, `profile.test=false` and `features=[]`; the normal/build feature tree contains no `test-util`. Evidence: `dev/v0131-team/evidence/Ops131/J27/static/prod-check.json`, `prod-check.stderr`, `prod-tree.txt` and `summary.txt`.

The measured baseline is `23ee2e97b3b5d1eb50ccc78a3a4cc90cf2bda660`; the repair is `e6254f88581de75d76251fe8a87315657043c502`. Each completed series ran the prebuilt server libtest as uid 1000 with 16 test threads, 24 competing busy loops, a 300 s per-run bound and host-verified `cpu.max 100000 100000`. The close arm was red in 1/20 baseline runs at the historical final cleanup, `Core(WorkspaceAlreadyOpen)`, and 0/20 repaired runs. Removal and mounted close were each 0/20 red on both versions. These are target rates, not a claim that the whole module was green under synthetic load. Raw baseline and repaired results, every run log, cap readings, source/binary records and instrument hashes are in `dev/v0131-team/evidence/Ops131/J24/` and `J29r2/`; the independent counts and raw-log hashes are in `evidence/Core131/closetest-fixed/matched-reading.json` under the same coordination root. The first tip series, `J29/`, stopped at run 12 with exit 124 and is preserved as incomplete, separate from the completed series. Its partial results are not pooled into the 20-run denominator.

Both mounted-arm mutations fail at their intended assertions. Suppressing the release-result guard makes the close answer `Ok(Completed)` and fails the outcome assertion; giving the held mounted operation the production 5 s budget under the unchanged 2 s outer bound fails the lifecycle-wait assertion. Each exact test exits 101; the unmodified test before and after exits 0. The driver restores the exact committed source hashes and finishes with no dirt. Evidence: `dev/v0131-team/evidence/Ops131/J27/mutations/` (`commands.jsonl`, each mutation's diff/log/status, restoration records and `result.json`).

On the committed repair, fmt, all-target clippy and rustdoc for chan, chan-library and chan-server, `make check-windows-test-target`, and Windows GNU whole-graph desktop clippy all return 0. Commands and statuses are in `dev/v0131-team/evidence/Ops131/J27/static/summary.txt`, with each step's full log and `.rc`. The gate guest's `cargo test --locked -p chan` passes 595 tests with 1 ignored, including the devserver verb mapping; chan-library passes 948 with 1 ignored. The full `cargo test --locked -p chan-server` rerun passes 2577 lib tests with 1 ignored, its one integration test, and doc-tests with no examples. All three lifecycle arms pass. Commands, source cleanliness and statuses are in `dev/v0131-gate/jobs/J27/summary.txt`; output/status pairs are `test-chan`, `test-chan-library` and `test-chan-server-r2` in that directory. The first server attempt (`test-chan-server`, rc 101) and the operator-stopped attempt (`test-chan-server-r2a-stopped`, rc 124) remain recorded. The successful rerun's queue isolation and host load are in `dev/v0131-team/evidence/Ops131/J27/alone.txt`; no load cause is inferred for the earlier failures.

The change is confined to test timing and the test-only override. No user-visible behavior or state owner changes, so the manual and subsystem design remain applicable. The integrated full-tree gate is separate from these scoped checks.
