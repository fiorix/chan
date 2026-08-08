//! Reverse proxy for the node wildcard (`{user}--{disc}.p1.usr.chan.app/{workspace}/...`)
//! into the `chan devserver` peer behind the registered tunnel.
//!
//! `{user}` and the optional `{disc}` (first 12 hex chars of a
//! devserver id, in the `{user}--{disc}` host form) are parsed out of
//! the wildcard `Host` header by `http::dispatch` and handed in. A
//! user can hold many live devservers; a disc host addresses one of
//! them by id prefix, and a bare `{user}` host resolves through the
//! gate credential's `drv` claim (the single-live-devserver case).
//! The gate is per-DEVSERVER: the `{workspace}` path segment is
//! tenant routing only, never a gate key. It is forwarded into the
//! tunnel unchanged and the devserver routes the tenant internally.
//!
//! Auth gate, in this order:
//!
//!   * an entry-exchange path with the wrong method, Origin, or Content-Type
//!     -> 404 / 403 / 415 before consulting live registry state
//!   * no live devserver registration matching the host (`{user}`,
//!     and the `{disc}` prefix when present) -> 404
//!   * `/api/devserver/*` (the local-only management API) -> 404
//!   * identity-origin POST to the fixed entry exchange path: verify the
//!     Ed25519 credential and exact bindings, atomically consume its `jti`,
//!     mint an opaque proxy-local session, set host-only gate/CSRF cookies,
//!     and 303 to the signed clean path
//!   * the exact extension capability shape
//!     (`/{tenant}/_chan/extensions/{id}/{64-hex}/...`) -> forwarded
//!     without the session gate; the devserver's own per-process path
//!     capability check is the authorization, and every response on
//!     that namespace carries the extension response policy so the
//!     opaque-origin frame can read the true status
//!   * request has a valid opaque `__Host-devserver_gate` cookie (aud + drv bound)
//!     -> pass through
//!   * anything else (no cookie, expired, wrong aud, wrong devserver)
//!     -> 404
//!
//! The auth assertion is the entry JWT, not "sub matches owner". Identity
//! mints entry tokens only after calling `profile.devserver_access(owner,
//! devserver, caller)`, so a validly-signed entry with the right aud and drv
//! proves the caller is authorized, owner or accepted grantee. The aud
//! claim (= the tenant host, `{owner}--{disc}.p1.usr.chan.app`) is what enforces tenant isolation;
//! comparing `sub` against the cached owner would lock out every grantee.
//!
//! 404 is preferred over 401 / 403 on the proxy path so an
//! unauthenticated probe cannot distinguish "devserver does not exist"
//! from "devserver exists but you are not signed in" or "wrong devserver in
//! the cookie." Owners returning after the one-hour maximum session expires bounce
//! through the gateway dashboard on the identity origin.
//!
//! Two transports, both ride a fresh yamux substream opened on the
//! registered `TunnelHandle`:
//!   * HTTP: hyper h1 client over the substream.
//!   * WebSocket: tungstenite's `client_async` runs the WS handshake
//!     directly on the substream.

use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::task::{Context, Poll};

use axum::body::Body;
use axum::extract::ws::{CloseFrame, Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, FromRequestParts, Request};
use axum::http::{
    header, request::Parts, HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri,
};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use chan_tunnel_proto::gateway_assertion;
use chan_tunnel_server::TunnelHandle;
use futures_util::{SinkExt, StreamExt};
use gateway_common::devserver_gate;
use http_body_util::Limited;
use hyper_util::rt::TokioIo;
use rand::RngCore;
use subtle::ConstantTimeEq;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode as TgCloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame as TgCloseFrame;
use tokio_tungstenite::tungstenite::Message as TgMessage;
use tokio_tungstenite::tungstenite::Utf8Bytes as TgUtf8Bytes;
use tokio_util::compat::FuturesAsyncReadCompatExt;
use uuid::Uuid;

use crate::error::{Error, Result};
use crate::http::AppState;
use crate::registry::Entry;
use crate::session_store::{ActiveOperation, SessionPrincipal, SessionRecord};

/// Wraps a response body with a hard deadline shared with the
/// `proxy_http` send_request timeout. If the upstream goes silent or
/// slow-drips bytes past the deadline, the body errors out (axum
/// closes the client connection). Without this, `request_timeout`
/// only covered headers and an unbounded-time body stream could hold
/// the substream open up to `max_response_bytes`.
///
/// Also owns an `AbortHandle` for the upstream hyper connection task
/// (`conn.with_upgrades()`). The conn task must outlive header
/// receipt so the body can stream, but must not outlive the body
/// (otherwise an aborted client request leaks a yamux substream
/// until the upstream closes on its own). Dropping the body aborts
/// the conn task; finishing the stream first lets the task exit
/// naturally and the abort is a no-op.
///
/// `axum::body::Body` is `Unpin` (boxes internally), and the boxed
/// `tokio::time::Sleep` is pinned at construction time, so the impl
/// avoids pin-projection plumbing.
struct DeadlineBody {
    inner: Body,
    sleep: Pin<Box<tokio::time::Sleep>>,
    cancelled: Pin<Box<dyn Future<Output = ()> + Send>>,
    /// Abort handle for the upstream conn task. Wrapped in
    /// `tokio_util::task::AbortOnDropHandle`? No: we want the abort
    /// to fire on body drop regardless of whether the stream
    /// completed normally (a completed conn task is a no-op on
    /// abort). Stored directly so the Drop impl can reach it.
    conn: Option<tokio::task::AbortHandle>,
}

impl DeadlineBody {
    fn new(
        inner: Body,
        deadline: tokio::time::Instant,
        cancellation: tokio_util::sync::CancellationToken,
        conn: tokio::task::AbortHandle,
    ) -> Self {
        Self {
            inner,
            sleep: Box::pin(tokio::time::sleep_until(deadline)),
            cancelled: Box::pin(cancellation.cancelled_owned()),
            conn: Some(conn),
        }
    }
}

impl Drop for DeadlineBody {
    fn drop(&mut self) {
        if let Some(c) = self.conn.take() {
            // Aborts an already-finished task as a no-op; aborts an
            // in-flight one so a leaking client doesn't strand the
            // upstream yamux substream.
            c.abort();
        }
    }
}

impl http_body::Body for DeadlineBody {
    type Data = bytes::Bytes;
    type Error = axum::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<std::result::Result<http_body::Frame<Self::Data>, Self::Error>>> {
        if self.sleep.as_mut().poll(cx).is_ready() {
            tracing::warn!("proxy response body exceeded authorization/request deadline");
            return Poll::Ready(Some(Err(axum::Error::new(
                "response body exceeded authorization/request deadline",
            ))));
        }
        if self.cancelled.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Some(Err(axum::Error::new(
                "browser session authorization revoked",
            ))));
        }
        Pin::new(&mut self.inner).poll_frame(cx)
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> http_body::SizeHint {
        self.inner.size_hint()
    }
}

/// Cookie name for the session-shape devserver-gate token. Host-only on
/// the tenant host (`{user}--{disc}.p1.usr.chan.app`); `Path=/`; HttpOnly; Secure; SameSite=Lax;
/// Absolute proxy-local session lifetime. The `__Host-` prefix makes the
/// browser enforce exactly that shape (Secure, no `Domain`, `Path=/`), so
/// a parent-domain cookie of the same name can never shadow it (A11).
const COOKIE_NAME: &str = "__Host-devserver_gate";
const CSRF_COOKIE_NAME: &str = "__Host-devserver_csrf";
/// Pre-A11 cookie names. The proxy never reads them, but upstream
/// `Set-Cookie` on these names stays stripped: allowing a devserver to
/// mint look-alike session cookies would only invite confusion.
const LEGACY_COOKIE_NAME: &str = "devserver_gate";
const LEGACY_CSRF_COOKIE_NAME: &str = "devserver_csrf";
const CSRF_HEADER_NAME: &str = "x-chan-csrf";
const ENTRY_FORM_CONTENT_TYPE: &str = "application/x-www-form-urlencoded";
const MAX_ENTRY_FORM_BYTES: usize = 8192;

/// Hop-by-hop headers we strip on both legs (RFC 7230 6.1).
/// Match is on the lowercase header name string; `HeaderName` can
/// not live in a const slice due to interior-mutability rules on
/// borrowed temporaries, so we compare via `as_str()`.
const HOP_BY_HOP_NAMES: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

fn is_hop_by_hop(name: &HeaderName) -> bool {
    HOP_BY_HOP_NAMES.contains(&name.as_str())
}

/// Parse the inbound `Connection` header into the list of header
/// names it marks as hop-by-hop. The caller strips each returned name
/// on top of the static HOP_BY_HOP_NAMES list (RFC 7230 6.1 §3).
fn connection_listed_headers(headers: &HeaderMap) -> Vec<HeaderName> {
    headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        // "close" / "keep-alive" are connection options, not headers.
        .filter(|s| !s.eq_ignore_ascii_case("close") && !s.eq_ignore_ascii_case("keep-alive"))
        .filter_map(|s| HeaderName::from_bytes(s.to_ascii_lowercase().as_bytes()).ok())
        .collect()
}

/// Entry point from `http::dispatch`. `user` and `disc` came out of
/// the wildcard Host header. The gate is per-DEVSERVER: the request
/// resolves to one of the user's live registrations and the gate
/// verifies the credential's `drv` claim against that devserver id.
/// It does NOT peel a path segment. The `{workspace}` path segment is
/// tenant routing only and is forwarded into the tunnel unchanged.
/// axum's extractors are not used at this level because the
/// dispatcher already consumed `Host`.
///
/// Devserver resolution:
///
///   * disc host (`{user}--{disc}`): the unique live devserver id
///     with that 12-hex prefix; zero or ambiguous matches -> 404.
///   * bare host (`{user}`): every live devserver is a candidate and
///     the gate picks the one the request's credential was minted
///     for (the signed `drv` claim), bounded by the user's live set.
///     A single live devserver keeps the pre-disc behavior; no
///     verifying credential -> 404.
pub async fn handle(state: AppState, user: String, disc: Option<String>, req: Request) -> Response {
    // Classify the extension capability lane up front: every response
    // leaving that namespace, from the gate 404s through the proxied
    // reply and the cancellation paths inside `proxy_http`, must carry
    // the extension response policy or the opaque-origin frame reads
    // the true status as a CORS violation.
    let extension_capability = is_extension_capability_path(req.uri().path());
    let mut response = handle_gated(state, user, disc, req, extension_capability).await;
    if extension_capability {
        apply_extension_capability_response_policy(&mut response);
    }
    response
}

async fn handle_gated(
    state: AppState,
    user: String,
    disc: Option<String>,
    mut req: Request,
    extension_capability: bool,
) -> Response {
    let is_entry_exchange = req.uri().path() == devserver_gate::ENTRY_EXCHANGE_PATH;
    let entry_credential = if is_entry_exchange {
        if let Some(response) = entry_preflight(&req, &state.cfg) {
            return response;
        }
        match read_entry_credential(&mut req).await {
            Ok(credential) => Some(credential),
            Err(response) => return response,
        }
    } else {
        None
    };

    let candidates: Vec<(String, Entry)> = match &disc {
        Some(d) => state
            .registry
            .get_user_devserver_by_prefix(&user, d)
            .into_iter()
            .collect(),
        None => state
            .registry
            .live_devserver_ids(&user)
            .into_iter()
            .filter_map(|id| state.registry.get(&user, &id).map(|entry| (id, entry)))
            .collect(),
    };
    if candidates.is_empty() {
        return if is_entry_exchange {
            entry_not_found_response()
        } else {
            not_found_response(req.headers())
        };
    }

    // A bare host with many live devservers must not turn one invalid entry
    // POST into an Ed25519 verification loop over the whole per-user fleet.
    // Production entry URLs carry a discriminator; retaining the one-route
    // legacy case keeps that path bounded to exactly one verification.
    if is_entry_exchange && disc.is_none() && candidates.len() != 1 {
        return entry_not_found_response();
    }

    // The management API is local-only; the proxy carries tenant content
    // only and never proxies `/api/devserver/*` on the public wildcard.
    if is_management_path(req.uri().path()) {
        return not_found_response(req.headers());
    }

    // The audience is the inbound Host. Tokens minted for one
    // subdomain do not validate on another, so a credential for
    // another user's devserver never verifies here regardless of
    // which candidate it is tried against.
    let aud = chan_tunnel_proto::gateway_assertion::canonical_audience(
        &state.cfg.forwarded_proto,
        &host_header(req.headers()).unwrap_or_default(),
    );

    if let Some(credential) = entry_credential {
        return exchange_entry(&state, candidates, &credential, &aud);
    }

    let is_ws = is_websocket_upgrade(req.headers());

    let (devserver_id, entry, caller, authorization) = if extension_capability {
        // Extension capability lane: the 256-bit path segment is the
        // credential and the devserver's own capability check is the
        // authorization (a miss produces its 404, CORS-readable under
        // the extension response policy). The session gate, the CSRF
        // check, and the WS Origin check all protect cookie-borne
        // authority; the opaque-origin extension frame can never send
        // that cookie, so none of them apply on this lane. The
        // assertion carries a nil subject: capability callers stay
        // non-owner, so the devserver's tunnel lane keeps them
        // read-only exactly like any guest.
        if candidates.len() != 1 {
            // A bare host with several live devservers cannot bind a
            // capability path to one tunnel; answer the same
            // anti-enumeration shape as the session gate.
            return not_found_response(req.headers());
        }
        let (devserver_id, entry) = candidates.into_iter().next().expect("one candidate");
        let caller = GatewayCaller {
            sub: Uuid::nil(),
            owner_user_id: entry.owner_id,
        };
        let authorization = SessionRecord::capability_lane(SessionPrincipal {
            subject_user_id: Uuid::nil(),
            owner_user_id: entry.owner_id,
            devserver_id: devserver_id.clone(),
            audience: aud.clone(),
        });
        (devserver_id, entry, caller, authorization)
    } else {
        // The gate always runs: every devserver tunnel is authenticated,
        // there is no un-gated pass-through. The first candidate whose
        // credential verifies under (aud, drv) wins.
        let mut resolved = None;
        for (devserver_id, entry) in candidates {
            match resolve_gate(&state, &req, &devserver_id, entry.owner_id, &aud) {
                Gate::Reject => continue,
                gate => {
                    resolved = Some((devserver_id, entry, gate));
                    break;
                }
            }
        }
        let Some((devserver_id, entry, gate)) = resolved else {
            return not_found_response(req.headers());
        };
        let (caller, authorization) = match gate {
            Gate::Pass { record } => (
                GatewayCaller {
                    sub: record.principal.subject_user_id,
                    owner_user_id: record.principal.owner_user_id,
                },
                record,
            ),
            // The loop above filtered rejects; kept as the safe default.
            Gate::Reject => return not_found_response(req.headers()),
        };
        if is_ws && !websocket_origin_matches(req.headers(), &state.cfg.forwarded_proto, &aud) {
            tracing::warn!(
                aud = %aud,
                devserver_id = %devserver_id,
                "gateway websocket origin check failed",
            );
            return (StatusCode::FORBIDDEN, "forbidden").into_response();
        }
        if requires_csrf(req.method()) && !csrf_header_matches_cookie(req.headers()) {
            tracing::warn!(
                aud = %aud,
                devserver_id = %devserver_id,
                method = %req.method(),
                "gateway csrf check failed",
            );
            return (StatusCode::FORBIDDEN, "forbidden").into_response();
        }
        (devserver_id, entry, caller, authorization)
    };
    // Every request entering a devserver tunnel must carry a signed gateway
    // assertion. A registration without a per-tunnel assertion key is an
    // invalid trust state, not a reason to downgrade to an unauthenticated
    // upstream request.
    let assertion = match gateway_assertion_value(
        entry.handle.gateway_assertion_key.as_ref(),
        &caller,
        &aud,
        &devserver_id,
    ) {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    let Some(operation) = authorization.begin_operation() else {
        return not_found_response(req.headers());
    };
    // Segment-preserving forward: hand the devserver the full public
    // `/{workspace}/...` path. Entry credentials are accepted only at the
    // fixed body-only exchange endpoint, so tenant query parameters remain
    // ordinary upstream application data.
    let upstream_path_and_query = forward_path(req.uri());
    let extension_frame = is_extension_proxy_path(&upstream_path_and_query);
    let policy = route_body_policy(&state.cfg, req.method(), &upstream_path_and_query);

    if is_ws {
        let (mut parts, body) = req.into_parts();
        // Pull WebSocketUpgrade out of the parts now that we've
        // gated. axum's extractor checks the upgrade headers we
        // already saw; failures here are malformed-upgrade clients.
        let upgrade = match WebSocketUpgrade::from_request_parts(&mut parts, &()).await {
            Ok(u) => u,
            Err(rej) => {
                tracing::debug!(error = %rej, "ws upgrade extractor refused");
                return rej.into_response();
            }
        };
        let forwarded = forwarded_headers(&parts, &state.cfg.forwarded_proto);
        let handle = entry.handle.clone();
        let idle_timeout = state.cfg.ws_idle_timeout;
        let cancellation = authorization.cancellation.clone();
        let expires_at = authorization.expires_at;
        let (client_tx, client_rx) = tokio::sync::oneshot::channel();
        let bridge = operation.spawn(async move {
            let Ok(client) = client_rx.await else {
                return;
            };
            if let Err(e) = bridge_ws(
                client,
                handle,
                &upstream_path_and_query,
                &forwarded,
                BridgePolicy {
                    assertion,
                    idle_timeout,
                    cancellation,
                    expires_at,
                },
            )
            .await
            {
                tracing::warn!(error = ?e, "ws bridge ended with error");
            }
        });
        // Detaching is intentional: the session operation registry owns the
        // task's AbortHandle and revocation waits until its guard is dropped.
        drop(bridge);
        let _ = body; // upgrade swallows the body anyway.
        return upgrade
            .on_upgrade(move |client| async move {
                let _ = client_tx.send(client);
            })
            .into_response();
    }

    let opts = ProxyOpts {
        max_request_bytes: policy.max_request_bytes,
        max_response_bytes: policy.max_response_bytes,
        request_timeout: policy.request_timeout,
        authorization: &authorization,
        forwarded_proto: state.cfg.forwarded_proto.as_str(),
        assertion,
    };
    let res = proxy_http(
        entry.handle.clone(),
        req,
        upstream_path_and_query,
        opts,
        operation,
    )
    .await;
    match res {
        Ok(mut response) => {
            apply_credentialed_response_policy(&mut response, extension_frame);
            response
        }
        Err(e) => e.into_response(),
    }
}

fn exchange_entry(
    state: &AppState,
    candidates: Vec<(String, Entry)>,
    token: &str,
    aud: &str,
) -> Response {
    for (devserver_id, entry) in candidates {
        let Ok(claims) = devserver_gate::decode_entry(
            &state.cfg.entry_verifiers,
            token,
            state.cfg.proxy_id.as_str(),
            aud,
            &devserver_id,
            entry.owner_id,
        ) else {
            continue;
        };
        match state.entry_replays.consume(
            claims.jti,
            claims.sub,
            claims
                .exp
                .saturating_add(devserver_gate::ENTRY_CLOCK_SKEW_SECONDS),
            chrono::Utc::now().timestamp(),
        ) {
            Ok(()) => {}
            Err(crate::entry_replay::ConsumeError::Replay) => return entry_not_found_response(),
            Err(crate::entry_replay::ConsumeError::AtCapacity) => {
                return (StatusCode::SERVICE_UNAVAILABLE, "entry capacity reached").into_response()
            }
        }
        let mut response = issue_session_cookie(
            &state.sessions,
            claims.sub,
            claims.owner_user_id,
            &devserver_id,
            aud,
            &claims.next_path,
        );
        apply_credentialed_response_policy(&mut response, false);
        return response;
    }
    entry_not_found_response()
}

fn entry_preflight(req: &Request, cfg: &crate::config::Config) -> Option<Response> {
    if req.method() != axum::http::Method::POST {
        return Some(entry_not_found_response());
    }
    if !exact_origin_matches(req.headers(), cfg.identity_origin.as_str()) {
        return Some((StatusCode::FORBIDDEN, "forbidden").into_response());
    }
    if !exact_entry_content_type(req.headers()) {
        return Some(
            (StatusCode::UNSUPPORTED_MEDIA_TYPE, "unsupported media type").into_response(),
        );
    }
    None
}

async fn read_entry_credential(req: &mut Request) -> std::result::Result<String, Response> {
    let body = axum::body::to_bytes(std::mem::take(req.body_mut()), MAX_ENTRY_FORM_BYTES)
        .await
        .map_err(|_| (StatusCode::PAYLOAD_TOO_LARGE, "payload too large").into_response())?;
    let fields: Vec<_> = url::form_urlencoded::parse(&body).collect();
    match fields.as_slice() {
        [(name, value)] if name == "credential" && !value.is_empty() => Ok(value.to_string()),
        _ => Err((StatusCode::BAD_REQUEST, "malformed entry exchange").into_response()),
    }
}

fn exact_entry_content_type(headers: &HeaderMap) -> bool {
    let mut values = headers.get_all(header::CONTENT_TYPE).iter();
    matches!(
        (values.next(), values.next()),
        (Some(value), None) if value.as_bytes() == ENTRY_FORM_CONTENT_TYPE.as_bytes()
    )
}

/// Per-request configuration slice handed to `proxy_http`. Bundled so
/// new knobs don't churn the call signature.
#[derive(Clone)]
struct ProxyOpts<'a> {
    max_request_bytes: Option<usize>,
    max_response_bytes: Option<usize>,
    request_timeout: Option<std::time::Duration>,
    authorization: &'a SessionRecord,
    forwarded_proto: &'a str,
    assertion: HeaderValue,
}

/// Body and deadline policy for one forwarded request: the transfer
/// route's explicit allowance, or the configured general caps.
struct RouteBodyPolicy {
    max_request_bytes: Option<usize>,
    max_response_bytes: Option<usize>,
    request_timeout: Option<std::time::Duration>,
}

/// Select the body/deadline policy for one forwarded request. Bulk
/// transfer routes get the explicit `TRANSFER_ROUTE_*` allowance; the
/// server-side copy route gets only the long deadline on top of the
/// general byte caps; every other route keeps the configured general
/// policy unchanged.
fn route_body_policy(
    cfg: &crate::config::Config,
    method: &Method,
    path_and_query: &str,
) -> RouteBodyPolicy {
    let general = || RouteBodyPolicy {
        max_request_bytes: cfg.max_request_bytes,
        max_response_bytes: cfg.max_response_bytes,
        request_timeout: cfg.request_timeout,
    };
    match transfer_route_class(method, path_and_query) {
        Some(TransferRoute::Bulk) => RouteBodyPolicy {
            max_request_bytes: Some(crate::config::TRANSFER_ROUTE_MAX_BYTES),
            max_response_bytes: Some(crate::config::TRANSFER_ROUTE_MAX_BYTES),
            request_timeout: Some(crate::config::TRANSFER_ROUTE_TIMEOUT),
        },
        Some(TransferRoute::ServerSideCopy) => RouteBodyPolicy {
            request_timeout: Some(crate::config::TRANSFER_ROUTE_TIMEOUT),
            ..general()
        },
        None => general(),
    }
}

/// The narrow set of routes allowed off the general body/deadline
/// policy.
enum TransferRoute {
    /// Large bodies in either direction: the multipart upload, and
    /// downloads of file content or directory archives.
    Bulk,
    /// A potentially long server-side copy whose request and response
    /// stay small JSON: only the deadline relaxes.
    ServerSideCopy,
}

/// Classify a forwarded request by method, path, and query. The path
/// here is the forwarded `/{workspace}/...` path; the tenant segment is
/// stripped before matching so workspace and terminal tenants classify
/// identically. Only the sanctioned bulk shapes qualify:
///
/// - `POST /{tenant}/api/files/upload` (multipart upload),
/// - `GET /{tenant}/api/files/{*path}` with a truthy `download` query
///   flag (file and directory-archive downloads),
/// - `POST /{tenant}/api/fs/transfer` (server-side copy).
///
/// Plain GET reads, `stream=1` reads, PUT writes, DELETE, the bare
/// `/api/files` listing and create routes, other tenant APIs, and
/// root-level paths all retain the general policy.
fn transfer_route_class(method: &Method, path_and_query: &str) -> Option<TransferRoute> {
    let mut parts = path_and_query.splitn(2, '?');
    let path = parts.next().unwrap_or("");
    let query = parts.next();
    let rest = path.strip_prefix('/')?;
    let tenant_path = rest.split_once('/').map(|(_, tail)| tail).unwrap_or("");
    if method == Method::POST {
        if tenant_path == "api/files/upload" {
            return Some(TransferRoute::Bulk);
        }
        if tenant_path == "api/fs/transfer" {
            return Some(TransferRoute::ServerSideCopy);
        }
        return None;
    }
    if method == Method::GET
        && tenant_path.starts_with("api/files/")
        && query_flag_truthy(query, "download")
    {
        return Some(TransferRoute::Bulk);
    }
    None
}

/// Whether `name` appears in the query string with exactly one
/// form-decoded value that is truthy under the same accepted set as the
/// server's `query_flag` (`1`, `true`, `TRUE`, `yes`, `YES`, `on`,
/// `ON`). The server's Axum `Query<ReadFileQuery>` form-decodes the
/// query (so `download=%31` reaches it as the accepted value `1`) and
/// rejects duplicate struct fields, so classification decodes the same
/// way and refuses duplicates rather than reading raw `&`-split pairs.
/// A bare flag without `=` decodes to an empty value and is not truthy,
/// matching the server.
fn query_flag_truthy(query: Option<&str>, name: &str) -> bool {
    let Some(query) = query else {
        return false;
    };
    let mut values = url::form_urlencoded::parse(query.as_bytes())
        .filter(|(key, _)| key == name)
        .map(|(_, value)| value);
    let Some(value) = values.next() else {
        return false;
    };
    if values.next().is_some() {
        return false;
    }
    matches!(
        value.as_ref(),
        "1" | "true" | "TRUE" | "yes" | "YES" | "on" | "ON"
    )
}

struct GatewayCaller {
    sub: Uuid,
    owner_user_id: Uuid,
}

/// Outcome of the auth-gate decision.
enum Gate {
    /// Forward the request under an existing gateway session.
    Pass { record: SessionRecord },
    /// Anything that should map to 404 on the proxy path: no token,
    /// bad signature, expired, wrong aud, wrong devserver.
    Reject,
}

fn resolve_gate(
    state: &AppState,
    req: &Request,
    devserver_id: &str,
    owner_user_id: Uuid,
    aud: &str,
) -> Gate {
    // No entry token: any one valid session cookie admits. A browser
    // may send several `__Host-devserver_gate` cookies under unusual conditions
    // (stale cookie at a different path that got attached to this
    // request); accept the first that verifies under this aud + drv so
    // a stale duplicate doesn't 404 a legitimate session.
    for cookie in cookie_values(req.headers(), COOKIE_NAME) {
        if let Some(record) = state.sessions.lookup(&cookie) {
            if record.principal.audience == aud
                && record.principal.devserver_id == devserver_id
                && record.principal.owner_user_id == owner_user_id
            {
                return Gate::Pass { record };
            }
        }
    }
    Gate::Reject
}

/// True when a request carries a `__Host-devserver_gate` session cookie. The
/// dispatcher uses this to
/// decide what a bare wildcard `/` means: a credential-bearing root is an
/// authenticated open that falls through to the gate and is forwarded to
/// the devserver root (where the launcher SPA is served), while a naked
/// bare-domain hit bounces to the dashboard front door. This does NOT
/// validate the credential. `resolve_gate` does that on the
/// fall-through; it only distinguishes "an open attempt" from "naked".
pub(crate) fn has_gate_credential(uri: &Uri, headers: &HeaderMap) -> bool {
    let _ = uri;
    !cookie_values(headers, COOKIE_NAME).is_empty()
}

/// True when the path targets the devserver's local-only management API
/// (`/api/devserver` or `/api/devserver/...`). The proxy 404s it on the
/// public wildcard so only tenant content reaches the tunnel; the owner
/// manages over the direct connection.
fn is_management_path(path: &str) -> bool {
    path == "/api/devserver" || path.starts_with("/api/devserver/")
}

/// The path forwarded into the tunnel: the full inbound path+query. The proxy is
/// a segment-PRESERVING forwarder. It does NOT strip the `{workspace}` segment;
/// the devserver mounts each tenant at its public `/{workspace}/` slug and
/// routes internally. Entry credentials are consumed at a separate fixed POST
/// endpoint, so any forwarded `?t=` belongs to the upstream tenant.
/// Always returns a path that starts with `/`.
fn forward_path(uri: &Uri) -> String {
    uri.path_and_query()
        .map(|p| p.as_str().to_string())
        .unwrap_or_else(|| "/".to_string())
}

/// Read the `__Host-devserver_gate` cookie value from the Cookie header(s).
/// Manual parse: this crate deliberately carries no cookie / session
/// dependency. RFC 6265 cookie-pair: `name=value; name=value; ...`.
/// Returns every match in order so the caller can fall through stale
/// duplicates (e.g. a browser sending an old + a fresh `__Host-devserver_gate`
/// under different paths that both got attached to the same request).
/// Quoted values (`name="value"`) get the quotes stripped per RFC.
fn cookie_values(headers: &HeaderMap, cookie_name: &str) -> Vec<String> {
    let mut out = Vec::new();
    for raw in headers.get_all(header::COOKIE).iter() {
        let Ok(s) = raw.to_str() else { continue };
        for pair in s.split(';') {
            let pair = pair.trim();
            let Some((name, value)) = pair.split_once('=') else {
                continue;
            };
            if name == cookie_name {
                let unquoted = value
                    .strip_prefix('"')
                    .and_then(|v| v.strip_suffix('"'))
                    .unwrap_or(value);
                out.push(unquoted.to_string());
            }
        }
    }
    out
}

/// Read and normalize the inbound Host spelling. Scheme-aware default-port
/// canonicalization happens at the caller using the configured public scheme.
fn host_header(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(|host| host.trim().trim_end_matches('.').to_ascii_lowercase())
}

fn requires_csrf(method: &axum::http::Method) -> bool {
    // Treat every method outside the HTTP safe-method set as state-changing.
    // Restricting this to the common four verbs leaves extension methods such
    // as PROPFIND or application-defined mutation verbs exposed to ambient
    // browser cookies whenever an upstream happens to support them.
    method != axum::http::Method::GET
        && method != axum::http::Method::HEAD
        && method != axum::http::Method::OPTIONS
}

fn csrf_header_matches_cookie(headers: &HeaderMap) -> bool {
    let Some(header_value) = headers.get(CSRF_HEADER_NAME).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    cookie_values(headers, CSRF_COOKIE_NAME)
        .into_iter()
        .any(|cookie| timing_safe_eq(cookie.as_bytes(), header_value.as_bytes()))
}

fn timing_safe_eq(a: &[u8], b: &[u8]) -> bool {
    // Length mismatch still returns early, as usual for timing-safe compares.
    if a.len() != b.len() {
        return false;
    }
    a.ct_eq(b).into()
}

/// Detect an HTTP/1.1 upgrade-to-WebSocket request. Mirrors what
/// `WebSocketUpgrade::from_request_parts` checks before doing the
/// handshake response. We sniff up front so the auth gate runs the
/// same logic for HTTP and WS without an extra round trip through
/// the extractor.
fn is_websocket_upgrade(headers: &HeaderMap) -> bool {
    let upgrade = headers
        .get(header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"));
    let conn = headers
        .get(header::CONNECTION)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.split(',')
                .map(str::trim)
                .any(|t| t.eq_ignore_ascii_case("upgrade"))
        });
    upgrade && conn
}

/// Browser WebSockets carry ambient cookies, while sibling tenant origins are
/// same-site. The browser's serialized Origin must therefore name the exact
/// externally visible origin before an upgrade can reach the devserver.
fn websocket_origin_matches(headers: &HeaderMap, scheme: &str, aud: &str) -> bool {
    exact_origin_matches(headers, &format!("{scheme}://{aud}"))
}

fn exact_origin_matches(headers: &HeaderMap, expected: &str) -> bool {
    let mut origins = headers.get_all(header::ORIGIN).iter();
    let Some(origin) = origins.next().and_then(|value| value.to_str().ok()) else {
        return false;
    };
    if origins.next().is_some() {
        return false;
    }
    origin == expected
}

fn is_extension_proxy_path(path_and_query: &str) -> bool {
    path_and_query
        .split_once('?')
        .map_or(path_and_query, |(path, _)| path)
        .contains("/_chan/extensions/")
}

/// Exact extension capability shape:
/// `/{tenant}/_chan/extensions/{id}/{64-hex}/...`. This is the ONLY
/// path admitted without the session gate; anything looser stays
/// behind it. The capability segment must be exactly 64 lowercase hex
/// characters (the devserver mints it that way) and must be followed
/// by a further `/` — the devserver routes only the slash-terminated
/// entry root and deeper assets, so a slashless capability URL has
/// nothing to reach and stays gated.
fn is_extension_capability_path(path: &str) -> bool {
    let mut segments = path.split('/');
    if segments.next() != Some("") {
        return false;
    }
    let Some(tenant) = segments.next() else {
        return false;
    };
    if tenant.is_empty() {
        return false;
    }
    if segments.next() != Some("_chan") || segments.next() != Some("extensions") {
        return false;
    }
    let Some(id) = segments.next() else {
        return false;
    };
    if id.is_empty() {
        return false;
    }
    let Some(capability) = segments.next() else {
        return false;
    };
    if capability.len() != 64
        || !capability
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return false;
    }
    segments.next().is_some()
}

/// The capability segment is a bearer credential in the path. Trace
/// spans record the request URI, so the dispatcher logs URIs through
/// this instead: on the admitted shape the capability segment is
/// replaced with a fixed marker, every other URI passes unchanged.
pub(crate) fn loggable_uri(uri: &Uri) -> String {
    let path = uri.path();
    if !is_extension_capability_path(path) {
        return uri.to_string();
    }
    let capability_start = path
        .match_indices('/')
        .nth(4)
        .map(|(at, _)| at + 1)
        .expect("admitted shape has five slashes");
    let mut redacted = String::with_capacity(uri.to_string().len());
    redacted.push_str(&path[..capability_start]);
    redacted.push_str("[capability]");
    redacted.push_str(&path[capability_start + 64..]);
    if let Some(query) = uri.query() {
        redacted.push('?');
        redacted.push_str(query);
    }
    redacted
}

/// Every response leaving the extension capability namespace must be
/// readable from the opaque-origin extension frame — the proxied reply
/// and every gateway-generated error alike — or the frame's console
/// reports a CORS violation that masks the true status. Hop-by-hop
/// headers are left alone so the WS 101 handshake survives untouched.
fn apply_extension_capability_response_policy(response: &mut Response) {
    let headers = response.headers_mut();
    headers.remove(header::SET_COOKIE);
    headers.remove(header::ACCESS_CONTROL_ALLOW_CREDENTIALS);
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("null"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    headers.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        HeaderName::from_static("referrer-policy"),
        HeaderValue::from_static("no-referrer"),
    );
}

fn apply_credentialed_response_policy(response: &mut Response, extension_frame: bool) {
    let headers = response.headers_mut();
    // A second CSP is intersected with any upstream policy, so framing is
    // denied without discarding stricter application directives. The sole
    // exception is Chan's capability-scoped extension proxy: those responses
    // are designed to live in the owning tenant's sandboxed iframe and may be
    // framed only by this exact gateway origin.
    headers.append(
        HeaderName::from_static("content-security-policy"),
        HeaderValue::from_static(if extension_frame {
            "frame-ancestors 'self'"
        } else {
            "frame-ancestors 'none'"
        }),
    );
    headers.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        HeaderName::from_static("referrer-policy"),
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
}

/// Mint an opaque proxy-local session for `sub`, set it as a `__Host-`
/// (Secure, host-only, `Path=/`) cookie, and 303 to the signed clean
/// path. Browsers
/// follow the 303 with the new cookie attached. `sub` comes from the
/// entry token we just verified, owner or accepted grantee, so the
/// session cookie identifies the right user for upstream attribution.
/// `Path=/` is safe because the grant is whole-devserver: every path on
/// this host is content the cookie-holder is authorized to reach, and
/// user-to-user isolation stays on the host-only `aud` claim.
fn issue_session_cookie(
    sessions: &crate::session_store::SessionStore,
    sub: Uuid,
    owner_user_id: Uuid,
    devserver_id: &str,
    aud: &str,
    next_path: &str,
) -> Response {
    let issued = match sessions.issue(SessionPrincipal {
        subject_user_id: sub,
        owner_user_id,
        devserver_id: devserver_id.to_string(),
        audience: aud.to_string(),
    }) {
        Ok(issued) => issued,
        Err(error) => {
            tracing::warn!(?error, "proxy-local browser session capacity reached");
            return (StatusCode::SERVICE_UNAVAILABLE, "session capacity reached").into_response();
        }
    };
    let csrf = random_csrf_token();
    let max_age = issued
        .record
        .expires_at
        .saturating_duration_since(tokio::time::Instant::now())
        .as_secs();
    let cookie_value = format!(
        "{COOKIE_NAME}={}; \
         Path=/; \
         HttpOnly; Secure; SameSite=Lax; Max-Age={max_age}",
        issued.id(),
    );
    let csrf_cookie = format!(
        "{CSRF_COOKIE_NAME}={csrf}; \
         Path=/; \
         Secure; SameSite=Lax; Max-Age={max_age}"
    );
    let mut res = (StatusCode::SEE_OTHER, "").into_response();
    res.headers_mut().insert(
        header::LOCATION,
        HeaderValue::from_str(next_path).unwrap_or(HeaderValue::from_static("/")),
    );
    res.headers_mut().append(
        header::SET_COOKIE,
        HeaderValue::from_str(&cookie_value).unwrap_or(HeaderValue::from_static(COOKIE_NAME)),
    );
    res.headers_mut().append(
        header::SET_COOKIE,
        HeaderValue::from_str(&csrf_cookie).unwrap_or(HeaderValue::from_static(CSRF_COOKIE_NAME)),
    );
    res
}

fn random_csrf_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

async fn proxy_http(
    handle: TunnelHandle,
    req: Request,
    upstream_path_and_query: String,
    opts: ProxyOpts<'_>,
    operation: ActiveOperation,
) -> Result<Response> {
    // The full request deadline (headers + body streaming) is anchored
    // at this Instant. send_request is bounded explicitly below; the
    // response body is bounded by wrapping it in DeadlineBody, which
    // shares the same deadline so a slow-drip upstream can't outlast
    // the configured timeout. Bypassed when request_timeout is None.
    let request_deadline = opts
        .request_timeout
        .map(|d| tokio::time::Instant::now() + d);
    let deadline = request_deadline
        .map(|request| request.min(opts.authorization.expires_at))
        .unwrap_or(opts.authorization.expires_at);

    let cancellation = opts.authorization.cancellation.clone();
    let stream = tokio::select! {
        _ = cancellation.cancelled() => {
            return Ok(not_found_response(&HeaderMap::new()));
        }
        timed = tokio::time::timeout_at(deadline, handle.open()) => match timed {
            Ok(result) => result
                .map_err(|e| Error::Upstream(format!("tunnel disconnected: {e}")))?,
            Err(_) => {
                return Ok((StatusCode::GATEWAY_TIMEOUT, "upstream timed out").into_response());
            }
        }
    };
    let io = TokioIo::new(stream.compat());

    let handshake = hyper::client::conn::http1::handshake(io);
    let (mut sender, conn) = tokio::select! {
        _ = cancellation.cancelled() => {
            return Ok(not_found_response(&HeaderMap::new()));
        }
        timed = tokio::time::timeout_at(deadline, handshake) => match timed {
            Ok(result) => result
                .map_err(|e| Error::Upstream(format!("upstream h1 handshake: {e}")))?,
            Err(_) => {
                return Ok((StatusCode::GATEWAY_TIMEOUT, "upstream timed out").into_response());
            }
        }
    };
    // The conn task must outlive header receipt (so the body can
    // stream back) but must not outlive the body, otherwise an
    // aborted client request leaks a yamux substream. We hand its
    // AbortHandle to DeadlineBody below; on body drop / body
    // completion, abort fires (no-op for an already-finished task).
    let conn_handle = operation.spawn(async move {
        if let Err(e) = conn.with_upgrades().await {
            tracing::debug!(error = %e, "upstream conn ended");
        }
    });
    let conn_abort = conn_handle.abort_handle();

    let (mut parts, body) = req.into_parts();
    let request_method = parts.method.clone();

    let forwarded = forwarded_headers(&parts, opts.forwarded_proto);
    strip_inbound_headers(&mut parts.headers);
    apply_forwarded(&mut parts.headers, &forwarded);
    apply_gateway_assertion(&mut parts.headers, opts.assertion);

    parts.uri = upstream_path_and_query
        .parse::<Uri>()
        .map_err(|e| Error::Anyhow(anyhow::anyhow!("upstream uri: {e}")))?;

    // Cap inbound request body before it reaches the upstream so a
    // malicious authenticated client cannot stream an unbounded body
    // and tie up the substream + yamux window.
    let body = match opts.max_request_bytes {
        Some(max) => Body::new(Limited::new(body, max)),
        None => Body::new(body),
    };

    let upstream_req = axum::http::Request::from_parts(parts, body);
    let send_fut = sender.send_request(upstream_req);
    let res = tokio::select! {
        _ = cancellation.cancelled() => {
            conn_abort.abort();
            return Ok(not_found_response(&HeaderMap::new()));
        }
        timed = tokio::time::timeout_at(deadline, send_fut) => match timed {
            Ok(r) => r.map_err(|e| Error::Upstream(format!("send_request: {e}")))?,
            Err(_) => {
                conn_abort.abort();
                tracing::warn!("proxy_http exceeded authorization/request deadline before response headers");
                return Ok((StatusCode::GATEWAY_TIMEOUT, "upstream timed out").into_response());
            }
        }
    };

    let (parts, body) = res.into_parts();
    // Response-cap invariant: a non-HEAD response that declares a body
    // length above the configured cap is refused with a deterministic
    // 502 before any body bytes forward, and the upstream connection
    // task is aborted. HEAD responses carry no body, so their declared
    // representation length is not capped. A response with no declared
    // length streams through the `Limited` backstop below.
    if let Some(max) = opts.max_response_bytes {
        if declared_response_over_cap(&request_method, &parts.headers, max) {
            conn_abort.abort();
            return Ok((
                StatusCode::BAD_GATEWAY,
                "upstream response exceeds the gateway body cap",
            )
                .into_response());
        }
    }
    let mut builder = Response::builder().status(parts.status);
    for (k, v) in strip_response_headers(&parts.headers) {
        builder = builder.header(k, v);
    }
    let bounded: Body = match opts.max_response_bytes {
        Some(max) => Body::new(Limited::new(body, max)),
        None => Body::new(body),
    };
    // Wrap the body when a deadline applies so:
    //  * a slow-drip upstream is bounded end-to-end, and
    //  * dropping the body aborts the conn task so a client that
    //    bails mid-response doesn't leak the yamux substream.
    // When no deadline is configured we let the body stream
    // unwrapped; the conn task exits naturally when the upstream
    // half-closes the substream.
    let response_body = Body::new(DeadlineBody::new(
        bounded,
        deadline,
        opts.authorization.cancellation.clone(),
        conn_abort,
    ));
    builder
        .body(response_body)
        .map_err(|e| Error::Anyhow(anyhow::anyhow!("response: {e}")))
}

/// Whether a response whose headers declare a content length must be
/// refused under the configured cap. The declared length is parsed as
/// `u64` and compared against the cap widened to `u64`. HEAD responses
/// carry no body, so their declared representation length is never
/// capped; responses with no declared length return false here and
/// stream through the `Limited` backstop.
fn declared_response_over_cap(method: &Method, headers: &HeaderMap, max: usize) -> bool {
    if method == Method::HEAD {
        return false;
    }
    headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
        .is_some_and(|len| len > max as u64)
}

/// Drop hop-by-hop headers, Host, Cookie (the __Host-devserver_gate cookie has
/// no business at the upstream), Authorization (a user-presented PAT
/// or bearer has no business at the tenant's `chan devserver` either;
/// auth on this leg is the __Host-devserver_gate handshake plus the tunnel
/// trust boundary), and existing X-Forwarded-*. Honors the
/// connection-token list per RFC 7230 6.1.
fn strip_inbound_headers(headers: &mut HeaderMap) {
    let connection_listed = connection_listed_headers(headers);
    for h in HOP_BY_HOP_NAMES {
        headers.remove(*h);
    }
    for h in &connection_listed {
        headers.remove(h);
    }
    headers.remove(header::HOST);
    headers.remove(header::COOKIE);
    headers.remove(header::AUTHORIZATION);
    headers.remove(CSRF_HEADER_NAME);
    headers.remove(X_FORWARDED_FOR);
    headers.remove(X_FORWARDED_PROTO);
    headers.remove(X_FORWARDED_HOST);
}

/// Same hop-by-hop filter applied to a response HeaderMap on its way
/// back to the client. Tenant cookies remain available, but Domain
/// cookies and the gateway's reserved auth/CSRF names are stripped so
/// one assigned devserver cannot plant cookies on sibling tenant hosts
/// or overwrite the proxy's own authority state.
fn strip_response_headers(
    headers: &HeaderMap,
) -> Vec<(axum::http::HeaderName, axum::http::HeaderValue)> {
    let connection_listed = connection_listed_headers(headers);
    headers
        .iter()
        .filter(|(k, _)| !is_hop_by_hop(k))
        .filter(|(k, _)| !connection_listed.iter().any(|h| h == *k))
        .filter(|(k, v)| *k != header::SET_COOKIE || safe_upstream_set_cookie(v))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

fn safe_upstream_set_cookie(value: &HeaderValue) -> bool {
    let Ok(raw) = value.to_str() else {
        return false;
    };
    let mut segments = raw.split(';');
    let Some(cookie_pair) = segments.next() else {
        return false;
    };
    let Some((name, _)) = cookie_pair.split_once('=') else {
        return false;
    };
    let name = name.trim();
    if name.eq_ignore_ascii_case(COOKIE_NAME)
        || name.eq_ignore_ascii_case(CSRF_COOKIE_NAME)
        || name.eq_ignore_ascii_case(LEGACY_COOKIE_NAME)
        || name.eq_ignore_ascii_case(LEGACY_CSRF_COOKIE_NAME)
    {
        return false;
    }
    !segments.any(|attribute| {
        attribute
            .split_once('=')
            .map_or(attribute, |(name, _)| name)
            .trim()
            .eq_ignore_ascii_case("domain")
    })
}

/// Bidirectional WebSocket pump.
///
/// One shared idle window covers BOTH directions: a frame either way
/// resets it, so a socket streaming upstream->client (a terminal
/// printing output) or client->upstream (heartbeats) never dies
/// mid-stream; only a bridge quiet in both directions for
/// `idle_timeout` (production: [`crate::config::DEFAULT_WS_IDLE_TIMEOUT`])
/// is cut. Every non-error teardown announces itself with a real WS
/// Close frame to each half -- an abrupt FIN leaves browsers without a
/// prompt `onclose` and the peer devserver with a dangling substream.
struct BridgePolicy {
    assertion: HeaderValue,
    idle_timeout: std::time::Duration,
    cancellation: tokio_util::sync::CancellationToken,
    expires_at: tokio::time::Instant,
}

async fn bridge_ws(
    client: WebSocket,
    handle: TunnelHandle,
    path_and_query: &str,
    forwarded: &ForwardedHeaders,
    policy: BridgePolicy,
) -> anyhow::Result<()> {
    let stream = handle.open().await?;
    let io = stream.compat();

    let upstream_url = format!("ws://chan-tunnel{path_and_query}");
    let mut request = upstream_url
        .as_str()
        .into_client_request()
        .map_err(|e| anyhow::anyhow!("build ws request: {e}"))?;
    apply_forwarded(request.headers_mut(), forwarded);
    apply_gateway_assertion(request.headers_mut(), policy.assertion);

    let (upstream, _resp) = tokio_tungstenite::client_async(request, io)
        .await
        .map_err(|e| anyhow::anyhow!("ws handshake: {e}"))?;

    let (mut up_tx, mut up_rx) = upstream.split();
    let (mut cl_tx, mut cl_rx) = client.split();

    let mut idle_deadline = tokio::time::Instant::now() + policy.idle_timeout;
    loop {
        tokio::select! {
            msg = cl_rx.next() => match msg {
                Some(Ok(msg)) => {
                    idle_deadline = tokio::time::Instant::now() + policy.idle_timeout;
                    let stop = matches!(msg, Message::Close(_));
                    up_tx.send(client_to_upstream(msg)).await?;
                    if stop {
                        break;
                    }
                }
                Some(Err(e)) => {
                    // Client transport died mid-frame; the upstream
                    // half is still healthy, so close it properly.
                    let _ = up_tx.send(TgMessage::Close(None)).await;
                    return Err(e.into());
                }
                None => {
                    // Client vanished without a Close handshake.
                    let _ = up_tx.send(TgMessage::Close(None)).await;
                    break;
                }
            },
            msg = up_rx.next() => match msg {
                Some(Ok(msg)) => {
                    idle_deadline = tokio::time::Instant::now() + policy.idle_timeout;
                    let stop = matches!(msg, TgMessage::Close(_));
                    if let Some(translated) = upstream_to_client(msg) {
                        cl_tx.send(translated).await?;
                    }
                    if stop {
                        break;
                    }
                }
                Some(Err(e)) => {
                    let _ = cl_tx
                        .send(Message::Close(Some(CloseFrame {
                            code: 1011, // internal error
                            reason: "upstream error".into(),
                        })))
                        .await;
                    return Err(e.into());
                }
                None => {
                    // The substream ended without a Close handshake
                    // (tunnel redial, yamux teardown): tell the
                    // browser so `onclose` fires promptly instead of
                    // leaving a half-open zombie socket.
                    let _ = cl_tx
                        .send(Message::Close(Some(CloseFrame {
                            code: 1001, // going away
                            reason: "upstream closed".into(),
                        })))
                        .await;
                    break;
                }
            },
            _ = tokio::time::sleep_until(idle_deadline) => {
                tracing::info!("ws bridge idle timeout (both directions quiet)");
                let _ = cl_tx
                    .send(Message::Close(Some(CloseFrame {
                        code: 1001, // going away
                        reason: "idle timeout".into(),
                    })))
                    .await;
                let _ = up_tx
                    .send(TgMessage::Close(Some(TgCloseFrame {
                        code: TgCloseCode::Away,
                        reason: TgUtf8Bytes::from_static("idle timeout"),
                    })))
                    .await;
                break;
            }
            _ = policy.cancellation.cancelled() => {
                let _ = cl_tx
                    .send(Message::Close(Some(CloseFrame {
                        code: 1008,
                        reason: "session revoked".into(),
                    })))
                    .await;
                let _ = up_tx
                    .send(TgMessage::Close(Some(TgCloseFrame {
                        code: TgCloseCode::Policy,
                        reason: TgUtf8Bytes::from_static("session revoked"),
                    })))
                    .await;
                break;
            }
            _ = tokio::time::sleep_until(policy.expires_at) => {
                let _ = cl_tx
                    .send(Message::Close(Some(CloseFrame {
                        code: 1008,
                        reason: "session expired".into(),
                    })))
                    .await;
                let _ = up_tx
                    .send(TgMessage::Close(Some(TgCloseFrame {
                        code: TgCloseCode::Policy,
                        reason: TgUtf8Bytes::from_static("session expired"),
                    })))
                    .await;
                break;
            }
        }
    }
    Ok(())
}

// axum and tungstenite each wrap ws text payloads in their own Utf8Bytes
// type with no direct conversion between them; the Bytes round-trip in
// to_tg_utf8 / to_ax_utf8 is zero-copy, and the re-validation cannot fail
// because the source type already guarantees valid UTF-8.
fn to_tg_utf8(s: Utf8Bytes) -> TgUtf8Bytes {
    TgUtf8Bytes::try_from(Bytes::from(s)).expect("axum Utf8Bytes is valid UTF-8")
}

fn client_to_upstream(msg: Message) -> TgMessage {
    match msg {
        Message::Text(s) => TgMessage::Text(to_tg_utf8(s)),
        Message::Binary(b) => TgMessage::Binary(b),
        Message::Ping(b) => TgMessage::Ping(b),
        Message::Pong(b) => TgMessage::Pong(b),
        Message::Close(frame) => TgMessage::Close(frame.map(|f| TgCloseFrame {
            code: TgCloseCode::from(f.code),
            reason: to_tg_utf8(f.reason),
        })),
    }
}

// ---------------------------------------------------------------
// X-Forwarded-* chain
// ---------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub(crate) struct ForwardedHeaders {
    xff: Option<String>,
    proto: String,
    host: Option<String>,
}

const X_FORWARDED_FOR: &str = "x-forwarded-for";
const X_FORWARDED_PROTO: &str = "x-forwarded-proto";
const X_FORWARDED_HOST: &str = "x-forwarded-host";

/// Trust boundary: devserver-proxy is the only thing between the client
/// and the upstream `chan devserver`. Inbound `X-Forwarded-Host` /
/// `X-Forwarded-Proto` are entirely client-controlled (nginx may not
/// scrub them, and the gateway must not assume it does) so we never
/// forward those values; we re-derive `host` from the inbound `Host`
/// header devserver-proxy itself routed on, and `proto` from
/// `cfg.forwarded_proto` (configured to match the terminator that
/// fronts this listener). Inbound XFF is equally client-controlled and is
/// discarded; without an explicit trusted-edge peer allowlist, only the
/// socket peer is safe to forward.
pub(crate) fn forwarded_headers(parts: &Parts, proto: &str) -> ForwardedHeaders {
    let peer_ip = parts
        .extensions
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ConnectInfo(addr)| addr.ip().to_string());

    let xff = peer_ip;

    let host = parts
        .headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    ForwardedHeaders {
        xff,
        proto: proto.to_string(),
        host,
    }
}

fn apply_forwarded(headers: &mut HeaderMap, f: &ForwardedHeaders) {
    if let Some(xff) = &f.xff {
        if let Ok(value) = HeaderValue::from_str(xff) {
            headers.insert(X_FORWARDED_FOR, value);
        }
    }
    if let Ok(value) = HeaderValue::from_str(&f.proto) {
        headers.insert(X_FORWARDED_PROTO, value);
    }
    if let Some(host) = &f.host {
        if let Ok(value) = HeaderValue::from_str(host) {
            headers.insert(X_FORWARDED_HOST, value);
        }
    }
}

fn gateway_assertion_value(
    key: Option<&gateway_assertion::AssertionKey>,
    caller: &GatewayCaller,
    aud: &str,
    devserver_id: &str,
) -> Result<HeaderValue> {
    let key = key.ok_or_else(|| {
        Error::Anyhow(anyhow::anyhow!(
            "live tunnel registration has no gateway assertion key"
        ))
    })?;
    let claims = gateway_assertion::claims(
        caller.sub.to_string(),
        caller.owner_user_id.to_string(),
        aud,
        devserver_id,
    );
    let signed = gateway_assertion::sign(key, &claims)
        .map_err(|e| Error::Anyhow(anyhow::anyhow!("sign gateway assertion: {e}")))?;
    HeaderValue::from_str(&signed)
        .map_err(|e| Error::Anyhow(anyhow::anyhow!("encode gateway assertion header: {e}")))
}

fn apply_gateway_assertion(headers: &mut HeaderMap, assertion: HeaderValue) {
    headers.remove(gateway_assertion::HEADER_NAME);
    headers.insert(gateway_assertion::HEADER_NAME, assertion);
}

// ---------------------------------------------------------------
// 404 page
// ---------------------------------------------------------------

fn not_found_response(headers: &HeaderMap) -> Response {
    if accepts_html(headers) {
        html_not_found()
    } else {
        Error::NotFound.into_response()
    }
}

fn entry_not_found_response() -> Response {
    Error::NotFound.into_response()
}

fn accepts_html(headers: &HeaderMap) -> bool {
    headers
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.contains("text/html"))
}

fn html_not_found() -> Response {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .body(Body::from(NOT_FOUND_HTML))
        .expect("static 404 response is valid")
}

/// Inlined so the binary has no SPA dependency. The mark is loaded
/// via a data: URL so a fresh deploy without nginx routing for
/// `/chan-mark.png` still renders. The watermark uses the same
/// CSS-mask recolor trick as the chan editor.
const NOT_FOUND_HTML: &str = r#"<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>workspace not found - chan</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root {
    --bg: #1c1c1e;
    --text: #f5f5f7;
    --text-secondary: #98989d;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #ffffff;
      --text: #1c1c1e;
      --text-secondary: #6c6c70;
    }
  }
  html, body {
    height: 100%;
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  main {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    text-align: center;
    padding: 2rem;
    box-sizing: border-box;
  }
  h1 {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
  }
  p {
    margin: 0;
    color: var(--text-secondary);
    font-size: 14px;
    max-width: 36ch;
  }
</style>
<main>
  <h1>workspace unavailable</h1>
  <p>This workspace is currently unavailable.</p>
</main>
</html>
"#;

// ---------------------------------------------------------------
// WebSocket frame translation
// ---------------------------------------------------------------

// Inverse of to_tg_utf8; same zero-copy Bytes round-trip, same
// infallibility argument.
fn to_ax_utf8(s: TgUtf8Bytes) -> Utf8Bytes {
    Utf8Bytes::try_from(Bytes::from(s)).expect("tungstenite Utf8Bytes is valid UTF-8")
}

fn upstream_to_client(msg: TgMessage) -> Option<Message> {
    Some(match msg {
        TgMessage::Text(s) => Message::Text(to_ax_utf8(s)),
        TgMessage::Binary(b) => Message::Binary(b),
        TgMessage::Ping(b) => Message::Ping(b),
        TgMessage::Pong(b) => Message::Pong(b),
        TgMessage::Close(frame) => Message::Close(frame.map(|f| CloseFrame {
            code: f.code.into(),
            reason: to_ax_utf8(f.reason),
        })),
        TgMessage::Frame(_) => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_IDENTITY_ORIGIN: &str = "https://gw.chan.app";

    #[test]
    fn entry_content_type_requires_one_exact_raw_value() {
        let mut headers = HeaderMap::new();
        headers.append(
            header::CONTENT_TYPE,
            HeaderValue::from_static(ENTRY_FORM_CONTENT_TYPE),
        );
        assert!(exact_entry_content_type(&headers));

        headers.append(
            header::CONTENT_TYPE,
            HeaderValue::from_bytes(&[0xff]).expect("opaque header value"),
        );
        assert!(!exact_entry_content_type(&headers));
    }

    #[test]
    fn duplicate_connection_fields_strip_every_named_hop_header() {
        let first = HeaderName::from_static("x-first-hop");
        let second = HeaderName::from_static("x-second-hop");
        let mut request = HeaderMap::new();
        request.append(header::CONNECTION, HeaderValue::from_static("x-first-hop"));
        request.append(header::CONNECTION, HeaderValue::from_static("x-second-hop"));
        request.insert(first.clone(), HeaderValue::from_static("secret"));
        request.insert(second.clone(), HeaderValue::from_static("secret"));
        strip_inbound_headers(&mut request);
        assert!(!request.contains_key(&first));
        assert!(!request.contains_key(&second));

        let mut response = HeaderMap::new();
        response.append(header::CONNECTION, HeaderValue::from_static("x-first-hop"));
        response.append(header::CONNECTION, HeaderValue::from_static("x-second-hop"));
        response.insert(first.clone(), HeaderValue::from_static("secret"));
        response.insert(second.clone(), HeaderValue::from_static("secret"));
        let stripped = strip_response_headers(&response);
        assert!(!stripped.iter().any(|(name, _)| name == first));
        assert!(!stripped.iter().any(|(name, _)| name == second));
    }

    #[test]
    fn upstream_cookies_cannot_cross_tenants_or_clobber_gateway_authority() {
        let mut headers = HeaderMap::new();
        headers.append(
            header::SET_COOKIE,
            HeaderValue::from_static("theme=dark; Path=/; SameSite=Lax"),
        );
        for blocked in [
            "wide=attacker; Domain=p1.usr.chan.app; Path=/",
            "wide=attacker; dOmAiN = p1.usr.chan.app; Path=/",
            "wide=attacker;  DOMAIN=p1.usr.chan.app",
            "__Host-devserver_gate=attacker; Path=/; Secure",
            "__Host-devserver_csrf=attacker; Path=/; Secure",
            "__host-DevServer_Gate=attacker; Path=/; Secure",
            "devserver_gate=attacker; Path=/",
            "devserver_csrf=attacker; Path=/",
            "DevServer_Gate=attacker; Path=/",
        ] {
            headers.append(header::SET_COOKIE, HeaderValue::from_static(blocked));
        }

        let stripped = strip_response_headers(&headers);
        let cookies = stripped
            .iter()
            .filter(|(name, _)| name == header::SET_COOKIE)
            .map(|(_, value)| value.to_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(cookies, ["theme=dark; Path=/; SameSite=Lax"]);
    }

    #[test]
    fn is_management_path_matches_devserver_api() {
        assert!(is_management_path("/api/devserver"));
        assert!(is_management_path("/api/devserver/workspaces"));
        assert!(is_management_path("/api/devserver/x/y"));
        // Tenant content that merely shares a prefix must NOT be 404'd.
        assert!(!is_management_path("/api/devserver-notes"));
        assert!(!is_management_path("/blog/api/devserver"));
        assert!(!is_management_path("/"));
        assert!(!is_management_path("/blog/"));
    }

    #[test]
    fn forward_path_preserves_segment() {
        // Segment-preserving: the {workspace} segment is forwarded
        // unchanged, and normal forwarding preserves the query.
        let u = |s: &str| s.parse::<Uri>().unwrap();
        assert_eq!(forward_path(&u("/blog/")), "/blog/");
        assert_eq!(forward_path(&u("/blog/assets/x.js")), "/blog/assets/x.js");
        assert_eq!(forward_path(&u("/blog/?a=1")), "/blog/?a=1");
        assert_eq!(forward_path(&u("/blog")), "/blog");
    }

    #[test]
    fn forward_path_preserves_t_param_for_upstream_tenants() {
        let u = |s: &str| s.parse::<Uri>().unwrap();
        assert_eq!(
            forward_path(&u("/blog/path?a=1&t=secret&b=2")),
            "/blog/path?a=1&t=secret&b=2"
        );
    }

    #[test]
    fn transfer_route_classification_requires_the_sanctioned_method_and_query() {
        let class = transfer_route_class as fn(&Method, &str) -> Option<TransferRoute>;
        let bulk = |m: Option<TransferRoute>| matches!(m, Some(TransferRoute::Bulk));
        let copy = |m: Option<TransferRoute>| matches!(m, Some(TransferRoute::ServerSideCopy));

        // The sanctioned bulk shapes.
        assert!(bulk(class(&Method::POST, "/blog/api/files/upload")));
        assert!(bulk(class(
            &Method::GET,
            "/blog/api/files/big.bin?download=1"
        )));
        assert!(bulk(class(
            &Method::GET,
            "/t/api/files/archive.tar?download=true"
        )));
        assert!(copy(class(&Method::POST, "/blog/api/fs/transfer")));

        // The same paths under the wrong method stay general.
        for method in [Method::GET, Method::PUT, Method::DELETE] {
            assert!(
                class(&method, "/blog/api/files/upload").is_none(),
                "{method}"
            );
            assert!(
                class(&method, "/blog/api/fs/transfer").is_none(),
                "{method}"
            );
        }
        for method in [Method::POST, Method::PUT, Method::DELETE] {
            assert!(
                class(&method, "/blog/api/files/big.bin?download=1").is_none(),
                "{method}"
            );
        }

        // GET on the file surface needs a truthy `download` flag.
        for path in [
            // Plain read.
            "/blog/api/files/notes/x.md",
            // Streamed editor read.
            "/blog/api/files/big.bin?stream=1",
            // Falsy and bare flag values.
            "/blog/api/files/big.bin?download=0",
            "/blog/api/files/big.bin?download",
            // Flag on another key.
            "/blog/api/files/big.bin?download2=1",
        ] {
            assert!(class(&Method::GET, path).is_none(), "{path}");
        }

        // The server's full accepted truthy set qualifies.
        for value in ["1", "true", "TRUE", "yes", "YES", "on", "ON"] {
            let path = format!("/blog/api/files/big.bin?download={value}");
            assert!(bulk(class(&Method::GET, &path)), "{path}");
        }

        // The query is form-decoded like the server's extractor: `%31`
        // reaches the classifier as the accepted value `1`.
        assert!(bulk(class(
            &Method::GET,
            "/blog/api/files/big.bin?download=%31"
        )));

        // Duplicate `download` fields keep the general policy because
        // the server extractor rejects duplicate struct fields, and an
        // encoded falsy value stays falsy.
        for path in [
            "/blog/api/files/big.bin?download=1&download=1",
            "/blog/api/files/big.bin?download=0&download=1",
            "/blog/api/files/big.bin?download=%30",
        ] {
            assert!(class(&Method::GET, path).is_none(), "{path}");
        }

        // Bare listing/create, other tenant APIs, and root-level paths
        // are never transfer routes.
        for (method, path) in [
            (Method::GET, "/blog/api/files"),
            (Method::GET, "/blog/api/files?dir=sub&download=1"),
            (Method::POST, "/blog/api/files"),
            (Method::POST, "/api/files/upload"),
            (Method::GET, "/api/files/big.bin?download=1"),
            (Method::POST, "/api/fs/transfer"),
            (Method::GET, "/blog/api/graph"),
            (Method::GET, "/blog/api/config"),
            (Method::GET, "/blog/"),
            (Method::GET, "/blog"),
            (Method::GET, "/"),
        ] {
            assert!(class(&method, path).is_none(), "{method} {path}");
        }
    }

    #[test]
    fn transfer_route_policy_replaces_the_general_caps() {
        let mut cfg = test_config();
        cfg.max_request_bytes = Some(64);
        cfg.max_response_bytes = Some(128);
        cfg.request_timeout = Some(std::time::Duration::from_secs(60));

        let transfer = route_body_policy(&cfg, &Method::GET, "/blog/api/files/big.bin?download=1");
        assert_eq!(
            transfer.max_request_bytes,
            Some(crate::config::TRANSFER_ROUTE_MAX_BYTES)
        );
        assert_eq!(
            transfer.max_response_bytes,
            Some(crate::config::TRANSFER_ROUTE_MAX_BYTES)
        );
        assert_eq!(
            transfer.request_timeout,
            Some(crate::config::TRANSFER_ROUTE_TIMEOUT)
        );

        // The server-side copy relaxes only the deadline; its JSON
        // request and response keep the general byte caps.
        let copy = route_body_policy(&cfg, &Method::POST, "/blog/api/fs/transfer");
        assert_eq!(copy.max_request_bytes, Some(64));
        assert_eq!(copy.max_response_bytes, Some(128));
        assert_eq!(
            copy.request_timeout,
            Some(crate::config::TRANSFER_ROUTE_TIMEOUT)
        );

        let general = route_body_policy(&cfg, &Method::GET, "/blog/api/graph");
        assert_eq!(general.max_request_bytes, Some(64));
        assert_eq!(general.max_response_bytes, Some(128));
        assert_eq!(
            general.request_timeout,
            Some(std::time::Duration::from_secs(60))
        );
    }

    #[test]
    fn declared_response_over_cap_skips_head_and_unknown_lengths() {
        let mut headers = HeaderMap::new();
        headers.insert(header::CONTENT_LENGTH, "8192".parse().unwrap());

        // A non-HEAD response declared over the cap is refused.
        assert!(declared_response_over_cap(&Method::GET, &headers, 1024));
        assert!(declared_response_over_cap(&Method::POST, &headers, 1024));

        // HEAD declares the representation length but carries no body,
        // so an over-cap declared length is not a refusal.
        assert!(!declared_response_over_cap(&Method::HEAD, &headers, 1024));

        // At the exact cap boundary the response passes.
        assert!(!declared_response_over_cap(&Method::GET, &headers, 8192));

        // A declared length beyond 32-bit usize range still compares
        // correctly as u64.
        headers.insert(
            header::CONTENT_LENGTH,
            "18446744073709551615".parse().unwrap(),
        );
        assert!(declared_response_over_cap(&Method::GET, &headers, 1024));

        // No declared length streams through the Limited backstop.
        assert!(!declared_response_over_cap(
            &Method::GET,
            &HeaderMap::new(),
            1024
        ));

        // An unparseable declared length is not a refusal here.
        headers.insert(header::CONTENT_LENGTH, "not-a-number".parse().unwrap());
        assert!(!declared_response_over_cap(&Method::GET, &headers, 1024));
    }

    /// Minimal Config for policy tests: every field inert, only the
    /// cap/deadline knobs vary.
    fn test_config() -> crate::config::Config {
        crate::config::Config {
            bind_addr: "127.0.0.1:0".parse().unwrap(),
            tunnel_bind_addr: "127.0.0.1:0".parse().unwrap(),
            apex_host: String::new(),
            wildcard_suffix: String::new(),
            identity_url: "http://127.0.0.1/".parse().unwrap(),
            identity_auth_token: String::new(),
            dashboard_url: String::new(),
            identity_origin: devserver_control_proto::CanonicalOrigin::parse("https://gw.chan.app")
                .unwrap(),
            entry_verifiers: gateway_common::devserver_gate::EntryVerifierRing::from_base64_list(
                &gateway_common::devserver_gate::EntrySigner::from_base64(
                    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                )
                .unwrap()
                .verifying_key_base64(),
            )
            .unwrap(),
            admission_lease_verifier: devserver_control_proto::AdmissionLeaseVerifier::from_base64(
                &devserver_control_proto::AdmissionLeaseSigner::from_base64(
                    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                )
                .unwrap()
                .verifying_key_base64(),
            )
            .unwrap(),
            control_url: "http://127.0.0.1/".parse().unwrap(),
            proxy_token: String::new(),
            proxy_id: devserver_control_proto::ProxyId::parse("p1").unwrap(),
            proxy_base_url: devserver_control_proto::CanonicalOrigin::parse(
                "https://p1.usr.chan.app",
            )
            .unwrap(),
            max_response_bytes: None,
            max_request_bytes: None,
            request_timeout: None,
            ws_idle_timeout: crate::config::DEFAULT_WS_IDLE_TIMEOUT,
            session_max_active: 1,
            session_lifetime: std::time::Duration::from_secs(60),
            entry_replay_max_active: 1,
            forwarded_proto: "https".into(),
        }
    }

    #[test]
    fn cookie_values_extracts_named_cookie() {
        let mut h = HeaderMap::new();
        h.insert(
            header::COOKIE,
            HeaderValue::from_static("foo=bar; __Host-devserver_gate=abc.def.ghi; baz=qux"),
        );
        assert_eq!(
            cookie_values(&h, COOKIE_NAME),
            vec!["abc.def.ghi".to_string()]
        );

        // Duplicate cookies: caller is responsible for picking the
        // first that verifies. We return them in header order.
        let mut h = HeaderMap::new();
        h.append(
            header::COOKIE,
            HeaderValue::from_static("__Host-devserver_gate=stale.1.x"),
        );
        h.append(
            header::COOKIE,
            HeaderValue::from_static("__Host-devserver_gate=fresh.2.y"),
        );
        assert_eq!(
            cookie_values(&h, COOKIE_NAME),
            vec!["stale.1.x", "fresh.2.y"]
        );

        // RFC-style quoted value: quotes stripped.
        let mut h = HeaderMap::new();
        h.insert(
            header::COOKIE,
            HeaderValue::from_static("__Host-devserver_gate=\"abc.def.ghi\""),
        );
        assert_eq!(
            cookie_values(&h, COOKIE_NAME),
            vec!["abc.def.ghi".to_string()]
        );

        let mut h = HeaderMap::new();
        h.insert(header::COOKIE, HeaderValue::from_static("foo=bar"));
        assert!(cookie_values(&h, COOKIE_NAME).is_empty());

        assert!(cookie_values(&HeaderMap::new(), COOKIE_NAME).is_empty());
    }

    #[test]
    fn has_gate_credential_detects_only_opaque_cookie() {
        let u = |s: &str| s.parse::<Uri>().unwrap();
        let empty = HeaderMap::new();
        // Naked root: no token, no cookie -> bounce to dashboard.
        assert!(!has_gate_credential(&u("/"), &empty));
        // URL query bearers never count as gateway credentials.
        assert!(!has_gate_credential(&u("/?t=abc.def.ghi"), &empty));
        assert!(!has_gate_credential(&u("/?t="), &empty));
        // A `__Host-devserver_gate` session cookie -> authenticated open.
        let mut h = HeaderMap::new();
        h.insert(
            header::COOKIE,
            HeaderValue::from_static("__Host-devserver_gate=abc.def.ghi"),
        );
        assert!(has_gate_credential(&u("/"), &h));
        // An unrelated cookie is not a credential.
        let mut h = HeaderMap::new();
        h.insert(header::COOKIE, HeaderValue::from_static("foo=bar"));
        assert!(!has_gate_credential(&u("/"), &h));
    }

    #[test]
    fn websocket_upgrade_detected() {
        let mut h = HeaderMap::new();
        h.insert(header::UPGRADE, HeaderValue::from_static("websocket"));
        h.insert(header::CONNECTION, HeaderValue::from_static("Upgrade"));
        assert!(is_websocket_upgrade(&h));

        // Connection list with extra options around Upgrade.
        h.insert(
            header::CONNECTION,
            HeaderValue::from_static("keep-alive, Upgrade"),
        );
        assert!(is_websocket_upgrade(&h));

        // Non-WS upgrade.
        h.insert(header::UPGRADE, HeaderValue::from_static("h2c"));
        assert!(!is_websocket_upgrade(&h));

        // No upgrade headers.
        let h = HeaderMap::new();
        assert!(!is_websocket_upgrade(&h));
    }

    const TEST_CAPABILITY: &str =
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn extension_capability_shape_is_exact() {
        let admitted = |path: &str| is_extension_capability_path(path);

        // The admitted shape: entry root and deeper assets.
        assert!(admitted(&format!(
            "/notes/_chan/extensions/echo/{TEST_CAPABILITY}/"
        )));
        assert!(admitted(&format!(
            "/notes/_chan/extensions/echo/{TEST_CAPABILITY}/app.js"
        )));
        assert!(admitted(&format!(
            "/notes/_chan/extensions/echo/{TEST_CAPABILITY}/assets/deep/x.wasm"
        )));

        // Everything looser stays behind the session gate.
        for path in [
            // No trailing slash after the capability.
            &format!("/notes/_chan/extensions/echo/{TEST_CAPABILITY}") as &str,
            // Capability too short / too long / non-hex / uppercase.
            "/notes/_chan/extensions/echo/0123abc/",
            &format!("/notes/_chan/extensions/echo/{TEST_CAPABILITY}0/"),
            "/notes/_chan/extensions/echo/ZZ23456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef/",
            &format!(
                "/notes/_chan/extensions/echo/{}/",
                TEST_CAPABILITY.to_ascii_uppercase()
            ),
            // Missing pieces of the namespace.
            &format!("/_chan/extensions/echo/{TEST_CAPABILITY}/"),
            &format!("/notes/_chan/extension/echo/{TEST_CAPABILITY}/"),
            &format!("/notes/chan/extensions/echo/{TEST_CAPABILITY}/"),
            &format!("/notes/_chan/extensions//{TEST_CAPABILITY}/"),
            // Tenant root and ordinary tenant content.
            "/",
            "/notes/",
            "/notes/api/extensions",
        ] {
            assert!(!admitted(path), "{path}");
        }
    }

    #[test]
    fn loggable_uri_redacts_only_the_capability_segment() {
        let u = |s: &str| s.parse::<Uri>().unwrap();

        let uri = u(&format!(
            "/notes/_chan/extensions/echo/{TEST_CAPABILITY}/app.js?v=1"
        ));
        let logged = loggable_uri(&uri);
        assert!(!logged.contains(TEST_CAPABILITY));
        assert_eq!(
            logged,
            "/notes/_chan/extensions/echo/[capability]/app.js?v=1"
        );

        // Ordinary URIs pass through unchanged, query included.
        for raw in ["/notes/api/graph?x=1", "/", "/blog/assets/app.js"] {
            assert_eq!(loggable_uri(&u(raw)), raw);
        }
    }

    fn test_state() -> AppState {
        AppState {
            cfg: std::sync::Arc::new(test_config()),
            registry: crate::registry::Registry::new(),
            readiness: tokio::sync::watch::channel(true).1,
            sessions: crate::session_store::SessionStore::new(
                4,
                std::time::Duration::from_secs(60),
            ),
            entry_replays: crate::entry_replay::EntryReplayCache::new(4),
        }
    }

    fn tenant_request(path: &str) -> Request {
        Request::builder()
            .uri(path)
            .header(header::HOST, "alice--0123456789ab.p1.usr.chan.app")
            .header(header::ORIGIN, "null")
            .body(Body::empty())
            .unwrap()
    }

    /// With no live devserver both lanes 404, but only the extension
    /// capability namespace answers CORS-readably; the tenant surface
    /// keeps today's bare anti-enumeration shape byte for byte.
    #[tokio::test]
    async fn extension_namespace_404s_carry_the_policy_and_the_tenant_stays_bare() {
        let state = test_state();
        let path = format!("/notes/_chan/extensions/echo/{TEST_CAPABILITY}/app.js");
        let response = handle(
            state.clone(),
            "alice".to_string(),
            Some("0123456789ab".to_string()),
            tenant_request(&path),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            response
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .expect("ACAO on the extension namespace 404"),
            "null"
        );
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "private, no-store"
        );

        for bare in ["/notes/", "/notes/api/graph"] {
            let response = handle(
                state.clone(),
                "alice".to_string(),
                Some("0123456789ab".to_string()),
                tenant_request(bare),
            )
            .await;
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{bare}");
            assert!(
                response
                    .headers()
                    .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                    .is_none(),
                "{bare} must stay CORS-opaque"
            );
            let body = axum::body::to_bytes(response.into_body(), 1024)
                .await
                .expect("body");
            assert_eq!(body.as_ref(), br#"{"error":"not found"}"#);
        }
    }

    #[test]
    fn only_extension_proxy_responses_are_same_origin_frameable() {
        assert!(is_extension_proxy_path(
            "/notes/_chan/extensions/echo/capability/index.html?v=1"
        ));
        assert!(!is_extension_proxy_path("/notes/api/extensions"));
        assert!(!is_extension_proxy_path(
            "/notes/_chan/extension/echo/index.html"
        ));

        let mut extension = StatusCode::OK.into_response();
        apply_credentialed_response_policy(&mut extension, true);
        assert_eq!(
            extension.headers().get("content-security-policy").unwrap(),
            "frame-ancestors 'self'"
        );

        let mut ordinary = StatusCode::OK.into_response();
        apply_credentialed_response_policy(&mut ordinary, false);
        assert_eq!(
            ordinary.headers().get("content-security-policy").unwrap(),
            "frame-ancestors 'none'"
        );
    }

    #[test]
    fn exact_identity_origin_passes_entry_gate() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static(TEST_IDENTITY_ORIGIN),
        );
        assert!(exact_origin_matches(&headers, TEST_IDENTITY_ORIGIN));
    }

    #[test]
    fn exact_origin_requires_one_exact_non_null_value() {
        let mut headers = HeaderMap::new();
        assert!(!exact_origin_matches(&headers, TEST_IDENTITY_ORIGIN));
        headers.append(header::ORIGIN, HeaderValue::from_static("null"));
        assert!(!exact_origin_matches(&headers, TEST_IDENTITY_ORIGIN));
        headers.clear();
        headers.append(
            header::ORIGIN,
            HeaderValue::from_static(TEST_IDENTITY_ORIGIN),
        );
        assert!(exact_origin_matches(&headers, TEST_IDENTITY_ORIGIN));
        headers.append(
            header::ORIGIN,
            HeaderValue::from_static(TEST_IDENTITY_ORIGIN),
        );
        assert!(!exact_origin_matches(&headers, TEST_IDENTITY_ORIGIN));
        headers.clear();
        headers.append(
            header::ORIGIN,
            HeaderValue::from_static("https://GW.chan.app"),
        );
        assert!(!exact_origin_matches(&headers, TEST_IDENTITY_ORIGIN));
    }

    #[test]
    fn websocket_origin_requires_one_exact_canonical_value() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://alice--0123456789ab.p1.usr.chan.app"),
        );
        assert!(websocket_origin_matches(
            &headers,
            "https",
            "alice--0123456789ab.p1.usr.chan.app"
        ));

        for origin in [
            "null",
            "http://alice--0123456789ab.p1.usr.chan.app",
            "https://bob--0123456789ab.p1.usr.chan.app",
            "https://alice--0123456789ab.p1.usr.chan.app:7002",
            "https://alice--0123456789ab.p1.usr.chan.app/path",
            "HTTPS://alice--0123456789ab.p1.usr.chan.app",
        ] {
            headers.insert(header::ORIGIN, HeaderValue::from_str(origin).unwrap());
            assert!(!websocket_origin_matches(
                &headers,
                "https",
                "alice--0123456789ab.p1.usr.chan.app"
            ));
        }

        headers.clear();
        assert!(!websocket_origin_matches(
            &headers,
            "https",
            "alice--0123456789ab.p1.usr.chan.app"
        ));
        headers.append(
            header::ORIGIN,
            HeaderValue::from_static("https://alice--0123456789ab.p1.usr.chan.app"),
        );
        headers.append(
            header::ORIGIN,
            HeaderValue::from_static("https://alice--0123456789ab.p1.usr.chan.app"),
        );
        assert!(!websocket_origin_matches(
            &headers,
            "https",
            "alice--0123456789ab.p1.usr.chan.app"
        ));
    }
}
