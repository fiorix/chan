//! The tunnel: UDP sockets, one protocol peer and one TCP/IP stack,
//! driven by one task.
//!
//! The driver owns the sockets and the network side of the loop: it polls
//! the stack, seals every packet the stack emitted and sends it to the
//! endpoint, and opens every datagram that arrives into the stack. The
//! streams never see a packet; they share the stack under its lock and
//! kick the driver when they queue bytes. The protocol core and the
//! current endpoint sit under a second lock, held for one call at a time,
//! so the status read never waits on a poll.

use std::collections::HashSet;
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use rand_core::{OsRng, RngCore};
use tokio::net::UdpSocket;
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::clock::Instant;
use crate::config::{Cidr, Config, Endpoint};
use crate::noise::errors::WireGuardError;
use crate::noise::REKEY_TIMEOUT;
use crate::noise::{Tunn, TunnResult};
use crate::resolver::{self, Resolver};
use crate::stack::{Shared, Stack};
use crate::stream::{Connecting, Listener, Stream, BACKLOG};

/// The MTU when the configuration names none: 1500 less the IPv4, UDP
/// and WireGuard headers, the value wg-quick picks.
const DEFAULT_MTU: u16 = 1420;

/// The timer tick of the protocol core; it expects about this rate.
pub(crate) const TICK: Duration = Duration::from_millis(250);

/// The largest UDP payload; a datagram is never longer.
const MAX_DATAGRAM: usize = 65535;

/// The sealing overhead of a transport message, which the work buffer
/// must hold beyond the packet.
const SEAL_OVERHEAD: usize = 32;

/// Datagrams read in one go after the socket signalled readiness, so a
/// burst is opened before the stack polls once rather than once each.
const RECEIVE_BURST: usize = 32;

/// Asked of the kernel for the tunnel socket's buffers: a window of
/// sealed packets arriving while the driver is busy must fit, and the
/// OS defaults (64 KiB on Windows, about 200 KiB on Linux) do not hold
/// one. The kernel may grant less; the request is best effort.
const SOCKET_BUFFER_HINT: usize = 4 * 1024 * 1024;

/// Whether the tunnel has a usable session, retaining the last handshake's
/// age after the protocol core discards that session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandshakeState {
    /// No handshake has completed.
    Never,
    /// A session is usable; the duration is the age of its handshake.
    Live(Duration),
    /// No session is usable; the duration is the age of the last handshake.
    Lost(Duration),
}

/// A point in time report on the tunnel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Status {
    /// The session's state and the age of its last completed handshake.
    pub handshake: HandshakeState,
    /// Payload bytes sealed for the peer.
    pub tx_bytes: u64,
    /// Payload bytes opened from the peer.
    pub rx_bytes: u64,
    /// Where datagrams go: the resolved configuration endpoint, or the
    /// source of the peer's latest authenticated datagram.
    /// `None` until an address is resolved or an authenticated peer arrives.
    pub endpoint: Option<SocketAddr>,
    /// Why the latest lookup of the endpoint name, or the socket bind for
    /// its answer, failed; cleared by the next usable answer. While it is
    /// set, initiations still go to `endpoint` when there is one.
    pub resolution_error: Option<String>,
    /// The latest lookup timed out and still holds the OS call, so no
    /// other lookup can start until it returns; `resolution_error` names
    /// the timeout meanwhile.
    pub resolution_stalled: bool,
}

/// A live session keeps its authenticated endpoint; a differing DNS answer
/// gets only a probe. Past 120 s plus three rekey retries, the path is
/// presumed dead and each retry may move to an untried answered address.
/// This matches wireguard-tools' `reresolve-dns.sh` threshold and precedes
/// session rejection at 180 s.
const STALE_HANDSHAKE: Duration = Duration::from_secs(135);

struct Wire {
    tunn: Tunn,
    endpoint: Option<SocketAddr>,
    /// The driver retains the observation instant and age together because
    /// the core drops its handshake stamp when it discards a session.
    last_handshake: Option<(Instant, Duration)>,
}

/// What the driver publishes after each lookup outcome, for `connect` and
/// `status`.
#[derive(Clone, Default)]
struct Resolution {
    error: Option<Arc<io::Error>>,
    /// A timed-out lookup still holds the OS call, so no other outcome
    /// can come until it returns.
    stalled: bool,
}

struct Inner {
    shared: Arc<Shared>,
    wire: Arc<Mutex<Wire>>,
    addresses: Vec<IpAddr>,
    allowed_ips: Vec<Cidr>,
    driver: JoinHandle<()>,
    resolution: watch::Receiver<Resolution>,
}

impl Drop for Inner {
    fn drop(&mut self) {
        self.driver.abort();
        self.shared.stack.lock().shut_down();
    }
}

/// A WireGuard tunnel to one peer, with TCP connections through it.
///
/// Handles are cheap to clone; the driver runs until the last one is
/// dropped, and every stream then fails instead of hanging.
#[derive(Clone)]
pub struct Tunnel {
    inner: Arc<Inner>,
}

impl Tunnel {
    /// Start the driver without resolving the endpoint or waiting for a
    /// handshake. Must run within the tokio runtime that owns the tunnel.
    /// Resolution and UDP binding run in the background; failures are
    /// reported by [`Self::status`] and retried on handshake attempts.
    pub fn start(config: Config) -> io::Result<Tunnel> {
        let resolver = Resolver::new(config.peer.endpoint.clone());
        Self::build(config, Sockets::default(), None, resolver)
    }

    /// Start the driver over a socket the caller bound, towards an
    /// endpoint the caller resolved. The driver still looks the configured
    /// name up on initiations: the caller's endpoint stands as the previous
    /// answer, so it is used while lookups fail and a lookup answering it
    /// is no change. Must be called within a tokio runtime, which the
    /// driver task runs on.
    pub fn start_on(config: Config, socket: UdpSocket, endpoint: SocketAddr) -> io::Result<Tunnel> {
        if socket.local_addr()?.is_ipv4() != endpoint.is_ipv4() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "the socket and the endpoint are of different address families",
            ));
        }
        let resolver = Resolver::new(config.peer.endpoint.clone());
        let mut sockets = Sockets::default();
        sockets.insert(socket)?;
        Self::build(config, sockets, Some(endpoint), resolver)
    }

    fn build(
        config: Config,
        sockets: Sockets,
        endpoint: Option<SocketAddr>,
        resolver: Resolver,
    ) -> io::Result<Tunnel> {
        let mtu = usize::from(config.mtu.unwrap_or(DEFAULT_MTU));
        let stack = Stack::new(&config.addresses, mtu)?;
        let shared = Arc::new(Shared::new(stack));
        let index = OsRng.next_u32() & 0x00ff_ffff;
        let tunn = Tunn::new(
            config.private_key,
            config.peer.public_key,
            config.peer.preshared_key,
            config.peer.persistent_keepalive,
            index,
            None,
        );
        let wire = Arc::new(Mutex::new(Wire {
            tunn,
            endpoint,
            last_handshake: None,
        }));
        let (resolution_tx, resolution) = watch::channel(Resolution::default());
        let driver = Driver {
            shared: shared.clone(),
            wire: wire.clone(),
            sockets,
            endpoint_name: config.peer.endpoint,
            allowed_ips: config.peer.allowed_ips.clone(),
            resolver,
            resolution_tx,
            looked_up_at: None,
            last_adopted: endpoint,
            answers: Vec::new(),
            tried: HashSet::new(),
            initiation: None,
            logged_failure: None,
            logged_session_loss: false,
            transmitted_initiation: false,
            pending_initiation: false,
        };
        let driver = tokio::spawn(driver.run());
        Ok(Tunnel {
            inner: Arc::new(Inner {
                shared,
                wire,
                addresses: config.addresses.iter().map(|c| c.addr).collect(),
                allowed_ips: config.peer.allowed_ips,
                driver,
                resolution,
            }),
        })
    }

    /// Open a TCP connection to `remote` through the tunnel. A destination
    /// outside the peer's allowed IPs is refused as `NetworkUnreachable`
    /// before anything is sent; a reset answers `ConnectionRefused`.
    /// Before any endpoint is known, it waits for a lookup that ends after
    /// it started and fails with that lookup's reason; when a timed-out
    /// lookup still holds the OS call, no such outcome can come, and it
    /// fails at once with the timeout. Other waits are bounded by the
    /// caller. Dropping the future closes the half-open connection.
    pub async fn connect(&self, remote: SocketAddr) -> io::Result<Stream> {
        let inner = &self.inner;
        if !inner.allowed_ips.iter().any(|c| c.contains(remote.ip())) {
            return Err(io::Error::new(
                io::ErrorKind::NetworkUnreachable,
                format!("{} is outside the peer's allowed IPs", remote.ip()),
            ));
        }
        let local = inner
            .addresses
            .iter()
            .copied()
            .find(|a| a.is_ipv4() == remote.is_ipv4())
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::AddrNotAvailable,
                    "the tunnel has no address of the destination's family",
                )
            })?;
        let (handle, local) = {
            let mut stack = inner.shared.stack.lock();
            if stack.closed {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionAborted,
                    "the tunnel is closed",
                ));
            }
            stack.connect(remote, local)?
        };
        inner.shared.kick();
        let connecting = Connecting::new(Stream::new(inner.shared.clone(), handle, local, remote));
        tokio::pin!(connecting);
        // An outcome published before this connect answers an earlier
        // attempt; only a later one, or a stall nothing can end, is ours.
        let mut resolution = inner.resolution.clone();
        let mut current = resolution.borrow_and_update().clone();
        let mut ours = current.stalled;
        loop {
            if ours && inner.wire.lock().endpoint.is_none() {
                if let Some(error) = current.error {
                    return Err(io::Error::new(error.kind(), error.to_string()));
                }
            }
            tokio::select! {
                result = &mut connecting => return result,
                changed = resolution.changed() => {
                    if changed.is_err() {
                        return Err(io::Error::new(io::ErrorKind::ConnectionAborted, "the tunnel is closed"));
                    }
                    current = resolution.borrow_and_update().clone();
                    ours = true;
                }
            }
        }
    }

    /// Listen for connections the peer opens to `port` at any tunnel
    /// address; 0 picks a free port.
    pub fn listen(&self, port: u16) -> io::Result<Listener> {
        let shared = &self.inner.shared;
        let (port, handles) = {
            let mut stack = shared.stack.lock();
            if stack.closed {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionAborted,
                    "the tunnel is closed",
                ));
            }
            stack.listen(port, BACKLOG)?
        };
        Ok(Listener::new(shared.clone(), port, handles))
    }

    /// The tunnel's counters and current endpoint.
    pub fn status(&self) -> Status {
        let wire = self.inner.wire.lock();
        let (last_handshake, tx_bytes, rx_bytes, _, _) = wire.tunn.stats();
        let resolution = self.inner.resolution.borrow();
        let handshake = match wire.last_handshake {
            None => HandshakeState::Never,
            Some((at, age)) => {
                let age = age + at.elapsed();
                if last_handshake.is_some() {
                    HandshakeState::Live(age)
                } else {
                    HandshakeState::Lost(age)
                }
            }
        };
        Status {
            handshake,
            tx_bytes: tx_bytes as u64,
            rx_bytes: rx_bytes as u64,
            endpoint: wire.endpoint,
            resolution_error: resolution.error.as_ref().map(ToString::to_string),
            resolution_stalled: resolution.stalled,
        }
    }

    /// The peer's AllowedIPs: the destinations `connect` carries. A
    /// caller holding several tunnels routes by them.
    pub fn allowed_ips(&self) -> &[Cidr] {
        &self.inner.allowed_ips
    }
}

impl std::fmt::Debug for Tunnel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Tunnel")
            .field("addresses", &self.inner.addresses)
            .field("allowed_ips", &self.inner.allowed_ips)
            .finish()
    }
}

/// A cookie reply authenticates nobody in either direction. The one the
/// core emits answers a handshake message it has not verified yet, and the
/// one it receives is sealed under a key derived from the peer's public key
/// with the on-wire mac1 as associated data, which anyone who saw the
/// initiation can reproduce. Neither moves the endpoint, as in the kernel.
fn is_cookie_reply(datagram: &[u8]) -> bool {
    datagram.len() == 64 && datagram[..4] == [3, 0, 0, 0]
}

fn is_handshake_initiation(datagram: &[u8]) -> bool {
    datagram.len() == 148 && datagram[..4] == [1, 0, 0, 0]
}

/// What a lookup answer did to the endpoint.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Adoption {
    /// The endpoint moved to the answer.
    Moved,
    /// A live session stays where it is; the answer gets an initiation,
    /// and roaming moves the endpoint if the peer answers from there.
    Probe,
}

/// Marks the stack closed when the driver ends for any reason, the
/// handle's abort included, so no stream waits on a poll that never comes.
struct ShutDown(Arc<Shared>);

impl Drop for ShutDown {
    fn drop(&mut self) {
        self.0.stack.lock().shut_down();
    }
}

enum Event {
    Datagram(usize, SocketAddr),
    ReceiveFailed(io::Error),
    Kick,
    Tick,
    StackTimer,
    Resolved(io::Result<Vec<SocketAddr>>),
    ResolveTimeout,
}

#[cfg(test)]
thread_local! {
    /// Makes `Sockets::ensure` fail on this thread, since no real bind of
    /// an ephemeral wildcard port fails on demand.
    static REFUSE_BIND: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[derive(Default)]
struct Sockets {
    v4: Option<UdpSocket>,
    v6: Option<UdpSocket>,
}

impl Sockets {
    fn get(&self, v4: bool) -> Option<&UdpSocket> {
        if v4 {
            self.v4.as_ref()
        } else {
            self.v6.as_ref()
        }
    }

    fn insert(&mut self, socket: UdpSocket) -> io::Result<()> {
        let kernel_socket = socket2::SockRef::from(&socket);
        if let Err(e) = kernel_socket.set_recv_buffer_size(SOCKET_BUFFER_HINT) {
            tracing::debug!(error = %e, "tunnel socket receive buffer left at the default");
        }
        if let Err(e) = kernel_socket.set_send_buffer_size(SOCKET_BUFFER_HINT) {
            tracing::debug!(error = %e, "tunnel socket send buffer left at the default");
        }
        if socket.local_addr()?.is_ipv4() {
            self.v4 = Some(socket)
        } else {
            self.v6 = Some(socket)
        }
        Ok(())
    }

    fn ensure(&mut self, endpoint: SocketAddr) -> io::Result<()> {
        if self.get(endpoint.is_ipv4()).is_some() {
            return Ok(());
        }
        #[cfg(test)]
        if REFUSE_BIND.get() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "refused by the test",
            ));
        }
        let bind: SocketAddr = if endpoint.is_ipv4() {
            (Ipv4Addr::UNSPECIFIED, 0).into()
        } else {
            (Ipv6Addr::UNSPECIFIED, 0).into()
        };
        let socket = socket2::Socket::new(
            socket2::Domain::for_address(bind),
            socket2::Type::DGRAM,
            Some(socket2::Protocol::UDP),
        )?;
        if bind.is_ipv6() {
            socket.set_only_v6(true)?;
        }
        socket.set_nonblocking(true)?;
        socket.bind(&bind.into())?;
        self.insert(UdpSocket::from_std(socket.into())?)
    }

    async fn receive(
        socket: &Option<UdpSocket>,
        buf: &mut [u8],
    ) -> io::Result<(usize, SocketAddr)> {
        match socket {
            Some(socket) => socket.recv_from(buf).await,
            None => std::future::pending().await,
        }
    }
}

struct Driver {
    shared: Arc<Shared>,
    wire: Arc<Mutex<Wire>>,
    sockets: Sockets,
    endpoint_name: Endpoint,
    allowed_ips: Vec<Cidr>,
    resolver: Resolver,
    resolution_tx: watch::Sender<Resolution>,
    /// When the latest lookup ended: an answer, a failure or its deadline.
    looked_up_at: Option<Instant>,
    /// An adopted answer, never a probe: an unchanged record must not
    /// pull a live session back from its authenticated roaming address.
    last_adopted: Option<SocketAddr>,
    answers: Vec<SocketAddr>,
    /// Retained across retries, cleared by a handshake or an expiry.
    tried: HashSet<SocketAddr>,
    initiation: Option<Initiation>,
    /// The failure last logged at warn; a repeat of it logs at debug.
    logged_failure: Option<String>,
    /// A loss logged at warn, cleared only by a completed handshake.
    logged_session_loss: bool,
    /// A held initiation is not evidence that the peer failed to answer.
    transmitted_initiation: bool,
    /// An initiation held for want of an endpoint, generated afresh when
    /// a lookup gives one, so its retry clock starts at transmission.
    pending_initiation: bool,
}

/// The latest core-produced initiation. A retry replaces its bytes, but
/// does not permit another probe while the same handshake is in progress.
struct Initiation {
    bytes: Vec<u8>,
    probed: bool,
    retargeted: bool,
}

impl Driver {
    async fn run(mut self) {
        let _shut_down = ShutDown(self.shared.clone());
        let mut datagram = vec![0u8; MAX_DATAGRAM];
        let mut datagram6 = vec![0u8; MAX_DATAGRAM];
        let mut work = vec![0u8; MAX_DATAGRAM + SEAL_OVERHEAD];
        let mut tick = tokio::time::interval(TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        self.resolver.start();

        loop {
            let (outbound, delay, saturated) = {
                let mut stack = self.shared.stack.lock();
                let delay = stack.poll();
                let saturated = stack.device.outbound_saturated();
                (stack.device.drain_outbound(), delay, saturated)
            };
            for packet in &outbound {
                self.send_packet(packet, &mut work).await;
            }
            if saturated {
                // More is waiting behind the drained batch. Yield first so
                // a reader sharing this thread gets to drain its side.
                tokio::task::yield_now().await;
                continue;
            }

            let stack_timer = async {
                match delay {
                    Some(delay) => tokio::time::sleep(delay).await,
                    None => std::future::pending().await,
                }
            };
            let resolve_deadline = self.resolver.deadline();
            let event = tokio::select! {
                received = Sockets::receive(&self.sockets.v4, &mut datagram) => match received {
                    Ok((len, from)) => Event::Datagram(len, from),
                    Err(e) => Event::ReceiveFailed(e),
                },
                received = Sockets::receive(&self.sockets.v6, &mut datagram6) => match received {
                    Ok((len, from)) => Event::Datagram(len, from),
                    Err(e) => Event::ReceiveFailed(e),
                },
                _ = self.shared.kicked() => Event::Kick,
                _ = tick.tick() => Event::Tick,
                _ = stack_timer => Event::StackTimer,
                result = self.resolver.completed() => Event::Resolved(result),
                _ = resolver::deadline(resolve_deadline) => Event::ResolveTimeout,
            };
            match event {
                Event::Datagram(len, from) => {
                    let datagram = if from.is_ipv4() {
                        &mut datagram
                    } else {
                        &mut datagram6
                    };
                    self.handle_datagram(&datagram[..len], from, &mut work)
                        .await;
                    for _ in 1..RECEIVE_BURST {
                        let Some(socket) = self.sockets.get(from.is_ipv4()) else {
                            break;
                        };
                        match socket.try_recv_from(datagram) {
                            Ok((len, from)) => {
                                self.handle_datagram(&datagram[..len], from, &mut work)
                                    .await;
                            }
                            Err(_) => break,
                        }
                    }
                }
                Event::ReceiveFailed(e) => {
                    // An ICMP unreachable for an earlier send surfaces here
                    // on some platforms; the socket itself is fine.
                    if matches!(
                        e.kind(),
                        io::ErrorKind::ConnectionReset | io::ErrorKind::ConnectionRefused
                    ) {
                        tracing::debug!(error = %e, "tunnel socket receive");
                        continue;
                    }
                    tracing::error!(error = %e, "tunnel socket failed; stopping the driver");
                    return;
                }
                Event::Tick => self.tick(&mut work).await,
                Event::Resolved(result) => self.resolved(result).await,
                Event::ResolveTimeout => {
                    self.resolver.timed_out();
                    let timeout = io::Error::new(io::ErrorKind::TimedOut, "lookup timed out");
                    self.failed(self.unresolved(timeout));
                    self.lookup_ended().await;
                }
                Event::Kick | Event::StackTimer => {}
            }
        }
    }

    /// Seal one IP packet from the stack and send it. Without a session
    /// the core queues the packet and hands back the handshake initiation
    /// instead.
    async fn send_packet(&mut self, packet: &[u8], work: &mut [u8]) {
        let len = {
            let mut wire = self.wire.lock();
            match wire.tunn.encapsulate(packet, work) {
                TunnResult::WriteToNetwork(sealed) => sealed.len(),
                TunnResult::Err(e) => {
                    tracing::debug!(error = %e, "dropping an outgoing packet");
                    return;
                }
                TunnResult::Done
                | TunnResult::WriteToTunnelV4(..)
                | TunnResult::WriteToTunnelV6(..) => return,
            }
        };
        self.transmit(&work[..len]).await;
    }

    async fn handle_datagram(&mut self, datagram: &[u8], from: SocketAddr, work: &mut [u8]) {
        if datagram.is_empty() {
            tracing::trace!(%from, "dropping an empty network datagram");
            return;
        }
        let mut to_network: Vec<Vec<u8>> = Vec::new();
        let mut to_stack: Vec<Vec<u8>> = Vec::new();
        {
            let mut wire = self.wire.lock();
            let previous_age = wire.tunn.time_since_last_handshake();
            let mut authenticated = false;
            let mut drain = false;
            match wire.tunn.decapsulate(Some(from.ip()), datagram, work) {
                TunnResult::Done => authenticated = !is_cookie_reply(datagram),
                TunnResult::Err(e) => {
                    tracing::trace!(error = %e, %from, "dropping a datagram");
                }
                TunnResult::WriteToNetwork(reply) => {
                    authenticated = !is_cookie_reply(reply);
                    to_network.push(reply.to_vec());
                    drain = true;
                }
                TunnResult::WriteToTunnelV4(packet, src) => {
                    authenticated = true;
                    self.accept_packet(&mut to_stack, packet, IpAddr::V4(src));
                }
                TunnResult::WriteToTunnelV6(packet, src) => {
                    authenticated = true;
                    self.accept_packet(&mut to_stack, packet, IpAddr::V6(src));
                }
            }
            // A completed handshake releases the packets queued behind it.
            while drain {
                match wire.tunn.decapsulate(None, &[], work) {
                    TunnResult::WriteToNetwork(sealed) => to_network.push(sealed.to_vec()),
                    _ => drain = false,
                }
            }
            if authenticated {
                if wire.endpoint != Some(from) {
                    tracing::info!(old = ?wire.endpoint, new = %from, "peer endpoint moved");
                    wire.endpoint = Some(from);
                }
                if let Some(age) = wire.tunn.time_since_last_handshake() {
                    if previous_age.is_none_or(|previous| age < previous) {
                        self.initiation = None;
                        self.tried.clear();
                    }
                    wire.last_handshake = Some((Instant::now(), age));
                    if std::mem::take(&mut self.logged_session_loss) {
                        tracing::warn!(
                            endpoint = %self.endpoint_name,
                            address = ?wire.endpoint,
                            "WireGuard session established"
                        );
                    }
                }
                if datagram.len() == 92 && datagram[..4] == [2, 0, 0, 0] {
                    self.pending_initiation = false;
                    if self
                        .initiation
                        .as_ref()
                        .is_some_and(|initiation| datagram[8..12] == initiation.bytes[4..8])
                    {
                        self.initiation = None;
                        self.tried.clear();
                    }
                }
            }
        }
        if !to_stack.is_empty() {
            let mut stack = self.shared.stack.lock();
            for packet in to_stack {
                stack.device.push_inbound(packet);
            }
        }
        for sealed in &to_network {
            self.transmit(sealed).await;
        }
    }

    /// Cryptokey routing on the receive side: a packet the peer sends from
    /// an address outside its allowed IPs is dropped, whatever it says.
    fn accept_packet(&self, to_stack: &mut Vec<Vec<u8>>, packet: &[u8], src: IpAddr) {
        if self.allowed_ips.iter().any(|c| c.contains(src)) {
            to_stack.push(packet.to_vec());
        } else {
            tracing::debug!(%src, "dropping a packet from outside the peer's allowed IPs");
        }
    }

    async fn tick(&mut self, work: &mut [u8]) {
        let (len, expired) = {
            let mut wire = self.wire.lock();
            let was_expired = wire.tunn.is_expired();
            match wire.tunn.update_timers(work) {
                TunnResult::WriteToNetwork(sealed) => (sealed.len(), false),
                TunnResult::Err(WireGuardError::ConnectionExpired) => {
                    // The expired core returns this error on every later tick.
                    if !was_expired {
                        let age = wire.last_handshake.map(|(at, age)| age + at.elapsed());
                        let last_handshake = age.map_or_else(
                            || "never".to_string(),
                            |age| format!("{:.1}s", age.as_secs_f64()),
                        );
                        let message = if wire.last_handshake.is_some() {
                            "WireGuard session lost"
                        } else {
                            "WireGuard session handshake has not completed"
                        };
                        if !self.logged_session_loss
                            && (self.transmitted_initiation || wire.last_handshake.is_some())
                        {
                            tracing::warn!(
                                endpoint = %self.endpoint_name,
                                address = ?wire.endpoint,
                                last_handshake = %last_handshake,
                                "{message}"
                            );
                            self.logged_session_loss = true;
                        } else {
                            tracing::debug!(
                                endpoint = %self.endpoint_name,
                                address = ?wire.endpoint,
                                last_handshake = %last_handshake,
                                "{message}"
                            );
                        }
                    }
                    (0, true)
                }
                TunnResult::Err(e) => {
                    tracing::debug!(error = %e, "timer tick");
                    (0, false)
                }
                TunnResult::Done
                | TunnResult::WriteToTunnelV4(..)
                | TunnResult::WriteToTunnelV6(..) => (0, false),
            }
        };
        if len > 0 {
            self.transmit(&work[..len]).await;
        }
        if expired {
            self.pending_initiation = false;
            self.initiation = None;
            self.tried.clear();
            self.looked_up_at = None;
        } else if self.pending_initiation {
            self.resolver.start();
        }
    }

    fn unresolved(&self, error: io::Error) -> io::Error {
        io::Error::new(
            error.kind(),
            format!("endpoint did not resolve: {}: {error}", self.endpoint_name),
        )
    }

    /// Publish a failure. A lookup fails every few seconds while dials
    /// keep coming, so only a new or changed failure logs at warn. A
    /// timed-out lookup is not retried: it says it waits for the system
    /// resolver instead.
    fn failed(&mut self, error: io::Error) {
        let message = error.to_string();
        let stalled = self.resolver.stalled();
        let repeat = self.logged_failure.as_deref() == Some(message.as_str());
        match (repeat, stalled) {
            (false, false) => {
                tracing::warn!(error = %message, "WireGuard endpoint failed; retrying");
            }
            (false, true) => tracing::warn!(
                error = %message,
                "WireGuard endpoint lookup stalled; waiting for the system resolver"
            ),
            (true, false) => {
                tracing::debug!(error = %message, "WireGuard endpoint still failing; retrying");
            }
            (true, true) => tracing::debug!(
                error = %message,
                "WireGuard endpoint lookup still stalled; waiting for the system resolver"
            ),
        }
        if !repeat {
            self.logged_failure = Some(message);
        }
        self.resolution_tx.send_replace(Resolution {
            error: Some(Arc::new(error)),
            stalled,
        });
    }

    /// A late answer stays available for the next core-produced attempt;
    /// resolution itself never starts a handshake on a live session.
    async fn resolved(&mut self, result: io::Result<Vec<SocketAddr>>) {
        match result {
            Err(error) => self.failed(self.unresolved(error)),
            Ok(answers) => {
                if self
                    .last_adopted
                    .is_some_and(|address| !answers.contains(&address))
                {
                    self.last_adopted = None;
                }
                self.answers = answers;
                match self.apply_answer().await {
                    Err(error) => self.failed(error),
                    Ok(_) => {
                        if self.logged_failure.take().is_some() {
                            tracing::warn!(endpoint = %self.endpoint_name, "WireGuard endpoint lookup recovered");
                        }
                        self.resolution_tx.send_replace(Resolution::default());
                    }
                }
            }
        }
        self.lookup_ended().await;
    }

    /// Keep an address still in the answer set while its session is live.
    /// A stale path may move on each retry, without revisiting an address
    /// already tried in this handshake. A live path gets one probe only.
    fn adopt(&self) -> Option<(SocketAddr, Adoption)> {
        let wire = self.wire.lock();
        let Some(current) = wire.endpoint else {
            return self
                .answers
                .first()
                .copied()
                .map(|answer| (answer, Adoption::Moved));
        };
        let stale = wire
            .tunn
            .time_since_last_handshake()
            .is_none_or(|age| age > STALE_HANDSHAKE);
        let initiation = self.initiation.as_ref()?;
        if stale {
            if initiation.retargeted
                || (!self.tried.contains(&current) && self.answers.contains(&current))
            {
                return None;
            }
        } else if initiation.probed || self.answers.contains(&current) {
            return None;
        }
        let answer = self.answers.iter().copied().find(|answer| {
            *answer != current
                && !self.tried.contains(answer)
                && (stale || Some(*answer) != self.last_adopted)
        })?;
        Some((
            answer,
            if stale {
                Adoption::Moved
            } else {
                Adoption::Probe
            },
        ))
    }

    async fn apply_answer(&mut self) -> io::Result<Option<Adoption>> {
        let Some((answer, adoption)) = self.adopt() else {
            return Ok(None);
        };
        self.sockets.ensure(answer).map_err(|error| {
            self.tried.insert(answer);
            io::Error::new(
                error.kind(),
                format!("binding a UDP socket for {answer}: {error}"),
            )
        })?;
        {
            let mut wire = self.wire.lock();
            if adoption == Adoption::Moved {
                tracing::info!(old = ?wire.endpoint, new = %answer, "endpoint resolved");
                wire.endpoint = Some(answer);
                self.last_adopted = Some(answer);
            } else {
                tracing::info!(endpoint = ?wire.endpoint, answer = %answer,
                    "endpoint name answered a new address; probing with the current handshake");
            }
        }
        if let Some(initiation) = &mut self.initiation {
            if adoption == Adoption::Probe {
                initiation.probed = true;
            } else {
                self.tried.insert(answer);
                initiation.retargeted = true;
            }
            if !self.pending_initiation {
                let bytes = initiation.bytes.clone();
                self.send_to(&bytes, answer).await;
            }
        }
        Ok(Some(adoption))
    }

    /// A lookup ended, by an answer, a failure or its deadline. An
    /// initiation held for want of an endpoint leaves now if there is one;
    /// without one it waits for the next lookup, which the tick starts.
    async fn lookup_ended(&mut self) {
        self.looked_up_at = Some(Instant::now());
        let endpoint = self.wire.lock().endpoint;
        if let (true, Some(endpoint)) = (self.pending_initiation, endpoint) {
            self.initiate(endpoint).await;
        }
    }

    /// Regenerate a held initiation when its first address arrives, so
    /// time spent resolving does not consume its transmission retry clock.
    async fn initiate(&mut self, to: SocketAddr) {
        self.pending_initiation = false;
        let mut initiation = [0; 148];
        let len = {
            let mut wire = self.wire.lock();
            match wire.tunn.format_handshake_initiation(&mut initiation, true) {
                TunnResult::WriteToNetwork(packet) => packet.len(),
                _ => return,
            }
        };
        self.initiation = Some(Initiation {
            bytes: initiation[..len].to_vec(),
            probed: false,
            retargeted: true,
        });
        self.tried.insert(to);
        self.send_to(&initiation[..len], to).await;
    }

    /// Every initiation asks for a lookup, unless an endpoint is known and
    /// one ended no more than `REKEY_TIMEOUT` ago. One to a known endpoint
    /// does not wait for it; without an endpoint it is held until a lookup
    /// gives one.
    fn look_up_on_initiation(&mut self, known: bool) {
        let fresh = self
            .looked_up_at
            .is_some_and(|at| at.elapsed() <= REKEY_TIMEOUT);
        if !(known && fresh) {
            self.resolver.start();
        }
    }

    async fn transmit(&mut self, datagram: &[u8]) {
        let endpoint = self.wire.lock().endpoint;
        let initiating = is_handshake_initiation(datagram);
        if initiating {
            match &mut self.initiation {
                Some(initiation) => {
                    initiation.bytes = datagram.to_vec();
                    initiation.retargeted = false;
                }
                None => {
                    self.initiation = Some(Initiation {
                        bytes: datagram.to_vec(),
                        probed: false,
                        retargeted: false,
                    })
                }
            }
            self.look_up_on_initiation(endpoint.is_some());
            self.pending_initiation = endpoint.is_none();
        }
        let mut moved = false;
        let live = self
            .wire
            .lock()
            .tunn
            .time_since_last_handshake()
            .is_some_and(|age| age <= STALE_HANDSHAKE);
        // The first attempt after a completed handshake or expiry asks for
        // a current answer before redirecting a stale path. Later retries
        // can advance through the set already returned for that attempt.
        if initiating && (live || !self.tried.is_empty()) {
            match self.apply_answer().await {
                Ok(adoption) => moved = adoption == Some(Adoption::Moved),
                Err(error) => self.failed(error),
            }
        }
        if let Some(endpoint) = endpoint.filter(|_| !moved) {
            self.send_to(datagram, endpoint).await;
            if initiating {
                self.tried.insert(endpoint);
            }
        }
    }

    async fn send_to(&mut self, datagram: &[u8], to: SocketAddr) {
        let Some(socket) = self.sockets.get(to.is_ipv4()) else {
            return;
        };
        if let Err(e) = socket.send_to(datagram, to).await {
            tracing::debug!(error = %e, endpoint = %to, "tunnel socket send");
        } else if is_handshake_initiation(datagram) {
            self.transmitted_initiation = true;
        }
    }
}

#[cfg(test)]
#[path = "tunnel_resolution_tests.rs"]
mod resolution_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::*;
    use crate::x25519::{PublicKey, StaticSecret};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::time::timeout;

    #[tokio::test]
    async fn echoes_a_mebibyte_each_way() {
        let Pair { a, b, .. } = pair().await;
        let mut listener = b.listen(0).unwrap();
        let port = listener.port();
        let server = tokio::spawn(async move {
            let stream = listener.accept().await.unwrap();
            let (mut rx, mut tx) = tokio::io::split(stream);
            let copied = tokio::io::copy(&mut rx, &mut tx).await.unwrap();
            tx.shutdown().await.unwrap();
            copied
        });

        let stream = timeout(WAIT, a.connect(b_port(port)))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stream.local_addr().ip(), A_ADDR.parse::<IpAddr>().unwrap());
        assert_eq!(stream.peer_addr(), b_port(port));
        let payload: Vec<u8> = (0..1024 * 1024u32)
            .map(|i| (i.wrapping_mul(2654435761) >> 13) as u8)
            .collect();
        let (mut rx, mut tx) = tokio::io::split(stream);
        let sent = payload.clone();
        let writer = tokio::spawn(async move {
            tx.write_all(&sent).await.unwrap();
            tx.shutdown().await.unwrap();
        });
        let mut echoed = Vec::new();
        timeout(WAIT, rx.read_to_end(&mut echoed))
            .await
            .unwrap()
            .unwrap();
        writer.await.unwrap();
        assert_eq!(echoed.len(), payload.len());
        assert!(echoed == payload, "the echo differs from what was sent");
        assert_eq!(server.await.unwrap(), payload.len() as u64);
    }

    #[tokio::test]
    async fn eof_after_shutdown_and_after_drop() {
        let Pair { a, b, .. } = pair().await;
        let mut listener = b.listen(0).unwrap();
        let port = listener.port();
        let client = timeout(WAIT, async {
            let (client, server) = tokio::join!(a.connect(b_port(port)), listener.accept());
            (client.unwrap(), server.unwrap())
        })
        .await
        .unwrap();
        let (mut client, mut server) = client;

        client.write_all(b"last words").await.unwrap();
        client.shutdown().await.unwrap();
        let mut got = Vec::new();
        timeout(WAIT, server.read_to_end(&mut got))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(got, b"last words");

        server.write_all(b"bye").await.unwrap();
        drop(server);
        let mut got = Vec::new();
        timeout(WAIT, client.read_to_end(&mut got))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(got, b"bye");
    }

    #[tokio::test]
    async fn unread_data_at_drop_resets_the_peer() {
        let Pair { a, b, .. } = pair().await;
        let mut listener = b.listen(0).unwrap();
        let port = listener.port();
        let (mut client, mut server) = timeout(WAIT, async {
            let (client, server) = tokio::join!(a.connect(b_port(port)), listener.accept());
            (client.unwrap(), server.unwrap())
        })
        .await
        .unwrap();

        // One write is one segment, so the second byte is in the server's
        // buffer when the first is read; dropping with it unread resets.
        client.write_all(b"ab").await.unwrap();
        let mut one = [0u8; 1];
        timeout(WAIT, server.read_exact(&mut one))
            .await
            .unwrap()
            .unwrap();
        drop(server);
        let mut rest = [0u8; 8];
        let err = timeout(WAIT, client.read(&mut rest))
            .await
            .unwrap()
            .expect_err("a reset reads as an error");
        assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);

        // Writes after the reset find the transmit half closed.
        let err = client
            .write_all(b"more")
            .await
            .expect_err("writes after the peer is gone fail");
        assert_eq!(err.kind(), io::ErrorKind::BrokenPipe);
    }

    #[tokio::test]
    async fn writes_after_the_peer_closed_break_the_pipe() {
        let Pair { a, b, .. } = pair().await;
        let mut listener = b.listen(0).unwrap();
        let port = listener.port();
        let (mut client, server) = timeout(WAIT, async {
            let (client, server) = tokio::join!(a.connect(b_port(port)), listener.accept());
            (client.unwrap(), server.unwrap())
        })
        .await
        .unwrap();

        drop(server);
        let mut buf = [0u8; 8];
        assert_eq!(
            timeout(WAIT, client.read(&mut buf)).await.unwrap().unwrap(),
            0
        );
        // The first write after the FIN is legal TCP: it is sent and the
        // closed peer answers with a reset, after which writes fail.
        let err = timeout(WAIT, async {
            loop {
                match client.write_all(b"x").await {
                    Ok(()) => tokio::time::sleep(Duration::from_millis(20)).await,
                    Err(e) => break e,
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(err.kind(), io::ErrorKind::BrokenPipe);
    }

    #[tokio::test]
    async fn connection_refused_when_nothing_listens() {
        let Pair { a, b: _b, .. } = pair().await;
        let err = timeout(WAIT, a.connect(b_port(9)))
            .await
            .unwrap()
            .expect_err("no listener on the port");
        assert_eq!(err.kind(), io::ErrorKind::ConnectionRefused);
    }

    #[tokio::test]
    async fn refuses_a_destination_outside_allowed_ips_without_sending() {
        let key = StaticSecret::random_from_rng(OsRng);
        let peer = PublicKey::from(&StaticSecret::random_from_rng(OsRng));
        let probe = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let probe_at = probe.local_addr().unwrap();
        let udp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let a =
            Tunnel::start_on(config(key, peer, A_ADDR, B_ADDR, probe_at), udp, probe_at).unwrap();

        let outside: SocketAddr = "10.9.9.9:80".parse().unwrap();
        let err = timeout(WAIT, a.connect(outside))
            .await
            .unwrap()
            .expect_err("outside the allowed IPs");
        assert_eq!(err.kind(), io::ErrorKind::NetworkUnreachable);
        tokio::time::sleep(2 * TICK).await;
        let mut buf = [0u8; 256];
        assert!(
            probe.try_recv_from(&mut buf).is_err(),
            "a refused connect must send nothing"
        );

        // The control: an allowed destination does reach the endpoint,
        // as the handshake initiation that precedes its SYN.
        let pending = tokio::spawn(async move { a.connect(b_port(80)).await });
        let (len, _) = timeout(WAIT, probe.recv_from(&mut buf))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(len, 148, "a handshake initiation");
        assert_eq!(&buf[..4], &[1, 0, 0, 0]);
        pending.abort();
    }

    /// A cookie reply is sealed under a key anyone who saw the initiation
    /// can derive, so one forged from a third address must not move the
    /// endpoint; the core still takes the cookie, which is the control
    /// that the forgery was well formed.
    #[tokio::test]
    async fn a_forged_cookie_reply_does_not_move_the_endpoint() {
        use crate::noise::handshake::{b2s_hash, LABEL_COOKIE};
        use chacha20poly1305::aead::{Aead, KeyInit, Payload};
        use chacha20poly1305::{XChaCha20Poly1305, XNonce};

        let key = StaticSecret::random_from_rng(OsRng);
        let peer = PublicKey::from(&StaticSecret::random_from_rng(OsRng));
        let probe = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let probe_at = probe.local_addr().unwrap();
        let udp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let a_at = udp.local_addr().unwrap();
        let a =
            Tunnel::start_on(config(key, peer, A_ADDR, B_ADDR, probe_at), udp, probe_at).unwrap();

        // The initiation the probe receives carries the sender index and the
        // mac1 a forger on the path would see.
        let pending = tokio::spawn({
            let a = a.clone();
            async move { a.connect(b_port(80)).await }
        });
        let mut init = [0u8; 256];
        let (len, _) = timeout(WAIT, probe.recv_from(&mut init))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(len, 148, "a handshake initiation");
        let sender_idx = &init[4..8];
        let mac1 = &init[116..132];

        let cookie_key = b2s_hash(LABEL_COOKIE, peer.as_bytes());
        let mut nonce = [0u8; 24];
        OsRng.fill_bytes(&mut nonce);
        let sealed = XChaCha20Poly1305::new_from_slice(&cookie_key)
            .unwrap()
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &[0x5a; 16],
                    aad: mac1,
                },
            )
            .unwrap();
        let mut reply = Vec::with_capacity(64);
        reply.extend_from_slice(&[3, 0, 0, 0]);
        reply.extend_from_slice(sender_idx);
        reply.extend_from_slice(&nonce);
        reply.extend_from_slice(&sealed);
        assert_eq!(reply.len(), 64);

        let forger = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        forger.send_to(&reply, a_at).await.unwrap();

        timeout(WAIT, async {
            while !a.inner.wire.lock().tunn.has_cookie() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the core takes a well-formed cookie reply");
        assert_eq!(
            a.status().endpoint,
            Some(probe_at),
            "a cookie reply authenticates nobody"
        );
        pending.abort();
    }

    #[tokio::test]
    async fn status_reports_the_handshake_and_the_bytes() {
        let Pair { a, b, a_at, b_at } = pair().await;
        let before = a.status();
        assert_eq!(before.handshake, HandshakeState::Never);
        assert_eq!((before.tx_bytes, before.rx_bytes), (0, 0));
        assert_eq!(before.endpoint, Some(b_at));

        let mut listener = b.listen(0).unwrap();
        let port = listener.port();
        let (mut client, mut server) = timeout(WAIT, async {
            let (client, server) = tokio::join!(a.connect(b_port(port)), listener.accept());
            (client.unwrap(), server.unwrap())
        })
        .await
        .unwrap();
        client.write_all(b"ping").await.unwrap();
        let mut buf = [0u8; 4];
        timeout(WAIT, server.read_exact(&mut buf))
            .await
            .unwrap()
            .unwrap();
        server.write_all(b"pong").await.unwrap();
        timeout(WAIT, client.read_exact(&mut buf))
            .await
            .unwrap()
            .unwrap();

        let after = a.status();
        assert!(
            matches!(after.handshake, HandshakeState::Live(age) if age < WAIT),
            "{after:?}"
        );
        assert!(after.tx_bytes > 0 && after.rx_bytes > 0, "{after:?}");
        assert_eq!(after.endpoint, Some(b_at));
        let b_status = b.status();
        assert!(
            matches!(b_status.handshake, HandshakeState::Live(_)),
            "{b_status:?}"
        );
        assert_eq!(b_status.endpoint, Some(a_at));
    }

    #[tokio::test]
    async fn streams_fail_once_the_tunnel_is_dropped() {
        let Pair { a, b, .. } = pair().await;
        let mut listener = b.listen(0).unwrap();
        let port = listener.port();
        let (mut client, server) = timeout(WAIT, async {
            let (client, server) = tokio::join!(a.connect(b_port(port)), listener.accept());
            (client.unwrap(), server.unwrap())
        })
        .await
        .unwrap();

        let reader = tokio::spawn(async move {
            let mut buf = [0u8; 8];
            client.read(&mut buf).await
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        drop(a);
        let err = timeout(WAIT, reader)
            .await
            .unwrap()
            .unwrap()
            .expect_err("a read on a closed tunnel fails");
        assert_eq!(err.kind(), io::ErrorKind::ConnectionAborted);
        drop(server);
    }
}
