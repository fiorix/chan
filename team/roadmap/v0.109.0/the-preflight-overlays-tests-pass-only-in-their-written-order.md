# The preflight overlay's tests pass only in their written order

Status: raised for v0.109.0 on 2026-10-21 by the lead, from a shuffle control run at the version's base; closes in the round.

## What was seen

`web/packages/workspace-app/src/components/PreflightOverlay.test.ts` is green in its written order and red under vitest's shuffled order. At the base (`980864e24`, svelte 5.56.4, vitest 4.1.11), four of five seeds (11, 23, 37, 41) fail "a poll that lands after an answer does not bring the answered step back" and seed 59 passes; at the refreshed web lockfile (svelte 5.57.2) the same four seeds fail, and three of them fail a second test as well (23 and 41 "a decision cancels its pending poll timer", 37 "an earlier held poll cannot replace an accepted decision") (`dev/v0109-team/evidence/Frontend109/webdep1/timers/shuffle-control-1.log`). The control ran with nothing of the lockfile refresh applied, so the dependence is the file's own. The file's `afterEach` unmounts every view, clears the fake timers, restores the real ones, empties the body and restores the mocks; which value survives from one test into the next is not established.

## Desired contract

Every test in the file passes alone and in any order: the file is green under vitest's shuffled order for the five seeds above and in its written order, at the same commit.

## What to do

1. Reproduce in a guest with `--sequence.shuffle --sequence.seed=<n>` for the seeds above and read which earlier test leaves the state the failing test reads: a mock installed with `mockResolvedValueOnce` and never consumed, a poll promise still pending when the mocks are restored, a timer that outlives `vi.clearAllTimers`, or a module-level value in `PreflightOverlay.svelte` or a module it imports.
2. Make each test own its state: consume or reset what it installs, and let the shared `afterEach` wait for the pending poll to settle before it restores the mocks, if that is the carrier.
3. Pin the repair red first: the five seeds red at the parent and green at the commit, with the commands and log paths in this row.

## Boundaries

`web/packages/workspace-app/src/components/PreflightOverlay.test.ts` and, only if the carrier is product state a test cannot reset, the smallest seam in `PreflightOverlay.svelte`. Not changed: the overlay's behaviour, its poll interval, the other test files.

## Acceptance

1. The file green under the five seeds and in its written order at the commit, red under at least one of the seeds at the parent, with the commands and their log paths recorded here.
2. `make web-check` green at the commit.
