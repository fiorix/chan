//! Blocking producers bridged onto response bodies under the transfer stall
//! bound.
//!
//! [`crate::bulk_transfer`] owns the bound and pins its own production half
//! free of the ambient blocking pool, since bulk work must never expand into
//! the threads interactive work needs. The bridges here are that interactive
//! work: editor-size text reads, raw byte reads, report rows and graph views,
//! each a handful of frames, run on the blocking pool on purpose. What they
//! borrow from the lane is only its no-progress policy, through a signal a
//! tenant mints.

use axum::body::{Body, Bytes};
use futures::{stream, Stream, StreamExt};
use tokio::sync::mpsc;

use crate::bulk_transfer::BulkCancel;

/// Frames a bridge producer may queue ahead of its reader. Small on purpose:
/// the channel is backpressure, not a buffer. The stall bound counts from the
/// moment a send blocks on a full channel, so a producer that computes for a
/// long time before its first frame holds its thread for that compute time
/// plus the bound when its reader has stopped.
pub(crate) const BRIDGE_CAPACITY: usize = 8;

/// A blocking producer bridged onto a response body through a bounded
/// channel, with the transfer stall bound on every send.
///
/// Editor-size text reads, raw byte reads, report rows and graph views run on
/// the blocking pool rather than the lane: each is a handful of frames, and
/// admitting them
/// would spend transfer slots on the interactive work the lane exists to
/// protect. What they share with a bulk send is the failure: a client that
/// stops reading fills the channel, and an unbounded send then parks the pool
/// thread for as long as the connection stays open. A send here gives up
/// after the bound, the producer returns, and the body ends as an error
/// rather than as a stream that looks complete.
pub(crate) struct StreamBridge<T> {
    rx: mpsc::Receiver<T>,
    signal: BulkCancel,
}

/// The producer's end of a [`StreamBridge`].
pub(crate) struct BridgeSender<T> {
    tx: mpsc::Sender<T>,
    signal: BulkCancel,
}

impl<T> BridgeSender<T> {
    /// Queue a frame, waiting for room within the bound. `false` once the
    /// reader is gone or the bound elapsed; the producer stops at the first
    /// `false`, and after a stall every later send refuses at once.
    pub(crate) fn send(&self, frame: T) -> bool {
        self.signal.send(&self.tx, frame).is_ok()
    }
}

impl<T: Send + 'static> StreamBridge<T> {
    /// Start `produce` on the blocking pool under the bound `signal` carries.
    pub(crate) fn spawn(
        signal: BulkCancel,
        produce: impl FnOnce(&BridgeSender<T>) + Send + 'static,
    ) -> Self {
        let (tx, rx) = mpsc::channel(BRIDGE_CAPACITY);
        let sender = BridgeSender {
            tx,
            signal: signal.clone(),
        };
        tokio::task::spawn_blocking(move || produce(&sender));
        Self { rx, signal }
    }

    /// The first frame, which decides the response status. `None` when the
    /// producer returned without one.
    pub(crate) async fn first(&mut self) -> Option<T> {
        self.rx.recv().await
    }

    /// The body: `first`, then every later frame through `render`. When the
    /// bound stopped the producer, the body ends with an error instead of an
    /// end of stream, so a client that resumes reading cannot take the frames
    /// it got for a complete response.
    pub(crate) fn into_body(
        self,
        first: Bytes,
        mut render: impl FnMut(T) -> Bytes + Send + 'static,
    ) -> Body {
        let rest = self.frames().map(move |frame| frame.map(&mut render));
        Body::from_stream(
            stream::once(async move { Ok::<Bytes, std::io::Error>(first) }).chain(rest),
        )
    }

    /// Every frame the producer queues, then the stall error when the bound
    /// stopped it.
    fn frames(self) -> impl Stream<Item = Result<T, std::io::Error>> + Send {
        let Self { rx, signal } = self;
        stream::unfold((rx, signal, false), |(mut rx, signal, ended)| async move {
            if ended {
                return None;
            }
            match rx.recv().await {
                Some(frame) => Some((Ok(frame), (rx, signal, false))),
                None if signal.is_cancelled() => Some((
                    Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "stream stalled without channel progress",
                    )),
                    (rx, signal, true),
                )),
                None => None,
            }
        })
    }
}

impl StreamBridge<std::io::Result<Bytes>> {
    /// The body of a raw byte stream, which has no leading frame to decide
    /// its status with: every chunk as produced, a read error as the item
    /// that ends it, and the stall error when the bound stopped the producer.
    pub(crate) fn into_raw_body(self) -> Body {
        Body::from_stream(self.frames().map(|frame| frame.and_then(|chunk| chunk)))
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::future::Future;
    use std::time::Duration;

    /// Hold a streaming response unpolled on a runtime whose blocking pool
    /// is one thread, and prove that thread comes back within the stall
    /// bound. The response's producer owns the pool's only thread, so a
    /// probe queued behind it can run only once the producer has returned:
    /// the measurement is a task that runs or does not, not a stopwatch.
    /// Returns what draining the body then produced, for the caller to say
    /// whether an abandoned stream must end as an error.
    ///
    /// The first half pins the fixture. Without it, a probe that ran while
    /// the producer was parked would prove nothing, since it would also run
    /// against a pool with a spare thread.
    pub(crate) fn assert_unread_stream_frees_its_pool_thread<F, Fut>(
        name: &str,
        respond: F,
    ) -> Result<axum::body::Bytes, axum::Error>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = axum::response::Response>,
    {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .max_blocking_threads(1)
            .enable_all()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            let (release, park) = std::sync::mpsc::channel::<()>();
            tokio::task::spawn_blocking(move || {
                let _ = park.recv();
            });
            let (probe_tx, mut probe_rx) = tokio::sync::mpsc::channel::<()>(1);
            tokio::task::spawn_blocking(move || {
                let _ = probe_tx.blocking_send(());
            });
            assert!(
                tokio::time::timeout(Duration::from_millis(200), probe_rx.recv())
                    .await
                    .is_err(),
                "{name}: the blocking pool must be one thread, or the measurement proves nothing"
            );
            drop(release);
            assert!(
                tokio::time::timeout(Duration::from_secs(10), probe_rx.recv())
                    .await
                    .is_ok(),
                "{name}: freeing the pool thread must let the queued task run"
            );

            let response = respond().await;
            assert_eq!(response.status(), axum::http::StatusCode::OK);
            let (ran_tx, mut ran_rx) = tokio::sync::mpsc::channel::<()>(1);
            tokio::task::spawn_blocking(move || {
                let _ = ran_tx.blocking_send(());
            });
            let freed = tokio::time::timeout(Duration::from_secs(2), ran_rx.recv()).await;
            if freed.is_err() {
                // Closing the channel unparks an unbounded producer before
                // the runtime joins its thread.
                drop(response);
                let _ = tokio::time::timeout(Duration::from_secs(2), ran_rx.recv()).await;
                panic!("{name}: the parked producer kept its pool thread past the stall bound");
            }
            tokio::time::timeout(
                Duration::from_secs(2),
                axum::body::to_bytes(response.into_body(), usize::MAX),
            )
            .await
            .expect("draining the abandoned body must not wait on the producer")
        })
    }
}
