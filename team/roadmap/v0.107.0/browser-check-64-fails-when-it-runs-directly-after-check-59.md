# Browser check 64 fails when it runs directly after check 59

Status: carried into v0.107.0 at the v0.106.0 GA on 2026-10-15, still raised for a decision.

Record before the release: raised by the review seat on 2026-10-13 from its read of the markdown click range (N6 of `reviews/review-Review106-mdclick-range-1.md` in the round's bus); written down the same day by the lead as a row of its own; owner the hygiene seat; a reading ordered in the round

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

## The reading 2026-10-13

Acceptance 1 (the hygiene seat, `dev/v0106-team/tasks/task-Hygiene106-Lead106-26.md`; `evidence/Hygiene106/check64-reading-1/`), in its guest's Chrome for Testing 155 against a bundle and a debug `chan` built at the integration tip `143219483`: check 64 alone green three times; check 59 then 64 red three times ("banner never appeared"); the reverse order green; 59, then check 60 (which runs its own devserver), then 64 red; and the pair green when check 59's malformed fixture is removed after its own assertion, the only input changed. The cause, by source and by run: check 59's scenario D writes `bad-utf8.md`, a Markdown file that is not valid UTF-8, into the shared throwaway workspace (`checks/59-large-file-streaming.mjs` 285 to 293) and nothing removes it (the check's `finally` closes only its extra page); the runner seeds one workspace and one server for the whole selected sequence and resets neither between checks (`run.mjs` 134 to 140, 358 to 470); the server's indexer reports the file as an error (`bad-utf8.md: io error: stream did not contain valid UTF-8`) and the next page boots behind the full-viewport preflight cover reading "Build search index failed" (the failing run's screenshot shows it); check 64 finds its editor text mounted behind the cover and proceeds, its local rewrite never reaches the document authority (no `push-ok` and no `conflict` frame in the 66-event timeline), the external write is adopted, and no banner appears. The resource readings of the red and green runs are alike; the order and the fixture, not load, decide the outcome.

The lead's ruling: the suite's fault is check 59's fixture lifetime, repaired in that check (the malformed file scoped to scenario D and removed in a `finally` that runs when D fails too, then a bounded wait on the preflight reading unlocked before the check hands the workspace on), red first as the frozen pair, then both orders, each alone and the pair with a neighbour between; the hygiene seat's task 26. The product's fault behind it is not the suite's to hide: one Markdown file that is not valid UTF-8 leaves the index status at an error and holds the next window behind the cover with its commands dropped. That is the row `idxlock`, now reached with an ordinary file, and its own acceptance asks for a browser arm of its own.

## The commit's home at the v0.106.0 GA 2026-10-15

The commit this item waits on, `7227f11c9b1986dd083eb84cdfeb19ac9598e689` on the seat branch `v0106/hygiene` (not landed on the integration branch), is kept as the patch `dev/v0106-team/evidence/Lead106/ga/carried-patches/chk64o/0001-test-e2e-retire-malformed-file-before-next-browser-c.patch` in the round's bus, which the round's archive carries after the seat branches are deleted at the teardown; it applies on the integration tip `671e49126` (`git apply --check` at the cut).
