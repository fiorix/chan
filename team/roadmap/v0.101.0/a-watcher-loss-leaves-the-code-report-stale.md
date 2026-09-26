# A watcher loss leaves the code report stale for the rest of the session

Status: accepted for v0.101.0 by the owner on 2026-09-25; raised during v0.101.0 on 2026-09-25 by the reading lane over the side-effect and error-handling lows (review line 3248 of the development ledger `dev/rust-review-lows.md`). A source reading against `main` at `f063ddd45`.

## Owner ruling

Accepted on 2026-09-25 as the lead recommended, in the lane for small server and CLI fixes with [a-corrupt-devserver-config-re-mints-the-library-identity](a-corrupt-devserver-config-re-mints-the-library-identity.md), [the-detached-daemon-keeps-the-launching-shells-directory](the-detached-daemon-keeps-the-launching-shells-directory.md), [a-scripted-reports-disable-exits-zero-having-changed-nothing](a-scripted-reports-disable-exits-zero-having-changed-nothing.md) and [a-keychain-failure-freezes-a-connected-gateways-roster](a-keychain-failure-freezes-a-connected-gateways-roster.md).

## What was seen

`ReportState::on_event` returns on `WatchKind::ProviderError` and leaves the rescan to "a future explicit Workspace::rebuild_report()" (`crates/chan-workspace/src/report.rs:169-176`), a function that does not exist anywhere in the tree. The persisted-report refresh becomes Owed only when a workspace opens with a report file present (`crates/chan-workspace/src/workspace.rs:1157`, `:1203-1204`), and a watcher loss never sets it (the test near `crates/chan-workspace/src/indexer.rs:536` pins that a loss neither clears nor adds it). After an inotify overflow or an FSEvents drop, the graph indexer reconciles but the report keeps its rows from before the loss until the next open. The language graph and the graph's report buckets (`crates/chan-server/src/routes/graph.rs:1233-1245`, `:1393-1397`) then show files that are gone and miss files that were added.

## What to do

Have a ProviderError schedule the report rescan on the recovery pass the loss already requests, for example by marking the persisted-report refresh Owed, so it runs through the existing `replace_policy` path under `write_serial`. Red first: create a file behind the watcher's back and apply `WatchEvent::loss`. Today `report()` does not list the file; after the fix it does once the pass completes.

## Boundaries

`crates/chan-workspace/src/report.rs` and the persisted-report refresh state in `workspace.rs` only; do not change the graph indexer's reconcile or the recovery coordinator's generation rules. In v0.101.0 `workspace.rs` and `indexer.rs` belong to the workspace lane, so raise this after that lane lands or inside it.
