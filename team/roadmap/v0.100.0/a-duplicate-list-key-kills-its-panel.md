# A duplicate list key kills the panel it renders in

Status: accepted for v0.100.0 by the owner on 2026-09-20. Raised on the owner's instruction to fold the frontend review's most critical findings into this version. From the review (finding INSP-01 high, LAUNCH-01 medium, and the missing error boundaries its section 5 records), re-verified against `main` at `d3de0180b` by reading.

## What was seen

**The backlinks list.** `web/packages/workspace-app/src/components/FileInfoBody.svelte` keys its backlinks `{#each}` on the source path alone and appends edges without deduplicating. The server deliberately keeps two edges that differ only by anchor or kind: the edges table's key is `(src, dst, kind, anchor)`, and `replace_file_keeps_two_anchors_to_the_same_target` in `crates/chan-workspace/src/graph.rs` asserts it. So a document that links a target twice, two anchors or a wikilink plus a markdown link, makes Svelte throw `each_key_duplicate` in production, and because the duplicate stays in the array every later update throws again: the Backlinks section is dead for that selection until the inspector is reopened. The same shape is live next to it, and not where this item first pointed. The graph loader in `state/graphData.svelte.ts` does dedupe, nodes by id and edges by `(source, target, kind, rank)`. The undeduplicated push is in `selectionEdgesFor` in the same file: two same-kind edges to one target that differ only by rank push that target twice, into four lists `FileInfoBody` keys on node id (`refs.tags`, `refs.dates`, `nonContactLinks`, and the separately keyed `backlinks`).

**The launcher's Computers deck.** In `web/packages/launcher/src/components/CommandLauncher.svelte`, two machine rows that resolve to the same `library_id` (a directly registered devserver plus its gateway roster row, or one box registered twice) both hand back the same window objects. The flattened list carries a duplicate `window_id`, the keyed each throws, and the deck goes down; any root query reaches it. `dedupeWindows` in `lib/machineTree.ts` reads like the guard for this and is not: it runs over the input list before the per-machine fan-out, so it cannot see one window handed to two machines that claim the same library.

**Nothing catches a render throw.** There is no `<svelte:boundary>` in any authored source file of the five frontend packages. A render-time throw takes down the surface it happens in with no recovery path, which turns a data-shape bug into a dead panel.

## Desired contract

A keyed list's key is unique for every shape of data the server may legitimately send. A render throw inside a pane's content, an inspector section or the launcher's deck is contained: the surface shows that it failed and offers a retry, and the rest of the window keeps working.

## Boundaries

`web/packages/workspace-app/src/components/FileInfoBody.svelte`, `state/graphData.svelte.ts`, `web/packages/launcher/src/components/CommandLauncher.svelte` and `lib/machineTree.ts`, and one boundary around each pane's content in the workspace app and around the launcher's deck. Which machine row owns a window claimed by two is a product question for the launcher; the crash guard does not wait for it. No Rust change: the server's duplicate edges are correct. The boundary around a pane's content is in `components/Pane.svelte`, which is the shell lane's file, so the pane half of acceptance 3 is cut to that lane; the inspector and launcher halves stay with the surfaces lane.

## Acceptance

1. The inspector renders a target linked twice from one document, by two anchors and by two link kinds, with both backlinks listed.
2. The Computers deck renders when two machine rows share a `library_id`.
3. A component made to throw during render inside a pane leaves the other panes, the tab strip and the command launcher working, and the failed surface says so.
4. Each case is a mounted test.
