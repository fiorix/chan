# The Linux gate runs every test under a canonical temp directory

Status: raised during v0.101.0 on 2026-09-26 from the main CI run on landing 13 (run 36224062159: `make ci-macos` and `make ci-windows` red on `off_filters_windows_from_feed_but_preserves_them_for_on_restore`, every Linux job green) and the order that reproduced it on Linux (`dev/v0101-team/reports/report-Services-1.md` in the development tree). A source reading against `main` at `1566b06d0`, reproduced on Linux with `TMPDIR` pointing at a symlink.

## What was seen

The full gate and `make ci-linux` run the Rust suites under a temp directory whose spelling is already canonical, so a test that stores a temp path's raw spelling where production stores a canonical key passes on Linux and fails on macOS, where `/var` is a symlink to `/private/var`, and on Windows, where the runner's temp path has a short spelling. Landing 13 carried five such tests, one in chan-library and four in chan-server, green through the full gate and red on both other arms; chan-server's suite never ran there because cargo stopped at the red chan-library binary. On Linux, `TMPDIR=/tmp/link` with `/tmp/link -> /tmp/real` reproduces all five. With those five fixed to mint the root the registry stores, the same run exposes five more tests that pass only because the message they check contains the raw spelling as a substring of the canonical one (`/private/var/x` contains `/var/x`; `/tmp/real/x` does not contain `/tmp/link/x`), at `1566b06d0`:

- `host::tests::probe_reports_a_replaced_root_as_unavailable`, `crates/chan-library/src/host.rs:7070`, `reason.contains(&root.display().to_string())`, `#[cfg(unix)]`.
- `host::tests::mounting_a_replaced_root_reports_it_without_waiting_for_the_probe`, `host.rs:7185`, the same check, `#[cfg(unix)]`.
- `routes::library::devserver_route_tests::add_answers_a_replaced_root_with_the_row_the_list_reports`, `crates/chan-server/src/routes/library.rs:3246`, `#[cfg(unix)]`.
- `routes::library::devserver_route_tests::on_answers_the_row_the_list_reports_healthy_and_replaced_alike`, `library.rs:3320`, `#[cfg(unix)]`.
- `devserver::tests::a_registration_whose_mount_fails_mints_no_window`, `crates/chan-server/src/devserver.rs:6393`, `message.contains(&not_a_root.display().to_string())`, not cfg-gated.

## Desired contract

A canonical-spelling mismatch goes red on the Linux gate, not first on a macOS or Windows runner: the Rust suites of the crates that mint roots run at least once under a symlinked temp directory in the gate or in `make ci-linux`, and no test's assertion on a path in a message passes by substring luck.

## What to do

Make the five assertions exact: compare with the spelling the message carries (the canonical one), or name both spellings on purpose where the message may carry either. Then add the symlinked run: a gate step or a `ci-linux` job that re-runs `cargo test -p chan-library -p chan-server` with `TMPDIR` set to a symlink, taking its verdict from the status file, and decide whether it runs in `make pre-push` (two suite runs more, a few minutes on a warm target) or only in CI. Red first: the run itself on `1566b06d0` goes red on the five tests landing 13 carried; after the five exact assertions it goes green, and a re-injected raw-spelling mint goes red on the new step alone.

## Boundaries

The five tests above, the gate's Makefile targets or `.github/workflows/ci.yml`, and the step list in `.agents/skills/gate/SKILL.md`. No production change.
