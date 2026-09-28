# Whether a draft drawing that does not parse may be discarded from its own dialog without a save first

Status: raised for a decision on 2026-09-28 by the lead's answer to the plan for the drawing's refused save (`dev/v0101-team/followups/followup-Lead-Frontend-16.md` in the development tree, ruling 1), from that plan (`dev/v0101-team/followups/followup-Frontend-Lead-13.md`, section 4, the draft drawing's row). Read in code at `7957bccef` and not run. A question of product for the owner, with no recommendation.

## What was seen

A draft's close saves a draft that has unsaved edits first, and when the save leaves it with unsaved edits it returns with the tab open, before the draft's own dialog, which offers to save the draft into the workspace or to discard it, can open (`handleDraftTabClose`, `web/packages/workspace-app/src/state/tabs.svelte.ts:3647-3693`, the save at `:3658-3661`, the dialog at `:3668-3680`). A drawing whose buffer does not parse is refused its save (`performSaveOnce`, `:5804-5812`), so a draft drawing in that state never reaches its dialog, and the user cannot discard it from there: the ways out are to fix the text or to undo it back to the saved one.

The drawing's refused save, in hand and not landed, keeps that refusal and says why, once, by the lead's ruling, which chose it over the plan's recommendation: a first dialog that throws the edits away and then the draft's own, where a cancel of the second would leave a tab open whose edits the first had taken.

## Desired contract

The owner's to decide: whether a draft drawing whose buffer does not parse can be discarded from the draft's own dialog, with no save first, and what such a discard throws away.

## What to do

If the owner allows it, the draft's close opens its dialog without a save when the buffer does not parse, and its Discard removes the draft as it does today; the lead's answer asks the drawing order's report to say what that would touch. If not, nothing changes and this item closes with the ruling.

## Boundaries

`handleDraftTabClose` in `web/packages/workspace-app/src/state/tabs.svelte.ts` and the draft's close dialog, with their tests.

## Acceptance

1. The owner's ruling is recorded here.
2. If a discard is allowed: a draft drawing whose buffer does not parse, closed, reaches its own dialog, and its Discard removes the draft with nothing written first, pinned.
