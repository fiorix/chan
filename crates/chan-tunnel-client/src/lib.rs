//! chan-tunnel client library.
//!
//! Used by `chan devserver run --tunnel-token ...`. `run` is the
//! entry point: it dials the gateway's tunnel endpoint over h2/TLS
//! (h2c for an `http://` URL to a loopback peer), runs `handshake`
//! over the resulting bidirectional h2 stream, serves every yamux
//! substream with the caller's `axum::Router` via hyper, and redials
//! with backoff when the tunnel drops.
//!
//! `dial`, `handshake` and `serve_substreams` are also exposed on
//! their own, so a test can drive one stage in isolation.

#![forbid(unsafe_code)]

mod dial;

pub use dial::{build_tls_config, dial, dial_with_tls};

use std::sync::Arc;
use std::time::Duration;

use chan_tunnel_proto::{read_frame, write_frame, Hello, HelloAck, ProtocolVersion};
use futures::AsyncRead as FutAsyncRead;
use futures::AsyncWrite as FutAsyncWrite;
use hyper_util::rt::TokioIo;
use hyper_util::service::TowerToHyperService;
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{mpsc, OwnedSemaphorePermit, Semaphore};
use tokio_util::compat::{Compat, FuturesAsyncReadCompatExt, TokioAsyncReadCompatExt};
use url::Url;
use yamux::{Config as YamuxConfig, Connection as YamuxConnection, Mode};

#[derive(Debug, Error)]
pub enum ClientError {
    #[error("invalid tunnel url: {0}")]
    InvalidUrl(String),

    #[error("tls: {0}")]
    Tls(String),

    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("handshake: {0}")]
    Handshake(String),

    /// Structured refusal from the server during the Hello/HelloAck
    /// round-trip. The `code` is one of
    /// `chan_tunnel_proto::error_code` (or an unknown string from a
    /// newer server); the `message` is human-readable. UI / CLI
    /// callers should match on `code` for known cases and fall back
    /// to `message` otherwise.
    #[error("server refused handshake: {code} ({message})")]
    RemoteRefusal { code: String, message: String },

    #[error("transport closed")]
    TransportClosed,
}

/// Default concurrent yamux substreams served by one client.
/// This bounds the h1 handler work running at once when the public
/// side floods a tunnel. Excess substreams are still accepted, and
/// wait for a permit before they are served; how many can exist at
/// all is bounded by `TUNNEL_YAMUX_MAX_STREAMS`.
pub const DEFAULT_MAX_CONCURRENT_SUBSTREAMS: usize = 128;
const LEASE_REFRESH_INTERVAL: Duration = Duration::from_secs(60);
const LEASE_REFRESH_RETRY_MIN: Duration = Duration::from_secs(5);
const LEASE_REFRESH_RETRY_MAX: Duration = Duration::from_secs(30);

impl From<chan_tunnel_proto::FrameError> for ClientError {
    fn from(e: chan_tunnel_proto::FrameError) -> Self {
        ClientError::Handshake(e.to_string())
    }
}

impl From<chan_tunnel_proto::IoFrameError> for ClientError {
    fn from(e: chan_tunnel_proto::IoFrameError) -> Self {
        match e {
            chan_tunnel_proto::IoFrameError::Io(e) => ClientError::Io(e),
            chan_tunnel_proto::IoFrameError::Frame(e) => ClientError::Handshake(e.to_string()),
        }
    }
}

/// Configuration for the dial loop. The token is intentionally a
/// `String` rather than borrowed: the dial loop may reconnect, and
/// holding a borrow across reconnects forces the caller into
/// awkward lifetimes.
#[derive(Clone)]
pub struct ClientConfig {
    pub tunnel_url: Url,
    pub token: String,
    /// Required Hello workspace field, validated as a workspace name. The devserver sends `"devserver"`; registration and the acknowledged prefix use the token-resolved devserver id, while tenant paths route within that registration.
    pub workspace: String,
    /// Display name sent in the Hello frame, for the gateway roster
    /// (`chan devserver run --tunnel-devserver-name`). Optional and
    /// routing-inert: servers that predate the field ignore it.
    pub name: Option<String>,
    /// `chan` version reported in the Hello frame; logs only.
    pub client_version: String,
    /// Initial reconnect backoff. Doubled up to `max_backoff`.
    pub initial_backoff: Duration,
    pub max_backoff: Duration,
    /// Wall-clock cap on a single dial attempt: TCP connect, TLS,
    /// h2 handshake, response, Hello/HelloAck. Without this, an
    /// unreachable host or a black-holed network can hang each
    /// attempt for the OS-level TCP timeout (minutes), defeating
    /// the retry backoff. 30s covers the trans-pacific case with
    /// margin; bump for satellite links.
    pub dial_timeout: Duration,
    /// Optional channel for `run` to publish lifecycle events on.
    /// Useful when the caller wants to surface "connected", "lost
    /// connection", "retrying in Xs" to its own UI. Backpressure:
    /// `run` uses `try_send`, so a slow consumer drops events
    /// rather than blocking the tunnel.
    pub events: Option<mpsc::Sender<TunnelEvent>>,
    /// Optional outbound HTTP proxy. When set, the client opens a
    /// TCP connection to the proxy and runs an HTTP/1.1 CONNECT to
    /// the tunnel host:port; TLS (if any) and h2 then run inside
    /// the resulting tunnel. Supports basic auth via the URL's
    /// userinfo (`http://user:pass@proxy.example:3128`). Schemes:
    /// `http://` only (plain CONNECT). HTTPS-to-proxy and SOCKS
    /// are out of scope; route those through a local stunnel /
    /// SOCKS-to-HTTP shim if needed.
    ///
    /// Env vars (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`) are NOT
    /// honoured automatically: the embedded callers (Swift /
    /// Kotlin / CLI) get a deterministic surface this way.
    pub proxy: Option<Url>,
    /// Max concurrent inbound yamux substreams served by this
    /// client. Values below 1 are clamped to 1. Default 128.
    pub max_concurrent_substreams: usize,
}

impl std::fmt::Debug for ClientConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ClientConfig")
            .field("tunnel_url", &url_without_userinfo(&self.tunnel_url))
            .field("token", &"[REDACTED]")
            .field("workspace", &self.workspace)
            .field("name", &self.name)
            .field("client_version", &self.client_version)
            .field("initial_backoff", &self.initial_backoff)
            .field("max_backoff", &self.max_backoff)
            .field("dial_timeout", &self.dial_timeout)
            .field("events", &self.events.as_ref().map(|_| "configured"))
            .field("proxy", &self.proxy.as_ref().map(url_without_userinfo))
            .field("max_concurrent_substreams", &self.max_concurrent_substreams)
            .finish()
    }
}

fn url_without_userinfo(url: &Url) -> Url {
    let mut sanitized = url.clone();
    let _ = sanitized.set_password(None);
    let _ = sanitized.set_username("");
    sanitized
}

impl Default for ClientConfig {
    fn default() -> Self {
        Self {
            tunnel_url: Url::parse("https://workspace.chan.app/v1/tunnel")
                .expect("hard-coded url is valid"),
            token: String::new(),
            workspace: String::new(),
            name: None,
            client_version: format!("chan-tunnel-client/{}", env!("CARGO_PKG_VERSION")),
            initial_backoff: Duration::from_millis(500),
            max_backoff: Duration::from_secs(30),
            dial_timeout: Duration::from_secs(30),
            events: None,
            proxy: None,
            max_concurrent_substreams: DEFAULT_MAX_CONCURRENT_SUBSTREAMS,
        }
    }
}

/// What the server told the client during HelloAck. `run` logs it,
/// emits it in `TunnelEvent::Connected`, and attaches it to every
/// request it serves as an `axum::Extension`. Nothing routes on
/// `prefix`: a devserver tenant serves at its own public slug.
/// `chan devserver` checks `workspace` (the token-resolved devserver
/// id) and `owner_user_id` against each request's gateway assertion.
#[derive(Debug, Clone)]
pub struct Registration {
    pub prefix: String,
    pub user: String,
    pub workspace: String,
    /// Immutable owner id resolved by the gateway from the tunnel PAT.
    pub owner_user_id: String,
}

/// Lifecycle events emitted by `run`. Callers subscribe via
/// `ClientConfig::events`. Cloning these is cheap; they're meant
/// to be tee'd to logs and a UI.
#[derive(Debug, Clone)]
pub enum TunnelEvent {
    /// A successful registration. Carries the server-assigned
    /// public prefix.
    Connected(Registration),
    /// The currently-registered tunnel ended (clean close from the
    /// server, or substream-loop error). `run` will sleep for
    /// `retry_in` then dial again.
    Disconnected { retry_in: Duration },
    /// Dial failed before registration (TLS error, h2 error, 401,
    /// network unreachable, etc.). `run` will sleep for `retry_in`
    /// then try again. `error` is best-effort human-readable.
    DialFailed { error: String, retry_in: Duration },
}

/// Drive the Hello/HelloAck round-trip over `socket` and return a
/// yamux client connection ready to accept inbound substreams.
///
/// Generic in `S`: `dial_with_tls` passes the tunnel POST's h2
/// request and response streams wrapped in
/// `chan_tunnel_proto::H2Duplex`, and a test that runs its own h2
/// exchange passes the same adapter. The yamux `Connection` returned
/// holds ownership of the socket via a `tokio-util` compat shim;
/// substreams it produces also use futures-io traits.
pub async fn handshake<S>(
    cfg: &ClientConfig,
    mut socket: S,
) -> Result<(Registration, YamuxConnection<Compat<S>>), ClientError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    if !chan_tunnel_proto::is_valid_workspace_name(&cfg.workspace) {
        return Err(ClientError::Handshake(format!(
            "invalid workspace name {:?}; expected lowercase [a-z0-9-], 1-{} chars, no leading/trailing hyphen",
            cfg.workspace,
            chan_tunnel_proto::MAX_WORKSPACE_NAME_LEN,
        )));
    }
    let hello = Hello {
        protocol: ProtocolVersion::V1,
        client_version: cfg.client_version.clone(),
        workspace: cfg.workspace.clone(),
        name: cfg.name.clone(),
    };
    write_frame(&mut socket, &hello).await?;

    let ack: HelloAck = read_frame(&mut socket).await?;
    let ok = match ack {
        HelloAck::Ok(ok) => ok,
        HelloAck::Refused(err) => {
            return Err(ClientError::RemoteRefusal {
                code: err.code,
                message: err.message,
            });
        }
    };
    if ok.protocol != ProtocolVersion::V1 {
        return Err(ClientError::Handshake(format!(
            "server returned unsupported protocol {:?}",
            ok.protocol
        )));
    }

    let registration = Registration {
        prefix: ok.prefix,
        user: ok.user,
        workspace: ok.workspace,
        owner_user_id: ok.owner_user_id,
    };
    let yamux = YamuxConnection::new(socket.compat(), tunnel_yamux_config(), Mode::Client);
    Ok((registration, yamux))
}

/// Yamux client config matching the terminator's: one shared stream cap
/// and connection receive window so bulk transfer is tuned identically
/// on both peers. yamux auto-tunes each stream's window from the 256
/// KiB protocol default toward the bandwidth-delay product, bounded by
/// the connection-wide budget.
fn tunnel_yamux_config() -> YamuxConfig {
    let mut cfg = YamuxConfig::default();
    cfg.set_max_num_streams(chan_tunnel_proto::TUNNEL_YAMUX_MAX_STREAMS)
        .set_max_connection_receive_window(Some(
            chan_tunnel_proto::TUNNEL_YAMUX_CONNECTION_RECEIVE_WINDOW,
        ));
    cfg
}

/// Serve every inbound yamux substream with `router` until the
/// connection closes. Each substream is one HTTP/1.1 request from
/// the public side; we run hyper's h1 server over it with the
/// user-supplied axum router as the service.
///
/// `with_upgrades()` is enabled so the substream stays alive after
/// a WebSocket 101 response; the bytes ride the existing yamux
/// substream until either end closes.
pub async fn serve_substreams<S>(
    conn: YamuxConnection<S>,
    router: axum::Router,
) -> Result<(), ClientError>
where
    S: FutAsyncRead + FutAsyncWrite + Unpin + Send + 'static,
{
    serve_substreams_with_limit(conn, router, DEFAULT_MAX_CONCURRENT_SUBSTREAMS).await
}

/// Same as [`serve_substreams`], with an explicit concurrency cap.
pub async fn serve_substreams_with_limit<S>(
    conn: YamuxConnection<S>,
    router: axum::Router,
    max_concurrent_substreams: usize,
) -> Result<(), ClientError>
where
    S: FutAsyncRead + FutAsyncWrite + Unpin + Send + 'static,
{
    serve_substreams_inner(conn, router, max_concurrent_substreams, None).await
}

async fn serve_substreams_inner<S>(
    mut conn: YamuxConnection<S>,
    router: axum::Router,
    max_concurrent_substreams: usize,
    refresh_token: Option<String>,
) -> Result<(), ClientError>
where
    S: FutAsyncRead + FutAsyncWrite + Unpin + Send + 'static,
{
    let limit = max_concurrent_substreams.max(1);
    let permits = Arc::new(Semaphore::new(limit));
    let (refresh_tx, mut refresh_rx) = mpsc::channel(1);
    let mut refresh_delay = Box::pin(tokio::time::sleep(LEASE_REFRESH_INTERVAL));
    let mut refresh_retry = LEASE_REFRESH_RETRY_MIN;
    let mut refresh_pending = false;
    loop {
        tokio::select! {
            result = refresh_rx.recv(), if refresh_pending => {
                refresh_pending = false;
                match result {
                    Some(Ok(())) => {
                        refresh_retry = LEASE_REFRESH_RETRY_MIN;
                        refresh_delay.as_mut().reset(tokio::time::Instant::now() + LEASE_REFRESH_INTERVAL);
                    }
                    Some(Err(error)) => {
                        tracing::warn!(error = %error, "admission lease refresh failed; retrying before expiry");
                        let delay = jittered(refresh_retry);
                        refresh_retry = (refresh_retry * 2).min(LEASE_REFRESH_RETRY_MAX);
                        refresh_delay.as_mut().reset(tokio::time::Instant::now() + delay);
                    }
                    None => return Err(ClientError::TransportClosed),
                }
            }
            _ = &mut refresh_delay, if refresh_token.is_some() && !refresh_pending => {
                let stream = futures::future::poll_fn(|cx| {
                    std::pin::Pin::new(&mut conn).poll_new_outbound(cx)
                })
                .await
                .map_err(|_| ClientError::TransportClosed)?;
                let token = refresh_token.clone().expect("select guard requires token");
                let refresh_tx = refresh_tx.clone();
                refresh_pending = true;
                tokio::spawn(async move {
                    let result = refresh_lease(stream, token).await;
                    let _ = refresh_tx.send(result).await;
                });
            }
            // Polled unconditionally, whatever the permit pool is
            // doing: `poll_next_inbound` is the only yamux entry point
            // that drives the connection, so gating it on a free permit
            // would stop reads, writes, flushes and keepalives for the
            // substreams already in flight, not just for the new one.
            // The permit is admission control for the work; how many
            // substreams may exist at all is yamux's own
            // `TUNNEL_YAMUX_MAX_STREAMS` accounting.
            next = futures::future::poll_fn(|cx| std::pin::Pin::new(&mut conn).poll_next_inbound(cx)) => match next {
            Some(Ok(stream)) => {
                let router = router.clone();
                let permits = permits.clone();
                tokio::spawn(async move {
                    let _permit = acquire_substream_permit(permits).await;
                    #[cfg(test)]
                    let _task_guard = SubstreamServeGuard::new();
                    serve_one_substream(stream, router).await;
                });
            }
            Some(Err(_)) | None => return Ok(()),
            }
        }
    }
}

async fn acquire_substream_permit(permits: Arc<Semaphore>) -> OwnedSemaphorePermit {
    permits
        .acquire_owned()
        .await
        .expect("substream semaphore is never closed")
}

/// Counts substreams being served, which is what the permit pool
/// bounds. A spawned task that is still waiting for its permit is
/// not counted: it holds a substream, not a handler.
#[cfg(test)]
static SERVING_SUBSTREAMS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
#[cfg(test)]
static MAX_SERVING_SUBSTREAMS: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

#[cfg(test)]
struct SubstreamServeGuard;

#[cfg(test)]
impl SubstreamServeGuard {
    fn new() -> Self {
        use std::sync::atomic::Ordering;

        let active = SERVING_SUBSTREAMS.fetch_add(1, Ordering::SeqCst) + 1;
        MAX_SERVING_SUBSTREAMS.fetch_max(active, Ordering::SeqCst);
        Self
    }
}

#[cfg(test)]
impl Drop for SubstreamServeGuard {
    fn drop(&mut self) {
        SERVING_SUBSTREAMS.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

async fn refresh_lease(stream: yamux::Stream, token: String) -> Result<(), ClientError> {
    let mut stream = stream.compat();
    write_frame(
        &mut stream,
        &chan_tunnel_proto::LeaseRefreshRequest { token },
    )
    .await?;
    let response: chan_tunnel_proto::LeaseRefreshResponse = read_frame(&mut stream).await?;
    match response {
        chan_tunnel_proto::LeaseRefreshResponse::Refreshed => Ok(()),
        chan_tunnel_proto::LeaseRefreshResponse::Refused { message } => Err(
            ClientError::Handshake(format!("lease refresh refused: {message}")),
        ),
    }
}

/// Run the tunnel client until cancelled: dial, register, serve
/// substreams, reconnect on disconnect with exponential backoff.
///
/// Designed for `chan devserver` to call as a long-lived future;
/// dropping it cancels everything cleanly. Returns only on
/// configuration errors that retrying cannot recover from
/// (invalid URL, invalid workspace name, missing token).
pub async fn run(cfg: ClientConfig, router: axum::Router) -> Result<(), ClientError> {
    if cfg.token.is_empty() {
        return Err(ClientError::Handshake(
            "ClientConfig.token is empty; nothing to authenticate with".into(),
        ));
    }
    if !chan_tunnel_proto::is_valid_workspace_name(&cfg.workspace) {
        return Err(ClientError::Handshake(format!(
            "invalid workspace name {:?}",
            cfg.workspace
        )));
    }
    dial::validate_tunnel_url(&cfg)?;

    // Build the TLS config once; rustls-native-certs walks the
    // OS trust store on every call (slow on macOS keychain) and
    // the reconnect loop would otherwise re-pay that on every
    // attempt. Lazy: only build for https:// URLs.
    let tls = if cfg.tunnel_url.scheme() == "https" {
        Some(std::sync::Arc::new(build_tls_config()?))
    } else {
        None
    };

    let mut backoff = cfg.initial_backoff;
    loop {
        // Cap a single dial attempt so an unreachable host doesn't
        // hang for minutes (OS TCP timeout) and starve the retry
        // backoff. Per-leg timeouts inside `dial` would be more
        // precise but a single global timeout is the simpler knob
        // and surfaces as one config field.
        let attempt =
            tokio::time::timeout(cfg.dial_timeout, dial_with_tls(&cfg, tls.as_ref())).await;
        let attempt = match attempt {
            Ok(r) => r,
            Err(_) => Err(ClientError::Handshake(format!(
                "dial timed out after {:?}",
                cfg.dial_timeout
            ))),
        };
        match attempt {
            Ok((registration, yconn)) => {
                tracing::info!(
                    user = %registration.user,
                    workspace = %registration.workspace,
                    prefix = %registration.prefix,
                    "tunnel connected",
                );
                emit(&cfg.events, TunnelEvent::Connected(registration.clone()));
                backoff = cfg.initial_backoff;
                let session_router = router.clone().layer(axum::Extension(registration.clone()));
                if let Err(e) = serve_substreams_inner(
                    yconn,
                    session_router,
                    cfg.max_concurrent_substreams,
                    Some(cfg.token.clone()),
                )
                .await
                {
                    tracing::warn!(error = %e, "tunnel substream loop ended");
                } else {
                    tracing::info!("tunnel disconnected");
                }
                emit(&cfg.events, TunnelEvent::Disconnected { retry_in: backoff });
            }
            Err(e) => {
                tracing::warn!(error = %e, ?backoff, "tunnel dial failed; retrying");
                emit(
                    &cfg.events,
                    TunnelEvent::DialFailed {
                        error: e.to_string(),
                        retry_in: backoff,
                    },
                );
            }
        }
        // Jitter the sleep by +/- 20% so a fleet of clients that
        // all disconnected at the same moment (server restart,
        // upstream blip) does not synchronise reconnects into a
        // thundering herd. The base is still doubled deterministically
        // below; only the actual sleep duration is randomised.
        tokio::time::sleep(jittered(backoff)).await;
        backoff = (backoff * 2).min(cfg.max_backoff);
    }
}

/// Apply +/- 20% jitter to a backoff duration. The entropy source
/// is the low bits of the system clock in nanoseconds; this is
/// not cryptographic but reconnect jitter does not need to be.
/// Using a clock-derived seed avoids pulling a `rand` dependency
/// into the client crate.
fn jittered(base: Duration) -> Duration {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    // Map nanos into [-20%, +20%]: pick a value in [-2000, 2000]
    // basis points, scale base by 1.0 + bps/10000.
    let bps = (nanos % 4001) as i64 - 2000;
    let scaled_micros = base.as_micros() as i64 * (10_000 + bps) / 10_000;
    Duration::from_micros(scaled_micros.max(0) as u64)
}

/// Best-effort send. Drops the event if the receiver is gone or
/// full so a slow consumer can't stall the dial loop.
fn emit(tx: &Option<mpsc::Sender<TunnelEvent>>, ev: TunnelEvent) {
    if let Some(tx) = tx {
        let _ = tx.try_send(ev);
    }
}

async fn serve_one_substream(stream: yamux::Stream, router: axum::Router) {
    let io = TokioIo::new(stream.compat());
    // The router takes Request<axum::body::Body>; hyper hands us
    // Request<hyper::body::Incoming>. Wrap the incoming body into
    // axum's so we can call the router. axum's serve helper
    // does the same internally.
    let service = tower::service_fn(move |req: http::Request<hyper::body::Incoming>| {
        let router = router.clone();
        async move {
            let (parts, body) = req.into_parts();
            let req = http::Request::from_parts(parts, axum::body::Body::new(body));
            Ok::<_, std::convert::Infallible>(
                tower::ServiceExt::oneshot(router, req)
                    .await
                    .into_response(),
            )
        }
    });
    let service = TowerToHyperService::new(service);
    if let Err(e) = hyper::server::conn::http1::Builder::new()
        .serve_connection(io, service)
        .with_upgrades()
        .await
    {
        tracing::debug!(error = %e, "substream serve_connection ended");
    }
}

use axum::response::IntoResponse;

#[cfg(test)]
mod backoff_tests {
    use super::*;
    use futures::AsyncWriteExt;
    use std::sync::atomic::Ordering;

    #[test]
    fn jittered_within_band() {
        let base = Duration::from_millis(500);
        for _ in 0..100 {
            let j = jittered(base);
            assert!(j >= Duration::from_millis(400), "{j:?} below 80% of base");
            assert!(j <= Duration::from_millis(600), "{j:?} above 120% of base");
        }
    }

    #[test]
    fn jittered_handles_zero() {
        assert_eq!(jittered(Duration::ZERO), Duration::ZERO);
    }

    #[test]
    fn client_config_debug_redacts_pat_and_url_userinfo() {
        let config = ClientConfig {
            tunnel_url: Url::parse(
                "https://tunnel-user-sentinel:tunnel-pass-sentinel@example.test/v1/tunnel",
            )
            .unwrap(),
            token: "pat-secret-sentinel".into(),
            proxy: Some(
                Url::parse("http://proxy-user-sentinel:proxy-pass-sentinel@127.0.0.1:3128")
                    .unwrap(),
            ),
            ..ClientConfig::default()
        };
        let debug = format!("{config:?}");
        assert!(debug.contains("[REDACTED]"));
        for secret in [
            "pat-secret-sentinel",
            "tunnel-user-sentinel",
            "tunnel-pass-sentinel",
            "proxy-user-sentinel",
            "proxy-pass-sentinel",
        ] {
            assert!(!debug.contains(secret), "debug leaked {secret}: {debug}");
        }
    }

    /// The permit pool bounds served work, not accepts: a flood of
    /// inbound substreams is taken off the connection (yamux caps how
    /// many may exist) but only `limit` of them are ever being served.
    #[tokio::test]
    async fn inbound_flood_never_serves_beyond_the_permit_limit() {
        SERVING_SUBSTREAMS.store(0, Ordering::SeqCst);
        MAX_SERVING_SUBSTREAMS.store(0, Ordering::SeqCst);

        let (client_io, server_io) = tokio::io::duplex(256 * 1024);
        let client = YamuxConnection::new(client_io.compat(), YamuxConfig::default(), Mode::Client);
        let mut server =
            YamuxConnection::new(server_io.compat(), YamuxConfig::default(), Mode::Server);
        let serving = tokio::spawn(serve_substreams_with_limit(client, axum::Router::new(), 1));

        let mut remote_streams = Vec::new();
        for _ in 0..32 {
            let stream = futures::future::poll_fn(|cx| {
                std::pin::Pin::new(&mut server).poll_new_outbound(cx)
            })
            .await
            .unwrap();
            remote_streams.push(stream);
        }
        for stream in &mut remote_streams {
            stream.write_all(b"G").await.unwrap();
        }
        let pumping = tokio::spawn(async move {
            let _ = futures::future::poll_fn(|cx| {
                std::pin::Pin::new(&mut server).poll_next_inbound(cx)
            })
            .await;
        });

        tokio::time::timeout(Duration::from_secs(2), async {
            while SERVING_SUBSTREAMS.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the first inbound stream was not served");
        for _ in 0..100 {
            tokio::task::yield_now().await;
        }
        assert_eq!(SERVING_SUBSTREAMS.load(Ordering::SeqCst), 1);
        assert_eq!(MAX_SERVING_SUBSTREAMS.load(Ordering::SeqCst), 1);

        drop(remote_streams);
        pumping.abort();
        serving.abort();
        // These counters are process-wide: let the aborted connection's
        // handlers exit before another test resets them. Best effort,
        // since a stuck handler is this test's failure to report, not a
        // reason to fail the drain.
        let _ = tokio::time::timeout(Duration::from_secs(5), async {
            while SERVING_SUBSTREAMS.load(Ordering::SeqCst) != 0 {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await;
    }
}

#[cfg(test)]
mod yamux_config_tests {
    use super::*;

    /// The client builds its yamux config from the shared proto
    /// constants; reverting to a bare default or a local duplicate
    /// value fails this test. `Config` exposes no getters, so the
    /// check reads its Debug projection of the constructed value.
    #[test]
    fn yamux_config_applies_the_shared_transport_values() {
        let debug = format!("{:?}", tunnel_yamux_config());
        assert!(
            debug.contains(&format!(
                "max_num_streams: {}",
                chan_tunnel_proto::TUNNEL_YAMUX_MAX_STREAMS
            )),
            "{debug}"
        );
        assert!(
            debug.contains(&format!(
                "max_connection_receive_window: Some({})",
                chan_tunnel_proto::TUNNEL_YAMUX_CONNECTION_RECEIVE_WINDOW
            )),
            "{debug}"
        );
    }
}
