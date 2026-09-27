# A cancelled workspace search stops between seeds and not inside one

Status: raised for a decision on 2026-09-27 by the independent review of the cancellation of a started MCP tool ([a-started-mcp-tool-cannot-be-cancelled](a-started-mcp-tool-cannot-be-cancelled.md); `dev/v0101-team/reviews/review-Runtime-14.md` in the development tree, its first finding, on the residual, with the lead's notes, which ruled that that work adds no read of the flag per hop), which read the code at `a4b09f6b2`; read again at `37e9d23dd`, where it holds, and not run. How long one seed can run on a large graph was not measured. Recommendation: a later version, with a measurement first.

## What was seen

A cancelled `workspace_search` reads its cancel flag at three kinds of boundary: at each entry of the catalog's tree walk (`Catalog::load`, `crates/chan-workspace/src/workspace_search.rs:975`, into `tree_entries`, `crates/chan-workspace/src/fs_ops.rs:2013-2016`), at each entry and file of the rescan of a warm report whose scope has changed (`workspace_search.rs:1005`, through `crates/chan-workspace/src/workspace.rs:4342-4350` and `:4457-4471` to `crates/chan-report/src/walk.rs:215-218` and `crates/chan-report/src/lib.rs:182-187`), and before each seed of its traversal (`workspace_search.rs:682-685`).

A seed runs to its end once it starts. `traverse_seed` runs up to the request's depth, at most ten hops (`MAX_DEPTH`, `:24`, applied at `:750`), each a query of the graph for the frontier's relationships (`:2064-2091`, the query at `:2071-2072`), and then, for a tag, a mention or a contact, its closure work (`:2092-2107`), or for a directory the directory's walk of the catalog with its closure (`traverse_directory`, `:2111-2146`); none of it reads the flag. Before the first seed, only the report's rescan reads it: the catalog's graph queries (`:985-1001`), the report's load or snapshot (`:1005`; `workspace.rs:4342-4360`), content retrieval (`workspace_search.rs:658-662`), entity matching (`:663`) and seed resolution (`:668-674`) run to their end, as does the relationship query after the last seed (`:690`). The search's own comment and `crates/chan-llm/design.md:71` say so (`workspace_search.rs:570-578`), as does the comment of the context's constructor (`crates/chan-llm/src/tools.rs:207-217`).

So a close of a root can wait on a running search for a whole seed and for the work before the first seed, where [a-started-mcp-tool-cannot-be-cancelled](a-started-mcp-tool-cannot-be-cancelled.md) asked that a close wait on a tool body for at most one filesystem call. The review's case: a search from a tag that most of a large workspace carries, at depth ten, cancelled during its first hop, runs the other nine hops and the closure before it reads the flag. How long that takes was not measured.

## Desired contract

A cancelled workspace search stops within a unit of work the documents name and a measurement shows to be short, so that a close of its root waits on it about as long as on a tree walk's entry.

## What to do

Measure first: the time of one seed at depth ten and of the work before the first seed, on a large workspace's graph. If either is long, read the flag at each hop of `traverse_seed` and between the phases before the first seed, which the landed work left out as a change of the traversal; a single graph or search query still runs to its end. Red first: a traversal whose flag is set during a seed's first hop, shown to run its remaining hops.

## Boundaries

`crates/chan-workspace/src/workspace_search.rs` (`workspace_search_cancelable`, `traverse_seed`, `traverse_directory`) and its tests, and the sentences that name the unit (`crates/chan-llm/design.md:71`, the comments at `workspace_search.rs:570-578` and `crates/chan-llm/src/tools.rs:207-217`). The cancellation's other boundaries are unchanged.

## Acceptance

1. A measurement of one seed at the depth limit and of the work before the first seed, on a named large workspace.
2. If the search gains reads of the flag, a flag set during a seed's hop stops the search at its next hop, pinned red first, and the documents name the new unit.
