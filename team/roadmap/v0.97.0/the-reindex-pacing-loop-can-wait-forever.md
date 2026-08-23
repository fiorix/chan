# The reindex pacing loop can wait for headroom that cannot arrive

Status: accepted scope for v0.97.0, raised while running the owner's acceptance for [the-fd-budget-disengages-where-it-cannot-measure](the-fd-budget-disengages-where-it-cannot-measure.md) on a real FreeBSD box. Fixed at `a447eed7`.

## Problem

Indexing chan's own source graph under `ulimit -n 64` on FreeBSD 15.0-RELEASE never finishes. The process sits at 0.0% CPU in state `I`, stuck partway through `GraphRebuild`, and was still there after 21 minutes. The same tree at the same limit indexes 413/413 files in the ordinary way on the commit before the descriptor fix.

`pace_reindex_worker` loops on one condition:

```rust
Some(snap) if reindex_should_pace(snap) => {
    steps = steps.saturating_add(1);
    std::thread::sleep(REINDEX_BACKOFF_STEP);
}
```

with `reindex_should_pace(snap)` being `snap.remaining() < REINDEX_RESERVE` and `REINDEX_RESERVE` a flat 64. `remaining()` is bounded by `limit`, so at `ulimit -n 64` the condition is unconditionally true and the loop has no exit: no step cap, no deadline, and `cancel` is `None` on the CLI path. The reserve stopped describing headroom and started describing the whole descriptor table.

The reserve is correct where it was sized. The module's own header names the 256-descriptor tables macOS shells hand out, and 64 is a quarter of that. Carried unscaled onto a much smaller table it asks for headroom no process in that table can ever have.

## This is not a FreeBSD bug, and the FreeBSD change did not introduce it

The loop is platform-neutral and has been reachable on Linux and macOS since the reserve was introduced. It reproduces on macOS at `ulimit -n 64` using a `0.95.1` binary (`git-719bf6b60392`), which predates every FreeBSD change in v0.96.0.

What the descriptor fix changed is FreeBSD's exposure to it. Before it, `fd_snapshot()` on FreeBSD returned `None` and the loop took its early-return arm, so the platform was accidentally immune. Teaching FreeBSD to measure descriptors correctly also handed it a live `Some` and, with it, a hang the other unix platforms already had. That is worth stating precisely, because the obvious reading -- that the sysctl work broke FreeBSD -- is wrong and would point any repair at the wrong module.

The failure modes are not symmetric, which is why this outranks the exhaustion it guards against. Running out of descriptors reports itself: the owner's original `EMFILE` names the error, the file and the operation. A parked worker says nothing at all.

## Desired contract

Pacing is a courtesy to interactive work, not a correctness gate. Under pressure that does not lift, a reindex degrades into a slower reindex, never one that does not finish. The reserve keeps its meaning -- leave a slice of the table for a concurrent autosave or terminal spawn -- at every limit rather than only at the limit it was sized for.

## Direction

Two changes, and both are load-bearing.

**Scale the reserve to the table.** `reindex_reserve_for(limit)` is `REINDEX_RESERVE.min(limit / 4)`: 64 wherever there is 64 to spare, a quarter of the table below that. The macOS case the reserve exists for is untouched, because `256 / 4` is exactly 64, and every existing threshold test keeps its current answer.

**Cap the per-call wait.** `REINDEX_BACKOFF_MAX_STEPS` bounds one call to half a second before it proceeds regardless. This is the backstop rather than the brake: scaling is what removes the realistic trigger, and the cap is what makes the module's already-documented promise that pacing "never blocks indefinitely" true rather than aspirational. `pace_reindex_worker_with` takes the probe as a parameter so that bound is testable against a snapshot that never improves.

Scaling alone is not enough, and the measured boundary is why. `ulimit -n` of 72 and 80 also hang, and both are above the reserve, so a guard that only excluded `limit <= REINDEX_RESERVE` would have left two thirds of the observed failures in place.

## Boundaries

No consumer, open-time knob or threshold changes: `tantivy_writer_budget`, `cap_index_read_workers`, `graph_reader_pool_size` and `acquire_workspace_permit` all read the same snapshot and make the same decisions. `LOW_LIMIT`, `TIGHT_HEADROOM` and `MODEST_HEADROOM` are untouched. Windows keeps the time-sliced yield it uses instead of fd pressure.

## Acceptance

1. Indexing chan's own source graph completes at `ulimit -n` of 64, 72, 80, 96, 128 and 256, on FreeBSD and on macOS.
2. `reindex_reserve_for` returns `REINDEX_RESERVE` at 256 and above, and a quarter of the table below it; every pre-existing pacing test keeps its current assertion unchanged.
3. A snapshot under permanent pressure at a satisfiable limit returns after `REINDEX_BACKOFF_MAX_STEPS` rather than looping.
4. The protection is intact: a table with a quarter or less free still paces.

## Evidence

- Fixed at `a447eed7`, `crates/chan-workspace/src/fd_budget.rs`.
- The boundary, measured as a before and after on FreeBSD 15.0-RELEASE arm64 with no `fdescfs` mounted, indexing 413 files:

  | `ulimit -n` | before the descriptor fix | after it | after this fix |
  | --- | --- | --- | --- |
  | 64 | 413/413 | no completion in 200s | 413/413 |
  | 72 | 413/413 | no completion in 200s | 413/413 |
  | 80 | 413/413 | no completion in 200s | 413/413 |
  | 96 | 413/413 | 413/413 | 413/413 |
  | 128 | 413/413 | 413/413 | 413/413 |
  | 256 | 413/413 | 413/413 | 413/413 |

- The same six limits pass on macOS after the fix; 64 hangs there before it, on a `0.95.1` binary, which is what establishes the bug as pre-existing and cross-platform.
- `RUSTFLAGS="-D warnings" cargo test -p chan-workspace fd_budget`: 16 passed, 0 failed, on macOS under the pinned 1.95.0 and natively on FreeBSD.
- The hung process was confirmed sleeping rather than working: 21m44s elapsed at 0.0% CPU in state `I`, output stopped inside `GraphRebuild`.

## What this cost to find

Nothing in the round that shipped the descriptor fix could have caught it. The 13 tests it added are all pure decisions over synthesized `FdSnapshot` values, none of them calls `fd_snapshot()`, and none of them runs the pacing loop against a probe. The item was accepted with its acceptance 1 explicitly deferred to the owner on real hardware, and this is what that acceptance found.

The general lesson is narrower than "run it on the platform". The fix was verified by the tests that existed and by a cross-target `cargo check`, and both were green and honest. What neither could see is that making a `None` into a `Some` hands the platform every behaviour keyed off `Some`, including the ones nobody was looking at. A change that turns a probe on wants its consumers re-read, not just its own arm tested.
