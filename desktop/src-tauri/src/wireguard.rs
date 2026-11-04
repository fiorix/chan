//! The WireGuard fabric: in-process tunnels to the gateways configured with
//! a wg-quick file, and the one loopback CONNECT proxy every outbound leg
//! reaches those gateways through.
//!
//! The fabric is decided once, at start, before any webview exists, and
//! lives for the process. The three legs to a gateway, the HTTP clients,
//! the window feed's WebSocket and the webviews, all know how to dial
//! through an HTTP proxy, so one proxy puts them inside the tunnels with no
//! interface, route or privilege on the host. It is decided at start
//! because the webview proxy is: WebView2 takes it as a browser argument
//! shared by every webview of the process, so the launcher and every window
//! must carry the same value and a change needs a restart. A gateway whose
//! file cannot be read at start is not fatal to the app; the row carries
//! the reader's message and refuses to connect until the file is fixed and
//! the desktop restarts. When no gateway carries a file nothing here runs
//! and every leg dials as it always did.
//!
//! The proxy routes by destination: an address inside a tunnel's AllowedIPs
//! goes through that tunnel, anything else is connected directly. The
//! loopback destinations of the Rust legs (the embedded server, a devserver
//! on this machine) never enter the proxy at all, so they do not depend on
//! it being up; the webviews on Linux have no such exception, which is why
//! the proxy forwards plain HTTP as well as CONNECT.

use std::collections::HashMap;
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use chan_wireguard::{ConnectProxy, Tunnel};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::http::Uri;
use url::Url;

use crate::config::Gateway;

/// The destinations the HTTP clients dial without the proxy: the proxy
/// would only pass them through, and the embedded server and a devserver on
/// this machine must not depend on it being up.
const DIRECT_HOSTS: &str = "127.0.0.0/8,::1,localhost";

/// A CONNECT exchange, connect included, is bounded so a proxy that stops
/// answering fails the feed round instead of holding it.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// A CONNECT response head longer than this without its blank line is a
/// broken proxy; the bound keeps the byte-wise read from growing forever.
const MAX_RESPONSE_HEAD: usize = 16 * 1024;

/// The connect refusal for a row whose WireGuard setting is not the one the
/// process started with.
pub const RESTART_REQUIRED: &str =
    "the gateway's WireGuard setting changed; restart chan-desktop to apply it";

/// The tunnels started at this process's start and the proxy over them.
/// Dropping it ends the proxy and every connection through it, so it lives
/// in [`AppState`](crate::AppState) for the process.
pub struct WireguardFabric {
    tunnels: Vec<Tunnel>,
    proxy: ConnectProxy,
    proxy_url: Url,
}

impl WireguardFabric {
    /// The proxy as the legs name it, `http://127.0.0.1:<port>`.
    pub fn proxy_url(&self) -> &Url {
        &self.proxy_url
    }

    /// How many tunnels the proxy routes over.
    pub fn tunnels(&self) -> usize {
        self.tunnels.len()
    }
}

impl std::fmt::Debug for WireguardFabric {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WireguardFabric")
            .field("tunnels", &self.tunnels.len())
            .field("proxy", &self.proxy)
            .finish()
    }
}

/// What the start decided for each gateway row: the file its tunnel runs
/// from, or why its file was refused. The Gateways projection reads it to
/// say which rows wait for a restart, and connect reads it to refuse a row
/// the process has no tunnel for.
#[derive(Debug, Default)]
pub struct WireguardStartup {
    /// Gateways with a running tunnel, by the file it was started from.
    started: HashMap<String, PathBuf>,
    /// Gateways whose file was refused, with the file and the reason.
    failed: HashMap<String, (PathBuf, String)>,
}

impl WireguardStartup {
    /// Whether an enabled row's WireGuard setting differs from what the
    /// process runs: a file added, changed, removed or refused since the
    /// start. A disabled row asks nothing of the process.
    pub fn restart_required(
        &self,
        gateway_id: &str,
        configured: Option<&Path>,
        enabled: bool,
    ) -> bool {
        enabled && self.started.get(gateway_id).map(PathBuf::as_path) != configured
    }

    /// The reason the row's file was refused at start, while the row still
    /// names that file.
    pub fn failure(&self, gateway_id: &str, configured: Option<&Path>) -> Option<&str> {
        self.failed
            .get(gateway_id)
            .filter(|(path, _)| Some(path.as_path()) == configured)
            .map(|(_, reason)| reason.as_str())
    }

    /// Why a connect of this row is refused, if it is: its file was refused
    /// at start, or its setting changed since. Connecting is enabling, so
    /// the row is judged as enabled.
    pub fn connect_refusal(&self, gateway_id: &str, configured: Option<&Path>) -> Option<String> {
        if let Some(reason) = self.failure(gateway_id, configured) {
            return Some(reason.to_string());
        }
        self.restart_required(gateway_id, configured, true)
            .then(|| RESTART_REQUIRED.to_string())
    }

    #[cfg(test)]
    pub(crate) fn for_test(
        started: &[(&str, &str)],
        failed: &[(&str, &str, &str)],
    ) -> WireguardStartup {
        WireguardStartup {
            started: started
                .iter()
                .map(|(id, path)| (id.to_string(), PathBuf::from(path)))
                .collect(),
            failed: failed
                .iter()
                .map(|(id, path, reason)| {
                    (id.to_string(), (PathBuf::from(path), reason.to_string()))
                })
                .collect(),
        }
    }
}

/// Start a tunnel for every enabled gateway with a WireGuard file and one
/// proxy over them. A file that cannot be read or a tunnel that cannot
/// start fails that row alone; a proxy that cannot bind fails every row,
/// since nothing can reach the tunnels without it. `None` when no tunnel
/// started. Must run on the tokio runtime the tunnels live on for the
/// process.
pub async fn start(gateways: &[Gateway]) -> (Option<WireguardFabric>, WireguardStartup) {
    let mut startup = WireguardStartup::default();
    let mut tunnels = Vec::new();
    for gateway in gateways.iter().filter(|g| g.enabled) {
        let Some(path) = &gateway.wireguard else {
            continue;
        };
        let config = match chan_wireguard::config::read_file(path) {
            Ok(config) => config,
            Err(e) => {
                tracing::warn!(gateway = %gateway.id, error = %e, "gateway WireGuard file refused");
                startup.failed.insert(
                    gateway.id.clone(),
                    (path.clone(), format!("WireGuard: {e}")),
                );
                continue;
            }
        };
        let endpoint = config.peer.endpoint.to_string();
        match Tunnel::start(config).await {
            Ok(tunnel) => {
                tracing::info!(
                    gateway = %gateway.id,
                    file = %path.display(),
                    %endpoint,
                    "gateway WireGuard tunnel started"
                );
                startup.started.insert(gateway.id.clone(), path.clone());
                tunnels.push(tunnel);
            }
            Err(e) => {
                tracing::warn!(gateway = %gateway.id, %endpoint, error = %e, "gateway WireGuard tunnel failed to start");
                startup.failed.insert(
                    gateway.id.clone(),
                    (
                        path.clone(),
                        format!("WireGuard: starting the tunnel to {endpoint}: {e}"),
                    ),
                );
            }
        }
    }
    if tunnels.is_empty() {
        return (None, startup);
    }
    let bind = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0);
    match ConnectProxy::bind(tunnels.clone(), bind).await {
        Ok(proxy) => {
            let proxy_url = Url::parse(&format!("http://{}", proxy.local_addr()))
                .expect("a loopback socket address is a URL authority");
            tracing::info!(proxy = %proxy.local_addr(), tunnels = tunnels.len(), "gateway WireGuard proxy listening");
            (
                Some(WireguardFabric {
                    tunnels,
                    proxy,
                    proxy_url,
                }),
                startup,
            )
        }
        Err(e) => {
            tracing::error!(error = %e, "gateway WireGuard proxy failed to bind; the tunnels are dropped");
            let reason = format!("WireGuard: starting the proxy: {e}");
            for (id, path) in std::mem::take(&mut startup.started) {
                startup.failed.insert(id, (path, reason.clone()));
            }
            (None, startup)
        }
    }
}

/// The process's proxy, as the legs consume it.
struct ProxyDecision {
    url: Url,
    addr: SocketAddr,
    proxy: reqwest::Proxy,
}

/// Decided once per process. A reader before the decision pins its absence,
/// so a decision made after a client was built fails rather than leaving
/// that client on the wrong path.
static PROXY: OnceLock<Option<ProxyDecision>> = OnceLock::new();

/// Record the process's proxy, `None` for no fabric, before any HTTP client
/// or webview is built. Fails when the decision was already made, by a
/// previous call or by a client built before it.
pub fn install_proxy(url: Option<Url>) -> Result<(), String> {
    let decision = match url {
        None => None,
        Some(url) => {
            let addr = proxy_socket_addr(&url)?;
            let proxy = reqwest::Proxy::all(url.clone())
                .map_err(|e| format!("{url} is not a proxy URL the HTTP client accepts: {e}"))?
                .no_proxy(reqwest::NoProxy::from_string(DIRECT_HOSTS));
            Some(ProxyDecision { url, addr, proxy })
        }
    };
    PROXY.set(decision).map_err(|_| {
        "the WireGuard proxy was decided twice, or after an HTTP client was built".to_string()
    })
}

fn proxy_socket_addr(url: &Url) -> Result<SocketAddr, String> {
    let host = url
        .host_str()
        .ok_or_else(|| format!("{url} has no host"))?
        .trim_matches(|c| c == '[' || c == ']');
    let ip: IpAddr = host
        .parse()
        .map_err(|_| format!("{url} must name the proxy by address"))?;
    let port = url.port().ok_or_else(|| format!("{url} has no port"))?;
    Ok(SocketAddr::new(ip, port))
}

fn decision() -> Option<&'static ProxyDecision> {
    PROXY.get_or_init(|| None).as_ref()
}

/// The builder every HTTP client of the desktop starts from: through the
/// proxy when the process has one, with loopback destinations direct, and
/// the plain builder otherwise.
pub fn client_builder() -> reqwest::ClientBuilder {
    client_builder_with(decision().map(|d| &d.proxy))
}

fn client_builder_with(proxy: Option<&reqwest::Proxy>) -> reqwest::ClientBuilder {
    let builder = reqwest::Client::builder();
    match proxy {
        Some(proxy) => builder.proxy(proxy.clone()),
        None => builder,
    }
}

/// Where a WebSocket upgrade to `uri` dials: the proxy, with the authority
/// to CONNECT, or `None` for a direct dial when the process has no proxy or
/// the host is a loopback one.
pub fn ws_route(uri: &Uri) -> Option<WsRoute> {
    ws_route_with(decision().map(|d| d.addr), uri)
}

/// A WebSocket dial through the proxy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WsRoute {
    pub proxy: SocketAddr,
    pub host: String,
    pub port: u16,
}

fn ws_route_with(proxy: Option<SocketAddr>, uri: &Uri) -> Option<WsRoute> {
    let proxy = proxy?;
    let host = uri
        .host()?
        .trim_matches(|c| c == '[' || c == ']')
        .to_string();
    if is_direct_host(&host) {
        return None;
    }
    let port = uri.port_u16().unwrap_or(match uri.scheme_str() {
        Some("wss") | Some("https") => 443,
        _ => 80,
    });
    Some(WsRoute { proxy, host, port })
}

/// Loopback literals and `localhost`, the hosts [`DIRECT_HOSTS`] names.
fn is_direct_host(host: &str) -> bool {
    match host.parse::<IpAddr>() {
        Ok(ip) => ip.is_loopback(),
        Err(_) => host.eq_ignore_ascii_case("localhost"),
    }
}

/// Open a TCP connection to `host:port` through the CONNECT proxy at
/// `proxy`: send the request, read the response head byte by byte to its
/// blank line so nothing of what follows is consumed, require a 200, and
/// hand back the stream for the TLS and WebSocket handshakes to run over.
pub async fn connect_through(proxy: SocketAddr, host: &str, port: u16) -> io::Result<TcpStream> {
    tokio::time::timeout(
        CONNECT_TIMEOUT,
        connect_through_unbounded(proxy, host, port),
    )
    .await
    .map_err(|_| {
        io::Error::new(
            io::ErrorKind::TimedOut,
            format!("CONNECT {host}:{port} through the WireGuard proxy timed out"),
        )
    })?
}

async fn connect_through_unbounded(
    proxy: SocketAddr,
    host: &str,
    port: u16,
) -> io::Result<TcpStream> {
    let mut stream = TcpStream::connect(proxy).await?;
    // The feed's frames are small and waited on; a delayed segment is a
    // round trip added to each.
    stream.set_nodelay(true)?;
    // An IPv6 literal needs its brackets back in the authority.
    let authority = if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    let request = format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n\r\n");
    stream.write_all(request.as_bytes()).await?;
    let mut head = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    loop {
        if stream.read(&mut byte).await? == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                format!("the WireGuard proxy closed during CONNECT {authority}"),
            ));
        }
        head.push(byte[0]);
        if head.ends_with(b"\r\n\r\n") {
            break;
        }
        if head.len() >= MAX_RESPONSE_HEAD {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("the WireGuard proxy's CONNECT {authority} response head never ended"),
            ));
        }
    }
    let status = connect_status(&head).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("the WireGuard proxy answered CONNECT {authority} with no HTTP status line"),
        )
    })?;
    if status != 200 {
        return Err(io::Error::new(
            io::ErrorKind::ConnectionRefused,
            format!("the WireGuard proxy answered {status} to CONNECT {authority}"),
        ));
    }
    Ok(stream)
}

/// The status code of a response head, `HTTP/1.x NNN ...`.
fn connect_status(head: &[u8]) -> Option<u16> {
    let line_end = head.windows(2).position(|pair| pair == b"\r\n")?;
    let line = std::str::from_utf8(&head[..line_end]).ok()?;
    let mut parts = line.splitn(3, ' ');
    let version = parts.next()?;
    if !version.starts_with("HTTP/1.") {
        return None;
    }
    parts.next()?.parse().ok()
}

/// The proxy URL for a window's webview builder: the process's proxy when
/// there is one and this platform's webview can take it. On macOS the
/// proxy is set on the webview's data store, which exists from macOS 14;
/// below it the windows reach gateways directly, and the first window says
/// so once. On Linux it also carries the local windows, through the proxy's
/// plain HTTP forwarding.
pub fn webview_proxy_url() -> Option<Url> {
    let decision = decision()?;
    platform_takes_webview_proxy().then(|| decision.url.clone())
}

/// The same proxy for the launcher's wry builder, which takes it as a
/// host and port rather than a URL.
pub fn launcher_proxy_config() -> Option<wry::ProxyConfig> {
    let decision = decision()?;
    platform_takes_webview_proxy().then(|| {
        wry::ProxyConfig::Http(wry::ProxyEndpoint {
            host: decision.addr.ip().to_string(),
            port: decision.addr.port().to_string(),
        })
    })
}

/// Put the process's proxy on a window's webview builder, when there is
/// one this platform's webview takes.
pub fn with_webview_proxy<'a, R: tauri::Runtime, M: tauri::Manager<R>>(
    builder: tauri::WebviewWindowBuilder<'a, R, M>,
) -> tauri::WebviewWindowBuilder<'a, R, M> {
    match webview_proxy_url() {
        Some(url) => builder.proxy_url(url),
        None => builder,
    }
}

/// The same for the launcher's wry builder.
pub fn with_launcher_proxy(builder: wry::WebViewBuilder<'_>) -> wry::WebViewBuilder<'_> {
    match launcher_proxy_config() {
        Some(config) => builder.with_proxy_config(config),
        None => builder,
    }
}

#[cfg(target_os = "macos")]
fn platform_takes_webview_proxy() -> bool {
    static TAKES: OnceLock<bool> = OnceLock::new();
    *TAKES.get_or_init(|| {
        let version = objc2_foundation::NSProcessInfo::processInfo().operatingSystemVersion();
        let takes = version.majorVersion >= 14;
        if !takes {
            tracing::warn!(
                major = version.majorVersion,
                minor = version.minorVersion,
                "gateway WireGuard needs macOS 14 for the windows; on this macOS the pages reach the gateways directly"
            );
        }
        takes
    })
}

#[cfg(not(target_os = "macos"))]
fn platform_takes_webview_proxy() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tokio::net::TcpListener;

    const WAIT: Duration = Duration::from_secs(10);

    /// A stand-in HTTP peer on loopback: it records the request line of
    /// every connection and answers each with `response`, then, when
    /// `echo` is set, copies whatever follows back to the client.
    struct FakePeer {
        addr: SocketAddr,
        requests: Arc<Mutex<Vec<String>>>,
    }

    impl FakePeer {
        async fn start(response: &'static str, echo: bool) -> FakePeer {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let requests = Arc::new(Mutex::new(Vec::new()));
            let seen = Arc::clone(&requests);
            tokio::spawn(async move {
                loop {
                    let Ok((mut socket, _)) = listener.accept().await else {
                        return;
                    };
                    let seen = Arc::clone(&seen);
                    tokio::spawn(async move {
                        let mut head = Vec::new();
                        let mut byte = [0u8; 1];
                        while !head.ends_with(b"\r\n\r\n") {
                            match socket.read(&mut byte).await {
                                Ok(0) | Err(_) => return,
                                Ok(_) => head.push(byte[0]),
                            }
                        }
                        let text = String::from_utf8_lossy(&head).to_string();
                        seen.lock().unwrap().push(text);
                        if socket.write_all(response.as_bytes()).await.is_err() {
                            return;
                        }
                        if echo {
                            let mut buf = [0u8; 256];
                            while let Ok(n) = socket.read(&mut buf).await {
                                if n == 0 || socket.write_all(&buf[..n]).await.is_err() {
                                    return;
                                }
                            }
                        }
                    });
                }
            });
            FakePeer { addr, requests }
        }

        fn url(&self) -> Url {
            Url::parse(&format!("http://{}", self.addr)).unwrap()
        }

        fn request_lines(&self) -> Vec<String> {
            self.requests
                .lock()
                .unwrap()
                .iter()
                .map(|head| head.lines().next().unwrap_or_default().to_string())
                .collect()
        }
    }

    fn proxy_for(url: &Url) -> reqwest::Proxy {
        reqwest::Proxy::all(url.clone())
            .unwrap()
            .no_proxy(reqwest::NoProxy::from_string(DIRECT_HOSTS))
    }

    #[tokio::test]
    async fn client_builder_applies_the_proxy_exactly_when_a_fabric_exists() {
        const NO_CONTENT: &str = "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n";
        let proxy = FakePeer::start(NO_CONTENT, false).await;
        let direct = FakePeer::start(NO_CONTENT, false).await;
        let timeout = Duration::from_secs(5);

        // With a fabric a remote origin is asked of the proxy in absolute
        // form, which is how the proxy learns the destination; the name is
        // never resolved here (`.invalid` never resolves).
        let proxied = client_builder_with(Some(&proxy_for(&proxy.url())))
            .timeout(timeout)
            .build()
            .unwrap();
        let response = proxied
            .get("http://nowhere.invalid:1/roster")
            .send()
            .await
            .expect("the proxy answers for the remote origin");
        assert_eq!(response.status(), 204);
        assert_eq!(
            proxy.request_lines(),
            vec!["GET http://nowhere.invalid:1/roster HTTP/1.1".to_string()]
        );

        // The same client dials a loopback origin directly: the proxy
        // would only pass it through, and the local legs must not depend
        // on it.
        let response = proxied
            .get(format!("http://{}/local", direct.addr))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 204);
        assert_eq!(
            direct.request_lines(),
            vec!["GET /local HTTP/1.1".to_string()]
        );
        assert_eq!(
            proxy.request_lines().len(),
            1,
            "loopback never enters the proxy"
        );

        // Without a fabric nothing reaches the proxy: the remote origin
        // fails on its own resolution and the loopback origin is direct.
        let plain = client_builder_with(None).timeout(timeout).build().unwrap();
        assert!(plain.get("http://nowhere.invalid:1/").send().await.is_err());
        let response = plain
            .get(format!("http://{}/plain", direct.addr))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 204);
        assert_eq!(proxy.request_lines().len(), 1, "no fabric, no proxy");
        assert_eq!(direct.request_lines().len(), 2);
    }

    #[tokio::test]
    async fn connect_through_requires_a_200_and_hands_back_the_stream() {
        let proxy = FakePeer::start("HTTP/1.1 200 Connection Established\r\n\r\n", true).await;
        let mut stream = tokio::time::timeout(WAIT, connect_through(proxy.addr, "10.7.0.2", 443))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            proxy.requests.lock().unwrap()[0],
            "CONNECT 10.7.0.2:443 HTTP/1.1\r\nHost: 10.7.0.2:443\r\n\r\n"
        );
        // What follows the head belongs to the caller: the bytes written
        // next come back through the splice, none swallowed.
        stream.write_all(b"ping").await.unwrap();
        let mut buf = [0u8; 4];
        tokio::time::timeout(WAIT, stream.read_exact(&mut buf))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&buf, b"ping");

        // An IPv6 host is bracketed in the authority.
        let _ = tokio::time::timeout(WAIT, connect_through(proxy.addr, "fd00:7::2", 8443))
            .await
            .unwrap()
            .unwrap();
        assert!(
            proxy.requests.lock().unwrap()[1].starts_with("CONNECT [fd00:7::2]:8443 HTTP/1.1\r\n")
        );

        // A refusal is an error naming the status, not a stream.
        let refusing = FakePeer::start(
            "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            false,
        )
        .await;
        let err = tokio::time::timeout(WAIT, connect_through(refusing.addr, "10.7.0.2", 443))
            .await
            .unwrap()
            .expect_err("a 403 is a refusal");
        assert_eq!(err.kind(), io::ErrorKind::ConnectionRefused);
        assert!(err.to_string().contains("403"), "{err}");
    }

    #[tokio::test]
    async fn connect_through_bounds_a_head_that_never_ends() {
        // A proxy that streams without ever sending the blank line.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let line = vec![b'A'; 1024];
            loop {
                if socket.write_all(&line).await.is_err() {
                    return;
                }
            }
        });
        let err = tokio::time::timeout(WAIT, connect_through(addr, "10.7.0.2", 443))
            .await
            .expect("the read is bounded")
            .expect_err("an endless head is refused");
        assert_eq!(err.kind(), io::ErrorKind::InvalidData, "{err}");
    }

    #[test]
    fn ws_route_dials_loopback_directly_and_the_rest_through_the_proxy() {
        let proxy: SocketAddr = "127.0.0.1:3128".parse().unwrap();
        let route = |uri: &str| ws_route_with(Some(proxy), &uri.parse().unwrap());
        assert_eq!(
            route("wss://alice--x.node.proxy.chan.app/ws?w=1"),
            Some(WsRoute {
                proxy,
                host: "alice--x.node.proxy.chan.app".into(),
                port: 443,
            })
        );
        assert_eq!(
            route("ws://10.7.0.2:8787/api/library/windows/watch"),
            Some(WsRoute {
                proxy,
                host: "10.7.0.2".into(),
                port: 8787,
            })
        );
        assert_eq!(
            route("ws://[fd00:7::2]:8787/ws").map(|r| (r.host, r.port)),
            Some(("fd00:7::2".into(), 8787))
        );
        for direct in [
            "ws://127.0.0.1:8787/ws",
            "ws://127.0.0.2:8787/ws",
            "ws://[::1]:8787/ws",
            "ws://localhost:8787/ws",
        ] {
            assert_eq!(route(direct), None, "{direct}");
        }
        // No proxy, no route.
        assert_eq!(
            ws_route_with(None, &"wss://gw.example/ws".parse().unwrap()),
            None
        );
    }

    #[test]
    fn restart_required_and_failure_follow_the_started_set() {
        let startup = WireguardStartup::for_test(
            &[("gw-a", "/home/u/a.conf")],
            &[(
                "gw-b",
                "/home/u/b.conf",
                "WireGuard: /home/u/b.conf: line 3: Address",
            )],
        );
        let a = Path::new("/home/u/a.conf");
        let b = Path::new("/home/u/b.conf");
        let other = Path::new("/home/u/other.conf");
        // The started row, unchanged, needs nothing.
        assert!(!startup.restart_required("gw-a", Some(a), true));
        assert_eq!(startup.connect_refusal("gw-a", Some(a)), None);
        // Its file changed, or was removed: the next start applies it.
        assert!(startup.restart_required("gw-a", Some(other), true));
        assert!(startup.restart_required("gw-a", None, true));
        assert_eq!(
            startup.connect_refusal("gw-a", None).as_deref(),
            Some(RESTART_REQUIRED)
        );
        // A row that gained a file after the start.
        assert!(startup.restart_required("gw-c", Some(other), true));
        assert_eq!(
            startup.connect_refusal("gw-c", Some(other)).as_deref(),
            Some(RESTART_REQUIRED)
        );
        // A row without a file, and a disabled row, ask nothing.
        assert!(!startup.restart_required("gw-c", None, true));
        assert_eq!(startup.connect_refusal("gw-c", None), None);
        assert!(!startup.restart_required("gw-a", None, false));
        // The refused file carries its reason while the row names it, and
        // a restart is what applies the fix.
        assert_eq!(
            startup.failure("gw-b", Some(b)),
            Some("WireGuard: /home/u/b.conf: line 3: Address")
        );
        assert!(startup.restart_required("gw-b", Some(b), true));
        assert_eq!(
            startup.connect_refusal("gw-b", Some(b)).as_deref(),
            Some("WireGuard: /home/u/b.conf: line 3: Address")
        );
        // Pointed elsewhere, the old refusal no longer applies.
        assert_eq!(startup.failure("gw-b", Some(other)), None);
        assert_eq!(startup.failure("gw-b", None), None);
        assert_eq!(startup.connect_refusal("gw-b", None), None);
    }

    #[test]
    fn connect_status_reads_the_status_line() {
        assert_eq!(
            connect_status(b"HTTP/1.1 200 Connection Established\r\n\r\n"),
            Some(200)
        );
        assert_eq!(
            connect_status(b"HTTP/1.0 502 Bad Gateway\r\nX: y\r\n\r\n"),
            Some(502)
        );
        assert_eq!(connect_status(b"HTTP/2 200\r\n\r\n"), None);
        assert_eq!(connect_status(b"garbage\r\n\r\n"), None);
        assert_eq!(connect_status(b"HTTP/1.1 \r\n\r\n"), None);
    }

    #[test]
    fn proxy_socket_addr_reads_the_url() {
        assert_eq!(
            proxy_socket_addr(&Url::parse("http://127.0.0.1:3128").unwrap()).unwrap(),
            "127.0.0.1:3128".parse::<SocketAddr>().unwrap()
        );
        assert_eq!(
            proxy_socket_addr(&Url::parse("http://[::1]:3128").unwrap()).unwrap(),
            "[::1]:3128".parse::<SocketAddr>().unwrap()
        );
        assert!(proxy_socket_addr(&Url::parse("http://proxy.example:3128").unwrap()).is_err());
        assert!(proxy_socket_addr(&Url::parse("http://127.0.0.1").unwrap()).is_err());
    }
}
