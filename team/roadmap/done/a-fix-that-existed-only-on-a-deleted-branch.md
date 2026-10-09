# A fix that existed only on a deleted branch

Status: withdrawn, and it did not ship: the triage found the same web patch already on `main` as `5848f628a`, with the guards it names in place, so this version needed no repair and added no code for it; closed at [v0.104.0](../../release/release-v0.104.0.md), which records the triage.

Record before the release: accepted for v0.104.0 by the owner's word of 2026-10-08 as a triage with a written answer; the triage of 2026-10-08 finds the same web patch on `main` as `5848f628a`, so no code is built and the item closes at the cut as repaired another way.

## What was seen

`8bd2da204` "fix(workspace-app): withhold fallback saves for unresolved live pushes" was on `v0101/frontend-29` alone when that branch was deleted on 2026-10-07 (`../chan-dev/releases/v0101-team/BRANCHES-DELETED-2026-10-07.md`); the object is still in the local repository. Its message: keep scene and document saves off the classic PUT path when a bounded wait expires or a socket is retired with a push unanswered; carry the unsaved reason across tab replacement and retain close warnings until a confirmed writer saves the buffer; distinguish same-socket snapshots from fresh reconciliation. It touches `docSync.svelte.ts`, `sceneSync.svelte.ts`, `tabs.svelte.ts` and their tests (10 files, 428 insertions, 135 deletions), with focused tests passing and no full gate at the time. The same web patch is on `main` as `5848f628a` (2026-09-29, the same subject, the same ten files, 428 insertions and 135 deletions), an ancestor of the base, with an equal stable `git patch-id` over `web/` (`ca0d5dd725323f8e33a494d575855891d669957e`); the whole-commit ids differ in the changelog hunk alone. So the deleted object was a second copy of a landed change, and what the triage has left to answer is whether a later commit undid any of it.

## Desired contract

A written answer: the behavior that commit repaired is present on `main` (the fallback PUT still fires after an unanswered push), repaired another way (the commit named), or open with the evidence; and if open, whether a repair is accepted for this version.

## What to do

Read the commit against `main` at the base: locate each repaired path in today's `docSync.svelte.ts`, `sceneSync.svelte.ts` and `tabs.svelte.ts`, and say for each whether the fallback save after an expired wait or a retired socket still reaches the PUT path. Where the answer is a reading, say so; where a test can show it, write the failing test and keep it as the record. Report to the lead for the scope decision before any product change.

## Boundaries

`web/packages/workspace-app/src/state/docSync.svelte.ts`, `sceneSync.svelte.ts`, `tabs.svelte.ts` and their tests. A repair, if accepted, is a new commit designed against today's code, not a pick of the old one unless it applies and the lead accepts the pick.

## Acceptance

1. The written answer for each repaired path: present, repaired another way with the commit, or open, with the reading or the test that shows it.
2. If open: the lead's scope decision recorded here, and the repair, if accepted, red first with `make web-check` green.

## Disposition 2026-10-08

Repaired another way, by `5848f628a` on `main`. The frontend seat's triage (`dev/v0104-team/reports/triage-Frontend104-item9.md`), checked by the lead and by the reviewer with git (`git merge-base --is-ancestor 5848f628a 910811335` exits 0; equal `web/` patch-ids), reads the live source at the base as keeping every repaired path: `docSync.svelte.ts` line 543 and `sceneSync.svelte.ts` line 796 return `unresolved` when the bounded settlement wait expires and their settlement recheck blocks the fallback while the session owns saves or a push lacks an outcome; the socket-loss paths keep the unresolved claim; `tabs.svelte.ts` records the unresolved fields and the save reason (6025), suppresses classic saves under the claim (6128), consumes an unresolved delegate result without reaching the PUT (6204) and counts the unresolved-save flag in dirtiness (5755); the fields carry through tab clones and pane-mode merges. The regressions `docSync.test.ts` 1636, 1704 and 1743, `sceneSync.test.ts` 881 and 995, `cloneTabFields.test.ts` and `tabs.drawingSave.test.ts` pin them and run in the web gate. No code; no runtime check is claimed by the triage itself. Acceptance 1 is met by this reading; acceptance 2 does not arise.
