# Gateway product control plane

> Status: shipped in [v0.79.0](../../release/release-v0.79.0.md): the gateway is administrable as a product boundary without database access, with explicit user access states, a durable per-user connected-devserver limit across the fleet, session and tunnel inspection and revocation, and an idempotent admin API. Account credentials and database roles are separated.

Consumer: the proprietary devsrv product. The contracts are deliberately generic gateway capabilities. No billing provider, product name, price, deployment topology, or devsrv-specific schema belongs in chan.

This document is self-contained. It consolidates every chan-side dependency needed by devsrv and supersedes the older devsrv notes about entitlement, account deletion, session `whoami`, resource limits, and distributed proxy administration.

The shared control-authority decision is recorded in [`gateway/docs/adr/0003-tunnels-and-tenant-sessions-share-control-authority.md`](../../../gateway/docs/adr/0003-tunnels-and-tenant-sessions-share-control-authority.md). Schema lands in `gateway/migrations/0016_gateway_control_plane.sql`.

## Goal

Make the chan gateway administrable as a product boundary without direct database access:

- enable, suspend, block, and restore users with explicit semantics;
- enforce a durable per-user connected-devserver limit across the proxy fleet;
- inspect and revoke OAuth account sessions, tenant browser sessions, and devserver tunnels;
- query OAuth history and fleet/user utilization;
- cut off one user or the whole tunnel fleet in an emergency and prevent reconnects;
- let an external account service push durable access policy through an idempotent admin API;
- keep operator use on `chan-gateway-admin` and machine use on the same scoped HTTP contracts.

The first consumer will configure an entitled user for three concurrently connected devservers. Three is a consumer policy value, not a chan default.

## Verified v0.77.0 baseline

v0.77.0 already provides:

- profile admin user list/get/create/update/rename/delete/block/unblock;
- PAT list/create/revoke and per-token audit;
- per-user auth audit;
- feature flags;
- devserver-control aggregate tunnel/proxy snapshots and watches;
- exact and owner-wide tunnel kills;
- subject/exact tenant-session revocation fan-out;
- an identity-signed 120-second admission lease;
- one fleet-wide positive `MAX_DEVSERVERS_PER_USER`;
- fail-closed controller readiness and proxy convergence;
- independent profile, identity, and controller admin credentials;
- `--json` on admin reads.

v0.77.0 does not provide:

- the internal OAuth-session `whoami` contract already consumed by devsrv-account;
- idempotent account-service admin routes for access revocation and deletion;
- durable per-user devserver limits;
- reversible per-user tunnel suspension;
- a persistent fleet admission pause;
- OAuth account-session inventory or exact revocation;
- tenant browser-session inventory;
- global auth-audit queries or aggregate utilization;
- CLI commands for tenant-session revocation or fleet-wide drain.

Do not implement those gaps in deployment shell, with direct SQL from another repository, or with query-time fan-out from devsrv. They belong behind the gateway's existing admin boundaries.

## Vocabulary and semantics

There are three different live session types:

- **OAuth session**: the identity-service `__Host-id_session` account cookie backed by `tower_sessions`.
- **Tenant session**: the proxy-local opaque `__Host-devserver_gate` browser session that authorizes tenant HTTP and WebSocket traffic.
- **Tunnel**: one connected `chan devserver` registration and its yamux transport.

The public/admin language must retain those distinctions. A generic `session` count with no type is ambiguous and must not be introduced.

User controls have three distinct meanings:

- **Block** is a security/account action. It prevents OAuth login, revokes every PAT, revokes OAuth and tenant sessions, kills owned tunnels, and prevents reconnects. Unblock never resurrects PATs.
- **Suspend devserver access** is reversible product policy. It preserves OAuth login and PAT rows, refuses PAT creation and tunnel admission, revokes tenant sessions for the user's owned devservers, and kills owned tunnels. Resume allows the existing unrevoked PATs to reconnect.
- **Fleet pause** is a global incident action. It persistently refuses new admission leases and PAT creation, drains all tenant sessions and tunnels, survives service restarts, and remains paused until an explicit resume.

## Architecture decisions

### Admin seam

`chan-gateway-admin` remains the human contract. Long-running services call the same documented HTTP APIs directly with scoped credentials. No service shells out to the CLI, parses table output, or receives a database credential.

All new CLI read commands support `--json`. Secret values, cookie IDs, PATs, admission leases, and internal tower-session IDs never appear in list output, error chains, tracing fields, or debug formatting.

### Durable policy owner

Profile owns durable user and fleet devserver policy. Identity reads the policy while creating a PAT and while validating a PAT for tunnel admission. Devserver-control enforces the signed per-user limit carried by the admission lease.

This keeps:

- durable policy beside the canonical user;
- billing/product logic outside chan;
- the controller database-free;
- proxy nodes free of profile/database/operator credentials;
- the admission decision independently verifiable from the signed lease.

### Push, not entitlement pull

An external product service pushes the resolved policy projection through the identity admin API. Chan does not know how a subscription or entitlement is calculated.

The push is idempotent:

1. persist the new policy;
2. when the change is stricter, revoke affected tenant sessions and kill owned tunnels;
3. report success only after every required controller command is confirmed.

If step 2 fails, the stricter policy remains durable and the API returns a retryable failure. A retry repeats the drain and converges. New admissions already fail against the durable policy.

### Existing safety ceiling remains

`MAX_DEVSERVERS_PER_USER` stays a required positive fleet safety ceiling with its current default. The effective limit is:

```text
min(MAX_DEVSERVERS_PER_USER, signed user policy limit)
```

Per-user policy cannot relax the deployment ceiling.

## Database additions

Add the next gateway migration after v0.77.0 migration 15.

### `devserver_user_policies`

```sql
CREATE TABLE devserver_user_policies (
    user_id                   uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    enabled                   boolean NOT NULL,
    max_connected_devservers  integer NOT NULL
                              CHECK (max_connected_devservers > 0),
    updated_at                timestamptz NOT NULL DEFAULT now()
);
```

No row means the compatibility default: enabled with the controller's fleet ceiling. Deployments that need deny-by-default policy set `DEVSERVER_POLICY_REQUIRED=true` on identity. In required mode, no row means disabled.

Do not add plan, product, price, subscription, entitlement-source, or provider columns.

### `devserver_fleet_policy`

```sql
CREATE TABLE devserver_fleet_policy (
    singleton            boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    admissions_enabled   boolean NOT NULL,
    updated_at           timestamptz NOT NULL DEFAULT now()
);

INSERT INTO devserver_fleet_policy (singleton, admissions_enabled)
VALUES (true, true);
```

The singleton row is the persistent fleet pause. Missing or unreadable state fails closed in identity.

### `identity_session_index`

```sql
CREATE TABLE identity_session_index (
    admin_session_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    store_id          text NOT NULL UNIQUE,
    authenticated_at  timestamptz NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX identity_session_index_user_idx
    ON identity_session_index (user_id, authenticated_at DESC);
```

`store_id` is the tower-session key and is a bearer secret. It is never serialized or logged. It is stored only because exact revocation must delete the corresponding `tower_sessions` record. The database already contains the same key in the tower store.

Do not add a foreign key to the tower-sessions schema. Store migration order and expired-record cleanup make that coupling invalid.

## Profile changes

### User policy store and routes

Add profile admin routes:

```text
GET  /v1/admin/users/{user_id}/devserver-policy
PUT  /v1/admin/users/{user_id}/devserver-policy
GET  /v1/admin/devserver-policy
PUT  /v1/admin/devserver-policy
```

User PUT request:

```json
{
  "enabled": true,
  "max_connected_devservers": 3
}
```

User GET/PUT response:

```json
{
  "user_id": "uuid",
  "enabled": true,
  "max_connected_devservers": 3,
  "updated_at": "rfc3339"
}
```

Fleet GET/PUT body:

```json
{
  "admissions_enabled": false,
  "updated_at": "rfc3339"
}
```

PUT is a single upsert and is idempotent. A missing user returns 404. A zero/negative/out-of-range limit returns 400. Use a named finite maximum accepted by the API; the controller safety ceiling still wins at admission.

These profile routes persist only. Composite drain semantics live on identity's operator tree below.

### Global auth audit

Add:

```text
GET /v1/admin/auth-audit
```

Supported filters:

- `user_id=<uuid>`;
- `action=<exact action>`;
- `since=<rfc3339>`;
- `until=<rfc3339>`;
- `limit=1..500`, default 100;
- `offset>=0`, default 0.

Sort by `(ts DESC, id DESC)`. Return the existing `AuthAudit` wire shape. Invalid filters return 400. An empty result is `[]`.

Add:

```text
GET /v1/admin/overview?since=<rfc3339>
```

Response:

```json
{
  "generated_at": "rfc3339",
  "users_total": 10,
  "users_active": 8,
  "users_blocked": 2,
  "users_logged_in_since": 5,
  "login_events_since": 7
}
```

`users_logged_in_since` is `COUNT(DISTINCT user_id)` over `action='login'`; `login_events_since` is the event count. The endpoint is an aggregate query, not an unbounded audit scan.

### Block fan-out

Keep the current transactional block behavior: set `blocked_at`, revoke live PATs, write one canonical audit row, enqueue/fan out controller revocation.

Extend the composite admin flow so `chan-gateway-admin user block` also:

- revokes every OAuth session for the user through identity;
- revokes tenant sessions where the user is subject;
- kills every owned tunnel.

The durable block is never rolled back if a drain fails. The command exits non-zero with a partial report until a retry confirms every revocation.

## Identity changes

### Internal OAuth-session `whoami`

Add to the existing `IDENTITY_INTERNAL_TOKEN` router:

```text
POST /internal/v1/sessions/whoami
```

Request:

```json
{"session":"raw __Host-id_session cookie value"}
```

Success:

```json
{
  "user": {
    "id": "uuid",
    "username": "alice",
    "blocked": false
  },
  "session": {
    "authenticated_at": "rfc3339"
  }
}
```

Malformed, unknown, expired, pre-auth, deleted-user, and blocked-user sessions all return the same 401 shape. The raw session value is never logged.

The OAuth callback:

1. completes the existing state/provider checks;
2. calls `session.cycle_id()`;
3. stamps `authenticated_at`;
4. stores `user_id`;
5. inserts/upserts `identity_session_index` with the post-cycle store ID.

Sessions predating this release have no index/stamp and fail `whoami` closed. No migration tries to infer authentication time.

Logout and profile deletion remove the index row and tower record. List/revoke paths lazily delete index rows whose tower record is absent or expired.

### OAuth-session admin

Add to the existing `IDENTITY_ADMIN_TOKEN` router:

```text
GET  /admin/v1/sessions
POST /admin/v1/sessions/{admin_session_id}/revoke
POST /admin/v1/users/{user_id}/sessions/revoke
GET  /admin/v1/sessions/overview
```

List filters:

- `user_id=<uuid>`;
- `limit=1..200`, default 100;
- `offset>=0`, default 0.

List item:

```json
{
  "id": "admin uuid",
  "user_id": "uuid",
  "authenticated_at": "rfc3339",
  "expires_at": "rfc3339"
}
```

Never return `store_id`. Exact and user-wide revoke are idempotent and return confirmed counts:

```json
{"oauth_sessions_revoked":2}
```

Overview:

```json
{
  "generated_at": "rfc3339",
  "oauth_sessions_active": 12
}
```

### Existing devsrv account admin contract

Add:

```text
POST   /admin/v1/users/{user_id}/access/revoke
DELETE /admin/v1/users/{user_id}
```

Access revoke:

1. revoke every live PAT;
2. write one canonical `access_revoked` auth-audit row;
3. revoke the user's OAuth sessions;
4. revoke the user's tenant sessions as subject;
5. kill the user's owned tunnels.

Success:

```json
{
  "user_id": "uuid",
  "username": "alice",
  "pats_revoked": 2,
  "oauth_sessions_revoked": 1,
  "tenant_sessions_revoked": 3,
  "tunnels_evicted": 2
}
```

Delete:

1. perform the same access cut;
2. delete all OAuth sessions;
3. trigger/complete the existing profile account-deletion settlement;
4. delete the profile row only after controller revocation settlement proves the quiet-window cuts.

Success is idempotent, including an already-absent user:

```json
{
  "user_id": "uuid",
  "profile_existed": false,
  "sessions_deleted": 0
}
```

Every completed step is durable. A downstream failure returns 502 and is safe to retry. Do not return 200 for best-effort eviction.

### Composite user policy API

Add:

```text
GET /admin/v1/users/{user_id}/devserver-policy
PUT /admin/v1/users/{user_id}/devserver-policy
```

Identity delegates persistence to profile. On a transition that disables access or lowers the limit, it then:

1. revokes tenant sessions whose owner is `user_id`;
2. kills every tunnel owned by `user_id`;
3. returns the persisted policy and confirmed drain counts.

Draining all owner tunnels on a limit reduction is intentional. Reconnects race through the controller and converge under the new cap; choosing arbitrary live winners in an HTTP handler would duplicate controller policy.

Response:

```json
{
  "policy": {
    "user_id": "uuid",
    "enabled": true,
    "max_connected_devservers": 3,
    "updated_at": "rfc3339"
  },
  "tenant_sessions_revoked": 2,
  "tunnels_evicted": 2
}
```

If persistence succeeds and drain fails, return 502 with no secret or raw downstream body. A retry must detect the already-persisted stricter policy and repeat the drain.

Raising the limit or resuming access needs no drain.

### Fleet pause API

Add:

```text
POST /admin/v1/fleet/pause
POST /admin/v1/fleet/resume
GET  /admin/v1/fleet
```

Pause:

1. persist `admissions_enabled=false` through profile;
2. revoke all tenant sessions through control;
3. kill all tunnels through control;
4. report success only after every reachable authority confirms.

Success:

```json
{
  "admissions_enabled": false,
  "tenant_sessions_revoked": 20,
  "tunnels_evicted": 8
}
```

If any proxy authority is warming, disconnected-but-retained, timed out, or otherwise unconfirmed, return 502. The durable pause remains in force and retries converge.

Resume only persists `admissions_enabled=true`. It never reconnects clients itself.

### PAT creation and validation policy

Both browser/admin PAT creation and admission validation read:

- `users.blocked_at`;
- `devserver_fleet_policy.admissions_enabled`;
- the effective `devserver_user_policies` row;
- `DEVSERVER_POLICY_REQUIRED`.

Behavior:

- blocked: preserve existing denial;
- fleet paused: refuse PAT creation and admission;
- user disabled: refuse PAT creation and admission;
- required mode with no row: refuse PAT creation and admission;
- enabled: mint/validate normally.

Public PAT creation returns 403 with stable reason `devserver_access_disabled`. Admin PAT creation returns 409 with the same reason. Internal token validation keeps its existing uniform 401 so it does not become a token/policy oracle.

Token listing and token revocation remain available while disabled or paused. OAuth login remains available for a suspended, unblocked user.

## Admission lease and controller changes

### Signed limit

Add this claim to `AdmissionLeaseClaims`:

```rust
pub max_connected_devservers: u32
```

It is authorization state, not part of `AdmissionLeaseBinding`. The signer validates it as positive and finite. The verifier rejects a missing, zero, or out-of-range value.

The control protocol version must increment because snapshots, deltas, and admission semantics change. Package-version lockstep remains mandatory.

Every tunnel row and pending claim retains the verified signed limit. The proxy cannot supply or modify it separately.

### Admission

For a new key, controller capacity uses the effective signed limit and the existing global ceiling. Reconnect neutrality remains unchanged for the same `(owner_user_id, devserver_id)` key.

Pending claims, active rows, staged rows, and disconnected retained authority all consume the per-user count exactly as they do under the current global cap.

For a reconciliation snapshot containing different still-valid limits for one owner, use the minimum signed limit represented by that owner's rows. This is fail-closed during the maximum 120-second policy transition window. A policy increase can therefore take one lease refresh to become effective; a decrease is accompanied by the composite owner drain.

Expose `max_connected_devservers` on the redacted `TunnelView` so operators can explain an `AtCapacity` decision without seeing a credential.

## Tenant browser-session inventory

### Proxy-local record

Keep the cookie/session ID secret. Add a separate random UUID `admin_session_id` to `SessionRecord`, plus wall-clock `created_at` and `expires_at` values for admin views. Continue using `Instant` for enforcement.

Admin view:

```json
{
  "id": "admin uuid",
  "subject_user_id": "uuid",
  "owner_user_id": "uuid",
  "devserver_id": "hex id",
  "proxy_id": "p1",
  "created_at": "rfc3339",
  "expires_at": "rfc3339"
}
```

Do not expose the cookie ID, entry `jti`, raw audience, caller assertion, peer address, or cancellation internals.

### Control protocol

Browser-session state joins the controller's authoritative snapshot/delta model:

- initial/resync snapshot includes bounded browser-session chunks;
- `BrowserSessionUp` and `BrowserSessionDown` extend the same contiguous generation as tunnel deltas;
- a generation gap retracts both tunnel and browser-session authority and forces one resync;
- session rows are invisible until the proxy reaches Active/FleetReady;
- controller loss keeps the existing proxy grace behavior;
- a disconnected retained authority makes a global or targeted revocation incomplete, never a false zero.

Set explicit per-proxy and fleet row/byte bounds derived from `SESSION_MAX_ACTIVE`; reject oversized snapshots before allocation. Browser-session events count against the existing bounded inbound frame rate.

Extend `SessionRevocation` with:

```rust
SessionId { admin_session_id: Uuid }
Owner { owner_user_id: Uuid }
All
```

Keep existing `Exact` and `Subject`. Exact revocation by admin UUID must lookup-deactivate, abort registered HTTP/WebSocket transports, wait for drain, and acknowledge only after removal, matching current revocation safety.

### Controller admin routes

Add:

```text
GET  /admin/v1/browser-sessions
GET  /admin/v1/browser-sessions/watch
POST /admin/v1/browser-sessions/{admin_session_id}/revoke
POST /admin/v1/browser-sessions/subjects/{user_id}/revoke
POST /admin/v1/browser-sessions/owners/{user_id}/revoke
POST /admin/v1/browser-sessions/revoke-all
POST /admin/v1/tunnels/kill-all
GET  /admin/v1/overview
```

List filters:

- `subject_user_id=<uuid>`;
- `owner_user_id=<uuid>`;
- `proxy_id=<id>`.

The list and watch have the same readiness semantics as tunnel/proxy reads. A warming controller returns 503; it never returns an authoritative empty list.

Mutation responses contain confirmed counts. Any unconfirmed proxy or drain timeout returns 502 with the confirmed count and remains safe to retry.

Overview:

```json
{
  "generated_at": "rfc3339",
  "proxies_connected": 2,
  "proxies_ready": 2,
  "devservers_connected": 8,
  "tenant_sessions_active": 20
}
```

## `chan-gateway-admin` surface

Retain existing command names and add:

```text
chan-gateway-admin policy get <ident>
chan-gateway-admin policy set <ident> --enabled --max-connected-devservers N
chan-gateway-admin policy suspend <ident>
chan-gateway-admin policy resume <ident>

chan-gateway-admin session oauth ps [--user <ident>]
chan-gateway-admin session oauth revoke <session-id>
chan-gateway-admin session oauth revoke-user <ident>

chan-gateway-admin session tenant ps [--subject <ident>] [--owner <ident>] [--proxy <id>]
chan-gateway-admin session tenant watch [same filters]
chan-gateway-admin session tenant revoke <session-id>
chan-gateway-admin session tenant revoke-subject <ident>
chan-gateway-admin session tenant revoke-owner <ident>

chan-gateway-admin audit ps [--user <ident>] [--action <action>] [--since <rfc3339>] [--until <rfc3339>]

chan-gateway-admin fleet pause --drain
chan-gateway-admin fleet resume
chan-gateway-admin fleet status

chan-gateway-admin overview [--since <duration>]
```

Rules:

- `policy suspend` preserves the stored limit.
- `policy resume` requires an existing policy; it does not invent a limit.
- `fleet pause` always drains; there is no misleading pause-with-live-tunnels mode.
- `<ident>` uses the existing UUID/email/username resolver.
- all read commands and all mutation reports support `--json`;
- TTY tables remain ASCII and target 80 columns;
- stdout contains data, stderr contains warnings/partial-failure diagnostics;
- existing exit codes 0/1/2/3 remain unchanged;
- partial composite success exits 1 and prints the durable state plus confirmed counts in JSON mode.

`overview` calls the three bounded aggregate endpoints, not list-and-count loops. JSON:

```json
{
  "generated_at": "rfc3339",
  "since": "rfc3339",
  "users": {
    "total": 10,
    "active": 8,
    "blocked": 2,
    "logged_in_since": 5,
    "login_events_since": 7
  },
  "sessions": {
    "oauth": 12,
    "tenant": 20,
    "tunnels": 8
  },
  "proxies": {
    "connected": 2,
    "ready": 2
  },
  "fleet_admissions_enabled": true
}
```

## Authentication and secret boundaries

- Profile policy/audit routes use `PROFILE_ADMIN_TOKEN`.
- Identity session/composite routes use `IDENTITY_ADMIN_TOKEN`.
- Controller inventory/revocation routes preserve operator/identity/profile scope separation.
- Proxy nodes retain only their proxy credential, identity-internal PAT-validation credential, admission/entry verifying keys, and data-plane material.
- No proxy receives an operator, profile, database, OAuth, policy-write, or signing credential.
- Every bearer comparison remains constant-time.
- CLI clients never reuse one service credential against another destination.
- Raw downstream bodies are not propagated across composite admin errors.

## Failure and concurrency requirements

- Policy upserts are transactional and idempotent.
- Two concurrent admissions at the last slot yield exactly one `Admit` and one `AtCapacity`.
- A stricter persisted policy wins even when its drain partially fails.
- A paused fleet stays paused across identity, profile, controller, and proxy restarts.
- Admission refuses when policy state cannot be read; management reads may return explicit upstream failure but never guess.
- Existing tunnels cannot live indefinitely under stale policy: their 120-second lease refresh fails while suspended/paused, and the proxy closes them.
- Snapshot/reconciliation uses the smallest valid signed cap for mixed leases.
- Revocation reports complete only after active transports drain.
- Controller warming/disconnected authority returns 503/502 as appropriate, never authoritative zero.
- OAuth-session index residue is harmless: list/revoke prunes a row when the tower record is absent or expired.
- An OAuth session created before indexed sessions exist is not treated as recently authenticated.

## Tests

### Profile

- migration constraints and singleton seed;
- required and compatibility-default policy resolution;
- policy upsert/get, missing user, invalid limit, and concurrent updates;
- global pause persistence;
- global auth-audit filters, pagination, stable ordering, and overview distinct-user counts;
- block remains transactional and queues revocation.

### Identity

- full OAuth login stamps `authenticated_at` after ID rotation and indexes the final store ID;
- `whoami` success plus uniform refusal for malformed, expired, pre-auth, blocked, and deleted sessions;
- OAuth session list never serializes `store_id`;
- exact/user-wide revoke removes tower and index records idempotently;
- PAT creation and admission behavior for enabled, disabled, missing-required, paused, and blocked policies;
- internal validation preserves uniform 401;
- admission leases contain the signed positive limit;
- composite policy decrease/suspend persists before drain and retries a partial drain;
- fleet pause persists before drain, survives restart, and retries;
- account revoke/delete endpoints converge from every partial step.

### Protocol, control, and proxy

- lease tamper/missing/zero/oversized limit refusal;
- global ceiling versus signed user ceiling;
- exact last-slot admission concurrency;
- reconnect neutrality;
- mixed-cap reconciliation uses the minimum;
- browser-session snapshot/delta convergence and generation-gap resync;
- session row/byte/rate bounds;
- exact/subject/owner/all session revocation and drain timeout;
- kill-all idempotence and partial proxy failure;
- overview and watch readiness semantics;
- debug/error output never contains cookie IDs, admission leases, or credentials.

### Admin CLI

- every new read and mutation report in TTY and JSON mode;
- identity resolution ambiguity/not-found behavior;
- composite partial failure exits 1 with durable state visible;
- existing exit codes remain pinned;
- overview uses bounded aggregate routes;
- `policy resume` refuses a missing policy;
- fleet pause always requests drain.

### End-to-end

Run at least a two-proxy fleet:

1. Set one user to three connected devservers.
2. Connect three distinct PAT/devservers across both proxies.
3. Confirm a fourth concurrent admission is refused.
4. Reduce the limit to one; confirm all old tunnels drain and only one reconnects.
5. Suspend the user; confirm PAT rows remain, tunnels/sessions drain, and reconnect fails.
6. Resume; confirm an existing unrevoked PAT reconnects.
7. Block; confirm OAuth/tenant/tunnel state drains and PATs are revoked.
8. Unblock; confirm old PATs still fail.
9. Pause the fleet; confirm all proxies drain, admission fails, and restart does not clear pause.
10. Resume and confirm normal admission.
11. Create/revoke exact OAuth and tenant sessions and verify all three session counts.
12. Confirm global OAuth history and overview counts match the generated events.

## OAuth post-login return path

The identity login endpoint needs one small, general same-origin redirect contract so a product account flow can return to its account surface instead of the site root:

```http
GET /auth/{provider}?return_to=%2Faccount%2F
```

- `return_to` is optional; omitting it preserves the existing `/` destination.
- Accept only an origin-relative path beginning with exactly one `/`.
- Reject absolute URLs, scheme-relative paths, backslashes, fragments, userinfo, control characters, and malformed percent encoding with `400 Bad Request`. Do not silently replace an invalid value with `/`.
- A query string on a valid path is allowed. Compare the parsed target origin with the configured public origin before accepting it.
- Store the validated target in the OAuth login session before leaving for the provider, alongside but separate from state/PKCE data.
- Consume the target exactly once after a successful callback and final session-ID rotation. Refreshing or replaying the callback must not reuse it.
- If product authorization later refuses the authenticated user with `oauth_login`, redirect to the same validated target with a stable `denied=oauth_login` query marker. Preserve any existing safe query parameters.
- Never put the raw target in structured logs or provider state, and do not weaken the existing state, nonce, or PKCE checks.

The devsrv product will use `/account/`. The contract is intentionally generic and remains useful to any same-origin product surface without adding devsrv-specific code to chan.

Tests must cover the default destination, `/account/`, a safe path with query parameters, absolute and scheme-relative URLs, encoded slash/backslash variants, control characters, malformed encoding, one-time consumption, callback replay, and unchanged state/PKCE refusal behavior.

## Documentation and compatibility

Update the canonical gateway design docs in the same commit as implementation:

- profile schema/admin policy/global audit;
- identity session, policy, account, and admin contracts;
- devserver-control protocol, inventory, revocation, and cap semantics;
- devserver-proxy session publication;
- admin CLI commands/output/exit codes;
- gateway context if session terminology needs clarification;
- protocol ADR if the combined tunnel/session snapshot changes the existing control-plane decision.

Preserve:

- `chan devserver`;
- `chan_pat_*`;
- `CHAN_ADMIN_*`;
- `CHAN_TUNNEL_*`;
- `/.well-known/chan-gateway`;
- `/chan-mark.png`;
- public `fiorix/chan-gateway-*` package/image names.

All gateway services, admin packages, and proxies ship at one immutable equal version. No `latest`, mixed-version fallback, direct SQL operator path, compatibility proxy mode, or old-protocol bridge is added.

## Suggested implementation order

1. Schema, profile policy store/routes, global audit, and aggregate stats.
2. Admission-lease claim and controller per-user cap enforcement.
3. Identity policy enforcement and composite policy/fleet operations.
4. OAuth `whoami`, session index, session admin, account admin, and safe `return_to` contracts.
5. Proxy browser-session IDs plus control snapshot/delta aggregation and revocation.
6. Admin CLI commands and overview.
7. Cross-service integration tests, docs, packaging, and full release gate.

The release is complete only when the exact immutable package set contains profile, identity, devserver-control, devserver-proxy, and admin with all tests above green.

## Out of scope

- billing providers, prices, subscriptions, invoices, and entitlement calculation;
- deployment hosts, DNS, TLS, WireGuard, sdme, containers, and promotion;
- CPU, memory, storage, bandwidth, request, or workspace quotas;
- per-proxy or per-region user limits;
- per-workspace access limits;
- durable controller membership or controller HA;
- a web admin UI;
- Prometheus/OTel export;
- batch admin mutation input.
