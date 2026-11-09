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

/// An active resource. Dropping it removes exactly one active count.
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

/// Count successful I/O and hold the active guard as long as the I/O exists.
pub struct MeteredIo<T> {
    inner: T,
    guard: Guard<'static>,
}

impl<T> MeteredIo<T> {
    pub fn new(inner: T, counter: &'static Counter) -> Self {
        Self {
            inner,
            guard: counter.enter(),
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
        self.guard.0.received(buf.filled().len() - before);
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
            self.guard.0.sent(n);
        }
        result
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
