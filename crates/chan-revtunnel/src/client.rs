//! Desktop-side half: bind the listener, answer the devserver, bridge each
//! accepted connection back over its own WebSocket.
//!
//! This module is deliberately free of Tauri: it takes a devserver base URL
//! plus credentials and nothing else, so the desktop shell calls it from a
//! command handler while the end-to-end harness calls it directly. That is
//! also what makes the acceptance tests runnable on a machine with no display
//! server, which is where this code has to be verified.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use futures::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

use crate::bridge::splice;
use crate::spec::{render_authority, TunnelSpec};
use crate::wire::{ControlFrame, CONN_PARAM, CONN_PATH, CONTROL_PATH, TUNNEL_PARAM};

/// How often the control socket is pinged while idle. Well under the gateway
/// bridge's 300s both-directions idle cut, matching the window feed's own
/// keepalive so a gateway-attached tunnel survives a quiet period.
const PING_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);

/// Everything the desktop needs to serve one tunnel.
pub struct ClientConfig {
    /// The devserver's WebSocket origin, e.g. `ws://127.0.0.1:8787`. The
    /// caller derives this from the window's own connection record, never from
    /// the trigger payload.
    pub base_ws_url: String,
    /// `Authorization: Bearer` value for a directly attached devserver.
    pub bearer: Option<String>,
    /// `Cookie` value for a gateway-attached devserver.
    pub cookie: Option<String>,
    /// `Origin`, required by the gateway on cookie-authenticated upgrades.
    pub origin: Option<String>,
    pub tunnel_id: String,
    pub spec: TunnelSpec,
}

/// A running tunnel. Dropping the handle does not stop it; call
/// [`TunnelHandle::stop`] or await [`TunnelHandle::wait`], which returns when
/// the devserver closes the tunnel.
#[derive(Debug)]
pub struct TunnelHandle {
    /// The authority the listener actually bound, resolved for port-0 asks.
    pub bound: SocketAddr,
    stop_tx: watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

impl TunnelHandle {
    /// Stop listening and drop every live bridge.
    pub fn stop(&self) {
        let _ = self.stop_tx.send(true);
    }

    /// Wait for the tunnel to end on its own (the devserver closed it, or the
    /// control socket dropped).
    pub async fn wait(self) {
        let _ = self.task.await;
    }
}

/// Bind, announce, and start serving.
///
/// A bind failure is still reported to the devserver over the control socket
/// before returning, so the blocked `cs tunnel` prints the real reason (a port
/// collision, a privileged port) instead of timing out. Only an unreachable
/// devserver returns without reporting: there is nothing to report to.
pub async fn open(cfg: ClientConfig) -> Result<TunnelHandle, String> {
    let control_url = format!(
        "{}{}?{}={}",
        cfg.base_ws_url.trim_end_matches('/'),
        CONTROL_PATH,
        TUNNEL_PARAM,
        cfg.tunnel_id
    );
    let request = build_request(&cfg, &control_url)?;
    let (mut control, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| format!("connect tunnel control socket: {e}"))?;

    let listener = match TcpListener::bind((cfg.spec.bind_addr, cfg.spec.desktop_port)).await {
        Ok(listener) => listener,
        Err(e) => {
            let message = format!(
                "cannot listen on {}: {e}",
                render_authority(cfg.spec.bind_addr, cfg.spec.desktop_port)
            );
            let _ = send_frame(
                &mut control,
                &ControlFrame::Failed {
                    message: message.clone(),
                },
            )
            .await;
            let _ = control.close(None).await;
            return Err(message);
        }
    };
    let bound = listener
        .local_addr()
        .map_err(|e| format!("resolving the bound address: {e}"))?;

    send_frame(
        &mut control,
        &ControlFrame::Ready {
            bound: bound.to_string(),
        },
    )
    .await
    .map_err(|e| format!("announcing the listener: {e}"))?;

    let (stop_tx, stop_rx) = watch::channel(false);
    let cfg = Arc::new(cfg);
    let task = tokio::spawn(run(cfg, listener, control, stop_rx));
    Ok(TunnelHandle {
        bound,
        stop_tx,
        task,
    })
}

/// Accept loop plus control-socket watch. Ends on any of: a `Close` frame, the
/// control socket dropping, or a local stop.
async fn run(
    cfg: Arc<ClientConfig>,
    listener: TcpListener,
    mut control: WsStream,
    mut stop_rx: watch::Receiver<bool>,
) {
    // Every bridge is owned by this set rather than detached, so ending the
    // tunnel also ends the connections it is carrying. A detached task would
    // keep splicing after the foreground `cs tunnel` exited, leaving the user
    // no way to close a connection short of killing the app.
    let mut conns = tokio::task::JoinSet::new();
    let mut conn_seq: u64 = 0;
    let mut ping = tokio::time::interval(PING_INTERVAL);
    ping.tick().await;
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((sock, peer)) => {
                    let conn_id = format!("c{conn_seq}");
                    conn_seq += 1;
                    let cfg = cfg.clone();
                    conns.spawn(async move {
                        if let Err(e) = serve_conn(cfg, sock, conn_id).await {
                            // Expected whenever nothing is listening on the
                            // devserver end: the caller sees a connect that
                            // closes at once, exactly like a dead forward.
                            tracing::debug!("revtunnel: connection from {peer} ended: {e}");
                        }
                    });
                }
                Err(e) => {
                    tracing::warn!("revtunnel: accept failed: {e}");
                    break;
                }
            },
            frame = control.next() => match frame {
                Some(Ok(Message::Text(text))) => {
                    // Ready/Failed are ours to send, never to receive, and an
                    // unknown frame is a newer devserver talking; ignoring both
                    // beats tearing down a working tunnel.
                    if let Ok(ControlFrame::Close { reason }) =
                        serde_json::from_str::<ControlFrame>(&text)
                    {
                        tracing::debug!("revtunnel: devserver closed the tunnel: {reason}");
                        break;
                    }
                }
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(_)) => {}
                Some(Err(e)) => {
                    tracing::debug!("revtunnel: control socket error: {e}");
                    break;
                }
            },
            _ = ping.tick() => {
                if control.send(Message::Ping(Vec::new().into())).await.is_err() {
                    break;
                }
            }
            changed = stop_rx.changed() => {
                // An `Err` means every `TunnelHandle` was dropped without a
                // stop. That has to end the loop too: a dropped sender makes
                // `changed()` resolve instantly and forever, so treating it as
                // "keep going" would spin this select hot for the life of the
                // process.
                if changed.is_err() || *stop_rx.borrow() {
                    break;
                }
            }
            // Reap finished bridges so a long-lived tunnel does not accumulate
            // their handles. Disabled while empty, or it would resolve
            // immediately and starve the other arms.
            _ = conns.join_next(), if !conns.is_empty() => {}
        }
    }
    // Abort every bridge still carrying bytes. This is what makes Ctrl-C on
    // the foreground command close the connections it opened, not just stop
    // accepting new ones.
    conns.shutdown().await;
    let _ = control.close(None).await;
}

/// One accepted connection: dial its data socket and splice.
async fn serve_conn(
    cfg: Arc<ClientConfig>,
    sock: TcpStream,
    conn_id: String,
) -> Result<(), String> {
    let url = format!(
        "{}{}?{}={}&{}={}",
        cfg.base_ws_url.trim_end_matches('/'),
        CONN_PATH,
        TUNNEL_PARAM,
        cfg.tunnel_id,
        CONN_PARAM,
        conn_id
    );
    let request = build_request(&cfg, &url)?;
    let (ws, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| format!("connect tunnel data socket: {e}"))?;

    let (to_peer_tx, to_peer_rx) = mpsc::channel::<Vec<u8>>(16);
    let (from_peer_tx, from_peer_rx) = mpsc::channel::<Vec<u8>>(16);
    let shuttle = tokio::spawn(shuttle(ws, to_peer_rx, from_peer_tx));
    splice(sock, to_peer_tx, from_peer_rx).await;
    shuttle.abort();
    Ok(())
}

/// Move bytes between the splice channels and the WebSocket.
async fn shuttle(ws: WsStream, mut out_rx: mpsc::Receiver<Vec<u8>>, in_tx: mpsc::Sender<Vec<u8>>) {
    let (mut sink, mut stream) = ws.split();
    loop {
        tokio::select! {
            outbound = out_rx.recv() => match outbound {
                Some(chunk) => {
                    if sink.send(Message::binary(chunk)).await.is_err() {
                        break;
                    }
                }
                None => break,
            },
            inbound = stream.next() => match inbound {
                Some(Ok(Message::Binary(bytes))) => {
                    if in_tx.send(bytes.to_vec()).await.is_err() {
                        break;
                    }
                }
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(_)) => {}
                Some(Err(_)) => break,
            },
        }
    }
    let _ = sink.close().await;
}

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn send_frame(ws: &mut WsStream, frame: &ControlFrame) -> Result<(), String> {
    let raw = serde_json::to_string(frame).map_err(|e| format!("encode control frame: {e}"))?;
    ws.send(Message::text(raw))
        .await
        .map_err(|e| format!("send control frame: {e}"))
}

fn build_request(
    cfg: &ClientConfig,
    url: &str,
) -> Result<tokio_tungstenite::tungstenite::handshake::client::Request, String> {
    let mut request = url
        .into_client_request()
        .map_err(|e| format!("bad tunnel url {url}: {e}"))?;
    if let Some(bearer) = &cfg.bearer {
        request.headers_mut().insert(
            "Authorization",
            format!("Bearer {bearer}")
                .parse()
                .map_err(|e| format!("bad bearer header: {e}"))?,
        );
    }
    if let Some(cookie) = &cfg.cookie {
        request.headers_mut().insert(
            "Cookie",
            cookie
                .parse()
                .map_err(|e| format!("bad cookie header: {e}"))?,
        );
    }
    if let Some(origin) = &cfg.origin {
        request.headers_mut().insert(
            "Origin",
            origin
                .parse()
                .map_err(|e| format!("bad origin header: {e}"))?,
        );
    }
    Ok(request)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spec::{parse_spec, Proto};

    fn cfg(base: &str, spec: TunnelSpec) -> ClientConfig {
        ClientConfig {
            base_ws_url: base.to_string(),
            bearer: Some("tok".into()),
            cookie: None,
            origin: None,
            tunnel_id: "tun-test".into(),
            spec,
        }
    }

    #[test]
    fn the_control_url_carries_the_tunnel_id() {
        let c = cfg(
            "ws://127.0.0.1:1/",
            parse_spec("0:3000", Proto::Tcp).unwrap(),
        );
        let url = format!(
            "{}{}?{}={}",
            c.base_ws_url.trim_end_matches('/'),
            CONTROL_PATH,
            TUNNEL_PARAM,
            c.tunnel_id
        );
        assert_eq!(
            url,
            "ws://127.0.0.1:1/api/library/tunnel/control?tunnel=tun-test"
        );
        // And it builds into a request carrying the bearer.
        let request = build_request(&c, &url).unwrap();
        assert_eq!(
            request.headers().get("Authorization").unwrap(),
            "Bearer tok"
        );
    }

    #[tokio::test]
    async fn an_unreachable_devserver_fails_before_binding_anything() {
        // Port 1 on loopback refuses; the listener must not be left bound.
        let spec = parse_spec("0:3000", Proto::Tcp).unwrap();
        let err = open(cfg("ws://127.0.0.1:1", spec)).await.unwrap_err();
        assert!(
            err.contains("connect tunnel control socket"),
            "unexpected error: {err}"
        );
    }

    /// A mock control socket: accept one WebSocket, hand back the stream.
    async fn mock_control() -> (String, tokio::task::JoinHandle<WsServer>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (sock, _) = listener.accept().await.unwrap();
            tokio_tungstenite::accept_async(sock).await.unwrap()
        });
        (format!("ws://{addr}"), server)
    }

    /// A mock devserver that answers the control socket and then accepts data
    /// sockets, holding each open without reading, so a bridge stays in flight.
    async fn mock_devserver() -> (String, mpsc::Receiver<WsServer>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = mpsc::channel(8);
        tokio::spawn(async move {
            while let Ok((sock, _)) = listener.accept().await {
                let Ok(ws) = tokio_tungstenite::accept_async(sock).await else {
                    continue;
                };
                if tx.send(ws).await.is_err() {
                    break;
                }
            }
        });
        (format!("ws://{addr}"), rx)
    }

    type WsServer = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

    #[tokio::test]
    async fn a_handle_dropped_without_a_stop_still_ends_the_tunnel() {
        // A forgotten handle must close the control socket rather than leave
        // the run loop spinning on a dropped stop sender.
        let (base, server) = mock_control().await;
        let spec = parse_spec("0:3000", Proto::Tcp).unwrap();
        let handle = open(cfg(&base, spec)).await.expect("tunnel opens");
        let mut ws = server.await.unwrap();

        // The first frame is the ready announcement.
        let ready = ws.next().await.unwrap().unwrap();
        assert!(matches!(ready, Message::Text(_)));

        drop(handle);

        // The loop must break and close, promptly. Without the dropped-sender
        // guard this read never resolves and the loop burns a core.
        let closed = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while let Some(frame) = ws.next().await {
                match frame {
                    Ok(Message::Close(_)) | Err(_) => return true,
                    Ok(_) => continue,
                }
            }
            true
        })
        .await;
        assert!(
            closed.is_ok(),
            "the run loop never closed its control socket"
        );
    }

    #[tokio::test]
    async fn ending_the_tunnel_drops_connections_that_are_still_carrying_bytes() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let (base, mut sockets) = mock_devserver().await;
        let spec = parse_spec("0:3000", Proto::Tcp).unwrap();
        let handle = open(cfg(&base, spec)).await.expect("tunnel opens");
        let mut control = sockets.recv().await.expect("control socket");
        assert!(matches!(
            control.next().await.unwrap().unwrap(),
            Message::Text(_)
        ));

        // A live bridge: the caller connects and its bytes reach the devserver
        // end, so this connection is genuinely in flight when the tunnel ends.
        let mut caller = TcpStream::connect(handle.bound).await.unwrap();
        let mut data = sockets.recv().await.expect("data socket");
        caller.write_all(b"in-flight").await.unwrap();
        assert_eq!(
            data.next().await.unwrap().unwrap(),
            Message::binary(b"in-flight".to_vec())
        );

        handle.stop();

        // The caller's socket must close rather than hang: ending the
        // foreground command ends the connections it was carrying.
        let mut sink = Vec::new();
        let drained = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            caller.read_to_end(&mut sink),
        )
        .await;
        assert!(
            drained.is_ok(),
            "an in-flight connection outlived the tunnel that carried it"
        );
    }
}
