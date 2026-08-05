//! chan-tunnel wire types.
//!
//! The transport between `chan devserver` (client) and the tunnel
//! terminator (server) is a single HTTP/2 bidirectional stream.
//! The first message in each direction is a length-prefixed JSON
//! control frame; after that, both sides hand the byte stream to
//! yamux.
//!
//! This crate is pure data: framing helpers and serde types. No
//! I/O, no async. Both client and server depend on it.

#![forbid(unsafe_code)]

mod control;
mod frame;
pub mod gateway_assertion;
mod h2_duplex;
mod io;
mod lease_refresh;
mod workspace_name;

pub use control::{error_code, Hello, HelloAck, HelloAckErr, HelloAckOk, ProtocolVersion};
pub use frame::{decode_frame, encode_frame, FrameError};
pub use h2_duplex::H2Duplex;
pub use io::{read_frame, write_frame, IoFrameError};
pub use lease_refresh::{LeaseRefreshRequest, LeaseRefreshResponse};
pub use workspace_name::{
    is_valid_username, is_valid_workspace_name, sanitize_workspace_name, MAX_USERNAME_LEN,
    MAX_WORKSPACE_NAME_LEN,
};

/// Path the client POSTs to on the public tunnel host. Stable
/// across versions; protocol version is negotiated inside the Hello
/// frame, not via a path bump.
pub const TUNNEL_PATH: &str = "/v1/tunnel";

/// Maximum size of a single control frame in bytes. Control frames
/// are tiny; this guards against a malicious or buggy peer trying to
/// allocate gigabytes before yamux even starts.
pub const MAX_CONTROL_FRAME_BYTES: usize = 64 * 1024;

/// HTTP/2 initial stream-level flow-control window both tunnel peers
/// advertise (16 MiB). The h2 default (64 KiB) throttles bulk transfer
/// over a high-latency link no matter what yamux does above it; the
/// window is per-direction, so client and server must raise it for both
/// directions to benefit.
pub const TUNNEL_H2_STREAM_WINDOW: u32 = 16 * 1024 * 1024;

/// HTTP/2 initial connection-level flow-control window both tunnel
/// peers advertise (32 MiB). Sized above the stream window so several
/// busy yamux substreams do not stall on the shared h2 connection
/// budget before their own stream windows are exhausted.
pub const TUNNEL_H2_CONNECTION_WINDOW: u32 = 32 * 1024 * 1024;

/// Maximum concurrent yamux substreams per tunnel connection (256).
/// Bounds a visitor opening many slow requests to a manageable memory
/// footprint while leaving plenty of room for browser-shaped
/// concurrency (pipelined requests plus a WebSocket or two).
pub const TUNNEL_YAMUX_MAX_STREAMS: usize = 256;

/// Total yamux receive window across all streams of a tunnel
/// connection (64 MiB). yamux auto-tunes each stream's window from the
/// 256 KiB protocol default toward the bandwidth-delay product; this is
/// the connection-wide budget that tuning may draw on. It must satisfy
/// yamux's own floor of `256 KiB * TUNNEL_YAMUX_MAX_STREAMS`, and it
/// does so exactly.
pub const TUNNEL_YAMUX_CONNECTION_RECEIVE_WINDOW: usize = 64 * 1024 * 1024;
