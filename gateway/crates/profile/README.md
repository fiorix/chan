# profile-service

Internal HTTP API in front of Postgres. Owns the canonical user record, linked OAuth identities, devservers and sharing grants, feature flags, durable per-user and fleet devserver policy, and the authentication audit log; serves the admin views over `api_tokens`. Called only by identity-service and the operator CLI; not exposed publicly.

This README is the operator and consumer contract: how to run the service, its configuration and its HTTP surface. Boundaries, invariants and rationale live in [`design.md`](design.md).

## Role in the system

profile-service is the single source of truth for who a user is. Sessions live in identity-service, which also writes the shared `api_tokens` table directly for PAT mint and validate. Cookie minting, page rendering and OAuth state are someone else's problem; profile owns the rows and the durable revocation outbox that keeps the fleet in step with them.

## Build

```bash
cargo build -p profile
```

## Dev run

```bash
createdb chan_gateway
export DATABASE_URL=postgres://localhost/chan_gateway
CHAN_GATEWAY_MIGRATIONS=only cargo run -p profile   # apply schema, then exit
export CHAN_GATEWAY_MIGRATIONS=external
export BIND_ADDR=127.0.0.1:7001
export PROFILE_AUTH_TOKEN=dev-service-token
export PROFILE_ADMIN_TOKEN=dev-admin-token   # optional; gates /v1/admin/*
export DEVSERVER_ADMIN_URL=http://127.0.0.1:7003
export DEVSERVER_PROFILE_ADMIN_TOKEN=dev-profile-control-token
cargo run -p profile
```

profile-service never migrates the schema at serve time. `CHAN_GATEWAY_MIGRATIONS` is required and accepts exactly `only` (apply the sqlx migrations under `gateway/migrations/` and exit) or `external` (serve, never touch DDL).

## Packaged run

`packaging/chan-gateway-profile.service` is a hardened `Type=simple` unit that reads `/etc/chan-gateway/profile.env` and declares `Requires=chan-gateway-migrate.service`: the migrate oneshot applies the schema with the database-owner credential, then the service starts in mode `external` under a non-DDL application role. The kube deployment follows the same split with a migrate job.

## Env vars

| Name                            | Required | Notes                           |
|---------------------------------|----------|---------------------------------|
| `CHAN_GATEWAY_MIGRATIONS`       | yes      | exactly `only` or `external`    |
| `DATABASE_URL`                  | yes      | Postgres connection string      |
| `BIND_ADDR`                     | no       | default `127.0.0.1:7001`        |
| `PROFILE_AUTH_TOKEN`            | yes      | service-tier bearer (`/v1/*`)   |
| `PROFILE_ADMIN_TOKEN`           | no       | admin bearer (`/v1/admin/*`)    |
| `DEVSERVER_ADMIN_URL`           | yes      | devserver-control admin base    |
| `DEVSERVER_PROFILE_ADMIN_TOKEN` | yes      | profile-scoped control token    |
| `DEVSERVER_RETENTION_MINUTES`   | no       | sweeper retention; `0` disables |
| `WIREGUARD_POOL_V4`            | no       | IPv4 CIDR; enables enrollment  |
| `WIREGUARD_POOL_V6`            | no       | optional IPv6 CIDR             |
| `WIREGUARD_POOL_RESERVED`      | no       | comma-separated excluded IPs   |
| `WIREGUARD_RELEASE_GRACE_MINUTES` | no    | denial-to-release delay; 5 min |
| `RUST_LOG`                      | no       | tracing filter, default info    |

A missing or empty `PROFILE_ADMIN_TOKEN` makes every `/v1/admin/*` route answer unauthorized; that is the safe default for a fresh deploy. `DEVSERVER_RETENTION_MINUTES` drives the devserver registry sweeper; unset means the built-in default and an unparseable value fails startup.

WireGuard enrollment requires `WIREGUARD_POOL_V4`; without it enrollment answers 503. The IPv6 pool and reserved list require that IPv4 pool. The pools are the gateway's: a peer gets one address set, unique across the gateway and valid on every ingress host. Pools exclude their network and first host address, plus the last IPv4 address and explicit reservations. The address the ingress interfaces answer on inside the tunnel must stay outside allocation: the first host address already is, and any other goes in `WIREGUARD_POOL_RESERVED`; profile does not know identity's ingress configuration and cannot check it. The release grace is a nonnegative whole number of minutes; `0` releases denied peers on the next sweep. Disabling devserver retention does not disable peer release.

## Routes

All routes are bearer-gated. The service-tier middleware accepts either the regular or the admin token, so single-token deployments can set `PROFILE_ADMIN_TOKEN = PROFILE_AUTH_TOKEN`.

Service API (`/v1/users/*`, `/v1/auth-audit`, `/v1/wireguard/peers`):

| Method | Path                                      | Purpose                          |
|--------|-------------------------------------------|----------------------------------|
| POST   | `/v1/users`                               | create user                      |
| GET    | `/v1/users/{id}`                          | fetch one user                   |
| PATCH  | `/v1/users/{id}`                          | update mutable fields            |
| DELETE | `/v1/users/{id}`                          | durable account-delete denial    |
| POST   | `/v1/users/{id}/pending-delete`           | durable account-delete denial    |
| POST   | `/v1/users/{id}/tokens/{token_id}/revoke` | owned PAT revoke + session cut   |
| PATCH  | `/v1/users/{id}/username`                 | rename handle (capped)           |
| GET    | `/v1/users/by-identity`                   | lookup by (provider, subject)    |
| GET    | `/v1/users/by-username`                   | case-insensitive handle lookup   |
| POST   | `/v1/users/upsert-by-identity`            | atomic find-or-create-or-link    |
| POST   | `/v1/users/{id}/identities`               | attach OAuth identity            |
| GET    | `/v1/users/{o}/devservers`                | list owner's devservers          |
| POST   | `/v1/users/{o}/devservers`                | create devserver (idempotent)    |
| DELETE | `/v1/users/{o}/devservers/{d}`            | delete devserver (cascades)      |
| POST   | `/v1/users/{o}/devservers/{d}/grants`     | upsert devserver grant           |
| GET    | `/v1/users/{o}/devservers/{d}/grants`     | list grants on a devserver       |
| GET    | `/v1/users/{o}/devservers/{d}/access`     | access check, `?as=<user_id>`    |
| DELETE | `/v1/users/{o}/grants/{id}`               | revoke a grant (owner-scoped)    |
| GET    | `/v1/users/{id}/grants/owned`             | devservers this user shares      |
| GET    | `/v1/users/{id}/grants/incoming`          | devservers shared with this user |
| POST   | `/v1/users/{id}/grants/claim`             | claim pending grants by email    |
| GET    | `/v1/users/{id}/flags`                    | resolved flags for one user      |
| POST   | `/v1/auth-audit`                          | append an auth event             |
| POST   | `/v1/users/{id}/wireguard/peers`           | enroll key or replace its PAT    |
| GET    | `/v1/wireguard/peers?host=p1`              | every active peer; ETag and 304   |

Enrollment takes `{token_id, public_key}` and an optional `host`. Keys are padded standard base64 encoding exactly 32 bytes. A key has one peer across the gateway: a new key returns 201 with `{id, user_id, token_id, public_key, addresses, created_at, updated_at}`; addresses use `/32` and optional `/128` host prefixes. The same user's key moves to the supplied token, preserves its addresses and returns 200. Another user's key or an exhausted pool returns 409; an unknown or differently owned token returns 404. Enrollment and release append `wireguard_enrolled` and `wireguard_released` to the token audit.

`host` in the enroll body selects nothing. When present it must be a single lowercase DNS label, and the answer echoes it as `host`; when absent the answer carries no `host`. It exists for an identity one release behind, which names its ingress host and requires the field in the answer.

The active list returns `{host, peers: [{public_key, allowed_ips}]}`, sorted by public key. `?host=` is required and must be a single lowercase DNS label; it filters nothing and is echoed as `host`, which an agent checks against its own id. Every label reads every active peer: profile does not know which labels are ingress hosts. Revocation, expiry and user block remove a peer from this response immediately, for every host at once. `ETag` is the quoted hex SHA-256 of the response bytes, which include the echoed host, so each host id has its own validator; a matching `If-None-Match` returns 304 without a body. Denied peers keep their addresses until the sweeper releases them after the configured grace.

Admin API (`/v1/admin/*`):

| Method | Path                                        | Purpose                        |
|--------|---------------------------------------------|--------------------------------|
| GET    | `/v1/admin/users`                           | list, with filters             |
| POST   | `/v1/admin/users/{id}/block`                | block + revoke PATs            |
| POST   | `/v1/admin/users/{id}/unblock`              | clear block                    |
| POST   | `/v1/admin/users/{id}/email`                | rewrite email (audited)        |
| POST   | `/v1/admin/users/{id}/access/revoke`        | revoke all PAT access          |
| GET    | `/v1/admin/users/{id}/devserver-policy`     | read durable user policy       |
| PUT    | `/v1/admin/users/{id}/devserver-policy`     | idempotent user-policy upsert  |
| GET    | `/v1/admin/users/{id}/auth-audit`           | per-user audit log             |
| GET    | `/v1/admin/users/{id}/tokens`               | list user's PATs               |
| POST   | `/v1/admin/tokens/{id}/revoke`              | revoke a PAT                   |
| GET    | `/v1/admin/tokens/{id}/audit`               | per-token audit log            |
| GET    | `/v1/admin/devserver-policy`                | read fleet admissions state    |
| PUT    | `/v1/admin/devserver-policy`                | pause/resume fleet admissions  |
| GET    | `/v1/admin/auth-audit`                      | filtered global auth history   |
| GET    | `/v1/admin/overview`                        | bounded user/login aggregates  |
| GET    | `/v1/admin/flags`                           | list flags + override count    |
| POST   | `/v1/admin/flags`                           | create / update a flag         |
| DELETE | `/v1/admin/flags/{key}`                     | drop flag (cascades overrides) |
| GET    | `/v1/admin/flags/{key}/overrides`           | per-user overrides on a flag   |
| POST   | `/v1/admin/flags/{key}/overrides`           | upsert per-user override       |
| DELETE | `/v1/admin/flags/{key}/overrides/{user_id}` | clear per-user override        |

Plus `GET /healthz` (no auth).

Block, pending delete, PAT revoke and claimed-grant delete each reserve a durable revocation job in the same transaction as the state change, answer accepted, and let the background worker confirm the fleet cut through devserver-control with retries that survive restarts. `POST /v1/admin/users/{id}/access/revoke` only revokes PATs and writes the audit row; identity's composite admin route performs the live cuts. Policy routes only persist state; identity owns the drain that follows a stricter user policy or a fleet pause.

Identity supplies the peer's public key and newly minted token id after browser consent. The private key and PAT secret never enter enrollment storage. Agents read the active set through identity's internal relay; they hold no profile bearer.

## Design rationale

See [`design.md`](design.md).
