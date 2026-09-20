# A text file the workspace cannot decode loses its backlinks and is re-read on every reconcile

Status: raised for v0.101.0 from the v0.99.0 fix loop's follow-ups, where the reconcile and guard follow-ups were recorded and parked. A source reading against `main` at `d3de0180b`; not reproduced.

## What was seen

`index_file_inner` (`crates/chan-workspace/src/workspace.rs`) stamps a non-Markdown file through the graph's `stamp_text_file` only after its content has been decoded as text, so a `.txt` whose bytes are not UTF-8 never gets a stat row. `reconcile` in the same file decides `needs_index` from the graph snapshot, and a file with no row is `true` every time, so every reconcile reads that file again and fails again.

`Graph::forget_file` (`crates/chan-workspace/src/graph.rs`) deletes edges with `src = ? OR dst = ?`, which removes the links other notes own into that path as well as the links the file itself declared. Reconcile's second pass calls `forget_file_serial` for any file excluded by the scope policy, so excluding a path from the workspace's scope drops the inbound Markdown links pointing at it, and they do not come back when it is included again.

In the same pass, the repair probe for a file that has a graph row but no index entry is guarded by `!fs_ops::is_markdown_file(rel)`, so a Markdown file that is present in the graph and missing from the index is not repaired by a reconcile at all.

## Desired contract

A text file the workspace cannot decode is recorded once and not retried on every pass; forgetting a file removes only the links that file owns; and reconcile repairs a graph-present, index-missing file whatever its kind.

## Boundaries

`crates/chan-workspace/src/workspace.rs` (`index_file_inner`, `reconcile`, `forget_file_inner` and `forget_file_serial`) and `crates/chan-workspace/src/graph.rs` (`forget_file`, `stamp_text_file`).

## Acceptance

1. A test writes a non-UTF-8 `.txt`, reconciles twice, and shows the second pass doing no work for it, red against today's code.
2. A test shows inbound Markdown links to a forgotten path surviving the forget, and the file's own outgoing links gone.
3. A test shows a Markdown file present in the graph and absent from the index repaired by one reconcile.
