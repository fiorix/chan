# The launcher's window counters are collapse toggles

Status: accepted for v0.114.0 by the owner's word of 2026-10-27; not started.

## What was asked

The owner's words of 2026-10-27: "in the computers window, on the "This machine" screen, we have a toggle button which counts the number of windows openen on that machine (or a devserver), and it can show and hide all terminals and workspaces... we no longer need that button, but we can keep the counter; the one on workspaces we also don't need because the workspaces already have the chevron; in there we can also keep the window counter, just no need for the toggle".

## Evidence

Read at `0119a1912`, paths under `web/packages/launcher/src/`:

- `components/Library.svelte` `windowCountToggle` (around line 473) renders the machine card's window count as a `button.count-badge.machine-toggle` that collapses or expands the whole card through `state/machineCollapse.svelte.ts`; it is rendered for This machine and for each devserver header.
- The workspace card head (around line 296) renders `button.count-badge` with the same expand action as the workspace's chevron button beside it.
- Tests that pin the toggles: `components/Library.test.ts` (around lines 766-918), `components/LibraryReadOnly.test.ts` (around line 195), `components/Library.deck.test.ts` (line 98, focus lands on `.machine-toggle`), `LauncherDemo.test.ts` (line 148), and `state/machineCollapse.test.ts`.

## Desired contract

- The machine card header (This machine and every devserver) shows its window count as plain text with the same badge look; it is not a button and nothing collapses the machine card.
- The workspace card head shows its window count as plain text; the chevron is the only control that expands or collapses the workspace's windows.
- Both counts keep their "N windows" title, and the deck's keyboard walk (Left and Right across a row's controls) skips them because they are no longer controls.

## Boundaries

- Remove `state/machineCollapse.svelte.ts` and its persisted collapse state if nothing else reads it; check for a stored key that a migration should clear.
- No change to the chevron, the All windows card, or the counts' values.

## Acceptance

- No button in a machine or workspace header carries the count; the count still reads the window total.
- A machine card that a user had collapsed before the change shows its windows.
- Library, deck, read-only and demo tests updated; launcher vitest and svelte-check green; a screenshot of the demo shows the counts.
