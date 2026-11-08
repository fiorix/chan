# A desktop reaches every proxy node through one WireGuard ingress

Status: raised by the owner on 2026-11-08 while planning the chan.app WireGuard rollout; proposed for v0.126.0 and moved to v0.127.0 by the owner on 2026-11-08; not started. Supersedes the v0.125.0 decision "one WireGuard ingress endpoint per gateway, served to the desktop by discovery and the redeem, with no list of ingress hosts distributed to desktops and more regions the operator's concern behind that one endpoint, and one tunnel per gateway row on the desktop" ([release-v0.125.0](../../release/release-v0.125.0.md), decisions, line 60).

Asked by the owner on 2026-11-08 after reading what a second proxy node would need under v0.125.0 ("with gw, are we funneling bidirectional traffic through that host? it'll become a bottleneck quickly"), and decided the same day: no v0.125.0 rollout on chan.app; each devserver-proxy node terminates its own WireGuard and the desktop reaches the node a devserver is connected to directly, in v0.126.0 ("i prefer to make the changes and release v126").

Line numbers below are at `c998d0327` (v0.125.0 plus docs). v0.126.0 carries v0.125.0's enrollment and migrations unchanged, so a v0.125.0 desktop, gateway or enrolled row below stands for either release.

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
   - Consequences: a v0.125.0 desktop enrolls against the first ingress and reaches the other nodes over their public path, and a v0.127.0 desktop starts one tunnel per ingress.
5. **One peer per key, gateway-wide.** Profile enrolls a peer once, independent of hosts, with one address set unique across the gateway, under one gateway-wide advisory lock. `GET /v1/wireguard/peers?host=` returns every active peer whatever the host, and still echoes `host` in the body (the agent requires it). Migration 18 drops `host` from `wireguard_peers` and its per-host uniques, and adds `UNIQUE (public_key)`, `UNIQUE (address_v4)` and `UNIQUE (address_v6)`. It keeps `token_id UNIQUE` (one peer per PAT). Before the new uniques, it deletes the older of any duplicate rows by `updated_at`; a desktop whose row it deletes signs in again. The sweeper releases gateway-wide with the same grace rules. Revoke, expiry and block drop the peer from every ingress at once.
6. **Identity guards the agent route.** `GET /internal/v1/wireguard/peers?host=` answers 404 for a host that is not a configured ingress id (and when enrollment is off), so a mistyped agent keeps its last list instead of wiping its peers. One `WIREGUARD_AGENT_TOKEN` stays shared by every agent (decision D5). Identity keeps sending `host` (the first ingress id) in profile's enroll body for one release, so a profile one release behind still accepts it; profile ignores it.
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

Each has a recommendation; the build can start on the recommended answers.

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
  - Coordinate with [patrevoke](a-pat-minted-by-the-redeem-is-orphaned-when-the-desktop-refuses-the-answer.md), which owns the same completion and commit path (`auth.rs:1015-1163`, `gateway.rs:223-234`): land one first and rebase the other.
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
   - **Peers route:** answers every active peer for `host=p1` and `host=p2`, each echoing its host, and 404 for `host=p9`.
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
   - **Mixed versions:** a v0.125.0 desktop against this gateway enrolls, reaches `*.p1` through the tunnel, and reaches `*.p2` over the public path. A v0.127.0 desktop against a v0.125.0 gateway enrolls and runs one tunnel as v0.125.0 does.
5. `make gateway-packaging-isolation-test` green with the new configure.sh and env templates, and `make shell-check` green.

## Related items

- [patrevoke](a-pat-minted-by-the-redeem-is-orphaned-when-the-desktop-refuses-the-answer.md): same redeem completion and credential commit. Its "no change to the redeem's answer shape" boundary needs amending for this item's additive fields.
- [gwdefaults](../v0.126.0/the-gateway-setup-defaults-name-the-maintainers-deployment.md): the tunnel ingress shape (namespace apex or node apex). With the node apex, the devserver's tunnel host is inside each ingress's derived host map; with a shared apex behind a load balancer, it stays on the public path. Neither changes this item.
- [gwci](no-ci-job-runs-the-gateway-packaging-and-roles-suites.md): this item changes configure.sh and the migration markers, which only those suites check.
- [systemca](the-rust-tls-clients-ignore-the-systems-ca-store.md): unchanged by this item. The desktop's and the agent's clients still trust the bundled roots only.
