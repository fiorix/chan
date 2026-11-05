# The pane and terminal menus offer no way to the command launcher

Status: shipped in [v0.124.0](../../release/release-v0.124.0.md).

Record before the release: asked by the owner on 2026-11-05: a Commands row (`app.launcher.toggle`) in the terminal's right-click menu and in an empty pane's body, which showed the webview's own menu (Back, Reload, Inspect), and chords on the pane menu's rows, Reload and Open Inspector among them. Built by the Claude subagent that built [the centre drop](a-pane-under-a-hidden-strip-has-nowhere-to-drop-a-tab-or-a-file.md), on `feat/pane-context-commands` stacked on it, since both change `Pane.svelte`; merged into `v0124/int` as `b2665def0`, with `93a6f1cdd` for its browser check. The owner left the browser's own menu on the strip's side toggle, the hamburger, the Hybrid Nav preview, the status bar, the dividers and the dialogs as it is.

## What was there

With the pane strip hidden there was no visible way to the command launcher, since the hamburger goes with the strip. Right-clicking an empty pane's body showed the webview's own menu: `Pane.svelte` skipped empty panes on purpose. The pane menu's rows carried no chords, and the desktop's inspector chord, Cmd+Alt+I on macOS and Ctrl+Alt+I on Linux and Windows, which `key_bridge.js` takes before the page sees the key and which is therefore not in the shortcut registry, was named nowhere in the page.

## Desired contract

1. Right-clicking the strip's empty stretch, an empty pane's included, or the body of a side with no tab, either side, strip drawn or hidden, opens the pane's menu and keeps the browser's shut. It lists Commands with the launcher's chord, Reload with its chord and, on the desktop only, Open Inspector with the key bridge's chord; Commands and Reload read the shortcut registry, overrides included.
2. A terminal's body menu ends with Commands after a separator.
3. A tab's body keeps its own menu, or the browser's where it has none, and Hybrid Nav's preview is left alone.
4. Commands runs `app.launcher.toggle` through the window's command bus, as the chord and the hamburger's row do. When the launcher closes, focus returns to what the menu opened over: the terminal, or in the pane menu whatever held focus as it opened, the empty pane's welcome included.
5. The inspector chord has one source in the page, labelled as every chord is, and none in a plain browser.

## Boundaries

`state/shortcuts.ts` (`WEB_INSPECTOR_CHORD`, `webInspectorChordLabel`), `Pane.svelte` (the menu on the strip's stretch and an empty side's body), `TerminalTab.svelte` (the Commands row; on ghostty the host is focused once, since ghostty-web's `focus()` focuses again on a zero-delay timer and took the keyboard back from the launcher), `state/store.svelte.ts` (`openCommandLauncherFromMenu`), the workspace app's design, the manual's launcher paragraph, the webdev skill's list of `key_bridge.js` readers, browser check 206.

## Acceptance

1. `shortcuts.inspector.test.ts` runs `key_bridge.js` from the file that ships it and presses the keystroke each label names, so the label is the bridge's chord on every platform; the same letter without Alt opens nothing. Red with the chord changed.
2. `Pane.contextMenu.test.ts`: the rows and chords on macOS, Linux and Windows desktops and macOS and Linux browsers, an override of the launcher's chord, Open Inspector reaching the desktop, where the menu opens and where it does not, and the focus Commands hands the launcher. `TerminalTab.menus.test.ts` and `TerminalTab.ghosttyBackend.test.ts`: the terminal row's place, chord and focus, and the keyboard held in the launcher on ghostty. Each rule replayed red under a mutation.
3. Browser check 206 with the browser's own pointer: an empty pane's body and its strip's stretch open chan's menu with Commands and Reload and their Linux Chrome chords, and the macOS labels from a macOS user agent; with the preference on, the empty side B's body still opens it; a terminal's menu ends with Commands; each Commands opens the launcher and Escape hands focus back. Red against the previous `Pane.svelte`, and before the ghostty focus fix.

## Built

Four commits: `e5752c5ef` (the inspector chord's one source), `9291d0a3f` (the Commands rows and the empty-pane menu), `db60cca05` (the design and the manual), `3e3761186` (check 206). The merge into `v0124/int` resolved two conflicts: both sides added a field to the ghostty stand-in's record in `TerminalTab.ghosttyBackend.test.ts`, and the menu's refusal read `surveyFor(tab.id) || launcherShownOverWindow()` where the launcher focus fix had replaced that import with `state/focusGuard.ts`; it calls `refocusRefused(tab.id)`, the same pair, without which the row threw "surveyFor is not defined". `93a6f1cdd` gives check 206's cleanup the server token: it was written against the pane strip helper's earlier signature, whose roster read the strip branch's repair added, and it failed after every menu assertion had passed in the whole browser suite at `b2665def0`.

Verification recorded in the commits: svelte-check and vitest on the listed suites; check 206 green alone in an isolated sdme guest at four CPUs. `make web-check` green at `b2665def0` (8,554 workspace-app tests); check 206 green alone with `93a6f1cdd` and in the guest pack of checks 90, 125, 134, 176 and 200 to 206 on the tree merged as `0226903d7`.

Open: the menus were not read in chan-desktop before the GA commit. A right-click on the strip's empty stretch leaves focus on the document body (found by the Escape fix that followed), the v0.125.0 row [`a-right-click-on-the-pane-strips-empty-stretch-leaves-focus-on-the-body`](../v0.125.0/a-right-click-on-the-pane-strips-empty-stretch-leaves-focus-on-the-body.md).
