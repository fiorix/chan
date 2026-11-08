# chan serve --help names Cmd+P as Team Work

Status: shipped in [v0.126.0](../../release/release-v0.126.0.md).

Record before the release: raised on 2026-11-08 while writing the chan.app tutorials; accepted by the owner for v0.126.0; built on `fix/help-cmd-p-binding` as `3b4beb595`, merged into the integration branch, awaiting the release.

## What is there now

The launcher section of `chan serve --help` ends with "Cmd+P is Team Work, not the launcher." (`crates/chan/src/help.rs:750`). The desktop's menu bar binds Cmd+P to View > Toggle Launcher, the Computers screen (`desktop/src-tauri/src/main.rs:6130-6135`), with Ctrl+Shift+P on Windows and Linux, and the workspace app binds no Cmd+P: Team Work has no chord of its own and opens from Hybrid Nav's `Mod+. p` or the pane menu's New team (`web/packages/workspace-app/src/App.svelte:793-794`). `cs terminal team --help` repeats the old binding as "the Cmd+P Team Work dialog" (`crates/chan-shell/src/help.rs:1279`).

## Desired contract

1. Both help texts name the current ways in: Cmd+P (Ctrl+Shift+P on Windows and Linux) toggles the Computers screen on the desktop, and Team Work opens from New team or `Mod+. p`.
2. No help text pairs Cmd+P with Team Work.

## Boundaries

- The two help strings; no shortcut changes.

## Acceptance

1. `chan serve --help` and `cs terminal team --help` at the tip read against the desktop menu and the workspace app's chord table.
2. `rg --text 'Cmd\+P' crates` finds no Team Work pairing.
3. The gate green, help snapshot tests included.
