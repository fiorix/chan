# Nix

The repository root is a flake for the Linux `chan-desktop` package. The default package is the desktop app because that is the normal install:

```sh
nix profile install github:fiorix/chan
```

The named install is equivalent:

```sh
nix profile install github:fiorix/chan#chan-desktop
```

The flake supports `x86_64-linux` and `aarch64-linux`. There is no separate headless output, NixOS module, Home Manager module, or systemd unit in this first package. The desktop output includes `chan` and `cs` symlinks to `chan-desktop`, so it still provides the command-line and devserver surfaces. Servers that do not want the desktop closure should keep using the standalone release archive, COPR/PPA/AUR `chan` package, or container image.

## Package shape

`packaging/nix/chan-desktop.nix` builds both web bundles and the Rust desktop binary from the locked repository source. Its output contains:

- `bin/chan-desktop`, wrapped with the GTK/WebKit runtime environment
- `bin/chan` and `bin/cs`, both symlinks to `chan-desktop`
- the shared desktop entry and hicolor icons
- the license and top-level release documentation

It deliberately does not install `chan-devserver.service`. A profile path is not a stable systemd `ExecStart` target, and service/module design is outside this package's scope.

The derivation exports `CHAN_PACKAGED=nix` while compiling. That makes the update probe and banner silent and makes every `chan upgrade` personality refuse with a Nix-specific package-manager hint. The desktop also recognizes a Nix store executable as an install it must not mirror into `~/.local/bin`; the output's own `chan` and `cs` symlinks are authoritative.

## Build and check

```sh
nix flake check --all-systems --no-build
nix build .#chan-desktop
make nix-check
```

`make nix-check` evaluates both systems, builds the native package, checks the output layout and update refusal, and boots the packaged devserver long enough to prove its health endpoint.

The package follows the repository's pinned Rust toolchain. It uses Node.js 22 from nixpkgs because Node.js 20 is end-of-life and has been removed from the current nixpkgs input; the rest of the project's existing CI remains on its own Node version.

## Fixed-output maintenance

Dependency changes intentionally make the build fail with a replacement hash:

- update `npmDeps.hash` after `web/package-lock.json` changes
- update `cargoHash` after `Cargo.lock` changes
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

`.github/workflows/publish-downstream.yml` builds and smokes the package on native x86_64 and aarch64 runners. A `publish=false`, `targets=cachix` dispatch does everything except authenticate and push. A GA run pushes each complete closure and creates these pins:

```text
vX.Y.Z-chan-desktop-x86_64-linux
vX.Y.Z-chan-desktop-aarch64-linux
```

Fresh runners then invoke `nix build` with local jobs disabled. That final job proves both closures substitute from the configured caches rather than merely existing in the first runner's local store.
