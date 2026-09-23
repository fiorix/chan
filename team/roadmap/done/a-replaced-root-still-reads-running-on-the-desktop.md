# A replaced root still reads running on the desktop

Status: shipped in [v0.100.0](../../release/release-v0.100.0.md): The root health probe is one function both embedders start, so the desktop reads a gone or replaced root as `unavailable` within one probe period and clears it when the directory returns.

## What was seen

V0.99.0 made a mounted workspace whose root is gone or replaced report `unavailable` on the launcher routes, in `chan ps` and in `chan workspace status`. The probe that discovers it, `WorkspaceHost::probe_mounted_roots` (`crates/chan-library/src/host.rs`), is called from exactly one production site, the devserver's run loop (`crates/chan-server/src/devserver.rs`). The desktop builds its own embedded `chan_server::WorkspaceHost` (`desktop/src-tauri/src/embedded.rs`) and never calls it, so on the desktop's local library a replaced root keeps reading `running` until a redundant add or on, and a row that went `unavailable` during a transient outage stays unavailable, with window minting refused, until another add, on, or off and on.

## Desired contract

Wherever the launcher routes are served, a mounted root's health is probed on the same cadence, so `unavailable` appears without an operator verb and clears when the root comes back.

## Boundaries

`desktop/src-tauri/src/embedded.rs` and the desktop's tick or watcher that would drive the probe, `crates/chan-library/src/host.rs` (`probe_mounted_roots`, `reconcile_root_health`), and `crates/chan-server/src/devserver.rs` for the existing cadence. The wire shape and the two SPA classifiers landed in v0.99.0 and do not change.

## Acceptance

1. A test over the embedded desktop host shows a replaced root reporting `unavailable` within one probe period, with no add or on.
2. The same test shows the row returning to `running` once the original root is back, on Linux.
3. The devserver path's behaviour and cadence are unchanged, pinned.
4. The documents that describe where the probe runs say so.

## What the third check pins

The cadence is pinned: `the_root_health_probe_keeps_its_fifteen_second_cadence` asserts `ROOT_HEALTH_PROBE_INTERVAL` against a written-out fifteen seconds, so moving it is a deliberate edit to that assertion. The devserver's behaviour is unchanged by reading rather than by a test. The probe loop moved verbatim into `spawn_root_health_probe`, and the devserver still calls it at startup, but no test fails if that call is removed. The devserver wiring is therefore verified by reading and left unpinned; a devserver-level integration test that would pin it is outside this item.

The desktop test names the root in the registry's canonical spelling when it checks the degraded row's reason, for the same macOS `/var` symlink reason recorded in the timed-out-mount item: the reason carries the canonical root, and a raw temp path matched it on macOS only as a substring.
