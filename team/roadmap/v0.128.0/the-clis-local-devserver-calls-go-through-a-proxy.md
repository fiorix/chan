# The CLI's local devserver calls go through a proxy

Status: raised on 2026-11-09 by the review of v0.127.0's live-metrics fixes, which found that an HTTP client built from the environment sends a request for `127.0.0.1` to `http_proxy`, and fixed it for `chan metrics` alone, as the owner ruled; accepted by the owner for v0.128.0 the same day. Not started.

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
