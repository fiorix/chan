//! TLS + h2 dial path for the chan-tunnel client.
//!
//! Resolves the tunnel URL, opens a TCP connection, runs rustls
//! through it (ALPN: h2), runs `h2::client` on top, posts the
//! handshake request, wraps `(SendStream, RecvStream)` in an
//! `H2Duplex`, and finally runs the chan-tunnel handshake.
//!
//! When the URL scheme is `http://` we skip TLS and run h2 in
//! cleartext (h2c) directly over the TCP socket. The server side
//! (chan-tunnel-server) is already h2c-only in production: nginx
//! terminates TLS at `usr.{domain}` and `grpc_pass`-es `/v1/tunnel`
//! as h2c into devserver-proxy's tunnel listener. The h2c branch exists
//! so a local stack can dial the devserver-proxy h2c port without
//! standing up a TLS terminator.

use std::sync::Arc;

use base64::engine::{general_purpose::STANDARD as B64, Engine as _};
use chan_tunnel_proto::H2Duplex;
use http::{Method, StatusCode};
use rustls::{ClientConfig as RustlsClientConfig, RootCertStore};
use rustls_pki_types::ServerName;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use tokio_util::compat::Compat;
use url::Url;
use yamux::Connection as YamuxConnection;

use crate::{handshake, ClientConfig, ClientError, Registration};

/// Open one tunnel against the configured URL: TLS + h2 + tunnel
/// handshake. Returns the registration the server assigned plus
/// the yamux connection ready to be passed to `serve_substreams`.
///
/// Reconnect logic lives in `run`; this function is the single
/// attempt and the testable unit. Builds a fresh TLS config every
/// call, which on macOS walks the keychain. For long-running hosts
/// that reconnect repeatedly, prefer `dial_with_tls` and reuse the
/// `Arc<RustlsClientConfig>`.
pub async fn dial(
    cfg: &ClientConfig,
) -> Result<(Registration, YamuxConnection<Compat<H2Duplex>>), ClientError> {
    let tls = if cfg.tunnel_url.scheme() == "https" {
        Some(Arc::new(build_tls_config()?))
    } else {
        None
    };
    dial_with_tls(cfg, tls.as_ref()).await
}

/// Same as `dial` but reuses a pre-built TLS config. The reconnect
/// loop in `run()` calls this so every retry doesn't re-walk the
/// system trust store; the macOS keychain in particular costs tens
/// of milliseconds per load.
pub async fn dial_with_tls(
    cfg: &ClientConfig,
    tls: Option<&Arc<RustlsClientConfig>>,
) -> Result<(Registration, YamuxConnection<Compat<H2Duplex>>), ClientError> {
    validate_tunnel_url(cfg)?;
    let host = cfg
        .tunnel_url
        .host_str()
        .ok_or_else(|| ClientError::InvalidUrl("missing host".into()))?
        .to_string();
    let port = cfg.tunnel_url.port_or_known_default().ok_or_else(|| {
        ClientError::InvalidUrl(format!("cannot infer port from {}", cfg.tunnel_url))
    })?;
    let scheme = cfg.tunnel_url.scheme();
    // Normalize: callers commonly pass just a `host:port` base
    // (e.g. an embed UI rendering `http://127.0.0.1:PORT`). The
    // server only accepts POSTs at `chan_tunnel_proto::TUNNEL_PATH`,
    // so a bare path or `/` would 404. Defaulting here keeps the
    // wire constant single-sourced and removes the footgun for new
    // callers; explicit paths the caller chose are preserved so a
    // typo like `/v2/tunnel` still surfaces as a 404 they can see.
    let tunnel_url = normalize_tunnel_url(&cfg.tunnel_url);

    let tcp = open_tcp(&host, port, cfg.proxy.as_ref()).await?;
    if scheme == "http"
        && !tcp
            .peer_addr()
            .map(|peer| peer.ip().is_loopback())
            .unwrap_or(false)
    {
        return Err(ClientError::InvalidUrl(
            "cleartext tunnel connection did not terminate on a loopback peer".into(),
        ));
    }
    tcp.set_nodelay(true).ok();

    // Workspace h2 frames in the background; the connection future has
    // a different type per branch (rustls TlsStream vs raw TcpStream),
    // so spawn inside each arm and only return the SendRequest.
    let mut send_req = if scheme == "https" {
        let tls_config = tls
            .ok_or_else(|| ClientError::Tls("https:// dial called without a TLS config".into()))?
            .clone();
        let connector = TlsConnector::from(tls_config);
        let server_name = ServerName::try_from(host.clone())
            .map_err(|e| ClientError::Tls(format!("invalid SNI {host:?}: {e}")))?;
        let tls = connector
            .connect(server_name, tcp)
            .await
            .map_err(|e| ClientError::Tls(format!("rustls handshake: {e}")))?;
        let (s, conn) = tunnel_h2_client_builder()
            .handshake(tls)
            .await
            .map_err(|e| ClientError::Handshake(format!("h2 handshake: {e}")))?;
        tokio::spawn(async move {
            if let Err(e) = conn.await {
                tracing::debug!(error = %e, "h2 client conn ended");
            }
        });
        s
    } else {
        let (s, conn) = tunnel_h2_client_builder()
            .handshake(tcp)
            .await
            .map_err(|e| ClientError::Handshake(format!("h2c handshake: {e}")))?;
        tokio::spawn(async move {
            if let Err(e) = conn.await {
                tracing::debug!(error = %e, "h2 client conn ended");
            }
        });
        s
    };

    let req = http::Request::builder()
        .method(Method::POST)
        .uri(tunnel_url.as_str())
        .header(http::header::AUTHORIZATION, format!("Bearer {}", cfg.token))
        .body(())
        .map_err(|e| ClientError::Handshake(format!("build request: {e}")))?;
    let (resp_fut, send) = send_req
        .send_request(req, false)
        .map_err(|e| ClientError::Handshake(format!("send_request: {e}")))?;
    let resp = resp_fut
        .await
        .map_err(|e| ClientError::Handshake(format!("response: {e}")))?;

    match resp.status() {
        StatusCode::OK => {}
        StatusCode::UNAUTHORIZED => {
            return Err(ClientError::Handshake(
                "unauthorized (bad token or missing tunnel scope)".into(),
            ));
        }
        other => return Err(ClientError::Handshake(format!("unexpected status {other}"))),
    }

    let recv = resp.into_body();
    let duplex = H2Duplex::new(send, recv);

    handshake(cfg, duplex).await
}

/// The h2 client builder with the shared tunnel flow-control windows.
/// h2's default 64 KiB stream window throttles bulk transfer over any
/// nontrivial RTT regardless of the yamux windows above it; both tunnel
/// peers advertise the same windows so both directions are covered.
fn tunnel_h2_client_builder() -> h2::client::Builder {
    let mut builder = h2::client::Builder::new();
    builder
        .initial_window_size(chan_tunnel_proto::TUNNEL_H2_STREAM_WINDOW)
        .initial_connection_window_size(chan_tunnel_proto::TUNNEL_H2_CONNECTION_WINDOW);
    builder
}

/// Return `url` with its path replaced by
/// `chan_tunnel_proto::TUNNEL_PATH` when the caller provided no
/// path (just `http://host:port`) or only `/`. Any non-trivial path
/// the caller chose explicitly is preserved verbatim; a typo like
/// `/v2/tunnel` still 404s at the server, where the operator can
/// see and fix it.
///
/// Centralising this means the wire constant lives in exactly one
/// place (`chan_tunnel_proto::TUNNEL_PATH`); new callers (embed
/// UIs, scripts, etc.) can pass just a base URL and the dial path
/// stays right.
fn normalize_tunnel_url(url: &Url) -> Url {
    let path = url.path();
    if !path.is_empty() && path != "/" {
        return url.clone();
    }
    let mut out = url.clone();
    out.set_path(chan_tunnel_proto::TUNNEL_PATH);
    out
}

fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

pub(crate) fn validate_tunnel_url(cfg: &ClientConfig) -> Result<(), ClientError> {
    if !cfg.tunnel_url.username().is_empty() || cfg.tunnel_url.password().is_some() {
        return Err(ClientError::InvalidUrl(
            "tunnel URL userinfo is forbidden; use the separate tunnel token".into(),
        ));
    }
    let host = cfg
        .tunnel_url
        .host_str()
        .ok_or_else(|| ClientError::InvalidUrl("missing host".into()))?;
    match cfg.tunnel_url.scheme() {
        "https" => Ok(()),
        "http" if is_loopback_host(host) => Ok(()),
        "http" => Err(ClientError::InvalidUrl(
            "non-loopback tunnel URLs must use https://".into(),
        )),
        _ => Err(ClientError::InvalidUrl(
            "tunnel URL scheme must be https:// or http://".into(),
        )),
    }
}

/// sent as a Basic auth header. The CONNECT exchange is bounded by
/// the parent `dial_timeout` (each leg here is non-blocking apart
/// from one short read for the response status line + headers).
async fn open_tcp(host: &str, port: u16, proxy: Option<&Url>) -> Result<TcpStream, ClientError> {
    let Some(proxy) = proxy else {
        return Ok(TcpStream::connect((host, port)).await?);
    };
    if proxy.scheme() != "http" {
        return Err(ClientError::InvalidUrl(format!(
            "proxy scheme must be http://, got {}://",
            proxy.scheme()
        )));
    }
    let proxy_host = proxy
        .host_str()
        .ok_or_else(|| ClientError::InvalidUrl("proxy URL missing host".into()))?;
    let proxy_port = proxy
        .port_or_known_default()
        .ok_or_else(|| ClientError::InvalidUrl("cannot infer proxy port".into()))?;
    let credentialed = !proxy.username().is_empty();
    let verified_loopback_literal = proxy_host
        .parse::<std::net::IpAddr>()
        .is_ok_and(|address| address.is_loopback());
    if credentialed && !verified_loopback_literal {
        return Err(ClientError::InvalidUrl(
            "credentials require an explicit loopback IP for a cleartext HTTP proxy".into(),
        ));
    }

    let mut tcp = TcpStream::connect((proxy_host, proxy_port)).await?;
    if credentialed && !tcp.peer_addr()?.ip().is_loopback() {
        return Err(ClientError::InvalidUrl(
            "credentials are refused because the cleartext HTTP proxy peer is not loopback".into(),
        ));
    }
    let target = format!("{host}:{port}");
    let mut req =
        format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\nProxy-Connection: keep-alive\r\n");
    // Userinfo is per RFC 3986. `Url::username` is percent-encoded;
    // decode for the Basic credentials. An empty username is valid
    // (no auth) and skipped.
    let user = proxy.username();
    if !user.is_empty() {
        let pass = proxy.password().unwrap_or("");
        let raw = format!("{user}:{pass}");
        let b64 = B64.encode(raw.as_bytes());
        req.push_str(&format!("Proxy-Authorization: Basic {b64}\r\n"));
    }
    req.push_str("\r\n");
    tcp.write_all(req.as_bytes()).await?;

    // Read response headers byte-by-byte, stopping exactly at the
    // CRLF CRLF terminator. Anything after those four bytes belongs
    // to the tunnelled upstream (h2 preface or TLS ClientHello) and
    // must not be consumed here, so we cannot use a buffered reader
    // that would over-read. Hard-cap at 16 KiB to bound a hostile
    // or broken proxy that never terminates its headers.
    let mut buf = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    loop {
        let n = tcp.read(&mut byte).await?;
        if n == 0 {
            return Err(ClientError::Handshake(
                "proxy closed connection during CONNECT".into(),
            ));
        }
        buf.push(byte[0]);
        if buf.ends_with(b"\r\n\r\n") {
            break;
        }
        if buf.len() > 16 * 1024 {
            return Err(ClientError::Handshake(
                "proxy CONNECT response exceeded 16 KiB before end of headers".into(),
            ));
        }
    }

    // Parse the status line. Status text after the code is
    // optional / proxy-specific; we only need the 3-digit code.
    let head = std::str::from_utf8(&buf)
        .map_err(|_| ClientError::Handshake("proxy CONNECT response is not UTF-8".into()))?;
    let status_line = head.lines().next().ok_or_else(|| {
        ClientError::Handshake("proxy CONNECT response had no status line".into())
    })?;
    let mut parts = status_line.splitn(3, ' ');
    let _version = parts.next();
    let code = parts.next().ok_or_else(|| {
        ClientError::Handshake("proxy CONNECT response status line malformed".into())
    })?;
    let code: u16 = code
        .parse()
        .map_err(|_| ClientError::Handshake("proxy CONNECT status code malformed".into()))?;
    if !(200..300).contains(&code) {
        // 407 in particular: auth required. Surface distinctly so
        // the caller can show "wrong proxy credentials" rather than
        // a generic transport error.
        return Err(ClientError::Handshake(format!(
            "proxy CONNECT to {target} failed with status {code}"
        )));
    }
    Ok(tcp)
}

pub fn build_tls_config() -> Result<RustlsClientConfig, ClientError> {
    // rustls 0.23 expects the default crypto provider to be
    // installed once per process. Re-install attempts are no-ops
    // and we ignore the result so multiple `dial` calls in a
    // single process don't fight over it.
    let _ = rustls::crypto::ring::default_provider().install_default();

    let mut roots = RootCertStore::empty();
    let native = rustls_native_certs::load_native_certs();
    if !native.errors.is_empty() {
        tracing::warn!(
            count = native.errors.len(),
            "rustls-native-certs reported per-cert errors; continuing with the rest",
        );
    }
    for cert in native.certs {
        let _ = roots.add(cert);
    }
    if roots.is_empty() {
        return Err(ClientError::Tls(
            "no native CA certificates available; cannot verify tunnel server".into(),
        ));
    }

    let mut config = RustlsClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    config.alpn_protocols = vec![b"h2".to_vec()];
    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

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

    /// The dial advertises the shared tunnel windows on the wire: the
    /// stream window in the first SETTINGS frame, and the connection
    /// raise as a stream-0 WINDOW_UPDATE over the h2 default (65_535).
    #[tokio::test]
    async fn client_advertises_the_shared_h2_windows() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let dialing = tokio::spawn(async move {
            let tcp = TcpStream::connect(addr).await.unwrap();
            let (_send, conn) = tunnel_h2_client_builder()
                .handshake::<_, hyper::body::Bytes>(tcp)
                .await
                .expect("client h2 handshake");
            let _ = conn.await;
        });
        let (mut server, _) = listener.accept().await.unwrap();
        let mut preface = [0u8; 24];
        server.read_exact(&mut preface).await.unwrap();
        assert_eq!(&preface, b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n");

        let mut initial_window = None;
        let mut connection_increment = None;
        let mut answered_settings = false;
        for _ in 0..6 {
            let (frame_type, stream_id, payload) =
                tokio::time::timeout(Duration::from_secs(5), read_h2_frame(&mut server))
                    .await
                    .expect("client frames must arrive promptly");
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
                    if !answered_settings {
                        // Answer so the client handshake can complete.
                        server
                            .write_all(&[0, 0, 0, 0x4, 0, 0, 0, 0, 0])
                            .await
                            .unwrap();
                        answered_settings = true;
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
        drop(server);
        let _ = dialing.await;
    }

    #[test]
    fn normalize_tunnel_url_appends_default_path_when_missing() {
        let normalized = normalize_tunnel_url(&Url::parse("http://127.0.0.1:7777").unwrap());
        assert_eq!(normalized.as_str(), "http://127.0.0.1:7777/v1/tunnel");
    }

    #[test]
    fn normalize_tunnel_url_appends_default_path_when_root_slash() {
        let normalized = normalize_tunnel_url(&Url::parse("http://127.0.0.1:7777/").unwrap());
        assert_eq!(normalized.as_str(), "http://127.0.0.1:7777/v1/tunnel");
    }

    #[test]
    fn normalize_tunnel_url_preserves_explicit_canonical_path() {
        let original = Url::parse("https://workspace.chan.app/v1/tunnel").unwrap();
        let normalized = normalize_tunnel_url(&original);
        assert_eq!(normalized.as_str(), original.as_str());
    }

    #[test]
    fn normalize_tunnel_url_preserves_caller_typos() {
        // A typo like /v2/tunnel is kept so the resulting 404 is
        // visible at the operator level rather than being silently
        // corrected.
        let typo = Url::parse("https://workspace.chan.app/v2/tunnel").unwrap();
        let normalized = normalize_tunnel_url(&typo);
        assert_eq!(normalized.as_str(), typo.as_str());
    }

    #[test]
    fn normalize_tunnel_url_preserves_query_and_fragment_when_path_missing() {
        // url::Url parses "http://h:p?q=1" with path "/", so this
        // exercises the path-replacement branch while keeping the
        // query intact.
        let with_query = Url::parse("http://127.0.0.1:7777?retry=1").unwrap();
        let normalized = normalize_tunnel_url(&with_query);
        assert_eq!(normalized.path(), "/v1/tunnel");
        assert_eq!(normalized.query(), Some("retry=1"));
    }

    #[test]
    fn loopback_recognition_never_uses_a_dns_prefix() {
        assert!(is_loopback_host("127.0.0.1"));
        assert!(is_loopback_host("::1"));
        assert!(is_loopback_host("localhost"));
        assert!(!is_loopback_host("127.example.com"));
        assert!(!is_loopback_host("10.0.0.2"));
    }

    #[test]
    fn tunnel_url_rejects_userinfo_because_auth_uses_the_pat() {
        for raw in [
            "https://alice:secret@workspace.chan.app/v1/tunnel",
            "https://alice@workspace.chan.app/v1/tunnel",
            "https://:secret@workspace.chan.app/v1/tunnel",
        ] {
            let cfg = ClientConfig {
                tunnel_url: Url::parse(raw).unwrap(),
                ..ClientConfig::default()
            };
            assert!(matches!(
                validate_tunnel_url(&cfg),
                Err(ClientError::InvalidUrl(message)) if message.contains("userinfo")
            ));
        }
    }

    async fn run_proxy(listener: TcpListener, response: &'static [u8]) -> Vec<u8> {
        let (mut sock, _) = listener.accept().await.unwrap();
        // Read up to CRLF CRLF so we capture exactly the CONNECT
        // request the client sent, then send the canned response.
        let mut req = Vec::new();
        let mut byte = [0u8; 1];
        loop {
            let n = sock.read(&mut byte).await.unwrap();
            if n == 0 {
                break;
            }
            req.push(byte[0]);
            if req.ends_with(b"\r\n\r\n") {
                break;
            }
        }
        sock.write_all(response).await.unwrap();
        // Echo a sentinel so the test can verify byte alignment
        // after the response headers (i.e. no leftover swallowed).
        // Then drop the socket; bytes already queued in the kernel
        // buffer remain readable by the client.
        sock.write_all(b"PREFACE").await.unwrap();
        req
    }

    #[tokio::test]
    async fn connect_no_auth_succeeds_and_leaves_post_header_bytes_intact() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = listener.local_addr().unwrap();
        let proxy_url = Url::parse(&format!("http://{proxy_addr}")).unwrap();

        let server = tokio::spawn(run_proxy(
            listener,
            b"HTTP/1.1 200 Connection Established\r\nVia: 1.1 test\r\n\r\n",
        ));

        let mut tcp = open_tcp("upstream.example", 443, Some(&proxy_url))
            .await
            .expect("open_tcp ok");
        // After CONNECT 200 the next bytes from the proxy belong to
        // the tunnelled upstream. Verify we did not swallow them.
        let mut sentinel = [0u8; 7];
        tcp.read_exact(&mut sentinel).await.unwrap();
        assert_eq!(&sentinel, b"PREFACE");

        let req = server.await.unwrap();
        let text = std::str::from_utf8(&req).unwrap();
        assert!(text.starts_with("CONNECT upstream.example:443 HTTP/1.1\r\n"));
        assert!(text.contains("Host: upstream.example:443"));
        assert!(!text.to_ascii_lowercase().contains("proxy-authorization"));
    }

    #[tokio::test]
    async fn connect_sends_basic_auth_from_userinfo() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = listener.local_addr().unwrap();
        // Embed userinfo "alice:s3cret" in the proxy URL.
        let proxy_url = Url::parse(&format!("http://alice:s3cret@{proxy_addr}")).unwrap();

        let server = tokio::spawn(run_proxy(listener, b"HTTP/1.1 200 OK\r\n\r\n"));

        let _tcp = open_tcp("upstream.example", 443, Some(&proxy_url))
            .await
            .expect("open_tcp ok");
        let req = server.await.unwrap();
        let text = std::str::from_utf8(&req).unwrap();
        // base64("alice:s3cret") == "YWxpY2U6czNjcmV0"
        assert!(
            text.contains("Proxy-Authorization: Basic YWxpY2U6czNjcmV0\r\n"),
            "request was {text:?}",
        );
    }

    #[tokio::test]
    async fn connect_non_2xx_status_is_an_error() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = listener.local_addr().unwrap();
        let proxy_url = Url::parse(&format!("http://alice:s3cret@{proxy_addr}")).unwrap();

        let _server = tokio::spawn(run_proxy(
            listener,
            b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n",
        ));

        let err = open_tcp("upstream.example", 443, Some(&proxy_url))
            .await
            .expect_err("407 should error");
        match err {
            ClientError::Handshake(msg) => {
                assert!(msg.contains("407"), "unexpected message: {msg}");
                assert!(
                    !msg.contains("s3cret") && !msg.contains("alice"),
                    "proxy credentials leaked in message: {msg}",
                );
            }
            other => panic!("expected Handshake error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn connect_malformed_status_does_not_echo_proxy_text() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = listener.local_addr().unwrap();
        let proxy_url = Url::parse(&format!("http://alice:s3cret@{proxy_addr}")).unwrap();

        let _server = tokio::spawn(run_proxy(
            listener,
            b"HTTP/1.1 s3cret echoed-by-proxy\r\n\r\n",
        ));

        let err = open_tcp("upstream.example", 443, Some(&proxy_url))
            .await
            .expect_err("malformed proxy status should error");
        match err {
            ClientError::Handshake(msg) => {
                assert!(
                    !msg.contains("s3cret"),
                    "proxy text leaked in message: {msg}"
                );
                assert!(
                    !msg.contains("echoed-by-proxy"),
                    "proxy text leaked in message: {msg}",
                );
            }
            other => panic!("expected Handshake error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn rejects_https_proxy_scheme() {
        let proxy_url = Url::parse("https://proxy.example:3128").unwrap();
        let err = open_tcp("upstream.example", 443, Some(&proxy_url))
            .await
            .expect_err("https proxy should be rejected");
        match err {
            ClientError::InvalidUrl(msg) => assert!(msg.contains("https")),
            other => panic!("expected InvalidUrl, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn rejects_credentials_on_non_loopback_cleartext_proxy_before_connect() {
        let proxy_url = Url::parse("http://alice:secret@proxy.example.test:3128").unwrap();
        let error = open_tcp("upstream.example", 443, Some(&proxy_url))
            .await
            .expect_err("remote cleartext proxy credentials must be refused");
        assert!(
            matches!(error, ClientError::InvalidUrl(message) if message.contains("credentials"))
        );
    }

    #[tokio::test]
    async fn rejects_credentials_for_localhost_before_dns_or_connect() {
        let proxy_url = Url::parse("http://alice:secret@localhost:3128").unwrap();
        let error = open_tcp("upstream.example", 443, Some(&proxy_url))
            .await
            .expect_err("a hostname is not verified loopback authority");
        assert!(
            matches!(error, ClientError::InvalidUrl(message) if message.contains("loopback IP"))
        );
    }
}
