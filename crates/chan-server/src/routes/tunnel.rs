//! The desktop-dialed WebSocket legs of a reverse tunnel (`cs tunnel`).
//!
//! Two GET WS routes on the launcher router, both addressed by the
//! server-minted unguessable tunnel id (see `chan_revtunnel::wire` for the
//! full three-leg contract):
//!
//! - `CONTROL_PATH` (`?tunnel=<id>`): one socket per tunnel. Its first inbound
//!   frame (`ready`/`failed`) answers the blocked `cs tunnel`; afterwards the
//!   socket carries only its own liveness, the teardown anchor in both
//!   directions.
//! - `CONN_PATH` (`?tunnel=<id>&conn=<id>`): one socket per accepted TCP
//!   connection. Binary frames are raw bytes; the devserver dials
//!   `127.0.0.1:{devserver_port}` and splices.
//!
//! Mounted from `routes::library` inside the launcher-bearer gate, so both
//! paths accept the bearer as `?t=` (a WebSocket client cannot always set an
//! `Authorization` header).

use std::net::Ipv4Addr;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use chan_revtunnel::server::{AttachError, ControlAttach, ReadyReport};
use chan_revtunnel::wire::MAX_DATA_FRAME_BYTES;
use chan_revtunnel::ControlFrame;
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::net::TcpStream;
use tokio::sync::mpsc;

use crate::WorkspaceHost;

#[derive(Deserialize)]
pub(super) struct TunnelControlQuery {
    tunnel: String,
}

#[derive(Deserialize)]
pub(super) struct TunnelConnQuery {
    tunnel: String,
    /// Names one accepted connection in the desktop's logs and ours; the
    /// devserver only echoes it into diagnostics.
    conn: String,
}

/// An attach refusal as an HTTP status, answered INSTEAD of upgrading so the
/// desktop sees a real refusal rather than a socket that opens and dies.
fn attach_refusal(error: AttachError) -> Response {
    let status = match error {
        AttachError::Unknown => StatusCode::NOT_FOUND,
        AttachError::AlreadyAttached | AttachError::NotLive => StatusCode::CONFLICT,
    };
    (status, error.to_string()).into_response()
}

/// `GET CONTROL_PATH?tunnel=<id>`: attach the tunnel's one control socket.
pub(super) async fn handle_tunnel_control(
    State(host): State<Arc<WorkspaceHost>>,
    Query(query): Query<TunnelControlQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    let attach = match host.tunnel_registry().attach_control(&query.tunnel) {
        Ok(attach) => attach,
        Err(error) => return attach_refusal(error),
    };
    ws.on_upgrade(move |socket| serve_tunnel_control(socket, attach))
}

/// Pump the control socket until one side ends it.
///
/// Inbound `ready`/`failed` frames are reported to the registry (unblocking
/// the waiting `cs tunnel`); anything else inbound is ignored for forward
/// compatibility. When the registration drops (the `cs tunnel` ended), the
/// watched close reason is forwarded as a `close` frame and the attach
/// detaches quietly -- the command is already gone, so no desktop-gone report.
/// A socket close or error instead drops the attach plainly, which is what
/// tells a still-blocked `cs tunnel` its desktop died.
async fn serve_tunnel_control(mut socket: WebSocket, attach: ControlAttach) {
    // A clone sidesteps borrowing `attach` mutably in the select while the
    // handler consumes it; a fresh receiver still sees the close value.
    let mut close = attach.close.clone();
    loop {
        tokio::select! {
            _ = close.changed() => {
                let reason = close
                    .borrow()
                    .clone()
                    .unwrap_or_else(|| "tunnel closed".to_string());
                if let Ok(raw) = serde_json::to_string(&ControlFrame::Close { reason }) {
                    let _ = socket.send(Message::text(raw)).await;
                }
                attach.detach_quietly();
                return;
            }
            msg = socket.recv() => match msg {
                Some(Ok(Message::Text(text))) => match serde_json::from_str::<ControlFrame>(&text) {
                    Ok(ControlFrame::Ready { bound }) => {
                        attach.report(ReadyReport::Ready { bound });
                    }
                    Ok(ControlFrame::Failed { message }) => {
                        attach.report(ReadyReport::Failed { message });
                    }
                    // `close` is devserver -> desktop only; an undecodable
                    // frame is a newer peer speaking additively. Ignore both.
                    Ok(ControlFrame::Close { .. }) | Err(_) => {}
                },
                // The desktop hung up: the plain `attach` drop below reports
                // desktop-gone to the blocked command.
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => return,
                // Binary is not part of the control contract; ping/pong are
                // answered by axum itself.
                Some(Ok(_)) => {}
            },
        }
    }
}

/// `GET CONN_PATH?tunnel=<id>&conn=<id>`: attach one data socket.
pub(super) async fn handle_tunnel_conn(
    State(host): State<Arc<WorkspaceHost>>,
    Query(query): Query<TunnelConnQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    // Resolve the dial port BEFORE upgrading so a stale/forged id or a
    // not-yet-ready tunnel is a real HTTP refusal.
    let port = match host.tunnel_registry().dial_port(&query.tunnel) {
        Ok(port) => port,
        Err(error) => return attach_refusal(error),
    };
    ws.on_upgrade(move |socket| serve_tunnel_conn(socket, port, query.conn))
}

/// Dial the devserver end and splice it against the data socket.
///
/// A refused dial closes the just-upgraded WS immediately, so the desktop's
/// local caller sees connect-then-EOF -- the same shape as a dead `ssh -R`
/// forward. It never tears the tunnel down: the next connection retries.
async fn serve_tunnel_conn(socket: WebSocket, port: u16, conn_id: String) {
    let tcp = match TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await {
        Ok(tcp) => tcp,
        Err(error) => {
            tracing::debug!(%error, conn_id, port, "tunnel data dial refused");
            return;
        }
    };
    let (mut ws_tx, mut ws_rx) = socket.split();
    let (to_peer, mut uplink_rx) = mpsc::channel::<Vec<u8>>(8);
    let (downlink_tx, from_peer) = mpsc::channel::<Vec<u8>>(8);
    // The two WebSocket adapter halves around the shared byte pump: raw bytes
    // ride binary frames, nothing else is data.
    let uplink = async {
        while let Some(chunk) = uplink_rx.recv().await {
            if ws_tx.send(Message::Binary(chunk.into())).await.is_err() {
                break;
            }
        }
    };
    let downlink = async {
        while let Some(msg) = ws_rx.next().await {
            match msg {
                Ok(Message::Binary(bytes)) => {
                    // Over the frame cap means a peer that is not speaking
                    // this protocol; drop the connection, not the bytes.
                    if bytes.len() > MAX_DATA_FRAME_BYTES {
                        break;
                    }
                    if downlink_tx.send(bytes.to_vec()).await.is_err() {
                        break;
                    }
                }
                Ok(Message::Close(_)) | Err(_) => break,
                // Text/ping/pong are not data frames.
                Ok(_) => {}
            }
        }
    };
    // Any leg ending ends them all: the channels carry no half-close signal,
    // so both directions drop together (mirroring the pump's own contract).
    tokio::select! {
        _ = chan_revtunnel::bridge::splice(tcp, to_peer, from_peer) => {}
        _ = uplink => {}
        _ = downlink => {}
    }
    let _ = ws_tx.close().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::body::Body;
    use axum::http::{header, Request};
    use chan_revtunnel::wire::{CONN_PATH, CONTROL_PATH};
    use tower::ServiceExt;

    /// A well-formed WebSocket handshake request. Served through `oneshot`
    /// there is no connection to upgrade, so a request that passes the gate
    /// and reaches the upgrade extractor answers 426 -- which is exactly what
    /// makes "mounted and authorized" observable without a live socket.
    fn ws_probe(uri: &str) -> Request<Body> {
        Request::builder()
            .uri(uri)
            .header(header::CONNECTION, "upgrade")
            .header(header::UPGRADE, "websocket")
            .header(header::SEC_WEBSOCKET_VERSION, "13")
            .header(header::SEC_WEBSOCKET_KEY, "dGhlIHNhbXBsZSBub25jZQ==")
            .body(Body::empty())
            .expect("ws probe")
    }

    #[tokio::test]
    async fn both_legs_are_mounted_and_accept_the_bearer_as_a_query_param() {
        let cfg = tempfile::tempdir().expect("config dir");
        let library =
            chan_workspace::Library::open_at(cfg.path().join("config.toml")).expect("library");
        let host = Arc::new(WorkspaceHost::new(library, crate::route_builder()));
        let app = crate::routes::launcher_router(
            host,
            Some(Arc::new(std::sync::RwLock::new("test-token".to_string()))),
            None,
        );

        // A desktop-dialed WebSocket cannot always set an `Authorization`
        // header, so both legs take the launcher bearer as `?t=`.
        for path in [CONTROL_PATH, CONN_PATH] {
            let authorized = app
                .clone()
                .oneshot(ws_probe(&format!(
                    "{path}?tunnel=tun-1&conn=c-1&t=test-token"
                )))
                .await
                .expect("response");
            assert_eq!(
                authorized.status(),
                StatusCode::UPGRADE_REQUIRED,
                "{path} must be mounted behind the bearer gate"
            );

            let anonymous = app
                .clone()
                .oneshot(ws_probe(&format!("{path}?tunnel=tun-1&conn=c-1")))
                .await
                .expect("response");
            assert_eq!(
                anonymous.status(),
                StatusCode::UNAUTHORIZED,
                "{path} must stay gated without a token"
            );
        }
    }

    #[test]
    fn refusals_map_to_the_statuses_the_desktop_distinguishes() {
        // 404 = the tunnel is gone (stop retrying); 409 = it exists but this
        // attach is wrong right now (duplicate control, or data before ready).
        assert_eq!(
            attach_refusal(AttachError::Unknown).status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            attach_refusal(AttachError::AlreadyAttached).status(),
            StatusCode::CONFLICT
        );
        assert_eq!(
            attach_refusal(AttachError::NotLive).status(),
            StatusCode::CONFLICT
        );
    }
}
