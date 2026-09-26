# A corrupt devserver config silently re-mints the library identity

Status: accepted for v0.101.0 by the owner on 2026-09-25; raised during v0.101.0 on 2026-09-25 by the reading lane over the side-effect and error-handling lows (review line 4425 of the development ledger `dev/rust-review-lows.md`). A source reading against `main` at `f063ddd45`.

## Owner ruling

Accepted on 2026-09-25 as the lead recommended, in the lane for small server and CLI fixes with [a-watcher-loss-leaves-the-code-report-stale](a-watcher-loss-leaves-the-code-report-stale.md), [the-detached-daemon-keeps-the-launching-shells-directory](the-detached-daemon-keeps-the-launching-shells-directory.md), [a-scripted-reports-disable-exits-zero-having-changed-nothing](a-scripted-reports-disable-exits-zero-having-changed-nothing.md) and [a-keychain-failure-freezes-a-connected-gateways-roster](a-keychain-failure-freezes-a-connected-gateways-roster.md).

## What was seen

`DevserverStore::load` (`crates/chan-server/src/devserver.rs:176-181`) turns any read error and any JSON parse error of the devserver `config.json` into `PersistedConfig::default()` without a log line. `run_devserver` then mints a fresh `library_id` (`devserver.rs:1766-1768`), which derives the control-socket identity (`:1793`) and the fd parker (`:1801`). The systemd restore then discards every parked terminal session as "manifest library id does not match this devserver" (`crates/chan-server/src/devserver/fdstore.rs:637-644`, printed at `:690-695`), so the operator sees an id mismatch rather than the unreadable config. The next `persist_state` writes the new identity over the old file (`devserver.rs:1305-1312`), which removes the evidence.

## What to do

Tell a missing file apart from an unreadable or unparseable one. Log the latter at warn with the path and the error, and set the file aside (for example `config.json.unreadable-<unix>`) before any save replaces it. Red first: write garbage to the store path, then assert that `load` still yields defaults, that a warn line names the path (a hand-rolled test subscriber avoids a Cargo.lock edge), and that the original bytes survive the first save.

## Boundaries

Do not change token rotation (`resolve_boot_token`) or the fdstore library-id check. `persisted_devserver_token` and `persisted_devserver_port` (`devserver.rs:261-295`) share `load` and keep answering None on an unreadable file. `crates/chan-server/src/devserver/` belongs to the v0.101.0 terminal replay lane; `devserver.rs` itself is outside that list, but `fdstore.rs` is its neighbour, so coordinate.
