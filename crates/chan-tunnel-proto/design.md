# chan-tunnel-proto: design

## Cross-crate context

chan-tunnel has three boundaries: shared wire contracts, a dial-side client embedded by `chan devserver`, and a terminator embedded by the gateway.

End to end, `chan devserver` embeds the client and dials the terminator at `POST {tunnel-host}/v1/tunnel`; after the control handshake the single h2 stream becomes a yamux session, and the terminator opens one substream per public request:

```mermaid
sequenceDiagram
    participant V as Public visitor
    participant C as chan devserver client
    participant S as tunnel terminator
    Note over C,S: Dial plus control handshake, once per tunnel
    C->>S: POST /v1/tunnel plus Bearer token
    S->>S: validate token and tunnel scope
    S-->>C: 200 OK, h2 stream stays open
    C->>S: Hello frame (protocol, workspace, display name)
    S->>S: validate workspace and run pre_ack hook
    S-->>C: HelloAck Ok frame (prefix, user, workspace, owner_user_id)
    Note over C,S: h2 stream now belongs to yamux, both directions
    V->>S: public HTTP request
    S->>C: open one yamux substream
    S->>C: forward h1 request over substream
    C->>C: serve via axum router over hyper h1
    C-->>S: h1 response over substream
    S-->>V: public HTTP response
    C->>S: periodic yamux control stream: LeaseRefreshRequest (PAT)
    S->>S: revalidate exact registration authority
    S-->>C: LeaseRefreshResponse
```

The control + data path: one control handshake per tunnel, then a yamux substream per public request.

This document is the canonical reference for the wire format and framing. The client and server design.md files reference back here for any byte-level detail.

## 1. Problem and scope

A chan user wants their local workspace reachable on a public URL without opening a port, configuring DNS, or running a TURN/STUN stack. The constraint is "works through corporate NAT and HTTP-only egress." The shape that fits is one long-lived HTTPS request.

This crate owns:

- Control frames (`Hello`, `HelloAck`) and the one-shot yamux lease-refresh request/response, including structured refusal codes and redacted PAT debug behavior.
- Length-prefixed framing (`[u32 BE len][json bytes]`) used only for the two control messages.
- Workspace-name and username validators applied identically by client and server (defense-in-depth gate against URL-unsafe identifiers), plus `sanitize_workspace_name`.
- `H2Duplex`: an `AsyncRead + AsyncWrite + Unpin` over an h2 `(SendStream<Bytes>, RecvStream)` pair, feeding the post-handshake byte stream into yamux on both ends.
- `TUNNEL_PATH` and `MAX_CONTROL_FRAME_BYTES`.
- The gateway caller assertion (`gateway_assertion`): per-tunnel key derivation, signed caller claims, `canonical_audience`, and the token-resolved devserver id (PAT SHA-256).

Out of scope here, owned by the I/O crates:

- TLS, h2 client/server setup, request routing.
- yamux multiplexing, substream lifecycle.
- Token validation, registry of live tunnels.
- HTTP-level rewriting, X-Forwarded-* injection, upgrade bridging.

## 2. Architecture overview

The end-to-end control and data path is the sequence diagram above (Cross-crate context). This section covers the on-wire framing the two control frames share.

Framing for the two control messages is identical in both directions: a big-endian `u32` length prefix followed by that many JSON bytes.

After `HelloAck` is fully read on the client and fully written on the server, the outer byte stream belongs to yamux. The same bounded frame helper is later reused inside a dedicated one-shot yamux stream for `LeaseRefreshRequest` / `LeaseRefreshResponse`; it is never interleaved with public h1 substreams.

## 3. Components / responsibilities

The split between the sync codec (`BytesMut`-based `encode_frame` / `decode_frame`) and the async helpers (tokio `read_frame` / `write_frame` over `AsyncRead`/`AsyncWrite`) is deliberate: the sync codec is self-contained and reusable from any I/O loop. The async helpers exist because both real callers run on tokio; a caller on a different runtime would consume the sync codec directly.

## 4. Contract surface

This crate owns the stable tunnel path, the control-frame size cap, the Hello / HelloAck schemas, the refusal-code vocabulary, the shared identifier validators, the frame codec, and the h2 duplex adapter. Client and server crates may orchestrate I/O differently, but they must use these shared contracts for the bytes and validation rules.

Control frames are owned serde values with plain strings and enums, no borrowed lifetimes. `Hello` carries protocol, client version for logs, workspace, and an optional display name; `HelloAck` is either success with the assigned prefix/user/workspace plus the immutable `owner_user_id` or refusal with a stable code plus safe message. `LeaseRefreshRequest` carries the PAT only for the duration of exact-registration revalidation and redacts it from `Debug`; its response is `Refreshed` or a safe refusal. Refusal codes are additive and machine-matchable.

The codec split remains deliberate: the sync codec is reusable from any I/O loop, while the tokio helpers are convenience for the current callers. Errors flatten cleanly so client and server can convert them into their own umbrella enums without re-exporting h2 or serde internals.

## 5. Wire format / framing

### Why a length-prefixed JSON envelope, not HTTP headers

The handshake fields could in theory ride on the request line or custom headers (`X-Chan-Workspace: notes`, etc.). They don't, for three reasons:

1. The production terminator runs behind nginx with `grpc_pass`. nginx will strip or rewrite arbitrary request headers on h2-to-h2 forwarding depending on configuration; the body is opaque to it. Putting the contract in the body is invariant under proxy churn.
2. The reverse direction (`HelloAck`) needs to carry structured data back to the client (success with `prefix` / `user` / `workspace`, or a refusal with `code` / `message`). HTTP responses could use headers, but then the schemas are asymmetric and adding a field on the response side is a header-name fight rather than a serde additive change.
3. JSON in the body is symmetric, evolvable (`#[serde(default)]`), and trivially testable without standing up h2.

### Why JSON

The control frames are exchanged once per tunnel lifetime; encode cost is irrelevant. JSON is debuggable on the wire, additive-friendly via serde, and avoids a transitive dep on a binary codec the rest of the workspace doesn't already use. A frame costs on the order of 200 B.

### Length prefix

`u32` big-endian. The decoder reads the prefix first so it can size the read buffer before allocating. Without a prefix the decoder would have to scan for end-of-JSON, which is fragile (escaped quotes, embedded objects).

`u32` instead of varint to keep the cap check trivial: any value above `MAX_CONTROL_FRAME_BYTES` is rejected immediately, before any body bytes hit memory.

### MAX_CONTROL_FRAME_BYTES

64 KiB. Real frames are well under 1 KiB. The cap exists because a malicious or buggy peer could send `0xFFFFFFFF` followed by no data; without a cap, the receiver would either OOM trying to allocate a 4 GiB buffer or hang reading a non-existent body. 64 KiB is small enough that even the worst-case allocation is harmless on every target, and large enough for any plausible additive growth.

`encode_frame` checks the cap before writing; `decode_frame` checks it before allocating. Both refuse frames over the cap with `FrameError::TooLarge(len)`.

### No `public` bit (always authenticated)

Earlier revisions carried a `Hello.public` flag (`#[serde(default)]`, so absence decoded as `false`) that asked the terminator to skip its sign-in check for a public workspace; `true` was a privilege-escalation request, gated server-side on an extra token scope (`TUNNEL_PUBLIC_SCOPE`) and refused with `missing_public_scope` when the scope was absent. The per-devserver model removed all of it: the tunnel is always authenticated and there is no anonymous-readable path, so `Hello.public`, `TUNNEL_PUBLIC_SCOPE`, and the `missing_public_scope` refusal are gone. The gateway authorizes a viewer with a single `devserver_access(owner, devserver, caller)` check, where one grant covers the whole library; see `chan-tunnel-server/design.md` and the gateway's `devserver-proxy/design.md`. A legacy client that still sends a `public` key is harmless: `Hello` decoding ignores unknown fields.

### Hello.name (display name, additive)

`Hello` carries an optional `name` (`#[serde(default)] Option<String>`): the display name the devserver announces for the gateway roster (`chan devserver --tunnel-devserver-name`, defaulting to the client host's hostname). It is display-only metadata -- never part of routing or the registry key, which stay token-resolved -- and rides the additive-field rule with no `ProtocolVersion` bump: an old client omits the key and decodes as `None` on a new server; an old server ignores the unknown key from a new client. The terminator hands a non-empty name to its validator hook (`Validator::announce_devserver_name`); the production gateway persists it as the devserver's label, deduped per owner with `-2`/`-3` suffixes.

### HelloAck: Ok or Refused

`HelloAck` is a `kind`-tagged enum. The success arm carries the registration; the `Refused` arm carries a stable machine-readable `code` plus a human-readable `message`, written into the same stream the success ack would have used. Without it, every pre-ack refusal (cap reached, bad workspace name, unsupported protocol) would surface to the client as a bare transport disconnect, indistinguishable from a network failure. Clients match on known codes and fall back to the `message` for unknown ones, keeping the refusal vocabulary additive.

### HelloAckOk.prefix

Server-assigned public path prefix, shape `/{devserver_id}` -- one leading slash, no trailing slash. The username is not in the path: the fronting proxy routes tenant wildcard subdomains (`{owner}--{disc}.{proxy}.usr.{domain}`), so the host carries the owner and devserver while the `{workspace}` path segment carries the tenant. The devserver client ignores the prefix; each tenant self-prefixes at its keyed pathspec via `<meta name="chan-prefix">`.

### ProtocolVersion negotiation

Carried inside `Hello` as a transparent `u16`. The path (`/v1/tunnel`) is a stable mount point and does not bump on version changes; bumping `ProtocolVersion` is reserved for incompatible changes, while additive ones use serde defaults. Only `V1` is defined; the server refuses anything else with the `unsupported_protocol` code, and the client rejects a non-V1 ack.

### H2Duplex

`h2` exposes a request/response as a `SendStream<Bytes>` plus a `RecvStream`. yamux wants a single `AsyncRead + AsyncWrite + Unpin`. `H2Duplex` is the glue:

- `poll_read` pulls a `Bytes` chunk from `RecvStream::poll_data` into an internal pending buffer, copies into the caller's buffer piecemeal, and calls `release_capacity` for the chunk's length so the peer's flow-control window keeps moving. The release is best-effort: a stream the peer already reset errors here and the error is ignored; the next read surfaces it.
- `poll_write` sends up to the currently granted capacity. At zero capacity it calls `reserve_capacity` and loops on `poll_capacity`: h2 can resolve that poll with a zero grant, and returning `Pending` then would hang the writer (the consumed waker is gone), so the loop re-polls until the grant is non-zero, the stream errors, or `poll_capacity` itself returns `Pending`.
- `poll_flush` is a no-op; h2 has no explicit flush.
- `poll_shutdown` issues `send_data(Bytes::new(), true)` once to half-close the write side; subsequent calls are no-ops.

Symmetric: server side's `RecvStream` is the request body and `SendStream` is the response body; client side is the reverse. The adapter doesn't care which.

Both peers advertise a 16 MiB HTTP/2 stream window and a 32 MiB HTTP/2 connection window. The yamux peers cap the connection at 256 concurrent substreams and a 64 MiB aggregate receive window. These values are protocol-level transport invariants owned by this crate, even though they do not change the serialized control frames.

## 6. Trust boundaries / validation

This crate is the validator surface for two values that flow into public routing: the workspace name (from the client's `Hello`) and the username (from the server's `Validated`).

### Workspace name (`is_valid_workspace_name`)

Rules: 1..=32 ASCII bytes; characters `[a-z0-9-]`; first and last character alphanumeric (no leading/trailing hyphen). Both sides call it: the client refuses to send an invalid name, and the server refuses to accept one (`invalid_workspace_name` refusal). The duplication is intentional -- the server does not trust clients, and the client check surfaces a config error locally without a round-trip.

`sanitize_workspace_name` is a best-effort transform from a free-form string (often the workspace directory's basename) into a valid name: lowercase ASCII, collapse non-alnum runs to single `-`, trim, truncate. Returns `None` when the result would be empty so the caller can prompt the user instead of inventing a name.

### Username (`is_valid_username`)

Slightly looser than the workspace validator because real identity services emit mixed-case names with underscores: ASCII alphanumerics, `-`, `_`; first character alphanumeric (no leading punctuation); 1..=64. Applied by chan-tunnel-server after the validator returns, to keep `Validated::username` from carrying `..` / `alice/bob` / whitespace into public routing.

### Frame-size cap

64 KiB, enforced in both `encode_frame` and `decode_frame` (see section 5).

## 7. Error model

Two error categories, both flat: frame errors (`TooLarge`, recoverable `Incomplete`, JSON decode) and async I/O wrapper errors (frame or I/O).

`FrameError::Incomplete` is recoverable: the caller leaves the `BytesMut` untouched, reads at least `need` more bytes, and tries again. Every other variant is terminal for the handshake; the caller closes the stream.

The async helpers return `IoFrameError`; the sync codec returns `FrameError`. Client and server both convert into their own umbrella enums via `From`, flattening through `Display` so `h2::Error` and `serde_json::Error` never leak across crate boundaries.

## 8. Open questions / future extensions

- Multi-workspace over a single tunnel -- already met above the protocol, so no wire change is planned. `chan devserver` registers one tunnel (keyed on its token-resolved devserver id) and the gateway's devserver-proxy routes workspaces by the preserved `{workspace}` path segment, so a whole library rides one h2/yamux session without a `Hello { workspaces: Vec<...> }` shape or a per-workspace registry rework.
- Negotiated frame cap. Both sides hard-code 64 KiB; a larger cap negotiated inside `Hello` would let future versions carry richer initial metadata without a protocol bump.
