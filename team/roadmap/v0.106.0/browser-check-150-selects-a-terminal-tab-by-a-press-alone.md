# Browser check 150 selects a terminal tab by a press alone

Status: raised by the review seat on 2026-10-13 from its runs beside the CLI-reload range (the last section of `reviews/review-Review106-clirld-range-1.md` in the round's bus); written down the same day by the lead as a row of its own; owner the desktop seat, named writer of the checks across lanes for the repair; a measurement and a test-only repair ordered in the round

## What was seen

`150-program-attach.mjs` fails alone at the integration tip `710527543`, three runs of three, and three of three at the review's composition with the CLI-reload range, on both terminal backends, at its wait for a tab selected in the reloaded co-viewer (its line 205); the check selects that tab by dispatching a `mousedown` alone (line 202). Twenty green runs of the check are recorded before `232964748` landed ("select terminal tabs on matching release", the repair of the item `ftrip`), after which a press on a terminal tab is held pending until its matching release. Read, not run: that a press and its release in the check turns it green, and which other checks select a terminal tab by a lone press.

## Desired contract

Each check selects a terminal tab the way the product selects it, a press and its release, so the suite's checks pass alone and in any position at a tip that carries the click repair.

## What to do

Reproduce check 150 alone at the tip; read the pending press in `Pane.svelte` against the check's dispatch; enumerate every check and helper that selects a terminal tab by a lone press, with check 150's line as the positive control; repair each in the check, red first, green alone and between neighbours.

## Boundaries

`scripts/e2e/browser-smoke/checks/*.mjs` and the suite's helpers. No product file: the product's rule is the `ftrip` item's, reviewed and landed.

## Acceptance

1. The cause written down with the lines, and the enumeration of lone presses with a verdict per line.
2. Check 150 and every repaired check green three times alone, and check 150 once between its neighbours, in the suite's Chrome with the engine named; the three reds at the tip retained as the base.
3. No product change.
