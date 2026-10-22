# Check 163 judges a late frame of an ended step as its last and bounds the setup's drain at 30 s

Status: raised for v0.109.0 on 2026-10-22 by the lead, from the review seat's reading of the idle-reload item's check model; closes in the round.

## What was seen

Browser check 163 (`scripts/e2e/browser-smoke/checks/163-file-browser-watch-refresh.mjs`) waits for the shared graph's fetch after each step's apply frames under one 30 s bound (`graphFetched`), the setup's 81 files included; the apply-coalescing item's loaded reading of those 81 files had its applies running from 1.4 to 33.0 s after the writes (a 31.6 s span beside a compile load in the integration guest), so under such a load the setup can time out ("the shared graph's fetch after the apply frames of setup") with nothing wrong in the page, and a green run never waits on that bound. A step's frames run to the next step's marks (`frameAt`, `applyAt`), which are taken only when the next step starts, and every transition but rename to removal passes through CDP awaits before them (the detector's finish and re-arm after the first created step and its re-arm after the modified step, tens of milliseconds; the expansion and the Control-click after the unopened step; the dashboard command after the second created step; the context menu and the dock after the hidden step, seconds): a late frame for the ending step's path that arrives in that gap less than a quiet window (250 ms) before the next step's marks becomes the step's last stamp while its own fetch counts to the next step, so the step's last fetch precedes its last frame, `lastGapMs` reads negative or under 200 ms, and the check is red with nothing wrong in the page; earlier in a long gap the frame's own fetch lands in the step and costs one fetch inside the race allowance. A second `Modified` frame 3.3 s late was seen once in 33 runs and landed after the next mark, so the red itself has not been seen; thirteen green runs bound its rate loosely.

## Desired contract

Check 163 reads a loaded setup to its end and judges each step by the frames that belong to it, so it is red for a page fault alone.

## What to do

The setup's `graphFetched` wait takes 90 s, as the first-build wait has (a bound parameter on `graphFetched`, or 90 s for every step). When `graphFetched(step)` resolves, the check records the step's end marks (`frames.length`, `applied.length`) and judges its stamps up to them; fetches stay counted to the next step's `graphAt`. A late frame in the gap then costs at most one fetch inside the race allowance and still shows in the report's counts.

## Boundaries

Check 163 alone. Not changed: the product, the suite's helpers and runner, the other checks, the step model's quiet windows and its race allowance.

## Acceptance

1. The step slice shown red first: a constructed frame list with a frame stamped between a step's end marks and the next step's marks is judged that step's last by the check at the parent and no step's at the commit (the judging code run on constructed input), or, where the check's judging code cannot run apart from a page, a mutant at the commit that drops the end marks; the setup's bound is read as text, since a green run never waits on it.
2. Check 163 alone ten times at the commit in the owning seat's guest and at the landing in the integration guest, green, with the report's counts in the row.
3. The row's closing section names the bound, the slice and the counts.
