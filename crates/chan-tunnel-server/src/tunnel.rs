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
//! peer closes.
use std::net::SocketAddr;
use std::sync::Arc;

use chan_tunnel_proto::{H2Duplex, TUNNEL_PATH};
use h2::Reason;
use http::{header, Method, Response, StatusCode};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;

use crate::driver::workspace_tunnel;
use crate::registry::Registry;
use crate::{
    handshake_validated_with_admission, RegistrationAdmission, RegistrationPermit, ServerError,
    Validated, Validator, FIRST_STREAM_TIMEOUT, H2_HANDSHAKE_TIMEOUT, MAX_INFLIGHT_HANDSHAKES,
    TUNNEL_SCOPE, VALIDATE_TIMEOUT,
};

struct LocalAdmission {
    registry: Arc<Registry>,
    max_workspaces_per_user: usize,
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
    async fn admit(
        &self,
        _hello: &chan_tunnel_proto::Hello,
        validated: &Validated,
    ) -> Result<RegistrationPermit, ServerError> {
        if self.max_workspaces_per_user > 0 {
            let registered = self.registry.list_workspaces_for(&validated.username);
            let already_present = registered
                .iter()
                .any(|row| row.workspace.as_ref() == validated.devserver_id.as_str());
            if !already_present && registered.len() >= self.max_workspaces_per_user {
                return Err(ServerError::TooManyWorkspaces {
                    user: validated.username.clone(),
                    max: self.max_workspaces_per_user,
                });
            }
        }
        Ok(RegistrationPermit {
            request_id: uuid::Uuid::new_v4(),
            registration_id: uuid::Uuid::new_v4(),
            admission_epoch: 0,
        })
    }
}

/// How many "stream beyond the first" rejections the drainer task
/// will tolerate before tearing down the whole h2 connection with
/// ENHANCE_YOUR_CALM. A correct client opens exactly one stream
/// (the tunnel POST); a peer that keeps opening more is misbehaving
/// or attempting to amplify load against the listener.
const MAX_DRAINER_REJECTIONS: u32 = 16;

/// Accept loop for a TCP listener bound to a tunnel-only port.
/// Returns only when the listener errors; per-connection failures
/// are logged and never bubble up.
///
/// `max_workspaces_per_user` caps the number of distinct workspaces a
/// single user may have registered concurrently. `0` disables the
/// limit. A reconnect of a workspace the user already has registered is
/// always allowed; the registry's last-writer-wins policy evicts
/// the stale entry before the count is checked again.
pub async fn serve_tunnel_listener(
    listener: TcpListener,
    validator: Arc<dyn Validator>,
    registry: Arc<Registry>,
    max_workspaces_per_user: usize,
) -> std::io::Result<()> {
    serve_tunnel_listener_with_admission(
        listener,
        validator,
        Arc::new(LocalAdmission {
            registry: registry.clone(),
            max_workspaces_per_user,
        }),
        registry,
        max_workspaces_per_user,
    )
    .await
}

pub async fn serve_tunnel_listener_with_admission(
    listener: TcpListener,
    validator: Arc<dyn Validator>,
    admission: Arc<dyn RegistrationAdmission>,
    registry: Arc<Registry>,
    max_workspaces_per_user: usize,
) -> std::io::Result<()> {
    // Cap concurrent in-flight handshakes. The permit is held only
    // through the authenticate-and-handshake stages; once the
    // per-tunnel driver takes over (workspace_tunnel), the permit is
    // dropped and the slot frees up for the next dial. This bounds
    // memory / task count against floods of half-open or slow peers.
    let inflight = Arc::new(Semaphore::new(MAX_INFLIGHT_HANDSHAKES));
    loop {
        let (tcp, peer) = listener.accept().await?;
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
                max_workspaces_per_user,
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

/// Workspace a single client's h2 connection through accept,
/// validate, handshake, register, and tunnel-driver lifecycle.
async fn handle_tunnel_conn(
    tcp: TcpStream,
    peer: SocketAddr,
    validator: Arc<dyn Validator>,
    admission: Arc<dyn RegistrationAdmission>,
    registry: Arc<Registry>,
    max_workspaces_per_user: usize,
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
        // Drain any further streams so the peer's GOAWAY arrives
        // cleanly; we don't expect any.
        while conn.accept().await.is_some() {}
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
            while conn.accept().await.is_some() {}
            return Ok(());
        }
    };

    let (_parts, recv_body) = request.into_parts();

    // Spawn the h2 frame driver BEFORE we await on the validator.
    // The h2 connection only makes progress while somebody is
    // polling it; the validate call is potentially a network round
    // trip to the identity service, and without an active driver
    // the connection would stall (no PINGs, no frame parsing).
    // The drainer also rejects any stream beyond the first one
    // (clients should only ever open the tunnel POST). It counts
    // those rejections and abrupt-shutdowns the connection above
    // `MAX_DRAINER_REJECTIONS` so a misbehaving authenticated peer
    // cannot indefinitely amplify load against the listener.
    tokio::spawn(async move {
        let mut rejections: u32 = 0;
        while let Some(rs) = conn.accept().await {
            if let Ok((_req, mut respond)) = rs {
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
                    break;
                }
            }
        }
    });

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
        max_workspaces_per_user,
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
            return Err(ServerError::TooManyWorkspaces {
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

    workspace_tunnel(
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
    use super::{extract_bearer, tunnel_h2_server_builder};
    use http::header::AUTHORIZATION;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

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
}
