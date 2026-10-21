# The drag-and-drop highlights and the card resize bars ignore the pane focus colour

Status: built on 2026-10-21 on the seat's branch; the section Built 2026-10-21 holds the evidence; it closes at the GA as shipped.

Record before the build: raised for v0.109.0 by the owner's word of 2026-10-21 ("The highlights in the pane from when we drag and drop tabs should use the colour from the focus border colour... today they are fixed in blue colour from what i can tell"; "The same applies to the highlight of the pane during drag and drop"; "And also for the vertical bar which we use to resize the outline and details windows, which are in the terminal, file browser, editor, search window and the hover over search results"); owner the frontend seat.

## What was seen

Read on 2026-10-21 at `50b4dbee5`; paths under `web/packages/workspace-app/src/`.

The focus border colour is chosen in the pane menu ("Focus border colour": blue, orange, green, pink) or by the `app.pane.focusColor.*` commands, both through `applyNamedFocusColor()` in `state/paneColor.ts`, which writes `--pane-highlight-color` on the root. A focused pane's border reads `var(--pane-highlight-color, var(--pane-active-focus))` (`components/Pane.svelte` `.pane.focused`), where `--pane-active-focus` is the pane's own preset; `components/OutlineBody.svelte` already reads the same expression for the current slide.

The drag-and-drop visuals do not. Each reads `--pane-focus`, the theme's base blue (`#388bfd` dark, `#7aa6e0` light), whatever colour the person chose (`components/Pane.svelte`):

| Visual | Rule |
| --- | --- |
| Tab strip while a tab is over it | `.tabs.drop-active`, inset 2px |
| Tab insertion marker | `.drop-bar`, 2px bar |
| Pane body edge-split overlay | `.editor-wrap.body-drop-*::after` |
| Pane move target | `.pane.transaction-drop-target::after` |
| Pane move split preview | `.pane.transaction-split-*::before` |

The pane being moved is outlined in a fixed orange (`.pane.transaction-grab`, `#f97316`), which is one of the presets. A drag across windows uses the same rules.

The resize bar on the inner edge of the floating Outline and Details cards is `.floating-resize` in `components/Inspector.svelte`: transparent at rest and `var(--link)` on hover and keyboard focus (`#58a6ff` dark, `#0969da` light). Every floating card uses it: the terminal's Details, the file browser's Details, the editor's Outline and Details, Search's Details (which is also the preview of the hovered or selected result), the graph's Details and the dashboard's. The docked handle `components/ResizeHandle.svelte` (the docked file browser and a non-floating inspector) uses the neutral `--separator-hover`.

No test pins any of these colours; `state/paneColor.test.ts` pins the preset hexes and the root variable only.

## Desired contract

Every drag-and-drop highlight of a tab or a pane, and the hover and focus colour of the floating cards' resize bar, use the pane's focus border colour: the person's choice when they made one, the theme's blue when they did not.

## What to do

1. Replace `var(--pane-focus)` with `var(--pane-highlight-color, var(--pane-active-focus))` in the five rules above, including inside the `color-mix()` tints.
2. The same expression for `.floating-resize:hover` and `:focus-visible` in `Inspector.svelte`. Its cards sit inside a `.pane`, so `--pane-active-focus` resolves; a card outside any pane falls back to the root variable, then to a stated default.
3. The moved pane's outline (`.transaction-grab`, fixed orange today) reads the same expression, by the owner's decision below.
4. The docked `ResizeHandle.svelte`'s hover (`.handle:hover`, `--separator-hover` today) reads the same expression; its resting paint (`--separator`, or transparent in the idle-invisible variant) stays neutral.
5. A raw-source test over `Pane.svelte`, `Inspector.svelte` and `ResizeHandle.svelte` that no drag, drop or resize rule names `--pane-focus` or `--link`, red first; a browser check that sets the focus colour to orange, starts a tab drag over another pane and a hover on a card's resize bar, and reads the computed colours.

## Boundaries

`components/Pane.svelte` (the drag and transaction rules), `components/Inspector.svelte` (`.floating-resize`), `components/ResizeHandle.svelte` (the hover rule only), their tests and a browser check. Not changed: the focus colours themselves, the menu, `state/paneColor.ts`.

## Acceptance

1. With each of the four presets, in light and dark themes, the tab strip highlight, the insertion marker, the edge-split overlay, the moved pane's outline, the move target and split preview, the floating cards' resize bar on hover and focus, and the docked handle on hover read the focus colour (computed style in a browser check).
2. With no colour chosen, they read the theme's blue as today; the docked handle at rest reads `--separator` as today.

## The owner's decisions 2026-10-21

Asked whether the moved pane's orange outline follows the focus colour too, and whether the docked file browser's resize handle does: "yes it should follow the focus colour"; "yes the docked resize should follow the focus colour; to be clear, it only shows on hover iirc, without hover they remain neutral". Read in the code: the docked handle paints `--separator` at rest (transparent in its idle-invisible variant) and `--separator-hover` on hover, so only the hover colour changes.

## Built 2026-10-21

Every drag-and-drop highlight of a tab or a pane and the resize bars read the window's focus colour, `var(--pane-highlight-color, var(--pane-active-focus))`, the focused pane's border expression: the colour the person chose, else the window's preset. In `components/Pane.svelte` that is the tab strip's ring under a dragged tab (`.tabs.drop-active`), the insertion marker (`.drop-bar`), the four edge-split overlays of a pane's body (`.editor-wrap.body-drop-*::after`), the move target (`.pane.transaction-drop-target::after`), the split preview (`.pane.transaction-split-*::before`) and the moved pane's dashed outline (`.pane.transaction-grab`, a fixed orange before), inside their `color-mix()` tints as well; in `components/Inspector.svelte` the floating cards' resize bar on hover and `:focus-visible`; in `components/ResizeHandle.svelte` the handle on hover, its resting paint left as it was. The docked file browser is rendered by `App.svelte` outside any pane, so the app root (`.app`) carries the window's preset as `data-focus-color={focusColorForWindow()}` with the four preset rules a pane has, and the docked handle takes `--pane-active-focus` from there, after a reload too, when a standalone server re-applies no chosen colour to the document root. `--separator-hover`, which nothing reads once the handle's hover moved, is gone from both themes.

`ResizeHandle.svelte`'s hover rule now follows its idle-invisible rule. The two have the same specificity, and with the idle rule last a hovered idle-invisible handle stayed transparent, so the docked file browser's handle, which is that variant, showed no colour on hover at all; the visible variant, `--separator` at rest, is mounted by no surface today, since every `Inspector` the app renders is floating.

Tests: `components/dragFocusColour.test.ts` reads the four stylesheets as text (jsdom applies no component CSS) and pins each rule's colour declaration to the expression with no fixed accent, link colour or literal left beside it, the docked handle's resting paint, the order of its two rules, the app root's tag carrying `data-focus-color={focusColorForWindow()}`, and its four presets equal to the pane's; it is an allowed source scanner, listed with its contract in the webdev skill. The browser check `176-drag-focus-colour` reads the painted colours; it docks the left file browser for the handle when it finds it closed and restores it, waiting until the server's preference reads closed, since a later check that finds the dock open opens no File Browser tab. The design text is the paragraph on the window's focus colour in `web/packages/workspace-app/src/design.md`.

Evidence paths below are under `dev/v0109-team/evidence/Frontend109/focdnd/` in the round's bus, in the frontend seat's guest (Chrome for Testing 156, 2 CPUs). Every run names the blobs it ran: check 176 is `1dd5970f4` in the runs at this commit and at the parents below, and `394f5c9bd` (the same arms, its dock restore waiting for the page alone) in the earlier runs at `acacbfd12`; the green runs have this commit's code.

- The source pin, blob `eb4466432` (`amend2/redgreen-2.log`, rc 0): red with the pin alone over this item's parent, 18 of 18; green with the change, 18 of 18; eleven mutants, one per rule, each red at its own rule: the strip's ring, the marker and an edge overlay's border back on `--pane-focus`, the moved pane's outline back on the fixed orange, the target's tint and the split preview's border back on `--pane-focus`, the floating bar back on `--link`, the docked hover on `--separator`, the two handle rules in their old order, one of the app root's presets changed, and the app root's `data-focus-color` attribute removed (its own case alone red).
- `make web-check`: exit 0 at `acacbfd12`, this commit's code with the pin's first seventeen cases (`amend/gate-1.log`: svelte-check 0 errors in every package, the workspace app's 7371 tests in 580 files, the lock unchanged); exit 0 at `81e5a9cb7`, which holds this commit's tree with the transfer id change below it and the new editor tab's cards above it (`../edopen/gate-2.log`: svelte-check 0 errors in every package, the workspace app's 7388 tests in 582 files, the lock unchanged).
- Check 176 alone, blob `1dd5970f4`: green at the commit (`amend2/c176-tip-3.log`), the ten arms and the reload reading, where after a reload with orange chosen the docked handle on hover reads `rgb(249, 115, 22)`; at `f649ff27c` (this commit's parent but the transfer id change below it, which touches no stylesheet) with the check taken from the commit: red (`amend2/c176-parent-2.log`) on its first reading, "no colour chosen, dark: the moved pane's outline reads rgb(249, 115, 22), expected rgb(56, 139, 253)"; and at `1909a8b9c`, the change before the app root carried the preset, with the check taken from the commit: red (`amend2/c176-1909-2.log`) on the reload reading alone, "after a reload the docked handle on hover reads rgb(122, 166, 224), expected rgb(249, 115, 22)". The same arms ran at `acacbfd12` with blob `394f5c9bd`: green there (`amend/c176-tip-1.log`), red at `f649ff27c` (`amend/c176-parent-1.log`) and at `1909a8b9c` (`amend/c176-1909-1.log`) on the same readings.
- The whole browser suite: red at `81e5a9cb7` in four checks run after 176 (`../edopen/browser-whole-2.log`: 20, 21, 40 and 50, each green alone there and at this item's earlier commit, `../edopen/four-tip-1.log` and `../edopen/four-parent-1.log`): the failure screenshots (`../edopen/whole-2-shots/`) show the left dock open, which 176 had restored in the page only, while `setBrowserSidePane` writes the preference after the page has changed and the page closed first. With the restore waiting for the server's preference, 176 followed by the four is green (`amend2/order-2.log`) and the whole suite is green at `2af4cab73`, which holds this commit with the new editor tab's cards above it: 93 of 93 (`../edopen/browser-whole-3.log`). The whole run at the new tip with the four checks green after 176 is the evidence, since the race showed once in a whole run and not in the five-check run (`amend2/order-1.log`).
- The docked handle measured by a probe run in the check's place (`browser/dock-probe-{base,tip}.log`, at the parent and at the change before the root preset): at the parent it widens from 4 to 6 px on hover and paints nothing (`rgba(0, 0, 0, 0)`), with no colour chosen and with orange chosen; with the change it paints the scheme's accent on hover with none chosen and orange with orange chosen, and nothing at rest.
- Acceptance 1 and 2 are covered by the check's ten arms and its reload reading (2's resting handle reads nothing in the idle-invisible variant, the only docked handle the app mounts; the visible variant's `--separator` at rest is the source pin's).

## Lead's rulings 2026-10-21

From the lead's ledger, 13:09Z: "F2 (after a reload on a standalone server the docked handle hovers in the theme's accent while the panes paint the chosen colour; the owner's word is that the docked handle follows the focus colour): (a), the window's preset on the app root with the four preset rules at that level so `--pane-active-focus` reaches the dock, check 176 asserting the after-reload reading, red first; F3 (the dead `--separator-hover` token) folded; F4 and F5 text; F6 (the pane-mode focus ring reads half the expression, no effect while every colour is a preset) left as is."
