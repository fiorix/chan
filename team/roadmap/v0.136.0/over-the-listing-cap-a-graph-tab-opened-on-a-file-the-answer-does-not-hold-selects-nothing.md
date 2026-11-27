# Over the listing cap a graph tab opened on a file the answer does not hold selects nothing

Status: accepted by the owner on 2026-11-26 (the last section); not started. Not built in v0.135.0, so the GA commit moves it to the next version (D125). Moved to v0.136.0 at the v0.135.0 GA on 2026-11-27.

Record: finding 7 of the cumulative read of the graph area, "Readers the mark does not reach (not regressions; a candidate row)" (`dev/v0135-team/reviews/review-cumulative-graph.md`), which the lead sent to the owner as a pre-existing candidate row (`dev/v0135-team/decisions.md`, D92). [The graph's walks over the listing cap](../done/the-graph-walks-a-workspace-over-the-listing-cap-three-times-per-load-and-shows-no-folder-layer.md) notes it for the owner ("The cumulative read's fixes, 2026-11-26"). Two readers: (a) a tab opened on a file, and (b) the language lens.

## What is there now

Read at `aabb9d039`, by reading, except the probe named. Paths are under `web/packages/workspace-app/src/` unless named otherwise.

- Over the cap a graph answer marked `tree: "folders"` holds every folder in scope and, of the files, those the graph already held, each joined to its folder (the graph row, "Built, 2026-11-25").
- (a) A tab opened on a file asks for it with `nodeSelection` (`state/store.svelte.ts:5136-5138`): depth 1 and a pending selection, with no folder opened; a tab opened on a directory gets the path down to it opened (`directorySelection`, `:5130-5132`). The tab drops a pending selection once the graph is whole and holds no node for it (`components/GraphPanel.svelte:2202-2222`). So over the cap a tab opened on a plain file the answer does not hold ends with nothing selected.
- The review's probe PB read that red at `66ba7b3b3`: `{selected: null, pending: null, reads: [""]}`, with its whole-tree control PB0 green. By the review's reading the base did the same. No line that names `pendingSelectId` changed in `GraphPanel.svelte` between `66ba7b3b3` and `aabb9d039`, and `store.svelte.ts` did not change (`git diff`); the probe was not run again.
- (b) The language layer's comment says the lens splays out to every file of a language (`crates/chan-server/src/routes/graph.rs:1806-1815`). Over the cap its edges and counts cover only the files the answer holds (the review's item 7(b), by reading).
- Not read: either case in a browser. The graph tab over the cap was read in WKWebView and WebKitGTK for its folders and level reads (the graph row, "Merged, and read on the engines, 2026-11-26"), not for a tab opened on a file.

## Desired contract

1. Under an over-cap answer (`tree` of `"folders"` or `"depth"`), a tab opened on a file the answer does not hold opens the file's folder chain, reads those levels, and selects the file once its level holds it. The pending selection is dropped only when the file's own level does not hold it either.
2. Under an answer of the whole tree, a tab opened on a file behaves as today.
3. The language layer's comment says what the lens holds over the cap. No design document states the lens (`grep`).

## Boundaries

- The tab's pending selection over the cap (`components/GraphPanel.svelte`, the openers in `state/store.svelte.ts`) with their tests, and the language layer's comment.
- Not here: what an over-cap answer holds, and the server's walks. For the lens the record proposes the comment only, not a lens that reaches every file over the cap.

## Acceptance

1. A mounted test, red at the base: probe PB's shape (an over-cap answer without the file, a tab opened on it) ends with the file selected after its level is read; PB0's whole-tree control stays green. One mutation turns the case red.
2. A browser reading on a generated tree over the cap in an isolated guest: a graph tab opened from a plain file deep in the tree lands with that file selected. Red at the base, green at the tip.

## Accepted, 2026-11-26

Accepted by the owner on 2026-11-26 ("app and workspace recommendations are good to me", `dev/v0135-team/decisions.md`, D125, which names it "the graph tab on a file the over-cap answer does not hold"), answering the candidate rows of the round's hand-back (`dev/v0135-team/handback.md`, section 7, "Graph over the cap"). Drafted as a lead document and not built in v0.135.0, so the GA commit moves it to the next version (D125).
