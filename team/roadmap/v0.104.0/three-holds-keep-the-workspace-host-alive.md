# Three holds keep the workspace host alive past its last owner

Status: accepted for v0.104.0 by the owner's word of 2026-10-08; three separate changes with separate risks, each designed with its intended failing test and reviewed before code, the second of them changing what a devserver stop executes.

## What was seen

Three strong handles on the workspace host, each read at source in the v0103 round and recorded in the v0.103.0 report's Follow-ups, keep the host from dropping with its last owner. Line numbers are at `910811335`, read by the runtime seat on 2026-10-08. First, the launcher router's strong handle: `admitting_launcher_router` in `crates/chan-server/src/routes/library.rs` (line 186) hands the host as axum state to the windows router (303) and places it in `LauncherState` (59), `WindowFeed` (87) and `LibraryCommandState` (133), and the surface-bearer middleware captures it (386; `require_surface_bearer` at 554); the report counts six state structs and twenty handlers, a count the design checks against the file; a weak handle there is the complete form of the cycle v0.103.0's second candidate broke at the fallback's installation instead. Second, the registry reload watcher: `run_devserver` leaks it on purpose (`crates/chan-server/src/devserver.rs` lines 3203 to 3208, `Box::leak`) with the host in its callback (`start_registry_reload_watcher` at 3497 moves `Arc<WorkspaceHost>` into the notify callback at 3512); three lines make it weak, after which a devserver's stop would run the host's drop for the first time, joining its bulk-transfer lane's two workers inline as a standalone serve's stop does (`BulkTransferLane::drop`, `crates/chan-library/src/bulk_transfer.rs` 528 to 547). Third, the fd parker's shared state: `ParkerShared.host` is strong (`crates/chan-server/src/devserver/fdstore.rs` 209, set at 503) and the host stores the hook that holds that shared state (524; `crates/chan-library/src/host.rs` 576), a ring also held by `DevserverParker`, the debounced writer task and each manifest thread; the weak-host form could run the host's drop on the manifest writer thread under the parker's phase lock, so the hook-weak form is the one to take; the v0103 census counted seventeen of the test binary's lanes.

## Desired contract

The host drops with its last owner: a devserver's stop runs the host's drop on a thread that may block, joining what it joins, and no router state, watcher callback or parker hook holds the host past that stop; a standalone serve's stop is unchanged.

## What to do

One design for the three changes before any code, to the reviewer: for each, the change, its risk, the intended failing test and why that test can fail on the behavior rather than on a missing symbol. For the reload watcher, what the host's drop joins and on which thread it runs after the change, and what a devserver stop then executes that it does not today. For the fd parker, the hook-weak form unless a new reading at source says otherwise, with the answer to what an unpark after the parker's end does. For the launcher router, the weak-handle form, with the counts checked against the file. Measure the test binary's live threads before and after, by the v0103 round's census (a one-test process held open at exit, `/proc` task names sampled per thread). Build the three as separate commits, each red first, each with the whole crate suite, fmt and clippy at its commit.

## Boundaries

`crates/chan-server/src/routes/library.rs`, `crates/chan-server/src/devserver.rs`, `crates/chan-server/src/devserver/fdstore.rs`, `crates/chan-library/src/host.rs` and their tests; the devserver's design document where it describes the host's lifetime. Not this item's: a real stop's client contract (a stated cost), and the desktop side of [native-windows-across-a-devserver-restart-the-open-half](native-windows-across-a-devserver-restart-the-open-half.md).

## Acceptance

1. The design reviewed before code, with the three risks, the three failing tests and the thread the host's drop runs on named.
2. Each hold removed in its own commit, its pin red first on the behavior (a host dropped when its last owner goes, or a stop that joins what the design says) and green after; no shared state outlives the stop.
3. A devserver stop with the watcher made weak shown to run the host's drop and to return, with the join's thread and duration recorded; a standalone serve's stop unchanged.
4. The thread census before and after at one named commit each, with the lanes counted; no new lane and no thread left past the stop.
5. fmt, clippy and the whole `chan-server` and `chan-library` suites green at each commit, in the owning guest, with the job and thread caps recorded.
