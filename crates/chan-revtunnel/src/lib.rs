//! Reverse port forwarding from a chan devserver to a connected chan-desktop.
//!
//! `cs tunnel [bind:]desktop-port:devserver-port`, run in a devserver
//! terminal, asks the desktop that owns the terminal's window to listen on a
//! port of the desktop machine and forward every connection back to a port on
//! the devserver host. It is `ssh -R` with the roles the chan topology already
//! has, and it exists because the devserver can never dial the desktop: only
//! the desktop can open connections, so the devserver asks over a channel the
//! desktop opened and the desktop dials back.
//!
//! Layout:
//!
//! - [`spec`]: the address spec and its parser (shared by the CLI and the
//!   server so both reject the same inputs with the same words).
//! - [`wire`]: the devserver <-> desktop contract. The canonical description
//!   of the three legs lives there.
//! - [`server`]: devserver-side registry; one registration per foreground
//!   `cs tunnel`, whose guard drop is the single teardown path.
//! - [`bridge`]: the byte pump, written against channels so both ends share it
//!   without agreeing on a WebSocket library.
//! - [`client`] (feature `client`): desktop-side listener and dialer.
//!
//! Scope today is TCP. `Proto::Udp` parses and is carried on the wire, but no
//! end implements datagram relay yet; a UDP tunnel is refused at the edge
//! rather than silently behaving like TCP.

pub mod bridge;
pub mod server;
pub mod spec;
pub mod wire;

#[cfg(feature = "client")]
pub mod client;

pub use spec::{parse_spec, Proto, SpecError, TunnelSpec};
pub use wire::{ControlFrame, TunnelOpen};
