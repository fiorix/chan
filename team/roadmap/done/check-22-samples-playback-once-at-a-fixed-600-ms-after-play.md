# Check 22 samples playback once at a fixed 600 ms after play

Status: shipped in [v0.109.0](../../release/release-v0.109.0.md).

Record before the release: built on 2026-10-23 on `v0109/bcs022`; the section "Built 2026-10-23" holds the evidence; it closes at the GA as shipped.

## What was seen

Browser check 22 (`scripts/e2e/browser-smoke/checks/22-cs-open-audio.mjs` 206 to 223) mutes the audio viewer's element, awaits `play()`, waits a fixed 600 ms, samples `currentTime` once and fails with "audio playback did not advance" when it has not moved. In the freeze's whole runs at `759aac125` and `a9fc42183` it was red at that line, the viewer's screenshot at 0:00, the only red of either run; it was green alone after each, in fifteen earlier whole runs, and in 40 of 40 repetitions at `a9fc42183` in a two-CPU guest, 20 plain and 20 beside two busy loops (the guest throttled in 98.8 percent of the cgroup's periods). A diagnostic copy that polls `currentTime` every 50 ms for up to 10 s after `play()` resolves saw the first observed advance at 50 ms in one constructed run and at 50 to 132 ms (median 93) in 20 loaded runs; a second copy whose event clock starts before `play()` saw `playing` at 0 to 3 ms and the first observed advance at 50 to 127 ms (median 120.5) in 20 loaded runs, `readyState` 4 in every run. No run advanced later than 600 ms, so they do not reproduce the whole-run reds; the check as written cannot tell a clock that starts after 600 ms from one that never starts, and records neither the media state nor when the clock first moved.

## Desired contract

Check 22 fails only when playback shows no progress within a 10 s polling window after `play()` resolves, and it records what it saw, red or green, in its structured details: the first observed `currentTime` advance relative to `play()`'s resolution, the element's `readyState`, `networkState` and `paused`, and the `playing`, `timeupdate`, `waiting` and `stalled` events with their times on a clock started before `play()`, so a red records the media state and the observed events. The window is a polling bound with timer slack, not a measured worst-case start time.

## What to do

Build: the fixed 600 ms sample becomes a 50 ms poll of `currentTime` for up to 10 s after `play()` resolves, with the event listeners installed and their clock started before `play()` and the two time origins labelled (the corrected diagnostic copy at `evidence/Hygiene109/reds-Fpp/timed-results/diag-timed/check.diff` is the model); the page returns the snapshot to the check, which records it in its details on success and, on failure, throws on the Node side with `smokeDetails` holding the snapshot and a message carrying it, so `results.json` keeps the details either way (`run.mjs` 460 to 470 stores failure details only through `error.smokeDetails`); listeners are removed and the owned element paused on both paths. Red first, in the guest, with the check's own playback code at the parent and the commit: a delayed-progress fixture whose `currentTime` stays fixed through the parent's 600 ms sample and advances before the new bound, driven by an owned sample sequence rather than a host sleep, reds the parent and greens the commit; a never-advancing fixture (the element's `currentTime` getter overridden before the playback block, the play promise resolving) reds both, the commit with the recorded state in its message and details; a guard mutation on the bound and one on the recorded fields each fails its pin. The real page passes alone at the commit. A whole-run red at the shipping commit that still shows no advance within the window is then read against the recorded state.

## Boundaries

`scripts/e2e/browser-smoke/checks/22-cs-open-audio.mjs` alone. Not changed: the product, the suite's runner and helpers (`protocolTimeout` included), the other checks.

## Acceptance

1. The delayed-progress fixture red at the parent and green at the commit; the never-advancing fixture red at both, with the commit's details in `results.json`; the two guard mutants red; check 22 alone green three of three at the commit; `make e2e-check` green.
2. The freeze's whole run at the shipping commit reports check 22's first observed advance and events in its details.

## Built 2026-10-23

Check 22 uses a 10 s polling window after `play()` resolves and samples `currentTime` every 50 ms. Its details record the first observed advance relative to the play promise's resolution, media state before and after polling, and timestamped media events from a clock started before `play()`. On no advance, the page returns that snapshot and the Node check attaches it to `smokeDetails` before throwing; the owned audio is paused and its event listeners are removed on both paths.

The evidence-only `fixture-wrapper.mjs` installs a `currentTime` getter before each selected check's playback block, preserving the parent and candidate playback code. Its delayed mode holds the first 15 reads at the initial value and advances on read 16, with no host sleep. The parent at `a9fc4218396917a15f46560c61173956bc669118` read twice and returned browser rc 1 with `audio playback did not advance`; the candidate returned rc 0 with the first observed advance at 756 ms and a full teardown. Its never mode held every read; the parent returned rc 1 with the same old message, while the candidate returned rc 1 after the polling window with `firstAdvanceMs:null`, both time origins, `readyState:4`, `networkState:1`, `paused` before and after, and timestamped `playing` and `timeupdate` events in both the message and `results.json.details` (`dev/v0109-team/evidence/Hygiene109/bcs022/review-{parent,candidate}-{delayed,never}/results.json`). The fixture result reader's constructed self-test and all four real pins returned rc 0 (`fixture-assert-self-test-wrapper.log`, `review-fixtures-assert-wrapper.log`).

A bound mutation reduced the polling window to zero: the delayed fixture's browser run returned rc 1 and its green pin returned rc 1. A diagnostic mutation omitted `events`: the never fixture's browser run returned rc 1 and its structured-details pin returned rc 1 for the missing field. The mutation driver passed its constructed self-test first (`review-mutants-wrapper.log`, `review-mutant-{bound,fields}/results.json`). These browser runs used `chan-v0109-hygiene` as `ubuntu` in a two-CPU, 8-GiB guest with disposable server homes and libraries.

At the committed check, the delayed fixture passed with its first observed advance at 755 ms and the never fixture failed with the snapshot in structured details (`review-commit-fixtures-wrapper.log`, `review-commit-{delayed,never}/results.json`). The real page passed alone three of three with no skips; each first observed advance was 50 ms, and the runs took 1,508, 1,459 and 1,505 ms wall time (`review-real-solos-wrapper.log`, `review-real-{1,2,3}/results.json`). `make e2e-check` returned rc 0 over 161 files (`review-commit-e2e-check-wrapper.log`). The final JSON reader returned rc 0 on the three real runs and both committed fixtures (`review-final-assert-wrapper.log`). The shipping whole-run record remains pending.
