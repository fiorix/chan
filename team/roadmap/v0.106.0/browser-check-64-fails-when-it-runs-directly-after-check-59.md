# Browser check 64 fails when it runs directly after check 59

Status: raised by the review seat on 2026-10-13 from its read of the markdown click range (N6 of `reviews/review-Review106-mdclick-range-1.md` in the round's bus); written down the same day by the lead as a row of its own; owner the hygiene seat; a reading ordered in the round

## What was seen

In the review seat's set of fifteen editor checks, `64-conflict-banner-reload` failed with "banner never appeared" at the base bundle and at the markdown click tip's bundle alike. Read alone at the tip bundle it passes (3 of 3) and after check 58 (1 of 1), and fails directly after `59-large-file-streaming` (the pair once, and both runs of the set, where 59 precedes it: 3 of 3). In a whole run three checks stand between the two, so the whole suite does not meet it today. The suite's README says a check passes alone and in any suite position.

## Desired contract

Each check passes alone and in any position: no check leaves state the next one meets, and no check needs state a neighbour left.

## What to do

Read what check 59 leaves and what check 64 needs (the workspace's files, the server's state, the page's storage, a watcher or an index still busy with the large file), by running the pair with each check's timeline kept and by reading both checks and the runner's per-check reset; say which of the two is at fault. Then the repair in that check or in the runner's reset, red first as the pair, green as the pair and alone.

## Boundaries

`scripts/e2e/browser-smoke/checks/59-large-file-streaming.mjs`, `checks/64-conflict-banner-reload.mjs`, the runner's per-check reset in `scripts/e2e/browser-smoke/run.mjs` and its helpers. No product file unless the reading finds a product fault, which then gets an item of its own.

## Acceptance

1. The cause written down with the lines of the check or the runner and a run of the pair that shows it.
2. The pair green in both orders and each check green alone, in the suite's Chrome, with the engine named.
3. A whole suite run not made slower by more than the repair's own wait, stated.
