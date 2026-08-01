# Nix

The repository root is a flake for the Linux `chan` and `chan-desktop` packages. The default package is the desktop app because that is the normal install:

```sh
nix profile install github:fiorix/chan
```

The named install is equivalent:

```sh
nix profile install github:fiorix/chan#chan-desktop
```

Install the headless CLI and devserver output without the desktop closure:

```sh
nix profile install github:fiorix/chan#chan
```

The flake supports `x86_64-linux` and `aarch64-linux`. It does not provide a NixOS module, Home Manager module, or systemd unit.

## Package shape

`packaging/nix/chan.nix` builds both web bundles and the standalone Rust binary from the locked repository source. Its output contains:

- `bin/chan`
- `bin/cs`, a symlink to `chan`
- the license and top-level release documentation

The headless output deliberately omits `chan-desktop`, GTK, WebKitGTK, the GTK runtime wrapper, the desktop entry, and icons.

`packaging/nix/chan-desktop.nix` builds the same web bundles and the Rust desktop binary. Its output contains:

- `bin/chan-desktop`, wrapped with the GTK/WebKit runtime environment
- `bin/chan` and `bin/cs`, both symlinks to `chan-desktop`
- the shared desktop entry and hicolor icons
- the license and top-level release documentation

It deliberately does not install `chan-devserver.service`. A profile path is not a stable systemd `ExecStart` target, and service/module design is outside this package's scope.

Both derivations export `CHAN_PACKAGED=nix` while compiling. That makes the update probe and banner silent and makes every `chan upgrade` personality refuse with a Nix-specific package-manager hint. The desktop also recognizes a Nix store executable as an install it must not mirror into `~/.local/bin`; each output's own `chan` and `cs` paths are authoritative.

## Build and check

```sh
nix flake check --all-systems --no-build
nix build .#chan
nix build .#chan-desktop
make nix-check
```

`make nix-check` evaluates both systems, builds both native packages, checks each output layout and update refusal, and boots each packaged devserver long enough to prove its health endpoint.

The packages follow the repository's pinned Rust toolchain. They use Node.js 22 from nixpkgs because Node.js 20 is end-of-life and has been removed from the current nixpkgs input; the rest of the project's existing CI remains on its own Node version.

## Fixed-output maintenance

Both packages feed `${src}/web` to `fetchNpmDeps`, so they share the `npmDeps.hash` derived from `web/package-lock.json`. Their Rust crate selections differ, so each derivation has its own `cargoHash`.

When a new package's `cargoHash` has not been harvested yet, use this deliberately failing placeholder rather than inventing a plausible hash:

```nix
# Harvest the replacement from the first build's hash mismatch.
cargoHash = lib.fakeHash;
```

Dependency changes intentionally make the affected build fail with a replacement hash:

- update the shared `npmDeps.hash` in both derivations after `web/package-lock.json` changes
- update each affected derivation's `cargoHash` after `Cargo.lock` or its Rust crate selection changes
- update `flake.lock` deliberately when changing nixpkgs or rust-overlay

Replace only the hash named by Nix's mismatch, then run `make nix-check` again. Do not refresh the flake inputs as part of an unrelated package repair.

## Cachix release path

The public cache is named `chan`. Once its external bootstrap is complete, the root flake declares its substituter and public signing key, so consumers can accept the flake configuration and fetch published closures without a Cachix account.

Accept that configuration only from the reviewed upstream flake. CI configures the same named cache explicitly and does not auto-accept cache settings from a pull request.

The one-time external setup is:

1. Create a public Cachix cache named `chan`.
2. Copy its public signing key into `flake.nix`.
3. Store a write token as the GitHub Actions secret `CACHIX_AUTH_TOKEN`.

Never commit or print the write token. The public signing key is not secret.

`.github/workflows/publish-downstream.yml` builds and smokes both packages on native x86_64 and aarch64 runners. A `publish=false`, `targets=cachix` dispatch does everything except authenticate and push. A GA run pushes each complete closure into the `chan` cache and creates these pins:

```text
vX.Y.Z-chan-x86_64-linux
vX.Y.Z-chan-aarch64-linux
vX.Y.Z-chan-desktop-x86_64-linux
vX.Y.Z-chan-desktop-aarch64-linux
```

Fresh runners then invoke `nix build` with local jobs disabled. That final job proves all four system/package closures substitute from the configured caches rather than merely existing in the first runner's local store.
