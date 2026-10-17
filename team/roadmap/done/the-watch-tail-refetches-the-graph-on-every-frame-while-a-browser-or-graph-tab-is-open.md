# The watch tail refetches the graph on every frame while a browser or graph tab is open

Status: shipped in [v0.107.0](../../release/release-v0.107.0.md).

Record before the release: built on 2026-10-16 on the seat's branch; the section Build 2026-10-16 holds the evidence; it closes at the GA as shipped.

Record before the release: raised by the review seat on 2026-10-14 from its read of the coalesced relist range (N3 of `reviews/review-Review106-relist-range-1.md` in the round's bus, measured there); written down the same day by the lead as a row of its own, outside the relist row; owner the frontend seat; not reached in the v0.106.0 round

## What was seen

Read at source at `v0106/frontend-relist` `14e6ca158` and counted in check 163's runs. The watch tail's second reaction to every frame, older than the relist landing, drops the cached graph and, when a File Browser tab or a graph tab is open, refetches it at once (`web/packages/workspace-app/src/state/store.svelte.ts` 1200 to 1210: `invalidateGraph()` then `void ensureGraphLoaded()`, whose comment calls the fetch de-duped). Each filesystem event reaches a window as two frames, so an event with such a tab open costs the graph route a request per frame beyond the one in flight. Counted in browser check 163 (`163-file-browser-watch-refresh.mjs`), which opens a File Browser and creates, modifies and removes a few files: 76, 83 and 74 requests to `/api/graph` in five to seven seconds, at the relist tip and with the candidate's store alike (10 in the paired control, which the earlier check's state changed), beside 9 to 12 directory listings in the same runs. Under a churn like check 62's 256-file probe the graph would be fetched back to back for its whole length. The graph is the workspace's link index, a whole-workspace read on the server.

Not established: the graph route's cost per request on the server; the count under check 62's probe with a graph tab open; whether `ensureGraphLoaded`'s de-duplication holds a request in flight or only a loaded result.

## Desired contract

A burst of filesystem events costs a bounded number of graph fetches while a graph surface is open, and the graph a person sees is one fetched after the last event.

## What to do

Count first: check 163's `/api/graph` requests per created file at the base and the tip (the relist range's reader already counts routes), and a store test with N frames and an open browser tab. Then the proposal to the review seat before code: the same shape as the watch relists' coordinator (one fetch in flight, one queued, a short quiet window), or one invalidation per burst with the fetch left to the next view.

## Boundaries

`web/packages/workspace-app/src/state/store.svelte.ts` (the watch tail's graph reaction and `ensureGraphLoaded`) with its tests, and check 163's counts. Not changed: the graph route.

## Acceptance

1. The count per frame at the base, in a test and in check 163.
2. The decision recorded here.
3. If a change: N frames with a graph surface open cost a bounded number of fetches, the last one after the last frame, pinned red first; one mutant per guard.

## Lead's rulings 2026-10-16

The frontend seat's design for this row (`reports/design-Frontend107-grfref.md` in the round's bus) was read by the lead, then by the review seat (`reviews/review-Review107-79-grfref-design.md`). The lead's rulings, in its words:

- "O1: the quiet window alone. The contract's "fetched after the last event" taken strictly, the rule `GraphPanel` already applies; a writer that never pauses for 250 ms defers the refresh and the last complete view stays, which the design text says in those words. No maximum wait."
- "O2: the draft sites through the coordinator, so a promotion and its frame are one burst (G9)."
- "O3: a refresh keeps the last complete view until its answer completes; a first load streams as now."
- "D1 taken, Review's option (a): nothing bounds a stalled `graphStream` (it goes through `chanFetch`, which has no timeout), and under R2 every later burst would wait on it forever. A no-progress bound on the refresh's stream, reset by each received event, aborts it and takes R4's path (view kept, `error` set, coordinator idle). It is a hang guard no green run waits, so its size is free of the measurement rule: 30 s, a named constant whose comment says it must outlast the route's quiet gap between `meta` and the first batch on a large workspace."
- "D2 taken: check 163 asserts the quiet gap on each step's last `/api/graph` request (at least 200 ms after the step's last frame), and one to two requests per step; the comment states the CDP-stamp race Review names (a frame in transit or queued behind the timer's task yields a request after its stamp, and the late frame's own fetch is the last)."
- "D3 ruled as (a): the item's contract is met in its words (one fetch per burst, after the last event); the index lag (the indexer applies a path only when its last event is at least `search_aggression.debounce()` old, 1 s by default, so the burst's fetch at 250 ms reads the graph before the burst is indexed, and nothing reloads after the apply) is the same at the base and earlier, and is raised by the lead as a row of its own for the round to close, with Review's option (c) as its shape: a server frame when the indexer applies a watcher change, which the coordinator treats as the burst's end."
- "D4 taken whole: G2 reads the held request's `signal.aborted` as false after a frame and its answer published when released, before the second fetch; G5 holds the refresh open after at least one batch and compares the view by equality to the last complete view at each step; mutants added for a failure that clears the view, the view kept with no surface, `teardown` not cancelling the timer (with its pin: a teardown inside a quiet window, no fetch after), and D1's bound."
- "N1 taken: `open()` read when the wait ends."

## Build 2026-10-16

Built in `web/packages/workspace-app/src/state/graphData.svelte.ts` and `state/store.svelte.ts` on the seat's branch, over the integration tip that holds the upload listing item; the evidence directory named below holds each commit's sha (`final-shas-4.txt`). The workspace app's design text holds the rule (`src/design.md`, "The shared graph through a burst of filesystem events").

**The count before the change** (`grfref/seq-4.{sh,log,status}`, a reading never committed), at the tip below this change:

- **Store reading** (`graph-reading.test.ts`, N events, each sent as the watch and fs frames a window receives):
  - with a File Browser tab: 2N graph streams, N of them aborted, and the view is the empty accumulator after every frame;
  - with a mounted dashboard inspector and no tab: N streams, through its drop effect;
  - with neither: none.
- **Check 163, counted:** 41 `/api/graph` requests over the arm, one per frame in each step, each starting in the frame's millisecond.

**What the shared graph does.**

- **A change aborts and drops nothing.** `noteGraphChanged` re-arms a 250 ms quiet window (`GRAPH_QUIET_MS`). The watch tail, a created draft and a promoted draft each call it, so a promotion and its own watch frame are one burst.
- **The burst's end** waits for every fetch in flight, since each began before the last change. The wait stops once the promise it awaited has settled, so a fetch that ends always frees it. It then reads `open()` (a File Browser or a graph tab): open, it fetches once; closed, it drops the view for the next surface to fetch. Each end takes a number before its wait, and of two ends that wait on one fetch only the later goes on after it.
- **A refresh keeps the last complete view** and replaces it once, when the answer completes; a first load publishes per batch. A load is a refresh only over a view a stream completed: a surface's own retry after a refresh's failure keeps the view too, and a first load that fails keeps what it streamed, so an inspector does not start it again, and the next load streams afresh over it.
- **A failure keeps the view and sets the error.** The burst ends, nothing retries without a change or a surface's own load, and the next burst fetches.
- **A stream that delivers no event for 30 s** (`GRAPH_STALL_MS`) is aborted and fails that way. The bound applies to every stream, a first load included, since the burst's end can wait on either.
- **`invalidateGraph`, `reloadGraph` and the store's `teardown`** cancel a burst whose end has not come (`cancelGraphRefresh`).
- **The index lag stays as ruled:** the burst's fetch can read the graph before the indexer applies the burst's own changes. The row "A graph refresh after a burst of events reads the graph before the indexer applies the burst" holds it.

**Where the build departs from the design and the rulings, with the reasons.**

- **The wait does not spin.** The first mutant run hung on `failure-busy`: a loop on `inflight` spins on a settled promise that is never cleared. The wait now advances only when `inflight` names another fetch.
- **A retry keeps the view.** A load refreshes in place over a complete view (N1 below), so a surface that asks again after a failure keeps the view the failure left (R3 and R4 together).
- **The stall bound covers first loads**, for the reason above.
- **Each draft site is its own guard.** The two sites each have a pin and a mutant; the design counted them as one.
- **N1 has its pin:** a tab closed while the burst's end waits on a fetch gets no fetch after it.

So there are 13 cases and 15 mutants, against the ruled eleven and twelve; the fold below adds S1's and N1's, 15 and 17.

**Pins.** 13 cases in `state/store.graphRefresh.test.ts`, through `onWatchEvent` over the demo workspace with fake timers, every `/api/graph` stream held by the test:

- ten events with a File Browser, one fetch a quiet window after the last frame (G1);
- a frame while the fetch is out: not aborted, its answer published, then one more fetch (G2);
- two bursts a second apart, one fetch each (G3);
- a failure: the view kept, the error set, no retry, a surface's retry keeping the view, the next burst fetching (G4);
- the view through a burst and a refresh that has sent a batch, equal to the last complete one (G5);
- no surface: no fetch, the view kept through the burst and dropped at its end (G6);
- a tab closed while the end waits on a fetch out (N1);
- a mounted dashboard inspector with no tab, one fetch per burst (G7);
- an explicit reload inside a quiet window, the burst's only fetch (G8);
- a stream that sends nothing, aborted at the bound, the view kept and the next burst freed (G10);
- a teardown inside a quiet window (G11);
- a created draft and a promoted draft with its frame, one fetch after the window (G9).

**Evidence**, in the frontend guest, logs under `dev/v0107-team/evidence/Frontend107/grfref/` in the round's bus:

- **Red first** (`runs-2.{log,status}`, the file against the parent's code): 13 of 13 fail on their assertions, among them G1 `no fetch while the frames keep coming: expected 20 to be +0`, G5 `expected [ { nodes: [], edges: [] }, ...] to deeply equal [...]`, G6 `kept through the burst: expected null to deeply equal {...}` and G9 `nothing before the window ends: expected 3 to be +0`. G2 and G10 stop at their first count (two fetches per event at the base); their guards are shown by the mutants below.
- **Green:** the 21 files that touch the shared graph, 360 tests (`runs-1`), and the pins with the graph stream and index reload files at the final code (`runs-2`).
- **Mutants** (`runs-2`, `mutant-table.py.txt`): 15, one per guard, each red on its own assertion:
  - the quiet window not re-armed (G1);
  - a change aborting the fetch out, and no wait for it (G2);
  - a refresh publishing per batch (G5);
  - a failure leaving the fetch set (G4's retry), a failure clearing the view (G4), and a retry blanking the view (G4);
  - a fetch with no surface, and the view kept with no surface (G6);
  - `open()` read before the wait (N1);
  - `invalidateGraph` not cancelling the burst (G8);
  - no stall bound (G10);
  - `teardown` not cancelling (G11);
  - each draft site fetching at once (G9).

  The first run (`runs-2-try-1`) hung on the failure mutant and found the promotion's mutant surviving; both pins are as above.
- **Check 163** (`scripts/e2e/browser-smoke/checks/163-file-browser-watch-refresh.mjs`), in Chrome for Testing 155.0.8059.84, against the bundle and a debug `chan` built at this change's code (`c163-checks-build`). Every step marks its frames and `/api/graph` starts by CDP's stamps and ends when a fetch has started after its last frame. The arm then asserts one or two fetches per step, with the last at least 200 ms after the step's last frame, and its comment states the race:
  - **alone** (`c163-fix`): PASS, one fetch in each of the eight steps, 250 to 258 ms after the step's last frame;
  - **over the parent's bundle** (`c163-base`, the parent's web sources; the new test file stays in the tree and is not in the bundle): red on its own assertion, one fetch per frame and a gap of 0 ms in every step (the removal 12 frames and 12 fetches);
  - **beside checks 162 and 164** (`c163-beside`): all three pass, 163 with one fetch per step, 250 to 251 ms after its last frame.
- **`make web-check`** at this change's code (`web-check.{log,status}`, rc 0, 21:10Z to 21:25Z, on two CPUs, the guest checkout clean before and after, no OOM event):
  - svelte-check 0 errors and 0 warnings in web-shared, the launcher, the workspace app and profile;
  - vitest: web-shared 7 files and 218 tests, the launcher 57 and 619, the workspace app 562 and 7260, profile 5 and 20;
  - the workspace app's production build.

  That run is at the first build's code; the fold below gates the commit's.

**The range's read, folded.** The review seat's read of the range (`reviews/review-Review107-86-grfref-range.md`, the lead's word in its task 11) and the suite owner's read of check 163 (`reviews/review-Hygiene107-7-c163-grfref.md`, the lead's word in its followup 33), both in the round's bus:

- **S1, two burst ends waiting on one fetch dropped the view it brings; repaired.** A burst ends while a fetch is out, and its end waits on it; a second burst begins and ends before that fetch answers, so its end waits on it too. The first end then fetched and took the open predicate, and the second, waiting on that fetch, found the predicate taken and dropped the view the fetch had just published: a fetch, a drop and a first load over an empty view, for any fetch slower than the gap between two burst ends. Each end now takes a number (`settleSeq`) before its wait, and only the latest goes on after it.
  - Pin: "two bursts that end while one fetch is out fetch once after it and keep the view that fetch brings", red at the first build's code on `expected { fetches: 2, view: null } to deeply equal { fetches: 2, view: C }`.
  - Mutant `settle-seq` (the number's check removed): red on the same assertion.
- **N1, a failed first load's partial view refreshed by its retry as if complete; repaired as one guard.** A first load publishes per batch and on a failure keeps what it streamed; the first build's retry saw a view and refreshed it, so the partial view stayed on screen until the retry answered.
  - The form the lead named, a failure keeping the view only when a stream completed it, drops the partial view, and the inspectors' drop effect then starts the failing load again: the probe `n1-literal` turns the three "a graph stream that keeps failing is started once" tests (`FileInfoBody`, `TagInfoBody`, `WorkspaceInfoBody`) red at 9 streams each.
  - So the failure keeps what it streamed, and `loadGraph` decides its mode from the view and a flag (`viewPartial`) set at a first load's start and cleared when a stream completes: a load over a partial view streams afresh, as the parent's retry did.
  - Pin: "a first load that fails keeps what it streamed, and its retry streams afresh", red at the first build's code on "the retry starts afresh"; it passes against the parent's code, whose retry streamed afresh.
  - Mutant `partial-refreshes` (the flag ignored): red on the same assertion. The retry mutant `retry-blanks-view` moves with the decision into `loadGraph` (a load after any failure streams afresh) and is red on "the retry keeps the view too".
- **Check 163's cap (O2).** A page that fetches at 250 ms and again later passes each step, and holds two fetches in every step, or in all but one when its second fetch lands after the next step's mark. The check now fails when more than three of its eight steps hold two fetches, on "the shared graph was fetched twice for <n> of <m> bursts, more than the race allows", followed by every step's counts.
- **Seen and declined for this round by the lead:** O1, the timeout's sentence does not say whether a step fetched inside the burst or not at all; O3, a frame of a step that arrives after the step's wait returns is judged as that step's, which no run shows.

**The fold's evidence**, in the frontend guest, logs under `dev/v0107-team/evidence/Frontend107/grfref/` in the round's bus:

- `runs-3`: the 15 pins against the first build's code, 2 red (S1 and N1, each on its own assertion) and 13 pass; green, the 21 files that touch the shared graph, 362 tests. Its mutants from `teardown-keeps-burst` on ran with the earlier store mutants still applied (its restore reinstalled only the changed files), so they are not counted.
- `runs-4`: the 17 mutants and the probe, with the checkout reset to the first build and the change installed before each: all 17 red on their own assertions (`mutant-table-3.py.txt`), and the probe as above. Its files equal the commit's but for one comment (`runs-4-wip-vs-scratch-2.diff`).
- `pins-red-at-parent`: the 15 pins against the parent's code, 14 red, 11 on their own assertions and 3 (G2, G10 and S1) on a count before it, whose guards the mutants show; N1's pin passes there.
- **Check 163** in Chrome for Testing 155.0.8059.84, against the bundle and debug `chan` built at the commit (`c163-checks-build-2`); each step's frames, fetches and last gap are in `c163-counts-2.txt`:
  - **alone** (`c163-fix-2`): PASS, one fetch in each of the eight steps, 250 to 253 ms after the step's last frame;
  - **beside checks 162 and 164** (`c163-beside-2`): all three pass; 163 holds one fetch in seven steps and two in the removal, 250 to 251 ms after the last frame;
  - **over a page that fetches twice per burst** (`c163-cap-control`, the web app with a second `loadGraph` 20 ms after the first, a commit never landed): red on the cap, "fetched twice for 8 of 8 bursts", 270 to 274 ms after each step's last frame;
  - **over the parent's bundle** (`c163-base-2`): red on the per-step judgement, a fetch per frame at 0 ms in every step.
- **`make web-check`** at the commit's code (`web-check-2.{log,status}`, rc 0, 22:22Z to 22:36Z, on two CPUs, the guest checkout clean before and after, no OOM event):
  - svelte-check 0 errors and 0 warnings in web-shared, the launcher, the workspace app and profile;
  - vitest: web-shared 7 files and 218 tests, the launcher 57 and 619, the workspace app 562 and 7262, profile 5 and 20;
  - the workspace app's production build.

  The commit that lands holds that run's web and check files and differs from it in this row's text and the message only.

Acceptance:

1. **The count per frame at the base, in a test and in check 163:** the reading above, and the pins' and the check's base runs.
2. **The decision:** the lead's rulings above.
3. **N frames with a graph surface open cost a bounded number of fetches, the last after the last frame, pinned red first; one mutant per guard:** G1, G2, G3 and S1, with the mutants above; in the browser, check 163's judgement and its cap.
