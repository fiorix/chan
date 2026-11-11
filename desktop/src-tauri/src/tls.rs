//! What each of the desktop's TLS transports adds to the trust decision it
//! takes from chan-tls. The decision itself (which roots, which verifier) is
//! chan-tls's alone, so the HTTP clients, the WebSocket dials and the updater
//! trust exactly the gateways the devserver's tunnel dial trusts; this module
//! only sets the ALPN each transport speaks.

use std::sync::Arc;

use chan_tls::rustls::ClientConfig;

/// `config` for a reqwest client of this build. reqwest uses a
/// preconfigured config as it is, ALPN included, and both reqwest versions
/// here (0.12 for the desktop's clients, 0.13 for the updater's) are built
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

/// The updater's reqwest 0.13 builder on `config`, for its check and its
/// download alike (the plugin runs `configure_client` before both).
#[cfg(any(target_os = "macos", target_os = "linux", windows))]
pub fn updater_client(
    builder: reqwest013::ClientBuilder,
    config: &ClientConfig,
) -> reqwest013::ClientBuilder {
    builder.tls_backend_preconfigured(http1(config.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_clients_offer_http1_alone() {
        let config = http1(chan_tls::client_config().unwrap());
        assert_eq!(config.alpn_protocols, [b"http/1.1".to_vec()]);
    }

    #[cfg(any(target_os = "macos", target_os = "linux", windows))]
    #[tokio::test]
    async fn the_updater_client_takes_the_shared_config_over_http1() {
        let (config, handshakes) = chan_tls::testing::recording(chan_tls::client_config().unwrap());
        let sink = chan_tls::testing::Sink::start();
        let client = updater_client(reqwest013::Client::builder(), &config)
            .no_proxy()
            .build()
            .unwrap();
        let refused = client
            .get(format!("https://{}/dl/desktop/latest.json", sink.addr))
            .send()
            .await;
        assert!(refused.is_err(), "the sink never answers");
        assert_eq!(handshakes.server_names(), ["127.0.0.1"]);
        assert_eq!(sink.alpn_offers(), [["http/1.1"]]);
    }
}
