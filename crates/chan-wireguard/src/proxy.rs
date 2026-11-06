//! The loopback HTTP proxy: one adapter through which a webview, an HTTP
//! client and a WebSocket dial reach hosts behind the tunnels.
//!
//! Every outbound leg the desktop has already knows how to dial through
//! an HTTP proxy, so one proxy on loopback puts them all inside the
//! tunnels without a TUN device and without a change to any of them. The
//! routing table is a live list of routes, each a tunnel under an id the
//! caller chose, which the caller edits while the proxy serves: a host
//! name a route maps is opened through its tunnel with no lookup on the
//! host, a destination inside one route's AllowedIPs is opened through
//! that route's tunnel, and anything else is connected directly on the
//! host. The pass-through is load-bearing, not a convenience: a webview
//! told to use a proxy sends every origin through it, loopback included
//! on Linux, so a proxy that refused the rest would take the local windows
//! down with it.
//!
//! Two request shapes are served. `CONNECT host:port` is what a browser
//! sends for an `https://` or `wss://` origin: the connection to the
//! destination is opened and the two are spliced. An absolute-form
//! request (`GET http://host/path`) is what a browser sends for a plain
//! `http://` origin, the local workspace windows among them: the request
//! is forwarded over a connection opened for it, with the response
//! streamed back, and an `Upgrade` the destination accepts is bridged.
//! hyper serves each client connection, so the same connection carries
//! any number of requests to any number of destinations, which is why a
//! transparent splice after the first request line would not do.

use std::convert::Infallible;
use std::fmt;
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use http_body_util::{Either, Empty};
use hyper::body::{Bytes, Incoming};
use hyper::client::conn::http1 as client;
use hyper::ext::ReasonPhrase;
use hyper::header::{self, HeaderMap, HeaderName, HeaderValue};
use hyper::http::uri::{self, PathAndQuery};
use hyper::server::conn::http1 as server;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode, Uri, Version};
use hyper_util::rt::{TokioIo, TokioTimer};
use parking_lot::{Mutex, RwLock};
use tokio::io::{copy_bidirectional, AsyncRead, AsyncWrite};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::timeout;

use crate::tunnel::Tunnel;

/// The most a request head may take; one longer is answered `431`. hyper
/// reads a head into one buffer bounded by this, so a client that never
/// ends its head cannot grow it forever. A browser's head is a few KiB,
/// cookies included.
const MAX_HEAD: usize = 64 * 1024;

/// How long a client has to send a request head, counted from the end
/// of the previous response as well as from the connect, so an idle
/// keep-alive connection is closed after this too. The close carries no
/// response; a browser reopens a connection it finds closed.
const HEAD_TIMEOUT: Duration = Duration::from_secs(60);

/// How long resolving the authority and opening the connection may take
/// together before the client is told the gateway timed out. This remains
/// the bound when a tunnel still has a session or awaits endpoint resolution.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// A request's SYN starts a handshake attempt when a tunnel has no session.
/// Give that attempt time to finish before refusing; the bound stays below
/// the connecting page's probe timeout so it can read the refusal and state.
const SESSION_TIMEOUT: Duration = Duration::from_secs(3);

/// Connections served at once. Past this the proxy stops accepting until
/// one ends, so a runaway local client cannot take every descriptor the
/// process has; the kernel's listen backlog holds the overflow.
const MAX_CONNECTIONS: usize = 256;

/// The pause after a failed accept (out of descriptors, most likely), so
/// the loop does not spin on the same error.
const ACCEPT_BACKOFF: Duration = Duration::from_millis(100);

/// One route of a [`ConnectProxy`]'s table.
#[derive(Clone, Debug)]
pub struct ProxyRoute {
    /// The tunnel that carries the destinations inside its peer's
    /// AllowedIPs. The route holds a handle of its own, so the tunnel runs
    /// at least as long as the route is in the table.
    pub tunnel: Tunnel,
    /// Host names the tunnel carries by name: a request for one connects
    /// through `tunnel` to its addresses with no lookup on the host. Empty
    /// for a route that carries destinations by address only.
    pub hosts: Vec<HostRoute>,
}

/// A host name a route carries without a lookup on the host, and the
/// tunnel addresses it stands for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostRoute {
    /// A DNS name, or `*.` followed by one, which matches a name with one
    /// or more labels in front of that suffix but never the suffix alone.
    /// Matched without regard to ASCII case.
    pub name: String,
    /// The addresses a request for the name connects to, in order: the
    /// first of a family the tunnel has an address of is used. Each lies
    /// inside the route's tunnel's AllowedIPs.
    pub addresses: Vec<IpAddr>,
}

impl HostRoute {
    /// Whether the request authority `name`, already a well-formed DNS
    /// name, is this entry's name or falls under its wildcard.
    fn matches(&self, name: &str) -> bool {
        match self.name.strip_prefix("*.") {
            Some(suffix) => {
                // The suffix and the dot in front of it, after at least one
                // label; every name here is ASCII, so byte offsets are
                // character offsets.
                let Some(head) = name.len().checked_sub(suffix.len() + 1) else {
                    return false;
                };
                head > 0
                    && name.as_bytes()[head] == b'.'
                    && name[head + 1..].eq_ignore_ascii_case(suffix)
            }
            None => name.eq_ignore_ascii_case(&self.name),
        }
    }
}

/// Refuse a route whose host map could send a mapped name anywhere but
/// through its tunnel: a name no request authority can match, or an
/// address outside the tunnel's AllowedIPs, which `Tunnel::connect` would
/// refuse and nothing would carry.
fn check_route(route: &ProxyRoute) -> io::Result<()> {
    for host in &route.hosts {
        let suffix = host.name.strip_prefix("*.").unwrap_or(&host.name);
        if !is_dns_name(suffix) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "the route's host {:?} is not a DNS name or *. and a DNS name",
                    host.name
                ),
            ));
        }
        let allowed = route.tunnel.allowed_ips();
        if let Some(outside) = host
            .addresses
            .iter()
            .find(|ip| !allowed.iter().any(|cidr| cidr.contains(**ip)))
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "the route maps {} to {outside}, which is outside its tunnel's AllowedIPs",
                    host.name
                ),
            ));
        }
    }
    Ok(())
}

/// An HTTP proxy on a loopback address that routes by destination.
///
/// Serves from the bound address until dropped, and every connection open
/// through it ends with it. It has no authentication, which is why it
/// binds loopback only: any process on the host may open a connection
/// through a tunnel, the same reach a kernel WireGuard interface on the
/// host would give it, and nothing beyond the host can.
///
/// The routes are live: [`add_route`](Self::add_route),
/// [`replace_route`](Self::replace_route) and
/// [`remove_route`](Self::remove_route) change them while the proxy serves,
/// and each request reads the table as it is when its destination is
/// opened. A connection already open keeps the stream it opened, so
/// replacing or removing its route does not end it; it ends when its
/// tunnel does, which is when the last handle of that tunnel is dropped,
/// the route's own included.
pub struct ConnectProxy {
    local: SocketAddr,
    router: Arc<Router>,
    accept: JoinHandle<()>,
}

impl ConnectProxy {
    /// Bind `bind` and serve over `tunnels`, as
    /// [`bind_routed`](Self::bind_routed) does with one route per tunnel,
    /// in order, under the ids `"0"`, `"1"` and so on, and no host names.
    pub async fn bind(tunnels: Vec<Tunnel>, bind: SocketAddr) -> io::Result<ConnectProxy> {
        let routes = tunnels
            .into_iter()
            .enumerate()
            .map(|(index, tunnel)| {
                let route = ProxyRoute {
                    tunnel,
                    hosts: Vec::new(),
                };
                (index.to_string(), route)
            })
            .collect();
        Self::bind_routed(routes, bind).await
    }

    /// Bind `bind`, which must be a loopback address (port 0 picks one),
    /// and serve CONNECT and plain-HTTP forwarding with `routes` as the
    /// starting table, each under its id. A host name the table maps is
    /// matched first, in table order, and connected through its route's
    /// tunnel with no lookup on the host; any other destination is
    /// resolved, and the first route, in table order, whose tunnel's
    /// AllowedIPs contain a resolved address carries it, while a
    /// destination inside none is connected directly. An empty table
    /// connects everything directly until a route is added. Two routes
    /// under one id are refused with `AlreadyExists`, and a host map that
    /// [`add_route`](Self::add_route) refuses is refused here the same way.
    /// Must be called within a tokio runtime, which the accept task runs
    /// on.
    pub async fn bind_routed(
        routes: Vec<(String, ProxyRoute)>,
        bind: SocketAddr,
    ) -> io::Result<ConnectProxy> {
        if !bind.ip().is_loopback() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "the proxy has no authentication and binds a loopback address only",
            ));
        }
        let mut table: Vec<(String, ProxyRoute)> = Vec::with_capacity(routes.len());
        for (id, route) in routes {
            check_route(&route)?;
            if table.iter().any(|(held, _)| *held == id) {
                return Err(held_id(&id));
            }
            table.push((id, route));
        }
        let listener = TcpListener::bind(bind).await?;
        let local = listener.local_addr()?;
        let count = table.len();
        let router = Arc::new(Router {
            routes: RwLock::new(table),
        });
        let accept = tokio::spawn(accept_loop(listener, router.clone()));
        tracing::debug!(%local, routes = count, "proxy listening");
        Ok(ConnectProxy {
            local,
            router,
            accept,
        })
    }

    /// The address clients connect to.
    pub fn local_addr(&self) -> SocketAddr {
        self.local
    }

    /// Append `route` under `id`; the next connection to one of its
    /// destinations goes through it. An id already in the table is refused
    /// with `AlreadyExists`, and with `InvalidInput` a host entry whose
    /// name is not a DNS name or `*.` and one, or whose address lies
    /// outside the tunnel's AllowedIPs, so a mapped name can never take the
    /// direct path; a refusal leaves the table as it was.
    pub fn add_route(&self, id: &str, route: ProxyRoute) -> io::Result<()> {
        check_route(&route)?;
        let mut routes = self.router.routes.write();
        if routes.iter().any(|(held, _)| held == id) {
            return Err(held_id(id));
        }
        routes.push((id.to_owned(), route));
        tracing::debug!(id, routes = routes.len(), "proxy route added");
        Ok(())
    }

    /// Put `route` under `id`: in the place of the route held there, so
    /// its order among the routes stands, or at the end when the id is
    /// new. The route it replaces is dropped once the new one is in the
    /// table, so the next connection goes through the new tunnel while the
    /// connections the old one carries end only when its last handle does.
    /// A host map [`add_route`](Self::add_route) refuses is refused the
    /// same way, and the table is left as it was.
    pub fn replace_route(&self, id: &str, route: ProxyRoute) -> io::Result<()> {
        check_route(&route)?;
        let replaced = {
            let mut routes = self.router.routes.write();
            let replaced = match routes.iter_mut().find(|(held, _)| held == id) {
                Some((_, held)) => Some(std::mem::replace(held, route)),
                None => {
                    routes.push((id.to_owned(), route));
                    None
                }
            };
            tracing::debug!(
                id,
                replaced = replaced.is_some(),
                routes = routes.len(),
                "proxy route set"
            );
            replaced
        };
        // A tunnel's last handle stops its driver; that work stays outside
        // the table's lock.
        drop(replaced);
        Ok(())
    }

    /// Remove the route under `id`, so its destinations are connected
    /// directly from the next connection on; `false` when no route has
    /// that id. Connections open through it end with its tunnel.
    pub fn remove_route(&self, id: &str) -> bool {
        let removed = {
            let mut routes = self.router.routes.write();
            let removed = routes
                .iter()
                .position(|(held, _)| held == id)
                .map(|index| routes.remove(index));
            tracing::debug!(
                id,
                removed = removed.is_some(),
                routes = routes.len(),
                "proxy route removed"
            );
            removed
        };
        let found = removed.is_some();
        drop(removed);
        found
    }

    /// How many routes the table holds.
    pub fn routes(&self) -> usize {
        self.router.routes.read().len()
    }
}

fn held_id(id: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::AlreadyExists,
        format!("the proxy already has a route with the id {id:?}"),
    )
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
            .field("routes", &self.routes())
            .finish()
    }
}

/// The live table, shared by the proxy, its accept task and every
/// connection. A reader holds the lock only to find a route and clone its
/// tunnel handle out, never across an await, and a writer only for one
/// edit of the list, so the lock is never contended for long.
struct Router {
    routes: RwLock<Vec<(String, ProxyRoute)>>,
}

impl Router {
    /// The tunnel and the addresses of the first host entry, in table
    /// order, that names `name`. A name with an empty label matches none.
    fn mapped(&self, name: &str) -> Option<(Tunnel, Vec<IpAddr>)> {
        if !is_dns_name(name) {
            return None;
        }
        self.routes.read().iter().find_map(|(_, route)| {
            route
                .hosts
                .iter()
                .find(|host| host.matches(name))
                .map(|host| (route.tunnel.clone(), host.addresses.clone()))
        })
    }

    /// The tunnel of the first route whose peer's AllowedIPs contain `ip`.
    fn tunnel_for(&self, ip: IpAddr) -> Option<Tunnel> {
        self.routes
            .read()
            .iter()
            .map(|(_, route)| &route.tunnel)
            .find(|tunnel| tunnel.allowed_ips().iter().any(|cidr| cidr.contains(ip)))
            .cloned()
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
                    tracing::debug!(error = %e, "proxy accept failed");
                    tokio::time::sleep(ACCEPT_BACKOFF).await;
                }
            },
            Some(finished) = connections.join_next() => {
                if let Err(e) = finished {
                    if e.is_panic() {
                        tracing::error!(error = %e, "a proxy connection task panicked");
                    }
                }
            }
        }
    }
}

/// The body of a response to the client: nothing, for a CONNECT, a 101
/// or a refusal, or the destination's response body streamed through.
type ResponseBody = Either<Empty<Bytes>, Incoming>;

fn empty() -> ResponseBody {
    Either::Left(Empty::new())
}

/// The connection to the destination, through a tunnel or direct, as one
/// type hyper and the splice can take.
trait Io: AsyncRead + AsyncWrite + Send + Unpin {}

impl<T: AsyncRead + AsyncWrite + Send + Unpin> Io for T {}

/// One accepted client connection: hyper serves its requests through
/// `handle`, and the tasks a request leaves behind (a splice, the
/// connection to a destination) are kept here so the connection task
/// waits for them and aborting it ends them.
struct Connection {
    router: Arc<Router>,
    peer: SocketAddr,
    side: Mutex<JoinSet<()>>,
}

async fn serve(router: Arc<Router>, client: TcpStream, peer: SocketAddr) {
    // Each direction carries small frames the other end waits on, so
    // holding one for a full segment adds a round trip to every one.
    if let Err(e) = client.set_nodelay(true) {
        tracing::debug!(error = %e, "proxy client socket nodelay");
    }
    let connection = Arc::new(Connection {
        router,
        peer,
        side: Mutex::new(JoinSet::new()),
    });
    let service = service_fn({
        let connection = connection.clone();
        move |request| {
            let connection = connection.clone();
            async move { Ok::<_, Infallible>(connection.handle(request).await) }
        }
    });
    let served = server::Builder::new()
        .timer(TokioTimer::new())
        .header_read_timeout(HEAD_TIMEOUT)
        .max_buf_size(MAX_HEAD)
        .serve_connection(TokioIo::new(client), service)
        .with_upgrades()
        .await;
    if let Err(e) = served {
        tracing::debug!(%peer, error = %e, "proxy connection ended");
    }
    // hyper is done with the connection once it hands an upgrade over or
    // the last response is written; the splice and the destination
    // connections run on, and this task's end must mean theirs.
    let mut side = std::mem::take(&mut *connection.side.lock());
    while side.join_next().await.is_some() {}
}

impl Connection {
    async fn handle(self: Arc<Self>, request: Request<Incoming>) -> Response<ResponseBody> {
        let result = if request.method() == Method::CONNECT {
            self.connect(request).await
        } else {
            self.forward(request).await
        };
        result.unwrap_or_else(|status| {
            tracing::debug!(peer = %self.peer, %status, "proxy request refused");
            refusal(status)
        })
    }

    /// Open the destination and answer 200; the splice runs once hyper
    /// hands the client connection over.
    async fn connect(
        &self,
        mut request: Request<Incoming>,
    ) -> Result<Response<ResponseBody>, StatusCode> {
        let authority = connect_authority(request.uri()).ok_or(StatusCode::BAD_REQUEST)?;
        let (upstream, target, route) = self.open(&authority).await?;
        let client = hyper::upgrade::on(&mut request);
        let peer = self.peer;
        tracing::debug!(%peer, %target, route, "CONNECT established");
        self.side.lock().spawn(async move {
            match client.await {
                Ok(client) => splice(TokioIo::new(client), upstream, peer, target).await,
                Err(e) => tracing::debug!(%peer, %target, error = %e, "CONNECT client left"),
            }
        });
        let mut response = Response::new(empty());
        // The status code is what a client acts on; the phrase is the
        // one every CONNECT proxy writes.
        response
            .extensions_mut()
            .insert(ReasonPhrase::from_static(b"Connection Established"));
        Ok(response)
    }

    /// Forward an absolute-form request over a connection opened for it
    /// and stream the response back; a 101 bridges the two upgraded
    /// connections.
    async fn forward(
        &self,
        mut request: Request<Incoming>,
    ) -> Result<Response<ResponseBody>, StatusCode> {
        let (authority, origin_form) = forward_target(request.uri())?;
        let version = request.version();
        // The client's upgrade handle is taken before the request moves on
        // to hyper's client, which has no use for it.
        let client_upgrade = wants_upgrade(&request).then(|| hyper::upgrade::on(&mut request));
        let (upstream, target, route) = self.open(&authority).await?;
        let (mut sender, upstream) = client::handshake(TokioIo::new(upstream))
            .await
            .map_err(|_| StatusCode::BAD_GATEWAY)?;
        let peer = self.peer;
        self.side.lock().spawn(async move {
            if let Err(e) = upstream.with_upgrades().await {
                tracing::debug!(%peer, %target, error = %e, "proxy destination connection ended");
            }
        });

        *request.uri_mut() = origin_form;
        // The destination hop is this proxy's own HTTP/1.1 connection,
        // whatever the client spoke; hyper frames the client's side by
        // the client's version.
        *request.version_mut() = Version::HTTP_11;
        strip_hop_by_hop(request.headers_mut(), client_upgrade.is_some());
        request
            .headers_mut()
            .insert(header::HOST, authority.host_header());
        if client_upgrade.is_none() {
            // One connection per request: the destination may close it
            // once the response is out, which also ends a response body
            // of unstated length.
            request
                .headers_mut()
                .insert(header::CONNECTION, HeaderValue::from_static("close"));
        }
        tracing::debug!(%peer, %target, route, "forwarding");

        let mut response = sender.send_request(request).await.map_err(|e| {
            tracing::debug!(%peer, %target, error = %e, "proxy destination gave no response");
            StatusCode::BAD_GATEWAY
        })?;
        if response.status() == StatusCode::SWITCHING_PROTOCOLS {
            // A 101 to a request that asked for no upgrade is the
            // destination's error, and hyper could not hand the client
            // connection over for it.
            let client = client_upgrade.ok_or(StatusCode::BAD_GATEWAY)?;
            let destination = hyper::upgrade::on(&mut response);
            self.side.lock().spawn(async move {
                match tokio::try_join!(client, destination) {
                    Ok((client, destination)) => {
                        splice(
                            TokioIo::new(client),
                            TokioIo::new(destination),
                            peer,
                            target,
                        )
                        .await
                    }
                    Err(e) => {
                        tracing::debug!(%peer, %target, error = %e, "proxy upgrade not completed")
                    }
                }
            });
            tracing::debug!(%peer, %target, route, "proxy upgrade bridged");
            let (mut parts, _) = response.into_parts();
            strip_hop_by_hop(&mut parts.headers, true);
            parts.version = version;
            return Ok(Response::from_parts(parts, empty()));
        }
        let (mut parts, body) = response.into_parts();
        strip_hop_by_hop(&mut parts.headers, false);
        parts.version = version;
        Ok(Response::from_parts(parts, Either::Right(body)))
    }

    /// Resolve the authority and open the connection to it, under the
    /// deadline, as the statuses a refusal answers with.
    async fn open(
        &self,
        authority: &Authority,
    ) -> Result<(Box<dyn Io>, SocketAddr, &'static str), StatusCode> {
        match timeout(CONNECT_TIMEOUT, connect(&self.router, authority)).await {
            Ok(Ok(opened)) => Ok(opened),
            Ok(Err(e)) => {
                tracing::debug!(peer = %self.peer, error = %e, "proxy destination unreachable");
                Err(StatusCode::BAD_GATEWAY)
            }
            Err(_) => Err(StatusCode::GATEWAY_TIMEOUT),
        }
    }
}

/// Copy both ways until either side ends, then drop both.
async fn splice<C, U>(mut client: C, mut upstream: U, peer: SocketAddr, target: SocketAddr)
where
    C: AsyncRead + AsyncWrite + Unpin,
    U: AsyncRead + AsyncWrite + Unpin,
{
    match copy_bidirectional(&mut client, &mut upstream).await {
        Ok((to_target, to_client)) => {
            tracing::debug!(%peer, %target, to_target, to_client, "proxy splice closed");
        }
        Err(e) => tracing::debug!(%peer, %target, error = %e, "proxy splice ended"),
    }
}

/// The response a request is refused with: the status, no body and
/// `Connection: close`, with nothing from the request in it. hyper adds
/// the `Content-Length: 0` and closes the connection after it.
fn refusal(status: StatusCode) -> Response<ResponseBody> {
    let mut response = Response::new(empty());
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert(header::CONNECTION, HeaderValue::from_static("close"));
    response
}

/// Whether the request asks the destination for a protocol upgrade: an
/// `Upgrade` header named by `Connection`, on HTTP/1.1, as RFC 7230
/// requires for the header to mean anything.
fn wants_upgrade(request: &Request<Incoming>) -> bool {
    request.version() == Version::HTTP_11
        && request.headers().contains_key(header::UPGRADE)
        && connection_tokens(request.headers()).any(|token| token.eq_ignore_ascii_case("upgrade"))
}

/// The header names the `Connection` header lists.
fn connection_tokens(headers: &HeaderMap) -> impl Iterator<Item = &str> {
    headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(str::trim)
        .filter(|token| !token.is_empty())
}

/// The headers that belong to one hop (RFC 7230 6.1) and the proxy's own
/// ones; `Transfer-Encoding` is hyper's, which frames each hop itself.
const HOP_BY_HOP: [HeaderName; 9] = [
    header::CONNECTION,
    HeaderName::from_static("keep-alive"),
    header::PROXY_AUTHENTICATE,
    header::PROXY_AUTHORIZATION,
    HeaderName::from_static("proxy-connection"),
    header::TE,
    header::TRAILER,
    header::TRANSFER_ENCODING,
    header::UPGRADE,
];

/// Remove the hop-by-hop headers, the ones `Connection` names included.
/// With `upgrade` the `Upgrade` header stays and `Connection` names it,
/// which is what carries a protocol switch across the hop.
fn strip_hop_by_hop(headers: &mut HeaderMap, upgrade: bool) {
    let named: Vec<HeaderName> = connection_tokens(headers)
        .filter_map(|token| HeaderName::from_bytes(token.as_bytes()).ok())
        .collect();
    for name in named.iter().chain(HOP_BY_HOP.iter()) {
        if upgrade && *name == header::UPGRADE {
            continue;
        }
        headers.remove(name);
    }
    if upgrade {
        headers.insert(header::CONNECTION, HeaderValue::from_static("upgrade"));
    }
}

/// The destination of a request: an address literal, or a name resolved
/// at connect time, and the port.
struct Authority {
    host: Host,
    port: u16,
}

enum Host {
    Ip(IpAddr),
    Name(String),
}

impl Authority {
    /// The `Host` header of a forwarded request: the authority of the
    /// target, as RFC 7230 has a proxy send it, with port 80 left off as
    /// a browser does.
    fn host_header(&self) -> HeaderValue {
        let host = match &self.host {
            Host::Ip(IpAddr::V6(ip)) => format!("[{ip}]"),
            Host::Ip(IpAddr::V4(ip)) => ip.to_string(),
            Host::Name(name) => name.clone(),
        };
        let value = if self.port == 80 {
            host
        } else {
            format!("{host}:{}", self.port)
        };
        HeaderValue::from_str(&value).expect("a parsed authority has header characters only")
    }
}

/// The target of a CONNECT: an authority with a port and nothing else.
fn connect_authority(uri: &Uri) -> Option<Authority> {
    if uri.scheme().is_some()
        || uri
            .path_and_query()
            .is_some_and(|pq| !pq.as_str().is_empty())
    {
        return None;
    }
    parse_authority(uri.authority()?.as_str(), None)
}

/// The target of a request to forward: absolute-form with the `http`
/// scheme, or `ws`, which WebKitGTK writes on a WebSocket upgrade to a
/// plain origin and which names the same hop, as the authority to open
/// and the origin-form target the destination is sent. Origin-form,
/// which is a request to this proxy itself, and any other scheme are
/// refused: `https://` and `wss://` reach the proxy as CONNECT, and the
/// rest it does not speak.
fn forward_target(uri: &Uri) -> Result<(Authority, Uri), StatusCode> {
    if !matches!(uri.scheme_str(), Some("http" | "ws")) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let authority = uri
        .authority()
        .and_then(|authority| parse_authority(authority.as_str(), Some(80)))
        .ok_or(StatusCode::BAD_REQUEST)?;
    let mut parts = uri::Parts::default();
    parts.path_and_query = Some(
        uri.path_and_query()
            .cloned()
            .unwrap_or_else(|| PathAndQuery::from_static("/")),
    );
    let origin_form = Uri::from_parts(parts).map_err(|_| StatusCode::BAD_REQUEST)?;
    Ok((authority, origin_form))
}

/// `host[:port]` with the host an IPv4 literal, a bracketed IPv6 literal
/// or a name of the characters a DNS name may carry. A bare IPv6 literal
/// has no unambiguous port and is refused; so is a missing port when
/// there is no default for it, a port of 0 and a port that is not a
/// number.
fn parse_authority(target: &str, default_port: Option<u16>) -> Option<Authority> {
    let (host, port) = match target.strip_prefix('[') {
        Some(rest) => {
            let (literal, port) = rest.split_once(']')?;
            let ip = literal.parse::<Ipv6Addr>().ok()?;
            (Host::Ip(IpAddr::V6(ip)), port.strip_prefix(':'))
        }
        None => {
            let (host, port) = match target.rsplit_once(':') {
                Some((host, port)) => (host, Some(port)),
                None => (target, None),
            };
            let host = match host.parse::<Ipv4Addr>() {
                Ok(ip) => Host::Ip(IpAddr::V4(ip)),
                Err(_) if is_name(host) => Host::Name(host.to_owned()),
                Err(_) => return None,
            };
            (host, port)
        }
    };
    let port = match port {
        Some(port) => {
            if port.is_empty() || !port.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            port.parse::<u16>().ok()?
        }
        None => default_port?,
    };
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

/// A name [`is_name`] accepts whose labels are all non-empty: the form a
/// host entry's name, or the suffix of its wildcard, must take.
fn is_dns_name(host: &str) -> bool {
    is_name(host) && host.split('.').all(|label| !label.is_empty())
}

/// Open the connection to the authority. A name a route maps goes through
/// that route's tunnel with no lookup on the host. Anything else is
/// resolved on the host, every time, so a name that moves is followed,
/// and goes through the tunnel of the first route whose AllowedIPs
/// contain a resolved address, or directly when none does.
async fn connect(
    router: &Router,
    authority: &Authority,
) -> io::Result<(Box<dyn Io>, SocketAddr, &'static str)> {
    if let Host::Name(name) = &authority.host {
        if let Some((tunnel, addresses)) = router.mapped(name) {
            return connect_mapped(&tunnel, &addresses, authority.port).await;
        }
    }
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
            let stream = connect_tunnel(&tunnel, *addr).await?;
            return Ok((Box::new(stream), *addr, "tunnel"));
        }
    }
    let stream = TcpStream::connect(addrs.as_slice()).await?;
    if let Err(e) = stream.set_nodelay(true) {
        tracing::debug!(error = %e, "proxy destination socket nodelay");
    }
    let peer = stream.peer_addr()?;
    Ok((Box::new(stream), peer, "direct"))
}

/// Connect a mapped name through its tunnel to the first of its addresses
/// whose family the tunnel has an address of. `Tunnel::connect` refuses a
/// family it lacks with `AddrNotAvailable` before it sends anything, so
/// that refusal moves on to the next address; a map with none of the
/// tunnel's families fails with it, and nothing is ever dialed directly.
async fn connect_mapped(
    tunnel: &Tunnel,
    addresses: &[IpAddr],
    port: u16,
) -> io::Result<(Box<dyn Io>, SocketAddr, &'static str)> {
    let mut lacking = io::Error::new(
        io::ErrorKind::AddrNotAvailable,
        "the mapped name has no address",
    );
    for ip in addresses {
        let addr = SocketAddr::new(*ip, port);
        match connect_tunnel(tunnel, addr).await {
            Ok(stream) => return Ok((Box::new(stream), addr, "tunnel")),
            Err(e) if e.kind() == io::ErrorKind::AddrNotAvailable => lacking = e,
            Err(e) => return Err(e),
        }
    }
    Err(lacking)
}

/// Keep the handshake's initiating SYN in flight while a tunnel with a
/// known endpoint has no session. A session that appears at the deadline
/// still gets the outer connect deadline; a dark tunnel gets a 502.
async fn connect_tunnel(tunnel: &Tunnel, addr: SocketAddr) -> io::Result<crate::Stream> {
    let status = tunnel.status();
    if matches!(status.handshake, crate::HandshakeState::Live(_)) || status.endpoint.is_none() {
        return tunnel.connect(addr).await;
    }
    let connecting = tunnel.connect(addr);
    tokio::pin!(connecting);
    tokio::select! {
        result = &mut connecting => result,
        _ = tokio::time::sleep(SESSION_TIMEOUT) => {
            let status = tunnel.status();
            if matches!(status.handshake, crate::HandshakeState::Live(_)) {
                connecting.await
            } else {
                tracing::debug!(
                    target = %addr,
                    route = "tunnel",
                    handshake = ?status.handshake,
                    "proxy refused a connection through a tunnel with no session"
                );
                Err(io::Error::new(io::ErrorKind::TimedOut, "the tunnel has no session"))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::*;
    use crate::tunnel::TICK;
    use crate::x25519::{PublicKey, StaticSecret};
    use http_body_util::{BodyExt, Full};
    use hyper::body::{Body, Frame, SizeHint};
    use rand_core::OsRng;
    use std::future::Future;
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::UdpSocket;
    use tokio::sync::mpsc;

    fn loopback() -> SocketAddr {
        "127.0.0.1:0".parse().unwrap()
    }

    type EventFields = Vec<(String, String)>;

    #[derive(Clone, Default)]
    struct ProxyEvents(Arc<Mutex<Vec<EventFields>>>);

    impl tracing::Subscriber for ProxyEvents {
        fn enabled(&self, _: &tracing::Metadata<'_>) -> bool {
            true
        }

        fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
            tracing::span::Id::from_u64(1)
        }

        fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}

        fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}

        fn event(&self, event: &tracing::Event<'_>) {
            struct Fields(Vec<(String, String)>);
            impl tracing::field::Visit for Fields {
                fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn fmt::Debug) {
                    self.0.push((field.name().into(), format!("{value:?}")));
                }
            }
            let mut fields = Fields(Vec::new());
            event.record(&mut fields);
            fields
                .0
                .push(("event_target".into(), event.metadata().target().into()));
            self.0.lock().push(fields.0);
        }

        fn enter(&self, _: &tracing::span::Id) {}

        fn exit(&self, _: &tracing::span::Id) {}
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

    /// A message head, read one byte at a time up to the blank line so
    /// what follows is left to the test. `None` when the other side
    /// closed before sending one.
    async fn read_head<S: AsyncRead + Unpin>(from: &mut S) -> Option<Vec<u8>> {
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        loop {
            match from.read(&mut byte).await {
                Ok(0) | Err(_) => return None,
                Ok(_) => head.push(byte[0]),
            }
            if head.ends_with(b"\r\n\r\n") {
                return Some(head);
            }
            assert!(head.len() < MAX_HEAD, "the head never ended");
        }
    }

    /// The status of a response head; hyper answers in the version the
    /// request spoke.
    fn status_of(head: &[u8]) -> u16 {
        let text = std::str::from_utf8(head).unwrap();
        let line = text.lines().next().unwrap();
        assert!(
            line.starts_with("HTTP/1.1 ") || line.starts_with("HTTP/1.0 "),
            "{line:?}"
        );
        line[9..12].parse().unwrap()
    }

    /// The head's header lines as `name: value`, the name lower-cased
    /// since names are case-insensitive and hyper writes them in lower
    /// case, the value as sent.
    fn headers_of(head: &[u8]) -> Vec<String> {
        std::str::from_utf8(head)
            .unwrap()
            .lines()
            .skip(1)
            .filter(|line| !line.is_empty())
            .map(|line| match line.split_once(':') {
                Some((name, value)) => format!("{}: {}", name.to_ascii_lowercase(), value.trim()),
                None => line.to_owned(),
            })
            .collect()
    }

    /// Send `request` and expect the refusal `status`, after which the
    /// proxy closes the connection.
    async fn expect_refusal(proxy: &ConnectProxy, request: &str, status: u16) {
        let mut client = TcpStream::connect(proxy.local_addr()).await.unwrap();
        client.write_all(request.as_bytes()).await.unwrap();
        let head = timeout(WAIT, read_head(&mut client))
            .await
            .unwrap()
            .expect("a refusal carries a status line");
        assert_eq!(
            status_of(&head),
            status,
            "{:?}",
            String::from_utf8_lossy(&head)
        );
        let headers = headers_of(&head);
        assert!(
            headers.contains(&"connection: close".to_owned()),
            "{headers:?}"
        );
        assert!(
            headers.contains(&"content-length: 0".to_owned()),
            "{headers:?}"
        );
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

    /// A hyper server on loopback answering every request with
    /// `handler`, until the task is dropped.
    async fn http_server<F, Fut, B>(handler: F) -> (SocketAddr, JoinHandle<()>)
    where
        F: Fn(Request<Incoming>) -> Fut + Clone + Send + Sync + 'static,
        Fut: Future<Output = Result<Response<B>, Infallible>> + Send + 'static,
        B: Body<Data = Bytes> + Send + 'static,
        B::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
    {
        let listener = TcpListener::bind(loopback()).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            loop {
                let (socket, _) = listener.accept().await.unwrap();
                let handler = handler.clone();
                tokio::spawn(async move {
                    let _ = server::Builder::new()
                        .serve_connection(TokioIo::new(socket), service_fn(handler))
                        .await;
                });
            }
        });
        (addr, task)
    }

    /// A hyper client connection to `addr`, its driver spawned.
    async fn http_client<B>(addr: SocketAddr) -> client::SendRequest<B>
    where
        B: Body + Send + 'static,
        B::Data: Send,
        B::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
    {
        let socket = TcpStream::connect(addr).await.unwrap();
        let (sender, connection) = client::handshake(TokioIo::new(socket)).await.unwrap();
        tokio::spawn(connection);
        sender
    }

    /// What a test server saw of a request.
    struct Seen {
        method: Method,
        uri: Uri,
        headers: HeaderMap,
    }

    /// A server that records each request and answers 201 with a header
    /// and a body of its own.
    async fn recording_server(
        body: &'static str,
    ) -> (SocketAddr, JoinHandle<()>, mpsc::UnboundedReceiver<Seen>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let (addr, task) = http_server(move |request: Request<Incoming>| {
            let tx = tx.clone();
            async move {
                tx.send(Seen {
                    method: request.method().clone(),
                    uri: request.uri().clone(),
                    headers: request.headers().clone(),
                })
                .unwrap();
                let mut response = Response::new(Full::new(Bytes::from_static(body.as_bytes())));
                *response.status_mut() = StatusCode::CREATED;
                response
                    .headers_mut()
                    .insert("x-served-by", HeaderValue::from_static("test server"));
                Ok::<_, Infallible>(response)
            }
        })
        .await;
        (addr, task, rx)
    }

    /// A request body of `chunks` frames of `chunk` bytes each, handed
    /// out one per poll with no length stated, so it travels chunked.
    struct Chunks {
        left: usize,
        chunk: usize,
    }

    impl Body for Chunks {
        type Data = Bytes;
        type Error = Infallible;

        fn poll_frame(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
            if self.left == 0 {
                return Poll::Ready(None);
            }
            self.left -= 1;
            let fill = (self.left % 251) as u8;
            Poll::Ready(Some(Ok(Frame::data(Bytes::from(vec![fill; self.chunk])))))
        }

        fn size_hint(&self) -> SizeHint {
            SizeHint::default()
        }
    }

    #[tokio::test]
    async fn connect_to_a_tunnel_address_goes_through_the_tunnel() {
        let Pair { a, b, .. } = pair().await;
        let mut listener = b.listen(0).unwrap();
        let port = listener.port();
        let proxy = ConnectProxy::bind(vec![a], loopback()).await.unwrap();

        let mut client = send_connect(&proxy, &format!("{B_ADDR}:{port}")).await;
        let (head, server) = timeout(WAIT, async {
            tokio::join!(read_head(&mut client), listener.accept())
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
            tokio::join!(read_head(&mut client), listener.accept())
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
            tokio::join!(read_head(&mut client), listener.accept())
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
            tokio::join!(read_head(&mut client), second_listener.accept())
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
            tokio::join!(read_head(&mut client), first_listener.accept())
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
    async fn an_absolute_form_get_is_forwarded_in_origin_form() {
        let (server, _server_task, mut seen) = recording_server("hello from the server").await;
        let proxy = ConnectProxy::bind(Vec::new(), loopback()).await.unwrap();
        let mut client = http_client::<Full<Bytes>>(proxy.local_addr()).await;

        let request = Request::builder()
            .method(Method::GET)
            .uri(format!("http://{server}/path/to?q=1"))
            // A Host that is not the target's authority: the proxy sends
            // the authority, as RFC 7230 has it.
            .header(header::HOST, "elsewhere.invalid")
            .header("proxy-connection", "keep-alive")
            .header("proxy-authorization", "Basic Zm9vOmJhcg==")
            .header(header::CONNECTION, "x-hop, keep-alive")
            .header("x-hop", "one hop only")
            .header("x-end-to-end", "kept")
            .body(Full::default())
            .unwrap();
        let response = timeout(WAIT, client.send_request(request))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        assert_eq!(response.headers()["x-served-by"], "test server");
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&body[..], b"hello from the server");

        let saw = seen.recv().await.unwrap();
        assert_eq!(saw.method, Method::GET);
        assert_eq!(saw.uri.to_string(), "/path/to?q=1");
        assert!(saw.uri.scheme().is_none() && saw.uri.authority().is_none());
        assert_eq!(saw.headers[header::HOST], server.to_string());
        assert_eq!(saw.headers["x-end-to-end"], "kept");
        for hop in [
            "proxy-connection",
            "proxy-authorization",
            "x-hop",
            "keep-alive",
        ] {
            assert!(!saw.headers.contains_key(hop), "{hop} crossed the hop");
        }
    }

    #[tokio::test]
    async fn two_requests_on_one_connection_reach_their_own_servers() {
        let (first, _first_task, first_seen) = recording_server("first").await;
        let (second, _second_task, second_seen) = recording_server("second").await;
        let servers = [first, second];
        let mut seen = [first_seen, second_seen];
        let proxy = ConnectProxy::bind(Vec::new(), loopback()).await.unwrap();
        let mut client = http_client::<Full<Bytes>>(proxy.local_addr()).await;

        for (which, body) in [(0, "first"), (1, "second"), (0, "first")] {
            let server = servers[which];
            let request = Request::builder()
                .uri(format!("http://{server}/{body}"))
                .body(Full::default())
                .unwrap();
            let response = timeout(WAIT, client.send_request(request))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(response.status(), StatusCode::CREATED);
            let got = response.into_body().collect().await.unwrap().to_bytes();
            assert_eq!(std::str::from_utf8(&got).unwrap(), body);
            let saw = seen[which].recv().await.unwrap();
            assert_eq!(saw.uri.path(), format!("/{body}"));
            assert_eq!(saw.headers[header::HOST], server.to_string());
        }
        assert!(
            client.is_ready(),
            "the client connection to the proxy is still open"
        );
    }

    #[tokio::test]
    async fn a_streamed_post_body_round_trips() {
        let (echo, _echo_task) = http_server(|request: Request<Incoming>| async move {
            assert_eq!(request.method(), Method::POST);
            Ok::<_, Infallible>(Response::new(request.into_body()))
        })
        .await;
        let proxy = ConnectProxy::bind(Vec::new(), loopback()).await.unwrap();
        let mut client = http_client::<Chunks>(proxy.local_addr()).await;

        let chunks = 256;
        let chunk = 4096;
        let request = Request::builder()
            .method(Method::POST)
            .uri(format!("http://{echo}/upload"))
            .body(Chunks {
                left: chunks,
                chunk,
            })
            .unwrap();
        let response = timeout(WAIT, client.send_request(request))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = timeout(WAIT, response.into_body().collect())
            .await
            .unwrap()
            .unwrap()
            .to_bytes();
        assert_eq!(body.len(), chunks * chunk);
        let expected: Vec<u8> = (0..chunks)
            .flat_map(|i| std::iter::repeat_n(((chunks - 1 - i) % 251) as u8, chunk))
            .collect();
        assert!(body[..] == expected[..], "the echoed body differs");
    }

    /// An absolute-form upgrade with `scheme` in the request target, as a
    /// browser writes one to a proxy, bridged to a server that answers the
    /// handshake by hand.
    async fn upgrade_through_proxy(scheme: &str) {
        let listener = TcpListener::bind(loopback()).await.unwrap();
        let server_at = listener.local_addr().unwrap();
        let proxy = ConnectProxy::bind(Vec::new(), loopback()).await.unwrap();
        let mut client = TcpStream::connect(proxy.local_addr()).await.unwrap();
        let request = format!(
            "GET {scheme}://{server_at}/ws HTTP/1.1\r\nHost: {server_at}\r\nConnection: Upgrade\r\n\
             Upgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
             Sec-WebSocket-Version: 13\r\n\r\n"
        );
        client.write_all(request.as_bytes()).await.unwrap();

        // The server answers the handshake by hand: a 101 and then bytes.
        let (mut server, _) = timeout(WAIT, listener.accept()).await.unwrap().unwrap();
        let head = timeout(WAIT, read_head(&mut server))
            .await
            .unwrap()
            .unwrap();
        let text = String::from_utf8(head).unwrap();
        assert!(text.starts_with("GET /ws HTTP/1.1\r\n"), "{text:?}");
        let headers = headers_of(text.as_bytes());
        assert!(
            headers.contains(&"upgrade: websocket".to_owned()),
            "{headers:?}"
        );
        assert!(
            headers.contains(&"connection: upgrade".to_owned()),
            "{headers:?}"
        );
        assert!(
            headers.contains(&"sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==".to_owned()),
            "{headers:?}"
        );
        server
            .write_all(
                b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
                  Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n",
            )
            .await
            .unwrap();

        let head = timeout(WAIT, read_head(&mut client))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(status_of(&head), 101);
        let headers = headers_of(&head);
        assert!(
            headers.contains(&"upgrade: websocket".to_owned()),
            "{headers:?}"
        );
        assert!(
            headers.contains(&"connection: upgrade".to_owned()),
            "{headers:?}"
        );
        assert!(
            headers.contains(&"sec-websocket-accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=".to_owned()),
            "{headers:?}"
        );
        exchange(client, server).await;
    }

    #[tokio::test]
    async fn an_upgrade_is_bridged_end_to_end() {
        upgrade_through_proxy("http").await;
    }

    /// WebKitGTK writes a WebSocket upgrade to a plain origin with the `ws`
    /// scheme in the request target.
    #[tokio::test]
    async fn a_ws_scheme_upgrade_is_bridged_end_to_end() {
        upgrade_through_proxy("ws").await;
    }

    #[tokio::test]
    async fn an_absolute_form_request_to_a_tunnel_address_goes_through_the_tunnel() {
        let Pair { a, b, .. } = pair().await;
        let mut listener = b.listen(0).unwrap();
        let port = listener.port();
        let proxy = ConnectProxy::bind(vec![a], loopback()).await.unwrap();
        let mut client = TcpStream::connect(proxy.local_addr()).await.unwrap();
        let request =
            format!("GET http://{B_ADDR}:{port}/hello HTTP/1.1\r\nHost: {B_ADDR}:{port}\r\n\r\n");
        client.write_all(request.as_bytes()).await.unwrap();

        // The far end answers a minimal response by hand.
        let mut server = timeout(WAIT, listener.accept()).await.unwrap().unwrap();
        assert_eq!(server.peer_addr().ip(), A_ADDR.parse::<IpAddr>().unwrap());
        let head = timeout(WAIT, read_head(&mut server))
            .await
            .unwrap()
            .unwrap();
        let text = String::from_utf8(head).unwrap();
        assert!(text.starts_with("GET /hello HTTP/1.1\r\n"), "{text:?}");
        assert!(
            headers_of(text.as_bytes()).contains(&format!("host: {B_ADDR}:{port}")),
            "{text:?}"
        );
        server
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello")
            .await
            .unwrap();

        let head = timeout(WAIT, read_head(&mut client))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(status_of(&head), 200);
        assert!(
            headers_of(&head).contains(&"content-length: 5".to_owned()),
            "{:?}",
            String::from_utf8_lossy(&head)
        );
        let mut body = [0u8; 5];
        timeout(WAIT, client.read_exact(&mut body))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&body, b"hello");
    }

    #[tokio::test]
    async fn origin_form_and_other_schemes_are_refused_with_400() {
        let proxy = ConnectProxy::bind(Vec::new(), loopback()).await.unwrap();
        for request in [
            "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
            "POST /api HTTP/1.1\r\nHost: 127.0.0.1:1\r\nContent-Length: 0\r\n\r\n",
            "GET https://127.0.0.1:1/ HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n",
            "GET ftp://127.0.0.1:1/ HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n",
            "GET wss://127.0.0.1:1/ HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n",
            "GET http://127.0.0.1:0/ HTTP/1.1\r\nHost: 127.0.0.1:0\r\n\r\n",
            "GET http://127.0.0.1:http/ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
            "GET http://::1:1/ HTTP/1.1\r\nHost: [::1]:1\r\n\r\n",
            "GET http://user@127.0.0.1:1/ HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n",
            "OPTIONS * HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
        ] {
            expect_refusal(&proxy, request, 400).await;
        }
    }

    #[tokio::test]
    async fn a_forward_to_a_refused_port_answers_502() {
        let proxy = ConnectProxy::bind(Vec::new(), loopback()).await.unwrap();
        let port = {
            let listener = TcpListener::bind(loopback()).await.unwrap();
            listener.local_addr().unwrap().port()
        };
        expect_refusal(
            &proxy,
            &format!("GET http://127.0.0.1:{port}/ HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n"),
            502,
        )
        .await;
    }

    #[tokio::test]
    async fn a_destination_that_closes_before_answering_gives_502() {
        let listener = TcpListener::bind(loopback()).await.unwrap();
        let server_at = listener.local_addr().unwrap();
        let closer = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            drop(socket);
        });
        let proxy = ConnectProxy::bind(Vec::new(), loopback()).await.unwrap();
        expect_refusal(
            &proxy,
            &format!("GET http://{server_at}/ HTTP/1.1\r\nHost: {server_at}\r\n\r\n"),
            502,
        )
        .await;
        closer.await.unwrap();
    }

    #[tokio::test]
    async fn bytes_sent_with_a_connect_head_reach_the_destination() {
        let listener = TcpListener::bind(loopback()).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let proxy = ConnectProxy::bind(Vec::new(), loopback()).await.unwrap();
        let mut client = TcpStream::connect(proxy.local_addr()).await.unwrap();
        // A client that does not wait for the 200 before it speaks to the
        // destination; the bytes sit in hyper's buffer until the splice.
        let request =
            format!("CONNECT 127.0.0.1:{port} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\nearly");
        client.write_all(request.as_bytes()).await.unwrap();
        let (head, server) = timeout(WAIT, async {
            tokio::join!(read_head(&mut client), listener.accept())
        })
        .await
        .unwrap();
        assert_eq!(status_of(&head.unwrap()), 200);
        let (mut server, _) = server.unwrap();
        let mut early = [0u8; 5];
        timeout(WAIT, server.read_exact(&mut early))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&early, b"early");
        exchange(client, server).await;
    }

    #[tokio::test]
    async fn a_malformed_request_is_refused_with_400() {
        let proxy = ConnectProxy::bind(Vec::new(), loopback()).await.unwrap();
        // A bare IPv6 literal, no port, port 0, an alphabetic port, a
        // version the proxy does not speak, and a non-name host.
        for request in [
            "CONNECT ::1:443 HTTP/1.1\r\n\r\n",
            "CONNECT 127.0.0.1 HTTP/1.1\r\n\r\n",
            "CONNECT 127.0.0.1:0 HTTP/1.1\r\n\r\n",
            "CONNECT 127.0.0.1:https HTTP/1.1\r\n\r\n",
            "CONNECT 127.0.0.1:443 HTTP/2.0\r\n\r\n",
            "CONNECT a/b:443 HTTP/1.1\r\n\r\n",
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
            if let Some(head) = read_head(&mut client).await {
                assert_eq!(status_of(&head), 431);
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
        let started = std::time::Instant::now();
        expect_refusal(
            &proxy,
            &format!("CONNECT 127.0.0.1:{port} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n"),
            502,
        )
        .await;
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    /// A socket bound but never read by its peer leaves the handshake dark.
    async fn silent_tunnel() -> (Tunnel, UdpSocket) {
        let a_key = StaticSecret::random_from_rng(OsRng);
        let b_key = StaticSecret::random_from_rng(OsRng);
        let a_udp = UdpSocket::bind(loopback()).await.unwrap();
        let silent = UdpSocket::bind(loopback()).await.unwrap();
        let at = silent.local_addr().unwrap();
        let a = Tunnel::start_on(
            config(a_key, PublicKey::from(&b_key), A_ADDR, B_ADDR, at),
            a_udp,
            at,
        )
        .unwrap();
        (a, silent)
    }

    #[tokio::test]
    async fn a_tunnel_without_a_session_refuses_connect_and_forward_after_three_seconds() {
        let (a, _silent) = silent_tunnel().await;
        let proxy = ConnectProxy::bind(vec![a], loopback()).await.unwrap();
        for request in [
            format!("CONNECT {B_ADDR}:80 HTTP/1.1\r\nHost: {B_ADDR}:80\r\n\r\n"),
            format!("GET http://{B_ADDR}:80/ HTTP/1.1\r\nHost: {B_ADDR}:80\r\n\r\n"),
        ] {
            let started = std::time::Instant::now();
            let mut client = TcpStream::connect(proxy.local_addr()).await.unwrap();
            client.write_all(request.as_bytes()).await.unwrap();
            let head = timeout(Duration::from_secs(5), read_head(&mut client))
                .await
                .expect("a dark tunnel is refused before the outer deadline")
                .unwrap();
            assert_eq!(status_of(&head), 502);
            assert!(started.elapsed() >= Duration::from_secs(3) - TICK);
            assert!(started.elapsed() < Duration::from_secs(5));
        }
    }

    #[tokio::test]
    async fn a_session_established_during_the_wait_connects() {
        let a_key = StaticSecret::random_from_rng(OsRng);
        let b_key = StaticSecret::random_from_rng(OsRng);
        let a_pub = PublicKey::from(&a_key);
        let b_pub = PublicKey::from(&b_key);
        let a_udp = UdpSocket::bind(loopback()).await.unwrap();
        let b_udp = UdpSocket::bind(loopback()).await.unwrap();
        let a_at = a_udp.local_addr().unwrap();
        let b_at = b_udp.local_addr().unwrap();
        let a = Tunnel::start_on(config(a_key, b_pub, A_ADDR, B_ADDR, b_at), a_udp, b_at).unwrap();
        let proxy = ConnectProxy::bind(vec![a], loopback()).await.unwrap();
        let delayed = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let b =
                Tunnel::start_on(config(b_key, a_pub, B_ADDR, A_ADDR, a_at), b_udp, a_at).unwrap();
            let mut listener = b.listen(80).unwrap();
            (b, listener.accept().await.unwrap())
        });
        let mut client = send_connect(&proxy, &format!("{B_ADDR}:80")).await;
        let (head, joined) = timeout(WAIT, async {
            tokio::join!(read_head(&mut client), delayed)
        })
        .await
        .unwrap();
        assert_eq!(status_of(&head.unwrap()), 200);
        let (_b, server) = joined.unwrap();
        exchange(client, server).await;
    }

    #[tokio::test]
    async fn a_new_session_keeps_a_pending_connect_past_the_session_deadline() {
        const THIRD_ADDR: &str = "10.7.0.3";
        let a_key = StaticSecret::random_from_rng(OsRng);
        let b_key = StaticSecret::random_from_rng(OsRng);
        let a_pub = PublicKey::from(&a_key);
        let b_pub = PublicKey::from(&b_key);
        let a_udp = UdpSocket::bind(loopback()).await.unwrap();
        let b_udp = UdpSocket::bind(loopback()).await.unwrap();
        let a_at = a_udp.local_addr().unwrap();
        let b_at = b_udp.local_addr().unwrap();
        let mut a_config = config(a_key, b_pub, A_ADDR, B_ADDR, b_at);
        a_config.peer.allowed_ips.push(cidr(THIRD_ADDR));
        let a = Tunnel::start_on(a_config, a_udp, b_at).unwrap();
        let status = a.clone();
        let proxy = ConnectProxy::bind(vec![a], loopback()).await.unwrap();
        let delayed = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(1)).await;
            Tunnel::start_on(config(b_key, a_pub, B_ADDR, A_ADDR, a_at), b_udp, a_at).unwrap()
        });
        let mut client = send_connect(&proxy, &format!("{THIRD_ADDR}:80")).await;
        let b = delayed.await.unwrap();
        // B discards a SYN for an address it does not own. Its handshake
        // still completes, so the second status read must keep this TCP
        // connect pending under the outer deadline.
        assert!(
            timeout(Duration::from_millis(4500), read_head(&mut client))
                .await
                .is_err(),
            "a live tunnel must not be refused at the session deadline"
        );
        assert!(matches!(
            status.status().handshake,
            crate::HandshakeState::Live(_)
        ));
        drop(client);
        drop(b);
    }

    #[tokio::test]
    async fn a_lost_session_is_refused_after_three_seconds() {
        let events = ProxyEvents::default();
        let dispatch = tracing::Dispatch::new(events.clone());
        let _second = tracing::Dispatch::new(ProxyEvents::default());
        let _subscriber = tracing::dispatcher::set_default(&dispatch);
        let _clock = crate::clock::test_offset_guard();
        let Pair { a, b, .. } = pair().await;
        let mut listener = b.listen(80).unwrap();
        let connecting = tokio::spawn({
            let a = a.clone();
            async move { a.connect(b_port(80)).await.unwrap() }
        });
        let mut server = timeout(WAIT, listener.accept()).await.unwrap().unwrap();
        let mut client = timeout(WAIT, connecting).await.unwrap().unwrap();
        client.write_all(b"ping").await.unwrap();
        let mut bytes = [0; 4];
        timeout(WAIT, server.read_exact(&mut bytes))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&bytes, b"ping");
        drop(client);
        drop(server);
        drop(listener);
        drop(b);
        crate::clock::advance(Duration::from_secs(181));
        let lost = timeout(WAIT, async {
            loop {
                let status = a.status();
                if let crate::HandshakeState::Lost(age) = status.handshake {
                    break age;
                }
                tokio::time::sleep(TICK).await;
            }
        })
        .await
        .expect("the core drops an expired session");
        assert!(lost >= Duration::from_secs(180));
        let proxy = ConnectProxy::bind(vec![a], loopback()).await.unwrap();
        let started = std::time::Instant::now();
        let mut client = send_connect(&proxy, &format!("{B_ADDR}:80")).await;
        let head = timeout(Duration::from_secs(5), read_head(&mut client))
            .await
            .expect("a lost tunnel is refused before the outer deadline")
            .unwrap();
        assert_eq!(status_of(&head), 502);
        assert!(started.elapsed() >= Duration::from_secs(3) - TICK);
        assert!(started.elapsed() < Duration::from_secs(5));
        let lines = events.0.lock();
        let refusals: Vec<_> = lines
            .iter()
            .filter(|fields| {
                fields.iter().any(|(key, value)| {
                    key == "message"
                        && value
                            .contains("proxy refused a connection through a tunnel with no session")
                })
            })
            .collect();
        assert_eq!(refusals.len(), 1, "{lines:?}");
        for (key, expected) in [
            ("event_target", "chan_wireguard::proxy"),
            ("target", B_ADDR),
            ("route", "tunnel"),
            ("handshake", "Lost("),
        ] {
            assert!(
                refusals[0]
                    .iter()
                    .any(|(field, value)| field == key && value.contains(expected)),
                "{key}: {:?}",
                refusals[0]
            );
        }
        let age = refusals[0]
            .iter()
            .find(|(key, _)| key == "handshake")
            .unwrap()
            .1
            .split_once("Lost(")
            .unwrap()
            .1
            .split_once('s')
            .unwrap()
            .0
            .parse::<f64>()
            .unwrap();
        assert!(age >= 180.0, "{age}");
    }

    #[tokio::test]
    async fn a_mapped_name_without_a_session_gets_the_same_refusal() {
        let (a, _silent) = silent_tunnel().await;
        let proxy = ConnectProxy::bind_routed(
            vec![(
                "gw".into(),
                mapped(a, vec![host("gateway.chan.invalid", &[B_ADDR])]),
            )],
            loopback(),
        )
        .await
        .unwrap();
        let started = std::time::Instant::now();
        let mut client = send_connect(&proxy, "gateway.chan.invalid:80").await;
        let head = timeout(Duration::from_secs(5), read_head(&mut client))
            .await
            .expect("a mapped dark tunnel is refused before the outer deadline")
            .unwrap();
        assert_eq!(status_of(&head), 502);
        assert!(started.elapsed() >= SESSION_TIMEOUT - TICK);
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

    fn route(tunnel: Tunnel) -> ProxyRoute {
        ProxyRoute {
            tunnel,
            hosts: Vec::new(),
        }
    }

    fn mapped(tunnel: Tunnel, hosts: Vec<HostRoute>) -> ProxyRoute {
        ProxyRoute { tunnel, hosts }
    }

    fn host(name: &str, addresses: &[&str]) -> HostRoute {
        HostRoute {
            name: name.to_owned(),
            addresses: addresses.iter().map(|a| a.parse().unwrap()).collect(),
        }
    }

    /// CONNECT `target` and expect the 200 first, then the tunnel's
    /// listener to hold the connection, from A's tunnel address.
    async fn through_tunnel(proxy: &ConnectProxy, target: &str, listener: &mut crate::Listener) {
        let mut client = send_connect(proxy, target).await;
        let head = timeout(WAIT, read_head(&mut client))
            .await
            .unwrap()
            .expect("a response head");
        assert_eq!(status_of(&head), 200, "CONNECT {target}");
        let server = timeout(WAIT, listener.accept()).await.unwrap().unwrap();
        assert_eq!(
            server.peer_addr().ip(),
            A_ADDR.parse::<IpAddr>().unwrap(),
            "CONNECT {target}"
        );
        exchange(client, server).await;
    }

    // The mapped names below are under `.invalid`, which never resolves
    // (RFC 2606): a request for one that reaches the peer was not looked
    // up, and one that takes the resolver's path is refused with 502.

    #[tokio::test]
    async fn a_mapped_name_goes_through_its_tunnel_without_a_lookup() {
        let Pair { a, b, .. } = pair().await;
        let mut listener = b.listen(0).unwrap();
        let port = listener.port();
        let proxy = ConnectProxy::bind_routed(
            vec![(
                "gw".into(),
                mapped(a, vec![host("gateway.chan.invalid", &[B_ADDR])]),
            )],
            loopback(),
        )
        .await
        .unwrap();
        for name in ["gateway.chan.invalid", "Gateway.CHAN.Invalid"] {
            through_tunnel(&proxy, &format!("{name}:{port}"), &mut listener).await;
        }
    }

    #[tokio::test]
    async fn a_wildcard_entry_matches_every_label_depth_below_it() {
        let Pair { a, b, .. } = pair().await;
        let mut listener = b.listen(0).unwrap();
        let port = listener.port();
        let proxy = ConnectProxy::bind_routed(
            vec![(
                "gw".into(),
                mapped(a, vec![host("*.proxy.chan.invalid", &[B_ADDR])]),
            )],
            loopback(),
        )
        .await
        .unwrap();
        for name in [
            "alice--x1.proxy.chan.invalid",
            "a.b.c.proxy.chan.invalid",
            "Alice.PROXY.chan.invalid",
        ] {
            through_tunnel(&proxy, &format!("{name}:{port}"), &mut listener).await;
        }
        // The bare suffix, a name that only ends in the suffix's letters and
        // names with an empty label are not under the wildcard: they take
        // the resolver's path, which `.invalid` fails.
        for name in [
            "proxy.chan.invalid",
            "xproxy.chan.invalid",
            ".proxy.chan.invalid",
            "a..proxy.chan.invalid",
        ] {
            expect_refusal(
                &proxy,
                &format!("CONNECT {name}:{port} HTTP/1.1\r\n\r\n"),
                502,
            )
            .await;
        }
    }

    #[tokio::test]
    async fn an_unmapped_name_still_resolves_on_the_host() {
        let Pair { a, .. } = pair().await;
        let listener = TcpListener::bind(loopback()).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let proxy = ConnectProxy::bind_routed(
            vec![(
                "gw".into(),
                mapped(a, vec![host("gateway.chan.invalid", &[B_ADDR])]),
            )],
            loopback(),
        )
        .await
        .unwrap();
        // `localhost` is in no map: it is resolved on the host and, being
        // outside every route's AllowedIPs, connected directly.
        let mut client = send_connect(&proxy, &format!("localhost:{port}")).await;
        let (head, server) = timeout(WAIT, async {
            tokio::join!(read_head(&mut client), listener.accept())
        })
        .await
        .unwrap();
        assert_eq!(status_of(&head.unwrap()), 200);
        let (server, from) = server.unwrap();
        assert!(from.ip().is_loopback(), "{from}");
        exchange(client, server).await;
    }

    #[tokio::test]
    async fn bind_routed_refuses_an_address_outside_allowed_ips() {
        let Pair { a, b, .. } = pair().await;
        let outside = || {
            mapped(
                a.clone(),
                vec![host("gateway.chan.invalid", &[B_ADDR, "10.9.9.9"])],
            )
        };
        let err = ConnectProxy::bind_routed(vec![("gw".into(), outside())], loopback())
            .await
            .unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput, "{err}");
        assert!(err.to_string().contains("10.9.9.9"), "{err}");

        let proxy = ConnectProxy::bind_routed(vec![("gw".into(), route(a.clone()))], loopback())
            .await
            .unwrap();
        let err = proxy.add_route("other", outside()).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput, "{err}");
        let err = proxy.replace_route("gw", outside()).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput, "{err}");
        assert_eq!(proxy.routes(), 1);
        assert!(
            !proxy.remove_route("other"),
            "a refused add leaves no route"
        );

        // A malformed name is refused the same way, so no entry can stand
        // that no request could match.
        for name in [
            "",
            "*",
            "*.",
            "*chan.invalid",
            "*.*.chan.invalid",
            "gateway.*.invalid",
            "gateway..chan.invalid",
            ".chan.invalid",
            "chan.invalid.",
            "gate way.chan.invalid",
            "gate/way.chan.invalid",
        ] {
            let err = proxy
                .add_route("bad", mapped(a.clone(), vec![host(name, &[B_ADDR])]))
                .unwrap_err();
            assert_eq!(err.kind(), io::ErrorKind::InvalidInput, "{name:?}: {err}");
        }
        assert_eq!(proxy.routes(), 1);

        // The control: exact and wildcard entries inside AllowedIPs are
        // taken.
        proxy
            .add_route(
                "good",
                mapped(
                    b,
                    vec![
                        host("gateway.chan.invalid", &[A_ADDR]),
                        host("*.proxy.chan.invalid", &[A_ADDR]),
                    ],
                ),
            )
            .unwrap();
        assert_eq!(proxy.routes(), 2);
    }

    #[tokio::test]
    async fn a_mapped_name_takes_the_first_address_of_a_family_its_tunnel_has() {
        // A side routes an IPv6 prefix too but holds only an IPv4 address,
        // so a mapped IPv6 address is inside AllowedIPs and of a family A
        // has no address of.
        let a_key = StaticSecret::random_from_rng(OsRng);
        let b_key = StaticSecret::random_from_rng(OsRng);
        let a_pub = PublicKey::from(&a_key);
        let b_pub = PublicKey::from(&b_key);
        let a_udp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let b_udp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let a_at = a_udp.local_addr().unwrap();
        let b_at = b_udp.local_addr().unwrap();
        let mut a_config = config(a_key, b_pub, A_ADDR, B_ADDR, b_at);
        a_config.peer.allowed_ips.push(crate::config::Cidr {
            addr: "fd00:7::2".parse().unwrap(),
            prefix: 128,
        });
        let a = Tunnel::start_on(a_config, a_udp, b_at).unwrap();
        let b = Tunnel::start_on(config(b_key, a_pub, B_ADDR, A_ADDR, a_at), b_udp, a_at).unwrap();
        let mut listener = b.listen(0).unwrap();
        let port = listener.port();
        let host_listener = TcpListener::bind(loopback()).await.unwrap();
        let host_port = host_listener.local_addr().unwrap().port();
        let proxy = ConnectProxy::bind_routed(
            vec![(
                "gw".into(),
                mapped(
                    a,
                    vec![
                        host("both.chan.invalid", &["fd00:7::2", B_ADDR]),
                        host("localhost", &["fd00:7::2"]),
                    ],
                ),
            )],
            loopback(),
        )
        .await
        .unwrap();

        // The IPv6 address is passed over for the IPv4 one after it.
        through_tunnel(&proxy, &format!("both.chan.invalid:{port}"), &mut listener).await;

        // With no address of a family the tunnel has, a mapped name is
        // refused. `localhost` would resolve on the host and reach the
        // listener there, so the 502 also shows it was never looked up.
        expect_refusal(
            &proxy,
            &format!("CONNECT localhost:{host_port} HTTP/1.1\r\n\r\n"),
            502,
        )
        .await;
        assert!(
            timeout(2 * TICK, host_listener.accept()).await.is_err(),
            "the mapped name never reached the host's own listener"
        );
    }

    /// A port on the host's loopback that nothing listens on, so a
    /// connection there taking the direct path is refused at once.
    async fn released_port() -> u16 {
        let listener = TcpListener::bind(loopback()).await.unwrap();
        listener.local_addr().unwrap().port()
    }

    /// A CONNECT to `127.0.0.1:port`, as a request a refusal is read from.
    fn connect_request(port: u16) -> String {
        format!("CONNECT 127.0.0.1:{port} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n")
    }

    // The peer's tunnel address in the live-table tests is 127.0.0.1, so a
    // destination the table does not route takes the direct path to the
    // host's own loopback, where nothing listens on the port: the refusal
    // is immediate and the same on every host, where a private address
    // with no route could hang until the connect deadline.

    #[tokio::test]
    async fn a_route_added_after_bind_carries_the_next_connect() {
        let Pair { a, b, .. } = pair_at(A_ADDR, "127.0.0.1").await;
        let port = released_port().await;
        let mut listener = b.listen(port).unwrap();
        let proxy = ConnectProxy::bind_routed(Vec::new(), loopback())
            .await
            .unwrap();
        assert_eq!(proxy.routes(), 0);
        // With no route the destination is connected directly, and the
        // host refuses it.
        expect_refusal(&proxy, &connect_request(port), 502).await;

        proxy.add_route("gw", route(a.clone())).unwrap();
        assert_eq!(proxy.routes(), 1);
        let mut client = send_connect(&proxy, &format!("127.0.0.1:{port}")).await;
        let (head, server) = timeout(WAIT, async {
            tokio::join!(read_head(&mut client), listener.accept())
        })
        .await
        .unwrap();
        assert_eq!(status_of(&head.unwrap()), 200);
        let server = server.unwrap();
        assert_eq!(server.peer_addr().ip(), A_ADDR.parse::<IpAddr>().unwrap());
        exchange(client, server).await;

        // A held id is refused and the table stands.
        let err = proxy.add_route("gw", route(a.clone())).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists, "{err}");
        assert_eq!(proxy.routes(), 1);
        let err = ConnectProxy::bind_routed(
            vec![("gw".into(), route(a.clone())), ("gw".into(), route(a))],
            loopback(),
        )
        .await
        .unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists, "{err}");
    }

    #[tokio::test]
    async fn a_replaced_route_carries_new_connects_and_old_splices_end_with_their_tunnel() {
        // Two peers at the same tunnel address, told apart by the address
        // each client side connects from.
        let first = pair_at("10.7.0.1", B_ADDR).await;
        let second = pair_at("10.7.0.3", B_ADDR).await;
        let mut first_listener = first.b.listen(0).unwrap();
        let mut second_listener = second.b.listen(0).unwrap();
        let proxy =
            ConnectProxy::bind_routed(vec![("gw".into(), route(first.a.clone()))], loopback())
                .await
                .unwrap();

        let target = format!("{B_ADDR}:{}", first_listener.port());
        let mut old = send_connect(&proxy, &target).await;
        let (head, server) = timeout(WAIT, async {
            tokio::join!(read_head(&mut old), first_listener.accept())
        })
        .await
        .unwrap();
        assert_eq!(status_of(&head.unwrap()), 200);
        let mut old_server = server.unwrap();
        assert_eq!(
            old_server.peer_addr().ip(),
            "10.7.0.1".parse::<IpAddr>().unwrap()
        );

        proxy.replace_route("gw", route(second.a.clone())).unwrap();
        assert_eq!(proxy.routes(), 1);
        let target = format!("{B_ADDR}:{}", second_listener.port());
        let mut new = send_connect(&proxy, &target).await;
        let (head, server) = timeout(WAIT, async {
            tokio::join!(read_head(&mut new), second_listener.accept())
        })
        .await
        .unwrap();
        assert_eq!(status_of(&head.unwrap()), 200);
        let server = server.unwrap();
        assert_eq!(
            server.peer_addr().ip(),
            "10.7.0.3".parse::<IpAddr>().unwrap()
        );
        exchange(new, server).await;

        // The old splice still moves bytes both ways: the test holds a
        // handle of the first tunnel, so it still runs.
        let mut buf = [0u8; 4];
        old.write_all(b"ping").await.unwrap();
        timeout(WAIT, old_server.read_exact(&mut buf))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&buf, b"ping");
        old_server.write_all(b"pong").await.unwrap();
        timeout(WAIT, old.read_exact(&mut buf))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&buf, b"pong");

        // Its last handle gone, the first tunnel closes its stack, the
        // splice's tunnel side fails and the proxy closes the client. The
        // far end inside the tunnel is told nothing: a closed tunnel sends
        // no reset.
        drop(first.a);
        let mut rest = [0u8; 8];
        assert_eq!(
            timeout(WAIT, old.read(&mut rest)).await.unwrap().unwrap(),
            0,
            "the client sees the splice end with its tunnel"
        );
    }

    #[tokio::test]
    async fn a_removed_route_falls_back_to_the_direct_path() {
        // A tunnel whose endpoint is a probe socket, so every datagram it
        // sends is seen, routing 127.0.0.1.
        let key = StaticSecret::random_from_rng(OsRng);
        let peer = PublicKey::from(&StaticSecret::random_from_rng(OsRng));
        let probe = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let probe_at = probe.local_addr().unwrap();
        let udp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let tunnel = Tunnel::start_on(
            config(key, peer, A_ADDR, "127.0.0.1", probe_at),
            udp,
            probe_at,
        )
        .unwrap();
        let port = released_port().await;
        let proxy =
            ConnectProxy::bind_routed(vec![("gw".into(), route(tunnel.clone()))], loopback())
                .await
                .unwrap();

        assert!(proxy.remove_route("gw"));
        assert!(!proxy.remove_route("gw"), "the id is gone");
        assert_eq!(proxy.routes(), 0);
        expect_refusal(&proxy, &connect_request(port), 502).await;
        tokio::time::sleep(2 * TICK).await;
        let mut buf = [0u8; 256];
        assert!(
            probe.try_recv_from(&mut buf).is_err(),
            "a removed route sends nothing to its peer"
        );

        // The control: routed, the same destination reaches the endpoint,
        // as the handshake initiation that precedes its SYN.
        proxy.add_route("gw", route(tunnel)).unwrap();
        let _pending = send_connect(&proxy, &format!("127.0.0.1:{port}")).await;
        let (len, _) = timeout(WAIT, probe.recv_from(&mut buf))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(len, 148, "a handshake initiation");
        assert_eq!(&buf[..4], &[1, 0, 0, 0]);
    }

    #[tokio::test]
    async fn debug_names_the_live_route_count() {
        let Pair { a, b, .. } = pair().await;
        let proxy = ConnectProxy::bind(vec![a, b.clone()], loopback())
            .await
            .unwrap();
        let text = format!("{proxy:?}");
        assert!(text.contains(&proxy.local_addr().to_string()), "{text}");
        assert!(text.contains("routes: 2"), "{text}");
        // `bind` names its routes by their index.
        assert!(proxy.remove_route("1"));
        assert!(format!("{proxy:?}").contains("routes: 1"), "{proxy:?}");
        proxy.add_route("b", route(b)).unwrap();
        assert!(format!("{proxy:?}").contains("routes: 2"), "{proxy:?}");
    }

    #[tokio::test]
    async fn dropping_the_proxy_ends_its_connections() {
        let listener = TcpListener::bind(loopback()).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let proxy = ConnectProxy::bind(Vec::new(), loopback()).await.unwrap();
        let at = proxy.local_addr();
        let mut client = send_connect(&proxy, &format!("127.0.0.1:{port}")).await;
        let (head, server) = timeout(WAIT, async {
            tokio::join!(read_head(&mut client), listener.accept())
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
