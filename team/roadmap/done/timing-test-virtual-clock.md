# Wall-clock timing tests: virtual clock and load-proof budgets

> Status: implemented on `v083/timing-test-virtual-clock`, pending merge and release.

## Problem

Two tests asserted wall-clock rates, so a contended host failed them without any defect present. `tenant::tests::one_deadline_aborts_and_joins_every_stuck_task` measured `elapsed < grace * 3` against a 100 ms grace and went red at 390 ms under load 20 on 8 cores while passing 12 of 12 in isolation. `indexer::tests::trigger_during_active_rebuild_forces_one_follow_up_generation` required a follow-up rebuild to start within 750 ms of release and failed the pre-push gate twice in a row on a busy machine while passing alone. A check that fails from host contention is a coin flip and trains readers to discount reds, which is how a real regression passes unnoticed.

## Fix

`one_deadline_aborts_and_joins_every_stuck_task` runs on `#[tokio::test(start_paused = true)]` and measures with `tokio::time::Instant`, so the grace deadline fires at precisely 100 ms of virtual time on any host. The bound keeps its discriminating power: a regression that multiplies grace by stuck-handle count trips `elapsed < grace * 3` at exactly 400 ms virtual. The production path was already fully tokio-time (`timeout_at` against a `tokio::time::Instant` deadline), so no production seam was needed; chan-library's dev-dependencies now enable tokio's `test-util` feature so the crate's tests build standalone (`start_paused` previously leaked in through workspace feature unification when built alongside chan-server).

The indexer recovery tests keep their real clock (the coordinator's rebuild passes run as real work on blocking threads, which a paused clock cannot virtualize) and drop the rate assertions instead. All five waits on the coordinator's rebuild pipeline across both recovery tests ride one named `CONVERGENCE_BUDGET` of 30 s, sized for rebuild work on a contended host after the rebuild smoke budget in chan-workspace's index facade; the 750 ms ceiling on the follow-up start is gone. Each wait still detects a lost or stuck generation the same way: it never arrives. The `elapsed >= cooldown` floor stays; tokio timers do not fire early, so the floor cannot flake, and it still catches a cooldown bypass on hosts fast enough to finish a pass inside the cooldown.

Audit: `crates/chan/tests/devserver_resilience.rs` bounds real process exit with a documented 12 s budget and its poll loops guard at 15-30 s; `crates/chan-workspace/src/index/facade.rs` bounds its rebuild smoke at 30 s. Both are properties with slack rather than rates, so both were left alone. Process-level budgets cannot virtualize because they wait on real child processes.

## Validation

- Mutation, tenant: multiplying the grace deadline by four turns the test red at exactly `400ms` on the `elapsed < grace * 3` assertion; reverted green.
- Mutation, indexer: removing the registered follow-up generation turns the test red at the widened timeout with `mid-rebuild generation was swallowed: Elapsed(())` after 5.6 s (the budget was 5 s at that point; the mechanism is unchanged at 30 s); reverted green. A cooldown-bypass mutation was tried and reverted without observable effect: pass-1 teardown work exceeds the 75 ms cooldown on this host, so the floor is satisfied by construction here and only bites on faster hosts.
- Load: an intermediate state (5 s ceilings) ran 40 logged iterations under parallel vite builds and failed once at the final convergence wait (`follow-up generation did not complete: Elapsed(())`), which motivated the 30 s budget. The final state passes 40 of 40 logged iterations under the same load plus this machine's chronic agent builds, and the full `indexer::` module passes 30 of 30.
