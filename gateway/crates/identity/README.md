# identity-service

Public-facing OAuth2 sign-in service for `gw.{domain}`. Runs the GitHub / Google / GitLab auth-code flow with PKCE, holds the host-only `__Host-id_session` cookie, and serves a Svelte SPA where users manage their profile, personal access tokens (PATs), and devservers (sharing). It mints the short-lived devserver-gate entry token that hands a user off to the devserver proxy.

## Role in the system

First public touch-point of chan-gateway. After a successful OAuth flow the browser holds the `__Host-id_session` cookie, which is host-only on `gw.{domain}` and is NOT shared with the devserver proxy. To open a workspace, identity mints a short-lived devserver-gate entry credential and returns a no-store handoff page that POSTs it in the body to the exact proxy origin. The proxy verifies and consumes it, then mints its own opaque host-scoped cookie and redirects to the signed clean path. That split is the load-bearing piece of cross-tenant isolation: no `.chan.app`-scoped cookie exists and no entry secret enters browser history or referrers.

Identity-service owns:

- session table rows (via `tower_sessions_sqlx_store`)
- `api_tokens` (PAT issuance, revoke, audit)

It does not own user data. Every user lookup, write, or audit row goes through profile-service over HTTP.

## Build

```bash
cargo build -p identity
```

Frontend baked in at build time via `rust_embed`. identity is the gateway's only SPA; its source is `@chan/profile` in the `./web` npm workspace at the repo root:

```bash
cd web
npm install
npm run build -w @chan/profile
```

A fresh checkout without `web/dist/` still builds; the SPA endpoints render a "frontend not built" banner that points at the build command.

## Dev run

```bash
createdb chan_gateway
export DATABASE_URL=postgres://localhost/chan_gateway
export BIND_ADDR=127.0.0.1:7000
export BASE_URL=http://127.0.0.1:7000
export DEVSERVER_PROXY_ORIGIN=http://usr.localtest.me:7002
export DEVSERVER_TUNNEL_ORIGIN=http://usr.localtest.me:7002
export PROFILE_SERVICE_URL=http://127.0.0.1:7001
export PROFILE_AUTH_TOKEN=dev-service-token
export PROFILE_ADMIN_TOKEN=dev-profile-admin-token
export IDENTITY_INTERNAL_TOKEN=dev-internal-token
export IDENTITY_SESSION_INTERNAL_TOKEN=dev-session-internal-token
export IDENTITY_ADMIN_TOKEN=dev-identity-admin-token
export IDENTITY_ACCOUNT_ADMIN_TOKEN=dev-account-admin-token
export DEVSERVER_POLICY_REQUIRED=false
export DEVSERVER_ENTRY_SIGNING_KEY=<base64-ed25519-private-key>
export GITHUB_CLIENT_ID=...
export GITHUB_CLIENT_SECRET=...
cargo run -p identity
```

Public origins are set explicitly (`BASE_URL`, `DEVSERVER_PROXY_ORIGIN`, `DEVSERVER_TUNNEL_ORIGIN`); there is no hostname derivation from a base domain. For the full local stack, prefer `packaging/gateway/scripts/dev/setup.sh`
+ `packaging/gateway/scripts/dev/run.sh`.

Register a GitHub OAuth app at `https://github.com/settings/developers` with callback `http://127.0.0.1:7000/auth/github/callback`. The other providers follow the same pattern.

## Env vars

Required:

| Name                      | Notes                                       |
|---------------------------|---------------------------------------------|
| `DATABASE_URL`            | Postgres connection string                  |
| `BASE_URL`                | identity's canonical public origin          |
| `DEVSERVER_PROXY_ORIGIN`  | proxy namespace apex origin; node bases must sit one label below it |
| `DEVSERVER_TUNNEL_ORIGIN` | tunnel ingress origin                       |
| `PROFILE_SERVICE_URL`     | profile-service HTTP base URL               |
| `PROFILE_AUTH_TOKEN`      | bearer for profile-service calls            |
| `PROFILE_ADMIN_TOKEN`     | profile admin bearer for policy/composites  |
| `IDENTITY_INTERNAL_TOKEN` | bearer devserver-proxy presents on validate |
| `IDENTITY_SESSION_INTERNAL_TOKEN` | narrow bearer for OAuth-session `whoami` |
| `DEVSERVER_ADMIN_URL`     | protected devserver-control admin base     |
| `DEVSERVER_IDENTITY_ADMIN_TOKEN` | identity-scoped controller bearer |
| `DEVSERVER_ADMISSION_VERIFYING_KEYS` | controller admission public-key ring |
| `DEVSERVER_ENTRY_SIGNING_KEY` | Ed25519 private key for short-lived entry credentials |
| At least one provider's `*_CLIENT_ID` + `*_CLIENT_SECRET` pair        |

Provider credentials (each pair optional; leave both unset to disable):

- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- `GITLAB_CLIENT_ID`, `GITLAB_CLIENT_SECRET`

Optional knobs:

| Name                       | Default                   | Purpose               |
|----------------------------|---------------------------|-----------------------|
| `BIND_ADDR`                | `127.0.0.1:7000`          | listen address        |
| `COOKIE_SECURE`            | `false`                   | HTTPS-only cookie     |
| `IDENTITY_ADMIN_TOKEN`     | unset                     | enables identity's operator admin tree |
| `IDENTITY_ACCOUNT_ADMIN_TOKEN` | unset                  | enables account-service composite access |
| `DEVSERVER_POLICY_REQUIRED` | `false`                  | deny PAT mint/admission when user policy is absent |
| `RUSTRICT_ALLOWLIST`       | unset                     | comma-separated usernames exempt from the profanity filter |
| `IDENTITY_OAUTH_ENDPOINTS_BASE` | unset (stock github.com) | GitHub OAuth/API endpoint origin override for local e2e stubs; never set in production |

## Routes

Public (no session required):

| Method | Path                        | Purpose               |
|--------|-----------------------------|-----------------------|
| GET    | `/`                         | SPA root (index.html) |
| GET    | `/healthz`                  | health check          |
| GET    | `/auth/{provider}`          | OAuth start (PKCE; optional safe `return_to`) |
| GET    | `/auth/{provider}/callback` | OAuth callback        |

Session-gated SPA API (`/api/*`):

| Method | Path                         | Purpose                                    |
|--------|------------------------------|--------------------------------------------|
| GET    | `/api/providers`             | list of enabled OAuth providers            |
| GET    | `/api/me`                    | current user                               |
| PATCH  | `/api/me/username`           | rename handle                              |
| POST   | `/api/logout`                | invalidate session                         |
| DELETE | `/api/profile`               | account deletion                           |
| GET    | `/api/tokens`                | list PATs                                  |
| POST   | `/api/tokens`                | mint a PAT (returns plaintext once)        |
| DELETE | `/api/tokens/{id}`           | revoke a PAT                               |
| GET    | `/api/tokens/{id}/audit`     | per-token audit log                        |
| GET    | `/api/devservers/owned`      | devservers the user owns (+ grant counts)  |
| GET    | `/api/devservers/incoming`   | devservers shared with the user            |
| POST   | `/api/devservers/{d}/grants` | share a devserver (whole library) by email |
| GET    | `/api/devservers/{d}/grants` | list grants on the user's devserver        |
| DELETE | `/api/grants/{id}`           | revoke a grant on the user's devserver     |

Public share landing (no auth at the door):

| Method | Path                     | Purpose                                 |
|--------|--------------------------|-----------------------------------------|
| GET    | `/s/{owner}/{workspace}` | per-tenant share link (OAuth-then-mint) |
| GET    | `/s/{owner}`             | whole-devserver open (owner-only)       |

Desktop authorize (PAT mint for chan-desktop; consent is session-gated, entry bounces through sign-in when needed):

| Method | Path                         | Purpose                            |
|--------|------------------------------|------------------------------------|
| GET    | `/desktop/authorize`         | validate query, stash, bounce      |
| GET    | `/desktop/authorize/consent` | consent page (SPA-styled)          |
| POST   | `/desktop/authorize/confirm` | allow/deny -> handoff -> loopback   |

Desktop devserver entry (Bearer PAT with the `desktop.connect` scope):

| Method | Path                          | Purpose                                      |
|--------|-------------------------------|----------------------------------------------|
| POST   | `/desktop/v1/devserver/entry` | mint an entry URL for the caller's devserver |

A 404 keeps the `{"error": msg}` shape and adds `reason` (`no_devserver`, `devserver_offline`, `access_denied`), `username`, and `label` (offline only) so chan-desktop can narrate the failure; see `design.md`.

Internal (route-scoped Bearer authentication):

| Method | Path                                   | Purpose                |
|--------|----------------------------------------|------------------------|
| POST   | `/internal/v1/tokens/validate`         | validate a PAT using `IDENTITY_INTERNAL_TOKEN` |
| POST   | `/internal/v1/sessions/whoami`         | resolve an indexed OAuth cookie using `IDENTITY_SESSION_INTERNAL_TOKEN` |

The token route is called by devserver-proxy during tunnel handshake and lease refresh. `whoami` accepts a raw `__Host-id_session` value from the separately authenticated account caller and returns only the indexed user plus authentication time. Malformed, unknown, expired, pre-index, deleted-user, and blocked-user cookies share one 401 response.

Admin (internal listener):

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/admin/v1/tokens` | mint a PAT |
| GET | `/admin/v1/sessions` | list OAuth sessions |
| POST | `/admin/v1/sessions/{id}/revoke` | revoke one OAuth session |
| POST | `/admin/v1/users/{id}/sessions/revoke` | revoke a user's OAuth sessions |
| GET | `/admin/v1/sessions/overview` | active OAuth-session count |
| GET/PUT | `/admin/v1/users/{id}/devserver-policy` | read/persist and drain user policy |
| GET | `/admin/v1/fleet` | persistent admissions state |
| POST | `/admin/v1/fleet/pause` | persist pause and drain all sessions/tunnels |
| POST | `/admin/v1/fleet/resume` | persist resume |
| POST | `/admin/v1/users/{id}/access/revoke` | PAT/OAuth/tenant/tunnel access cut |
| DELETE | `/admin/v1/users/{id}` | convergent account deletion |

`IDENTITY_ADMIN_TOKEN` is the operator credential and may call every admin route. `IDENTITY_ACCOUNT_ADMIN_TOKEN` may call only access revoke, profile delete, and per-user devserver-policy GET/PUT. An unset narrow token disables its caller scope. Every configured identity bearer must be distinct or startup fails.

Composite mutations persist denial before issuing controller commands. Any unconfirmed downstream cut returns 502 with durable state and confirmed counts; raw downstream response bodies and credentials are not propagated.

## Design rationale

See [`design.md`](design.md).
