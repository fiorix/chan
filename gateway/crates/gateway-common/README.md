# gateway-common

Shared internal library for the chan-gateway crates: typed HTTP clients, the Ed25519 entry credential, internal-transport checks, validators and the token-bucket throttle primitive.

Not published; not user-facing. Has no binary.

## Role in the system

The gateway services need the same plumbing in several places: calling profile-service and devserver-control, validating usernames, signing and verifying the browser entry handoff, protecting internal boundaries, and throttling token validation. This crate is the single home for those contracts.

## Build

```bash
cargo build -p gateway-common
cargo test  -p gateway-common
```

## Modules

- `profile_client`: typed reqwest wrapper over profile-service's HTTP API. Owns its own `ProfileError` enum so the client carries no axum coupling; each consumer maps it onto its local error via a `From` impl.
- `devserver_control_client`: typed reqwest wrapper over devserver-control's `/admin/v1/*` tree.
- `devserver_gate`: Ed25519 encode and decode for the short-lived, single-use entry credential. Standing browser sessions are opaque and proxy-local.
- `internal_transport`: fail-closed validation for cleartext internal listeners and service URLs.
- `token_bucket`: per-fingerprint token bucket with a bounded map, plus the shared default limits for the two validate throttles.
- `validators`: username shape validation and the lifetime rename cap.
- `wireguard`: public-key and ingress-host validation, the `Ingress` type (one proxy node's WireGuard interface as a desktop reaches it: its id, endpoint and public key), enrolled peer and active-list shapes. `ProfileClient` enrolls a peer, one per key across the gateway, and reads the gateway's active list as one host id with ETag/304 support.
- `static_files`: generic SPA-fallback handler over `rust_embed::RustEmbed`. Each consumer keeps its own `#[derive(Embed)]` (rust_embed resolves the `#[folder]` path relative to the deriving crate) and calls `static_files::serve::<Assets>(uri, banner)`.
- `shutdown`: graceful-shutdown future (SIGTERM or Ctrl-C) used by every service binary.

## Design rationale

See [`design.md`](design.md).
