# The standalone Windows CLI ships untested

Status: REGISTERED 2026-08-12, promoted from a v0.89.0 draft after the close triage confirmed the gap and corrected the draft's overstatement. Small CI-hygiene item.

## What

chan ships on Windows twice: `release.yml` builds, Authenticode-signs, and publishes `chan-x86_64-pc-windows-msvc.zip` as the standalone CLI the install page resolves, and the NSIS installer bundles the same `chan.exe` as a desktop resource. The `ci-windows` arm was scoped to chan-library and chan-desktop this round, so the `chan` crate's tests run on no CI arm on Windows. Most of the crate's logic is covered on Linux and macOS through injectable pure cores (`release_target_for`, `parse_cli_with_arg0`, `control_socket_for_pid_in_dirs`), so the coverage gap is modest, not a void. What runs on no arm is the two thin Windows syscall wrappers: the `DETACHED_PROCESS` daemon spawn and the named-pipe control-socket connect under `\\.\pipe\`.

## Grounding

Verified at v0.89.0 HEAD by the close triage:
- Publication: `.github/workflows/release.yml` builds `-p chan`, signs `target/release/chan.exe`, packs `chan-x86_64-pc-windows-msvc.zip`, and the marketing metadata and verifier require that asset.
- The Windows-only code exists: named-pipe discovery under `\\.\pipe\` (`crates/chan/src/lib.rs`), `DETACHED_PROCESS` spawn (`crates/chan/src/devserver_daemon.rs`), the ARGV0 shim, and the `current_target` Windows refusal.
- The refusal logic is actually the best-covered path (ungated `test_release_target_for_inactive_public_artifacts` runs on every arm); the draft's claim that it is covered nowhere was wrong and is corrected here.

## Contract

A `chan.exe` smoke on the already-building Windows CI arm, exercising the two syscall paths end to end: `chan --version`, a devserver start, and named-pipe control-socket discovery. This is a few lines and needs no full chan-crate Windows test port, which would mostly re-run logic already green on Linux. It is distinct from the deferred full-suite Windows port (a separate held draft).

## Acceptance

- A `chan.exe` smoke runs on the `ci-windows` arm and exercises version, devserver start, and named-pipe discovery.
- The recorded rationale names the two syscall paths as the residual the smoke covers, without reopening the full-suite port.
