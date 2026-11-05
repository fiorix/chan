# Escape does not close a terminal's right-click menu

Status: shipped in [v0.124.0](../../release/release-v0.124.0.md).

Record before the release: found on 2026-11-05 by the Claude subagent that repaired [three stale browser checks](browser-checks-60-125-and-134-test-what-the-product-no-longer-does.md), while it read check 125 in its guest; red at `main` `720b543c0`, so older than this release. The owner asked for a subagent to fix it the same day, on `fix/terminal-menu-escape` off `96d71d989`, merged into `v0124/int` as `8c0f5eefb`. It continues [escape-closes-the-overlay-under-an-open-menu](escape-closes-the-overlay-under-an-open-menu.md) (v0.100.0: "An open menu owns Escape"), whose shared menu primitive the terminal's and the editor's own menus do not use.

## What was there

A terminal keeps focus while its body menu or its tab menu is open, and both engines take Escape at the focused element: xterm.js on its textarea and chan's ghostty key listener on the host each send ESC to the PTY and stop the event. The menu listened for Escape on the window in the bubble phase and never heard it, so the menu stayed open and the shell read an ESC on every press, in a workspace window and in a standalone terminal window alike. An editor keeps focus the same way under its body and tab menus; CodeMirror took Escape first, so the menu closed and the selection it was opened on collapsed with it.

## Desired contract

1. With a terminal's body or tab menu open, Escape closes the menu, reaches neither engine nor the PTY, and leaves focus on the terminal; other keys still go to the terminal while a menu is open.
2. With an editor's body or tab menu open, Escape closes the menu and keeps the selection.
3. An Escape typed in a menu's own fields (the tab menu's name field) still reaches the field first and closes the menu as it bubbles out.

## Boundaries

`TerminalTab.svelte` and `FileEditorTab.svelte` take an Escape aimed outside the open menu in the window's capture phase and stop it there; their tests; browser check 207. The pane's menus, which already own Escape, are unchanged.

## Acceptance

1. `TerminalTab.menuEscape.test.ts` mounts the tab over a real xterm.js and over a ghostty stand-in behind chan's real key listener: its four menu arms red against the previous component (the menu open, ESC at the PTY), the control (no menu, Escape reaches the PTY) green on both.
2. `FileEditorTab.test.ts`: the menu arms red against the previous component (the selection collapsed), the control (no menu, Escape collapses the selection) green; without the in-menu exception the existing "Escape reverts the draft" test is red.
3. Browser check 207 over a shell turned into a raw recorder of every byte its PTY receives, on xterm.js and ghostty, in a workspace window and in the terminal window a throwaway devserver mints: Escape closes the body menu and the tab menu, focus stays on the terminal and the PTY reads only the `x` typed after it; a control press with no menu open reaches the PTY as ESC, so a blind recorder fails the check; an editor's body and tab menus close and keep the selection.

## Built

Three commits: `81c2b438c` (the terminal's menus), `f315ce65a` (the editor's menus), `e3211cdc3` (check 207). Verification recorded in the commits and the lead's notes: check 207 red against the previous components on each of its eight menu arms and green alone (17 s) and in a pack with 176, 203, 205 and 206 in an isolated guest; `make web-check` green.

Open: chan-desktop's webviews were not read before the GA commit. The graph's tab menu and the inspector's action pill take Escape in the bubble phase too, where nothing takes it first today (the v0.125.0 row [`the-graph-tab-menu-and-the-inspector-action-pill-take-escape-in-the-bubble-phase`](../v0.125.0/the-graph-tab-menu-and-the-inspector-action-pill-take-escape-in-the-bubble-phase.md)), and a right-click on the strip's empty stretch leaves focus on the body ([`a-right-click-on-the-pane-strips-empty-stretch-leaves-focus-on-the-body`](../v0.125.0/a-right-click-on-the-pane-strips-empty-stretch-leaves-focus-on-the-body.md)).
