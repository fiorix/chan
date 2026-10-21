# The rich prompt has no close button and no style toolbar

Status: raised for v0.109.0 by the owner's word of 2026-10-21 ("The rich prompt window should have a Close (x) button for mobile users, and it should also toggle the style toolbar - these go on left (the style toolbar) and right (the close button) and in case of the style toolbar we employ the same principle as in the editor: on the first row it shifts the text down when the toolbar is expanded; this should be the default behaviour already"); owner the frontend seat.

## What was seen

Read on 2026-10-21 at `50b4dbee5`; paths under `web/packages/workspace-app/src/`.

The rich prompt (`components/RichPrompt.svelte`) is a floating markdown composer over the bottom of a terminal, the editor's `Wysiwyg` on a per-terminal draft, sending with Mod+Enter. It opens and closes only by toggles: the chord (Cmd+Shift+P on macOS, Ctrl+Shift+P elsewhere), the terminal menu's Show/Hide Rich Prompt and the launcher command `terminal.richPrompt`; Escape on an editable card abandons the draft and hides it. There is no close button, so a person on a phone, with no chord and no Escape key, can close it only from the terminal menu. Its chrome from top to bottom: an 8px resize handle, the editor area (max 32vh unless resized), and a bottom strip (queued count or a note, recall, the submit button). It has no `@media` or touch rule of its own.

It has no style toolbar: formatting is keyboard only. The editor's toolbar is `components/StyleToolbar.svelte`, absolutely placed at the top left (`top: 8px; left: 8px; z-index: 30`), with an idle fade after 3 s, a collapsed "Aa" pill and an expanded row (block kind, bold, italic, strike, code, link, lists, task list, rule, image) and a source toggle. A file tab turns it on from its tab menu ("Toggle style toolbar") or `app.editor.styleToolbar`, per tab (`tab.styleToolbarOpen`, default off). While it is on, the editor reserves room on the first row: `--editor-top-pad` is 2.5rem instead of 0.5rem on the editor host (`components/FileEditorTab.svelte`), read by `editor/Wysiwyg.svelte`'s content padding, so the toolbar never covers the first line.

Tests: the rich prompt's strip, Escape and show/hide are covered (`richPromptPendingMachine.svelte.test.ts`, `RichPrompt.svelte.test.ts`, `TerminalTab.richPrompt.test.ts`); nothing covers a header, a close button or a narrow width. `FileEditorTab.test.ts` checks the reserved padding in source mode only.

## Desired contract

The rich prompt has a close (x) button at its top right that hides the card and keeps the draft, and the editor's style toolbar floating at the top left of its text area (by the owner's choice of option B below), turned on and off from the terminal menu and a launcher command as the editor's is from its tab menu. While the toolbar is on, the first row of text moves down by the toolbar's height, so it never covers text. The toolbar has no image button and keeps the source toggle with its Mod+E shortcut.

## Questions for the design read

1. What the close button does with the draft: hide the card and keep the text (recommended, as the menu toggle does), or abandon it as Escape does.
2. Whether the toolbar's visibility is per terminal and kept across reloads like the editor's `styleToolbarOpen`, and whether it starts shown or hidden. The owner's "this should be the default behaviour already" is read here as the text-shift being the toolbar's standing behaviour, not as the toolbar starting open; to confirm.
3. Which of the editor toolbar's controls the prompt keeps: image insertion and the source toggle have no clear meaning in a prompt.
4. Whether the toolbar sits in the new header row (no reserved padding needed) or floats over the editor as in a file tab (the reserved first-row padding is then required); the resize handle stays the top edge either way.
5. On touch screens, the toolbar's idle fade and hover expansion assume a pointer; whether the prompt's toolbar stays expanded.

## What to do

Design read to the owner with the questions above and a recommendation each, then: the header in `RichPrompt.svelte` with the two controls, keyboard reachable and labelled; `StyleToolbar.svelte` reused with the prompt's `Wysiwyg` ref and a `selVer` from its selection changes, with the controls the owner keeps; the first-row reservation through the same `--editor-top-pad` the editor uses if the toolbar floats; the toggle also as a launcher command beside `terminal.richPrompt`.

## Boundaries

`components/RichPrompt.svelte`, `components/StyleToolbar.svelte` only as far as a prop to trim its controls, `state/richPrompt.svelte.ts` for any new per-terminal state, `state/commands/terminal.ts`, their tests and a browser check at a phone width. Not changed: the send and queue behaviour, Escape's meaning, the editor's toolbar.

## Acceptance

1. The owner's answers to the questions recorded here.
2. A component test per control, red first: the close button hides the card and leaves the draft as decided; the toolbar control shows and hides the toolbar; with the toolbar shown the first line of text is not under it.
3. A browser check at a 390px viewport: the card opens from the terminal menu, the close button is visible and closes it, the toolbar toggles, and a bold applied from the toolbar reaches the sent text.

## The owner's answers 2026-10-21

1. The close button keeps the draft: "yes".
2. The controls: "remove the image insertion but keep source toggle including the shortcut (e.g. cmd+e on mac)". The editor's toggle is `app.editor.toggleMode`, Mod+E (`state/shortcuts.ts`); the prompt has no source mode today, so this adds one, and Mod+E in the prompt must reach the prompt, not the terminal under it.
3. The placement: "i think in the editor but show me first on a .md what it'd look like and than i can decide"; after reading the mock (`dev/rpchrm-toolbar-placement.md`, option A a header row, option B the editor's floating toolbar): "ok I will take B for the toolbar, floats over the text area". The toolbar floats at the top left of the text area as in a file tab, the close button sits at the card's top right, and while the toolbar is turned on the first row of text moves down by its height through the same `--editor-top-pad` rule; turned off, the card is as compact as today with only the close button added.
4. Touch screens: "not really, it could collapse which means an extra click to use it, it's fine". The toolbar keeps the editor's collapse and idle behaviour on touch.
5. The text push-down is the standing behaviour, not the toolbar starting open: "yes the text push-down".
