# Nix chan-desktop package and Cachix publication

Status: IMPLEMENTED locally for v0.81.0 on 2026-07-29; public Cachix cache/key and GitHub secret bootstrap pending.

## Why

Chan has package-manager-owned builds for COPR, Launchpad, and AUR, but no root flake or binary-cache release path. Nix users must assemble the Tauri dependency closure themselves and every machine repeats the Rust and frontend build. The product is desktop-first, so the package users reach without naming an attribute should be the UI build, not a server-oriented CLI.

## Accepted contract

- A root `flake.nix` and locked inputs expose `packages.<system>.chan-desktop` for `x86_64-linux` and `aarch64-linux`. `packages.<system>.default` is the same package.
- The output contains `chan-desktop` plus `chan` and `cs` symlinks to that binary, the shared desktop entry, icons, license, and release docs.
- This first cut has no separate `chan` output, NixOS module, Home Manager module, systemd unit, or Darwin package. Headless servers keep using the standalone archives, existing distro `chan` packages, or container image.
- The build uses the repository Rust toolchain, locked Cargo/npm dependency graphs, WebKitGTK 4.1, and a supported nixpkgs Node.js. Version comes from the root Cargo workspace, so the release pin cycle remains the single source of truth.
- Nix owns updates. The derivation compiles with `CHAN_PACKAGED=nix`, which suppresses update probes and banners and refuses every `chan upgrade` personality with a Nix-specific hint. A Nix-store desktop executable never creates mutable `~/.local/bin` shims.

## Cachix and release behavior

- The public cache name is `chan`. After external bootstrap, its substituter and public signing key live in flake configuration; its write token lives only in the GitHub secret `CACHIX_AUTH_TOKEN`.
- Core PR CI evaluates both systems and builds/smokes native x86_64.
- `publish-downstream` adds a Cachix chain independent of Docker, COPR, Launchpad, and AUR. Native x86_64 and aarch64 runners build and smoke the exact output.
- `publish=false`, `targets=cachix` proves both packages without pushing and without requiring a token.
- A GA run pushes each closure and pins `vX.Y.Z-chan-desktop-<system>`. Fresh runners then invoke `nix build` with local jobs disabled, proving substitution rather than reuse of the publisher's store.
- Release candidates are build-only. They do not push or pin Cachix paths.

## External bootstrap

The repository cannot create or own an account-level cache from source. Before the first dry run, the release owner creates the public `chan` cache, copies its public key into `flake.nix`, and adds its write token to the canonical repository as `CACHIX_AUTH_TOKEN`. Only the public key is committed or shared.

## Acceptance

- `nix flake check --all-systems --no-build` evaluates both supported systems.
- `nix build .#chan-desktop` succeeds natively on x86_64 and aarch64.
- Output smoke proves the binary and symlinks, desktop metadata and icons, no systemd unit, Nix-owned upgrade refusal, and a healthy packaged devserver.
- The ordinary build-matrix checker requires the Nix CI job and both Cachix downstream jobs, including the native arm runner and no-local-build substitution command.
- A v0.81.0 downstream dry run is green on both architectures.
- The GA cache has both versioned pins, and a fresh runner substitutes and smokes both outputs.

## Maintenance boundary

Cargo, npm, nixpkgs, and rust-overlay changes update only their corresponding lock or fixed-output hash and rerun the full Nix smoke. Expanding to a distinct headless closure, modules, services, or Darwin is a later design decision, not an incidental addition to this package.
