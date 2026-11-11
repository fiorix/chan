//! HTTP policy for local devserver calls and explicitly addressed metrics.

use std::time::Duration;

use anyhow::{Context, Result};

fn bounded(timeout: Duration) -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
}

/// The bearer must reach only this host's selected listener. reqwest otherwise takes the proxy from the environment and, on macOS and Windows, the system, with no loopback exemption. Redirects must not move the request to another listener either.
pub(crate) fn local_devserver(timeout: Duration) -> Result<reqwest::Client> {
    bounded(timeout)
        .no_proxy()
        .build()
        .context("building local devserver HTTP client")
}

/// An explicit metrics URL keeps the user's proxy settings, which a remote server may need. The URL can name any server, a devserver behind a gateway included, so a TLS server is verified with chan-tls's trust decision, the one the desktop and the devserver's tunnel make.
pub(crate) fn explicit_url(timeout: Duration) -> Result<reqwest::Client> {
    let tls = chan_tls::client_config().context("building the TLS trust for the metrics URL")?;
    explicit_url_builder(timeout, tls)
        .build()
        .context("building explicit-URL HTTP client")
}

fn explicit_url_builder(
    timeout: Duration,
    mut tls: chan_tls::rustls::ClientConfig,
) -> reqwest::ClientBuilder {
    // reqwest uses a preconfigured config as it is, ALPN included, and this
    // build has no HTTP/2, so the config offers HTTP/1.1 alone.
    tls.alpn_protocols = vec![b"http/1.1".to_vec()];
    bounded(timeout).use_preconfigured_tls(tls)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn explicit_requests_verify_with_the_config_given_over_http1() {
        let (tls, handshakes) = chan_tls::testing::recording(chan_tls::client_config().unwrap());
        let sink = chan_tls::testing::Sink::start();
        // No proxy from the environment either, so the dial is the sink's.
        let client = explicit_url_builder(Duration::from_secs(5), tls)
            .no_proxy()
            .build()
            .unwrap();
        let refused = client
            .get(format!("https://{}/api/metrics", sink.addr))
            .send()
            .await;
        assert!(refused.is_err(), "the sink never answers");
        assert_eq!(handshakes.server_names(), ["127.0.0.1"]);
        assert_eq!(sink.alpn_offers(), [["http/1.1"]]);
    }

    #[tokio::test]
    async fn local_requests_do_not_follow_redirects() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let destination = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        destination.set_nonblocking(true).unwrap();
        let location = destination.local_addr().unwrap();
        let server = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = server.local_addr().unwrap();
        let peer = tokio::spawn(async move {
            let (mut socket, _) = server.accept().await.unwrap();
            let mut head = Vec::new();
            while !head.ends_with(b"\r\n\r\n") {
                head.push(socket.read_u8().await.unwrap());
            }
            socket.write_all(format!(
                "HTTP/1.1 302 Found\r\nlocation: http://{location}/redirected\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
            ).as_bytes()).await.unwrap();
        });
        let response = local_devserver(Duration::from_secs(1))
            .unwrap()
            .get(format!("http://{addr}/api/health"))
            .bearer_auth("test-token")
            .send()
            .await
            .unwrap();
        peer.await.unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::FOUND);
        assert_eq!(
            destination.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }
}
