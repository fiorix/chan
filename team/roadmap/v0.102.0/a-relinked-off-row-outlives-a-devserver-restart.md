# A relinked root's off row outlives a devserver restart as a record no list shows

Status: accepted by the owner on 2026-09-27 for a later version than v0.101.0, so it is held under v0.102.0; raised during v0.101.0 on 2026-09-27 while the fix for [a-hung-root-stalls-desktop-close-and-quit](../v0.101.0/a-hung-root-stalls-desktop-close-and-quit.md) was built; read in code and not reproduced, a source reading at `72578a59b`.

## Owner ruling

Accepted on 2026-09-27 for a later version, as the lead recommended: no user-visible effect is known. It is not part of v0.101.0. On 2026-09-29 the owner ruled that the item stays open with [two-registry-rows-can-name-one-directory](two-registry-rows-can-name-one-directory.md), accepted for v0.102.0 that day: the code that landed on 2026-09-28 does what this item asks except where the registry holds two rows for one directory, which is that item's case (the reading of 2026-09-28 below).

## What was seen

A user's off through the host records the workspace off under the key the host resolved and, when it differs, under the root the registry row stores (`overlay_spellings`, `crates/chan-library/src/host.rs:4347-4358`, written by `close_workspace_for_root_locked` and `close_workspace_impl`, `:3149`, `:3170`, `:3356`). The two differ for a root that moved under a symlink after it was registered. On the devserver, a control-socket `chan close` and the MCP bridge's close of such a root reach those arms (`crates/chan-server/src/control_socket.rs:1891`, `crates/chan-server/src/mcp_bridge.rs:627`, `:646`), so the devserver's overlay gains an off row under the resolved key beside the off row under the stored root. The resolved-key row predates the fix; the fix added the stored-root one.

- **A running devserver drops the row at its next save**, when it holds no record under that key: a save replaces the overlay with the rows of its records (`persist_state_with_mounted_snapshot_locked`, `crates/chan-server/src/devserver.rs:1506-1552`).
- **A restart that comes first loads it as a record.** The restore reads every overlay row (`run_devserver`, `devserver.rs:2175-2181`). Right after a load the registry holds the row's stored root and not the resolved key (`registered_root_keys`, `:3093-3099`, over a cached path a load sets to the stored root, `crates/chan-workspace/src/registry.rs:260-271`), so `register_restore_rows` registers the resolved key (`devserver.rs:1732-1773`); the registration finds the relinked row by its alias and sets its cached path to the resolved key (`touch_matched`, `registry.rs:383-391`), so the row is kept. `prepare_restore_rows` then makes a record for every row it is handed, off rows included, keyed by each row's own prefix (`devserver.rs:1781-1809`), so the resolved key gets an off record of its own beside the stored root's.
- **The list never shows that record.** `workspace_entries` lists one row per registry row, taking the record whose root is that row's stored root, and adds a record whose root no row stores only when it is on (`devserver.rs:1604-1638`).
- **Every later save writes the row back.** A save keeps a record whose root is among the registry's keys, which now include the row's cached resolved path, and writes each kept record's row into the overlay (`devserver.rs:1531-1535`, `:1547-1552`; `WorkspaceRecord::persisted`, `:589-598`). The next restart loads it again.

The devserver's restart test for a relinked root turned off (`a_relinked_root_turned_off_reads_off_after_a_restart`, `devserver.rs:6889-6932`) restarts in this state and asserts only that no listed entry reads on. No test asserts what becomes of the row under the resolved key, or of the record it makes.

**Read again at `ada0ecc4c` on 2026-09-28: the code there does what this item asks, except where the registry holds two rows for one directory.** One record per workspace, which landed that day under [a-relinked-root-window-nests-outside-its-row](../v0.101.0/a-relinked-root-window-nests-outside-its-row.md), changed the restore this item reads. The host still writes the off row under both spellings (`overlay_spellings`, `crates/chan-library/src/host.rs:4658-4664`, written at `:3381` and `:3402`), and a restart still registers the row under the resolved key, which finds the relinked row by the stored root that re-resolves to it and caches the resolved key on it (`register_restore_rows`, `crates/chan-server/src/devserver.rs:1876-1917`; `touch_matched`, `crates/chan-workspace/src/registry.rs:384-391`). But the restore now groups the overlay's rows by the registry row each row's path names and makes one record per group, under that row's stored root, desired on when any of its rows is (`prepare_restore_rows`, `devserver.rs:1942-1990`; `registered_row_for`, `:3286-3294`), so the two off rows make one off record, and the first save writes that record's one row, under the stored root, as the whole overlay, which drops the row under the resolved key (`devserver.rs:1618-1665`; `WorkspaceOverlay::replace`, `crates/chan-library/src/workspace_persist.rs:137-160`, the overlay set at `:157`). A restore of rows under both keys, both off, is pinned to one record under the stored root, off, whose first save writes one row (`an_earlier_overlay_restores_a_workspace_on_when_any_row_is_on`, `devserver.rs:9578`, its case "both off"), and a relinked root restored on lists once, on, with its token (`a_relinked_root_turned_on_then_handed_off_is_one_record_across_a_restart`, `:9275`). Where the registration's probe of the stored root misses its two seconds, a second registry row is stored at the resolved key, the row under it makes a record of its own, and the workspace is listed twice, which is inferred from the code and not run; that is [two-registry-rows-can-name-one-directory](two-registry-rows-can-name-one-directory.md). This item's state is the owner's acceptance and is not changed here.

## Desired contract

After a restart each registered workspace has one devserver record, and an overlay row that only restates another row's intent under a second spelling of the same root does not outlive the next save.

## What to do

Either match a restored row to its registry row and key the record by the row's stored root, as the devserver's other records are, or drop at the save a record whose root is only a registry row's cached path and not its stored root. Red first with the existing restart test, asserting the overlay's rows after a save.

## Boundaries

`crates/chan-server/src/devserver.rs` (`register_restore_rows`, `prepare_restore_rows`, `persist_state_with_mounted_snapshot_locked`) and its tests. The host's two spellings and the desktop are unchanged.

## Acceptance

1. After an off of a relinked root and a devserver restart, a save leaves no overlay row under the resolved key, and the root reads off.
2. The relinked root restored on still lists once, on, with its token.
