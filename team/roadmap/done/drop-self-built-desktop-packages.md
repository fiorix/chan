# Stop Publishing The Self-Built Desktop .deb And .rpm

> Status: shipped in [v0.75.0](../../release/release-v0.75.0.md): the unmaintained self-built Tauri .deb/.rpm are gone; COPR/PPA/AUR is the desktop package channel.

Status: accepted scope for v0.74.0, blocked on the loopback redirect item landing first.

## Problem

Every chan release uploads four Linux desktop packages that chan builds itself and nobody maintains as distro packages: `Chan_<version>_amd64.deb`, `Chan_<version>_arm64.deb`, `Chan-<version>-1.x86_64.rpm` and `Chan-<version>-1.aarch64.rpm`. They come out of the `linux-desktop-artifacts` job, which stages whatever Tauri's `targets: "all"` emitted by globbing three bundle directories: `.github/workflows/release.yml:352-355` loops over `target/release/bundle/appimage/*.AppImage`, `target/release/bundle/deb/*.deb` and `target/release/bundle/rpm/*.rpm`, copies each match into `release-artifacts/`, and uploads the directory at `.github/workflows/release.yml:366-369`; the publish job attaches everything under `artifacts/**/*` at `.github/workflows/release.yml:816-822`.

These packages duplicate a maintained rollout. `pkgbase chan-desktop` ships through COPR, Launchpad and the AUR. COPR builds it from the SCM package described at `packaging/distros/README.md:28-31`: latest stable Fedora plus rawhide on x86_64 and aarch64, and `centos-stream-10` on x86_64 and aarch64, with `centos-stream+epel-next-9-*` denied because EPEL Next 9 lacks the WebKitGTK 4.1 / libsoup3 stack. Launchpad publishes `ppa:fiorix/chan` for the Ubuntu series named in `.github/workflows/publish-downstream.yml:181` (`noble resolute`), amd64 and arm64, from the source dirs under `packaging/distros/debian/chan-desktop/`. The AUR carries both recipes from `packaging/distros/arch/aur/chan-desktop/PKGBUILD.in`, with x86_64 gating publication and native aarch64 observed-only for now (`packaging/distros/arch/README.md:23`, `packaging/distros/arch/README.md:63`).

The uncovered gap is real and should be stated rather than papered over: there is no Debian channel at all, only Ubuntu via the PPA, and no RPM channel outside Fedora, rawhide and CentOS Stream 10. Users on Debian, openSUSE or an older Ubuntu series keep the universal AppImage, which the same job continues to ship.

The blocker is the desktop entry. Among chan's release artifacts, only these four install a system `.desktop` file that claims `x-scheme-handler/chan`, which is what carries the OAuth callback back into the desktop app. Source-level evidence says they never delivered it: chan's own hand-written entry sets `Exec=chan-desktop %U` and `MimeType=x-scheme-handler/chan;` (`packaging/distros/shared/chan-desktop.desktop:5`, `packaging/distros/shared/chan-desktop.desktop:9`) and is what the distro packages install (`packaging/distros/fedora/chan-desktop.spec:66-67`, `packaging/distros/arch/aur/chan-desktop/PKGBUILD.in:73-74`, `packaging/distros/debian/chan-desktop/debian/rules:50-51`), while the Tauri bundle config declares no Linux desktop-entry template at all (`desktop/src-tauri/tauri.conf.json:51-53` sets only `linux.deb.depends`), so the bundler's generated entry is used and it carries no `%u`/`%U` field code for the deep-link plugin registered at `desktop/src-tauri/tauri.conf.json:21-25`. That argument is source-level, not observed on an installed package, so the safe order is to land the loopback redirect for desktop gateway sign-in first, which makes the scheme handler irrelevant, then drop these artifacts.

## Desired contract

A GA release publishes no self-built desktop `.deb` or `.rpm`. Linux desktop users get the AppImage from the release page, or a maintained package from COPR, the PPA or the AUR. `/dl` metadata, the downloads page and the release-asset verifier list exactly the artifacts that exist, with no desktop `deb`/`rpm` download entries.

The drop is a staging-only change in `release.yml`: remove the `deb` and `rpm` glob lines from the loop at `.github/workflows/release.yml:352-355`, leaving the AppImage. `desktop/src-tauri/tauri.conf.json:35` keeps `"targets": "all"`. Narrowing it would break the local multi-distro path: `packaging/sdme/build-chan-desktop.sh:121-124` assigns `bundle_paths` from a single `ls` over the appimage, deb and rpm globs under `set -euo pipefail` (line 29), and an unmatched glob makes that `ls` fail the whole script. The bundler keeps emitting all three formats; CI simply stops shipping two of them.

Every consumer that names these four assets must change in the same commit:

- `web/packages/marketing/scripts/verify-release-assets.mjs:31-34`, the required-asset list checked against the uploaded release.
- `web/packages/marketing/scripts/collect-release-assets.mjs:36-39`, the manifest builder.
- `web/packages/marketing/scripts/generate-release-metadata.mjs:58-88`, the four `desktop-linux-{deb,deb-arm64,rpm-amd64,rpm-arm64}` download entries.
- `web/packages/marketing/scripts/smoke-release-assets-manifest.mjs:236-239` and its prerelease assertions at lines 66-67.
- `web/packages/marketing/scripts/smoke-release-metadata.mjs:38` and lines 119-120.
- `web/packages/marketing/fixtures/release-assets/v0.15.4.json:38-55`, the four fixture asset entries.

A missed consumer is not a one-release problem. `preserve-release-metadata.mjs:37-46` re-runs the collector and generator over the latest five GA releases for any Pages deploy, so a stale required-asset expectation breaks every future site build, not just the release that dropped the packages.

## Acceptance

- `npm run check` in `web/packages/marketing` is green; it runs `smoke-release-assets-manifest.mjs` and `smoke-release-metadata.mjs` among the node checks (`web/packages/marketing/package.json:20`).
- The full pre-push gate is green, including `actionlint` over the edited `release.yml`.
- `node scripts/collect-release-assets.mjs --tag <previous GA tag> --latest-count 5` followed by `generate-release-metadata.mjs` over the real GitHub Releases history produces `/dl` output with no `desktop-linux-deb*` or `desktop-linux-rpm*` entries and does not fail on historical releases that still contain those assets. Collection over past releases must tolerate their presence; only generation stops emitting them.
- On the GA run, `npm run verify:release -- --tag <tag>` passes against the uploaded set, and the release page lists the AppImage plus the CLI, gateway, Windows and macOS artifacts, with no `Chan_<version>_*.deb` or `Chan-<version>-1.*.rpm`.
- Owner-only, on real hardware, after the loopback redirect item lands: confirm on the release that a `chan://` OAuth callback completes for a desktop app installed from the AppImage and from one distro package, so no user loses a working sign-in path. This cannot be proven in CI: it needs a session bus, a desktop environment and a browser session.

## Boundaries

- Staging-only edits to `.github/workflows/release.yml`, plus the six consumers listed above. No change to `desktop/src-tauri/tauri.conf.json`, no change to `packaging/sdme/build-chan-desktop.sh`, no change to any file under `packaging/distros/`.
- Prose in `docs/contributing/linux-and-macos.md:77` and `docs/contributing/linux-and-macos.md:144` describes which bundles `release.yml` ships; update those sentences to match, do not restructure the documents.
- Do not touch the gateway `.deb` packages built by the separate job at `.github/workflows/release.yml:259-276`; they are the only server-side packages and are unaffected.
- Do not add a Debian or openSUSE channel in this item. Naming the gap is in scope; filling it is a separate roadmap item.
- Ordering is a hard dependency: this item does not land before the loopback redirect for desktop gateway sign-in.
