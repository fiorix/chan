//! Tunnel listener: accepts h2c POSTs from `chan devserver` clients
//! and registers them in the shared `Registry`.
//!
//! nginx terminates TLS for `devserver.chan.app` and `grpc_pass`es
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
    let mut conn =
        match tokio::time::timeout(H2_HANDSHAKE_TIMEOUT, h2::server::handshake(tcp)).await {
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
    use super::extract_bearer;
    use http::header::AUTHORIZATION;

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
