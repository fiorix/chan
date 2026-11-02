# devserver-proxy

Public-facing service at `{proxy}.proxy.{domain}` (node apex) and `*.{proxy}.proxy.{domain}` (wildcard). Reverse-proxies HTTP and WebSocket traffic into a user's running `chan devserver` instances. Embeds `chan-tunnel-server` to terminate registrations from those instances on a separate h2c listener; every registration is admitted by devserver-control before the client sees `HelloAck::Ok`. No SPA, no database; browser sessions and entry replay state are bounded in-memory state.

## Role in the system

devserver-proxy is where a devserver is served in the browser. It does not read identity's session cookie. identity mints a short-lived Ed25519 entry credential that reaches `POST /_chan/entry` in a request body; the proxy verifies it (signature, issuer, exact audience, proxy id, devserver id, signed clean path), consumes its replay id, and mints the bounded opaque host-only `__Host-devserver_gate` cookie. Authenticated traffic then reaches the exact `chan devserver` peer through its live yamux tunnel. No entry credential appears in a navigation URL. Boundaries, the gate order, the session model and the hygiene rules are in [`design.md`](design.md).

## Build

```bash
cargo build -p devserver-proxy
```

No frontend: devserver-proxy ships no SPA.

## Dev run

```bash
export BIND_ADDR=127.0.0.1:7002
export TUNNEL_BIND_ADDR=127.0.0.1:7100
export IDENTITY_URL=http://127.0.0.1:7004
export IDENTITY_INTERNAL_TOKEN=dev-internal-token
export DEVSERVER_ENTRY_VERIFYING_KEYS=<base64-ed25519-public-key>
export DEVSERVER_ADMISSION_VERIFYING_KEYS=<base64-ed25519-public-key>
export IDENTITY_PUBLIC_ORIGIN=http://127.0.0.1:7000
export DASHBOARD_URL=http://127.0.0.1:7000/workspaces
export DEVSERVER_CONTROL_URL=http://127.0.0.1:7101
export DEVSERVER_PROXY_TOKEN=dev-proxy-token
export DEVSERVER_PROXY_ID=p1
export DEVSERVER_PROXY_BASE_URL=https://p1.devserver.localtest.me:7002
export DEVSERVER_TUNNEL_ORIGIN=https://p1.devserver.localtest.me:7100
cargo run -p devserver-proxy
```

The recorded public origins use `https` because the config refuses a cleartext public origin whose host is not a loopback literal; the listeners themselves stay loopback cleartext in dev. For the full local stack (identity, profile, control, Postgres), prefer `packaging/gateway/scripts/dev/setup.sh` plus `packaging/gateway/scripts/dev/run.sh`. Two listeners come up:

- `BIND_ADDR` (7002): public HTTP. `proxy.{domain}` sits behind a TLS edge in production; loopback in dev.
- `TUNNEL_BIND_ADDR` (7100): h2c. The edge forwards `proxy.{domain}/v1/tunnel` here as h2c (nginx `grpc_pass`); `chan devserver` instances dial it for the handshake. A tunnel is one long-lived `POST`, so that edge location needs idle timeouts that fit a tunnel; [`gateway/docs/dev-setup.md`](../../docs/dev-setup.md) says which and why.

## Env vars

Required:

| Name                                 | Notes                                        |
|--------------------------------------|----------------------------------------------|
| `IDENTITY_INTERNAL_TOKEN`            | bearer presented on identity's validate      |
| `DEVSERVER_ENTRY_VERIFYING_KEYS`     | one or two Ed25519 entry public keys         |
| `DEVSERVER_ADMISSION_VERIFYING_KEYS` | one or two admission public keys             |
| `IDENTITY_PUBLIC_ORIGIN`             | exact allowed Origin for entry exchange      |
| `DASHBOARD_URL`                      | sign-in redirect for the bare wildcard root  |
| `DEVSERVER_CONTROL_URL`              | h2c origin of the controller proxy listener  |
| `DEVSERVER_PROXY_TOKEN`              | bearer presented only to the controller      |
| `DEVSERVER_PROXY_ID`                 | provisioned node id; one lowercase DNS label |
| `DEVSERVER_PROXY_BASE_URL`           | exact public origin of this node's wildcard  |
| `DEVSERVER_TUNNEL_ORIGIN`            | public tunnel origin; gives the apex host    |

Optional:

| Name                              | Default                 | Purpose                  |
|-----------------------------------|-------------------------|--------------------------|
| `BIND_ADDR`                       | `127.0.0.1:7002`        | public listener          |
| `TUNNEL_BIND_ADDR`                | `127.0.0.1:7100`        | tunnel listener (h2c)    |
| `IDENTITY_URL`                    | `http://127.0.0.1:7000` | identity validate base   |
| `MAX_RESPONSE_BYTES`              | built in (`0` disables) | response body cap        |
| `MAX_REQUEST_BYTES`               | built in (`0` disables) | request body cap         |
| `REQUEST_TIMEOUT_SECS`            | built in (`0` disables) | end-to-end timeout       |
| `FORWARDED_PROTO`                 | `https`                 | `X-Forwarded-Proto`      |
| `SESSION_MAX_ACTIVE`              | built in                | process-wide session cap |
| `SESSION_LIFETIME_SECS`           | one hour (the maximum)  | opaque-session lifetime  |
| `ENTRY_REPLAY_MAX_ACTIVE`         | built in                | active entry-replay cap  |
| `CHAN_GATEWAY_INTERNAL_TRANSPORT` | unset                   | overlay assertion        |
| `RUST_LOG`                        | `info`                  | tracing filter           |

The packaged env file and the dev-run example point `IDENTITY_URL` at identity's separate internal listener (`7004`); the default above applies when the variable is unset. `CHAN_GATEWAY_INTERNAL_TRANSPORT` takes exactly `protected-overlay` and only behind an authenticated, encrypted overlay.

## Routes

- Apex (`{proxy}.proxy.{domain}`): `POST /v1/tunnel` (raw h2c, on the tunnel listener), `/healthz` and `/readyz`. Readiness is true only once the controller session reaches `FleetReady`; until then new tunnel admissions are refused with the `control_unavailable` code. Per-user devserver capacity is a fleet-wide decision the controller makes at admission and surfaces as `too_many_workspaces`. The aggregate `/admin/v1/*` tree lives on devserver-control, not on the proxy.
- Wildcard (`{owner}--{disc}.{proxy}.proxy.{domain}`, addressing one devserver by a prefix of its id): the per-devserver reverse proxy. `POST /_chan/entry` exchanges a body credential; ordinary paths require the opaque `__Host-devserver_gate` cookie and unsafe methods the `X-Chan-CSRF` mirror. On pass the full `/{workspace}/...` path is forwarded into the tunnel unchanged and the devserver routes the tenant. `/api/devserver/*` (the local-only management API) is not-found here.

Each opaque tenant session has a separate random admin UUID plus creation and expiry; the proxy publishes only that redacted record over the control protocol. Controller revocations support exact subject/owner/devserver, subject, admin UUID, owner and all sessions, and acknowledgement waits for matching HTTP and WebSocket transports to drain.

## Design rationale

See [`design.md`](design.md).
