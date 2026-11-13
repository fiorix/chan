# The Windows-target clippy of chan-desktop's whole dependency graph is red in the chan crate

Status: accepted for v0.131.0 by the owner on 2026-11-13; not started.

Record: met by the Windows 11 VM run of every candidate from v0.126.0 to v0.129.0 and recorded in each release record without a row ([v0.126.0](../../release/release-v0.126.0.md), [v0.127.0](../../release/release-v0.127.0.md), [v0.128.0](../../release/release-v0.128.0.md), [v0.129.0](../../release/release-v0.129.0.md)). In v0.129.0 a worker met it at the round's base on Linux for the Windows target (`dev/v0129/status.md`, 2026-11-12, and `dev/v0129/evidence/termfix/runs/135846-base-windows-deps/`), and the VM met it again on the release commit `ed89b7f7f` (`dev/v0129/evidence/winvm/ed89b7f7f-05-clippy/`, rc 101; the `--no-deps` form, `05b-clippy-nodeps/`, rc 0). The integrator's follow-up candidate was to box the large `Err` variant (`dev/v0129/status.md`, 2026-11-13T18:21Z; `dev/v0129/handoff-downstream.md`). At v0.130.0's planning the owner placed the later group of rows, this one among them, in v0.131.0: "yes v0.131" (`dev/v0130/status.md`). Contract line 2, that the gate's Windows-target lint reach the chan crate, was added by the row's drafter; the owner kept it ("keep it").

## What is there now

Read at `342dbe791`:

- `devserver_verb` (`crates/chan/src/devserver.rs:96-113`) splits a `chan devserver` subcommand and hands a client-side one back whole as its error: `Result<(DevserverServeArgs, DevserverVerb), DevserverAction>`. Seven variants of `DevserverAction` (`crates/chan/src/cli.rs:352`) carry `DevserverServeArgs` by value. Built for Windows, clippy 1.95.0 counts six of them at 128 bytes and `Status` at 129, at or over its default `large-error-threshold` of 128, and `clippy::result_large_err` fires at `devserver.rs:98`. Built for Linux it is silent. By reading, the difference is `tunnel_wireguard: Option<PathBuf>`, wider on Windows, where an OS string carries a flag beside its bytes; not measured.
- Red: `cargo clippy -p chan-desktop --all-targets -- -D warnings` natively on the Windows VM, and `cargo clippy --locked --all-targets --target x86_64-pc-windows-gnu -p chan-desktop -- -D warnings` on Linux. Both stop at the chan crate, so neither has linted what depends on it. The desktop's dev-loop lint, `make -C desktop lint` (`desktop/Makefile:189-190`, listed in `.agents/desktop.md`), is that form, so by reading it is red when run on Windows.
- Green: every form with `--no-deps`, which lints the named crates alone. Nothing in the gate or CI lints the chan crate for Windows: `make check-windows-test-target` (`Makefile:514-540`) lints the crates of `CHAN_WINDOWS_TEST_CRATES` (`Makefile:40`, which does not name chan) with `--no-deps`; `make windows-cross-check` runs `cargo check` on chan for the Windows target (`scripts/windows-cross-check.sh:182`), not clippy; `make ci-windows` runs no clippy.
- The repository answers this lint by boxing elsewhere: chan-server's handlers box an axum `Response` (`crates/chan-server/src/routes/library.rs:2175`), and the desktop's shutdown action boxes the updater's object ([the Windows-target check row](../done/the-linux-gate-has-no-windows-target-check.md)).

## Desired contract

1. Clippy with warnings denied over chan-desktop's whole dependency graph is green for the Windows target, natively and as `x86_64-pc-windows-gnu`. `devserver_verb`'s error is small on every target, by boxing what is large or by a smaller type for the client-side verbs, not by allowing the lint.
2. The Windows-target lint the gate runs reaches the chan crate's own code, so a finding only that target sees there is red in the gate, not first on the Windows VM.
3. `chan devserver`'s verbs, flags and dispatch are unchanged.

## Boundaries

- `devserver_verb`, its two callers and the type it returns (`crates/chan/src/devserver.rs`, `cli.rs`); the Windows-target lint step (`check-windows-test-target` in the `Makefile`) and its description in `.agents/skills/gate/SKILL.md`.
- A further finding the whole-graph form meets once it gets past the chan crate is in scope too; none is known, since that form has never got past it.
- Not here: running chan's own tests on Windows.

## Acceptance

1. In a Linux guest, `RUSTFLAGS="-D warnings" cargo clippy --locked --all-targets --target x86_64-pc-windows-gnu -p chan-desktop -- -D warnings` rc 0; rc 101 on `result_large_err` at `devserver.rs:98` on the code without the change.
2. The gate's Windows-target lint step, reaching the chan crate, red on the code without the change on that one finding and green with it.
3. `cargo test -p chan` green, `devserver_verb_maps_every_server_side_subcommand` among them; the Linux clippy and rustdoc steps green.
4. On the Windows VM (`dev/vm/windows.sh`) at the candidate, `cargo clippy -p chan-desktop --all-targets -- -D warnings`, the form without `--no-deps`, rc 0.
