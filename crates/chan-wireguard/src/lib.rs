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
//! The `noise` module and the clock derive from Cloudflare's boringtun
//! under BSD-3-Clause; the notice is the LICENSE file beside the crate's
//! manifest.

#![forbid(unsafe_code)]

pub(crate) mod clock;
pub mod noise;

/// The Curve25519 key types a tunnel is built from.
pub mod x25519 {
    pub use x25519_dalek::{PublicKey, ReusableSecret, SharedSecret, StaticSecret};
}
