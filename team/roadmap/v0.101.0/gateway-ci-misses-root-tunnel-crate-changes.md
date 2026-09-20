# Gateway CI does not run when the root tunnel crates change

Status: raised for v0.101.0 on the owner's instruction, 2026-09-20, from the development archive's pre-v0.68 backlog. The claims are a source reading against `main` at `fa0df75ad`.

## What was seen

`gateway/Cargo.toml` consumes three crates of the root workspace by path: `chan-tunnel-client`, `chan-tunnel-proto` and `chan-tunnel-server`. `.github/workflows/gateway-ci.yml` triggers only on `gateway/**`, the `Makefile`, `rust-toolchain.toml`, the web lock and `package.json`, the profile package, the gateway Docker files and the workflow itself. A change under `crates/chan-tunnel-*` therefore runs the main CI, which never builds the gateway, and skips the one workflow that would compile, lint and test the gateway against it. A break shows up on the next unrelated push under `gateway/`, attributed to the wrong commit. Locally `make pre-push` does build the gateway, on Linux only.

The same backlog entry names a second gap that still holds: `make gateway-build` passes no `--locked`, and `release.yml` calls it with `GATEWAY_CARGO_FLAGS="--release --target ..."`, so a drifted `gateway/Cargo.lock` re-resolves silently in a release build.

## Desired contract

Owner ruling, 2026-09-20: do this. A change to any root crate the gateway builds from runs Gateway CI, and a gateway release build fails on lock drift instead of resolving around it.

## Boundaries

`.github/workflows/gateway-ci.yml` (both the `push` and `pull_request` path lists), the mirror-image `paths-ignore` in `ci.yml` that its header comment describes, and the `gateway-build` recipe in the `Makefile`. The path list should follow the path dependencies, including what those three crates themselves depend on inside the root workspace, and the root `Cargo.toml` they inherit versions from.

## Acceptance

1. A pull request that touches only `crates/chan-tunnel-proto/` runs Gateway CI.
2. A test or a lint step fails when `gateway/Cargo.toml` gains a root path dependency the workflow's path list does not cover, so the list cannot rot again.
3. `make gateway-build` fails, with cargo's own message, when `gateway/Cargo.lock` is out of date.
4. `actionlint` is clean and the two workflows' path rules still do not both skip any path.
