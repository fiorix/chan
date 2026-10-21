# The drag-and-drop highlights and the card resize bars ignore the pane focus colour

Status: raised for v0.109.0 by the owner's word of 2026-10-21 ("The highlights in the pane from when we drag and drop tabs should use the colour from the focus border colour... today they are fixed in blue colour from what i can tell"; "The same applies to the highlight of the pane during drag and drop"; "And also for the vertical bar which we use to resize the outline and details windows, which are in the terminal, file browser, editor, search window and the hover over search results"); owner the frontend seat.

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
