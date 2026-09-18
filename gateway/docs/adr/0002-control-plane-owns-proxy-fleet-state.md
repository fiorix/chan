# The control plane owns proxy fleet state

Status: accepted (2026-07-21).

A singleton, database-free controller (`devserver-control`) owns the dynamic proxy directory, the aggregate tunnel view, fleet admission, and command routing for the devserver proxy fleet. Every `devserver-proxy` node holds one authenticated h2 control session to the controller, publishes its full registry snapshot plus deltas, asks the controller for an admission decision before acknowledging any tunnel, and executes the controller's kill commands. identity, profile, and the admin CLI read one coherent aggregate view from the controller's `/admin/v1/*` tree; the proxy no longer exposes a process-local management view. Fleet state lives in one owner task fed by bounded messages, never in PostgreSQL: the state is a liveness view that is worthless when stale, and the owning proxy process is the only authority that can refresh it.

## Considered options

- **DNS round-robin across unchanged proxies** rejected: tenant traffic is not guaranteed to reach the process holding the yamux handle, so no load-balancer shape avoids an ownership directory.
- **A shared PostgreSQL registry** rejected: a database cannot serialize a usable `TunnelHandle`, and rows retained after a process failure would report stale ownership as truth.
- **Query-time fan-out from identity, profile, or the admin CLI** rejected: it has no safe answer when one proxy is unreachable (partial read presented as fleet truth), and it would make the profile sweeper depend on a distributed partial read.
- **Fleet ownership embedded in identity or profile** rejected: that couples proxy churn and command routing to database-facing request services; a dedicated database-free controller keeps those responsibilities separate.
- **A central tenant reverse proxy keeping one wildcard host** rejected: it adds another streaming HTTP/WebSocket hop and makes the central machine the data-plane bottleneck that proxy scaling exists to remove.
- **Singleton controller (chosen).** The controller carries metadata and commands only; tenant data never crosses it, so its cost is one small stateless process per deployment.

## Failure semantics

- Loss of the controller stops new tunnel admission immediately: a proxy admits nothing while its control session is down, and there is no singleton or local-admission fallback.
- Existing data paths get a bounded 30-second reconnect grace (`grace_seconds: 30`, heartbeats at 5 seconds, dead at 15). When grace expires, the proxy evicts every tunnel it holds and fails closed; recovery requires a fresh snapshot and `FleetReady`.
- After a controller restart, `/readyz`, aggregate reads, management writes, and admissions hold 503 until at least one complete proxy snapshot has arrived and a 30-second convergence window has elapsed. Duplicate rows left inside the proxies' grace period reconcile deterministically (lexicographically smallest `(proxy_id, registration_id)` wins; losers are commanded down before readiness), so a controller outage cannot create indefinite untracked or conflicting tunnels.
- A disconnected proxy's unpublished rows remain retained authority through the convergence deadline and continue to consume fleet capacity. Authority is keyed by `(proxy_id, boot_id)`, so a changed-boot reconnect cannot hide an unreachable old process. Non-empty snapshots from a changed boot are quarantined once the fleet is ready.
- Browser-session revocation is a distributed command. The controller reports completion only when fleet authority is ready, no retained proxy authority is unreachable, and every addressed proxy confirms that matching HTTP/WebSocket bridge tasks have been force-stopped and drained. An already-minted entry credential can still create a session until its 30-second lifetime plus skew ends; destructive identity workflows therefore wait that window and perform a second acknowledged revocation before final completion.

## Security and resource authority

- Identity signs a short-lived admission lease bound to owner id, username, devserver id, registration id, and proxy id. The controller verifies it at admission, snapshot/delta ingestion, and refresh. The live client keeps the PAT and periodically re-presents it to identity over a dedicated tunnel stream; only the resulting lease reaches the controller, and expiry closes the tunnel.
- Proxy fleet credentials are allowlisted per proxy id with a two-key rotation bound. Admin credentials are separate for operator, identity, and profile scopes. Credential values are distinct visible ASCII and are compared in constant time.
- Cleartext control HTTP/h2c is permitted only on loopback or when deployment explicitly asserts the exact protected-overlay mode. Bearers authenticate authority but do not provide transport confidentiality.
- Memory and work are finite: 128 live sessions, 256 live-plus-disconnected authorities, 2,048 rows/2 MiB per session snapshot, 16,384 rows/64 MiB fleet state, bounded pending claims/commands/watches, a 64-frame inbound queue, and a 32-frame-per-second sliding limit per established session. The offending session is retired on overflow or flood.
- These controls do not turn an assigned proxy node into a trusted execution environment. A fully compromised node can capture the raw PAT while it transiently passes through initial validation or lease refresh, then exercise stolen-PAT transfer/impersonation until that PAT is revoked or expires. Leases and scoped service credentials constrain fleet authority and honest retention; deployment node isolation, incident eviction, and PAT rotation/revocation remain the response to node compromise.
- **2026-09-18:** The proxy also handles the PAT during the Hello-name announcement and while a tunnel's h2 connection lasts; see 'Devserver publication' in `gateway/design.md` for the inventory, and `crates/chan-tunnel-server/design.md` for residual trust details.

## Consequences

- The controller is a singleton. Losing it stops admission fleet-wide until it returns and convergence completes; controller HA, durable control state, leader election, and cross-region replication are out of scope.
- The aggregate `/admin/v1/*` tunnel tree moves from devserver-proxy to devserver-control; consumers point `DEVSERVER_ADMIN_URL` at the controller and always see either one coherent fleet view or an explicit upstream failure, never a partial process snapshot.
- Every management kill routes by registration UUID to the owning proxy only; proxy nodes hold no database, profile-service, OAuth, session, or operator-admin credential.
- All gateway services and proxies run the exact same package version; the control handshake rejects a mismatch.
