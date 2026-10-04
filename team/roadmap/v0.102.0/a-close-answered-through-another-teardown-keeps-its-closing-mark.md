# A close answered through another teardown keeps its closing mark

Status: raised on 2026-10-04 by an independent review of a Runtime range on the v0.102.0 integration branch, which read that a close answered still releasing through an earlier teardown's permit leaves its own `Closing` mark under a key whose permit is free, and that two rules of the close by prefix have no pin; ruled by the lead that day a defect with one defensible fix under the team's rule for a discovery, to be built on the branch in two ranges, the fix first and the two pins after; the owner has not ruled on it and reviews it on the branch and in the lead's rulings.

## Owner ruling

Not yet put to the owner.

## What was seen

Read from source and not reproduced. `close_workspace_impl` in `crates/chan-library/src/host.rs` marks `Closing` under each key its runtime goes by, the canonical root and the root it was opened at when they differ, in the step that takes the runtime out of the routing map, and then takes a teardown permit under each of those keys. When an earlier teardown still holds a permit under one of them, the close takes none of its own and runs its teardown to the bound. If the workspace is still held at that bound, the close writes `workspace is still releasing; retry` under the key whose permit is held, passes over the key whose permit is free, and disarms the guard that would have removed its marks: the free key keeps `Closing`. Nothing removes it afterwards. The earlier teardown removes the retry words under its own keys alone, a close of a root no runtime holds leaves a `Closing` row as another close's, and a mount's success clears its canonical key alone. A status read by that key reads closing with nothing closing, until something writes another row there. It needs two teardowns held at once that share one key of two, which a root relinked since it was registered can give. The comment over that disarm says the guard must not clear the retry words; the guard as it is removes `Closing` rows alone and cannot.

The same review read two rules of that close that no test holds. The marks and the detach are one section of the routing map's write lock, which is what keeps a close that finds its runtime gone from owning marks: the two steps apart pass every pin. And the end of a close removes `Closing` rows alone, so a row a health check wrote meanwhile stays; the review reads that before that range it removed any row under the canonical key.

The close's bound and its marks under both keys are this version's ([a-mounted-close-awaits-a-teardown-with-no-deadline](a-mounted-close-awaits-a-teardown-with-no-deadline.md)), so the released v0.101.0 has no close that answers at a bound and no such mark; that was not read at the release's tag. The devserver's own clears, which removed another close's mark under a record's root, are repaired under [a-removal-does-not-hold-the-row-it-selected](a-removal-does-not-hold-the-row-it-selected.md); until that repair they also removed this leftover mark, as a side effect.

## Desired contract

When a close answers still releasing through a permit it does not hold, no key its runtime went by reads `Closing` after the answer, and the key under the held permit reads the retry words until that teardown returns. A close writes its marks and takes its runtime out of the routing map in one step under that map's lock, so a close that finds its runtime gone writes no mark. The end of a close, and the guard of a close whose caller left, remove that close's own `Closing` rows and no other row.

## What to do

The guard that removes a close's own marks stays armed in the arm that answers through another teardown's permit, or the close removes its marks before it answers: either leaves the retry words, which that guard cannot remove. Pinned red first with an earlier teardown left running under one key and a runtime of two keys closed beside it. The two rules are pinned as they stand, each proven by a mutation: the first through a probe at the end of the lock's section that exists in test builds alone, the second by a row planted under one key while a close is held at its teardown.

## Boundaries

`crates/chan-library/src/host.rs` (`close_workspace_impl` and its tests) and `crates/chan-library/design.md`.

## Acceptance

1. A close that answers still releasing through an earlier teardown's permit leaves the retry words under the key that permit is held under and no `Closing` mark under a key whose permit is free; pinned red first.
2. A close's marks are written while the routing map's lock that detaches its runtime is held, and a second close of that prefix while the first awaits its teardown answers that nothing is mounted and leaves both keys reading closing; pinned, with the mutation that writes the marks after the lock's section.
3. A row another writer puts under one of a close's keys while the close awaits its teardown reads the same after the close completes and after its caller left; pinned, with the mutations that make the close's end and its guard remove every row. The cost is written: a late `Unavailable` from a health check outlives a close by prefix until a mount or an off clears the row.
4. `crates/chan-library/design.md` says what a close answered through another teardown's permit leaves under each key.
