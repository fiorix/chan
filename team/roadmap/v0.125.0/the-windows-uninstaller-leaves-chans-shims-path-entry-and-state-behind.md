# The Windows uninstaller leaves chan's shims, Path entry and state behind

Status: built for v0.125.0 and carried in its first release candidate `0.125.0-rc0` (`67fd26b38`); read in a clean Windows 11 guest against the v0.124.0 installer.

## What was seen

A silent uninstall of chan-desktop through its own NSIS uninstaller, read in the guest after the Windows desktop WireGuard run and the VC runtime proof, removes the desktop itself and leaves:

- the `chan` and `cs` shims (a `.cmd` wrapper and a POSIX one each) in `%LOCALAPPDATA%\chan\bin`, which point at the removed `chan.exe`, so `chan` and `cs` in a new shell fail;
- that directory on the user `Path`, which the desktop appends at launch (`install_bin_shims` in `desktop/src-tauri/src/cs_install.rs`);
- `~\.chan`, the library's state;
- the webview's data under the `app.chan.desktop` identifier;
- the installer's own key, `HKCU\Software\chan\Chan`.

`scripts/e2e/desktop-wireguard-windows.sh` removes all of these itself after its run, and puts the user `Path` back to the value it recorded, because the uninstaller does not. [the-nsis-uninstaller-stub-ships-unsigned](../done/the-nsis-uninstaller-stub-ships-unsigned.md) is the uninstaller's other closed item.

## Desired contract

A decision for the owner, then the build. A proposal: the uninstaller removes what the install and the desktop made that points at the install, the shims, their directory when it is left empty, the `Path` entry the desktop added and the installer's key; it keeps the user's state, `~\.chan` and the webview data, unless the user asks for them to go (as the Homebrew cask's `zap` does on macOS), and an interactive uninstall offers that choice.

## Acceptance

1. In a clean Windows guest: install, launch once, uninstall silently; the shims, their directory, the `Path` entry and the installer's key are gone, the user `Path` reads as it did before the install, and `~\.chan` is kept.
2. The same with the user's choice to remove state: `~\.chan` and the webview data are gone too.
3. `desktop-wireguard-windows.sh`'s cleanup check finds nothing left by the uninstaller.

## Built

Four commits: `69b0b95ba` (an NSIS uninstall hook, `desktop/src-tauri/windows/installer-hooks.nsh`, named by both Windows configs and skipped on the self-updater's `/UPDATE` run, deletes the shims in `%LOCALAPPDATA%\chan\bin` that carry the desktop's marker and the directories they leave empty, drops the shim directory from the user `Path` with the other entries joined back byte for byte and the value's type kept, deletes `HKCU\Software\chan\Chan`, and with the state choice removes `~\.chan` beside the template's webview data under `app.chan.desktop`; the desktop records each `Path` append under the installer's key, so a value the uninstall empties is kept, empty, when that record says it existed before the append, and deleted otherwise), `7a949166b` (`desktop-wireguard-windows.sh`'s cleanup checks what the uninstaller left instead of repairing it, names each miss "left by the uninstaller" and fails the run, and requires `~\.chan` and the webview data to survive the silent uninstall), `e169e8f5e` (the Windows verify steps of `release.yml` and `release-desktop.yml` throw when the installer's key survives the silent uninstall), and `347e9a1f6` (`uninstall.exe /S /PURGE` makes the state choice on a scripted uninstall, while `/S` alone keeps the state; the template's `/P` prefix test also makes `/PURGE` passive).

Verification: on Linux, the `Path` record, append and removal round-trip tests and the hook-shape tests (both configs name the file, each macro sits inside the update guard, `~\.chan` only under the state choice, no prompt) passed, and 21 mutations of the record, the append and the hook, at `69b0b95ba` and again at `347e9a1f6`, each failed at its own assertion. The Desktop Package Dry Run `42202598807` at `347e9a1f6` passed on all three platforms; its Windows job compiled the hook, and its verify step's key assertion passed on the runner's silent uninstall. That run's Windows installer was then read in a clean Windows 11 guest, each check after a silent install and one launch, with the published v0.124.0 installer as the red:

- Silent uninstall: the install directory, the shims and their directory, the installer's key, the uninstall entry and both shortcuts are gone, the user `Path` reads as before the install with the same type, and `~\.chan` and the webview data are kept. v0.124.0 left `%LOCALAPPDATA%\Chan\bin` with its four shims, the key and chan's `Path` entry.
- `/S /PURGE`: the same, with `~\.chan` and both the local and the roaming webview data gone too. v0.124.0 left the same four and also `~\.chan` and the webview data. The interactive uninstall's checkbox, which sets the same choice, was not clicked in the guest.
- An entry of the user's appended behind chan's (`;C:\keep-me`): the `Path` reads as before the install plus that entry, type kept. v0.124.0 kept chan's entry ahead of it.
- The uninstaller run with `/S /UPDATE` keeps the shims, the `Path` entry, `~\.chan` and the key; a plain `/S` after it removes them as above.
- The workflow's key assertion, run in the guest after the silent uninstall, passed on the branch and threw on v0.124.0 with `Silent NSIS uninstall left HKCU:\Software\chan\Chan`.
- `desktop-wireguard-windows.sh`, against the guest and a kernel WireGuard peer, passed every arm with the branch installer, the uninstaller exiting 0 and the cleanup finding nothing left; with v0.124.0 every arm passed and the cleanup failed the run, naming the shim directory with its four shims, the installer's key and the user `Path` as left by the uninstaller.
