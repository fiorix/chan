# Escape closes the overlay under an open menu

Status: accepted for v0.100.0 by the owner on 2026-09-20. Raised on the owner's instruction to fold the frontend review's most critical findings into this version. From the review (finding SHELL-04, medium), re-verified against `main` at `d3de0180b` by reading. Small, and scheduled here because it is keyboard ownership that the layout-aware shortcut import must find settled.

## What was seen

`web/packages/workspace-app/src/components/HamburgerMenu.svelte`, the shared menu primitive, binds only `onmousedown` and has no key handling. With the search overlay open and its hamburger menu open, Escape falls through to the window handler and closes the whole Search panel instead of the menu, and the user's query goes with it. `Pane.svelte` carries its own Escape branch for the same menu, which is the duplicate a fix deletes.

## Desired contract

An open menu owns Escape: the first Escape closes the menu and nothing else, and focus returns to the control that opened it.

## Boundaries

`web/packages/workspace-app/src/components/HamburgerMenu.svelte`, `components/Pane.svelte`, and a new mounted test. The wider question of Escape having one designated owner and eight local handlers belongs to the repeated-shapes work in the next version; this item fixes the one case that loses user input.

## Acceptance

1. With Search open and its menu open, Escape closes the menu, keeps the panel and the query, and returns focus to the menu button; a second Escape closes the panel.
2. The pane menu behaves the same way through the shared primitive, with no Escape branch of its own in `Pane.svelte`.
