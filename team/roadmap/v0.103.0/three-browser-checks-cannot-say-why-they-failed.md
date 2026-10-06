# Three browser checks cannot say why they failed

Status: failure diagnostics built and independently reviewed; combined browser acceptance pending. Check 123 behavior stays unchanged.

## Owner decision, 2026-10-06

Retain every failing page's own state and screenshot before cleanup in all three checks, sharing instrumentation with the stall probe. Deliberate failures must prove that the records survive and contain the expected details. Keep check 123's behavior unchanged until recorded evidence supports a change; if its first-connect assertion is later separated, retain foreground/reconnect coverage. This decision does not accept the proposed no-foreground wait change.

## Implementation evidence, 2026-10-06

The six-file harness range through `171bd53ab` is integrated at `a6de8ece3`. The runner keeps a bounded, token-masked timeline of page warnings and errors, slow or failed requests, listings, socket events, server lines and guest resource counters. Checks 30, 98 and 123 retain their own live pages' state and screenshots before cleanup. Check 30 keeps export legs and upload timing; check 98 keeps deletion, listing, watch and page evidence; check 123 keeps both co-viewers. Verdicts, time bounds and check 123's foreground behavior are unchanged.

Deliberate failures in the actual checks, respectively after the second-window deck export, after root deletion and after both co-viewers mounted, each exited 1 with the intended error, a false final verdict, page captures and a timeline. The temporary patches were restored and their source hashes checked. Independent review read the source and these artifacts; the integrated recorder's two focused tests and all 79 e2e syntax checks passed in the lead's separate guest. An earlier recorder timestamp defect was repaired, and a run that exceeded the original event cap remains recorded beside the larger-cap rerun.

These results establish failure retention, not the causes of the earlier product failures or a stable suite. Whole-suite and every-check-alone acceptance at one frozen combined candidate remain open. No check 123 wait change or five-run acceptance of such a change is claimed.

## Record before this decision

Every section below records the state before the dated decision above and is preserved as history. The dated decision governs the current scope.

Previous status: raised for a decision on 2026-10-05, before the v0.102.0 GA, and listed under v0.103.0 from the start: the owner asked that day that what leaves v0.102.0 be put in the next version's list to be checked, and this is the lead's proposal for that list. `raised | decide`: not accepted and not built; the owner has not ruled on it and did not take it into v0.102.0, which shipped on 2026-10-05.

Raised by the lead from the readings of three reds of the browser smoke suite on 2026-10-05: check 123's at `e5ede897d`, and check 30's and check 98's at `adf953f6c`. Each reading was made at its commit with nothing run, each ends on what the red run did not record, and each names a repair on the check's side. The three checks have no diff from those commits to `22c1e8fc8`, the commit of the version's second release candidate, where they and the runner were read again for this item. Nothing was run for it.

## Owner ruling

Not ruled. For check 123 the lead ruled on 2026-10-05 that its wait changes only if a forcing run confirms the reading of its red, and the forcing run did not; the red itself is the owner's to rule, on the two rows that take check 123 as their proof, [a-windows-first-save-can-swallow-a-peers-unsent-split](a-windows-first-save-can-swallow-a-peers-unsent-split.md) and [a-window-misses-a-layout-saved-while-its-socket-was-down](a-window-misses-a-layout-saved-while-its-socket-was-down.md). For checks 30 and 98 the owner was told in writing on 2026-10-05 what their readings found, and nothing was asked about the checks themselves. No ruling on a check's repair is recorded.

## What was seen

Three reds, each in a whole run of the suite in the build guest on 2026-10-05 and each green in the other runs at its commit, and what each run kept. The runs are recorded on [the-browser-smoke-suite-is-red-at-the-base](the-browser-smoke-suite-is-red-at-the-base.md).

Check 123 was red at `A never showed B's split`, after 24.0 s. Its run kept the error and its stack, the start, the duration and one picture, and the picture is of the runner's own page: the check closes its two pages before the runner takes it. It kept no time and no state of either of the check's pages, and no line of their consoles or requests.

Check 30 was red at `cs export failed`, with `slide 2 render timed out after 30000ms` under it, after 143.8 s. Its run kept the command's output and its pictures. It kept no time of any of the check's three exports and no count of uploads, and nothing of the second window's console or requests; the reading took the first export's length from the time at which a picture was written.

Check 98 was red at its wait of thirty seconds for `Workspace root unavailable`, after 43.0 s. Its run kept the timeout and three pictures, and no details. What its own picture of its page shows is on [the-file-browser-keeps-a-tree-whose-root-is-gone](the-file-browser-keeps-a-tree-whose-root-is-gone.md).

Why, read in the suite at `22c1e8fc8`. The runner keeps a check's details from what the check returns, so on a pass, and on a failure keeps only what the check hung on its error as `smokeDetails`; it prints console errors and responses of status 400 and above for its own page alone, and on a failure it pictures its own page (`scripts/e2e/browser-smoke/run.mjs`). Check 30 returns its three legs' times, pages and upload counts and hangs nothing on an error (`checks/30-pdf-cs-export.mjs`). Check 98 returns its two timelines the same way, and its failure path takes one picture and throws the error on (`checks/98-workspace-root-loss.mjs`). Check 123 hangs nothing on its error and closes both of its pages before the runner's picture (`checks/123-hybrid-nav-stale.mjs`).

One check does otherwise, and is the precedent. Since `270bfb9af`, a commit of the suite built on 2026-10-05, check 54 hangs a record of its own failing page on its error before it closes that page, and the runner takes it; that commit added the one line of the runner that does. By its report a mutation of the check's wait showed the record hold the page's own picture, its document, 25 resource timings, 26 responses with their status and content type, the console's messages and no failed request.

## Why it matters

A red that records nothing is read from the code, and each of these three readings ends at not established. Check 123's red is what two rows of v0.102.0 wait on. Check 30's and check 98's were read beside states a user can meet, a slow `cs export` and a File Browser that keeps a tree whose root is gone, and neither run could say whether it was that state. As the checks stand, the next red of any of the three says as little.

## Desired contract

Not chosen: the owner's ruling decides whether anything is built. The lead proposes the three repairs the readings name on the check's side. They are of two kinds.

Two change what a failure records and not what passes, and by their reading need no red first. Check 30 keeps its three legs' times and the uploads it saw when it fails, hung on its error as check 54 hangs its record, and for both of its pages, for the length of each export, logs every request slower than five seconds with its path, start, duration and status, and the console's warnings as well as its errors; the reading says the page's own resource timings give the requests with no change to the product. No retry and no longer bound: by the reading either would hide a wait the owner can meet. Check 98 attaches, in its failure path, its two timelines, whether the tree's `rootUnavailable` flag and its error are set, the state of the page's event socket, how many watch frames arrived after the removal began and whether the root's own was among them, and the status and duration of each listing after it; the File Browser's item names the same record in its boundaries, and it can be built with either item. Not a longer wait.

The third changes what a check does. Check 123 would wait for the first window's two panes without bringing that window to the front first, with the wait's condition, its step of 100 ms and its bound of 20 s unchanged, so that the check no longer swaps the first window's event socket in the path of the frame it waits for; the check's later waits keep their swaps. Its reading set a proof for that: a forcing run, the first window loaded through the suite's delay proxy with 400 ms of latency set just before the second window's split. By the reading the unchanged check then reds every time at this wait, and in its own words, if the check stays green under the forcing, the reading is wrong. The lead ordered the change on that proof, three reds at the label; it was not met, and the check is as it was. The forcing ran six times. Before the delay proxy's repair: one red at the label, one at a wait for Hybrid Nav's mode, and one at a terminal's registration, a step that comes after this wait in the check. Through the repaired proxy: one red at a wait for Hybrid Nav's mode, which by its report did not reach this wait, and two at the terminal's registration, which by their report passed it. The records on the suite's item and on the layout item say that the fixture could not reach this wait because the check's earlier waits fail under the latency. By the runs' reports that is so of one run of the last three; three runs of the six reached this wait with the latency on and passed it, where the reading says it reds every time. None of the six was green: those three went red at a later step. So the owner is asked more than whether to build it: whether check 123's wait changes without the proof its reading set. Two things beside that. The lead ruled on 2026-10-05 that the wait without the fronting still holds what the layout item's acceptance asks, the read at a page's first open. And the gap at a return to visible, which the reading takes as its leading candidate for the red, is the cost the layout item writes and that [a-survey-is-refused-while-a-page-reconnects-after-a-wake-gap](a-survey-is-refused-while-a-page-reconnects-after-a-wake-gap.md) carries; the changed check would no longer meet it at this wait.

The reading of check 123 also lists what a probe of the check must put on one clock: each socket's creation, handshake and close, each `session_changed` frame, each session request, each change of visibility and the check's own steps. It names that as a probe to run and not as a record the check keeps of a failure; whether the check should keep it is not in the reading.

## Boundaries

`scripts/e2e/browser-smoke/checks/30-pdf-cs-export.mjs`, `checks/98-workspace-root-loss.mjs` and `checks/123-hybrid-nav-stale.mjs`, and `run.mjs` only as far as a record needs it. No product file, no wait made longer, no retry. Not the suite-wide probe of [the-browser-suite-stalls-on-a-different-check](the-browser-suite-stalls-on-a-different-check.md), which asks the same of any check, and not the product repairs of the File Browser's item.

## Acceptance

Left open until the owner rules.

1. The ruling is recorded for each of the three: built or left, and for check 123 whether its wait changes without the forcing run's proof.
2. For checks 30 and 98, if built: a mutation that makes the check fail shows its failure record hold what is named above, as check 54's was shown; the check is green alone and in a whole run after it, with no bound changed.
3. For check 123, if built: the check is green five of five alone and in a whole run, and the two items that take it as their proof say that its wait changed and on what.

## Not established

Why any of the three was red: each reading's verdict is not established, with one leading candidate for check 123, a frame lost in a socket swap the check itself starts, and three for check 98. That a hidden first window receives the frame, reconciles and shows two panes within the wait, which check 123's repair rests on: not run. That the page's own resource timings hold what check 30's record needs, for a page behind another too: the reading's statement, not run. What the six forced runs show of check 123's reading beyond their labels: their reports give no time and no state of either page, the latency also reached the check's other steps, and the first three ran through a proxy later shown to deliver out of order. That the third run before the proxy's repair passed this wait is taken from the order of the check's steps at `22c1e8fc8` and not from its report, which gives its label alone. The pictures of the forced runs were not viewed for this item, and nothing was run for it.
