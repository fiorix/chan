//! Tunnel listener: accepts h2c POSTs from `chan devserver` clients
//! and registers them in the shared `Registry`.
//!
//! nginx terminates TLS for `proxy.{domain}` and `grpc_pass`es
//! `/v1/tunnel` as cleartext h2 (h2c) to this listener; everything
//! else on the apex hits the axum HTTP listener. We run `h2::server`
//! directly on the TCP socket; using axum/hyper here would force us
//! to glue the bidirectional body back together with mpsc senders.
//! Raw h2 lets us hand the `(SendStream, RecvStream)` straight to
//! `H2Duplex`.
//!
//! One tunnel = one h2 connection = one accepted stream. Anything
//! else (additional streams, wrong method, wrong path, missing
//! Authorization) gets a final-frame error response and the rest
//! of the connection is treated as a keepalive driver until the
//! peer closes. For a refused dial, at any stage before the tunnel
//! registers, that keepalive driver is bounded and holds nothing:
//! `h2::server::Connection` has no idle timeout, so anything a
//! refused peer can park on is something any peer that reaches the
//! listener can exhaust.
use std::future::Future;
use std::net::SocketAddr;
use std::sync::Arc;

use chan_tunnel_proto::{accept_next, H2Duplex, TUNNEL_PATH};
use h2::Reason;
use http::{header, Method, Response, StatusCode};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, Semaphore};

use crate::driver::run_tunnel;
use crate::registry::Registry;
use crate::{
    handshake_validated_with_admission, RegistrationAdmission, RegistrationPermit, ServerError,
    Validated, Validator, FIRST_STREAM_TIMEOUT, H2_HANDSHAKE_TIMEOUT, MAX_INFLIGHT_HANDSHAKES,
    TUNNEL_SCOPE, VALIDATE_TIMEOUT,
};

struct LocalAdmission {
    registry: Arc<Registry>,
    max_registrations_per_user: usize,
}

/// The h2 server builder with the shared tunnel flow-control windows.
/// h2's default 64 KiB stream window throttles bulk transfer over any
/// nontrivial RTT regardless of the yamux windows above it; both tunnel
/// peers advertise the same windows so both directions are covered.
fn tunnel_h2_server_builder() -> h2::server::Builder {
    let mut builder = h2::server::Builder::new();
    builder
        .initial_window_size(chan_tunnel_proto::TUNNEL_H2_STREAM_WINDOW)
        .initial_connection_window_size(chan_tunnel_proto::TUNNEL_H2_CONNECTION_WINDOW);
    builder
}

#[async_trait::async_trait]
impl RegistrationAdmission for LocalAdmission {
    async fn admit_registration(
        &self,
        _hello: &chan_tunnel_proto::Hello,
        validated: &Validated,
        registration_id: uuid::Uuid,
    ) -> Result<RegistrationPermit, ServerError> {
        if self.max_registrations_per_user > 0 {
            let registered = self.registry.list_workspaces_for(&validated.username);
            let already_present = registered
                .iter()
                .any(|row| row.workspace.as_ref() == validated.devserver_id.as_str());
            if !already_present && registered.len() >= self.max_registrations_per_user {
                return Err(ServerError::TooManyRegistrations {
                    user: validated.username.clone(),
                    max: self.max_registrations_per_user,
                });
            }
        }
        Ok(RegistrationPermit {
            request_id: uuid::Uuid::new_v4(),
            registration_id,
            admission_epoch: 0,
        })
    }
}

/// How long a refused dial keeps polling the connection after its
/// final response frame is queued. h2 writes nothing unless the
/// connection is polled, so returning straight away would drop the
/// 404 / 401 on the floor; and `h2::server::Connection` has no idle
/// timeout of its own, so a peer that takes its refusal and then
/// holds the TCP open must not be able to park the task forever.
const REJECTION_DRAIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// How many "stream beyond the first" rejections the drainer task
/// will tolerate before tearing down the whole h2 connection with
/// ENHANCE_YOUR_CALM. A correct client opens exactly one stream
/// (the tunnel POST); a peer that keeps opening more is misbehaving
/// or attempting to amplify load against the listener.
const MAX_DRAINER_REJECTIONS: u32 = 16;

/// Accept loop for a TCP listener bound to a tunnel-only port.
/// Returns only when the listening socket itself is unusable
/// (`chan_tunnel_proto::AcceptFailure::Listener`): an accept failure
/// that concerns one pending connection is retried at once, and one
/// that means the process is short of descriptors or memory is
/// retried after a pause, so an embedder that treats the return as
/// the listener dying only sees it when it has. Per-connection
/// failures after accept are logged and never bubble up.
///
/// `max_registrations_per_user` caps the number of distinct devserver
/// registrations (devserver ids) a single user may hold concurrently.
/// `0` disables the limit. A reconnect of a devserver the user already
/// has registered is always allowed; the registry's last-writer-wins
/// policy evicts the stale entry before the count is checked again.
pub async fn serve_tunnel_listener(
    listener: TcpListener,
    validator: Arc<dyn Validator>,
    registry: Arc<Registry>,
    max_registrations_per_user: usize,
) -> std::io::Result<()> {
    serve_tunnel_listener_with_admission(
        listener,
        validator,
        Arc::new(LocalAdmission {
            registry: registry.clone(),
            max_registrations_per_user,
        }),
        registry,
        max_registrations_per_user,
    )
    .await
}

pub async fn serve_tunnel_listener_with_admission(
    listener: TcpListener,
    validator: Arc<dyn Validator>,
    admission: Arc<dyn RegistrationAdmission>,
    registry: Arc<Registry>,
    max_registrations_per_user: usize,
) -> std::io::Result<()> {
    serve_accepted(
        || listener.accept(),
        validator,
        admission,
        registry,
        max_registrations_per_user,
    )
    .await
}

/// The accept loop over any source of accept results. The listener
/// passes its own `accept`; a test passes one that injects the
/// failures a real socket only produces under fd exhaustion.
async fn serve_accepted<A, F>(
    mut accept: A,
    validator: Arc<dyn Validator>,
    admission: Arc<dyn RegistrationAdmission>,
    registry: Arc<Registry>,
    max_registrations_per_user: usize,
) -> std::io::Result<()>
where
    A: FnMut() -> F,
    F: Future<Output = std::io::Result<(TcpStream, SocketAddr)>>,
{
    // Cap concurrent in-flight handshakes. The permit is held only
    // through the authenticate-and-handshake stages; once the
    // per-tunnel driver takes over (run_tunnel), the permit is
    // dropped and the slot frees up for the next dial. This bounds
    // memory / task count against floods of half-open or slow peers.
    let inflight = Arc::new(Semaphore::new(MAX_INFLIGHT_HANDSHAKES));
    loop {
        let (tcp, peer) = accept_next("tunnel", &mut accept).await?;
        let permit = match inflight.clone().try_acquire_owned() {
            Ok(p) => p,
            Err(_) => {
                tracing::warn!(
                    %peer,
                    max = MAX_INFLIGHT_HANDSHAKES,
                    "tunnel listener at in-flight handshake cap; rejecting",
                );
                drop(tcp);
                continue;
            }
        };
        let validator = validator.clone();
        let admission = admission.clone();
        let registry = registry.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_tunnel_conn(
                tcp,
                peer,
                validator,
                admission,
                registry,
                max_registrations_per_user,
                permit,
            )
            .await
            {
                tracing::warn!(%peer, error = %e, "tunnel connection ended with error");
            } else {
                tracing::debug!(%peer, "tunnel connection closed");
            }
        });
    }
}

/// Drive a single client's h2 connection through accept,
/// validate, handshake, register, and tunnel-driver lifecycle.
async fn handle_tunnel_conn(
    tcp: TcpStream,
    peer: SocketAddr,
    validator: Arc<dyn Validator>,
    admission: Arc<dyn RegistrationAdmission>,
    registry: Arc<Registry>,
    max_registrations_per_user: usize,
    inflight_permit: tokio::sync::OwnedSemaphorePermit,
) -> Result<(), ServerError> {
    let _ = tcp.set_nodelay(true);
    // Per-stage timeouts: a peer that finishes one stage but stalls
    // on the next is bounded by the next stage's timer rather than
    // sitting indefinitely on `HELLO_READ_TIMEOUT` only (which kicks
    // in much later, after the 200).
    let mut conn = match tokio::time::timeout(
        H2_HANDSHAKE_TIMEOUT,
        tunnel_h2_server_builder().handshake(tcp),
    )
    .await
    {
        Ok(Ok(c)) => c,
        Ok(Err(e)) => return Err(ServerError::Handshake(format!("h2 handshake: {e}"))),
        Err(_) => {
            return Err(ServerError::Handshake(format!(
                "h2 handshake timed out after {H2_HANDSHAKE_TIMEOUT:?}"
            )))
        }
    };

    let accepted = match tokio::time::timeout(FIRST_STREAM_TIMEOUT, conn.accept()).await {
        Ok(opt) => opt,
        Err(_) => {
            return Err(ServerError::Handshake(format!(
                "first stream not received within {FIRST_STREAM_TIMEOUT:?}"
            )))
        }
    };
    let (request, mut respond) = match accepted {
        Some(Ok(rs)) => rs,
        Some(Err(e)) => return Err(ServerError::Handshake(format!("h2 accept: {e}"))),
        None => return Ok(()),
    };

    if request.method() != Method::POST || request.uri().path() != TUNNEL_PATH {
        let resp = Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(())
            .expect("constant response");
        let _ = respond.send_response(resp, true);
        // The refusal is the whole exchange: the in-flight slot goes
        // back to the next dialer before the connection is flushed,
        // so an unauthenticated peer that then sits on an open TCP
        // connection cannot hold a slot with it.
        drop(inflight_permit);
        drain_refused_conn(conn).await;
        return Ok(());
    }

    let token = match extract_bearer(&request) {
        Some(t) => t,
        None => {
            let resp = Response::builder()
                .status(StatusCode::UNAUTHORIZED)
                .body(())
                .expect("constant response");
            let _ = respond.send_response(resp, true);
            drop(inflight_permit);
            drain_refused_conn(conn).await;
            return Ok(());
        }
    };

    let (_parts, recv_body) = request.into_parts();

    // Spawn the h2 frame driver BEFORE we await on the validator.
    // The h2 connection only makes progress while somebody is
    // polling it; the validate call is potentially a network round
    // trip to the identity service, and without an active driver
    // the connection would stall (no PINGs, no frame parsing).
    //
    // `admitted` is sent only once the tunnel is registered, as the
    // last step before the tunnel driver takes over. Every return
    // above that point drops it unsent, which the h2 driver takes as
    // a refusal: it flushes the refusal and closes the connection.
    // A refusal path added later ends the h2 driver without having
    // to remember to.
    let (admitted, outcome) = oneshot::channel();
    tokio::spawn(drive_tunnel_conn(conn, outcome));

    // Validate the token BEFORE sending 200. Every authentication
    // failure returns the same 401 on the wire so a candidate token
    // exposes neither validity nor scope; the internal error keeps the
    // exact cause available to server logs. Sending 200 first and then
    // closing the stream would instead collapse authentication and
    // transport failures into the same generic handshake error.
    //
    // Server-side timeout independent of any timeout the `Validator`
    // impl might enforce internally: a hung identity service cannot
    // pin this task and its permit forever.
    let registration_id = uuid::Uuid::new_v4();
    let validated = match tokio::time::timeout(
        VALIDATE_TIMEOUT,
        validator.validate_registration(&token, registration_id),
    )
    .await
    {
        Ok(Ok(v)) => v,
        Err(_) => {
            let resp = Response::builder()
                .status(StatusCode::GATEWAY_TIMEOUT)
                .body(())
                .expect("constant response");
            let _ = respond.send_response(resp, true);
            return Err(ServerError::Identity(format!(
                "validator timed out after {VALIDATE_TIMEOUT:?}"
            )));
        }
        Ok(Err(e)) => {
            let status = match &e {
                ServerError::InvalidToken => StatusCode::UNAUTHORIZED,
                ServerError::Identity(_) => StatusCode::BAD_GATEWAY,
                _ => StatusCode::INTERNAL_SERVER_ERROR,
            };
            let resp = Response::builder()
                .status(status)
                .body(())
                .expect("constant response");
            let _ = respond.send_response(resp, true);
            return Err(e);
        }
    };
    if !validated.scopes.iter().any(|s| s == TUNNEL_SCOPE) {
        let resp = Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .body(())
            .expect("constant response");
        let _ = respond.send_response(resp, true);
        return Err(ServerError::MissingScope);
    }

    let resp = Response::builder()
        .status(StatusCode::OK)
        .body(())
        .expect("constant response");
    let send = respond
        .send_response(resp, false)
        .map_err(|e| ServerError::Handshake(format!("send_response: {e}")))?;

    let duplex = H2Duplex::new(send, recv_body);
    let (hello, validated, permit, yconn) =
        handshake_validated_with_admission(duplex, validated, admission.as_ref(), registration_id)
            .await?;

    if !admission.permit_is_current(permit) {
        admission.cancel(permit).await;
        drop(yconn);
        return Err(ServerError::ControlUnavailable);
    }

    let user: Arc<str> = Arc::from(validated.username.as_str());
    // The second registry key is the token-resolved devserver id (the
    // authoritative identity), not the ignored `Hello.workspace` label.
    let devserver: Arc<str> = Arc::from(validated.devserver_id.as_str());
    // Final local-cap race fence. `LocalAdmission` makes the friendly
    // pre-ack check, then `register_with_cap` repeats the count and insert
    // under one lock acquisition. Controller-backed callers disable this
    // local authority with zero. A local-cap loser here has already
    // received HelloAck, so dropping `yconn` closes the transport.
    let (handle, open_rx, shutdown_rx) = match registry.register_authorized_with_id_and_cap(
        user.clone(),
        devserver.clone(),
        Some(peer),
        validated.gateway_assertion_key,
        permit.registration_id,
        validated.user_id,
        validated.admission_lease.as_deref().map(Arc::from),
        validated.admission_lease_expires_at,
        max_registrations_per_user,
    ) {
        Ok(triple) => triple,
        Err(capped) => {
            admission.cancel(permit).await;
            tracing::warn!(
                user = %capped.user,
                max = capped.max,
                "tunnel registration raced past admission and hit the local cap",
            );
            drop(yconn);
            return Err(ServerError::TooManyRegistrations {
                user: capped.user,
                max: capped.max,
            });
        }
    };
    if !admission.permit_is_current(permit) {
        registry.evict_registration(permit.registration_id);
        admission.cancel(permit).await;
        drop(yconn);
        return Err(ServerError::ControlUnavailable);
    }
    tracing::info!(%user, %devserver, "tunnel registered");

    // The Hello may carry a display name for the roster. Hand it to
    // the validator on a detached task: it is best-effort metadata,
    // so a slow identity hop must not delay the tunnel driver, and a
    // failure never unwinds the registration.
    if let Some(name) = hello
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
    {
        let validator = validator.clone();
        let token = token.clone();
        tokio::spawn(async move {
            validator.announce_devserver_name(&token, &name).await;
        });
    }

    // Handshake is done; the in-flight slot belongs to the next
    // dialer. The per-tunnel driver runs without holding a permit.
    drop(inflight_permit);
    let _ = admitted.send(());

    run_tunnel(
        yconn,
        open_rx,
        shutdown_rx,
        registry.clone(),
        handle,
        validator,
        validated,
    )
    .await;
    tracing::info!(%user, %devserver, "tunnel driver exited");
    Ok(())
}

/// The h2 frame driver of a dial that got past the pre-auth checks.
/// For an admitted tunnel it runs for the tunnel's whole life, so it
/// has no bound of its own. `outcome` resolves once: a value means the
/// tunnel registered and this loop carries on; a dropped sender means
/// the handler refused and returned, and with nothing else owning the
/// connection a peer holding the TCP open would keep this task and its
/// socket alive, so the refusal is drained and the connection closed
/// the way a pre-auth refusal is.
///
/// A correct client opens exactly one stream, so any further stream is
/// answered 409, and above `MAX_DRAINER_REJECTIONS` the connection is
/// shut down so a misbehaving peer cannot amplify load against the
/// listener.
async fn drive_tunnel_conn(
    mut conn: h2::server::Connection<TcpStream, bytes::Bytes>,
    mut outcome: oneshot::Receiver<()>,
) {
    let mut rejections: u32 = 0;
    let mut admitted = false;
    loop {
        let next = if admitted {
            conn.accept().await
        } else {
            tokio::select! {
                next = conn.accept() => next,
                verdict = &mut outcome => {
                    if verdict.is_err() {
                        drain_refused_conn(conn).await;
                        return;
                    }
                    admitted = true;
                    continue;
                }
            }
        };
        let Some(next) = next else {
            return;
        };
        if let Ok((_req, mut respond)) = next {
            let resp = Response::builder()
                .status(StatusCode::CONFLICT)
                .body(())
                .expect("constant response");
            let _ = respond.send_response(resp, true);
            rejections = rejections.saturating_add(1);
            if rejections >= MAX_DRAINER_REJECTIONS {
                tracing::warn!(
                    rejections,
                    "tunnel peer opened too many streams; abrupt shutdown",
                );
                conn.abrupt_shutdown(Reason::ENHANCE_YOUR_CALM);
                return;
            }
        }
    }
}

/// Flush a refused connection's final response and let the peer close,
/// bounded by `REJECTION_DRAIN_TIMEOUT`. The in-flight permit is
/// released before this runs: a refused peer gets the courtesy of a
/// clean close, not a slot to sit in.
async fn drain_refused_conn<T, B>(mut conn: h2::server::Connection<T, B>)
where
    T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    B: bytes::Buf,
{
    let drained = tokio::time::timeout(REJECTION_DRAIN_TIMEOUT, async {
        while conn.accept().await.is_some() {}
    })
    .await;
    if drained.is_err() {
        conn.abrupt_shutdown(Reason::NO_ERROR);
    }
}

/// Pull a Bearer token out of an Authorization header. Per RFC 6750
/// the scheme name is case-insensitive ("Bearer", "bearer", "BEARER"
/// all valid); some clients in the wild only emit lowercase, so a
/// strict prefix match would 401 them. The scheme / token separator
/// is one or more SP / HTAB (RFC 7230 BWS); a `split_once(' ')` rejects
/// otherwise-valid `Bearer\t<token>` or multi-space variants. Token
/// value is trimmed and rejected if empty.
fn extract_bearer<B>(request: &http::Request<B>) -> Option<String> {
    let raw = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())?
        .trim_start();
    let sep = raw.find([' ', '\t'])?;
    let scheme = &raw[..sep];
    if !scheme.eq_ignore_ascii_case("Bearer") {
        return None;
    }
    let token = raw[sep..].trim();
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        extract_bearer, handle_tunnel_conn, tunnel_h2_server_builder, REJECTION_DRAIN_TIMEOUT,
    };
    use std::sync::Arc;
    use std::time::Duration;

    use chan_tunnel_client::{ClientConfig, ClientError};
    use chan_tunnel_proto::{H2Duplex, TUNNEL_PATH};
    use h2::Ping;
    use http::header::AUTHORIZATION;
    use http::{Method, Request, StatusCode};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::Semaphore;

    use crate::{
        AllowAllAdmission, RegistrationAdmission, RegistrationPermit, Registry, ServerError,
        Validated, Validator, TUNNEL_SCOPE, VALIDATE_TIMEOUT,
    };

    /// Read one h2 frame as (frame type, stream id, payload).
    async fn read_h2_frame(stream: &mut TcpStream) -> (u8, u32, Vec<u8>) {
        let mut header = [0u8; 9];
        stream.read_exact(&mut header).await.expect("frame header");
        let len = u32::from_be_bytes([0, header[0], header[1], header[2]]) as usize;
        let stream_id =
            u32::from_be_bytes([header[5], header[6], header[7], header[8]]) & 0x7fff_ffff;
        let mut payload = vec![0u8; len];
        stream
            .read_exact(&mut payload)
            .await
            .expect("frame payload");
        (header[3], stream_id, payload)
    }

    /// The listener advertises the shared tunnel windows on the wire:
    /// the stream window in its first SETTINGS frame, and the
    /// connection raise as a stream-0 WINDOW_UPDATE over the h2
    /// default (65_535).
    #[tokio::test]
    async fn server_advertises_the_shared_h2_windows() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let serving = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut conn = tunnel_h2_server_builder()
                .handshake::<_, bytes::Bytes>(tcp)
                .await
                .expect("server h2 handshake");
            // Drive the connection so the queued SETTINGS/WINDOW_UPDATE
            // frames flush; ends when the test drops the client.
            while let Some(_next) = conn.accept().await {}
        });
        let mut client = TcpStream::connect(addr).await.unwrap();
        client
            .write_all(b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n")
            .await
            .unwrap();
        // An empty client SETTINGS completes the peer's side of the exchange.
        client
            .write_all(&[0, 0, 0, 0x4, 0, 0, 0, 0, 0])
            .await
            .unwrap();

        let mut initial_window = None;
        let mut connection_increment = None;
        for _ in 0..6 {
            let (frame_type, stream_id, payload) = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                read_h2_frame(&mut client),
            )
            .await
            .expect("server frames must arrive promptly");
            match frame_type {
                0x4 => {
                    assert_eq!(stream_id, 0);
                    for pair in payload.chunks_exact(6) {
                        let id = u16::from_be_bytes([pair[0], pair[1]]);
                        let value = u32::from_be_bytes([pair[2], pair[3], pair[4], pair[5]]);
                        if id == 0x4 {
                            initial_window = Some(value);
                        }
                    }
                }
                0x8 => {
                    assert_eq!(stream_id, 0);
                    connection_increment =
                        Some(u32::from_be_bytes(payload[..4].try_into().unwrap()) & 0x7fff_ffff);
                }
                _ => {}
            }
            if initial_window.is_some() && connection_increment.is_some() {
                break;
            }
        }
        assert_eq!(
            initial_window,
            Some(chan_tunnel_proto::TUNNEL_H2_STREAM_WINDOW)
        );
        assert_eq!(
            connection_increment,
            Some(chan_tunnel_proto::TUNNEL_H2_CONNECTION_WINDOW - 65_535)
        );
        drop(client);
        let _ = serving.await;
    }

    fn req_with_auth(value: &str) -> http::Request<()> {
        http::Request::builder()
            .header(AUTHORIZATION, value)
            .body(())
            .unwrap()
    }

    #[test]
    fn extract_bearer_canonical() {
        assert_eq!(
            extract_bearer(&req_with_auth("Bearer abc")).as_deref(),
            Some("abc")
        );
    }

    #[test]
    fn extract_bearer_case_insensitive() {
        for scheme in ["bearer", "BEARER", "BeArEr"] {
            assert_eq!(
                extract_bearer(&req_with_auth(&format!("{scheme} tok"))).as_deref(),
                Some("tok"),
                "scheme {scheme}",
            );
        }
    }

    #[test]
    fn extract_bearer_rejects_other_schemes() {
        assert!(extract_bearer(&req_with_auth("Basic dXNlcjpwYXNz")).is_none());
        assert!(extract_bearer(&req_with_auth("Token abc")).is_none());
    }

    #[test]
    fn extract_bearer_empty_or_whitespace_token_rejected() {
        assert!(extract_bearer(&req_with_auth("Bearer ")).is_none());
        assert!(extract_bearer(&req_with_auth("Bearer    ")).is_none());
    }

    #[test]
    fn extract_bearer_trims_token() {
        assert_eq!(
            extract_bearer(&req_with_auth("Bearer   spaced  ")).as_deref(),
            Some("spaced")
        );
    }

    #[test]
    fn extract_bearer_accepts_tab_separator() {
        assert_eq!(
            extract_bearer(&req_with_auth("Bearer\ttok")).as_deref(),
            Some("tok"),
        );
        // Mixed whitespace between scheme and token (BWS).
        assert_eq!(
            extract_bearer(&req_with_auth("Bearer \t tok")).as_deref(),
            Some("tok"),
        );
    }

    #[test]
    fn extract_bearer_accepts_leading_whitespace_in_header() {
        // Some clients/proxies prefix the value with whitespace;
        // the scheme should still be recognised.
        assert_eq!(
            extract_bearer(&req_with_auth("  Bearer tok")).as_deref(),
            Some("tok"),
        );
    }

    struct UnreachableValidator;

    #[async_trait::async_trait]
    impl Validator for UnreachableValidator {
        async fn validate(&self, _token: &str) -> Result<Validated, ServerError> {
            panic!("a pre-auth rejection must never reach the validator")
        }
    }

    /// Drive one connection into a pre-auth rejection, then leave the
    /// peer sitting on an open TCP connection the way an idle client
    /// does, and report whether the listener's in-flight slot came back
    /// while it sat there.
    async fn slot_returns_while_the_peer_holds_the_connection(
        request: Request<()>,
        expect: StatusCode,
    ) -> bool {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("local addr");
        // One slot, taken by this connection: whether it comes back is
        // the whole question, and a pool of one makes the answer exact.
        let inflight = Arc::new(Semaphore::new(1));
        let permit = inflight
            .clone()
            .try_acquire_owned()
            .expect("the pool starts with a free slot");
        let serving = tokio::spawn(async move {
            let (tcp, peer) = listener.accept().await.expect("accept");
            let _ = handle_tunnel_conn(
                tcp,
                peer,
                Arc::new(UnreachableValidator),
                Arc::new(AllowAllAdmission),
                Registry::new(),
                0,
                permit,
            )
            .await;
        });

        let tcp = TcpStream::connect(addr).await.expect("connect");
        let (mut send_request, connection) = h2::client::handshake(tcp)
            .await
            .expect("client h2 handshake");
        let driving = tokio::spawn(async move {
            let _ = connection.await;
        });
        let (response, _body) = send_request
            .send_request(request, true)
            .expect("send request");
        let response = tokio::time::timeout(Duration::from_secs(5), response)
            .await
            .expect("the rejection response never arrived")
            .expect("h2 response");
        assert_eq!(response.status(), expect);

        // `send_request` and the connection task are deliberately still
        // alive: nothing here closes the connection after the refusal.
        let returned = tokio::time::timeout(Duration::from_secs(2), inflight.acquire())
            .await
            .is_ok();
        drop(send_request);
        driving.abort();
        serving.abort();
        returned
    }

    #[tokio::test]
    async fn a_wrong_path_rejection_frees_the_inflight_slot() {
        let request = Request::builder()
            .method(Method::GET)
            .uri("http://tunnel.test/not-the-tunnel")
            .body(())
            .expect("request");
        assert!(
            slot_returns_while_the_peer_holds_the_connection(request, StatusCode::NOT_FOUND).await,
            "the 404 branch held the in-flight slot while the peer idled",
        );
    }

    #[tokio::test]
    async fn a_missing_bearer_rejection_frees_the_inflight_slot() {
        let request = Request::builder()
            .method(Method::POST)
            .uri(format!(
                "http://tunnel.test{}",
                chan_tunnel_proto::TUNNEL_PATH
            ))
            .body(())
            .expect("request");
        assert!(
            slot_returns_while_the_peer_holds_the_connection(request, StatusCode::UNAUTHORIZED)
                .await,
            "the 401 branch held the in-flight slot while the peer idled",
        );
    }

    /// How long a test gives the server to close a refused dial the peer
    /// is holding open: the refusal drain plus a margin that dwarfs any
    /// scheduling delay on a loaded test runner.
    const CLOSE_WINDOW: Duration = REJECTION_DRAIN_TIMEOUT.saturating_add(Duration::from_secs(5));

    #[derive(Clone, Copy)]
    enum Verdict {
        Admit,
        InvalidToken,
        NoTunnelScope,
        IdentityDown,
        Hang,
    }

    /// A validator that answers every token the same way, so each test
    /// reaches exactly one branch past the h2 driver spawn.
    struct ScriptedValidator(Verdict);

    #[async_trait::async_trait]
    impl Validator for ScriptedValidator {
        async fn validate(&self, _token: &str) -> Result<Validated, ServerError> {
            let scopes = match self.0 {
                Verdict::Admit => vec![TUNNEL_SCOPE.to_string()],
                Verdict::NoTunnelScope => Vec::new(),
                Verdict::InvalidToken => return Err(ServerError::InvalidToken),
                Verdict::IdentityDown => {
                    return Err(ServerError::Identity("identity service down".into()))
                }
                Verdict::Hang => std::future::pending().await,
            };
            Ok(Validated {
                user_id: uuid::Uuid::nil(),
                username: "alice".into(),
                devserver_id: "ds-1".into(),
                scopes,
                gateway_assertion_key: None,
                admission_lease: None,
                admission_lease_expires_at: None,
            })
        }
    }

    struct AtCapacityAdmission;

    #[async_trait::async_trait]
    impl RegistrationAdmission for AtCapacityAdmission {
        async fn admit_registration(
            &self,
            _hello: &chan_tunnel_proto::Hello,
            validated: &Validated,
            _registration_id: uuid::Uuid,
        ) -> Result<RegistrationPermit, ServerError> {
            Err(ServerError::AdmissionAtCapacity {
                user: validated.username.clone(),
            })
        }
    }

    fn client_config() -> ClientConfig {
        ClientConfig {
            tunnel_url: url::Url::parse("http://tunnel.test/v1/tunnel").expect("constant url"),
            token: "unused".into(),
            workspace: "devsrv".into(),
            name: None,
            client_version: "chan/test".into(),
            initial_backoff: Duration::from_millis(50),
            max_backoff: Duration::from_secs(1),
            dial_timeout: Duration::from_secs(5),
            events: None,
            proxy: None,
            max_concurrent_substreams: chan_tunnel_client::DEFAULT_MAX_CONCURRENT_SUBSTREAMS,
        }
    }

    /// A peer that dialled the tunnel, took its answer, and then keeps
    /// the TCP connection open: nothing in a test closes it, so only the
    /// server can.
    struct HeldDial {
        status: StatusCode,
        /// The tunnel stream when the answer was a 200.
        tunnel: Option<H2Duplex>,
        _request_body: Option<h2::SendStream<bytes::Bytes>>,
        _send_request: h2::client::SendRequest<bytes::Bytes>,
        ping_pong: h2::PingPong,
        /// The client h2 connection: it finishes only when the server
        /// closes the socket.
        connection: tokio::task::JoinHandle<()>,
        serving: tokio::task::JoinHandle<Result<(), ServerError>>,
    }

    async fn dial_and_hold(
        validator: Arc<dyn Validator>,
        admission: Arc<dyn RegistrationAdmission>,
        registry: Arc<Registry>,
    ) -> HeldDial {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("local addr");
        let permit = Arc::new(Semaphore::new(1))
            .try_acquire_owned()
            .expect("the pool starts with a free slot");
        let serving = tokio::spawn(async move {
            let (tcp, peer) = listener.accept().await.expect("accept");
            handle_tunnel_conn(tcp, peer, validator, admission, registry, 0, permit).await
        });

        let tcp = TcpStream::connect(addr).await.expect("connect");
        let (mut send_request, mut connection) = h2::client::handshake(tcp)
            .await
            .expect("client h2 handshake");
        let ping_pong = connection
            .ping_pong()
            .expect("a fresh connection hands out its PingPong");
        let connection = tokio::spawn(async move {
            let _ = connection.await;
        });
        let request = Request::builder()
            .method(Method::POST)
            .uri(format!("http://tunnel.test{TUNNEL_PATH}"))
            .header(AUTHORIZATION, "Bearer well-formed-but-bogus")
            .body(())
            .expect("request");
        let (response, request_body) = send_request
            .send_request(request, false)
            .expect("send request");
        let response = tokio::time::timeout(VALIDATE_TIMEOUT + Duration::from_secs(5), response)
            .await
            .expect("the dial was never answered")
            .expect("h2 response");
        let status = response.status();
        let (tunnel, request_body) = if status == StatusCode::OK {
            (
                Some(H2Duplex::new(request_body, response.into_body())),
                None,
            )
        } else {
            (None, Some(request_body))
        };
        HeldDial {
            status,
            tunnel,
            _request_body: request_body,
            _send_request: send_request,
            ping_pong,
            connection,
            serving,
        }
    }

    /// The handler has refused and returned; the peer still holds the
    /// TCP open. The server must close it within `CLOSE_WINDOW`. The
    /// observation is the client connection finishing, which happens
    /// only on EOF, a reset or a GOAWAY from the server, and never on
    /// the client's own account because the test holds every client
    /// handle. When it does not finish, a PING is sent so the failure
    /// says whether a server task is still driving the connection.
    async fn assert_the_server_closes_the_held_dial(
        mut held: HeldDial,
        expect: StatusCode,
        what: &str,
    ) {
        assert_eq!(held.status, expect, "{what}: refusal status");
        let handler = tokio::time::timeout(Duration::from_secs(5), &mut held.serving)
            .await
            .unwrap_or_else(|_| panic!("{what}: the handler did not return after refusing"))
            .expect("handler task");
        assert!(handler.is_err(), "{what}: the handler reported success");
        let closed = tokio::time::timeout(CLOSE_WINDOW, &mut held.connection)
            .await
            .is_ok();
        if !closed {
            let pong =
                tokio::time::timeout(Duration::from_secs(2), held.ping_pong.ping(Ping::opaque()))
                    .await;
            panic!(
                "{what}: the handler returned, and {CLOSE_WINDOW:?} later the server still holds \
                 the refused connection open (PING answered: {})",
                matches!(pong, Ok(Ok(_))),
            );
        }
    }

    #[tokio::test]
    async fn an_invalid_token_refusal_closes_the_held_connection() {
        let held = dial_and_hold(
            Arc::new(ScriptedValidator(Verdict::InvalidToken)),
            Arc::new(AllowAllAdmission),
            Registry::new(),
        )
        .await;
        assert_the_server_closes_the_held_dial(held, StatusCode::UNAUTHORIZED, "invalid token")
            .await;
    }

    #[tokio::test]
    async fn a_missing_scope_refusal_closes_the_held_connection() {
        let held = dial_and_hold(
            Arc::new(ScriptedValidator(Verdict::NoTunnelScope)),
            Arc::new(AllowAllAdmission),
            Registry::new(),
        )
        .await;
        assert_the_server_closes_the_held_dial(held, StatusCode::UNAUTHORIZED, "missing scope")
            .await;
    }

    #[tokio::test]
    async fn an_identity_error_refusal_closes_the_held_connection() {
        let held = dial_and_hold(
            Arc::new(ScriptedValidator(Verdict::IdentityDown)),
            Arc::new(AllowAllAdmission),
            Registry::new(),
        )
        .await;
        assert_the_server_closes_the_held_dial(held, StatusCode::BAD_GATEWAY, "identity error")
            .await;
    }

    #[tokio::test]
    async fn a_validator_timeout_refusal_closes_the_held_connection() {
        let held = dial_and_hold(
            Arc::new(ScriptedValidator(Verdict::Hang)),
            Arc::new(AllowAllAdmission),
            Registry::new(),
        )
        .await;
        assert_the_server_closes_the_held_dial(
            held,
            StatusCode::GATEWAY_TIMEOUT,
            "validator timeout",
        )
        .await;
    }

    /// A refusal after the 200 (here admission, in the Hello exchange)
    /// is a refusal all the same: nothing was registered.
    #[tokio::test]
    async fn an_admission_refusal_after_the_200_closes_the_held_connection() {
        let mut held = dial_and_hold(
            Arc::new(ScriptedValidator(Verdict::Admit)),
            Arc::new(AtCapacityAdmission),
            Registry::new(),
        )
        .await;
        let tunnel = held
            .tunnel
            .take()
            .expect("a validated dial gets its 200 before admission");
        let refused = tokio::time::timeout(
            Duration::from_secs(5),
            chan_tunnel_client::handshake(&client_config(), tunnel),
        )
        .await
        .expect("no HelloAck");
        assert!(
            matches!(refused, Err(ClientError::RemoteRefusal { .. })),
            "admission must refuse in the HelloAck: {:?}",
            refused.err(),
        );
        assert_the_server_closes_the_held_dial(held, StatusCode::OK, "admission refusal").await;
    }

    /// The task that ends a refused dial is also the admitted tunnel's
    /// h2 driver for the tunnel's whole life, so an admitted tunnel must
    /// stay up and carry traffic well past the point where a refused dial
    /// is closed.
    #[tokio::test]
    async fn an_admitted_tunnel_stays_up_past_the_refusal_close_window() {
        use futures::{AsyncReadExt as _, AsyncWriteExt as _};

        let registry = Registry::new();
        let mut held = dial_and_hold(
            Arc::new(ScriptedValidator(Verdict::Admit)),
            Arc::new(AllowAllAdmission),
            registry.clone(),
        )
        .await;
        assert_eq!(held.status, StatusCode::OK);
        let tunnel = held.tunnel.take().expect("an admitted dial gets its 200");
        let (_registration, mut yamux) = tokio::time::timeout(
            Duration::from_secs(5),
            chan_tunnel_client::handshake(&client_config(), tunnel),
        )
        .await
        .expect("no HelloAck")
        .expect("admitted handshake");
        // The devserver side: echo every substream the gateway opens.
        let _peer = tokio::spawn(async move {
            while let Some(Ok(stream)) =
                futures::future::poll_fn(|cx| yamux.poll_next_inbound(cx)).await
            {
                tokio::spawn(async move {
                    let (mut reader, mut writer) = stream.split();
                    let mut buf = [0u8; 64];
                    while let Ok(n) = reader.read(&mut buf).await {
                        if n == 0
                            || writer.write_all(&buf[..n]).await.is_err()
                            || writer.flush().await.is_err()
                        {
                            break;
                        }
                    }
                });
            }
        });
        let mut registered = false;
        for _ in 0..100 {
            if registry.get("alice", "ds-1").is_some() {
                registered = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(registered, "the admitted tunnel never registered");

        tokio::time::sleep(CLOSE_WINDOW).await;

        assert!(
            !held.connection.is_finished(),
            "the server closed an admitted tunnel",
        );
        assert!(!held.serving.is_finished(), "the tunnel handler returned");
        let handle = registry
            .get("alice", "ds-1")
            .expect("the admitted tunnel is still registered");
        let mut stream = tokio::time::timeout(Duration::from_secs(5), handle.open())
            .await
            .expect("substream open timed out")
            .expect("substream open");
        let echoed = tokio::time::timeout(Duration::from_secs(5), async {
            stream.write_all(b"still up").await?;
            stream.flush().await?;
            let mut echoed = [0u8; 8];
            stream.read_exact(&mut echoed).await?;
            Ok::<_, std::io::Error>(echoed)
        })
        .await
        .expect("substream echo timed out")
        .expect("substream echo");
        assert_eq!(&echoed, b"still up");
        tokio::time::timeout(Duration::from_secs(5), held.ping_pong.ping(Ping::opaque()))
            .await
            .expect("PING timed out")
            .expect("PONG");
    }

    /// `accept(2)` fails for reasons that say nothing about the listening
    /// socket: a peer that reset before it was accepted, or a process
    /// out of descriptors under exactly the flood this listener exists to
    /// absorb. The embedding proxy treats the loop returning as the
    /// listener dying and takes every tunnel on the node down with it,
    /// so neither failure may end the loop, and the next connection must
    /// still be served.
    #[tokio::test]
    async fn a_transient_accept_failure_does_not_end_the_listener() {
        let listener = Arc::new(TcpListener::bind("127.0.0.1:0").await.expect("bind"));
        let addr = listener.local_addr().expect("local addr");
        // Popped from the back: a failure for one connection, then one
        // that means the process is out of a resource.
        let injected = Arc::new(std::sync::Mutex::new(vec![
            std::io::Error::from(std::io::ErrorKind::OutOfMemory),
            std::io::Error::from(std::io::ErrorKind::ConnectionAborted),
        ]));
        let accept = {
            let injected = injected.clone();
            move || {
                let failure = injected.lock().expect("injected failures").pop();
                let listener = listener.clone();
                async move {
                    match failure {
                        Some(error) => Err(error),
                        None => listener.accept().await,
                    }
                }
            }
        };
        let serving = tokio::spawn(super::serve_accepted(
            accept,
            Arc::new(UnreachableValidator),
            Arc::new(AllowAllAdmission),
            Registry::new(),
            0,
        ));

        let status = tokio::time::timeout(Duration::from_secs(10), async {
            let tcp = TcpStream::connect(addr).await?;
            let (mut send_request, connection) = h2::client::handshake(tcp)
                .await
                .map_err(std::io::Error::other)?;
            tokio::spawn(async move {
                let _ = connection.await;
            });
            let request = Request::builder()
                .method(Method::GET)
                .uri("http://tunnel.test/not-the-tunnel")
                .body(())
                .expect("request");
            let (response, _body) = send_request
                .send_request(request, true)
                .map_err(std::io::Error::other)?;
            let response = response.await.map_err(std::io::Error::other)?;
            Ok::<_, std::io::Error>(response.status())
        })
        .await;
        if serving.is_finished() {
            panic!(
                "the accept loop ended on an injected failure: {:?}",
                serving.await.expect("serving task")
            );
        }
        assert!(
            injected.lock().expect("injected failures").is_empty(),
            "the loop did not consume both injected failures",
        );
        let status = status
            .expect("the connection after the failures was never served")
            .expect("h2 exchange");
        assert_eq!(status, StatusCode::NOT_FOUND);
        serving.abort();
    }
}
