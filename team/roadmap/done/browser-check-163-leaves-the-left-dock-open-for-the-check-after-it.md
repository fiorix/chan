# Browser check 163 leaves the left dock open for the check after it

Status: shipped in [v0.106.0](../../release/release-v0.106.0.md).

Record before the release: raised by the frontend seat on 2026-10-13 from two whole runs of the suite beside its check 165 (followup 57 in the round's bus); measured and read at source by the hygiene seat the same day; written down the same day by the lead as a row of its own; owner the hygiene seat, named writer of the check across lanes for the repair; a repair of the check's teardown ordered in the round

## What was seen

In two whole runs of the browser suite, the first since check 163 landed, check 20 (`20-pdf-inspector`) failed with "Waiting for selector .pill-caret failed" at its line 545 directly after check 163 (`163-file-browser-watch-refresh`). Check 20 alone passes, and passes after check 165 and after check 162; 163 then 20 fails every time. The suite's README says a check passes alone and in any suite position.

## Desired contract

Each check passes alone and in any position: no check leaves state the next one meets, and no check needs state a neighbour left.

## What to do

Read what check 163 leaves and what check 20 needs, by running the pair and each check alone with their results kept, and by reading both checks and the runner's per-check reset; say which of the two is at fault. Then the repair in that check, red first as the pair, green as the pair, alone and with the neighbours between.

## Boundaries

`scripts/e2e/browser-smoke/checks/163-file-browser-watch-refresh.mjs`, `checks/20-pdf-inspector.mjs`, the runner's per-check reset in `scripts/e2e/browser-smoke/run.mjs` and its helpers. No product file unless the reading finds a product fault, which then gets an item of its own.

## Acceptance

1. The cause written down with the lines of the check or the runner and a run of the pair that shows it.
2. The pair green three times, each check green alone and the pair with a neighbour before it, in the suite's Chrome, with the engine named; the restore's absence red as the pair.
3. The repair adds no wait to a check that did not change the state it restores, stated.

## The reading and the lead's ruling 2026-10-13

Acceptance 1 (the hygiene seat, `dev/v0106-team/tasks/task-Hygiene106-Lead106-44.md` in the round's bus; `evidence/Hygiene106/check163-20-43/`), in its guest's Chrome for Testing 155.0.8059.39 against a bundle and a `chan` binary built at the integration tip `710527543`, each run bounded inside the guest on a fresh disposable workspace, home and server, with `SMOKE_PDF_CASES=doc.md`: 163 then 20 red three times (check 20 at 10.7 to 10.8 s on `.pill-caret`), 20 alone green three times (2.3 to 2.8 s), 162 then 20 green. The cause, by source and by the runs' screenshots: check 163 opens the left dock with "Stick to left" (its lines 206 to 218, only when no dock tree exists) and its `finally` (229 to 235) removes its files and its observer but never restores the dock; the toggle persists the preference `browser_side_panes.left` (`state/store.svelte.ts` 4726 to 4747) and the next page hydrates it (871 to 874), since the runner keeps one server and one `CHAN_HOME` across checks and closes only each browser context (`run.mjs` 214 to 226). Check 20's `openFileBrowser` (its lines 521 to 529) returns for any `[role=tree]`, so it accepts the persisted dock and opens no browser tab; its unscoped row click selects `doc.md` in the dock, where the Details inspector is rendered for a browser tab alone (`FileBrowserSurface.svelte` 391 to 395 and 537), so the awaited `.pill-caret` never mounts. The failing runs' screenshots show the left dock and an empty main pane; the passing runs' show the browser tab and its inspector. The three red runs carried CPU throttling and memory-max events in the guest's cgroup, as the green controls did; the wait's ten seconds are not a timing judgment, since the inspector was never mounted.

The lead's ruling: the suite's fault is check 163's teardown, repaired there: the check records whether it opened the dock and, when it did, puts it back as it found it and waits until the persisted preference and the dock's DOM agree with the restored state before it returns, under a named bound; a check that did not open the dock restores nothing, and the check's own measurement is unchanged. One test-only commit, written by the hygiene seat in the frontend lane's file by the lead's naming (the repair is small and in the teardown it read; the frontend seat's task at the time was a reading that touched neither check). Check 20's opener, which accepts any tree where it means a browser tab's, is a second weakness kept as a stated cost of this version: it is reached only by a check that leaves the dock open, and the repair above removes the one such check. The runner's reset is not changed: a persisted preference is the page's state to restore, as the README's contract puts it on the check that changed it. The whole suite's run at the candidate is the first to meet the repaired pair in sequence.

## The restore built, reviewed and landed 2026-10-13

Acceptance 1 is the section above. Acceptance 2 (the hygiene seat, `dev/v0106-team/tasks/task-Hygiene106-Lead106-45.md` in the round's bus; `evidence/Hygiene106/check163-20-44/final/`), one test-only commit landed on the integration branch as `e423d7d7f`, check 163 alone: the check records its own successful "Stick to left" click and, in its `finally`, when it opened the dock, clicks "Unstick left" through the dock's context menu (the same menu item labelled by the store's state, which calls the toggle and writes both sides as booleans), then polls the preference from `GET /api/config` and the page's dock DOM until both show the closed state, with bounds of 15 s for the opening agreement, 10 s to find the action and 15 s for the restored state; the unstick is in a `finally` of its own, so a measurement that fails still restores; the file, observer and CDP cleanup stay outermost. At the commit on the task 43 binary in the seat's guest (Chrome for Testing 155): the pair 163 then 20 green three times (check 20 at 2.5 to 3.0 s), 163 alone, 20 alone, 162 then 163 then 20, all green; `node --check` and `git diff --check` 0; the red first is the three pairs of the section above at the same tip, which are also the restore's absence. The check's report fields, waits and root-listing measurements are unchanged; check 20 is untouched.

The review seat's read (`reviews/review-Review106-chk163-restore-1.md`), from its own build: the pair red twice at the base and green three times at the tip, each check green alone; the unstick click removed red at the restore's poll; the opened flag never set, check 20 red (the pair is the pin); the measurement made to fail with the restore intact, check 20 green (the preference is back on the failing path too); the restore's menu item missing, the check red and not silent. The restored value is `left: false`, never an absent key, which the poll's strict comparison accepts; no other check names the dock or its preference; the bounds add at most 40 s to a failing run. One note, accepted by the lead as a stated cost: when the measurement and the restore both fail, the restore's error replaces the measurement's in the result, so a reader of that red starts from the cleanup; a later test-only line would catch the restore's error and rethrow the body's with it as the cause. Acceptance 3: a check that did not open the dock restores nothing and waits for nothing. Not established: the whole suite with the commit (the candidate's run); WebKit; a slower machine against the three bounds.
