# The preflight overlay's tests pass only in their written order

Status: shipped in [v0.109.0](../../release/release-v0.109.0.md).

Record before the release: built on 2026-10-22 on the seat's branch; the section Built 2026-10-22 holds the evidence; it closes at the GA as shipped.

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

## Built 2026-10-22

At parent `1b292adb50bd4d3ef3adf0a1d2daa8f8cfdb8d00`, shuffled seeds 11, 23, 37 and 41 failed the poll test at its second `api.preflight` call (line 89: expected two calls, got one); seed 59 and written order passed. In `PreflightOverlay.test.ts`, `hostDecision` installs fake timers and then spies on `setTimeout` (lines 125-126). The shared `afterEach` cleared timers and called `vi.useRealTimers()` before `vi.restoreAllMocks()` (lines 15-18), so restoring that spy last reinstalled the fake `setTimeout` function after the real clock was restored. A later real-timer poll was scheduled on that abandoned fake clock and never fired. This was test-owned timer state, not component module state. The five parent commands were `timeout 300 npx vitest run src/components/PreflightOverlay.test.ts --sequence.shuffle --sequence.seed=<11|23|37|41|59>` from `web/packages/workspace-app`; the written-order command omitted `--sequence.*`. Logs and raw statuses are under `dev/v0109-team/evidence/Hygiene109/pfshuf/parent/`.

The test file restores spies before returning to real timers. No component file or poll interval changed. The same five bounded shuffle commands passed, 16/16 tests each, in the guest working tree with the teardown reorder; the written-order command passed 16/16. Logs and raw statuses are under `dev/v0109-team/evidence/Hygiene109/pfshuf/repair/`. The exported guest patch is `dev/v0109-team/evidence/Hygiene109/pfshuf/repair.patch` (SHA-256 `eb58c341c725f73c65eea4d86fe6d275e26daf1386d491a5803ee496951c347f`), applied without edits to the owning worktree. The committed-run table in `dev/v0109-team/evidence/Review109/pfshuf/job-1.log` records ten of eleven shuffled seeds red at the parent and all eleven green at the repair tip.

One mutant restored only the unsafe teardown order. Seed 11 failed at the intended second-poll assertion (one call instead of two), raw test exit 1; the private checkout's fixed diff was restored byte-for-byte. Its log, status and before/after patches are under `dev/v0109-team/evidence/Hygiene109/pfshuf/mutant/`. A final test awaits a zero-delay real timer after the fake-timer tests in written order, under the suite's default bound. Reversing only the two teardown lines fails this test at that bound in written order (16 passed, 1 failed, raw exit 1; the red at the default bound is arm D1 of `dev/v0109-team/evidence/Review109/pfshuf2/job-2.log`); restoring the lines passes 17/17 in written order and under seed 11 (raw exit 0 each). The before and after source patches have the same SHA-256 (`55667d399a6c9c6f25fecb05e2399f3660264698c9ebab68821018b72262066a`); commands, logs and raw statuses are under `dev/v0109-team/evidence/Hygiene109/pfshuf/p1/`.

At this commit, the clean private checkout ran `VITEST_MAX_WORKERS=1 make web-check` with an in-guest 1,800-second bound, raw exit 0: web-shared passed 218 tests in 7 files, launcher 624 in 57, workspace app 7,428 in 585, and profile 20 in 5. The preflight file passed 17/17; type checks and production builds passed. The command, identity, raw status and full log are under `dev/v0109-team/evidence/Hygiene109/pfshuf/p1/commit-gate/`. The guest's host cgroup stayed at two CPUs and 8 GiB with no OOM; its lifetime memory and swap peaks and mid/end counters are in `dev/v0109-team/evidence/Hygiene109/pfshuf/cgroup-{mid,end-1}.txt`, so elapsed time is not used as a performance claim.
