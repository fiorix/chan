# A standalone terminal window loads no saved shortcut overrides

Status: accepted for v0.130.0 by the owner on 2026-11-13; built on 2026-11-14 on the branch `v0130/terminal-window-shortcuts`, not merged; the section "Built" holds the evidence.

Record: left as built for the owner by the command deck's lanes, their point 6: "A standalone terminal window loads no saved shortcut overrides. This is the same on main." The owner: "it should, let's add an item for next version" (`dev/command-launcher-revamp/handoff.md`, "For the owner to decide"; quoted in the [command launcher row](../done/the-command-launcher-is-one-flat-list-behind-dead-keys.md)).

## What is there now

Read at v0.129.0's content (`97210264c`), and the same at v0.128.0 (`8ded1bda9`):

- A shortcut assigned in Settings is saved in the preferences' `[shortcuts]` table (`crates/chan-server/src/preferences.rs`). A window resolves its chords with the saved shortcuts once `hydrateOverrides` (`web/packages/workspace-app/src/state/keymapOverrides.svelte.ts`) has loaded them. Its one caller is `applyServerPreferences` (`web/packages/workspace-app/src/state/store.svelte.ts`), which a workspace window runs at boot and on every `config_changed`, and which returns at once in a window with no workspace.
- A standalone terminal window reads the same preferences, its shortcuts among them, from `/api/config`, which the terminal tenant's router serves for reading and writing (`terminal_router`, `crates/chan-server/src/lib.rs`), through `refreshStandalonePreferences`, at boot and on every `config_changed`. That function deliberately does not run `applyServerPreferences`, which would switch the docked file browsers back on and fight the launcher's theme there; it applies the per-surface body themes alone. So the saved shortcuts are never loaded there, and the window's chords stay the defaults.
- The drop of saved chords for the 43 retired command ids runs inside `hydrateOverrides`, so a standalone window neither loads an override nor drops a retired one. On the owner's Mac on 2026-11-13 the status line "Dropped saved shortcuts for 1 removed command" showed once on a workspace window and never on the standalone terminal window (`dev/v0129/owner/reports/parts-abc-at-8a44e110e.md`, Part C, `retired-1`).

## Desired contract

1. A standalone terminal window resolves its chords with the saved shortcut overrides, as a workspace window does, when it loads and after a change saved from another window.
2. A saved chord for a retired command id is dropped there as it is in a workspace window.
3. Nothing else of the workspace window's preference mirror comes with it: the docked file browsers and the theme stay as the standalone window sets them.

## Boundaries

- The workspace app's loading of preferences in a window without a workspace (`refreshStandalonePreferences`) and the override table (`keymapOverrides.svelte.ts`). The server already serves the preferences to that window, so no route changes by the reading above.
- Not here: which commands a standalone window offers, or the Keyboard Shortcuts grid's editing there.

## Acceptance

1. Tests over a window without a workspace: a saved override resolves its chord after load and after a `config_changed`, and a saved retired id is dropped; each red on the code without the change.
2. On chan-desktop, a shortcut changed in Settings works in a standalone terminal window, opened before the change and after it (the owner on macOS, or a desktop guest on Linux).

## Built

On the branch `v0130/terminal-window-shortcuts` over `v0130/int` (`7ed970eb3`): `45f1ba8a5` fix(web), and this row's commit.

What changed. `refreshStandalonePreferences` (`web/packages/workspace-app/src/state/store.svelte.ts`) hands the saved shortcuts of the `/api/config` payload it already reads to `hydrateOverrides`, beside the per-surface body themes, at boot and on every `config_changed`, and takes nothing else of `applyServerPreferences`' mirror. The retired-id drop runs inside `hydrateOverrides`, so the window writes the saved table back without a retired row and says so in its status line. The terminal tenant's router already serves GET and PATCH `/api/config` (`terminal_router`), and a write through another tenant reaches its windows through the config watch, so no route changed. The workspace app's design document says which windows load the table.

Tests, red then green. `src/App.standaloneShortcuts.test.ts` mounts the app in a `?kind=terminal` window over the demo transport: a saved chord for Settings resolves (`chordFor`), runs Settings and takes the built-in Ctrl+, out of play at load; the same after a change saved from another window and a `config_changed`, and a cleared change brings the built-in back; a saved retired row (`app.theme.dark`, and `app.pane.focusColor.blue` arriving with a change) is dropped from the saved table with "Dropped saved shortcuts for 1 removed command"; and at load and after a change the docked file browsers stay off and the theme stays the launcher's, though the saved preferences turn both docks on and choose light. Six of the seven tests are red on the unchanged code and all seven green with the change. Mutations: without the hydrate line the same six go red; a fix that also mirrors `browser_side_panes`, or the theme, turns the two contract 3 tests red. `make web-check` is green on the committed tree.

On chan-desktop. A reading in an sdme guest (rootfs `chan-e2e-desktop`, with openbox, xdotool, ImageMagick, xclip and python3-gi added) drives a debug chan-desktop on WebKitGTK 2.52.6 under Xvfb by X input, reading the pages through the engine's inspector, on each terminal backend. The chan home starts with one saved chord, for `app.theme.dark`; the desktop boots into one standalone terminal window, which drops the row from `preferences.toml` and says so, and a second one (a `chan-term` handed to the desktop) opened over the cleaned table says nothing of it. In both, with the terminal clicked into, Ctrl+Alt+Y opens nothing and Ctrl+, opens Settings. In a workspace window, Ctrl+, by X input opens Settings; through the inspector the Keyboard Shortcuts section is chosen, the grid filtered and the Settings row's Linux cell clicked, and Ctrl+Alt+Y by X input into the grid's capture saves `linux = "Mod+Alt+Y"` through the grid's own write. Then in both windows opened before the change, and in a third opened after it, Ctrl+Alt+Y pressed into the focused terminal opens Settings and Ctrl+, opens nothing. With the change: PASS on ghostty and on xterm.js. With the base web bundle under the same binaries: every subject arm is a fault on both backends while every control holds; the retired row stays saved, no window says anything, and Ctrl+Alt+Y opens nothing in any standalone window.

Not observed: WKWebView on macOS and WebView2 on Windows; the owner's walk on macOS (Cmd chords, the `macos` slot); a change made in a standalone window's own Keyboard Shortcuts grid, which the row leaves out.
