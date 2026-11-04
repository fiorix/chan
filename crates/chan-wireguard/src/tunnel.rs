//! The tunnel: one UDP socket, one protocol peer and one TCP/IP stack,
//! driven by one task.
//!
//! The driver owns the socket and the network side of the loop: it polls
//! the stack, seals every packet the stack emitted and sends it to the
//! endpoint, and opens every datagram that arrives into the stack. The
//! streams never see a packet; they share the stack under its lock and
//! kick the driver when they queue bytes. The protocol core and the
//! current endpoint sit under a second lock, held for one call at a time,
//! so the status read never waits on a poll.

use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use rand_core::{OsRng, RngCore};
use tokio::net::UdpSocket;
use tokio::task::JoinHandle;

use crate::config::{Cidr, Config, Endpoint};
use crate::noise::errors::WireGuardError;
use crate::noise::{Tunn, TunnResult};
use crate::stack::{Shared, Stack};
use crate::stream::{Connecting, Listener, Stream, BACKLOG};

/// The MTU when the configuration names none: 1500 less the IPv4, UDP
/// and WireGuard headers, the value wg-quick picks.
const DEFAULT_MTU: u16 = 1420;

/// The timer tick of the protocol core; it expects about this rate.
const TICK: Duration = Duration::from_millis(250);

/// The largest UDP payload; a datagram is never longer.
const MAX_DATAGRAM: usize = 65535;

/// The sealing overhead of a transport message, which the work buffer
/// must hold beyond the packet.
const SEAL_OVERHEAD: usize = 32;

/// Datagrams read in one go after the socket signalled readiness, so a
/// burst is opened before the stack polls once rather than once each.
const RECEIVE_BURST: usize = 32;

/// How long a name lookup may take when the endpoint is re-resolved
/// after the tunnel expired.
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(10);

/// Asked of the kernel for the tunnel socket's buffers: a window of
/// sealed packets arriving while the driver is busy must fit, and the
/// OS defaults (64 KiB on Windows, about 200 KiB on Linux) do not hold
/// one. The kernel may grant less; the request is best effort.
const SOCKET_BUFFER_HINT: usize = 4 * 1024 * 1024;

/// A point in time report on the tunnel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Status {
    /// Time since the current session's handshake completed; `None`
    /// before the first one.
    pub last_handshake: Option<Duration>,
    /// Payload bytes sealed for the peer.
    pub tx_bytes: u64,
    /// Payload bytes opened from the peer.
    pub rx_bytes: u64,
    /// Where datagrams go: the resolved configuration endpoint, or the
    /// source of the peer's latest authenticated datagram.
    pub endpoint: SocketAddr,
}

struct Wire {
    tunn: Tunn,
    endpoint: SocketAddr,
}

struct Inner {
    shared: Arc<Shared>,
    wire: Arc<Mutex<Wire>>,
    addresses: Vec<IpAddr>,
    allowed_ips: Vec<Cidr>,
    driver: JoinHandle<()>,
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
    /// Resolve the peer's endpoint, bind a UDP socket of its family on an
    /// ephemeral port and start the driver. No datagram is sent until a
    /// connection is opened or the keepalive asks for one.
    pub async fn start(config: Config) -> io::Result<Tunnel> {
        let endpoint = resolve(&config.peer.endpoint, None).await?;
        let bind: SocketAddr = if endpoint.is_ipv4() {
            (Ipv4Addr::UNSPECIFIED, 0).into()
        } else {
            (Ipv6Addr::UNSPECIFIED, 0).into()
        };
        let socket = UdpSocket::bind(bind).await?;
        Self::start_on(config, socket, endpoint)
    }

    /// Start the driver over a socket the caller bound, towards an
    /// endpoint the caller resolved. Must be called within a tokio
    /// runtime, which the driver task runs on.
    pub fn start_on(config: Config, socket: UdpSocket, endpoint: SocketAddr) -> io::Result<Tunnel> {
        if socket.local_addr()?.is_ipv4() != endpoint.is_ipv4() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "the socket and the endpoint are of different address families",
            ));
        }
        let kernel_socket = socket2::SockRef::from(&socket);
        if let Err(e) = kernel_socket.set_recv_buffer_size(SOCKET_BUFFER_HINT) {
            tracing::debug!(error = %e, "tunnel socket receive buffer left at the default");
        }
        if let Err(e) = kernel_socket.set_send_buffer_size(SOCKET_BUFFER_HINT) {
            tracing::debug!(error = %e, "tunnel socket send buffer left at the default");
        }
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
        let wire = Arc::new(Mutex::new(Wire { tunn, endpoint }));
        let driver = Driver {
            shared: shared.clone(),
            wire: wire.clone(),
            socket,
            endpoint_name: config.peer.endpoint,
            allowed_ips: config.peer.allowed_ips.clone(),
            expired: false,
        };
        let driver = tokio::spawn(driver.run());
        Ok(Tunnel {
            inner: Arc::new(Inner {
                shared,
                wire,
                addresses: config.addresses.iter().map(|c| c.addr).collect(),
                allowed_ips: config.peer.allowed_ips,
                driver,
            }),
        })
    }

    /// Open a TCP connection to `remote` through the tunnel. A destination
    /// outside the peer's allowed IPs is refused as `NetworkUnreachable`
    /// before anything is sent; a reset answers `ConnectionRefused`.
    /// Dropping the future closes the half-open connection.
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
        Connecting::new(Stream::new(inner.shared.clone(), handle, local, remote)).await
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
        Status {
            last_handshake,
            tx_bytes: tx_bytes as u64,
            rx_bytes: rx_bytes as u64,
            endpoint: wire.endpoint,
        }
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

/// The first address the endpoint resolves to, of the wanted family when
/// one is given.
async fn resolve(endpoint: &Endpoint, want_v4: Option<bool>) -> io::Result<SocketAddr> {
    tokio::net::lookup_host((endpoint.host.as_str(), endpoint.port))
        .await?
        .find(|a| want_v4.is_none_or(|v4| a.is_ipv4() == v4))
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                format!("{endpoint} resolved to no usable address"),
            )
        })
}

/// A cookie reply is the one message the core answers before it has
/// authenticated the sender, so it must not move the endpoint.
fn is_cookie_reply(datagram: &[u8]) -> bool {
    datagram.len() == 64 && datagram[..4] == [3, 0, 0, 0]
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
}

struct Driver {
    shared: Arc<Shared>,
    wire: Arc<Mutex<Wire>>,
    socket: UdpSocket,
    endpoint_name: Endpoint,
    allowed_ips: Vec<Cidr>,
    /// Whether the last tick reported the tunnel expired, so the endpoint
    /// is re-resolved once per expiry rather than every tick.
    expired: bool,
}

impl Driver {
    async fn run(mut self) {
        let _shut_down = ShutDown(self.shared.clone());
        let mut datagram = vec![0u8; MAX_DATAGRAM];
        let mut work = vec![0u8; MAX_DATAGRAM + SEAL_OVERHEAD];
        let mut tick = tokio::time::interval(TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

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
            let event = tokio::select! {
                received = self.socket.recv_from(&mut datagram) => match received {
                    Ok((len, from)) => Event::Datagram(len, from),
                    Err(e) => Event::ReceiveFailed(e),
                },
                _ = self.shared.kicked() => Event::Kick,
                _ = tick.tick() => Event::Tick,
                _ = stack_timer => Event::StackTimer,
            };
            match event {
                Event::Datagram(len, from) => {
                    self.handle_datagram(&datagram[..len], from, &mut work)
                        .await;
                    for _ in 1..RECEIVE_BURST {
                        match self.socket.try_recv_from(&mut datagram) {
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
                Event::Kick | Event::StackTimer => {}
            }
        }
    }

    /// Seal one IP packet from the stack and send it. Without a session
    /// the core queues the packet and hands back the handshake initiation
    /// instead.
    async fn send_packet(&self, packet: &[u8], work: &mut [u8]) {
        let (len, endpoint) = {
            let mut wire = self.wire.lock();
            match wire.tunn.encapsulate(packet, work) {
                TunnResult::WriteToNetwork(sealed) => (sealed.len(), wire.endpoint),
                TunnResult::Err(e) => {
                    tracing::debug!(error = %e, "dropping an outgoing packet");
                    return;
                }
                TunnResult::Done
                | TunnResult::WriteToTunnelV4(..)
                | TunnResult::WriteToTunnelV6(..) => return,
            }
        };
        self.send(&work[..len], endpoint).await;
    }

    async fn handle_datagram(&mut self, datagram: &[u8], from: SocketAddr, work: &mut [u8]) {
        let mut to_network: Vec<Vec<u8>> = Vec::new();
        let mut to_stack: Vec<Vec<u8>> = Vec::new();
        let endpoint = {
            let mut wire = self.wire.lock();
            let mut authenticated = false;
            let mut drain = false;
            match wire.tunn.decapsulate(Some(from.ip()), datagram, work) {
                TunnResult::Done => authenticated = true,
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
                self.expired = false;
                if wire.endpoint != from {
                    tracing::info!(old = %wire.endpoint, new = %from, "peer endpoint moved");
                    wire.endpoint = from;
                }
            }
            wire.endpoint
        };
        if !to_stack.is_empty() {
            let mut stack = self.shared.stack.lock();
            for packet in to_stack {
                stack.device.push_inbound(packet);
            }
        }
        for sealed in &to_network {
            self.send(sealed, endpoint).await;
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
        let (len, endpoint, expired) = {
            let mut wire = self.wire.lock();
            match wire.tunn.update_timers(work) {
                TunnResult::WriteToNetwork(sealed) => (sealed.len(), wire.endpoint, false),
                TunnResult::Err(WireGuardError::ConnectionExpired) => (0, wire.endpoint, true),
                TunnResult::Err(e) => {
                    tracing::debug!(error = %e, "timer tick");
                    (0, wire.endpoint, false)
                }
                TunnResult::Done
                | TunnResult::WriteToTunnelV4(..)
                | TunnResult::WriteToTunnelV6(..) => (0, wire.endpoint, false),
            }
        };
        if len > 0 {
            self.send(&work[..len], endpoint).await;
        }
        if expired && !self.expired {
            // The peer stopped answering for the whole retry window. The
            // next packet starts a fresh handshake on its own; the name is
            // read again first so a moved peer is found.
            self.expired = true;
            tracing::warn!(endpoint = %self.endpoint_name, "tunnel expired; re-resolving the endpoint");
            let want_v4 = self.socket.local_addr().map(|a| a.is_ipv4()).ok();
            match tokio::time::timeout(RESOLVE_TIMEOUT, resolve(&self.endpoint_name, want_v4)).await
            {
                Ok(Ok(addr)) => {
                    let mut wire = self.wire.lock();
                    if wire.endpoint != addr {
                        tracing::info!(old = %wire.endpoint, new = %addr, "endpoint re-resolved");
                        wire.endpoint = addr;
                    }
                }
                Ok(Err(e)) => tracing::warn!(error = %e, "endpoint lookup failed"),
                Err(_) => tracing::warn!("endpoint lookup timed out"),
            }
        } else if !expired {
            self.expired = false;
        }
    }

    async fn send(&self, datagram: &[u8], endpoint: SocketAddr) {
        if let Err(e) = self.socket.send_to(datagram, endpoint).await {
            tracing::debug!(error = %e, %endpoint, "tunnel socket send");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Peer;
    use crate::x25519::{PublicKey, StaticSecret};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::time::timeout;

    const A_ADDR: &str = "10.7.0.1";
    const B_ADDR: &str = "10.7.0.2";

    fn cidr(addr: &str) -> Cidr {
        Cidr {
            addr: addr.parse().unwrap(),
            prefix: 32,
        }
    }

    fn config(
        key: StaticSecret,
        peer: PublicKey,
        own: &str,
        other: &str,
        endpoint: SocketAddr,
    ) -> Config {
        Config {
            private_key: key,
            addresses: vec![cidr(own)],
            mtu: None,
            peer: Peer {
                public_key: peer,
                preshared_key: None,
                endpoint: Endpoint {
                    host: endpoint.ip().to_string(),
                    port: endpoint.port(),
                },
                allowed_ips: vec![cidr(other)],
                persistent_keepalive: None,
            },
        }
    }

    struct Pair {
        a: Tunnel,
        b: Tunnel,
        a_at: SocketAddr,
        b_at: SocketAddr,
    }

    /// Two tunnels on loopback UDP, each the other's peer, A at 10.7.0.1
    /// and B at 10.7.0.2.
    async fn pair() -> Pair {
        let a_key = StaticSecret::random_from_rng(OsRng);
        let b_key = StaticSecret::random_from_rng(OsRng);
        let a_pub = PublicKey::from(&a_key);
        let b_pub = PublicKey::from(&b_key);
        let a_udp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let b_udp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let a_at = a_udp.local_addr().unwrap();
        let b_at = b_udp.local_addr().unwrap();
        let a = Tunnel::start_on(config(a_key, b_pub, A_ADDR, B_ADDR, b_at), a_udp, b_at).unwrap();
        let b = Tunnel::start_on(config(b_key, a_pub, B_ADDR, A_ADDR, a_at), b_udp, a_at).unwrap();
        Pair { a, b, a_at, b_at }
    }

    fn b_port(port: u16) -> SocketAddr {
        SocketAddr::new(B_ADDR.parse().unwrap(), port)
    }

    const WAIT: Duration = Duration::from_secs(10);

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

    #[tokio::test]
    async fn status_reports_the_handshake_and_the_bytes() {
        let Pair { a, b, a_at, b_at } = pair().await;
        let before = a.status();
        assert_eq!(before.last_handshake, None);
        assert_eq!((before.tx_bytes, before.rx_bytes), (0, 0));
        assert_eq!(before.endpoint, b_at);

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
        assert!(after.last_handshake.is_some(), "{after:?}");
        assert!(after.last_handshake.unwrap() < WAIT);
        assert!(after.tx_bytes > 0 && after.rx_bytes > 0, "{after:?}");
        assert_eq!(after.endpoint, b_at);
        let b_status = b.status();
        assert!(b_status.last_handshake.is_some(), "{b_status:?}");
        assert_eq!(b_status.endpoint, a_at);
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
