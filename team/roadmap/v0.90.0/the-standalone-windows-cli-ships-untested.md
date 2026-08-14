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

## Shipped 2026-08-14, and what writing it found

`scripts/smoke-windows-cli.sh`, wired into `make ci-windows` after the release CLI is built. It drives `--version`, the `DETACHED_PROCESS` daemon spawn, and named-pipe discovery plus connect via `chan ps`, whose BY column is only resolvable by reading the holder record, enumerating `\\.\pipe\` for that pid, opening the socket and round-tripping an `Identify`. Verified on Windows 11: it passes against the release binary and fails at the first step against a broken one.

Two defects the gap was hiding, both fixed on the same branch:

- **The named-pipe discovery this item names could not run at all on Windows.** Its only two callers (`chan ps`, `chan close`) reach it through the workspace lock record, and a Windows `LockFileEx` holder made that record unreadable, so neither ever obtained a pid to look a socket up for. The smoke's headline check was un-writable until that was fixed -- it was first drafted against a namespace diff and only became a real discovery test afterwards. The defect is broader than this item (it also breaks the dead-holder steal and makes chan call its own lock foreign) and is fixed in `crates/chan-workspace/src/lock.rs`.
- **A debug-profile `chan.exe` died at startup on every invocation**, `--version` included: the MSVC linker's 1 MB main-thread stack is too small for the unoptimized `chan::run` future. Release fit under the ceiling, so the shipped artifact was never affected -- but the ceiling is a cliff one future-sized change away from reaching it, and this smoke's `--version` step is exactly the guard that would catch that. Fixed by running the CLI on a thread the binary sizes itself.

Neither would have surfaced without executing the binary on a Windows host, which is the point of the item.
