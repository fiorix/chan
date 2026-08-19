# chan on Arch Linux (AUR)

Two source-built packages are published to the Arch User Repository:

- [`chan`](https://aur.archlinux.org/packages/chan) installs the standalone CLI and devserver.
- [`chan-desktop`](https://aur.archlinux.org/packages/chan-desktop) installs the native desktop and provides the same `chan` and `cs` command surface.

They conflict because `chan-desktop` contains the full CLI in-process. Install one:

```bash
paru -S chan
paru -S chan-desktop
```

Without an AUR helper:

```bash
git clone https://aur.archlinux.org/chan.git
cd chan
makepkg -si
```

The recipes declare x86_64 and aarch64. The x86_64 path has green release history and gates AUR publication. CI does not validate aarch64: every attempt failed on a CI-environment fault (the Arch Linux ARM download host's TLS certificate, then pacman 7's Landlock sandbox inside the container), never on a package defect, so aarch64 is neither built nor gated before publish. The aarch64 PKGBUILD still ships in the AUR; aarch64 users build it natively with `makepkg -si`. CachyOS can consume the AUR recipes directly, but inclusion in CachyOS's precompiled package repositories is a separate request to that project.

## Maintainer flow

The AUR is a collection of git repositories containing build recipes; it does not build or validate packages. Pushing `PKGBUILD` and `.SRCINFO` publishes immediately. The checked-in files here are versionless templates so the repository cannot strand an old release number.

- `aur/{chan,chan-desktop}/PKGBUILD.in` are the source package templates.
- `make-aur-package.sh` resolves a GA tag or a local test archive, renders `PKGBUILD`, generates `.SRCINFO`, and validates the metadata. It never pushes.
- `build-in-container.sh` is the shared clean-Arch build/install/smoke path used by CI and sdme.
- `build-with-sdme.sh` archives a committed local revision and runs both packages in a disposable sdme container.
- `build-in-ci.sh` is the workflow's entry point: it validates the tag and `pkgrel`, then runs the same container build against the image the job provides, so the x86_64 and aarch64 jobs cannot drift apart.

Import an Arch rootfs once, then run the local gate:

```bash
sudo sdme fs import docker.io/archlinux/archlinux:base --name archlinux
make aur-check SDME='sudo sdme' AUR_ROOTFS=archlinux
```

`archlinux` is a plain upstream base rootfs, named like the other base imports the packaging paths use (`ubuntu`, `centos-stream-9`); only purpose-built rootfs images with a `.sdme` template carry a `chan-`/`gateway-` prefix. `AUR_ROOTFS` selects a different import. The pre-provisioned desktop build rootfs is deliberately not reused because its baked dependencies would hide a missing `PKGBUILD` declaration.

`AUR_REV` defaults to `HEAD` and may name another committed revision. The wrapper archives that revision rather than the working tree, so commit the packaging changes in a worktree before using this as the final local gate.

The package architecture comes from the host and rootfs; the build never uses QEMU. An aarch64 host runs the same local target against an Arch Linux ARM import under the same name, but CI validates only x86_64.

**Automatic AUR publication resumed on the v0.91.0 release.** It was suspended from 2026-08-06 while the Arch Linux [Active AUR malicious packages incident](https://archlinux.org/news/active-aur-malicious-packages-incident/) stood with pushes restricted, and lifted after the AUR re-enabled them: [aurweb v6.5.0 deployed](https://lists.archlinux.org/archives/list/aur-general@lists.archlinux.org/thread/P5C7GZ4C3OJIH4EXJ62JAF6X6PY2BCQ4/), 2026-08-11, states "SSH/git push access is re-enabled along with adoption". Adoption now files a request for review rather than transferring maintainership immediately, which is the control for the hijacking the incident was about. A GA release publishes both pkgbases again; local validation below is unaffected and always was.

The automatic path lives in `.github/workflows/publish-downstream.yml`. After a successful GA Release run it builds, installs, and smokes `chan` and `chan-desktop` on clean x86_64 containers, probes the AUR credential, and pushes both AUR repositories after the credential and x86_64 jobs pass. It needs `AUR_SSH_PRIVATE_KEY`, the same private key already registered with the maintainer's AUR account for `sdme`. Without the secret, validation still runs and publication is skipped; a `publish=false` dispatch on this repository fails instead, because proving the credential is that run's only product. That is the behavior the suspension interrupts and the behavior restoring it returns to.

Manual dispatch takes the existing GA tag plus:

| Input | Effect |
|---|---|
| `targets` | Runs one distro (`copr`, `launchpad`, `aur`) instead of all three, so a Launchpad retry costs one job. |
| `publish` | Defaults to false: renders, validates, and probes the credentials, then pushes nothing. A retry that must actually publish needs `publish=true`. |
| `aur_pkgrel` | Keep `1` for a normal release; raise it when repairing packaging for an already-published upstream version. |

A prerelease version skips every job in the workflow: the AUR jobs, `copr`, and `launchpad` all filter a `-` out of the tag, on both the dispatch and the workflow_run path. Release candidates are validated on a branch and their tags are not pushed, so this is defense in depth rather than a path anything is expected to take.

`aur-auth` is the only pre-release proof that the private key in the secret has its public half registered on the AUR account: it runs `ssh -T aur@aur.archlinux.org`, which a registered key answers with a greeting and a refused interactive shell. Without that probe a wrong key surfaces as a failed clone at publication time, after the release is already out.

CI does not validate aarch64. Every attempt failed on a CI-environment fault (the Arch Linux ARM download host's TLS certificate, then pacman 7's Landlock sandbox inside the container), never on a package defect, so the aarch64 leg is not built or gated before publish; the aarch64 PKGBUILD ships for users to build natively.

`aur-validate` is a hard `needs` of `aur-publish`, so anything that fails inside its x86_64 matrix (the `makepkg` build, package-scoped `cargo test`, namcap error gate, packaged-update check, systemd unit check, or the `chan-desktop` desktop-entry and icon checks) blocks the AUR push. The matrix covers both packages, so a `chan-desktop` failure also holds back `chan`. The blast radius stops there. COPR, the PPA, and the GitHub release are separate jobs and a separate workflow, so none of them is affected; the fix is a recipe change plus a `targets=aur` dispatch, with `aur_pkgrel` raised if that version already published.

Only `PKGBUILD` and `.SRCINFO` belong in the AUR repositories. The generated source archive and `.pkg.tar.zst` files under `target/aur-*` are local artifacts.

## Package behavior

- Both recipes build from the GA tag and use locked npm and Cargo dependencies. `RUSTUP_TOOLCHAIN=stable` keeps the tree's `rust-toolchain.toml` pin from making a rustup-provided cargo download a second toolchain mid-build.
- `CHAN_PACKAGED=aur` disables `chan` self-upgrade so package ownership remains with the AUR helper. The local `make linux-archpkg` QA package is stamped `pacman` instead, because it never came from the AUR.
- The container proves that stamp differently per package. Installed `chan` runs `chan upgrade`, which must exit unsuccessfully and name the AUR helper. The desktop personality routes `chan upgrade` to a running GUI instead, which a headless container cannot supply, so `chan-desktop` is checked at the stamp itself: the rendered recipe must export `CHAN_PACKAGED=aur`, and the installed binary must still carry the AUR-helper refusal hint. That hint is reachable only through `option_env!("CHAN_PACKAGED")` being `Some`, so an unstamped release build drops it with the dead branch and the check fails.
- `namcap` gates the container build: its error class covers a library the binary needs and the recipe does not declare, which would otherwise ship silently to every AUR user. Warnings stay advisory and are printed in full. Adding a waiver is one commented line in `build-in-container.sh`'s `namcap_waivers` array. The array is empty: every finding measured for either package is one of the dependency-declaration warnings below, all advisory.
- For `chan`, namcap reports `gcc-libs` and `systemd` as possibly unneeded, and reports `libgcc` as needed and implicitly satisfied. For `chan-desktop` it adds `libayatana-appindicator`, `librsvg`, and `xdg-utils` as possibly unneeded, and `dbus`, `gdk-pixbuf2`, `cairo`, and `glib2` as implicitly satisfied. All of them stay as they are. namcap derives dependencies from linked sonames alone: `systemd` is a runtime dependency for the packaged user unit and `chan devserver start --service=systemd`, `xdg-utils` carries the `chan://` scheme handler, and `libayatana-appindicator` carries the tray, none of which an ELF header shows; `gcc-libs` is the package that provides the `libgcc_s.so.1` the same output says the binary needs (there is no `libgcc` package to declare). The remaining warning on both packages, an unused `ld-linux-x86-64.so.2`, is the dynamic loader itself.
- `chan-desktop` links to the host WebKitGTK/Mesa stack. This is the correct Arch/CachyOS path and avoids the rolling-distro incompatibility of the Ubuntu-built AppImage.
- The AUR Ed25519 host key is pinned to the fingerprint published by the AUR. Do not replace it with `ssh-keyscan`.
