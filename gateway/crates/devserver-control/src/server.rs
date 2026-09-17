use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::io;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use chan_tunnel_proto::{accept_next, H2Duplex};
use devserver_control_proto::{
    read_frame, write_frame, AdmissionLease, AdmissionLeaseBinding, AdmissionLeaseVerifier,
    BrowserSessionRow, CanonicalOrigin, ClientFrame, FrameError, ProxyId, ProxyOriginTemplate,
    ServerFrame, TunnelRow, CONNECT_PATH, CONTENT_TYPE, MAX_BROWSER_SESSION_SNAPSHOT_BYTES,
    MAX_BROWSER_SESSION_SNAPSHOT_ROWS, MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_ROWS, PROTOCOL_VERSION,
};
use h2::server::SendResponse;
use http::{header, Method, Request, Response, StatusCode};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch, Semaphore};
use tokio::task::JoinSet;
use tokio::time::Instant;
use uuid::Uuid;

use crate::{
    config::ProxyCredentials, ActorError, ControllerHandle, MutationStatus, ProxyControlSession,
};

const H2_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const FIRST_STREAM_TIMEOUT: Duration = Duration::from_secs(10);
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(30);
/// Bound on one write to a proxy, and on the final frame plus the
/// half-close that ends a session. The writer is an h2 stream, which
/// stays pending until the proxy grants flow-control window, so a proxy
/// that stops reading would otherwise park the write forever; and a
/// write in a `select!` arm body stops every other arm of its session,
/// deadlines included. A proxy that has not taken a frame for as long as
/// the actor waits before declaring it dead is not coming back, and the
/// session ends with its connection and in-flight permit.
const CONTROL_WRITE_TIMEOUT: Duration = crate::SESSION_DEAD_AFTER;
const MAX_EXTRA_STREAMS: usize = 16;
const MAX_INFLIGHT_CONNECTIONS: usize = 128;
// A full 2,048-row snapshot is 18 frames at the protocol chunk maximum.
// Thirty-two frames/second leaves headroom for concurrent deltas while a
// 64-frame reader queue absorbs one additional window without allowing one
// session to build a large private backlog ahead of the shared actor.
const MAX_CLIENT_FRAMES_PER_WINDOW: usize = 32;
const CLIENT_FRAME_RATE_WINDOW: Duration = Duration::from_secs(1);
const CLIENT_FRAME_QUEUE_CAPACITY: usize = 64;
const PROXY_ID_HEADER: &str = "x-chan-proxy-id";

struct AbortOnDropTask(Option<tokio::task::JoinHandle<()>>);

#[derive(Default)]
struct ClientFrameRateLimiter {
    accepted: VecDeque<Instant>,
}

impl ClientFrameRateLimiter {
    fn accept(&mut self, now: Instant) -> bool {
        while self.accepted.front().is_some_and(|accepted| {
            now.saturating_duration_since(*accepted) >= CLIENT_FRAME_RATE_WINDOW
        }) {
            self.accepted.pop_front();
        }
        if self.accepted.len() >= MAX_CLIENT_FRAMES_PER_WINDOW {
            return false;
        }
        self.accepted.push_back(now);
        true
    }
}

impl AbortOnDropTask {
    fn new(task: tokio::task::JoinHandle<()>) -> Self {
        Self(Some(task))
    }

    async fn cancel(mut self) {
        if let Some(task) = self.0.take() {
            task.abort();
            let _ = task.await;
        }
    }
}

impl Drop for AbortOnDropTask {
    fn drop(&mut self) {
        if let Some(task) = &self.0 {
            task.abort();
        }
    }
}

/// Serve proxy control connections until `shutdown` fires. Returns an
/// error only when the listening socket itself is unusable
/// (`chan_tunnel_proto::AcceptFailure::Listener`); `main` exits the
/// process when this returns, and this is the fleet's only controller.
pub async fn serve_control_listener(
    listener: TcpListener,
    controller: ControllerHandle,
    proxy_credentials: ProxyCredentials,
    admission_lease_verifier: AdmissionLeaseVerifier,
    origin_template: ProxyOriginTemplate,
    shutdown: watch::Receiver<bool>,
) -> io::Result<()> {
    let proxy_credentials = Arc::new(proxy_credentials);
    serve_accepted(
        || listener.accept(),
        move |stream| {
            handle_connection(
                stream,
                controller.clone(),
                proxy_credentials.clone(),
                admission_lease_verifier.clone(),
                origin_template.clone(),
            )
        },
        shutdown,
    )
    .await
}

/// The accept loop over any source of accept results and any
/// connection handler. The listener passes its own `accept` and
/// `handle_connection`; tests pass an `accept` that injects the
/// failures a real socket only produces under fd exhaustion, and a
/// handler that panics, which nothing reachable in `handle_connection`
/// does on demand.
async fn serve_accepted<A, F, H, C>(
    mut accept: A,
    mut handle: H,
    mut shutdown: watch::Receiver<bool>,
) -> io::Result<()>
where
    A: FnMut() -> F,
    F: Future<Output = io::Result<(TcpStream, SocketAddr)>>,
    H: FnMut(TcpStream) -> C,
    C: Future<Output = Result<(), SessionError>> + Send + 'static,
{
    let inflight = Arc::new(Semaphore::new(MAX_INFLIGHT_CONNECTIONS));
    let mut connections = JoinSet::new();
    // Which peer each connection task serves, so a task that panics can
    // still be named in the log.
    let mut peers = HashMap::new();
    loop {
        tokio::select! {
            biased;
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    break;
                }
            }
            joined = connections.join_next_with_id(), if !connections.is_empty() => {
                match joined {
                    Some(Ok((id, ()))) => {
                        peers.remove(&id);
                    }
                    // Only `connections.shutdown()` below cancels a task, so
                    // this is a panic in one proxy's session handler. The
                    // unwind already dropped that connection, its permit and
                    // its command receiver, and the actor retires a session
                    // whose receiver is gone the next time it sends it a
                    // frame. No other proxy's session is involved, so the
                    // listener keeps serving them.
                    Some(Err(error)) => match peers.remove(&error.id()) {
                        Some(peer) => {
                            tracing::error!(%peer, %error, "proxy control connection task failed");
                        }
                        None => tracing::error!(%error, "proxy control connection task failed"),
                    },
                    None => {}
                }
            }
            // `accept_next` retries a failure that concerns one connection
            // at once and pauses after one that means the process is out of
            // descriptors or memory, returning only when the listening socket
            // is unusable. Racing it here is safe: an arm that wins mid-pause
            // drops the pause, and a connection task ending is what frees
            // the descriptors an exhausted accept is waiting for.
            accepted = accept_next("proxy control", &mut accept) => {
                let (stream, peer) = accepted?;
                let Ok(permit) = inflight.clone().try_acquire_owned() else {
                    tracing::warn!(%peer, max = MAX_INFLIGHT_CONNECTIONS, "proxy control connection cap reached");
                    continue;
                };
                let connection = handle(stream);
                let task = connections.spawn(async move {
                    let _permit = permit;
                    if let Err(error) = connection.await {
                        tracing::warn!(%peer, error = ?error, "proxy control connection closed");
                    }
                });
                peers.insert(task.id(), peer);
            }
        }
    }
    connections.shutdown().await;
    Ok(())
}

async fn handle_connection<T>(
    stream: T,
    controller: ControllerHandle,
    proxy_credentials: Arc<ProxyCredentials>,
    admission_lease_verifier: AdmissionLeaseVerifier,
    origin_template: ProxyOriginTemplate,
) -> Result<(), SessionError>
where
    T: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let mut connection = tokio::time::timeout(H2_HANDSHAKE_TIMEOUT, h2::server::handshake(stream))
        .await
        .map_err(|_| SessionError::Timeout("h2 handshake"))??;
    let accepted = tokio::time::timeout(FIRST_STREAM_TIMEOUT, connection.accept())
        .await
        .map_err(|_| SessionError::Timeout("first control stream"))?;
    let (request, mut respond) = match accepted {
        Some(result) => result?,
        None => return Ok(()),
    };

    let authenticated_proxy_id = match validate_request(&request, &proxy_credentials) {
        Ok(proxy_id) => proxy_id,
        Err(status) => {
            send_http_response(&mut respond, status, true)?;
            connection.graceful_shutdown();
            let _ = tokio::time::timeout(Duration::from_secs(1), async {
                while connection.accept().await.is_some() {}
            })
            .await;
            return Ok(());
        }
    };
    let (_parts, recv) = request.into_parts();
    let send = send_http_response(&mut respond, StatusCode::OK, false)?
        .expect("non-terminal response has a body stream");

    let mut session = Box::pin(run_session(
        H2Duplex::new(send, recv),
        controller,
        origin_template,
        authenticated_proxy_id,
        admission_lease_verifier,
    ));
    let mut rejected = 0usize;
    let result = loop {
        tokio::select! {
            result = &mut session => break result,
            stream = connection.accept() => {
                let Some(stream) = stream else {
                    break session.await;
                };
                if let Ok((_request, mut respond)) = stream {
                    let _ = send_http_response(&mut respond, StatusCode::CONFLICT, true);
                    rejected += 1;
                    if rejected >= MAX_EXTRA_STREAMS {
                        connection.abrupt_shutdown(h2::Reason::ENHANCE_YOUR_CALM);
                    }
                }
            }
        }
    };
    connection.graceful_shutdown();
    let _ = tokio::time::timeout(Duration::from_secs(1), async {
        while connection.accept().await.is_some() {}
    })
    .await;
    result
}

fn validate_request<B>(
    request: &Request<B>,
    proxy_credentials: &ProxyCredentials,
) -> Result<ProxyId, StatusCode> {
    if request.method() != Method::POST {
        return Err(StatusCode::METHOD_NOT_ALLOWED);
    }
    if request.uri().path() != CONNECT_PATH {
        return Err(StatusCode::NOT_FOUND);
    }
    let provided = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    let proxy_id = request
        .headers()
        .get(PROXY_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| ProxyId::parse(value).ok())
        .ok_or(StatusCode::UNAUTHORIZED)?;
    if !provided.is_some_and(|token| proxy_credentials.authenticate(&proxy_id, token.as_bytes())) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let content_type = request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    if content_type != Some(CONTENT_TYPE) {
        return Err(StatusCode::UNSUPPORTED_MEDIA_TYPE);
    }
    Ok(proxy_id)
}

fn send_http_response(
    respond: &mut SendResponse<bytes::Bytes>,
    status: StatusCode,
    end_stream: bool,
) -> Result<Option<h2::SendStream<bytes::Bytes>>, SessionError> {
    let response = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, CONTENT_TYPE)
        .body(())
        .map_err(|error| SessionError::Protocol(error.to_string()))?;
    let send = respond.send_response(response, end_stream)?;
    Ok((!end_stream).then_some(send))
}

async fn run_session<S>(
    stream: S,
    controller: ControllerHandle,
    origin_template: ProxyOriginTemplate,
    authenticated_proxy_id: ProxyId,
    admission_lease_verifier: AdmissionLeaseVerifier,
) -> Result<(), SessionError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (mut reader, mut writer) = tokio::io::split(stream);
    let hello = tokio::time::timeout(HELLO_TIMEOUT, read_frame::<_, ClientFrame>(&mut reader))
        .await
        .map_err(|_| SessionError::Timeout("ClientHello"))??;
    let ClientFrame::ClientHello {
        protocol_version,
        package_version,
        proxy_id,
        proxy_base_url,
        boot_id,
    } = hello
    else {
        send_shutdown(&mut writer, "ClientHello must be the first frame").await?;
        return Err(SessionError::Protocol(
            "first control frame was not ClientHello".into(),
        ));
    };
    if proxy_id != authenticated_proxy_id {
        send_shutdown(
            &mut writer,
            "ClientHello proxy id does not match its credential",
        )
        .await?;
        return Err(SessionError::Protocol(
            "ClientHello proxy id does not match its credential".into(),
        ));
    }
    if protocol_version != PROTOCOL_VERSION {
        send_shutdown(&mut writer, "unsupported control protocol version").await?;
        return Err(SessionError::Protocol(
            "unsupported control protocol version".into(),
        ));
    }
    if package_version != env!("CARGO_PKG_VERSION") {
        send_shutdown(&mut writer, "gateway package version mismatch").await?;
        return Err(SessionError::Protocol(
            "gateway package version mismatch".into(),
        ));
    }
    if let Err(message) = validate_origin(&origin_template, &proxy_id, &proxy_base_url) {
        send_shutdown(&mut writer, message).await?;
        return Err(SessionError::Protocol(message.to_string()));
    }

    let mut session = match controller
        .begin_session(proxy_id.clone(), proxy_base_url, package_version, boot_id)
        .await
    {
        Ok(session) => session,
        Err(ActorError::State(crate::StateError::DuplicateProxyId)) => {
            send_shutdown(&mut writer, "proxy id already has a live session").await?;
            return Err(SessionError::Protocol("duplicate proxy id".into()));
        }
        Err(error) => return Err(error.into()),
    };
    write_control(
        &mut writer,
        &ServerFrame::ServerHello {
            protocol_version: PROTOCOL_VERSION,
            package_version: env!("CARGO_PKG_VERSION").into(),
            heartbeat_seconds: crate::HEARTBEAT_INTERVAL.as_secs(),
            dead_seconds: crate::SESSION_DEAD_AFTER.as_secs(),
            grace_seconds: devserver_control_proto::PROXY_CONTROL_LOSS_GRACE_SECONDS,
        },
    )
    .await?;

    let incarnation = session.incarnation;
    let result = run_established(
        reader,
        &mut writer,
        &controller,
        &proxy_id,
        &admission_lease_verifier,
        &mut session,
    )
    .await;
    if let Err(error) = controller.disconnect(proxy_id, incarnation).await {
        if !matches!(error, ActorError::State(crate::StateError::StaleSession)) {
            tracing::warn!(error = ?error, "failed to remove closed proxy control session");
        }
    }
    result
}

fn validate_origin(
    template: &ProxyOriginTemplate,
    proxy_id: &ProxyId,
    provided: &CanonicalOrigin,
) -> Result<(), &'static str> {
    let expected = template
        .expand(proxy_id)
        .map_err(|_| "proxy base URL template expansion failed")?;
    if &expected == provided {
        Ok(())
    } else {
        Err("proxy base URL does not match its validated proxy id")
    }
}

async fn run_established<R, W>(
    mut reader: R,
    writer: &mut W,
    controller: &ControllerHandle,
    proxy_id: &ProxyId,
    admission_lease_verifier: &AdmissionLeaseVerifier,
    session: &mut ProxyControlSession,
) -> Result<(), SessionError>
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin,
{
    // One task owns the framed reader for the entire established session.
    // `read_frame` is not cancellation-safe after consuming a length prefix
    // or payload fragment, so it must never be recreated by a `select!` arm.
    let (incoming_tx, mut incoming_rx) = mpsc::channel(CLIENT_FRAME_QUEUE_CAPACITY);
    let (overflow_tx, mut overflow_rx) = mpsc::channel(1);
    let reader_task = AbortOnDropTask::new(tokio::spawn(async move {
        loop {
            let frame = read_frame::<_, ClientFrame>(&mut reader).await;
            let terminal = frame.is_err();
            match incoming_tx.try_send(frame) {
                Ok(()) if !terminal => {}
                Ok(()) => break,
                Err(mpsc::error::TrySendError::Full(_)) => {
                    let _ = overflow_tx.try_send(());
                    break;
                }
                Err(mpsc::error::TrySendError::Closed(_)) => break,
            }
        }
    }));

    let mut phase = Phase::awaiting_snapshot();
    let mut frame_rate = ClientFrameRateLimiter::default();
    let mut overflow_open = true;
    let result = async {
        loop {
            let deadline = phase.deadline();
            tokio::select! {
                biased;
                _ = wait_deadline(deadline) => {
                    send_shutdown(writer, "snapshot deadline exceeded").await?;
                    return Err(SessionError::Timeout("initial snapshot"));
                }
                overflowed = overflow_rx.recv(), if overflow_open => {
                    match overflowed {
                        Some(()) => {
                            send_shutdown(writer, "client frame queue overflowed").await?;
                            return Err(SessionError::Protocol("client frame queue overflowed".into()));
                        }
                        None => overflow_open = false,
                    }
                }
                outgoing = session.commands.recv() => {
                    let Some(outgoing) = outgoing else {
                        return Ok(());
                    };
                    let resync = matches!(outgoing, ServerFrame::ResyncRequired { .. });
                    let shutdown = matches!(outgoing, ServerFrame::Shutdown { .. });
                    tracing::debug!(frame = ?outgoing, "sending proxy control frame");
                    if shutdown {
                        write_final(writer, &outgoing).await?;
                        return Ok(());
                    }
                    write_control(writer, &outgoing).await?;
                    if resync {
                        phase = Phase::awaiting_snapshot();
                    }
                }
                incoming = incoming_rx.recv() => {
                    let incoming = incoming
                        .ok_or_else(|| SessionError::Protocol("client frame reader stopped".into()))??;
                    if !snapshot_chunk_is_exempt(&phase, &incoming)
                        && !frame_rate.accept(Instant::now())
                    {
                        send_shutdown(writer, "client frame rate limit exceeded").await?;
                        return Err(SessionError::Protocol("client frame rate limit exceeded".into()));
                    }
                    if let Err(error) = incoming.validate() {
                        send_shutdown(writer, "invalid control frame").await?;
                        return Err(error.into());
                    }
                    handle_client_frame(
                        incoming,
                        &mut phase,
                        writer,
                        controller,
                        proxy_id,
                        admission_lease_verifier,
                        session.incarnation,
                    ).await?;
                }
            }
        }
    }
    .await;
    reader_task.cancel().await;
    result
}

#[allow(clippy::too_many_arguments)]
async fn handle_client_frame<W>(
    frame: ClientFrame,
    phase: &mut Phase,
    writer: &mut W,
    controller: &ControllerHandle,
    proxy_id: &ProxyId,
    admission_lease_verifier: &AdmissionLeaseVerifier,
    incarnation: crate::SessionIncarnation,
) -> Result<(), SessionError>
where
    W: AsyncWrite + Unpin,
{
    let frame = match frame {
        ClientFrame::Pong { nonce } => {
            controller
                .pong(proxy_id.clone(), incarnation, nonce)
                .await?;
            return Ok(());
        }
        frame => frame,
    };
    match phase {
        Phase::AwaitSnapshot { deadline } => match frame {
            ClientFrame::SnapshotStart { base_generation } => {
                controller
                    .record_activity(proxy_id.clone(), incarnation)
                    .await?;
                *phase = Phase::Snapshot {
                    deadline: *deadline,
                    base_generation,
                    rows: Vec::new(),
                    refused: Vec::new(),
                    registration_ids: HashSet::new(),
                    bytes: 0,
                    browser_sessions: Vec::new(),
                    browser_session_ids: HashSet::new(),
                    browser_session_bytes: 0,
                };
            }
            ClientFrame::ClientHello { .. } => {
                return illegal_frame(writer, "duplicate ClientHello").await;
            }
            _ => {
                send_resync(writer, 0).await?;
                *phase = Phase::awaiting_snapshot();
            }
        },
        Phase::Snapshot {
            deadline: _,
            base_generation,
            rows,
            refused,
            registration_ids,
            bytes,
            browser_sessions,
            browser_session_ids,
            browser_session_bytes,
        } => match frame {
            ClientFrame::SnapshotChunk { rows: chunk } => {
                controller
                    .record_activity(proxy_id.clone(), incarnation)
                    .await?;
                // Every row the proxy sent counts, refused or not: the
                // limits bound what it may publish.
                if !snapshot_rows_fit(registration_ids.len(), chunk.len()) {
                    send_shutdown(writer, "snapshot row limit exceeded").await?;
                    return Err(SessionError::SnapshotTooLarge);
                }
                let chunk_bytes = serde_json::to_vec(&chunk).map_err(FrameError::Json)?.len();
                if !snapshot_bytes_fit(*bytes, chunk_bytes) {
                    send_shutdown(writer, "snapshot byte limit exceeded").await?;
                    return Err(SessionError::SnapshotTooLarge);
                }
                let mut chunk_ids = HashSet::with_capacity(chunk.len());
                if chunk.iter().any(|row| {
                    registration_ids.contains(&row.registration_id)
                        || !chunk_ids.insert(row.registration_id)
                }) {
                    send_resync(writer, *base_generation).await?;
                    *phase = Phase::awaiting_snapshot();
                    return Ok(());
                }
                registration_ids.extend(chunk_ids);
                *bytes += chunk_bytes;
                for row in chunk {
                    match verify_tunnel_row(admission_lease_verifier, proxy_id, &row) {
                        Ok(()) => rows.push(row),
                        Err(reason) => {
                            log_refused_row(proxy_id, &row, &reason);
                            refused.push(row.registration_id);
                        }
                    }
                }
            }
            ClientFrame::BrowserSessionSnapshotChunk { rows: chunk } => {
                controller
                    .record_activity(proxy_id.clone(), incarnation)
                    .await?;
                if !bounded_add(
                    browser_sessions.len(),
                    chunk.len(),
                    MAX_BROWSER_SESSION_SNAPSHOT_ROWS,
                ) {
                    send_shutdown(writer, "browser-session snapshot row limit exceeded").await?;
                    return Err(SessionError::SnapshotTooLarge);
                }
                let chunk_bytes = serde_json::to_vec(&chunk).map_err(FrameError::Json)?.len();
                if !bounded_add(
                    *browser_session_bytes,
                    chunk_bytes,
                    MAX_BROWSER_SESSION_SNAPSHOT_BYTES,
                ) {
                    send_shutdown(writer, "browser-session snapshot byte limit exceeded").await?;
                    return Err(SessionError::SnapshotTooLarge);
                }
                let mut chunk_ids = HashSet::with_capacity(chunk.len());
                if chunk.iter().any(|row| {
                    browser_session_ids.contains(&row.admin_session_id)
                        || !chunk_ids.insert(row.admin_session_id)
                }) {
                    send_resync(writer, *base_generation).await?;
                    *phase = Phase::awaiting_snapshot();
                    return Ok(());
                }
                browser_session_ids.extend(chunk_ids);
                *browser_session_bytes += chunk_bytes;
                browser_sessions.extend(chunk);
            }
            ClientFrame::SnapshotEnd {
                base_generation: end_generation,
            } if end_generation == *base_generation => {
                let base_generation = *base_generation;
                let rows = std::mem::take(rows);
                let refused = std::mem::take(refused);
                let browser_sessions = std::mem::take(browser_sessions);
                *phase = Phase::Active;
                controller
                    .accept_snapshot(
                        proxy_id.clone(),
                        incarnation,
                        base_generation,
                        rows,
                        refused,
                        browser_sessions,
                    )
                    .await?;
            }
            ClientFrame::ClientHello { .. } => {
                return illegal_frame(writer, "duplicate ClientHello").await;
            }
            _ => {
                let expected_generation = *base_generation;
                send_resync(writer, expected_generation).await?;
                *phase = Phase::awaiting_snapshot();
            }
        },
        Phase::Active => match frame {
            ClientFrame::TunnelUp { generation, row } => {
                let status = match verify_tunnel_row(admission_lease_verifier, proxy_id, &row) {
                    Ok(()) => {
                        controller
                            .tunnel_up(proxy_id.clone(), incarnation, generation, row)
                            .await?
                    }
                    Err(reason) => {
                        log_refused_row(proxy_id, &row, &reason);
                        controller
                            .refuse_tunnel_up(
                                proxy_id.clone(),
                                incarnation,
                                generation,
                                row.registration_id,
                            )
                            .await?
                    }
                };
                if status == MutationStatus::Resyncing {
                    *phase = Phase::awaiting_snapshot();
                }
            }
            ClientFrame::BrowserSessionUp { generation, row } => {
                let status = controller
                    .browser_session_up(proxy_id.clone(), incarnation, generation, row)
                    .await?;
                if status == MutationStatus::Resyncing {
                    *phase = Phase::awaiting_snapshot();
                }
            }
            ClientFrame::BrowserSessionDown {
                generation,
                admin_session_id,
            } => {
                let status = controller
                    .browser_session_down(
                        proxy_id.clone(),
                        incarnation,
                        generation,
                        admin_session_id,
                    )
                    .await?;
                if status == MutationStatus::Resyncing {
                    *phase = Phase::awaiting_snapshot();
                }
            }
            ClientFrame::TunnelDown {
                generation,
                registration_id,
            } => {
                let status = controller
                    .tunnel_down(proxy_id.clone(), incarnation, generation, registration_id)
                    .await?;
                if status == MutationStatus::Resyncing {
                    *phase = Phase::awaiting_snapshot();
                }
            }
            ClientFrame::AdmissionRequest {
                request_id,
                registration_id,
                owner_user_id,
                user,
                devserver_id,
                admission_lease,
            } => {
                let verified = verify_lease(
                    admission_lease_verifier,
                    &admission_lease,
                    AdmissionLeaseBinding {
                        owner_user_id,
                        user: user.clone(),
                        devserver_id: devserver_id.clone(),
                        registration_id,
                        proxy_id: proxy_id.clone(),
                    },
                );
                let claims = match verified {
                    Ok(claims) => claims,
                    Err(reason) => {
                        // `Stale` rather than `ControlWarming`, which would
                        // say the controller is not ready: what is not
                        // current is this request's authority. The proxy
                        // refuses the one client the same way for both.
                        tracing::warn!(
                            proxy_id = proxy_id.as_str(),
                            %request_id,
                            %registration_id,
                            %reason,
                            "refusing an admission request whose lease the controller cannot verify"
                        );
                        controller
                            .record_activity(proxy_id.clone(), incarnation)
                            .await?;
                        write_control(
                            writer,
                            &ServerFrame::AdmissionDecision {
                                request_id,
                                registration_id,
                                decision: devserver_control_proto::AdmissionDecision::Stale,
                            },
                        )
                        .await?;
                        return Ok(());
                    }
                };
                controller
                    .request_admission_authorized(
                        proxy_id.clone(),
                        incarnation,
                        request_id,
                        registration_id,
                        owner_user_id,
                        user,
                        devserver_id,
                        claims.max_connected_devservers,
                        admission_lease,
                        chrono::DateTime::from_timestamp(claims.expires_at, 0).ok_or_else(
                            || SessionError::Protocol("lease expiry is out of range".into()),
                        )?,
                    )
                    .await?;
            }
            ClientFrame::LeaseRefresh {
                registration_id,
                admission_lease,
            } => {
                let verified = admission_lease_verifier
                    .verify(&admission_lease, chrono::Utc::now())
                    .map_err(|error| format!("invalid admission lease: {error}"))
                    .and_then(|claims| {
                        if claims.binding.proxy_id != *proxy_id
                            || claims.binding.registration_id != registration_id
                        {
                            Err("admission lease binding mismatch".to_string())
                        } else {
                            Ok(claims)
                        }
                    });
                let claims = match verified {
                    Ok(claims) => claims,
                    Err(reason) => {
                        tracing::warn!(
                            proxy_id = proxy_id.as_str(),
                            %registration_id,
                            %reason,
                            "killing a registration whose lease refresh the controller cannot verify"
                        );
                        controller
                            .refuse_lease_refresh(proxy_id.clone(), incarnation, registration_id)
                            .await?;
                        return Ok(());
                    }
                };
                controller
                    .refresh_lease(
                        proxy_id.clone(),
                        incarnation,
                        registration_id,
                        claims.binding.owner_user_id,
                        claims.binding.user,
                        claims.binding.devserver_id,
                        claims.max_connected_devservers,
                        admission_lease,
                        chrono::DateTime::from_timestamp(claims.expires_at, 0).ok_or_else(
                            || SessionError::Protocol("lease expiry is out of range".into()),
                        )?,
                    )
                    .await?;
            }
            ClientFrame::AdmissionCancel {
                request_id,
                registration_id,
            } => {
                controller
                    .cancel_admission(proxy_id.clone(), incarnation, request_id, registration_id)
                    .await?;
            }
            ClientFrame::CommandResult {
                command_id,
                killed,
                missing,
                failed,
            } => {
                controller
                    .command_result(
                        proxy_id.clone(),
                        incarnation,
                        command_id,
                        killed,
                        missing,
                        failed,
                    )
                    .await?;
            }
            ClientFrame::SessionRevocationResult {
                command_id,
                revoked,
            } => {
                controller
                    .session_revocation_result(proxy_id.clone(), incarnation, command_id, revoked)
                    .await?;
            }
            ClientFrame::Pong { nonce } => {
                controller
                    .pong(proxy_id.clone(), incarnation, nonce)
                    .await?;
            }
            ClientFrame::SnapshotStart { .. }
            | ClientFrame::SnapshotChunk { .. }
            | ClientFrame::BrowserSessionSnapshotChunk { .. }
            | ClientFrame::SnapshotEnd { .. } => {
                controller
                    .require_resync(proxy_id.clone(), incarnation)
                    .await?;
                *phase = Phase::awaiting_snapshot();
            }
            ClientFrame::ClientHello { .. } => {
                return illegal_frame(writer, "duplicate ClientHello").await;
            }
        },
    }
    Ok(())
}

/// Whether a frame streams initial-snapshot rows and so does not spend
/// the per-frame rate budget.
///
/// Chunks carry at most `MAX_SNAPSHOT_CHUNK_ROWS` rows each, and a
/// proxy may hold 2,048 tunnel rows (16 chunks) plus
/// `MAX_BROWSER_SESSION_SNAPSHOT_ROWS` browser-session rows (782
/// chunks). The proxy writes `SnapshotStart`, every chunk, and
/// `SnapshotEnd` in one tight loop with no pacing, so at
/// `MAX_CLIENT_FRAMES_PER_WINDOW` frames per window any snapshot past
/// roughly 31 chunks tripped the limiter and the proxy could never
/// join. The rows themselves stay bounded by `snapshot_rows_fit`, the
/// browser-session row and byte caps, and the absolute snapshot
/// deadline, so the exemption removes no real bound.
///
/// A chunk with no rows consumes none of those bounds, so it is not
/// exempt. A real proxy never sends one -- it chunks a slice, which
/// never yields an empty piece -- and an empty chunk is the cheapest
/// shape a flood could take.
fn snapshot_chunk_is_exempt(phase: &Phase, frame: &ClientFrame) -> bool {
    if !matches!(phase, Phase::Snapshot { .. }) {
        return false;
    }
    match frame {
        ClientFrame::SnapshotChunk { rows } => !rows.is_empty(),
        ClientFrame::BrowserSessionSnapshotChunk { rows } => !rows.is_empty(),
        _ => false,
    }
}

fn snapshot_rows_fit(current: usize, incoming: usize) -> bool {
    current
        .checked_add(incoming)
        .is_some_and(|total| total <= MAX_SNAPSHOT_ROWS)
}

fn snapshot_bytes_fit(current: usize, incoming: usize) -> bool {
    bounded_add(current, incoming, MAX_SNAPSHOT_BYTES)
}

fn bounded_add(current: usize, incoming: usize, maximum: usize) -> bool {
    current
        .checked_add(incoming)
        .is_some_and(|total| total <= maximum)
}

/// Verify one lease against the binding its frame claims. The error says
/// why that one tunnel's authority is refused and is never a reason to end
/// the session: the frame is well formed, and a reconnect would meet the
/// same lease again.
fn verify_lease(
    verifier: &AdmissionLeaseVerifier,
    lease: &AdmissionLease,
    expected: AdmissionLeaseBinding,
) -> Result<devserver_control_proto::AdmissionLeaseClaims, String> {
    let claims = verifier
        .verify(lease, chrono::Utc::now())
        .map_err(|error| format!("invalid admission lease: {error}"))?;
    if claims.binding != expected {
        return Err("admission lease binding mismatch".into());
    }
    Ok(claims)
}

fn verify_tunnel_row(
    verifier: &AdmissionLeaseVerifier,
    proxy_id: &ProxyId,
    row: &TunnelRow,
) -> Result<(), String> {
    let claims = verify_lease(
        verifier,
        &row.admission_lease,
        row.binding_for(proxy_id.clone()),
    )?;
    if row.admission_lease_expires_at.timestamp() != claims.expires_at {
        return Err("admission lease expiry mismatch".into());
    }
    if row.max_connected_devservers != claims.max_connected_devservers {
        return Err("admission lease devserver limit mismatch".into());
    }
    Ok(())
}

fn log_refused_row(proxy_id: &ProxyId, row: &TunnelRow, reason: &str) {
    tracing::warn!(
        proxy_id = proxy_id.as_str(),
        registration_id = %row.registration_id,
        user = %row.user,
        reason,
        "refusing a tunnel row whose admission lease the controller cannot verify"
    );
}

async fn illegal_frame<W>(writer: &mut W, reason: &'static str) -> Result<(), SessionError>
where
    W: AsyncWrite + Unpin,
{
    send_shutdown(writer, reason).await?;
    Err(SessionError::Protocol(reason.into()))
}

/// Every caller returns once this does, so a shutdown the proxy never
/// reads still ends the session, as a `Timeout` instead of the reason.
async fn send_shutdown<W>(writer: &mut W, reason: &'static str) -> Result<(), SessionError>
where
    W: AsyncWrite + Unpin,
{
    write_final(
        writer,
        &ServerFrame::Shutdown {
            reason: reason.into(),
            retryable: true,
        },
    )
    .await
}

async fn send_resync<W>(writer: &mut W, expected_generation: u64) -> Result<(), SessionError>
where
    W: AsyncWrite + Unpin,
{
    write_control(
        writer,
        &ServerFrame::ResyncRequired {
            expected_generation,
        },
    )
    .await
}

async fn write_control<W>(writer: &mut W, frame: &ServerFrame) -> Result<(), SessionError>
where
    W: AsyncWrite + Unpin,
{
    bounded_write(write_frame(writer, frame)).await
}

/// Write the session's last frame and half-close, under one bound.
async fn write_final<W>(writer: &mut W, frame: &ServerFrame) -> Result<(), SessionError>
where
    W: AsyncWrite + Unpin,
{
    bounded_write(async {
        write_frame(writer, frame).await?;
        writer.shutdown().await.map_err(FrameError::Io)
    })
    .await
}

async fn bounded_write(
    write: impl Future<Output = Result<(), FrameError>>,
) -> Result<(), SessionError> {
    tokio::time::timeout(CONTROL_WRITE_TIMEOUT, write)
        .await
        .map_err(|_| SessionError::Timeout("proxy control write"))?
        .map_err(SessionError::from)
}

async fn wait_deadline(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

enum Phase {
    AwaitSnapshot {
        deadline: Instant,
    },
    Snapshot {
        deadline: Instant,
        base_generation: u64,
        rows: Vec<TunnelRow>,
        /// Registration ids of rows whose leases did not verify. They are
        /// left out of `rows` but still counted in `registration_ids`, so a
        /// repeat is still a duplicate.
        refused: Vec<Uuid>,
        registration_ids: HashSet<Uuid>,
        bytes: usize,
        browser_sessions: Vec<BrowserSessionRow>,
        browser_session_ids: HashSet<Uuid>,
        browser_session_bytes: usize,
    },
    Active,
}

impl Phase {
    fn awaiting_snapshot() -> Self {
        Self::AwaitSnapshot {
            deadline: Instant::now() + SNAPSHOT_TIMEOUT,
        }
    }

    fn deadline(&self) -> Option<Instant> {
        match self {
            Self::AwaitSnapshot { deadline } | Self::Snapshot { deadline, .. } => Some(*deadline),
            Self::Active => None,
        }
    }
}

#[derive(Debug, thiserror::Error)]
enum SessionError {
    #[error("control session timed out during {0}")]
    Timeout(&'static str),
    #[error("control protocol error: {0}")]
    Protocol(String),
    #[error("control snapshot exceeds the row limit")]
    SnapshotTooLarge,
    #[error(transparent)]
    Frame(#[from] FrameError),
    #[error(transparent)]
    H2(#[from] h2::Error),
    #[error(transparent)]
    Actor(#[from] ActorError),
}

#[cfg(test)]
mod tests {
    use super::*;
    use devserver_control_proto::{
        AdmissionDecision, AdmissionLeaseSigner, TunnelRow, MAX_SNAPSHOT_CHUNK_ROWS,
    };
    use uuid::Uuid;

    const TEST_PROXY_TOKEN: &str = "0123456789abcdef0123456789abcdef";
    const TEST_SIGNING_KEY: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    /// A key outside the controller's verifying ring, as after a rotation
    /// that reached identity or a proxy but not the controller.
    const FOREIGN_SIGNING_KEY: &str = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";

    fn admission_keys() -> (AdmissionLeaseSigner, AdmissionLeaseVerifier) {
        let signer = AdmissionLeaseSigner::from_base64(TEST_SIGNING_KEY).unwrap();
        let verifier = AdmissionLeaseVerifier::from_base64(&signer.verifying_key_base64()).unwrap();
        (signer, verifier)
    }

    fn binding(
        owner_user_id: Uuid,
        user: &str,
        devserver_id: &str,
        registration_id: Uuid,
    ) -> AdmissionLeaseBinding {
        AdmissionLeaseBinding {
            owner_user_id,
            user: user.into(),
            devserver_id: devserver_id.into(),
            registration_id,
            proxy_id: ProxyId::parse("p1").unwrap(),
        }
    }

    fn lease_signed_with(signing_key: &str, binding: AdmissionLeaseBinding) -> AdmissionLease {
        AdmissionLeaseSigner::from_base64(signing_key)
            .unwrap()
            .sign(binding, 3, chrono::Utc::now(), 120)
            .unwrap()
    }

    fn signed_row(user: &str, devserver_id: &str, registration_id: Uuid) -> TunnelRow {
        row_signed_with(TEST_SIGNING_KEY, user, devserver_id, registration_id)
    }

    fn row_signed_with(
        signing_key: &str,
        user: &str,
        devserver_id: &str,
        registration_id: Uuid,
    ) -> TunnelRow {
        let owner_user_id = Uuid::new_v4();
        let signer = AdmissionLeaseSigner::from_base64(signing_key).unwrap();
        let now = chrono::Utc::now();
        let admission_lease = signer
            .sign(
                binding(owner_user_id, user, devserver_id, registration_id),
                3,
                now,
                120,
            )
            .unwrap();
        TunnelRow {
            registration_id,
            owner_user_id,
            user: user.into(),
            devserver_id: devserver_id.into(),
            max_connected_devservers: 3,
            admission_lease,
            admission_lease_expires_at: chrono::DateTime::from_timestamp(now.timestamp() + 120, 0)
                .unwrap(),
            peer_addr: None,
            connected_at: now,
        }
    }

    struct Opened {
        status: StatusCode,
        stream: Option<H2Duplex>,
        server: tokio::task::JoinHandle<Result<(), SessionError>>,
        driver: tokio::task::JoinHandle<Result<(), h2::Error>>,
    }

    impl Drop for Opened {
        fn drop(&mut self) {
            self.server.abort();
            self.driver.abort();
        }
    }

    async fn open(
        controller: ControllerHandle,
        method: Method,
        path: &str,
        token: Option<&str>,
        content_type: Option<&str>,
    ) -> Opened {
        let (client_io, server_io) = tokio::io::duplex(64 * 1024);
        let (_, verifier) = admission_keys();
        let server = tokio::spawn(handle_connection(
            server_io,
            controller,
            Arc::new(ProxyCredentials::parse(&format!("p1={TEST_PROXY_TOKEN}")).unwrap()),
            verifier,
            ProxyOriginTemplate::parse("https://{proxy_id}.proxy.example.test").unwrap(),
        ));
        let (mut client, connection) = h2::client::handshake(client_io).await.unwrap();
        let driver = tokio::spawn(connection);
        let mut request = Request::builder().method(method).uri(path);
        if let Some(token) = token {
            request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        request = request.header(PROXY_ID_HEADER, "p1");
        if let Some(content_type) = content_type {
            request = request.header(header::CONTENT_TYPE, content_type);
        }
        let (response, send) = client
            .send_request(request.body(()).unwrap(), false)
            .unwrap();
        let response = response.await.unwrap();
        let status = response.status();
        let stream = (status == StatusCode::OK).then(|| H2Duplex::new(send, response.into_body()));
        Opened {
            status,
            stream,
            server,
            driver,
        }
    }

    async fn connected(controller: ControllerHandle) -> Opened {
        open(
            controller,
            Method::POST,
            CONNECT_PATH,
            Some(TEST_PROXY_TOKEN),
            Some(CONTENT_TYPE),
        )
        .await
    }

    async fn connected_as(
        controller: ControllerHandle,
        proxy_id: &str,
        token: &str,
        credentials: &str,
    ) -> Opened {
        let (client_io, server_io) = tokio::io::duplex(64 * 1024);
        let (_, verifier) = admission_keys();
        let server = tokio::spawn(handle_connection(
            server_io,
            controller,
            Arc::new(ProxyCredentials::parse(credentials).unwrap()),
            verifier,
            ProxyOriginTemplate::parse("https://{proxy_id}.proxy.example.test").unwrap(),
        ));
        let (mut client, connection) = h2::client::handshake(client_io).await.unwrap();
        let driver = tokio::spawn(connection);
        let request = Request::builder()
            .method(Method::POST)
            .uri(CONNECT_PATH)
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .header(PROXY_ID_HEADER, proxy_id)
            .header(header::CONTENT_TYPE, CONTENT_TYPE)
            .body(())
            .unwrap();
        let (response, send) = client.send_request(request, false).unwrap();
        let response = response.await.unwrap();
        let status = response.status();
        let stream = (status == StatusCode::OK).then(|| H2Duplex::new(send, response.into_body()));
        Opened {
            status,
            stream,
            server,
            driver,
        }
    }

    fn hello(protocol_version: u16, package_version: &str, origin: &str) -> ClientFrame {
        hello_as("p1", protocol_version, package_version, origin)
    }

    fn hello_as(
        proxy_id: &str,
        protocol_version: u16,
        package_version: &str,
        origin: &str,
    ) -> ClientFrame {
        ClientFrame::ClientHello {
            protocol_version,
            package_version: package_version.into(),
            proxy_id: ProxyId::parse(proxy_id).unwrap(),
            proxy_base_url: CanonicalOrigin::parse(origin).unwrap(),
            boot_id: Uuid::new_v4(),
        }
    }

    async fn handshake(stream: &mut H2Duplex) {
        handshake_as(stream, "p1").await;
    }

    async fn handshake_as(stream: &mut H2Duplex, proxy_id: &str) {
        write_frame(
            stream,
            &hello_as(
                proxy_id,
                PROTOCOL_VERSION,
                env!("CARGO_PKG_VERSION"),
                &format!("https://{proxy_id}.proxy.example.test"),
            ),
        )
        .await
        .unwrap();
        assert!(matches!(
            read_frame::<_, ServerFrame>(stream).await.unwrap(),
            ServerFrame::ServerHello {
                protocol_version: PROTOCOL_VERSION,
                heartbeat_seconds: 5,
                dead_seconds: 15,
                grace_seconds: 30,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn http_connect_rejects_method_path_auth_and_content_type() {
        let cases = [
            (
                Method::GET,
                CONNECT_PATH,
                Some(TEST_PROXY_TOKEN),
                Some(CONTENT_TYPE),
                StatusCode::METHOD_NOT_ALLOWED,
            ),
            (
                Method::POST,
                "/wrong",
                Some("secret"),
                Some(CONTENT_TYPE),
                StatusCode::NOT_FOUND,
            ),
            (
                Method::POST,
                CONNECT_PATH,
                Some("wrong"),
                Some(CONTENT_TYPE),
                StatusCode::UNAUTHORIZED,
            ),
            (
                Method::POST,
                CONNECT_PATH,
                None,
                Some(CONTENT_TYPE),
                StatusCode::UNAUTHORIZED,
            ),
            (
                Method::POST,
                CONNECT_PATH,
                Some(TEST_PROXY_TOKEN),
                Some("application/json"),
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
            ),
        ];
        for (method, path, token, content_type, expected) in cases {
            let opened = open(
                crate::spawn_controller(100),
                method,
                path,
                token,
                content_type,
            )
            .await;
            assert_eq!(opened.status, expected);
        }
    }

    #[tokio::test]
    async fn hello_rejects_control_package_and_origin_mismatches() {
        let cases = [
            hello(
                PROTOCOL_VERSION + 1,
                env!("CARGO_PKG_VERSION"),
                "https://p1.proxy.example.test",
            ),
            hello(PROTOCOL_VERSION, "0.0.0", "https://p1.proxy.example.test"),
            hello(
                PROTOCOL_VERSION,
                env!("CARGO_PKG_VERSION"),
                "https://other.proxy.example.test",
            ),
        ];
        for hello in cases {
            let mut opened = connected(crate::spawn_controller(100)).await;
            let stream = opened.stream.as_mut().unwrap();
            write_frame(stream, &hello).await.unwrap();
            assert!(matches!(
                read_frame::<_, ServerFrame>(stream).await.unwrap(),
                ServerFrame::Shutdown { .. }
            ));
        }
    }

    #[tokio::test]
    async fn snapshot_then_generation_gap_resyncs_on_the_same_stream() {
        let controller = crate::spawn_controller(100);
        let mut opened = connected(controller).await;
        let stream = opened.stream.as_mut().unwrap();
        handshake(stream).await;
        write_frame(stream, &ClientFrame::SnapshotStart { base_generation: 0 })
            .await
            .unwrap();
        write_frame(stream, &ClientFrame::SnapshotChunk { rows: Vec::new() })
            .await
            .unwrap();
        write_frame(stream, &ClientFrame::SnapshotEnd { base_generation: 0 })
            .await
            .unwrap();
        assert!(matches!(
            read_frame::<_, ServerFrame>(stream).await.unwrap(),
            ServerFrame::SnapshotAccepted { base_generation: 0 }
        ));

        write_frame(
            stream,
            &ClientFrame::TunnelUp {
                generation: 2,
                row: signed_row("alice", "one", Uuid::new_v4()),
            },
        )
        .await
        .unwrap();
        assert!(matches!(
            read_frame::<_, ServerFrame>(stream).await.unwrap(),
            ServerFrame::ResyncRequired {
                expected_generation: 1
            }
        ));

        write_frame(stream, &ClientFrame::SnapshotStart { base_generation: 0 })
            .await
            .unwrap();
        write_frame(stream, &ClientFrame::SnapshotEnd { base_generation: 0 })
            .await
            .unwrap();
        assert!(matches!(
            read_frame::<_, ServerFrame>(stream).await.unwrap(),
            ServerFrame::SnapshotAccepted { base_generation: 0 }
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn split_client_frame_survives_an_interleaved_server_command() {
        let mut opened = connected(crate::spawn_controller(100)).await;
        let stream = opened.stream.as_mut().unwrap();
        handshake(stream).await;
        write_frame(stream, &ClientFrame::SnapshotStart { base_generation: 0 })
            .await
            .unwrap();

        let chunk = ClientFrame::SnapshotChunk {
            rows: vec![signed_row(
                &"alice".repeat(8),
                &"one".repeat(16),
                Uuid::new_v4(),
            )],
        };
        let payload = serde_json::to_vec(&chunk).unwrap();
        let split = payload.len() / 2;
        stream
            .write_all(&(payload.len() as u32).to_be_bytes())
            .await
            .unwrap();
        stream.write_all(&payload[..split]).await.unwrap();
        tokio::task::yield_now().await;

        tokio::time::advance(crate::HEARTBEAT_INTERVAL).await;
        let ping = read_frame::<_, ServerFrame>(stream).await.unwrap();
        assert!(matches!(ping, ServerFrame::Ping { .. }));

        stream.write_all(&payload[split..]).await.unwrap();
        write_frame(stream, &ClientFrame::SnapshotEnd { base_generation: 0 })
            .await
            .unwrap();
        let mut accepted = false;
        for _ in 0..4 {
            match read_frame::<_, ServerFrame>(stream).await.unwrap() {
                ServerFrame::SnapshotAccepted { base_generation: 0 } => {
                    accepted = true;
                    break;
                }
                ServerFrame::Ping { nonce } => {
                    write_frame(stream, &ClientFrame::Pong { nonce })
                        .await
                        .unwrap();
                }
                frame => panic!("unexpected server frame: {frame:?}"),
            }
        }
        assert!(accepted, "split snapshot chunk was not accepted");
    }

    #[tokio::test]
    async fn out_of_order_snapshot_frame_resyncs_and_duplicate_hello_closes() {
        let mut opened = connected(crate::spawn_controller(100)).await;
        let stream = opened.stream.as_mut().unwrap();
        handshake(stream).await;
        let admission_row = signed_row("alice", "one", Uuid::new_v4());
        write_frame(
            stream,
            &ClientFrame::AdmissionRequest {
                request_id: Uuid::new_v4(),
                registration_id: admission_row.registration_id,
                owner_user_id: admission_row.owner_user_id,
                user: "alice".into(),
                devserver_id: "one".into(),
                admission_lease: admission_row.admission_lease,
            },
        )
        .await
        .unwrap();
        assert!(matches!(
            read_frame::<_, ServerFrame>(stream).await.unwrap(),
            ServerFrame::ResyncRequired {
                expected_generation: 0
            }
        ));
        let duplicate = signed_row("alice", "one", Uuid::new_v4());
        write_frame(stream, &ClientFrame::SnapshotStart { base_generation: 0 })
            .await
            .unwrap();
        write_frame(
            stream,
            &ClientFrame::SnapshotChunk {
                rows: vec![duplicate.clone(), duplicate],
            },
        )
        .await
        .unwrap();
        assert!(matches!(
            read_frame::<_, ServerFrame>(stream).await.unwrap(),
            ServerFrame::ResyncRequired {
                expected_generation: 0
            }
        ));
        write_frame(
            stream,
            &hello(
                PROTOCOL_VERSION,
                env!("CARGO_PKG_VERSION"),
                "https://p1.proxy.example.test",
            ),
        )
        .await
        .unwrap();
        assert!(matches!(
            read_frame::<_, ServerFrame>(stream).await.unwrap(),
            ServerFrame::Shutdown { .. }
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn snapshot_deadline_is_absolute_while_pongs_keep_the_session_alive() {
        let mut opened = connected(crate::spawn_controller(100)).await;
        let stream = opened.stream.as_mut().unwrap();
        handshake(stream).await;
        for _ in 0..5 {
            tokio::time::advance(crate::HEARTBEAT_INTERVAL).await;
            let nonce = loop {
                if let ServerFrame::Ping { nonce } =
                    read_frame::<_, ServerFrame>(stream).await.unwrap()
                {
                    break nonce;
                }
            };
            write_frame(stream, &ClientFrame::Pong { nonce })
                .await
                .unwrap();
        }
        tokio::time::advance(crate::HEARTBEAT_INTERVAL).await;
        let mut shutdown = false;
        for _ in 0..8 {
            let frame = read_frame::<_, ServerFrame>(stream).await.unwrap();
            if matches!(frame, ServerFrame::Shutdown { .. }) {
                shutdown = true;
                break;
            }
        }
        assert!(
            shutdown,
            "snapshot timeout did not close within eight frames"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn flooded_control_session_is_closed_while_peer_and_ticker_stay_responsive() {
        const P2_TOKEN: &str = "fedcba9876543210fedcba9876543210";
        let controller = crate::spawn_controller(100);
        let credentials = format!("p1={TEST_PROXY_TOKEN};p2={P2_TOKEN}");
        let mut flooded =
            connected_as(controller.clone(), "p1", TEST_PROXY_TOKEN, &credentials).await;
        let mut peer = connected_as(controller, "p2", P2_TOKEN, &credentials).await;
        let flooded_stream = flooded.stream.as_mut().unwrap();
        let peer_stream = peer.stream.as_mut().unwrap();
        handshake_as(flooded_stream, "p1").await;
        handshake_as(peer_stream, "p2").await;

        write_frame(
            peer_stream,
            &ClientFrame::SnapshotStart { base_generation: 0 },
        )
        .await
        .unwrap();
        write_frame(
            peer_stream,
            &ClientFrame::SnapshotEnd { base_generation: 0 },
        )
        .await
        .unwrap();
        assert!(matches!(
            read_frame::<_, ServerFrame>(peer_stream).await.unwrap(),
            ServerFrame::SnapshotAccepted { base_generation: 0 }
        ));

        write_frame(
            flooded_stream,
            &ClientFrame::SnapshotStart { base_generation: 0 },
        )
        .await
        .unwrap();
        for _ in 0..MAX_CLIENT_FRAMES_PER_WINDOW {
            write_frame(
                flooded_stream,
                &ClientFrame::SnapshotChunk { rows: Vec::new() },
            )
            .await
            .unwrap();
        }
        let shutdown = read_frame::<_, ServerFrame>(flooded_stream).await.unwrap();
        assert!(
            matches!(shutdown, ServerFrame::Shutdown { reason, .. } if reason.contains("rate limit"))
        );

        tokio::time::advance(crate::HEARTBEAT_INTERVAL).await;
        let ping = read_frame::<_, ServerFrame>(peer_stream).await.unwrap();
        let ServerFrame::Ping { nonce } = ping else {
            panic!("responsive peer did not receive ticker ping: {ping:?}");
        };
        write_frame(peer_stream, &ClientFrame::Pong { nonce })
            .await
            .unwrap();
    }

    /// A proxy carrying a near-cap browser-session registry writes 781 full
    /// snapshot chunks back to back with no pacing. Row-carrying snapshot
    /// chunks skip the 32-frames-per-second client limiter while the session
    /// streams its snapshot, so the burst must end in `SnapshotAccepted`
    /// rather than a rate-limit shutdown.
    #[tokio::test]
    async fn a_full_browser_session_snapshot_joins_instead_of_being_rate_limited() {
        const CHUNKS: usize = MAX_BROWSER_SESSION_SNAPSHOT_ROWS / MAX_SNAPSHOT_CHUNK_ROWS;
        let mut opened = connected(crate::spawn_controller(100)).await;
        let stream = opened.stream.as_mut().unwrap();
        handshake(stream).await;
        write_frame(stream, &ClientFrame::SnapshotStart { base_generation: 0 })
            .await
            .unwrap();
        let created_at = chrono::Utc::now();
        let expires_at = created_at + chrono::Duration::seconds(300);
        for chunk in 0..CHUNKS {
            let rows = (0..MAX_SNAPSHOT_CHUNK_ROWS)
                .map(|_| BrowserSessionRow {
                    admin_session_id: Uuid::new_v4(),
                    subject_user_id: Uuid::new_v4(),
                    owner_user_id: Uuid::new_v4(),
                    devserver_id: "d".into(),
                    created_at,
                    expires_at,
                })
                .collect();
            if let Err(error) =
                write_frame(stream, &ClientFrame::BrowserSessionSnapshotChunk { rows }).await
            {
                panic!("controller closed the session at chunk {chunk}: {error}");
            }
        }
        write_frame(stream, &ClientFrame::SnapshotEnd { base_generation: 0 })
            .await
            .unwrap();
        // Streaming this many chunks outlasts a heartbeat interval, so
        // answer any ping that lands before the acceptance.
        loop {
            match read_frame::<_, ServerFrame>(stream).await.unwrap() {
                ServerFrame::SnapshotAccepted { base_generation: 0 } => break,
                ServerFrame::Ping { nonce } => {
                    write_frame(stream, &ClientFrame::Pong { nonce })
                        .await
                        .unwrap();
                }
                frame => panic!("a {CHUNKS}-chunk snapshot was not accepted: {frame:?}"),
            }
        }
    }

    /// The exemption is narrow on purpose: only a row-carrying
    /// snapshot chunk, and only while the session is streaming its
    /// snapshot.
    #[test]
    fn only_row_carrying_snapshot_chunks_skip_the_rate_limiter() {
        let streaming = Phase::Snapshot {
            deadline: Instant::now() + SNAPSHOT_TIMEOUT,
            base_generation: 0,
            rows: Vec::new(),
            refused: Vec::new(),
            registration_ids: HashSet::new(),
            bytes: 0,
            browser_sessions: Vec::new(),
            browser_session_ids: HashSet::new(),
            browser_session_bytes: 0,
        };
        let created_at = chrono::Utc::now();
        let browser_chunk = ClientFrame::BrowserSessionSnapshotChunk {
            rows: vec![BrowserSessionRow {
                admin_session_id: Uuid::new_v4(),
                subject_user_id: Uuid::new_v4(),
                owner_user_id: Uuid::new_v4(),
                devserver_id: "d".into(),
                created_at,
                expires_at: created_at + chrono::Duration::seconds(300),
            }],
        };
        let tunnel_chunk = ClientFrame::SnapshotChunk {
            rows: vec![signed_row("alice", "one", Uuid::new_v4())],
        };
        assert!(snapshot_chunk_is_exempt(&streaming, &browser_chunk));
        assert!(snapshot_chunk_is_exempt(&streaming, &tunnel_chunk));

        assert!(!snapshot_chunk_is_exempt(&Phase::Active, &browser_chunk));
        assert!(!snapshot_chunk_is_exempt(&Phase::Active, &tunnel_chunk));
        assert!(!snapshot_chunk_is_exempt(
            &Phase::awaiting_snapshot(),
            &tunnel_chunk
        ));
        assert!(!snapshot_chunk_is_exempt(
            &streaming,
            &ClientFrame::SnapshotChunk { rows: Vec::new() }
        ));
        assert!(!snapshot_chunk_is_exempt(
            &streaming,
            &ClientFrame::BrowserSessionSnapshotChunk { rows: Vec::new() }
        ));
        assert!(!snapshot_chunk_is_exempt(
            &streaming,
            &ClientFrame::SnapshotEnd { base_generation: 0 }
        ));
    }

    #[test]
    fn client_frame_rate_limit_releases_capacity_after_the_window() {
        let now = Instant::now();
        let mut limit = ClientFrameRateLimiter::default();
        for _ in 0..MAX_CLIENT_FRAMES_PER_WINDOW {
            assert!(limit.accept(now));
        }
        assert!(!limit.accept(now));
        assert!(limit.accept(now + CLIENT_FRAME_RATE_WINDOW));
    }

    #[test]
    fn cumulative_snapshot_limit_is_checked_without_overflow() {
        assert!(snapshot_rows_fit(MAX_SNAPSHOT_ROWS - 1, 1));
        assert!(!snapshot_rows_fit(MAX_SNAPSHOT_ROWS, 1));
        assert!(!snapshot_rows_fit(usize::MAX, 1));
        assert!(snapshot_bytes_fit(MAX_SNAPSHOT_BYTES - 1, 1));
        assert!(!snapshot_bytes_fit(MAX_SNAPSHOT_BYTES, 1));
        assert!(!snapshot_bytes_fit(usize::MAX, 1));
    }

    /// Dial `addr` as a proxy that presents no credential and return the
    /// status the controller answers its connect with. A 401 proves the
    /// listener accepted the connection and a connection task served it.
    async fn unauthenticated_connect_status(addr: SocketAddr) -> io::Result<StatusCode> {
        let tcp = TcpStream::connect(addr).await?;
        let (mut client, connection) =
            h2::client::handshake(tcp).await.map_err(io::Error::other)?;
        tokio::spawn(async move {
            let _ = connection.await;
        });
        let request = Request::builder()
            .method(Method::POST)
            .uri(format!("http://{addr}{CONNECT_PATH}"))
            .header(header::CONTENT_TYPE, CONTENT_TYPE)
            .body(())
            .expect("request");
        let (response, _send) = client
            .send_request(request, true)
            .map_err(io::Error::other)?;
        Ok(response.await.map_err(io::Error::other)?.status())
    }

    type BoxedConnection =
        std::pin::Pin<Box<dyn Future<Output = Result<(), SessionError>> + Send + 'static>>;

    /// The connection handler `serve_control_listener` builds, over the
    /// test credentials, admission key and origin template.
    fn serving_handler(controller: ControllerHandle) -> impl FnMut(TcpStream) -> BoxedConnection {
        let credentials =
            Arc::new(ProxyCredentials::parse(&format!("p1={TEST_PROXY_TOKEN}")).unwrap());
        let (_, verifier) = admission_keys();
        let template = ProxyOriginTemplate::parse("https://{proxy_id}.proxy.example.test").unwrap();
        move |stream| {
            Box::pin(handle_connection(
                stream,
                controller.clone(),
                credentials.clone(),
                verifier.clone(),
                template.clone(),
            ))
        }
    }

    /// This controller is the fleet's only one, and `main` exits the
    /// process when this loop returns, so an accept failure that concerns
    /// one peer, or a moment out of descriptors, would stop admission for
    /// every proxy. Neither may end the loop, and the next proxy
    /// connection must still be served.
    #[tokio::test]
    async fn a_transient_accept_failure_does_not_end_the_control_listener() {
        let listener = Arc::new(TcpListener::bind("127.0.0.1:0").await.unwrap());
        let addr = listener.local_addr().unwrap();
        // Popped from the back: a failure for one connection, then one
        // that means the process is out of a resource.
        let injected = Arc::new(std::sync::Mutex::new(vec![
            io::Error::from(io::ErrorKind::OutOfMemory),
            io::Error::from(io::ErrorKind::ConnectionAborted),
        ]));
        let accept = {
            let injected = injected.clone();
            move || {
                let failure = injected.lock().unwrap().pop();
                let listener = listener.clone();
                async move {
                    match failure {
                        Some(error) => Err(error),
                        None => listener.accept().await,
                    }
                }
            }
        };
        let (shutdown, shutdown_rx) = watch::channel(false);
        let serving = tokio::spawn(serve_accepted(
            accept,
            serving_handler(crate::spawn_controller(100)),
            shutdown_rx,
        ));

        let status = tokio::time::timeout(
            Duration::from_secs(10),
            unauthenticated_connect_status(addr),
        )
        .await;
        if serving.is_finished() {
            panic!(
                "the accept loop ended on an injected failure: {:?}",
                serving.await.unwrap()
            );
        }
        assert!(
            injected.lock().unwrap().is_empty(),
            "the loop did not consume both injected failures",
        );
        let status = status
            .expect("the connection after the failures was never served")
            .expect("h2 exchange");
        assert_eq!(status, StatusCode::UNAUTHORIZED);

        shutdown.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(5), serving)
            .await
            .expect("the loop did not stop on shutdown")
            .unwrap()
            .unwrap();
    }

    /// A panic in one proxy's connection task ends that proxy's session
    /// and nothing else. The loop must not answer it by shutting down
    /// every other proxy's session and returning, which `main` turns into
    /// the fleet's only controller exiting. Nothing reachable in
    /// `handle_connection` panics on demand, so the first connection's
    /// handler panics before it reads a byte; the second is the real one.
    #[tokio::test]
    async fn a_panicking_connection_task_does_not_end_the_control_listener() {
        let _ = tracing_subscriber::fmt().with_test_writer().try_init();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let mut serve = serving_handler(crate::spawn_controller(100));
        let mut first = true;
        let handle = move |stream: TcpStream| -> BoxedConnection {
            if std::mem::replace(&mut first, false) {
                Box::pin(async move {
                    let _stream = stream;
                    panic!("injected connection task panic");
                })
            } else {
                serve(stream)
            }
        };
        let (shutdown, shutdown_rx) = watch::channel(false);
        let serving =
            tokio::spawn(
                async move { serve_accepted(|| listener.accept(), handle, shutdown_rx).await },
            );

        // The panicking task drops the socket as it unwinds, inside the
        // same poll that completes it, so this EOF means the loop's
        // `JoinSet` already holds the panic when the next dial arrives.
        let mut doomed = TcpStream::connect(addr).await.unwrap();
        let mut byte = [0u8; 1];
        let read = tokio::time::timeout(
            Duration::from_secs(5),
            tokio::io::AsyncReadExt::read(&mut doomed, &mut byte),
        )
        .await
        .expect("the panicking connection was never closed");
        assert!(matches!(read, Ok(0) | Err(_)), "{read:?}");

        let status = tokio::time::timeout(
            Duration::from_secs(10),
            unauthenticated_connect_status(addr),
        )
        .await;
        if serving.is_finished() {
            panic!(
                "the accept loop ended after a connection task panicked: {:?}",
                serving.await.unwrap()
            );
        }
        let status = status
            .expect("the connection after the panic was never served")
            .expect("h2 exchange");
        assert_eq!(status, StatusCode::UNAUTHORIZED);

        shutdown.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(5), serving)
            .await
            .expect("the loop did not stop on shutdown")
            .unwrap()
            .unwrap();
    }

    /// Open a controller session as a proxy with a 16-byte h2 stream
    /// window, complete the handshake, send `then` if given, and from then
    /// on read nothing. Returns once the connection task has ended, or
    /// panics with what it still holds.
    ///
    /// A proxy that stops reading (a hung process, a stopped VM, a
    /// half-dead path) never grants the stream more window, so a controller
    /// write to it stays pending. Those writes sit in `select!` arm bodies,
    /// where nothing else in the session is polled, so without a bound the
    /// connection task, and the in-flight permit it holds, outlive the
    /// session's heartbeat expiry for as long as TCP stays up.
    async fn stalled_reader_ends(scenario: &str, then: Option<ClientFrame>) {
        const STREAM_WINDOW: u32 = 16;
        let (client_io, server_io) = tokio::io::duplex(64 * 1024);
        // One slot, held by the connection exactly as the listener's loop
        // holds it: moved into the task that runs `handle_connection`.
        let permits = Arc::new(Semaphore::new(1));
        let permit = permits.clone().try_acquire_owned().unwrap();
        let controller = crate::spawn_controller(100);
        let mut proxies = controller.watch_proxies();
        let credentials =
            Arc::new(ProxyCredentials::parse(&format!("p1={TEST_PROXY_TOKEN}")).unwrap());
        let (_, verifier) = admission_keys();
        let template = ProxyOriginTemplate::parse("https://{proxy_id}.proxy.example.test").unwrap();
        let server = tokio::spawn(async move {
            let _permit = permit;
            handle_connection(server_io, controller, credentials, verifier, template).await
        });

        let (mut client, connection) = h2::client::Builder::new()
            .initial_window_size(STREAM_WINDOW)
            .handshake::<_, bytes::Bytes>(client_io)
            .await
            .unwrap();
        let driver = tokio::spawn(connection);
        let request = Request::builder()
            .method(Method::POST)
            .uri(CONNECT_PATH)
            .header(header::AUTHORIZATION, format!("Bearer {TEST_PROXY_TOKEN}"))
            .header(PROXY_ID_HEADER, "p1")
            .header(header::CONTENT_TYPE, CONTENT_TYPE)
            .body(())
            .unwrap();
        let (response, send) = client.send_request(request, false).unwrap();
        let response = response.await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let mut stream = H2Duplex::new(send, response.into_body());
        handshake(&mut stream).await;
        let started = Instant::now();
        tokio::time::timeout(
            Duration::from_secs(5),
            proxies.wait_for(|proxies| proxies.len() == 1),
        )
        .await
        .expect("the controller never listed the session")
        .unwrap();
        if let Some(frame) = then {
            write_frame(&mut stream, &frame).await.unwrap();
        }

        // From here the proxy reads nothing. The first write that does not
        // fit the window starts no later than the actor's first heartbeat
        // ping, on its first one-second tick at or past
        // `HEARTBEAT_INTERVAL`; a bounded write gives up
        // `SESSION_DEAD_AFTER` after it started, and the connection then
        // spends at most one second draining h2 before it returns. Two
        // more seconds are slack.
        let bound = crate::HEARTBEAT_INTERVAL + crate::SESSION_DEAD_AFTER + Duration::from_secs(4);
        tokio::time::sleep(bound).await;
        if !server.is_finished() {
            tokio::time::sleep(crate::SESSION_DEAD_AFTER * 4).await;
            panic!(
                "{scenario}: the connection task is still running {:?} after the proxy \
                 stopped reading (heartbeat expiry is {:?}); finished={}, permits \
                 available={}, sessions the controller still lists={}",
                started.elapsed(),
                crate::SESSION_DEAD_AFTER,
                server.is_finished(),
                permits.available_permits(),
                proxies.borrow().len(),
            );
        }
        assert!(
            proxies.borrow().is_empty(),
            "{scenario}: the controller kept the session"
        );
        assert_eq!(
            permits.available_permits(),
            1,
            "{scenario}: the permit did not return"
        );
        let result = server.await.unwrap();
        assert!(
            matches!(result, Err(SessionError::Timeout("proxy control write"))),
            "{scenario}: {result:?}"
        );
        drop(stream);
        driver.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn a_proxy_that_stops_reading_releases_its_connection_and_permit() {
        // The actor's heartbeat ping is the write that parks.
        stalled_reader_ends("a parked command write", None).await;
        // A frame the controller refuses: the `Shutdown` it writes before
        // ending the session is the write that parks, and the session must
        // end anyway.
        stalled_reader_ends(
            "a parked shutdown write",
            Some(hello(
                PROTOCOL_VERSION,
                env!("CARGO_PKG_VERSION"),
                "https://p1.proxy.example.test",
            )),
        )
        .await;
    }

    /// The next frame the controller sends that is not a heartbeat,
    /// answering each `Ping` on the way as a proxy does. A session that
    /// ends instead fails the test with what the session task returned, and
    /// so does one that sends only heartbeats for longer than any wait here
    /// (the convergence window is six of them).
    async fn next_command(opened: &mut Opened, step: &str) -> ServerFrame {
        for _ in 0..16 {
            let stream = opened.stream.as_mut().unwrap();
            match read_frame::<_, ServerFrame>(stream).await {
                Ok(ServerFrame::Ping { nonce }) => {
                    // A failed pong surfaces as the next read's error.
                    let _ = write_frame(stream, &ClientFrame::Pong { nonce }).await;
                }
                Ok(frame) => return frame,
                Err(error) => {
                    let session =
                        tokio::time::timeout(Duration::from_secs(5), &mut opened.server).await;
                    panic!(
                        "{step}: the control session ended ({error}); session task: {session:?}"
                    );
                }
            }
        }
        panic!("{step}: the controller sent only heartbeats for sixteen intervals");
    }

    /// Answer two heartbeats, failing on any other frame first. Paused
    /// time moves only when every task is idle, so the second ping is
    /// queued after the session task handled everything the test wrote
    /// before this call, and a resync or kill those frames caused would
    /// arrive ahead of it.
    async fn only_heartbeats(opened: &mut Opened, step: &str) {
        for _ in 0..2 {
            let stream = opened.stream.as_mut().unwrap();
            match read_frame::<_, ServerFrame>(stream).await {
                Ok(ServerFrame::Ping { nonce }) => {
                    write_frame(stream, &ClientFrame::Pong { nonce })
                        .await
                        .unwrap();
                }
                Ok(frame) => panic!("{step}: expected only heartbeats, got {frame:?}"),
                Err(error) => {
                    let session =
                        tokio::time::timeout(Duration::from_secs(5), &mut opened.server).await;
                    panic!(
                        "{step}: the control session ended ({error}); session task: {session:?}"
                    );
                }
            }
        }
    }

    async fn send(opened: &mut Opened, frames: &[ClientFrame]) {
        let stream = opened.stream.as_mut().unwrap();
        for frame in frames {
            write_frame(stream, frame).await.unwrap();
        }
    }

    async fn publish_snapshot(opened: &mut Opened, rows: Vec<TunnelRow>) {
        send(
            opened,
            &[
                ClientFrame::SnapshotStart { base_generation: 0 },
                ClientFrame::SnapshotChunk { rows },
                ClientFrame::SnapshotEnd { base_generation: 0 },
            ],
        )
        .await;
    }

    async fn expect_fleet_ready(opened: &mut Opened, step: &str) {
        match next_command(opened, step).await {
            ServerFrame::FleetReady => {}
            frame => panic!("{step}: expected FleetReady, got {frame:?}"),
        }
    }

    /// Require a kill naming exactly `registration_id`, then do what a
    /// proxy does with it: evict, report the eviction, and publish the
    /// eviction's own `TunnelDown` at `down_generation`.
    async fn kill_then_down(
        opened: &mut Opened,
        step: &str,
        registration_id: Uuid,
        down_generation: u64,
    ) {
        let (command_id, registration_ids) = match next_command(opened, step).await {
            ServerFrame::KillRegistrations {
                command_id,
                registration_ids,
            } => (command_id, registration_ids),
            frame => panic!("{step}: expected a kill, got {frame:?}"),
        };
        assert_eq!(
            registration_ids,
            vec![registration_id],
            "{step}: the kill must name only the refused registration"
        );
        send(
            opened,
            &[
                ClientFrame::CommandResult {
                    command_id,
                    killed: vec![registration_id],
                    missing: Vec::new(),
                    failed: Vec::new(),
                },
                ClientFrame::TunnelDown {
                    generation: down_generation,
                    registration_id,
                },
            ],
        )
        .await;
    }

    async fn aggregate_ids(controller: &ControllerHandle) -> Vec<Uuid> {
        let mut ids: Vec<_> = controller
            .tunnels()
            .await
            .unwrap()
            .into_iter()
            .map(|tunnel| tunnel.registration_id)
            .collect();
        ids.sort();
        ids
    }

    async fn assert_session_active(controller: &ControllerHandle, step: &str) {
        let proxies = controller.proxies().await.unwrap();
        assert!(
            matches!(
                proxies.as_slice(),
                [crate::ProxyView {
                    status: crate::ProxyStatus::Active,
                    ..
                }]
            ),
            "{step}: {proxies:?}"
        );
    }

    /// One row whose lease the controller cannot verify must not cost the
    /// proxy its session: every reconnect's snapshot would carry the same
    /// row, and the session would flap until the proxy's grace evicted
    /// every tunnel on the node. The row here is the one the rig's stub
    /// identity produced, an expiry one second off the one its lease signs.
    #[tokio::test(start_paused = true)]
    async fn a_snapshot_row_the_controller_cannot_verify_costs_only_that_tunnel() {
        let controller = crate::spawn_controller(100);
        let mut opened = connected(controller.clone()).await;
        handshake(opened.stream.as_mut().unwrap()).await;
        let good = signed_row("alice", "one", Uuid::new_v4());
        let mut skewed = signed_row("bob", "two", Uuid::new_v4());
        skewed.admission_lease_expires_at += chrono::Duration::seconds(1);

        publish_snapshot(&mut opened, vec![good.clone(), skewed.clone()]).await;
        match next_command(&mut opened, "snapshot with one unverifiable row").await {
            ServerFrame::SnapshotAccepted { base_generation: 0 } => {}
            frame => panic!("expected SnapshotAccepted, got {frame:?}"),
        }
        // The snapshot has no generation beyond its base, so the eviction's
        // down is the first delta.
        kill_then_down(
            &mut opened,
            "refused snapshot row",
            skewed.registration_id,
            1,
        )
        .await;
        expect_fleet_ready(&mut opened, "convergence after the refused row's down").await;
        assert_eq!(aggregate_ids(&controller).await, vec![good.registration_id]);
        assert_session_active(&controller, "after the refused row's down").await;

        send(
            &mut opened,
            &[ClientFrame::TunnelDown {
                generation: 2,
                registration_id: good.registration_id,
            }],
        )
        .await;
        only_heartbeats(&mut opened, "the good row's down at the next generation").await;
        assert!(aggregate_ids(&controller).await.is_empty());
        assert_session_active(&controller, "after the good row's down").await;
    }

    #[tokio::test(start_paused = true)]
    async fn a_tunnel_up_the_controller_cannot_verify_costs_only_that_tunnel() {
        let controller = crate::spawn_controller(100);
        let mut opened = connected(controller.clone()).await;
        handshake(opened.stream.as_mut().unwrap()).await;
        let good = signed_row("alice", "one", Uuid::new_v4());
        publish_snapshot(&mut opened, vec![good.clone()]).await;
        assert!(matches!(
            next_command(&mut opened, "snapshot").await,
            ServerFrame::SnapshotAccepted { base_generation: 0 }
        ));
        expect_fleet_ready(&mut opened, "snapshot").await;

        let foreign = row_signed_with(FOREIGN_SIGNING_KEY, "bob", "two", Uuid::new_v4());
        send(
            &mut opened,
            &[ClientFrame::TunnelUp {
                generation: 1,
                row: foreign.clone(),
            }],
        )
        .await;
        kill_then_down(&mut opened, "refused TunnelUp", foreign.registration_id, 2).await;
        assert_eq!(aggregate_ids(&controller).await, vec![good.registration_id]);

        send(
            &mut opened,
            &[ClientFrame::TunnelDown {
                generation: 3,
                registration_id: good.registration_id,
            }],
        )
        .await;
        only_heartbeats(&mut opened, "the good row's down at the next generation").await;
        assert!(aggregate_ids(&controller).await.is_empty());
        assert_session_active(&controller, "after both downs").await;
    }

    #[tokio::test(start_paused = true)]
    async fn a_browser_session_up_past_the_fleet_cap_keeps_the_control_session() {
        tokio::time::timeout(Duration::from_secs(120), async {
            for down_first in [false, true] {
                let controller = crate::spawn_controller(100);
                let mut opened = connected(controller.clone()).await;
                handshake(opened.stream.as_mut().unwrap()).await;
                let incumbent = signed_row("owner", "one", Uuid::new_v4());
                publish_snapshot(&mut opened, vec![incumbent.clone()]).await;
                assert!(matches!(
                    next_command(&mut opened, "snapshot").await,
                    ServerFrame::SnapshotAccepted { base_generation: 0 }
                ));
                expect_fleet_ready(&mut opened, "snapshot").await;
                controller.fill_browser_fleet_bytes_for_test().await;
                let admin_session_id = Uuid::new_v4();
                let created_at = chrono::Utc::now();
                send(
                    &mut opened,
                    &[ClientFrame::BrowserSessionUp {
                        generation: 1,
                        row: BrowserSessionRow {
                            admin_session_id,
                            subject_user_id: incumbent.owner_user_id,
                            owner_user_id: incumbent.owner_user_id,
                            devserver_id: incumbent.devserver_id.clone(),
                            created_at,
                            expires_at: created_at + chrono::Duration::hours(1),
                        },
                    }],
                )
                .await;
                let command_id = match next_command(&mut opened, "over-cap browser session").await {
                    ServerFrame::RevokeSessions {
                        command_id,
                        revocation:
                            devserver_control_proto::SessionRevocation::SessionId {
                                admin_session_id: revoked_id,
                            },
                    } => {
                        assert_eq!(revoked_id, admin_session_id);
                        command_id
                    }
                    frame => panic!("expected a session revoke, got {frame:?}"),
                };
                let result = ClientFrame::SessionRevocationResult {
                    command_id,
                    revoked: 1,
                };
                let down = ClientFrame::BrowserSessionDown {
                    generation: 2,
                    admin_session_id,
                };
                let frames = if down_first {
                    [down, result]
                } else {
                    [result, down]
                };
                send(&mut opened, &frames).await;
                only_heartbeats(&mut opened, "after browser-session refusal and down").await;
                assert_session_active(&controller, "after browser-session refusal").await;
                assert_eq!(
                    aggregate_ids(&controller).await,
                    vec![incumbent.registration_id]
                );
                assert!(controller.browser_sessions().await.unwrap().is_empty());
            }
        })
        .await
        .expect("over-cap browser session test timed out");
    }

    #[tokio::test(start_paused = true)]
    async fn a_tunnel_up_past_the_session_cap_keeps_the_control_session() {
        tokio::time::timeout(Duration::from_secs(120), async {
            let controller = crate::spawn_controller(100);
            let mut opened = connected(controller.clone()).await;
            handshake(opened.stream.as_mut().unwrap()).await;
            let rows: Vec<_> = (0..devserver_control_proto::MAX_SNAPSHOT_ROWS - 1)
                .map(|index| signed_row(&format!("owner-{index}"), "one", Uuid::new_v4()))
                .collect();
            let mut expected: Vec<_> = rows.iter().map(|row| row.registration_id).collect();
            expected.sort();
            send(
                &mut opened,
                &[ClientFrame::SnapshotStart { base_generation: 0 }],
            )
            .await;
            for chunk in rows.chunks(devserver_control_proto::MAX_SNAPSHOT_CHUNK_ROWS) {
                send(
                    &mut opened,
                    &[ClientFrame::SnapshotChunk {
                        rows: chunk.to_vec(),
                    }],
                )
                .await;
            }
            send(
                &mut opened,
                &[ClientFrame::SnapshotEnd { base_generation: 0 }],
            )
            .await;
            assert!(matches!(
                next_command(&mut opened, "full snapshot").await,
                ServerFrame::SnapshotAccepted { base_generation: 0 }
            ));
            expect_fleet_ready(&mut opened, "full snapshot").await;
            assert_eq!(aggregate_ids(&controller).await, expected);

            let extra = signed_row("extra", "extra", Uuid::new_v4());
            let request_id = Uuid::new_v4();
            send(
                &mut opened,
                &[ClientFrame::AdmissionRequest {
                    request_id,
                    registration_id: extra.registration_id,
                    owner_user_id: extra.owner_user_id,
                    user: extra.user.clone(),
                    devserver_id: extra.devserver_id.clone(),
                    admission_lease: extra.admission_lease.clone(),
                }],
            )
            .await;
            assert!(matches!(
                next_command(&mut opened, "admission before filling the session").await,
                ServerFrame::AdmissionDecision {
                    request_id: admitted_request,
                    registration_id,
                    decision: AdmissionDecision::Admit,
                } if admitted_request == request_id && registration_id == extra.registration_id
            ));
            // Admission reserves the last row. Inject an incumbent to exercise
            // the publication backstop with that claim still present.
            let filler = signed_row("filler", "filler", Uuid::new_v4());
            expected.push(filler.registration_id);
            expected.sort();
            controller
                .fill_session_row_for_test(
                    ProxyId::parse("p1").unwrap(),
                    filler,
                    extra.registration_id,
                )
                .await;
            assert_eq!(aggregate_ids(&controller).await, expected);
            send(
                &mut opened,
                &[ClientFrame::TunnelUp {
                    generation: 1,
                    row: extra.clone(),
                }],
            )
            .await;
            kill_then_down(
                &mut opened,
                "over-cap registration",
                extra.registration_id,
                2,
            )
            .await;
            only_heartbeats(&mut opened, "after the refused registration's down").await;
            assert_session_active(&controller, "after the over-cap registration").await;
            assert_eq!(aggregate_ids(&controller).await, expected);
        })
        .await
        .expect("over-cap registration test timed out");
    }

    /// `Stale` and `ControlWarming` both refuse one client on the proxy.
    /// `Stale` is the one that is true: the request's authority is not
    /// current, while the controller is ready.
    #[tokio::test(start_paused = true)]
    async fn an_admission_request_the_controller_cannot_verify_is_answered_stale() {
        // A cap of two devservers per owner, so a refused request that
        // reserved a slot would show as the next request's `AtCapacity`.
        let controller = crate::spawn_controller(2);
        let mut opened = connected(controller.clone()).await;
        handshake(opened.stream.as_mut().unwrap()).await;
        let good = signed_row("alice", "one", Uuid::new_v4());
        let owner = good.owner_user_id;
        publish_snapshot(&mut opened, vec![good]).await;
        assert!(matches!(
            next_command(&mut opened, "snapshot").await,
            ServerFrame::SnapshotAccepted { base_generation: 0 }
        ));
        expect_fleet_ready(&mut opened, "snapshot").await;

        let request = |devserver_id: &str, admission_lease: AdmissionLease, registration_id| {
            ClientFrame::AdmissionRequest {
                request_id: Uuid::new_v4(),
                registration_id,
                owner_user_id: owner,
                user: "alice".into(),
                devserver_id: devserver_id.into(),
                admission_lease,
            }
        };
        let foreign_registration = Uuid::new_v4();
        let misbound_registration = Uuid::new_v4();
        let admitted_registration = Uuid::new_v4();
        let over_cap_registration = Uuid::new_v4();
        let cases = [
            (
                "a lease signed outside the ring",
                request(
                    "two",
                    lease_signed_with(
                        FOREIGN_SIGNING_KEY,
                        binding(owner, "alice", "two", foreign_registration),
                    ),
                    foreign_registration,
                ),
                AdmissionDecision::Stale,
            ),
            (
                "a lease bound to another registration",
                request(
                    "three",
                    lease_signed_with(
                        TEST_SIGNING_KEY,
                        binding(owner, "alice", "three", Uuid::new_v4()),
                    ),
                    misbound_registration,
                ),
                AdmissionDecision::Stale,
            ),
            (
                "a verifiable request after both refusals",
                request(
                    "four",
                    lease_signed_with(
                        TEST_SIGNING_KEY,
                        binding(owner, "alice", "four", admitted_registration),
                    ),
                    admitted_registration,
                ),
                AdmissionDecision::Admit,
            ),
            (
                "a verifiable request past the cap",
                request(
                    "five",
                    lease_signed_with(
                        TEST_SIGNING_KEY,
                        binding(owner, "alice", "five", over_cap_registration),
                    ),
                    over_cap_registration,
                ),
                AdmissionDecision::AtCapacity,
            ),
        ];
        for (step, frame, expected) in cases {
            let ClientFrame::AdmissionRequest {
                request_id,
                registration_id,
                ..
            } = frame
            else {
                unreachable!();
            };
            send(&mut opened, &[frame]).await;
            match next_command(&mut opened, step).await {
                ServerFrame::AdmissionDecision {
                    request_id: answered,
                    registration_id: answered_registration,
                    decision,
                } if answered == request_id && answered_registration == registration_id => {
                    assert_eq!(decision, expected, "{step}");
                }
                frame => panic!("{step}: expected its admission decision, got {frame:?}"),
            }
        }
        assert_session_active(&controller, "after the refusals").await;
    }

    #[tokio::test(start_paused = true)]
    async fn a_lease_refresh_the_controller_cannot_verify_kills_only_that_registration() {
        let controller = crate::spawn_controller(100);
        let mut opened = connected(controller.clone()).await;
        handshake(opened.stream.as_mut().unwrap()).await;
        let foreign = signed_row("alice", "one", Uuid::new_v4());
        let other_registration = signed_row("bob", "two", Uuid::new_v4());
        let other_devserver = signed_row("carol", "three", Uuid::new_v4());
        let renewed = signed_row("dave", "four", Uuid::new_v4());
        publish_snapshot(
            &mut opened,
            vec![
                foreign.clone(),
                other_registration.clone(),
                other_devserver.clone(),
                renewed.clone(),
            ],
        )
        .await;
        assert!(matches!(
            next_command(&mut opened, "snapshot").await,
            ServerFrame::SnapshotAccepted { base_generation: 0 }
        ));
        expect_fleet_ready(&mut opened, "snapshot").await;

        let refused = [
            (
                "a refresh signed outside the ring",
                foreign.registration_id,
                lease_signed_with(
                    FOREIGN_SIGNING_KEY,
                    foreign.binding_for(ProxyId::parse("p1").unwrap()),
                ),
            ),
            (
                "a refresh bound to another registration",
                other_registration.registration_id,
                lease_signed_with(
                    TEST_SIGNING_KEY,
                    binding(
                        other_registration.owner_user_id,
                        "bob",
                        "two",
                        Uuid::new_v4(),
                    ),
                ),
            ),
            (
                "a refresh bound to another devserver",
                other_devserver.registration_id,
                lease_signed_with(
                    TEST_SIGNING_KEY,
                    binding(
                        other_devserver.owner_user_id,
                        "carol",
                        "elsewhere",
                        other_devserver.registration_id,
                    ),
                ),
            ),
        ];
        for (generation, (step, registration_id, admission_lease)) in (1..).zip(refused) {
            send(
                &mut opened,
                &[ClientFrame::LeaseRefresh {
                    registration_id,
                    admission_lease,
                }],
            )
            .await;
            kill_then_down(&mut opened, step, registration_id, generation).await;
        }

        let renewal = lease_signed_with(
            TEST_SIGNING_KEY,
            renewed.binding_for(ProxyId::parse("p1").unwrap()),
        );
        send(
            &mut opened,
            &[ClientFrame::LeaseRefresh {
                registration_id: renewed.registration_id,
                admission_lease: renewal.clone(),
            }],
        )
        .await;
        only_heartbeats(&mut opened, "a verifiable refresh and the three downs").await;
        let tunnels = controller.tunnels().await.unwrap();
        assert_eq!(tunnels.len(), 1, "{tunnels:?}");
        assert_eq!(tunnels[0].registration_id, renewed.registration_id);
        assert_eq!(tunnels[0].admission_lease, renewal.as_str());
        assert_session_active(&controller, "after the refused refreshes").await;
    }

    /// Refusing a row's authority softens nothing structural: a repeated
    /// id and a generation gap resync exactly as they do for rows that
    /// verify, and they are checked before the lease is.
    #[tokio::test(start_paused = true)]
    async fn structural_violations_around_an_unverifiable_row_still_resync() {
        let controller = crate::spawn_controller(100);
        let mut opened = connected(controller.clone()).await;
        handshake(opened.stream.as_mut().unwrap()).await;
        let foreign = row_signed_with(FOREIGN_SIGNING_KEY, "bob", "two", Uuid::new_v4());

        send(
            &mut opened,
            &[
                ClientFrame::SnapshotStart { base_generation: 0 },
                ClientFrame::SnapshotChunk {
                    rows: vec![foreign.clone(), foreign.clone()],
                },
            ],
        )
        .await;
        match next_command(&mut opened, "a snapshot repeating an unverifiable row").await {
            ServerFrame::ResyncRequired {
                expected_generation: 0,
            } => {}
            frame => panic!("expected ResyncRequired, got {frame:?}"),
        }

        let good = signed_row("alice", "one", Uuid::new_v4());
        publish_snapshot(&mut opened, vec![good]).await;
        assert!(matches!(
            next_command(&mut opened, "snapshot").await,
            ServerFrame::SnapshotAccepted { base_generation: 0 }
        ));
        expect_fleet_ready(&mut opened, "snapshot").await;
        send(
            &mut opened,
            &[ClientFrame::TunnelUp {
                generation: 1,
                row: foreign.clone(),
            }],
        )
        .await;
        match next_command(&mut opened, "refused TunnelUp").await {
            ServerFrame::KillRegistrations {
                registration_ids, ..
            } if registration_ids == vec![foreign.registration_id] => {}
            frame => panic!("expected the refused row's kill, got {frame:?}"),
        }
        // Published up again before its down: a duplicate registration id.
        send(
            &mut opened,
            &[ClientFrame::TunnelUp {
                generation: 2,
                row: foreign.clone(),
            }],
        )
        .await;
        match next_command(&mut opened, "the refused registration published again").await {
            ServerFrame::ResyncRequired {
                expected_generation: 3,
            } => {}
            frame => panic!("expected ResyncRequired, got {frame:?}"),
        }

        publish_snapshot(&mut opened, Vec::new()).await;
        match next_command(&mut opened, "resnapshot").await {
            ServerFrame::SnapshotAccepted { base_generation: 0 } => {}
            frame => panic!("expected SnapshotAccepted, got {frame:?}"),
        }
        expect_fleet_ready(&mut opened, "resnapshot").await;
        let gap = row_signed_with(FOREIGN_SIGNING_KEY, "carol", "three", Uuid::new_v4());
        send(
            &mut opened,
            &[ClientFrame::TunnelUp {
                generation: 2,
                row: gap,
            }],
        )
        .await;
        match next_command(&mut opened, "an unverifiable row across a generation gap").await {
            ServerFrame::ResyncRequired {
                expected_generation: 1,
            } => {}
            frame => panic!("expected ResyncRequired, got {frame:?}"),
        }
    }
}
