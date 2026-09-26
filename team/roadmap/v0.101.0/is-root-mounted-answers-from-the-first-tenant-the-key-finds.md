# The by-root mount query answers from the first tenant the key finds

Status: raised during v0.101.0 on 2026-09-26 by the services lane's hung-root order (`dev/v0101-team/reports/report-Services-7.md`, "Terminal-tenant parity", in the development tree), read in code and not reproduced; a source reading against `main` at `ef33cb0f3`.

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
