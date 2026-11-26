# Backlinks list the whole tree per call and miss links to unindexed files over the listing cap

Status: accepted by the owner on 2026-11-26 (the last section); not started. Not built in v0.135.0, so the GA commit moves it to the next version (D125).

Record: found while [the graph's walks over the listing cap](the-graph-walks-a-workspace-over-the-listing-cap-three-times-per-load-and-shows-no-folder-layer.md) were built. The lead kept the backlinks route out of that row and listed it for the owner (`dev/v0135-team/decisions.md`, D13: "The backlinks twin (`backlinks_for_path` over the cap) is out of the row"), as the twin, on the inspector's linked-from list, of the defect [the v0.132.0 row](../done/links-to-files-in-a-workspace-over-the-listing-cap-draw-as-missing-in-the-graph.md) fixed for the graph (`dev/v0135-team/status.md`, For Alex, "U8 adjacent (D13)").

## What is there now

Read at `aabb9d039`, by reading; nothing run.

- `/api/backlinks/{path}` (`crates/chan-server/src/lib.rs:2102`) answers through `backlinks_for_path` (`crates/chan-server/src/routes/graph.rs:2841-2903`). Each call lists the whole tree with `list_tree_filtered_unified` (`:2865-2873`) to give the link resolver every regular file on disk beside the indexed ones, then resolves every link edge of every indexed file and keeps those that land on `path`.
- Over the 500,000-entry listing cap, or when the walk fails, the resolver has the indexed files alone (`:2860-2864`). A link to a file the index does not hold (the comment's example is `[link](LICENSE)` from a README) then resolves to no file, so that file's backlinks miss it. The walk to the cap is made on every call and thrown away, as the graph row records for the same listing before its fix.
- The graph's own load has an over-cap answer for its links: the per-target lookup the v0.132.0 row added (`link_targets_on_disk`, `graph.rs:886`), with the differences from the walk its doc comment states (`:853-885`). The backlinks route uses neither that lookup nor the graph's directories-only walk.
- Two callers ask: the inspector's linked-from list streams the answer whenever its selected path changes (`web/packages/workspace-app/src/components/FileInfoBody.svelte:438-445`), and the file editor's status bar fetches a count 600 ms after a file opens (`web/packages/workspace-app/src/components/WikiStatusBar.svelte:54-67`).
- Not measured: the time of a backlinks call under or over the cap.

## Desired contract

1. Over the listing cap, a file's backlinks hold every link from an indexed file that resolves to it, indexed or not, as the graph's link resolution over the cap finds them.
2. A backlinks call makes no whole-tree walk: it looks up only the targets its links name, as the graph's per-target lookup does.
3. Under the cap, every answer is the same as today's, or differs only where the per-target lookup's doc comment says it differs from the walk (a wrong-case spelling on a case-folding volume, a file inside a mount point inside the root, an extensionless link to a text file, a source-relative spelling of a non-Markdown file), each such difference read and recorded here.

## Boundaries

- `backlinks_for_path` and its streamed form in `crates/chan-server/src/routes/graph.rs`, reusing the graph's lookup, with their tests.
- Not here: the graph's own load, the inspector's and the status bar's display.

## Acceptance

1. Route tests with the cap lowered: a link to an unindexed file is found over the cap, red at the base; a counter shows no whole-tree walk in a backlinks call, red at the base.
2. A differential of backlinks answers, base against tip, on a fixture tree under the cap: identical, or each difference one the lookup's comment names.
3. An end-to-end reading on a generated tree over the cap in an isolated guest: a backlinks call's time at the base and the tip, and the linked-from list of an unindexed file that indexed notes link to.

## Accepted, 2026-11-26

Accepted by the owner on 2026-11-26 ("app and workspace recommendations are good to me", `dev/v0135-team/decisions.md`, D125), answering the candidate rows of the round's hand-back (`dev/v0135-team/handback.md`, section 7, "Backlinks"). Drafted as a lead document and not built in v0.135.0, so the GA commit moves it to the next version (D125).
