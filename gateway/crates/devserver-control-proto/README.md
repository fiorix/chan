# devserver-control-proto

Wire contract between devserver-proxy nodes and devserver-control: the frame types for the h2c control session, the length-prefixed JSON framing helpers, the validated id and origin types, the signed admission lease, and the shared limits.

Not published; not user-facing. Has no binary.

## Role in the system

The control session is the only channel between a proxy and the controller, and both sides must agree on every byte of it. This crate is the single home for that agreement so the client (devserver-proxy) and the server (devserver-control) cannot drift. It has no axum, h2 or gateway-service dependency, so it stays cheap to compile for both sides. identity depends on it too, to sign admission leases.

## Build

```bash
cargo build -p devserver-control-proto
cargo test  -p devserver-control-proto
```

## Contents

- `ClientFrame` and `ServerFrame`: the versioned, serde-tagged frame enums for combined tunnel and tenant-session snapshot staging, contiguous deltas, admission, kills, revocations, heartbeat, resync and readiness.
- `read_frame` and `write_frame`: a big-endian length prefix plus a JSON body, capped at `MAX_FRAME_BYTES`.
- `TunnelRow`: one registration with its verified signed per-user limit.
- `BrowserSessionRow`: one redacted tenant-session row keyed by an admin UUID, never by its cookie id.
- `SessionRevocation`: exact, subject, admin-session-id, owner and fleet-wide revocation selectors.
- `AdmissionDecision`: `Admit`, `AtCapacity`, `ControlWarming`, `Stale`.
- `AdmissionLease` with `AdmissionLeaseSigner` and `AdmissionLeaseVerifier`: the identity-signed Ed25519 admission lease. Its claims carry the admission purpose, the protocol version, a binding of `(owner_user_id, user, devserver_id, registration_id, proxy_id)`, a positive bounded `max_connected_devservers`, and an issued and expiry pair with a bounded lifetime and clock skew.
- `ProxyId`, `CanonicalOrigin`, `ProxyOriginTemplate`: a validated node id (one lowercase DNS label), a canonical http(s) origin, and the origin template with exactly one `{proxy_id}` placeholder used to check a proxy's announced base URL.
- Limits and constants: `PROTOCOL_VERSION`, `CONNECT_PATH`, `CONTENT_TYPE`, the snapshot chunk, row and byte caps for tunnels and browser sessions, and the proxy grace, convergence and controller retention intervals both sides must agree on.

## Design rationale

See [`../devserver-control/design.md`](../devserver-control/design.md) for the session lifecycle and protocol semantics this crate encodes.
