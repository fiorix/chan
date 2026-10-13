# A terminal moved to another window can come back into its source window

Status: raised for v0.106.0 at the v0.105.0 GA on 2026-10-11, from the osc7501 round's record (check 150's one red at `729736e51`); written down, not designed, not accepted for build.

## What was seen

Two pages viewed one window. The second page saved the shared layout and closed; its `session_changed` reached the first page 160 ms before that page dragged a terminal tab into another window. The drag's end closed the moving tab as moving out, and 380 ms after the drop the first page opened a new tab on the moved session, so the session was attached in two windows. The record is `dev/osc7501-team/evidence/Web7501/task9/guest-results/full-combined/150-program-attach.timeline.json` in the chan-dev archive of the round, and the mechanism, read in `web/packages/workspace-app/src/state/store.svelte.ts` at `6a0e16b16`: `onSessionChangedFrame` armed the 250 ms sync refetch; the move's close armed the page's own save; `applyRemoteSessionBlob` flushed that save and re-armed the refetch, but `commitSessionSave` starts its `api.putSession` without awaiting it, so the re-armed fetch read the co-viewer's older blob before the page's PUT landed, and `reconcileLayout` in `state/tabs.svelte.ts` restored the moved terminal as a remote terminal with no live match. Once in 22 runs of the check; the check now waits for the co-viewer's save to settle before the move and does not reach the race.

Seen again at the candidate `78f787b4d` on the front tab before any move (the lead's pack, check 150 red once): 305 ms after the tab's socket opened, a `session_changed` of the window was followed by the socket's close, and the co-viewer's later blob re-created the tab under a new id, so the cleanup's close by the original id found no tab; the same shape as check 157's vanished tab at `a09396ef0`. So the race reaches a tab just created as well as one just moved.

Not established: whether the same window of time exists for a tab closed rather than moved, and what a user sees after it (the moved terminal in both windows until one is closed).

## Desired contract

A page's own flushed save is observed by the refetch that flush re-arms: that refetch reads the blob the flush wrote, or a later one, never an older co-viewer's. A refetch armed by another frame while the flushed write is still in flight is not held by this item; it is the session-save row's.

## What to do

Make `applyRemoteSessionBlob` await the flushed PUT before it re-arms the refetch, or carry the flushed payload's hash so a fetched blob older than it is discarded; pin it with a store-level test that orders the co-viewer's write, the local flush and the refetch as the record did, red first on its own assertion.

## Boundaries

`web/packages/workspace-app/src/state/store.svelte.ts` (the co-view sync section) and its tests; `state/tabs.svelte.ts` only if the reconcile must learn to refuse a terminal marked moving out. Not changed: the cross-window move itself and check 150's settle wait, which stays as the check's own guard.

## Acceptance

1. A store-level test that reproduces the record's order (co-viewer save, local move-out close, flush, refetch) fails before the change on the re-created terminal and passes after.
2. Check 150 with its settle wait removed in a guest-only run passes in a loop of twenty runs, each engine, with no terminal re-created in the source window; the settle wait is kept in the committed check.
3. The decision on a closed (not moved) tab recorded here, measured or stated unmeasured.

## The constructed red and the lead's choice 2026-10-13

The frontend seat's store-level test (`dev/v0106-team/followups/followup-Frontend106-Lead106-34.md`; `evidence/Frontend106/covret-red.*`) orders the record's events in `state/` with the PUT held: a peer's `session_changed`, the local move-out close at 160 ms, the pending local save's flush at 250 ms and the re-armed fetch at 500 ms. At the released code it is red on its own assertion: the old peer blob re-creates the moved terminal in the source layout. The lead's choice between the two repairs the item names: `applyRemoteSessionBlob` awaits the flushed PUT before it re-arms the refetch, because the PUT's promise resolves only after the server's write response, so the re-armed fetch cannot read a blob older than the write, while a payload hash cannot order an older GET against an in-flight write. The two named repairs are the item's design and this is the decision; the review seat reads the range (the test and the repair) before integration. The failure and concurrent-save paths are the seat's to read and state; the closed-tab arm stays unmeasured unless the lane's time allows; the twenty-run loop of check 150 without its settle wait likewise.

## The repair built 2026-10-13

By the frontend seat (`dev/v0106-team/tasks/task-Frontend106-Lead106-25.md`; the commit `cb0399c1a` on its branch: `state/store.svelte.ts` 19 lines, `state/store.sessionReadBack.test.ts` 64, the frontend design's sentence): `commitSessionSave` and `flushPendingSessionSave` return the write's promise and `applyRemoteSessionBlob` awaits the flushed write before it re-arms the refetch. The store test orders the record's events with the PUT held and is red at the unchanged product on the terminal-presence assertion for a move-out and for an ordinary close (acceptance 3's closed-tab arm is thereby measured: the same stale-fetch window reaches a close when a durable file tab keeps the session blob live), and on a no-fetch assertion for a failed local PUT; green after the repair; the await dropped reds all three. The affected store and co-view modules (424 of 424 in seven), the type check and the builds green at the tip. Acceptance 2's loop: check 150 with its settle wait removed in the guest only, 20 of 20 whole runs green in Chrome 155 on both backends against the tip's bundle; the check's cleanup waits for the subject's tab label to leave the source page and makes no direct assertion that no duplicate ever appeared, so a transient duplicate could escape it; the store tests assert the absence directly. No loop was run at the base; the item keeps its historical one red in 22. The review seat reads the range before it lands.

Two paths the seat read and the repair does not cover, given a row of their own (`sesser`): a failed flushed PUT leaves the dedupe snapshot advanced, so an identical later save may not retry and a reload can read the old blob; a debounce PUT already in flight has no timer to flush, so a peer's frame in that interval can still fetch without waiting for it, and two overlapping own PUTs can finish out of order.

## The repair reviewed and landed; the contract narrowed to what the code does 2026-10-13

The review seat read the commit (its verdict of 13:32Z in the round's bus, `reviews/review-Review106-covret-range-1.md`) and it is landed. The repair is the ruled one and is complete along its chain: the save returns the PUT's or the DELETE's promise, the flush returns it, and the read-back awaits it before it re-arms; the debounce caller catches its own rejection and there is no other caller, so no rejection is left unhandled. The base's store under the tip's tests is red on three assertions, each its own; the await dropped, the PUT branch not returned and the flush not returning its write each give the same three.

One finding, ruled by the lead on the review's first proposal: the contract above and the design's new sentence said more than the code does. A second frame from the co-viewer while the flushed PUT is in flight arms a read of its own, which goes out with the PUT held and re-creates the terminal (constructed and run by the review at the tip). It is not a regression, since at the base the read went out whatever the PUT's state, and it is the mechanism of the session-save row, so the contract is narrowed here to the read the flush re-arms, the design's sentence is narrowed the same way in a commit owed by the frontend seat, and the case goes to that row with the review's test. Remembering the write in flight and holding every read for it would close this and the debounce case together; that is the row's repair and was not built or run.

Two guards get a pin in the same owed commit: the DELETE arm (an emptied window, the plainest move-out, whose promise dropped passes the committed module) and the debounce caller's catch (whose loss the app would show the person as an unhandled error).

What the acceptance points carry. Acceptance 1 and 3 carry the repair: the store tests, for a move-out and for a close. Acceptance 2 is run and green and does not carry "no terminal re-created": nothing in the check after the drop reads the source page, and with no loop at the base twenty greens are what the unrepaired product gives about four times in ten at one red in 22. After a failed flushed PUT the removal stays in this page until the co-viewer's next frame, whose read then brings the terminal back, since the server never took the removal.

## The two pins and the narrowed sentence reviewed and landed 2026-10-13

The runtime seat's two commits for the review's pins were read by the review seat (`reviews/review-Review106-covret-pins-1.md` in the round's bus): both can land, with no finding. The first pin holds the case where the window has emptied and the flush awaits a DELETE: with that branch's promise dropped it is red alone, at "refetch waits for the local DELETE"; it also asks one read after the release, no terminal in the pane, and one PUT and one DELETE in all. The second holds the debounce caller's handling of a rejected save through the real API call: with the catch removed it is red at its own assertion in six runs of six. The module passes 11 of 11 against the integration store. Landed on `v0106/int` as `00df0da5e` and `b64d46d8e`; `make web-check` is 0 there, the workspace app 6,992 of 6,992.

Two notes, ruled built by the runtime seat: the design sentence says "PUT" where the awaited write is a DELETE once the window has emptied; and the debounce pin holds only while everything between the timer and the rejection is a microtask, so its assertion moves one macrotask later.

## The two notes built, reviewed and landed 2026-10-13

The runtime seat's two commits for the notes above (`dev/v0106-team/tasks/task-Runtime106-Lead106-33.md` in the round's bus; `evidence/Runtime106/covret-notes-1/`), read by the review seat (`reviews/review-Review106-covret-notes-1.md`): both can land. The design sentence now says the awaited write is a PUT, or a DELETE once the window has emptied, and that no read is rearmed if that write fails, which is `commitSessionSave` and the read-back arm for arm; the debounce pin's assertion waits one awaited advance of zero under the file's fake timers, which is a real turn (a real `setImmediate` callback and a pending microtask have run when it returns), so the pin no longer depends on the save path's microtask count: with the debounce caller's catch removed the new form is red at the pin where the old form passed. The pin sees a rejection a few real turns away and no further (red at two turns, passing at five and more), where the runner's own unhandled-rejection report still fails the run; it is not unbounded and the item says so. The seat's first commit imported `node:timers/promises`, which the app's type check refuses (no Node declarations in the workspace), and its second replaced the import with the typed advance; since the first alone is red under the web gate, the lead landed the two as one commit on the integration branch, `4990ea9b3`, whose tree equals the two-commit rehearsal's, the seat's branch unchanged. The module passes 11 of 11 at the tip.
