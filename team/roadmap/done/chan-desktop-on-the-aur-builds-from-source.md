# chan-desktop on the AUR builds from source

Status: shipped in [v0.123.0](../../release/release-v0.123.0.md).

Record before the release: built on 2026-11-03 in another of the owner's sessions on the local branch `chan-desktop-bin` over `main` at `12b1da9d6`, and folded into v0.123.0 during its cut by the owner's word ("Fold in, round 3"); shipped in the same release, with no row of its own before the GA.

## What was there

The AUR carried `chan` and `chan-desktop`, both source recipes: installing the desktop on Arch, CachyOS or Omarchy compiled the whole Rust workspace and the web bundles on the user's machine.

## Desired contract

1. A `chan-desktop-bin` AUR package installs the same desktop prebuilt, from an asset on the GitHub release, so nothing compiles on the user's machine. It provides `chan` and `chan-desktop` and conflicts with both, and declares x86_64 only.
2. The asset is the `usr/` tree of a `chan-desktop` package built from the GA tag by the `chan-desktop` recipe itself, on an Arch Linux Archive snapshot dated six weeks before the tagged commit, so it runs on systems that far behind current Arch; the commit date picks the snapshot, so a rebuild of one tag links against the same libraries.
3. The asset's upload and the AUR push run in a chain of their own in `publish-downstream` (`aur-bin-validate`, `aur-bin-publish`), so a failure there holds back neither `chan` nor `chan-desktop`; a published asset is never replaced, since its name carries the pkgrel.
4. `ci.yml` builds the asset on the snapshot and installs and smokes the prebuilt recipe beside the two source legs; `make build-matrix-check` holds the prebuilt package's depends equal to `chan-desktop`'s and pins its provides, conflicts and arch.

## Closing

Two commits, cherry-picked onto the v0.123.0 staging branch with the patch ids of the originals: `a65870f7e` (from `39f472289`), ci(aur): move the AUR publication steps into publish-aur.sh, which keeps the existing AUR push and its checks in one script the new chain shares; and `08aa45220` (from `c2a0f4538`), feat(packaging): publish chan-desktop-bin to the AUR.

Verification recorded in the second commit: `build-in-ci.sh` under rootless podman for v0.122.0 built, tested, installed and smoked `chan-desktop` on the 2026/09/21 snapshot and packed a 25.7 MB asset, then namcapped, installed and smoked `chan-desktop-bin` from it on the current image; the asset's binary ran on a CachyOS host with webkit2gtk-4.1 2.54.2 and glibc 2.44 and needs GLIBC_2.39 at most; mutations of the snapshot flag, the lag, the asset check and the name check each fail the stub test. At the fold: `make shell-check`, `make workflow-check`, `make build-matrix-check`, `make sdme-contract-check`, `test-build-in-ci.sh` and `test-build-with-sdme.sh` green on the picks, and a read-only review of the series found no defect that fails or blocks the release or the other publication jobs; it ran the asset publication step against stand-ins, green on a fresh upload and on an existing asset with the same bytes, red on different bytes, a broken asset or a missing checksum.

Open: the asset upload and the AUR push first run at the v0.123.0 tag; the snapshot's Arch rust must meet the workspace's rust-version; the chan.app install page lists the package once it exists on the AUR; aarch64 keeps the source package.
