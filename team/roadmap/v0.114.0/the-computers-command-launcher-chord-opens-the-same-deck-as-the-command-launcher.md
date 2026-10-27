# The Computers command launcher chord opens the same deck as the command launcher

Status: accepted for v0.114.0 by the owner's word of 2026-10-27; decided, not built.

## What was asked

Found while rewriting the manual's Computers screen pages on 2026-10-27; the owner asked for it to be saved for later.

## Evidence

Read at `0119a1912`. `web/packages/workspace-app/src/state/shortcuts.ts` registers `app.launcher.computers`, "Computers command launcher", Cmd+Shift+K on macOS and Ctrl+Alt+Shift+K on the Linux and Windows desktop, desktop only. App.svelte dispatches it to `showCommandLauncher("computers")`, which ignores its argument and toggles the same deck as Cmd+K / Ctrl+Alt+K (around line 208), so the chord opens the contextual list, not the Computers scope. The manual does not document the chord.

## Owner decision (2026-10-27)

"just cmd+k enough, no need to have the cmd+shift+k vriant".

## What to do

Remove `app.launcher.computers`: its registry row and `COMPUTERS_LAUNCHER_ID` branch in `shortcuts.ts`, its dispatch in `App.svelte`, the launcher package's twin binding in `web/packages/launcher/src/components/CommandLauncher.svelte` (the "computers" entry mode), and the tests that pin it. Cmd+K / Ctrl+Alt+K and the deck's Computers scope stay.

## Acceptance

- Settings > Keyboard Shortcuts no longer lists Computers command launcher; Cmd+Shift+K and Ctrl+Alt+Shift+K do nothing in Chan Desktop and the launcher.
- workspace-app and launcher vitest and svelte-check green.
