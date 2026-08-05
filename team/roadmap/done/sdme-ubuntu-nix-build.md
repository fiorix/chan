# Disposable sdme Ubuntu Nix build

Status: SHIPPED in [v0.84.0](../../release/release-v0.84.0.md).

## What

The release workflow needs a reproducible Nix build on hosts without Nix. The tracked `make nix-sdme-check` path runs the existing Nix build and smoke checks inside a disposable Ubuntu sdme guest instead of using the host root filesystem or an ad hoc stateful container.

## Contract

- The guest uses an explicitly selected imported Ubuntu rootfs and verifies `ID=ubuntu` before installing packages.
- A snapshot of the indexed working-tree files is created under `/var/tmp` and mounted read-only at `/src`. It preserves modified tracked content, omits tracked deletions, and excludes Git metadata, ignored files, and untracked files. One output directory is mounted writable at `/out`.
- The guest installs the declared Nix and smoke prerequisites, initializes a disposable local store, evaluates the repository flake, builds the selected package, and runs the existing package smoke.
- Guest build directories and smoke-test temporary files use protected paths below `/var/tmp`. The disposable guest narrows `/var/tmp` to mode 0755 without changing the host path.
- `NIX_PACKAGE` accepts `all`, `chan`, or `chan-desktop` and rejects every other value before creating a guest.
- The driver preserves the combined build log and status, propagates failures, attempts to remove its PID-scoped container and source snapshot on every exit path, and reports cleanup failures without replacing an earlier failure.
- The workflow does not bind host `/`, publish artifacts, push Cachix outputs, or replace the native CI and downstream publication paths.

## Acceptance

- The stubbed contract test rejects a missing explicit rootfs, every source/output overlap, and guest build state under `/tmp`. It proves tracked modifications are present while tracked deletions, Git metadata, ignored files, and untracked files are absent.
- Shell syntax, shellcheck, workflow checks, build-matrix checks, and the Make dry run pass.
- A clean `NIX_PACKAGE=chan` run succeeds from an Ubuntu guest, preserves a clean source tree, and leaves no matching container.

## Evidence

- The stub contract passed after exercising rootfs selection, tracked-source snapshot semantics, protected `/var/tmp` paths, failure propagation, cleanup precedence, and signal cleanup. Shell syntax, shellcheck, build-matrix, Make dry-run, and diff checks also passed.
- `TMPDIR=/var/tmp make nix-sdme-check NIX_PACKAGE=chan NIX_SDME_ROOTFS=ubuntu NIX_SDME_OUT=/var/tmp/chan-v0840-nix-sdme SDME='sudo -n sdme'` completed with status 0 on 2026-08-05 from commit `dd16f198`.
- The live guest identified itself as Ubuntu 26.04, initialized a local Nix 2.34.3 store, evaluated every declared system, built `chan`, and reported both `built devserver smoke: PASS` and `Nix package smoke: PASS`.
- The source tree stayed clean. The PID-scoped guest and tracked-source snapshot were absent after cleanup.
- `TMPDIR=/var/tmp CARGO_TARGET_DIR=/var/tmp/chan-v0840-release-cut/target CARGO_INCREMENTAL=0 npm_config_cache=/var/tmp/chan-v0840-npm-cache make pre-push` completed with status 0 on commit `fe450858` on 2026-08-05. Its static sdme contract, shell, workflow, and build-matrix checks passed with the rest of the integrated release gate.
