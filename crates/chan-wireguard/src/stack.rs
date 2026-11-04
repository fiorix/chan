//! The TCP/IP stack inside the process: smoltcp over a device that is two
//! packet queues, the socket bookkeeping the streams and the driver share,
//! and the port allocator.
//!
//! Nothing here touches the network. The driver moves packets between the
//! device's queues and the protocol core; the streams copy bytes in and out
//! of socket buffers under the one lock and register their wakers with the
//! socket when they must wait.

use std::collections::{HashMap, VecDeque};
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use rand_core::{OsRng, RngCore};
use smoltcp::iface::{Config as InterfaceConfig, Interface, SocketHandle, SocketSet};
use smoltcp::phy::{self, DeviceCapabilities, Medium};
use smoltcp::socket::tcp;
use smoltcp::time::Instant as StackInstant;
use smoltcp::wire::{HardwareAddress, IpAddress, IpCidr, IpListenEndpoint};
use tokio::sync::Notify;

use crate::config::Cidr;

/// Per-direction socket buffer. A WAN round trip of 100 ms at this window
/// still moves a few MiB/s per connection, which is more than the h2
/// tunnel above it needs; a smaller buffer caps every transfer at a crawl.
const SOCKET_BUFFER: usize = 256 * 1024;

/// Packets the interface may queue for the driver before it must wait for
/// a drain. The interface pauses egress when the device refuses a transmit
/// token, so this bounds the memory one poll can take.
const OUTBOUND_CAPACITY: usize = 128;

/// Decrypted packets waiting for the next poll. Past this the datagram is
/// dropped and TCP retransmits, which is what a saturated link does too.
const INBOUND_CAPACITY: usize = 256;

/// How long a released socket may wait for its peer to finish closing
/// before it is reset and removed. A clean close reaches the end of
/// TIME-WAIT well inside this; a peer that never answers the FIN would
/// otherwise pin the socket and its port forever.
const LINGER: Duration = Duration::from_secs(15);

const EPHEMERAL_FIRST: u16 = 49152;
const EPHEMERAL_COUNT: u32 = u16::MAX as u32 - EPHEMERAL_FIRST as u32 + 1;

/// The smoltcp device: IP packets in from the tunnel, IP packets out to it.
pub(crate) struct Device {
    mtu: usize,
    inbound: VecDeque<Vec<u8>>,
    outbound: VecDeque<Vec<u8>>,
}

impl Device {
    fn new(mtu: usize) -> Self {
        Self {
            mtu,
            inbound: VecDeque::new(),
            outbound: VecDeque::new(),
        }
    }

    /// Queue a decrypted packet from the peer for the next poll.
    pub(crate) fn push_inbound(&mut self, packet: Vec<u8>) {
        if self.inbound.len() >= INBOUND_CAPACITY {
            tracing::trace!("inbound queue full, dropping a packet");
            return;
        }
        self.inbound.push_back(packet);
    }

    /// Everything the interface emitted since the last drain, oldest first.
    pub(crate) fn drain_outbound(&mut self) -> Vec<Vec<u8>> {
        self.outbound.drain(..).collect()
    }

    /// Whether the last poll stopped because the outbound queue was full,
    /// in which case the interface has more to send once it is drained.
    pub(crate) fn outbound_saturated(&self) -> bool {
        self.outbound.len() >= OUTBOUND_CAPACITY
    }
}

pub(crate) struct RxToken(Vec<u8>);

impl phy::RxToken for RxToken {
    fn consume<R, F>(self, f: F) -> R
    where
        F: FnOnce(&[u8]) -> R,
    {
        f(&self.0)
    }
}

pub(crate) struct TxToken<'a>(&'a mut VecDeque<Vec<u8>>);

impl phy::TxToken for TxToken<'_> {
    fn consume<R, F>(self, len: usize, f: F) -> R
    where
        F: FnOnce(&mut [u8]) -> R,
    {
        let mut packet = vec![0u8; len];
        let result = f(&mut packet);
        self.0.push_back(packet);
        result
    }
}

impl phy::Device for Device {
    type RxToken<'a>
        = RxToken
    where
        Self: 'a;
    type TxToken<'a>
        = TxToken<'a>
    where
        Self: 'a;

    fn receive(&mut self, _now: StackInstant) -> Option<(RxToken, TxToken<'_>)> {
        // The reply token is handed out past the outbound bound on purpose:
        // ingress then always completes in one poll, and the bound still
        // holds for egress through `transmit`.
        let packet = self.inbound.pop_front()?;
        Some((RxToken(packet), TxToken(&mut self.outbound)))
    }

    fn transmit(&mut self, _now: StackInstant) -> Option<TxToken<'_>> {
        (self.outbound.len() < OUTBOUND_CAPACITY).then_some(TxToken(&mut self.outbound))
    }

    fn capabilities(&self) -> DeviceCapabilities {
        let mut caps = DeviceCapabilities::default();
        caps.medium = Medium::Ip;
        caps.max_transmission_unit = self.mtu;
        caps
    }
}

struct Entry {
    port: u16,
    /// Set when the owning stream or listener is gone; the driver removes
    /// the socket once it is closed, or resets it after the linger.
    released_at: Option<Instant>,
}

/// The interface, its sockets and what the crate keeps beside them.
pub(crate) struct Stack {
    iface: Interface,
    pub(crate) device: Device,
    pub(crate) sockets: SocketSet<'static>,
    entries: HashMap<SocketHandle, Entry>,
    /// Local ports in use, with how many sockets hold each (a listener's
    /// backlog shares one).
    ports: HashMap<u16, usize>,
    next_port: u16,
    epoch: Instant,
    /// Set once the driver is gone. Every stream operation then fails
    /// instead of waiting for a poll that never comes.
    pub(crate) closed: bool,
}

impl Stack {
    pub(crate) fn new(addresses: &[Cidr], mtu: usize) -> io::Result<Self> {
        let mut device = Device::new(mtu);
        let mut config = InterfaceConfig::new(HardwareAddress::Ip);
        config.random_seed = OsRng.next_u64();
        let mut iface = Interface::new(config, &mut device, StackInstant::ZERO);

        for cidr in addresses {
            if !IpAddress::from(cidr.addr).is_unicast() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("tunnel address {cidr} is not a unicast address"),
                ));
            }
        }
        let mut overflow = false;
        iface.update_ip_addrs(|slots| {
            for cidr in addresses {
                if slots
                    .push(IpCidr::new(cidr.addr.into(), cidr.prefix))
                    .is_err()
                {
                    overflow = true;
                }
            }
        });
        if overflow {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "the stack holds at most two tunnel addresses",
            ));
        }

        // The IP medium sends to any destination the route table admits
        // and never uses the gateway value, but without a default route a
        // socket to a prefix outside the tunnel addresses sends nothing.
        // The tunnel's own address stands in as the gateway.
        let routes = iface.routes_mut();
        if let Some(v4) = addresses.iter().find_map(|c| match c.addr {
            IpAddr::V4(a) => Some(a),
            IpAddr::V6(_) => None,
        }) {
            routes
                .add_default_ipv4_route(v4)
                .map_err(|_| io::Error::other("route table full"))?;
        }
        if let Some(v6) = addresses.iter().find_map(|c| match c.addr {
            IpAddr::V6(a) => Some(a),
            IpAddr::V4(_) => None,
        }) {
            routes
                .add_default_ipv6_route(v6)
                .map_err(|_| io::Error::other("route table full"))?;
        }

        let next_port = EPHEMERAL_FIRST + (OsRng.next_u32() % EPHEMERAL_COUNT) as u16;
        Ok(Self {
            iface,
            device,
            sockets: SocketSet::new(Vec::new()),
            entries: HashMap::new(),
            ports: HashMap::new(),
            next_port,
            epoch: Instant::now(),
            closed: false,
        })
    }

    /// smoltcp's own `Instant::now` is the wall clock; its timers want a
    /// monotonic count, so time is measured from the stack's creation.
    fn now(&self) -> StackInstant {
        StackInstant::from_micros(self.epoch.elapsed().as_micros() as i64)
    }

    /// Run the interface over the queued packets and the sockets, release
    /// what finished closing, and say how long the interface can wait
    /// before it needs polling again (`None` for no timer pending).
    pub(crate) fn poll(&mut self) -> Option<Duration> {
        let now = self.now();
        self.iface.poll(now, &mut self.device, &mut self.sockets);
        self.reap();
        self.iface
            .poll_delay(now, &self.sockets)
            .map(|delay| Duration::from_micros(delay.total_micros()))
    }

    fn reap(&mut self) {
        let now = Instant::now();
        let mut done = Vec::new();
        for (&handle, entry) in &self.entries {
            let Some(released_at) = entry.released_at else {
                continue;
            };
            let socket = self.sockets.get_mut::<tcp::Socket>(handle);
            let state = socket.state();
            // A closed socket still holding its endpoints has a reset to
            // send first; the tuple clears once it left.
            if state == tcp::State::Closed && socket.remote_endpoint().is_none() {
                done.push(handle);
            } else if state == tcp::State::Closed {
                continue;
            } else if socket.can_recv() || now.duration_since(released_at) >= LINGER {
                // Data for a reader that is gone, or a peer that never
                // finished closing: a reset, as a closed OS socket answers.
                socket.abort();
            }
        }
        for handle in done {
            self.remove(handle);
        }
    }

    fn remove(&mut self, handle: SocketHandle) {
        self.sockets.remove(handle);
        if let Some(entry) = self.entries.remove(&handle) {
            self.free_port(entry.port);
        }
    }

    /// Mark the driver gone: wake every waiter so it reads the closed flag
    /// instead of sleeping on a socket nothing polls any more.
    pub(crate) fn shut_down(&mut self) {
        self.closed = true;
        for &handle in self.entries.keys() {
            self.sockets.get_mut::<tcp::Socket>(handle).abort();
        }
    }

    fn free_port_candidate(&mut self) -> io::Result<u16> {
        for _ in 0..EPHEMERAL_COUNT {
            let port = self.next_port;
            self.next_port = if port == u16::MAX {
                EPHEMERAL_FIRST
            } else {
                port + 1
            };
            if !self.ports.contains_key(&port) {
                return Ok(port);
            }
        }
        Err(io::Error::new(
            io::ErrorKind::AddrInUse,
            "no free ephemeral port in the tunnel",
        ))
    }

    fn reserve_port(&mut self, port: u16) {
        *self.ports.entry(port).or_insert(0) += 1;
    }

    fn free_port(&mut self, port: u16) {
        if let Some(count) = self.ports.get_mut(&port) {
            *count -= 1;
            if *count == 0 {
                self.ports.remove(&port);
            }
        }
    }

    fn new_socket() -> tcp::Socket<'static> {
        let mut socket = tcp::Socket::new(
            tcp::SocketBuffer::new(vec![0u8; SOCKET_BUFFER]),
            tcp::SocketBuffer::new(vec![0u8; SOCKET_BUFFER]),
        );
        // The traffic above is request-response h2 frames; holding a small
        // frame back for a full segment adds a round trip to every one.
        socket.set_nagle_enabled(false);
        // Without congestion control a socket sends its peer's whole window
        // in one burst, which overruns any path with less buffering than
        // that, a UDP socket on the same host included.
        socket.set_congestion_control(tcp::CongestionControl::Cubic);
        socket
    }

    fn add_socket(&mut self, socket: tcp::Socket<'static>, port: u16) -> SocketHandle {
        let handle = self.sockets.add(socket);
        self.entries.insert(
            handle,
            Entry {
                port,
                released_at: None,
            },
        );
        handle
    }

    /// Start a connection from `local` on a fresh ephemeral port. The
    /// socket is in SYN-SENT when this returns; the driver sends the SYN at
    /// its next poll.
    pub(crate) fn connect(
        &mut self,
        remote: SocketAddr,
        local: IpAddr,
    ) -> io::Result<(SocketHandle, SocketAddr)> {
        let port = self.free_port_candidate()?;
        let mut socket = Self::new_socket();
        let local_endpoint = IpListenEndpoint {
            addr: Some(local.into()),
            port,
        };
        socket
            .connect(self.iface.context(), remote, local_endpoint)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))?;
        self.reserve_port(port);
        let handle = self.add_socket(socket, port);
        Ok((handle, SocketAddr::new(local, port)))
    }

    /// Open `backlog` listening sockets on `port` (0 picks a free one) so
    /// SYNs arriving together each find a socket instead of a reset.
    pub(crate) fn listen(
        &mut self,
        port: u16,
        backlog: usize,
    ) -> io::Result<(u16, Vec<SocketHandle>)> {
        let port = if port == 0 {
            self.free_port_candidate()?
        } else if self.ports.contains_key(&port) {
            return Err(io::Error::new(
                io::ErrorKind::AddrInUse,
                format!("port {port} is in use in the tunnel"),
            ));
        } else {
            port
        };
        let handles = (0..backlog)
            .map(|_| self.add_listening(port))
            .collect::<io::Result<Vec<_>>>()?;
        Ok((port, handles))
    }

    /// One more listening socket on `port`, replacing one that accepted.
    pub(crate) fn add_listening(&mut self, port: u16) -> io::Result<SocketHandle> {
        let mut socket = Self::new_socket();
        socket
            .listen(IpListenEndpoint { addr: None, port })
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))?;
        self.reserve_port(port);
        Ok(self.add_socket(socket, port))
    }

    /// The owner is gone; the driver removes the socket once it closes.
    pub(crate) fn release(&mut self, handle: SocketHandle) {
        if let Some(entry) = self.entries.get_mut(&handle) {
            entry.released_at = Some(Instant::now());
        }
    }
}

/// What the driver and the streams share: the stack under its lock and
/// the kick that asks the driver to poll it.
pub(crate) struct Shared {
    pub(crate) stack: Mutex<Stack>,
    kick: Notify,
}

impl Shared {
    pub(crate) fn new(stack: Stack) -> Self {
        Self {
            stack: Mutex::new(stack),
            kick: Notify::new(),
        }
    }

    /// Ask the driver to poll: bytes were queued, a socket was opened or
    /// closed, or a window opened. A kick before the driver waits is
    /// remembered, so none is lost.
    pub(crate) fn kick(&self) {
        self.kick.notify_one();
    }

    /// Resolves at the next kick, or at once for one already delivered.
    pub(crate) async fn kicked(&self) {
        self.kick.notified().await;
    }
}
