# Checks 165 and 170 assume a state the app replaces under them

Status: raised for v0.109.0 on 2026-10-22 by the lead, from the review seat's placement of two reds in the browser suite's whole runs at the suite runner's commit; closes in the round.

## What was seen

Check 165 (`scripts/e2e/browser-smoke/checks/165-bulwrp-hang.mjs`, `applyArm` at 105 to 124) switches the editor theme for an arm by setting `data-editor-theme` on the document root by hand. The app's effect in `web/packages/workspace-app/src/App.svelte` (336 to 340) writes the stored `editor_theme` preference back onto the root whenever `currentPreferences()` changes, and that value is `workspace.info?.preferences` (`currentPreferences`, `store.svelte.ts` 877 to 879), so any replacement of the workspace info during an arm restores the stored theme. In a whole run the google_docs arm's first two readings were 14.67 px and its later 22 were 16 px, the github arm's size: the arm's own full-document saves, whose frames fill the arm, are the likely trigger (the timeline records no workspace fetch, so the trigger is inferred). The corrected run passed in the same guest with the same fonts under higher I/O pressure, so the font set is not the cause; the check's per-reading font assertion is what caught the lost arm. Check 170 (`checks/170-status-pill-closes.mjs` 88 to 98) assumes the status pill holds the Transfers launcher alone when it waits for the pill to leave, and never checks that; in the corrected run the pill's section was the indexer's ("reindexing ..."), and the check timed out while the guest was stalled on I/O.

## Desired contract

Each check sets the state it measures through the app and asserts the precondition it waits on: check 165's theme survives the app's preference write-back, and check 170 waits for the pill only once the pill holds the launcher alone.

## What to do

Check 165 sets each arm's theme through the preference the app keeps (`PATCH /api/config` with `editor_theme`, the attribute waited for after the write, the original restored in a `finally`), or re-asserts the attribute before every reading and fails with "the theme was replaced" when it changed, whichever the reading of the preference write finds sound; the row records which and why. Check 170 waits for the indexer to be idle (no reindexing section on the pill) before it raises the pill, and asserts the pill's sections are the launcher alone before waiting for its removal. Pins red first by construction: for 165, a preference write of another key during an arm (the app's write-back forced) reddens the check at the parent and not at the commit; for 170, a raise while the indexer's section shows reddens the parent and not the commit.

## Boundaries

The two check files and, if a helper serves both, `scripts/e2e/browser-smoke/lib/`. Not changed: the app's preference effect, the status pill, the other checks.

## Acceptance

1. The two constructed pins red at the parent and green at the commit, with the commands and logs recorded here.
2. Checks 165 and 170 green alone at the commit three times each, and `make e2e-check` green.
