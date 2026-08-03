# Release platform verification

Status: REGISTERED for v0.84.0, grounded 2026-08-03, specified 2026-08-03, ready to implement.

## What

`make pre-push` is Linux-only. It cannot see Windows or macOS breakage, so a change that compiles and passes every local check can still fail a platform CI lane or a release build. The release checklist does not currently require any pre-tag step that compiles for a non-Linux target on the owner's machine.

This item adds a reproducible Windows cross-check target and makes two platform verification steps mandatory before a GA tag.

## Verified current state

- `make pre-push` runs shellcheck, actionlint, the build matrix check, `cargo fmt --check`, clippy, tests, a `--no-default-features` build, the gateway lanes, the web checks, and `host-build-check`. Every one of them targets the host, which is Linux here.
- No Makefile target, `scripts/pre-push`, or workflow references `x86_64-pc-windows-gnu` or mingw. Windows is compiled only by `make ci-windows` on a `windows-latest` runner in `.github/workflows/ci.yml`.
- The release skill already makes the `publish=false` `release.yml` dispatch mandatory before GA and states that it is the only exercise of the macOS sign and notarize path. It does not name that dispatch as the only macOS compile available, and it has no Windows equivalent.
- `make aur-check`, `make copr-check`, and `make linux-chan-desktop` already run their toolchains in disposable `sdme` containers, so a container-hosted cross toolchain matches the established pattern rather than adding a new one.

## Evidence

- v0.83.0 declared `CHILD_SHUTDOWN_GRACE` unconditionally in `crates/chan-server/src/extensions.rs` while only the `cfg(unix)` `terminate_child` read it. Windows saw an unused constant and the `dead_code` lint under `-D warnings` failed `ci-windows` before `chan-server` finished compiling. It was fixed in `a04d63e1`, found only because an unrelated CI run was read by chance.
- v0.76.0 shipped a comparable platform break and needed a re-cut as v0.76.1.

Both classes are compile-time, so a cross-compile catches them without a Windows machine.

## Contract

### Windows cross-check target

Add `make windows-cross-check`:

- runs `RUSTFLAGS="-D warnings" cargo check --release -p chan --target x86_64-pc-windows-gnu`;
- runs the mingw toolchain inside a disposable `sdme` container, so any Linux host reproduces it with only `sdme` installed and nothing is added to the host toolchain; and
- is not part of `make pre-push`. It is a release-checklist step, not a per-push gate.

The target is advisory about linking: `cargo check` proves the crate graph compiles and lints clean for the target. It does not produce or smoke a Windows binary; `ci-windows` remains the authority for that.

### Mandatory pre-tag steps

The release cycle gains an explicit platform verification step before the GA tag, requiring both of:

1. `make windows-cross-check` green on the GA candidate tree; and
2. a `release.yml` dispatch with `publish=false`, which is the only macOS compile available off a macOS workstation.

Neither step is optional and neither substitutes for the other: the cross-check covers Windows compile and lint without a CI round trip, and the dry run covers macOS. A GA tag pushed without both is out of process.

The release skill must state plainly that `make pre-push` is Linux-only and cannot see Windows or macOS breakage, so a green local gate is not evidence about either platform.

## Implementation shape

- Add the `windows-cross-check` target to `Makefile`, following the `aur-check` shape: a small script under `packaging/` or `scripts/` invoked with `SDME`, rather than an inline container recipe.
- Register the new surface with `scripts/check-build-matrix.py` if that checker's contract covers it; if it does not, say so in the item rather than widening the checker.
- Update `.agents/skills/release/SKILL.md`: name the Linux-only limit of `make pre-push`, add the platform verification step to the cycle ahead of the GA close, and cross-reference it from the dry-run step.
- Update `.agents/skills/gate/SKILL.md` where it describes what the gate does and does not cover.

## Acceptance checks

- `make windows-cross-check` completes green on the current tree, and its runtime is recorded in the item.
- Reintroducing the v0.83.0 defect shape, an unconditional constant read only under `cfg(unix)`, makes the target fail with the `dead_code` diagnostic. Revert the injection afterwards.
- The target runs on a host with no mingw toolchain installed, proving the container carries it.
- `make pre-push` is unchanged in runtime and content.
- `shellcheck` and `actionlint` stay green over any new script.

## Boundaries

- No Windows binary production, linking guarantee, or smoke from the cross-check.
- No macOS cross-compile. The `publish=false` dispatch remains the only macOS coverage.
- No new per-push gate work; `make pre-push` does not gain a cross-compile.
- No change to `ci-windows` or the CI matrix.

## Implementation evidence

- Added `make windows-cross-check` and `scripts/windows-cross-check.sh`. The script creates a disposable Ubuntu `sdme` container, installs the pinned Rust toolchain plus MinGW in the guest, and runs the exact contract command with `RUSTFLAGS="-D warnings"`.
- The host target is dedicated to this check at `target/windows-cross-check` and is bound to `/cargo-target` in the guest. The guest receives `CARGO_TARGET_DIR=/cargo-target`, so it never uses the shared workspace target or its Cargo lock.
- The script records the Cargo status in the dedicated bind and validates it on the host. This is necessary because the local `sdme` command path can return zero when the guest command fails.
- `scripts/check-build-matrix.py` is unchanged. Its contract covers automatic shipped-build edges; this target is an explicitly manual release-checklist check, so registering it would widen the checker beyond its existing scope.
- The release skill now requires the Windows check and the existing macOS dry run before GA close. The gate skill states that `make pre-push` is host-native and Linux-only in the release environment.

## Validation evidence

- A cold `make windows-cross-check` completed green in `589.78s` (`9m49.78s`); Cargo reported `7m24s`. The dedicated target occupied `670M`. This meets the expected release-checklist scale of under ten minutes cold.
- A final clean check completed green in `118.10s` with a synthetic host `PATH` containing no `cargo`, `rustc`, `rustup`, `cc`, `gcc`, or `x86_64-w64-mingw32-gcc`. `SDME` was supplied by absolute path. This proves the host toolchain is not used.
- Temporarily removing only the `#[cfg(unix)]` guard from `CHILD_SHUTDOWN_GRACE` made the corrected target fail with status 101, surfaced by Make as exit 2. The output contained `constant CHILD_SHUTDOWN_GRACE is never used` and noted that `-D dead-code` was implied by `-D warnings`. The guard was restored immediately; `crates/chan-server/src/extensions.rs` is clean and the injection was never staged or committed.
- Direct ShellCheck 0.11.0 and `bash -n` passed for the new script. `scripts/lint-static.sh workflows` passed, including Actionlint. `python3 scripts/check-build-matrix.py` passed.
- The `pre-push` recipe extracted from `HEAD:Makefile` and from the worktree had the same SHA-256, `6b1b10835a3139119f08ad524a05930d37e24ef6431f1b4252eca7fd643823e5`. `make -n pre-push` contained neither `windows-cross-check` nor `x86_64-pc-windows-gnu`, proving its content and execution graph are unchanged. The lane did not run the full gate.
- The cross-check compiles and lints only. It does not link or smoke a Windows binary; `ci-windows` remains authoritative.
