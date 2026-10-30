# A local terminal window cannot show the desktop behind it

Status: built on `desktop/terminal-prototypes` by 2026-10-30 (commits `1b66ab60f`, `fc97aef28`, `cff4cb0a1`, `25165529a`, `e63b637f1`); read by eye on macOS by the owner and measured on Linux under a compositor on 2026-10-30 (the section Built and verified); no item was written while it was built, so this record is written from the commits and the readings; closes at the GA.

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
