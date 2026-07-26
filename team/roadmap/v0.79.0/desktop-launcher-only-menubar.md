# Launcher-only menubar on Linux and Windows

Status: REGISTERED for v0.79.0. Implemented on branch `desktop-launcher-only-menubar`, based on the v0.78.0 GA commit. Not yet merged or gated.

## What

Off macOS, only the Chan Launcher window carries a native menubar. The app-wide default menu and the per-window-kind bars (the workspace hamburger mirror, the owned terminal and control shapes, the `wscmd:` and `ws-*` id namespaces) are removed. The launcher bar attaches per window through `Window::set_menu` when the launcher is built, and every other window is born menu-less.

macOS is untouched: the global menubar still owns every chord there.

## Chord routing

The chords the retired menubars owned move into `KEY_BRIDGE_JS`, injected per window so routing stays contextualized to the invoking window:

- `Ctrl+Shift+N` opens another window of its own connection, so a control terminal yields a standalone terminal.
- `Ctrl+Q` runs the same confirm-then-quit flow as the menu item.
- `Ctrl+Shift+T` on a control terminal spawns a standalone terminal instead of toggling a tab it does not have. The window kind is stamped via `window.__CHAN_WINDOW_KIND__`.

The launcher never loads the bridge, so its native menu chords cannot double-fire. The new bridge cases are gated on `!metaKey`, which keeps macOS routing unchanged.

## Boundaries

The branch touches `desktop/src-tauri/src/main.rs`, `desktop/src-tauri/src/serve.rs`, and `desktop/src-tauri/permissions/app.toml`. It is a net deletion in `main.rs`.

The v0.78.0 clipboard work lives in the same file. The branch preserves it: the `on_clipboard` helper, `with_cached_clipboard`, the `spawn_blocking` command split, and the `wayland-data-control` feature are all present at the same call counts as `main`.

## Acceptance

- Every chord the retired menubars owned still fires on Linux and Windows, from each window kind that used to own it.
- The launcher's native menu chords do not double-fire.
- macOS menubar behavior is unchanged, including chords gated on `metaKey`.
- No window other than the launcher is born with a menubar off macOS.
- `make pre-push` green, including `host-build-check`, which builds the native desktop package.
