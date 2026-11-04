//! Fixtures the crate's tests share: two tunnels on loopback UDP sockets,
//! each the other's peer, and the configuration that builds one side.

use std::net::SocketAddr;
use std::time::Duration;

use rand_core::OsRng;
use tokio::net::UdpSocket;

use crate::config::{Cidr, Config, Endpoint, Peer};
use crate::tunnel::Tunnel;
use crate::x25519::{PublicKey, StaticSecret};

pub(crate) const A_ADDR: &str = "10.7.0.1";
pub(crate) const B_ADDR: &str = "10.7.0.2";

/// The bound on any one wait in a test; a handshake and a TCP open on
/// loopback finish in milliseconds, so reaching it is a failure.
pub(crate) const WAIT: Duration = Duration::from_secs(10);

pub(crate) fn cidr(addr: &str) -> Cidr {
    Cidr {
        addr: addr.parse().unwrap(),
        prefix: 32,
    }
}

/// One side's configuration: its own address, the other side as the
/// peer, and the peer's address as the only allowed prefix.
pub(crate) fn config(
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

pub(crate) struct Pair {
    pub(crate) a: Tunnel,
    pub(crate) b: Tunnel,
    pub(crate) a_at: SocketAddr,
    pub(crate) b_at: SocketAddr,
}

/// Two tunnels on loopback UDP, each the other's peer, A at `A_ADDR` and
/// B at `B_ADDR`.
pub(crate) async fn pair() -> Pair {
    pair_at(A_ADDR, B_ADDR).await
}

/// The pair at the given tunnel addresses, so a test can hold two pairs
/// with disjoint prefixes.
pub(crate) async fn pair_at(a_addr: &str, b_addr: &str) -> Pair {
    let a_key = StaticSecret::random_from_rng(OsRng);
    let b_key = StaticSecret::random_from_rng(OsRng);
    let a_pub = PublicKey::from(&a_key);
    let b_pub = PublicKey::from(&b_key);
    let a_udp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let b_udp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let a_at = a_udp.local_addr().unwrap();
    let b_at = b_udp.local_addr().unwrap();
    let a = Tunnel::start_on(config(a_key, b_pub, a_addr, b_addr, b_at), a_udp, b_at).unwrap();
    let b = Tunnel::start_on(config(b_key, a_pub, b_addr, a_addr, a_at), b_udp, a_at).unwrap();
    Pair { a, b, a_at, b_at }
}

/// `B_ADDR` at `port`, the address A dials.
pub(crate) fn b_port(port: u16) -> SocketAddr {
    SocketAddr::new(B_ADDR.parse().unwrap(), port)
}
