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

/// An explicit metrics URL keeps the user's proxy settings, which a remote server may need.
pub(crate) fn explicit_url(timeout: Duration) -> Result<reqwest::Client> {
    bounded(timeout)
        .build()
        .context("building explicit-URL HTTP client")
}

#[cfg(test)]
mod tests {
    use super::*;

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
