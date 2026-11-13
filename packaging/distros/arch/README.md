# chan on Arch Linux (AUR)

Three packages are published to the Arch User Repository:

- [`chan`](https://aur.archlinux.org/packages/chan) builds and installs the standalone CLI and devserver.
- [`chan-desktop`](https://aur.archlinux.org/packages/chan-desktop) builds and installs the native desktop and provides the same `chan` and `cs` command surface.
- [`chan-desktop-bin`](https://aur.archlinux.org/packages/chan-desktop-bin) installs the same desktop prebuilt, from an asset on the GitHub release, so nothing compiles on the user's machine.

They conflict because each desktop package contains the full CLI in-process. Install one:

```bash
paru -S chan
paru -S chan-desktop
paru -S chan-desktop-bin
```

Without an AUR helper:

```bash
git clone https://aur.archlinux.org/chan.git
cd chan
makepkg -si
```

The source recipes declare x86_64 and aarch64; `chan-desktop-bin` declares x86_64 only, the one architecture the Arch Linux Archive its asset is built from serves. The x86_64 path gates AUR publication. CI does not validate aarch64: every attempt failed on a CI-environment fault (the Arch Linux ARM download host's TLS certificate, then pacman's Landlock sandbox inside the container), never on a package defect, so aarch64 is neither built nor gated before publish. The aarch64 PKGBUILD still ships in the AUR; aarch64 users build it natively with `makepkg -si`. CachyOS can consume the AUR recipes directly, but inclusion in CachyOS's precompiled package repositories is a separate request to that project.

## chan-desktop-bin

The release asset `chan-desktop-bin-X.Y.Z-N-x86_64.tar.zst` (N is the pkgrel) is the `usr/` tree of a `chan-desktop` package built from the GA tag by the `chan-desktop` recipe itself, so it carries the same `CHAN_PACKAGED=aur` stamp, files, and runtime dependencies; `make build-matrix-check` holds the two `depends` lists equal. The `chan-desktop-bin` recipe copies that tree into place.

The asset is built on an [Arch Linux Archive](https://wiki.archlinux.org/title/Arch_Linux_Archive) snapshot dated six weeks before the tagged commit. A binary linked against older glibc and WebKitGTK keeps running on newer ones, not the reverse, so the snapshot sets the oldest system the package runs on. Six weeks keeps it at or behind derivatives that hold their mirror back: Omarchy's stable channel trails Arch by a month. The gap is measurable: on 2026-11-03 the six-week snapshot (2026/09/22) carried webkit2gtk-4.1 2.52.6 where Arch had 2.54.2. The commit date, not the clock, picks the day, so rebuilding one tag links against the same snapshot. The snapshot's Arch `rust` must still meet the workspace `rust-version`; a toolchain bump that outruns it fails the asset build, not the source packages.

`build-in-ci.sh` with `PKGBASE=chan-desktop-bin` proves both ends in two containers on the same image. The first downgrades it to the snapshot (`ARCH_SNAPSHOT` overrides the date), builds, installs, and smokes `chan-desktop` there, then packs the asset with `desktop-bin-asset.sh`. The second renders `chan-desktop-bin` against that asset and builds, namcaps, installs, and smokes it on the current image. Locally, with Docker:

```bash
git archive --format=tar.gz --prefix=chan-X.Y.Z/ HEAD > target/aur-ci-source/chan-X.Y.Z.tar.gz
RELEASE_TAG=vX.Y.Z PKGBASE=chan-desktop-bin AUR_LOCAL_SOURCE=target/aur-ci-source/chan-X.Y.Z.tar.gz \
    packaging/distros/arch/build-in-ci.sh docker.io/archlinux/archlinux:base-devel
```

`downgrade-to-snapshot.sh` does the downgrade. `pacman -Suu` takes every installed package the snapshot carries to the snapshot's version and leaves installed the ones the snapshot lacks, and one of those that shares a file with a snapshot package fails the whole transaction on a file conflict: an image with openssl 4 carries the `openssl-3` compat package, whose `libssl.so.3` the snapshot's openssl 3 also owns. The script drops the packages the snapshot lacks from pacman's database first and keeps their files on disk until the snapshot's packages have replaced them, since any of them could hold a library pacman itself loads. It fails, naming the snapshot and the dropped packages, when `pacman -Dk` finds a dependency unmet, before anything is deleted. Then it deletes what no snapshot package took over the way `pacman -R` does, files first and each directory once it is empty, so a file no package owns stays with the directories above it, and the log names those directories. Last, it fails unless every installed package is in the snapshot at the snapshot's version. A configuration file the image keeps beside the snapshot's `.pacnew`, or saves as a `.pacsave`, is listed in the log but does not fail the build, which reads neither. Since it uninstalls packages and deletes files, the script refuses to run outside a container (`systemd-detect-virt --container`, which answers under docker, podman and sdme) or unless every repository `pacman-conf` lists is served by the snapshot of the date it is given alone. Starting from the image of the snapshot's own date instead would need a registry lookup, since an image tag carries a build number a date does not give. `packaging/distros/arch/test-downgrade-to-snapshot.sh` runs the script against stand-ins for pacman, `pacman-conf` and `systemd-detect-virt` that serve real output: the `openssl-3` case, and a package whose file names hold glob characters and commas.

`make aur-check` covers the two source packages only.

The asset name carries the pkgrel, so a published asset is never replaced: a retry of the same version and pkgrel downloads and reuses it, and a repaired recipe is a new pkgrel and a new asset. The binary links WebKitGTK, libsoup, and GTK by API-versioned sonames (`webkit2gtk-4.1`, `libsoup-3.0`, `gtk-3`), which change with a new package name rather than in place; a soname change in any of them would need a release whose snapshot is past it.

## Maintainer flow

The AUR is a collection of git repositories containing build recipes; it does not build or validate packages. Pushing `PKGBUILD` and `.SRCINFO` publishes immediately. The checked-in files here are versionless templates so the repository cannot strand an old release number.

- `aur/{chan,chan-desktop}/PKGBUILD.in` are the source package templates, and `aur/chan-desktop-bin/PKGBUILD.in` the prebuilt one.
- `make-aur-package.sh` resolves a GA tag, a local test archive, or for `chan-desktop-bin` the release asset or a local copy of it, renders `PKGBUILD`, generates `.SRCINFO`, and validates the metadata. It never pushes.
- `desktop-bin-asset.sh` names the `chan-desktop-bin` asset and packs it from a built `chan-desktop` package.
- `publish-aur.sh` holds the workflow's dry-run report, AUR push, and RPC index check, shared by every pkgbase.
- `build-in-container.sh` is the shared clean-Arch build, install and smoke path used by CI and sdme.
- `downgrade-to-snapshot.sh` takes that container to the Arch Linux Archive snapshot the `chan-desktop-bin` asset is built on.
- `build-with-sdme.sh` archives a committed local revision and runs both packages in a disposable sdme container.
- `build-in-ci.sh` is the workflow's entry point: it validates the tag and `pkgrel`, then runs the same container build against the image the job provides, so the x86_64 and aarch64 jobs cannot drift apart.

The CI wrapper defaults `AUR_CARGO_JOBS` to 2 and passes it as `CARGO_BUILD_JOBS` to every cargo call in either package's recipe, `build()` and `check()` included; a workflow caller can set a positive integer `AUR_CARGO_JOBS` to change the bound. The published recipes and a user's own `makepkg` do not set it and keep cargo's default. `check()` still runs the same release-profile command and tests, so what it proves is unchanged. `packaging/distros/arch/test-build-in-ci.sh` checks the wrapper's Docker arguments, the builder's environment, and the resource log with local stubs; `make aur-contract-check`, part of the Linux `make pre-push`, runs it and `test-downgrade-to-snapshot.sh` as a non-root user.

Import an Arch rootfs once, then run the local gate:

```bash
sudo sdme fs import docker.io/archlinux/archlinux:base --name archlinux
make aur-check SDME='sudo sdme' AUR_ROOTFS=archlinux
```

`archlinux` is a plain upstream base rootfs, named like the other base imports the packaging paths use (`ubuntu`, `centos-stream-9`); only purpose-built rootfs images with a `.sdme` template carry a `chan-` or `gateway-` prefix. `AUR_ROOTFS` selects a different import. The pre-provisioned desktop build rootfs is deliberately not reused because its baked dependencies would hide a missing `PKGBUILD` declaration.

`AUR_REV` defaults to `HEAD` and may name another committed revision. The wrapper archives that revision rather than the working tree, so commit the packaging changes before using this as the final local gate.

The package architecture comes from the host and rootfs; the build never uses QEMU. An aarch64 host runs the same local target against an Arch Linux ARM import under the same name, but CI validates only x86_64.

The automatic path lives in `.github/workflows/publish-downstream.yml`. After a successful GA Release run it builds, installs, and smokes `chan` and `chan-desktop` on clean x86_64 containers, probes the AUR credential, and pushes both AUR repositories after the credential and x86_64 jobs pass. In a separate chain, `aur-bin-validate` builds the `chan-desktop-bin` asset and recipe as above, or reuses an asset the release already carries, and `aur-bin-publish` uploads the asset to the GitHub release, checks that the release serves the bytes the recipe pins, and only then pushes the recipe. It is the one AUR job with `contents: write`. It needs `AUR_SSH_PRIVATE_KEY`, the private key registered with the maintainer's AUR account. Without the secret, validation still runs and publication is skipped; a `publish=false` dispatch on this repository fails instead, because proving the credential is that run's only product.

Manual dispatch takes the existing GA tag plus:

| Input | Effect |
|---|---|
| `targets` | Runs one downstream target (`docker`, `cachix`, `copr`, `launchpad`, `aur`, `homebrew`) instead of all, so a retry costs one job chain. |
| `publish` | Defaults to false: renders, validates, and probes the credentials, then pushes nothing. A retry that must actually publish needs `publish=true`. |
| `aur_pkgrel` | Keep `1` for a normal release; raise it when repairing packaging for an already-published upstream version. |

A prerelease version skips every job in the workflow: the AUR jobs, `copr`, and `launchpad` all filter a `-` out of the tag, on both the dispatch and the workflow_run path. Release candidates are validated on a branch and their tags are not pushed, so this is defense in depth rather than a path anything is expected to take.

`aur-auth` is the only pre-release proof that the private key in the secret has its public half registered on the AUR account: it runs `ssh -T aur@aur.archlinux.org`, which a registered key answers with a greeting and a refused interactive shell. Without that probe a wrong key surfaces as a failed clone at publication time, after the release is already out.

`aur-validate` is a hard `needs` of `aur-publish`, so anything that fails inside its x86_64 matrix (the `makepkg` build, package-scoped `cargo test`, the namcap error gate, the packaged-update check, the systemd unit check, or the `chan-desktop` desktop-entry and icon checks) blocks the AUR push. The matrix covers both packages, so a `chan-desktop` failure also holds back `chan`. `chan-desktop-bin` runs in its own chain, so a failure there holds back neither source package, and theirs do not hold it back. The blast radius stops there: COPR, the PPA, and the GitHub release are separate jobs and a separate workflow, so none of them is affected; the fix is a recipe change plus a `targets=aur` dispatch, with `aur_pkgrel` raised if that version already published.

Only `PKGBUILD` and `.SRCINFO` belong in the AUR repositories. The generated source archive and `.pkg.tar.zst` files under `target/aur-*` are local artifacts.

## Package behavior

- Both recipes build from the GA tag and use locked npm and Cargo dependencies. `RUSTUP_TOOLCHAIN=stable` keeps the tree's `rust-toolchain.toml` pin from making a rustup-provided cargo download a second toolchain mid-build.
- Each `build()` saves its release binary to `package-bin/<pkgname>` inside the extracted source directory, outside cargo's `target/`. `check()` runs the package's tests in the original target directory; integration tests can relink its binary there with dev-dependency features. `package()` installs the saved copy, so those test features cannot change the binary it ships. `make build-matrix-check` pins the copy after the last cargo build, its install source, and the absence of later recipe commands that write it. The checker accepts a small literal command grammar and rejects unreadable writers or paths; it does not inspect manifests, resolve features, or verify the contents of the built package.
- `CHAN_PACKAGED=aur` disables `chan` self-upgrade so package ownership remains with the AUR helper. The local `make linux-archpkg` QA package is stamped `pacman` instead, because it never came from the AUR.
- The container proves that stamp differently per package. Installed `chan` runs `chan upgrade`, which must exit unsuccessfully and name the AUR helper. The desktop personality routes `chan upgrade` to a running GUI instead, which a headless container cannot supply, so `chan-desktop` is checked at the stamp itself: the rendered recipe must export `CHAN_PACKAGED=aur`, and the installed binary must still carry the AUR-helper refusal hint. That hint is reachable only through `option_env!("CHAN_PACKAGED")` being `Some`, so an unstamped release build drops it with the dead branch and the check fails.
- `namcap` gates the container build: its error class covers a library the binary needs and the recipe does not declare, which would otherwise ship silently to every AUR user. Warnings stay advisory and are printed in full. Adding a waiver is one commented line in `build-in-container.sh`'s `namcap_waivers` array. The array is empty: every finding measured for either package is one of the dependency-declaration warnings below, all advisory.
- For `chan`, namcap reports `gcc-libs` and `systemd` as possibly unneeded, and `libgcc` as needed and implicitly satisfied. For `chan-desktop` it adds `libayatana-appindicator`, `librsvg`, and `xdg-utils` as possibly unneeded, and `dbus`, `gdk-pixbuf2`, `cairo`, and `glib2` as implicitly satisfied. All of them stay as they are. namcap derives dependencies from linked sonames alone: `systemd` is a runtime dependency for the packaged user unit and `chan devserver start --service=systemd`, `xdg-utils` carries the `chan://` scheme handler, and `libayatana-appindicator` carries the tray, none of which an ELF header shows; `gcc-libs` is the package that provides the `libgcc_s.so.1` the same output says the binary needs (there is no `libgcc` package to declare). The remaining warning on both packages, an unused `ld-linux-x86-64.so.2`, is the dynamic loader itself.
- `chan-desktop` links to the host WebKitGTK/Mesa stack. This is the correct Arch/CachyOS path and avoids the rolling-distro incompatibility of the Ubuntu-built AppImage.
- `chan-desktop-bin` runs the `chan-desktop` smoke against the installed package: the binary must carry the AUR-helper refusal hint, and the desktop entry and icons must be in place. It has no build step to stamp, so the rendered-recipe half of that check does not apply.
- The AUR Ed25519 host key is pinned to the fingerprint published by the AUR. Do not replace it with `ssh-keyscan`.
