# chan-tunnel-server: design

## Keying and authentication model

The tunnel is per-DEVSERVER and always authenticated:

- The registry's second key is the token-resolved `devserver_id` (`Validated.devserver_id`, lowercase hex SHA-256 of the PAT), not the client's `Hello.workspace` (an ignored `"devserver"` placeholder). A devserver carries its whole library through one registration; the `{workspace}` path segment is tenant routing only. The code keeps the historical `workspace` name on the registry's inner key, exported types, and the `workspace_tunnel` task; the value it carries is the `devserver_id`.
- There is no `public` bit anywhere: `Hello.public`, `TUNNEL_PUBLIC_SCOPE`, `ServerError::MissingPublicScope`, the `missing_public_scope` refusal, and the `public` field on `TunnelHandle` / `WorkspaceInfo` / `TunnelInfo` do not exist. A viewer is authorized by the gateway's one `devserver_access(owner, devserver, caller)` check (a grant is the whole library).
- The gateway consumer is `devserver-proxy`; the public tenant origin is `{owner}--{disc}.{proxy}.usr.{domain}` (`disc` = the first 12 hex chars of the devserver id); it mounts its own segment-preserving reverse proxy. The forwarding, cap, and upgrade hygiene lives in that gateway layer; the public-side controls in section 6 document the contract it meets.

## Cross-crate context

chan-tunnel has three boundaries: shared wire contracts, a dial-side client driven by `chan devserver`, and this terminator embedded by the gateway.

This document covers terminator-side design. The wire format is in chan-tunnel-proto's design.md.

## 1. Problem and scope

The terminator side of chan-tunnel needs to:

- Accept long-lived h2c POSTs from arbitrary `chan devserver` clients.
- Authenticate the bearer token before committing to the body, returning the same empty 401 for an invalid token and a valid token without tunnel scope.
- Run the Hello / HelloAck round-trip and bind the registration to `(validated_user, token-resolved devserver_id)` (the requested workspace name is validated but ignored), emitting structured `HelloAck::Refused` frames for policy failures.
- Multiplex per-public-request substreams over the resulting yamux session.
- Expose live tunnels to a public-facing axum router so the host can route public requests at the registered peer.
- Tolerate flap (a `chan devserver` restart should reclaim its registration without waiting for a TCP timeout).

Out of scope:

- TLS termination. The gateway's nginx does it. This crate runs h2c.
- Token issuance / identity. The `Validator` trait is the seam.
- Persistence. The registry is in-memory; a restart drops every tunnel and clients reconnect.
- Wire format (chan-tunnel-proto).

## 2. Architecture overview

```mermaid
flowchart TD
    client["chan devserver: dial POST /v1/tunnel + Bearer"]
    nginx["nginx grpc_pass (h2c)"]
    listener["serve_tunnel_listener: TCP accept + Semaphore permit"]
    h2["h2 handshake, first stream POST /v1/tunnel"]
    validate{"validator.validate_registration() BEFORE 200"}
    reject["reply uniform auth 401 or upstream 5xx"]
    ack["200, handshake_validated_with_admission Hello/HelloAck + admission"]
    register["register_authorized_with_id_and_cap()"]
    driver["workspace_tunnel: per-tunnel task owns yamux Connection"]
    registry[("Registry: user -> devserver_id -> handle")]
    proxy["devserver-proxy public request"]
    get["registry devserver resolution -> TunnelHandle"]
    open["TunnelHandle.open() -> yamux substream"]
    h1["hyper h1 send_request over substream"]

    client --> nginx --> listener --> h2 --> validate
    validate -- "fail" --> reject
    validate -- "ok" --> ack --> register --> driver
    register -. "insert handle" .-> registry
    proxy --> get
    get -. "lookup" .-> registry
    get --> open
    open -. "OpenRequest" .-> driver
    open --> h1
    driver -. "yamux substream" .-> h1
    h1 -. "forward to" .-> client
```

*Terminator data path: dial through nginx to the listener, the validate-before-200 handshake into the registry, and the public request path through devserver-proxy back over a yamux substream.*

## 3. Components / responsibilities

### Listener flow

```mermaid
sequenceDiagram
    autonumber
    participant C as chan devserver
    participant L as serve_tunnel_listener
    participant H as handle_tunnel_conn
    participant V as Validator
    participant R as Registry

    C->>L: TCP connect
    L->>L: try_acquire permit (MAX_INFLIGHT 1024)
    Note over L: at cap drops socket and continues
    L->>H: spawn task with owned permit
    C->>H: h2 handshake (10s)
    C->>H: first stream POST /v1/tunnel + Bearer (10s)

    alt method != POST or path != /v1/tunnel
        H-->>C: 404 Not Found
    else missing or empty Bearer
        H-->>C: 401 Unauthorized
    else gates pass
        H->>H: spawn frame driver (extra stream 409, then ENHANCE_YOUR_CALM)
        H->>V: validate_registration(token) (10s)
        alt validate timeout
            H-->>C: 504 Gateway Timeout
        else InvalidToken
            H-->>C: 401 Unauthorized
        else Identity error
            H-->>C: 502 Bad Gateway
        else Validated but no tunnel scope
            H-->>C: 401 Unauthorized
        else Validated with tunnel scope
            V-->>H: Validated (user, devserver_id, scopes)
            Note over H,C: validate-before-200 invariant: 200 only AFTER auth passes
            H-->>C: 200 OK (body open)
            H->>C: handshake_validated_with_admission reads Hello (15s)
            C->>H: Hello frame
            Note over H,C: protocol/workspace/pre_ack failures refused in-band (HelloAck Refused)
            H->>C: HelloAck Ok
            H->>R: register_authorized_with_id_and_cap (authoritative per-user cap)
            alt raced past cap
                H->>H: drop yconn (client sees transport disconnect)
            else registered
                R-->>H: handle, open_rx, shutdown_rx
                H->>H: drop permit, run workspace_tunnel
            end
        end
    end
```

*Listener handshake ordering and the validate-before-200 invariant; the numbered steps below carry the per-stage contracts.*

`serve_tunnel_listener(listener, validator, registry, max_workspaces_per_user)`:

1. `TcpListener::accept`. Try to acquire one permit from a per-listener `Semaphore::new(MAX_INFLIGHT_HANDSHAKES)` (1024). If the semaphore is empty, the TCP socket is dropped and the loop continues; this bounds memory against floods of half-open peers that have not yet hit a per-stage timeout. Otherwise spawn `handle_tunnel_conn` carrying the owned permit.
2. The h2 server builder advertises the shared 16 MiB stream and 32 MiB connection receive windows, then handshakes under `H2_HANDSHAKE_TIMEOUT` (10s).
3. First `conn.accept()` under `FIRST_STREAM_TIMEOUT` (10s).
4. Reject `(method != POST) || (path != TUNNEL_PATH)` with 404.
5. Parse `Authorization: Bearer ...` (case-insensitive scheme, SP/HTAB separator, trimmed token); reject missing / empty with 401.
6. Spawn an h2 frame driver task BEFORE awaiting the validator: the validator may be a network round-trip and h2 only progresses while polled. The task rejects any subsequent stream on the same connection with 409 (clients must only ever open one) and `abrupt_shutdown(ENHANCE_YOUR_CALM)` after `MAX_DRAINER_REJECTIONS` (16) rejections.
7. Call `validator.validate_registration(token, registration_id).await` under `VALIDATE_TIMEOUT` (10s, independent of any timeout the `Validator` impl enforces internally). On timeout, reply 504. On error: 401 (`InvalidToken`), 502 (`Identity`), or 500. Validation runs before the 200 so authentication failures are not collapsed into generic transport failures.
8. Verify the validated token's `scopes` contains `"tunnel"`; otherwise send an empty 401 and return `ServerError::MissingScope` to the listener.
9. Send 200 (response headers, body open). Wrap `(SendStream, recv_body)` in `H2Duplex`.
10. `handshake_validated_with_admission(duplex, validated, admission, registration_id)` (`handshake_validated` + `pre_ack` remain the embedder-facing free functions):
   - Defense-in-depth username check (`is_valid_username`).
   - `read_frame::<Hello>` with `HELLO_READ_TIMEOUT` (15s) bound.
   - Reject non-V1 protocol and invalid workspace names. Each rejection writes a `HelloAck::Refused { code, message }` frame (best-effort) before returning so the client receives a structured error instead of a transport disconnect.
   - Run the admission check for post-validate policy: `LocalAdmission::admit` does a best-effort per-user count over distinct `devserver_id`s (controller deployments substitute their own `RegistrationAdmission`), run under `VALIDATE_TIMEOUT` before the ack. On failure, the `ServerError` is mapped to a stable refusal code (`chan_tunnel_proto::error_code`) and a `HelloAck::Refused` is written before returning.
   - On success, write `HelloAck::Ok(HelloAckOk { prefix: "/{devserver_id}", user, workspace, .. })` and wrap the duplex in yamux server mode with a 256-substream cap and 64 MiB aggregate receive window.
11. `registry.register_authorized_with_id_and_cap(...)` returns a `TunnelHandle`, the open-request `mpsc::Receiver`, and the eviction `oneshot::Receiver`. This is the authoritative cap check: the admission count was best-effort, and two parallel dials could both pass it; `register_authorized_with_id_and_cap` does count + insert under one lock acquisition. A loser here has already received HelloAck; dropping the yamux connection on the early return surfaces as a transport disconnect. The in-flight semaphore permit is dropped after registration so a long-lived tunnel does not consume an accept slot.
12. `workspace_tunnel(...)` runs until close or eviction. On exit, `registry.deregister_if_owner(&handle)`.

### Driver loop

One task per registered tunnel owns the yamux `Connection`. Its concerns are merged into a single `poll_fn`:

- Shutdown takes priority. The `oneshot::Receiver` resolves either on explicit `()` send or sender drop (the registry drops it on eviction). Either signal exits the loop and `poll_close`s yamux.
- Drain pending `OpenRequest`s from the public side into a local queue and call `poll_new_outbound`; reply with the new substream over the oneshot in the request.
- Poll for the one client-opened control shape: admission-lease refresh. At most one refresh is pending; additional inbound streams are dropped. Refresh is handled outside the driver poll so identity validation does not stall public outbound stream allocation.

On exit the driver replies `OpenError::Disconnected` to any open requests still queued, then deregisters itself if it still owns the registry slot.

`poll_fn` rather than `select!` because two of the three branches need `&mut conn` and `select!` over multiple `poll_fn`s holding that borrow conflicts.

### Admission authority and lease refresh

Controller-backed embedding uses `serve_tunnel_listener_with_admission`. Identity validation returns an opaque signed admission lease bound to `(owner_user_id, user, devserver_id, registration_id, proxy_id)`. Before `HelloAck::Ok`, `RegistrationAdmission::admit_registration` asks the control plane to verify the lease and reserve capacity. A synchronous admission epoch is checked immediately before and after registry insertion; losing control invalidates the epoch, so an already-admitted but stalled handshake cannot register after fail-closed eviction.

The lease expires independently of TCP/yamux liveness. Before expiry, the client opens an inbound refresh stream and sends its PAT in `LeaseRefreshRequest`. One absolute 10-second deadline covers reading the frame, identity revalidation, registry update, and response write. The refreshed identity must preserve the existing user id, username, and devserver id, and must return a new lease for the same registration. The PAT is dropped after validation and every related `Debug` surface is redacted. A successful registry update publishes `RegistryEvent::LeaseRefresh`; devserver-proxy forwards only the signed lease to the controller as a generation-contiguous refresh. Failed refreshes can retry, but reaching lease expiry closes and deregisters the tunnel.

### Registry

- Two-level map `user -> devserver_id -> Entry` (keys `Arc<str>`) under `parking_lot::Mutex`. The split lets `get(&str, &str)` resolve via `Borrow<str>` without allocating, and makes per-user enumeration a direct inner-map walk. Empty user buckets are removed. (The inner key is named `workspace` in the code; its value is the token-resolved `devserver_id`.)
- `Entry { handle: TunnelHandle, _shutdown_tx: oneshot::Sender<()> }`. Dropping the entry drops the sender, which wakes the per-tunnel driver's receiver, which closes yamux.
- Collision: last-writer-wins. `register_authorized_with_id_and_cap` evicts any prior entry for the same key, logs the prior registration's age (flap visibility), and returns the new handle. A devserver restart reclaims its registration.
- Per-user cap: `register_authorized_with_id_and_cap` refuses (`RegisterCapped`) when the user already holds `max_workspaces_per_user` distinct registrations (devserver ids) and this key is not among them; `0` disables the check. Count and insert happen under the same lock, so parallel dials cannot race past the cap.
- `TunnelHandle::open()` sends an open request (`oneshot::Sender<Result<yamux::Stream, OpenError>>`) over the per-tunnel mpsc and awaits the reply; `OpenError::Disconnected` if either channel is gone.
- `deregister_if_owner` removes the entry only if it still points at the same handle (matching `registration_id`), so a driver shutting down after eviction can't accidentally remove its successor.
- Admin views: `list_workspaces_for(user)` and `list_all()`, both sorted, carrying the peer address and connect time for dashboard / `ps`-style tooling (the `public` bit is gone). `evict(user, devserver_id)` forces a tunnel offline.

### Gateway forwarding path

Public-side forwarding lives in the gateway; this crate exposes only `TunnelHandle::open`. The proxy parses `{owner}` and the optional `--{disc}` discriminator from the wildcard host (`{owner}--{disc}.{proxy}.usr.{domain}`), gates the viewer with the opaque per-devserver `__Host-devserver_gate` session cookie (minted by the Ed25519 entry exchange), and forwards the full segment-preserving `/{workspace}/...` path over the substream. The forwarding contract it meets:

- One outbound substream per public request, driven by `hyper::client::conn::http1` with `with_upgrades()`. h1 maps cleanly because the substream is already muxed (see "Why h1 over yamux").
- A single deadline covers `handle.open()` (502 on `Disconnected`, 504 on timeout), the h1 handshake, and `send_request` up to response headers.
- WebSockets: axum's `WebSocketUpgrade` is extracted after the gate; the proxy runs tungstenite's `client_async` handshake directly on a fresh substream and pumps frames both ways, resetting a monotonic idle deadline per frame so wall-clock jumps (NTP slew, suspend/resume) cannot register as activity.
- Forwarded-header sanitisation and request/response body caps (section 6) bound what a public visitor can inject or stream through to chan-serve.

See the gateway's `devserver-proxy/design.md` for the full layer.

### Why h1 over yamux, not h2

The substream is already a multiplexed channel; running h2 inside would be mux-on-mux. h1 maps cleanly: one substream is one request. WebSocket upgrades work with `with_upgrades()`. Body streaming works through the yamux flow-control window.

### Why h2c (not TLS) on the listener

The deployment in front owns transport security: nginx terminates TLS at the gateway and forwards h2c via `grpc_pass` on the `/v1/tunnel` path. Running rustls here would duplicate trust config and complicate cert rotation. The listener itself is h2c-only; any host can put its own TLS layer in front.

## 4. Embedding contracts

The host supplies a `Validator`; this crate never issues or interprets tokens itself. Validation returns the authenticated user, username, token-resolved devserver id, and scopes. The listener requires the tunnel scope before sending 200, and post-200 policy failures are reported as structured HelloAck refusals.

The listener is the only path that inserts tunnels into the registry. It owns validate-before-200, Hello/HelloAck, per-user cap enforcement, and transition into the driver loop. Registration itself stays crate-private so embedders cannot mint handles that bypass validation.

The registry is keyed by user plus token-resolved devserver id. It exposes lookup for public forwarding, sorted snapshots for dashboard/admin views, and explicit eviction. A `TunnelHandle` opens one yamux substream for one public request; its single failure category is disconnected, which public callers map to 502.

Public-side forwarding belongs to the gateway. This crate intentionally exposes no public router or public config; the gateway layers authentication, host routing, body caps, forwarded-header sanitation, rate limits, and upgrade bridging on top of `TunnelHandle::open`.

## 5. Wire format / framing

The wire format is owned by chan-tunnel-proto. See [`chan-tunnel-proto/design.md`](../chan-tunnel-proto/design.md) sections 2 and 5 for the byte layout, the JSON envelope rationale, the 64 KiB cap, and `H2Duplex`.

Server-specific notes:

- The 200 response is sent BEFORE the framed `Hello` is read but AFTER the validator and tunnel-scope gate run. This split is the reason `handshake_validated` exists alongside `handshake`: the listener needs to return a uniform 401 for authentication failures prior to committing to the body.
- Failures after the 200 (bad protocol, bad workspace name, `pre_ack` policy) are reported in-band as `HelloAck::Refused` with a stable code, written best-effort before the stream is dropped. `refusal_for` maps `TooManyWorkspaces` and `AdmissionAtCapacity` to `too_many_workspaces` and `ControlUnavailable` to `control_unavailable`; anything else surfaces as `internal` with the error's `Display` as message.
- `HELLO_READ_TIMEOUT = 15s` bounds slow-loris-style peers that connect, get the 200, and never frame a `Hello`. 15s is plenty for trans-pacific; tighter would risk false positives on slow mobile uplinks.
- The yamux config caps each tunnel at 256 concurrent streams and a 64 MiB aggregate receive window. A visitor opening many slow requests is bounded without reducing normal browser concurrency.
- `HelloAckOk.prefix` is `/{devserver_id}` (the resolved id the registration is keyed on; the devserver client ignores it -- tenants self-prefix at their public slugs). The username travels in the wildcard host on the public side, not in the path.

## 6. Trust boundaries / validation

- **Token authentication**: the consumer's `Validator` impl is the identity authority. This crate calls it; on success it gets a redacted `Validated` carrying immutable ids, scopes, the per-tunnel assertion key, and (in controller deployments) a registration-bound admission lease with expiry. Order is fixed: validator and tunnel-scope checks run *before* the 200 response. Invalid and scopeless tokens receive the same empty 401, while the listener receives `ServerError::InvalidToken` or `ServerError::MissingScope`. After 200, policy failures are reported via `HelloAck::Refused`. The validator contract forbids logging, echoing, or persisting the token; listener error values are safe to log only because this seam honors that contract.
- **Control-plane admission**: `RegistrationAdmission` is the fleet-capacity and liveness authority. The proxy must obtain a current permit before acknowledging or inserting a tunnel. Control loss invalidates permits and refuses new admissions; there is no local fallback in the production embedding.
- **Residual assigned-node trust**: an honest proxy does not retain the PAT beyond validation and redacts all related debug surfaces, but the proxy process necessarily sees the raw PAT during initial validation and refresh. A fully compromised assigned node can capture and reuse it until identity revokes it or it expires. Admission leases are not a TEE boundary; node isolation and PAT rotation/revocation remain required incident response.
- **Tunnel scope**: the validator returns scopes; the listener refuses tokens missing `TUNNEL_SCOPE` (`"tunnel"`) with the same empty 401 used for an invalid token, while logging `ServerError::MissingScope` internally.
- **Public scope**: REMOVED. The tunnel is always authenticated -- there is no anonymous-readable path -- so `TUNNEL_PUBLIC_SCOPE` / `Hello.public` / `MissingPublicScope` are gone. The gateway authorizes a viewer with one `devserver_access(owner, devserver, caller)` check (a grant is the whole library); see the gateway's `devserver-proxy/design.md` and ADR-0001.
- **Username validation** (`is_valid_username`): defense-in-depth. The username flows into public routing; if the upstream identity service ever emits `..`, slashes, or whitespace, the public side would mis-route. The handshake refuses any username that wouldn't be URL-safe.
- **Workspace name validation** (`is_valid_workspace_name`): every Hello's `workspace` field is checked; clients pre-check too but we don't trust them.
- **Per-user registration cap**: `max_workspaces_per_user` bounds how many distinct registrations (distinct `devserver_id`s) one user can keep. Checked best-effort in admission (clean refusal on the wire) and authoritatively under the registry lock at insert.
- **Method / path gate**: 404 for anything other than `POST /v1/tunnel`. The drainer task rejects additional streams on the same connection with 409 and abrupt-shutdowns the connection (ENHANCE_YOUR_CALM) after 16 rejections.
- **Bearer parsing**: scheme name is case-insensitive (RFC 6750); the scheme/token separator is one or more SP / HTAB (RFC 7230 BWS); empty / whitespace-only tokens are rejected.
- **Listener back-pressure cap**: at most `MAX_INFLIGHT_HANDSHAKES` (1024) connections may sit in the authenticate-and-handshake stages simultaneously. Above that the TCP socket is closed immediately so a flood of half-open peers cannot exhaust memory. Per-stage timeouts (h2 handshake 10s, first stream 10s, validate 10s, Hello read 15s) bound each slot.
- **Public-side controls**: the items below describe the forwarding hygiene the gateway enforces; the knobs are devserver-proxy environment configuration.
- **Public-side body policy**: `MAX_REQUEST_BYTES` and `MAX_RESPONSE_BYTES` default to 100 MiB and wrap general request and response bodies in `http_body_util::Limited`; zero disables the corresponding general cap. Exact multipart-upload and form-decoded download routes use explicit 100 GiB caps. The server-side copy route retains the general JSON byte caps. A non-HEAD response whose declared length exceeds its effective cap is refused with 502 before body forwarding; unknown-length responses remain bounded while streaming.
- **Upstream request timeout**: `REQUEST_TIMEOUT_SECS` (default 60s, 0 disables) is one deadline across opening the substream, the h1 handshake, response headers, and body streaming (`DeadlineBody`), limited by the session expiry. Exact upload, download, and server-side copy routes use a 24-hour deadline. A miss before headers returns 504 and a mid-body miss errors the stream.
- **WS idle window**: a bridged WebSocket is cut only after BOTH directions are quiet for `DEFAULT_WS_IDLE_TIMEOUT` (300s); any frame resets the window, and teardown sends a real Close frame to each half. Keeps a public client that 101'd and went silent from pinning the substream forever.
- **Host routing**: the dispatcher accepts only the configured apex and the configured wildcard suffix (`{owner}` / `{owner}--{disc}` single label); any other Host is 404, so a misrouted listener exposes nothing.
- **Per-visitor rate limit**: none in-process. Behind nginx the visible peer is always the proxy, so a peer-IP limiter would key every visitor into a single bucket; rate-limiting belongs upstream (`limit_req_zone $binary_remote_addr`).
- **Forwarded-header sanitisation** (`strip_inbound_headers` + `apply_forwarded`): hop-by-hop and Connection-listed headers, `Host`, `Cookie`, `Authorization`, the CSRF header, and inbound `X-Forwarded-{For,Proto,Host}` are stripped before the proxy re-injects its own values; the public side does not get to dictate any of these to the devserver, and public visitors cannot inject bearer tokens or cookie state into it (public-side authentication is the proxy's job). `X-Forwarded-Proto` comes from `FORWARDED_PROTO` (default https), `X-Forwarded-Host` from the routed Host, and `X-Forwarded-For` is the socket peer only -- inbound XFF is never trusted and there is no append knob.

## 7. Error model

Single umbrella enum `ServerError` with eight variants (see section 4). Conversions from `chan_tunnel_proto::FrameError` and `IoFrameError` flatten through `Display`, so the crate boundary stays free of `h2::Error`, `serde_json::Error`, and `yamux::Error`. On the wire, pre-ack policy errors additionally map to stable `HelloAck::Refused` codes via `refusal_for`.

`OpenError::Disconnected` is the single failure mode of `TunnelHandle::open()`: either the request channel is gone (the driver has already exited) or the reply channel was dropped (the driver couldn't allocate the substream because yamux is closing). Public-side callers map both into 502.

## 8. Open questions / future extensions

- Persistent registry. Today a host restart drops every tunnel and clients reconnect. A small on-disk index would let the public side serve "tunnel offline since X" errors with context instead of a bare 502 during a restart.
- Per-tunnel quotas. `max_workspaces_per_user` caps workspace count; nothing caps a single tunnel's concurrent in-flight requests (beyond the 256-substream yamux cap), total bandwidth, or request rate.
- Multi-workspace per tunnel. See chan-tunnel-proto's design.md section 8; would change the registry shape so one yamux session can serve several workspaces.
- Health probe on the substream. The driver currently learns about a dead peer when yamux errors or an `open` fails. An explicit application-level ping over a control substream would give the public side faster failover.
