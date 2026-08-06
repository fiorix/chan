# Selected settings pills switch their outer border to blue

Status: IMPLEMENTED for v0.85.0, grounded 2026-08-05, extended to radio pills by owner ruling 2026-08-06, automated evidence complete.

## What

A control rendered with pill chrome in Settings turns its whole outer border blue when selected, both checkbox pills and radio pills. The selected background already signals the state; the blue border adds a second, louder signal that reads as focus rather than as a value.

The checkbox half was taken first, on the argument that a blue border should mean "the chosen one of a set" and a checkbox is not one of a set. The owner then ruled the distinction not worth keeping and aligned the two controls: a selected radio pill loses the blue border as well, keeping its shape, spacing, selected dot, background, disabled behavior, keyboard handling, and focus ring. That ruling overrides the delivery plan's line that radio pills remain unchanged, and it is a decision rather than a drift.

## Verified current state (2026-08-05)

A repo-wide sweep for `border-color: var(--link)` finds exactly three checkbox-pill sites, each one declaration inside a `.pill.on` block whose `background: var(--hover-bg)` stays:

- `web/packages/workspace-app/src/components/settings/PillToggle.svelte:51`, the shared control
- `web/packages/workspace-app/src/components/settings/workspace/ReportsControl.svelte:128`
- `web/packages/workspace-app/src/components/settings/workspace/SemanticControl.svelte:290`

There is no fourth checkbox site.

`web/packages/workspace-app/src/components/settings/PillRadio.svelte:68` carries a textually identical `.pill.on` rule and is the fourth and last site, taken under the 2026-08-06 ruling. No site keys off the native `:checked` pseudo-class, so nothing in the selector text distinguishes the four; each is pinned by file name rather than by selector, so a sweep that reintroduces the border at one site is still caught.

Two further pill-like surfaces were checked and are out of reach: `TeamDialog.svelte` holds a radio but no pill, no border property, and no `var(--link)`; `StyleToolbar.svelte` matches `class="pill"` but is a decorative `aria-hidden` span with no selected variant.

No existing test covers this surface. `SettingsOverlay.render.test.ts` mounts pills and sets `--link`, but asserts PATCH payloads and labels, never a border.

## Contract

- Selected checkbox and radio pills retain their shape, spacing, neutral border, and selected background.
- Neither switches the outer border to blue when selected.
- A radio pill's selected dot and focus ring are unchanged, because both come from the native input rather than from `.pill.on`.
- Plain checkboxes without pill chrome are unchanged.
- Hover borders, disabled behavior, native input state, and keyboard behavior are unchanged.

One consequence follows from the existing cascade and is intended rather than incidental: `.pill:hover` and `.pill.on` have equal specificity and `.pill.on` wins on source order, so a hovered selected pill rendered blue and renders the ordinary hover border after this change. The hover rule itself is untouched.

## Acceptance

- A test proves the blue declaration is gone from all four `.pill.on` blocks and that the selected background survives at each. The radio assertion was originally the inverse, pinning the blue declaration as retained, written as a guard against a selector-level sweep removing it without a decision. Under the ruling it is inverted rather than deleted, and the file states that the alignment is a decision, so a later reader can distinguish an override from erosion.
- The test is source-pinned, not computed-style. `web/packages/workspace-app/vite.config.ts` runs jsdom with no `css` option and the svelte plugin emits component CSS externally, so component `<style>` blocks never apply in these tests and a `getComputedStyle` assertion would pass whether or not the rule exists. A check that cannot go red is worse than no check.
- Each assertion is written against the unmodified source first and its red captured before the declaration is removed, for the radio site as much as for the three checkbox ones. Every pin that stays green across the change is separately shown red against a copy with the pinned property removed, so no pin in the file is a check that cannot fail.

## Rough size

Small. Four one-line removals plus one test file. No wire, server, or state change.
