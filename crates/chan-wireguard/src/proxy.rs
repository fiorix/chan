//! The loopback HTTP CONNECT proxy: one adapter through which a webview,
//! an HTTP client and a WebSocket dial reach hosts behind the tunnels.
//!
//! Every outbound leg the desktop has already knows how to dial through
//! an HTTP proxy, so one proxy on loopback puts them all inside the
//! tunnels without a TUN device and without a change to any of them. The
//! routing table is the tunnels' AllowedIPs: a destination inside one
//! tunnel's prefixes is opened through that tunnel, and anything else is
//! connected directly on the host. The pass-through is load-bearing, not
//! a convenience: a webview told to use a proxy sends every origin
//! through it, loopback included on Linux, so a proxy that refused the
//! rest would take the local windows down with it.

use std::fmt;
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{copy_bidirectional, AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::timeout;

use crate::stream::Stream;
use crate::tunnel::Tunnel;

/// A request head longer than this without a blank line ending it is
/// refused; a CONNECT head is a few hundred bytes, and the bound keeps a
/// client that never ends its head from growing the buffer forever.
const MAX_HEAD: usize = 16 * 1024;

/// How long a client has to finish its request head once connected.
const HEAD_TIMEOUT: Duration = Duration::from_secs(10);

/// How long resolving the authority and opening the connection may take
/// together before the client is told the gateway timed out. A connect
/// through a tunnel whose peer is silent never fails on its own, so this
/// is the only bound on it.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// Connections served at once. Past this the proxy stops accepting until
/// one ends, so a runaway local client cannot take every descriptor the
/// process has; the kernel's listen backlog holds the overflow.
const MAX_CONNECTIONS: usize = 256;

/// The pause after a failed accept (out of descriptors, most likely), so
/// the loop does not spin on the same error.
const ACCEPT_BACKOFF: Duration = Duration::from_millis(100);

const ESTABLISHED: &[u8] = b"HTTP/1.1 200 Connection Established\r\n\r\n";

/// A CONNECT proxy on a loopback address that routes by destination.
///
/// Serves from the bound address until dropped, and every connection open
/// through it ends with it. It has no authentication, which is why it
/// binds loopback only: any process on the host may open a connection
/// through a tunnel, the same reach a kernel WireGuard interface on the
/// host would give it, and nothing beyond the host can.
pub struct ConnectProxy {
    local: SocketAddr,
    tunnels: usize,
    accept: JoinHandle<()>,
}

impl ConnectProxy {
    /// Bind `bind`, which must be a loopback address (port 0 picks one),
    /// and serve CONNECT for the destinations of `tunnels`, in order:
    /// the first tunnel whose peer's AllowedIPs contain a resolved
    /// destination carries it, and a destination inside none is connected
    /// directly. Must be called within a tokio runtime, which the accept
    /// task runs on.
    pub async fn bind(tunnels: Vec<Tunnel>, bind: SocketAddr) -> io::Result<ConnectProxy> {
        if !bind.ip().is_loopback() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "the CONNECT proxy has no authentication and binds a loopback address only",
            ));
        }
        let listener = TcpListener::bind(bind).await?;
        let local = listener.local_addr()?;
        let router = Arc::new(Router { tunnels });
        let count = router.tunnels.len();
        let accept = tokio::spawn(accept_loop(listener, router));
        tracing::debug!(%local, tunnels = count, "CONNECT proxy listening");
        Ok(ConnectProxy {
            local,
            tunnels: count,
            accept,
        })
    }

    /// The address clients connect to.
    pub fn local_addr(&self) -> SocketAddr {
        self.local
    }
}

impl Drop for ConnectProxy {
    fn drop(&mut self) {
        // The accept task owns the connection tasks, so this ends them too.
        self.accept.abort();
    }
}

impl fmt::Debug for ConnectProxy {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ConnectProxy")
            .field("local", &self.local)
            .field("tunnels", &self.tunnels)
            .finish()
    }
}

struct Router {
    tunnels: Vec<Tunnel>,
}

impl Router {
    /// The first tunnel whose peer's AllowedIPs contain `ip`.
    fn tunnel_for(&self, ip: IpAddr) -> Option<&Tunnel> {
        self.tunnels
            .iter()
            .find(|tunnel| tunnel.allowed_ips().iter().any(|cidr| cidr.contains(ip)))
    }
}

async fn accept_loop(listener: TcpListener, router: Arc<Router>) {
    // The set owns every connection task, so dropping it when this task
    // is aborted ends them all with the proxy.
    let mut connections: JoinSet<()> = JoinSet::new();
    loop {
        while connections.len() >= MAX_CONNECTIONS {
            connections.join_next().await;
        }
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((socket, peer)) => {
                    connections.spawn(serve(router.clone(), socket, peer));
                }
                Err(e) => {
                    tracing::debug!(error = %e, "CONNECT proxy accept failed");
                    tokio::time::sleep(ACCEPT_BACKOFF).await;
                }
            },
            Some(finished) = connections.join_next() => {
                if let Err(e) = finished {
                    if e.is_panic() {
                        tracing::error!(error = %e, "a CONNECT proxy connection task panicked");
                    }
                }
            }
        }
    }
}

/// The status a connection is refused with. The response is the status
/// line and `Connection: close`, with no body and nothing from the
/// request in it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Status {
    /// The head does not parse as a CONNECT request.
    BadRequest,
    /// A parsed request with another method; only CONNECT is served.
    MethodNotAllowed,
    /// The head did not arrive within `HEAD_TIMEOUT`.
    RequestTimeout,
    /// The authority did not resolve or the connection was refused.
    BadGateway,
    /// Resolving and connecting took longer than `CONNECT_TIMEOUT`.
    GatewayTimeout,
}

impl Status {
    fn line(self) -> &'static str {
        match self {
            Status::BadRequest => "400 Bad Request",
            Status::MethodNotAllowed => "405 Method Not Allowed",
            Status::RequestTimeout => "408 Request Timeout",
            Status::BadGateway => "502 Bad Gateway",
            Status::GatewayTimeout => "504 Gateway Timeout",
        }
    }

    fn response(self) -> String {
        let mut head = format!("HTTP/1.1 {}\r\n", self.line());
        if self == Status::MethodNotAllowed {
            // A 405 names what the resource does accept.
            head.push_str("Allow: CONNECT\r\n");
        }
        head.push_str("Content-Length: 0\r\nConnection: close\r\n\r\n");
        head
    }
}

/// Why a connection ends before it is spliced.
enum Failure {
    /// The client is answered with the status and closed.
    Refused(Status),
    /// The client went away before it could be answered.
    Gone,
}

/// The connection to the destination, opened one way or the other.
enum Upstream {
    Tunnel(Stream),
    Direct(TcpStream),
}

async fn serve(router: Arc<Router>, mut client: TcpStream, peer: SocketAddr) {
    // Each direction carries small frames the other end waits on, so
    // holding one for a full segment adds a round trip to every one.
    if let Err(e) = client.set_nodelay(true) {
        tracing::debug!(error = %e, "CONNECT proxy client socket nodelay");
    }
    let (upstream, target) = match open(&router, &mut client).await {
        Ok(opened) => opened,
        Err(Failure::Refused(status)) => {
            tracing::debug!(%peer, status = status.line(), "CONNECT refused");
            let response = status.response();
            // The client may be gone already; there is nothing to do then.
            let _ = client.write_all(response.as_bytes()).await;
            let _ = client.shutdown().await;
            return;
        }
        Err(Failure::Gone) => return,
    };
    if let Err(e) = client.write_all(ESTABLISHED).await {
        tracing::debug!(%peer, error = %e, "CONNECT client left before the 200");
        return;
    }
    let route = match &upstream {
        Upstream::Tunnel(_) => "tunnel",
        Upstream::Direct(_) => "direct",
    };
    tracing::debug!(%peer, %target, route, "CONNECT established");
    let spliced = match upstream {
        Upstream::Tunnel(mut stream) => copy_bidirectional(&mut client, &mut stream).await,
        Upstream::Direct(mut stream) => copy_bidirectional(&mut client, &mut stream).await,
    };
    match spliced {
        Ok((to_target, to_client)) => {
            tracing::debug!(%peer, %target, to_target, to_client, "CONNECT closed");
        }
        Err(e) => tracing::debug!(%peer, %target, error = %e, "CONNECT ended"),
    }
}

/// Read and parse the request, resolve the authority and open the
/// connection to it, under the deadlines. Nothing is written to the
/// client here.
async fn open(router: &Router, client: &mut TcpStream) -> Result<(Upstream, SocketAddr), Failure> {
    let head = match timeout(HEAD_TIMEOUT, read_head(client)).await {
        Ok(Ok(head)) => head,
        Ok(Err(HeadError::TooLong)) => return Err(Failure::Refused(Status::BadRequest)),
        Ok(Err(HeadError::Closed)) => return Err(Failure::Gone),
        Err(_) => return Err(Failure::Refused(Status::RequestTimeout)),
    };
    let authority = parse_request(&head).map_err(Failure::Refused)?;
    match timeout(CONNECT_TIMEOUT, connect(router, &authority)).await {
        Ok(Ok(opened)) => Ok(opened),
        Ok(Err(e)) => {
            tracing::debug!(error = %e, "CONNECT target unreachable");
            Err(Failure::Refused(Status::BadGateway))
        }
        Err(_) => Err(Failure::Refused(Status::GatewayTimeout)),
    }
}

enum HeadError {
    TooLong,
    /// The client closed, or the read failed, before the head ended.
    Closed,
}

/// The request head up to and including the blank line, read one byte at
/// a time so that nothing after it is consumed: a client may follow its
/// CONNECT with the first bytes for the destination, and those belong to
/// the splice.
async fn read_head(client: &mut TcpStream) -> Result<Vec<u8>, HeadError> {
    let mut head = Vec::with_capacity(512);
    let mut byte = [0u8; 1];
    loop {
        match client.read(&mut byte).await {
            Ok(0) | Err(_) => return Err(HeadError::Closed),
            Ok(_) => head.push(byte[0]),
        }
        if head.ends_with(b"\r\n\r\n") {
            return Ok(head);
        }
        if head.len() >= MAX_HEAD {
            return Err(HeadError::TooLong);
        }
    }
}

/// The destination of a CONNECT: an address literal, or a name resolved
/// at connect time.
struct Authority {
    host: Host,
    port: u16,
}

enum Host {
    Ip(IpAddr),
    Name(String),
}

/// The request line of `head` as a CONNECT authority. Headers are not
/// read: the proxy has no use for `Host`, and a `Proxy-Authorization`
/// is ignored since there is nothing to authorize against.
fn parse_request(head: &[u8]) -> Result<Authority, Status> {
    let line_end = head
        .windows(2)
        .position(|pair| pair == b"\r\n")
        .ok_or(Status::BadRequest)?;
    let line = std::str::from_utf8(&head[..line_end]).map_err(|_| Status::BadRequest)?;
    let mut parts = line.split(' ');
    let (Some(method), Some(target), Some(version), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(Status::BadRequest);
    };
    if version != "HTTP/1.1" && version != "HTTP/1.0" {
        return Err(Status::BadRequest);
    }
    if method != "CONNECT" {
        return Err(Status::MethodNotAllowed);
    }
    parse_authority(target).ok_or(Status::BadRequest)
}

/// `host:port` with the host an IPv4 literal, a bracketed IPv6 literal or
/// a name of the characters a DNS name may carry. A bare IPv6 literal
/// has no unambiguous port and is refused.
fn parse_authority(target: &str) -> Option<Authority> {
    let (host, port) = match target.strip_prefix('[') {
        Some(rest) => {
            let (literal, port) = rest.split_once(']')?;
            let port = port.strip_prefix(':')?;
            let ip = literal.parse::<Ipv6Addr>().ok()?;
            (Host::Ip(IpAddr::V6(ip)), port)
        }
        None => {
            let (host, port) = target.rsplit_once(':')?;
            let host = match host.parse::<Ipv4Addr>() {
                Ok(ip) => Host::Ip(IpAddr::V4(ip)),
                Err(_) if is_name(host) => Host::Name(host.to_owned()),
                Err(_) => return None,
            };
            (host, port)
        }
    };
    if port.is_empty() || !port.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let port: u16 = port.parse().ok()?;
    if port == 0 {
        return None;
    }
    Some(Authority { host, port })
}

/// Letters, digits, hyphens, underscores and dots, within the length a
/// DNS name may have; a name is passed to the resolver and nowhere else.
fn is_name(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_'))
}

/// Resolve the authority on the host, every time, so a name that moves is
/// followed, then open the connection: through the first tunnel whose
/// AllowedIPs contain a resolved address, or directly when none does.
async fn connect(router: &Router, authority: &Authority) -> io::Result<(Upstream, SocketAddr)> {
    let addrs: Vec<SocketAddr> = match &authority.host {
        Host::Ip(ip) => vec![SocketAddr::new(*ip, authority.port)],
        Host::Name(name) => tokio::net::lookup_host((name.as_str(), authority.port))
            .await?
            .collect(),
    };
    if addrs.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "the authority resolved to no address",
        ));
    }
    for addr in &addrs {
        if let Some(tunnel) = router.tunnel_for(addr.ip()) {
            let stream = tunnel.connect(*addr).await?;
            return Ok((Upstream::Tunnel(stream), *addr));
        }
    }
    let stream = TcpStream::connect(addrs.as_slice()).await?;
    if let Err(e) = stream.set_nodelay(true) {
        tracing::debug!(error = %e, "CONNECT proxy target socket nodelay");
    }
    let peer = stream.peer_addr()?;
    Ok((Upstream::Direct(stream), peer))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::*;
    use crate::tunnel::TICK;
    use crate::x25519::{PublicKey, StaticSecret};
    use rand_core::OsRng;
    use tokio::net::UdpSocket;

    fn loopback() -> SocketAddr {
        "127.0.0.1:0".parse().unwrap()
    }

    /// Open a connection to the proxy and send a CONNECT for `target`,
    /// with the headers a browser or reqwest sends along.
    async fn send_connect(proxy: &ConnectProxy, target: &str) -> TcpStream {
        let mut client = TcpStream::connect(proxy.local_addr()).await.unwrap();
        let request = format!(
            "CONNECT {target} HTTP/1.1\r\nHost: {target}\r\nProxy-Connection: keep-alive\r\n\
             Proxy-Authorization: Basic Zm9vOmJhcg==\r\nUser-Agent: test\r\n\r\n"
        );
        client.write_all(request.as_bytes()).await.unwrap();
        client
    }

    /// The response head, read as the proxy reads a request: one byte at
    /// a time up to the blank line, so what follows is left to the test.
    /// `None` when the proxy closed before sending one.
    async fn read_response(client: &mut TcpStream) -> Option<Vec<u8>> {
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        loop {
            match client.read(&mut byte).await {
                Ok(0) | Err(_) => return None,
                Ok(_) => head.push(byte[0]),
            }
            if head.ends_with(b"\r\n\r\n") {
                return Some(head);
            }
            assert!(head.len() < MAX_HEAD, "the response head never ended");
        }
    }

    fn status_of(head: &[u8]) -> u16 {
        let text = std::str::from_utf8(head).unwrap();
        let line = text.lines().next().unwrap();
        assert!(line.starts_with("HTTP/1.1 "), "{line:?}");
        line[9..12].parse().unwrap()
    }

    /// CONNECT `target` and expect the refusal `status`, after which the
    /// proxy closes the connection.
    async fn expect_refusal(proxy: &ConnectProxy, request: &str, status: u16) {
        let mut client = TcpStream::connect(proxy.local_addr()).await.unwrap();
        client.write_all(request.as_bytes()).await.unwrap();
        let head = timeout(WAIT, read_response(&mut client))
            .await
            .unwrap()
            .expect("a refusal carries a status line");
        assert_eq!(
            status_of(&head),
            status,
            "{:?}",
            String::from_utf8_lossy(&head)
        );
        let text = String::from_utf8(head).unwrap();
        assert!(text.contains("\r\nConnection: close\r\n"), "{text:?}");
        assert!(text.contains("\r\nContent-Length: 0\r\n"), "{text:?}");
        let mut rest = [0u8; 16];
        assert_eq!(
            timeout(WAIT, client.read(&mut rest))
                .await
                .unwrap()
                .unwrap(),
            0,
            "the proxy closes after a refusal"
        );
    }

    /// Exchange a request and a reply through an established connection,
    /// then close the client and see the close reach the other end.
    async fn exchange<S: AsyncReadExt + AsyncWriteExt + Unpin>(
        mut client: TcpStream,
        mut server: S,
    ) {
        client.write_all(b"ping").await.unwrap();
        let mut buf = [0u8; 4];
        timeout(WAIT, server.read_exact(&mut buf))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&buf, b"ping");
        server.write_all(b"pong").await.unwrap();
        timeout(WAIT, client.read_exact(&mut buf))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&buf, b"pong");
        drop(client);
        assert_eq!(
            timeout(WAIT, server.read(&mut buf)).await.unwrap().unwrap(),
            0,
            "the client's close reaches the destination"
        );
    }

    #[tokio::test]
    async fn connect_to_a_tunnel_address_goes_through_the_tunnel() {
        let Pair { a, b, .. } = pair().await;
        let mut listener = b.listen(0).unwrap();
        let port = listener.port();
        let proxy = ConnectProxy::bind(vec![a], loopback()).await.unwrap();

        let mut client = send_connect(&proxy, &format!("{B_ADDR}:{port}")).await;
        let (head, server) = timeout(WAIT, async {
            tokio::join!(read_response(&mut client), listener.accept())
        })
        .await
        .unwrap();
        assert_eq!(status_of(&head.unwrap()), 200);
        let server = server.unwrap();
        assert_eq!(server.peer_addr().ip(), A_ADDR.parse::<IpAddr>().unwrap());
        exchange(client, server).await;
    }

    #[tokio::test]
    async fn connect_to_a_bracketed_ipv6_literal_passes_through() {
        let Pair { a, .. } = pair().await;
        let listener = TcpListener::bind("[::1]:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let proxy = ConnectProxy::bind(vec![a], loopback()).await.unwrap();

        let mut client = send_connect(&proxy, &format!("[::1]:{port}")).await;
        let (head, server) = timeout(WAIT, async {
            tokio::join!(read_response(&mut client), listener.accept())
        })
        .await
        .unwrap();
        assert_eq!(status_of(&head.unwrap()), 200);
        let (server, from) = server.unwrap();
        assert!(from.ip().is_loopback(), "{from}");
        exchange(client, server).await;
    }

    #[tokio::test]
    async fn connect_outside_allowed_ips_passes_through_without_a_datagram() {
        let key = StaticSecret::random_from_rng(OsRng);
        let peer = PublicKey::from(&StaticSecret::random_from_rng(OsRng));
        let probe = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let probe_at = probe.local_addr().unwrap();
        let udp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let a =
            Tunnel::start_on(config(key, peer, A_ADDR, B_ADDR, probe_at), udp, probe_at).unwrap();
        let listener = TcpListener::bind(loopback()).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let proxy = ConnectProxy::bind(vec![a], loopback()).await.unwrap();

        let mut client = send_connect(&proxy, &format!("127.0.0.1:{port}")).await;
        let (head, server) = timeout(WAIT, async {
            tokio::join!(read_response(&mut client), listener.accept())
        })
        .await
        .unwrap();
        assert_eq!(status_of(&head.unwrap()), 200);
        exchange(client, server.unwrap().0).await;
        tokio::time::sleep(2 * TICK).await;
        let mut buf = [0u8; 256];
        assert!(
            probe.try_recv_from(&mut buf).is_err(),
            "a pass-through must send nothing to the peer"
        );

        // The control: a destination inside AllowedIPs does reach the
        // endpoint, as the handshake initiation that precedes its SYN.
        let _pending = send_connect(&proxy, &format!("{B_ADDR}:80")).await;
        let (len, _) = timeout(WAIT, probe.recv_from(&mut buf))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(len, 148, "a handshake initiation");
        assert_eq!(&buf[..4], &[1, 0, 0, 0]);
    }

    #[tokio::test]
    async fn two_tunnels_route_by_destination() {
        let first = pair_at("10.7.0.1", "10.7.0.2").await;
        let second = pair_at("10.8.0.1", "10.8.0.2").await;
        let mut first_listener = first.b.listen(0).unwrap();
        let mut second_listener = second.b.listen(0).unwrap();
        let proxy = ConnectProxy::bind(vec![first.a, second.a], loopback())
            .await
            .unwrap();

        let target = format!("10.8.0.2:{}", second_listener.port());
        let mut client = send_connect(&proxy, &target).await;
        let (head, server) = timeout(WAIT, async {
            tokio::join!(read_response(&mut client), second_listener.accept())
        })
        .await
        .unwrap();
        assert_eq!(status_of(&head.unwrap()), 200);
        let server = server.unwrap();
        assert_eq!(
            server.peer_addr().ip(),
            "10.8.0.1".parse::<IpAddr>().unwrap()
        );
        exchange(client, server).await;

        let target = format!("10.7.0.2:{}", first_listener.port());
        let mut client = send_connect(&proxy, &target).await;
        let (head, server) = timeout(WAIT, async {
            tokio::join!(read_response(&mut client), first_listener.accept())
        })
        .await
        .unwrap();
        assert_eq!(status_of(&head.unwrap()), 200);
        let server = server.unwrap();
        assert_eq!(
            server.peer_addr().ip(),
            "10.7.0.1".parse::<IpAddr>().unwrap()
        );
        exchange(client, server).await;
    }

    #[tokio::test]
    async fn a_get_is_refused_with_405_and_closed() {
        let proxy = ConnectProxy::bind(Vec::new(), loopback()).await.unwrap();
        expect_refusal(&proxy, "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n", 405).await;
        expect_refusal(
            &proxy,
            "GET http://127.0.0.1:1/ HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n",
            405,
        )
        .await;
    }

    #[tokio::test]
    async fn a_malformed_request_is_refused_with_400() {
        let proxy = ConnectProxy::bind(Vec::new(), loopback()).await.unwrap();
        // A bare IPv6 literal, no port, port 0, an alphabetic port, a
        // version the proxy does not speak, a non-name host, and no
        // request line at all.
        for request in [
            "CONNECT ::1:443 HTTP/1.1\r\n\r\n",
            "CONNECT 127.0.0.1 HTTP/1.1\r\n\r\n",
            "CONNECT 127.0.0.1:0 HTTP/1.1\r\n\r\n",
            "CONNECT 127.0.0.1:https HTTP/1.1\r\n\r\n",
            "CONNECT 127.0.0.1:443 HTTP/2.0\r\n\r\n",
            "CONNECT a/b:443 HTTP/1.1\r\n\r\n",
            "\r\n\r\n",
        ] {
            expect_refusal(&proxy, request, 400).await;
        }
    }

    #[tokio::test]
    async fn an_oversized_head_is_refused_without_a_hang() {
        let proxy = ConnectProxy::bind(Vec::new(), loopback()).await.unwrap();
        let mut client = TcpStream::connect(proxy.local_addr()).await.unwrap();
        // A head that never ends: past the bound the proxy answers or
        // closes, and either is seen well before the head timeout.
        let head = vec![b'A'; MAX_HEAD + 4096];
        let writer = async {
            // The proxy may close before the whole head is written, in
            // which case the write fails; that is a refusal too.
            let _ = client.write_all(&head).await;
            if let Some(head) = read_response(&mut client).await {
                assert_eq!(status_of(&head), 400);
            }
        };
        timeout(Duration::from_secs(5), writer)
            .await
            .expect("an oversized head is answered or closed");
    }

    #[tokio::test]
    async fn a_refused_connection_answers_502() {
        let proxy = ConnectProxy::bind(Vec::new(), loopback()).await.unwrap();
        // A port that was just released has nothing listening on it.
        let port = {
            let listener = TcpListener::bind(loopback()).await.unwrap();
            listener.local_addr().unwrap().port()
        };
        expect_refusal(
            &proxy,
            &format!("CONNECT 127.0.0.1:{port} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n"),
            502,
        )
        .await;
    }

    #[tokio::test]
    async fn an_unresolvable_name_answers_502() {
        let proxy = ConnectProxy::bind(Vec::new(), loopback()).await.unwrap();
        // `.invalid` is reserved never to resolve (RFC 2606).
        expect_refusal(&proxy, "CONNECT nowhere.invalid:443 HTTP/1.0\r\n\r\n", 502).await;
    }

    #[tokio::test]
    async fn bind_refuses_a_non_loopback_address() {
        for bind in ["0.0.0.0:0", "[::]:0", "192.0.2.1:0", "[2001:db8::1]:0"] {
            let err = ConnectProxy::bind(Vec::new(), bind.parse().unwrap())
                .await
                .expect_err(bind);
            assert_eq!(err.kind(), io::ErrorKind::InvalidInput, "{bind}");
        }
        // The control: both loopback families bind.
        let v4 = ConnectProxy::bind(Vec::new(), loopback()).await.unwrap();
        assert!(v4.local_addr().ip().is_loopback());
        assert_ne!(v4.local_addr().port(), 0);
        let v6 = ConnectProxy::bind(Vec::new(), "[::1]:0".parse().unwrap())
            .await
            .unwrap();
        assert!(v6.local_addr().ip().is_loopback());
    }

    #[tokio::test]
    async fn debug_names_the_address_and_the_tunnel_count() {
        let Pair { a, b, .. } = pair().await;
        let proxy = ConnectProxy::bind(vec![a, b], loopback()).await.unwrap();
        let text = format!("{proxy:?}");
        assert!(text.contains(&proxy.local_addr().to_string()), "{text}");
        assert!(text.contains("tunnels: 2"), "{text}");
    }

    #[tokio::test]
    async fn dropping_the_proxy_ends_its_connections() {
        let listener = TcpListener::bind(loopback()).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let proxy = ConnectProxy::bind(Vec::new(), loopback()).await.unwrap();
        let at = proxy.local_addr();
        let mut client = send_connect(&proxy, &format!("127.0.0.1:{port}")).await;
        let (head, server) = timeout(WAIT, async {
            tokio::join!(read_response(&mut client), listener.accept())
        })
        .await
        .unwrap();
        assert_eq!(status_of(&head.unwrap()), 200);
        let (mut server, _) = server.unwrap();

        drop(proxy);
        let mut buf = [0u8; 8];
        assert_eq!(
            timeout(WAIT, server.read(&mut buf)).await.unwrap().unwrap(),
            0,
            "the destination sees the splice end"
        );
        assert_eq!(
            timeout(WAIT, client.read(&mut buf)).await.unwrap().unwrap(),
            0,
            "the client sees the splice end"
        );
        assert!(
            TcpStream::connect(at).await.is_err(),
            "nothing listens once the proxy is dropped"
        );
    }
}
