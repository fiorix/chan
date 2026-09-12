//! The inbound substream pool bounds served work; it must never stop
//! the yamux connection.
//!
//! `Connection::poll_next_inbound` is yamux's only driver: it is the
//! sole reader, writer and flusher of the socket, and nothing else
//! the client calls touches it. A client that stops polling it while
//! its permit pool is full therefore stops serving the substreams
//! already in flight too, so this test saturates the pool and then
//! watches the connection for progress.

use std::sync::Arc;
use std::time::Duration;

use futures::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, Notify};
use tokio::time::timeout;
use tokio_util::compat::TokioAsyncReadCompatExt;
use yamux::{Config as YamuxConfig, Connection as YamuxConnection, Mode};

/// Every wait in this test is bounded: a wedged connection has to
/// surface as a failed assertion, not as a stuck test binary.
const STEP_TIMEOUT: Duration = Duration::from_secs(5);

/// Read one HTTP/1.1 status line off a substream, a byte at a time so
/// nothing is buffered past the line the assertion reads.
async fn read_status_line<S>(stream: &mut S) -> String
where
    S: futures::AsyncRead + Unpin,
{
    let mut line = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        let read = stream.read(&mut byte).await.expect("substream read");
        assert_eq!(read, 1, "substream closed before its status line");
        match byte[0] {
            b'\n' => break,
            b'\r' => {}
            other => line.push(other),
        }
    }
    String::from_utf8(line).expect("status line is ascii")
}

fn request(path: &str) -> Vec<u8> {
    format!("GET {path} HTTP/1.1\r\nHost: tunnel-test\r\n\r\n").into_bytes()
}

#[tokio::test]
async fn a_saturated_permit_pool_still_drives_the_connection() {
    let (entered_tx, mut entered_rx) = mpsc::channel::<()>(1);
    let release = Arc::new(Notify::new());
    let held_release = release.clone();
    let router = axum::Router::new()
        .route(
            "/hold",
            axum::routing::get(move || {
                let entered_tx = entered_tx.clone();
                let release = held_release.clone();
                async move {
                    let _ = entered_tx.send(()).await;
                    release.notified().await;
                    "held"
                }
            }),
        )
        .route("/ping", axum::routing::get(|| async { "pong" }));

    let (client_io, server_io) = tokio::io::duplex(256 * 1024);
    let client = YamuxConnection::new(client_io.compat(), YamuxConfig::default(), Mode::Client);
    let mut server = YamuxConnection::new(server_io.compat(), YamuxConfig::default(), Mode::Server);
    // One permit, so the first substream served saturates the pool.
    let serving = tokio::spawn(chan_tunnel_client::serve_substreams_with_limit(
        client, router, 1,
    ));

    // Both substreams are opened before the pump takes the connection:
    // poll_new_outbound only queues the frames, it never writes them.
    let mut holder =
        futures::future::poll_fn(|cx| std::pin::Pin::new(&mut server).poll_new_outbound(cx))
            .await
            .expect("open holder substream");
    let mut queued =
        futures::future::poll_fn(|cx| std::pin::Pin::new(&mut server).poll_new_outbound(cx))
            .await
            .expect("open queued substream");
    let pumping = tokio::spawn(async move {
        // Resolves only on error or close; until then it is what keeps
        // the public side of the connection reading and writing.
        let _ =
            futures::future::poll_fn(|cx| std::pin::Pin::new(&mut server).poll_next_inbound(cx))
                .await;
    });

    holder.write_all(&request("/hold")).await.expect("write");
    queued.write_all(&request("/ping")).await.expect("write");

    // The pool is saturated once /hold's handler is inside the route:
    // it holds the only permit until the test releases it.
    timeout(STEP_TIMEOUT, entered_rx.recv())
        .await
        .expect("the first substream was never served: the connection is wedged")
        .expect("the route reports before it parks");

    // Progress while saturated: the substream already in flight runs to
    // completion, which only happens if the connection is still driven.
    release.notify_one();
    let status = timeout(STEP_TIMEOUT, read_status_line(&mut holder))
        .await
        .expect("no response while the permit pool was saturated");
    assert!(status.starts_with("HTTP/1.1 200"), "{status}");

    // The permit lives as long as the substream, so close the served
    // one: the substream that arrived with the pool full is then
    // served in its turn, rather than being stranded behind it.
    drop(holder);
    let status = timeout(STEP_TIMEOUT, read_status_line(&mut queued))
        .await
        .expect("the substream that waited for a permit was never served");
    assert!(status.starts_with("HTTP/1.1 200"), "{status}");

    pumping.abort();
    serving.abort();
}
