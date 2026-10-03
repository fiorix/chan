# The canonical-key mount query counts the terminal tenant as a workspace

Status: shipped in [v0.101.0](../../release/release-v0.101.0.md).

Record before the release: raised during v0.101.0 on 2026-09-26 by the services lane's hung-root order (`dev/v0101-team/reports/report-Services-7.md`, "Terminal-tenant parity", in the development tree); the lane's first fix called it and regressed a registered home workspace in a red test before it switched to a workspace-only query. A source reading against `main` at `ef33cb0f3` for the remaining callers; not reproduced there.

## Owner ruling

Accepted on 2026-09-26 as the lead recommended, with [is-root-mounted-answers-from-the-first-tenant-the-key-finds](is-root-mounted-answers-from-the-first-tenant-the-key-finds.md): the window feed, the devserver list and the health probe ask a workspace-only query, or the canonical-key query gains that filter; each caller pinned with the terminal tenant up.

## What was seen

`WorkspaceHost::is_canonical_root_mounted` goes by `hosted_for_key`, which matches every runtime in the routing map, the shared terminal-only tenant included, whose root is the home directory. A registered workspace at the home directory therefore reads mounted through that query whenever the terminal tenant is up, whether or not its own runtime is. The query's callers are the window feed, the devserver list and the health probe.

## Desired contract

A query that asks whether a workspace is mounted counts only runtimes holding a workspace; the terminal-only tenant is never a mounted workspace.

## What to do

Give `is_canonical_root_mounted` a workspace-only filter, or route the three callers through a query that has one, and pin each caller with the terminal tenant up beside a registered home workspace (the window feed's row, the devserver list's state, the probe's subject). Small.

## Boundaries

`crates/chan-library/src/host.rs` (`is_canonical_root_mounted`, `hosted_for_key`) and the three callers' tests.

## What shipped

Landed on 2026-09-27 with [the-terminal-tenant-answers-for-a-home-workspace](the-terminal-tenant-answers-for-a-home-workspace.md), whose What shipped is the full record. What answers this item: `is_canonical_root_mounted` goes by `hosted_for_key`, which through `found_by` now finds only a runtime that holds a workspace, so the shared terminal tenant never reads as a mounted home workspace to the window feed's filter (`window_in_live_feed`), the health fold (`reconcile_root_health`), the starting mark or the devserver's list (`entry_from_record` in `crates/chan-server/src/devserver.rs`). Pinned with the terminal tenant up and the home registered and not mounted: in the library its window stays out of the live feed and is kept, a failed health check publishes nothing for it, and it reads stopped and can be marked starting; on the devserver its row lists stopped and off with no token. With the home mounted, the query answers true beside the terminal tenants and its windows resolve to its own tenant, pinned in the library only, since the devserver's tests do not mount the home directory.
