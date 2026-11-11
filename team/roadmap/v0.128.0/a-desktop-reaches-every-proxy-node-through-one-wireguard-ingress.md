# A desktop reaches every proxy node through one WireGuard ingress

Status: raised by the owner on 2026-11-08 while planning the chan.app WireGuard rollout; proposed for v0.126.0 and moved to v0.127.0 by the owner on 2026-11-08; moved to v0.128.0 by the owner on 2026-11-09; the gateway lane was built on 2026-11-10 on `feat/wireguard-ingress-per-node-gateway` (61 commits over `77c872a8d`, with the integration branch merged in up to `e10d622a4`, gated at `da75ff666`), reviewed and merged into the integration branch on 2026-11-11 (`2a912e0e3`); the desktop discovery, enrollment storage, migration, per-ingress fabric and reconciliation, registry/UI projection and desktop enrollment/reconcile harness are built; native guest and real gateway/desktop verification remain open. The build stands on the recommended answers to D1, D2, D3 and D5 and on the owner's ruling of 2026-11-10 on contract 6. Acceptance 1 and 5 hold, and so does the agent half of 3, with the evidence below. Acceptance 2's discovery, enrollment, migration, fabric, reconciliation and per-ingress projection cases are covered; the desktop half of 3 and acceptance 4 remain open. Supersedes the v0.125.0 decision "one WireGuard ingress endpoint per gateway, served to the desktop by discovery and the redeem, with no list of ingress hosts distributed to desktops and more regions the operator's concern behind that one endpoint, and one tunnel per gateway row on the desktop" ([release-v0.125.0](../../release/release-v0.125.0.md), decisions, line 60).

Asked by the owner on 2026-11-08 after reading what a second proxy node would need under v0.125.0 ("with gw, are we funneling bidirectional traffic through that host? it'll become a bottleneck quickly"), and decided the same day: no v0.125.0 rollout on chan.app; each devserver-proxy node terminates its own WireGuard and the desktop reaches the node a devserver is connected to directly, in v0.126.0 ("i prefer to make the changes and release v126").

Line numbers below are at `c998d0327` (v0.125.0 plus docs). v0.126.0 and v0.127.0 carry v0.125.0's enrollment and migrations unchanged, so a v0.125.0 desktop, gateway or enrolled row below stands for any of the three releases.

## What is there now

Tenant traffic today goes from the desktop straight to the proxy node that holds the devserver's tunnel: a tenant origin is `{owner}--{disc}.{proxy_id}.{proxy apex}` (`gateway/crates/identity/src/config.rs:237-257`, `tenant_origin_for`), and the node's TLS edge for `*.{proxy_id}.{proxy apex}` answers it. The gateway's central services (identity, profile, control) carry no tenant bytes.

v0.125.0's enrollment cannot keep that shape once a gateway has more than one node:

1. Identity holds one ingress. `wireguard_from_vars` (`gateway/crates/identity/src/config.rs:446-547`) reads one `WIREGUARD_HOST_ID`, `WIREGUARD_ENDPOINT`, `WIREGUARD_PUBLIC_KEY`, `WIREGUARD_ALLOWED_IPS` and `WIREGUARD_HOSTS` into one `WireguardEnrollment` (`gateway/crates/identity/src/wireguard.rs:17-32`). Discovery carries one `wireguard: {endpoint, public_key}` (`gateway/crates/identity/src/http.rs:332-354`), and the redeem answers one peer (`RedeemPayload.wireguard`, `desktop_authorize.rs:197-207`; `Parameters`, `wireguard.rs:35-44`).
2. `WIREGUARD_HOSTS` names only the proxy origin's host, the tunnel origin's host or `*.{proxy host}` (`config.rs:517-518`); a per-node name such as `*.p1.proxy.example.test` is refused and a test pins it (`config.rs:1169`). So every node's tenants map to the one ingress through `*.{proxy host}`, which the desktop matches at any depth (`crates/chan-wireguard/src/proxy.rs:113-129`).
3. With a second node, every enrolled desktop's traffic for every node enters the one ingress host, which must forward it to the owning node (an SNI router plus a backbone the operator builds). That host carries each forwarded byte in and out, adds its round trip to every request, and is a single point of failure for every enrolled desktop. The detour also cuts throughput, not only latency: chan-wireguard's sockets hold 256 KiB per direction (`crates/chan-wireguard/design.md:85`), so one connection moves at most about 256 KiB per round trip.
4. Profile ties one peer to one host and one PAT. `wireguard_peers` has `token_id UNIQUE`, `UNIQUE (host, public_key)`, `UNIQUE (host, address_v4)` and `UNIQUE (host, address_v6)` (`gateway/migrations/0017_wireguard_peers.sql`); allocation looks only at the host's own rows (`gateway/crates/profile/src/wireguard.rs:254-259`) under a per-host advisory lock (`:235`), so the same address is handed out on two hosts (test `wireguard_pool_exhaustion_is_409`, `gateway/crates/profile/tests/api.rs:219`). Identity always enrolls on its single `host_id` (`desktop_authorize.rs:604-678`).
5. The desktop holds one tunnel per gateway row. `WireguardFabric.rows` is keyed by gateway id with one `Tunnel` per `Row::Running` (`desktop/src-tauri/src/wireguard.rs:64-99`); the proxy route id is the gateway id (`adopt`, `:143-217`); the row stores one client file `<id>.conf`, one host map and one enrolled key (`desktop/src-tauri/src/config.rs:119-181`, `wireguard_keys.rs:26,31`); the client file format takes exactly one `[Peer]` (`crates/chan-wireguard/src/config.rs:527`).
6. An agent whose host id identity does not know wipes its peers: identity checks only the label's syntax and relays profile (`gateway/crates/identity/src/wireguard.rs:82-111`), profile answers 200 with an empty list (`profile/src/wireguard.rs:278-329`), and the agent removes every peer it manages.

What already fits per-node ingress:

- The agent has nothing single-ingress in it: one agent per node, its own `WIREGUARD_AGENT_HOST_ID`, polling `?host=` and refusing a body whose `host` differs (`gateway/crates/wireguard-agent/src/identity.rs:122-128`). configure.sh already sets the host id to the node id (`packaging/gateway/scripts/configure.sh:320`).
- The desktop's `ConnectProxy` holds any number of routes, each its own tunnel and host map (`crates/chan-wireguard/src/proxy.rs:182-186`, route lookup `Router::mapped` and `tunnel_for` at `:370-391`). A mapped name connects through its own route's tunnel to its mapped address (`:830-831`), and `check_route` (`:135-163`) refuses no overlap, so two routes may map different names to the same tunnel address. No test pins that yet: `two_tunnels_route_by_destination` (`:1270`) routes two tunnels over different subnets by AllowedIPs, with no host maps. Each `Tunnel` has its own UDP socket, session, index and stack (`crates/chan-wireguard/src/tunnel.rs:147-180`, `:429-455`), so one private key in several tunnels at once is fine.
- Node naming is already code, not convention: a node base is exactly one label under the proxy origin, equal to the signed `proxy_id` (`identity/src/config.rs:268-322`, `validate_node_base`).

## Desired contract

1. **One WireGuard ingress per proxy node.** Each devserver-proxy node that offers WireGuard runs its own kernel interface and its own agent. The ingress id is the node's `DEVSERVER_PROXY_ID`. Every ingress answers on the same tunnel address(es), and every ingress lists every enrolled peer.
2. **Identity configures a list.** It reads:
   - `WIREGUARD_INGRESSES`: entries `id=public_key@endpoint`, separated by `;`. `id` is a `ProxyId` label, `public_key` is canonical base64 (`canonical_public_key`), and `endpoint` follows `validate_wireguard_endpoint`. Ids must be unique; keys and endpoints may repeat.
   - `WIREGUARD_INGRESS_ADDRESSES`: the address(es) every ingress interface answers on inside the tunnel, at most one IPv4 and one IPv6, each inside `WIREGUARD_ALLOWED_IPS`.
   - `WIREGUARD_ALLOWED_IPS` and `WIREGUARD_PERSISTENT_KEEPALIVE`, same meaning and defaults as today. They apply to every ingress.
   - The rule is all-or-none over `WIREGUARD_INGRESSES`, `WIREGUARD_INGRESS_ADDRESSES` and `WIREGUARD_ALLOWED_IPS`.
   - The v0.125.0 names `WIREGUARD_HOST_ID`, `WIREGUARD_ENDPOINT`, `WIREGUARD_PUBLIC_KEY` and `WIREGUARD_HOSTS` refuse startup when set, with a message naming their replacement (decision D2).
   - Identity derives each ingress's host map: `{id}.{proxy host}` and `*.{id}.{proxy host}`, both mapped to `WIREGUARD_INGRESS_ADDRESSES`, where `{proxy host}` is `DEVSERVER_PROXY_ORIGIN`'s host. These are exactly the node base and tenant names identity already builds. No operator-written host map remains.
3. **Discovery lists the ingresses.** `wireguard` stays an object, so a v0.125.0 desktop still decodes it. It keeps `endpoint` and `public_key`, set to the first ingress. It gains `allowed_ips`, `persistent_keepalive` (omitted when off) and `ingresses: [{id, endpoint, public_key, hosts: [{name, addresses}]}]`. Discovery carries everything a desktop needs to start a tunnel to any ingress except the desktop's own address and key.
4. **The redeem answers one address and the list.** `wireguard` keeps today's fields with these values:
   - `server_public_key`, `endpoint` and `hosts`: the first ingress;
   - `addresses`: the peer's one address set, valid on every ingress;
   - `allowed_ips` and `persistent_keepalive`: unchanged.
   - It gains `ingresses: [{id, endpoint, server_public_key, hosts}]`, equal to discovery's list.
   - Consequences: a v0.125.0 desktop enrolls against the first ingress and reaches the other nodes over their public path, and a v0.128.0 desktop starts one tunnel per ingress.
5. **One peer per key, gateway-wide.** Profile enrolls a peer once, independent of hosts, with one address set unique across the gateway, under one gateway-wide advisory lock. `GET /v1/wireguard/peers?host=` returns every active peer whatever the host, and still echoes `host` in the body (the agent requires it). Migration 18 drops `host` from `wireguard_peers` and its per-host uniques, and adds `UNIQUE (public_key)`, `UNIQUE (address_v4)` and `UNIQUE (address_v6)`. It keeps `token_id UNIQUE` (one peer per PAT). Before the new uniques, it deletes the older of any duplicate rows by `updated_at`; a desktop whose row it deletes signs in again. The sweeper releases gateway-wide with the same grace rules. Revoke, expiry and block drop the peer from every ingress at once.
6. **Identity guards the agent route.** While enrollment is configured, `GET /internal/v1/wireguard/peers?host=` answers 404 for a host that is not a configured ingress id, so an agent whose host id identity's list lacks keeps its last list, and both sides log it at warn. While enrollment is not configured, the route relays profile's list for any well-formed host, so a revoke still reaches every interface. One `WIREGUARD_AGENT_TOKEN` stays shared by every agent (decision D5). Identity keeps sending `host` (the first ingress id) in profile's enroll body for one release, so a profile one release behind still accepts it; profile selects nothing by it, checks it as a label and echoes it.
   - Amended on 2026-11-10 by the owner's ruling during the build ("i take your recommendation"). The first text answered 404 when enrollment is off as well. Read against the built code, that froze every agent's list on a gateway that turned enrollment off, so a revoked PAT stayed a kernel peer on every node; and since every host's list is now the same, a mistyped host id no longer wipes peers under either answer.
7. **The consent page names every ingress** it enrolls the key with (id and endpoint), not one endpoint.
8. **The desktop holds one tunnel per ingress per gateway row.**
   - All of a row's tunnels use the row's one key and its one address set.
   - Each ingress is its own proxy route with its own host map. The route id is unique per row and ingress, e.g. `{gateway_id}/{ingress_id}`.
   - A tenant name reaches only its own node's tunnel.
   - A dead node stalls only its own names: the 3 s session wait and 502 stay per tunnel.
9. **The desktop follows discovery without a new sign-in.** At every discovery read it already makes (the connect's read at `desktop/src-tauri/src/gateway.rs:926`, whose result goes through `publish_discovery` at `:1079-1125`; `adopt_wireguard` at `:830-854` adopts from the stored row and makes no read), an enrolled row reconciles its tunnels against `wireguard.ingresses`. It starts a tunnel for a new ingress, retires one that is gone, and replaces one whose key, endpoint or hosts changed. A node added to the gateway is reachable from every enrolled desktop at its next discovery read, and every agent already lists every peer (decision D4).
10. **The desktop compares the redeem's list with discovery's**: same ids, keys and endpoints, otherwise `PEER_CHANGED` as today. A gateway whose discovery and redeem carry no `ingresses` (v0.125.0) is one ingress, built from the legacy fields and the redeem's `hosts`, exactly as v0.125.0 does.
11. **Old desktop state keeps working.**
    - A row enrolled by v0.125.0 (a `<id>.conf` from enrollment, `wireguard_hosts`, an enrolled key) keeps its tunnel after the upgrade.
    - It gains the other ingresses at its next discovery read, reading its address from its client file. It is written back in the new shape.
    - A hand-written WireGuard file on a row (v0.124.0) stays one tunnel, unchanged.
12. **The gateway badge shows one WireGuard line per ingress** (id and live status). `GatewayEntry` (`crates/chan-library/src/gateway_registry.rs:55-106`) carries the per-ingress statuses.

## Wire shapes

Discovery (`/.well-known/chan-gateway`), two nodes:

```json
"wireguard": {
  "endpoint": "p1.proxy.example.com:51820",
  "public_key": "<p1 key>",
  "allowed_ips": ["10.7.0.1/32"],
  "persistent_keepalive": 25,
  "ingresses": [
    {"id": "p1", "endpoint": "p1.proxy.example.com:51820", "public_key": "<p1 key>",
     "hosts": [{"name": "p1.proxy.example.com", "addresses": ["10.7.0.1"]},
               {"name": "*.p1.proxy.example.com", "addresses": ["10.7.0.1"]}]},
    {"id": "p2", "endpoint": "p2.proxy.example.com:51820", "public_key": "<p2 key>",
     "hosts": [{"name": "p2.proxy.example.com", "addresses": ["10.7.0.1"]},
               {"name": "*.p2.proxy.example.com", "addresses": ["10.7.0.1"]}]}
  ]
}
```

Redeem (`POST /desktop/authorize/redeem`), same gateway:

```json
"wireguard": {
  "server_public_key": "<p1 key>",
  "endpoint": "p1.proxy.example.com:51820",
  "addresses": ["10.7.0.23/32"],
  "allowed_ips": ["10.7.0.1/32"],
  "persistent_keepalive": 25,
  "hosts": [{"name": "p1.proxy.example.com", "addresses": ["10.7.0.1"]},
            {"name": "*.p1.proxy.example.com", "addresses": ["10.7.0.1"]}],
  "ingresses": [
    {"id": "p1", "endpoint": "p1.proxy.example.com:51820", "server_public_key": "<p1 key>", "hosts": ["...as discovery..."]},
    {"id": "p2", "endpoint": "p2.proxy.example.com:51820", "server_public_key": "<p2 key>", "hosts": ["...as discovery..."]}
  ]
}
```

Operator configuration for the same gateway:

```sh
# identity.env
WIREGUARD_INGRESSES=p1=<p1 key>@p1.proxy.example.com:51820;p2=<p2 key>@p2.proxy.example.com:51820
WIREGUARD_INGRESS_ADDRESSES=10.7.0.1
WIREGUARD_ALLOWED_IPS=10.7.0.1/32
WIREGUARD_AGENT_TOKEN=<openssl rand -hex 32>

# profile.env (unchanged)
WIREGUARD_POOL_V4=10.7.0.0/24

# each node: its own interface key, the shared address, its own agent host id
# /etc/wireguard/wg0.conf: Address = 10.7.0.1/24, ListenPort = 51820, PrivateKey = <node key>
# /etc/chan-gateway/wireguard-agent.env: WIREGUARD_AGENT_HOST_ID=p1 (p2 on the other node)
```

The endpoint may be the node apex itself: the tunnel resolves its endpoint through the host's `getaddrinfo` (`crates/chan-wireguard/design.md:75`), not through the proxy's host map, so a name the map routes into the tunnel is still a valid endpoint. The ingress address must stay outside profile's allocation (network+1, or listed in `WIREGUARD_POOL_RESERVED`); identity cannot check profile's pool, so the docs say it.

## Decisions for the owner

Each has a recommendation; the build can start on the recommended answers. The gateway lane was built on the recommended answers to D1, D2, D3 and D5, as the owner was told when it started on 2026-11-10. D4 is the desktop lane's.

- **D1. Identity config grammar.** Recommend `WIREGUARD_INGRESSES=id=key@endpoint;...` plus derived host names, as in contract 2. It follows `DEVSERVER_PROXY_CREDENTIALS` (`id=token;...`), and base64's `=` padding is safe because each entry splits once on the first `=` and once on `@`. Alternative: per-id variables (`WIREGUARD_INGRESS_P1_ENDPOINT`, ...), which kube secrets and configure.sh handle worse.
- **D2. v0.125.0 enrollment variables.** Recommend refusing them at startup, naming `WIREGUARD_INGRESSES`. One form and no hub mode; v0.125.0 enrollment shipped on 2026-11-07, so few gateways set them. Alternative: read them as a one-entry list and keep `*.{proxy host}` as a hub mode, which keeps a second validation path alive.
- **D3. Legacy fields for v0.125.0 desktops.** Recommend keeping `endpoint` and `public_key` in discovery, and the single-peer fields in the redeem, set to the first ingress. A v0.125.0 desktop then works for the first node and reaches the others over the public path. Dropping only the two discovery fields is not an option: v0.125.0's `WireguardDiscovery` requires both (`desktop/src-tauri/src/devserver.rs:649-656`), so that desktop would fail to decode discovery and could not connect at all. Alternative: move the list to a new top-level key and omit `wireguard`; a v0.125.0 desktop then sees no enrollment offered and uses the public path for every node.
- **D4. Following discovery without a sign-in.** Recommend yes (contract 9): adding a node is identity config plus the node's interface and agent, with no desktop action. Alternative: only at sign-in, which means every desktop signs in again whenever a node is added.
- **D5. Agent bearer.** Recommend one shared `WIREGUARD_AGENT_TOKEN`: every host's list is identical, so binding a token to a host hides nothing. Alternative: `id=token` per host, for revoking one node's token alone.

## Boundaries

- **Gateway:** identity's config, discovery, consent and redeem, and its internal peers route; profile's enroll, list, allocation, sweeper and migration 18; gateway-common's shared WireGuard types and profile client; the gateway packaging and docs listed under Work.
- **Desktop:** the discovery and redeem parse, the row's persisted shape, the fabric's tunnels and routes, the gateway projection and the launcher badge. chan-wireguard gains at most a constructor for a `Config` from parts, if the desktop builds tunnels from the key file and the row's parameters instead of one client file per ingress.
- **Agent:** no code change. The README, design, env template and its comment say that the host id is the node's `DEVSERVER_PROXY_ID` and must be a configured ingress.
- **Out of scope:**
  - forwarding between nodes, an SNI hub, GeoDNS;
  - per-user or per-node restrictions (every PAT works on every node today);
  - devserver enrollment (`chan devserver run --tunnel-wireguard` keeps its hand-written file, one node);
  - a Kubernetes manifest for the agent;
  - DNS inside the tunnel.
- A row's tunnels share `allowed_ips`, so resolver-based routing (a name not in any host map whose resolved address falls inside AllowedIPs, `proxy.rs:370-391`) always picks the first of them. The host maps cover every name the gateway serves through the tunnel, so the work must not rely on the resolver path.
- `.agents/gateway.md:43`: `design.md` changes in the same commit as the routes and wire shapes. `:39`: run `make gateway-packaging-isolation-test` for the configure.sh and env template changes. `.agents/playbook.md:64-65`: read persisted state in the old shape and write the new one; a wire field the previous release lacks is optional with a stated meaning.

## Work

**Gateway lane** (`gateway/`)

- **gateway-common:**
  - an `Ingress` type `{id, endpoint, public_key}`;
  - the `PeerList` and `EnrolledPeer` shapes without a per-host meaning (`gateway-common/src/wireguard.rs:29-53`);
  - the profile client's enroll body (`profile_client.rs:792-816`) keeps sending `host` for one release.
- **identity:**
  - `wireguard_from_vars` is rewritten for contract 2, with config unit tests replacing `wireguard_config_*` (`config.rs:1092-1196`).
  - `WireguardEnrollment` holds `ingresses`, `addresses`, `allowed_ips` and `keepalive`, and a derived host map per ingress.
  - `GatewayWireguardDiscovery` (`http.rs:350-354`) and `Parameters` (`wireguard.rs:35-44`) take the fields of contracts 3 and 4.
  - Consent text (`desktop_authorize.rs:786-794`, `:907-913`).
  - `peers` refuses an unconfigured host with 404 (`wireguard.rs:82-111`).
  - Tests: `identity/tests/wireguard.rs`, `identity/tests/desktop_authorize.rs` (fixture `wireguard_enrollment()` at `:1097` becomes two ingresses), and the unit tests at `desktop_authorize.rs:1501-1594`.
- **profile:**
  - migration `0018` (contract 5);
  - `enroll` and `allocate` gateway-wide, with the lock `pg_advisory_xact_lock(hashtext('wireguard_pool'))`;
  - `list` without the host filter;
  - `release_once` gateway-wide;
  - the WireGuard tests in `profile/tests/api.rs:116-692` updated (the helpers `enroll_peer` and `peer_list` at `:129-165` take a `host`), plus new ones for gateway-wide uniqueness and the migration's dedupe.
- **Migration markers:** bump every `EXPECTED_SQLX_MIGRATION=17` to 18: `configure.sh:217,227,255`; `identity/packaging/identity.env:16` and `migrate.env:10`; `profile/packaging/profile.env:11`; `packaging/kube/config.yaml:64` (written `EXPECTED_SQLX_MIGRATION: "17"`, so a search for `=17` misses it); the postinst checks at `identity/packaging/postinst:42,59-60` and `profile/packaging/postinst:39`; the pins at `check-packaging-isolation.sh:103,112`. `gateway/README.md:130` names migration 17 in its upgrade steps. `packaging/kube/database-roles.yaml:211,331,339` and `reconcile-database-roles.sh:66,186,194` name the table only, in the inventory and table-level grants, so grants and `DATABASE_ROLE_POLICY_VERSION` stay; `packaging/gateway/scripts/test-database-roles.sh:263` inserts a `wireguard_peers` row naming `host` and must drop it. Write the rollback to v0.125.0 (its identity refuses an unknown applied migration) into the release notes.
- **Packaging:**
  - `identity/packaging/identity.env:38-48` and `configure.sh:264-271`: the new variables, with a prompt for the ingress list.
  - `configure.sh` mints the agent token twice (`:160`, `:167`) and writes `WIREGUARD_AGENT_TOKEN=` into identity.env twice (`:264`, `:279`); fix both while there.
  - `wireguard-agent/packaging/wireguard-agent.env:17` comment.
  - `check-packaging-isolation.sh:136-183` (the agent unit and token pins) if they move.
- **Docs:**
  - `gateway/design.md:17,182`, `gateway/CONTEXT.md:21`, `gateway/README.md:134-139`;
  - `identity/README.md:108,119-132,181,198`, `identity/design.md:21,85,87`;
  - `profile/README.md:50-58,91-96,128`, `profile/design.md:19,55-63,106,132-138`;
  - `wireguard-agent/README.md:3,7,22-36,44`, `wireguard-agent/design.md:7`;
  - `.agents/gateway.md:66,68`.
  - A new ADR in `gateway/docs/adr/` records one ingress per proxy node and why it replaces the v0.125.0 decision.

**Desktop lane** (`desktop/`, `crates/chan-wireguard`, `crates/chan-library`, `web/packages/launcher`)

- **Discovery:** `WireguardDiscovery` (`desktop/src-tauri/src/devserver.rs:649-656`) gains `allowed_ips`, `persistent_keepalive` and `ingresses`, all optional. With no `ingresses`, the legacy pair is the one ingress. Validation (`:725-731`) covers each entry.
- **Redeem:**
  - `EnrollmentParams` (`wireguard_keys.rs:68-78`) gains `ingresses`.
  - `prepare` (`:110-160`) compares the list with discovery's and validates each ingress's hosts against `allowed_ips` before anything is written. Today hosts are only checked at adopt, where a bad one fails silently into `last_error`.
  - Coordinate with [patrevoke](../done/a-pat-minted-by-the-redeem-is-orphaned-when-the-desktop-refuses-the-answer.md), which owns the same completion and commit path (`auth.rs:1015-1163`, `gateway.rs:223-234`): land one first and rebase the other.
- **Row:**
  - The enrolled shape stores the address set, `allowed_ips`, keepalive and the ingress list (`config.rs:119-181`), and keeps `<id>.key`.
  - Recommended: build each tunnel's `Config` in memory from the key file and the row, instead of one wg-quick file per ingress, so the private key stays in one owner-only file and a discovery reconcile writes no key material.
  - `record_wireguard_enrollment` (`:1303-1326`) writes the new shape.
  - A v0.125.0-enrolled row is read from its `<id>.conf` and rewritten (contract 11).
  - The hand-written `wireguard` path keeps its single-tunnel meaning.
- **Fabric** (`wireguard.rs`):
  - `rows` holds a set of tunnels per gateway;
  - route ids per ingress;
  - `adopt`, `retire`, `status`, `failure`, `connect_refusal` and `reason_for_destination` work per ingress and keep route order stable;
  - a reconcile entry point drives contract 9 from the discovery reads.
- **Projection and UI:**
  - `GatewayEntry` gains per-ingress statuses, mirrored in the launcher's `web/packages/launcher/src/api/library.ts:451` (`wireguard_status`) and its mock (`mock.ts:631-676`);
  - `Gateways.svelte:138-166` renders a line per ingress;
  - `web/packages/launcher/design.md:97,135`.
- **Docs:**
  - `desktop/design.md:222-236`;
  - `crates/chan-wireguard/design.md:3,95-97,124` if routes or config change;
  - `design.md:139`;
  - `docs/config-reference.md:279,341-343` (also fix its wrong "restart is needed" and add the enrollment fields).
- **e2e:**
  - `scripts/e2e/stub-identity.mjs` serves two ingresses.
  - `scripts/e2e/desktop-wireguard.sh --enroll` runs two `wg-peer --client-key` peers on the same tunnel address with distinct keys and ports, and its tenant arm proves each name goes through its own peer.
  - A new `--reconcile` arm adds a third ingress to the stub's discovery and proves its tunnel starts with no sign-in.

**Docs lane**

- `web/packages/marketing/src/pages/gateway.html:50-68` (nodes and the WireGuard section);
- `web/packages/marketing/src/pages/manual/gateway.html` gets a WireGuard enrollment section covering per-node interfaces, the agent and identity's list;
- `CHANGELOG.md`.

## Acceptance

1. Gateway unit and integration tests (`cargo test --locked` in `gateway/` against Postgres):
   - **Config:** identity parses a two-ingress config and refuses duplicate ids, a bad key, a bad endpoint, an empty list, an address outside `WIREGUARD_ALLOWED_IPS`, a partial set, and any v0.125.0 name.
   - **Discovery:** carries the legacy pair (first ingress) and `ingresses` with derived hosts, and carries no `wireguard` when enrollment is off.
   - **Full sign-in:** enrolls one peer and answers one address with both ingresses.
   - **Peers route:** answers every active peer for `host=p1` and `host=p2`, each echoing its host, and 404 for `host=p9`; with enrollment not configured it relays the list for `host=p9` too (contract 6 as amended).
   - **Profile:** never hands one address to two peers; migration 18 dedupes a fixture with one key on two hosts and one address on two hosts, keeping the newer row.
   - **Revoke:** a revoked PAT drops the peer from both hosts' lists.
2. Desktop unit tests:
   - discovery with and without `ingresses`;
   - a two-ingress redeem writes the row, keeps the key in one file and starts two routes, and each node's names go to their own tunnel at the shared address;
   - a mismatch with discovery refuses with `PEER_CHANGED` and stores nothing;
   - reconcile adds, retires and replaces ingresses with no sign-in;
   - a v0.125.0-enrolled row keeps its tunnel and gains the second ingress;
   - a hand-written file stays one tunnel;
   - the projection carries per-ingress statuses.
3. `scripts/e2e/desktop-wireguard.sh --enroll` and `--reconcile` green under Xvfb; `scripts/e2e/wireguard-agent.sh` unchanged and green.
4. Integration in guests, against a real identity, profile and Postgres. Two nodes (two guests or two network namespaces), each with a kernel interface at the same tunnel address, its own key, its own agent (`p1`, `p2`) and a tenant stand-in behind TLS for `*.p1` and `*.p2`. Then:
   - **Enroll:** one desktop enrolls once. A `*.p1` tenant loads through p1's tunnel and a `*.p2` tenant through p2's, and `wg show` transfer counters on the other node do not move during each load.
   - **Add a node:** `p3` added to `WIREGUARD_INGRESSES` (identity restarted) and brought up becomes reachable from the same desktop at its next connect, with no sign-in.
   - **Revoke:** revoking the PAT removes the peer from all three nodes within two agent polls, and every tenant load fails.
   - **Node outage:** stopping p2's interface makes only `*.p2` names fail (502 after 3 s) while `*.p1` keeps loading.
   - **Mixed versions:** a v0.125.0 desktop against this gateway enrolls, reaches `*.p1` through the tunnel, and reaches `*.p2` over the public path. A v0.128.0 desktop against a v0.125.0 gateway enrolls and runs one tunnel as v0.125.0 does.
5. `make gateway-packaging-isolation-test` green with the new configure.sh and env templates, and `make shell-check` green.

## Evidence

The gateway lane is on `feat/wireguard-ingress-per-node-gateway`: 61 commits over `77c872a8d`, with the integration branch merged in up to `e10d622a4`, 43 files against that branch. One agent coordinated it on 2026-11-10 through subagents: a profile half and an identity half built side by side against a fixed client contract, packaging and documents after them, an independent review of each half, their fixes, a pass that brought the documents in line with the packaging, a review of everything after the first merge, and its fixes. The desktop implementation and its remaining acceptance gaps are recorded below.

What landed, by the Work list:

- **gateway-common:** `Ingress {id, endpoint, public_key}`; `PeerList` and `EnrolledPeer` with no per-host meaning; the enroll body still carries `host`.
- **identity:** `wireguard_from_vars` reads the list of contract 2 and refuses the four v0.125.0 names in one message; discovery and the redeem carry `ingresses`, with the first ingress in the single fields; the consent page names every ingress; the peers route answers by contract 6 as amended and logs an unlisted host at warn, at its first refused poll and then every ten minutes.
- **profile:** migration `0018_wireguard_peers_gateway_wide.sql`; enroll, allocation, list and release gateway-wide under `pg_advisory_xact_lock(hashtext('wireguard_pool'))`.
- **Markers and packaging:** every marker at 18, `packaging/kube/config.yaml` among them; the env templates; `configure.sh` asks for the ingress list and one IPv4 pool, checks both before it writes anything by the rules identity and profile apply at startup, and mints the agent bearer once.
- **Documents:** `gateway/design.md`, `README.md` and `CONTEXT.md`, [ADR 0004](../../../gateway/docs/adr/0004-one-wireguard-ingress-per-proxy-node.md), the crate READMEs and designs, `.agents/gateway.md`, `packaging/kube/README.md`, and from the docs lane the manual's WireGuard section and one paragraph of the gateway page. `CHANGELOG.md` is left for the release.

Acceptance 1, line by line, under `gateway/crates/`:

- **Config:** `wireguard_config_reads_two_ingresses_in_order_with_derived_host_maps`, `wireguard_config_refuses_an_invalid_ingress_list` (duplicate ids, a bad key, a bad endpoint, an empty list), `wireguard_config_refuses_invalid_addresses_and_routing_policy`, `wireguard_config_refuses_a_partial_set` and `wireguard_config_refuses_the_single_ingress_names_in_one_message`, in `identity/src/config.rs`.
- **Discovery:** `discovery_lists_every_ingress_and_repeats_the_first_as_the_single_pair` and `discovery_advertises_wireguard_only_when_configured`, in `identity/tests/wireguard.rs`.
- **Full sign-in:** `full_flow_with_a_wireguard_key_enrolls_one_peer_and_answers_one_address_with_every_ingress`, in `identity/tests/desktop_authorize.rs`.
- **Peers route:** `wireguard_peers_route_relays_each_configured_ingress_and_answers_404_for_another_host`, `wireguard_peers_route_relays_every_well_formed_host_while_enrollment_is_off` and `an_unlisted_host_is_logged_once_at_warn_with_its_label_and_without_the_bearer`, in `identity/tests/wireguard.rs`.
- **Profile:** `wireguard_never_hands_one_address_to_two_peers` and `wireguard_migration_18_keeps_the_later_row_of_each_duplicate`, in `profile/tests/api.rs`.
- **Revoke:** `wireguard_peers_list_drops_revoked_expired_and_blocked` in profile's file and `a_peer_profile_drops_leaves_each_hosts_list_at_that_hosts_next_poll` in identity's.

Each new or changed test was seen red once by its builder, against a change to the one guard it pins. The reviews then found gaps, closed the same way: the migration test did not fix which row of a pair survives, and identity had no test of the redeem's wire shape without a database, of the call that binds the parser to the process's origins, or of the derived names against the names identity mints.

The gate ran at `da75ff666` in a clean detached worktree, with the identity SPA built from the tree: `make gateway-fmt`, `gateway-lint`, `gateway-doc`, `gateway-test` and `gateway-build`; the whole gateway workspace's tests, 753 passed and none failed, built on the host and run against PostgreSQL 18 in a disposable sdme guest with a private network; `make gateway-packaging-isolation-test` (88 PASS lines), the database-roles suite in a guest of its own, `make shell-check` and `packaging/kube/test-manifests.py`. Acceptance 5 is two of those steps. Gateway CI has not run on the branch.

Acceptance 3, the agent half: `scripts/e2e/wireguard-agent.sh`, unchanged, is green at `c13dd6f33` against a kernel WireGuard interface in a VM (kernel 7.2.9, wireguard-tools 1.0.20260223). Its add, remove, operator and unauthorized arms pass with the agent under the packaged unit's hardening. After that commit the agent crate changed in its README alone.

Acceptance 4 has not run. It needs two nodes with kernel interfaces, tenant stand-ins behind TLS and a desktop that holds one tunnel per ingress. What ran is the gateway alone, at `da75ff666`: identity, profile and PostgreSQL in one sdme guest, installed by the six packages' postinst scripts, configured by the unmodified `configure.sh` and started from the packaged units, with GitHub's OAuth the only stand-in.

- The migration unit leaves the schema at 18: `wireguard_peers` has no `host` column and has its three single-column uniques.
- Discovery carries the single pair of the first ingress and both ingresses with their derived hosts.
- A sign-in through authorize, consent and redeem enrolls one row and answers one address with both ingresses, and the consent page names both. The same key signing in again keeps its address, and a second key gets the next one.
- The peers route answers the same peers to `p1` and `p2`, each body echoing its host under its own ETag; `p9` gets 404 and a warn line in identity's journal, a malformed host 400, a request without the agent bearer 401.
- `chan-gateway-admin token revoke` drops the peer from both lists at their next read.
- With enrollment commented out and identity restarted, discovery carries no `wireguard` and the route relays the list for `p1`, `p2` and `p9`.
- With one or all four of the v0.125.0 names set, identity exits 1 before it binds a listener, and its journal names them.

This host's kernel offers no WireGuard to a container, so no kernel interface ran in that guest. Three agents ran there on userspace `wireguard-go` devices with the real `wg`: `p1`, `p2`, and `p9`, which identity's list lacks. An enrolled key was on both listed nodes' interfaces 4.7 s after the consent was confirmed and gone from both 4.6 s after the revoke, inside the two five-second polls allowed. The `p9` agent was answered 404, logged that it keeps its last list and held no peer; with enrollment off it was served the list and added the remaining key.

Departures from the text above:

- **Contract 6** is amended in place, by the owner's ruling.
- **The dedupe rule of contract 5.** Migration 18 deletes a row when a later enrollment, by `updated_at` and then `id`, holds its key or one of its addresses, whether or not that later row itself stays. A key keeps at most its latest enrollment, and the outcome does not depend on the order rows are visited in. Where three rows chain, one more row goes than "the older of a pair" would take, and that desktop signs in once more. Each column is its own equality join: one join on the three equalities under OR compared every pair of rows under the table lock, 73 s at 32,000 rows against 0.24 s.
- **Audit rows.** Each enrollment the migration deletes gets a `wireguard_released` row in its token's audit. The profile review raised it; it is one commit, `46ee698c8`, and the owner may drop it until the migration ships, after which the file's checksum fixes its text.
- **`EnrolledPeer.host` is optional.** Profile echoes the host an enroll request names and leaves the field out otherwise. An identity one release behind names a host and requires the field in the answer.
- **`WireguardEnrollment` has no `addresses` field.** The tunnel addresses are in each ingress's derived host map.
- **`configure.sh` asks for the pool as well as the list** and writes `WIREGUARD_POOL_V4` into `profile.env` in the same run. It does not ask for the tunnel address: it takes the pool's first host address. A run over existing files shows the list it replaces as a line to answer with, offers the replaced pool as the pool question's default, and names the WireGuard settings it does not carry over.

## For the release notes

- **Upgrade order.** A profile from a release that carries migration 17 names the dropped column in every WireGuard statement: on the migrated schema its enroll and peer-list routes answer 500 and its sweeper releases no address. Where identity and profile are upgraded apart, profile goes with the migration, before or together with identity. `gateway/README.md` says so.
- **The four v0.125.0 variables.** `WIREGUARD_HOST_ID`, `WIREGUARD_ENDPOINT`, `WIREGUARD_PUBLIC_KEY` and `WIREGUARD_HOSTS` stop identity at startup, with a message naming `WIREGUARD_INGRESSES`. A gateway that enrolls moves to the list before it upgrades.
- **Duplicates.** A desktop whose enrollment migration 18 deletes as a duplicate signs in again.
- **Rollback.** The previous release cannot use a database at migration 18. Its migrate step refuses an applied migration it does not know, and it does so after `prepare-database-roles` has revoked both services' privileges and cleared the ready marker, so the schema is reversed first. On a gateway that ran more than one ingress, stop the agent and take the interface down on every node but the one that stays the ingress: after the rollback the previous profile lists peers only under the host named in the SQL, and an agent polling under another id is served an empty list and removes every peer it manages. Stop `chan-gateway-identity` and `chan-gateway-profile`, then run this as the database owner, with the id of that node in place of `p1`:

  ```sql
  BEGIN;
  ALTER TABLE public.wireguard_peers
      DROP CONSTRAINT wireguard_peers_public_key_key,
      DROP CONSTRAINT wireguard_peers_address_v4_key,
      DROP CONSTRAINT wireguard_peers_address_v6_key,
      ADD COLUMN host text NOT NULL DEFAULT 'p1';
  ALTER TABLE public.wireguard_peers
      ALTER COLUMN host DROP DEFAULT,
      ADD UNIQUE (host, public_key),
      ADD UNIQUE (host, address_v4),
      ADD UNIQUE (host, address_v6);
  DELETE FROM public._sqlx_migrations WHERE version = 18;
  COMMIT;
  ```

  Set `EXPECTED_SQLX_MIGRATION=17` in `migrate.env`, `identity.env` and `profile.env`, install the previous packages, put the four single-ingress variables back in `identity.env` in place of the three new ones, then restart `chan-gateway-migrate` and start profile and identity. On Kubernetes, after the SQL, set `EXPECTED_SQLX_MIGRATION: "17"` and the previous image tags and run steps 2 to 4 of `packaging/kube/README.md` (scale profile and identity to zero, delete the three Jobs, prepare, migrate, reconcile, apply); rolling the images back alone leaves the ready marker at 18. What is lost: enrollments that migration 18 deleted stay deleted, every remaining peer is placed on the one host named in the SQL, and the `wireguard_released` rows the migration wrote stay in the audit, no longer told from a sweep's by their time.
- The SQL ran in a probe: a migrator whose set ends at 17 refuses the database at 18, and after the SQL it runs and applies nothing, the previous statements work and the per-host uniques are back under migration 17's names. The previous release's binaries, the packaged steps and the Kubernetes sequence on a rolled-back database were read, not run.

## Found beside the work

Not changed on the branch; each is the owner's to place.

- `packaging/gateway/scripts/dev/setup.sh` writes `DEVSERVER_PROXY_CREDENTIALS` unquoted into a file the dev runner sources, so a two-node value keeps its first entry only. Read and probed, not run through the runner.
- `configure.sh`: two runs within one second share a backup name; it sets no umask of its own; and the interface and node id questions take no default from the files they replace, as the pool question did before the last fix.
- Profile keeps every allocated address when `WIREGUARD_POOL_V4` is changed by hand: a key that signs in again gets its old address back, outside the new pool.
- The Kubernetes manifests carry no `WIREGUARD_*` variable, so a cluster as shipped offers no enrollment. A manifest for the agent is out of scope above.
- `docs/contributing/linux-and-macos.md` (its deb walk-through) lists `configure.sh`'s answers in an older form. The `Makefile` comment on `gateway-packaging-isolation-test` and `.agents/skills/gate/SKILL.md` describe that suite without its `configure.sh` arms.
- The isolation suite's arm for an unreadable env file is skipped when the suite runs as root.
- identity's `whoami_refusal_shape_is_uniform` (`tests/auth.rs`) went red once in eight runs under host load, at `callback should redirect`, outside this change; a candidate for [loadres](some-tests-still-go-red-under-the-heaviest-cpu-load.md).

## Related items

- [patrevoke](../done/a-pat-minted-by-the-redeem-is-orphaned-when-the-desktop-refuses-the-answer.md): same redeem completion and credential commit. Its "no change to the redeem's answer shape" boundary needs amending for this item's additive fields.
- [gwdefaults](../done/the-gateway-setup-defaults-name-the-maintainers-deployment.md): the tunnel ingress shape (namespace apex or node apex). With the node apex, the devserver's tunnel host is inside each ingress's derived host map; with a shared apex behind a load balancer, it stays on the public path. Neither changes this item.
- [gwci](../done/no-ci-job-runs-the-gateway-packaging-and-roles-suites.md): this item changes configure.sh and the migration markers, which only those suites check.
- [systemca](the-rust-tls-clients-ignore-the-systems-ca-store.md): unchanged by this item. The desktop's and the agent's clients still trust the bundled roots only.

## Built: the desktop's shapes, 2026-11-11

Contract 10 is built in the desktop's parser and credential path (a05cee357, ed2b53c24): discovery accepts the optional `allowed_ips`, `persistent_keepalive` and `ingresses`, validates every ingress (a label id, a canonical key, an endpoint as identity validates it, hosts with addresses inside `allowed_ips`) and keeps the legacy pair consistent with the first ingress; the redeem compares its list with discovery's by id, key and endpoint in any order, stores discovery's order, refuses a changed or one-sided list with `PEER_CHANGED` before any credential is stored, validates every ingress's hosts before storage, and treats both lists absent as the one legacy ingress (`LEGACY_INGRESS_ID`, pinned). Contract 11's persisted state and migration are built (77fa041f2): the enrolled row stores the address set, the allowed IPs, the keepalive and the ingress list with one owner-only key file and no client file, every ingress's `Config` built in memory from one read of that key (checked against the enrolled key); a v0.125.0 row whose owned `<id>.conf` key matches the key file and the enrolled key converts at startup with its tunnel kept, a mismatched or hand-edited file keeps its file and tunnel until a kept re-enrollment removes the unchanged owned file after the commit, a hand-written path keeps its single-tunnel meaning, a row whose key file was regenerated is not adopted at connect so discovery and sign-in proceed and the new enrollment replaces it (a running old tunnel stays until then), and the migration's cleanup logs a failed removal and retries a matching orphan at the next start. The fabric starts the first ingress's tunnel in this stage; the launcher shows and polls a gateway's WireGuard line for a row with a file, a live status or an enrolled key (1333979bc), and the e2e enroll arm expects the new row shape (no client file, the key only in the key file). The desktop, chan-wireguard and launcher design documents, the config reference and the e2e script's header say so (7860570cf, 9cd522987).

Verified by the seat's scoped gate and the lead's independent review and re-review (`dev/v0128-team/reviews/review-wgnode-desktop-t1.md`): fmt, the six desktop modules and the startup test (481 tests), chan-wireguard (124), clippy on both crates, web-check (10,379 tests), shell-check and e2e-check; four baseline assertion reds (a duplicate ingress id, an unadvertised list and a host outside the allowed IPs, duplicated private material, an obsolete enrollment blocking the replacement sign-in) and eighteen guard mutations red at their assertions; the review's one integration finding (the launcher losing its line for enrolled rows) and its gaps fixed before the commits. Open for T2: one tunnel per ingress with its own route and host map, the reconcile at discovery reads, and the re-enrollment cleanup that cannot be retried after a failed removal; for T3 the per-ingress projection, the e2e arms and the guest and mixed-version acceptance. At the merge into the integration branch (`dev/v0128-team/evidence/Lead128/wgnode1-merge`): fmt; clippy on chan-desktop and chan-wireguard with warnings denied; the six desktop modules and the startup test (16, 28, 94, 67, 41, 110 and 1); chan-wireguard (124); shell-check; e2e-check; make web-check (tests 246, 815, 9344 and 35); `make check-windows-test-target` in the gate guest; all green at 0eee27e37. The e2e enroll arm passed at 9755a505d in the lead's desktop guest (`dev/v0128-team/evidence/Lead128/wgnode-enroll-arm/`): its six checks in one run, the start line naming the key file, the row's file absent and the enrollment holding the key file path, the addresses, the policy and the one legacy ingress, the key directory holding the key alone at mode 600 with no client file, the private key in the key file and nowhere else, the peer handshaking and the tenant connect refusing on the discovery 404.

## Desktop fabric and discovery built

Contracts 8 and 9 are implemented. The desktop holds one tunnel and host map per enrolled ingress, named by the gateway and ingress ids, sharing the row's client key and address set. Adoption retains unchanged tunnels and atomically publishes routes in discovery order. Each tenant name reaches its own peer even when peers share a tunnel address; a dead node's session wait and 502 affect only its own names. Manual files remain one tunnel.

Every successful connect discovery reconciles an enabled enrolled row's advertised ingress list: new peers start, gone peers retire, and changed peer keys, endpoints or host maps replace only that ingress. The public row is validated and saved before adoption under the store and current-attempt locks. Stale results and failed persistence leave tunnels unchanged, and no private key is rewritten. A converted legacy enrollment gains later peers on discovery without signing in again. An absent WireGuard object or legacy discovery without a list retains the stored enrollment. Regenerated keys keep the established recovery sign-in path.

Acceptance 2's fabric and reconcile cases are covered by desktop unit tests: two real peers on the same address receive their own node's traffic, a dead node refuses independently, an open stream survives a route reorder, discovery adds/removes/replaces peers, and a migrated enrollment reaches the second peer. Tests also cover failed persistence, stale and cancelled publication, invalid parameters, unchanged-file timestamps, regenerated keys, manual files, shared client settings and the summary status order. Independent guard mutations establish that these checks can fail. Native desktop, kernel-peer and end-to-end acceptance remain open.

The fabric stage retained the summary status: the worst running ingress, with discovery order breaking ties, plus a refused ingress's reason in the row error. The projection and harness stage below adds contract 12 and the desktop end-to-end arms. This row is not done.

Cleanup retry: an obsolete owned client file is removed only after a kept credential commit and only while its bytes match a persisted path/SHA-256 record beside the enrollment. Startup migration persists the same record with the converted row. Startup and successful connect retry it independently of later key or public parameter changes; missing files and digest mismatches clear the record and log the outcome once. A replacement or active manual file stays untouched. This removes the prior retry limit without a background retry loop. A failure to save the initial record still keeps the file and reports that persistence error.

## Desktop projection and enrollment harness built

Contract 12 is implemented. `GatewayEntry` carries ordered `wireguard_ingresses` id/status pairs beside the unchanged `wireguard_status` summary. Each adopted ingress exposes its live state or start refusal; manual files and enrollment-wide refusals keep the summary/error path, and an older peer's missing list defaults empty. As a display convention, a sole `legacy` id projects an empty list, including a real sole node with that name because enrollment stores no provenance; several ingresses retain every id. The launcher renders one private WireGuard line per listed ingress, including a single listed ingress, with id and connection details independently revealable. The id keeps its width beside a long status, which truncates with its full text in the title; a manual path takes the space after its summary. Reveals follow ingress identity through reorder, and a retained ingress list keeps the visible two-second poll active after key regeneration. The test mock mirrors enrollment, refresh and retirement. One fabric read returns the refusal, summary and ingress list under one registry lock; a reconcile cannot split the projection between two ingress sets.

The desktop enrollment harness uses two separate peers with distinct outer ports and keys at the same inner address. `--enroll` checks the one sign-in, exact stored parameters, both ordered live statuses, one key file, no client file, and per-node discovery and completed webview fetches reaching only their own peer. `--reconcile` adds p3 through discovery and the existing Connect route, checking the three routes with no further sign-in, key rewrite, desktop/proxy restart or p1/p2 tunnel restart. The script preserves negative probes before enrollment and before p3 is advertised. Its oracle matches native gateway-qualified route ids using a captured desktop trace, and adopt/reconcile verdicts print measured states, start counts, process ids, sign-in counts and key continuity. Its identity handler, data oracle and mocked shell helpers have 33 passing host-safe tests, run by the Linux e2e gate. The fix round adds six independent assertion-red mutations covering trace, observation and key guards to the original 19 harness mutations; these checks do not execute the desktop arms.

Acceptance 2's projection is covered by registry serialization, desktop projection and mounted launcher tests, including older-peer defaults, refusals, manual files, order, privacy, polling and the sole/multi-ingress legacy convention. The latest scoped checks pass 72 desktop config and 33 fabric tests, 125 focused launcher tests and the full 10,391-test web gate. Three legacy projection and five mounted layout/fallback mutations fail independently and restore; the original seven projection and ten launcher mutations remain in the evidence. Formatting, warning-denied desktop clippy, shell/workflow lint, helper and e2e syntax checks pass. A separate test repair makes the regenerated-key sign-in install its existing origin-scoped keychain stub before Connect; all 120 gateway module tests pass with platform keyring syscalls denied.

The lead's provisional guest reading of b2e832e3a, with the native route-id match corrected in its copy, passes all 9 enrollment and 14 reconcile verdicts. Replacing p2's server key makes adoption and p2 traffic fail while p1 stays green; omitting p3 from discovery makes reconciliation and p3 traffic fail. The lead's WebKitGTK screenshots show per-ingress lines, privacy concealment and reveals following reordered ids at 640 and 1100 pixels; their long-status finding prompted the layout fix above. The final integrated scripts and layout still need the lead's guest rereading, and the unchanged wireguard-agent arm remains part of acceptance 3. No kernel-node routing, real gateway sign-in or mixed-version result is claimed here. Acceptance 4 remains open and the row stays unfinished. The run instructions and sealed evidence are on the round's coordination bus, for archival at round close.

## Read in the lead's desktop guest after the fix round, 2026-11-11

At a3f196d68 (the fix round's code tip; the documents commit after it changes no code) in the lead's isolated desktop guest, unmodified: `scripts/e2e/desktop-wireguard.sh --enroll` passes its nine verdicts and `--reconcile` its fourteen, with the measured values printed (two peers started once each, the same desktop and proxy process before and after, one authorize and one redeem, the key digest and metadata unchanged, p3 added without a sign-in, a key rewrite or a restart); the control that replaces p2's server key fails adoption and p2's traffic while p1 stays green. The launcher at 1100 and 640 pixels shows one line per ingress with every id at its whole width beside long statuses that truncate with their full text in the title, privacy removing ids and statuses from the DOM and a reveal following its ingress through a reorder; a sole `legacy` ingress served by the real desktop shows the summary line alone, with the word nowhere in the card, the DOM or the API. Evidence: `dev/v0128-team/evidence/Lead128/wgnode-t3-reading-2/` (summary.md). Acceptance 3's desktop half is met; acceptance 4 (the real gateway and the mixed-version readings) remains the lead's, and the `wireguard-agent` arm stays part of acceptance 3's agent half as before.

## Desktop reconciliation retirement logs

Reconciliation logs each removed or replaced running ingress once after publishing the complete route table, with the gateway id, gateway-qualified ingress route id and source path. Unchanged and reordered tunnels remain silent, as do refused starts. The regression drives real fabric adoption, checks one drop across repeated discovery, a same-id replacement, and removal of a refused ingress; it fails on the missing retirement line before the fix. Native acceptance of the remaining row stays with the lead.

## Idle ingress keepalive renewal

Keepalive 25 is passed to the protocol core and sent while idle. A due keepalive now renews an initiator session at least 120 seconds old; responders keep sending keepalives, and the passive keepalive and unanswered-data rules remain payload-only. The desktop still projects the core's live/lost state without an independent timeout. The 650-second core clock regression reproduces session gaps with no payload before the fix, and checks ongoing renewal afterwards; boundary cases cover age, initiator role and no keepalive due. A loopback tunnel-driver regression advances the clock through ten idle minutes and checks fresh live status with zero payload counters. Real-gateway idle acceptance remains the lead's.
