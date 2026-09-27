# The Linux gate runs every test under a canonical temp directory

Status: raised during v0.101.0 on 2026-09-26 from the main CI run on landing 13 (run 36224062159: `make ci-macos` and `make ci-windows` red on `off_filters_windows_from_feed_but_preserves_them_for_on_restore`, every Linux job green) and the order that reproduced it on Linux (`dev/v0101-team/reports/report-Services-1.md` in the development tree). A source reading against `main` at `1566b06d0`, reproduced on Linux with `TMPDIR` pointing at a symlink.

## Owner ruling

Accepted on 2026-09-26 as the lead recommended: the five assertions become exact, and a symlinked-`TMPDIR` run of the chan-library and chan-server suites is added as a `ci-linux` job only, so `make pre-push` does not grow; the landing record says which arm proves which crate. The services lane's.

## What was seen

The full gate and `make ci-linux` run the Rust suites under a temp directory whose spelling is already canonical, so a test that stores a temp path's raw spelling where production stores a canonical key passes on Linux and fails on macOS, where `/var` is a symlink to `/private/var`, and on Windows, where the runner's temp path most likely has a short spelling (the log prints no path). Landing 13 carried five such tests, one in chan-library and four in chan-server, green through the full gate. The chan-library test was red on both other arms. The four chan-server tests were never run there: on macOS cargo stopped at the red chan-library binary, and the Windows arm runs chan-server only through the six tests named in `CHAN_SERVER_WINDOWS_TESTS` in the Makefile, so nothing proves them on Windows at all. On Linux, `TMPDIR=/tmp/link` with `/tmp/link -> /tmp/real` reproduces all five. With those five fixed to mint the root the registry stores, the same run exposes five more tests that pass only because the message they check contains the raw spelling as a substring of the canonical one (`/private/var/x` contains `/var/x`; `/tmp/real/x` does not contain `/tmp/link/x`), at `1566b06d0`:

- `host::tests::probe_reports_a_replaced_root_as_unavailable`, `crates/chan-library/src/host.rs:7071`, `reason.contains(&root.display().to_string())`, `#[cfg(unix)]`.
- `host::tests::mounting_a_replaced_root_reports_it_without_waiting_for_the_probe`, `host.rs:7186`, the same check, `#[cfg(unix)]`.
- `routes::library::devserver_route_tests::add_answers_a_replaced_root_with_the_row_the_list_reports`, `crates/chan-server/src/routes/library.rs:3247`, `#[cfg(unix)]`.
- `routes::library::devserver_route_tests::on_answers_the_row_the_list_reports_healthy_and_replaced_alike`, `library.rs:3321`, `#[cfg(unix)]`.
- `devserver::tests::a_registration_whose_mount_fails_mints_no_window`, `crates/chan-server/src/devserver.rs:6394`, `message.contains(&not_a_root.display().to_string())`, not cfg-gated, and not run by the Windows arm either; under a short-name temp path it would be red there, since the refusal names the registry row's long-name root.

## Desired contract

A canonical-spelling mismatch goes red on the Linux gate, not first on a macOS or Windows runner: the Rust suites of the crates that mint roots run at least once under a symlinked temp directory in the gate or in `make ci-linux`, no test's assertion on a path in a message passes by substring luck, and the landing record says which arm proves which crate (the Windows arm runs chan-server through a named list, not in full).

## What to do

Make the five assertions exact: compare with the spelling the message carries (the canonical one), or name both spellings on purpose where the message may carry either. Then add the symlinked run: a gate step or a `ci-linux` job that re-runs `cargo test -p chan-library -p chan-server` with `TMPDIR` set to a symlink, taking its verdict from the status file, and decide whether it runs in `make pre-push` (two suite runs more, a few minutes on a warm target) or only in CI. Red first: the run itself on `1566b06d0` goes red on the five tests landing 13 carried; after the five exact assertions it goes green, and a re-injected raw-spelling mint goes red on the new step alone.

## Boundaries

The five tests above, the gate's Makefile targets or `.github/workflows/ci.yml`, and the step list in `.agents/skills/gate/SKILL.md`. No production change.

## What shipped

Landed on 2026-09-27 as a step of `make ci-linux`, as the owner ruled, so `make pre-push` does not grow. The lead verified the range, and it had no independent review: it changes no production code. Lines are cited at `f55f7f509`.

- **What `make ci-linux` runs beyond `make pre-push`.** `ci-linux` keeps `pre-push` as its prerequisite and then runs two Make targets, `test-symlink-tmpdir` and then `check-windows-test-target` (`Makefile:391-394`); the second is [the-linux-gate-has-no-windows-target-check](the-linux-gate-has-no-windows-target-check.md)'s. `make pre-push` runs neither (`Makefile:310-367`), and the git hook runs `make pre-push` and nothing else (`scripts/pre-push:11`), so a push from a developer's tree runs neither step. CI runs both in the two jobs that run `make ci-linux`: `linux` in `.github/workflows/ci.yml`, on pushes to `main` and on pull requests (`ci.yml:15-26`, `:79`), and `linux-validate` in `.github/workflows/release.yml`, on a `v*` tag and on a dispatched release run (`release.yml:15-19`, `:184`). What the two jobs install for the second step is in its item; this one needs nothing new.
- **The symlinked run fails closed.** `test-symlink-tmpdir` makes a directory under `/tmp` with `mktemp`, and beside it a symlink to it with the same name and `-l` after it, then runs `cargo test -p chan-library -p chan-server --no-fail-fast` with `TMPDIR` set to the link and warnings denied (`Makefile:396-408`). Before cargo starts, it refuses with "error: symlinked TMPDIR must resolve to another directory" unless the link was made, is a symlink, and resolves to that directory under a different spelling (`:402-407`), and it removes the link and the directory when it exits (`:400`). The lane's report ran the recipe with an `ln` that made no link and saw that refusal with cargo not started (`dev/v0101-team/reports/report-Services-16.md` in the development tree).

The five assertions compared a message with a temp path's raw spelling by substring (What was seen). Each now pins the root between the words that surround it in the message, spelled as the registry stores it: a new registry row's root is the canonical form of the path it was added under (`crates/chan-workspace/src/registry.rs:393-394`, computed by `canonical_form` at `crates/chan-workspace/src/library.rs:556-564`, which is `paths::canonicalize_normalized`, `registry.rs:437-438`).

- `crates/chan-library/src/host.rs`: `probe_reports_a_replaced_root_as_unavailable` (`:8196-8205`) and `mounting_a_replaced_root_reports_it_without_waiting_for_the_probe` (`:8317-8327`) require the degraded row's reason to start with `workspace root does not exist: <root>;`, the root spelled by `chan_workspace::paths::canonicalize_normalized`.
- `crates/chan-server/src/routes/library.rs`: `add_answers_a_replaced_root_with_the_row_the_list_reports` (`:3278-3285`) and `on_answers_the_row_the_list_reports_healthy_and_replaced_alike` (`:3353-3360`) require the same start, with the root the row itself lists in its `path`, which is the registry row's root (`local_launcher_row`, `:704-707`).
- `crates/chan-server/src/devserver.rs`: `a_registration_whose_mount_fails_mints_no_window` (`:7772-7783`) requires the refusal to end with `): <root>`, the root spelled as in the host tests.

What the symlinked run proves about them: in a plain Linux temp directory a path's raw and canonical spellings are one string, so an exact assertion and one that passes by luck both pass. Through the link they differ, the raw one carrying `-l` after the directory's name (`Makefile:399`), and neither contains the other, so each of the five passes only if the message carries the stored spelling where the assertion expects it. The lane's report ran the symlinked suites on the code before the change: red on exactly these five, two in chan-library and three in chan-server, and on no other test. After the change they are green, and with `off_filters_windows_from_feed_but_preserves_them_for_on_restore` (`host.rs:5615`), the test whose red on macOS and Windows raised this item, put back to mint its window under the raw spelling, the symlinked run went red on that one test while both plain suites passed. On a warm target the step took 35 seconds and compiled nothing; a cold runner is not measured.

What it does not show: the run exercises one symlink's spelling on Linux, not the `/private/var` spelling of macOS or a Windows temp path, and it runs chan-library and chan-server only. The devserver test is still not among the six chan-server tests the Windows arm runs (`Makefile:41-47`), so no run shows it under a Windows temp path. The code map the order was written from read every assertion in the four crates' tests whose needle is built from a temp path, 42 of them, and found no sixth that passes by substring (`dev/v0101-team/int22-docs/codemaps/services-gate-arms.md` in the development tree); that is a reading, not a run.

Which arm proves which crate, for the four crates the Windows arm compiles in tests. "Linux, macOS" is `cargo test --all-targets` in `make pre-push` and in `make ci-macos` (`Makefile:341`, `:440`); "symlinked" is the run above; "Windows" is `make ci-windows` on the Windows runner (`Makefile:443-493`, `ci.yml:125-163`); "Windows target" is `check-windows-test-target`, which compiles and lints for `x86_64-pc-windows-gnu` on Linux and runs nothing.

| crate, tests | Linux, macOS | symlinked | Windows | Windows target |
| --- | --- | --- | --- | --- |
| chan-library, lib | run | run | run | linted |
| chan-desktop, binary | run | not run | run | linted |
| chan-server, lib | run | run | 6 named run | linted |
| chan-workspace, lib | run | not run | 8 named run | linted |
| chan-workspace, tests/ | run | not run | not compiled | the only check |

The Windows arm runs chan-library's and chan-desktop's tests in full (`Makefile:486-487`). For chan-server and chan-workspace it compiles the crate's whole lib test binary, with warnings denied, and runs only the tests named in `CHAN_SERVER_WINDOWS_TESTS` and `CHAN_WORKSPACE_WINDOWS_TESTS` (`Makefile:41-59`, run at `:495-545`): a Windows-only compile error in any of their lib tests reds it, and a test it does not name never runs on Windows. It does not compile chan-workspace's eleven integration tests (`crates/chan-workspace/tests/`), for which the Windows-target step is the only check for Windows. No clippy runs on the Windows arm (`Makefile:443-493`, `desktop/Makefile:98-108`), so the Windows-target step is the only lint for Windows on every row.

The gate skill says what `make ci-linux` adds, with the same coverage (`.agents/skills/gate/SKILL.md:50-66`); `CONTRIBUTING.md` and `.agents/README.md` say the hook runs `make pre-push`, the shared gate Linux CI extends (`CONTRIBUTING.md:43`, `.agents/README.md:40`); and the container recipe that mirrors CI installs what the Windows-target step needs before it runs `make ci-linux` (`docs/contributing/linux-and-macos.md:46`, `:59-73`).

Not yet observed: no GitHub runner has run the step. Whether the runner's `/tmp` passes the link's guard, which refuses if `/tmp` is itself a symlink because the link then resolves to a spelling other than the one `mktemp` gave (`Makefile:399`, `:402-404`), and what the step costs cold in time and in the Rust cache `main` saves (`ci.yml:47-52`), are for main CI's first run after this landing to show.
