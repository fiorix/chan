//! Process-local counters shared by chan's transports and serving layer.
//! Byte counts are payload bytes at each named layer; nested layers must not
//! be added together to estimate physical network traffic.

use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::task::{Context, Poll};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

/// A cumulative channel counter. Its active gauge follows owned lifetimes.
#[derive(Debug, Default)]
pub struct Counter {
    active: AtomicU64,
    opened: AtomicU64,
    received: AtomicU64,
    sent: AtomicU64,
}

/// Counts since process start; byte directions are relative to this process.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub active: u64,
    pub opened: u64,
    pub received_bytes: u64,
    pub sent_bytes: u64,
}

impl Counter {
    pub const fn new() -> Self {
        Self {
            active: AtomicU64::new(0),
            opened: AtomicU64::new(0),
            received: AtomicU64::new(0),
            sent: AtomicU64::new(0),
        }
    }

    /// Count a resource until its guard drops, including cancellation.
    pub fn enter(&self) -> Guard<'_> {
        self.enter_many(1)
    }

    /// Hold several capacity slots for one owner.
    pub fn enter_many(&self, count: u64) -> Guard<'_> {
        self.active.fetch_add(count, Relaxed);
        self.opened.fetch_add(count, Relaxed);
        Guard(self, count)
    }

    pub fn received(&self, bytes: usize) {
        self.received.fetch_add(bytes as u64, Relaxed);
    }

    pub fn sent(&self, bytes: usize) {
        self.sent.fetch_add(bytes as u64, Relaxed);
    }

    pub fn snapshot(&self) -> Activity {
        Activity {
            active: self.active.load(Relaxed),
            opened: self.opened.load(Relaxed),
            received_bytes: self.received.load(Relaxed),
            sent_bytes: self.sent.load(Relaxed),
        }
    }
}

/// An active resource. Dropping it removes the active counts it holds: one
/// from [`Counter::enter`], as many as were asked from
/// [`Counter::enter_many`].
#[derive(Debug)]
pub struct Guard<'a>(&'a Counter, u64);

impl Drop for Guard<'_> {
    fn drop(&mut self) {
        self.0.active.fetch_sub(self.1, Relaxed);
    }
}

/// Local serving sockets and gateway transport payloads, counted once per leg.
pub static NETWORK: Counter = Counter::new();
/// Gateway substreams waiting for a handler permit.
pub static YAMUX_WAITING: Counter = Counter::new();
/// Gateway substreams whose HTTP handler holds a permit.
pub static YAMUX_SERVING: Counter = Counter::new();
/// Handler capacity across live gateway sessions.
pub static YAMUX_SERVICE_CAPACITY: Counter = Counter::new();
/// Ready reverse-forward listeners, not their TCP connections.
pub static REVERSE_LISTENERS: Counter = Counter::new();

/// An event count whose value only increases during the process lifetime.
#[derive(Default)]
pub struct Total(AtomicU64);
impl Total {
    pub const fn new() -> Self {
        Self(AtomicU64::new(0))
    }
    pub fn increment(&self) {
        self.0.fetch_add(1, Relaxed);
    }
    pub fn get(&self) -> u64 {
        self.0.load(Relaxed)
    }
}
/// Failed gateway dial attempts, including timed-out attempts.
pub static TUNNEL_DIAL_FAILURES: Total = Total::new();
/// Upload/download HTTP requests and their payloads.
pub static TRANSFERS: Counter = Counter::new();
/// Connected gateway yamux sessions.
pub static TUNNELS: Counter = Counter::new();
/// Accepted gateway yamux streams, including upgraded WebSockets.
pub static YAMUX: Counter = Counter::new();
/// HTTP/2 CONNECT streams carrying gateway tunnels.
pub static HTTP2: Counter = Counter::new();
/// Reverse-forward TCP connections and their payloads.
pub static REVERSE: Counter = Counter::new();

/// Count successful I/O without changing it: every call, vectored writes
/// included, reaches the inner stream as it would unwrapped, so a wrapped
/// transport keeps its write strategy and buffering.
pub struct MeteredIo<T> {
    inner: T,
    counter: &'static Counter,
    _active: Option<Guard<'static>>,
}

impl<T> MeteredIo<T> {
    /// Count a whole stream, holding its active count while it exists.
    pub fn new(inner: T, counter: &'static Counter) -> Self {
        Self {
            inner,
            counter,
            _active: Some(counter.enter()),
        }
    }

    /// Count one half of a split stream. The owner of both halves holds the
    /// active count with [`Counter::enter`], so a connection counts once
    /// however it is split.
    pub fn half(inner: T, counter: &'static Counter) -> Self {
        Self {
            inner,
            counter,
            _active: None,
        }
    }
}

impl<T: AsyncRead + Unpin> AsyncRead for MeteredIo<T> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buf.filled().len();
        let result = Pin::new(&mut self.inner).poll_read(cx, buf);
        self.counter.received(buf.filled().len() - before);
        result
    }
}

impl<T: AsyncWrite + Unpin> AsyncWrite for MeteredIo<T> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let result = Pin::new(&mut self.inner).poll_write(cx, buf);
        if let Poll::Ready(Ok(n)) = result {
            self.counter.sent(n);
        }
        result
    }

    // tokio's defaults would report a non-vectored stream and write only the
    // first buffer, which turns hyper and rustls batching into one copy or one
    // record per call.
    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        let result = Pin::new(&mut self.inner).poll_write_vectored(cx, bufs);
        if let Poll::Ready(Ok(n)) = result {
            self.counter.sent(n);
        }
        result
    }

    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn counts_successful_bytes_and_releases_on_drop() {
        static COUNTER: Counter = Counter::new();
        let (a, mut b) = tokio::io::duplex(64);
        let mut a = MeteredIo::new(a, &COUNTER);
        a.write_all(b"abc").await.unwrap();
        let mut bytes = [0; 3];
        b.read_exact(&mut bytes).await.unwrap();
        assert_eq!(&bytes, b"abc");
        b.write_all(b"xy").await.unwrap();
        a.read_exact(&mut bytes[..2]).await.unwrap();
        assert_eq!(COUNTER.snapshot().active, 1);
        drop(a);
        let sample = COUNTER.snapshot();
        assert_eq!(
            (
                sample.active,
                sample.opened,
                sample.received_bytes,
                sample.sent_bytes
            ),
            (0, 1, 2, 3)
        );
    }

    /// A transport that takes every buffer of a vectored write in one call.
    #[derive(Default)]
    struct VectoredSink(Vec<u8>);

    impl AsyncWrite for VectoredSink {
        fn poll_write(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            buf: &[u8],
        ) -> Poll<io::Result<usize>> {
            self.get_mut().0.extend_from_slice(buf);
            Poll::Ready(Ok(buf.len()))
        }

        fn poll_write_vectored(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            bufs: &[io::IoSlice<'_>],
        ) -> Poll<io::Result<usize>> {
            let sink = self.get_mut();
            for buf in bufs {
                sink.0.extend_from_slice(buf);
            }
            Poll::Ready(Ok(bufs.iter().map(|buf| buf.len()).sum()))
        }

        fn is_write_vectored(&self) -> bool {
            true
        }

        fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }

        fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn vectored_writes_reach_the_inner_stream_whole_and_counted() {
        static COUNTER: Counter = Counter::new();
        let mut io = MeteredIo::new(VectoredSink::default(), &COUNTER);
        assert!(io.is_write_vectored(), "the wrapper hides vectored writes");
        let written = io
            .write_vectored(&[io::IoSlice::new(&[1; 100]), io::IoSlice::new(&[2; 100])])
            .await
            .unwrap();
        assert_eq!(written, 200, "one call carries both buffers");
        assert_eq!(io.inner.0.len(), 200);
        assert_eq!(COUNTER.snapshot().sent_bytes, 200);
    }

    #[tokio::test]
    async fn split_halves_count_bytes_and_leave_the_active_count_to_their_owner() {
        static COUNTER: Counter = Counter::new();
        let (a, mut b) = tokio::io::duplex(64);
        let (read, write) = tokio::io::split(a);
        let owner = COUNTER.enter();
        let mut read = MeteredIo::half(read, &COUNTER);
        let mut write = MeteredIo::half(write, &COUNTER);
        write.write_all(b"abc").await.unwrap();
        b.write_all(b"xy").await.unwrap();
        let mut bytes = [0; 2];
        read.read_exact(&mut bytes).await.unwrap();
        assert_eq!(COUNTER.snapshot().active, 1);
        drop((read, write));
        assert_eq!(COUNTER.snapshot().active, 1);
        drop(owner);
        let sample = COUNTER.snapshot();
        assert_eq!(
            (
                sample.active,
                sample.opened,
                sample.received_bytes,
                sample.sent_bytes
            ),
            (0, 1, 2, 3)
        );
    }

    #[tokio::test]
    async fn partial_write_cancellation_and_half_close_preserve_exact_totals() {
        use std::future::Future;
        static COUNTER: Counter = Counter::new();
        let (a, mut b) = tokio::io::duplex(1);
        let mut a = MeteredIo::new(a, &COUNTER);
        {
            let write = a.write_all(b"abc");
            tokio::pin!(write);
            let mut cx = Context::from_waker(std::task::Waker::noop());
            assert!(write.as_mut().poll(&mut cx).is_pending());
            assert_eq!(COUNTER.snapshot().sent_bytes, 1);
            // Cancel the pending write after the transport accepted one byte.
        }
        assert_eq!(b.read_u8().await.unwrap(), b'a');
        a.shutdown().await.unwrap();
        assert_eq!(b.read(&mut [0]).await.unwrap(), 0);
        assert_eq!(COUNTER.snapshot().active, 1);
        drop(b);
        assert!(a.write(b"d").await.is_err());
        assert_eq!(COUNTER.snapshot().sent_bytes, 1);
        drop(a);
        assert_eq!(COUNTER.snapshot().active, 0);
    }
}
