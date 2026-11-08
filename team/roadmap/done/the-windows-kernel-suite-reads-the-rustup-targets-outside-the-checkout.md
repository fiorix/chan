# The Windows kernel suite reads the rustup targets outside the checkout

Status: shipped in [v0.126.0](../../release/release-v0.126.0.md).

Record before the release: raised on 2026-11-07 from the v0.125.0 release's Windows kernel suite run; accepted by the owner for v0.126.0 at the v0.125.0 cut; built on `fix/windows-suite-preflight-toolchain` as `0ab2f131b`, merged into the integration branch, awaiting the release.

## What is there now

`scripts/e2e/wireguard-windows.sh` cross-builds the Windows binaries it drives when none are named: `zigbuild_ready` checks for `zig`, `cargo-zigbuild` and the `x86_64-pc-windows-gnu` target with `rustup target list --installed`, and the build then runs as `(cd "$REPO" && cargo zigbuild ...)`. The target check runs in the caller's working directory, where `rustup` selects the default toolchain, while the build runs inside the checkout, where `rust-toolchain.toml` pins the toolchain. When the driver starts outside the checkout (a systemd user unit starts in `$HOME`) and only the pinned toolchain has the target, the check reads the default toolchain's list, misses the target and refuses with "the x86_64-pc-windows-gnu target is not installed" though the build would succeed; the release's first run of the suite exited 2 on it, and its driver was given a `cd` into the worktree as a workaround.

## Desired contract

1. The preflight reads the toolchain the build uses: the target check runs inside `$REPO`, or names the toolchain the checkout pins, so a driver started from any directory gets the answer the build gets.
2. The refusal and its text stay for a target the pinned toolchain lacks.

## Boundaries

- The preflight function alone; the build commands and the suite's arms unchanged.

## Acceptance

1. A constructed red at the base: a default toolchain without the target beside the pinned one with it, the driver started from `$HOME`, exits 2 with the target refusal; the same setup at the fix passes the preflight and reaches the build.
2. The pinned toolchain without the target, from any directory, still refuses with the same text.
3. `make shell-check` and `make e2e-check` green at the tip.
