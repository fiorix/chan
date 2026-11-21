# A workspace over the listing cap locks its windows, and a deep graph freezes the page

Status: shipped in [v0.132.0](../../release/release-v0.132.0.md): the graph rebuild lists only the files the index reads; a failed index leaves the window open and the status chip shows the whole error; a listing over the cap ends its pass once with the fix named; a resumed rebuild stages every file; and the graph's depth applies on release, capped at 10 for a directory, within a 3,000-node budget with a `[limit]` cue (`v0132/listingcap` at `6c98e059e`, merged as `c22e80a5c`). Read in a guest by `scripts/e2e/listing-cap.sh`, acceptances 1 and 2 green at the tip with nine failures at the base, and by check 301 in a guest's Chrome (J198: the longest frame gap 117 ms at the tip, 767 to 850 ms with 25,216 nodes at the base). Not read on macOS, where the owner met it.

Record before the release: accepted for v0.132.0 by the owner on 2026-11-18, with all four of the lead's recommendations taken (`dev/v0132/decisions.md` in the development tree, "A workspace over the listing cap", 2026-11-18); not started.

Record: the owner's words: "found a bug trying to crank up the depth of the graph from ../chan-dev workspace ... the whole window got stuck and i used another window on the computers screen to un/hide; clicked close and the window closed". His screenshot (macOS desktop, v0.131.0): the whole window is the "Preparing workspace" screen, its one step "Build search index" marked "failed", the text "listing exceeds 500000 entries (encountered at least 500000); narrow the path or clean up the directory", and no control. The reading behind this row: `dev/v0132-team/reports/investigation-preflight-listing-cap-1.md` in the development tree (code read at v0.131.0 `d8fa491db` and at `v0132/int` `c868882c0`, where none of the paths below differ).

## What is there now

- **The workspace:** `chan-dev` tracks 578,326 files (read with `git ls-files`), 450,643 of them under directories named `evidence`; with its directories the index walk sees about 622,700 entries. Only about 98,000 are files the index reads (`.md` and `.txt`, `fs_ops.rs:381`).
- **The cap:** `LIST_TREE_LIMIT = 500_000` (`crates/chan-workspace/src/fs_ops.rs:1854`), raised as `ChanError::ListingTooLarge` (`error.rs:77`) by `tree_entries` (`fs_ops.rs:1998-2016`). The full rebuild hits it in the graph rebuild, which lists every in-scope file and directory (`fs_ops::list_tree_scoped`, `workspace.rs:3448`), not only the files it makes documents of. The search build's own walk (`list_indexable`, `index/facade.rs:1522-1536`) has no cap.
- **The retry:** the coordinator sets `IndexStatus::Error` (`indexer.rs:895-899`) and requeues the pass (`workspace.rs:1744-1750`) every 30 s (`REBUILD_COOLDOWN`, `indexer.rs:394`), forever; each retry sets `Building` first, so a page still polling loses the cover and gets it back. The rebuild marker is written before the graph rebuild, so the next server start rebuilds again. A full rebuild starts on every write to `.git/index` or `.git/HEAD` (`vcs.rs:87-88`, `indexer.rs:1446-1450`), so every commit in such a workspace starts one.
- **The lock:** `preflight.rs` turns `IndexStatus::Error` into a failed step (176-179) and sets `locked: phase != Phase::Ready` (`preflight.rs:290`), so a failed index locks the window. `PreflightOverlay.svelte` shows a failed step's label, "failed" and the error text, and no control (322-334); Tab has no button to land on; app chords are dropped under a cover; the red close dot's Hide and Close prompt paints at 30002, under the cover's 40000. The ruling that kept the lock for the index's own failures is in [the unreadable-file row](../done/an-unreadable-workspace-file-locks-every-window-that-boots-behind-the-preflight-cover.md).
- **The graph's depth:** the slider (`GraphPanel.svelte:2184-2193`) applies every intermediate value of a drag (`setDepth`, 257-266, no debounce). For a directory, depth opens every folder below it up to the deepest loaded level (`selectionDepthCap`, `graph/selectionView.ts:150-162`, no upper bound; `chan-dev` is 20 levels deep) and reads each opened folder's children (`loadOpenedChildren`, 219-233). The server bounds each request (`routes/fs_graph.rs`: depth 1 to 10, 10,000 nodes, pages of 16 to 256), but not how many folders the client opens. The layout runs d3-force on the page's main thread (`GraphCanvas.svelte`, `buildSim` 829-880, `sim.tick(300)`) over every drawn node, with no node budget.

## Desired contract

1. **The index lists what it uses.** The graph rebuild lists only the in-scope files the index reads, not every file and directory, and the listing cap counts that list. A workspace whose indexable files are under the cap builds its index whatever else it holds.
2. **A failed index does not lock the window.** The preflight locks only on a decision the user must make; an index that failed leaves the window usable (files, terminals, editing and the graph need no search index), and the index status chip names the error and how to fix it.
3. **A listing over the cap is final for its pass.** It is not retried every 30 s; the rebuild marker is cleared once the failure is recorded; the next rebuild starts on the triggers that start one today (a change to the excluded directories, the Rebuild index command, a server start, the VCS triggers). The server-start trigger is the narrower one the code has: a start rebuilds only over an empty, inconsistent or marked index, so once the failed pass's own marker is gone, a start over an index built earlier runs a reconcile, which converges, and the error comes back when another trigger runs the rebuild.
4. **The graph's depth is bounded:** the slider applies its value when released (or once per frame while dragging, with no read or layout per intermediate value), a directory's depth is capped at the server's 10, and a drawn-node budget stops the depth at the deepest level that fits, with a `[limit]` cue beside the existing `[max]`.

## Boundaries

- The cap's value stays. The search build's own walk, the fs-graph route's bounds and the excluded-directories setting are unchanged.
- A decision the user must make still locks the preflight (the unowned recovery's "rebuild").
- No new warning surface: the existing status chip carries the error.

## Acceptance

1. **A large workspace builds (end to end, in an isolated guest):** a workspace of about 520,000 non-indexable entries and a few hundred Markdown notes: the preflight reaches ready, the index reaches idle, a search finds a note; red at `c868882c0`, where the preflight locks on the listing error.
2. **A failed index leaves the window usable (end to end, in a guest):** a workspace whose indexable files alone exceed the cap: the window opens with no cover, a terminal and an editor work, the status chip names the error, and no rebuild runs again within two minutes; red at `c868882c0`.
3. **The graph's depth (end to end, a browser check over a generated deep tree):** dragging the depth slider from 1 to its end keeps the page answering input (a probe's frame gaps under a named bound), the depth stops at 10 or at the node budget with its cue, and the folders read are bounded; red at `c868882c0`.
4. Unit tests for each contract, each red without its change.
5. The manual's search and graph pages say what a workspace over the cap does, if they describe the cap.

## Decided

The owner, on the lead's four recommendations (the index lists what it uses; a failed index does not lock the window, reversing the ruling that kept that lock; a listing over the cap is final for its pass; the graph's depth is bounded): "agree on the graph recommendation", with the four quoted. All four go into v0.132.0.
