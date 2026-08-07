//! Shared helpers for the chan-gateway crates.
//!
//! Modules:
//!
//!   * `profile_client`: typed HTTP client for profile-service. Used
//!     by identity-service. Owns its own error enum (`ProfileError`);
//!     the consumer maps it onto its local axum error via a `From`
//!     impl.
//!   * `shutdown`: graceful-shutdown future (SIGTERM or Ctrl-C) used
//!     by every service binary.
//!   * `static_files`: rust-embed-backed SPA-fallback handler. Each
//!     consumer keeps its own `#[derive(Embed)]` (rust-embed resolves
//!     the `#[folder]` path relative to the deriving crate) and calls
//!     `static_files::serve::<Assets>(uri, banner)`. Used only by
//!     identity-service; devserver-proxy ships no SPA.
//!   * `token_bucket`: per-fingerprint token bucket with a bounded
//!     map, plus the shared default limits. Backs the brute-force
//!     throttle in `devserver_proxy::throttle_validator` and
//!     `identity::token_throttle`; both wrap this primitive in a
//!     thin trait-level adapter.
//!   * `validators`: username shape validation and the lifetime
//!     rename cap, shared by identity, profile, and devserver-proxy.
//!   * `devserver_control_client`: typed HTTP client for
//!     devserver-control's `/admin/v1/*` tree. Used by identity-service
//!     (on revoke / delete / dashboard reads) and profile-service (on
//!     admin block and in the registry sweeper) so a state change in
//!     the DB also tears down the live tunnel registrations the proxy
//!     fleet holds for the user.
//!   * `devserver_gate`: Ed25519 entry credentials and exact binding
//!     validation for the body-only identity-to-proxy handoff.
//!   * `internal_transport`: the repository-wide rule for internal
//!     listeners and URLs: HTTPS always, cleartext only to a loopback
//!     IP literal or under an explicitly declared authenticated
//!     overlay.

pub mod devserver_control_client;
pub mod devserver_gate;
pub mod internal_transport;
pub mod profile_client;
pub mod shutdown;
pub mod static_files;
pub mod token_bucket;
pub mod validators;

pub use shutdown::shutdown_signal;
