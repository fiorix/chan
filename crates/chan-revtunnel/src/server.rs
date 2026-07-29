//! Devserver-side registry: what a tunnel is while it exists.
//!
//! A registration lives exactly as long as the foreground `cs tunnel` that
//! created it. The control-socket handler holds a [`Registration`]; its guard
//! drop is the single teardown path, so every way that handler can end (a
//! clean Ctrl-C, a killed client, a panic unwinding the task) closes the
//! tunnel the same way. Nothing here is persisted: a devserver restart takes
//! every tunnel with it, which is the same lifetime the terminals themselves
//! have.
//!
//! ## Unbounded by design, for now
//!
//! Neither the number of live tunnels nor the number of connections one tunnel
//! carries is capped, and the bytes are unmetered. A busy tunnel therefore
//! competes with the session that opened it, which is worth knowing before
//! pushing bulk traffic through one:
//!
//! - On a gateway-attached devserver every data socket is one more yamux
//!   substream on the SAME h2 session that carries the terminal's own
//!   WebSocket, so tunnel traffic contends for that session's flow-control
//!   window directly against the terminal. The session admits 256 substreams
//!   and the devserver serves 128 concurrent inbound, so enough tunnel
//!   connections can also starve ordinary requests.
//! - On both ends the bridges run on the same tokio runtime as the rest of the
//!   process: the devserver's PTY and watcher work, and the desktop's window
//!   feeds and IPC.
//!
//! TODO: cap live tunnels and per-tunnel connections here, where a tunnel is
//! admitted, and account the bytes a tunnel moves.
//!
//! ## A dropped control socket is fatal, which the gateway path outgrows
//!
//! Losing the control socket fails the blocked `cs tunnel` immediately. That
//! matches a directly attached desktop, where the socket drops only if the
//! desktop really went away. It does not match a gateway-attached one: those
//! browser sessions expire absolutely (an hour at most) and are revocable, and
//! the proxy force-closes bridged WebSockets on both, so a long-lived gateway
//! tunnel dies mid-flight through no fault of either end.
//!
//! TODO: hold a registration through a grace window instead of failing at
//! once, and let the desktop redial by tunnel id to resume it. That makes the
//! tunnel id a resumable credential, so it lands with the authority question
//! on the routes (see `require_tunnel_owner` in chan-server), not before it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::sync::{oneshot, watch};

use crate::spec::TunnelSpec;

/// What the desktop reported when it answered the trigger.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadyReport {
    /// The listener is up at this authority (already resolved, so a port-0
    /// request reads back as the port the OS picked).
    Ready { bound: String },
    /// The listener never came up.
    Failed { message: String },
}

#[derive(Debug)]
struct Entry {
    devserver_port: u16,
    /// Fires once, when the desktop's control socket sends its first frame.
    ready_tx: Option<oneshot::Sender<ReadyReport>>,
    /// Fires when a control socket that had attached goes away, so a blocked
    /// `cs tunnel` learns its desktop died instead of hanging.
    gone_tx: Option<oneshot::Sender<()>>,
    /// Set when the registration is dropped: the control socket observes this
    /// and sends a `Close` frame before hanging up.
    close_tx: watch::Sender<Option<String>>,
    /// A control socket is currently attached. Guards against a second desktop
    /// racing onto the same tunnel id.
    control_attached: bool,
    /// The desktop answered `Ready`, so data sockets may now attach.
    live: bool,
}

/// All tunnels a devserver process is currently serving.
#[derive(Debug, Default)]
pub struct TunnelRegistry {
    inner: Mutex<HashMap<String, Entry>>,
}

/// The control-socket handler's handle on one tunnel. Dropping it deregisters
/// the tunnel and signals any attached control socket to close.
#[derive(Debug)]
pub struct Registration {
    pub tunnel_id: String,
    /// Resolves when the desktop answers the trigger.
    pub ready: oneshot::Receiver<ReadyReport>,
    /// Resolves if an attached desktop later disappears.
    pub desktop_gone: oneshot::Receiver<()>,
    registry: Arc<TunnelRegistry>,
}

impl Drop for Registration {
    fn drop(&mut self) {
        self.registry.deregister(&self.tunnel_id);
    }
}

/// A control socket's view of its tunnel: watch for the close signal, report
/// the desktop's first frame, and deregister on the way out.
#[derive(Debug)]
pub struct ControlAttach {
    pub tunnel_id: String,
    /// Yields `Some(reason)` when the foreground command ended.
    pub close: watch::Receiver<Option<String>>,
    registry: Arc<TunnelRegistry>,
    detached: bool,
}

impl ControlAttach {
    /// Record the desktop's first frame. Returns false when the tunnel is
    /// already gone or already answered.
    pub fn report(&self, report: ReadyReport) -> bool {
        self.registry.report(&self.tunnel_id, report)
    }

    /// Detach cleanly: the socket closed because the tunnel ended, so the
    /// blocked `cs` must NOT be told its desktop died.
    pub fn detach_quietly(mut self) {
        self.detached = true;
        self.registry.detach_control(&self.tunnel_id, false);
    }
}

impl Drop for ControlAttach {
    fn drop(&mut self) {
        if !self.detached {
            self.registry.detach_control(&self.tunnel_id, true);
        }
    }
}

/// Why a control or data socket could not attach. These are the refusals the
/// route turns into HTTP statuses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachError {
    /// No such tunnel: never registered, or its `cs tunnel` already ended.
    Unknown,
    /// A control socket is already attached to this tunnel.
    AlreadyAttached,
    /// A data socket arrived before the desktop reported a live listener.
    NotLive,
}

impl std::fmt::Display for AttachError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            AttachError::Unknown => "no such tunnel",
            AttachError::AlreadyAttached => "tunnel already has a control connection",
            AttachError::NotLive => "tunnel is not live",
        })
    }
}

impl TunnelRegistry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Register `tunnel_id` for `spec`. The caller mints the id and must make
    /// it unguessable: it is the only thing naming this tunnel on the two
    /// WebSocket paths.
    pub fn register(
        self: &Arc<Self>,
        tunnel_id: impl Into<String>,
        spec: &TunnelSpec,
    ) -> Registration {
        let tunnel_id = tunnel_id.into();
        let (ready_tx, ready) = oneshot::channel();
        let (gone_tx, desktop_gone) = oneshot::channel();
        let (close_tx, _close_rx) = watch::channel(None);
        self.inner.lock().expect("tunnel registry poisoned").insert(
            tunnel_id.clone(),
            Entry {
                devserver_port: spec.devserver_port,
                ready_tx: Some(ready_tx),
                gone_tx: Some(gone_tx),
                close_tx,
                control_attached: false,
                live: false,
            },
        );
        Registration {
            tunnel_id,
            ready,
            desktop_gone,
            registry: self.clone(),
        }
    }

    /// Attach the one control socket a tunnel may have.
    pub fn attach_control(self: &Arc<Self>, tunnel_id: &str) -> Result<ControlAttach, AttachError> {
        let mut map = self.inner.lock().expect("tunnel registry poisoned");
        let entry = map.get_mut(tunnel_id).ok_or(AttachError::Unknown)?;
        if entry.control_attached {
            return Err(AttachError::AlreadyAttached);
        }
        entry.control_attached = true;
        Ok(ControlAttach {
            tunnel_id: tunnel_id.to_string(),
            close: entry.close_tx.subscribe(),
            registry: self.clone(),
            detached: false,
        })
    }

    /// The port a data socket for this tunnel should dial on loopback. `Err`
    /// when the tunnel is unknown or has not reported a live listener, so a
    /// stale or forged id never causes a dial.
    pub fn dial_port(&self, tunnel_id: &str) -> Result<u16, AttachError> {
        let map = self.inner.lock().expect("tunnel registry poisoned");
        let entry = map.get(tunnel_id).ok_or(AttachError::Unknown)?;
        if !entry.live {
            return Err(AttachError::NotLive);
        }
        Ok(entry.devserver_port)
    }

    pub fn len(&self) -> usize {
        self.inner.lock().expect("tunnel registry poisoned").len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn report(&self, tunnel_id: &str, report: ReadyReport) -> bool {
        let mut map = self.inner.lock().expect("tunnel registry poisoned");
        let Some(entry) = map.get_mut(tunnel_id) else {
            return false;
        };
        let Some(tx) = entry.ready_tx.take() else {
            return false;
        };
        if matches!(report, ReadyReport::Ready { .. }) {
            entry.live = true;
        }
        tx.send(report).is_ok()
    }

    fn detach_control(&self, tunnel_id: &str, notify_gone: bool) {
        let mut map = self.inner.lock().expect("tunnel registry poisoned");
        let Some(entry) = map.get_mut(tunnel_id) else {
            return;
        };
        entry.control_attached = false;
        entry.live = false;
        if notify_gone {
            if let Some(tx) = entry.gone_tx.take() {
                let _ = tx.send(());
            }
        }
    }

    fn deregister(&self, tunnel_id: &str) {
        let entry = self
            .inner
            .lock()
            .expect("tunnel registry poisoned")
            .remove(tunnel_id);
        if let Some(entry) = entry {
            // Wake the control socket so it can send a Close frame. The
            // receiver may already be gone; that just means the desktop went
            // first.
            let _ = entry.close_tx.send(Some(
                crate::wire::TunnelEnd::ClientGone
                    .close_reason()
                    .to_string(),
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spec::{parse_spec, Proto};

    fn spec() -> TunnelSpec {
        parse_spec("8080:3000", Proto::Tcp).unwrap()
    }

    #[tokio::test]
    async fn a_ready_report_unblocks_the_waiter_and_opens_the_data_path() {
        let registry = TunnelRegistry::new();
        let mut reg = registry.register("tun-1", &spec());
        // Before the desktop answers, a data socket must not cause a dial.
        assert_eq!(registry.dial_port("tun-1"), Err(AttachError::NotLive));

        let attach = registry.attach_control("tun-1").unwrap();
        assert!(attach.report(ReadyReport::Ready {
            bound: "127.0.0.1:8080".into()
        }));
        assert_eq!(
            reg.ready.try_recv().unwrap(),
            ReadyReport::Ready {
                bound: "127.0.0.1:8080".into()
            }
        );
        assert_eq!(registry.dial_port("tun-1"), Ok(3000));
    }

    #[tokio::test]
    async fn a_failed_report_never_opens_the_data_path() {
        let registry = TunnelRegistry::new();
        let mut reg = registry.register("tun-2", &spec());
        let attach = registry.attach_control("tun-2").unwrap();
        assert!(attach.report(ReadyReport::Failed {
            message: "address already in use".into()
        }));
        assert!(matches!(
            reg.ready.try_recv().unwrap(),
            ReadyReport::Failed { .. }
        ));
        assert_eq!(registry.dial_port("tun-2"), Err(AttachError::NotLive));
    }

    #[tokio::test]
    async fn dropping_the_registration_closes_the_control_socket_and_forgets_the_tunnel() {
        let registry = TunnelRegistry::new();
        let reg = registry.register("tun-3", &spec());
        let mut attach = registry.attach_control("tun-3").unwrap();
        assert_eq!(registry.len(), 1);

        drop(reg);
        attach.close.changed().await.unwrap();
        assert_eq!(
            attach.close.borrow().clone(),
            Some("cs tunnel exited".to_string())
        );
        assert!(registry.is_empty());
        assert_eq!(registry.dial_port("tun-3"), Err(AttachError::Unknown));
    }

    #[tokio::test]
    async fn a_dropped_control_socket_tells_the_blocked_command_its_desktop_died() {
        let registry = TunnelRegistry::new();
        let mut reg = registry.register("tun-4", &spec());
        let attach = registry.attach_control("tun-4").unwrap();
        attach.report(ReadyReport::Ready {
            bound: "127.0.0.1:8080".into(),
        });
        drop(attach);

        reg.desktop_gone.try_recv().expect("desktop-gone fired");
        // The data path closes with it: a reconnecting desktop must re-report.
        assert_eq!(registry.dial_port("tun-4"), Err(AttachError::NotLive));
    }

    #[tokio::test]
    async fn an_orderly_detach_does_not_report_the_desktop_as_dead() {
        let registry = TunnelRegistry::new();
        let mut reg = registry.register("tun-5", &spec());
        let attach = registry.attach_control("tun-5").unwrap();
        attach.detach_quietly();
        assert!(reg.desktop_gone.try_recv().is_err());
    }

    #[test]
    fn only_one_control_socket_may_attach() {
        let registry = TunnelRegistry::new();
        let _reg = registry.register("tun-6", &spec());
        let _first = registry.attach_control("tun-6").unwrap();
        assert_eq!(
            registry.attach_control("tun-6").unwrap_err(),
            AttachError::AlreadyAttached
        );
    }

    #[test]
    fn an_unknown_tunnel_id_attaches_to_nothing() {
        let registry = TunnelRegistry::new();
        assert_eq!(
            registry.attach_control("tun-nope").unwrap_err(),
            AttachError::Unknown
        );
        assert_eq!(registry.dial_port("tun-nope"), Err(AttachError::Unknown));
    }

    #[test]
    fn a_detached_control_socket_frees_the_slot_for_a_reconnect() {
        let registry = TunnelRegistry::new();
        let _reg = registry.register("tun-7", &spec());
        let first = registry.attach_control("tun-7").unwrap();
        drop(first);
        assert!(registry.attach_control("tun-7").is_ok());
    }
}
