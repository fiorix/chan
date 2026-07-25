# profile-service

Internal HTTP API in front of Postgres. Owns the canonical user record, linked OAuth identities, devservers + sharing grants, feature flags, and the authentication audit log; serves the admin views over `api_tokens`. Called only by `identity-service` and the operator CLI; not exposed publicly.

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
export BIND_ADDR=127.0.0.1:7001
export PROFILE_AUTH_TOKEN=dev-service-token
export PROFILE_ADMIN_TOKEN=dev-admin-token   # optional; gates /v1/admin/*
export DEVSERVER_ADMIN_URL=http://127.0.0.1:7003
export DEVSERVER_PROFILE_ADMIN_TOKEN=dev-profile-control-token
cargo run -p profile
```

Migrations under `migrations/` run on startup.

## Env vars

| Name                   | Required | Notes                             |
|------------------------|----------|-----------------------------------|
| `DATABASE_URL`         | yes      | Postgres connection string        |
| `BIND_ADDR`            | no       | Default `127.0.0.1:7001`          |
| `PROFILE_AUTH_TOKEN`   | yes      | Bearer for `/v1/users/*` routes   |
| `PROFILE_ADMIN_TOKEN`  | no       | Bearer for `/v1/admin/*` routes   |
| `DEVSERVER_ADMIN_URL`  | yes      | protected devserver-control admin base |
| `DEVSERVER_PROFILE_ADMIN_TOKEN` | yes | profile-scoped controller bearer |

A missing `PROFILE_ADMIN_TOKEN` makes every `/v1/admin/*` route return 401; that is the safe default for a fresh deploy. Every access-denial mutation writes a durable revocation job in the same transaction. The worker uses the profile-scoped controller bearer to cut tunnels and browser sessions across the fleet and retries across service restarts until settled or exhausted.

## Routes

All routes Bearer-gated. The middleware accepts either the regular or admin token where both apply, so single-token deployments can set `PROFILE_ADMIN_TOKEN = PROFILE_AUTH_TOKEN`.

Service API (`/v1/users/*`, `/v1/auth-audit`):

| Method | Path                                  | Purpose                            |
|--------|---------------------------------------|------------------------------------|
| POST   | `/v1/users`                           | create user                        |
| GET    | `/v1/users/{id}`                      | fetch one user                     |
| PATCH  | `/v1/users/{id}`                      | update mutable fields              |
| DELETE | `/v1/users/{id}`                      | hard delete (cascades)             |
| PATCH  | `/v1/users/{id}/username`             | rename handle (cap 4)              |
| GET    | `/v1/users/by-identity`               | lookup by (provider, subject)      |
| GET    | `/v1/users/by-username`               | case-insensitive handle lookup     |
| POST   | `/v1/users/upsert-by-identity`        | atomic find-or-create-or-link      |
| POST   | `/v1/users/{id}/identities`           | attach OAuth identity              |
| GET    | `/v1/users/{o}/devservers`            | list owner's devservers            |
| POST   | `/v1/users/{o}/devservers`            | create devserver (idempotent)      |
| DELETE | `/v1/users/{o}/devservers/{d}`        | delete devserver (cascades grants) |
| POST   | `/v1/users/{o}/devservers/{d}/grants` | create / promote devserver grant   |
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
| GET    | `/v1/admin/users/{id}/auth-audit`           | per-user audit log             |
| GET    | `/v1/admin/users/{id}/tokens`               | list user's PATs               |
| POST   | `/v1/admin/tokens/{id}/revoke`              | revoke a PAT                   |
| GET    | `/v1/admin/tokens/{id}/audit`               | per-token audit log            |
| GET    | `/v1/admin/flags`                           | list flags + override count    |
| POST   | `/v1/admin/flags`                           | create / update a flag         |
| DELETE | `/v1/admin/flags/{key}`                     | drop flag (cascades overrides) |
| GET    | `/v1/admin/flags/{key}/overrides`           | per-user overrides on a flag   |
| POST   | `/v1/admin/flags/{key}/overrides`           | upsert per-user override       |
| DELETE | `/v1/admin/flags/{key}/overrides/{user_id}` | clear per-user override        |

Plus `GET /healthz` (no auth).

## Design rationale

See [`design.md`](design.md).
