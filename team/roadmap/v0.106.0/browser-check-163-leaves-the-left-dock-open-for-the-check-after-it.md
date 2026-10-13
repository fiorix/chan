# Browser check 163 leaves the left dock open for the check after it

Status: raised by the frontend seat on 2026-10-13 from two whole runs of the suite beside its check 165 (followup 57 in the round's bus); measured and read at source by the hygiene seat the same day; written down the same day by the lead as a row of its own; owner the hygiene seat, named writer of the check across lanes for the repair; a repair of the check's teardown ordered in the round

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
