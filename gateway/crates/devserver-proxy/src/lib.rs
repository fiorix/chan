//! devserver-proxy: public-facing service at p{n}.usr.{domain} (apex) and
//! *.p{n}.usr.{domain} (wildcard).
//!
//! Two TCP listeners share the process, fronted by distinct public HTTP and
//! tunnel-ingress listeners:
//!
//!   * `bind_addr` (p{n}.usr.{domain} apex + *.p{n}.usr.{domain} wildcard):
//!     axum HTTP. The wildcard host carries the tenant reverse-proxy
//!     surface; the apex carries `/healthz` and `/readyz` only.
//!     A single router dispatches on the `Host` header. devserver-proxy
//!     reads no identity-service session cookie. Identity-signed entry
//!     credentials are exchanged through a fixed body-only POST, then the
//!     browser uses a host-only opaque `__Host-devserver_gate` cookie.
//!
//!   * `tunnel_bind_addr` (p{n}.usr.{domain} apex, behind nginx
//!     `grpc_pass` on `/v1/tunnel`): h2c handshake for chan-tunnel
//!     clients. Embeds `chan_tunnel_server` as a library and shares
//!     the same in-process `Registry` with the public side.
//!
//! No SPA ships in this binary. The dashboard, sign-in surface and
//! workspace list live at gw.{domain}.

pub mod config;
pub mod control;
pub mod entry_replay;
pub mod error;
pub mod http;
pub mod identity_validator;
pub mod proxy;
pub mod registry;
pub mod session_store;
pub mod throttle_validator;

pub use config::Config;
pub use error::{Error, Result};
