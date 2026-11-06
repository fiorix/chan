//! The WireGuard protocol core chan embeds.
//!
//! [`noise::Tunn`] is one peer of a WireGuard tunnel as a sans-IO state
//! machine: datagrams from the network go in and IP packets come out,
//! IP packets go in and datagrams come out, and a periodic tick drives the
//! handshake retries, the rekey and the keepalives. It owns no socket, no
//! timer and no TCP stack; the caller does. The construction is the one
//! the WireGuard whitepaper fixes (Noise_IKpsk2 over Curve25519,
//! ChaCha20-Poly1305, BLAKE2s), which is why the code is owned here
//! rather than tracked as a dependency: the protocol has no versioning to
//! follow.
//!
//! [`Tunnel`] is the tunnel as a process uses it: it owns the UDP socket,
//! drives one `Tunn` and runs a TCP/IP stack over it, so a caller opens
//! TCP connections to the peer's addresses with [`Tunnel::connect`] and
//! gets a tokio [`Stream`], with no interface, route or privilege on the
//! host. [`config::Config`] is read from the wg-quick file format.
//! [`ConnectProxy`] is a loopback HTTP proxy over a live table of tunnels
//! for the dialers that cannot call `connect` themselves, a webview among
//! them: it serves CONNECT and forwards plain-HTTP requests, and a host
//! name a route maps, or a destination inside a tunnel's AllowedIPs, goes
//! through that tunnel while anything else is connected directly.
//!
//! The `noise` module and the clock derive from Cloudflare's boringtun
//! under BSD-3-Clause; the notice is the LICENSE file beside the crate's
//! manifest.

#![forbid(unsafe_code)]

pub(crate) mod clock;
pub mod config;
pub mod noise;
mod proxy;
mod resolver;
mod stack;
mod stream;
#[cfg(test)]
mod testing;
mod tunnel;

pub use proxy::{ConnectProxy, HostRoute, ProxyRoute};
pub use stream::{Listener, Stream};
pub use tunnel::{HandshakeState, Status, Tunnel};

/// The Curve25519 key types a tunnel is built from.
pub mod x25519 {
    pub use x25519_dalek::{PublicKey, ReusableSecret, SharedSecret, StaticSecret};
}
