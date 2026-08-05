# Checked checkbox pills switch their outer border to blue

Status: REGISTERED for v0.85.0, grounded 2026-08-05.

## What

A checkbox rendered with pill chrome in Settings turns its whole outer border blue when checked. The checked background already signals the state; the blue border adds a second, louder signal that reads as focus or selection rather than as an on/off value.

Radio pills use the same blue border to mean "this is the chosen one of a set", which is what a blue border should mean. A checkbox is not one of a set, so the two controls currently say the same thing visually while meaning different things.

## Verified current state (2026-08-05)

A repo-wide sweep for `border-color: var(--link)` finds exactly three checkbox-pill sites, each one declaration inside a `.pill.on` block whose `background: var(--hover-bg)` stays:

- `web/packages/workspace-app/src/components/settings/PillToggle.svelte:51`, the shared control
- `web/packages/workspace-app/src/components/settings/workspace/ReportsControl.svelte:128`
- `web/packages/workspace-app/src/components/settings/workspace/SemanticControl.svelte:290`

There is no fourth site.

The discriminator is not the selector. `web/packages/workspace-app/src/components/settings/PillRadio.svelte:68` carries a textually identical `.pill.on` rule and must keep it. None of the three targets contains a radio, and no site keys off the native `:checked` pseudo-class, so a selector-level sweep across the settings tree would take out the radio rule too.

No existing test covers this surface. `SettingsOverlay.render.test.ts` mounts pills and sets `--link`, but asserts PATCH payloads and labels, never a border.

## Contract

- Checked checkbox pills retain their shape, spacing, neutral border, and checked background.
- Checked checkbox pills no longer switch the outer border to blue.
- Radio pills are unchanged, including their blue checked border.
- Plain checkboxes without pill chrome are unchanged.
- Hover borders, disabled behavior, native checkbox state, and keyboard behavior are unchanged.

One consequence follows from the existing cascade and is intended rather than incidental: `.pill:hover` and `.pill.on` have equal specificity and `.pill.on` currently wins on source order, so a hovered checked pill renders blue today and renders the hover border after this change. The hover rule itself is untouched.

## Acceptance

- A test proves the blue declaration is gone from each of the three checkbox `.pill.on` blocks, that the checked background survives at each, and that `PillRadio`'s blue declaration is retained.
- The test is source-pinned, not computed-style. `web/packages/workspace-app/vite.config.ts` runs jsdom with no `css` option and the svelte plugin emits component CSS externally, so component `<style>` blocks never apply in these tests and a `getComputedStyle` assertion would pass whether or not the rule exists. A check that cannot go red is worse than no check.
- The test is written against the unmodified sources first, so the three checkbox assertions go red and the radio assertion goes green, and that red is captured before the declarations are removed.

## Rough size

Small. Three one-line removals plus one new test file. No wire, server, or state change.
