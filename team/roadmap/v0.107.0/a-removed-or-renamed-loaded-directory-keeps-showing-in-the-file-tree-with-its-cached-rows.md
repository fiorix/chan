# A removed or renamed loaded directory keeps showing in the file tree with its cached rows

Status: carried into v0.107.0 at the v0.106.0 GA on 2026-10-15, still raised for a decision.

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
