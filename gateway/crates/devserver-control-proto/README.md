# devserver-control-proto

Wire contract between devserver-proxy nodes and devserver-control: the frame types for the h2c control session, the length-prefixed JSON framing helpers, the validated id and origin types, and the shared limits.

Not published; not user-facing. Has no binary.

## Role in the system

The control session is the only channel between a proxy and the controller, and both sides must agree on every byte of it. This crate is the single home for that agreement so the client (devserver-proxy) and the server (devserver-control) cannot drift. It has no axum, h2, or gateway-service dependency, so it stays cheap to compile for both sides.

## Build

```bash
cargo build -p devserver-control-proto
cargo test  -p devserver-control-proto
```

## Contents

- `ClientFrame` / `ServerFrame`: the versioned, serde-tagged frame enums for combined tunnel and tenant-session snapshot staging, contiguous deltas, admission, kills, revocations, heartbeat, resync, and readiness.
- `read_frame` / `write_frame`: u32 big-endian length prefix plus a JSON body, capped at `MAX_FRAME_BYTES` (1 MiB).
- `TunnelRow`: one registration with its verified signed per-user limit.
- `BrowserSessionRow`: one redacted tenant-session row keyed by an admin UUID, never by its cookie id.
- `SessionRevocation`: exact, subject, admin-session-id, owner, and fleet-wide revocation selectors.
- `AdmissionDecision`: `Admit`, `AtCapacity`, `ControlWarming`, `Stale`.
- `AdmissionLease` with `AdmissionLeaseSigner` / `AdmissionLeaseVerifier`: the identity-signed Ed25519 admission lease. Its claims carry purpose `chan.devserver.admission`, the protocol version, a binding of `(owner_user_id, user, devserver_id, registration_id, proxy_id)`, a positive `max_connected_devservers` capped at `MAX_SIGNED_CONNECTED_DEVSERVERS` (1,000,000), and an issued/expiry pair bounded to 300 seconds with 30 seconds of clock skew.
- `ProxyId`, `CanonicalOrigin`, `ProxyOriginTemplate`: validated node id (one lowercase DNS label), canonical http(s) origin, and the origin template with exactly one `{proxy_id}` placeholder used to check a proxy's announced base URL.
- Limits: `PROTOCOL_VERSION` (2), `CONNECT_PATH` (`/v1/proxies/connect`), `CONTENT_TYPE`, `MAX_SNAPSHOT_CHUNK_ROWS` (128), `MAX_SNAPSHOT_ROWS` (2,048), `MAX_BROWSER_SESSION_SNAPSHOT_ROWS` (100,000), and explicit byte/count bounds.

## Design rationale

See [`../devserver-control/design.md`](../devserver-control/design.md) for the session lifecycle and protocol semantics this crate encodes.
