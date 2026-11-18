//! Process-wide state for the iOS app, plus the connected-devserver
//! feed the embedded host merges into the launcher surface.
//!
//! One `Arc<AppState>` is built at boot over the shared config store and
//! handed to Tauri (`manage`), the embedded server, and every background
//! task; background runtime owners need the same handle Tauri commands
//! get, which is why the state is shared by `Arc` rather than owned by
//! the builder. The desktop's watcher, window-geometry, handoff, and
//! updater state has no iOS counterpart (single webview, OS-owned
//! lifecycle) and is not carried here.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};

use crate::config::{ConfigStore, DevserverRemoveHook, GatewayRemoveHook};
use crate::devserver::DevserverConns;
use crate::embedded::EmbeddedServer;
use crate::gateway::GatewayManager;

/// Reconnect hook for a rostered row whose registration moved proxy
/// nodes: fires the normal connect flow for one synthesized row id.
/// The roster poll cannot see the concrete `AppHandle`, so the iOS boot
/// fills this cell once Tauri setup runs.
pub type DevserverReconnectHook = Arc<dyn Fn(&str) + Send + Sync>;

/// Process-wide state. Shared via `Arc` because Tauri commands and
/// background runtime owners need the same state handle.
pub struct AppState {
    /// Shared config handle. An `Arc<Mutex<...>>` (not a bare `Mutex`)
    /// so the launcher's config registries, installed into the embedded
    /// host, write the SAME config the app's own commands read: every
    /// full-file rewrite serializes through one lock, so a devserver
    /// CRUD cannot lose an update to a concurrent save.
    pub store: Arc<Mutex<ConfigStore>>,
    /// In-process chan-server host for local workspaces. Initialized
    /// during Tauri setup, after the async runtime is available for
    /// Tokio listener registration.
    pub embedded: OnceLock<EmbeddedServer>,
    /// Live connections to devservers, keyed by `Devserver.id`. A
    /// devserver present here is connected (the launcher polls its
    /// workspace list and can open its tenants); absent means
    /// disconnected. In memory only: the bearer token rotates, so it
    /// is re-acquired on each connect.
    pub devservers: Arc<DevserverConns>,
    /// The launcher's connected-devserver feed source. Installed on
    /// the embedded host; populated on connect and drained on
    /// disconnect. The host reads it when assembling the launcher's
    /// window + workspace lists.
    pub devserver_feed: Arc<DevserverFeed>,
    /// Devservers with a connect request currently in flight. A second
    /// connect coalesces into the first instead of spawning another
    /// control terminal.
    pub devserver_connecting: Arc<Mutex<HashSet<String>>>,
    /// Current scripted control run per devserver. The generation
    /// binds the prefix and connect result so a stale run cannot emit
    /// against or overwrite a newer connect attempt.
    pub control_terminal_runs: Mutex<HashMap<String, ControlTerminalRun>>,
    /// Devservers whose control script exited (or whose connect
    /// failed) while the control terminal is still live: the
    /// connection is marked down but the control terminal is KEPT at
    /// "process exited" so the user can read the death reason.
    /// Reconnect is BLOCKED for these ids until the control terminal
    /// is closed, so the user has to see why it ended (or hit
    /// Reconnect, whose teardown reaps it).
    pub control_terminal_dead: Mutex<HashSet<String>>,
    /// Monotonic generation source for scripted control runs.
    pub control_terminal_generation: std::sync::atomic::AtomicU64,
    /// Per synthesized row serialization for connect, trust mutation,
    /// roster revocation, and gateway cascades. Holding the async
    /// lock makes DELETE wait for an older connect to settle and then
    /// tear it down, while a connect that starts later observes the
    /// revoked policy before any entry or capability work.
    native_policy_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Monotonic policy generation per synthesized row. Connect
    /// captures it before entry work and rechecks it immediately
    /// before registration; trust revocation and roster invalidation
    /// bump it.
    native_policy_generations: Mutex<HashMap<String, u64>>,
    /// Teardown hook the launcher's `DevserverConfigRegistry` fires
    /// after an HTTP `DELETE /api/library/devservers/{id}` drops a
    /// row, so that path reaps a live connection through
    /// `teardown_devserver_connection`. The registry (chan-server
    /// side) cannot see the `AppHandle`, so it is installed with this
    /// shared cell and the boot fills it (with a closure over the
    /// `AppHandle`) once Tauri setup runs.
    pub devserver_remove_hook: Arc<OnceLock<DevserverRemoveHook>>,
    /// The reconnect analogue of `devserver_remove_hook`: the roster
    /// poll detects a rostered row's registration moving proxy nodes
    /// but cannot see the concrete `AppHandle` the connect path
    /// needs, so it fires this cell after tearing the old connection
    /// down. Filled once Tauri setup runs.
    pub devserver_reconnect_hook: Arc<OnceLock<DevserverReconnectHook>>,
    /// The gateway analogue of `devserver_remove_hook`: HTTP
    /// `DELETE /api/library/gateways/{id}` drops a row, so that path
    /// runs the same cascade teardown the Tauri command does. Filled
    /// once Tauri setup runs.
    pub gateway_remove_hook: Arc<OnceLock<GatewayRemoveHook>>,
    /// The managed per-gateway runtime map: connect state, roster
    /// cache, poll handles. Shared with the config registry (its
    /// live-state projection) and every gateway operation.
    pub gateway_manager: Arc<GatewayManager>,
    /// Plain devserver rows whose raw-dial failure already ran the
    /// is-this-really-a-gateway backstop probe this run, so the probe
    /// never becomes a per-connect cost again.
    pub gateway_backstop_probed: Mutex<HashSet<String>>,
    /// Windows hidden ("buried") by a hide gesture, in bury order
    /// (most recent last). On iOS the single webview is never buried;
    /// the list exists so the window-ops label resolution and the
    /// last-shown guard read the same state as on desktop.
    pub buried_windows: Mutex<Vec<BuriedWindow>>,
    /// Native labels whose next `CloseRequested` is an explicit
    /// launcher or `cs window hide` gesture. The close handler
    /// consumes the one-shot flag and buries directly instead of
    /// showing the confirmation.
    pub silent_hides: Mutex<HashSet<String>>,
    /// The terminal background opacity the windows were last told, so
    /// the config hook's call for the app's own write (already
    /// announced by the command that wrote it) sends nothing again.
    /// `None` until the first announcement; a window reads its first
    /// value through the command.
    pub terminal_background_opacity: Mutex<Option<u32>>,
}

impl AppState {
    /// Fresh process state over a config store: every runtime map
    /// empty, every cell unfilled. The single construction path,
    /// shared by the real app and by tests driving the gateway and
    /// devserver flows.
    pub(crate) fn with_store(store: Arc<Mutex<ConfigStore>>) -> Self {
        Self {
            store,
            embedded: OnceLock::new(),
            devservers: Arc::new(DevserverConns::default()),
            devserver_feed: Arc::new(DevserverFeed::default()),
            devserver_connecting: Arc::new(Mutex::new(HashSet::new())),
            control_terminal_runs: Mutex::new(HashMap::new()),
            control_terminal_dead: Mutex::new(HashSet::new()),
            control_terminal_generation: std::sync::atomic::AtomicU64::new(0),
            native_policy_locks: Mutex::new(HashMap::new()),
            native_policy_generations: Mutex::new(HashMap::new()),
            devserver_remove_hook: Arc::new(OnceLock::new()),
            devserver_reconnect_hook: Arc::new(OnceLock::new()),
            gateway_remove_hook: Arc::new(OnceLock::new()),
            gateway_manager: Arc::new(GatewayManager::default()),
            gateway_backstop_probed: Mutex::new(HashSet::new()),
            buried_windows: Mutex::new(Vec::new()),
            silent_hides: Mutex::new(HashSet::new()),
            terminal_background_opacity: Mutex::new(None),
        }
    }

    /// The embedded local server, once `.setup()` has started it.
    pub(crate) fn embedded(&self) -> Option<&EmbeddedServer> {
        self.embedded.get()
    }

    pub(crate) fn native_policy_lock(&self, id: &str) -> Arc<tokio::sync::Mutex<()>> {
        Arc::clone(
            self.native_policy_locks
                .lock()
                .unwrap()
                .entry(id.to_string())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
        )
    }

    pub(crate) fn bump_native_policy_generation(&self, id: &str) -> u64 {
        let mut generations = self.native_policy_generations.lock().unwrap();
        let generation = generations.entry(id.to_string()).or_insert(0);
        *generation = generation.saturating_add(1);
        *generation
    }

    /// Record `label` as buried (most recent). Re-burying a label
    /// drops its older entry first so the list holds one entry per
    /// window and recency stays truthful.
    pub fn bury_window(&self, label: &str, title: &str) {
        let mut buried = self.buried_windows.lock().unwrap();
        buried.retain(|b| b.label != label);
        buried.push(BuriedWindow {
            label: label.to_string(),
            title: title.to_string(),
            buried_at: crate::config::now_millis(),
        });
    }

    /// Drop `label` from the buried list (unburied or destroyed).
    /// Returns whether an entry was actually removed.
    pub fn remove_buried(&self, label: &str) -> bool {
        let mut buried = self.buried_windows.lock().unwrap();
        let before = buried.len();
        buried.retain(|b| b.label != label);
        buried.len() != before
    }

    /// Mark `label` so its next close request performs an explicit
    /// hide without the red-button confirmation. Set on the main
    /// thread just before `window.close()`; consumed by the close
    /// handler.
    pub fn mark_silent_hide(&self, label: &str) {
        self.silent_hides.lock().unwrap().insert(label.to_string());
    }

    /// Consume the silent-hide flag for `label`. One-shot: a later
    /// close finds no flag and asks for confirmation as usual.
    pub fn take_silent_hide(&self, label: &str) -> bool {
        self.silent_hides.lock().unwrap().remove(label)
    }

    /// (label, title) pairs of every buried window, most recent
    /// first.
    pub fn buried_snapshot(&self) -> Vec<(String, String)> {
        self.buried_windows
            .lock()
            .unwrap()
            .iter()
            .rev()
            .map(|b| (b.label.clone(), b.title.clone()))
            .collect()
    }
}

/// Replace `library_id`'s slice of the active-transfer label set:
/// One live devserver's window snapshot, as its feed task publishes
/// it and the launcher feed reads it.
#[derive(Debug, Default)]
pub struct DevserverWindowSnapshot {
    pub windows: Vec<chan_server::WindowRecord>,
    pub tmux_connections: Vec<chan_server::TmuxConnectionRecord>,
}

impl From<Vec<chan_server::WindowRecord>> for DevserverWindowSnapshot {
    fn from(windows: Vec<chan_server::WindowRecord>) -> Self {
        Self {
            windows,
            tmux_connections: Vec::new(),
        }
    }
}

/// The native label a window record answers to:
/// `{library_id}::{window_id}`.
pub fn native_label(record: &chan_server::WindowRecord) -> String {
    format!("{}::{}", record.library_id, record.window_id)
}

pub struct ControlTerminalRun {
    pub generation: u64,
    pub prefix: String,
    pub script_based: bool,
}
/// One buried (hidden, not closed) window: see `AppState::buried_windows`.
#[derive(Debug, Clone)]
pub struct BuriedWindow {
    /// Tauri window label. Also the Window-menu item id suffix.
    pub label: String,
    /// The window's title at bury time (`serve::watched_window_title`'s
    /// "local / chan Window 2" behind its machine glyph, or a control
    /// terminal's "Control Terminal - box"), never privacy mode's mask
    /// (`AppState::bury_window`) -- the Window menu's last resort for the
    /// row's text.
    pub title: String,
    /// Wall-clock millis at bury time; diagnostics only (the Vec's
    /// push order is the recency authority).
    pub buried_at: u64,
}
/// The launcher's connected-devserver feed source: aggregates every
/// connected devserver's live window snapshot and cached workspace rows so the
/// embedded host merges them into the local launcher surface (one launcher lists
/// local + remote alike). Installed on the host via
/// `WorkspaceHost::install_devserver_feed`; the desktop registers a devserver on
/// connect (`connect_devserver_impl`) and drops it on disconnect
/// (`teardown_devserver_connection`). The trait reads are sync: the window
/// snapshots are the SAME `Arc<Mutex<…>>` each devserver window-watcher feed task
/// writes, and the async-fetched workspaces are served from a cache a per-devserver
/// poll task refreshes (`spawn_devserver_workspace_poll`).
#[derive(Default)]
pub struct DevserverFeed {
    /// Devserver id -> its live window snapshot (shared with the watcher feed task).
    windows: Mutex<HashMap<String, Arc<Mutex<DevserverWindowSnapshot>>>>,
    /// Devserver id -> its cached served workspaces (refreshed by the poll task).
    workspaces: Mutex<HashMap<String, Vec<chan_server::LauncherWorkspace>>>,
    /// Devserver id -> its cached pane-highlight colour (its own remote
    /// `LocalColorStore` value, refreshed by the poll task). Absent = no colour
    /// (default accent). Surfaced through `pane_color` so a devserver window's
    /// `?pane=` injects that devserver's own colour.
    colors: Mutex<HashMap<String, String>>,
    /// Devserver id -> its remote `library_id`, cached once learned from a window.
    /// `library_id_of` falls back to this so `entry_from_devserver` (the
    /// launcher's `DevserverEntry`) and the workspace poll still resolve the
    /// library_id when the live window feed is momentarily empty (no windows yet).
    /// Survives disconnect (the same devserver keeps its library_id on reconnect).
    library_ids: Mutex<HashMap<String, String>>,
    /// Devserver id -> its self-reported OS (`os` family, optional `pretty_name`),
    /// cached from the `DevserverInfo` probe at connect so `entry_from_devserver`
    /// resolves the launcher's machine icon. Like `library_ids`, it survives
    /// disconnect (the OS does not change across a reconnect).
    os: Mutex<HashMap<String, (String, Option<String>)>>,
    /// Native labels of devserver windows the desktop has LOCALLY buried.
    /// `windows()` overrides their `connected` to false so the launcher dot
    /// reflects hidden the moment they're hidden -- the desktop's bury state is the
    /// truth for the dot (a workspace window's remote `/ws` push agrees, but a
    /// standalone terminal on the shared `/terminal` tenant never pushes
    /// `connected:false`, so its dot hung without this).
    buried: Mutex<std::collections::HashSet<String>>,
    /// Devserver ids whose connection is DOWN: the control script exited, or
    /// the workspace poll finds the transport unreachable. `windows()` and
    /// `workspaces()` serve NO rows for a down devserver, so the launcher
    /// cannot offer open / hide / manage on workspaces it cannot reach. The
    /// caches stay intact underneath; the rows return the moment the flag
    /// clears (poll recovery or a fresh connect).
    down: Mutex<std::collections::HashSet<String>>,
    /// Devserver ids whose window/color FEED sockets are down (N consecutive
    /// feed reconnect failures) while the connection record still exists -- the
    /// post-sleep half-open zombie. Kept SEPARATE from `down` (the workspace
    /// poll's fresh-TCP set): the poll heals on a fresh dial every 5s and would
    /// fight a watchdog-driven bit, so the feed watchdog owns this flag and
    /// `entry_from_devserver` maps it to `DevserverStatus::Unreachable`.
    unreachable: Mutex<std::collections::HashSet<String>>,
}

impl DevserverFeed {
    /// The cached OS (`os` family, optional `pretty_name`) of a devserver, or
    /// `None` before its first connect. Survives disconnect (kept by `forget`).
    pub(crate) fn os_of(&self, id: &str) -> Option<(String, Option<String>)> {
        self.os.lock().unwrap().get(id).cloned()
    }

    /// Drop a disconnected devserver from the per-connection feeds (windows +
    /// workspace + colour). KEEPS `library_ids` (the same
    /// devserver keeps its id on reconnect). Clears its buried-label overrides so
    /// a reconnect doesn't show its reopened windows as hidden. The control
    /// terminal is not a desktop feed record (it is a chan-library registry
    /// row); its reap is `reap_control_window` on the connect-script PTY exit /
    /// teardown, not a `forget` drop.
    pub(crate) fn forget(&self, id: &str) {
        self.windows.lock().unwrap().remove(id);
        self.workspaces.lock().unwrap().remove(id);
        self.colors.lock().unwrap().remove(id);
        self.down.lock().unwrap().remove(id);
        self.unreachable.lock().unwrap().remove(id);
        if let Some(library_id) = self.library_ids.lock().unwrap().get(id).cloned() {
            let prefix = format!("{library_id}::");
            self.buried
                .lock()
                .unwrap()
                .retain(|l| !l.starts_with(&prefix));
        }
    }

    /// The remote `library_id` of a connected devserver. Learned from the live
    /// window snapshot and cached: on reconnect the snapshot can be empty for
    /// a moment (no windows yet), so fall back to the cached value -- otherwise the
    /// control record (which needs the library_id) wouldn't emit until a later
    /// window arrives.
    pub(crate) fn library_id_of(&self, id: &str) -> Option<String> {
        let from_snapshot = self.windows.lock().unwrap().get(id).and_then(|s| {
            s.lock()
                .unwrap()
                .windows
                .first()
                .map(|r| r.library_id.clone())
        });
        if let Some(lib) = from_snapshot {
            self.library_ids
                .lock()
                .unwrap()
                .insert(id.to_string(), lib.clone());
            return Some(lib);
        }
        self.library_ids.lock().unwrap().get(id).cloned()
    }

    /// Flip a devserver's DOWN state (connection lost / control script exited,
    /// vs recovered / reconnected). Returns whether it changed, so the caller
    /// fires the library-change signal only on a real flip.
    pub(crate) fn set_down(&self, id: &str, down: bool) -> bool {
        let mut set = self.down.lock().unwrap();
        if down {
            set.insert(id.to_string())
        } else {
            set.remove(id)
        }
    }

    /// Flip a devserver's UNREACHABLE state (its window/color feed
    /// sockets are down while the connection record still exists).
    /// Returns whether it changed. No production caller sets it on
    /// this build (there is no feed watchdog); the registry tests
    /// drive it, so it is test-only here.
    #[cfg(test)]
    pub(crate) fn set_unreachable(&self, id: &str, unreachable: bool) -> bool {
        let mut set = self.unreachable.lock().unwrap();
        if unreachable {
            set.insert(id.to_string())
        } else {
            set.remove(id)
        }
    }

    /// Whether this devserver's feed sockets are currently marked unreachable.
    pub(crate) fn is_unreachable(&self, id: &str) -> bool {
        self.unreachable.lock().unwrap().contains(id)
    }

    /// Native labels for the latest connected-devserver window snapshots. This
    /// lets launcher bridge ops resolve a bare `window_id` even when the remote
    /// window is server-hidden and has no live or locally-buried native label.
    pub(crate) fn window_labels(&self) -> Vec<String> {
        self.windows
            .lock()
            .unwrap()
            .values()
            .flat_map(|snapshot| {
                snapshot
                    .lock()
                    .unwrap()
                    .windows
                    .iter()
                    .map(native_label)
                    .collect::<Vec<_>>()
            })
            .collect()
    }

    /// Current devserver window record for a composite native label, plus the
    /// owning devserver id. Used by native window actions that must rebuild a
    /// watched remote webview from the latest per-window tenant token.
    pub(crate) fn record_for_native_label(
        &self,
        label: &str,
    ) -> Option<(String, chan_server::WindowRecord)> {
        self.windows.lock().unwrap().iter().find_map(|(id, snap)| {
            snap.lock()
                .unwrap()
                .windows
                .iter()
                .find(|r| native_label(r) == label)
                .cloned()
                .map(|record| (id.clone(), record))
        })
    }

    /// Current devserver window record for a BARE `window_id`, plus the owning
    /// devserver id -- the `cs window rm` resolution, where only the id (no
    /// composite label) crosses the bridge. Window ids are random hex minted
    /// per library, so a cross-library collision is theoretical; the first
    /// match wins.
    pub(crate) fn record_for_window_id(
        &self,
        window_id: &str,
    ) -> Option<(String, chan_server::WindowRecord)> {
        self.windows.lock().unwrap().iter().find_map(|(id, snap)| {
            snap.lock()
                .unwrap()
                .windows
                .iter()
                .find(|r| r.window_id == window_id)
                .cloned()
                .map(|record| (id.clone(), record))
        })
    }

    /// The devserver id owning `library_id`, learned from live window snapshots
    /// or the cached library id seeded at connect. The reverse of
    /// [`library_id_of`](Self::library_id_of); window-label actions use it so a
    /// disconnect overlay still resolves after the live snapshot is hidden or
    /// retired.
    pub(crate) fn devserver_id_for_library(&self, library_id: &str) -> Option<String> {
        if let Some(id) = self.windows.lock().unwrap().iter().find_map(|(id, snap)| {
            snap.lock()
                .unwrap()
                .windows
                .iter()
                .any(|r| r.library_id == library_id)
                .then(|| id.clone())
        }) {
            return Some(id);
        }
        self.library_ids
            .lock()
            .unwrap()
            .iter()
            .find_map(|(id, cached)| (cached == library_id).then(|| id.clone()))
    }
}

impl chan_server::DevserverFeedSource for DevserverFeed {
    fn tmux_connections(&self) -> Vec<chan_server::TmuxConnectionRecord> {
        let down = self.down.lock().unwrap().clone();
        self.windows
            .lock()
            .unwrap()
            .iter()
            .filter(|(id, _)| !down.contains(*id))
            .flat_map(|(_, snapshot)| snapshot.lock().unwrap().tmux_connections.clone())
            .collect()
    }

    fn windows(&self) -> Vec<chan_server::WindowRecord> {
        // A DOWN devserver (script exited / transport unreachable) serves no
        // window rows at all: every launcher affordance on them (open / hide /
        // focus) needs the connection that is gone.
        let down = self.down.lock().unwrap().clone();
        let mut records: Vec<chan_server::WindowRecord> = self
            .windows
            .lock()
            .unwrap()
            .iter()
            .filter(|(id, _)| !down.contains(*id))
            .flat_map(|(_, snapshot)| snapshot.lock().unwrap().windows.clone())
            .collect();
        // While this desktop has buried a window, report it to the launcher as
        // disconnected with no holder list because the closed webview cannot
        // identify any other client's socket.
        {
            let buried = self.buried.lock().unwrap();
            if !buried.is_empty() {
                for r in records.iter_mut() {
                    if buried.contains(&native_label(r)) {
                        r.connected = false;
                        r.holders = None;
                    }
                }
            }
        }
        // The control terminal is not synthesized here: it is a
        // real chan-library registry row (minted by `mint_control_window` under the
        // devserver's `library_id`, `control:true`), so it already rides the
        // registry snapshot that `assemble_window_records` merges -- no desktop-side
        // append.
        records
    }

    fn workspaces(&self) -> Vec<chan_server::LauncherWorkspace> {
        // Mirror `windows()`: a DOWN devserver serves no workspace rows, so
        // the launcher cannot offer on/off/forget on workspaces it cannot
        // reach. The cache underneath survives for the recovery re-render.
        let down = self.down.lock().unwrap().clone();
        self.workspaces
            .lock()
            .unwrap()
            .iter()
            .filter(|(id, _)| !down.contains(*id))
            .flat_map(|(_, rows)| rows.clone())
            .collect()
    }

    fn pane_color(&self, library_id: &str) -> Option<String> {
        // The colour of the connected devserver owning `library_id` -- its own
        // cached `LocalColorStore` value. `WorkspaceHost::pane_color` delegates
        // here for `lib-<hex>` ids; `None` -> the editor's default accent.
        let id = self.devserver_id_for_library(library_id)?;
        self.colors.lock().unwrap().get(&id).cloned()
    }
}
