# The rich prompt has no close button and no style toolbar

Status: shipped in [v0.109.0](../../release/release-v0.109.0.md).

Record before the release: built on 2026-10-21 on the seat's branch; the section Built 2026-10-21 holds the evidence; it closes at the GA as shipped.

Record before the build: raised for v0.109.0 by the owner's word of 2026-10-21 ("The rich prompt window should have a Close (x) button for mobile users, and it should also toggle the style toolbar - these go on left (the style toolbar) and right (the close button) and in case of the style toolbar we employ the same principle as in the editor: on the first row it shifts the text down when the toolbar is expanded; this should be the default behaviour already"); owner the frontend seat.

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

## Built 2026-10-21

The card (`components/RichPrompt.svelte`) has a close button at its top right, `aria-label` "Close Rich Prompt", after the strip in the tab order (the composer keeps Tab for indenting); a tap or a click writes the draft and hides the card, as the terminal menu's toggle does, and the draft is there when the card opens again; Escape still abandons it. `.rp-editor` keeps a right inset the button's width, so no line runs under it, and the card caps the style toolbar at its width less 52px, so on a phone the toolbar's expanded row scrolls rather than reach under the button.

The editor's `StyleToolbar` floats at the card's top left over the text area while the terminal's toggle is on, with a new `image` prop (default true, so file tabs are unchanged) set false, so the row has no image button; it keeps the editor's collapse and idle fade on touch. While it shows, `.rp-editor` sets `--editor-top-pad` to 2.5rem and the card's own content rule, which outranks `Wysiwyg`'s and `Source`'s, reads it, so the first row sits below the toolbar; turned off, the card is as before with the close button added. The toggle is per terminal in `state/richPrompt.svelte.ts`, starts hidden, and a reload keeps it through the session payload's `rpt` bit beside `rpv` (`state/tabs.svelte.ts`: written from the module, restored on a reload and on a cross-window move, kept out of the URL hash and listed with the identity table's excluded keys); a closed terminal's entries are dropped. The terminal menu's Show or Hide Style Toolbar row (`components/TerminalTab.svelte`, after Show/Hide Rich Prompt) and the launcher command `terminal.richPromptToolbar` (`state/commands/terminal.ts`, "Toggle Rich Prompt style toolbar") are offered only while the card shows.

The card has a source mode: the toolbar's source toggle, or the `app.editor.toggleMode` chord matched by `eventMatchesShortcut` (Mod+E, user remaps included), swaps `Wysiwyg` for `Source` over the same draft with the same keymaps, lock and view registration, the caret mapped as a file tab maps it, and the keyboard handed to the editor the swap mounts. The card takes the chord in a highest-precedence handler ahead of its lock and stops it there, so a pending card still flips and neither the app's document handler nor the terminal beneath sees it. `Source` (`editor/Source.svelte`) takes a `surface` prop, as `Wysiwyg` does, so the card's source view follows the terminal surface's theme, and a `focusEnd`; the card's overrides reach `.md-source` as they reach `.md-wysiwyg-cm6`. The source mode is per terminal and a reload opens the card rendered. While a message is pending the toolbar's formatting is disabled with the card and its source toggle stays usable; in source mode a pasted image is not turned into a draft image. The design text is the Rich Prompt chrome paragraph in `web/packages/workspace-app/src/design.md`.

Tests: `components/RichPrompt.chrome.test.ts` (the close button, the toolbar without image insertion, the top pad, the pending lock, the chord's swap both ways with the text and the keyboard kept, the chord a keymap override assigns taking the toggle from Mod+E, a caret at an image's edge mapped into its URL, on macOS and on Linux, and the chord reaching no document listener); `components/RichPrompt.surface.test.ts` (`Source` on the terminal surface, alone and in the card); `components/StyleToolbar.test.ts` (the row without the image button); `components/TerminalTab.richPrompt.test.ts` (the menu row and the command offered only while the card shows, each toggling the bit; a closed terminal dropping it); `components/richPromptCaretPersistence.test.ts` and `components/terminalMoveAcrossWindows.test.ts` (`rpt` across a reload and a move, never in the URL hash); `state/paneModeConflict.test.ts` (`rpt` in the key inventory); the requirement table's snapshot gains the command. The browser check `177-rich-prompt-chrome` runs at a 390 by 844 touch screen.

Evidence paths below are under `dev/v0109-team/evidence/Frontend109/rpchrm/` in the round's bus, in the frontend seat's guest (Chrome for Testing 156, 2 CPUs).

- The pins (`redgreen-1.log`; blobs `RichPrompt.svelte` `df6daf3bf`, `StyleToolbar.svelte` `a7ce28cec`, `TerminalTab.svelte` `86c476cb6`, `Source.svelte` `2dee12718`, `richPrompt.svelte.ts` `d286f71d9`, `tabs.svelte.ts` `660a1313e`, `commands/terminal.ts` `2489eb2b5`, this commit's): with the eight test files alone over the parent, 21 of 150 red; green with the change, 150 of 150; fourteen mutants, thirteen red: the close running Escape's abandon, the top pad unset, the image button off by default, the chord let past the card, the chord behind the lock, the swapped-in editor left unfocused, the toolbar not disabled with the lock, `rpt` not written, not restored on a reload, not restored on a move, the menu row offered while the card is hidden, the command offered while it is hidden, and a closed terminal's entries kept. The fourteenth, `Source`'s theme seeded from the editor surface, survived: the editor's effect reconfigures the theme to its surface at mount, so the seed decides only the frame before; that effect line hard-coded to the editor surface is red (`redgreen-2.log`).
- `make web-check` at `ed8edd741`, this commit's tree but this section: exit 0 (`gate-1.log`: svelte-check 0 errors in every package, the workspace app's 7407 tests in 583 files, the lock unchanged).
- Check 177 alone: green at `ed8edd741` (`c177-tip-1.log`); red at the parent with the check taken from the commit (`c177-parent-1.log`) on its first assertion, "the card has a close button"; and red with the card's toolbar cap taken out (`c177-nocap-1.log`, the card file overlaid), where a tap on the source toggle lands on the close button. Beside the checks that drive the card and the terminal menu, 104, 125 and 175: all four green (`beside-1.log`).
- The keymap and caret pins (`p1-pin-1.log`, at `7eba15fb2`, which holds the chrome file at this commit's blob `557e98218` and `RichPrompt.svelte` at this commit's blob `df6daf3bf`): svelte-check 0 errors, the chrome file 14 of 14; the toggle matched by a literal Meta-or-Ctrl+E test in place of `eventMatchesShortcut` red on both systems at "the built-in chord no longer swaps"; the swap's caret left unmapped red on both at the source caret, 11 where 5 is expected.
- Against R2's "equal": the card's height in source differs from the rendered one by the two editors' line faces (124.8 against 129.8 px in an iteration run, `c177-iter-3.log`); check 177 bounds the difference by one source line and asserts that the source editor's scroller has nothing to scroll.

Acceptance 1 is the owner's answers above; 2 is the component tests, red first; 3 is check 177.

## Lead's rulings 2026-10-21

From the lead's task of 13:42Z: "The lead's ruling on question 2, dated 2026-10-21, by the owner's "same principle as in the editor": the toolbar's visibility is per terminal and kept across reloads as the editor's `styleToolbarOpen` is, and it starts hidden (the owner's answer 5)."

From the lead's ledger, 15:49Z: "(1) the terminal menu row and the launcher command for the toolbar are offered only while the prompt is shown, since the toolbar lives in the card; (2) the prompt's source mode is per terminal and is not kept across a reload (a reloaded card opens rendered); the ruling of task 4 kept the toolbar's visibility only, and no second bit is added; (3) while a message is pending, the toolbar's formatting buttons are disabled with the card's lock and the source toggle stays usable, as the editor's read-only case does; (4) in source mode an image pasted into the card is not turned into a draft image, as the editor's source mode does not; the rendered mode keeps it."

From the lead's ledger, 15:59Z: "Taken into the code, dated 2026-10-21: R1 (`Source.svelte` hard-codes the hybrid theme's editor surface at 113 and 439; a `surface` prop, pinned red first); R2 (the card's overrides reach `.md-source` too: height, overflow, background; a source arm in check 177); R3 (the swap unmounts the focused editor: `Source` takes `autoFocus` and an empty placeholder; the Mod+E tests assert focus inside the new editor both ways); R4 (the chord matched by `eventMatchesShortcut(e, "app.editor.toggleMode")`, user remaps included, as `terminal.find` does); R5 (check 177 emulates a touch screen with `hasTouch`, `isMobile` and `tap()`, and asserts the bold lies inside the card); R6 (the new launcher command moves `requirementTable.test.ts.snap` in the commit)."
