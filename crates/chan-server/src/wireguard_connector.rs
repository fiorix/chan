//! The gateway dial carried by an in-process WireGuard tunnel.
//!
//! `chan devserver run --tunnel-wireguard` hands the devserver a wg-quick
//! configuration. The tunnel started from it carries the h2 dial to the
//! gateway's tunnel ingress at an address inside the peer's AllowedIPs, so
//! the ingress needs no public name, no certificate and no edge in front
//! of it. The peer is pinned by its static key and every byte is
//! encrypted, which is what chan-tunnel-client asks of a connector before
//! it runs cleartext h2 over it.

use std::io;
use std::net::{IpAddr, SocketAddr};

use chan_tunnel_client::{ConnectFuture, Connector, DialStream};
use chan_wireguard::Tunnel;

/// A [`Connector`] that opens the tunnel URL's host and port as a TCP
/// connection through one WireGuard tunnel.
pub(crate) struct WireguardConnector {
    tunnel: Tunnel,
}

impl WireguardConnector {
    pub(crate) fn new(tunnel: Tunnel) -> Self {
        Self { tunnel }
    }
}

impl Connector for WireguardConnector {
    fn connect<'a>(&'a self, host: &'a str, port: u16) -> ConnectFuture<'a> {
        Box::pin(async move {
            // The tunnel URL names an address inside the tunnel. A name is
            // resolved on the host; the tunnel refuses whatever resolves
            // outside the peer's AllowedIPs before a byte leaves, so a name
            // that points elsewhere fails here rather than dialing plain TCP.
            let ip = match host.parse::<IpAddr>() {
                Ok(ip) => ip,
                Err(_) => tokio::net::lookup_host((host, port))
                    .await?
                    .next()
                    .ok_or_else(|| {
                        io::Error::new(
                            io::ErrorKind::NotFound,
                            format!("{host} resolved to no address"),
                        )
                    })?
                    .ip(),
            };
            let stream = self.tunnel.connect(SocketAddr::new(ip, port)).await?;
            Ok(Box::new(stream) as Box<dyn DialStream>)
        })
    }

    fn is_protected(&self) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;

    use chan_wireguard::config::Config;
    use tokio::net::UdpSocket;
    use tokio::time::timeout;

    const KEY_A: &str = "yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=";
    const KEY_B: &str = "xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=";
    const WAIT: Duration = Duration::from_secs(10);

    /// A tunnel at 10.7.0.2 whose peer, reachable at 10.7.0.1, is a UDP
    /// socket the test holds and never answers from.
    async fn tunnel_towards(probe_at: SocketAddr) -> Tunnel {
        let text = format!(
            "[Interface]\nPrivateKey = {KEY_A}\nAddress = 10.7.0.2/32\n\
             [Peer]\nPublicKey = {KEY_B}\nEndpoint = {probe_at}\nAllowedIPs = 10.7.0.1/32\n"
        );
        let config = Config::parse(&text).unwrap();
        let udp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        Tunnel::start_on(config, udp, probe_at).unwrap()
    }

    /// A handshake initiation is the first datagram a tunnel sends for a
    /// connection to an allowed address.
    fn is_handshake_initiation(datagram: &[u8]) -> bool {
        datagram.len() == 148 && datagram[..4] == [1, 0, 0, 0]
    }

    #[tokio::test]
    async fn refuses_a_host_outside_the_tunnel_without_sending() {
        let probe = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let probe_at = probe.local_addr().unwrap();
        let connector = WireguardConnector::new(tunnel_towards(probe_at).await);
        assert!(connector.is_protected());

        let err = match timeout(WAIT, connector.connect("10.9.9.9", 80))
            .await
            .unwrap()
        {
            Ok(_) => panic!("outside the peer's allowed IPs"),
            Err(err) => err,
        };
        assert_eq!(err.kind(), io::ErrorKind::NetworkUnreachable);
        tokio::time::sleep(Duration::from_millis(600)).await;
        let mut buf = [0u8; 256];
        assert!(
            probe.try_recv_from(&mut buf).is_err(),
            "a refused connect must send nothing"
        );

        // The control: an address inside the tunnel starts the handshake.
        let pending =
            tokio::spawn(async move { connector.connect("10.7.0.1", 80).await.map(|_| ()) });
        let (len, _) = timeout(WAIT, probe.recv_from(&mut buf))
            .await
            .unwrap()
            .unwrap();
        assert!(is_handshake_initiation(&buf[..len]), "{len} bytes");
        pending.abort();
    }

    /// A tunnel URL on a WireGuard address is cleartext h2 to a non-loopback
    /// host, which the client refuses over plain TCP and admits over this
    /// connector: the dial then reaches the peer through the tunnel.
    #[tokio::test]
    async fn a_tunnel_address_passes_the_client_validation_with_the_connector() {
        let probe = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let probe_at = probe.local_addr().unwrap();
        let connector = Arc::new(WireguardConnector::new(tunnel_towards(probe_at).await));
        let cfg = chan_tunnel_client::ClientConfig {
            tunnel_url: url::Url::parse("http://10.7.0.1:4443/v1/tunnel").unwrap(),
            token: "chan_pat_x".into(),
            workspace: "devserver".into(),
            dial_timeout: Duration::from_secs(2),
            connector: Some(connector),
            ..chan_tunnel_client::ClientConfig::default()
        };

        let plain = chan_tunnel_client::ClientConfig {
            connector: None,
            ..cfg.clone()
        };
        let err = chan_tunnel_client::run(plain, axum::Router::new())
            .await
            .expect_err("plain TCP cannot carry cleartext h2 to 10.7.0.1");
        assert!(
            matches!(err, chan_tunnel_client::ClientError::InvalidUrl(ref m) if m.contains("https://")),
            "{err}"
        );

        let running = tokio::spawn(chan_tunnel_client::run(cfg, axum::Router::new()));
        let mut buf = [0u8; 256];
        let (len, _) = timeout(WAIT, probe.recv_from(&mut buf))
            .await
            .unwrap()
            .unwrap();
        assert!(is_handshake_initiation(&buf[..len]), "{len} bytes");
        running.abort();
    }
}
