# Wall-clock test flakiness and an unguarded check precondition

> Status: shipped in [v0.79.0](../../release/release-v0.79.0.md): the self-write suppression tests read a caller-supplied instant instead of the wall clock, browser check 62 asserts a load-monotone structural cap instead of a rate ceiling, and check 60 skips on a missing launcher bundle instead of failing downstream.

## Problem

Three checks could fail from host contention or an absent precondition rather than from a defect. A check that fails for those reasons is not a test, it is a coin flip, and it trains readers to discount reds, which is how a real regression passes unnoticed.

They are two classes, not one.

## Class A: assertions that measure the scheduler

`SelfWrites` read time by calling `Instant::now()` internally, so `fresh_note_after_expiry_resuppresses` and `entry_expires_after_window` failed whenever the thread was descheduled for longer than their 20ms window between two adjacent statements.

Time is now a parameter on the private `note_at`, `reserve_at`, and `should_suppress_at`. The public `note`, `reserve`, and `should_suppress` are thin wrappers passing `Instant::now()`, so production behavior and every caller are unchanged and the seam stays module-private. The tests drive synthetic times from one base and contain no sleeps.

Browser check `62` asserted a 10 Hz progress-coalescing ceiling with no slack. Measurement showed why a count-based assertion cannot work: a throttled upload delivers progress at the throttler's own tick rate, about 9.8 events per second, which is the same rate as the coalescing window, so the coalescer passes nearly everything and no count separation exists. A fixed ratio against the chunk count also inverts under load, because the event count is fixed per file while the rendered count scales with wall time.

The check now asserts the coalescer's structural cap. Two rendered updates for one transfer are always at least `PROGRESS_INTERVAL_MS` apart, because the leading edge requires it and the trailing timer cannot fire early, so the rendered count stays below `window/100 + 1`. A slower host stretches the window and lowers the count, so load cannot flip the assertion. Monotonic sampled percentages, a committed-final-state check, and a minimum chunk floor keep a degenerate event stream from passing vacuously.

`applyProgress` increments a `window.__chanTransferApplies` counter that the application never reads, so the check can count rendered updates precisely. Counting rendered output from the DOM was rejected because identical consecutive values produce no mutation, which undercounts and hides regressions.

## Class B: an unguarded precondition

Browser check `60` had no `ctx.skip` path, so an absent launcher bundle produced a downstream failure instead of a skip. Its sibling `95` skips. `60` now skips on the same condition.

## Contract

`scripts/e2e/browser-smoke/README.md` records both rules for future checks: assert a property rather than a rate, because a wall-clock threshold with no slack fails on a loaded host; and call `ctx.skip` when an external precondition is absent rather than failing.

## Validation

The replacement assertion was proven to still detect the defect: with coalescing intact the probe recorded 102 rendered updates against a cap of 112, and with `PROGRESS_INTERVAL_MS` set to 0 and the bundle rebuilt it failed as designed at 512 rendered updates against a cap of 130. The self-write module tests ran 50 consecutive times under a parallel web build with zero failures.
