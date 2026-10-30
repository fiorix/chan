# A local terminal window cannot show the desktop behind it

Status: shipped in [v0.116.0](../../release/release-v0.116.0.md); the section Built and verified holds the macOS and Linux readings, and the record of 2026-10-30 after it the change that builds every local terminal window transparent so the setting applies live. Not read by eye: the light theme in a see-through window; FreeBSD and Windows.

Record before the release: built on `desktop/terminal-prototypes` by 2026-10-30 (commits `1b66ab60f`, `fc97aef28`, `cff4cb0a1`, `25165529a`, `e63b637f1`); read by eye on macOS by the owner and measured on Linux under a compositor on 2026-10-30 (the section Built and verified); no item was written while it was built, so this record is written from the commits and the readings; the owner then found a macOS window opaque at a setting below 100, and every local terminal window is now built transparent (the section Every local terminal window is built transparent); closes at the GA.

## What was asked

The owner asked for a see-through terminal background, the way `background-opacity` works in other terminal emulators, for chan-desktop's local terminal windows. Before the build every chan-desktop window was built opaque, and the page painted the terminal background, the pane face and the workspace backdrop as solid colours, so nothing of the desktop could show through.

## Desired contract

- `terminal.background_opacity` is a `server.toml` key under `[terminal]`: a whole percent from 80 to 100, 100 the default and opaque. `chan config set terminal.background_opacity N` and Settings > Terminal > Background opacity (a slider in steps of one, showing 100 as "100% (off)") write it; the preferences route clamps it on write; a stored value under 80 reads as 80. The range starts at 80 because the values people use sit just under opaque, and a coarser slider offered only 90 and 95 before 100.
- Transparency is decided when the native window is built, because Tauri has no runtime toggle. A local standalone terminal window and the default-terminal `terminal-exec` window are built transparent while the value is below 100, read from the same `server.toml` the preferences route writes, and their URL carries `transparent=1`; workspace windows, devserver windows, control terminals and a window built while the value was 100 stay opaque and carry no flag. Values below 100 apply live; a window built at 100 stays opaque until it is reopened, and the Settings hint says so.
- In a transparent window only the terminals are see-through. Both renderers are built with `allowTransparency` and a fully transparent default background that keeps its RGB (xterm.js draws inverse-video text with it); the tint is painted once on `.terminal-tab` at the live opacity; the pane face under a terminal and, below 100, the page body are clear; the workspace backdrop that wraps every pane keeps painting the gutters and the frames around panes and splits, as a layer of its own (`main::before`) masked with a hole behind each pane card showing a terminal, rebuilt on a resize of the backdrop or a face and on a structural change.
- On macOS the native title bar stays opaque: a transparent window clears it along with the content, so the desktop gives the title bar container an opaque layer in the window background colour, resolved for the appearance in effect when the window is built. The title bar itself is not marked transparent, because that lets clicks through it and moves the page up under it.
- The browser caret ghostty-web's contenteditable host would draw at the host's left edge is hidden (`caret-color: transparent` on `.terminal-host`): the renderer's canvas no longer covers it once the canvas is see-through, and the terminal draws its own cursor.
- Moving a settings slider changes nothing beside it: the value label keeps the width of its widest form and a save flashes the value instead of putting a note in the row, so the slider no longer narrows under the pointer mid-drag.

## Boundaries

`crates/chan-library/src/config.rs` (the key, its default and bounds), `crates/chan-server/src/routes/preferences.rs` (the clamp), `crates/chan/src/config.rs` and `help.rs` (the `chan config` key and its range), `desktop/src-tauri/src/serve.rs` (`builds_transparent`, the URL flag, the macOS title bar layer), `web/packages/workspace-app/src/terminal/backgroundOpacity.ts` and `seeThroughBackdrop.ts`, `App.svelte`, `TerminalTab.svelte`, `terminal/backend.ts`, the settings slider components (`SettingField.svelte`, `SliderField.svelte`, `TerminalSection.svelte`, `commit.ts`), `desktop/design.md`, `docs/config-reference.md`.

Known gaps, as built: light-theme contrast correction is off in a transparent window; ghostty treats cells with an explicit black background as clear; a transparent macOS window loses automatic window tabbing; Linux needs a compositor.

## Acceptance

1. Unit tests: the clamp and default in chan-library and the preferences route, `builds_transparent` for every window kind, the page helpers (`backgroundOpacity.test.ts`, `seeThroughBackdrop.test.ts`), the caret pin (`terminalHostCaret.test.ts`), the slider row pins (`fields.test.ts`); clippy with warnings denied; svelte-check and vitest green.
2. By eye in the built app: a standalone terminal window opened below 100 shows the desktop through its terminal body while the tab strip, the pane frame and the text stay opaque; a window opened at 100 is opaque; on macOS the title bar is opaque with the tab strip below it.
3. Under a Linux compositor: the same reading for a standalone terminal window, the default-terminal window and a window restored at launch, against a window built at 100 as the control.

## Built and verified

macOS, by the commits of 2026-10-29 and 2026-10-30: clippy with `-D warnings` for chan-library, chan-server, chan and chan-desktop; the config, preferences, help-wrap and serve tests; svelte-check and the full vitest suite (607 files, 7884 tests at `e63b637f1`). The owner read the title bar opaque with the tab strip below it, the caret bar gone in a transparent ghostty window, and the slider in the desktop; a geometry probe on the running app showed the full-size content view with the content layout rect ending at the title bar. The backdrop mask was not checked by eye on macOS.

Linux, 2026-10-30, on a CachyOS host under Hyprland 0.57.0 (an unattended 1920x1080 output, WebKitGTK 2.54.2), with the debug build of `e63b637f1`, an isolated `CHAN_HOME` and `terminal.background_opacity = 80` written by `chan config set`:

- A standalone terminal window opened by a default-terminal handoff, the default-terminal window of an own process (`chan-desktop --title=... --dir=...`) and the window restored at the desktop's launch all show the compositor's wallpaper through the terminal body; a handoff window built at 100 under the same settings is flat. Read with `grim` captures after the open animation: the body's per-channel standard deviation is 1.2 at 100 and 1.4, 4.6 and 5.4 (R, G, B) at 80, with the same body mean within two units; the pane tab strip reads a standard deviation of 0 in every capture and the window's frame band the same values at 80 and 100, so the backdrop mask holds on WebKitGTK.
- With `terminal.ghostty = true` a handoff window at 80 shows no bright pixel in the band down the terminal host's left edge: no browser caret bar. Whether ghostty-web loaded or fell back to xterm.js cannot be told from outside; the setting was on and the terminal was new.
- Hyprland's own `active_opacity` and `inactive_opacity` were 1.0 and no window rule touched opacity.
- `cargo clippy -p chan-desktop --all-targets -- -D warnings` on Linux, green; the full `make pre-push` at `e63b637f1` green through every step but the host's AppImage bundling, which fails at origin/main the same way (linuxdeploy's bundled `strip` and the host's RELR sections).

The captures, the rig and the readers are in the `chan-dev` repository under `releases/v0116/terminal-prototypes-linux/`.

Not read: the light theme in a transparent window; FreeBSD and Windows.

## Every local terminal window is built transparent, 2026-10-30

The owner's words of 2026-10-30, after reading the ghostty masking build on the macOS desktop: "what's not working is the actualy transparency of the terminal, again.. perhaps something got lost in the rebase?"

Nothing was lost: every piece of the contract above is present at `7856e8f6c`, and the rebase touched only the web masking files and `terminal_sessions.rs`. Read on the macOS desktop with the debug build of `7856e8f6c` in an isolated `CHAN_HOME`, through `screencapture -l` of each window and the alpha of its pixels (a capture keeps the window's alpha: the rounded corners read 0):

- The first window opened while the value was the default 100, so it was built opaque, and it stays opaque whatever the slider says afterwards. This is the contract as written, and it is the trap: the slider moves, the open window cannot follow.
- `chan config set terminal.background_opacity 90` with the desktop running, then a new window: the terminal body read alpha 255 on xterm.js and on ghostty. The window was built transparent (the build reads `server.toml` from disk), but the page read 100 from its tenant's in-memory config, which only a `PATCH /api/config` through that tenant or a restart refreshed: `config_watch::start` ran for a standalone `chan serve` alone. The same gap kept a Settings write in one tenant's window (a workspace) away from another tenant's windows (the terminal windows).
- The same value written through `PATCH /api/config`: the two windows built transparent read alpha 229 (90%) at once and a new window the same; the tab strip and the title bar stayed at 255.

What changed:

- `builds_transparent` (`desktop/src-tauri/src/serve.rs`) no longer takes the setting: every local standalone terminal window and the default-terminal window is built transparent and carries `transparent=1`, and the page paints itself opaque at 100, so a change in either direction applies live to every open terminal window and nothing has to be reopened. Workspace windows, devserver windows and control terminals stay opaque. `chan_server::TERMINAL_BACKGROUND_OPACITY_MAX`, exported only for that build-time read, is gone.
- The light-theme contrast floor (xterm.js `minimumContrastRatio` 4.5) now drops to 1 only while the desktop shows through (a transparent window below 100), not in every transparent window, so building them all transparent does not take it from a light terminal at 100. ghostty-web skips a cell background of exactly black and fills the row with the theme background first in any window, so a transparent window at 100 paints what an opaque one does.
- `config_watch::ConfigWatch` (`crates/chan-server/src/config_watch.rs`) is one watch on the config directory for many tenants, held weakly and started with the first. `chan serve` keeps one for its tenant; the route layer behind chan-desktop and the devserver holds one for every tenant it mounts. On an event each tenant reloads and compares with its own copy, so the writer stays quiet and every other tenant refreshes its windows.
- The known gap "a transparent macOS window loses automatic window tabbing" was not a cost of transparency: Tauri turns automatic tabbing off for every window built without a tabbing identifier (`tauri-runtime-wry` 2.12.2, `lib.rs` 4436), chan sets none, and tao applies it app-wide through `NSWindow.setAllowsAutomaticWindowTabbing(false)` (`tao` 0.37.2, `platform_impl/macos/window.rs` 307). The desktop design no longer lists it; the known-gaps line above keeps it as it was written at the build.
- The Settings hint, `desktop/design.md`, `docs/config-reference.md`, the `TerminalConfig` doc comment and the page comments say the setting applies live to every open terminal window; `crates/chan-server/design.md` describes the config refresh.

Checks, 2026-10-30, macOS:

- Unit tests: `config_watch` gains `dispatch_refreshes_every_other_tenant_and_forgets_dropped_ones` (the writer stays quiet, the other tenant reloads 90 and pushes `config_changed`, a dropped tenant leaves the list) and `tenants_hold_no_tenant_alive`; `only_local_terminal_windows_build_transparent` pins the window kinds without a setting; `TerminalTab.theme.test.ts` pins the light floor in a transparent window at 4.5 at 100, 1 at 90 and 4.5 again live, and fails against the window-flag rule it replaces.
- The scoped gate after the last edit, with `RUSTFLAGS="-D warnings"`: `cargo fmt --check`, clippy with `-D warnings` and rustdoc for chan-server, chan-desktop and chan-library; `cargo test --all-targets` for the three, 3752 passed and 0 failed; `make web-check` green (workspace app 608 files, 7899 tests; launcher 64 files, 696; shared 8 files, 234; profile 5 files, 20; both production builds).
- In the debug desktop built from the change, in a fresh isolated `CHAN_HOME` with `terminal.ghostty = true`: the first window, built at the default 100, reads alpha 255 over its terminal body; `chan config set terminal.background_opacity 90` with the desktop running takes the same window to 229 without reopening it, and `chan config set terminal.background_opacity 100` back to 255; the tab strip and the title bar read 255 throughout.
- The owner moved the Settings slider in that build's open terminal window on the macOS desktop and read it working ("done testing, it works").

Not read: a Settings write in a workspace window reaching an open terminal window by eye (the dispatch test covers the mechanism); the light theme by eye; Linux, FreeBSD and Windows, where every local terminal window is now also built transparent and paints itself opaque at 100.
