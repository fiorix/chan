# Whether a draft drawing that does not parse may be discarded from its own dialog without a save first

Status: shipped in [v0.102.0](../../release/release-v0.102.0.md).

Record before the release: accepted by the owner on 2026-09-29 for a later version than v0.101.0, so it is held under v0.102.0; raised during v0.101.0 on 2026-09-28 by the lead's answer to the plan for the drawing's refused save (`dev/v0101-team/followups/followup-Lead-Frontend-16.md` in the development tree, ruling 1), from that plan (`dev/v0101-team/followups/followup-Frontend-Lead-13.md`, section 4, the draft drawing's row). Read in code at `7957bccef` and not run.

## Owner ruling

Accepted on 2026-09-29 for a later version. The owner accepted in one answer every recommendation the lead had put to them that day, and with that answer closed v0.101.0's intake under one rule: a raised item enters v0.101.0 only when it loses a user's data or weakens security and its fix is small and local, a test-only or infrastructure item only when it makes the release gate or a release job unreliable, and an item whose fix changes a contract or reopens excluded scope, or whose fault is a wrong state with a rare trigger, goes to v0.102.0. Under that rule the build goes to v0.102.0: the fault is a wrong state whose trigger is rare, a draft that is a drawing, edited as source, with a text that does not parse. The shape is ruled with it: a draft drawing whose text does not parse may be discarded from the draft's own dialog with no save first, and that dialog offers discard and cancel only. When it was raised the item put this to the owner as a question of product, with no recommendation. It is not part of v0.101.0.

## What was seen

A draft's close saves a draft that has unsaved edits first, and when the save leaves it with unsaved edits it returns with the tab open, before the draft's own dialog, which offers to save the draft into the workspace or to discard it, can open (`handleDraftTabClose`, `web/packages/workspace-app/src/state/tabs.svelte.ts:3647-3693`, the save at `:3658-3661`, the dialog at `:3668-3680`). A drawing whose buffer does not parse is refused its save (`performSaveOnce`, `:5804-5812`), so a draft drawing in that state never reaches its dialog, and the user cannot discard it from there: the ways out are to fix the text or to undo it back to the saved one.

The drawing's refused save, in hand and not landed, keeps that refusal and says why, once, by the lead's ruling, which chose it over the plan's recommendation: a first dialog that throws the edits away and then the draft's own, where a cancel of the second would leave a tab open whose edits the first had taken.

On 2026-09-28 the drawing's refused save landed with that refusal: a draft drawing whose save is refused is not closed, its dialog does not open, and a notice says `<file> was not saved.`, while the tab's toolbar keeps the reason (`handleDraftTabClose`, `web/packages/workspace-app/src/state/tabs.svelte.ts:3708-3727`, the dialog at `:3735`; `src/components/FileEditorTab.svelte:1288-1291`). The notice's reason and its instruction were taken out by the lead's ruling on that order's review, since a notice shows for three seconds (`src/state/store.svelte.ts:528`, `:580-582`). What a discard from the draft's dialog would touch is in that order's report (`dev/v0101-team/reports/report-Frontend-26.md` in the development tree, "Residuals").

## Desired contract

The owner's to decide: whether a draft drawing whose buffer does not parse can be discarded from the draft's own dialog, with no save first, and what such a discard throws away.

## What to do

If the owner allows it, the draft's close opens its dialog without a save when the buffer does not parse, and its Discard removes the draft as it does today; the lead's answer asks the drawing order's report to say what that would touch. If not, nothing changes and this item closes with the ruling.

## Boundaries

`handleDraftTabClose` in `web/packages/workspace-app/src/state/tabs.svelte.ts` and the draft's close dialog, with their tests.

## Acceptance

1. The owner's ruling is recorded here.
2. If a discard is allowed: a draft drawing whose buffer does not parse, closed, reaches its own dialog, and its Discard removes the draft with nothing written first, pinned.

## What shipped

Built on 2026-10-03 on the v0.102.0 integration branch and not on `main`, in a range the lead accepted on its report, a reading of its diff and its own gate. This record was written that day from that reading.

A draft drawing whose unsaved text does not parse runs no save at its close and opens the draft's own dialog (`handleDraftTabClose`, `web/packages/workspace-app/src/state/tabs.svelte.ts`; `web/packages/workspace-app/src/components/DraftCloseModal.svelte`). The dialog then names no destination, gives the parse reason and offers Discard Draft and Cancel alone, with focus on Cancel. Discard removes the draft with nothing written first, and Cancel keeps the tab with the text as typed. The ruling is read as the state in which the close's save is refused: a draft whose text on disk does not parse and has no unsaved edit keeps the dialog that saves it, since its save promotes the file as it is. Pinned in `DraftCloseModal.test.ts` and `tabs.drawingSave.test.ts`, each pin red under a mutation; `web/packages/workspace-app/src/editor/design.md` describes the close. Left by it: what a reopen does with a draft discarded this way, raised as [a-reopened-broken-drawing-comes-back-clean](a-reopened-broken-drawing-comes-back-clean.md).
