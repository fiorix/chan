# distros

Source packaging for Fedora COPR, Ubuntu Launchpad (PPA), the Arch User Repository, and Nix/Cachix, plus the binary Homebrew tap. COPR, Launchpad, and AUR ship standalone `chan` and `chan-desktop`; the first Nix package ships `chan-desktop` as the default output, including its `chan` and `cs` entry points; Homebrew serves the prebuilt macOS release assets as a `chan-desktop` cask and a `chan` formula. COPR and Launchpad build from a vendored source tarball because their builders are offline; AUR users build from the tagged source with locked npm and Cargo dependencies. The public command surface is the root Makefile (`make distros-tarball`, `make copr-srpm`, `make copr-build`, `make copr-check`, `make ppa-source`, `make ppa-upload`, `make aur-check`, `make nix-check`, `make homebrew-check`).

| Path | Concern |
|---|---|
| `mkdist` | Vendored source tarball builder shared by both ecosystems: git archive + prebuilt web bundles + `cargo vendor` + in-tarball `.cargo/config.toml` offline redirect. |
| `shared/` | `chan-devserver.service` (systemd user unit) and `chan-desktop.desktop`, installed by both the rpm and deb packages. |
| `fedora/` | `chan.spec`, `chan-desktop.spec`. The build tooling rewrites `%upstream_version` from the workspace Cargo.toml, so the committed value is a fallback. |
| `copr/` | `make-srpm.sh` (tarball + spec sync + `rpmbuild -bs`; runs in the COPR SRPM chroot or a local Fedora container), `build-srpm.sh` (local container driver, `--submit` for copr-cli), `build-with-sdme.sh` (host driver for the CentOS matrix behind `make copr-check`), `build-in-container.sh` (the per-container rebuild, install, and smoke it runs in the guest), and `test-build-with-sdme.sh` (host-side control-flow check for the driver, against a stub sdme). |
| `debian/` | `chan/` + `chan-desktop/` debian source dirs, `build-source.sh` (per-series `debuild -S`), `upload.sh` (dput). |
| `arch/` | Versionless AUR templates, renderer, and the shared clean-container/sdme validation path. |
| `../nix/` | Root-flake `chan-desktop` derivation, package contract, fixed-output maintenance, and Cachix release notes. |
| `homebrew/` | Versionless cask (`chan-desktop`) and formula (`chan`) templates plus the renderer for the [fiorix/homebrew-chan](https://github.com/fiorix/homebrew-chan) tap. Renders from the published GA release assets (DMG and darwin CLI tarball); no source build. |

`.copr/Makefile` at the repo root is COPR's "make srpm" entry point and delegates to `copr/make-srpm.sh`.

## Package shape

- `chan`: `/usr/bin/chan` + `/usr/bin/cs` symlink (argv0 dispatch) + the devserver user unit. Runtime deps: glibc and systemd (the unit and `chan devserver --service=systemd`); everything native is statically linked (ring, bundled SQLite, zstd; rustls, no OpenSSL).
- `chan-desktop`: `/usr/bin/chan-desktop` + `chan`/`cs` symlinks to it (the desktop binary IS the CLI via argv0 dispatch), `.desktop` entry with the `chan://` scheme handler, hicolor icons, and the same devserver unit. It conflicts with and provides `chan`; RPM/deb retain their existing replacement metadata, while AUR deliberately does not replace an installed package. Runtime deps add the WebKitGTK 4.1/GTK3/libsoup3 stack (auto-derived from sonames).
- All distro source builds export `CHAN_PACKAGED=rpm|deb|aur`, the Nix derivation exports `nix`, and the local `make linux-archpkg` QA package exports `pacman`. The marker bakes the self-update surface off (`crates/chan/src/update.rs`): the probe/banner stay silent and `chan upgrade` points at the package manager. The `/usr` desktop packages still write their self-healing `~/.local/bin/{chan,cs}` shims on boot; a Nix store install does not, because the profile exposes the output's own symlinks.
- Nix: the default and only package is `chan-desktop` for `x86_64-linux` and `aarch64-linux`. It includes `chan`/`cs` symlinks but no systemd unit or module. See [`../nix/README.md`](../nix/README.md).
- The `.deb`/`.rpm` release assets built by `make linux-deb`/`make linux-rpm` carry no marker, by design. No repository serves them: they are downloaded and installed by hand, so `sudo apt upgrade` would never update them and `chan upgrade` is the correct update path. The marker belongs only where a package manager genuinely owns updates.
- The Homebrew tap repackages the unmarked GitHub Release artifacts, so the self-update surface stays on for both packages. For the cask that is by design: `auto_updates true`, the Tauri updater owns app upgrades, and `brew upgrade` skips it unless `--greedy`. For the formula it is a known drift: `chan upgrade` replaces the binary in place and Homebrew's recorded version lags, so the formula's caveats steer users to `brew upgrade chan`.
- The packaged user unit lives in `/usr/lib/systemd/user/`; a unit written by `chan devserver --service=systemd` into `~/.config/systemd/user/` overrides it per the systemd user search order, so both flows coexist.

## Service configuration

COPR (`https://copr.fedorainfracloud.org`, project `fiorix/chan`, ID 245281):

- Chroots: the latest stable Fedora + rawhide on x86_64/aarch64; `centos-stream+epel-next-9` on x86_64/aarch64 for `chan`; and `centos-stream-10` on x86_64/aarch64 for both packages.
- Two SCM packages, `chan` and `chan-desktop`: Git source pointed at the GitHub repo, build method "make srpm", Spec File `packaging/distros/fedora/<pkg>.spec` (COPR forwards it as `spec=` to `.copr/Makefile`), committish empty (builds main's HEAD). Because the committish is empty, `main` must stay frozen from the GA tag push until both COPR builds complete; the workflow's publication probe asserts the built version matches the tag so a broken freeze reds at release time rather than reaching a user's `dnf upgrade`.
- CentOS chroot additional repository: `https://dl.fedoraproject.org/pub/epel/$releasever/Everything/$basearch/`. Add it separately to each of the four CentOS chroots, not project-wide, and keep `$releasever` literal so the EL9 and EL10 chroots select matching EPEL content without exposing Fedora chroots to nonexistent EPEL release paths.
- `chan-desktop` denies `centos-stream+epel-next-9-*`: EPEL Next 9 does not carry the WebKitGTK 4.1/libsoup3 development stack required by the current Tauri build. `chan` is enabled in all four CentOS chroots.
- The `publish-downstream` workflow (below) POSTs the project's **custom** webhook (Settings > Integrations, `webhooks/custom/<id>/<token>/<pkg>/`) for both packages; the base URL lives in the `COPR_WEBHOOK` repo secret. COPR's GitHub integration stays disabled: it fires on every push, not just releases.
- Local iteration without a release: run `make copr-check` for clean CentOS rebuild/install smokes, `make copr-srpm` for SRPM-only work, `make copr-build` for a raw submission, or curl the custom webhook manually. Raw `chan-desktop` submissions exclude both EL9 chroots just like the SCM package denylist.
- If a stable chroot's rust trails the workspace MSRV, enable an external rust repo for that chroot in the project settings, or wait for the distro update; rawhide tracks upstream closely.

The roadmap calls this Hyperscale support because that is the deployment target. Hyperscale is not a COPR buildroot input: the EL9 RPM is built against CentOS Stream 9 plus EPEL/EPEL Next and remains installable on a Hyperscale-enabled host.

**Repo-controlled vs COPR console state.** Two separate things decide what COPR builds, and only one of them is in this repo:

- **Repo-controlled**, readable and verifiable from a checkout: the spec files, what `make-srpm.sh` produces, and the two `--exclude-chroot centos-stream+epel-next-9-*` arguments that `build-srpm.sh --submit` passes for a raw `chan-desktop` submission.
- **COPR console state**, which no artifact here asserts or verifies: the enabled chroot list, the per-chroot additional EPEL repository, and the `chan-desktop` package chroot denylist.

The release path never touches `build-srpm.sh`: `publish-downstream` POSTs the custom webhook, COPR rebuilds the SCM package from Git, and the console denylist alone keeps the two unsupported EL9 `chan-desktop` jobs from being scheduled. COPR's public package endpoint does not expose the denylist, so it cannot be checked from a script either. Confirm it by eye in the project settings (Packages > `chan-desktop` > Edit) and by the absence of EL9 desktop jobs in the first build after any package or chroot change.

**Local matrix (`make copr-check`).** Import native-architecture rootfs images once, then point the Make target at their sdme names:

```sh
sudo sdme fs import quay.io/centos/centos:stream9 --name centos-stream-9 --install-packages=yes -v
sudo sdme fs import quay.io/centos/centos:stream10 --name centos-stream-10 --install-packages=yes -v
make copr-check DOCKER='sudo docker'
```

`copr-check` requires a Linux host. The guest hands its results back through a writable host bind, and on macOS lima mounts the host home read-only over virtiofs, which is why `packaging/sdme/build-chan-desktop.sh` stages its artifacts in the VM and pulls them out with `limactl copy` instead. `SDME` defaults to `sudo sdme`.

`COPR_RELEASE=9|10` and `PKG=chan|chan-desktop` narrow a diagnostic run. EL9 desktop is intentionally rejected. Imported rootfs names are per host: `COPR_EL9_ROOTFS` and `COPR_EL10_ROOTFS` default to the names above, and a missing one lists the names the host actually has. `DOCKER` defaults to `docker`; use `sudo docker` on hosts with a root-only socket. `REUSE_SRPM=1` reuses existing SRPMs for a guest-only diagnostic retry. `KEEP_CONTAINER=1` keeps every container for diagnosis, including a failed target's; otherwise each container is removed as its target finishes. Both take `0` or `1` and reject any other value. Every target runs even after an earlier one fails, and the run ends with a per-target PASS/FAIL summary and a non-zero exit if any target failed; an interrupt aborts the matrix instead. Results land under `target/distros/copr-check/el<9|10>/<arch>/<package>/`.

`sdme new` deletes the container when its guest command exits non-zero, so a failed target's results directory, not its container, is the surviving diagnostic surface. The guest wrapper hands that directory back to the host user on every path it reaches, the failing one included, which is what lets the next run clear it. A killed or timed-out container never reaches the handback; that leaves root-owned 0644 files in a host-owned directory, which the host can still read and delete. A directory an older run left owned by a container uid fails its own target with the `sudo rm -rf` that clears it, and the rest of the matrix still runs.

`test-build-with-sdme.sh` runs the driver against a stub sdme and a stub guest in about three seconds: per-target status capture, the re-run after a failed target, an unusable results directory, interrupt handling, and knob and preflight validation. Its stub guest runs as the host user, so it gates the wrapper reaching the handback, not the uid change itself; only a real container run shows that. Run it after editing the driver, since the real matrix costs hours of offline RPM rebuilds.

This is a repository-fidelity and packaging check, not a mock buildroot: `dnf builddep` installs the declared `BuildRequires` into a full CentOS rootfs, so a dependency the rootfs already provides but the spec omits passes here and fails in COPR's minimal buildroot.

Launchpad (`ppa:fiorix/chan`, processors amd64 + arm64 -- Launchpad defaults to amd64 only; the checkbox is in the PPA's "Change details"):

- The upload signing key is registered with the Launchpad account and lives in the repo secrets for CI (below); locally debsign uses `DEBSIGN_KEY` (or its default key). Local signing needs a tty pinentry: prime gpg-agent from a real terminal first (any one-off `gpg --clearsign`) when driving the build from an agent shell, or `debsign` the staged `*_source.changes` manually.
- Host prerequisites for local build/sign/upload: `devscripts`, `debhelper`, `dpkg-dev`, `dput` (`debuild -S` runs `debian/rules clean`, which needs debhelper's `dh`).
- Local flow (re-uploads, pre-release testing): `make distros-tarball && make ppa-source PPA_SERIES="noble resolute"` then `make ppa-upload`. Source-only uploads; each series gets `X.Y.Z-1~<series>1` while the orig tarball stays byte-identical across series (Launchpad requires this for one upstream version). A packaging-only re-upload bumps `SERIESREV`, which switches debuild to `-sd` (Launchpad already has the orig).
- Default PPA quota is ~2 GiB; each upstream version stores the ~63 MB orig twice (one per source package). Delete superseded versions or request a quota bump as needed.

Homebrew tap ([fiorix/homebrew-chan](https://github.com/fiorix/homebrew-chan), Apple Silicon macOS only):

- One cask (`chan-desktop`, installs `Chan.app` from the released DMG) and one binary formula (`chan`, installs the released darwin CLI tarball). Users run `brew install --cask fiorix/chan/chan-desktop` or `brew install fiorix/chan/chan`; the tap is implied by the qualified name.
- The tap repo holds only rendered definitions, a README, and the license. The templates and renderer live here, in `homebrew/`; CI regenerates both files from the template on every GA, so the tap is never edited by hand.
- The cask declares `auto_updates true` and no `binary` stanzas: the app's Tauri updater owns upgrades and the app itself maintains the `~/.local/bin/{chan,cs}` shims (`desktop/src-tauri/src/cs_install.rs`). The formula installs `bin/chan` plus the `cs` symlink, matching install.sh.
- Publication pushes to the tap over SSH with the `HOMEBREW_TAP_DEPLOY_KEY_BASE64` repo secret, the private half of a write deploy key on the tap repo, stored base64-encoded on one line because a multiline key does not survive every paste path (the `APPLE_CERTIFICATE_BASE64` precedent). The auth probe expects the deploy-key greeting naming `fiorix/homebrew-chan`, so a key registered any other way fails the chain.
- Local iteration: `make homebrew-check` renders both definitions from the released assets and syntax-checks them with `ruby -c`. There is no local `brew` on Linux hosts; `brew style`, `brew audit`, and the install smoke run in the workflow's macOS job. `HOMEBREW_VERSION=X.Y.Z` renders a version other than the workspace one; `HOMEBREW_LOCAL_ASSET` hashes a local asset instead of the published one.
- Backfill or repair: dispatch `publish-downstream` with the tag and `targets=homebrew`. The homebrew jobs check out the dispatching ref, not the tag, so template fixes publish without a new chan release. The tag must be an existing GA release: the renderer hashes its published assets.

## Release automation

`.github/workflows/publish-downstream.yml` runs after a successful tagged Release workflow and carries Docker Hub, Cachix, COPR, the PPA, and the AUR. It is deliberately separate from `release.yml`: secondary failures are red and attributable in this workflow but cannot fail the GitHub Release, `/dl` metadata, or Pages. Each target has an independent job chain, so one secondary failure does not suppress the others. Distro and Cachix publication jobs filter prerelease versions; Docker preserves immutable prerelease tags but moves `latest` only for GA. On forks, publication steps no-op when their secret is absent:

- `docker-build` builds both native architectures and pushes by digest; `docker-manifest` assembles and verifies the same four multi-arch images documented under [`../docker/`](../docker/). A `publish=false` dispatch builds cache-only and intentionally skips Docker Hub config and login.
- `cachix-build` builds and smokes the default flake package on native x86_64 and aarch64 runners, then pushes and pins each GA closure. `cachix-substitute` uses fresh runners with local builds disabled to prove both closures are available from the configured caches. A `publish=false` dispatch builds and smokes without requiring `CACHIX_AUTH_TOKEN`.
- `copr` curls the custom webhook in independent `chan` and `chan-desktop` matrix cells, with fail-fast disabled so both trigger outcomes are reported, then `verify-copr-publication.sh` polls the unauthenticated COPR API and fails the cell unless every chroot for that package succeeded at the released version. A built version other than the tag is a red, catching a `main` that was not frozen during publication; a budget that expires with the build unfinished reds as publication unconfirmed rather than failed. The probe reports but does not assert the chroot set: the enabled chroots, the per-chroot EPEL repository, and the `chan-desktop` EL9 denylist stay console-only state. That denylist should prevent EL9 desktop jobs, but it can lapse; if one is scheduled anyway, the spec refuses EL9 immediately and names the unavailable dependencies. Read the chroot set the probe reports on every release because the denylist remains console-only.
- `launchpad` rebuilds the vendored tarball at the released commit, imports `LAUNCHPAD_GPG_PRIVATE_KEY`/`LAUNCHPAD_GPG_PASSPHRASE` into an ephemeral loopback-pinentry keyring, and runs the same build-source.sh + upload.sh as the local flow.
- `aur-auth` proves the `AUR_SSH_PRIVATE_KEY` credential against `aur.archlinux.org` before anything is pushed. `aur-validate` builds, installs, and smokes both source recipes on clean upstream Arch x86_64 containers and gates publication. CI does not validate aarch64: every attempt failed on a CI-environment fault, not a package defect, so the aarch64 PKGBUILD ships for users to build natively rather than being gated in CI. See [`arch/README.md`](arch/README.md).
- `homebrew-auth` proves the `HOMEBREW_TAP_DEPLOY_KEY_BASE64` credential against github.com before anything is pushed. `homebrew-validate` renders both definitions on an arm64 macOS runner, stages them as a local tap, runs `brew style` and `brew audit`, then really installs the cask and the formula and smokes `chan --version`; it gates publication. `homebrew-publish` copies the rendered files into a clone of the tap, pushes one commit covering both, and confirms the tap serves the released version through the GitHub contents API.

Retry with `workflow_dispatch` and the tag. `targets` scopes the run to `docker`, `cachix`, `copr`, `launchpad`, or `aur`, so retrying a transient Launchpad ftp 550 does not also rebuild Docker, Nix, or the Arch packages. `publish` defaults to false: a dispatch builds or renders without uploading unless it is set to true. Dry-run reports name only what they observed: Docker and Cachix prove their builds without reading publisher credentials, while the PPA jobs fail on the canonical repository when a credential they exist to prove is absent. The AUR jobs do the same: `aur-auth` proves the credential before anything is pushed. On a fork, absent publication secrets are the expected no-op.

## Toolchain note

The workspace MSRV (`rust-toolchain.toml`) can run ahead of the distro archives. Fedora ships current rust in stable releases; Ubuntu ships versioned `rustc-1.XX`/`cargo-1.XX` packages that trail by a release or two, so `debian/*/rules` prefers the versioned toolchain when present and passes `--ignore-rust-version` to tolerate the gap. When `rustc-1.95` (or newer) reaches the target series, drop the flag and tighten the `Build-Depends` alternation in `debian/*/control`.
