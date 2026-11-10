# identity-service

Public-facing OAuth2 sign-in service for `gw.{domain}`. Runs the GitHub, Google and GitLab auth-code flow with PKCE, holds the host-only `__Host-id_session` cookie, serves the account SPA (profile, personal access tokens, devserver sharing), answers the desktop API, and mints the short-lived entry credential that hands a user off to a devserver's proxy origin.

This file is the operator and consumer reference: how to build and run it, its configuration and its HTTP surface. Boundaries, flows, invariants and rationale live in [design.md](design.md).

## Role in the system

First public touch-point of the gateway. After OAuth the browser holds `__Host-id_session`, host-only on `gw.{domain}` and never shared with devserver-proxy. To open a devserver, identity mints a short-lived entry credential and returns a no-store handoff that posts it in a body to the exact proxy origin; the proxy verifies and consumes it, mints its own host-only cookies and redirects to the signed clean path. That split is the load-bearing piece of cross-tenant isolation: no parent-domain cookie exists and no entry secret enters browser history or referrers.

identity owns the session rows (via `tower_sessions_sqlx_store`), the session index and `api_tokens`. User, identity and audit data live in profile-service and are reached over HTTP.

## Build

```bash
cargo build -p identity
```

The SPA is baked in at build time via `rust_embed`. Its source is `@chan/profile` in the `./web` npm workspace at the repo root:

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
# Apply migrations once; the process exits when DDL succeeds.
CHAN_GATEWAY_MIGRATIONS=only cargo run -p identity

export CHAN_GATEWAY_MIGRATIONS=external
export BIND_ADDR=127.0.0.1:7000
# Must not collide with PROFILE_SERVICE_URL below (the crate default
# INTERNAL_BIND_ADDR is 127.0.0.1:7001).
export INTERNAL_BIND_ADDR=127.0.0.1:7004
export BASE_URL=http://127.0.0.1:7000
export DEVSERVER_PROXY_ORIGIN=http://proxy.localtest.me:7002
export DEVSERVER_TUNNEL_ORIGIN=http://proxy.localtest.me:7002
export PROFILE_SERVICE_URL=http://127.0.0.1:7001
export PROFILE_AUTH_TOKEN=dev-service-token
export PROFILE_ADMIN_TOKEN=dev-profile-admin-token
export IDENTITY_INTERNAL_TOKEN=dev-internal-token
export IDENTITY_SESSION_INTERNAL_TOKEN=dev-session-internal-token
export IDENTITY_ADMIN_TOKEN=dev-identity-admin-token
export IDENTITY_ACCOUNT_ADMIN_TOKEN=dev-account-admin-token
export DEVSERVER_ADMIN_URL=http://127.0.0.1:7003
export DEVSERVER_IDENTITY_ADMIN_TOKEN=dev-control-identity-token
export DEVSERVER_POLICY_REQUIRED=false
export DEVSERVER_ADMISSION_SIGNING_KEY=<base64-ed25519-private-key>
export DEVSERVER_ADMISSION_VERIFYING_KEYS=<base64-ed25519-public-key>
export DEVSERVER_ENTRY_SIGNING_KEY=<base64-ed25519-private-key>
export GITHUB_CLIENT_ID=...
export GITHUB_CLIENT_SECRET=...
cargo run -p identity
```

Public origins are set explicitly (`BASE_URL`, `DEVSERVER_PROXY_ORIGIN`, `DEVSERVER_TUNNEL_ORIGIN`); nothing is derived from a base domain. For the full local stack, prefer `packaging/gateway/scripts/dev/setup.sh` plus `packaging/gateway/scripts/dev/run.sh`.

Register a GitHub OAuth app at `https://github.com/settings/developers` with callback `http://127.0.0.1:7000/auth/github/callback`. The other providers follow the same pattern.

## Listeners

identity serves two routers on two listeners: the public browser listener on `BIND_ADDR` and the internal listener on `INTERNAL_BIND_ADDR` (crate default `127.0.0.1:7001`; the packaged `identity.env` sets `7004` and the dev stack `17004`). The internal listener carries `/internal/v1/*` and `/admin/v1/*` and never mounts the session layer; on the public listener any `/internal/*` probe gets a plain 404.

## Database migrations

Migrations never run implicitly on boot. `CHAN_GATEWAY_MIGRATIONS` is required and must be exactly `only` or `external`. `only` applies `gateway/migrations/` plus the tower-sessions store migration and exits, needing only `DATABASE_URL`; `external` never touches DDL.

The Debian package splits the two modes across units: `chan-gateway-migrate.service` is a oneshot that runs this binary with `CHAN_GATEWAY_MIGRATIONS=only` as the database owner, and `chan-gateway-identity.service` and `chan-gateway-profile.service` pull it in with `Requires=`. No gateway crate uses sd_notify or a watchdog.

## Env vars

Required:

| Name                                 | Notes                                  |
|--------------------------------------|----------------------------------------|
| `DATABASE_URL`                       | Postgres connection string             |
| `CHAN_GATEWAY_MIGRATIONS`            | `only` or `external`                   |
| `BASE_URL`                           | identity's canonical public origin     |
| `DEVSERVER_PROXY_ORIGIN`             | proxy namespace apex origin            |
| `DEVSERVER_TUNNEL_ORIGIN`            | tunnel ingress origin                  |
| `PROFILE_SERVICE_URL`                | profile-service HTTP base URL          |
| `PROFILE_AUTH_TOKEN`                 | bearer for profile-service calls       |
| `PROFILE_ADMIN_TOKEN`                | profile admin bearer for composites    |
| `IDENTITY_INTERNAL_TOKEN`            | bearer devserver-proxy presents        |
| `DEVSERVER_ADMIN_URL`                | devserver-control admin base           |
| `DEVSERVER_IDENTITY_ADMIN_TOKEN`     | identity-scoped controller bearer      |
| `DEVSERVER_ADMISSION_SIGNING_KEY`    | Ed25519 admission-lease signing key    |
| `DEVSERVER_ADMISSION_VERIFYING_KEYS` | admission public-key ring              |
| `DEVSERVER_ENTRY_SIGNING_KEY`        | Ed25519 entry-credential signing key   |

At least one provider's `*_CLIENT_ID` and `*_CLIENT_SECRET` pair is required: `GITHUB_*`, `GOOGLE_*`, `GITLAB_*`. A pair counts only when both values are non-empty after trimming; leaving both unset or empty disables that provider, and setting only one of the two refuses to start with a message that names the empty variable and prints neither value.

Optional:

| Name                              | Default            | Purpose                 |
|-----------------------------------|--------------------|-------------------------|
| `BIND_ADDR`                       | `127.0.0.1:7000`   | public listener         |
| `INTERNAL_BIND_ADDR`              | `127.0.0.1:7001`   | internal listener       |
| `COOKIE_SECURE`                   | `false`            | HTTPS-only cookie       |
| `IDENTITY_SESSION_INTERNAL_TOKEN` | unset              | enables `whoami`        |
| `WIREGUARD_AGENT_TOKEN`           | unset              | enables peer-list reads |
| `IDENTITY_ADMIN_TOKEN`            | unset              | enables the admin tree  |
| `IDENTITY_ACCOUNT_ADMIN_TOKEN`    | unset              | enables the composites  |
| `DEVSERVER_POLICY_REQUIRED`       | `false`            | deny when policy absent |
| `CHAN_GATEWAY_INTERNAL_TRANSPORT` | unset              | `protected-overlay`     |
| `RUST_LOG`                        | `info`             | tracing filter          |
| `RUSTRICT_ALLOWLIST`              | unset              | profanity-filter allowlist |
| `IDENTITY_OAUTH_ENDPOINTS_BASE`   | unset              | GitHub endpoint override |

Every configured identity bearer must be distinct or startup fails. An unset narrow token disables its caller scope. `RUSTRICT_ALLOWLIST` is a comma-separated list of usernames exempt from the profanity filter. `IDENTITY_OAUTH_ENDPOINTS_BASE` points the GitHub provider at a local stub for end-to-end tests and is never set in production.

### WireGuard enrollment

Identity offers one WireGuard ingress per proxy node that terminates WireGuard: that node's kernel interface. Set `WIREGUARD_INGRESSES`, `WIREGUARD_INGRESS_ADDRESSES` and `WIREGUARD_ALLOWED_IPS` together; a partial set refuses startup, and a value that is empty or only whitespace counts as unset. Absence omits `wireguard` from discovery and refuses an authorize request carrying a key. Identity stays publicly reachable without the tunnel.

| Name | Value |
| --- | --- |
| `WIREGUARD_INGRESSES` | Semicolon-separated `id=public_key@endpoint`, one per node |
| `WIREGUARD_INGRESS_ADDRESSES` | Tunnel address of every ingress interface: one IPv4, one IPv6 or both, comma-separated |
| `WIREGUARD_ALLOWED_IPS` | Comma-separated CIDRs routed through each tunnel |
| `WIREGUARD_PERSISTENT_KEEPALIVE` | Optional seconds, default 25; 0 omits it |

```sh
WIREGUARD_INGRESSES=p1=<p1 key>@p1.proxy.example.com:51820;p2=<p2 key>@p2.proxy.example.com:51820
WIREGUARD_INGRESS_ADDRESSES=10.7.0.1
WIREGUARD_ALLOWED_IPS=10.7.0.1/32
```

In a `WIREGUARD_INGRESSES` entry, `id` is the node's `DEVSERVER_PROXY_ID`, one lowercase DNS label, which is also the `WIREGUARD_AGENT_HOST_ID` of the agent on that node. `public_key` is the node interface's key, padded base64 for 32 bytes. `endpoint` is the interface's `host:port`, with an IPv6 literal in brackets; it may be the node's own name, since a desktop resolves an endpoint on its host and not through a tunnel's host map. An entry is split once on its first `=` and once on `@`, so the `=` that pads the key needs no escaping. Ids are unique; keys and endpoints may repeat. An empty entry, which a trailing or doubled `;` makes, is refused. The order of the list is kept: its first entry is the ingress the single-ingress fields of discovery and of the redeem describe.

Every ingress interface answers on the same `WIREGUARD_INGRESS_ADDRESSES`, at most one address per family, each inside `WIREGUARD_ALLOWED_IPS`. No host map is configured: identity derives one per ingress, `{id}.{proxy host}` and `*.{id}.{proxy host}` mapped to the ingress addresses, where `{proxy host}` is the host of `DEVSERVER_PROXY_ORIGIN` without its port. Those are the node's base name and its tenant names, so a tenant name is carried only by its own node's tunnel. With enrollment configured, `DEVSERVER_PROXY_ORIGIN` must have a DNS name as its host, every derived name must be a lowercase DNS name of at most 253 bytes, and `BASE_URL`'s host must be neither a derived node name nor a name below one.

`WIREGUARD_ALLOWED_IPS` and `WIREGUARD_PERSISTENT_KEEPALIVE` apply to every ingress. The ingress addresses must stay out of profile's allocation: profile never allocates a pool's network address or its first host address, and any other ingress address belongs in profile's `WIREGUARD_POOL_RESERVED`. Identity cannot read profile's pool, so it does not check this.

`WIREGUARD_HOST_ID`, `WIREGUARD_ENDPOINT`, `WIREGUARD_PUBLIC_KEY` and `WIREGUARD_HOSTS` describe a single ingress and are refused: a non-empty value in any of them stops startup with a message naming what to set instead (`WIREGUARD_INGRESSES` for the first three; nothing for `WIREGUARD_HOSTS`, whose map is derived). A deployment that sets them therefore never starts with enrollment silently off.

With enrollment configured, discovery's `wireguard` object carries `endpoint` and `public_key` (the first ingress's), `allowed_ips`, `persistent_keepalive` (left out when it is 0) and `ingresses`: one `{id, endpoint, public_key, hosts}` per ingress in the configured order, where `hosts` is that ingress's derived map as `[{name, addresses}]`. That is everything a desktop needs to start a tunnel to any ingress except its own key and address. A desktop that reads only `endpoint` and `public_key` sees one ingress, the first.

Profile separately needs `WIREGUARD_POOL_V4` and may set `WIREGUARD_POOL_V6`, reservations and release grace. `configure.sh` generates the agent bearer and leaves the interface and pool values as commented examples.

## Routes

Public (no session required):

| Method | Path                        | Purpose                          |
|--------|-----------------------------|----------------------------------|
| GET    | `/`                         | SPA root                         |
| GET    | `/healthz`                  | health check                     |
| GET    | `/.well-known/chan-gateway` | gateway discovery JSON           |
| GET    | `/auth/{provider}`          | OAuth start (PKCE, `return_to`)  |
| GET    | `/auth/{provider}/callback` | OAuth callback                   |

Session-gated SPA API:

| Method | Path                         | Purpose                             |
|--------|------------------------------|-------------------------------------|
| GET    | `/api/providers`             | enabled OAuth providers             |
| GET    | `/api/me`                    | current user, flags, live list      |
| PATCH  | `/api/me/username`           | rename handle (kills tunnels first) |
| POST   | `/api/logout`                | invalidate session                  |
| DELETE | `/api/profile`               | account deletion                    |
| GET    | `/api/tokens`                | list PATs                           |
| POST   | `/api/tokens`                | mint a PAT (plaintext once)         |
| DELETE | `/api/tokens/{id}`           | revoke a PAT                        |
| GET    | `/api/tokens/{id}/audit`     | per-token audit log                 |
| GET    | `/api/devservers/owned`      | devservers the user owns            |
| GET    | `/api/devservers/incoming`   | devservers shared with the user     |
| POST   | `/api/devservers/{d}/grants` | share a devserver by email          |
| GET    | `/api/devservers/{d}/grants` | list grants on a devserver          |
| DELETE | `/api/grants/{id}`           | revoke a grant                      |

Share landings (no auth at the door; sign-in then mint):

| Method | Path                     | Purpose                            |
|--------|--------------------------|------------------------------------|
| GET    | `/s/{owner}/{workspace}` | per-tenant share link              |
| GET    | `/s/{owner}`             | whole-devserver share link         |

Both admit the devserver's owner and every accepted grantee, and answer any other caller with the not-found an unknown handle gets.

Desktop authorize (PAT mint for chan-desktop):

| Method | Path                         | Purpose                           |
|--------|------------------------------|-----------------------------------|
| GET    | `/desktop/authorize`         | validate query, stash, bounce     |
| GET    | `/desktop/authorize/consent` | consent page                      |
| POST   | `/desktop/authorize/confirm` | allow or deny, then loopback      |
| POST   | `/desktop/authorize/redeem`  | one-time code to PAT              |

The optional `wireguard_public_key` authorize query carries a padded base64 32-byte key, shown on the consent page. Allow enrolls it in profile once, against the minted PAT, before issuing the redemption code; the one enrollment covers every ingress. Enrollment failure soft-revokes that undelivered PAT and hands back `error=wireguard_enroll_failed`. Successful redemption adds `wireguard`: the peer's one assigned `addresses` set, valid on every ingress, `allowed_ips`, optional `persistent_keepalive`, and `ingresses`, which is discovery's list with each key named `server_public_key`. The object's own `server_public_key`, `endpoint` and `hosts` are the first ingress's, so a desktop that reads no list enrolls against the first ingress and reaches the other nodes over their public path. Without a key the response shape is unchanged.

Desktop API (Bearer PAT):

| Method | Path                          | Purpose                          |
|--------|-------------------------------|----------------------------------|
| POST   | `/desktop/v1/devserver/entry` | mint an entry credential         |
| GET    | `/desktop/v1/devservers`      | account roster (ETag, 304)       |
| DELETE | `/desktop/v1/token`           | the bearer PAT revokes itself    |

The entry body optionally carries `{path, owner, owner_user_id, devserver_id}` to target an explicit devserver; the response is `{owner_user_id, username, devserver_id, proxy_origin, entry_exchange_url, entry_credential, expires_at}` with `Cache-Control: no-store`. A not-found adds a stable `reason` (`no_devserver`, `devserver_offline`, `access_denied`) so chan-desktop can narrate the failure. The roster answers `{user_id, username, devservers: [{owner_user_id, owner, devserver_id, label, online, proxy_origin|null}]}`. The token route reads no id and no body: the bearer, which must carry `desktop.connect` or `desktop.account`, is the only token it soft-revokes (`revoked_at` set, row and audit kept, a `revoked_via_desktop` audit row), answered 204; a token that was used also gets the owner's revoke cut (profile's durable reservation and the first cut of the owner's tunnels and sessions), run detached after the answer so the client cannot cancel it. A revoked, expired, unknown or non-desktop bearer, and a session cookie without one, get the same 401 `{"error":"unauthorized"}` as the other desktop routes.

Internal listener (route-scoped bearers):

| Method | Path                           | Bearer                            |
|--------|--------------------------------|-----------------------------------|
| POST   | `/internal/v1/tokens/validate` | `IDENTITY_INTERNAL_TOKEN`         |
| POST   | `/internal/v1/sessions/whoami` | `IDENTITY_SESSION_INTERNAL_TOKEN` |
| GET    | `/internal/v1/wireguard/peers` | `WIREGUARD_AGENT_TOKEN`           |

The peer-list route requires `?host=<label>` and relays profile's JSON bytes, quoted ETag and conditional 304 unchanged. Missing or wrong bearer answers 401, an empty configured bearer 404, malformed host 400, and profile failure 502.

The validate route serves PAT validation, Hello-name announcement and lease refresh for devserver-proxy; with `proxy_id` and `registration_id` present the response also carries the signed admission lease. See [Devserver publication](../../design.md#devserver-publication) for the contact inventory.

Admin (internal listener; `IDENTITY_ADMIN_TOKEN` may call every route, `IDENTITY_ACCOUNT_ADMIN_TOKEN` only access revoke, delete and devserver policy):

| Method  | Path                                       | Purpose                       |
|---------|--------------------------------------------|-------------------------------|
| POST    | `/admin/v1/tokens`                         | mint a PAT                    |
| POST    | `/admin/v1/tokens/{id}/revoke`             | revoke a PAT                  |
| GET     | `/admin/v1/sessions`                       | list OAuth sessions           |
| POST    | `/admin/v1/sessions/{id}/revoke`           | revoke one OAuth session      |
| POST    | `/admin/v1/users/{id}/sessions/revoke`     | revoke a user's sessions      |
| GET     | `/admin/v1/sessions/overview`              | active OAuth-session count    |
| GET/PUT | `/admin/v1/users/{id}/devserver-policy`    | read or persist user policy   |
| GET     | `/admin/v1/fleet`                          | persistent admissions state   |
| POST    | `/admin/v1/fleet/pause`                    | pause and drain the fleet     |
| POST    | `/admin/v1/fleet/resume`                   | resume admissions             |
| POST    | `/admin/v1/users/{id}/access/revoke`       | PAT, OAuth, tenant, tunnel cut|
| DELETE  | `/admin/v1/users/{id}`                     | convergent account deletion   |

Composite mutations persist denial before issuing controller commands; an unconfirmed downstream cut answers an upstream error carrying the durable state and confirmed counts.

## Design rationale

See [`design.md`](design.md).
