# The Windows uninstaller leaves chan's shims, Path entry and state behind

Status: raised at the v0.124.0 close from the round's clean Windows 11 guest; not started.

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
