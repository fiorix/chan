# devserver-control

Singleton, database-free control plane for the devserver-proxy fleet. Owns the dynamic proxy directory, the aggregate tunnel and tenant-session views, signed per-user admission limits and command routing. Every devserver-proxy node holds one authenticated h2c control session to it on a dedicated listener; identity, profile and the admin CLI read one coherent fleet view from its `/admin/v1/*` tree. No SPA, no database, no tenant traffic: the controller carries metadata and commands only.

## Role in the system

devserver-proxy keeps its registrations in a process-local registry, so with more than one node nothing in the fleet can answer who holds a tunnel or how many devservers a user runs. devserver-control is that answer. Each proxy publishes a full registry snapshot plus deltas over its control session, asks the controller for an admission decision before acknowledging any tunnel registration, and executes the controller's kill commands. Consumers point `DEVSERVER_ADMIN_URL` at this service and always see either one coherent fleet view or an explicit upstream failure, never a partial process snapshot. The split and its failure semantics are decided in [ADR-0002](../../docs/adr/0002-control-plane-owns-proxy-fleet-state.md) and described in [`design.md`](design.md).

## Build

```bash
cargo build -p devserver-control
```

The binary is `devserver-control-service`. No frontend.

## Dev run

```bash
export BIND_ADDR=127.0.0.1:7003
export PROXY_BIND_ADDR=127.0.0.1:7101
export DEVSERVER_OPERATOR_ADMIN_TOKENS=operator-token-32-bytes-minimum-000
export DEVSERVER_IDENTITY_ADMIN_TOKENS=identity-token-32-bytes-minimum-000
export DEVSERVER_PROFILE_ADMIN_TOKENS=profile-token-32-bytes-minimum-0000
export DEVSERVER_PROXY_CREDENTIALS='p1=proxy-token-32-bytes-minimum-000000'
readarray -t admission_keys < <(python3 packaging/gateway/scripts/generate-admission-keypair.py)
export DEVSERVER_ADMISSION_VERIFYING_KEYS="${admission_keys[1]}"
export DEVSERVER_PROXY_BASE_URL_TEMPLATE='https://{proxy_id}.devserver.localtest.me:7002'
cargo run -p devserver-control
```

For the full local stack, prefer `packaging/gateway/scripts/dev/setup.sh` plus `packaging/gateway/scripts/dev/run.sh`. Two listeners come up:

- `BIND_ADDR` (7003): admin HTTP. `/healthz` and `/readyz` are unauthenticated; `/admin/v1/*` is bearer-gated by route-scoped operator, identity and profile credentials.
- `PROXY_BIND_ADDR` (7101): h2c. Each devserver-proxy node dials `POST /v1/proxies/connect` with its proxy-id-scoped credential and holds the stream for the life of its control session.

Both listeners must be loopback unless the deployment sets `CHAN_GATEWAY_INTERNAL_TRANSPORT=protected-overlay`, an assertion that the surrounding network provides confidentiality and peer isolation for these cleartext listeners.

The template must expand each proxy's `DEVSERVER_PROXY_ID` to exactly that node's `DEVSERVER_PROXY_BASE_URL`; a mismatch closes the control session at the handshake. With the values above, a proxy runs with `DEVSERVER_PROXY_ID=p1` and `DEVSERVER_PROXY_BASE_URL=https://p1.devserver.localtest.me:7002`.

## Env vars

Required:

| Name                                 | Notes                                       |
|--------------------------------------|---------------------------------------------|
| `DEVSERVER_OPERATOR_ADMIN_TOKENS`    | one or two rotating full-access bearers     |
| `DEVSERVER_IDENTITY_ADMIN_TOKENS`    | one or two rotating identity-scoped bearers |
| `DEVSERVER_PROFILE_ADMIN_TOKENS`     | one or two rotating profile-scoped bearers  |
| `DEVSERVER_PROXY_CREDENTIALS`        | `proxy_id=token` allowlist; up to two per id|
| `DEVSERVER_ADMISSION_VERIFYING_KEYS` | one or two rotating Ed25519 public keys     |
| `DEVSERVER_PROXY_BASE_URL_TEMPLATE`  | one `{proxy_id}` origin template            |

Optional:

| Name                              | Default          | Purpose                         |
|-----------------------------------|------------------|---------------------------------|
| `BIND_ADDR`                       | `127.0.0.1:7003` | admin listener                  |
| `PROXY_BIND_ADDR`                 | `127.0.0.1:7101` | proxy control listener (h2c)    |
| `MAX_DEVSERVERS_PER_USER`         | `100`            | fleet-wide per-owner ceiling    |
| `CHAN_GATEWAY_INTERNAL_TRANSPORT` | unset            | overlay assertion               |
| `RUST_LOG`                        | `info`           | tracing filter                  |

Every credential is visible ASCII within a bounded length, and credentials may not be reused across proxy ids or admin scopes. Rotation accepts at most two values per authority. `CHAN_GATEWAY_INTERNAL_TRANSPORT` takes exactly `protected-overlay` and only behind an authenticated, encrypted overlay.

## Routes

Admin listener (`BIND_ADDR`); all `/admin/v1/*` routes bearer-gated and scope-checked:

| Method | Path                                                    | Purpose                   |
|--------|---------------------------------------------------------|---------------------------|
| GET    | `/healthz`                                              | liveness; no auth         |
| GET    | `/readyz`                                               | unavailable while warming |
| GET    | `/admin/v1/tunnels`                                     | aggregate tunnels         |
| GET    | `/admin/v1/tunnels/watch`                               | SSE snapshot stream       |
| POST   | `/admin/v1/tunnels/kill-all`                            | fleet-wide tunnel drain   |
| POST   | `/admin/v1/tunnels/{owner_user_id}/{devserver_id}/kill` | exact kill                |
| GET    | `/admin/v1/owners/{owner_user_id}/tunnels`              | one owner's rows          |
| POST   | `/admin/v1/owners/{owner_user_id}/tunnels/kill`         | owner-wide kill           |
| POST   | `/admin/v1/sessions/revoke`                             | scoped revocation variants|
| GET    | `/admin/v1/proxies`                                     | proxy directory           |
| GET    | `/admin/v1/proxies/watch`                               | SSE proxy stream          |
| GET    | `/admin/v1/browser-sessions`                            | tenant-session inventory  |
| GET    | `/admin/v1/browser-sessions/watch`                      | tenant-session SSE stream |
| POST   | `/admin/v1/browser-sessions/{id}/revoke`                | revoke one admin id       |
| POST   | `/admin/v1/browser-sessions/subjects/{id}/revoke`       | revoke by caller          |
| POST   | `/admin/v1/browser-sessions/owners/{id}/revoke`         | revoke by devserver owner |
| POST   | `/admin/v1/browser-sessions/revoke-all`                 | fleet-wide session drain  |
| GET    | `/admin/v1/overview`                                    | bounded fleet aggregates  |

Proxy listener (`PROXY_BIND_ADDR`):

| Method | Path                  | Purpose                          |
|--------|-----------------------|----------------------------------|
| POST   | `/v1/proxies/connect` | raw h2c control stream per proxy |

Aggregate reads fail closed until the controller is ready (a convergence window plus reconciliation). Kills route by registration id to the owning proxy only. Session revocation answers a partial failure unless every connected proxy confirms the drain and no retained disconnected authority is unreachable. Operator credentials can use every route; identity credentials can use owner, exact and fleet drain mutations; profile credentials keep exact and subject revocation plus their tunnel reads and kills, and request-body authorization prevents a profile token from selecting identity-only revocation variants.

## Design rationale

See [`design.md`](design.md).
