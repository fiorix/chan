# An upload of many files lists its directory once per file

Status: raised by the review seat on 2026-10-14 from its read of the coalesced relist range (question (c) of `reviews/review-Review106-relist-range-1.md` in the round's bus); written down the same day by the lead as a row of its own, outside the relist row; owner the frontend seat; not reached in the v0.106.0 round

## What was seen

Read at source at `v0106/frontend-relist` `14e6ca158` and at the round's base `4507fe5a0`, and counted in one run. The upload loop awaits a listing of the file's nearest loaded parent after each uploaded file (`web/packages/workspace-app/src/state/store.svelte.ts` 6202 at the tip, 6034 at the base: `refreshTreeForPath(result.path)` under `root !== "filesystem" || usesStandaloneFiles()`), and the standalone upload path lists once per uploaded file after the batch (1897 at the tip). So an upload of N files into one directory lists that directory N times in sequence, where one listing after the batch would show the same rows, and each listing is a directory read with its contacts scan and content sniffs on the server (`crates/chan-server/src/routes/files.rs` 212 to 236), so the server's work grows with N squared. Counted: browser check 62's 256-file probe made 255 root listings in its 8.7 s window at the base (`evidence/Lead106/relist-baseline/stalls-2cpu-1-solo-62/` in the round's bus), none overlapping, 6 ms each in the guest; the same at the relist tip beside the watch relists' 24. The listings are sequential, one in flight, so they do not flood; they are work the person does not see.

Not established: the cost on a slow disk or a large directory; whether the per-file listing serves anything the batch's last listing would not (the row of each file appears as it lands, which a progress row could show instead).

## Desired contract

An upload of N files into one directory costs a bounded number of listings of it, and the rows appear as the transfer's progress shows them.

## What to do

Count first, in the store's tests: N uploads through `uploadFilesTo` with a counting listing, at the base and at the proposed change. Then the proposal to the review seat before code: list once after the batch (and once more if an event arrived meanwhile, which the watch coordinator already does), with the transfer's own progress row standing in for the per-file row.

## Boundaries

`web/packages/workspace-app/src/state/store.svelte.ts` (the two upload paths) with its tests, and check 62's probe if its expectations change. Not changed: the server's listing route.

## Acceptance

1. The count at the base and at the change, in a test and in check 62's probe window.
2. The decision recorded here.
3. If a change: N uploads make one listing of the directory after the batch, pinned red first; the rows of all N files present after it; one mutant per guard.
