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
//! - `CONN_PATH` (`?tunnel=<id>&conn=<id>[&half_close=true]`): one socket per
//!   accepted TCP connection. Binary frames are raw bytes. On a negotiated
//!   half-close leg, a Text `half_close` frame ends the sender's direction.
//!   The devserver dials `127.0.0.1:{devserver_port}` and splices.
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
use chan_revtunnel::wire::{HALF_CLOSE_MARKER, MAX_DATA_FRAME_BYTES};
use chan_revtunnel::ControlFrame;
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::net::TcpStream;
use tokio::sync::mpsc;

use crate::WorkspaceHost;

/// Called only after the leg has decided to end, this one-second grace gives
/// the send slot and Close frame a final flush without tying teardown to a
/// transport idle deadline. Expiry loses the Close frame and, after an
/// abnormal exit, may also lose the worker's one in-flight data frame.
const HALF_CLOSE_CLOSE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(1);

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
    /// The desktop opts in only after the devserver advertised support in the
    /// trigger payload.
    #[serde(default)]
    half_close: bool,
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
    ws.on_upgrade(move |socket| serve_tunnel_conn(socket, port, query.conn, query.half_close))
}

/// Dial the devserver end and splice it against the data socket.
///
/// A refused dial closes the just-upgraded WS immediately, so the desktop's
/// local caller sees connect-then-EOF -- the same shape as a dead `ssh -R`
/// forward. It never tears the tunnel down: the next connection retries.
async fn serve_tunnel_conn(socket: WebSocket, port: u16, conn_id: String, half_close: bool) {
    let tcp = match TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await {
        Ok(tcp) => tcp,
        Err(error) => {
            tracing::debug!(%error, conn_id, port, "tunnel data dial refused");
            return;
        }
    };
    let (to_peer, uplink_rx) = mpsc::channel::<Vec<u8>>(8);
    let (downlink_tx, from_peer) = mpsc::channel::<Vec<u8>>(8);
    if half_close {
        let adapter = shuttle_half_close(socket, uplink_rx, downlink_tx);
        let splice = chan_revtunnel::bridge::splice_half_close(tcp, to_peer, from_peer);
        tokio::pin!(adapter);
        tokio::pin!(splice);
        tokio::select! {
            peer_half_close = &mut adapter => {
                // Once the peer's marker was accepted and the TCP downlink
                // ended, dropping the splice can close the remaining read
                // half. Without a marker, let the byte pump drain its channel
                // and propagate cancellation itself.
                if peer_half_close == PeerHalfClose::Open {
                    splice.await;
                }
            }
            // A completed splice drops both channels, which ends the adapter
            // through its bounded close path.
            _ = &mut splice => {
                let _ = adapter.await;
            }
        }
        return;
    }
    let (mut ws_tx, mut ws_rx) = socket.split();
    let mut uplink_rx = uplink_rx;
    // The two WebSocket adapter halves around the shared byte pump: raw bytes
    // ride binary frames, nothing else is data.
    let uplink = tokio::spawn(async move {
        while let Some(chunk) = uplink_rx.recv().await {
            if ws_tx.send(Message::Binary(chunk.into())).await.is_err() {
                break;
            }
        }
        let _ = ws_tx.close().await;
    });
    let downlink = async move {
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
    // The downlink adapter may end first, which closes `from_peer` and ends
    // the splice. Keep the uplink alive until its channel closes so every
    // frame read before EOF reaches the WebSocket.
    let downlink = tokio::spawn(downlink);
    chan_revtunnel::bridge::splice(tcp, to_peer, from_peer).await;
    let _ = uplink.await;
    downlink.abort();
    let _ = downlink.await;
}

fn half_close_outbound_message(chunk: Vec<u8>) -> Message {
    if chunk.is_empty() {
        Message::text(HALF_CLOSE_MARKER)
    } else {
        Message::Binary(chunk.into())
    }
}

fn half_close_inbound_chunk(message: Message) -> Option<Vec<u8>> {
    match message {
        Message::Binary(bytes) if !bytes.is_empty() => Some(bytes.to_vec()),
        Message::Text(text) if text == HALF_CLOSE_MARKER => Some(Vec::new()),
        _ => None,
    }
}

async fn close_half_close<T>(close: impl std::future::Future<Output = T>) {
    let _ = tokio::time::timeout(HALF_CLOSE_CLOSE_TIMEOUT, close).await;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PeerHalfClose {
    Open,
    DownlinkEnded,
}

/// Move negotiated data and directional end markers over the WebSocket.
///
/// The adapter owns an outbound task that stays independent of a blocked
/// inbound channel send. After an inbound marker, valid later data frames are
/// discarded while the stream remains polled for transport closure until the
/// outbound direction ends. Before that marker, inbound channel backpressure
/// can pause stream polling. Oversized Binary frames end the leg in either
/// state. Every completed exit that recovers the sink makes exactly one
/// bounded close attempt. A `DownlinkEnded` result means the adapter enqueued
/// the peer marker and the TCP byte pump dropped its inbound receiver.
async fn shuttle_half_close(
    socket: WebSocket,
    mut out_rx: mpsc::Receiver<Vec<u8>>,
    in_tx: mpsc::Sender<Vec<u8>>,
) -> PeerHalfClose {
    let (mut sink, mut stream) = socket.split();
    let (stop_tx, mut stop_rx) = tokio::sync::oneshot::channel();
    let mut outbound = tokio::task::JoinSet::new();
    outbound.spawn(async move {
        let orderly = loop {
            let chunk = tokio::select! {
                biased;
                _ = &mut stop_rx => break false,
                chunk = out_rx.recv() => chunk,
            };
            let Some(chunk) = chunk else { break false };
            let ended = chunk.is_empty();
            let sent = tokio::select! {
                biased;
                _ = &mut stop_rx => false,
                result = sink.send(half_close_outbound_message(chunk)) => result.is_ok(),
            };
            if !sent {
                break false;
            }
            if ended {
                break true;
            }
        };
        (sink, orderly)
    });
    let mut outbound_finished = false;
    let mut finished_sink = None;
    let mut in_tx = Some(in_tx);
    let mut peer_half_close = PeerHalfClose::Open;
    loop {
        if finished_sink.is_some() && in_tx.is_none() {
            break;
        }
        tokio::select! {
            result = outbound.join_next(), if !outbound_finished => {
                outbound_finished = true;
                match result {
                    Some(Ok((sink, true))) => finished_sink = Some(sink),
                    Some(Ok((sink, false))) => {
                        finished_sink = Some(sink);
                        break;
                    }
                    Some(Err(_)) | None => return peer_half_close,
                }
            }
            inbound = stream.next() => match inbound {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(Message::Binary(bytes))) if bytes.len() > MAX_DATA_FRAME_BYTES => break,
                Some(Ok(message)) => {
                    let Some(tx) = in_tx.as_ref() else {
                        continue;
                    };
                    let Some(chunk) = half_close_inbound_chunk(message) else {
                        continue;
                    };
                    let ended = chunk.is_empty();
                    if tx.send(chunk).await.is_err() {
                        break;
                    }
                    if ended {
                        tx.closed().await;
                        in_tx.take();
                        peer_half_close = PeerHalfClose::DownlinkEnded;
                    }
                }
            },
        }
    }
    let mut sink = match finished_sink {
        Some(sink) => sink,
        None => {
            let _ = stop_tx.send(());
            match outbound.join_next().await {
                Some(Ok((sink, _))) => sink,
                Some(Err(_)) | None => return peer_half_close,
            }
        }
    };
    close_half_close(sink.close()).await;
    peer_half_close
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::body::Body;
    use axum::http::{header, Request};
    use chan_revtunnel::wire::{CONN_PATH, CONTROL_PATH};
    use tokio::io::AsyncReadExt;
    use tower::ServiceExt;

    type ClientWebSocket = tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >;

    /// Build a real upgraded Axum socket and its tungstenite peer.
    async fn websocket_pair() -> (WebSocket, ClientWebSocket, tokio::task::JoinHandle<()>) {
        let (socket_tx, socket_rx) = tokio::sync::oneshot::channel::<WebSocket>();
        let socket_tx = Arc::new(std::sync::Mutex::new(Some(socket_tx)));
        let app = axum::Router::new().route(
            "/",
            axum::routing::get(move |ws: WebSocketUpgrade| {
                let socket_tx = Arc::clone(&socket_tx);
                async move {
                    ws.on_upgrade(move |socket| async move {
                        let sender = {
                            let mut slot = socket_tx.lock().expect("socket sender lock");
                            slot.take().expect("single test WebSocket")
                        };
                        let _ = sender.send(socket);
                    })
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test WebSocket server");
        let address = listener.local_addr().expect("test WebSocket address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("serve test WebSocket")
        });
        let (peer, _) = tokio_tungstenite::connect_async(format!("ws://{address}/"))
            .await
            .expect("connect test WebSocket");
        let socket = tokio::time::timeout(std::time::Duration::from_secs(2), socket_rx)
            .await
            .expect("Axum upgrades the test WebSocket")
            .expect("upgrade hands out its socket");
        (socket, peer, server)
    }

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

    #[test]
    fn half_close_frames_translate_only_the_named_text_marker() {
        assert_eq!(
            half_close_outbound_message(Vec::new()),
            Message::text(HALF_CLOSE_MARKER)
        );
        assert_eq!(
            half_close_outbound_message(b"bytes".to_vec()),
            Message::Binary(b"bytes".to_vec().into())
        );
        assert_eq!(
            half_close_inbound_chunk(Message::text(HALF_CLOSE_MARKER)),
            Some(Vec::new())
        );
        assert_eq!(
            half_close_inbound_chunk(Message::text("future-control")),
            None
        );
        assert_eq!(
            half_close_inbound_chunk(Message::Binary(b"bytes".to_vec().into())),
            Some(b"bytes".to_vec())
        );
    }

    #[tokio::test]
    async fn an_unreadable_peer_cannot_hold_a_half_close_close_forever() {
        tokio::time::timeout(
            HALF_CLOSE_CLOSE_TIMEOUT + std::time::Duration::from_secs(1),
            close_half_close(std::future::pending::<()>()),
        )
        .await
        .expect("bounded close returns before its caller's deadline");
    }

    #[tokio::test]
    async fn an_unreadable_peer_cannot_hold_a_half_close_adapter_forever() {
        let (socket, mut peer, server) = websocket_pair().await;
        let (out_tx, out_rx) = mpsc::channel(1);
        let (in_tx, in_rx) = mpsc::channel(1);
        drop(in_rx);
        let adapter = tokio::spawn(shuttle_half_close(socket, out_rx, in_tx));

        // Once the second chunk enters the one-slot channel, the outbound
        // worker owns the large first frame. Leaving the peer unread makes
        // that send, and therefore SplitSink::close's flush, stay pending.
        out_tx
            .send(vec![0; 16 * 1024 * 1024])
            .await
            .expect("queue large outbound frame");
        out_tx
            .send(vec![1])
            .await
            .expect("outbound worker takes large frame");
        peer.send(tokio_tungstenite::tungstenite::Message::binary(
            b"stop".to_vec(),
        ))
        .await
        .expect("trigger inbound channel failure");

        tokio::time::timeout(std::time::Duration::from_secs(3), adapter)
            .await
            .expect("an unreadable peer cannot retain the adapter")
            .expect("adapter task");
        server.abort();
    }

    #[tokio::test]
    async fn a_closed_half_close_socket_ends_its_connection_task_after_a_peer_marker() {
        let origin = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind quiet origin");
        let origin_port = origin.local_addr().expect("quiet origin address").port();
        let (socket, mut peer, server) = websocket_pair().await;
        let connection = tokio::spawn(serve_tunnel_conn(
            socket,
            origin_port,
            "test-connection".to_string(),
            true,
        ));
        let (mut origin_socket, _) = origin.accept().await.expect("accept origin connection");

        peer.send(tokio_tungstenite::tungstenite::Message::text(
            HALF_CLOSE_MARKER,
        ))
        .await
        .expect("send peer marker");
        let mut request = Vec::new();
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            origin_socket.read_to_end(&mut request),
        )
        .await
        .expect("peer marker shuts down the origin write half")
        .expect("read request through peer marker");
        assert!(request.is_empty());

        peer.close(None).await.expect("close peer socket");
        tokio::time::timeout(std::time::Duration::from_secs(3), connection)
            .await
            .expect("closed socket ends the whole connection task")
            .expect("connection task");
        server.abort();
    }
}
