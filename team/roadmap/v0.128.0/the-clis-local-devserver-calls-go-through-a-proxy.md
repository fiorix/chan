# The CLI's local devserver calls go through a proxy

Status: raised on 2026-11-09 by the review of v0.127.0's live-metrics fixes, which found that an HTTP client built from the environment sends a request for `127.0.0.1` to `http_proxy`, and fixed it for `chan metrics` alone, as the owner ruled; accepted by the owner for v0.128.0 the same day. Built on 2026-11-11 in two stages and merged into the release's integration branch; the section Built holds the evidence.

## What is there now

The CLI reaches the local devserver over loopback HTTP with clients built by `reqwest::Client::new()`. Those take their proxy from `http_proxy`, `HTTPS_PROXY` and `ALL_PROXY` (and, on macOS and Windows, from the system's proxy settings) with no exemption for loopback; only a `NO_PROXY` entry keeps a request direct. With a proxy set and no `NO_PROXY` entry for `127.0.0.1`:

- `chan ps` (`crates/chan/src/status.rs`, `devserver_activity`) sends the devserver's bearer to `/api/devserver/workspaces` and each workspace's own token to its `/api/index/status` and `/api/health`.
- `chan devserver stop --force` drains terminals with the bearer (`crates/chan/src/devserver/management.rs`, `drain_devserver_terminals_with_token`).
- `chan devserver rotate-token` sends the current bearer and reads the new one back in the response (`management.rs`, `rotate_devserver_token_at`), so the proxy sees both.
- The health probes (`crates/chan/src/devserver_daemon.rs`, `ready_record`; `crates/chan/src/devserver/watchdog.rs`, `run_health_watchdog`) carry no token but go to the proxy too, so a proxy that cannot reach the host's loopback would make a healthy devserver read as down.

Evidence: in the v0.127.0 review a recording proxy logged `GET http://127.0.0.1:<port>/api/metrics?history=false` with the bearer from `chan metrics`, whose client was built the same way before its fix (`be77bd32c`); the call sites above are read, not run, and the health-probe consequence is inferred from the reading.

The same calls dial the persisted devserver port, which outlives the devserver, and send the bearer to whatever listens there. In v0.127.0 `chan metrics` gained a Linux check that every listener on that address belongs to the caller's uid (`crates/chan/src/metrics/listener.rs`); the calls above have no such check.

The address they dial comes from the systemd unit file whenever one exists (`local_devserver_dial_addr`, `crates/chan/src/devserver/persisted.rs`), and `chan devserver stop` leaves the file. After a `start`, a `stop` and a `chan devserver run` on another port, the calls dial the unit's pinned port while the devserver listens on the port it recorded: `chan devserver rotate-token` gets no answer there, rewrites the persisted token alone and reports that no running devserver answered, while the one running keeps its old token (read from `crates/chan/src/devserver/management.rs`, not run). In v0.127.0 `chan metrics` on Linux tries the recorded port second, under its listener check; the other calls do not.

## Desired contract

1. Every CLI call to the local devserver, and every health probe of it, goes direct: never through a proxy taken from the environment or the system, whatever proxy settings are present. One shared constructor builds the local client, so a new call cannot forget it.
2. Every local call that carries the devserver's or a workspace's token first checks, where the platform can tell (Linux today), that every listener on the address belongs to the caller, sharing `chan metrics`' check, and refuses otherwise.
3. Calls to an explicit remote URL keep the user's proxy settings.
4. Every local call reaches the devserver that is running: where the unit's pinned address has no listener of the caller's, the recorded port is tried under the same check, as `chan metrics` does.

## Boundaries

- The CLI's calls to the local devserver and the devserver's own health probes. The desktop's and the gateway's HTTP clients are outside this item; if the reading finds one dialling loopback with a token, it gets its own row.
- No new authentication scheme. macOS, FreeBSD and Windows keep sending to the port unverified until a small, sound way to read a listener's owner exists there.

## Acceptance

1. With every proxy variable pointing at a recording listener and `NO_PROXY` cleared, `chan ps`, the terminal drain, `rotate-token` and both health probes reach a stand-in devserver directly and the recording listener sees nothing; a guard fails the suite if a local call builds its own client instead of the shared one.
2. On Linux, `chan ps`, the drain and `rotate-token` refuse a listener owned by another uid and send to the caller's own, with the socket table as a fixture.
3. In an isolated guest, `chan ps` against a running devserver with `http_proxy` pointed at a recording listener lists every workspace with its activity, and the listener records nothing.
4. After a `start`, a `stop` and a `chan devserver run` on another port, `chan ps` lists the running devserver's workspaces and `rotate-token` rotates the running devserver's token, with real listeners as the fixture.

## Built, 2026-11-11

One module, `crates/chan/src/http_client.rs`, builds the CLI's HTTP clients: `local_devserver` with proxy lookup off, redirects off and a bound the caller passes, used by `chan ps`'s activity read, the terminal drain, `rotate-token`, the daemon's readiness record, the health watchdog and the local `chan metrics`; `explicit_url` keeps the user's proxy for `chan metrics --url`, and the self-upgrade keeps its own remote client. A source guard test (`crates/chan/tests/http_client_guard.rs`) fails the suite when a raw reqwest client is built anywhere but those two modules (`5cfeef3c3`). A crate-level `local_listener::resolve` is shared by metrics, the activity read, the drain and `rotate-token`: the unit-pinned address first, then the recorded port when it differs, wildcard binds dialed on loopback, and on Linux every listener at the chosen address must belong to the caller, read from the socket tables just before the connect (the parser moved from metrics with its tests). A foreign listener or an unreadable table receives no bearer; `rotate-token` rewrites only the persisted file when no candidate has a listener at all, and leaves the file unchanged on a foreign listener or an unreadable table. The tokenless readiness and join probes keep the address their own backend selected. macOS, FreeBSD and Windows send to the first candidate unverified, as before (`56c64e20b`). The CLI design document and the manual's devserver page say so (merged as `b7f4ee627` and `b1adb39d8`).

Checks: the guard red naming the six raw clients and metrics' builder, then green; child-process tests with a recording proxy named by every proxy variable and `NO_PROXY` cleared, red at the base for the activity read, the drain, rotation and readiness (each reached the recorder) and green after, with the explicit-URL control reaching the recorder once and a redirect refused; mutations red for a call site put back on `Client::new`, the shared `no_proxy` removed, `no_proxy` added to the explicit constructor, and the redirect policy removed. Ownership and fallback tests with socket-table fixtures, red first (foreign listeners reached the stand-in; stale pinned addresses answered 503 or no activity) then green (9 and 3 tests), mutations red for the drain's resolver skipped and the recorded candidate dropped; fmt, clippy with warnings denied, 369 library tests. In an isolated guest: the whole chan suite green at both commits (500 then 511 passed, 0 failed, 1 ignored by design); acceptance 3, a proxied `chan ps` against a running devserver fills its row with the recorder at zero lines while the explicit-URL control records one line; acceptance 4, with a unit file pinning a port where nothing listens and a devserver running on the port it recorded, `chan ps` lists the workspace and `rotate-token` rotates the running devserver's token, naming its port, the old bearer refused with 401 and the new one accepted, and with the devserver stopped the offline rotation rewrites the file alone.

Found beside the work, not changed: the offline rotation's "listening on" line names the unit's pinned port where nothing listens (a CLI bullet for the open small findings row); the real `chan devserver start` and `stop` could not run in the guest's namespace (no user bus), so the unit file was written as `start` writes it.
