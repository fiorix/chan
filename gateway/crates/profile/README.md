# profile-service

Internal HTTP API in front of Postgres. Owns the canonical user record, linked OAuth identities, devservers + sharing grants, feature flags, durable per-user and fleet devserver policy, and the authentication audit log; serves the admin views over `api_tokens`. Called only by `identity-service` and the operator CLI; not exposed publicly.

This README is the operator and consumer contract: how to run the service, its configuration, and its HTTP surface. Component boundaries, invariants, and rationale live in [`design.md`](design.md).

## Role in the system

profile-service is the single source of truth for "who is this user." Sessions live elsewhere (identity-service holds the only `tower_sessions` table), and PAT mint / validate is identity-service writing the shared `api_tokens` table directly. Cookie minting, profile-page rendering, and OAuth state are all someone else's problem; profile owns the rows.

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

profile-service never migrates the schema at serve time. `CHAN_GATEWAY_MIGRATIONS` is required and accepts exactly two values: `only` applies the sqlx migrations under `gateway/migrations/` and exits, `external` serves and never touches DDL. An unset or otherwise shaped value fails startup.

## Packaged run

`packaging/chan-gateway-profile.service` is a hardened `Type=simple` unit that reads `/etc/chan-gateway/profile.env` and declares `Requires=chan-gateway-migrate.service`: the migrate oneshot applies the schema with the database-owner credential (mode `only`), then the service starts in mode `external` under a non-DDL application role. The kube deployment follows the same split with a migrate job.

## Env vars

| Name                          | Required | Notes                         |
|-------------------------------|----------|-------------------------------|
| `CHAN_GATEWAY_MIGRATIONS`     | yes      | exactly `only` or `external`  |
| `DATABASE_URL`                | yes      | Postgres connection string    |
| `BIND_ADDR`                   | no       | default `127.0.0.1:7001`      |
| `PROFILE_AUTH_TOKEN`          | yes      | service-tier bearer (`/v1/*`) |
| `PROFILE_ADMIN_TOKEN`         | no       | admin bearer (`/v1/admin/*`)  |
| `DEVSERVER_ADMIN_URL`         | yes      | devserver-control admin base  |
| `DEVSERVER_PROFILE_ADMIN_TOKEN` | yes    | profile-scoped control token  |
| `DEVSERVER_RETENTION_MINUTES` | no       | unset = 15, `0` disables      |
| `RUST_LOG`                    | no       | tracing filter, default info  |

A missing or empty `PROFILE_ADMIN_TOKEN` makes every `/v1/admin/*` route return 401; that is the safe default for a fresh deploy. Block, pending-delete, PAT revocation, and claimed-grant deletion each reserve a durable revocation job in the same transaction as the state change; the background worker confirms the fleet cut through devserver-control with retries that survive service restarts (see [`design.md`](design.md)). `POST /v1/admin/users/{id}/access/revoke` is the exception: it only revokes PATs and writes the audit row, and identity's composite admin route performs the live cuts. `DEVSERVER_RETENTION_MINUTES` drives the devserver registry sweeper: absent or empty means 15 minutes, `0` disables it, and an unparseable value fails startup.

## Routes

All routes Bearer-gated. The middleware accepts either the regular or admin token where both apply, so single-token deployments can set `PROFILE_ADMIN_TOKEN = PROFILE_AUTH_TOKEN`.

Service API (`/v1/users/*`, `/v1/auth-audit`):

| Method | Path                                  | Purpose                            |
|--------|---------------------------------------|------------------------------------|
| POST   | `/v1/users`                           | create user                        |
| GET    | `/v1/users/{id}`                      | fetch one user                     |
| PATCH  | `/v1/users/{id}`                      | update mutable fields              |
| DELETE | `/v1/users/{id}`                      | hard delete (cascades)             |
| POST   | `/v1/users/{id}/pending-delete`       | durable account-delete denial      |
| POST   | `/v1/users/{id}/tokens/{token_id}/revoke` | owned PAT revoke + durable session cut |
| PATCH  | `/v1/users/{id}/username`             | rename handle (cap 4)              |
| GET    | `/v1/users/by-identity`               | lookup by (provider, subject)      |
| GET    | `/v1/users/by-username`               | case-insensitive handle lookup     |
| POST   | `/v1/users/upsert-by-identity`        | atomic find-or-create-or-link      |
| POST   | `/v1/users/{id}/identities`           | attach OAuth identity              |
| GET    | `/v1/users/{o}/devservers`            | list owner's devservers            |
| POST   | `/v1/users/{o}/devservers`            | create devserver (idempotent)      |
| DELETE | `/v1/users/{o}/devservers/{d}`        | delete devserver (cascades grants) |
| POST   | `/v1/users/{o}/devservers/{d}/grants` | upsert devserver grant (binary)    |
| GET    | `/v1/users/{o}/devservers/{d}/grants` | list grants on a devserver         |
| GET    | `/v1/users/{o}/devservers/{d}/access` | access check, `?as=<user_id>`      |
| DELETE | `/v1/users/{o}/grants/{id}`           | revoke a grant (owner-scoped)      |
| GET    | `/v1/users/{id}/grants/owned`         | devservers this user shares        |
| GET    | `/v1/users/{id}/grants/incoming`      | devservers shared with this user   |
| POST   | `/v1/users/{id}/grants/claim`         | claim pending grants by email      |
| GET    | `/v1/users/{id}/flags`                | resolved flags for one user        |
| POST   | `/v1/auth-audit`                      | append login/logout event          |

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

Block returns 202: the handler sets `blocked_at`, revokes every live PAT, writes the `blocked` audit row, and reserves a durable revocation job in one transaction; the background worker performs the fleet cut asynchronously. Unblock clears `blocked_at` and `block_reason` only: PATs revoked at block time stay revoked, and the route answers 409 while an account-delete job is pending.

`devserver_user_policies` stores reversible per-user access plus a positive `max_connected_devservers` value. No row is the compatibility default; identity may instead require a row with `DEVSERVER_POLICY_REQUIRED=true`. `devserver_fleet_policy` is a seeded singleton and survives every service restart. Profile policy routes only persist state. Identity owns the composite drain that follows a stricter user policy or fleet pause.

Global audit accepts exact `user_id` and `action`, RFC3339 `since`/`until`, `limit=1..500`, and non-negative `offset`. Overview counts users and login events in one aggregate query rather than listing and counting rows client-side.
