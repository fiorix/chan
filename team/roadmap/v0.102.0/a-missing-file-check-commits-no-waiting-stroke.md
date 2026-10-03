# The missing-file check commits no waiting stroke before it reloads

Status: raised for a decision on 2026-10-02 and held under v0.102.0. It is the third route of [a-stroke-in-the-debounce-is-lost-to-a-load](../done/a-stroke-in-the-debounce-is-lost-to-a-load.md), whose other two routes are built in v0.101.0 as the owner accepted that item; by a ruling of the lead's on 2026-10-02 the third gets a row of its own, since a standing hold on missing-file work keeps it out of v0.101.0. Read in the code at `d7a7a7fa0`; not run.

## What was seen

`resolveMissingFileCheck` (`web/packages/workspace-app/src/state/tabs.svelte.ts`) decides whether a tab is clean by comparing its buffer with its saved text, and commits no waiting editor input before it compares, where `refreshTabFromDisk` and `forceReloadFromDisk` in the same file call `flushTabEdits` before their guards. A stroke still inside the canvas's debounce when the check runs is not in the buffer yet, so the tab reads clean and what follows treats it as one. `web/packages/workspace-app/src/editor/design.md` says that the check commits nothing first. Inferred from the code; the loss was not reproduced.

## Desired contract

A stroke that is waiting when the missing-file check runs is committed before the check decides that the tab is clean.

## What to do

Commit the tab's waiting edits before the comparison, as the two built routes do. Red first, mounted: a stroke waiting when the check runs is in the buffer after it.

## Boundaries

`web/packages/workspace-app/src/state/tabs.svelte.ts`, its tests and one sentence of `editor/design.md`. `ExcalidrawCanvas.svelte` is not touched.

## Acceptance

1. A stroke waiting when the missing-file check runs survives it, pinned red first.
2. `editor/design.md` says what the check commits.
