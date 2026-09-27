# A forget of a relinked root waits on a hung root once per registry lookup

Status: accepted by the owner on 2026-09-27 for a later version than v0.101.0, so it is held under v0.102.0; raised during v0.101.0 on 2026-09-27 by an independent reading of the fix for [a-hung-root-stalls-desktop-close-and-quit](../v0.101.0/a-hung-root-stalls-desktop-close-and-quit.md); the lookup count read in code, the timing inferred and not measured, a source reading at `72578a59b`.

## Owner ruling

Accepted on 2026-09-27 for a later version, as the lead recommended: the wait is bounded, and it needs a root that moved under a symlink beside a root that does not answer. It is not part of v0.101.0.

## What was seen

A registry lookup canonicalizes the path it is asked for and matches it against each row's cached canonical path; only when no row's cached path matches does it re-resolve the other rows' stored roots, and it waits up to two seconds for them (`Library::match_root`, `crates/chan-workspace/src/library.rs:556-565`; `Registry::alias_candidates`, `crates/chan-workspace/src/registry.rs:345-359`; `ALIAS_PROBE_BUDGET`, `:481`). The wait is per lookup: each lookup sets its own deadline (`fresh_canonicals`, `:562-569`), and `crates/chan-library/design.md` says so ("The bound is per lookup: a removal makes several, one for each registry step it takes, and a removal whose own row's cached path is stale can wait that long at each of them").

A row's cached path is stale when it is not where the row's root resolves now, as after the root moved under a symlink: a load sets it to the root the row stores, resolving nothing (`Registry::load_from`, `registry.rs:260-271`), and a touch sets it to where the root resolved then (`touch_matched`, `:383-391`). A forget of such a row, `chan workspace forget` through the desktop's handoff or through the control socket, goes through `WorkspaceHost::remove_workspace_for_root` (`crates/chan-library/src/host.rs:3202`) and makes four lookups, none of which finds the row by its cached path:

1. the close's registered check, for a row that is not mounted (`registered_stored_root`, `host.rs:4364-4371`, into `Library::workspace_paths_for`, `library.rs:530-531`);
2. `Library::unregister_workspace`'s peek (`library.rs:285`);
3. `reset_workspace_with`'s metadata-key lookup (`library.rs:422`);
4. its final registry removal (`library.rs:468`).

Beside a registered root that does not answer, each waits the full two seconds: about eight seconds for a row that is off and six for one that is mounted, whose close finds its runtime by the key the runtime stores and skips the first. The CLI waits three seconds for the handoff's reply (`Request::reply_budget`, `crates/chan-server/src/handoff.rs:258-266`) and past that falls back to the control socket's teardown while the desktop is still removing (`try_close_workspace`, `handoff.rs:1255-1290`). The desktop's held-restore forget test (`a_forget_of_a_queued_relinked_root_leaves_no_row_to_restore`, `desktop/src-tauri/src/main.rs:9251`) makes this forget beside a stalled root and asserts only the overlay's rows; no test asserts how long it takes. A forget of a row whose cached path matches waits on no other root, which the forget beside a hung root is pinned to.

## Desired contract

A forget of one workspace waits on no other workspace's filesystem, whatever its own row's cached path, or waits at most one bound in all, within the CLI's reply budget.

## What to do

Resolve the row once and carry it through the removal: the close's lookup already finds it, so the unregister and the reset can take that row, or its metadata key, instead of looking the root up three more times. Pin it with a relinked row forgotten beside a stalled root, asserting the reply within the CLI's budget.

## Boundaries

`crates/chan-workspace/src/library.rs` (`unregister_workspace`, `reset_workspace_with`) and `crates/chan-library/src/host.rs` (`remove_workspace_for_root` and the close under it), with their tests. The alias probe's budget is unchanged.

## Acceptance

1. A forget of a relinked row beside a stalled root answers within the CLI's reply budget, pinned on the desktop's handoff.
2. The forget still removes the row, its overlay rows under both spellings and its metadata.
