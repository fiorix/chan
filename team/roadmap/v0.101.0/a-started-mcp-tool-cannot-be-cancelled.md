# A started MCP tool cannot be cancelled and holds its root's writer lock until it returns

Status: raised during v0.101.0 on 2026-09-26 from the root locks lane, whose report and independent review (`dev/v0101-tasks/report-rlock.md` and `dev/v0101-tasks/reviews/review-rlock.md`, 2026-09-25) both confirmed by reading the second of the two clauses [one-root-blocks-every-other-mount](one-root-blocks-every-other-mount.md) reported without re-verifying: a tool body that is not cancelled at unmount. The lane did not fix it. A source reading against `main` at `426f06e33`; not reproduced.

## What was seen

`run_tool` in `crates/chan-llm/src/mcp.rs` runs a JSON tool inside `spawn_blocking` and reads the request's cancellation token there twice: before it resolves the workspace (`:631`) and after (`:636`). It then calls `tools::execute` (`:639`), and nothing reads the token again. `ToolContext` carries only the workspace (`crates/chan-llm/src/tools.rs:69-71`), so neither `tools::execute` nor the tool it dispatches to (`tools.rs:247-259`) can see a cancel. `read_media_content` has the same shape: its checks are at `:656` and `:661`, and `read_media_content_sync` (`:664`) then runs to its end. The test `mcp_cancelled_request_does_not_resolve_or_write` (`:933`) pins a cancel that arrives before the body starts, the only case the code handles.

A cancel therefore stops only a tool that has not started. A body already running, a `list_files` or a `workspace_search` over a large tree for example, whose loops run inside chan-workspace (`list_tree_unified` at `tools.rs:313`, `workspace_search` at `:358`), runs to completion and holds its `Arc<Workspace>` until it returns. That handle owns the root's writer lock (the `_lock` field of `Workspace`, `crates/chan-workspace/src/workspace.rs:846`). A close of the root clears the workspace cell and then waits for that lock's release (`HostedWorkspaceRuntime::shutdown`, `crates/chan-library/src/host.rs:572-600`), and `wait_for_workspace_release` gives up after 5 s with `close_workspace: workspace flock still held 5s after teardown` (`host.rs:3930-3946`), so the lock stays held past the close until the body returns. The reindex pass has the same shape and takes a cancel flag checked at file boundaries for exactly this reason (the comment in `shutdown`, `host.rs:573-582`); a tool body has none. `crates/chan-llm/design.md` and `crates/chan-library/design.md` already say that a running tool body is not interrupted and can keep its workspace.

## Desired contract

Once its request is cancelled or its root closes, a running tool body stops at its next file or result boundary, answers `request cancelled` and drops its workspace, so a close waits on a tool body for at most one filesystem call, as it does for the reindex pass. A single blocking call is still not interrupted.

## What to do

Carry the request's `CancellationToken` into `ToolContext` and poll it inside the loops that can run long. The review names the search, the tree walks and `repo_report`; those loops live in chan-workspace, so they need a cancellation seam of their own, the way the reindex pass takes its flag. `read_media` reads one file in one call and keeps the checks it has. Establish whether a root's close reaches the tokens of the requests still running against it, which this reading did not. Red first: a test that cancels a request while its tool body is inside a walk and shows the body return before the walk ends; today it runs to the end.

## Boundaries

`crates/chan-llm/src/mcp.rs` (`run_tool`, `read_media_content`), `crates/chan-llm/src/tools.rs` (`ToolContext` and the tools), the chan-workspace calls those tools make where a loop needs the seam, and the cancellation paragraph of `crates/chan-llm/design.md`. The root locks and the close path in `crates/chan-library/src/host.rs` belong to [one-root-blocks-every-other-mount](one-root-blocks-every-other-mount.md), as does that item's other clause, the over-cap handoff reply.
