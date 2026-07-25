# gateway-common

Shared internal library for the chan-gateway crates: typed HTTP clients, Ed25519 entry credentials, internal-transport checks, validators, and the token-bucket throttle primitive.

Not published; not user-facing. Has no binary.

## Role in the system

The gateway services need the same plumbing in several places -- calling profile-service and devserver-control, validating usernames, signing and verifying the browser entry handoff, protecting internal boundaries, and throttling token validation. This crate is the single home for those contracts.

## Build

```bash
cargo build -p gateway-common
cargo test  -p gateway-common
```

## Modules

- `profile_client`: typed reqwest wrapper over profile-service's HTTP API. Owns its own `ProfileError` enum so this crate has no axum / IntoResponse dependency.
- `shutdown`: graceful-shutdown future (SIGTERM or Ctrl-C) used by every service binary.
- `static_files`: generic SPA-fallback handler over `rust_embed::RustEmbed`. Each consumer keeps its own `#[derive(Embed)]` (rust_embed resolves the `#[folder]` path relative to the deriving crate) and calls `static_files::serve::<Assets>(uri, banner)`.
- `token_bucket`: per-fingerprint token bucket with a bounded map, plus the shared default limits for the two validate throttles.
- `validators`: username shape validation + the lifetime rename cap.
- `devserver_control_client`: typed reqwest wrapper over devserver-control's `/admin/v1/*` tree.
- `devserver_gate`: Ed25519 encode/decode for the 30-second, single-use entry credential. Standing browser sessions are opaque and proxy-local.
- `internal_transport`: fail-closed validation for cleartext internal listeners and service URLs.

## Design rationale

See [`design.md`](design.md).
