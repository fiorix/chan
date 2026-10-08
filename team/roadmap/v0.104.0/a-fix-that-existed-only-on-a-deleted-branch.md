# A fix that existed only on a deleted branch

Status: accepted for v0.104.0 by the owner's word of 2026-10-08 as a triage with a written answer; a repair is built only if the triage finds the behavior open and the lead accepts it.

## What was seen

`8bd2da204` "fix(workspace-app): withhold fallback saves for unresolved live pushes" was on `v0101/frontend-29` alone when that branch was deleted on 2026-10-07 (`../chan-dev/releases/v0101-team/BRANCHES-DELETED-2026-10-07.md`); the object is still in the local repository. Its message: keep scene and document saves off the classic PUT path when a bounded wait expires or a socket is retired with a push unanswered; carry the unsaved reason across tab replacement and retain close warnings until a confirmed writer saves the buffer; distinguish same-socket snapshots from fresh reconciliation. It touches `docSync.svelte.ts`, `sceneSync.svelte.ts`, `tabs.svelte.ts` and their tests (10 files, 428 insertions, 135 deletions), with focused tests passing and no full gate at the time.

## Desired contract

A written answer: the behavior that commit repaired is present on `main` (the fallback PUT still fires after an unanswered push), repaired another way (the commit named), or open with the evidence; and if open, whether a repair is accepted for this version.

## What to do

Read the commit against `main` at the base: locate each repaired path in today's `docSync.svelte.ts`, `sceneSync.svelte.ts` and `tabs.svelte.ts`, and say for each whether the fallback save after an expired wait or a retired socket still reaches the PUT path. Where the answer is a reading, say so; where a test can show it, write the failing test and keep it as the record. Report to the lead for the scope decision before any product change.

## Boundaries

`web/packages/workspace-app/src/state/docSync.svelte.ts`, `sceneSync.svelte.ts`, `tabs.svelte.ts` and their tests. A repair, if accepted, is a new commit designed against today's code, not a pick of the old one unless it applies and the lead accepts the pick.

## Acceptance

1. The written answer for each repaired path: present, repaired another way with the commit, or open, with the reading or the test that shows it.
2. If open: the lead's scope decision recorded here, and the repair, if accepted, red first with `make web-check` green.
