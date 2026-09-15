//! Per-tunnel driver task.
//!
//! Owns a `yamux::Connection` for the lifetime of one registered
//! tunnel. Three things share its attention:
//!
//! 1. `OpenRequest` messages from the fronting proxy (via
//!    `TunnelHandle::open`) asking for a new outbound substream. Each
//!    message carries a oneshot reply channel.
//! 2. Inbound substreams from the peer. The protocol does not use
//!    these in v0; we drop them, which yamux turns into a RST on
//!    the next poll.
//! 3. The shutdown signal: the registry's `oneshot::Sender<()>`
//!    being dropped (either because the entry was evicted, or
//!    because deregistration ran). Receiver wakes with an error.
//!
//! All three are merged into one `poll_fn` body so the two
//! reborrows of `&mut conn` happen sequentially within a single
//! poll invocation; `select!` over multiple `poll_fn`s holding
//! `&mut conn` would conflict on the borrow.

use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::Poll;
use std::time::Duration;

use futures::AsyncRead as FutAsyncRead;
use futures::AsyncWrite as FutAsyncWrite;
use tokio::sync::{mpsc, oneshot};
use tokio_util::compat::FuturesAsyncReadCompatExt;
use yamux::Connection as YamuxConnection;

use crate::registry::{OpenRequest, Registry, TunnelHandle};
use crate::{Validated, Validator};

#[cfg(not(test))]
const LEASE_REFRESH_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(test)]
const LEASE_REFRESH_TIMEOUT: Duration = Duration::from_millis(20);

/// Run the driver to completion. Returns when the yamux connection
/// closes, errors, or the shutdown signal fires.
///
/// `handle` is kept alive only so the driver can call
/// `Registry::deregister_if_owner` once it exits. Cloning the
/// handle into the registry beforehand and dropping it here would
/// also remove the entry, but only after the request channel
/// receiver this task owns goes away, which already implies
/// "tunnel is gone" to the public side.
pub(crate) async fn run_tunnel<S>(
    mut conn: YamuxConnection<S>,
    mut open_rx: mpsc::Receiver<OpenRequest>,
    mut shutdown_rx: oneshot::Receiver<()>,
    registry: Arc<Registry>,
    handle: TunnelHandle,
    validator: Arc<dyn Validator>,
    validated: Validated,
) where
    S: FutAsyncRead + FutAsyncWrite + Unpin + Send + 'static,
{
    let mut pending: VecDeque<OpenRequest> = VecDeque::new();
    let mut request_channel_open = true;
    let (refresh_tx, mut refresh_rx) = mpsc::channel(1);
    let mut refresh_pending = false;
    let mut lease_deadline = validated
        .admission_lease_expires_at
        .map(|expires_at| Box::pin(tokio::time::sleep(wall_delay(expires_at))));

    enum Step {
        Inbound(yamux::Stream),
        RefreshFinished(Option<chrono::DateTime<chrono::Utc>>),
        LeaseExpired,
        Shutdown, // shutdown signal or yamux error
    }

    loop {
        let step = futures::future::poll_fn(|cx| {
            // Shutdown takes priority over anything else. Either an
            // explicit `()` send, or the sender being dropped (which
            // is how `Registry::register` evicts the previous tunnel),
            // resolves the receiver.
            if Pin::new(&mut shutdown_rx).poll(cx).is_ready() {
                return Poll::Ready(Step::Shutdown);
            }
            if let Poll::Ready(result) = refresh_rx.poll_recv(cx) {
                refresh_pending = false;
                return Poll::Ready(Step::RefreshFinished(result.flatten()));
            }
            if lease_deadline
                .as_mut()
                .is_some_and(|deadline| deadline.as_mut().poll(cx).is_ready())
            {
                return Poll::Ready(Step::LeaseExpired);
            }

            if request_channel_open {
                loop {
                    match open_rx.poll_recv(cx) {
                        Poll::Ready(Some(reply)) => pending.push_back(reply),
                        Poll::Ready(None) => {
                            request_channel_open = false;
                            break;
                        }
                        Poll::Pending => break,
                    }
                }
            }

            while pending.front().is_some() {
                match Pin::new(&mut conn).poll_new_outbound(cx) {
                    Poll::Ready(Ok(stream)) => {
                        let reply = pending.pop_front().expect("front() said Some");
                        let _ = reply.send(Ok(stream));
                    }
                    Poll::Ready(Err(_)) => return Poll::Ready(Step::Shutdown),
                    Poll::Pending => break,
                }
            }

            match Pin::new(&mut conn).poll_next_inbound(cx) {
                Poll::Ready(Some(Ok(stream))) => Poll::Ready(Step::Inbound(stream)),
                Poll::Ready(Some(Err(_))) | Poll::Ready(None) => Poll::Ready(Step::Shutdown),
                Poll::Pending => Poll::Pending,
            }
        })
        .await;

        match step {
            Step::Inbound(stream) => {
                if refresh_pending {
                    drop(stream);
                    continue;
                }
                let validator = validator.clone();
                let validated = validated.clone();
                let registry = registry.clone();
                let registration_id = handle.registration_id;
                let refresh_tx = refresh_tx.clone();
                refresh_pending = true;
                tokio::spawn(async move {
                    let result = refresh_lease(
                        stream,
                        validator.as_ref(),
                        &validated,
                        &registry,
                        registration_id,
                    )
                    .await
                    .ok();
                    let _ = refresh_tx.send(result).await;
                });
                continue;
            }
            Step::RefreshFinished(Some(expires_at)) => {
                lease_deadline = Some(Box::pin(tokio::time::sleep(wall_delay(expires_at))));
                continue;
            }
            Step::RefreshFinished(None) => continue,
            Step::LeaseExpired => {
                tracing::warn!(registration_id = %handle.registration_id, "admission lease expired; closing tunnel");
                break;
            }
            Step::Shutdown => break,
        }
    }

    // Best-effort yamux close. Errors here only affect the peer's
    // log; we're done either way.
    let _ = futures::future::poll_fn(|cx| Pin::new(&mut conn).poll_close(cx)).await;

    // Tell any open() callers still waiting that we're gone.
    while let Some(reply) = pending.pop_front() {
        let _ = reply.send(Err(crate::registry::OpenError::Disconnected));
    }

    registry.deregister_if_owner(&handle);
}

async fn refresh_lease(
    stream: yamux::Stream,
    validator: &dyn Validator,
    current: &Validated,
    registry: &Registry,
    registration_id: uuid::Uuid,
) -> Result<chrono::DateTime<chrono::Utc>, ()> {
    refresh_lease_timed(
        stream.compat(),
        validator,
        current,
        registry,
        registration_id,
    )
    .await
}

async fn refresh_lease_timed<S>(
    stream: S,
    validator: &dyn Validator,
    current: &Validated,
    registry: &Registry,
    registration_id: uuid::Uuid,
) -> Result<chrono::DateTime<chrono::Utc>, ()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    tokio::time::timeout(
        LEASE_REFRESH_TIMEOUT,
        refresh_lease_inner(stream, validator, current, registry, registration_id),
    )
    .await
    .map_err(|_| ())?
}

async fn refresh_lease_inner(
    mut stream: impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    validator: &dyn Validator,
    current: &Validated,
    registry: &Registry,
    registration_id: uuid::Uuid,
) -> Result<chrono::DateTime<chrono::Utc>, ()> {
    let request: chan_tunnel_proto::LeaseRefreshRequest =
        match chan_tunnel_proto::read_frame(&mut stream).await {
            Ok(request) => request,
            Err(_) => return Err(()),
        };
    if request.token.len() > 1024 {
        let _ = chan_tunnel_proto::write_frame(
            &mut stream,
            &chan_tunnel_proto::LeaseRefreshResponse::Refused {
                message: "token is too long".into(),
            },
        )
        .await;
        return Err(());
    }
    let refreshed = validator
        .validate_registration(&request.token, registration_id)
        .await;
    drop(request);
    let refreshed = match refreshed {
        Ok(refreshed)
            if refreshed.user_id == current.user_id
                && refreshed.username == current.username
                && refreshed.devserver_id == current.devserver_id =>
        {
            refreshed
        }
        _ => {
            let _ = chan_tunnel_proto::write_frame(
                &mut stream,
                &chan_tunnel_proto::LeaseRefreshResponse::Refused {
                    message: "authorization refresh failed".into(),
                },
            )
            .await;
            return Err(());
        }
    };
    let Some(lease) = refreshed.admission_lease.map(Arc::<str>::from) else {
        return Err(());
    };
    let Some(expires_at) = refreshed.admission_lease_expires_at else {
        return Err(());
    };
    if !registry.refresh_admission_lease(registration_id, refreshed.user_id, lease, expires_at) {
        return Err(());
    }
    chan_tunnel_proto::write_frame(
        &mut stream,
        &chan_tunnel_proto::LeaseRefreshResponse::Refreshed,
    )
    .await
    .map_err(|_| ())?;
    Ok(expires_at)
}

fn wall_delay(expires_at: chrono::DateTime<chrono::Utc>) -> Duration {
    expires_at
        .signed_duration_since(chrono::Utc::now())
        .to_std()
        .unwrap_or(Duration::ZERO)
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use futures::AsyncWriteExt;
    use tokio::io::AsyncReadExt;
    use tokio_util::compat::TokioAsyncReadCompatExt;
    use yamux::Mode;

    use crate::registry::MAX_TUNNEL_SUBSTREAMS;

    struct UnexpectedValidator;

    #[async_trait]
    impl Validator for UnexpectedValidator {
        async fn validate(&self, _token: &str) -> Result<Validated, crate::ServerError> {
            panic!("a silent refresh stream must time out before validation")
        }
    }

    #[tokio::test]
    async fn silent_refresh_has_one_absolute_deadline() {
        let (_peer, stream) = tokio::io::duplex(1024);
        let current = Validated {
            user_id: uuid::Uuid::new_v4(),
            username: "alice".into(),
            devserver_id: "devserver".into(),
            scopes: vec!["tunnel".into()],
            gateway_assertion_key: None,
            admission_lease: Some("old".into()),
            admission_lease_expires_at: Some(chrono::Utc::now() + chrono::Duration::minutes(5)),
        };
        let started = tokio::time::Instant::now();
        assert!(refresh_lease_timed(
            stream,
            &UnexpectedValidator,
            &current,
            &Registry::new(),
            uuid::Uuid::new_v4(),
        )
        .await
        .is_err());
        assert!(started.elapsed() >= LEASE_REFRESH_TIMEOUT);
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    /// Drive one registered tunnel whose peer only drains the socket.
    /// That is enough for `poll_new_outbound`: yamux creates the
    /// stream from its own accounting, without waiting for the peer.
    fn spawn_tunnel() -> (Arc<Registry>, TunnelHandle) {
        let (server_io, mut peer_io) = tokio::io::duplex(1024 * 1024);
        tokio::spawn(async move {
            let mut buf = vec![0u8; 64 * 1024];
            while peer_io.read(&mut buf).await.unwrap_or(0) > 0 {}
        });
        let conn = yamux::Connection::new(
            server_io.compat(),
            crate::tunnel_yamux_config(),
            Mode::Server,
        );
        let registry = Registry::new();
        let (handle, open_rx, shutdown_rx) = registry
            .register_with_cap("alice".into(), "ds".into(), None, None, 0)
            .expect("register");
        let validated = Validated {
            user_id: uuid::Uuid::new_v4(),
            username: "alice".into(),
            devserver_id: "ds".into(),
            scopes: vec!["tunnel".into()],
            gateway_assertion_key: None,
            admission_lease: None,
            admission_lease_expires_at: None,
        };
        tokio::spawn(run_tunnel(
            conn,
            open_rx,
            shutdown_rx,
            registry.clone(),
            handle.clone(),
            Arc::new(UnexpectedValidator),
            validated,
        ));
        (registry, handle)
    }

    /// An open past the substream budget is one caller's problem. It
    /// waits for a slot; the tunnel stays registered and every
    /// substream already open stays usable. Asking yamux for a stream
    /// past `TUNNEL_YAMUX_MAX_STREAMS` instead returns an error that
    /// has already put the connection into cleanup, which takes the
    /// whole session and all its substreams down with it.
    #[tokio::test]
    async fn an_open_past_the_substream_budget_waits_instead_of_killing_the_tunnel() {
        let (registry, handle) = spawn_tunnel();

        let mut streams = Vec::new();
        for i in 0..MAX_TUNNEL_SUBSTREAMS {
            let stream = tokio::time::timeout(Duration::from_secs(10), handle.open())
                .await
                .unwrap_or_else(|_| panic!("open {i} timed out"))
                .unwrap_or_else(|e| panic!("open {i} failed: {e}"));
            streams.push(stream);
        }

        // One past the budget: the caller waits (its own deadline
        // bounds that), and nothing else on the tunnel notices.
        let extra = tokio::time::timeout(Duration::from_millis(250), handle.open()).await;
        assert!(
            extra.is_err(),
            "an open past the budget must wait for a slot",
        );
        assert!(
            registry.get("alice", "ds").is_some(),
            "the tunnel was torn down by one refused open",
        );
        tokio::time::timeout(Duration::from_secs(10), streams[0].write_all(b"ping"))
            .await
            .expect("write timed out")
            .expect("substreams opened earlier must still be usable");

        // And the slot really does come back: a caller parked on the
        // budget is served once a substream closes.
        let waiting = tokio::spawn({
            let handle = handle.clone();
            async move { handle.open().await }
        });
        tokio::task::yield_now().await;
        streams.pop();
        let served = tokio::time::timeout(Duration::from_secs(10), waiting)
            .await
            .expect("the parked open was never served")
            .expect("open task panicked");
        assert!(served.is_ok(), "parked open failed: {:?}", served.err());
    }
}
