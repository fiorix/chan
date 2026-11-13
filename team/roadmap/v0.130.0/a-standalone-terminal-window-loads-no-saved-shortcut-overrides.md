# A standalone terminal window loads no saved shortcut overrides

Status: accepted for v0.130.0 by the owner on 2026-11-13; not started.

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
