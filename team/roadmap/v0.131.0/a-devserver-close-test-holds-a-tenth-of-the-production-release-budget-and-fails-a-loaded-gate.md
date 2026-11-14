# A devserver close test holds a tenth of the production release budget and fails a loaded gate

Status: accepted for v0.131.0 by the owner on 2026-11-14 (`dev/v0131/decisions.md`, point 11: "as you recommend"), to be repaired at the round's opening; not started.

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
