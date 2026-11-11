//! What each of the desktop's TLS transports adds to the trust decision it
//! takes from chan-tls. The decision itself (which roots, which verifier) is
//! chan-tls's alone, so the HTTP clients and the WebSocket dials trust exactly
//! the gateways the devserver's tunnel dial trusts; this module only sets the
//! ALPN each transport speaks.

use std::sync::Arc;

use chan_tls::rustls::ClientConfig;

/// `config` for a reqwest client of this build. reqwest uses a
/// preconfigured config as it is, ALPN included, and reqwest is built here
/// without HTTP/2, so the config offers HTTP/1.1 alone, as reqwest's own
/// config would.
pub fn http1(mut config: ClientConfig) -> ClientConfig {
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    config
}

/// The connector of a WebSocket dial: the shared config with no ALPN, as
/// tokio-tungstenite's own connector has none. A `ws://` dial never uses it.
pub fn ws_connector() -> Result<tokio_tungstenite::Connector, String> {
    chan_tls::client_config()
        .map(|config| tokio_tungstenite::Connector::Rustls(Arc::new(config)))
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_clients_offer_http1_alone() {
        let config = http1(chan_tls::client_config().unwrap());
        assert_eq!(config.alpn_protocols, [b"http/1.1".to_vec()]);
    }
}
