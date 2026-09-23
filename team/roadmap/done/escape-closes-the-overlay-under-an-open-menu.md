# Escape closes the overlay under an open menu

Status: shipped in [v0.100.0](../../release/release-v0.100.0.md): The first Escape closes an open menu and nothing else, and focus returns to the control that opened it.

## What was seen

`web/packages/workspace-app/src/components/HamburgerMenu.svelte`, the shared menu primitive, binds only `onmousedown` and has no key handling. With the search overlay open and its hamburger menu open, Escape falls through to the window handler and closes the whole Search panel instead of the menu. The query survives, because `searchPanel.query` is lifted into the store and round-trips through the URL hash; what the user loses is the open panel and the results rendered in it, which the component rebuilds on the next open. `Pane.svelte` carries its own Escape branch for the same menu, which is the duplicate a fix deletes.

## Desired contract

An open menu owns Escape: the first Escape closes the menu and nothing else, and focus returns to the control that opened it.

## Boundaries

`web/packages/workspace-app/src/components/HamburgerMenu.svelte`, `components/Pane.svelte`, and a new mounted test. The wider question of Escape having one designated owner and eight local handlers belongs to the repeated-shapes work in the next version; this item fixes the one case that loses user input.

## Acceptance

1. With Search open and its menu open, Escape closes the menu, keeps the panel and the query, and returns focus to the menu button; a second Escape closes the panel.
2. The pane menu behaves the same way through the shared primitive, with no Escape branch of its own in `Pane.svelte`.
