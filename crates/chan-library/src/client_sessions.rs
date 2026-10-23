//! Client sessions shared by every tenant of one library. A holder tag groups
//! a desktop's windows; it is an operational claim, never an auth credential.
//! Detaching a client cancels its connections and refuses automatic reattach
//! until an explicit resume. It never removes a window or a PTY.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tokio::sync::watch;

use crate::name_casefold::comparison_key;
use crate::session_presence::{validate_name, SessionRegistry, WhoamiInfo};
use crate::time::now_unix_secs;

/// WebSocket close code for an explicitly detached client.
pub const DETACHED_CLOSE_CODE: u16 = 4001;
const MAX_CLIENTS: usize = 4096;

/// Client-supplied holder tags use the same grammar on every transport.
pub fn valid_holder(tag: &str) -> bool {
    !tag.is_empty()
        && tag.len() <= 64
        && tag
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// One connection's placement, independent of the shared window and PTY.
#[derive(Clone, Debug, Serialize)]
pub struct ConnectionInfo {
    pub tenant: String,
    pub window_id: String,
    pub kind: String,
    pub transport: String,
    pub terminal_id: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    pub connected_at: u64,
    pub last_seen: u64,
}

/// A client and its currently attached connections, for `cs session`.
#[derive(Clone, Debug, Serialize)]
pub struct ClientInfo {
    pub id: String,
    pub holder: String,
    pub name: String,
    pub status: &'static str,
    pub connected_at: u64,
    pub last_seen: u64,
    pub connections: Vec<ConnectionInfo>,
}

struct Client {
    id: String,
    holder: String,
    tagged: bool,
    default_name: String,
    name: Option<String>,
    connected_at: u64,
    last_seen: u64,
    connections: BTreeMap<u64, ConnectionInfo>,
    detached: watch::Sender<bool>,
}

impl Client {
    fn info(&self) -> ClientInfo {
        ClientInfo {
            id: self.id.clone(),
            holder: self.holder.clone(),
            name: self.name.as_ref().unwrap_or(&self.default_name).clone(),
            status: if *self.detached.borrow() {
                "detached"
            } else if self.connections.is_empty() {
                "disconnected"
            } else {
                "live"
            },
            connected_at: self.connected_at,
            last_seen: self.last_seen,
            connections: self.connections.values().cloned().collect(),
        }
    }
}

#[derive(Default)]
struct Inner {
    clients: BTreeMap<String, Client>,
    holders: HashMap<String, String>,
    next_connection: u64,
}

impl Inner {
    fn remove_client(&mut self, id: &str) {
        if let Some(client) = self.clients.remove(id) {
            self.holders.remove(&client.holder);
        }
    }
}

/// The process-local client roster. Detached tags remain tombstoned for the
/// server's lifetime, so a sleeping client cannot silently reconnect later.
#[derive(Default)]
pub struct ClientSessions {
    inner: Mutex<Inner>,
}

impl ClientSessions {
    /// Construct an empty roster, shared into each tenant by its builder.
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Bind a tenant to this library's roster without giving each tenant its
    /// own client identity namespace.
    pub fn tenant(self: &Arc<Self>, prefix: &str, kind: &str) -> ClientTenant {
        ClientTenant {
            registry: self.clone(),
            prefix: prefix.into(),
            kind: kind.into(),
        }
    }

    /// List clients, including disconnected and explicitly detached clients.
    pub fn list(&self) -> Vec<ClientInfo> {
        self.lock().clients.values().map(Client::info).collect()
    }

    /// Read one exact id. Names are labels, never ambiguous mutation selectors.
    pub fn info(&self, id: &str) -> Result<ClientInfo, String> {
        self.lock()
            .clients
            .get(id)
            .map(Client::info)
            .ok_or_else(|| format!("no client session {id}"))
    }

    /// Rename a client, or restore its generated name with `None`.
    /// Explicit names must pass the shared participant-name validation. Both
    /// explicit and restored names must differ ignoring case from every other
    /// live client's name.
    pub fn rename(&self, id: &str, name: Option<&str>) -> Result<ClientInfo, String> {
        self.with_rename(id, name, |client, name| {
            client.name = name.map(str::to_owned);
            Ok(client.info())
        })
    }

    /// Name a client and its calling window's participant together, or reset
    /// both overrides with `None`. Validation, missing records and collisions
    /// refuse before either registry changes. Returns both updated records.
    pub fn rename_with_participant(
        &self,
        id: &str,
        name: Option<&str>,
        participants: &SessionRegistry,
        window: &str,
    ) -> Result<(ClientInfo, WhoamiInfo), String> {
        // Always hold the client lock before the participant lock. The
        // companion update cannot fail, so both collision checks precede
        // either mutation and no rollback can overwrite a concurrent rename.
        self.with_rename(id, name, |client, name| {
            participants
                .rename_validated_with(window, name, || {
                    client.name = name.map(str::to_owned);
                    client.info()
                })
                .map_err(|e| e.to_string())
        })
    }

    fn with_rename<T>(
        &self,
        id: &str,
        name: Option<&str>,
        update: impl FnOnce(&mut Client, Option<&str>) -> Result<T, String>,
    ) -> Result<T, String> {
        let name = name
            .map(validate_name)
            .transpose()
            .map_err(|e| e.to_string())?;
        let mut inner = self.lock();
        let client = inner
            .clients
            .get(id)
            .ok_or_else(|| format!("no client session {id}"))?;
        let folded = comparison_key(name.unwrap_or(&client.default_name));
        if let Some(other) = inner.clients.values().find(|client| {
            client.id != id
                && !client.connections.is_empty()
                && !*client.detached.borrow()
                && comparison_key(client.name.as_ref().unwrap_or(&client.default_name)) == folded
        }) {
            return Err(format!(
                "session name is already held by client {}",
                other.id
            ));
        }
        let client = inner
            .clients
            .get_mut(id)
            .ok_or_else(|| format!("no client session {id}"))?;
        update(client, name)
    }

    /// Revoke every attachment of one client without changing shared resources.
    pub fn detach(&self, id: &str) -> Result<ClientInfo, String> {
        let inner = self.lock();
        let client = inner
            .clients
            .get(id)
            .ok_or_else(|| format!("no client session {id}"))?;
        client.detached.send_replace(true);
        Ok(client.info())
    }

    /// Resume is an explicit frontend action. Old connection receivers remain
    /// revoked, even if a resume races with their teardown.
    pub fn resume(&self, holder: &str) -> Result<(), String> {
        if !valid_holder(holder) {
            return Err("invalid client holder".into());
        }
        let mut inner = self.lock();
        // A detached page can outlive the server that remembered its holder.
        let Some(id) = inner.holders.get(holder).cloned() else {
            return Ok(());
        };
        let client = inner
            .clients
            .get_mut(&id)
            .ok_or("no client session for this holder")?;
        if *client.detached.borrow() {
            client.detached = watch::channel(false).0;
        }
        Ok(())
    }

    /// Whether this holder has been explicitly detached. Unknown tags have no
    /// session yet; admission happens when their first connection registers.
    pub fn is_detached(&self, holder: &str) -> bool {
        let inner = self.lock();
        inner
            .holders
            .get(holder)
            .and_then(|id| inner.clients.get(id))
            .is_some_and(|client| *client.detached.borrow())
    }
}

/// A tenant's access to the shared roster and its connection-placement defaults.
#[derive(Clone)]
pub struct ClientTenant {
    pub registry: Arc<ClientSessions>,
    prefix: String,
    kind: String,
}

impl Default for ClientTenant {
    fn default() -> Self {
        ClientSessions::new().tenant("", "workspace")
    }
}

impl ClientTenant {
    /// Register a connection before it can create or mutate any shared state.
    /// Untagged callers remain usable, but their independent connections cannot
    /// claim to be one device.
    pub fn connect(
        &self,
        holder: Option<&str>,
        window: &str,
        transport: &str,
    ) -> Result<ClientConnection, String> {
        let mut inner = self.registry.lock();
        inner.next_connection += 1;
        let connection_id = inner.next_connection;
        let holder = holder.filter(|tag| valid_holder(tag));
        let tagged = holder.is_some();
        let holder = holder
            .map(str::to_owned)
            .unwrap_or_else(|| format!("untagged:{connection_id}"));
        let id = match inner.holders.get(&holder) {
            Some(id) => id.clone(),
            None => {
                if inner.clients.len() >= MAX_CLIENTS {
                    let oldest = inner
                        .clients
                        .values()
                        .filter(|client| {
                            client.connections.is_empty() && !*client.detached.borrow()
                        })
                        .min_by_key(|client| client.last_seen)
                        .map(|client| client.id.clone())
                        .ok_or("client session limit reached")?;
                    inner.remove_client(&oldest);
                }
                let id = loop {
                    let id = format!("c-{:016x}", rand::random::<u64>());
                    if !inner.clients.contains_key(&id) {
                        break id;
                    }
                };
                let taken: HashSet<String> = inner
                    .clients
                    .values()
                    .flat_map(|c| {
                        [
                            c.default_name.clone(),
                            c.name.as_ref().unwrap_or(&c.default_name).clone(),
                        ]
                    })
                    .collect();
                let default_name = crate::participant_names::generate_name(&taken);
                let now = now_unix_secs();
                inner.clients.insert(
                    id.clone(),
                    Client {
                        id: id.clone(),
                        holder: holder.clone(),
                        tagged,
                        default_name,
                        name: None,
                        connected_at: now,
                        last_seen: now,
                        connections: BTreeMap::new(),
                        detached: watch::channel(false).0,
                    },
                );
                inner.holders.insert(holder, id.clone());
                id
            }
        };
        let client = inner
            .clients
            .get_mut(&id)
            .ok_or("client session disappeared")?;
        if *client.detached.borrow() {
            return Err("client session detached; reconnect explicitly".into());
        }
        let now = now_unix_secs();
        client.last_seen = now;
        client.connections.insert(
            connection_id,
            ConnectionInfo {
                tenant: self.prefix.clone(),
                window_id: window.into(),
                kind: self.kind.clone(),
                transport: transport.into(),
                terminal_id: None,
                cols: None,
                rows: None,
                connected_at: now,
                last_seen: now,
            },
        );
        Ok(ClientConnection {
            registry: self.registry.clone(),
            id,
            connection_id,
            detached: client.detached.subscribe(),
        })
    }

    /// Clients attached to this window. A shared PTY cannot infer which of them
    /// typed a shell command; the caller must resolve multiple candidates.
    pub fn candidates(&self, window: &str) -> Vec<ClientInfo> {
        self.registry
            .list()
            .into_iter()
            .filter(|client| {
                client.status == "live"
                    && client.connections.iter().any(|connection| {
                        connection.tenant == self.prefix && connection.window_id == window
                    })
            })
            .collect()
    }
}

/// An attachment lease. Dropping it releases only this connection.
pub struct ClientConnection {
    registry: Arc<ClientSessions>,
    id: String,
    connection_id: u64,
    detached: watch::Receiver<bool>,
}

impl ClientConnection {
    /// The client identity shared by its event and terminal connections.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// The attachment's revocation receiver, retained across reconnect races.
    pub fn cancellation(&self) -> watch::Receiver<bool> {
        self.detached.clone()
    }

    /// Record observed inbound traffic and, for PTYs, its id and requested grid.
    pub fn observe(&self, terminal: Option<&str>, grid: Option<(u16, u16)>) {
        let mut inner = self.registry.lock();
        if let Some(client) = inner.clients.get_mut(&self.id) {
            let now = now_unix_secs();
            client.last_seen = now;
            if let Some(connection) = client.connections.get_mut(&self.connection_id) {
                connection.last_seen = now;
                if let Some(terminal) = terminal {
                    connection.terminal_id = Some(terminal.into());
                }
                if let Some((cols, rows)) = grid {
                    connection.cols = Some(cols);
                    connection.rows = Some(rows);
                }
            }
        }
    }
}

impl Drop for ClientConnection {
    fn drop(&mut self) {
        let mut inner = self.registry.lock();
        if let Some(client) = inner.clients.get_mut(&self.id) {
            client.connections.remove(&self.connection_id);
            client.last_seen = now_unix_secs();
            if !client.tagged && client.connections.is_empty() && !*client.detached.borrow() {
                inner.remove_client(&self.id);
            }
        }
    }
}

/// Wait for revocation, including one that happened before the wait started.
pub async fn cancelled(mut receiver: watch::Receiver<bool>) {
    loop {
        if *receiver.borrow_and_update() {
            return;
        }
        if receiver.changed().await.is_err() {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn naming_repair_caseless_client_clash_preserves_spelling() {
        let tenant = ClientSessions::new().tenant("/repo", "workspace");
        let a = tenant.connect(Some("a"), "a", "events").unwrap();
        let b = tenant.connect(Some("b"), "b", "events").unwrap();
        tenant.registry.rename(a.id(), Some("Sam")).unwrap();
        tenant.registry.rename(b.id(), Some("before")).unwrap();
        assert_eq!(
            tenant.registry.rename(b.id(), Some("\u{17f}am")).err(),
            Some(format!("session name is already held by client {}", a.id()))
        );
        assert_eq!(tenant.registry.info(a.id()).unwrap().name, "Sam");
        assert_eq!(tenant.registry.info(b.id()).unwrap().name, "before");
    }

    #[test]
    fn naming_repair_generated_defaults_survive_overrides() {
        let tenant = ClientSessions::new().tenant("/repo", "workspace");
        let clients: Vec<_> = (0..201)
            .map(|i| {
                let client = tenant
                    .connect(Some(&format!("holder-{i}")), "w", "events")
                    .unwrap();
                let default = tenant.registry.info(client.id()).unwrap().name;
                tenant
                    .registry
                    .rename(client.id(), Some(&format!("custom-{i}")))
                    .unwrap();
                (client, default)
            })
            .collect();
        let defaults: HashSet<_> = clients.iter().map(|(_, default)| default).collect();
        assert_eq!(defaults.len(), clients.len());
        for (client, default) in clients {
            assert_eq!(
                tenant.registry.rename(client.id(), None).unwrap().name,
                default
            );
        }
    }

    #[test]
    fn naming_repair_client_reset_clash_preserves_both_names() {
        let tenant = ClientSessions::new().tenant("/repo", "workspace");
        let a = tenant.connect(Some("a"), "a", "events").unwrap();
        let default = tenant.registry.info(a.id()).unwrap().name;
        tenant.registry.rename(a.id(), Some("before")).unwrap();
        let b = tenant.connect(Some("b"), "b", "events").unwrap();
        tenant
            .registry
            .rename(b.id(), Some(&default.to_uppercase()))
            .unwrap();
        let participants = Arc::new(SessionRegistry::new());
        let _guard = participants.join("a", true, None).guard;
        participants.rename("a", "participant before").unwrap();
        let before = participants.whoami("a", std::time::Instant::now()).unwrap();
        let error = tenant
            .registry
            .rename_with_participant(a.id(), None, &participants, "a")
            .err();
        assert_eq!(
            error,
            Some(format!("session name is already held by client {}", b.id()))
        );
        assert_eq!(tenant.registry.info(a.id()).unwrap().name, "before");
        assert_eq!(
            participants.whoami("a", std::time::Instant::now()).unwrap(),
            before
        );
        tenant.registry.detach(b.id()).unwrap();
        assert_eq!(tenant.registry.rename(a.id(), None).unwrap().name, default);
    }

    #[test]
    fn naming_repair_participant_reset_clash_preserves_both_names() {
        let tenant = ClientSessions::new().tenant("/repo", "workspace");
        let client = tenant.connect(Some("a"), "a", "events").unwrap();
        let participants = Arc::new(SessionRegistry::new());
        let _a = participants.join("a", true, None).guard;
        let default = participants
            .whoami("a", std::time::Instant::now())
            .unwrap()
            .name;
        tenant
            .registry
            .rename_with_participant(client.id(), Some("before"), &participants, "a")
            .unwrap();
        let _b = participants.join("b", true, None).guard;
        participants.rename("b", &default.to_uppercase()).unwrap();
        let before = participants.whoami("a", std::time::Instant::now()).unwrap();
        assert_eq!(
            tenant
                .registry
                .rename_with_participant(client.id(), None, &participants, "a")
                .err(),
            Some("session name is already held by participant window b".into())
        );
        assert_eq!(tenant.registry.info(client.id()).unwrap().name, "before");
        assert_eq!(
            participants.whoami("a", std::time::Instant::now()).unwrap(),
            before
        );
    }

    #[test]
    fn naming_repair_gateway_identity_can_be_shared_after_reset() {
        use crate::session_presence::ParticipantIdentity;
        let tenant = ClientSessions::new().tenant("/repo", "workspace");
        let client = tenant.connect(Some("a"), "a", "events").unwrap();
        let default = tenant.registry.info(client.id()).unwrap().name;
        let participants = Arc::new(SessionRegistry::new());
        let identity = ParticipantIdentity {
            display_name: Some("Sam".into()),
            email: None,
        };
        let _a = participants.join("a", false, Some(identity.clone())).guard;
        let _b = participants.join("b", false, Some(identity)).guard;
        tenant
            .registry
            .rename_with_participant(client.id(), Some("before"), &participants, "a")
            .unwrap();
        let (reset_client, reset_participant) = tenant
            .registry
            .rename_with_participant(client.id(), None, &participants, "a")
            .unwrap();
        assert_eq!(reset_client.name, default);
        assert_eq!(reset_participant.name, "Sam");
        assert_eq!(
            participants
                .whoami("b", std::time::Instant::now())
                .unwrap()
                .name,
            "Sam"
        );
    }

    #[test]
    fn naming_repair_caseless_clash_on_either_side_preserves_both_names() {
        for participant_clash in [false, true] {
            let tenant = ClientSessions::new().tenant("/repo", "workspace");
            let client = tenant.connect(Some("a"), "a", "events").unwrap();
            let other = tenant.connect(Some("b"), "b", "events").unwrap();
            let participants = Arc::new(SessionRegistry::new());
            let _a = participants.join("a", true, None).guard;
            let _b = participants.join("b", true, None).guard;
            tenant
                .registry
                .rename_with_participant(client.id(), Some("before"), &participants, "a")
                .unwrap();
            let holder = if participant_clash {
                participants.rename("b", "Sam").unwrap();
                "participant window b".to_owned()
            } else {
                tenant.registry.rename(other.id(), Some("Sam")).unwrap();
                format!("client {}", other.id())
            };
            let before = participants.whoami("a", std::time::Instant::now()).unwrap();
            assert_eq!(
                tenant
                    .registry
                    .rename_with_participant(client.id(), Some("\u{17f}am"), &participants, "a")
                    .err(),
                Some(format!("session name is already held by {holder}"))
            );
            assert_eq!(tenant.registry.info(client.id()).unwrap().name, "before");
            assert_eq!(
                participants.whoami("a", std::time::Instant::now()).unwrap(),
                before
            );
        }
    }

    #[test]
    fn rename_refuses_invalid_names_without_changing_the_client() {
        let tenant = ClientSessions::new().tenant("/repo", "workspace");
        let client = tenant.connect(Some("work"), "w", "events").unwrap();
        tenant.registry.rename(client.id(), Some("before")).unwrap();
        for invalid in [
            "   ".to_owned(),
            "x".repeat(65),
            "A\u{85}".into(),
            "A\u{200b}".into(),
            "A\u{202e}".into(),
        ] {
            assert!(
                tenant.registry.rename(client.id(), Some(&invalid)).is_err(),
                "{invalid:?}"
            );
            assert_eq!(tenant.registry.info(client.id()).unwrap().name, "before");
        }
    }

    #[test]
    fn rename_checks_other_live_clients_but_allows_self_and_disconnected_names() {
        let tenant = ClientSessions::new().tenant("/repo", "workspace");
        let a = tenant.connect(Some("work"), "a", "events").unwrap();
        let b = tenant.connect(Some("home"), "b", "events").unwrap();
        tenant.registry.rename(a.id(), Some("\u{c9}lodie")).unwrap();
        tenant.registry.rename(a.id(), Some("\u{e9}LODIE")).unwrap();
        let before = tenant.registry.info(b.id()).unwrap().name;
        let result = tenant.registry.rename(b.id(), Some("\u{c9}lodie"));
        assert_eq!(
            result.err(),
            Some(format!("session name is already held by client {}", a.id()))
        );
        assert_eq!(tenant.registry.info(b.id()).unwrap().name, before);
        drop(a);
        assert_eq!(
            tenant
                .registry
                .rename(b.id(), Some("\u{c9}lodie"))
                .unwrap()
                .name,
            "\u{c9}lodie"
        );
        assert_eq!(
            tenant
                .registry
                .rename(b.id(), Some(&"\u{e9}".repeat(64)))
                .unwrap()
                .name
                .chars()
                .count(),
            64
        );
    }

    #[test]
    fn combined_rename_refuses_a_missing_participant_before_changing_the_client() {
        let tenant = ClientSessions::new().tenant("/repo", "workspace");
        let client = tenant.connect(Some("work"), "missing", "terminal").unwrap();
        let participants = SessionRegistry::new();
        let before = tenant.registry.info(client.id()).unwrap().name;
        for name in [Some("Alice"), None] {
            assert!(tenant
                .registry
                .rename_with_participant(client.id(), name, &participants, "missing")
                .is_err());
            assert_eq!(tenant.registry.info(client.id()).unwrap().name, before);
        }
    }

    #[test]
    fn explicit_holders_cannot_claim_an_untagged_connection() {
        let tenant = ClientSessions::new().tenant("/repo", "workspace");
        let untagged = tenant.connect(None, "w", "events").unwrap();
        let tagged = tenant.connect(Some("untagged-1"), "w", "events").unwrap();
        assert_ne!(
            untagged.id(),
            tagged.id(),
            "synthetic holders cannot be claimed explicitly"
        );
        assert!(!valid_holder(
            &tenant.registry.info(untagged.id()).unwrap().holder
        ));
        let tagged_id = tagged.id().to_owned();
        drop(tagged);
        assert_eq!(
            tenant
                .registry
                .info(untagged.id())
                .unwrap()
                .connections
                .len(),
            1
        );
        drop(untagged);
        assert_eq!(
            tenant.registry.info(&tagged_id).unwrap().status,
            "disconnected"
        );
        assert_eq!(tenant.registry.list().len(), 1);
    }

    #[test]
    fn completed_untagged_connections_do_not_exhaust_the_roster() {
        let tenant = ClientSessions::new().tenant("/repo", "workspace");
        for _ in 0..MAX_CLIENTS {
            drop(tenant.connect(None, "w", "events").unwrap());
        }
        let next = tenant.connect(Some("new-holder"), "w", "events");
        assert_eq!(
            next.as_ref().err(),
            None,
            "completed untagged leases consume no slots"
        );
        assert_eq!(tenant.registry.list().len(), 1);
        assert_eq!(tenant.registry.lock().holders.len(), 1);
    }

    #[test]
    fn disconnected_clients_evict_oldest_activity_and_return_as_new_clients() {
        let tenant = ClientSessions::new().tenant("/repo", "workspace");
        let mut ids = Vec::new();
        for n in 0..MAX_CLIENTS {
            let connection = tenant
                .connect(Some(&format!("holder-{n}")), "w", "events")
                .unwrap();
            ids.push(connection.id().to_owned());
            drop(connection);
        }
        // Set activity directly so neither clock resolution nor random id order
        // determines the client to evict.
        let oldest = &ids[MAX_CLIENTS / 2];
        {
            let mut inner = tenant.registry.lock();
            for client in inner.clients.values_mut() {
                client.last_seen = 10;
            }
            inner.clients.get_mut(oldest).unwrap().last_seen = 1;
        }
        tenant
            .registry
            .rename(oldest, Some("remembered name"))
            .unwrap();
        let newcomer = tenant.connect(Some("new-holder"), "w", "events");
        assert_eq!(
            newcomer.as_ref().err(),
            None,
            "disconnected records yield a slot"
        );
        assert!(tenant.registry.info(oldest).is_err());
        assert!(tenant.registry.info(&ids[0]).is_ok());
        let returned = tenant
            .connect(Some(&format!("holder-{}", MAX_CLIENTS / 2)), "w", "events")
            .unwrap();
        assert_ne!(returned.id(), oldest);
        assert_ne!(
            tenant.registry.info(returned.id()).unwrap().name,
            "remembered name"
        );
        assert_eq!(tenant.registry.list().len(), MAX_CLIENTS);
        assert_eq!(tenant.registry.lock().holders.len(), MAX_CLIENTS);
    }

    #[test]
    fn live_and_detached_clients_cannot_be_evicted() {
        let tenant = ClientSessions::new().tenant("/repo", "workspace");
        let mut live = Vec::new();
        for n in 0..MAX_CLIENTS {
            let connection = tenant
                .connect(Some(&format!("holder-{n}")), "w", "events")
                .unwrap();
            if n % 2 == 0 {
                tenant.registry.detach(connection.id()).unwrap();
            } else {
                live.push(connection);
            }
        }
        let before = tenant
            .registry
            .list()
            .into_iter()
            .map(|c| c.id)
            .collect::<Vec<_>>();
        let refused = tenant.connect(Some("new-holder"), "w", "events");
        assert_eq!(
            refused.err().as_deref(),
            Some("client session limit reached")
        );
        assert_eq!(
            tenant
                .registry
                .list()
                .into_iter()
                .map(|c| c.id)
                .collect::<Vec<_>>(),
            before
        );
        assert_eq!(live.len(), MAX_CLIENTS / 2);
    }

    #[test]
    fn detached_clients_survive_eviction_pressure_and_stay_refused() {
        let tenant = ClientSessions::new().tenant("/repo", "workspace");
        let detached = tenant
            .connect(Some("detached-holder"), "w", "events")
            .unwrap();
        let detached_id = detached.id().to_owned();
        tenant.registry.detach(&detached_id).unwrap();
        drop(detached);
        for n in 1..MAX_CLIENTS {
            drop(
                tenant
                    .connect(Some(&format!("holder-{n}")), "w", "events")
                    .unwrap(),
            );
        }
        tenant
            .registry
            .lock()
            .clients
            .get_mut(&detached_id)
            .unwrap()
            .last_seen = 0;
        for n in 0..3 {
            let newcomer = tenant.connect(Some(&format!("new-{n}")), "w", "events");
            assert_eq!(
                newcomer.as_ref().err(),
                None,
                "a detached oldest record must not prevent another eviction"
            );
            drop(newcomer);
            assert_eq!(
                tenant.registry.info(&detached_id).unwrap().status,
                "detached"
            );
            assert_eq!(
                tenant
                    .connect(Some("detached-holder"), "w", "events")
                    .err()
                    .as_deref(),
                Some("client session detached; reconnect explicitly")
            );
        }
    }

    #[test]
    fn untagged_retirement_preserves_detached_and_explicitly_tagged_records() {
        let tenant = ClientSessions::new().tenant("/repo", "workspace");
        let tagged = tenant
            .connect(Some("untagged-user"), "w", "events")
            .unwrap();
        let tagged_id = tagged.id().to_owned();
        drop(tagged);
        assert_eq!(
            tenant.registry.info(&tagged_id).unwrap().status,
            "disconnected"
        );
        let untagged = tenant.connect(None, "w", "events").unwrap();
        let detached_id = untagged.id().to_owned();
        tenant.registry.detach(&detached_id).unwrap();
        drop(untagged);
        assert_eq!(
            tenant.registry.info(&detached_id).unwrap().status,
            "detached"
        );
    }

    #[tokio::test]
    async fn clients_share_windows_but_detach_independently_across_tenants() {
        let registry = ClientSessions::new();
        let workspace = registry.tenant("/repo", "workspace");
        let terminal = registry.tenant("/terminal", "terminal");
        let work = workspace
            .connect(Some("work"), "w-shared", "events")
            .unwrap();
        let work_pty = terminal
            .connect(Some("work"), "w-shell", "terminal")
            .unwrap();
        let home = workspace
            .connect(Some("home"), "w-shared", "events")
            .unwrap();
        assert_eq!(work.id(), work_pty.id());
        assert_ne!(work.id(), home.id());
        assert_eq!(workspace.candidates("w-shared").len(), 2);
        registry.rename(work.id(), Some("work laptop")).unwrap();
        assert_ne!(registry.info(home.id()).unwrap().name, "work laptop");
        registry.detach(work.id()).unwrap();
        cancelled(work.cancellation()).await;
        cancelled(work_pty.cancellation()).await;
        assert!(!*home.cancellation().borrow());
        assert_eq!(workspace.candidates("w-shared").len(), 1);
        assert!(workspace
            .connect(Some("work"), "w-shared", "events")
            .is_err());
        assert!(terminal
            .connect(Some("work"), "w-shell", "terminal")
            .is_err());
        registry.resume("work").unwrap();
        cancelled(work.cancellation()).await;
        let resumed = workspace
            .connect(Some("work"), "w-shared", "events")
            .unwrap();
        assert_eq!(work.id(), resumed.id());
        assert!(!*resumed.cancellation().borrow());
        drop(work);
        assert_eq!(registry.info(resumed.id()).unwrap().status, "live");
    }

    #[test]
    fn reconnects_keep_identity_and_names_and_old_guards_do_not_remove_new_connections() {
        let tenant = ClientSessions::new().tenant("/repo", "workspace");
        assert!(tenant.registry.resume("laptop").is_ok());
        assert!(tenant.registry.resume("invalid/holder").is_err());
        let first = tenant.connect(Some("laptop"), "w", "terminal").unwrap();
        let id = first.id().to_owned();
        first.observe(Some("pty-1"), Some((80, 24)));
        tenant.registry.rename(&id, Some("  home  ")).unwrap();
        let second = tenant.connect(Some("laptop"), "w", "events").unwrap();
        assert_eq!(id, second.id());
        let before = tenant.registry.info(&id).unwrap();
        assert_eq!(before.name, "home");
        assert_eq!(before.connections[0].terminal_id.as_deref(), Some("pty-1"));
        assert_eq!(before.connections[0].cols, Some(80));
        drop(first);
        assert_eq!(tenant.registry.info(&id).unwrap().connections.len(), 1);
        drop(second);
        assert_eq!(tenant.registry.info(&id).unwrap().status, "disconnected");
        let third = tenant.connect(Some("laptop"), "w", "events").unwrap();
        assert_eq!(id, third.id());
        assert!(tenant.registry.rename(&id, Some("\n\t")).is_err());
        assert!(tenant.registry.detach("unknown").is_err());
    }
}
