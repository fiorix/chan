# The Linux AppImage does not self-upgrade

Status: SHIPPED in [v0.95.0](../../release/release-v0.95.0.md). Landed from `feat/appimage-self-upgrade` (87d8c3ed) through intake; the close review serialized the two update drivers and made a handoff that finds the on-launch install done relaunch instead of downloading again (f2e51b86). The macOS compile of the widened arms and the runner-side signing are proven by the release `publish=false` dry run only.

## Problem

Of chan-desktop's release channels, only macOS self-upgraded: the DMG and the Homebrew cask ride the Tauri updater, while the Linux AppImage was a no-op on launch and `chan upgrade` against it opened a window only to answer that desktop upgrade over hand-off is not supported on linux. The AppImage is the one Linux channel that can self-upgrade: the package-manager builds (COPR, PPA, AUR, Nix) are stamped `CHAN_PACKAGED` and must keep refusing, because the package manager owns their update path, and the Tauri-emitted `.deb`/`.rpm` have no channel. The updater plugin already has a real AppImage installer that renames the current image aside on the same filesystem, writes the verified payload over `$APPIMAGE`, and restores the backup on failure; relaunch resolves `$APPIMAGE` too, and the `~/.local/bin/{chan,cs}` shims `exec` that same path, so an in-place overwrite leaves every entry point valid. What was missing was on chan's side: the updater arms were compiled for macOS only, the release jobs signed only the macOS payload, and the `/dl` collector knew no Linux updater entries.

## Direction

- The four updater arms (handoff upgrade, the on-launch check, the update-ready notice, the restart after install) compile for macOS and Linux, gated at runtime on `$APPIMAGE`: a Linux desktop not started from its AppImage refuses with a pointer instead of launching a window or fetching anything (`linux_updater_refusal`).
- The release workflow's Linux desktop job fails fast without the updater signing key, minisigns each AppImage with `cargo tauri signer sign`, and stages the detached `.sig` beside it; the dry-run workflow mirrors the step.
- The `/dl` collector decorates the existing AppImage records with `linux-x86_64` / `linux-aarch64` updater entries (payload plus signature), optional for archived releases that predate signing and required for the release being cut, so the retained-release window never fails the Pages build; `updaterPayloads` in the marketing release-assets script is the single source for the payload-to-platform map, and the release-asset verifier requires every `.sig` of the release under verification.
- The documentation names the three signed payload shapes and the manual-recovery path (download the AppImage by hand) where it used to say macOS-only.

## Acceptance

- `linux_updater_refuses_outside_an_appimage` pins the refusal; the marketing smokes pin the collector's archived-release optional rule, the decorate-in-place rule, and the verifier's `.sig` requirement; `make workflow-check` covers the signing steps.
- End to end, against a real AppImage built from the branch with a throwaway updater key, under Xvfb in a build container: a handoff `chan upgrade` replaces the image in place (new inode, payload sha) and relaunches a desktop with the same `$APPIMAGE`; the on-launch check downloads, installs, and notifies the launcher without restarting; a loose `chan-desktop` binary with no `$APPIMAGE` refuses both `chan upgrade --check` and `chan upgrade` without a window or a network fetch; a bad signature leaves the image byte-identical at the same inode. All four passed.
- The full gate is green on the branch in the build container.
- Not proven in the round, and named as gaps: the macOS compile of the widened `cfg` arms (no macOS host; the release `publish=false` dry run is the check) and the runner-side signing step (exercised by the same dry run, first run for real at the GA tag).
