# The Computers command launcher chord opens the same deck as the command launcher

Status: accepted for v0.114.0 by the owner's word of 2026-10-27; not started.

## What was asked

Found while rewriting the manual's Computers screen pages on 2026-10-27; the owner asked for it to be saved for later.

## Evidence

Read at `0119a1912`. `web/packages/workspace-app/src/state/shortcuts.ts` registers `app.launcher.computers`, "Computers command launcher", Cmd+Shift+K on macOS and Ctrl+Alt+Shift+K on the Linux and Windows desktop, desktop only. App.svelte dispatches it to `showCommandLauncher("computers")`, which ignores its argument and toggles the same deck as Cmd+K / Ctrl+Alt+K (around line 208), so the chord opens the contextual list, not the Computers scope. The manual does not document the chord.

## What to do

Decide with the owner: make the chord open the deck on its Computers scope (and document it beside Cmd+K), or remove the binding and its registry row.

## Acceptance

- The decision recorded here.
- If kept: a test that the chord opens on the Computers scope, and the Navigation page names it. If removed: Settings > Keyboard Shortcuts no longer lists it.
