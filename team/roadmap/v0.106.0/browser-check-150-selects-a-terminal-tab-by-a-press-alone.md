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

## The release built, reviewed and landed; the settle wait's red placed in two rows 2026-10-13

Acceptance 1 (the desktop seat, `dev/v0106-team/tasks/task-Desktop106-Lead106-47.md` in the round's bus; `evidence/Desktop106/chk150-*`): the cause as the first section says, read against `Pane.svelte` 1505 to 1526 (a primary press on a terminal tab records a pending press and selects nothing; the release selects only with button 0, the same tab and the same visible side; a release reaching `document`, a `pointercancel` or a window blur clears it); nine `mousedown` hits across seven checks and one helper read with a verdict each, check 150's line 202 the only lone press on a terminal tab, the others an observer, comments, paired releases on file browser and graph tabs and editor observers. The review seat's own search (`reviews/review-Review106-chk150-release-1.md`) agrees and widens it: one `pointerdown` on a terminal surface to dismiss a menu, eleven trusted presses each with its release, two synthetic pairs, a `contextmenu`, synthetic `dragstart`s with no press, and nothing outside the suite on a tab. Acceptance 2: one insertion at line 203, the matching `mouseup` dispatched on the same node, landed on the integration branch as `0b579ab37`; at the tip the check red three of three alone on both backends, green three times alone and once between 149 and 151 in the seat's guest's Chrome for Testing 155; the review's mutants of the pair (the press removed; the release with button 1, on the other tab, on `document`, not bubbling) each red at the selection wait, so each clause of the product's rule is needed and the selection is the product's. Acceptance 3 held: no product file.

Not a green check yet. With the selection working the check reaches its next wait, the co-view settle (its lines 209 to 211, added 2026-10-10 and unreachable since the click repair), and there it is red about one run in eight in the review's guest: 3 runs of 23 at the tip, each one leg with `sourceGets=0`, and green 32 of 32 with the close moved after the settle. The cause is not the check's and not this commit's: the server stores a session write whose client has gone and never announces it (the row `sessann`, ordered repaired in this round), and the app's exit flush trusts a save that was only sent (the row `exitfl`, the next version's design). Ruled by the lead: the check is not changed to close after the settle, since that wait is the one place in the suite that meets the server's defect; it is counted again at an integration tip that carries `sessann`'s repair (24 runs alone or more, and the neighbours), and if that landing is not reached the candidate's whole run carries this red named with its rate. The item's acceptance 2 as first written (green three times alone and once between neighbours) is met and is not a sufficient bar for this check: at 3 of 23, four green runs happen about 57 times in 100. Not established: WebKit; the rate before the click repair; the rate on a machine that is not throttled.

Counted again at the landed repair (the desktop seat, `tasks/task-Desktop106-Lead106-49.md` and `reports/report-Desktop106-chk150-count.md` in the round's bus; the runs under `evidence/Desktop106/chk150-count-artifacts/`): at `66e54d206`, the integration tip carrying `sessann`'s repair, check 150 unchanged is green 24 of 24 alone and 4 of 4 between checks 149 and 151 in the seat's guest's Chrome for Testing 155 on Linux, 56 settled backend legs each recording one source-session GET, both backend restarts completed in every run, no red leg, no skip and no retry; a functional count under the guest's 2 CPU cap, with no timing claim. The settle red of about one run in eight at the unrepaired route is not seen at the repaired tip, so the candidate's whole run carries no named red for this check. Still not established: WebKit; the rate on a machine that is not throttled.
