# A removed or renamed loaded directory keeps showing in the file tree with its cached rows

Status: shipped in [v0.107.0](../../release/release-v0.107.0.md).

Record before the release: built on 2026-10-16 on the seat's branch; the section Build 2026-10-16 holds the evidence; it closes at the GA as shipped.

Record before the release: raised by the review seat on 2026-10-13 from its read of the file tree root rows design ("Outside the item" in `reviews/review-Review106-fbroot-design-1.md` in the round's bus); written down the same day by the lead as a row of its own, outside that item; owner the frontend seat; not reached in the v0.106.0 round

## What was seen

Read at source at `v0106/frontend` `31513a64f` and at the round's base, not run. When a directory that was expanded once is removed or renamed from outside chan and its parent is relisted, the directory's own row goes, but its cached rows are kept: the merge keeps every path with a further slash (`web/packages/workspace-app/src/state/store.svelte.ts`, `mergeDirEntries`, 2968 to 2973), the directory stays marked loaded, and the tree builds the directory again from its rows' paths (`components/FileTree.svelte`, `ensureDir`, 492 to 512). So the old directory keeps showing with its old rows, and a rename shows the new name beside it. Today that happens wherever the event is in scope, and nothing selected is enough. The root rows change alters one case: with a file selected elsewhere, today's tree shows the old name alone and the changed one shows both.

Not established: the behaviour in a run; that a missing directory's listing is an error the relist's catch swallows (read no further than `crates/chan-server/src/routes/files.rs` 196 to 197); what a full refresh does to it.

## Desired contract

A directory removed or renamed outside chan leaves the tree with its rows, and a renamed one shows under its new name alone.

## What to do

A constructed store case first, at the base and at the root rows tip: load a directory, send its `Removed` frame and its parent's listing without it, and read the tree's rows; the same for a rename. Then the review's proposal, to the review seat before code: the frame carries `is_dir` (the watch tail already reads it for the root, 1170 to 1173), so on a removed or renamed directory drop the rows under the old path and its keys in the loaded and error sets before the parent's relist.

## Boundaries

`web/packages/workspace-app/src/state/store.svelte.ts` (the watch tail and `mergeDirEntries`) with `store.watchFrames.test.ts`, and one arm of a browser check if the decision is a change. Not changed: the server's watcher and its frames.

## Acceptance

1. The constructed case's reading at the base and at the root rows tip, for a removal and for a rename.
2. The decision recorded here.
3. If a change: a pin per case, red first on its own assertion.

## Run once by the review of the watch relist 2026-10-13

The review seat's read of the file tree's watch relist (`reviews/review-Review106-fbroot-range-1.md` in the round's bus, its question 4) constructed and ran this in a store test at that range's tip and over its base: a loaded directory with one cached row, renamed with the dock open. With a file selected elsewhere, the base showed no change at all; at the tip the root is relisted once, the new name's row arrives, the old directory's own row goes, and its cached row and its loaded mark stay, so the tree builds the old directory again beside the new one. With nothing selected the two read the same rows, by the part of the row string the failure message shows; the rest was cut and not read. So the relist widened where the stale directory shows by one arrangement, and the fault is the one described above. Not run in a browser.

## Lead's rulings 2026-10-16

The frontend seat's design for this row (`reports/design-Frontend107-dirgon.md` in the round's bus) was read by the lead and then by the review seat (`reviews/review-Review107-63-dirgon-design.md`). The lead's rulings, in its words, the second set taking the review's five points into the design before the code:

- "O1: the listing-driven drop (the listing is the truth for one level; a deeper row survives only below a child the listing holds as a directory; the loaded and error keys at or below a dropped child go with it), in place of the frame-driven drop the row names, for your three reasons (the standalone watcher's `is_dir` always false; the workspace watcher's stat of a path that left; a frame-driven drop leaving an error key that outlives the directory). The row's "What to do" changes as the lead's word with that evidence, and its open readings are answered in the closing section (a full refresh clears the stale directory; a missing directory's listing is an error every relist's catch swallows)."
- "O2: the overtaken-listing guard is included (the sequence from `noteTreeListingStart`, a drop recorded per path, a listing not newer than a drop at or above its directory discarded, `listTreeDir` setting no loaded mark on it), with P7, P8 and M4, M5, M7 as the note gives them."
- "O3: you write check 163's arm on `v0107/frontend` and Hygiene107 reads it before the landing, as with check 166 (its C1 close step applies if the arm leaves sessions or files; the arm's cleanup removes the renamed directory as you say); grfref builds on it later."
- "O4: no; P1 and P2 run at your tip, and the row records the review's v0106 run for the state before the root rows relist."

- "D1: the overtaken-listing guard misses the dropped child's own parent: an older parent listing (for example `refreshTreeForPath`'s, served before the rename) that answers after the drop re-adds the child's row, and an expanded child then records an error. The rule becomes: a listing does not re-add a child dropped at or after its stamp."
- "D5: "at or above its directory" compares whole path segments, so a drop at `notes` does not refuse `notes-old`, and a sibling's listing, which touches only the sibling's rows, passes."
- "D2: what records a drop is named: every child that was a directory row or held a loaded, loading or error key (P7's `notes` holds only a loading key)."
- "D3: the drop records are bounded: records older than the oldest listing still in flight are deleted, each site's stamp settled in its `finally`."
- "D4: `refreshTree` records a drop at the root with its own stamp, so a first load in flight across a refresh (after a chan move or delete, on resume, on a root reconcile) cannot restore the old rows and the loaded mark."
- "N1: the row states that a selected path under a removed directory makes `FileInfoBody` list the missing parent once per grandparent listing."
- "N2: the reds run at the commit's parent, the amended tablos, not at `7ec652a78`."

## Build 2026-10-16

Built in `web/packages/workspace-app/src/state/store.svelte.ts` on the seat's branch, over check 164's revision, which changes no web file, and the amended tablos commit below it; the evidence directory named below holds each commit's sha (`final-shas-2.txt`). The lead and the review seat read the design first (the rulings above). The workspace app's design text holds the rules (`src/design.md`, "A file tree listing and its cached rows").

**What the store does.**

- A directory's listing is the truth for one level. `mergeDirEntries` replaces the directory's children and keeps a deeper row only below a child the listing holds as a directory, so the parent's relist takes a removed or renamed directory's cached rows with its own row.
- The five listing sites share one merge, `applyTreeListing`. It deletes the loaded and error keys at or below each child that leaves, and records the drop.
- The drop reads the listing, not a frame's `is_dir`. The standalone watcher sends `false` on every frame (`standalone_watch.rs` `translate`), and the workspace watcher stats a path that a removal or a move-out has taken away (`watch.rs` `event_is_dir`).
- **Stamps.** Every listing takes a stamp from one sequence when it starts (`noteTreeListingStart`) and settles it in its `finally`.
- **Discarding an overtaken listing.** A listing is discarded when it answers, a failure included, if it started before:
  - a newer listing of its own directory applied (`treeListed`); or
  - a drop at or above its directory (`treeDrops`).

  A discarded first load sets no loaded mark and records no error.
- **What records a drop.** A child that holds a loaded, loading or error key, since every listing at or below a child holds one of those there while it is out.
- **A full refresh** records a drop at the root with its own stamp, on a listing and on a missing root alike.
- **Paths** compare by whole segments, so a drop at `notes` leaves `notes-old` as it is.
- **Records** are deleted once no listing older than the one that made them is out. `teardown` resets the registry.
- **The watch tail's comment** states the drop in the present tense.

**Where the build departs from the rulings, with the reasons.**

- **D1 is a per-directory rule.** The per-child form ("a listing does not re-add a child dropped at or after its stamp") keeps the old name out when an older root listing answers last. But that listing also lacks the new name, so it would hide the renamed directory until the next listing of the root. A listing older than the newest applied listing of its directory is therefore discarded whole.
  - This covers the review's case, since the listing that dropped the child is a newer listing of the same parent, and also the hidden new name.
  - The per-child filter is then a guard no mutant can observe, so it is not built.
  - The pin asserts both the old name gone and the new name kept.
- **D2's directory-row term is not built.** Under the per-directory rule a child that is only a directory row, with no key, matters only to an older listing of its parent, which the per-directory rule already discards. So the criterion is the three key sets, each with its own pin (a loaded, an error and a loading key of a directory the parent's first listing lacks). P7's `notes` is recorded through its loading key.
- **One case added in the same class as the frame-driven drop's stale error:** a first load that fails after its directory has left records no error key.

**The open readings, answered at source.**

- A full refresh replaces the rows and resets the loaded, loading and error sets, so it clears the stale directory.
- A missing directory's listing is an error from the server (`routes/files.rs` `list_dir_entries` through `workspace.list` to `err_from`), which `refreshTreeForPath`, `relistTreeDir` and `runWatchRelist` swallow.
- The demo transport answers an empty listing for a missing directory, so the pins drive the parent's listing, which both answer alike.

**What stays.**

- **Excluded names.** The server's per-directory listing leaves out the walk filter's directory names and, at the top, `.chan` and `.git`. A directory under one of those names that `FileInfoBody` loaded directly, for a selected path inside it, loses its rows at its parent's next listing, and the inspector's effect lists it again: one listing per parent listing, not a loop.
- **A selected path under a removed directory.** `FileInfoBody` lists the missing parent once, records the error and stops. The next listing of the grandparent drops that error key, so it asks once more: one failing listing per grandparent listing. The arm's removal step, with `nested` selected under `folder`, meets it.
- **Expansion stays keyed by path.** A renamed directory's new path opens collapsed.
- **A full refresh's answer replaces the rows** whatever listing answered while it was out. Root watch relists wait for a refresh in flight, as they always have.

**Pins.** 17 cases in `state/store.watchFrames.test.ts` ("a directory that leaves its parent's listing"), over the demo workspace:

- the removal, the rename, and the removal from a frame without the directory bit (P1 to P3);
- a directory made again under the old name listing afresh (the loaded key);
- the error key of a directory below a removed one;
- a relist keeping a directory it still holds (a guard);
- a first load overtaken by the rename (with no record left once every listing settles), and one below a removed directory;
- a first load that fails after its directory left;
- the older parent listing answering last (D1);
- a first load across a full refresh, and across a refresh that finds the root gone (D4);
- every listing site settling its stamp (D3);
- a sibling whose name the dropped directory begins (D5, a guard);
- a loaded, an error and a loading key of a directory the parent's first listing lacks (D2).

**Evidence**, in the frontend guest, logs under `dev/v0107-team/evidence/Frontend107/dirgon/` in the round's bus:

- **Red first** (`dirgon-runs-1.{sh,log,status}`, at `2515f1446`, whose web tree the commit's parent holds unchanged, with the file as it lands): 15 of the 17 fail.
  - 14 fail on their own assertion: the removal and the rename `expected [ 'notes/sub', 'notes/a.md', ...(2) ] to deeply equal []`; the older parent listing `expected [ 'notes' ] to deeply equal []`; the overtaken first load `expected [ 'notes/a.md', 'notes/b.md' ] to deeply equal []`.
  - The settle case fails on the record count export, absent there; the six settle mutants turn it red at the fix.
  - The two guards pass, and so do the file's 34 existing cases.
- **Green:** the 66 files that touch the file tree's state, 1358 tests.
- **Mutants:** 24, one per guard, each replacing one unique piece of the store, each red against the watch frame file (case counts in brackets):
  - the merge keeping every deeper row (6) and dropping every deeper row (1);
  - no loaded-key drop (6), no error-key drop (2);
  - no overtaken check (6); the drop check reading the directory alone, not its ancestors (3);
  - the loaded mark set on a discarded listing (5);
  - no newer-listing check (1), the applied listing not recorded (1);
  - either record set not pruned (2 each);
  - no root drop at a refresh (1), nor at a missing root (1);
  - a plain prefix instead of a segment (1);
  - the drop criterion without the loaded (5), the loading (3) or the error keys (1);
  - an error recorded for a discarded failure (1);
  - each of the six listing sites not settling its stamp (refresh 2, first load 2, watch relist 1, refresh for a path 1, reset 1, draft surfacing 1).

  The guest's `memory.events` counted no OOM event.
- **The reaction's cost** (`dirgon-cost.{log,status}`; `listing-cost.measure.test.ts` and `listing-cost.sh`, a measurement never committed):
  - One root listing applied over a cached tree of 10,201 rows and 201 loaded directories, 100 rounds per run, three runs of each store alternating.
  - Median 43.8, 46.1 and 43.5 ms below the change; 46.8, 46.0 and 46.4 ms with it. p90 runs from 47.3 to 52.1 ms across the six.
  - A burst of watch frames starts at most one listing per directory every 250 ms, so the change adds about 2 ms, within the runs' spread, to a reaction that runs at most four times a second per directory.
- **Check 163's arm** (`scripts/e2e/browser-smoke/checks/163-file-browser-watch-refresh.mjs`), in Chrome for Testing 155.0.8059.84 (HeadlessChrome/155 on Linux, inotify's frame shapes), against the bundle and a debug `chan` built in the guest at the commit (`d163-checks-build`):
  - **Alone at the commit** (`d163-fix`): PASS in 7.8 s, `leftTree` `{"renamed":{"oldName":false,"oldChild":false},"removed":{"folder":false,"nested":false}}`.
  - **Alone over the bundle below the change** (`d163-base`), with the same check file: red on the arm's own assertion, `a directory that left kept its cached rows: {"renamed":{"oldName":true,"oldChild":true},"removed":{"folder":true,"nested":true}}`. Both readings are taken before either is judged, so one run shows both steps red.
  - **Beside checks 162 and 164** (`d163-beside`): all three pass.
  - The waits before the readings are positive: the new name's row, and a root file written after the removal, which only a root listing that started after the removal brings.
  - Hygiene107 read the arm as the suite's owner. Its O1 to O3 and N1 are in the arm: it reads the old paths' rows by their full path in the tab's tree and the dock's, logs the rename's reading before the removal, and its comment names a listing that answers after the change. Run again at the commit, with check 164's revision below it:
    - **alone** (`r1-d163-fix`): PASS in 7.7 s, all eight readings false;
    - **over the parent's bundle** (`r1-d163-base`): red, `{"renamed":{"oldName":true,"dock-oldName":true,"oldChild":true,"dock-oldChild":false},"removed":{"folder":true,"dock-folder":true,"nested":true,"dock-nested":true}}`. The arm expanded the renamed directory in the tab's tree alone, so the dock held no child row of it, and its old-child reading was false at the base as at the fix;
    - **beside checks 162 and 164** (`r1-d163-beside`): all three pass.
  - Hygiene107's second read (its C1) gave that reading its control: before the rename the arm expands the renamed directory in the dock too, and waits for its child's row there. Run again at the commit (`c1-seq-1.{sh,log,status}`, the bundle and a debug `chan` built at the commit in `c1-d163-checks-build`):
    - **alone** (`c1-d163-fix`): PASS in 7.1 s, all eight readings false;
    - **over the parent's bundle** (`c1-d163-base`): red on the arm's own assertion with all eight readings true, `{"renamed":{"oldName":true,"dock-oldName":true,"oldChild":true,"dock-oldChild":true},"removed":{"folder":true,"dock-folder":true,"nested":true,"dock-nested":true}}`;
    - **beside checks 162 and 164** (`c1-d163-beside`): all three pass.
- **`make web-check`** at `cd7977ab5` (`dirgon-web-check.{log,status}`, rc 0, 18:06Z to 18:20Z, on two CPUs, the guest checkout clean before and after, no OOM event):
  - svelte-check 0 errors and 0 warnings in web-shared, the launcher, the workspace app and profile;
  - vitest: web-shared 7 files and 218 tests, the launcher 57 and 619, the workspace app 561 and 7237, profile 5 and 20;
  - the workspace app's production build.

  `cd7977ab5` is this change on the tablos commit before check 164's revision went below it. The commit that lands holds the same web tree (the same patch id, rebased) and differs from it in check 163's arm, check 164 below it, this row's evidence and the message. `make web-check` reads none of `scripts/e2e`.

Acceptance:

1. **The constructed case's reading:** P1 (a removal) and P2 (a rename) at `2515f1446`, the web tree below the commit. That holds the root rows relist as shipped in v0.106.0. The review's run of 2026-10-13 above holds the state before it (the lead's O4).
2. **The decision:** the lead's rulings above.
3. **A pin per case, red first on its own assertion:** the pins above, with one mutant per guard. The browser arm is in check 163.
