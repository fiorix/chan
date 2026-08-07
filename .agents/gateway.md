# Gateway

Contribution guidelines for agents and contributors working on the `gateway/` workspace. Source files live under `gateway/`; this file documents them from the shared `.agents/` home.

The gateway is what makes a local `chan devserver` reachable on a public URL with sign-in and sharing, without the user opening a port, configuring DNS, or running a TURN/STUN stack. It terminates the tunnel a devserver dials out, gates every request on the wildcard host, and hands a freshly authenticated browser off from the sign-in surface to the tenant content over a short-lived token. The unit it exposes, gates, and shares is the **devserver** (resolved from the owner's PAT; a user may run several, capped fleet-wide by devserver-control), not an individual workspace; the `{workspace}` path segment is tenant routing inside that devserver, never a permission key.

## What this workspace is

The `gateway/` Cargo workspace runs the account, sign-in, and reverse-proxy surface for chan.app, a separate nested Cargo workspace. Its crates under `gateway/crates/` are the services in the Topology below, which names each one with the host it answers on and what it owns; each crate's `design.md` is the full surface. The ownership that is not obvious from the layout: `profile` is the only crate that touches the sharing tables (`devservers`, `devserver_grants`); `identity` holds the only cookie session, the PAT tables, and the `/internal/v1/tokens/validate` endpoint the proxy hits on every handshake; `devserver-proxy` holds no Postgres and ships no SPA; `devserver-control` (with its `devserver-control-proto` frame crate) owns the authoritative proxy directory, fleet-wide admission, and the aggregate `/admin/v1/*` tree; `gateway-common` is the single home of the `devserver_gate` entry-credential envelope and the cross-service clients.

Each public-facing crate ships two docs: `README.md` is the consumer-facing entry (pitch, install, build, route table, env vars) and `design.md` is the canonical design reference (problem, architecture, public surface, key decisions, invariants, error model). Update `design.md` in the same commit as any change that affects HTTP routes, the on-the-wire shape of a public response, the session contract, or the inter-service trust model.

### Topology

```mermaid
flowchart TB
    subgraph browser["Browser"]
        IDSPA["identity SPA · gw.{domain}"]
        LAUNCH["web-launcher SPA<br/>(served through the proxy at the devserver root)"]
    end

    subgraph gw["chan gateway (nested Cargo workspace)"]
        ID["identity-service · gw.{domain}<br/>OAuth · sessions · PATs · /s/{owner} open · token validate · discovery"]
        PROXY["devserver-proxy nodes · {proxy}.usr.{domain}<br/>node apex: tunnel + healthz<br/>*.{proxy}.usr.{domain} wildcard: launcher root + tenants + gate cookies"]
        CTL["devserver-control<br/>proxy directory · admission · /admin/v1/*"]
        PROFILE["profile-service · internal, not public<br/>Postgres: users · identities · devservers + devserver_grants"]
        ADMIN["admin CLI"]
        COMMON["gateway-common<br/>domain · devserver_gate · profile_client · devserver_control_client"]
        PG[("Postgres")]
    end

    subgraph box["User's machine"]
        DS["chan devserver · library = ~/.chan workspaces<br/>serves the launcher at / · tenants under /{slug}-{8hex}/"]
    end

    IDSPA -->|OAuth · manage devservers · Open| ID
    ID -->|"mint entry credential (drv, aud)"| IDSPA
    ID <-->|users · grants · access| PROFILE
    PROFILE --- PG
    ID --- PG
    PROXY -->|validate PAT · /internal/v1/tokens/validate| ID
    PROXY <-->|h2c control stream · snapshots + admission + kills| CTL
    ID -->|aggregate reads · kills| CTL
    PROFILE -->|block eviction · sweeper marks| CTL
    DS ==>|"tunnel register with PAT · usr.{domain}/v1/tunnel"| PROXY
    PROXY ==>|gated tenant + root traffic over the tunnel| DS
    LAUNCH -->|/api/library/* via the proxy| PROXY
    ID --> COMMON
    PROXY --> COMMON
    PROFILE --> COMMON
```

The gated path is the tenant traffic the proxy forwards over the tunnel to the tenant wildcard host (the thick arrows): a browser only reaches the devserver after identity has minted a short-lived Ed25519 entry credential for it and devserver-proxy has exchanged that credential (a POST to its `/_chan/entry` endpoint) for the `__Host-devserver_gate` plus `__Host-devserver_csrf` host-only cookies. devserver-proxy never talks to Postgres; it resolves identity over HTTP at handshake time, keeps its live-tunnel state in an in-process registry, and publishes it to devserver-control over one authenticated control stream.

## Build & Test

```bash
cargo build
cargo test
cargo fmt --check
cargo clippy --all-targets -- -D warnings
```

The Rust toolchain is pinned in `rust-toolchain.toml`. The pre-push hook (`./scripts/install-hooks` to install) runs the same gate as CI; a passing local push will not fail in the cloud.

Database setup for tests (both `profile` and `identity` open a pool against the same gateway database):

```bash
createdb chan_gateway        # dev database
createdb chan_gateway_test   # test database used by integration tests
export DATABASE_URL=postgres://localhost/chan_gateway
```

Only identity-service ships a SPA. Its source is `@chan/profile` and the shared chrome is `@chan/web-shared`, both members of the `./web` npm workspace at the repo root:

```bash
cd web
npm install                          # one install for the whole workspace
npm run build -w @chan/profile       # build the identity SPA bundle (or: make gateway-spa)
```

Per-app dev:

```bash
cd web && npm run dev -w @chan/profile    # vite dev server for the identity SPA
```

The rust-embed input folder (`gateway/crates/identity/web/dist/`) is created by the SPA build; a fresh checkout does not compile the gateway workspace until `make gateway-spa` (or the npm build above) has run once. With an empty bundle, identity's SPA endpoint returns a "frontend not built" banner that points at the right command. devserver-proxy has no SPA.

## Writing Rules

- **No em dashes** in comments or documentation. Use commas, semicolons, parentheses, or separate sentences.
- **Tables**: pure ASCII, target 80 columns, left-aligned, no Unicode box-drawing.
- **Factual**: no marketing language ("just", "easy", "blazing"). Verify every claim against the implementation; flag drift.
- **Comments**: explain WHY, not WHAT. The code shows what; the comment explains the reasoning, the trade-off, or the constraint.

## Workspace Principles

These rules cut across every crate in the `gateway/` Cargo workspace. Per-crate specifics live in each crate's `design.md`.

### Constant-time secret comparisons

Every bearer token, OAuth state value, JWT signature compare, and CSRF-shaped check uses `subtle::ConstantTimeEq` (or an equivalent timing-safe operation). Plain `==` on a secret is never acceptable, even when the rest of the request gates require an authenticated session. The known leak (length inequality short-circuits) is acknowledged in a comment next to each compare.

### HTTP error mapping

Each request-handler crate (`profile`, `identity`, `devserver-proxy`) defines a `thiserror::Error` enum with an `IntoResponse` impl that maps every variant to a precise HTTP status code. Public-facing messages are short and intentionally generic (`unauthorized`, `internal error`, `upstream unreachable`); detailed context goes into the `tracing` log on the server side. `anyhow::Error` is acceptable in `main.rs` and in startup paths; request handlers return explicit thiserror variants.

`gateway_common::profile_client::ProfileError`, `gateway_common::devserver_control_client::DevserverControlError`, and `gateway_common::devserver_gate::DevserverGateError` are the cross-service client errors. Each consumer maps them onto its local error via a `From` impl so request handlers can `?` straight through.

### Session contract

identity-service owns the only session cookie in the suite: `__Host-id_session` (`id_session_insecure_dev` when `COOKIE_SECURE=false`), host-only on the identity origin `gw.{domain}` (no `Domain` attribute), `HttpOnly`, `SameSite=Lax`, 30-day inactivity expiry. devserver-proxy does not read this cookie.

devserver-proxy writes two host-only cookies on the tenant host `{owner}--{disc}.{proxy}.usr.{domain}`, both scoped `Path=/` and not shared with identity. `__Host-devserver_gate` is HttpOnly, Secure, SameSite=Lax, and carries an opaque revocable proxy-local session id (maximum one hour), minted when the proxy consumes a 30s Ed25519 entry credential POSTed to `/_chan/entry`. `__Host-devserver_csrf` is Secure, SameSite=Lax, readable by same-origin launcher JS, and must match `X-Chan-CSRF` on unsafe proxied HTTP methods.

This split is the load-bearing piece of the cross-tenant isolation: no parent-domain cookie exists, so a browser does not auto-attach an id session to a fetch on a sibling tenant origin, and the `__Host-` prefix makes the browser itself refuse any parent-domain shadow of the same name. Cookie sharing across the two services is replaced by an explicit entry-credential handoff (a POST body to the proxy's `/_chan/entry`, never a URL parameter; gate cookies set by devserver-proxy on exchange). The whole-host `Path=/` scope is safe precisely because the gate is per-devserver: a collaborator is granted the entire devserver, so there is no non-granted sub-tenant on the same host to isolate the cookie away from. User-to-user isolation rides the host-only `aud` claim, not the cookie path. Unsafe writes need the CSRF mirror because SameSite is site-based, and sibling `*.{proxy}.usr.{domain}` origins are same-site.

### Reverse-proxy trust boundary

`devserver-proxy` strips hop-by-hop headers (RFC 7230 6.1) on both the request and response legs, **including every header named by the inbound `Connection` value** (also required by 6.1). It drops the inbound `Host`, `Cookie`, `Authorization`, and `X-Chan-CSRF` headers before forwarding (the gate cookies, CSRF mirror, and any user-presented PAT have no business at the tenant's upstream; auth on that leg is the entry handshake plus the tunnel trust boundary). It recomputes `X-Forwarded-For` as the socket peer only (the inbound chain is discarded), `X-Forwarded-Proto` from `FORWARDED_PROTO` (configured to match the terminator that fronts this listener; default `https`), and `X-Forwarded-Host` from the inbound `Host` header devserver-proxy itself routed on. Inbound `X-Forwarded-For` / `X-Forwarded-Host` / `X-Forwarded-Proto` from clients are NEVER trusted; nginx may not scrub them and the gateway must not assume it does. Upstream is reached over a yamux substream owned by an authenticated tunnel; there is no SSRF risk because the upstream URL is never user-supplied. `Set-Cookie` is left intact on the response leg so tenant content can set its own host-only cookies.

Request bodies are bounded by `MAX_REQUEST_BYTES` (default 100 MiB). Response bodies are bounded by `MAX_RESPONSE_BYTES` (default 100 MiB). Setting either to `0` disables the corresponding general cap. HTTP requests are bounded end-to-end by `REQUEST_TIMEOUT_SECS` (default 60s), including the response body stream; the same deadline wrapper aborts the upstream connection task on client drop. The sanctioned transfer routes have an explicit policy: `POST /{tenant}/api/files/upload` and `GET /{tenant}/api/files/{path}` with exactly one form-decoded, truthy `download` field allow 100 GiB request and response bodies with a 24-hour deadline, while `POST /{tenant}/api/fs/transfer` keeps the general byte caps and receives only the 24-hour deadline. Every other method, path, and query keeps the general policy. A non-HEAD response with a declared `Content-Length` above its effective cap returns 502 before body bytes are forwarded; HEAD is exempt because it carries no body, and responses without a declared length remain subject to the streaming cap. WebSockets bypass the total deadline and use a 300-second per-half idle timeout.

### Database pools

`profile` and `identity` each open a Postgres pool capped at 4 connections, both against the same gateway database. Postgres non-superuser slots are a shared resource; running both services on a single dev Postgres alongside running tests can otherwise run the slot count out. The cap is documented at each pool-build site. `devserver-proxy`, `admin`, and `gateway-common` hold no DB connection: devserver-proxy resolves identity over HTTP at handshake and keeps its live-tunnel state in an in-process registry.

### Atomic upserts in profile-service

The user / identity / email triangle has a known concurrent first-time-login race (two providers, same email, same user, in the same second). `profile-service` resolves it in a single transaction (`POST /v1/users/upsert-by-identity`); identity-service calls only that endpoint. New code that reaches across users and identities should use the same atomic shape rather than reimplement a multi-step dance.

### Service-to-service bearers

All bearers are `openssl rand -hex 32`; the authoritative per-service roster is each crate's `packaging/*.env` file. The cross-service ones:

- `PROFILE_AUTH_TOKEN`: identity-service -> profile-service service API. profile-service also accepts `PROFILE_ADMIN_TOKEN` here so a single-token deployment works; the middleware runs both checks unconditionally (`regular | admin`) so a wrong token never short-circuits on the first byte.
- `IDENTITY_INTERNAL_TOKEN`: devserver-proxy -> identity-service `/internal/v1/tokens/validate`. Required; no fallback to `PROFILE_AUTH_TOKEN`. Rotating one does not rotate the other.
- The devserver-control `/admin/v1/*` credentials are scoped per caller and rotation-capable (each accepts a list): `DEVSERVER_OPERATOR_ADMIN_TOKENS` for operator tooling, `DEVSERVER_IDENTITY_ADMIN_TOKENS`, and `DEVSERVER_PROFILE_ADMIN_TOKENS`. identity and profile present their own values via the singular `DEVSERVER_IDENTITY_ADMIN_TOKEN` / `DEVSERVER_PROFILE_ADMIN_TOKEN`, both required. devserver-control rejects a credential reused across scopes, so a leaked service-scope token never grants the operator tree.
- `DEVSERVER_PROXY_TOKEN`: devserver-proxy -> devserver-control `/v1/proxies/connect` control session. Distinct from the admin credentials on purpose: a proxy node holds no operator-admin credential.

Plus the asymmetric key pairs:

- `DEVSERVER_ENTRY_SIGNING_KEY` (identity only) and `DEVSERVER_ENTRY_VERIFYING_KEYS` (each proxy, a 1-2 key ring for rotation): Ed25519 keys for the 30s entry credential identity mints and devserver-proxy consumes at `/_chan/entry`. The proxy holds no signing key; a compromised node cannot mint entries.
- `DEVSERVER_ADMISSION_SIGNING_KEY` and `DEVSERVER_ADMISSION_VERIFYING_KEYS`: the parallel Ed25519 pair for devserver admission, spanning identity, devserver-control, and the proxy fleet; each crate's `design.md` records who signs and who verifies.

## Contributor Patterns

Per-crate rules that come up often when editing this code. For the full design rationale, read the crate's `design.md`.

### profile

- **Two-tier auth.** Routes use `PROFILE_AUTH_TOKEN` for the service API (`/v1/users/*`, the grant routes, `/v1/auth-audit`) and `PROFILE_ADMIN_TOKEN` for the admin tree (`/v1/admin/*`). Single-token deployments may set them to the same value; the service-API middleware accepts either.
- **Placeholder usernames are deterministic.** New rows seed `username = 'u' || substr(replace(uuid::text, '-', ''), 1, 12)`. identity-service renames on first sign-in; the hard cap of 4 lifetime renames is enforced in `update_username` via a CAS update. Don't invent an alternate seeding scheme.
- **All SQL is parameterized.** Constants like `USER_COLS` are `format!`'d into queries; user input always goes through `.bind()` and `$N`.
- **The devserver is the sharing unit.** `devserver_access(owner, devserver, caller)` is the single per-request access decision: `{access: true}` for the owner or a claimed grant, 404 in every other case (no-grant and unknown-devserver share one shape so the endpoint cannot enumerate shares). Access is binary; there are no roles. A grant gives the WHOLE devserver, not a single workspace; `create_devserver_grant` auto-bootstraps the parent `devservers` row so callers don't need a separate hop.
- **Block fans out server-side.** `POST /v1/admin/users/{id}/block` also calls devserver-control `kill_user_tunnels` (best-effort) when a `DevserverControlClient` is configured, so the live registrations drop across the proxy fleet at the same time the DB row changes.

### identity

- **OAuth providers are pluggable.** Each lives at `src/providers/<name>.rs` (github, gitlab, google) behind a small `Provider` trait. Registering a new provider requires one file plus wiring in `Config::from_env`.
- **PAT shape: `chan_pat_<32 random bytes, base64url, no pad>`.** Generated with `OsRng`; the database stores only the SHA-256(token) (base64url), so a table dump leaks no live secrets. Plaintext appears once on the create response.
- **The devserver id is the PAT digest.** `devserver_id_from_pat` is the lowercase-hex SHA-256 of the raw PAT (same digest as the stored hash, hex-encoded). One token identifies one devserver; this 64-char string is the cross-service handle the tunnel registry keys on and the `drv` claim carries. The raw PAT never leaves identity.
- **OAuth callback validates state before provider.** Plain `pending.provider != provider` runs only after a constant-time state compare so timing on the provider check can't be used to oracle the session's expected provider.
- **Session id rotates on login.** `session.cycle_id()` runs at the privilege boundary, before storing `user_id`. Closes session fixation.
- **Token revoke and account delete evict tunnels.** `DELETE /api/tokens/{id}` and profile delete fire devserver-proxy `kill_user_tunnels` best-effort after the DB update.
- **Entry-credential mint is the share-landing route.** `GET /s/{owner}` (whole-devserver open, owner-only) and `GET /s/{owner}/{workspace}` (per-tenant) resolve a live devserver of the owner's (`?d=` selector, single live, else first accessible), call `profile.devserver_access`, and mint a 30s Ed25519 entry credential (`drv` = that live `devserver_id`, `aud` = the tenant origin `{owner}--{disc}.{proxy}.usr.{domain}` built from the controller-reported node base) that the browser POSTs to the proxy's `/_chan/entry`, so the credential is minted at click time and never rides a URL.

### devserver-proxy

- **Apex vs wildcard.** The node apex (`{proxy}.usr.{domain}`): tunnel + healthz only (the aggregate admin tree lives on devserver-control). The node wildcard (`*.{proxy}.usr.{domain}`): tenant content only. A single axum router dispatches on the raw `Host` header (never the `Host` extractor, which would honor a spoofable `X-Forwarded-Host`). The h2c tunnel endpoint runs on a separate internal listener; nginx `grpc_pass`es `/v1/tunnel` to it.
- **The gate is per-devserver, not per-workspace.** `proxy::handle` parses `{owner}` plus the `--{disc}` discriminator out of the tenant host and verifies the session's `drv` against that devserver id. The `{workspace}` path segment is tenant routing only: it is forwarded into the tunnel unchanged (a segment-preserving forward) and the devserver routes each tenant internally. There is no path-segment gate key.
- **Auth gate order on the wildcard** (`proxy::handle`): an `/_chan/entry` request first validates method, exact Origin, exact Content-Type, and its bounded one-field form before consulting the registry, so 404, 403, 415, 400, and 413 response tuples do not reveal liveness; every entry-specific 404 uses one JSON shape regardless of `Accept`; no live devserver for the host -> 404; `/api/devserver/*` (the devserver's local-only management API) -> 404; a valid entry credential (exp + aud + drv + one-time jti + exactly-one-Origin) mints `__Host-devserver_gate` and `__Host-devserver_csrf`, then redirects 303 to the signed clean path; a valid `__Host-devserver_gate` session cookie -> pass through; unsafe HTTP methods also require `X-Chan-CSRF` matching the CSRF cookie; anything else -> 404 or 403 for a failed CSRF check after auth. Outside entry exchange, the negotiated 404 shape covers "unknown devserver", "no credential", and "wrong devserver in the cookie" so unauthenticated probes cannot enumerate registrations.
- **The proxy is not the access authority.** The gate never compares `sub` against the registry-cached `owner_id`: that would lock out every accepted grantee. identity already checked `devserver_access` before minting, so a validly-signed entry with the right `aud` and `drv` is the authorization assertion. The `aud` claim (= the inbound tenant host) is what enforces user-to-user isolation.
- **Bare wildcard root depends on credentials.** A naked tenant root with no gate session redirects to `DASHBOARD_URL` (the gateway dashboard on the identity origin) because devserver-proxy renders no UI. A root that carries a gate session falls through to the gate and forwards `/` to the devserver root, where the launcher SPA is served.
- **Hop-by-hop stripping is complete.** `HOP_BY_HOP_NAMES` lists the static names; `connection_listed_headers` parses the inbound `Connection` value and strips every name it lists. Both applied on every leg.
- **Two listeners, one Registry.** The h2c tunnel listener and the axum HTTP listener share the in-process `Registry`. A registration on the tunnel listener is visible to the proxy handler on the very next request.
- **Signature scheme hard-required.** `gateway_common::devserver_gate` accepts Ed25519 only for entry credentials; the gate cookie itself is an opaque proxy-local session id, not a signed token.

### admin

- **Three exit codes.** 0 success; 1 upstream/network error; 2 user input error (bad uuid, missing arg); 3 not found. Exit codes are part of the contract for shell wrappers.
- **`--json` everywhere.** TTY default is a `comfy_table` plain-text table; `--json` emits the same data as JSON for jq piping. Adding a new subcommand without `--json` is a regression.

### gateway-common

- **No axum / IntoResponse coupling in data-layer types.** `ProfileError`, `DevserverControlError`, `DevserverGateError`, and `Claims` are plain thiserror / serde. Each consumer maps via `From` for its local error.
- **`User` is the superset.** The struct carries every field profile-service can return; consumers ignore the fields they don't need. Don't fork the struct per consumer.
- **`devserver_gate` is the single source of the entry-credential shape.** Identity (mint) and devserver-proxy (verify + consume) call through this module. Ed25519 is hard-required on every verify, and the `aud` + `drv` claims are matched in-band by the caller. Gateway callers canonicalize `aud` as a lowercase host with default ports stripped and non-default ports preserved.

## Documentation

- **Workspace overview**: [`gateway/README.md`](../gateway/README.md)
- **Domain glossary**: [`gateway/CONTEXT.md`](../gateway/CONTEXT.md) fixes the devserver / library / workspace / tenant language; the decision behind the per-devserver model is [`gateway/docs/adr/0001-devserver-is-the-sharing-unit.md`](../gateway/docs/adr/0001-devserver-is-the-sharing-unit.md), the fleet control plane is [`gateway/docs/adr/0002-control-plane-owns-proxy-fleet-state.md`](../gateway/docs/adr/0002-control-plane-owns-proxy-fleet-state.md), and the shared control authority over tunnels and tenant sessions is [`gateway/docs/adr/0003-tunnels-and-tenant-sessions-share-control-authority.md`](../gateway/docs/adr/0003-tunnels-and-tenant-sessions-share-control-authority.md).
- **Crate design references** (canonical; `README.md` next to each is the consumer-facing entry):
  - [`gateway/crates/profile/design.md`](../gateway/crates/profile/design.md): schema, two-tier auth, atomic upsert, devserver grants, block fan-out.
  - [`gateway/crates/identity/design.md`](../gateway/crates/identity/design.md): OAuth providers, PAT lifecycle, session contract, entry-token mint, dashboard.
  - [`gateway/crates/devserver-proxy/design.md`](../gateway/crates/devserver-proxy/design.md): apex / wildcard split, devserver-gate verify, registry model, reverse-proxy hygiene.
  - [`gateway/crates/devserver-control/design.md`](../gateway/crates/devserver-control/design.md): proxy directory, fleet admission, aggregate admin tree, control protocol (frames in `devserver-control-proto`).
  - [`gateway/crates/admin/design.md`](../gateway/crates/admin/design.md): command surface, output contract, exit codes.
  - [`gateway/crates/gateway-common/design.md`](../gateway/crates/gateway-common/design.md): why a shared crate, what belongs and what does not.
- **Issue tracker**: GitHub repo `fiorix/chan`.
