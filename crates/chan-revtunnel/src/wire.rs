//! The devserver <-> desktop contract for one reverse tunnel.
//!
//! Direction is the load-bearing constraint: a devserver never dials a
//! desktop. Every hop here is therefore desktop-initiated, and the devserver
//! only ever asks for something over a channel the desktop already opened.
//!
//! One `cs tunnel` invocation drives three legs:
//!
//! 1. TRIGGER (fire-and-forget). The control-socket handler pushes a
//!    `tunnel_open` window_command to the terminal's own window over the
//!    tenant `/ws`. Addressing the window is also how the desktop is chosen:
//!    the window's webview belongs to exactly one desktop process, so no
//!    separate desktop-selection rule is needed.
//! 2. CONTROL (one WebSocket per tunnel, desktop-dialed). Its first frame is
//!    the acknowledgement `cs` is blocked on: [`ControlFrame::Ready`] with the
//!    bound address, or [`ControlFrame::Failed`] with the reason. Afterwards
//!    the socket carries nothing but its own liveness, which is the point: it
//!    is the lifetime anchor in both directions. `cs` exits -> the devserver
//!    drops the registration and closes it -> the desktop tears the listener
//!    down. The desktop dies -> the socket drops -> the devserver fails the
//!    blocked `cs`.
//! 3. DATA (one WebSocket per accepted connection, desktop-dialed). Binary
//!    frames are raw TCP bytes in both directions. The devserver dials
//!    `127.0.0.1:{devserver_port}` when the socket opens and splices.
//!
//! Both WebSocket paths live under `/api/library/*` deliberately:
//! `/api/devserver/*` is 404'd by the gateway on the public wildcard, so a
//! control surface there could never work for a gateway-attached desktop.

use serde::{Deserialize, Serialize};

use crate::spec::{Proto, TunnelSpec};

/// Per-tunnel control socket. Query: `?tunnel=<id>`.
pub const CONTROL_PATH: &str = "/api/library/tunnel/control";

/// Per-connection data socket. Query: `?tunnel=<id>&conn=<id>`.
pub const CONN_PATH: &str = "/api/library/tunnel/conn";

/// Query parameter naming the tunnel on both paths.
pub const TUNNEL_PARAM: &str = "tunnel";

/// Query parameter naming one accepted connection on [`CONN_PATH`].
pub const CONN_PARAM: &str = "conn";

/// How long the devserver waits for the desktop to answer the trigger with a
/// control socket before giving up and failing `cs`. Long enough for a webview
/// to be woken and a WebSocket to be established over a gateway hop, short
/// enough that a browser-only viewer (which will never answer) fails while the
/// user is still watching.
pub const READY_TIMEOUT_SECS: u64 = 10;

/// Largest data frame either side emits. Reads are chunked to this, so it
/// doubles as the receive cap: anything larger means a peer that is not
/// speaking this protocol.
pub const MAX_DATA_FRAME_BYTES: usize = 64 * 1024;

/// The `tunnel_open` window_command payload: the trigger the SPA hands to its
/// native host. It carries everything the desktop needs to act without a
/// second round-trip, and no capability of its own: the desktop resolves WHICH
/// devserver to dial from the window's own connection record, never from these
/// fields. A page that forges this command can therefore only ask its own
/// devserver to do what its own devserver could already ask for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TunnelOpen {
    /// Server-minted, unguessable. Names the registration the control and data
    /// sockets attach to.
    pub tunnel_id: String,
    pub proto: Proto,
    /// Rendered bind address (`127.0.0.1`, `::1`, ...), not the port.
    pub bind_addr: String,
    pub desktop_port: u16,
    pub devserver_port: u16,
}

impl TunnelOpen {
    pub fn from_spec(tunnel_id: impl Into<String>, spec: &TunnelSpec) -> Self {
        Self {
            tunnel_id: tunnel_id.into(),
            proto: spec.proto,
            bind_addr: spec.bind_addr.to_string(),
            desktop_port: spec.desktop_port,
            devserver_port: spec.devserver_port,
        }
    }
}

/// Text frames on the control socket. Additive by serde tag, like the rest of
/// the project's JSON contracts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ControlFrame {
    /// Desktop -> devserver, first frame on success. `bound` is the actual
    /// listening authority, which matters when the request asked for port 0.
    Ready { bound: String },
    /// Desktop -> devserver, first frame on failure. The listener never came
    /// up; the reason is user-facing (a port collision, a refused consent).
    Failed { message: String },
    /// Devserver -> desktop: stop listening and drop every bridge. Sent when
    /// the foreground `cs tunnel` ends, so the desktop learns the difference
    /// between an orderly close and a dropped connection.
    Close { reason: String },
}

/// How a tunnel ended, as reported back to the blocked `cs tunnel`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TunnelEnd {
    /// The `cs` client went away (Ctrl-C, or its process died). The normal
    /// exit: the command's lifetime IS the tunnel's lifetime.
    ClientGone,
    /// The desktop's control socket dropped while the tunnel was live.
    DesktopGone,
}

impl TunnelEnd {
    pub fn close_reason(&self) -> &'static str {
        match self {
            TunnelEnd::ClientGone => "cs tunnel exited",
            TunnelEnd::DesktopGone => "desktop disconnected",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spec::parse_spec;

    #[test]
    fn control_frames_round_trip_by_tag() {
        let ready = ControlFrame::Ready {
            bound: "127.0.0.1:8080".into(),
        };
        let raw = serde_json::to_string(&ready).unwrap();
        assert_eq!(raw, r#"{"type":"ready","bound":"127.0.0.1:8080"}"#);
        assert_eq!(serde_json::from_str::<ControlFrame>(&raw).unwrap(), ready);

        let failed = ControlFrame::Failed {
            message: "address already in use".into(),
        };
        assert_eq!(
            serde_json::from_str::<ControlFrame>(&serde_json::to_string(&failed).unwrap()).unwrap(),
            failed
        );
    }

    #[test]
    fn an_unknown_frame_tag_is_a_decode_error_not_a_silent_default() {
        assert!(serde_json::from_str::<ControlFrame>(r#"{"type":"nope"}"#).is_err());
    }

    #[test]
    fn tunnel_open_carries_the_spec_verbatim() {
        let spec = parse_spec("8080:3000", Proto::Tcp).unwrap();
        let open = TunnelOpen::from_spec("tun-abc", &spec);
        assert_eq!(open.tunnel_id, "tun-abc");
        assert_eq!(open.bind_addr, "127.0.0.1");
        assert_eq!(open.desktop_port, 8080);
        assert_eq!(open.devserver_port, 3000);
        assert_eq!(open.proto, Proto::Tcp);
    }

    #[test]
    fn end_reasons_are_distinguishable_to_the_desktop() {
        assert_ne!(
            TunnelEnd::ClientGone.close_reason(),
            TunnelEnd::DesktopGone.close_reason()
        );
    }
}
