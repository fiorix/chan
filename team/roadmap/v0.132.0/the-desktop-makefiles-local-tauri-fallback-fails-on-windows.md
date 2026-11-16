# The desktop Makefile's local tauri fallback fails on Windows

Status: accepted for v0.132.0 by the owner on 2026-11-16 ("Take all four recommendations"); not started.

Record: met by v0.131.0's Windows test VM package build (job J234, 2026-11-16T06:00Z): `make` installed tauri-cli 2.12.4 under the tree and then ended with `error: no such command: tauri`. The team's later runs pinned the tool directory in their own harness by a native PATH prepend; CI installs tauri-cli globally and never takes this path.

## What is there now

`desktop/Makefile` runs tauri through `TAURI := PATH="$(TAURI_CLI_ROOT)/bin:$$PATH" cargo tauri`, with `TAURI_CLI_ROOT` an absolute path. On Windows that path begins with a drive letter, so the colon-separated list the recipe builds holds `C:/...`, and cargo cannot find the locally installed `cargo-tauri`. A developer building the desktop on Windows without a global tauri-cli meets it.

## Desired contract

1. `make` in `desktop/` on Windows finds the tauri-cli it installed under `.build-tools/tauri-cli` without a global install.
2. Linux and macOS behave as today, and the pinned tool still outranks a stale one, as the Makefile's comment requires.

## Acceptance

1. A native Windows run of the desktop package target with no global tauri-cli: the local tool is found and the package builds.
2. The same target on Linux unchanged (the scoped gate).
