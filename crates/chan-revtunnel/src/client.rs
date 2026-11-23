//! Desktop-side half: bind the listener, answer the devserver, bridge each
//! accepted connection back over its own WebSocket.
//!
//! This module is deliberately free of Tauri: it takes a devserver base URL
//! plus credentials and nothing else, so the desktop shell calls it from a
//! command handler while the end-to-end harness calls it directly. That is
//! also what makes the acceptance tests runnable on a machine with no display
//! server, which is where this code has to be verified.

use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;

use futures::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::Uri;
use tokio_tungstenite::tungstenite::Message;

use crate::bridge::{splice, splice_half_close};
use crate::spec::{render_authority, TunnelSpec};
use crate::wire::{
    ControlFrame, CONN_PARAM, CONN_PATH, CONTROL_PATH, HALF_CLOSE_MARKER, HALF_CLOSE_PARAM,
    TUNNEL_PARAM,
};

/// How often the control socket is pinged while idle. Well under the gateway
/// bridge's 300s both-directions idle cut, matching the window feed's own
/// keepalive so a gateway-attached tunnel survives a quiet period.
const PING_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);

/// Pause before retrying an accept that failed for a non-connection reason
/// (fd exhaustion under EMFILE/ENFILE, buffer pressure). Long enough that a
/// starved process is not spinning on a hot error loop, short enough that a
/// queued connection is served the moment the pressure clears.
const ACCEPT_RETRY_PAUSE: std::time::Duration = std::time::Duration::from_millis(500);

/// Called only after the leg has decided to end, this one-second grace gives
/// the send slot and Close frame a final flush without tying teardown to a
/// transport idle deadline. Expiry loses the Close frame and, after an
/// abnormal exit, may also lose the worker's one in-flight data frame.
const HALF_CLOSE_CLOSE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(1);

/// The accept errors that mean one PEER vanished between SYN and accept
/// rather than anything about the listener: retried immediately, exactly as
/// axum's serve loop classifies them.
fn is_connection_error(e: &std::io::Error) -> bool {
    matches!(
        e.kind(),
        std::io::ErrorKind::ConnectionRefused
            | std::io::ErrorKind::ConnectionAborted
            | std::io::ErrorKind::ConnectionReset
    )
}

/// What [`Transport::connect`] resolves to: the stream a routed dial runs
/// over, `None` for a direct dial, or the I/O error the route met.
pub type ConnectFuture<'a> =
    Pin<Box<dyn Future<Output = std::io::Result<Option<TcpStream>>> + Send + 'a>>;

/// Where a tunnel socket's TCP stream comes from when the machine's own dial
/// to the URL's authority is not the whole answer: the embedder reaches the
/// devserver through a proxy, or through a tunnel inside the process. It
/// decides the route and nothing else. The URL, the `Host` header, the
/// credentials and the TLS server name stay the ones [`ClientConfig`] names,
/// and TLS stays [`ClientConfig::connector`]'s job.
///
/// The client asks before every dial, the control socket's and each data
/// socket's, so an embedder's routing policy is read when the dial happens
/// and a tunnel never dials by a route it remembered.
pub trait Transport: Send + Sync {
    /// The stream for a dial of `uri`, a tunnel socket's full `ws://` or
    /// `wss://` URL. `Ok(Some(stream))` is a stream already connected toward
    /// that URL's authority: the client runs TLS over it when the scheme asks
    /// for it, then the WebSocket handshake, both addressed to the URL's own
    /// host. `Ok(None)` selects the direct dial. An error fails the dial: the
    /// client never answers a failed route by dialing directly.
    fn connect<'a>(&'a self, uri: &'a Uri) -> ConnectFuture<'a>;
}

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
    /// Whether the devserver advertised the half-close data-leg contract.
    pub half_close: bool,
    /// The TLS connector of a `wss://` origin, so the tunnel's sockets verify
    /// the gateway as the caller's other clients do. `None` keeps
    /// tokio-tungstenite's own connector, over the bundled roots.
    pub connector: Option<tokio_tungstenite::Connector>,
    /// The route of every tunnel socket, asked at each dial. `None` dials
    /// each socket directly.
    pub transport: Option<Arc<dyn Transport>>,
}

/// A running tunnel. Dropping the handle requests shutdown, as does [`TunnelHandle::stop`]. Await [`TunnelHandle::wait`] to join the task after a stop request or wait for the devserver to close it.
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
    let (mut control, _) = dial(&cfg, request)
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
                    // Never fatal to the tunnel: only the foreground command,
                    // the devserver, or the control socket may end it, and an
                    // accept error names none of those. Ending on a transient
                    // EMFILE here would close the control socket, which the
                    // devserver reports to the blocked `cs tunnel` as the
                    // desktop dying. The devserver end of this same
                    // feature rides axum's serve loop, which retries every
                    // accept error; mirror that policy, paced for the
                    // resource-pressure class. The pause runs inline, so a
                    // devserver `close` frame waits out at most one pause.
                    tracing::warn!("revtunnel: accept failed: {e}");
                    if !is_connection_error(&e) {
                        tokio::time::sleep(ACCEPT_RETRY_PAUSE).await;
                    }
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
    let url = data_url(&cfg, &conn_id);
    let request = build_request(&cfg, &url)?;
    let (ws, _) = dial(&cfg, request)
        .await
        .map_err(|e| format!("connect tunnel data socket: {e}"))?;

    let (to_peer_tx, to_peer_rx) = mpsc::channel::<Vec<u8>>(16);
    let (from_peer_tx, from_peer_rx) = mpsc::channel::<Vec<u8>>(16);
    if cfg.half_close {
        tokio::join!(
            splice_half_close(sock, to_peer_tx, from_peer_rx),
            shuttle_half_close(ws, to_peer_rx, from_peer_tx),
        );
    } else {
        tokio::join!(
            splice(sock, to_peer_tx, from_peer_rx),
            shuttle(ws, to_peer_rx, from_peer_tx),
        );
    }
    Ok(())
}

/// Open one tunnel socket, control or data, over the route the transport
/// names for it now. A routed stream carries the same TLS and WebSocket
/// handshakes the direct dial runs, for the same host, so the route changes
/// how the bytes travel and not who is verified or what is presented.
async fn dial(
    cfg: &ClientConfig,
    request: tokio_tungstenite::tungstenite::handshake::client::Request,
) -> Result<
    (
        WsStream,
        tokio_tungstenite::tungstenite::handshake::client::Response,
    ),
    tokio_tungstenite::tungstenite::Error,
> {
    let routed = match &cfg.transport {
        Some(transport) => transport
            .connect(request.uri())
            .await
            .map_err(tokio_tungstenite::tungstenite::Error::Io)?,
        None => None,
    };
    match routed {
        Some(stream) => {
            tokio_tungstenite::client_async_tls_with_config(
                request,
                stream,
                None,
                cfg.connector.clone(),
            )
            .await
        }
        None => {
            tokio_tungstenite::connect_async_tls_with_config(
                request,
                None,
                false,
                cfg.connector.clone(),
            )
            .await
        }
    }
}

fn data_url(cfg: &ClientConfig, conn_id: &str) -> String {
    let mut url = format!(
        "{}{}?{}={}&{}={}",
        cfg.base_ws_url.trim_end_matches('/'),
        CONN_PATH,
        TUNNEL_PARAM,
        cfg.tunnel_id,
        CONN_PARAM,
        conn_id
    );
    if cfg.half_close {
        url.push_str(&format!("&{HALF_CLOSE_PARAM}=true"));
    }
    url
}

/// Move bytes between the splice channels and the WebSocket.
///
/// The directions are independently polled, but either one ending closes the
/// whole WebSocket as the legacy contract requires. A downlink end signals the
/// outbound direction and waits for its unbounded close attempt. If that stop
/// wins after the outbound direction has received a chunk but before its send
/// begins, the chunk is discarded as both-direction teardown starts. No close
/// timeout is imposed because expiry can replace the legacy peer's Close with
/// a transport reset.
async fn shuttle(ws: WsStream, mut out_rx: mpsc::Receiver<Vec<u8>>, in_tx: mpsc::Sender<Vec<u8>>) {
    let (mut sink, mut stream) = ws.split();
    let (stop_tx, mut stop_rx) = tokio::sync::oneshot::channel();
    let outbound = async move {
        loop {
            let chunk = tokio::select! {
                biased;
                _ = &mut stop_rx => break,
                chunk = out_rx.recv() => chunk,
            };
            let Some(chunk) = chunk else { break };
            let sent = tokio::select! {
                biased;
                _ = &mut stop_rx => false,
                result = sink.send(Message::binary(chunk)) => result.is_ok(),
            };
            if !sent {
                break;
            }
        }
        let _ = sink.close().await;
    };
    let downlink = async move {
        while let Some(inbound) = stream.next().await {
            match inbound {
                Ok(Message::Binary(bytes)) => {
                    if in_tx.send(bytes.to_vec()).await.is_err() {
                        break;
                    }
                }
                Ok(Message::Close(_)) => break,
                Ok(_) => {}
                Err(_) => break,
            }
        }
    };
    tokio::pin!(outbound);
    tokio::pin!(downlink);
    tokio::select! {
        _ = &mut outbound => {}
        _ = &mut downlink => {
            let _ = stop_tx.send(());
            outbound.await;
        }
    }
}

fn half_close_outbound_message(chunk: Vec<u8>) -> Message {
    if chunk.is_empty() {
        Message::text(HALF_CLOSE_MARKER)
    } else {
        Message::binary(chunk)
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

/// Move negotiated data and directional end markers over the WebSocket.
///
/// The adapter owns an outbound task that stays independent of a blocked
/// inbound channel send. After an inbound marker, later data frames are
/// discarded while the stream remains polled for transport closure until the
/// outbound direction ends. Before that marker, inbound channel backpressure
/// can pause stream polling. Every completed exit that recovers the sink makes
/// exactly one bounded close attempt.
async fn shuttle_half_close(
    ws: WsStream,
    mut out_rx: mpsc::Receiver<Vec<u8>>,
    in_tx: mpsc::Sender<Vec<u8>>,
) {
    let (mut sink, mut stream) = ws.split();
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
                    Some(Err(_)) | None => return,
                }
            }
            inbound = stream.next() => match inbound {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
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
                        in_tx.take();
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
                Some(Err(_)) | None => return,
            }
        }
    };
    close_half_close(sink.close()).await;
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
            half_close: false,
            connector: None,
            transport: None,
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

    #[test]
    fn the_data_url_advertises_half_close_only_when_enabled() {
        let mut c = cfg(
            "ws://127.0.0.1:1/",
            parse_spec("0:3000", Proto::Tcp).unwrap(),
        );
        assert_eq!(
            data_url(&c, "c1"),
            "ws://127.0.0.1:1/api/library/tunnel/conn?tunnel=tun-test&conn=c1"
        );
        c.half_close = true;
        assert_eq!(
            data_url(&c, "c1"),
            "ws://127.0.0.1:1/api/library/tunnel/conn?tunnel=tun-test&conn=c1&half_close=true"
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
            Message::binary(b"bytes".to_vec())
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
            half_close_inbound_chunk(Message::binary(b"bytes".to_vec())),
            Some(b"bytes".to_vec())
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
    async fn a_wss_origin_dials_with_the_connector_it_is_given() {
        let (tls, handshakes) = chan_tls::testing::recording(chan_tls::client_config().unwrap());
        let sink = chan_tls::testing::Sink::start();
        let mut c = cfg(
            &format!("wss://{}", sink.addr),
            parse_spec("0:3000", Proto::Tcp).unwrap(),
        );
        c.connector = Some(tokio_tungstenite::Connector::Rustls(std::sync::Arc::new(
            tls,
        )));
        let err = open(c).await.unwrap_err();
        assert!(err.contains("connect tunnel control socket"), "{err}");
        assert_eq!(handshakes.server_names(), ["127.0.0.1"]);
        assert_eq!(sink.alpn_offers(), [Vec::<String>::new()]);
    }

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

    #[tokio::test]
    async fn a_peer_close_after_its_half_close_marker_ends_the_adapter() {
        let (base, server) = mock_control().await;
        let (ws, _) = tokio_tungstenite::connect_async(base)
            .await
            .expect("connect adapter socket");
        let mut peer = server.await.expect("accept adapter socket");
        let (out_tx, out_rx) = mpsc::channel(1);
        let (in_tx, mut in_rx) = mpsc::channel(1);
        let adapter = tokio::spawn(shuttle_half_close(ws, out_rx, in_tx));

        peer.send(Message::text(HALF_CLOSE_MARKER))
            .await
            .expect("send inbound marker");
        assert_eq!(
            tokio::time::timeout(std::time::Duration::from_secs(2), in_rx.recv())
                .await
                .expect("adapter forwards inbound marker"),
            Some(Vec::new())
        );

        // Data after the marker is outside that direction's stream. Keep the
        // outbound channel live so only the peer close can end the adapter.
        peer.send(Message::binary(b"after-marker".to_vec()))
            .await
            .expect("send post-marker data");
        peer.close(None).await.expect("close peer socket");
        tokio::time::timeout(std::time::Duration::from_secs(2), adapter)
            .await
            .expect("peer close ends the adapter after its marker")
            .expect("adapter task");
        assert_eq!(in_rx.recv().await, None);
        drop(out_tx);
    }

    #[tokio::test]
    async fn a_local_pump_failure_sends_a_close_frame_to_the_peer() {
        let (base, server) = mock_control().await;
        let (ws, _) = tokio_tungstenite::connect_async(base)
            .await
            .expect("connect adapter socket");
        let mut peer = server.await.expect("accept adapter socket");
        let (out_tx, out_rx) = mpsc::channel(1);
        let (in_tx, _in_rx) = mpsc::channel(1);
        let adapter = tokio::spawn(shuttle_half_close(ws, out_rx, in_tx));

        drop(out_tx);
        let frame = tokio::time::timeout(std::time::Duration::from_secs(2), peer.next())
            .await
            .expect("local pump failure closes the data socket")
            .expect("peer observes the close frame")
            .expect("close frame is valid");
        assert!(
            matches!(frame, Message::Close(_)),
            "unexpected frame: {frame:?}"
        );
        tokio::time::timeout(std::time::Duration::from_secs(2), adapter)
            .await
            .expect("adapter ends after closing the data socket")
            .expect("adapter task");
    }

    #[tokio::test]
    async fn an_unreadable_peer_cannot_hold_a_half_close_adapter_forever() {
        let (base, server) = mock_control().await;
        let (ws, _) = tokio_tungstenite::connect_async(base)
            .await
            .expect("connect adapter socket");
        let mut peer = server.await.expect("accept adapter socket");
        let (out_tx, out_rx) = mpsc::channel(1);
        let (in_tx, in_rx) = mpsc::channel(1);
        drop(in_rx);
        let adapter = tokio::spawn(shuttle_half_close(ws, out_rx, in_tx));

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
        peer.send(Message::binary(b"stop".to_vec()))
            .await
            .expect("trigger inbound channel failure");

        tokio::time::timeout(std::time::Duration::from_secs(3), adapter)
            .await
            .expect("an unreadable peer cannot retain the adapter")
            .expect("adapter task");
    }

    #[tokio::test]
    async fn legacy_adapter_moves_large_full_duplex_streams_independently() {
        const TRANSFER_BYTES: usize = 8 * 1024 * 1024;
        const CHUNK_BYTES: usize = 64 * 1024;

        let (base, server) = mock_control().await;
        let (ws, _) = tokio_tungstenite::connect_async(base)
            .await
            .expect("connect adapter socket");
        let mut peer = server.await.expect("accept adapter socket");
        let (out_tx, out_rx) = mpsc::channel(16);
        let (in_tx, mut in_rx) = mpsc::channel(16);
        let adapter = tokio::spawn(shuttle(ws, out_rx, in_tx));
        let request = vec![0x35; TRANSFER_BYTES];
        let response = vec![0xc1; TRANSFER_BYTES];

        let local_response = response.clone();
        let local = async move {
            let send = async move {
                for chunk in local_response.chunks(CHUNK_BYTES) {
                    out_tx
                        .send(chunk.to_vec())
                        .await
                        .expect("queue local response");
                }
            };
            let receive = async move {
                let mut received = Vec::with_capacity(TRANSFER_BYTES);
                while received.len() < TRANSFER_BYTES {
                    let Some(chunk) = in_rx.recv().await else {
                        break;
                    };
                    received.extend_from_slice(&chunk);
                }
                received
            };
            let ((), received) = tokio::join!(send, receive);
            received
        };
        let peer_request = request.clone();
        let remote = async move {
            for chunk in peer_request.chunks(CHUNK_BYTES) {
                peer.send(Message::binary(chunk.to_vec()))
                    .await
                    .expect("send peer request");
            }
            let mut received = Vec::with_capacity(TRANSFER_BYTES);
            while let Some(frame) = peer.next().await {
                match frame.expect("receive local response") {
                    Message::Binary(bytes) => received.extend_from_slice(&bytes),
                    Message::Close(_) => break,
                    _ => {}
                }
            }
            received
        };

        let (received_request, received_response, ()) =
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                let (received_request, received_response, adapter) =
                    tokio::join!(local, remote, adapter);
                (
                    received_request,
                    received_response,
                    adapter.expect("adapter task"),
                )
            })
            .await
            .expect("legacy full-duplex transfer must not wedge");
        assert_eq!(received_request, request);
        assert_eq!(received_response, response);
    }

    /// What one upgrade to a fixture carried.
    #[derive(Debug, Clone, PartialEq, Eq)]
    struct Upgrade {
        /// The request target: path and query.
        target: String,
        host: Option<String>,
        cookie: Option<String>,
        origin: Option<String>,
    }

    impl Upgrade {
        fn of(request: &tokio_tungstenite::tungstenite::handshake::server::Request) -> Self {
            let header = |name: &str| {
                request
                    .headers()
                    .get(name)
                    .map(|value| value.to_str().unwrap().to_string())
            };
            Self {
                target: request
                    .uri()
                    .path_and_query()
                    .map(|target| target.to_string())
                    .unwrap_or_default(),
                host: header("host"),
                cookie: header("cookie"),
                origin: header("origin"),
            }
        }

        fn is_control(&self) -> bool {
            self.target.starts_with(CONTROL_PATH)
        }
    }

    /// What a fixture answers a data frame with, so a caller reading it back
    /// knows the bytes went to the fixture and returned from it.
    fn answer(bytes: &[u8]) -> Vec<u8> {
        [b"re:".as_slice(), bytes].concat()
    }

    const WAIT: std::time::Duration = std::time::Duration::from_secs(10);

    async fn within<T>(what: &str, future: impl Future<Output = T>) -> T {
        tokio::time::timeout(WAIT, future)
            .await
            .unwrap_or_else(|_| panic!("{what} did not finish"))
    }

    /// A devserver stand-in on loopback: it records every upgrade, hands the
    /// control socket's text frames to the test, and answers each data
    /// socket's binary frames.
    struct Tenant {
        addr: SocketAddr,
        upgrades: Arc<std::sync::Mutex<Vec<Upgrade>>>,
        control: mpsc::Receiver<String>,
    }

    impl Tenant {
        async fn start() -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let upgrades = Arc::new(std::sync::Mutex::new(Vec::new()));
            let (control_tx, control) = mpsc::channel(8);
            let seen = upgrades.clone();
            tokio::spawn(async move {
                while let Ok((sock, _)) = listener.accept().await {
                    let seen = seen.clone();
                    let control_tx = control_tx.clone();
                    tokio::spawn(async move {
                        let mut upgrade = None;
                        let accepted = tokio_tungstenite::accept_hdr_async(
                            sock,
                            #[allow(clippy::result_large_err)]
                            |request: &tokio_tungstenite::tungstenite::handshake::server::Request,
                             response| {
                                upgrade = Some(Upgrade::of(request));
                                Ok(response)
                            },
                        )
                        .await;
                        let (Ok(mut ws), Some(upgrade)) = (accepted, upgrade) else {
                            return;
                        };
                        seen.lock().unwrap().push(upgrade.clone());
                        while let Some(Ok(frame)) = ws.next().await {
                            let open = match frame {
                                Message::Text(text) if upgrade.is_control() => {
                                    let _ = control_tx.send(text.to_string()).await;
                                    true
                                }
                                Message::Binary(bytes) => {
                                    ws.send(Message::binary(answer(&bytes))).await.is_ok()
                                }
                                Message::Close(_) => false,
                                _ => true,
                            };
                            if !open {
                                break;
                            }
                        }
                    });
                }
            });
            Self {
                addr,
                upgrades,
                control,
            }
        }

        fn upgrades(&self) -> Vec<Upgrade> {
            self.upgrades.lock().unwrap().clone()
        }

        async fn ready(&mut self) -> ControlFrame {
            let text = within("the ready frame", self.control.recv())
                .await
                .expect("the control socket reached the fixture");
            serde_json::from_str(&text).expect("a control frame")
        }
    }

    /// A transport that alone reaches a fixture: each dial it carries lands on
    /// `upstream`, whatever authority the URL names, and every dial it is
    /// asked for is recorded. Past `carried` dials it refuses, as a proxy
    /// that will not open the route does.
    struct Routed {
        upstream: SocketAddr,
        carried: usize,
        dials: std::sync::Mutex<Vec<String>>,
    }

    impl Routed {
        fn to(upstream: SocketAddr) -> Arc<Self> {
            Self::carrying(upstream, usize::MAX)
        }

        fn carrying(upstream: SocketAddr, carried: usize) -> Arc<Self> {
            Arc::new(Self {
                upstream,
                carried,
                dials: std::sync::Mutex::new(Vec::new()),
            })
        }

        fn dials(&self) -> Vec<String> {
            self.dials.lock().unwrap().clone()
        }
    }

    impl Transport for Routed {
        fn connect<'a>(&'a self, uri: &'a Uri) -> ConnectFuture<'a> {
            Box::pin(async move {
                let asked = {
                    let mut dials = self.dials.lock().unwrap();
                    dials.push(uri.to_string());
                    dials.len()
                };
                if asked > self.carried {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::ConnectionRefused,
                        "the test proxy refused the route",
                    ));
                }
                TcpStream::connect(self.upstream).await.map(Some)
            })
        }
    }

    /// A transport whose policy selects the direct dial, counting the asks.
    #[derive(Default)]
    struct Direct(std::sync::atomic::AtomicUsize);

    impl Transport for Direct {
        fn connect<'a>(&'a self, _: &'a Uri) -> ConnectFuture<'a> {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Box::pin(async { Ok(None) })
        }
    }

    /// A tenant name no resolver answers (RFC 6761 reserves `.invalid`), so a
    /// socket reaches the fixture through the transport or not at all.
    const TENANT: &str = "alice--0123456789ab.p1.proxy.chan.invalid";

    /// One caller's round trip through a tunnel's listener: its bytes reach
    /// the fixture over a data socket and the fixture's answer comes back.
    async fn round_trip(bound: SocketAddr, bytes: &[u8]) -> TcpStream {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let mut caller = within("the caller's connect", TcpStream::connect(bound))
            .await
            .expect("the tunnel's listener accepts");
        caller.write_all(bytes).await.unwrap();
        let mut back = vec![0u8; answer(bytes).len()];
        within("the fixture's answer", caller.read_exact(&mut back))
            .await
            .expect("the answer crosses the data socket");
        assert_eq!(back, answer(bytes));
        caller
    }

    #[tokio::test]
    async fn a_transport_carries_the_control_socket_and_every_data_socket() {
        let mut tenant = Tenant::start().await;
        let transport = Routed::to(tenant.addr);
        let base = format!("ws://{TENANT}:8443");
        let origin = format!("https://{TENANT}:8443");
        let mut c = cfg(&base, parse_spec("0:3000", Proto::Tcp).unwrap());
        c.bearer = None;
        c.cookie = Some("__Host-devserver_gate=g".into());
        c.origin = Some(origin.clone());
        c.transport = Some(transport.clone());

        let handle = within("the tunnel's open", open(c))
            .await
            .expect("the control socket rides the transport");
        assert_eq!(
            tenant.ready().await,
            ControlFrame::Ready {
                bound: handle.bound.to_string()
            }
        );

        // Two connections, the first still open while the second is served:
        // each data socket is its own dial, asked of the transport anew.
        let first = round_trip(handle.bound, b"one").await;
        let second = round_trip(handle.bound, b"two").await;

        let control = format!("{base}{CONTROL_PATH}?{TUNNEL_PARAM}=tun-test");
        let data =
            |conn: &str| format!("{base}{CONN_PATH}?{TUNNEL_PARAM}=tun-test&{CONN_PARAM}={conn}");
        assert_eq!(transport.dials(), [control, data("c0"), data("c1")]);

        // The route changed how the bytes travel and nothing they say: each
        // upgrade names the tenant and carries the session it was given.
        let upgrade = |target: String| Upgrade {
            target,
            host: Some(format!("{TENANT}:8443")),
            cookie: Some("__Host-devserver_gate=g".into()),
            origin: Some(origin.clone()),
        };
        assert_eq!(
            tenant.upgrades(),
            [
                upgrade(format!("{CONTROL_PATH}?{TUNNEL_PARAM}=tun-test")),
                upgrade(format!(
                    "{CONN_PATH}?{TUNNEL_PARAM}=tun-test&{CONN_PARAM}=c0"
                )),
                upgrade(format!(
                    "{CONN_PATH}?{TUNNEL_PARAM}=tun-test&{CONN_PARAM}=c1"
                )),
            ]
        );

        let bound = handle.bound;
        handle.stop();
        within("the tunnel's end", handle.wait()).await;
        assert!(
            TcpStream::connect(bound).await.is_err(),
            "a stopped tunnel left its listener bound"
        );
        drop((first, second));
    }

    #[tokio::test]
    async fn a_transport_that_selects_the_direct_dial_keeps_it() {
        let mut tenant = Tenant::start().await;
        let transport = Arc::new(Direct::default());
        let mut c = cfg(
            &format!("ws://{}", tenant.addr),
            parse_spec("0:3000", Proto::Tcp).unwrap(),
        );
        c.transport = Some(transport.clone());

        let handle = within("the tunnel's open", open(c))
            .await
            .expect("a direct route dials the URL's own authority");
        assert!(matches!(tenant.ready().await, ControlFrame::Ready { .. }));
        let _caller = round_trip(handle.bound, b"direct").await;
        assert_eq!(
            transport.0.load(std::sync::atomic::Ordering::SeqCst),
            2,
            "the policy is asked for the control socket and for the data socket"
        );
        assert_eq!(
            tenant.upgrades()[0].host,
            Some(tenant.addr.to_string()),
            "a direct dial names the authority it dialed"
        );
    }

    /// A port nothing listens on, free at the time of asking.
    fn free_port() -> u16 {
        std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    #[tokio::test]
    async fn a_refused_route_fails_the_control_dial_without_a_direct_one() {
        // The fixture is reachable directly at the URL's own authority, so a
        // client that answered the refusal by dialing directly would open.
        let tenant = Tenant::start().await;
        let transport = Routed::carrying(tenant.addr, 0);
        let port = free_port();
        let mut c = cfg(
            &format!("ws://{}", tenant.addr),
            parse_spec(&format!("{port}:3000"), Proto::Tcp).unwrap(),
        );
        c.transport = Some(transport.clone());

        let err = within("the tunnel's open", open(c)).await.unwrap_err();
        assert!(err.contains("connect tunnel control socket"), "{err}");
        assert!(err.contains("the test proxy refused the route"), "{err}");
        assert_eq!(transport.dials().len(), 1);
        assert_eq!(tenant.upgrades(), [], "nothing was dialed directly");
        // Nothing was bound for a tunnel that never opened.
        TcpListener::bind(("127.0.0.1", port))
            .await
            .expect("a refused tunnel leaves its port free");
    }

    #[tokio::test]
    async fn a_refused_route_ends_one_connection_without_a_direct_dial() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        // The control socket is carried and every later route is refused,
        // while the fixture stays reachable directly.
        let mut tenant = Tenant::start().await;
        let transport = Routed::carrying(tenant.addr, 1);
        let mut c = cfg(
            &format!("ws://{}", tenant.addr),
            parse_spec("0:3000", Proto::Tcp).unwrap(),
        );
        c.transport = Some(transport.clone());
        let handle = within("the tunnel's open", open(c))
            .await
            .expect("the control socket is carried");
        assert!(matches!(tenant.ready().await, ControlFrame::Ready { .. }));

        let mut caller = TcpStream::connect(handle.bound).await.unwrap();
        caller.write_all(b"lost").await.unwrap();
        let mut back = Vec::new();
        // The connection closes, by a FIN or a reset, with nothing answered.
        let _ = within("the caller's close", caller.read_to_end(&mut back)).await;
        assert_eq!(back, b"", "a refused route answered the caller");
        assert_eq!(transport.dials().len(), 2);
        assert_eq!(
            tenant.upgrades().len(),
            1,
            "the data socket was dialed directly after its route was refused"
        );
    }

    /// A devserver stand-in behind TLS, presenting one leaf. It records the
    /// server name each client asked for beside the upgrade, hands the
    /// control socket's text frames to the test, and answers data frames.
    struct TlsTenant {
        addr: SocketAddr,
        upgrades: Arc<std::sync::Mutex<Vec<(String, Upgrade)>>>,
        control: std::sync::mpsc::Receiver<String>,
    }

    impl TlsTenant {
        fn start(leaf: &chan_tls::testing::pki::Issued) -> Self {
            use chan_tls::rustls;

            let config = Arc::new(
                rustls::ServerConfig::builder_with_provider(Arc::new(
                    rustls::crypto::ring::default_provider(),
                ))
                .with_safe_default_protocol_versions()
                .unwrap()
                .with_no_client_auth()
                .with_single_cert(vec![leaf.cert.clone()], leaf.key.clone_key())
                .unwrap(),
            );
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let addr = listener.local_addr().unwrap();
            let upgrades = Arc::new(std::sync::Mutex::new(Vec::new()));
            let (control_tx, control) = std::sync::mpsc::channel();
            let seen = upgrades.clone();
            std::thread::spawn(move || {
                for socket in listener.incoming() {
                    let Ok(socket) = socket else { continue };
                    let config = config.clone();
                    let seen = seen.clone();
                    let control_tx = control_tx.clone();
                    std::thread::spawn(move || {
                        Self::serve(socket, config, &seen, &control_tx);
                    });
                }
            });
            Self {
                addr,
                upgrades,
                control,
            }
        }

        fn serve(
            socket: std::net::TcpStream,
            config: Arc<chan_tls::rustls::ServerConfig>,
            seen: &std::sync::Mutex<Vec<(String, Upgrade)>>,
            control_tx: &std::sync::mpsc::Sender<String>,
        ) {
            use chan_tls::rustls;
            use tokio_tungstenite::tungstenite;

            // A read that outlives the test ends the thread.
            let _ = socket.set_read_timeout(Some(WAIT));
            let tls =
                rustls::StreamOwned::new(rustls::ServerConnection::new(config).unwrap(), socket);
            let mut upgrade = None;
            let accepted = tungstenite::accept_hdr(
                tls,
                #[allow(clippy::result_large_err)]
                |request: &tungstenite::handshake::server::Request, response| {
                    upgrade = Some(Upgrade::of(request));
                    Ok(response)
                },
            );
            // A client that refuses the certificate never finishes either
            // handshake.
            let Ok(mut ws) = accepted else {
                return;
            };
            let Some(upgrade) = upgrade else {
                return;
            };
            let server_name = ws.get_ref().conn.server_name().unwrap_or("").to_string();
            seen.lock().unwrap().push((server_name, upgrade.clone()));
            while let Ok(frame) = ws.read() {
                let open = match frame {
                    Message::Text(text) if upgrade.is_control() => {
                        let _ = control_tx.send(text.to_string());
                        true
                    }
                    Message::Binary(bytes) => ws.send(Message::binary(answer(&bytes))).is_ok(),
                    Message::Close(_) => false,
                    _ => true,
                };
                if !open {
                    break;
                }
            }
        }

        fn upgrades(&self) -> Vec<(String, Upgrade)> {
            self.upgrades.lock().unwrap().clone()
        }
    }

    /// A client config whose only root is `ca`.
    fn trusting(ca: &chan_tls::testing::pki::Issued) -> chan_tls::rustls::ClientConfig {
        use chan_tls::rustls;

        let mut roots = rustls::RootCertStore::empty();
        roots.add(ca.cert.clone()).unwrap();
        rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth()
    }

    fn rustls_connector(config: chan_tls::rustls::ClientConfig) -> tokio_tungstenite::Connector {
        tokio_tungstenite::Connector::Rustls(Arc::new(config))
    }

    fn wss_cfg(transport: Arc<Routed>, connector: tokio_tungstenite::Connector) -> ClientConfig {
        let mut c = cfg(
            &format!("wss://{TENANT}"),
            parse_spec("0:3000", Proto::Tcp).unwrap(),
        );
        c.connector = Some(connector);
        c.transport = Some(transport);
        c
    }

    #[tokio::test]
    async fn a_carried_wss_tunnel_verifies_the_tenant_with_the_connector_it_is_given() {
        let ca = chan_tls::testing::pki::ca("chan revtunnel test CA");
        let tenant = TlsTenant::start(&chan_tls::testing::pki::leaf_for(&ca, TENANT));
        let transport = Routed::to(tenant.addr);
        let (config, handshakes) = chan_tls::testing::recording(trusting(&ca));

        let handle = within(
            "the tunnel's open",
            open(wss_cfg(transport.clone(), rustls_connector(config))),
        )
        .await
        .expect("the connector's root verifies the tenant's leaf");
        let ready = tenant.control.recv_timeout(WAIT).expect("the ready frame");
        assert_eq!(
            serde_json::from_str::<ControlFrame>(&ready).unwrap(),
            ControlFrame::Ready {
                bound: handle.bound.to_string()
            }
        );
        let _caller = round_trip(handle.bound, b"over tls").await;

        // Both sockets asked TLS for the tenant, the name the URL holds, and
        // never for the address the transport reached.
        assert_eq!(handshakes.server_names(), [TENANT, TENANT]);
        let upgrades = tenant.upgrades();
        assert_eq!(upgrades.len(), 2);
        for (server_name, upgrade) in &upgrades {
            assert_eq!(server_name, TENANT);
            assert_eq!(upgrade.host.as_deref(), Some(TENANT));
        }
        assert!(upgrades[0].1.is_control() && !upgrades[1].1.is_control());
        assert_eq!(transport.dials().len(), 2);
    }

    #[tokio::test]
    async fn a_carried_wss_tunnel_refuses_a_certificate_its_connector_does_not_verify() {
        let ca = chan_tls::testing::pki::ca("chan revtunnel test CA");

        // The shared trust decision holds no root for this CA: the leaf is
        // refused though it names the tenant.
        let tenant = TlsTenant::start(&chan_tls::testing::pki::leaf_for(&ca, TENANT));
        let transport = Routed::to(tenant.addr);
        let shared = rustls_connector(chan_tls::client_config().unwrap());
        let err = within(
            "the tunnel's open",
            open(wss_cfg(transport.clone(), shared)),
        )
        .await
        .unwrap_err();
        assert!(err.contains("connect tunnel control socket"), "{err}");
        assert_eq!(transport.dials().len(), 1, "the route was carried");
        assert_eq!(tenant.upgrades(), []);

        // A trusted CA's leaf for another name is refused too. The leaf also
        // names 127.0.0.1, the address the transport reached, so a client
        // verifying the route's peer instead of the tenant would accept it.
        let other = TlsTenant::start(&chan_tls::testing::pki::leaf_for(
            &ca,
            "bob--ba9876543210.p1.proxy.chan.invalid",
        ));
        let transport = Routed::to(other.addr);
        let err = within(
            "the tunnel's open",
            open(wss_cfg(transport.clone(), rustls_connector(trusting(&ca)))),
        )
        .await
        .unwrap_err();
        assert!(err.contains("connect tunnel control socket"), "{err}");
        assert_eq!(transport.dials().len(), 1, "the route was carried");
        assert_eq!(other.upgrades(), []);
    }
}
