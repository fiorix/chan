# A relinked root's off row outlives a devserver restart as a record no list shows

Status: raised for a decision on 2026-09-27 while the fix for [a-hung-root-stalls-desktop-close-and-quit](a-hung-root-stalls-desktop-close-and-quit.md) was built; read in code and not reproduced, a source reading at `72578a59b`. Recommendation: accept for a later version: no user-visible effect is known.

## What was seen

A user's off through the host records the workspace off under the key the host resolved and, when it differs, under the root the registry row stores (`overlay_spellings`, `crates/chan-library/src/host.rs:4347-4358`, written by `close_workspace_for_root_locked` and `close_workspace_impl`, `:3149`, `:3170`, `:3356`). The two differ for a root that moved under a symlink after it was registered. On the devserver, a control-socket `chan close` and the MCP bridge's close of such a root reach those arms (`crates/chan-server/src/control_socket.rs:1891`, `crates/chan-server/src/mcp_bridge.rs:627`, `:646`), so the devserver's overlay gains an off row under the resolved key beside the off row under the stored root. The resolved-key row predates the fix; the fix added the stored-root one.

- **A running devserver drops the row at its next save**, when it holds no record under that key: a save replaces the overlay with the rows of its records (`persist_state_with_mounted_snapshot_locked`, `crates/chan-server/src/devserver.rs:1506-1552`).
- **A restart that comes first loads it as a record.** The restore reads every overlay row (`run_devserver`, `devserver.rs:2175-2181`). Right after a load the registry holds the row's stored root and not the resolved key (`registered_root_keys`, `:3093-3099`, over a cached path a load sets to the stored root, `crates/chan-workspace/src/registry.rs:260-271`), so `register_restore_rows` registers the resolved key (`devserver.rs:1732-1773`); the registration finds the relinked row by its alias and sets its cached path to the resolved key (`touch_matched`, `registry.rs:383-391`), so the row is kept. `prepare_restore_rows` then makes a record for every row it is handed, off rows included, keyed by each row's own prefix (`devserver.rs:1781-1809`), so the resolved key gets an off record of its own beside the stored root's.
- **The list never shows that record.** `workspace_entries` lists one row per registry row, taking the record whose root is that row's stored root, and adds a record whose root no row stores only when it is on (`devserver.rs:1604-1638`).
- **Every later save writes the row back.** A save keeps a record whose root is among the registry's keys, which now include the row's cached resolved path, and writes each kept record's row into the overlay (`devserver.rs:1531-1535`, `:1547-1552`; `WorkspaceRecord::persisted`, `:589-598`). The next restart loads it again.

The devserver's restart test for a relinked root turned off (`a_relinked_root_turned_off_reads_off_after_a_restart`, `devserver.rs:6889-6932`) restarts in this state and asserts only that no listed entry reads on. No test asserts what becomes of the row under the resolved key, or of the record it makes.

## Desired contract

After a restart each registered workspace has one devserver record, and an overlay row that only restates another row's intent under a second spelling of the same root does not outlive the next save.

## What to do

Either match a restored row to its registry row and key the record by the row's stored root, as the devserver's other records are, or drop at the save a record whose root is only a registry row's cached path and not its stored root. Red first with the existing restart test, asserting the overlay's rows after a save.

## Boundaries

`crates/chan-server/src/devserver.rs` (`register_restore_rows`, `prepare_restore_rows`, `persist_state_with_mounted_snapshot_locked`) and its tests. The host's two spellings and the desktop are unchanged.

## Acceptance

1. After an off of a relinked root and a devserver restart, a save leaves no overlay row under the resolved key, and the root reads off.
2. The relinked root restored on still lists once, on, with its token.
