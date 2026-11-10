# Gateway

The account, sign-in and reverse-proxy surface of a self-hosted chan gateway, a separate nested Cargo workspace. This glossary fixes the domain language; the system design and lifecycles live in [`design.md`](design.md), and decisions and their rationale live in `docs/adr/`.

## The devserver model

**devserver**: The single, gateway-exposed `chan devserver` process a user runs; it hosts a library and holds one tunnel registration. A user may run several devservers, each identified by its own PAT, and several can be reachable through the gateway at once; the only cap is on connected devservers, enforced at admission. _Avoid_: remote, instance, node

**library**: The set of workspaces a devserver hosts (the workspace registry under the chan home on that machine). The devserver is the process; the library is its contents. _Avoid_: collection, registry

**workspace**: A single project directory; the tenant unit inside a library. It is not a permission or sharing unit. _Avoid_: project, folder, drive

**tenant**: A workspace as routed and served inside the devserver, mounted at `/{slug}-{8hex}/`. _Avoid_: site, app

## Gate and identity

**devserver-proxy**: The gateway's reverse-proxy service and fleet data plane. Many provisioned nodes run it, each with a stable node id, at the configured tunnel origin's host (`proxy.{domain}`) and its own tenant wildcard (`*.{proxy}.proxy.{domain}`). _Avoid_: workspace-proxy, tenant-proxy

**devserver-control**: The singleton, database-free control plane. Owns the dynamic proxy directory, the aggregate tunnel view, fleet admission and command routing; serves `/admin/v1/*` to identity, profile and the admin CLI. Every proxy node holds one authenticated h2 control session to it. _Avoid_: controller-service, fleet-db

**WireGuard ingress**: One proxy node's kernel WireGuard interface as a desktop reaches it: an id, which is the node's proxy id, the interface's public key and its `host:port` endpoint. A gateway offers one per node that terminates WireGuard; every ingress answers on the same tunnel addresses and accepts every enrolled peer, and none forwards for another node. It is not the tunnel ingress, the origin devservers dial. _Avoid_: hub, VPN gateway, WireGuard host

**WireGuard peer**: A desktop's enrolled WireGuard key: one profile record per public key across the gateway, tied to its user and to one PAT, with one address set from the gateway's pool. It is active while that PAT is live and unexpired and its user is not blocked. _Avoid_: client, device

**wireguard-agent**: The agent on a proxy node that keeps the peers of the node's kernel WireGuard interface equal to the gateway's active WireGuard peers. It reads them from identity's internal listener under the node's ingress id, the same list on every node, applies them with `wg`, and adds and removes only the peers in its managed set, the ones it added itself. _Avoid_: wg-sync, peer daemon

**devserver token**: The owner PAT (`chan_pat_*`) that authorizes a devserver to register over the tunnel. One token identifies one devserver; the gateway derives the devserver id from the token's digest. The PAT stays opaque. _Avoid_: tunnel-name, api-key

**admission lease**: The short-lived Ed25519 credential identity signs on a successful PAT validation, binding owner, devserver id, registration id, proxy id and the signed per-user limit. devserver-control verifies it before reserving capacity; the proxy forwards it and cannot mint one. _Avoid_: admission token

**devserver_gate**: The host-only opaque browser-session cookie on the wildcard host. Sessions are proxy-local, scoped to one devserver and `Path=/`, and expire absolutely within one hour. _Avoid_: workspace_gate, auth-cookie

**devserver grant**: A profile record that a caller may access an owner's devserver, meaning its whole library. The sharing unit. _Avoid_: workspace-grant, share, ACL

**entry credential**: The short-lived, single-use Ed25519 credential that identity mints after a devserver access check. The browser or desktop submits it in the body of the fixed `POST /_chan/entry` exchange; it never belongs in a URL. _Avoid_: handoff-token

**admin CLI**: `chan-gateway-admin`, the operator command-line client. It holds no server of its own; it calls the scoped admin trees of profile, identity and devserver-control over protected internal HTTP. _Avoid_: admin-service, admin console

## Session terminology

**OAuth session**: The identity-service account session behind `__Host-id_session` and `tower_sessions`. Its operator id is the `identity_session_index` admin session id; the secret tower store id is never serialized. _Avoid_: browser session, tenant session

**tenant session**: The proxy-local opaque authorization behind `__Host-devserver_gate`. Its separate admin UUID is published to devserver-control for inventory and revocation. _Avoid_: OAuth session, cookie id

**tunnel**: One live `chan devserver` registration and yamux transport, keyed by owner plus devserver id and addressed for commands by registration UUID. A tunnel is not a session count. _Avoid_: session
