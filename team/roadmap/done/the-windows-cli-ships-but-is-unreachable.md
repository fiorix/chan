# The Windows CLI ships but is unreachable

Status: SHIPPED in [v0.97.0](../../release/release-v0.97.0.md). Raised at the v0.96.0 close and implemented at `6ba42025`, with the replacement rollback description corrected at `a9d8b613`. Native Windows CI proves the installer and a real standalone self-replacement; the public `https://chan.app/install.ps1` fetch is necessarily a post-tag acceptance.

## Problem

chan already publishes a standalone Windows CLI and nothing can find it, ask for it, or update it.

`chan-x86_64-pc-windows-msvc.zip` is built by every release run and is a REQUIRED asset: `windowsAssets()` in `release-assets.mjs` returns it alongside the NSIS installer, `publish-release` gates on the `windows-artifacts` job, and the release verifier holds the release being cut to it. A Windows Server operator who knows the filename can download it from the GitHub Release today and it works.

Everything that would lead them to it is missing, in three independent places:

- **`chan upgrade` refuses.** `release_target_for` has no `("windows", _)` arm, so it bails with "no published standalone chan CLI release for windows/x86_64" for an asset the same release published. Below that, `extract_tar_gz` under `#[cfg(target_os = "windows")]` is a stub that bails "chan upgrade is not published for Windows": the extraction path is tar.gz-only, so even with a target row there is nothing that can unpack a zip.
- **There is no install path.** `install.sh` is a POSIX shell script served from `https://chan.app/install.sh`. Windows has no equivalent, so the documented install story stops at the platform boundary.
- **`/dl/cli/latest.json` does not list it.** `generate-release-metadata.mjs` emits no windows CLI target, and `update.rs` carries a test, `test_target_asset_for_rejects_unsupported_target`, that asserts the metadata does NOT include a standalone chan CLI asset for `x86_64-pc-windows-msvc`. That test currently passes because the generator omits it, so the absence is pinned rather than accidental.

The shape is exactly the FreeBSD gap v0.96.0 closed: the artifact was never the obstacle, the target row, the installer arm and the metadata entry were.

## The constraint that makes this more than three edits

Windows already has a `chan upgrade` that works, and it belongs to the desktop. The NSIS install ships a companion console `chan.exe`, and v0.95.0 deliberately routed its upgrade through the running desktop "instead of looking for a Windows CLI tarball that does not exist". That premise stops being true the moment `/dl/cli/latest.json` lists one.

So the work is not "add Windows to the target table"; it is teaching one binary to tell which of two installations it is:

- shipped beside a desktop install, where `chan upgrade` must keep driving the NSIS updater and must NOT replace itself out from under the installer's file inventory;
- unzipped standalone on a machine with no desktop, where `chan upgrade` should replace its own `chan.exe` from the published zip.

Getting that wrong in the first direction corrupts a desktop install; in the second it leaves the operator with the refusal they have today. The discriminator, and its test, is the real content of this item.

## Direction

1. **`chan upgrade` resolves the Windows CLI.** A `("windows", "x86_64") => ("x86_64-pc-windows-msvc", "zip", "chan.exe")` row, a zip extraction arm replacing the stub, and the installation discriminator above. Windows cannot replace a running executable in place, so the standalone path needs the rename-and-swap dance the AppImage and NSIS updaters already model.
2. **An install path.** A PowerShell installer at a stable URL, `irm https://chan.app/install.ps1 | iex` in the shape of the existing `install.sh`: detect architecture, resolve the published zip, verify its SHA-256, unpack, place `chan.exe` and the `cs` shim on PATH, and refuse honestly on an unsupported architecture. New surface, and the largest part of this item.
3. **Discoverability.** The install page and `docs/**` name the Windows CLI as a supported download rather than leaving it as an undocumented artifact.

## Boundaries

The desktop install and its NSIS updater path do not change behaviour. arm64 Windows is out unless the release starts building it; today `windowsAssets()` is x86_64 only. This item does not touch the `cs` client's own Windows shims beyond placing them on PATH.

## Acceptance

1. `chan upgrade` and `chan upgrade --check` resolve `chan-x86_64-pc-windows-msvc.zip` from `/dl/cli/latest.json` on a standalone Windows install and complete a real self-replacement.
2. A desktop install's companion `chan.exe` still routes `chan upgrade` through the desktop's NSIS updater and does not self-replace. Both directions of the discriminator are pinned by tests.
3. `test_target_asset_for_rejects_unsupported_target` inverts: the metadata now includes the windows target, so that assertion becomes its opposite rather than being deleted.
4. `irm https://chan.app/install.ps1 | iex` installs chan on a stock Windows Server box with no prior chan present, and refuses honestly on arm64.
5. The install page and docs list the Windows CLI.

## Evidence

- Implemented at `6ba42025`: the updater selects `x86_64-pc-windows-msvc`, extracts the exact top-level `chan.exe` from the zip under a 256 MiB cap, verifies SHA-256, swaps the running executable through a rollback-safe rename, and schedules deletion of the mapped backup. `a9d8b613` corrected the design text to describe that rollback boundary exactly.
- `web/packages/marketing/src/install.ps1` installs under `%LOCALAPPDATA%\chan-cli\bin` by default, verifies the exact release asset and digest, refuses unsupported architectures and foreign or desktop-owned shims, writes both `cs.cmd` and a Git Bash shim, and updates the user PATH idempotently. The install and manual pages expose the stable PowerShell command.
- The metadata generator includes the Windows CLI from v0.97.0 onward while retaining historical target truth. The updater tests select the zip, reject Windows arm64 by name, and pin both standalone and desktop-companion routing.
- Native Windows job `97389867646` in CI run `32713530630`, on exact implementation commit `a9d8b613`, built the release CLI and NSIS package; passed 361 desktop tests and 303 library tests; passed the release CLI and packaged-devserver smokes; and ended with `windows installer smoke: install, refusal cases, PATH, and self-upgrade PASS`. The smoke installs into an empty isolated `%LOCALAPPDATA%`, proves digest, ownership, architecture, PATH and shim refusals, then drives `chan upgrade -y --verbose` against local release metadata and confirms the installed executable's SHA-256 changes to the verified payload.
- `web/packages/marketing/scripts/release-assets.mjs`: `windowsAssets()` returns `Chan_${version}_x64-setup.exe` and `chan-x86_64-pc-windows-msvc.zip`, and the comment records that `publish-release` gates on the windows-artifacts job so the verifier requires both.
- The v0.96.0 dry-run artifact diff carried `chan-x86_64-pc-windows-msvc.zip` among the required assets, so the zip is real and current rather than historical.
- Before implementation, `crates/chan/src/update.rs` had no Windows release target, its Windows extraction arm was a bail stub, and `test_target_asset_for_rejects_unsupported_target` pinned the metadata's omission.
- v0.95.0's CHANGELOG records the desktop routing decision and its stated premise, a Windows CLI tarball "that does not exist", which is the assumption this item overturns.
