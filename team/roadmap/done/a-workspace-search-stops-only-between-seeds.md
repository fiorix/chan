# A cancelled workspace search stops between seeds and not inside one

Status: shipped in [v0.102.0](../../release/release-v0.102.0.md).

Record before the release: accepted by the owner on 2026-09-29 for a later version than v0.101.0, so it is held under v0.102.0; raised during v0.101.0 on 2026-09-27 by the independent review of the cancellation of a started MCP tool ([a-started-mcp-tool-cannot-be-cancelled](a-started-mcp-tool-cannot-be-cancelled.md); `dev/v0101-team/reviews/review-Runtime-14.md` in the development tree, its first finding, on the residual, with the lead's notes, which ruled that that work adds no read of the flag per hop), which read the code at `a4b09f6b2`; read again at `37e9d23dd`, where it holds, and not run. How long one seed can run on a large graph was not measured.

## Owner ruling

Accepted on 2026-09-29 for a later version. The owner accepted in one answer every recommendation the lead had put to them that day, and with that answer closed v0.101.0's intake under one rule: a raised item enters v0.101.0 only when it loses a user's data or weakens security and its fix is small and local, a test-only or infrastructure item only when it makes the release gate or a release job unreliable, and an item whose fix changes a contract or reopens excluded scope, or whose fault is a wrong state with a rare trigger, goes to v0.102.0. Under that rule this item goes to v0.102.0: a cancelled search waits for one seed at most and nothing is lost, and how long one seed runs on a large graph was never measured. The measurement comes first, as the lead recommended when the item was raised. It is not part of v0.101.0.

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

## What shipped

Built on 2026-10-03 on the v0.102.0 integration branch and not on `main`, in a range the lead accepted on its report, its status files, an independent review of its whole diff and the lead's own reading of the parts that review questioned. This record was written that day from those.

Measured first, in a release build on a generated workspace. At 20,000 notes and 100,000 links no stretch without a flag read took longer than 139 milliseconds. At 200,000 notes the work before the first seed took 1.44 seconds, one seed 1.24 seconds and the pass after the last seed 4.84 seconds. So the reads were built: a search reads its cancel flag after each of the catalog's three graph queries, before content retrieval, entity matching and seed resolution, before each seed, at each hop of a seed, before a seed's closure work and before the induced-relationship query (`workspace_search_cancelable`, `traverse_seed`, `crates/chan-workspace/src/workspace_search.rs`). Pinned: a flag set during a seed's first hop stops it at the next hop, one set during the only hop stops the search before its last query, and one set before the first seed stops it at its next phase. `crates/chan-llm/design.md` names the unit and carries the measurement. Left: one query with the pass over its rows still runs to its end, and three such units stay long at the larger size: a hop over a hub (1.1 seconds), the catalog's graph queries (1.0 second together) and the pass after the last seed (4.8 seconds), which is raised as [a-directory-seed-scans-the-catalog-per-node](a-directory-seed-scans-the-catalog-per-node.md). The reads after each catalog query and before a closure have no pin of their own, since a later read catches the same cancel.
