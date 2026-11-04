//! TCP connections through the tunnel as tokio streams.
//!
//! A stream is a handle to one socket in the shared stack. Each operation
//! locks the stack briefly, copies bytes into or out of the socket's
//! buffer, and either returns or leaves its waker with the socket. The
//! lock makes the check and the registration one step, so a state change
//! between them cannot be missed. Backpressure is the socket's own
//! buffers: a full transmit buffer parks the writer, an empty receive
//! buffer parks the reader, and the driver wakes whichever the next poll
//! moves.

use std::future::Future;
use std::io;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use smoltcp::iface::SocketHandle;
use smoltcp::socket::tcp;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

use crate::stack::Shared;

/// Listening sockets a listener keeps open at once, so SYNs arriving
/// together each find one.
pub(crate) const BACKLOG: usize = 4;

fn tunnel_closed() -> io::Error {
    io::Error::new(io::ErrorKind::ConnectionAborted, "the tunnel is closed")
}

/// A TCP connection carried by the tunnel.
///
/// Reads return 0 once the peer closed its side; a reset after
/// establishment reads as `ConnectionReset`. Writes fail with
/// `BrokenPipe` once the peer is gone. Shutdown sends the FIN after the
/// queued bytes and returns at once. Dropping the stream closes it, and
/// data the reader never took out is answered with a reset, as an OS
/// socket does.
pub struct Stream {
    shared: Arc<Shared>,
    handle: SocketHandle,
    local: SocketAddr,
    peer: SocketAddr,
}

impl Stream {
    pub(crate) fn new(
        shared: Arc<Shared>,
        handle: SocketHandle,
        local: SocketAddr,
        peer: SocketAddr,
    ) -> Self {
        Self {
            shared,
            handle,
            local,
            peer,
        }
    }

    /// The tunnel address and port this side speaks from.
    pub fn local_addr(&self) -> SocketAddr {
        self.local
    }

    /// The address and port at the other end.
    pub fn peer_addr(&self) -> SocketAddr {
        self.peer
    }
}

impl AsyncRead for Stream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let chunk = buf.initialize_unfilled();
        if chunk.is_empty() {
            return Poll::Ready(Ok(()));
        }
        let mut stack = self.shared.stack.lock();
        if stack.closed {
            return Poll::Ready(Err(tunnel_closed()));
        }
        let socket = stack.sockets.get_mut::<tcp::Socket>(self.handle);
        match socket.recv_slice(chunk) {
            Ok(0) => {
                socket.register_recv_waker(cx.waker());
                Poll::Pending
            }
            Ok(n) => {
                buf.advance(n);
                drop(stack);
                // The window just grew; a poll sends the update so a peer
                // waiting on a full window does not sit until the tick.
                self.shared.kick();
                Poll::Ready(Ok(()))
            }
            Err(tcp::RecvError::Finished) => Poll::Ready(Ok(())),
            Err(tcp::RecvError::InvalidState) => Poll::Ready(Err(io::Error::new(
                io::ErrorKind::ConnectionReset,
                "connection reset by peer",
            ))),
        }
    }
}

impl AsyncWrite for Stream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        data: &[u8],
    ) -> Poll<io::Result<usize>> {
        if data.is_empty() {
            return Poll::Ready(Ok(0));
        }
        let mut stack = self.shared.stack.lock();
        if stack.closed {
            return Poll::Ready(Err(tunnel_closed()));
        }
        let socket = stack.sockets.get_mut::<tcp::Socket>(self.handle);
        match socket.send_slice(data) {
            Ok(0) => {
                socket.register_send_waker(cx.waker());
                Poll::Pending
            }
            Ok(n) => {
                drop(stack);
                self.shared.kick();
                Poll::Ready(Ok(n))
            }
            Err(tcp::SendError::InvalidState) => Poll::Ready(Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "the peer closed the connection",
            ))),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        // Bytes leave at the driver's next poll; waiting for the peer's
        // acknowledgement here would add a round trip to every flush, and
        // an OS socket's flush does not wait either.
        self.shared.kick();
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let mut stack = self.shared.stack.lock();
        if stack.closed {
            return Poll::Ready(Err(tunnel_closed()));
        }
        stack.sockets.get_mut::<tcp::Socket>(self.handle).close();
        drop(stack);
        self.shared.kick();
        Poll::Ready(Ok(()))
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        let mut stack = self.shared.stack.lock();
        if stack.closed {
            return;
        }
        let socket = stack.sockets.get_mut::<tcp::Socket>(self.handle);
        if socket.can_recv() {
            socket.abort();
        } else {
            socket.close();
        }
        stack.release(self.handle);
        drop(stack);
        self.shared.kick();
    }
}

impl std::fmt::Debug for Stream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Stream")
            .field("local", &self.local)
            .field("peer", &self.peer)
            .finish()
    }
}

/// A pending connection: resolves once the handshake completes, refuses
/// on a reset, and takes the half-open socket down with it when dropped.
pub(crate) struct Connecting {
    stream: Option<Stream>,
}

impl Connecting {
    pub(crate) fn new(stream: Stream) -> Self {
        Self {
            stream: Some(stream),
        }
    }
}

impl Future for Connecting {
    type Output = io::Result<Stream>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let stream = self
            .stream
            .as_ref()
            .expect("a connect future is not polled after it resolved");
        let mut stack = stream.shared.stack.lock();
        if stack.closed {
            return Poll::Ready(Err(tunnel_closed()));
        }
        let socket = stack.sockets.get_mut::<tcp::Socket>(stream.handle);
        match socket.state() {
            tcp::State::SynSent | tcp::State::SynReceived => {
                socket.register_send_waker(cx.waker());
                Poll::Pending
            }
            // The stack leaves SYN-SENT for CLOSED only on the peer's
            // reset. The stream inside is dropped with this future, which
            // releases the socket.
            tcp::State::Closed => Poll::Ready(Err(io::Error::new(
                io::ErrorKind::ConnectionRefused,
                "connection refused",
            ))),
            _ => {
                drop(stack);
                Poll::Ready(Ok(self.stream.take().expect("checked above")))
            }
        }
    }
}

/// Accepts connections the peer opens to a port on the tunnel.
pub struct Listener {
    shared: Arc<Shared>,
    port: u16,
    handles: Vec<SocketHandle>,
}

impl Listener {
    pub(crate) fn new(shared: Arc<Shared>, port: u16, handles: Vec<SocketHandle>) -> Self {
        Self {
            shared,
            port,
            handles,
        }
    }

    /// The port the listener answers on, at every tunnel address.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// The next established connection. One accept runs at a time.
    pub async fn accept(&mut self) -> io::Result<Stream> {
        std::future::poll_fn(|cx| self.poll_accept(cx)).await
    }

    fn poll_accept(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<Stream>> {
        let mut stack = self.shared.stack.lock();
        if stack.closed {
            return Poll::Ready(Err(tunnel_closed()));
        }
        for slot in &mut self.handles {
            let socket = stack.sockets.get_mut::<tcp::Socket>(*slot);
            match socket.state() {
                tcp::State::Listen | tcp::State::SynReceived => {
                    socket.register_recv_waker(cx.waker());
                }
                // A connection that was reset before it was accepted, or
                // one the stack gave up on; listen again.
                tcp::State::Closed => {
                    if let Err(e) = socket.listen(self.port) {
                        return Poll::Ready(Err(io::Error::new(
                            io::ErrorKind::InvalidInput,
                            e.to_string(),
                        )));
                    }
                    socket.register_recv_waker(cx.waker());
                }
                _ => {
                    let (Some(local), Some(peer)) =
                        (socket.local_endpoint(), socket.remote_endpoint())
                    else {
                        continue;
                    };
                    let accepted = *slot;
                    *slot = stack.add_listening(self.port)?;
                    drop(stack);
                    return Poll::Ready(Ok(Stream::new(
                        self.shared.clone(),
                        accepted,
                        local.into(),
                        peer.into(),
                    )));
                }
            }
        }
        Poll::Pending
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        let mut stack = self.shared.stack.lock();
        if stack.closed {
            return;
        }
        for &handle in &self.handles {
            stack.sockets.get_mut::<tcp::Socket>(handle).abort();
            stack.release(handle);
        }
        drop(stack);
        self.shared.kick();
    }
}

impl std::fmt::Debug for Listener {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Listener")
            .field("port", &self.port)
            .finish()
    }
}
