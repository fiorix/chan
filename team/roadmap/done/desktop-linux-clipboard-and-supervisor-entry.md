# Linux clipboard survives a copy, and generated supervisors keep the chan entry point

> Status: shipped in [v0.78.0](../../release/release-v0.78.0.md): native clipboard operations run off the Tauri invoke thread, Linux holds one process-wide clipboard handle so a copy survives long enough for the session to take it, and the systemd/launchd writers select a `chan`-named executable instead of persisting the desktop binary.

Three fixes that were found and fixed together on Linux. Each is independently reachable; they share only the platform.

## 1. Native clipboard operations blocked the invoke thread

A Tauri command that is not `async` runs on the main thread, so the six native clipboard commands held it for as long as `arboard` took. On X11 that is unbounded: probing a target the selection owner never answers stalls for seconds, and the window could not even render the `cs paste` request card while it waited, which reads as a frozen app.

macOS keeps the commands synchronous, because NSPasteboard must be touched from the main thread. Every other platform exposes the same six names as async commands running through `tauri::async_runtime::spawn_blocking`, with one process-wide `OnceLock<Mutex<()>>` taken inside the blocking closure to preserve the mutual exclusion the single invoke thread used to provide for free. A queued operation now parks a pool thread rather than the async runtime.

`arboard` also gains `wayland-data-control`, target-gated to non-macOS unix, so a Wayland session uses the wlr data-control protocol instead of being served through XWayland's X11 selection. It adds no shared library the desktop binary did not already link.

## 2. The Linux clipboard handle was dropped too fast for the copy to survive

X11 and the wlr data-control protocol serve a selection FROM THE OWNING CLIENT: the bytes live in the owner, not in the display server. Every clipboard operation created its own `arboard::Clipboard` and dropped it in the same expression, so a `cs copy` owned the selection for microseconds and released it before the session's clipboard manager could take a copy. The paste target kept seeing the previous contents, and `arboard` said as much in its own drop-time warning. Measured on X11 plus Plasma: dropping immediately loses the contents; holding the handle 250ms keeps them.

The six operations now acquire through one `on_clipboard` helper. On Linux it owns a single process-wide handle, connected on first use and reused, so chan stays a real selection owner. A failed operation discards the handle, because a handle whose connection died with its X session would otherwise fail every later operation for the life of the process; a poisoned lock reconnects for the same reason.

Off Linux the helper is `Clipboard::new().and_then(|mut c| op(&mut c))`, so each command expands to the expression it already had. That is deliberate: NSPasteboard is a server-side clipboard, so handle lifetime carries no meaning there, and on Windows `Clipboard::new()` OPENS the OLE clipboard, which must be closed promptly or every other app is locked out of it.

## 3. Generated supervisors pointed at the desktop GUI

chan-desktop dispatches the CLI only when invoked through a `chan` name, so a supervisor's executable basename IS the personality selector. Distro packages ship `/usr/bin/chan` as a symlink to `chan-desktop`, and `current_exe()` on Linux reports the symlink TARGET, so the unit writer persisted `ExecStart=/usr/bin/chan-desktop devserver`: a unit that starts the desktop GUI instead of the devserver. Reproduced on Arch with the shipped 0.77.0 binary.

`resolve_relaunchable_exe` splits into live discovery plus a pure `select_relaunchable_exe`, which prefers a `chan`-named `current_exe()`, then an existing `chan` sibling next to a `chan-desktop` binary (the distro layout), then the CHAN_HOME-aware local `bin/chan` shim (the macOS `.app` and AppImage layouts, where nothing under the bundle or the ephemeral AppImage mount is a stable entry point). This replaces the old `$APPIMAGE` preference: the AppImage launches the GUI, and its mount path is gone by the next boot. A desktop binary with no `chan` entry point anywhere is now a clear error instead of a supervisor that would launch the GUI.

The selected path is deliberately NOT canonicalized; resolving a `chan` symlink back to `chan-desktop` is the bug. The same resolver feeds the systemd and launchd writers and the `--service=chan` daemon re-exec, which had the same wrong-personality hazard.

## Validation

Clipboard handle reuse, discard-after-failure, and cache-nothing-on-failed-connect were each mutation-checked: never reusing, and keeping a broken handle, each fail the test. A current-thread async test proves a short timer progresses while a 200ms operation runs and fails if the operation runs inline; a concurrency test proves operations never overlap under the guard. The supervisor selector has a table-driven pin over the standalone CLI, distro sibling, local shim, AppImage run, unrecognized name, missing `current_exe`, and both no-entry-point errors, asserting no selection is ever the desktop binary, plus a pin that the generated systemd `ExecStart` and launchd `ProgramArguments` both start `chan devserver`.

Verified live on Arch against a real `chan` -> `chan-desktop` symlink: the shipped binary writes `chan-desktop`, the patched one writes `chan`, and a planted broken unit is repaired.

## Known gaps

The Wayland data-control path and the macOS and Windows clipboard branches were compile-checked, not exercised on their platforms; the measured evidence is X11 plus Plasma. launchd generation is pinned by test, not run on a real macOS host.
