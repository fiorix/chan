# An upload of many files lists its directory once per file

Status: built on 2026-10-16 on the seat's branch; the section Build 2026-10-16 holds the evidence; it closes at the GA as shipped.

Record before the release: raised by the review seat on 2026-10-14 from its read of the coalesced relist range (question (c) of `reviews/review-Review106-relist-range-1.md` in the round's bus); written down the same day by the lead as a row of its own, outside the relist row; owner the frontend seat; not reached in the v0.106.0 round

## What was seen

Read at source at `v0106/frontend-relist` `14e6ca158` and at the round's base `4507fe5a0`, and counted in one run. The upload loop awaits a listing of the file's nearest loaded parent after each uploaded file (`web/packages/workspace-app/src/state/store.svelte.ts` 6202 at the tip, 6034 at the base: `refreshTreeForPath(result.path)` under `root !== "filesystem" || usesStandaloneFiles()`), and the standalone upload path lists once per uploaded file after the batch (1897 at the tip). So an upload of N files into one directory lists that directory N times in sequence, where one listing after the batch would show the same rows, and each listing is a directory read with its contacts scan and content sniffs on the server (`crates/chan-server/src/routes/files.rs` 212 to 236), so the server's work grows with N squared. Counted: browser check 62's 256-file probe made 255 root listings in its 8.7 s window at `ea4b04f18`, the integration commit before the relist landing (`evidence/Lead106/relist-baseline/stalls-2cpu-1-solo-62/` in the round's bus), none overlapping, 6 ms each in the guest; at the relist tip 280 in the window, 255 or 256 of them the loop's own and the rest the watch relists', the split being a subtraction. The listings are sequential, one in flight, so they do not flood; they are work the person does not see.

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

## Lead's rulings 2026-10-16

The frontend seat's design for this row (`reports/design-Frontend107-uplist.md` in the round's bus) was read by the lead and then by the review seat (`reviews/review-Review107-70-uplist-design.md`). The lead's rulings, in its words, the second set taking the review's points into the design before the code:

- "O1: the thrown native batch lists once (D2), since the picker cannot say what landed and one listing is the cost the repair sets for every ending; stated in the design text."
- "O2: you write check 62's probe count on your base in the item's commit, as the item's own browser arm: at most `duration/250 + 3` root listings over the probe window, one listing after the last file, all 256 names in the root's last answer, red at the tip on its own assertion; its runs alone at the fix and at the parent's bundle, and beside its neighbours, recorded with the engine. Hygiene107 reads the edit as the suite's owner before the landing, and adds c62err's assertion (no `classification=Status code: 5` line in the run's server log) on the landed tip, where the server change exists; your base lacks it, so you do not write that line."

- "D1: `refreshTreeForPath(path)` lists the nearest loaded parent of its argument starting at `parentDir(path)`, so D2's thrown native batch, which has no landed path, must pass a path inside the destination (or use an at-or-above helper), not the destination itself, or it lists the destination's parent; D2's pin asserts the directory listed, not a count. The loop's call with the last file is right."
- "N1: a file whose request answered as the cancel was asked is counted before the cancel check, so the catch does not skip the one listing it owes."
- "N2: the design sentence reads "failed or cancelled after a file landed"."

## Build 2026-10-16

Built in `web/packages/workspace-app/src/state/store.svelte.ts` on the seat's branch, over dirgon; the evidence directory named below holds each commit's sha (`final-shas-3.txt`). The lead and the review seat read the design first (the rulings above). The workspace app's design text holds the rule (`src/design.md`, "A file tree listing and its cached rows").

**What the store does.**

- **One listing per upload operation.** An upload lists its destination once, when its batch ends: done, or failed or cancelled after a file landed.
  - `fileOps.uploadFilesTo` lists nothing per file, so the upload waits on no listing between files.
  - `listLanded` runs once after the loop, before `finishTransfer` and the reveal, and once in the catch, before the failed row (a cancel marks its row when it is pressed). It lists the nearest loaded parent of the last landed file. An upload whose first file fails lists nothing, since the server persists nothing for an upload that does not complete.
  - A request that answered counts as landed before the cancel check, so a cancel asked as it answered still owes its listing.
- **The native picker** lists once for a returned batch. A batch that throws lists the destination itself through `refreshTreeAtOrAbove`, since it cannot say what landed.
- **One condition** decides both paths: `uploadShowsInTree`, a workspace window's workspace root or the Files app's filesystem.
- **Meanwhile,** the rows arrive through the watch coordinator's relists, at most one start per 250 ms per directory, and the transfer row shows the progress. The server, its frames and the coordinator are unchanged.

**The count, before and after.**

- **Before:** an upload of N files into a loaded directory lists it N + W times in the writing window: N from the loop, plus W watch relists, about T/250 + 1 over an upload of T ms. The native picker lists it N times after its batch, and not at all after a throw.
- **After:** 1 + W, and 1 for a native batch.

**Pins.** Ten cases in `state/store.upload.test.ts` ("an upload lists its destination once, when it ends"):

- U1: five files, one listing of the folder, after the last file landed and while the transfer row is active; the row then done.
- U2: the five rows present and the last selected (a guard).
- U3: a second upload listing again.
- U4: the third file failing, one listing with the two landed rows, while the transfer row is active; the row then failed.
- U5: the first file failing, no listing (a guard).
- U6: a cancel after two landed, one listing.
- U7: an upload to the filesystem in a workspace window, no listing (a guard).
- U8: a cancel asked as the first file's request answered, its row present.
- D1: a native batch of four, one listing of the folder.
- D2: a native batch that throws, the folder listed, not its parent.

**Evidence**, in the frontend guest, logs under `dev/v0107-team/evidence/Frontend107/uplist/` in the round's bus:

- **Red first** (`uplist-runs-1` and, after U8's rewrite, `uplist-runs-2`, at the commit's parent `19491e7ad` with the file as it lands): 7 of the 10 fail, each on its own assertion:
  - U1 `expected [ 'list docs', 'list docs', ...(3) ] to have a length of 1 but got 5`;
  - U3 `expected 6 to be 2`; U4 and U6 `expected 2 to be 1`;
  - U8 `expected [] to deeply equal [ 'docs/u0.md' ]`;
  - D1 `expected [ 'docs', 'docs', 'docs', 'docs' ] to deeply equal [ 'docs' ]`;
  - D2 `expected [] to deeply equal [ 'docs' ]`.

  The three guards and the file's nine existing cases pass.
- **Green:** the 13 files that touch the upload paths, 324 tests (`uplist-runs-1`, and `uplist-runs-3` at the commit's code); after U8's rewrite, the upload and store files, 87 tests (`uplist-runs-2`).
- **U8's first form** (the cancel as the second file answered) let the N1 mutant survive: the end listing lists the whole directory, so the earlier file's listing showed the later row. U8 now cancels as the first file answers, so the mutant has nothing else to list through.
- **The listing's place against the row's end** (`uplist-runs-3.{sh,log,status}`, at the commit's code): U1 and U4 read the transfer row's state when the folder is listed, `["active"]`. The tip's upload file against the parent's store fails 7 of 19, as above, since U1 and U4 fail first on their counts.
- **Mutants:** 11, one per guard, each against the upload and store files (case counts in brackets), all red again at the commit's code in `uplist-runs-3` (`mutant-table-3.py.txt`):
  - the per-file listing restored (5);
  - no listing when done (4); no listing on a failure (3);
  - a listing with nothing landed (3);
  - the tree condition dropped (1);
  - the native batch listing per file (1);
  - no listing for a thrown native batch (1); a thrown batch listing the parent (1);
  - the landed file counted after the cancel check (1, `uplist-runs-2`);
  - the listing moved after `finishTransfer` (1, U1: `listed while the row is active: expected [ 'done' ] to deeply equal [ 'active' ]`);
  - the catch's listing moved after the failed row (1, U4: `expected [ 'failed' ] to deeply equal [ 'active' ]`).

  The guest's `memory.events` counted no OOM event.
- **Check 62's count** (`scripts/e2e/browser-smoke/checks/62-binary-transfer-streaming.mjs`, the coalescing probe), in Chrome for Testing 155.0.8059.84 (HeadlessChrome/155 on Linux), against the bundle and a debug `chan` built in the guest at `8f40beee5`, this change on dirgon (`up62-checks-build`):
  - **Alone at the change** (`up62-fix`): PASS in 107.7 s. 20 root listings in a 5247 ms window, against a bound of 24.0. The 256-file upload took 5164 ms. One listing started after the last upload answered, and it held all 256 names.
  - **Alone over the parent's bundle** (`up62-base`), with the same check file: red on its own assertion, `the upload listed its destination 288 times in 8651 ms, over the bound of 37.6`.
  - **Beside checks 61 and 63** (`up62-beside`): all three pass (62 in 121.9 s).
  - The window opens at the chooser's accept and closes when the first root listing that starts after the last upload request answers completes, ordered by the browser's own timestamps.
  - Hygiene107 read the edit as the suite's owner, and adds c62err's server-log assertion on the landed tip. Its read gave the probe three lines:
    - a window of 250 ms per file or longer fails the check, since it holds as many relist starts as a listing per file would make;
    - at most `500/250 + 2 = 4` root listings start in the 500 ms after the end listing: two relist steps, the upload's own end listing when a relist ended the window (it is outside the relist spacing), and the window bound's one listing of slack. A listing per file deferred past the window fails it;
    - the comment states that the window's length is the test's own clock while the count stops at the end listing's start, so the bound is lenient by a fraction of a step.
  - Run again with those lines (`uplist-seq-3` and `grfref/seq-4`; the bundle and a debug `chan` built at the commit's code in `up62-2-checks-build`):
    - **alone** (`up62-fix-2`): PASS in 106.1 s; 16 root listings in a 4196 ms window against a bound of 19.8; 1 in the 500 ms after it;
    - **over the parent's bundle** (`up62-base-2`): red on its own assertion, `the upload listed its destination 288 times in 9338 ms, over the bound of 40.4`;
    - **beside checks 61 and 63** (`up62-beside-2`): all three pass, 62 in 111.8 s with 28 root listings in a 10246 ms window against a bound of 44.0 and 1 in the 500 ms after it;
    - **over a store that lists every landed file after the batch** (`up62-o2-mutant`, a control commit never landed): red on the 500 ms bound, `the upload listed its destination 256 times in the 500 ms after the window's end, over the bound of 4`, with the window bound met;
    - **with the window guard's threshold lowered to 1 ms per file** (`up62-o1-constructed`, the check file edited in the guest and restored): red on the guard, `the probe's window of 5255 ms cannot tell a listing per file from the watch relists`.
- **`make web-check`** at `8f40beee5` (`uplist-web-check.{log,status}`, rc 0, 19:06Z to 19:20Z, on two CPUs, the guest checkout clean before and after, no OOM event):
  - svelte-check 0 errors and 0 warnings in web-shared, the launcher, the workspace app and profile;
  - vitest: web-shared 7 files and 218 tests, the launcher 57 and 619, the workspace app 561 and 7247, profile 5 and 20;
  - the workspace app's production build.

  Again at the commit's code (`uplist-web-check-2.{log,status}`, rc 0, 19:57Z to 20:12Z, on two CPUs, the guest checkout clean before and after, no OOM event): the same counts, workspace app 561 files and 7247 tests. The commit that lands holds that run's web and check files and differs from it in this row's text and the message only.

Acceptance:

1. **The count at the base and at the change:** in the store, U1 and D1 red at the parent and green with the change; in check 62's probe window, above.
2. **The decision:** the lead's rulings above.
3. **N uploads make one listing of the directory after the batch, pinned red first, with the rows of all N present after it:** U1 and U2, with U1 and U4 placing the listing before the row's end, one mutant per guard. The browser arm is check 62's count.
