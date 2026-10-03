# The by-root mount query answers from the first tenant the key finds

Status: shipped in [v0.101.0](../../release/release-v0.101.0.md).

Record before the release: raised during v0.101.0 on 2026-09-26 by the services lane's hung-root order (`dev/v0101-team/reports/report-Services-7.md`, "Terminal-tenant parity", in the development tree), read in code and not reproduced; a source reading against `main` at `ef33cb0f3`.

## Owner ruling

Accepted on 2026-09-26 as the lead recommended, with [the-canonical-key-query-counts-the-terminal-tenant](the-canonical-key-query-counts-the-terminal-tenant.md): the by-root query answers over every runtime the key finds, preferring one holding a workspace, pinned with the terminal tenant up beside a registered home workspace.

## What was seen

`WorkspaceHost::is_root_mounted` answers through `live_workspace_by_key`, which takes the first runtime `found_by` the key in the routing map, a `HashMap`, and reads that one's workspace cell. The shared terminal-only tenant's root is the home directory. With a home workspace mounted and the terminal tenant up, two runtimes match the key and iteration order decides which is read: when it is the terminal tenant, whose cell holds no workspace, the query answers false for a workspace that is mounted. Its callers, the serve tests and whatever else asks by path, inherit the answer.

## Desired contract

A by-root mount query answers true when any runtime holding a workspace matches the key, whatever else matches it.

## What to do

Have `live_workspace_by_key` prefer a runtime whose cell holds a workspace, or answer over all matches, and pin it with the terminal tenant up beside a registered home workspace. Small.

## Boundaries

`crates/chan-library/src/host.rs` (`live_workspace_by_key`, `is_root_mounted`) and its tests.

## What shipped

Landed on 2026-09-27 with [the-terminal-tenant-answers-for-a-home-workspace](the-terminal-tenant-answers-for-a-home-workspace.md), whose What shipped is the full record. What answers this item: `live_workspace_by_key` finds its runtime through `found_by`, which now answers only for a runtime that holds a workspace, so `is_root_mounted` and `live_workspace` read the home workspace's own runtime whatever terminal tenants go by the same key. Pinned with the shared terminal tenant and two command tenants up beside a mounted home workspace (`queries_find_home_beside_shared_and_command_terminals` in `crates/chan-library/src/host.rs`). Which runtime the routing map yields first is not fixed, so a return to the first match would red that pin only when a terminal tenant comes first, which three of them beside one workspace make likely but not certain.
