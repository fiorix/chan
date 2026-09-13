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
                if !snapshot_rows_fit(rows.len(), chunk.len()) {
                    send_shutdown(writer, "snapshot row limit exceeded").await?;
                    return Err(SessionError::SnapshotTooLarge);
                }
                let chunk_bytes = serde_json::to_vec(&chunk).map_err(FrameError::Json)?.len();
                if !snapshot_bytes_fit(*bytes, chunk_bytes) {
                    send_shutdown(writer, "snapshot byte limit exceeded").await?;
                    return Err(SessionError::SnapshotTooLarge);
                }
                for row in &chunk {
                    verify_tunnel_row(admission_lease_verifier, proxy_id, row)?;
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
                rows.extend(chunk);
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
                let browser_sessions = std::mem::take(browser_sessions);
                *phase = Phase::Active;
                controller
                    .accept_snapshot(
                        proxy_id.clone(),
                        incarnation,
                        base_generation,
                        rows,
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
                verify_tunnel_row(admission_lease_verifier, proxy_id, &row)?;
                let status = controller
                    .tunnel_up(proxy_id.clone(), incarnation, generation, row)
                    .await?;
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
                let claims = verify_lease(
                    admission_lease_verifier,
                    &admission_lease,
                    AdmissionLeaseBinding {
                        owner_user_id,
                        user: user.clone(),
                        devserver_id: devserver_id.clone(),
                        registration_id,
                        proxy_id: proxy_id.clone(),
                    },
                )?;
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
                let claims = admission_lease_verifier
                    .verify(&admission_lease, chrono::Utc::now())
                    .map_err(|error| {
                        SessionError::Protocol(format!("invalid lease refresh: {error}"))
                    })?;
                if claims.binding.proxy_id != *proxy_id
                    || claims.binding.registration_id != registration_id
                {
                    return Err(SessionError::Protocol(
                        "lease refresh binding mismatch".into(),
                    ));
                }
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

fn verify_lease(
    verifier: &AdmissionLeaseVerifier,
    lease: &AdmissionLease,
    expected: AdmissionLeaseBinding,
) -> Result<devserver_control_proto::AdmissionLeaseClaims, SessionError> {
    let claims = verifier
        .verify(lease, chrono::Utc::now())
        .map_err(|error| SessionError::Protocol(format!("invalid admission lease: {error}")))?;
    if claims.binding != expected {
        return Err(SessionError::Protocol(
            "admission lease binding mismatch".into(),
        ));
    }
    Ok(claims)
}

fn verify_tunnel_row(
    verifier: &AdmissionLeaseVerifier,
    proxy_id: &ProxyId,
    row: &TunnelRow,
) -> Result<(), SessionError> {
    let claims = verify_lease(
        verifier,
        &row.admission_lease,
        row.binding_for(proxy_id.clone()),
    )?;
    if row.admission_lease_expires_at.timestamp() != claims.expires_at {
        return Err(SessionError::Protocol(
            "admission lease expiry mismatch".into(),
        ));
    }
    if row.max_connected_devservers != claims.max_connected_devservers {
        return Err(SessionError::Protocol(
            "admission lease devserver limit mismatch".into(),
        ));
    }
    Ok(())
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
    use devserver_control_proto::{AdmissionLeaseSigner, TunnelRow, MAX_SNAPSHOT_CHUNK_ROWS};
    use uuid::Uuid;

    const TEST_PROXY_TOKEN: &str = "0123456789abcdef0123456789abcdef";
    const TEST_SIGNING_KEY: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    fn admission_keys() -> (AdmissionLeaseSigner, AdmissionLeaseVerifier) {
        let signer = AdmissionLeaseSigner::from_base64(TEST_SIGNING_KEY).unwrap();
        let verifier = AdmissionLeaseVerifier::from_base64(&signer.verifying_key_base64()).unwrap();
        (signer, verifier)
    }

    fn signed_row(user: &str, devserver_id: &str, registration_id: Uuid) -> TunnelRow {
        let owner_user_id = Uuid::new_v4();
        let (signer, _) = admission_keys();
        let now = chrono::Utc::now();
        let admission_lease = signer
            .sign(
                AdmissionLeaseBinding {
                    owner_user_id,
                    user: user.into(),
                    devserver_id: devserver_id.into(),
                    registration_id,
                    proxy_id: ProxyId::parse("p1").unwrap(),
                },
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

    /// A proxy carrying a full browser-session registry writes 781
    /// snapshot chunks back to back with no pacing. At 32 frames per
    /// second the per-frame limiter used to shut the session down
    /// around the 31st chunk, so such a proxy could never join.
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
}
