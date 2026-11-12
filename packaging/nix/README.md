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

The flake supports `x86_64-linux` and `aarch64-linux`. It does not provide a NixOS module, a Home Manager module, or a systemd unit.

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

It deliberately does not install `chan-devserver.service`: a profile path is not a stable systemd `ExecStart` target, and service and module design is outside this package's scope.

Both derivations export `CHAN_PACKAGED=nix` while compiling. That keeps the update probe and banner silent and makes every `chan upgrade` personality refuse with a Nix-specific package-manager hint. The desktop also recognizes a Nix store executable as an install it must not mirror into `~/.local/bin`; each output's own `chan`, `cs`, `chan-files`, `chan-edit` and `chan-term` paths are authoritative.

## Build and check

```sh
nix flake check --all-systems --no-build
nix build .#chan
nix build .#chan-desktop
make nix-check
```

`make nix-check` evaluates both systems, builds both native packages, checks each output layout and update refusal, and boots each packaged devserver long enough to prove its health endpoint.

On a Linux host without Nix, import a plain Ubuntu rootfs once and run the supplementary sdme check:

```sh
sudo sdme fs import docker.io/ubuntu:26.04 --name ubuntu --install-packages=yes -v
make nix-sdme-check
make nix-sdme-check NIX_PACKAGE=chan
make nix-sdme-check NIX_PACKAGE=chan-desktop
```

`NIX_SDME_ROOTFS` selects the imported Ubuntu rootfs. The driver verifies the guest identity, installs Ubuntu's `nix-bin` and `nix-setup-systemd` packages inside the disposable overlay, initializes the local store, enables flakes, and keeps Nix build directories and smoke-test temporary files under `/var/tmp` (narrowed to 0755 in the guest, because Nix refuses a build path with a world-writable component; the host `/var/tmp` is untouched). `NIX_PACKAGE=all` delegates to the native `make nix-check` contract; either named package evaluates the flake, builds and validates exactly that output, and runs its package smoke without first building the other package.

The driver copies the current contents of indexed files into a tracked-source snapshot under `/var/tmp`, omitting tracked deletions, Git metadata, ignored files, and untracked files. That snapshot is mounted read-only at `/src` and evaluated as a path flake, so linked worktrees need no Git metadata inside the guest and ignored build products cannot enter the Nix source. The only writable host mount is the selected output directory at `/out`, `/var/tmp/chan-nix-sdme-check` by default; the driver rejects repository/output and snapshot/output overlap. Combined guest output is retained as `build.log` beside the guest status file. A container or snapshot cleanup failure fails an otherwise successful run without replacing an earlier failure. This check never publishes to Cachix or creates release artifacts.

`make nix-sdme-contract-check` exercises the rootfs, bind, store setup, status, failure, and cleanup behaviour against a stub. It does not start a container or install Nix.

The packages follow the repository's pinned Rust toolchain and use Node.js 22 from nixpkgs, the major `.nvmrc` declares.

## Fixed-output maintenance

Both packages feed `${src}/web` to `fetchNpmDeps`, so they share the `npmDeps.hash` derived from `web/package-lock.json`. Both also build from the same flake source and vendor the same root `Cargo.lock` (`cargoBuildFlags` selects the crate to build, not the crates to vendor), so they share the `cargoHash`: one harvested value goes into both derivations, and `make nix-hash-check` fails when the two differ.

`packaging/nix/cargo-lock.sha256` records, in `sha256sum` format, the digest of the `Cargo.lock` the pinned `cargoHash` was harvested for. `make nix-hash-check`, a `make pre-push` step on every host, compares the live lock with it, so any lock change fails the gate until the hash is harvested again. `make nix-hash-pin CARGO_HASH=sha256-...` writes the harvested value into both derivations and rewrites the digest file from the live lock in one step. The pin helper refuses a placeholder, a malformed value, a value the same derivation pins as `npmDeps.hash`, and the value both derivations already carry when the digest file does not name the live lock (that is the `specified:` line a Nix build prints beside `got:`; the `got:` line of the `-vendor-staging` mismatch is the value to copy); it leaves every file untouched when it refuses, and it cannot prove the value it accepts, which only a Nix build can. A malformed digest file (a conflict marker left in it, say) also makes the helper refuse: restore the file from the commit whose pins were kept, or harvest again. `npmDeps.hash` has no such record: a stale npm hash passes the gate and fails only in the Nix build, which reports its `-npm-deps` mismatch before the cargo one.

When a new package's `cargoHash` has not been harvested yet, use this deliberately failing placeholder rather than inventing a plausible hash:

```nix
# Harvest the replacement from the first build's hash mismatch.
cargoHash = lib.fakeHash;
```

The placeholder is a working state for the harvest, not one to commit: `make nix-hash-check` fails while either file carries it.

Dependency changes intentionally make the affected build fail with a replacement hash:

- update the shared `npmDeps.hash` in both derivations after `web/package-lock.json` changes
- update the `cargoHash` in both derivations after `Cargo.lock` changes, with `make nix-hash-pin`, which also records the lock digest
- update `flake.lock` deliberately when changing nixpkgs or rust-overlay

Replace only the hash named by Nix's mismatch, which the derivation name selects: `-npm-deps` is `npmDeps.hash`, and `-vendor-staging` is `cargoHash`; then run `make nix-check` again. Do not refresh the flake inputs as part of an unrelated package repair. On a host without Nix, or where the harvest must not run as root, the release skill (`.agents/skills/release/SKILL.md`, "Nix hashes on a host without Nix") describes the capped-guest harvest as a non-root user with a real `/nix` owned by that user.

## Cachix release path

The public cache is named `chan`. The root flake declares its substituter and public signing key, so consumers can accept the flake configuration and fetch published closures without a Cachix account. Accept that configuration only from the reviewed upstream flake; CI configures the same named cache explicitly and does not auto-accept cache settings from a pull request.

The cache depends on three things outside the repository: the public Cachix cache named `chan`, its public signing key in `flake.nix`, and a write token stored as the GitHub Actions secret `CACHIX_AUTH_TOKEN`. Never commit or print the write token; the public signing key is not secret.

`.github/workflows/publish-downstream.yml` builds and smokes both packages on native x86_64 and aarch64 runners. A `publish=false`, `targets=cachix` dispatch does everything except authenticate and push, and prints the pins a GA would make. A GA run pushes each complete closure into the `chan` cache and pins it under one stable name per package and system:

```text
chan-x86_64-linux
chan-aarch64-linux
chan-desktop-x86_64-linux
chan-desktop-aarch64-linux
```

Each GA adds a revision to each of the four pins, and `scripts/cachix-pin.sh` pins with `cachix pin --keep-revisions`, so Cachix keeps the newest revisions of each name and drops the older ones; a pin keeps its closure out of Cachix's garbage collection, and a dropped revision's closure falls to it once nothing else holds it. The number kept is the workflow's `cachix_keep` input, 10 by default and on every tag-triggered run; raise it on a `workflow_dispatch` retry, or change the default in the workflow. Revisions are kept by when they were pinned, not by version, so a patch release of an older line counts as the newest. Release candidates are never pinned. The pushes run before the pins, so a publication's closures are pushed while the previous revisions still hold theirs.

Fresh runners then invoke `nix build` with local jobs disabled. That final job proves all four system/package closures substitute from the configured caches rather than merely existing in the first runner's local store.
