//! Byte pumps between a TCP socket and a message channel.
//!
//! The two ends of a data leg speak different libraries: the devserver serves
//! its WebSocket through axum, the desktop dials one with tokio-tungstenite.
//! Neither belongs in the shared contract, so this module is written against
//! plain mpsc channels of byte vectors instead. Each side's WebSocket adapter
//! shuttles frames into and out of those channels, which keeps this pump (the
//! part with the tricky half-close semantics) identical on both ends and
//! testable with no WebSocket at all.

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;

use crate::wire::MAX_DATA_FRAME_BYTES;

/// Splice `tcp` against a peer reachable through `to_peer` / `from_peer`.
///
/// Returns when either direction closes: a TCP EOF, a peer channel close, or
/// an error on either side. Both directions are dropped together rather than
/// half-closed, because the peer channel carries no half-close signal and a
/// lingering half is indistinguishable from a stall to the process on the
/// other end of the socket.
pub async fn splice(
    tcp: TcpStream,
    to_peer: mpsc::Sender<Vec<u8>>,
    mut from_peer: mpsc::Receiver<Vec<u8>>,
) {
    let (mut read, mut write) = tcp.into_split();

    let uplink = async move {
        let mut buf = vec![0u8; MAX_DATA_FRAME_BYTES];
        loop {
            match read.read(&mut buf).await {
                // Clean EOF from the local peer.
                Ok(0) => break,
                Ok(n) => {
                    if to_peer.send(buf[..n].to_vec()).await.is_err() {
                        break;
                    }
                }
                Err(e) => {
                    tracing::debug!("revtunnel: socket read ended: {e}");
                    break;
                }
            }
        }
    };

    let downlink = async move {
        while let Some(chunk) = from_peer.recv().await {
            if chunk.is_empty() {
                continue;
            }
            if let Err(e) = write.write_all(&chunk).await {
                tracing::debug!("revtunnel: socket write ended: {e}");
                break;
            }
        }
        // Best effort: the far end already stopped, so a failure here says
        // only that this side was also gone.
        let _ = write.shutdown().await;
    };

    tokio::select! {
        _ = uplink => {}
        _ = downlink => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// Bind a loopback listener, connect to it, and hand back both ends.
    async fn socket_pair() -> (TcpStream, TcpStream) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let connect = tokio::spawn(async move { TcpStream::connect(addr).await.unwrap() });
        let (server, _) = listener.accept().await.unwrap();
        (connect.await.unwrap(), server)
    }

    #[tokio::test]
    async fn bytes_flow_in_both_directions() {
        let (mut client, spliced) = socket_pair().await;
        let (to_peer, mut peer_rx) = mpsc::channel(8);
        let (peer_tx, from_peer) = mpsc::channel(8);
        let pump = tokio::spawn(splice(spliced, to_peer, from_peer));

        client.write_all(b"ping").await.unwrap();
        assert_eq!(peer_rx.recv().await.unwrap(), b"ping".to_vec());

        peer_tx.send(b"pong".to_vec()).await.unwrap();
        let mut buf = [0u8; 4];
        client.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"pong");

        drop(client);
        pump.await.unwrap();
    }

    #[tokio::test]
    async fn a_closed_peer_channel_ends_the_splice_and_shuts_the_socket() {
        let (mut client, spliced) = socket_pair().await;
        let (to_peer, _peer_rx) = mpsc::channel(8);
        let (peer_tx, from_peer) = mpsc::channel::<Vec<u8>>(8);
        let pump = tokio::spawn(splice(spliced, to_peer, from_peer));

        // The peer hangs up (its data socket closed): the local end must see
        // EOF rather than a hang.
        drop(peer_tx);
        let mut sink = Vec::new();
        client.read_to_end(&mut sink).await.unwrap();
        assert!(sink.is_empty());
        pump.await.unwrap();
    }

    #[tokio::test]
    async fn a_local_eof_ends_the_splice() {
        let (client, spliced) = socket_pair().await;
        let (to_peer, mut peer_rx) = mpsc::channel(8);
        let (_peer_tx, from_peer) = mpsc::channel(8);
        let pump = tokio::spawn(splice(spliced, to_peer, from_peer));

        drop(client);
        // The uplink closes, so the peer sees the channel end with no data.
        assert!(peer_rx.recv().await.is_none());
        pump.await.unwrap();
    }

    #[tokio::test]
    async fn empty_frames_are_ignored_rather_than_treated_as_eof() {
        let (mut client, spliced) = socket_pair().await;
        let (to_peer, _peer_rx) = mpsc::channel(8);
        let (peer_tx, from_peer) = mpsc::channel(8);
        let pump = tokio::spawn(splice(spliced, to_peer, from_peer));

        peer_tx.send(Vec::new()).await.unwrap();
        peer_tx.send(b"after".to_vec()).await.unwrap();
        let mut buf = [0u8; 5];
        client.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"after");

        drop(client);
        drop(peer_tx);
        pump.await.unwrap();
    }

    #[tokio::test]
    async fn a_peer_close_does_not_cancel_an_in_flight_uplink_send() {
        let mut failures = Vec::new();
        for iteration in 0..10u8 {
            let (mut client, spliced) = socket_pair().await;
            let (to_peer, mut peer_rx) = mpsc::channel(1);
            to_peer.send(b"occupied".to_vec()).await.unwrap();
            let (peer_tx, from_peer) = mpsc::channel::<Vec<u8>>(8);
            let mut pump = tokio::spawn(splice(spliced, to_peer, from_peer));

            let payload = vec![iteration];
            client.write_all(&payload).await.unwrap();
            client.shutdown().await.unwrap();

            // Local EOF cannot finish while the one-slot outbound channel is
            // occupied: the byte read from TCP is waiting in `send`.
            assert!(
                tokio::time::timeout(std::time::Duration::from_millis(50), &mut pump)
                    .await
                    .is_err(),
                "splice returned before its blocked send"
            );

            // Ending the opposite direction must let that send finish rather
            // than cancel it. Free the slot only after the peer close races it.
            drop(peer_tx);
            assert_eq!(peer_rx.recv().await.unwrap(), b"occupied".to_vec());
            tokio::time::timeout(std::time::Duration::from_secs(2), &mut pump)
                .await
                .expect("splice finishes after the outbound slot opens")
                .unwrap();
            let received = peer_rx.recv().await;
            if received.as_deref() != Some(payload.as_slice()) {
                failures.push((iteration, received));
            }
        }
        assert!(
            failures.is_empty(),
            "peer close cancelled in-flight uplink sends: {failures:?}"
        );
    }

    #[tokio::test]
    async fn a_local_eof_does_not_cancel_an_in_flight_socket_write() {
        let mut failures = Vec::new();
        for iteration in 0..10u8 {
            let (mut client, spliced) = socket_pair().await;
            let (to_peer, _peer_rx) = mpsc::channel(8);
            let (peer_tx, from_peer) = mpsc::channel(8);
            let mut pump = tokio::spawn(splice(spliced, to_peer, from_peer));
            let payload = vec![iteration; 16 * 1024 * 1024];
            peer_tx.send(payload.clone()).await.unwrap();

            // One byte proves `write_all` started. Stop reading before local
            // EOF races it, leaving far more than the socket buffer in flight.
            let mut first = [0u8; 1];
            tokio::time::timeout(
                std::time::Duration::from_secs(2),
                client.read_exact(&mut first),
            )
            .await
            .expect("socket write starts")
            .unwrap();
            client.shutdown().await.unwrap();

            let finished_early =
                match tokio::time::timeout(std::time::Duration::from_millis(50), &mut pump).await {
                    Ok(result) => {
                        result.unwrap();
                        true
                    }
                    Err(_) => false,
                };

            let mut received = first.to_vec();
            tokio::time::timeout(
                std::time::Duration::from_secs(5),
                client.read_to_end(&mut received),
            )
            .await
            .expect("socket write drains")
            .unwrap();
            if !finished_early {
                tokio::time::timeout(std::time::Duration::from_secs(2), &mut pump)
                    .await
                    .expect("splice finishes after the socket drains")
                    .unwrap();
            }

            if received != payload {
                failures.push((iteration, received.len()));
            }
        }
        assert!(
            failures.is_empty(),
            "local EOF cancelled in-flight socket writes: {failures:?}"
        );
    }
}
