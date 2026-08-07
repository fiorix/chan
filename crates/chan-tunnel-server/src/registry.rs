//! Live tunnel registry keyed by `(user, workspace)`.
//!
//! A registered tunnel exposes one operation: open a fresh
//! outbound yamux substream against the connected `chan devserver`
//! peer. The actual yamux `Connection` is owned by a per-tunnel
//! driver task; the registry only stores a `TunnelHandle` that
//! sends open requests over an mpsc channel.
//!
//! Collision policy: last-writer-wins. When `register` finds an
//! existing entry, it drops the old one. The old driver task sees
//! its shutdown signal and closes its yamux connection, which
//! tears down the underlying h2 stream; the disconnected peer is
//! free to reconnect (with backoff) but will boot whoever is
//! currently registered. This matches a chan-serve restart
//! reclaiming its workspace without waiting for a TCP timeout.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use chan_tunnel_proto::gateway_assertion::AssertionKey;
use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use tokio::sync::{broadcast, mpsc, oneshot};
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum OpenError {
    #[error("tunnel disconnected")]
    Disconnected,
}

/// Returned by `Registry::register_checked` when registering would
/// take the user over the per-user workspace cap. Carries the username
/// and the cap so the listener can log / report context.
#[derive(Debug, thiserror::Error)]
#[error("user {user} reached max concurrent workspaces ({max})")]
pub struct RegisterCapped {
    pub user: String,
    pub max: usize,
}

/// One row of `Registry::list_workspaces_for`. Pairs the workspace name
/// with the peer address and connection time so admin tools can render a
/// `ps`-like view without piggybacking on the handshake.
#[derive(Debug, Clone)]
pub struct WorkspaceInfo {
    pub workspace: Arc<str>,
    pub peer_addr: Option<SocketAddr>,
    pub connected_at: DateTime<Utc>,
}

/// One row of `Registry::list_all`. Same as `WorkspaceInfo` but also
/// carries the username so a single call covers the admin
/// `tunnel ps` view.
#[derive(Clone)]
pub struct TunnelInfo {
    pub registration_id: Uuid,
    pub owner_user_id: Uuid,
    pub user: Arc<str>,
    pub workspace: Arc<str>,
    pub admission_lease: Option<Arc<str>>,
    pub admission_lease_expires_at: Option<DateTime<Utc>>,
    pub peer_addr: Option<SocketAddr>,
    pub connected_at: DateTime<Utc>,
}

impl std::fmt::Debug for TunnelInfo {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TunnelInfo")
            .field("registration_id", &self.registration_id)
            .field("owner_user_id", &self.owner_user_id)
            .field("user", &self.user)
            .field("workspace", &self.workspace)
            .field(
                "admission_lease",
                &self.admission_lease.as_ref().map(|_| "[REDACTED]"),
            )
            .field(
                "admission_lease_expires_at",
                &self.admission_lease_expires_at,
            )
            .field("peer_addr", &self.peer_addr)
            .field("connected_at", &self.connected_at)
            .finish()
    }
}

#[derive(Clone)]
pub enum RegistryEvent {
    TunnelUp {
        generation: u64,
        row: TunnelInfo,
    },
    TunnelDown {
        generation: u64,
        registration_id: Uuid,
    },
    LeaseRefresh {
        registration_id: Uuid,
        owner_user_id: Uuid,
        admission_lease: Arc<str>,
        admission_lease_expires_at: DateTime<Utc>,
    },
}

impl std::fmt::Debug for RegistryEvent {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TunnelUp { generation, row } => formatter
                .debug_struct("TunnelUp")
                .field("generation", generation)
                .field("row", row)
                .finish(),
            Self::TunnelDown {
                generation,
                registration_id,
            } => formatter
                .debug_struct("TunnelDown")
                .field("generation", generation)
                .field("registration_id", registration_id)
                .finish(),
            Self::LeaseRefresh {
                registration_id,
                owner_user_id,
                admission_lease: _,
                admission_lease_expires_at,
            } => formatter
                .debug_struct("LeaseRefresh")
                .field("registration_id", registration_id)
                .field("owner_user_id", owner_user_id)
                .field("admission_lease", &"[REDACTED]")
                .field("admission_lease_expires_at", admission_lease_expires_at)
                .finish(),
        }
    }
}

pub(crate) type OpenReply = oneshot::Sender<Result<yamux::Stream, OpenError>>;

/// Sent through `TunnelHandle::open_tx` to ask the per-tunnel
/// driver to allocate a new outbound substream.
pub(crate) type OpenRequest = OpenReply;

/// A handle to a live tunnel. Cheap to clone; the underlying
/// channel is shared. Clones don't keep the tunnel alive on their
/// own: when the registry entry is replaced or removed, the
/// driver's shutdown signal fires, the yamux connection closes,
/// and subsequent `open()` calls return `OpenError::Disconnected`.
#[derive(Clone)]
pub struct TunnelHandle {
    open_tx: mpsc::Sender<OpenRequest>,
    pub registration_id: Uuid,
    pub owner_user_id: Uuid,
    pub user: Arc<str>,
    pub workspace: Arc<str>,
    /// Peer's TCP address as seen by the listener accept loop.
    /// `None` when the registration didn't go through the listener
    /// path (mainly tests).
    pub peer_addr: Option<SocketAddr>,
    /// Wall-clock time at which the tunnel was registered. Used by
    /// admin tools to render uptime; not load-bearing for routing.
    pub connected_at: DateTime<Utc>,
    /// Shared only between the tunnel client and gateway proxy for this
    /// registration. Not surfaced in admin views.
    pub gateway_assertion_key: Option<AssertionKey>,
    pub admission_lease: Option<Arc<str>>,
    pub admission_lease_expires_at: Option<DateTime<Utc>>,
}

impl TunnelHandle {
    pub async fn open(&self) -> Result<yamux::Stream, OpenError> {
        let (tx, rx) = oneshot::channel();
        if self.open_tx.send(tx).await.is_err() {
            return Err(OpenError::Disconnected);
        }
        rx.await.map_err(|_| OpenError::Disconnected)?
    }
}

struct Entry {
    handle: TunnelHandle,
    /// When this sender is dropped, the per-tunnel driver task's
    /// receiver wakes with a `RecvError`, which it treats as
    /// "you've been evicted; close the yamux connection and
    /// exit". The receiver lives in `driver::workspace_tunnel`.
    _shutdown_tx: oneshot::Sender<()>,
}

/// Two-level map keyed `user -> workspace -> Entry`. The split lets
/// `get(&str, &str)` resolve the hash via `Arc<str>: Borrow<str>`
/// without allocating fresh `Arc<str>` lookups on every public
/// request, and makes per-user enumeration a direct inner-map
/// iteration instead of a full-table filter.
type UserMap = HashMap<Arc<str>, HashMap<Arc<str>, Entry>>;

struct State {
    users: UserMap,
    generation: u64,
    events: broadcast::Sender<RegistryEvent>,
}

pub struct Registry {
    inner: Mutex<State>,
}

impl Default for Registry {
    fn default() -> Self {
        let (events, _) = broadcast::channel(1024);
        Self {
            inner: Mutex::new(State {
                users: HashMap::new(),
                generation: 0,
                events,
            }),
        }
    }
}

impl Registry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Register a new tunnel and enforce a per-user concurrent-workspace
    /// cap atomically with the insert. `max_workspaces_per_user == 0`
    /// disables the check. The cap is enforced under the same lock
    /// acquisition that performs the eviction + insert, so two
    /// parallel dials from the same user cannot both observe
    /// `count == max - 1` and both succeed.
    ///
    /// Reconnect of a workspace the user already holds is always
    /// allowed: the same-key entry is evicted and replaced, and the
    /// user's workspace count is unchanged.
    #[cfg(test)]
    pub(crate) fn register_with_cap(
        self: &Arc<Self>,
        user: Arc<str>,
        workspace: Arc<str>,
        peer_addr: Option<SocketAddr>,
        gateway_assertion_key: Option<AssertionKey>,
        max_workspaces_per_user: usize,
    ) -> Result<
        (
            TunnelHandle,
            mpsc::Receiver<OpenRequest>,
            oneshot::Receiver<()>,
        ),
        RegisterCapped,
    > {
        self.register_with_id_and_cap(
            user,
            workspace,
            peer_addr,
            gateway_assertion_key,
            Uuid::new_v4(),
            max_workspaces_per_user,
        )
    }

    #[cfg(test)]
    pub(crate) fn register_with_id_and_cap(
        self: &Arc<Self>,
        user: Arc<str>,
        workspace: Arc<str>,
        peer_addr: Option<SocketAddr>,
        gateway_assertion_key: Option<AssertionKey>,
        registration_id: Uuid,
        max_workspaces_per_user: usize,
    ) -> Result<
        (
            TunnelHandle,
            mpsc::Receiver<OpenRequest>,
            oneshot::Receiver<()>,
        ),
        RegisterCapped,
    > {
        self.register_authorized_with_id_and_cap(
            user,
            workspace,
            peer_addr,
            gateway_assertion_key,
            registration_id,
            Uuid::nil(),
            None,
            None,
            max_workspaces_per_user,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn register_authorized_with_id_and_cap(
        self: &Arc<Self>,
        user: Arc<str>,
        workspace: Arc<str>,
        peer_addr: Option<SocketAddr>,
        gateway_assertion_key: Option<AssertionKey>,
        registration_id: Uuid,
        owner_user_id: Uuid,
        admission_lease: Option<Arc<str>>,
        admission_lease_expires_at: Option<DateTime<Utc>>,
        max_workspaces_per_user: usize,
    ) -> Result<
        (
            TunnelHandle,
            mpsc::Receiver<OpenRequest>,
            oneshot::Receiver<()>,
        ),
        RegisterCapped,
    > {
        let (open_tx, open_rx) = mpsc::channel::<OpenRequest>(64);
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let handle = TunnelHandle {
            open_tx,
            registration_id,
            owner_user_id,
            user: user.clone(),
            workspace: workspace.clone(),
            peer_addr,
            connected_at: Utc::now(),
            gateway_assertion_key,
            admission_lease,
            admission_lease_expires_at,
        };
        let entry = Entry {
            handle: handle.clone(),
            _shutdown_tx: shutdown_tx,
        };
        let evicted = {
            let mut g = self.inner.lock();
            let workspaces = g.users.entry(user.clone()).or_default();
            if max_workspaces_per_user > 0
                && !workspaces.contains_key(&workspace)
                && workspaces.len() >= max_workspaces_per_user
            {
                // Clean up the inner map we may have just created
                // via `or_default` so a capped attempt doesn't leave
                // an empty user bucket behind.
                if workspaces.is_empty() {
                    g.users.remove(&user);
                }
                return Err(RegisterCapped {
                    user: user.to_string(),
                    max: max_workspaces_per_user,
                });
            }
            let evicted = workspaces.insert(workspace.clone(), entry);
            if let Some(old) = &evicted {
                g.generation += 1;
                let _ = g.events.send(RegistryEvent::TunnelDown {
                    generation: g.generation,
                    registration_id: old.handle.registration_id,
                });
            }
            g.generation += 1;
            let _ = g.events.send(RegistryEvent::TunnelUp {
                generation: g.generation,
                row: tunnel_info(&handle),
            });
            evicted
        };
        if let Some(old) = evicted {
            // Log the eviction with the prior registration's age so
            // an operator can spot flap (two chan-serve instances
            // fighting over the same workspace name) without having to
            // diff connection counts. The Drop on `old` fires the
            // shutdown signal that tells the previous driver to
            // close its yamux connection.
            let prior_age = Utc::now()
                .signed_duration_since(old.handle.connected_at)
                .num_milliseconds();
            tracing::info!(
                %user,
                %workspace,
                prior_age_ms = prior_age,
                "tunnel registration evicted predecessor",
            );
            drop(old);
        }
        Ok((handle, open_rx, shutdown_rx))
    }

    /// Look up a live tunnel for a public request. Returns `None`
    /// if no tunnel is currently registered for that pair. Both
    /// hashmap lookups borrow `&str` straight through to the
    /// `Arc<str>` keys, so no per-call allocation.
    pub fn get(&self, user: &str, workspace: &str) -> Option<TunnelHandle> {
        let g = self.inner.lock();
        g.users
            .get(user)
            .and_then(|workspaces| workspaces.get(workspace))
            .map(|e| e.handle.clone())
    }

    /// Workspaces currently registered for `user`, sorted by name.
    /// Used by the dashboard to enumerate "workspaces I have online"
    /// without needing a separate metadata service.
    pub fn list_workspaces_for(&self, user: &str) -> Vec<WorkspaceInfo> {
        let g = self.inner.lock();
        let Some(workspaces) = g.users.get(user) else {
            return Vec::new();
        };
        let mut out: Vec<WorkspaceInfo> = workspaces
            .iter()
            .map(|(d, e)| WorkspaceInfo {
                workspace: d.clone(),
                peer_addr: e.handle.peer_addr,
                connected_at: e.handle.connected_at,
            })
            .collect();
        out.sort_by(|a, b| a.workspace.cmp(&b.workspace));
        out
    }

    /// Snapshot every registered tunnel. Sorted by `(user, workspace)`
    /// so the admin `tunnel ps` view is stable across calls.
    pub fn list_all(&self) -> Vec<TunnelInfo> {
        let g = self.inner.lock();
        let mut out: Vec<TunnelInfo> = g
            .users
            .iter()
            .flat_map(|(u, workspaces)| {
                workspaces.iter().map(move |(d, e)| TunnelInfo {
                    registration_id: e.handle.registration_id,
                    owner_user_id: e.handle.owner_user_id,
                    user: u.clone(),
                    workspace: d.clone(),
                    admission_lease: e.handle.admission_lease.clone(),
                    admission_lease_expires_at: e.handle.admission_lease_expires_at,
                    peer_addr: e.handle.peer_addr,
                    connected_at: e.handle.connected_at,
                })
            })
            .collect();
        out.sort_by(|a, b| {
            a.user
                .cmp(&b.user)
                .then_with(|| a.workspace.cmp(&b.workspace))
        });
        out
    }

    /// Force a tunnel offline. Drops the registry entry, which
    /// fires the per-tunnel driver's shutdown signal and tears
    /// down the yamux connection. Returns `true` if a row was
    /// removed, `false` if nothing was registered for the pair.
    pub fn evict(&self, user: &str, workspace: &str) -> bool {
        let mut g = self.inner.lock();
        let Some(workspaces) = g.users.get_mut(user) else {
            return false;
        };
        let removed = workspaces.remove(workspace);
        if workspaces.is_empty() {
            g.users.remove(user);
        }
        if let Some(removed) = removed {
            emit_down(&mut g, removed.handle.registration_id);
            true
        } else {
            false
        }
    }

    /// Remove a registered tunnel only if `handle` is the one
    /// currently stored. Used by the driver task on its own
    /// teardown so it doesn't accidentally evict a successor that
    /// took its slot.
    pub(crate) fn deregister_if_owner(&self, handle: &TunnelHandle) {
        let mut g = self.inner.lock();
        let Some(workspaces) = g.users.get_mut(handle.user.as_ref()) else {
            return;
        };
        let should_remove = workspaces
            .get(handle.workspace.as_ref())
            .map(|entry| entry.handle.registration_id == handle.registration_id)
            .unwrap_or(false);
        if should_remove {
            workspaces.remove(handle.workspace.as_ref());
            if workspaces.is_empty() {
                g.users.remove(handle.user.as_ref());
            }
            emit_down(&mut g, handle.registration_id);
        }
    }

    pub fn snapshot_and_subscribe(
        &self,
    ) -> (u64, Vec<TunnelInfo>, broadcast::Receiver<RegistryEvent>) {
        let g = self.inner.lock();
        let mut rows = snapshot(&g.users);
        rows.sort_by(|a, b| {
            a.user
                .cmp(&b.user)
                .then_with(|| a.workspace.cmp(&b.workspace))
        });
        (g.generation, rows, g.events.subscribe())
    }

    pub fn evict_registration(&self, registration_id: Uuid) -> bool {
        let mut g = self.inner.lock();
        let key = g.users.iter().find_map(|(user, workspaces)| {
            workspaces.iter().find_map(|(workspace, entry)| {
                (entry.handle.registration_id == registration_id)
                    .then(|| (user.clone(), workspace.clone()))
            })
        });
        let Some((user, workspace)) = key else {
            return false;
        };
        let workspaces = g.users.get_mut(&user).expect("key came from registry");
        workspaces.remove(&workspace);
        if workspaces.is_empty() {
            g.users.remove(&user);
        }
        emit_down(&mut g, registration_id);
        true
    }

    /// Replace the identity lease for one live registration and publish a
    /// generation-contiguous delta so controller authority expires and
    /// refreshes independently of tunnel liveness.
    pub fn refresh_admission_lease(
        &self,
        registration_id: Uuid,
        owner_user_id: Uuid,
        admission_lease: Arc<str>,
        admission_lease_expires_at: DateTime<Utc>,
    ) -> bool {
        let mut g = self.inner.lock();
        let mut changed = None;
        for workspaces in g.users.values_mut() {
            for entry in workspaces.values_mut() {
                if entry.handle.registration_id == registration_id
                    && entry.handle.owner_user_id == owner_user_id
                {
                    entry.handle.admission_lease = Some(admission_lease.clone());
                    entry.handle.admission_lease_expires_at = Some(admission_lease_expires_at);
                    changed = Some(tunnel_info(&entry.handle));
                    break;
                }
            }
            if changed.is_some() {
                break;
            }
        }
        let Some(row) = changed else {
            return false;
        };
        let _ = row;
        let _ = g.events.send(RegistryEvent::LeaseRefresh {
            registration_id,
            owner_user_id,
            admission_lease,
            admission_lease_expires_at,
        });
        true
    }

    pub fn evict_all(&self) -> usize {
        let mut g = self.inner.lock();
        let ids: Vec<Uuid> = g
            .users
            .values()
            .flat_map(|workspaces| {
                workspaces
                    .values()
                    .map(|entry| entry.handle.registration_id)
            })
            .collect();
        g.users.clear();
        for id in &ids {
            emit_down(&mut g, *id);
        }
        ids.len()
    }
}

fn tunnel_info(handle: &TunnelHandle) -> TunnelInfo {
    TunnelInfo {
        registration_id: handle.registration_id,
        owner_user_id: handle.owner_user_id,
        user: handle.user.clone(),
        workspace: handle.workspace.clone(),
        admission_lease: handle.admission_lease.clone(),
        admission_lease_expires_at: handle.admission_lease_expires_at,
        peer_addr: handle.peer_addr,
        connected_at: handle.connected_at,
    }
}

fn snapshot(users: &UserMap) -> Vec<TunnelInfo> {
    users
        .values()
        .flat_map(|workspaces| workspaces.values().map(|entry| tunnel_info(&entry.handle)))
        .collect()
}

fn emit_down(state: &mut State, registration_id: Uuid) {
    state.generation += 1;
    let _ = state.events.send(RegistryEvent::TunnelDown {
        generation: state.generation,
        registration_id,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn evict_on_collision() {
        use tokio::sync::oneshot::error::TryRecvError;
        let reg = Registry::new();
        let user: Arc<str> = Arc::from("alice");
        let workspace: Arc<str> = Arc::from("notes");

        let (_h1, _rx1, mut shutdown1) = reg
            .register_with_cap(user.clone(), workspace.clone(), None, None, 0)
            .unwrap();
        // Before the collision, the receiver has no value and the
        // sender is still alive: try_recv must report Empty.
        assert!(matches!(shutdown1.try_recv(), Err(TryRecvError::Empty)));

        // Re-register the same pair: old entry is dropped, its
        // shutdown sender is dropped with it, so the receiver wakes
        // with Closed.
        let (_h2, _rx2, _shutdown2) = reg
            .register_with_cap(user.clone(), workspace.clone(), None, None, 0)
            .unwrap();
        match shutdown1.try_recv() {
            Err(TryRecvError::Closed) => {}
            other => panic!("expected Closed after eviction, got {other:?}"),
        }

        // The new handle is what the registry returns from now on.
        assert!(reg.get("alice", "notes").is_some());
    }

    #[tokio::test]
    async fn evict_drops_empty_user_bucket() {
        let reg = Registry::new();
        let _h = reg
            .register_with_cap(Arc::from("alice"), Arc::from("notes"), None, None, 0)
            .unwrap();
        assert!(reg.evict("alice", "notes"));
        // After the last workspace is removed, the user bucket is
        // cleaned up so a stale `list_workspaces_for("alice")` doesn't
        // hold a reference to an empty inner map indefinitely.
        assert!(reg.list_workspaces_for("alice").is_empty());
        // Sanity: evict again returns false.
        assert!(!reg.evict("alice", "notes"));
    }

    #[tokio::test]
    async fn lookup_returns_current_handle() {
        let reg = Registry::new();
        let (_h, _rx, _sd) = reg
            .register_with_cap(Arc::from("alice"), Arc::from("notes"), None, None, 0)
            .unwrap();
        assert!(reg.get("alice", "notes").is_some());
        assert!(reg.get("alice", "other").is_none());
        assert!(reg.get("bob", "notes").is_none());
    }

    #[tokio::test]
    async fn register_with_cap_enforces_per_user_limit() {
        let reg = Registry::new();
        let _a = reg
            .register_with_cap(Arc::from("alice"), Arc::from("d1"), None, None, 2)
            .unwrap();
        let _b = reg
            .register_with_cap(Arc::from("alice"), Arc::from("d2"), None, None, 2)
            .unwrap();
        let err = reg
            .register_with_cap(Arc::from("alice"), Arc::from("d3"), None, None, 2)
            .err()
            .expect("third workspace should be capped");
        assert_eq!(err.user, "alice");
        assert_eq!(err.max, 2);
        // Reconnect of an existing workspace bypasses the cap.
        let _a2 = reg
            .register_with_cap(Arc::from("alice"), Arc::from("d1"), None, None, 2)
            .unwrap();
        // Other user is unaffected.
        let _bob = reg
            .register_with_cap(Arc::from("bob"), Arc::from("d1"), None, None, 2)
            .unwrap();
    }

    #[tokio::test]
    async fn register_with_cap_zero_disables_check() {
        let reg = Registry::new();
        for i in 0..5 {
            let _ = reg
                .register_with_cap(
                    Arc::from("alice"),
                    Arc::from(format!("d{i}")),
                    None,
                    None,
                    0,
                )
                .unwrap();
        }
    }

    #[tokio::test]
    async fn list_workspaces_for_returns_sorted_names_per_user() {
        let reg = Registry::new();
        let (_h1, _rx1, _sd1) = reg
            .register_with_cap(Arc::from("alice"), Arc::from("notes"), None, None, 0)
            .unwrap();
        let (_h2, _rx2, _sd2) = reg
            .register_with_cap(Arc::from("alice"), Arc::from("ideas"), None, None, 0)
            .unwrap();
        let (_h3, _rx3, _sd3) = reg
            .register_with_cap(Arc::from("bob"), Arc::from("notes"), None, None, 0)
            .unwrap();

        let alice: Vec<String> = reg
            .list_workspaces_for("alice")
            .into_iter()
            .map(|d| d.workspace.as_ref().to_string())
            .collect();
        assert_eq!(alice, vec!["ideas".to_string(), "notes".to_string()]);

        let bob: Vec<String> = reg
            .list_workspaces_for("bob")
            .into_iter()
            .map(|d| d.workspace.as_ref().to_string())
            .collect();
        assert_eq!(bob, vec!["notes".to_string()]);

        assert!(reg.list_workspaces_for("nobody").is_empty());
    }

    #[tokio::test]
    async fn snapshot_subscription_is_contiguous_and_precise() {
        let reg = Registry::new();
        let (generation, rows, mut events) = reg.snapshot_and_subscribe();
        assert_eq!(generation, 0);
        assert!(rows.is_empty());

        let (handle, _rx, _shutdown) = reg
            .register_with_cap(Arc::from("alice"), Arc::from("notes"), None, None, 0)
            .unwrap();
        let up = events.recv().await.unwrap();
        match up {
            RegistryEvent::TunnelUp { generation, row } => {
                assert_eq!(generation, 1);
                assert_eq!(row.registration_id, handle.registration_id);
            }
            other => panic!("expected TunnelUp, got {other:?}"),
        }

        assert!(reg.evict_registration(handle.registration_id));
        let down = events.recv().await.unwrap();
        assert!(matches!(
            down,
            RegistryEvent::TunnelDown {
                generation: 2,
                registration_id
            } if registration_id == handle.registration_id
        ));
        assert!(!reg.evict_registration(handle.registration_id));
    }

    #[tokio::test]
    async fn predecessor_teardown_cannot_remove_successor() {
        let reg = Registry::new();
        let (old, _rx, _shutdown) = reg
            .register_with_cap(Arc::from("alice"), Arc::from("notes"), None, None, 0)
            .unwrap();
        let (new, _rx, _shutdown) = reg
            .register_with_cap(Arc::from("alice"), Arc::from("notes"), None, None, 0)
            .unwrap();

        reg.deregister_if_owner(&old);
        assert_eq!(
            reg.get("alice", "notes").unwrap().registration_id,
            new.registration_id
        );
    }

    #[tokio::test]
    async fn evict_all_reports_and_emits_every_registration() {
        let reg = Registry::new();
        let (_generation, _rows, mut events) = reg.snapshot_and_subscribe();
        for workspace in ["one", "two"] {
            reg.register_with_cap(Arc::from("alice"), Arc::from(workspace), None, None, 0)
                .unwrap();
            let _ = events.recv().await.unwrap();
        }
        assert_eq!(reg.evict_all(), 2);
        assert!(reg.list_all().is_empty());
        let first = events.recv().await.unwrap();
        let second = events.recv().await.unwrap();
        assert!(matches!(
            first,
            RegistryEvent::TunnelDown { generation: 3, .. }
        ));
        assert!(matches!(
            second,
            RegistryEvent::TunnelDown { generation: 4, .. }
        ));
    }

    #[test]
    fn admission_authority_debug_is_redacted_in_rows_and_events() {
        let sentinel = Arc::<str>::from("lease-secret-sentinel");
        let row = TunnelInfo {
            registration_id: Uuid::new_v4(),
            owner_user_id: Uuid::new_v4(),
            user: Arc::from("alice"),
            workspace: Arc::from("devserver"),
            admission_lease: Some(sentinel.clone()),
            admission_lease_expires_at: Some(Utc::now() + chrono::Duration::minutes(5)),
            peer_addr: None,
            connected_at: Utc::now(),
        };
        let row_debug = format!("{row:?}");
        assert!(row_debug.contains("[REDACTED]"));
        assert!(!row_debug.contains(sentinel.as_ref()));

        let event = RegistryEvent::LeaseRefresh {
            registration_id: row.registration_id,
            owner_user_id: row.owner_user_id,
            admission_lease: sentinel.clone(),
            admission_lease_expires_at: row.admission_lease_expires_at.unwrap(),
        };
        let event_debug = format!("{event:?}");
        assert!(event_debug.contains("[REDACTED]"));
        assert!(!event_debug.contains(sentinel.as_ref()));
    }
}
