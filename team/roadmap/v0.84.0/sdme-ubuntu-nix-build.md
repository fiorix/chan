# Disposable sdme Ubuntu Nix build

Status: REGISTERED for v0.84.0, implemented 2026-08-04, live guest validation pending.

## What

The release workflow needs a reproducible Nix build on hosts without Nix. The tracked `make nix-sdme-check` path runs the existing Nix build and smoke checks inside a disposable Ubuntu sdme guest instead of using the host root filesystem or an ad hoc stateful container.

## Contract

- The guest uses an explicitly selected imported Ubuntu rootfs and verifies `ID=ubuntu` before installing packages.
- The source checkout is mounted read-only at `/src`. One output directory is mounted writable at `/out`.
- The guest installs the declared Nix and smoke prerequisites, initializes a disposable local store, evaluates the repository flake, builds the selected package, and runs the existing package smoke.
- Guest build directories and smoke-test temporary files use `/var/tmp`.
- `NIX_PACKAGE` accepts `all`, `chan`, or `chan-desktop` and rejects every other value before creating a guest.
- The driver preserves the combined build log and status, propagates failures, attempts to remove its PID-scoped container on every exit path, and reports cleanup failures without replacing an earlier failure.
- The workflow does not bind host `/`, publish artifacts, push Cachix outputs, or replace the native CI and downstream publication paths.

## Acceptance

- The stubbed contract test rejects a missing explicit rootfs, every source/output overlap, and guest build state under `/tmp`.
- Shell syntax, shellcheck, workflow checks, build-matrix checks, and the Make dry run pass.
- A clean `NIX_PACKAGE=chan` run succeeds from an Ubuntu guest, preserves a clean source tree, and leaves no matching container.
