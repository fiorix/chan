#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod auth;
mod config;
mod cs_install;
mod devserver;
mod download;
mod dropped_paths;
mod embedded;
mod gateway;
mod linux_gui_stack;
mod native_dialog;
mod native_transfer;
mod registry;
mod remote_workspace;
mod revtunnel;
mod runtime_capability;
mod serve;
mod upload;
mod watcher;
mod window_ops;
mod window_watcher;
mod window_watcher_wiring;

use std::collections::HashMap;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
// MenuItemKind and the predefined-menu items are only NAMED by the
// macOS menu surgery (strip-close / About matching); the dynamic
// Window-menu rebuild iterates items without naming the kind, so
// off-macOS those imports are unused and `-D warnings` fails the Linux
// build (caught by CI, not the local macOS gate, which never compiles
// the other cfg branch).
use tauri::menu::{Menu, MenuItemBuilder, Submenu};
#[cfg(target_os = "macos")]
use tauri::menu::{MenuItemKind, PredefinedMenuItem, WINDOW_SUBMENU_ID};
use tauri::{Emitter, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_opener::OpenerExt;

use config::{ConfigStore, WindowGeometry};
use serve::ServeHandle;
use window_watcher_wiring::DevserverWatcherStop;

const SYSTEM_NOTICE: &str = "system-notice";

/// The commit this binary was built from, stamped by build.rs ("unknown"
/// outside a git checkout). The version string alone cannot identify a
/// build: the version pins bump only at release cut, so a pre-release
/// branch build and the previous release's bundle carry the same version.
/// Shown in About, logged at startup, and advertised by
/// [`native_vocabulary`], the surfaces an acceptance run looks at.
const CHAN_DESKTOP_BUILD_ID: &str = env!("CHAN_DESKTOP_BUILD_ID");
const DESKTOP_UPDATE_READY_EVENT: &str = "desktop-update-ready";

/// What the launcher's update-ready dialog needs: the version, and whether
/// the bytes are already installed on disk (macOS and the Linux AppImage
/// swap the bundle in place, so dismissing the dialog still applies it on
/// the next launch) or only downloaded and staged (Windows, where the NSIS
/// installer is the process exit and runs only when the user restarts from
/// the dialog).
#[derive(Debug, Clone, Serialize)]
struct DesktopUpdateReadyPayload {
    version: String,
    installed: bool,
}

/// Windows: an update the on-launch check downloaded and verified, parked
/// until the user restarts from the launcher's dialog. The installer is the
/// exit, so it never runs unasked; a dismissed dialog keeps nothing across
/// launches (the next launch downloads and asks again).
#[cfg(windows)]
pub struct PendingUpdate {
    update: tauri_plugin_updater::Update,
    bytes: Vec<u8>,
    version: String,
}

/// Reconnect hook for a rostered row whose registration moved proxy nodes:
/// fires the normal connect flow ([`connect_devserver_impl`]) for one
/// synthesized row id. Mirror of [`config::DevserverRemoveHook`], filled
/// once Tauri setup runs because gateway.rs cannot see the concrete
/// `AppHandle`.
pub type DevserverReconnectHook = Arc<dyn Fn(&str) + Send + Sync>;

/// Process-wide state. Shared via `Arc` because Tauri commands and
/// background runtime owners need the same state handle.
pub struct AppState {
    /// Shared config handle. An `Arc<Mutex<…>>` (not a bare `Mutex`) so the
    /// launcher's [`DevserverConfigRegistry`](config::DevserverConfigRegistry),
    /// installed into the embedded host, writes the SAME config the desktop's
    /// own commands and the window-config LRU do -- every full-file rewrite
    /// serializes through one lock, so a devserver CRUD can't lose an update to
    /// a concurrent window-config save.
    store: Arc<Mutex<ConfigStore>>,
    /// Live embedded local workspaces keyed by canonical workspace path.
    serves: Mutex<HashMap<String, ServeHandle>>,
    /// In-process chan-server host for normal local workspaces.
    /// Initialized during Tauri setup, after the async runtime is
    /// available for Tokio listener registration.
    embedded: OnceLock<embedded::EmbeddedServer>,
    /// The local window watcher's desktop-local view state,
    /// shared so the close handlers can bury/unbury through the watcher rather
    /// than the legacy hide path. Set once when the watcher spawns.
    local_watcher_view: OnceLock<Arc<window_watcher::WatcherViewState>>,
    /// Per-live-window zoom level. Tracks the
    /// current zoom for every open webview keyed by window label so
    /// `zoom_in` / `zoom_out` / `zoom_reset` can compute the next
    /// level without spawning a JS eval round-trip to read the
    /// current. Missing entries read as 1.0 (the chan-desktop default).
    pub live_window_zooms: Mutex<HashMap<String, f64>>,
    /// Per-live-window display number, keyed by window label, with the
    /// base title it was assigned under. Drives the `"{title} Window
    /// {N}"` suffix so the OS Window menu disambiguates windows that
    /// share a base title (two windows on the same workspace, several
    /// standalone terminals). `N` is the lowest free number among live
    /// windows with the SAME base title, so a number freed by a closed
    /// window gets reused -- mirroring `Registry::next_terminal_name`'s
    /// lowest-free `Terminal-N` scheme. Freed on window destroy; a
    /// hidden-in-place control terminal keeps its number until destruction.
    pub window_numbers: Mutex<HashMap<String, (String, u64)>>,
    /// Custom window titles set via `cs window title <id> <title>`, keyed
    /// by window label. Consulted by `build_workspace_window_with_completion`
    /// so the override survives the bury/reopen cycle (the auto "{base} Window
    /// {N}" scheme applies only when there's no override). Session-scoped: not
    /// persisted across an app restart, like the display numbers.
    pub window_title_overrides: Mutex<HashMap<String, String>>,
    /// Windows hidden ("buried") by the OS close button, in bury order (most
    /// recent last). Watcher-managed windows close their native surface but keep
    /// their library record; a control terminal stays hidden in place. The
    /// Window menu lists each entry for reopening. Entries leave the list on
    /// unbury or final window destruction.
    pub buried_windows: Mutex<Vec<BuriedWindow>>,
    /// Native labels whose next `CloseRequested` is an explicit launcher or
    /// `cs window hide` gesture. The close handler consumes the one-shot flag and
    /// buries directly instead of showing the red-button confirmation.
    pub silent_hides: Mutex<std::collections::HashSet<String>>,
    /// Live connections to devservers, keyed by `Devserver.id`. A devserver
    /// present here is connected (the launcher polls its workspace list and
    /// can open its tenants); absent means disconnected. In memory only:
    /// the bearer token rotates, so it is re-acquired on each connect.
    pub devservers: Arc<devserver::DevserverConns>,
    /// The launcher's connected-devserver feed source. Installed on the
    /// embedded host; populated on connect and drained on disconnect. The host
    /// reads it when assembling the launcher's window + workspace lists.
    pub devserver_feed: Arc<DevserverFeed>,
    /// Per connected devserver (`Devserver.id`), the stop handle for its window
    /// watcher. Disconnect stops the watcher and closes that devserver's native
    /// windows; `mark_devserver_control_exited` retires the watcher while keeping
    /// its windows for the user's reconnect or abandon decision.
    pub(crate) devserver_watchers:
        Mutex<HashMap<String, tokio::sync::watch::Sender<DevserverWatcherStop>>>,
    /// Per connected devserver (`Devserver.id`), its window-watcher view state,
    /// the devserver analog of `local_watcher_view`. The close handler buries a
    /// devserver window through it so the reconcile CLOSES
    /// the webview (drops the `/ws`) rather than hiding it alive, letting the
    /// launcher dot reflect hidden. Dropped on disconnect with the watcher.
    pub devserver_watcher_views: Mutex<HashMap<String, Arc<window_watcher::WatcherViewState>>>,
    /// Devserver windows whose remote registry DELETE has not yet been observed
    /// absent from an authoritative feed snapshot. Process-local by design: the
    /// close intent survives watcher replacement and suppresses stale records,
    /// but a desktop restart clears it.
    pub(crate) pending_window_deletes: Arc<window_watcher::PendingDeleteState>,
    /// Composite native labels (`{library_id}::{window_id}`) of connected-
    /// devserver windows that currently have an in-flight file transfer, as
    /// reported by each devserver's windows feed (`WindowRecord.active_transfer`).
    /// A desktop webview onto a remote devserver sees no remote `/ws` traffic, so
    /// the feed bit is the close guard's only signal that a remote window is
    /// mid-transfer (the local library answers through the embedded host instead).
    /// Volatile: each devserver feed push refreshes its library's slice.
    pub devserver_active_transfers: Mutex<std::collections::HashSet<String>>,
    /// Current scripted control run per devserver. The generation binds the
    /// prefix, watcher, and connect result so a stale run cannot emit against or
    /// overwrite a newer connect attempt.
    pub control_terminal_runs: Mutex<HashMap<String, ControlTerminalRun>>,
    /// Devservers whose control script exited (or whose connect failed) while
    /// the control terminal is still live: the connection is marked down but the
    /// control terminal is KEPT at "process exited" so the user can read the
    /// death reason. Reconnect is BLOCKED for these ids until the control
    /// terminal is closed (`close_devserver_control_terminal` clears the id), so
    /// the user has to see why it ended (or hit Reconnect, whose teardown reaps it).
    pub control_terminal_dead: Mutex<std::collections::HashSet<String>>,
    /// Monotonic generation source for scripted control runs.
    pub control_terminal_generation: std::sync::atomic::AtomicU64,
    /// Devservers with a connect request currently in flight. A second connect
    /// coalesces into the first instead of spawning another control terminal.
    pub devserver_connecting: Arc<Mutex<std::collections::HashSet<String>>>,
    /// Per synthesized row serialization for connect, trust mutation, roster
    /// revocation, and gateway cascades. Holding the async lock makes DELETE
    /// wait for an older connect to settle and then tear it down, while a
    /// connect that starts later observes the revoked policy before any entry
    /// or capability work.
    native_policy_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Monotonic policy generation per synthesized row. Connect captures it
    /// before entry work and rechecks it immediately before registration; trust
    /// revocation and roster invalidation bump it.
    native_policy_generations: Mutex<HashMap<String, u64>>,
    /// Teardown hook the launcher's
    /// [`DevserverConfigRegistry`](config::DevserverConfigRegistry) fires after an
    /// HTTP `DELETE /api/library/devservers/{id}` drops a row, so that path
    /// reaps a live connection/windows through [`teardown_devserver_connection`]
    /// (shared with `disconnect_devserver`). The registry (chan-server side) can't see the `AppHandle`,
    /// so it's installed with this shared cell and the desktop fills it (with a
    /// closure over the `AppHandle`) once Tauri setup runs.
    pub devserver_remove_hook: Arc<OnceLock<config::DevserverRemoveHook>>,
    /// The reconnect analogue of [`devserver_remove_hook`](Self::devserver_remove_hook):
    /// the roster poll (gateway.rs) detects a rostered row's registration
    /// moving proxy nodes but cannot see the concrete `AppHandle` the
    /// connect path needs, so it fires this cell after tearing the old
    /// connection down. Filled once Tauri setup runs.
    pub devserver_reconnect_hook: Arc<OnceLock<DevserverReconnectHook>>,
    /// The gateway analogue of [`devserver_remove_hook`](Self::devserver_remove_hook):
    /// HTTP `DELETE /api/library/gateways/{id}` drops a row, so that path runs
    /// the same cascade teardown the Tauri command does. Filled once Tauri
    /// setup runs.
    pub gateway_remove_hook: Arc<OnceLock<config::GatewayRemoveHook>>,
    /// The managed per-gateway runtime map: connect state, roster cache,
    /// poll handles. Shared with the config registry (its live-state
    /// projection) and every gateway operation.
    pub gateway_manager: Arc<gateway::GatewayManager>,
    /// Plain devserver rows whose raw-dial failure already ran the
    /// is-this-really-a-gateway backstop probe this run, so the probe
    /// never becomes a per-connect cost again.
    pub gateway_backstop_probed: Mutex<std::collections::HashSet<String>>,
    /// The startup legacy-row migration outcome, parked until the first
    /// launcher page load takes it and narrates it as a notice (an emit at
    /// startup would fire before the SPA subscribes). `None` when nothing
    /// migrated or once the notice went out.
    pub gateway_migration: Mutex<Option<config::GatewayMigration>>,
    /// Set when the user confirmed the quit dialog: the re-fired
    /// `ExitRequested` (from `app.exit(0)` in the dialog callback)
    /// must pass instead of prompting again.
    pub quit_confirmed: std::sync::atomic::AtomicBool,
    /// One-shot guard for the awaited embedded-tenant drain that precedes a
    /// normal exit or update restart.
    pub shutdown_started: std::sync::atomic::AtomicBool,
    /// True while the quit-confirmation dialog is showing, so a
    /// repeated Cmd+Q doesn't stack a second dialog.
    pub quit_prompt_open: std::sync::atomic::AtomicBool,
    /// Windows: the downloaded, verified update waiting for the user to
    /// restart from the launcher's dialog (see [`PendingUpdate`]).
    #[cfg(windows)]
    pub pending_update: Mutex<Option<PendingUpdate>>,
    /// Serializes the updater's download/install across its two drivers, the
    /// on-launch check and a handoff `chan upgrade`. Both can run against the
    /// same image at once (a `chan upgrade` that launched the desktop arrives
    /// while the on-launch check is already downloading), and the plugin's
    /// in-place replace of the AppImage / staged installer must not race.
    pub update_gate: tokio::sync::Mutex<()>,
    /// The version the on-launch check already installed on disk (macOS, the
    /// AppImage), so a handoff `chan upgrade` that arrives afterwards relaunches
    /// into it instead of downloading the same payload again.
    pub update_installed_version: Mutex<Option<String>>,
}

impl AppState {
    /// Fresh process state over a config store: every runtime map empty,
    /// every cell unfilled. The single construction path, shared by the
    /// real app and by tests driving the gateway/devserver flows.
    pub(crate) fn with_store(store: Arc<Mutex<ConfigStore>>) -> Self {
        Self {
            store,
            serves: Mutex::new(HashMap::new()),
            embedded: OnceLock::new(),
            local_watcher_view: OnceLock::new(),
            live_window_zooms: Mutex::new(HashMap::new()),
            window_numbers: Mutex::new(HashMap::new()),
            window_title_overrides: Mutex::new(HashMap::new()),
            buried_windows: Mutex::new(Vec::new()),
            silent_hides: Mutex::new(std::collections::HashSet::new()),
            devservers: Arc::new(devserver::DevserverConns::default()),
            devserver_feed: Arc::new(DevserverFeed::default()),
            devserver_watchers: Mutex::new(HashMap::new()),
            devserver_watcher_views: Mutex::new(HashMap::new()),
            pending_window_deletes: Arc::new(window_watcher::PendingDeleteState::default()),
            devserver_active_transfers: Mutex::new(std::collections::HashSet::new()),
            control_terminal_runs: Mutex::new(HashMap::new()),
            control_terminal_dead: Mutex::new(std::collections::HashSet::new()),
            control_terminal_generation: std::sync::atomic::AtomicU64::new(0),
            devserver_connecting: Arc::new(Mutex::new(std::collections::HashSet::new())),
            native_policy_locks: Mutex::new(HashMap::new()),
            native_policy_generations: Mutex::new(HashMap::new()),
            devserver_remove_hook: Arc::new(OnceLock::new()),
            devserver_reconnect_hook: Arc::new(OnceLock::new()),
            gateway_remove_hook: Arc::new(OnceLock::new()),
            gateway_manager: Arc::new(gateway::GatewayManager::default()),
            gateway_backstop_probed: Mutex::new(std::collections::HashSet::new()),
            gateway_migration: Mutex::new(None),
            quit_confirmed: std::sync::atomic::AtomicBool::new(false),
            shutdown_started: std::sync::atomic::AtomicBool::new(false),
            quit_prompt_open: std::sync::atomic::AtomicBool::new(false),
            #[cfg(windows)]
            pending_update: Mutex::new(None),
            update_gate: tokio::sync::Mutex::new(()),
            update_installed_version: Mutex::new(None),
        }
    }

    fn native_policy_lock(&self, id: &str) -> Arc<tokio::sync::Mutex<()>> {
        Arc::clone(
            self.native_policy_locks
                .lock()
                .unwrap()
                .entry(id.to_string())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
        )
    }

    fn native_policy_generation(&self, id: &str) -> u64 {
        self.native_policy_generations
            .lock()
            .unwrap()
            .get(id)
            .copied()
            .unwrap_or(0)
    }

    fn bump_native_policy_generation(&self, id: &str) -> u64 {
        let mut generations = self.native_policy_generations.lock().unwrap();
        let generation = generations.entry(id.to_string()).or_insert(0);
        *generation = generation.saturating_add(1);
        *generation
    }
}

#[derive(Debug, Clone)]
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
    /// OS display title at bury time ("🏠 /path Window 2",
    /// "Terminal Window 1") -- shown verbatim in the Window menu.
    pub title: String,
    /// Wall-clock millis at bury time; diagnostics only (the Vec's
    /// push order is the recency authority).
    pub buried_at: u64,
}

/// Lowest free display number (`>= 1`) for `base` among the live
/// window-number entries, ignoring any slot already held by `label`
/// itself (so a re-assign of the same window keeps its number stable).
/// Split out as a free function so the reuse logic is unit-testable
/// without constructing a full `AppState`.
fn lowest_free_window_number(
    numbers: &HashMap<String, (String, u64)>,
    label: &str,
    base: &str,
) -> u64 {
    let taken: std::collections::HashSet<u64> = numbers
        .iter()
        .filter(|(l, (b, _))| l.as_str() != label && b == base)
        .map(|(_, (_, n))| *n)
        .collect();
    (1u64..)
        .find(|n| !taken.contains(n))
        .expect("the naturals always contain a free slot")
}

/// Replace `library_id`'s slice of the active-transfer label set: drop every
/// entry under the `{library_id}::` prefix, then insert `active_labels`. Split
/// out as a free function so the per-library refresh is unit-testable without an
/// `AppState`. Each devserver's feed owns its own library prefix, so refreshing
/// one library never disturbs another's entries.
fn refresh_library_transfers(
    set: &mut std::collections::HashSet<String>,
    library_id: &str,
    active_labels: &[String],
) {
    let prefix = format!("{library_id}::");
    set.retain(|l| !l.starts_with(&prefix));
    set.extend(active_labels.iter().cloned());
}

impl AppState {
    /// The embedded local server, once `.setup()` has started it. The
    /// window-watcher wiring reads the library's window feed through this.
    pub(crate) fn embedded(&self) -> Option<&embedded::EmbeddedServer> {
        self.embedded.get()
    }

    /// The window watcher's view state, once the watcher has
    /// spawned. Close handlers bury/unbury local windows through it.
    pub(crate) fn local_watcher_view(&self) -> Option<&Arc<window_watcher::WatcherViewState>> {
        self.local_watcher_view.get()
    }

    /// Record the watcher's view state so close handlers can reach it. Set once.
    pub(crate) fn set_local_watcher_view(&self, view: Arc<window_watcher::WatcherViewState>) {
        let _ = self.local_watcher_view.set(view);
    }

    /// Refresh the active-transfer labels for one devserver library from a feed
    /// snapshot: drop this library's stale slice and re-add the labels the push
    /// marks `active_transfer`. Volatile per-push state -- the windows feed
    /// re-reports the bit on every change, so each push fully refreshes the slice.
    pub(crate) fn refresh_devserver_active_transfers(
        &self,
        library_id: &str,
        active_labels: &[String],
    ) {
        let mut set = self.devserver_active_transfers.lock().unwrap();
        refresh_library_transfers(&mut set, library_id, active_labels);
    }

    /// True iff the cached feed bit marks this devserver window (a composite
    /// `{library_id}::{window_id}` native label) as having an in-flight transfer.
    /// The local library answers through the embedded host instead.
    pub(crate) fn devserver_window_has_active_transfer(&self, native_label: &str) -> bool {
        self.devserver_active_transfers
            .lock()
            .unwrap()
            .contains(native_label)
    }

    /// Upsert a window's freshly-captured OS geometry into the desktop-local
    /// geometry LRU (see `config::push_window_geometry`). Keyed by the stable
    /// native window label and covers every window class. Best-effort: any I/O
    /// error is logged and dropped.
    pub fn push_window_geometry(&self, label: &str, geom: WindowGeometry) {
        let mut store = self.store.lock().unwrap();
        let mut cfg = match store.get() {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(error = %e, "loading config to push window geometry failed");
                return;
            }
        };
        config::push_window_geometry(&mut cfg, label, geom);
        if let Err(e) = store.save(&cfg) {
            tracing::warn!(error = %e, "persisting window geometry stack failed");
        }
    }

    /// Resolve the geometry to apply for `label` under `current_sig` (see
    /// `config::lookup_window_geometry`): exact-signature restore vs size-only
    /// fallback vs nothing. Read-only; `None` on a config read error (the open
    /// then falls back to the default size).
    pub fn lookup_window_geometry(
        &self,
        label: &str,
        current_sig: &str,
    ) -> Option<config::GeometryMatch> {
        let cfg = match self.store.lock().unwrap().get() {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(error = %e, "loading config to look up window geometry failed");
                return None;
            }
        };
        config::lookup_window_geometry(&cfg, label, current_sig)
    }

    /// Assign the lowest-free display number for `base` among live
    /// windows that share the same base title, record it under
    /// `label`, and return it. The first window of a given base is
    /// `1`; a number freed by `release_window_number` is handed back
    /// out on the next assign -- mirroring the lowest-free reuse of
    /// `Registry::next_terminal_name`. Re-assigning the same `label`
    /// (a defensive double-build) refreshes its slot.
    pub fn assign_window_number(&self, label: &str, base: &str) -> u64 {
        let mut numbers = self.window_numbers.lock().unwrap();
        let n = lowest_free_window_number(&numbers, label, base);
        numbers.insert(label.to_string(), (base.to_string(), n));
        n
    }

    /// Release the display number held by `label` so it can be reused
    /// by the next window with the same base title. Called from the
    /// window-destroy handler. A no-op for an unknown label.
    pub fn release_window_number(&self, label: &str) {
        self.window_numbers.lock().unwrap().remove(label);
    }

    /// The custom OS-title override for `label`, if any (read by
    /// `build_workspace_window_with_completion`).
    pub fn window_title_override(&self, label: &str) -> Option<String> {
        self.window_title_overrides
            .lock()
            .unwrap()
            .get(label)
            .cloned()
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
            buried_at: config::current_millis(),
        });
    }

    /// Drop `label` from the buried list (unburied or destroyed).
    /// Returns whether an entry was actually removed, so callers know
    /// if the Window menu needs a rebuild.
    pub fn remove_buried(&self, label: &str) -> bool {
        let mut buried = self.buried_windows.lock().unwrap();
        let before = buried.len();
        buried.retain(|b| b.label != label);
        buried.len() != before
    }

    /// Mark `label` so its next close request performs an explicit hide without
    /// the red-button confirmation. Set on the main thread just before
    /// `window.close()`; consumed by the close handler.
    pub fn mark_silent_hide(&self, label: &str) {
        self.silent_hides.lock().unwrap().insert(label.to_string());
    }

    /// Consume the silent-hide flag for `label`. One-shot: a later red-button
    /// close finds no flag and asks for confirmation as usual.
    pub fn take_silent_hide(&self, label: &str) -> bool {
        self.silent_hides.lock().unwrap().remove(label)
    }

    /// (label, title) pairs of every buried window, most recent first
    /// (Window-menu display order).
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

/// The launcher's connected-devserver feed source: aggregates every
/// connected devserver's live window snapshot and cached workspace rows so the
/// embedded host merges them into the local launcher surface (one launcher lists
/// local + remote alike). Installed on the host via
/// `WorkspaceHost::install_devserver_feed`; the desktop registers a devserver on
/// connect ([`connect_devserver_impl`]) and drops it on disconnect
/// ([`teardown_devserver_connection`]). The trait reads are sync: the window
/// snapshots are the SAME `Arc<Mutex<…>>` each devserver window-watcher feed task
/// writes, and the async-fetched workspaces are served from a cache a per-devserver
/// poll task refreshes ([`spawn_devserver_workspace_poll`]).
#[derive(Default)]
pub struct DevserverFeed {
    /// Devserver id -> its live window snapshot (shared with the watcher feed task).
    windows: Mutex<HashMap<String, Arc<Mutex<Vec<chan_server::WindowRecord>>>>>,
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
    /// Track a freshly-connected devserver's window snapshot so `windows()` sees
    /// it; the Arc is the one the watcher feed task mutates in place.
    fn register_windows(&self, id: String, snapshot: Arc<Mutex<Vec<chan_server::WindowRecord>>>) {
        self.windows.lock().unwrap().insert(id, snapshot);
    }

    /// Seed a devserver's remote `library_id` into the cache BEFORE its first
    /// window reaches the snapshot. The connect flow learns the id from
    /// `wait_for_devserver`'s `info` and mints the control row under it; without
    /// this seed, `library_id_of` returns `None` until a later window syncs the
    /// mapping, so the launcher cannot match the control row's `library_id` to this
    /// devserver and groups it under a blank `↗` header. Seeding here makes
    /// `entry_from_devserver` carry the real id from the FIRST render so the control
    /// row groups under its parent devserver immediately. Idempotent; a later
    /// snapshot read re-caches the same value.
    fn seed_library_id(&self, id: String, library_id: String) {
        self.library_ids.lock().unwrap().insert(id, library_id);
    }

    /// Seed a devserver's self-reported OS from the connect probe so the launcher
    /// machine icon resolves from the FIRST render rather than waiting on a later
    /// refetch. Idempotent; a reconnect re-seeds the same value.
    fn seed_os(&self, id: String, os: String, pretty_name: Option<String>) {
        self.os.lock().unwrap().insert(id, (os, pretty_name));
    }

    /// The cached OS (`os` family, optional `pretty_name`) of a devserver, or
    /// `None` before its first connect. Survives disconnect (kept by `forget`).
    fn os_of(&self, id: &str) -> Option<(String, Option<String>)> {
        self.os.lock().unwrap().get(id).cloned()
    }

    /// Drop a disconnected devserver from the per-connection feeds (windows +
    /// workspace + colour). KEEPS `library_ids` (the same
    /// devserver keeps its id on reconnect). Clears its buried-label overrides so
    /// a reconnect doesn't show its reopened windows as hidden. The control
    /// terminal is not a desktop feed record (it is a chan-library registry
    /// row); its reap is `reap_control_window` on the connect-script PTY exit /
    /// teardown, not a `forget` drop.
    fn forget(&self, id: &str) {
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

    /// Replace a devserver's cached workspace rows (the poll task gates this on a
    /// real change, so this just stores).
    fn set_workspaces(&self, id: String, rows: Vec<chan_server::LauncherWorkspace>) {
        self.workspaces.lock().unwrap().insert(id, rows);
    }

    /// Replace a devserver's cached colour (the colour watch gates its
    /// re-push on this). `None` clears it (the devserver has no colour set →
    /// default accent). Returns whether the stored value CHANGED, so the caller
    /// signals the library only on a real delta (the watch pushes on connect too).
    fn set_color(&self, id: String, color: Option<String>) -> bool {
        let mut colors = self.colors.lock().unwrap();
        if colors.get(&id).cloned() == color {
            return false;
        }
        match color {
            Some(c) => {
                colors.insert(id, c);
            }
            None => {
                colors.remove(&id);
            }
        }
        true
    }

    /// The remote `library_id` of a connected devserver. Learned from the live
    /// window snapshot and cached: on reconnect the snapshot can be empty for
    /// a moment (no windows yet), so fall back to the cached value -- otherwise the
    /// control record (which needs the library_id) wouldn't emit until a later
    /// window arrives.
    fn library_id_of(&self, id: &str) -> Option<String> {
        let from_snapshot = self
            .windows
            .lock()
            .unwrap()
            .get(id)
            .and_then(|s| s.lock().unwrap().first().map(|r| r.library_id.clone()));
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
    fn set_down(&self, id: &str, down: bool) -> bool {
        let mut set = self.down.lock().unwrap();
        if down {
            set.insert(id.to_string())
        } else {
            set.remove(id)
        }
    }

    /// Flip a devserver's UNREACHABLE state (its window/color feed sockets are
    /// down while the connection record still exists). Returns whether it
    /// changed, so the caller fires the attention/library signals only on a real
    /// flip. Read by `entry_from_devserver` to render `DevserverStatus::Unreachable`.
    fn set_unreachable(&self, id: &str, unreachable: bool) -> bool {
        let mut set = self.unreachable.lock().unwrap();
        if unreachable {
            set.insert(id.to_string())
        } else {
            set.remove(id)
        }
    }

    /// Whether this devserver's feed sockets are currently marked unreachable.
    fn is_unreachable(&self, id: &str) -> bool {
        self.unreachable.lock().unwrap().contains(id)
    }

    /// Mark a devserver window LOCALLY buried (or un-buried) so `windows()`
    /// overrides its `connected`. Returns whether it changed, so the caller
    /// fires the library-change signal only on a real flip.
    fn set_buried(&self, label: &str, buried: bool) -> bool {
        let mut set = self.buried.lock().unwrap();
        if buried {
            set.insert(label.to_string())
        } else {
            set.remove(label)
        }
    }

    /// Native labels for the latest connected-devserver window snapshots. This
    /// lets launcher bridge ops resolve a bare `window_id` even when the remote
    /// window is server-hidden and has no live or locally-buried native label.
    fn window_labels(&self) -> Vec<String> {
        self.windows
            .lock()
            .unwrap()
            .values()
            .flat_map(|snapshot| {
                snapshot
                    .lock()
                    .unwrap()
                    .iter()
                    .map(window_watcher::native_label)
                    .collect::<Vec<_>>()
            })
            .collect()
    }

    /// Current devserver window record for a composite native label, plus the
    /// owning devserver id. Used by native window actions that must rebuild a
    /// watched remote webview from the latest per-window tenant token.
    fn record_for_native_label(&self, label: &str) -> Option<(String, chan_server::WindowRecord)> {
        self.windows.lock().unwrap().iter().find_map(|(id, snap)| {
            snap.lock()
                .unwrap()
                .iter()
                .find(|r| window_watcher::native_label(r) == label)
                .cloned()
                .map(|record| (id.clone(), record))
        })
    }

    /// Current devserver window record for a BARE `window_id`, plus the owning
    /// devserver id -- the `cs window rm` resolution, where only the id (no
    /// composite label) crosses the bridge. Window ids are random hex minted
    /// per library, so a cross-library collision is theoretical; the first
    /// match wins.
    fn record_for_window_id(&self, window_id: &str) -> Option<(String, chan_server::WindowRecord)> {
        self.windows.lock().unwrap().iter().find_map(|(id, snap)| {
            snap.lock()
                .unwrap()
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
    fn devserver_id_for_library(&self, library_id: &str) -> Option<String> {
        if let Some(id) = self.windows.lock().unwrap().iter().find_map(|(id, snap)| {
            snap.lock()
                .unwrap()
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
            .flat_map(|(_, snapshot)| snapshot.lock().unwrap().clone())
            .collect();
        // Override `connected` for windows the desktop has LOCALLY buried so
        // the launcher dot reflects hidden immediately -- the desktop's bury state
        // is the truth for the dot. A workspace window's remote `/ws` drop agrees,
        // but a standalone terminal on the shared `/terminal` tenant never pushes
        // `connected:false`, so its dot hung without this.
        {
            let buried = self.buried.lock().unwrap();
            if !buried.is_empty() {
                for r in records.iter_mut() {
                    if buried.contains(&window_watcher::native_label(r)) {
                        r.connected = false;
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

/// Tag a connected devserver's workspace row as a launcher row: keyed by its
/// remote mount `prefix` and discriminated by `devserver_id` (the field the SPA
/// groups + routes on); `library_id` is the best-effort remote-library tag. The
/// remote prefix is an absolute route path (`/slug`); the `LauncherWorkspace.prefix`
/// contract is the slash-free SLUG (local + devserver alike, pinned by
/// chan-library's doc), so strip the leading slash here. The on/off/forget ops
/// round-trip that slug and [`devserver_route_prefix`] re-adds the slash for the
/// remote management API.
fn to_launcher_workspace(
    devserver_id: &str,
    library_id: Option<String>,
    row: devserver::DevserverWorkspaceRow,
) -> chan_server::LauncherWorkspace {
    let slug = row.prefix.trim_start_matches('/').to_string();
    chan_server::LauncherWorkspace {
        workspace_id: slug.clone(),
        path: row.path,
        status: row.status,
        error: row.error,
        label: row.label,
        on: row.on,
        library_id,
        devserver_id: Some(devserver_id.to_string()),
        prefix: slug,
    }
}

/// Refresh one connected devserver's workspace cache immediately after a
/// launcher-driven mutation. The poll loop remains the fallback for missed
/// changes, but the acting launcher should not wait up to five seconds to leave
/// a stale on/off state.
async fn refresh_devserver_workspace_cache(
    state: &Arc<AppState>,
    id: &str,
    conn: &devserver::DevserverConn,
) -> Result<(), String> {
    let rows = devserver::fetch_workspaces(conn).await?;
    let library_id = state.devserver_feed.library_id_of(id);
    let mapped = rows
        .into_iter()
        .map(|r| to_launcher_workspace(id, library_id.clone(), r))
        .collect();
    state.devserver_feed.set_workspaces(id.to_string(), mapped);
    if let Some(embedded) = state.embedded() {
        embedded.signal_library_change();
    }
    Ok(())
}

/// The launcher addresses a devserver workspace by its slash-free slug (the
/// `LauncherWorkspace.prefix` contract), but the devserver management API
/// (`/api/devserver/workspaces{prefix}/on`, the DELETE) addresses it as an
/// absolute route path. Re-add the leading slash for the remote call; idempotent
/// so an already-absolute prefix passes through unchanged.
fn devserver_route_prefix(slug: &str) -> String {
    if slug.starts_with('/') {
        slug.to_string()
    } else {
        format!("/{slug}")
    }
}

const DEVSERVER_CONTROL_ATTENTION_EVENT: &str = "devserver-control-attention";
const DEVSERVER_CONTROL_RESTORED_EVENT: &str = "devserver-control-restored";

/// Warm a devserver's pane-colour cache before its window watcher opens any
/// window, so a devserver window seeds its `?pane=` colour from the first
/// build instead of flashing blue until the colour watch
/// ([`window_watcher_wiring::spawn_devserver_color_watch`]) pushes its first
/// frame. The cache is keyed by devserver id and read through `pane_color` at
/// mint time; the watch keeps it live afterwards. Best-effort: a failed fetch
/// leaves the cache cold for the watch to fill and logs `failure` at debug, so
/// connect never fails on it. The local library needs no analog, since its
/// `pane_color("local")` reads the persisted desktop config directly.
async fn seed_devserver_color(
    state: &AppState,
    id: &str,
    conn: &devserver::DevserverConn,
    failure: &str,
) {
    match devserver::fetch_local_color(conn).await {
        Ok(color) => {
            state.devserver_feed.set_color(id.to_string(), color);
        }
        Err(e) => {
            tracing::debug!(devserver = %id, error = %e, "{failure}");
        }
    }
}

/// Wire a devserver's freshly spawned window watcher into the launcher: clear
/// any down flag a script death or an outage left so the rows render at once,
/// register the watcher's live window snapshot, seed the workspace list from
/// `rows` when the connect fetched them already, then start the workspace
/// poll and the colour watch on the watcher's `cancel` and keep its view and
/// stop handle, so the close handler buries windows through the view and a
/// disconnect stops the watcher's tasks, the poll and the colour watch with
/// one send. The seed sits after
/// `register_windows`, because `library_id_of` resolves through the registered
/// snapshot, and before the poll starts, so the poll's fresher list is never
/// overwritten by it.
fn wire_devserver_watcher(
    app: &tauri::AppHandle,
    state: &Arc<AppState>,
    id: &str,
    conn: devserver::DevserverConn,
    (cancel, snapshot, view): (
        tokio::sync::watch::Sender<DevserverWatcherStop>,
        Arc<Mutex<Vec<chan_server::WindowRecord>>>,
        Arc<window_watcher::WatcherViewState>,
    ),
    rows: Option<Vec<devserver::DevserverWorkspaceRow>>,
) {
    state.devserver_feed.set_down(id, false);
    state
        .devserver_feed
        .register_windows(id.to_string(), snapshot);
    if let Some(rows) = rows {
        let library_id = state.devserver_feed.library_id_of(id);
        let mapped = rows
            .into_iter()
            .map(|r| to_launcher_workspace(id, library_id.clone(), r))
            .collect();
        state.devserver_feed.set_workspaces(id.to_string(), mapped);
    }
    spawn_devserver_workspace_poll(
        app.clone(),
        Arc::clone(state),
        id.to_string(),
        conn.clone(),
        cancel.subscribe(),
    );
    window_watcher_wiring::spawn_devserver_color_watch(
        Arc::clone(state),
        id.to_string(),
        conn,
        cancel.subscribe(),
    );
    state
        .devserver_watcher_views
        .lock()
        .unwrap()
        .insert(id.to_string(), view);
    state
        .devserver_watchers
        .lock()
        .unwrap()
        .insert(id.to_string(), cancel);
}

/// Poll a connected devserver's served-workspace list into the feed cache so the
/// (sync) [`DevserverFeed::workspaces`] serves it without blocking on HTTP. Fires
/// [`EmbeddedServer::signal_library_change`](embedded::EmbeddedServer::signal_library_change)
/// only when the list actually changes, so the launcher re-pushes on a real
/// delta, not every tick. Stops when `cancel` leaves the running state, the same
/// signal that stops the window watcher.
///
/// The devserver's pane-highlight COLOUR is not polled here: it rides the
/// push-based `/api/library/local-color/watch` feed via
/// [`window_watcher_wiring::spawn_devserver_color_watch`]. There is no
/// `workspaces/watch` endpoint, so the workspace list is polled.
fn spawn_devserver_workspace_poll(
    app: tauri::AppHandle,
    state: Arc<AppState>,
    id: String,
    conn: devserver::DevserverConn,
    mut cancel: tokio::sync::watch::Receiver<DevserverWatcherStop>,
) {
    const POLL: std::time::Duration = std::time::Duration::from_secs(5);
    tauri::async_runtime::spawn(async move {
        let mut last_ws: Option<Vec<devserver::DevserverWorkspaceRow>> = None;
        let mut unreachable = false;
        loop {
            if (*cancel.borrow_and_update()).is_stopped() {
                return;
            }
            let mut changed = false;
            match devserver::fetch_workspaces(&conn).await {
                Ok(rows) => {
                    if unreachable && state.devservers.is_connected(&id) {
                        let _ = app.emit(DEVSERVER_CONTROL_RESTORED_EVENT, id.clone());
                    }
                    unreachable = false;
                    // Recovery: the transport answers again, so the rows the
                    // down flag hid come back in the same push.
                    if state.devserver_feed.set_down(&id, false) {
                        changed = true;
                    }
                    if last_ws.as_ref() != Some(&rows) {
                        let library_id = state.devserver_feed.library_id_of(&id);
                        let mapped = rows
                            .iter()
                            .cloned()
                            .map(|r| to_launcher_workspace(&id, library_id.clone(), r))
                            .collect();
                        state.devserver_feed.set_workspaces(id.clone(), mapped);
                        last_ws = Some(rows);
                        changed = true;
                    }
                }
                Err(e) => {
                    tracing::debug!(devserver = %id, error = %e, "polling devserver workspaces failed");
                    if !unreachable && state.devservers.is_connected(&id) {
                        let _ = app.emit(DEVSERVER_CONTROL_ATTENTION_EVENT, id.clone());
                    }
                    // The transport stopped answering: hide this devserver's
                    // workspace + window rows from the launcher immediately so
                    // the user cannot open / hide / manage windows against a
                    // connection that is gone. The caches stay; the Ok arm
                    // above restores the rows the moment the poll recovers.
                    if state.devserver_feed.set_down(&id, true) {
                        changed = true;
                    }
                    unreachable = true;
                }
            }
            if changed {
                if let Some(embedded) = state.embedded() {
                    embedded.signal_library_change();
                }
            }
            tokio::select! {
                _ = cancel.changed() => return,
                _ = tokio::time::sleep(POLL) => {}
            }
        }
    });
}

/// Register `path` with the shared embedded Library, creating the
/// directory for a fresh path. No workspace handle is held when this
/// returns, so the immediately-following `serve::start` can mount the
/// workspace without tripping `WorkspaceAlreadyOpen` against the
/// lifetime flock. Blocking: `register_workspace` writes the registry,
/// so callers invoke it via `spawn_blocking`.
fn register_workspace_path(library: &chan_workspace::Library, path: &str) -> Result<(), String> {
    let root = Path::new(path);
    if !root.exists() {
        std::fs::create_dir_all(root)
            .map_err(|e| format!("creating workspace root {path}: {e}"))?;
    }
    library
        .register_workspace(root)
        .map_err(|e| format!("registering workspace {path}: {e}"))?;
    Ok(())
}

/// Snapshot every currently-mounted local workspace into the library-owned
/// workspace overlay (`~/.chan/workspaces.json`) as `on` rows, so the next boot
/// re-serves them (the boot matrix). Off workspaces are simply absent -- the CLI
/// registry surfaces them off. Called after each on/off toggle and on clean
/// shutdown. Best-effort: a no-op when the embedded host / overlay is
/// unavailable, never fatal to the toggle or the exit.
fn persist_workspaces(state: &AppState) {
    let Some(embedded) = state.embedded.get() else {
        return;
    };
    let Some(overlay) = embedded.workspace_overlay() else {
        return;
    };
    // Reconcile against the host's ACTUAL mounted set (the registered library
    // workspaces filtered by what is mounted right now), mirroring chan-server's
    // devserver `persist_state`: a workspace unmounted out-of-band (a
    // control-socket `chan close`) leaves no desktop-side trace, so reading the
    // live mount is what keeps a closed workspace from being persisted as `on`
    // and resurrected on the next boot. `overlay.replace` sorts by path on save.
    let rows: Vec<chan_server::PersistedWorkspace> = embedded
        .library()
        .list_workspaces()
        .into_iter()
        .filter(|ws| embedded.is_root_mounted(&ws.root_path))
        .map(|ws| {
            chan_server::PersistedWorkspace::new(ws.root_path.to_string_lossy().into_owned(), true)
        })
        .collect();
    tracing::info!(
        on = rows.len(),
        paths = ?rows.iter().map(|r| r.path.as_str()).collect::<Vec<_>>(),
        "persisting the on workspace set"
    );
    overlay.replace(rows);
}

fn devserver_url_token(raw: &str) -> Option<String> {
    let parsed = url::Url::parse(raw).ok()?;
    parsed
        .query_pairs()
        .find_map(|(key, value)| (key == "t").then(|| value.trim().to_string()))
        .filter(|token| !token.is_empty())
}

/// Window-menu title for a record with no live webview to read a title from (a
/// hidden watcher window is destroyed, so this is the normal case for the Hidden
/// section).
///
/// A LOCAL record composes exactly what the titlebar would show, so a window
/// reads the same whether it is listed under Open or under Hidden. A REMOTE
/// record cannot: the titlebar's base is built from the live connection's
/// display name (`DevserverConn::name`), which the record does not carry here.
/// Rather than render a plausible-but-different title, fall back to the
/// library-composed `title` and append the caption to it -- the pre-existing
/// behaviour for these rows, plus the caption this is here to surface.
fn record_menu_title(record: &chan_server::WindowRecord) -> String {
    if record.library_id == "local" {
        return serve::watched_window_title(record, None);
    }
    let caption = record.label.trim();
    if caption.is_empty() {
        record.title.clone()
    } else {
        format!("{} [{caption}]", record.title)
    }
}

/// Reap a devserver's control terminal: close its window AND its chan-library
/// registry row + tenant, then drop the prefix tracking so the exit watcher
/// (keyed on it) stops. Closing the control-terminal WINDOW alone doesn't stop
/// the connect script -- its `/control-N` tenant outlives the window -- so
/// `reap_control_window` reaps both (idempotent), killing the script PTY. Used
/// by explicit teardown, by an explicit user close of the control window, and
/// by the PTY-exit path once the script-backed connection has ended.
async fn reap_devserver_control_terminal(app: &tauri::AppHandle, state: &AppState, id: &str) {
    let label = serve::control_terminal_label(id);
    serve::close_window_by_label(app, &label);
    if state.remove_buried(&label) {
        rebuild_window_menu(app);
    }
    state.control_terminal_runs.lock().unwrap().remove(id);
    if let Some(embedded) = state.embedded.get() {
        embedded.reap_control_window(&label).await;
    }
}

/// Drop a devserver's live connection windows: stop its window watcher and
/// remove its workspace tenants/standalone terminals, then drop it from the
/// launcher feed. Leaves the control terminal to the caller: a live but
/// unreachable connection may keep it for attention, a clean past-grace
/// script exit reaps it through full teardown, and a failing script exit
/// keeps it at "process exited" for the death reason. Idempotent.
fn remove_devserver_windows(app: &tauri::AppHandle, state: &AppState, id: &str) {
    // Cancel the window watcher (it detaches its windows, not reap -- the
    // devserver keeps its set server-side).
    if let Some(cancel) = state.devserver_watchers.lock().unwrap().remove(id) {
        let _ = cancel.send(DevserverWatcherStop::CloseWindows);
    }
    state.devserver_watcher_views.lock().unwrap().remove(id);
    // Drop it from the launcher feed and re-push so its windows + workspaces
    // leave the launcher (the watcher/poll already stopped on cancel).
    state.devserver_feed.forget(id);
    if let Some(embedded) = state.embedded() {
        embedded.signal_library_change();
    }
    let _ = app.emit(serve::SERVES_CHANGED, ());
}

/// Error marker for native access that requires an explicit trust grant.
const NATIVE_TRUST_REQUIRED: &str = "native_trust_required";

fn require_rostered_native_policy(
    state: &AppState,
    gateway_id: &str,
    owner: &str,
    devserver_id: &str,
) -> Result<gateway::RosterDevserver, String> {
    let row = state
        .gateway_manager
        .roster_row(gateway_id, owner, devserver_id)
        .ok_or_else(|| "the gateway roster no longer contains this devserver".to_string())?;
    let cfg = state.store.lock().unwrap().get().map_err(err)?;
    let gateway = cfg
        .gateways
        .iter()
        .find(|gateway| gateway.id == gateway_id)
        .ok_or_else(|| format!("no gateway {gateway_id}"))?;
    if row.shared && !gateway.trusts_native(row.owner_user_id, devserver_id) {
        return Err(NATIVE_TRUST_REQUIRED.to_string());
    }
    Ok(row)
}

fn require_rostered_native_policy_generation(
    state: &AppState,
    id: &str,
    gateway_id: &str,
    owner: &str,
    devserver_id: &str,
    expected_generation: u64,
) -> Result<gateway::RosterDevserver, String> {
    if state.native_policy_generation(id) != expected_generation {
        return Err("devserver native trust changed while connecting".to_string());
    }
    require_rostered_native_policy(state, gateway_id, owner, devserver_id)
}

fn signal_devserver_policy_change(app: &tauri::AppHandle, state: &AppState) {
    if let Some(embedded) = state.embedded() {
        embedded.signal_library_change();
    }
    let _ = app.emit(serve::SERVES_CHANGED, ());
}

async fn grant_devserver_native_trust(
    app: &tauri::AppHandle,
    state: &Arc<AppState>,
    id: &str,
) -> Result<(), String> {
    let (gateway_id, owner, devserver_id) = gateway::parse_synthesized_id(id)
        .ok_or_else(|| "native trust is only available for gateway devservers".to_string())?;
    let policy_lock = state.native_policy_lock(id);
    let _policy_guard = policy_lock.lock().await;
    let row = state
        .gateway_manager
        .roster_row(&gateway_id, &owner, &devserver_id)
        .ok_or_else(|| "the gateway roster no longer contains this devserver".to_string())?;
    if !row.shared {
        return Err("owned devservers do not require native trust".to_string());
    }
    config::set_native_trust(
        &state.store,
        &gateway_id,
        row.owner_user_id,
        &owner,
        &devserver_id,
        true,
    )?;
    state.bump_native_policy_generation(id);
    signal_devserver_policy_change(app, state);
    Ok(())
}

async fn revoke_devserver_native_trust(
    app: &tauri::AppHandle,
    state: &Arc<AppState>,
    id: &str,
) -> Result<(), String> {
    let (gateway_id, owner, devserver_id) = gateway::parse_synthesized_id(id)
        .ok_or_else(|| "native trust is only available for gateway devservers".to_string())?;
    let policy_lock = state.native_policy_lock(id);
    let _policy_guard = policy_lock.lock().await;
    let row = state
        .gateway_manager
        .roster_row(&gateway_id, &owner, &devserver_id)
        .ok_or_else(|| "the gateway roster no longer contains this devserver".to_string())?;
    if !row.shared {
        return Err("owned devservers do not carry revocable native trust".to_string());
    }
    config::set_native_trust(
        &state.store,
        &gateway_id,
        row.owner_user_id,
        &owner,
        &devserver_id,
        false,
    )?;
    state.bump_native_policy_generation(id);
    teardown_devserver_connection(app, state, id).await;
    signal_devserver_policy_change(app, state);
    Ok(())
}

/// Fully tear down a devserver: drop the connection, remove its workspace
/// windows + stop the watcher, AND reap the control terminal (which kills the
/// connect-script PTY), then refresh the launcher. The full teardown behind the
/// explicit Disconnect button (`DesktopWindowOp::DisconnectDevserver`) and the
/// launcher's HTTP-DELETE remove hook, where the connection is going away for
/// good. Idempotent; safe to call when the devserver is already disconnected.
async fn teardown_devserver_connection(app: &tauri::AppHandle, state: &AppState, id: &str) {
    state.devservers.remove(id);
    // A full teardown reaps the control terminal, so the reconnect block must
    // not outlive it: the block's invariant is that a kept "process exited"
    // terminal exists for the user to close. A stale entry here permanently
    // walls off connect with "close the control terminal ..." pointing at a
    // terminal that no longer exists.
    state.control_terminal_dead.lock().unwrap().remove(id);
    // Reap the control terminal BEFORE remove_devserver_windows fires the
    // launcher refresh, so the refresh already reflects the reaped control row.
    reap_devserver_control_terminal(app, state, id).await;
    remove_devserver_windows(app, state, id);
}

/// A script-backed devserver's control script exited (the script IS the
/// connection), or its connect failed while the control terminal is still live.
/// Mark the connection DOWN but KEEP the control terminal at "process exited" so
/// the user can read the death reason. Workspace windows are the CALLER's call:
/// this function leaves them alone, so the connect error arm keeps them open on
/// the reconnect spinner while the exit watcher closes them (via
/// `remove_devserver_windows`) before marking. Reconnect stays BLOCKED
/// (`control_terminal_dead`) until the user closes the control terminal
/// (`close_devserver_control_terminal` clears it) or hits Reconnect (whose
/// teardown reaps it). This is the counterpart to
/// `teardown_devserver_connection`, which reaps everything, and to the exit
/// watcher's within-grace clean-exit auto-reap, which reaps only the control
/// terminal. Idempotent.
fn mark_devserver_control_exited(app: &tauri::AppHandle, state: &AppState, id: &str) {
    // Keeping requires something to keep: with no current control run (a
    // concurrent close or reconnect reaped it between the caller's currency
    // check and this call) there is no terminal to hold at "process exited",
    // and marking anyway would strand the reconnect block on nothing.
    if !state.control_terminal_runs.lock().unwrap().contains_key(id) {
        return;
    }
    state.devservers.remove(id);
    state
        .control_terminal_dead
        .lock()
        .unwrap()
        .insert(id.to_string());
    // Retire the window watcher + workspace poll WITHOUT closing the workspace
    // windows here; the caller decides their fate (kept windows drop their own
    // `/ws` to the now-dead transport and show the DisconnectOverlay reconnect
    // spinner). Do NOT forget the feed or reap the control terminal, so the
    // launcher keeps rendering the flashing control row (a `control:true`
    // record under the devserver's `lib-` library) at "process exited".
    if let Some(cancel) = state.devserver_watchers.lock().unwrap().remove(id) {
        let _ = cancel.send(DevserverWatcherStop::RetireKeepWindows);
    }
    state.devserver_watcher_views.lock().unwrap().remove(id);
    // Hide the devserver's workspace + window rows from the launcher NOW: the
    // script was the connection, so every affordance on those rows (open /
    // hide / on / off) is a doomed click while it is down. The kept control
    // row is an embedded registry row, not a feed row, so it still renders
    // the death reason; the signal below pushes the trimmed feed.
    state.devserver_feed.set_down(id, true);
    // Flash the launcher's control row. The label ("connection closed" vs "not
    // responding") is the launcher's call, keyed on the devserver's now-`false`
    // connected status; this event only drives the flash.
    let _ = app.emit(DEVSERVER_CONTROL_ATTENTION_EVENT, id.to_string());
    if let Some(embedded) = state.embedded() {
        embedded.signal_library_change();
    }
    let _ = app.emit(serve::SERVES_CHANGED, ());
}

/// The user explicitly closed the control terminal window. This is different
/// from the connect script exiting inside an otherwise open terminal: the row
/// should leave the launcher, not linger flashing for attention.
async fn close_devserver_control_terminal(app: &tauri::AppHandle, state: &AppState, id: &str) {
    let was_connected = state.devservers.is_connected(id);
    if was_connected {
        state.devservers.remove(id);
    }
    // Closing a dead control terminal (the user read the death reason) clears the
    // reconnect block: the devserver is now ready to connect again.
    state.control_terminal_dead.lock().unwrap().remove(id);
    reap_devserver_control_terminal(app, state, id).await;
    if was_connected {
        remove_devserver_windows(app, state, id);
    } else if let Some(embedded) = state.embedded() {
        embedded.signal_library_change();
    }
}

/// Persist a window's `hidden` visibility to its OWNING
/// registry, routed by the native label's library. Called at the bury
/// (`hidden=true`) and unbury (`hidden=false`) chokepoints -- BOTH the native
/// red-dot close AND the SPA SHOW/HIDE toggle (bridge `/hide`+`/open`) funnel
/// through them -- so a connect MIRRORS the persisted layout (HIDE-PERSIST
/// Option A). The in-memory `buried` set stays the transient local view; this
/// makes the visibility durable + server-shared.
fn persist_window_hidden(state: &AppState, label: &str, hidden: bool) {
    // Control terminal: its registry row's `window_id` IS the full label
    // (`control_terminal_label`), minted into the LOCAL embedded library.
    if label.starts_with("control-terminal-") {
        if let Some(embedded) = state.embedded() {
            let _ = embedded.set_window_hidden(label, hidden);
        }
        return;
    }
    // LOCAL window: embedded registry, `window_id` = the part after `local::`.
    if let Some(window_id) = label.strip_prefix("local::") {
        if let Some(embedded) = state.embedded() {
            let _ = embedded.set_window_hidden(window_id, hidden);
        }
        return;
    }
    // DEVSERVER window (`lib-<hex>::<window_id>`): the devserver owns its registry,
    // so persist there via its `/visibility` route. Async HTTP, and the bury/
    // unbury chokepoints are sync, so fire-and-forget; the feed round-trip
    // reflects the new visibility.
    if let Some((library_id, window_id)) = label.split_once("::") {
        if let Some(ds_id) = state.devserver_feed.devserver_id_for_library(library_id) {
            if let Some(conn) = state.devservers.get(&ds_id) {
                let window_id = window_id.to_string();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) =
                        devserver::set_window_visibility(&conn, &window_id, hidden).await
                    {
                        tracing::debug!(error = %e, "persisting devserver window visibility failed");
                    }
                });
            }
        }
    }
}

/// Poll a devserver's info endpoint until it answers or the budget runs out.
/// The connect script may take a moment to bring the devserver up, or prompt
/// for credentials in the control terminal, so the wait is generous; a
/// refused connection fails fast, so most attempts cost only the backoff.
///
/// `abort` is checked before every attempt: for a scripted devserver the
/// caller passes the control-run liveness probe, so the connect attempt fails
/// within one backoff of the script FAILING instead of spinning out the whole
/// budget against a transport that can never come up (the launcher's Connect
/// button rides `devserver_connecting`, so a spun-out wait pins the spinner
/// for the full budget). A clean script return does not abort: a daemonizing
/// script exits 0 with the devserver up, so the dial is the arbiter there.
/// No-script connects pass a probe that never fires.
async fn wait_for_devserver(
    host: &str,
    port: u16,
    abort: impl Fn() -> Option<ConnectDevserverError>,
) -> Result<devserver::DevserverInfo, ConnectDevserverError> {
    const MAX_ATTEMPTS: usize = 20;
    const BACKOFF: std::time::Duration = std::time::Duration::from_millis(1500);
    let mut last_err = String::new();
    for attempt in 1..=MAX_ATTEMPTS {
        if let Some(e) = abort() {
            return Err(e);
        }
        match devserver::fetch_info(host, port).await {
            Ok(info) => return Ok(info),
            Err(e) => {
                last_err = e;
                if attempt < MAX_ATTEMPTS {
                    tokio::time::sleep(BACKOFF).await;
                }
            }
        }
    }
    Err(format!("devserver {host}:{port} did not come up in time ({last_err})").into())
}

#[derive(Debug)]
enum ConnectDevserverError {
    ControlTerminated(String),
    Other(String),
}

impl ConnectDevserverError {
    fn message(self) -> String {
        match self {
            Self::ControlTerminated(message) | Self::Other(message) => message,
        }
    }

    fn control_terminated(&self) -> bool {
        matches!(self, Self::ControlTerminated(_))
    }
}

impl From<String> for ConnectDevserverError {
    fn from(message: String) -> Self {
        Self::Other(message)
    }
}

/// Poll a control terminal's output until the connect script's devserver
/// prints its `token=` line, or the budget runs out. The script may take a
/// moment, or prompt for credentials in the terminal, so the wait is
/// generous.
async fn scrape_control_terminal_token(
    app: &tauri::AppHandle,
    state: &AppState,
    control_label: &str,
    prefix: &str,
) -> Result<String, ConnectDevserverError> {
    let Some(embedded) = state.embedded.get() else {
        return Err("embedded local server is unavailable".to_string().into());
    };
    const MAX_ATTEMPTS: usize = 40;
    const BACKOFF: std::time::Duration = std::time::Duration::from_millis(1500);
    // `build_workspace_window_with_completion` registers the control window on
    // the main thread AFTER its spawn returns, so the first poll(s) here can run
    // before the window exists. Latch once we've seen it, so a later
    // disappearance reads as a user close (below) rather than the build race.
    let mut window_seen = false;
    for _ in 0..MAX_ATTEMPTS {
        // The scrollback is read BEFORE the exit probe: a daemonizing connect
        // script prints the token and returns inside a single poll window, and
        // a token it already printed must win over the exit that follows it.
        // The exit probe below then only fails scripts that died with no token
        // to show.
        if let Some(token) = devserver::scrape_token(&embedded.read_control_terminal_output(prefix))
        {
            return Ok(token);
        }
        // No token, and the connect script's PTY has exited: a failed
        // connect (bad credentials, script error, a ^C-killed script). Fail fast
        // instead of waiting out the full backoff budget, so the launcher
        // surveys (abandon/edit/retry) promptly rather than sticking on
        // "connecting". The exit status is the tenant's, independent of the
        // control window, so this also catches the script dying in place.
        if let Some(exit) = embedded.control_terminal_exit(prefix) {
            return Err(ConnectDevserverError::ControlTerminated(format!(
                "the devserver connect script exited ({exit}) before the connection was established"
            )));
        }
        // The user closed the control terminal (^W / red button) before it
        // connected. A window close does NOT reap the tenant -- the PTY outlives
        // it (client WS detach keeps it warm), so `control_terminal_exit` above
        // stays None and we'd otherwise strand on "connecting" until the budget
        // runs out. Abort so the SAME failure survey fires at once. Gated on
        // `window_seen` to ride out the build race above.
        match app.get_webview_window(control_label) {
            Some(_) => window_seen = true,
            None if window_seen => {
                return Err(ConnectDevserverError::ControlTerminated(
                    "the control terminal was closed before the devserver connected".to_string(),
                ));
            }
            None => {}
        }
        tokio::time::sleep(BACKOFF).await;
    }
    Err(
        "the devserver did not print its token in the control terminal in time"
            .to_string()
            .into(),
    )
}

fn control_run_is_current(state: &AppState, id: &str, generation: u64, prefix: &str) -> bool {
    state
        .control_terminal_runs
        .lock()
        .unwrap()
        .get(id)
        .map(|run| run.generation == generation && run.prefix == prefix && run.script_based)
        .unwrap_or(false)
}

/// Whether a control script's exit is CLEAN (status 0). A daemonizing connect
/// script (for example `chan devserver join`) prints the token,
/// detaches the server, and returns 0 on every healthy connect, so a clean
/// exit means "the script finished its job", never "read what failed here".
/// Anything else (a non-zero status, a signal, an unknown status) is a
/// failure.
fn control_script_exit_is_clean(exit: &chan_server::TerminalExit) -> bool {
    matches!(exit, chan_server::TerminalExit::Code { code: 0 })
}

fn ensure_control_run_live(
    state: &AppState,
    id: &str,
    generation: u64,
    prefix: &str,
) -> Result<(), ConnectDevserverError> {
    if !control_run_is_current(state, id, generation, prefix) {
        return Err("the devserver connect attempt was replaced"
            .to_string()
            .into());
    }
    if let Some(exit) = state
        .embedded
        .get()
        .and_then(|e| e.control_terminal_exit(prefix))
    {
        // A clean return is not a death: a daemonizing connect script exits 0
        // once the devserver is detached, while the connect flow is still
        // dialing. Whether the transport survived the script is the dial's
        // call, not this probe's.
        if !control_script_exit_is_clean(&exit) {
            return Err(ConnectDevserverError::ControlTerminated(format!(
                "the devserver connect script exited ({exit})"
            )));
        }
    }
    Ok(())
}

/// Watch a scripted devserver's control-terminal PTY from the moment its prefix
/// is registered. The script IS the connection for a persistent transport
/// (`ssh -N`, `limactl shell ... chan devserver join`), so what its exit
/// means depends on how and when it ended:
///
/// - CLEAN (status 0) while the connect flow is still in flight: healthy vs
///   failed is unknowable until that flow resolves (the startup race: a
///   daemonizing script can return before the connection is recorded), so
///   judgment is deferred.
/// - CLEAN with the connection up, within `CLEAN_EXIT_GRACE` of the
///   connection registering: the daemonize handshake (`chan devserver
///   --service=chan` prints the token, detaches the server, and returns 0 on
///   every healthy connect). A clean exit carries no death reason worth
///   reading, so the control terminal is auto-reaped; the connection, its
///   windows, and reconnect are untouched.
/// - CLEAN with the connection up, past the grace: the script was the
///   transport and its return ends the connection (a ^C forwarded into
///   `limactl shell` kills the remote, which exits 0, relayed as a clean
///   exit), so the whole connection tears down: conn dropped, control
///   terminal reaped, workspace windows closed, launcher shows.
/// - Anything else (a non-zero status, a signal, or a clean exit with no
///   connection to show for it): the connection stops and its workspace
///   windows close, but the control terminal is KEPT at "process exited"
///   (`mark_devserver_control_exited`) so the user can read the death reason;
///   reconnect stays blocked until they close it. A non-responsive but
///   still-running script is handled by the workspace poll attention path
///   instead.
///
/// Stops without firing once this watcher's control terminal is no longer the
/// devserver's current one: a disconnect/forget removes the prefix (and reaps
/// the tenant), and a fresh connect replaces it -- either way that exit is not a
/// surprise THIS watcher owns, so it must not double-emit or fire against a
/// reconnected session.
fn spawn_control_terminal_exit_watcher(
    app: tauri::AppHandle,
    state: Arc<AppState>,
    id: String,
    prefix: String,
    generation: u64,
    script_based: bool,
) {
    tauri::async_runtime::spawn(async move {
        const POLL: std::time::Duration = std::time::Duration::from_millis(1000);
        // A clean exit within this window of the connection registering reads
        // as the daemonize handshake returning; a clean exit past it means the
        // script was the transport and the connection is over.
        const CLEAN_EXIT_GRACE: std::time::Duration = std::time::Duration::from_secs(10);
        loop {
            if !control_run_is_current(&state, &id, generation, &prefix) {
                return;
            }
            let exited = state
                .embedded
                .get()
                .and_then(|e| e.control_terminal_exit(&prefix));
            let Some(exit) = exited else {
                tokio::time::sleep(POLL).await;
                continue;
            };
            if !script_based {
                return;
            }
            let clean = control_script_exit_is_clean(&exit);
            // The startup race: a daemonizing script returns cleanly while the
            // connect flow is still recording the connection, so healthy vs
            // failed is unknowable until that flow resolves. Keep polling (the
            // connect's own budgets bound the wait). Checked BEFORE the
            // connected gate below: reaping mid-connect would fail the
            // in-flight attempt's liveness checks and tear down a connect that
            // was about to land.
            if clean && state.devserver_connecting.lock().unwrap().contains(&id) {
                tokio::time::sleep(POLL).await;
                continue;
            }
            if !control_run_is_current(&state, &id, generation, &prefix) {
                return;
            }
            if clean && state.devservers.is_connected(&id) {
                // The registration age tells the two clean endings apart:
                // within the grace this is the daemonize handshake returning
                // (the detached server carries the connection on), past it the
                // script was the transport and its return ends the connection.
                // A conn racing away between the gate above and this read
                // yields None and lands on the (idempotent) full disconnect.
                let within_grace = state
                    .devservers
                    .registered_elapsed(&id)
                    .is_some_and(|age| age <= CLEAN_EXIT_GRACE);
                if within_grace {
                    tracing::info!(
                        devserver = %id,
                        "control script exited cleanly within the connect grace; reaping the control terminal"
                    );
                    reap_devserver_control_terminal(&app, &state, &id).await;
                    if let Some(embedded) = state.embedded() {
                        embedded.signal_library_change();
                    }
                    let _ = app.emit(serve::SERVES_CHANGED, ());
                    return;
                }
                tracing::info!(
                    devserver = %id,
                    "control script exited cleanly past the connect grace; disconnecting the devserver"
                );
                teardown_devserver_connection(&app, &state, &id).await;
                return;
            }
            tracing::info!(
                devserver = %id,
                exit = %exit,
                "control script exited without a healthy connection; closing windows, keeping control terminal"
            );
            // Close the workspace windows FIRST, while the window watcher is
            // still registered: the removal closes watcher-driven windows by
            // cancelling that watcher with CloseWindows, and the mark below
            // retires the same watcher KEEPING its windows. Composed the other
            // way round the retire wins and the windows stay open against a
            // dead transport.
            remove_devserver_windows(&app, &state, &id);
            mark_devserver_control_exited(&app, &state, &id);
            return;
        }
    });
}

/// Connect to a configured devserver: run its connect script in a control
/// terminal (when one is set), acquire its bearer token, confirm it answers,
/// record the connection, open a standalone terminal on it, then tuck the
/// control terminal away. A stored write-only token from the devserver Address
/// wins after the script starts, so a tunnel script can be just `ssh -N`. With
/// no stored token, scripted connects scrape `CHAN_DEVSERVER_TOKEN=...` from
/// the control terminal; no-script local connects read
/// `~/.chan/devserver/config.json`. Once connected the launcher polls the
/// devserver's workspace list.
///
/// Driven over the desktop bridge: the launcher's Connect button fires
/// `POST /api/library/devservers/{id}/connect` → `DesktopWindowOp::ConnectDevserver`
/// → `window_ops`, which calls this. There is no `#[tauri::command]` wrapper  --
/// the launcher is pure HTTP, never a Tauri invoke.
async fn connect_devserver_impl(
    app: tauri::AppHandle,
    state: Arc<AppState>,
    id: String,
) -> Result<(), String> {
    // Idempotency: a re-Connect on an already-connected devserver is a
    // no-op, not an error. Without this the second connect re-ran the control
    // terminal + scrape, which raced the live one ("control terminal was closed
    // before the devserver connected").
    if state.devservers.is_connected(&id) {
        return Ok(());
    }
    // A dead control terminal blocks reconnect: the user must close it (read the
    // death reason) first, or use Reconnect (whose teardown reaps it, clearing
    // this before it dials). The block is only honored while its terminal actually
    // exists: a stale entry whose window is gone (any residual race that strands
    // the flag) self-heals here instead of walling off connect with an
    // instruction the user cannot follow.
    if state.control_terminal_dead.lock().unwrap().contains(&id) {
        if app
            .get_webview_window(&serve::control_terminal_label(&id))
            .is_some()
        {
            return Err(
                "close the control terminal to see why the connection ended, then reconnect"
                    .to_string(),
            );
        }
        state.control_terminal_dead.lock().unwrap().remove(&id);
    }
    {
        let mut connecting = state.devserver_connecting.lock().unwrap();
        if !connecting.insert(id.clone()) {
            return Ok(());
        }
    }
    if let Some(embedded) = state.embedded() {
        embedded.signal_library_change();
    }
    let _ = app.emit(serve::SERVES_CHANGED, ());
    let result =
        match connect_devserver_impl_inner(app.clone(), Arc::clone(&state), id.clone()).await {
            Ok(()) => Ok(()),
            Err(e) => {
                // A failed raw dial on a plain row may mean "this URL is a
                // gateway" (ruling out offline rows is impossible here);
                // the one-time backstop probe answers that out-of-band.
                if !id.starts_with("gw:") {
                    spawn_gateway_backstop_probe(&app, &state, &id);
                }
                let control_terminated = e.control_terminated();
                let message = e.message();
                // ControlTerminated covers two very different endings, told
                // apart by whether the control WINDOW is still up:
                //   - the user closed the window mid-connect: nothing to keep,
                //     tear the attempt down (the survey offers retry/edit).
                //   - the script exited inside a still-open terminal: keep it
                //     at "process exited". The exit watcher usually marks this
                //     first (its poll outruns the scrape backoff); routing the
                //     scrape's error to teardown here reaped the terminal the
                //     watcher just chose to keep, and left the watcher's
                //     reconnect block pointing at nothing.
                let control_window_live = app
                    .get_webview_window(&serve::control_terminal_label(&id))
                    .is_some();
                if control_terminated && !control_window_live {
                    teardown_devserver_connection(&app, &state, &id).await;
                } else if state
                    .control_terminal_runs
                    .lock()
                    .unwrap()
                    .contains_key(&id)
                {
                    // The control script exited inside a still-open terminal, or
                    // the connect failed with its script still live (for example
                    // `ssh -N` up, but the devserver behind it is a wrong
                    // protocol or slow to answer): keep the control terminal so
                    // the user can read the failure, and block reconnect until
                    // they close it.
                    mark_devserver_control_exited(&app, &state, &id);
                } else {
                    // No control terminal to keep (a no-script devserver, or the
                    // failure predates the control run): drop the conn + windows.
                    state.devservers.remove(&id);
                    remove_devserver_windows(&app, &state, &id);
                }
                Err(message)
            }
        };
    state.devserver_connecting.lock().unwrap().remove(&id);
    if let Some(embedded) = state.embedded() {
        embedded.signal_library_change();
    }
    let _ = app.emit(serve::SERVES_CHANGED, ());
    result
}

fn origin_host_port(origin: &str) -> Result<(String, u16), ConnectDevserverError> {
    let parsed =
        url::Url::parse(origin).map_err(|e| format!("invalid gateway proxy origin: {e}"))?;
    let host = parsed
        .host_str()
        .filter(|h| !h.is_empty())
        .ok_or_else(|| "gateway proxy origin has no host".to_string())?
        .to_string();
    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| "gateway proxy origin has no port and an unknown scheme".to_string())?;
    Ok((host, port))
}

fn gateway_display_name(configured_label: &str, gateway_url: &str, proxy_origin: &str) -> String {
    if !configured_label.is_empty() {
        return configured_label.to_string();
    }
    url::Url::parse(gateway_url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .or_else(|| {
            url::Url::parse(proxy_origin)
                .ok()
                .and_then(|u| u.host_str().map(str::to_string))
        })
        .unwrap_or_else(|| gateway_url.to_string())
}

/// How long a gateway connect waits on the browser sign-in before the row
/// resets. Generous: the user may be creating an account or fishing for a
/// passkey; a re-click any time re-opens the browser and restarts the clock.
const GATEWAY_SIGNIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5 * 60);

/// A plain devserver row's connect failed: probe once per row per run
/// whether the URL is really a gateway (rows predating the Gateways screen
/// carry no marker and cannot be identified offline). A gateway answer
/// surfaces an info notice pointing at the Gateways screen. Detached from
/// the failure path so the connect error banners immediately; never
/// re-probes, so the probe cannot become a per-connect cost. Deliberately
/// broader than the raw dial itself - ANY failure class on a plain row
/// triggers the one probe - because the one-shot guard and the
/// gateway-positive-only notice make a stray probe free, while classifying
/// dial errors would miss gateways that fail later in the connect.
/// Returns whether this call spawned the probe (false = already probed).
fn spawn_gateway_backstop_probe<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &Arc<AppState>,
    id: &str,
) -> bool {
    if !state
        .gateway_backstop_probed
        .lock()
        .unwrap()
        .insert(id.to_string())
    {
        return false;
    }
    let app = app.clone();
    let state = Arc::clone(state);
    let id = id.to_string();
    tauri::async_runtime::spawn(async move {
        let Ok(cfg) = state.store.lock().unwrap().get() else {
            return;
        };
        let Some(row) = cfg.devservers.iter().find(|d| d.id == id) else {
            return;
        };
        let (url, label) = (row.url.clone(), row.label.clone());
        drop(cfg);
        if devserver::discover_gateway(&url).await.is_ok() {
            gateway::emit_notice(
                &app,
                "info",
                "devserver",
                &id,
                if label.is_empty() { &url } else { &label },
                "This URL is a gateway",
                "this address answers as a chan-gateway - add it on the Gateways screen to see all its devservers",
            );
        }
    });
    true
}

/// Take the parked legacy-migration outcome and narrate it as a launcher
/// notice, called from the launcher's first page load. Only converted
/// rows narrate (marker clearing alone changes nothing the user can see).
/// Returns whether a notice was scheduled. The emit rides a 1s grace so
/// the SPA's listener registration (during mount, just after the load
/// event) usually lands first; a launcher taking longer than the grace
/// LOSES the one-shot - accepted, since the migrated gateways are visible
/// on the Gateways screen regardless.
fn narrate_parked_migration<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &Arc<AppState>,
) -> bool {
    let Some(migration) = state.gateway_migration.lock().unwrap().take() else {
        return false;
    };
    if migration.converted_rows == 0 {
        return false;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        gateway::emit_notice(
            &app,
            "info",
            "desktop",
            "desktop",
            "chan-desktop",
            "Gateways migrated",
            &format!(
                "{} gateway connection(s) moved from devserver rows to the Gateways screen",
                migration.converted_rows
            ),
        );
    });
    true
}

/// The runtime-independent head of a rostered-devserver connect: mint the
/// entry through the gateway with the explicit (owner, devserver id)
/// target and narrate the failures - a 401 runs the gateway cascade, an
/// offline row emits a clean devserver-sourced notice beside the failed
/// connect. Returns the ready proxy connection for the concrete wiring
/// tail. Generic over the runtime so the narration paths drive under the
/// mock runtime in tests.
async fn rostered_conn<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &Arc<AppState>,
    id: &str,
    gateway_id: &str,
    owner: &str,
    devserver_id: &str,
) -> Result<devserver::DevserverConn, ConnectDevserverError> {
    let row = require_rostered_native_policy(state, gateway_id, owner, devserver_id)?;
    let Some(discovery) = state.gateway_manager.discovery(gateway_id) else {
        return Err(
            "connect the gateway first - its roster supplies this devserver"
                .to_string()
                .into(),
        );
    };
    let row_label = row.label;
    let Some(pat) = auth::load_gateway_pat(&discovery.identity_origin)? else {
        return Err("the gateway sign-in is missing - reconnect the gateway"
            .to_string()
            .into());
    };
    let gateway = match devserver::gateway_conn(
        &discovery,
        pat.secret,
        Some(devserver::GatewayEntryTarget {
            owner_user_id: row.owner_user_id,
            owner: owner.to_string(),
            devserver_id: devserver_id.to_string(),
        }),
    )
    .await
    {
        Ok(gateway) => gateway,
        Err(devserver::GatewayEntryError::Unauthorized) => {
            // Dead PAT: the same 401 semantics as the roster poll - run the
            // gateway cascade (which clears the credential) and point the
            // user at the gateway-level reconnect.
            gateway::cascade_disconnect(
                app,
                state,
                gateway_id,
                gateway::CascadeReason::Unauthorized,
            )
            .await;
            return Err(
                "the gateway sign-in is no longer valid - reconnect the gateway"
                    .to_string()
                    .into(),
            );
        }
        // The row holds no live tunnel right now (the gateway checks
        // liveness before authorization, so a dark SHARED row answers this
        // too): say so as a clean devserver-sourced notice in addition to
        // failing the connect.
        Err(e @ devserver::GatewayEntryError::DevserverOffline { .. }) => {
            let label = if row_label.is_empty() {
                devserver_id.chars().take(12).collect::<String>()
            } else {
                row_label.clone()
            };
            gateway::emit_notice(
                app,
                "info",
                "devserver",
                id,
                &label,
                "Devserver offline",
                &e.to_string(),
            );
            return Err(e.to_string().into());
        }
        // Known reasons (no devserver, denied) surface their own banner
        // strings; Other keeps the raw message. No prefix here: the entry
        // narration IS the failure.
        Err(e) => return Err(e.to_string().into()),
    };
    let (host, port) = origin_host_port(&gateway.proxy_origin)?;
    let name = gateway_display_name(
        &row_label,
        &discovery.identity_origin,
        &gateway.proxy_origin,
    );
    Ok(devserver::DevserverConn {
        host,
        port,
        token: String::new(),
        name,
        gateway: Some(Box::new(gateway)),
    })
}

/// Connect one rostered gateway devserver (a synthesized `gw:` row): mint
/// its entry through the gateway ([`rostered_conn`]), then wire the
/// proxy-backed connection exactly like a raw devserver. The GATEWAY must
/// already be connected - the row only lists while its roster is live -
/// and its account PAT comes from the keyring; sign-in runs at the
/// gateway level, never per row.
async fn connect_rostered_devserver(
    app: tauri::AppHandle,
    state: Arc<AppState>,
    id: String,
    gateway_id: String,
    owner: String,
    devserver_id: String,
) -> Result<(), ConnectDevserverError> {
    let policy_lock = state.native_policy_lock(&id);
    let _policy_guard = policy_lock.lock().await;
    let policy_generation = state.native_policy_generation(&id);
    require_rostered_native_policy_generation(
        &state,
        &id,
        &gateway_id,
        &owner,
        &devserver_id,
        policy_generation,
    )?;
    let conn = rostered_conn(&app, &state, &id, &gateway_id, &owner, &devserver_id).await?;

    let proxy_origin = conn
        .gateway
        .as_ref()
        .expect("rostered connections are gateway-backed")
        .proxy_origin
        .clone();
    crate::runtime_capability::mint_exact_origin_grant(&app, &proxy_origin)
        .map_err(|e| format!("granting native access for this devserver failed: {e}"))?;
    require_rostered_native_policy_generation(
        &state,
        &id,
        &gateway_id,
        &owner,
        &devserver_id,
        policy_generation,
    )?;
    devserver::install_gateway_webview_session(&app, &conn, None)
        .map_err(|e| format!("installing gateway WebView session: {e}"))?;

    let rows = devserver::fetch_workspaces(&conn)
        .await
        .map_err(|e| format!("authenticating gateway devserver proxy: {e}"))?;
    require_rostered_native_policy_generation(
        &state,
        &id,
        &gateway_id,
        &owner,
        &devserver_id,
        policy_generation,
    )?;
    state.devservers.set(id.clone(), conn.clone());

    seed_devserver_color(
        &state,
        &id,
        &conn,
        "eager gateway pane-colour seed failed; the colour watch will fill it",
    )
    .await;

    // Seed the devserver's self-reported OS so the launcher's machine icon
    // renders instead of the neutral globe. The raw-connect path reads it from
    // the `fetch_info` probe, which the gateway proxy never forwards, so the
    // rostered path reads the launcher shell's host-os meta; no `pretty_name`
    // travels that surface (the icon is driven by `os` alone). Best-effort:
    // connect must not fail on a cosmetic seed, the icon just stays neutral.
    match devserver::fetch_gateway_host_os(&conn).await {
        Ok(os) => {
            state.devserver_feed.seed_os(id.clone(), os, None);
        }
        Err(e) => {
            tracing::debug!(
                devserver = %id,
                error = %e,
                "gateway OS seed failed; the machine icon stays neutral",
            );
        }
    }

    if let Err(e) = require_rostered_native_policy_generation(
        &state,
        &id,
        &gateway_id,
        &owner,
        &devserver_id,
        policy_generation,
    ) {
        state.devservers.remove(&id);
        return Err(e.into());
    }

    let (cancel, snapshot, view) = window_watcher_wiring::spawn_devserver_window_watcher(
        id.clone(),
        app.clone(),
        conn.clone(),
    )
    .await?;
    if let Err(e) = require_rostered_native_policy_generation(
        &state,
        &id,
        &gateway_id,
        &owner,
        &devserver_id,
        policy_generation,
    ) {
        state.devservers.remove(&id);
        let _ = cancel.send(DevserverWatcherStop::CloseWindows);
        return Err(e.into());
    }
    wire_devserver_watcher(
        &app,
        &state,
        &id,
        conn,
        (cancel, snapshot, view),
        Some(rows),
    );
    if let Some(embedded) = state.embedded() {
        embedded.signal_library_change();
    }
    let _ = app.emit(serve::SERVES_CHANGED, ());
    Ok(())
}

async fn connect_devserver_impl_inner(
    app: tauri::AppHandle,
    state: Arc<AppState>,
    id: String,
) -> Result<(), ConnectDevserverError> {
    // Rostered gateway devservers route through the gateway manager's
    // state, never the persisted vec: the synthesized id carries the
    // (gateway, owner, devserver) triple.
    if let Some((gateway_id, owner, devserver_id)) = gateway::parse_synthesized_id(&id) {
        return connect_rostered_devserver(app, state, id, gateway_id, owner, devserver_id).await;
    }
    let (url, script, stored_token, configured_label, auto_hide_control) = {
        let cfg = state.store.lock().unwrap().get().map_err(err)?;
        let ds = cfg
            .devservers
            .iter()
            .find(|d| d.id == id)
            .ok_or_else(|| format!("no devserver {id}"))?;
        (
            ds.url.clone(),
            ds.script.clone(),
            ds.token.trim().to_string(),
            ds.label.trim().to_string(),
            ds.auto_hide_control,
        )
    };
    // Plain rows go straight to the raw dial: gateways are first-class
    // rows with their own connect, so no per-connect discovery probe runs
    // here. A gateway URL still stored as a plain row (predating the
    // Gateways screen, unidentifiable offline) surfaces through the
    // one-time backstop probe when its raw dial fails.
    // Parse the stored URL into the (host, port) the raw-tunnel dial uses
    // (the port defaults from the scheme when omitted).
    let (host, port) = devserver::parse_devserver_url(&url)?;
    let control_title = if configured_label.is_empty() {
        format!("{host}:{port}")
    } else {
        configured_label.clone()
    };
    // A configured script runs in a control terminal that brings the
    // devserver up; with no script the devserver is expected to be running
    // already.
    let control = if script.trim().is_empty() {
        None
    } else {
        reap_devserver_control_terminal(&app, &state, &id).await;
        let ct = serve::spawn_control_terminal_window(
            app.clone(),
            Arc::clone(&state),
            &id,
            script,
            &control_title,
        )
        .await?;
        let generation = state
            .control_terminal_generation
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            + 1;
        state.control_terminal_runs.lock().unwrap().insert(
            id.clone(),
            ControlTerminalRun {
                generation,
                prefix: ct.prefix.clone(),
                script_based: true,
            },
        );
        spawn_control_terminal_exit_watcher(
            app.clone(),
            Arc::clone(&state),
            id.clone(),
            ct.prefix.clone(),
            generation,
            true,
        );
        state.devserver_feed.seed_library_id(id.clone(), id.clone());
        if let Some(embedded) = state.embedded() {
            embedded.mint_control_window(
                serve::control_terminal_label(&id),
                id.clone(),
                ct.prefix.clone(),
            )?;
            embedded.signal_library_change();
        }
        Some((ct, generation))
    };
    let (token, port) = if !stored_token.is_empty() {
        // The script, when present, is transport setup and must already be
        // running before this token is used.
        if let Some((ct, generation)) = &control {
            ensure_control_run_live(&state, &id, *generation, &ct.prefix)?;
        }
        (stored_token, port)
    } else {
        match &control {
            Some((ct, generation)) => {
                let token = scrape_control_terminal_token(
                    &app,
                    &state,
                    &serve::control_terminal_label(&id),
                    &ct.prefix,
                )
                .await?;
                ensure_control_run_live(&state, &id, *generation, &ct.prefix)?;
                (token, port)
            }
            // Local devserver (no control script, no stored token): read the
            // CURRENT token AND port from its persisted config. The stored URL's
            // port goes stale when a `--port 0` local devserver restarts on a
            // different OS-assigned port; the config carries the live port.
            None => (
                devserver::read_local_token()?,
                devserver::read_local_port().unwrap_or(port),
            ),
        }
    };
    // The wait aborts within one backoff of the control script dying (or the
    // run being replaced): with the script gone the devserver can never come
    // up, and spinning out the full budget pinned the launcher's Connect
    // spinner for ~30s before failing with a misleading "did not come up in
    // time" instead of the script's own death.
    let info = wait_for_devserver(&host, port, || {
        control.as_ref().and_then(|(ct, generation)| {
            ensure_control_run_live(&state, &id, *generation, &ct.prefix).err()
        })
    })
    .await?;
    if let Some((ct, generation)) = &control {
        ensure_control_run_live(&state, &id, *generation, &ct.prefix)?;
    }
    if info.protocol != devserver::DEVSERVER_API_PROTOCOL {
        return Err(format!(
            "devserver speaks management protocol {} but this desktop speaks {}; update whichever is older",
            info.protocol,
            devserver::DEVSERVER_API_PROTOCOL
        )
        .into());
    }
    tracing::info!(
        version = %info.devserver_version,
        label = %info.host_label,
        "connected to devserver"
    );
    // Window-title display name: the server's host_label, else the dialed host
    // (a bare tunnel host like 127.0.0.1 is a poor title, but better than blank).
    let name = if info.host_label.trim().is_empty() {
        host.clone()
    } else {
        info.host_label.clone()
    };
    let conn = devserver::DevserverConn {
        host,
        port,
        token,
        name,
        gateway: None,
    };
    devserver::fetch_workspaces(&conn)
        .await
        .map_err(|e| format!("authenticating devserver management API: {e}"))?;
    state.devservers.set(id.clone(), conn.clone());
    // Seed this devserver's `library_id` into the launcher
    // feed BEFORE the control mint so the launcher resolves the control row's group
    // to the devserver's NAME from the FIRST render, not a blank `↗`. Without it
    // `library_id_of` stays None until a window syncs the mapping, and the launcher
    // (which matches the control row's `library_id` against each devserver's
    // reported id) groups it separately. Non-empty only: `info.library_id` defaults
    // to "" if the devserver omitted it; the launcher's never-blank fallback is
    // only a safety net.
    let control_library_id = if info.library_id.is_empty() {
        id.clone()
    } else {
        info.library_id.clone()
    };
    state
        .devserver_feed
        .seed_library_id(id.clone(), control_library_id.clone());
    // Seed the self-reported OS alongside the library_id so the launcher's
    // machine icon renders from the first feed read. Non-empty only: a devserver
    // too old to report `os` leaves the icon neutral rather than blanking it.
    if !info.os.is_empty() {
        state
            .devserver_feed
            .seed_os(id.clone(), info.os.clone(), info.pretty_name.clone());
    }
    // Mint the connect-script control terminal as a chan-library registry row
    // under this devserver's `library_id`. The native window was
    // already opened imperatively by `spawn_control_terminal_window`;
    // this furnishes only the feed row, so the control terminal rides
    // `/api/library/windows` with a REAL library_id, shows the devserver group on
    // a zero-window connect, survives reload, and is reaped by
    // `reap_control_window` on the connect-script PTY exit. Minted HERE
    // (post-`wait_for_devserver`) because the library_id only arrives with `info`;
    // read-time assembly resolves the row's prefix/token/connected from the tenant.
    if let Some((ct, generation)) = &control {
        ensure_control_run_live(&state, &id, *generation, &ct.prefix)?;
        if let Some(embedded) = state.embedded() {
            embedded.mint_control_window(
                serve::control_terminal_label(&id),
                control_library_id.clone(),
                ct.prefix.clone(),
            )?;
        }
    }
    seed_devserver_color(
        &state,
        &id,
        &conn,
        "eager pane-colour seed failed; the colour watch will fill it",
    )
    .await;
    if let Some((ct, generation)) = &control {
        ensure_control_run_live(&state, &id, *generation, &ct.prefix)?;
    }
    // The window watcher is the SOLE driver of this devserver's native windows:
    // spawn it over the library feed (`/api/library/windows/watch`), and its
    // snapshots reconcile open whatever the devserver persisted. An EMPTY feed is
    // valid (a fresh devserver, or one the user emptied before disconnecting).
    let (cancel, snapshot, view) = window_watcher_wiring::spawn_devserver_window_watcher(
        id.clone(),
        app.clone(),
        conn.clone(),
    )
    .await?;
    if let Some((ct, generation)) = &control {
        ensure_control_run_live(&state, &id, *generation, &ct.prefix)?;
    }
    wire_devserver_watcher(&app, &state, &id, conn, (cancel, snapshot, view), None);
    // The desktop does not mint a boot terminal on connect: the headless
    // devserver runs the library's own first-open rule when it opens (one
    // terminal the very first time, never re-minted once the user closes it), so
    // the desktop just reconciles whatever the feed reports.
    //
    // The control terminal stays open after connect while its script runs. Its
    // exit watcher (started as soon as the prefix was registered, before token
    // scraping) auto-reaps it when the script returns cleanly within the
    // connect grace (the daemonize handshake), disconnects the whole devserver
    // when a clean return comes later (the script was the transport), and
    // keeps it at "process exited" when the script fails.
    // Auto-hide the control terminal on connect success when the devserver's
    // "auto-hide control terminal on success" is set. A PROGRAMMATIC hide → reuse
    // the silent-hide path so it does NOT fire the bury notice (unlike the OS
    // close button); the close handler buries it + flips its launcher dot hidden.
    if auto_hide_control && control.is_some() {
        let label = serve::control_terminal_label(&id);
        state.mark_silent_hide(&label);
        let app_for_hide = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(w) = app_for_hide.get_webview_window(&label) {
                let _ = w.close();
            }
        });
    }
    // Re-push the launcher feed now so the control-terminal record appears
    // immediately. On a FRESH connect the boot terminal's feed push would
    // trigger this, but on RECONNECT the feed can be empty for a beat -- the cached
    // library_id (`library_id_of`) lets `windows()` emit the control record, and
    // this signal makes the launcher pick it up without waiting for a later window.
    if let Some(embedded) = state.embedded() {
        embedded.signal_library_change();
    }
    let _ = app.emit(serve::SERVES_CHANGED, ());
    Ok(())
}

/// Open a devserver workspace window by MINTING it on the devserver's library
/// (`POST /api/library/windows {Workspace, path}`). The window watcher then
/// reconciles the new record open, so the window is feed-driven: it persists
/// server-side and reopens on reconnect, and disconnect closes it via the
/// watcher's reconcile-to-empty. The SPA Open button
/// turns the workspace ON first, so the minted record resolves a live token (an
/// off workspace mints an empty token the watcher skips). Reached over the
/// desktop bridge from the launcher's `workspaces/open` route.
pub(crate) async fn open_devserver_workspace_impl(
    state: &Arc<AppState>,
    id: String,
    path: String,
) -> Result<(), String> {
    let conn = state
        .devservers
        .get(&id)
        .ok_or_else(|| "devserver is not connected".to_string())?;
    devserver::mint_library_window(&conn, chan_server::WindowKind::Workspace, Some(path)).await?;
    Ok(())
}

/// Mint a standalone terminal window on a connected devserver's library (the
/// launcher's per-devserver New Terminal button). The library assigns the window
/// id, persists the record, and fires the watch, so the desktop's window watcher
/// opens it as a `lib-` terminal on the devserver's shared `/terminal` tenant  --
/// the same terminal family as the connect-time boot terminal, not an isolated
/// per-window tenant. Reached over the desktop bridge from the launcher's
/// per-devserver `terminal` route.
pub(crate) async fn open_devserver_terminal_impl(
    state: &Arc<AppState>,
    id: String,
) -> Result<(), String> {
    let conn = state
        .devservers
        .get(&id)
        .ok_or_else(|| format!("devserver {id} is not connected"))?;
    devserver::mint_library_window(&conn, chan_server::WindowKind::Terminal, None).await?;
    Ok(())
}

/// Forget (unmount) a workspace on a connected devserver via its management
/// API. The devserver stops serving that workspace; its files on the box are
/// untouched and it can be re-mounted later. Reached over the desktop bridge
/// from the launcher's `workspaces/{prefix}` DELETE route.
pub(crate) async fn forget_devserver_workspace_impl(
    state: &Arc<AppState>,
    id: String,
    prefix: String,
    force: bool,
) -> Result<chan_server::SetWorkspaceOnOutcome, String> {
    let conn = state
        .devservers
        .get(&id)
        .ok_or_else(|| format!("devserver {id} is not connected"))?;
    match devserver::forget_workspace(&conn, &devserver_route_prefix(&prefix), force).await {
        Ok(()) => {
            if let Err(e) = refresh_devserver_workspace_cache(state, &id, &conn).await {
                tracing::warn!(devserver = %id, error = %e, "refreshing devserver workspaces after forget failed");
            }
            Ok(chan_server::SetWorkspaceOnOutcome::Done)
        }
        Err(devserver::SetWorkspaceOnError::ActiveTerminals { active_terminals }) => {
            Ok(chan_server::SetWorkspaceOnOutcome::NeedsForce { active_terminals })
        }
        Err(devserver::SetWorkspaceOnError::Other { message }) => Err(message),
    }
}

/// Set a registered devserver workspace on (mount + mint a fresh tenant token)
/// or off (unmount, keep registered) -- the on/off toggle on a devserver row,
/// distinct from Forget ([`forget_devserver_workspace_impl`]). Reached over the
/// desktop bridge from the launcher's `workspaces/on|off` routes.
/// An unforced off of a workspace with live terminals is NOT an error: it
/// resolves to [`NeedsForce`](chan_server::SetWorkspaceOnOutcome::NeedsForce)
/// with the live-terminal count, so the launcher confirms then retries with
/// `force: true` (which force-offs -> [`Done`](chan_server::SetWorkspaceOnOutcome::Done)).
pub(crate) async fn set_devserver_workspace_on_impl(
    state: &Arc<AppState>,
    id: String,
    prefix: String,
    on: bool,
    force: bool,
) -> Result<chan_server::SetWorkspaceOnOutcome, String> {
    let conn = state
        .devservers
        .get(&id)
        .ok_or_else(|| format!("devserver {id} is not connected"))?;
    match devserver::set_workspace_on(&conn, &devserver_route_prefix(&prefix), on, force).await {
        Ok(()) => {
            if let Err(e) = refresh_devserver_workspace_cache(state, &id, &conn).await {
                tracing::warn!(devserver = %id, error = %e, "refreshing devserver workspaces after toggle failed");
            }
            Ok(chan_server::SetWorkspaceOnOutcome::Done)
        }
        // Live-terminal block is a confirmable outcome, not a failure: round-trip
        // the count so the launcher can offer the force-off.
        Err(devserver::SetWorkspaceOnError::ActiveTerminals { active_terminals }) => {
            Ok(chan_server::SetWorkspaceOnOutcome::NeedsForce { active_terminals })
        }
        // A LOCAL devserver registers its workspaces over the well-known
        // discovery socket, which is the source of truth; the HTTP toggle is
        // best-effort, so a transport failure (e.g. a stale port after a restart)
        // is non-fatal and must not toast on `chan serve`. A remote devserver
        // (which always has a connect script / ssh tunnel) still surfaces it.
        Err(devserver::SetWorkspaceOnError::Other { message }) => {
            if devserver_is_local(state, &id) {
                tracing::warn!(devserver = %id, "local devserver workspace toggle failed (non-fatal): {message}");
                Ok(chan_server::SetWorkspaceOnOutcome::Done)
            } else {
                Err(message)
            }
        }
    }
}

/// Whether the connected devserver `id` is LOCAL: configured with no connect
/// script (a remote devserver always has one -- an `ssh -L` tunnel or gateway
/// dial -- even though both resolve to a loopback host, so the host alone can't
/// tell them apart). A local devserver's workspace toggle is best-effort.
fn devserver_is_local(state: &AppState, id: &str) -> bool {
    state
        .store
        .lock()
        .ok()
        .and_then(|store| store.get().ok())
        .and_then(|cfg| {
            cfg.devservers
                .iter()
                .find(|d| d.id == id)
                .map(|d| d.script.trim().is_empty())
        })
        .unwrap_or(false)
}

/// Resolve a `chan devserver connect|disconnect|forget` TARGET (or the
/// `--on TARGET` of the workspace lifecycle verbs) -- a URL or a launcher
/// label -- to one persisted registry row id. Gateway-roster rows are
/// deliberately out of reach: they carry no local config, and the Gateways
/// screen manages them. Ambiguity refuses with the candidates rather than
/// guessing; the pure resolution lives in [`remote_workspace`].
#[cfg(any(unix, windows))]
fn resolve_devserver_target(state: &Arc<AppState>, target: &str) -> Result<String, String> {
    let cfg = state
        .store
        .lock()
        .unwrap()
        .get()
        .map_err(|e| e.to_string())?;
    remote_workspace::resolve_devserver_target_in(&cfg.devservers, target)
}

/// The `chan devserver ls` projection: every registry row (gateway-roster
/// rows included, marked) as a summary the CLI renders.
fn list_devservers_from_handoff(
    state: &Arc<AppState>,
) -> Vec<chan_server::handoff::DevserverSummary> {
    use chan_server::DevserverRegistry;
    let registry = config::DevserverConfigRegistry::new(
        Arc::clone(&state.store),
        Arc::clone(&state.devserver_remove_hook),
        Arc::clone(&state.devservers),
        Arc::clone(&state.devserver_connecting),
        Arc::clone(&state.devserver_feed),
        Arc::clone(&state.gateway_manager),
    );
    registry
        .list()
        .into_iter()
        .map(|e| chan_server::handoff::DevserverSummary {
            // Rows registered by an older desktop may still carry `?t=`.
            url: config::display_devserver_url(&e.url),
            label: e.label,
            status: match e.status {
                chan_server::DevserverStatus::Disconnected => "disconnected",
                chan_server::DevserverStatus::Connecting => "connecting",
                chan_server::DevserverStatus::Connected => "connected",
                chan_server::DevserverStatus::Unreachable => "unreachable",
            }
            .into(),
            gateway: e.gateway_id.is_some(),
        })
        .collect()
}

/// The `chan devserver forget` handoff: remove one registration row. A live
/// (connected or connecting) row refuses without `force`; with it, the
/// registry's remove hook performs the disconnect-and-remove in one stroke.
/// The remote devserver process keeps running either way.
fn forget_devserver_from_handoff(
    state: &Arc<AppState>,
    target: &str,
    force: bool,
) -> Result<(), String> {
    use chan_server::DevserverRegistry;
    let id = resolve_devserver_target(state, target)?;
    let live = state.devservers.is_connected(&id)
        || state.devserver_connecting.lock().unwrap().contains(&id);
    if live && !force {
        return Err(format!(
            "devserver {target:?} is connected; run `chan devserver disconnect {target}` \
             first, or pass --force to disconnect and forget in one step."
        ));
    }
    let registry = config::DevserverConfigRegistry::new(
        Arc::clone(&state.store),
        Arc::clone(&state.devserver_remove_hook),
        Arc::clone(&state.devservers),
        Arc::clone(&state.devserver_connecting),
        Arc::clone(&state.devserver_feed),
        Arc::clone(&state.gateway_manager),
    );
    // `remove` fires the remove hook, which reaps any live connection and
    // windows; `Ok(false)` means the row vanished in a race, which is the
    // goal state either way.
    registry.remove(&id)?;
    // Like the register handoff: a registry mutation with no window mints no
    // feed push, so the launcher needs an explicit signal to re-list.
    if let Some(embedded) = state.embedded() {
        embedded.signal_library_change();
    }
    Ok(())
}

/// The `chan workspace serve WS --on TARGET` handoff: mount WS on a registered,
/// connected devserver through the connection the desktop holds, then refresh
/// the launcher's cache so the new row shows at once. Synchronous by design
/// (the CLI's reply budget covers the server's mount timeout): the CLI reports
/// the prefix or the refusal, never a guess. A registered but disconnected
/// row refuses with a pointer at `chan devserver connect`, since dialing on
/// the CLI's behalf would skip the sign-in and trust prompts the launcher
/// owns.
#[cfg(any(unix, windows))]
async fn serve_remote_workspace_from_handoff(
    state: &Arc<AppState>,
    target: &str,
    workspace_path: &str,
) -> Result<String, String> {
    let id = resolve_devserver_target(state, target)?;
    let connecting = state.devserver_connecting.lock().unwrap().contains(&id);
    let conn =
        remote_workspace::refuse_unless_connected(state.devservers.get(&id), target, connecting)?;
    let prefix = devserver::add_workspace(&conn, workspace_path).await?;
    if let Err(e) = refresh_devserver_workspace_cache(state, &id, &conn).await {
        tracing::warn!(devserver = %id, error = %e, "refreshing devserver workspaces after a remote serve failed");
    }
    Ok(prefix)
}

/// The `chan close WS --on TARGET` (`remove: false`) and `chan workspace forget
/// WS --on TARGET` (`remove: true`) handoffs: resolve WS to one row on the
/// connected devserver (refusing over guessing, listing the rows), then
/// unmount or forget through the devserver's own routes with `force` unset,
/// so its live-terminal guard answers as [`chan_server::SetWorkspaceOnOutcome::NeedsForce`].
/// These call the devserver directly rather than through the launcher's
/// toggle, whose local-devserver leniency reports a failed transport as done.
#[cfg(any(unix, windows))]
async fn close_remote_workspace_from_handoff(
    state: &Arc<AppState>,
    target: &str,
    workspace_path: &str,
    remove: bool,
) -> Result<(chan_server::SetWorkspaceOnOutcome, bool), String> {
    let id = resolve_devserver_target(state, target)?;
    let connecting = state.devserver_connecting.lock().unwrap().contains(&id);
    let conn =
        remote_workspace::refuse_unless_connected(state.devservers.get(&id), target, connecting)?;
    let rows = devserver::fetch_workspaces(&conn).await?;
    let row = remote_workspace::resolve_remote_workspace(&rows, workspace_path, target)?;
    let was_served = row.on;
    let prefix = devserver_route_prefix(&row.prefix);
    let result = if remove {
        devserver::forget_workspace(&conn, &prefix, false).await
    } else {
        devserver::set_workspace_on(&conn, &prefix, false, false).await
    };
    match result {
        Ok(()) => {
            if let Err(e) = refresh_devserver_workspace_cache(state, &id, &conn).await {
                tracing::warn!(devserver = %id, error = %e, "refreshing devserver workspaces after a remote close failed");
            }
            Ok((chan_server::SetWorkspaceOnOutcome::Done, was_served))
        }
        Err(devserver::SetWorkspaceOnError::ActiveTerminals { active_terminals }) => Ok((
            chan_server::SetWorkspaceOnOutcome::NeedsForce { active_terminals },
            was_served,
        )),
        Err(devserver::SetWorkspaceOnError::Other { message }) => Err(message),
    }
}

/// Register (and persist) a devserver from a `chan serve {url}` CLI handoff.
/// Writes the `{url, name, script}` entry through the same
/// [`DevserverConfigRegistry`](config::DevserverConfigRegistry) the launcher's
/// `/api/library/devservers` routes use (the shared config handle), so the new
/// row shows up in the launcher. A `?t=` URL carries the write-only devserver
/// bearer; otherwise the user can provide a connect script that prints
/// `CHAN_DEVSERVER_TOKEN=...` and connect it from the launcher row.
///
/// This fn stays SYNC and never dials the URL: the CLI blocks ~3s on the
/// `DevserverRegistered` response, so the is-this-really-a-gateway probe
/// rides a detached task spawned here. A gateway-positive answer converts
/// the just-registered row into a gateway entry out-of-band; the launcher
/// picks the swap up over the library feed and the wire stays byte-
/// identical for old and new CLIs alike.
fn register_devserver_from_handoff(
    app: &tauri::AppHandle,
    state: &Arc<AppState>,
    url: String,
    name: Option<String>,
    script: Option<String>,
) -> Result<(), String> {
    use chan_server::{DevserverInput, DevserverRegistry};
    // The handoff carries a URL; the registry's `add` now takes host+port (the
    // devserver model switched back to Host+Port), so parse it apart here.
    let (host, port) = devserver::parse_devserver_url(&url)?;
    let token = devserver_url_token(&url);
    let registry = config::DevserverConfigRegistry::new(
        Arc::clone(&state.store),
        Arc::clone(&state.devserver_remove_hook),
        Arc::clone(&state.devservers),
        Arc::clone(&state.devserver_connecting),
        Arc::clone(&state.devserver_feed),
        Arc::clone(&state.gateway_manager),
    );
    // The bearer rides the write-only `token` field; the stored URL never
    // carries it, so listings and the launcher header show the endpoint only.
    let entry = registry.add(DevserverInput {
        url: Some(config::display_devserver_url(&url)),
        host,
        port,
        label: name,
        script,
        token,
        clear_token: false,
        auto_hide_control: false,
    })?;
    // The launcher live-updates its devserver list from the window-watch feed
    // (`refreshDevserversLive`). A registry add mints no window, so this
    // OUT-OF-BAND `chan serve <url>` add fires no feed push and stays invisible
    // until a manual reload. The launcher's own add/edit form self-refreshes
    // (`saveDevserver` re-lists) and removal already pushes via its connection
    // teardown, so this handoff is the one path that needs an explicit signal.
    if let Some(embedded) = state.embedded() {
        embedded.signal_library_change();
    }
    let app = app.clone();
    let state = Arc::clone(state);
    tauri::async_runtime::spawn(async move {
        if devserver::discover_gateway(&entry.url).await.is_err() {
            return;
        }
        match config::convert_devserver_row_to_gateway(&state.store, &entry.id) {
            Ok(Some(gw)) => {
                let label = if gw.label.is_empty() {
                    gw.url.clone()
                } else {
                    gw.label.clone()
                };
                gateway::emit_notice(
                    &app,
                    "info",
                    "gateway",
                    &gw.id,
                    &label,
                    "Gateway added",
                    "chan serve registered a gateway; connect it on the Gateways screen to see all its devservers",
                );
                if let Some(embedded) = state.embedded() {
                    embedded.signal_library_change();
                }
            }
            // The row was removed while the probe ran: nothing to convert.
            Ok(None) => {}
            Err(e) => {
                tracing::warn!(devserver = %entry.id, error = %e, "gateway conversion after handoff failed");
            }
        }
    });
    Ok(())
}

/// Open a workspace in a native window in response to a CLI handoff
/// request (`chan serve <workspace>` while this desktop is running).
///
/// Registers and boots the workspace through the shared embedded Library, then
/// `serve::start` mounts it, restores persisted windows, and mints one new
/// window. If the workspace is already running,
/// `serve::start` returns early, so this function mints the requested window
/// directly. The watcher opens the newly minted row in both cases.
///
/// The slow work (registry write, boot scan, mount) runs on a spawned
/// task so the callback returns promptly and the CLI doesn't block on
/// the handshake. The synchronous return therefore reports only that
/// the request was accepted, not that the window is fully up; on a
/// genuine mount failure the desktop emits a system notice rather than
/// blocking the CLI.
#[cfg(any(unix, windows))]
fn open_workspace_from_handoff(
    app: tauri::AppHandle,
    state: Arc<AppState>,
    path: PathBuf,
) -> Result<(), String> {
    let key = canonical_key(&path);

    // Already running: raise an additional window immediately. This is
    // synchronous and gives the user the window without a mount cycle.
    let running_url = state
        .serves
        .lock()
        .unwrap()
        .get(&key)
        .and_then(|h| h.url.clone());
    if running_url.is_some() {
        // Already running: mint another window; the watcher opens it.
        return state
            .embedded()
            .ok_or_else(|| "embedded local server is unavailable".to_string())?
            .mint_window(chan_server::WindowKind::Workspace, Some(key.clone()))
            .map(|_| ());
    }

    // Not running: register (creating the dir for a fresh path)
    // through the shared Library, then mount + spawn the window. Off
    // the listener task so the CLI gets a prompt response.
    let Some(embedded) = state.embedded.get() else {
        return Err("embedded local server is unavailable".to_string());
    };
    let library = embedded.library().clone();
    let key_for_block = key.clone();
    tauri::async_runtime::spawn(async move {
        let library_for_register = library.clone();
        let key_for_register = key_for_block.clone();
        let registered = tokio::task::spawn_blocking(move || {
            register_workspace_path(&library_for_register, &key_for_register)
        })
        .await;
        match registered {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                emit_system_notice(
                    &app,
                    "warning",
                    format!("Could not open {key_for_block} from chan serve: {e}"),
                );
                return;
            }
            Err(e) => {
                emit_system_notice(
                    &app,
                    "warning",
                    format!("Opening {key_for_block} from chan serve panicked: {e}"),
                );
                return;
            }
        }
        // The handoff is an explicit open, so mint after mounting and restoring.
        if let Err(e) = serve::start(
            app.clone(),
            Arc::clone(&state),
            key_for_block.clone(),
            serve::WorkspaceOpenMode::OpenWindow,
        )
        .await
        {
            emit_system_notice(
                &app,
                "warning",
                format!("Could not open {key_for_block} from chan serve: {e}"),
            );
        }
    });
    Ok(())
}

/// Tear down a local workspace handed off from `chan close` / `chan workspace forget`
/// (handoff `CloseWorkspace`). Runs through the embedded host's owner operation
/// so live-terminal refusal is reported before anything is unregistered.
async fn close_workspace_from_handoff(
    app: tauri::AppHandle,
    state: Arc<AppState>,
    path: PathBuf,
    remove: bool,
) -> Result<chan_server::WorkspaceLifecycleOutcome, String> {
    if state.embedded.get().is_none() {
        // No embedded host to tear down through: let the CLI fall back to the
        // control-socket path (Error → not HandedOff).
        return Err("embedded local server is unavailable".to_string());
    }
    let key = canonical_key(&path);
    let embedded = state
        .embedded
        .get()
        .expect("embedded availability checked above");
    let outcome = if remove {
        embedded
            .remove_workspace_root(Path::new(&key), false)
            .await?
    } else {
        embedded
            .close_workspace_root(Path::new(&key), false)
            .await?
    };
    match outcome {
        chan_server::WorkspaceLifecycleOutcome::Completed
        | chan_server::WorkspaceLifecycleOutcome::NotFound => {
            state.serves.lock().unwrap().remove(&key);
            persist_workspaces(&state);
            let _ = app.emit(serve::SERVES_CHANGED, ());
        }
        chan_server::WorkspaceLifecycleOutcome::Refused { .. } => {}
    }
    Ok(outcome)
}

/// The reason this desktop cannot drive `tauri-plugin-updater` for itself,
/// or `None` when it can. macOS always can: the `.app` is the payload. On
/// Linux only the AppImage can: the plugin overwrites the file named by
/// `$APPIMAGE` in place, and any other Linux binary (a `cargo run` build,
/// the Tauri deb/rpm that CI never publishes) would have it rewrite
/// `current_exe()` with AppImage bytes. On Windows only an NSIS-installed
/// `chan-desktop.exe` can: the payload is the installer, which reinstalls
/// over the install it was started from, and a `cargo run` binary would
/// install a second copy under `%LOCALAPPDATA%`. The distro-packaged
/// refusal (`CHAN_PACKAGED`) sits upstream in the CLI, so a COPR/PPA/AUR/Nix
/// desktop never reaches this.
#[cfg(target_os = "macos")]
fn desktop_updater_refusal() -> Option<String> {
    None
}

#[cfg(target_os = "linux")]
fn desktop_updater_refusal() -> Option<String> {
    linux_updater_refusal(cs_install::appimage_path().as_deref())
}

#[cfg(windows)]
fn desktop_updater_refusal() -> Option<String> {
    windows_updater_refusal(cs_install::is_installed_desktop_exe())
}

/// The Windows half of [`desktop_updater_refusal`], keyed on the installed
/// classification so a test can flip it.
#[cfg(any(windows, test))]
fn windows_updater_refusal(installed: bool) -> Option<String> {
    if installed {
        return None;
    }
    Some(
        "desktop self-upgrade on windows is available only for an installed chan-desktop (the \
         NSIS install's own directory, under %LOCALAPPDATA% or Program Files by default); this \
         build does not run from an install"
            .to_string(),
    )
}

/// Windows: a live self-managed devserver daemon (`chan devserver start
/// --service=chan`) runs from the install's own `chan.exe`, which the NSIS
/// installer cannot overwrite while that image is mapped, so both update
/// drivers refuse until it is stopped. Keyed on the pid so a test can flip it.
#[cfg(any(windows, test))]
fn windows_devserver_daemon_refusal(daemon_pid: Option<u32>) -> Option<String> {
    daemon_pid.map(|pid| {
        format!(
            "a self-managed devserver (pid {pid}) is running from this install and holds its \
             chan.exe; stop it with `chan devserver stop`, then retry the update"
        )
    })
}

/// The Linux half of [`desktop_updater_refusal`], keyed on the AppImage path
/// so a test can flip it.
#[cfg(any(target_os = "linux", test))]
fn linux_updater_refusal(appimage: Option<&std::path::Path>) -> Option<String> {
    if appimage.is_some() {
        return None;
    }
    Some(
        "desktop self-upgrade on linux is available only when chan-desktop runs from its \
         AppImage; this build was not started from one"
            .to_string(),
    )
}

/// Drive `tauri-plugin-updater` in response to a `chan upgrade` from the
/// desktop-dispatched `chan` binary (handoff `Upgrade` request).
///
/// With `check_only` we report availability synchronously (the CLI prints
/// it) without installing. Otherwise we kick off check -> download -> install
/// on a background task and return `UpgradeStarted` at once (fire-and-return:
/// the multi-MB download can't be awaited from the CLI socket round-trip);
/// when it finishes we re-affirm the `~/.local/bin/{chan,cs}` shims and
/// relaunch into the new version.
/// Desktop updater payloads are signed and published for the macOS `.app`,
/// the Linux AppImage, and the Windows NSIS installer. A Linux build that is
/// not running from an AppImage and a Windows build that is not an install
/// return a clear error rather than pretending to upgrade.
#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
async fn desktop_handle_upgrade(
    _app: tauri::AppHandle,
    _check_only: bool,
) -> chan_server::handoff::Response {
    chan_server::handoff::Response::Error {
        message: format!(
            "desktop upgrade over hand-off is not supported on {}",
            std::env::consts::OS
        ),
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
async fn desktop_handle_upgrade(
    app: tauri::AppHandle,
    check_only: bool,
) -> chan_server::handoff::Response {
    use chan_server::handoff::{Response, CHAN_VERSION};
    use tauri_plugin_updater::UpdaterExt;

    if let Some(message) = desktop_updater_refusal() {
        return Response::Error { message };
    }

    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            return Response::Error {
                message: format!("updater unavailable: {e}"),
            }
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            if check_only {
                return Response::UpgradeChecked {
                    desktop_version: CHAN_VERSION.into(),
                    available: Some(version),
                };
            }
            // Fire-and-return: install in the background; the CLI already has
            // its `UpgradeStarted` ack.
            let app_bg = app.clone();
            tauri::async_runtime::spawn(async move {
                let state = Arc::clone(&app_bg.state::<Arc<AppState>>());
                // Serialize with the on-launch check; when it already installed
                // this version, relaunching is all that is left to do.
                let _gate = state.update_gate.lock().await;
                if state.update_installed_version.lock().unwrap().as_deref()
                    == Some(version.as_str())
                {
                    tracing::info!(%version, "update already installed by the on-launch check; relaunching");
                    let _ = begin_normal_shutdown(app_bg, ShutdownAction::Restart);
                    return;
                }
                match update
                    .download_and_install(|_chunk, _total| {}, || {})
                    .await
                {
                    Ok(()) => {
                        // Re-affirm the shims to the (possibly relocated)
                        // binary before relaunching into the new version.
                        match cs_install::install_bin_shims() {
                            Ok(n) => {
                                tracing::info!(shims = n, "re-affirmed bin shims after update")
                            }
                            Err(e) => {
                                tracing::warn!(error = %e, "re-affirming bin shims after update failed")
                            }
                        }
                        *state.update_installed_version.lock().unwrap() = Some(version.clone());
                        tracing::info!(%version, "chan-desktop update installed; relaunching");
                        let _ = begin_normal_shutdown(app_bg, ShutdownAction::Restart);
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "chan-desktop update failed");
                        emit_system_notice(
                            &app_bg,
                            "warning",
                            format!("chan-desktop update failed: {e}"),
                        );
                    }
                }
            });
            Response::UpgradeStarted {
                desktop_version: CHAN_VERSION.into(),
            }
        }
        Ok(None) => Response::UpgradeChecked {
            desktop_version: CHAN_VERSION.into(),
            available: None,
        },
        Err(e) => Response::Error {
            message: format!("update check failed: {e}"),
        },
    }
}

/// The Windows arm of the handoff upgrade. The install IS the exit here:
/// `tauri-plugin-updater` launches the NSIS installer (passive, `/R` so it
/// relaunches the app) and exits the process itself, so the bytes are
/// downloaded and verified first, then the embedded tenants are drained
/// through `begin_normal_shutdown`, and only then is the installer handed
/// the bytes. Fire-and-return like the unix arm: the CLI already has its
/// `UpgradeStarted` ack and its "it will relaunch when done" stays true.
#[cfg(windows)]
async fn desktop_handle_upgrade(
    app: tauri::AppHandle,
    check_only: bool,
) -> chan_server::handoff::Response {
    use chan_server::handoff::{Response, CHAN_VERSION};
    use tauri_plugin_updater::UpdaterExt;

    if let Some(message) = desktop_updater_refusal() {
        return Response::Error { message };
    }
    if let Some(message) = windows_devserver_daemon_refusal(chan::self_managed_devserver_pid()) {
        return Response::Error { message };
    }

    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            return Response::Error {
                message: format!("updater unavailable: {e}"),
            }
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            if check_only {
                return Response::UpgradeChecked {
                    desktop_version: CHAN_VERSION.into(),
                    available: Some(version),
                };
            }
            let app_bg = app.clone();
            tauri::async_runtime::spawn(async move {
                let state = Arc::clone(&app_bg.state::<Arc<AppState>>());
                // Serialize with the on-launch check, and reuse the bytes it
                // staged for this same version instead of downloading twice.
                let _gate = state.update_gate.lock().await;
                let staged = state
                    .pending_update
                    .lock()
                    .unwrap()
                    .take_if(|p| p.version == version)
                    .map(|p| p.bytes);
                let bytes = match staged {
                    Some(bytes) => {
                        tracing::info!(%version, "installing the update staged by the on-launch check");
                        Ok(bytes)
                    }
                    None => update.download(|_chunk, _total| {}, || {}).await,
                };
                match bytes {
                    Ok(bytes) => {
                        tracing::info!(%version, "chan-desktop update downloaded; installing and relaunching");
                        if begin_normal_shutdown(
                            app_bg.clone(),
                            ShutdownAction::InstallUpdate { update, bytes },
                        )
                        .is_err()
                        {
                            emit_system_notice(
                                &app_bg,
                                "warning",
                                "chan-desktop update not installed: a shutdown was already in progress; relaunch and run `chan upgrade` again",
                            );
                        }
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "chan-desktop update failed");
                        emit_system_notice(
                            &app_bg,
                            "warning",
                            format!("chan-desktop update failed: {e}"),
                        );
                    }
                }
            });
            Response::UpgradeStarted {
                desktop_version: CHAN_VERSION.into(),
            }
        }
        Ok(None) => Response::UpgradeChecked {
            desktop_version: CHAN_VERSION.into(),
            available: None,
        },
        Err(e) => Response::Error {
            message: format!("update check failed: {e}"),
        },
    }
}

/// On-launch background self-update check. The desktop registers
/// `tauri-plugin-updater`, but only the hand `chan upgrade` (the hand-off
/// `desktop_handle_upgrade` path) drives it -- a running desktop never checks on
/// its own, so it stays on its installed version until the user upgrades by
/// hand. Spawn a background check on launch so a stale desktop updates itself.
///
/// Opt-out mirrors the CLI's `CHAN_UPDATE_CHECK=0` (`chan::update` `ENV_DISABLE`)
/// so one env silences both the CLI banner probe and this desktop check. The new
/// bundle is downloaded + installed in the background, then the launcher is
/// notified to show its update-ready dialog. The macOS `.app` and the Linux
/// AppImage have a signed desktop updater payload/feed; a Linux build that is
/// not an AppImage skips the check, and other platforms are explicit no-ops.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn spawn_launch_update_check(app: tauri::AppHandle) {
    use tauri_plugin_updater::UpdaterExt;

    // Mirror the CLI opt-out exactly: only the literal "0" disables it.
    if matches!(std::env::var("CHAN_UPDATE_CHECK"), Ok(v) if v == "0") {
        tracing::info!("on-launch update check disabled by CHAN_UPDATE_CHECK=0");
        return;
    }
    if let Some(reason) = desktop_updater_refusal() {
        tracing::info!(%reason, "on-launch update check skipped");
        return;
    }
    tauri::async_runtime::spawn(async move {
        let updater = match app.updater() {
            Ok(u) => u,
            Err(e) => {
                tracing::warn!(error = %e, "on-launch update check: updater unavailable");
                return;
            }
        };
        match updater.check().await {
            Ok(Some(update)) => {
                let version = update.version.clone();
                tracing::info!(%version, "on-launch update available; downloading");
                let state = Arc::clone(&app.state::<Arc<AppState>>());
                // Serialize with a handoff `chan upgrade` (see
                // `AppState::update_gate`): only one driver replaces the image.
                let _gate = state.update_gate.lock().await;
                match update
                    .download_and_install(|_chunk, _total| {}, || {})
                    .await
                {
                    Ok(()) => {
                        // Re-affirm the `~/.local/bin/{chan,cs}` shims to the
                        // (possibly relocated) new binary, mirroring the
                        // `chan upgrade` install path.
                        match cs_install::install_bin_shims() {
                            Ok(n) => {
                                tracing::info!(shims = n, "re-affirmed bin shims after update")
                            }
                            Err(e) => {
                                tracing::warn!(error = %e, "re-affirming bin shims after update failed")
                            }
                        }
                        *state.update_installed_version.lock().unwrap() = Some(version.clone());
                        tracing::info!(%version, "on-launch update installed; notifying launcher");
                        notify_desktop_update_ready(&app, &version, true);
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "on-launch update download/install failed");
                    }
                }
            }
            Ok(None) => tracing::info!("on-launch update check: already up to date"),
            Err(e) => tracing::warn!(error = %e, "on-launch update check failed"),
        }
    });
}

/// The Windows arm of the on-launch check: download and verify in the
/// background, then stage the bytes and ask through the launcher's dialog.
/// Nothing is installed here, because on Windows the install is the exit
/// (the NSIS installer runs and relaunches the app); it runs only when the
/// user restarts from the dialog (`restart_desktop_after_update`).
#[cfg(windows)]
fn spawn_launch_update_check(app: tauri::AppHandle) {
    use tauri_plugin_updater::UpdaterExt;

    // Mirror the CLI opt-out exactly: only the literal "0" disables it.
    if matches!(std::env::var("CHAN_UPDATE_CHECK"), Ok(v) if v == "0") {
        tracing::info!("on-launch update check disabled by CHAN_UPDATE_CHECK=0");
        return;
    }
    if let Some(reason) = desktop_updater_refusal() {
        tracing::info!(%reason, "on-launch update check skipped");
        return;
    }
    tauri::async_runtime::spawn(async move {
        let updater = match app.updater() {
            Ok(u) => u,
            Err(e) => {
                tracing::warn!(error = %e, "on-launch update check: updater unavailable");
                return;
            }
        };
        match updater.check().await {
            Ok(Some(update)) => {
                let version = update.version.clone();
                tracing::info!(%version, "on-launch update available; downloading");
                let state = Arc::clone(&app.state::<Arc<AppState>>());
                // Serialize with a handoff `chan upgrade` (see
                // `AppState::update_gate`): one driver stages or installs.
                let _gate = state.update_gate.lock().await;
                match update.download(|_chunk, _total| {}, || {}).await {
                    Ok(bytes) => {
                        *state.pending_update.lock().unwrap() = Some(PendingUpdate {
                            update,
                            bytes,
                            version: version.clone(),
                        });
                        tracing::info!(%version, "on-launch update downloaded; notifying launcher");
                        notify_desktop_update_ready(&app, &version, false);
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "on-launch update download failed");
                    }
                }
            }
            Ok(None) => tracing::info!("on-launch update check: already up to date"),
            Err(e) => tracing::warn!(error = %e, "on-launch update check failed"),
        }
    });
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn spawn_launch_update_check(_app: tauri::AppHandle) {
    // No signed desktop updater feed for this platform; nothing to check.
}

/// After an on-launch update lands, bring the launcher forward and let its
/// in-window update dialog ask whether to relaunch now. `installed` says
/// whether the new bundle is already on disk (macOS, the Linux AppImage:
/// dismissing the dialog simply applies it on the next launch) or staged
/// for the installer that runs on restart (Windows).
#[cfg(any(target_os = "macos", target_os = "linux", windows))]
fn notify_desktop_update_ready(app: &tauri::AppHandle, version: &str, installed: bool) {
    let _ = show_window(app, "main");
    let payload = DesktopUpdateReadyPayload {
        version: version.to_string(),
        installed,
    };
    let labels: Vec<String> = app
        .webview_windows()
        .keys()
        .filter(|label| label.as_str() == "main" || label.starts_with("main-"))
        .cloned()
        .collect();
    if labels.is_empty() {
        let _ = app.emit(DESKTOP_UPDATE_READY_EVENT, payload);
        return;
    }
    for label in labels {
        let _ = app.emit_to(label.as_str(), DESKTOP_UPDATE_READY_EVENT, payload.clone());
    }
}

#[tauri::command]
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn restart_desktop_after_update(app: tauri::AppHandle) {
    let _ = begin_normal_shutdown(app, ShutdownAction::Restart);
}

/// Windows: the dialog's restart installs the staged update. The drain runs
/// first, then the installer takes the bytes and relaunches the app.
#[tauri::command]
#[cfg(windows)]
fn restart_desktop_after_update(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(message) = windows_devserver_daemon_refusal(chan::self_managed_devserver_pid()) {
        return Err(message);
    }
    let state = Arc::clone(&app.state::<Arc<AppState>>());
    let pending = state.pending_update.lock().unwrap().take();
    let Some(PendingUpdate {
        update,
        bytes,
        version,
    }) = pending
    else {
        return Err(
            "no downloaded update is staged; relaunch chan-desktop to check again".to_string(),
        );
    };
    tracing::info!(%version, "installing the staged update and relaunching");
    match begin_normal_shutdown(app, ShutdownAction::InstallUpdate { update, bytes }) {
        Ok(()) => Ok(()),
        // A quit or an earlier install is already draining: keep the staged
        // bytes so the dialog can retry once it settles, and say so.
        Err(ShutdownAction::InstallUpdate { update, bytes }) => {
            *state.pending_update.lock().unwrap() = Some(PendingUpdate {
                update,
                bytes,
                version,
            });
            Err(
                "chan-desktop is already shutting down; the staged update was not installed, \
                 relaunch and restart again"
                    .to_string(),
            )
        }
        Err(_) => Err("chan-desktop is already shutting down".to_string()),
    }
}

#[tauri::command]
#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn restart_desktop_after_update() -> Result<(), String> {
    Err(format!(
        "desktop self-upgrade is not supported on {}",
        std::env::consts::OS
    ))
}

/// Result of a connecting-screen reachability probe. Loopback targets treat
/// every HTTP response as reachable. Non-loopback targets also require that a
/// gateway upstream status (502, 503, or 504) was not returned. `detail` is a
/// short ASCII reason shown in the per-attempt row; `status` is the HTTP code
/// when a response arrived.
#[derive(Debug, Clone, Serialize)]
struct ProbeResult {
    reachable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<u16>,
    detail: String,
}

/// Server-side cap so a black-hole host (packets dropped, no RST) can't
/// hang the probe and stack up overlapping in-flight requests behind the
/// page's retry loop.
const PROBE_TIMEOUT_SECS: u64 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProbeTargetKind {
    Loopback,
    Gateway,
}

fn probe_target_kind(raw_url: &str) -> ProbeTargetKind {
    let Ok(parsed) = url::Url::parse(raw_url) else {
        return ProbeTargetKind::Gateway;
    };
    let loopback = match parsed.host() {
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        Some(url::Host::Domain(domain)) => {
            domain.eq_ignore_ascii_case("localhost")
                || domain
                    .to_ascii_lowercase()
                    .strip_suffix(".localhost")
                    .is_some()
        }
        None => false,
    };
    if loopback {
        ProbeTargetKind::Loopback
    } else {
        ProbeTargetKind::Gateway
    }
}

fn probe_response_reachable(target: ProbeTargetKind, status: Option<reqwest::StatusCode>) -> bool {
    status.is_some_and(|status| {
        target == ProbeTargetKind::Loopback
            || !matches!(
                status,
                reqwest::StatusCode::BAD_GATEWAY
                    | reqwest::StatusCode::SERVICE_UNAVAILABLE
                    | reqwest::StatusCode::GATEWAY_TIMEOUT
            )
    })
}

/// Reachability probe for the chan-desktop connecting screen. Devserver
/// windows load the bundled local `connecting.html` instead of pointing the
/// webview straight at the remote (a down remote paints a blank white webview);
/// that trusted local page calls this command on a retry loop until the remote
/// answers, then navigates. Runs from Rust because the page's CSP
/// (`default-src 'self'`) blocks a cross-origin `fetch`. Authentication cookies
/// for the target origin are copied from the calling webview when available so
/// the probe can distinguish a registered-but-not-answering gateway devserver
/// from a live one.
#[tauri::command]
async fn probe_url(window: tauri::WebviewWindow, url: String) -> ProbeResult {
    let target = probe_target_kind(&url);
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(PROBE_TIMEOUT_SECS))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return ProbeResult {
                reachable: false,
                status: None,
                detail: format!("probe client error: {e}"),
            }
        }
    };
    let mut request = client.get(&url);
    if let Ok(parsed) = url::Url::parse(&url) {
        if let Ok(cookies) = window.cookies_for_url(parsed) {
            let cookie_header = cookies
                .iter()
                .map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
                .collect::<Vec<_>>()
                .join("; ");
            if !cookie_header.is_empty() {
                if let Ok(value) = reqwest::header::HeaderValue::from_str(&cookie_header) {
                    request = request.header(reqwest::header::COOKIE, value);
                }
            }
        }
    }
    match request.send().await {
        Ok(resp) => {
            let status = resp.status();
            ProbeResult {
                reachable: probe_response_reachable(target, Some(status)),
                status: Some(status.as_u16()),
                detail: status.to_string(),
            }
        }
        Err(e) => ProbeResult {
            reachable: probe_response_reachable(target, None),
            status: None,
            detail: probe_error_detail(&e),
        },
    }
}

/// Collapse a reqwest error to the transport-failure class the
/// connecting screen's row cares about. reqwest's own Display is verbose
/// and embeds the full URL, so we surface a short ASCII label instead.
fn probe_error_detail(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "timed out".to_string()
    } else if e.is_connect() {
        "could not connect".to_string()
    } else if e.is_request() {
        "request failed".to_string()
    } else {
        "unreachable".to_string()
    }
}

/// Host OS the desktop shell is running on, as `std::env::consts::OS`
/// (`"macos"`, `"linux"`, `"windows"`, ...), for SPA features that exist
/// on one platform only. Sourced from the compiled-in target triple rather
/// than a `navigator.userAgent` sniff so the answer is exact and cannot be
/// spoofed by a webview UA string.
#[tauri::command]
fn platform_os() -> String {
    std::env::consts::OS.to_string()
}

/// Clipboard text for the terminal's right-click "Paste". Read natively
/// via `arboard` rather than the webview's `navigator.clipboard.readText()`,
/// which pops WKWebView's DOM-paste "Paste" button (a WebKit privacy
/// affordance with no JS opt-out). An empty / non-text clipboard maps
/// to "" so the SPA just treats it as nothing-to-paste; other failures
/// surface as an Err the SPA logs before falling back to the web API.
fn clipboard_read_text() -> Result<String, String> {
    match on_clipboard(|c| optional_content(c.get_text())) {
        Ok(text) => Ok(text.unwrap_or_default()),
        Err(e) => Err(e.to_string()),
    }
}

/// Write clipboard text natively for the terminal's OSC 52 copy. An OSC 52
/// sequence carries no user gesture, which a WKWebView's
/// `navigator.clipboard.writeText()` can reject, so the SPA routes the write
/// here through `arboard`. Any failure surfaces as an Err the SPA logs before
/// falling back to the web API.
fn clipboard_write_text(text: String) -> Result<(), String> {
    on_clipboard(|c| c.set_text(text)).map_err(|e| e.to_string())
}

/// Read a PNG image off the OS clipboard for `cs paste` of an image, bypassing
/// WKWebView's paste button like the text read. arboard returns raw RGBA
/// (`ImageData`), so encode it to PNG (what the terminal deals in). An
/// image-less clipboard maps to `Ok(None)` so the SPA just tries the next
/// representation.
fn clipboard_read_image() -> Result<Option<Vec<u8>>, String> {
    let image = match on_clipboard(|c| optional_content(c.get_image())) {
        Ok(Some(image)) => image,
        Ok(None) => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let width = u32::try_from(image.width).map_err(|_| "clipboard image too wide".to_string())?;
    let height = u32::try_from(image.height).map_err(|_| "clipboard image too tall".to_string())?;
    let buffer = image::RgbaImage::from_raw(width, height, image.bytes.into_owned())
        .ok_or_else(|| "clipboard image buffer size mismatch".to_string())?;
    let mut png = std::io::Cursor::new(Vec::new());
    buffer
        .write_to(&mut png, image::ImageFormat::Png)
        .map_err(|e| format!("encode clipboard png: {e}"))?;
    Ok(Some(png.into_inner()))
}

/// Allocation/dimension caps for decoding an incoming clipboard PNG. A tiny
/// PNG can declare enormous dimensions (a decompression bomb), so bound the
/// decode instead of letting `w*h*4` OOM the desktop process. The alloc cap is
/// the real guard; the dimension caps reject absurd sizes early.
fn clipboard_image_limits() -> image::Limits {
    let mut limits = image::Limits::no_limits();
    limits.max_image_width = Some(16_384);
    limits.max_image_height = Some(16_384);
    limits.max_alloc = Some(512 * 1024 * 1024);
    limits
}

/// Write a PNG image onto the OS clipboard for `cs copy` of an image. The SPA
/// sends PNG bytes (it normalizes any raster to PNG first); arboard wants raw
/// RGBA, so decode the PNG to RGBA `ImageData` under a bounded decoder (a
/// hostile PNG can declare huge dimensions). Any failure surfaces as an Err the
/// CLI reports.
fn clipboard_write_image(bytes: Vec<u8>) -> Result<(), String> {
    let mut reader = image::ImageReader::with_format(
        std::io::Cursor::new(bytes.as_slice()),
        image::ImageFormat::Png,
    );
    reader.limits(clipboard_image_limits());
    let decoded = reader
        .decode()
        .map_err(|e| format!("decode clipboard png: {e}"))?
        .to_rgba8();
    let (width, height) = (decoded.width() as usize, decoded.height() as usize);
    let image = arboard::ImageData {
        width,
        height,
        bytes: std::borrow::Cow::Owned(decoded.into_raw()),
    };
    on_clipboard(|c| c.set_image(image)).map_err(|e| e.to_string())
}

/// Read HTML off the OS clipboard for `cs paste --html`. An HTML-less clipboard
/// maps to `Ok(None)`. Native arboard read, mirroring [`clipboard_read_text`].
fn clipboard_read_html() -> Result<Option<String>, String> {
    match on_clipboard(|c| optional_content(c.get().html())) {
        Ok(html) => Ok(html),
        Err(e) => Err(e.to_string()),
    }
}

/// Write HTML (with a plain-text fallback) onto the OS clipboard for
/// `cs copy --html`, so a real browser reading the OS clipboard (a paste into
/// Gmail) keeps the formatting. arboard's HTML setter carries the alt text for
/// plain-only targets.
fn clipboard_write_html(html: String, alt_text: String) -> Result<(), String> {
    on_clipboard(|c| c.set().html(html, Some(alt_text))).map_err(|e| e.to_string())
}

/// An absent representation is not a failure: `ContentNotAvailable` means the
/// clipboard holds no such kind, which every read treats as `None`. Classifying
/// it inside the operation keeps `with_cached_clipboard` from mistaking it for a
/// broken connection and discarding the handle that OWNS the selection on Linux.
fn optional_content<T>(result: Result<T, arboard::Error>) -> Result<Option<T>, arboard::Error> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(arboard::Error::ContentNotAvailable) => Ok(None),
        Err(e) => Err(e),
    }
}

/// Acquire the OS clipboard and run one operation on it, off Linux: a fresh
/// handle per operation, which is what every platform did before Linux needed
/// its own lifetime. macOS's NSPasteboard is a server-side clipboard, so the
/// handle's lifetime carries no meaning, and on Windows `Clipboard::new()` OPENS
/// the OLE clipboard, which must be closed promptly or every other app is
/// locked out of it. Errors stay `arboard::Error` so each command maps
/// acquisition and operation failures together.
#[cfg(not(target_os = "linux"))]
fn on_clipboard<T>(
    op: impl FnOnce(&mut arboard::Clipboard) -> Result<T, arboard::Error>,
) -> Result<T, arboard::Error> {
    arboard::Clipboard::new().and_then(|mut clipboard| op(&mut clipboard))
}

/// Acquire the OS clipboard and run one operation on it, on Linux: ONE handle
/// for the whole process, connected on first use and reused afterwards.
///
/// X11 and the wlr data-control protocol serve a selection FROM THE OWNING
/// CLIENT -- the bytes live in the owner, not in the display server. A handle
/// created per operation makes chan the owner for microseconds and then drops
/// it, so a `cs copy` is released before the session's clipboard manager can
/// take a copy and the paste target still sees the previous contents (arboard
/// says as much in its own drop-time warning). Keeping the handle alive keeps
/// chan a real owner, which is what arboard documents as the fix.
///
/// Every caller already runs under [`run_clipboard_op`]'s guard, so this lock is
/// uncontended in practice; it is here to own mutable static state safely, not
/// to serialize.
#[cfg(target_os = "linux")]
fn on_clipboard<T>(
    op: impl FnOnce(&mut arboard::Clipboard) -> Result<T, arboard::Error>,
) -> Result<T, arboard::Error> {
    static CLIPBOARD: OnceLock<Mutex<Option<arboard::Clipboard>>> = OnceLock::new();
    let mut slot = match CLIPBOARD.get_or_init(|| Mutex::new(None)).lock() {
        Ok(slot) => slot,
        // A panic inside an operation leaves the cached handle's state unknown,
        // so recover the lock but reconnect from scratch.
        Err(poisoned) => {
            let mut slot = poisoned.into_inner();
            *slot = None;
            slot
        }
    };
    with_cached_clipboard(&mut slot, arboard::Clipboard::new, op)
}

/// Reuse `slot`'s handle, connecting on first use, and discard it whenever an
/// operation fails so the next one reconnects: a handle whose display-server
/// connection died (the X session restarted under us) would otherwise fail every
/// later operation for the life of the process. Generic over the handle so the
/// reuse and discard rules are testable without a clipboard server.
#[cfg(target_os = "linux")]
fn with_cached_clipboard<C, T, E>(
    slot: &mut Option<C>,
    connect: impl FnOnce() -> Result<C, E>,
    op: impl FnOnce(&mut C) -> Result<T, E>,
) -> Result<T, E> {
    let handle = match slot {
        Some(handle) => handle,
        None => slot.insert(connect()?),
    };
    let result = op(handle);
    if result.is_err() {
        *slot = None;
    }
    result
}

/// Process-wide serialization for the native clipboard off macOS: one clipboard
/// operation at a time while holding this guard. The X11 selection dance and
/// Windows' OLE clipboard both misbehave when two of them run at once, and
/// async commands run concurrently, so the mutual exclusion must be explicit
/// rather than inherited from a single invoke thread.
#[cfg(not(target_os = "macos"))]
fn clipboard_serial_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Run one clipboard operation on the blocking pool, serialized against every
/// other one. arboard's X11 backend waits on the selection owner to answer a
/// target, which a dead or uncooperative owner never does, so a synchronous
/// command holds the Tauri invoke thread for seconds and the window cannot even
/// render the `cs paste` request card. The guard is taken INSIDE the blocking
/// closure so a queued operation parks a pool thread, never the async runtime.
#[cfg(not(target_os = "macos"))]
async fn run_clipboard_op<T, F>(op: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    let joined = tauri::async_runtime::spawn_blocking(move || {
        let _guard = clipboard_serial_lock()
            .lock()
            .map_err(|_| "clipboard lock poisoned".to_string())?;
        op()
    })
    .await;
    clipboard_join_result(joined)
}

/// Flatten a clipboard blocking task's join result: the operation's own error
/// rides through untouched, and a task that panicked or was cancelled becomes
/// an ordinary command error rather than an unwrap on the invoke path.
#[cfg(not(target_os = "macos"))]
fn clipboard_join_result<T>(joined: tauri::Result<Result<T, String>>) -> Result<T, String> {
    joined.map_err(|e| format!("clipboard task failed: {e}"))?
}

// The six clipboard commands. macOS keeps them synchronous, so each one runs on
// the main thread NSPasteboard expects; every other platform makes them async
// over `run_clipboard_op`, so a stalled clipboard owner cannot hold the invoke
// thread. Same names either way, so the ACL and the SPA see one surface.

/// See [`clipboard_read_text`].
#[cfg(target_os = "macos")]
#[tauri::command]
fn read_clipboard_text() -> Result<String, String> {
    clipboard_read_text()
}

/// See [`clipboard_read_text`].
#[cfg(not(target_os = "macos"))]
#[tauri::command]
async fn read_clipboard_text() -> Result<String, String> {
    run_clipboard_op(clipboard_read_text).await
}

/// See [`clipboard_write_text`].
#[cfg(target_os = "macos")]
#[tauri::command]
fn write_clipboard_text(text: String) -> Result<(), String> {
    clipboard_write_text(text)
}

/// See [`clipboard_write_text`].
#[cfg(not(target_os = "macos"))]
#[tauri::command]
async fn write_clipboard_text(text: String) -> Result<(), String> {
    run_clipboard_op(move || clipboard_write_text(text)).await
}

/// See [`clipboard_read_image`].
#[cfg(target_os = "macos")]
#[tauri::command]
fn read_clipboard_image() -> Result<Option<Vec<u8>>, String> {
    clipboard_read_image()
}

/// See [`clipboard_read_image`].
#[cfg(not(target_os = "macos"))]
#[tauri::command]
async fn read_clipboard_image() -> Result<Option<Vec<u8>>, String> {
    run_clipboard_op(clipboard_read_image).await
}

/// See [`clipboard_write_image`].
#[cfg(target_os = "macos")]
#[tauri::command]
fn write_clipboard_image(bytes: Vec<u8>) -> Result<(), String> {
    clipboard_write_image(bytes)
}

/// See [`clipboard_write_image`].
#[cfg(not(target_os = "macos"))]
#[tauri::command]
async fn write_clipboard_image(bytes: Vec<u8>) -> Result<(), String> {
    run_clipboard_op(move || clipboard_write_image(bytes)).await
}

/// See [`clipboard_read_html`].
#[cfg(target_os = "macos")]
#[tauri::command]
fn read_clipboard_html() -> Result<Option<String>, String> {
    clipboard_read_html()
}

/// See [`clipboard_read_html`].
#[cfg(not(target_os = "macos"))]
#[tauri::command]
async fn read_clipboard_html() -> Result<Option<String>, String> {
    run_clipboard_op(clipboard_read_html).await
}

/// See [`clipboard_write_html`].
#[cfg(target_os = "macos")]
#[tauri::command]
fn write_clipboard_html(html: String, alt_text: String) -> Result<(), String> {
    clipboard_write_html(html, alt_text)
}

/// See [`clipboard_write_html`].
#[cfg(not(target_os = "macos"))]
#[tauri::command]
async fn write_clipboard_html(html: String, alt_text: String) -> Result<(), String> {
    run_clipboard_op(move || clipboard_write_html(html, alt_text)).await
}

fn show_window(app: &tauri::AppHandle, label: &str) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(label) {
        w.show().map_err(err)?;
        w.set_focus().map_err(err)?;
    }
    Ok(())
}

fn devserver_library_id_from_window_label(label: &str) -> Option<&str> {
    label
        .split_once("::")
        .map(|(library_id, _)| library_id)
        .filter(|library_id| library_id.starts_with("lib-"))
}

fn devserver_id_for_window_label(feed: &DevserverFeed, label: &str) -> Option<String> {
    let library_id = devserver_library_id_from_window_label(label)?;
    feed.devserver_id_for_library(library_id)
}

/// Reload the calling webview window. Backs the SPA's tab
/// context-menu "Reload" entry AND the
/// `Cmd+R` accelerator wired in `KEY_BRIDGE_JS`. The accelerator
/// path bypasses the SPA event bus and invokes this command
/// directly so a SPA-side fault (frozen Svelte runtime, JS error
/// in the chord handler) doesn't lock the dev affordance away.
#[tauri::command]
fn reload_window(
    app: tauri::AppHandle,
    state: State<Arc<AppState>>,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    if reload_devserver_window_from_feed(&app, state.inner(), window.label())? {
        return Ok(());
    }
    // Tauri 2's `WebviewWindow::eval` runs JS inside the webview;
    // we use it instead of the missing-in-2 `reload()` method.
    window
        .eval("window.location.reload()")
        .map_err(|e| format!("reloading window: {e}"))
}

fn reload_devserver_window_from_feed(
    app: &tauri::AppHandle,
    state: &Arc<AppState>,
    label: &str,
) -> Result<bool, String> {
    if !label.starts_with("lib-") {
        return Ok(false);
    }
    let Some((devserver_id, record)) = state.devserver_feed.record_for_native_label(label) else {
        return Ok(false);
    };
    if record.token.is_empty() {
        return Ok(false);
    }
    let Some(conn) = state.devservers.get(&devserver_id) else {
        return Ok(false);
    };
    // Resolving the navigation URL can be a network round trip (a gateway
    // entry mint), so the reload is fire-and-forget: the command returns
    // "handled" and the task navigates when the URL lands.
    let app = app.clone();
    let label = label.to_string();
    let record = record.clone();
    tauri::async_runtime::spawn(async move {
        let url = match devserver::window_navigation_url(&conn, &record).await {
            Ok(url) => url,
            Err(e) => {
                tracing::warn!(
                    window = %record.window_id,
                    error = %e,
                    "reload: resolving devserver window URL failed",
                );
                return;
            }
        };
        if let Err(e) =
            devserver::install_gateway_webview_session(&app, &conn, Some(label.as_str()))
        {
            tracing::warn!(window = %record.window_id, error = %e, "reload: installing gateway WebView session failed");
            return;
        }
        let result = match serve::retarget_watched_remote_window(&app, &url, &record) {
            Ok(true) => Ok(()),
            Ok(false) => {
                serve::open_watched_remote_window(&app, &url, &conn.name, &record, Box::new(|_| {}))
            }
            Err(e) => Err(e),
        };
        if let Err(e) = result {
            tracing::warn!(
                window = %record.window_id,
                error = %e,
                "reload: navigating devserver window failed",
            );
        }
    });
    Ok(true)
}

/// Open the DevTools inspector on the calling webview. Mirrors
/// the SPA's "Open Inspector" context-menu entry
/// AND the `Cmd+Opt+I` accelerator in `KEY_BRIDGE_JS`. Requires
/// the `devtools` Cargo feature on the `tauri` crate (enabled in
/// `desktop/src-tauri/Cargo.toml`) so release builds carry the
/// inspector affordance, not just debug builds. Tauri 2 removed
/// the `app.devTools` JSON config key in favour of this
/// compile-time flag.
#[tauri::command]
fn open_devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}

/// New Window from a menu-less SPA window's key bridge (Ctrl+Shift+N
/// off-mac; also a control terminal's Ctrl+Shift+T, whose New-terminal
/// chord means a standalone terminal). Off macOS only the launcher keeps
/// a menubar, so these windows route the chord over IPC -- focus-proof
/// and live on the connecting screen, where the SPA command bus is dead.
/// The routing mirrors the launcher menu's New Window item but keyed on
/// the INVOKING window's label instead of focus: a workspace-class
/// window (a watcher-opened `local::` or `lib-` window)
/// opens another window of its OWN connection; anything else (a control
/// terminal) spawns a standalone terminal.
#[tauri::command]
fn open_new_window(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    let label = window.label();
    if serve::is_workspace_webview_label(label) {
        open_new_window_for_label(&app, label)
    } else {
        spawn_terminal_window(&app);
        Ok(())
    }
}

/// Quit from a menu-less SPA window's key bridge (Ctrl+Q off-mac): the
/// same confirm-then-quit flow the launcher's Quit menu item runs. The
/// launcher's own Ctrl+Q stays with its native menu item; macOS is
/// untouched (Cmd+Q is the menubar's).
#[tauri::command]
fn request_app_quit(app: tauri::AppHandle) {
    request_quit(&app);
}

/// Close-cascade tail. The SPA
/// invokes this when the last tab and then the last empty pane of a
/// workspace window are closed: close the window, and -- only if this
/// was the LAST chan SPA window -- bring the launcher (the
/// native-desktop workspace list) back to the foreground so the user
/// isn't left with no window. The launcher's CloseRequested handler
/// hides rather than destroys it (see the setup hook), so re-showing
/// is instant.
///
/// When OTHER SPA windows remain we must NOT raise the launcher: a
/// cross-window terminal MOVE empties (and thus closes) the source
/// window, and unconditionally focusing the launcher there stole focus
/// from the drop-target window. Leaving the launcher alone lets the OS
/// keep focus on the frontmost remaining window -- the window the user
/// just dropped the terminal into.
#[tauri::command]
async fn request_close_window(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    let closing = window.label();
    // A control terminal WINDOW close is explicit teardown of that row. The
    // script/PTY-exit watcher is the path that keeps the row and emits launcher
    // attention; once the window itself is closed, reap the row/tenant so it
    // cannot linger flashing in the launcher.
    if let Some(id) = closing.strip_prefix("control-terminal-") {
        let state = app.state::<Arc<AppState>>();
        let id = id.to_string();
        let _ = show_window(&app, "main");
        close_devserver_control_terminal(&app, &state, &id).await;
        return Ok(());
    }
    let others_remain = app
        .webview_windows()
        .keys()
        .any(|label| label != closing && serve::is_workspace_webview_label(label));
    if !others_remain {
        let _ = show_window(&app, "main");
    }
    // A watcher-managed local window (`local::<window_id>`) emptied (last
    // pane/tab closed, ^W/^D/Cmd+W): DISCARD its registry record -- which reaps
    // its sessions and fires the feed -- so the watcher reconciles the native
    // window closed. The record is gone, so it can NEVER reopen (the boomerang
    // bug a bare destroy hit: the record stayed live and reconcile reopened it).
    if let Some(window_id) = closing.strip_prefix("local::") {
        if let Some(embedded) = app.state::<Arc<AppState>>().embedded() {
            match embedded.discard_window(window_id) {
                Ok(_) => return Ok(()),
                Err(e) => {
                    tracing::warn!(window = %window_id, error = %e, "discarding an emptied window failed; destroying");
                }
            }
        }
    }
    // A watcher-managed DEVSERVER window (`lib-<library_id>::<window_id>`) closes
    // immediately while its registry DELETE runs asynchronously. Record the
    // close intent before destroying the native surface. A stale feed snapshot
    // must keep treating this label as suppressed when the DELETE cannot reach
    // the server; reconnect retries the same intent without reopening it.
    if closing.starts_with("lib-") {
        let state = Arc::clone(app.state::<Arc<AppState>>().inner());
        let label = closing.to_string();
        if let Some((devserver_id, record)) = state.devserver_feed.record_for_native_label(&label) {
            state.pending_window_deletes.queue(&devserver_id, &record);
            if let Some(view) = state
                .devserver_watcher_views
                .lock()
                .unwrap()
                .get(&devserver_id)
                .cloned()
            {
                // The watcher view closes the surface on any reconcile that
                // races the direct destroy. The process-wide pending state is
                // the durable suppression across watcher replacement.
                view.bury(&label);
            }
            if let Some(conn) = state.devservers.get(&devserver_id) {
                if let Some(attempt) = state.pending_window_deletes.begin(&label) {
                    spawn_pending_window_delete_attempt(
                        app.clone(),
                        Arc::clone(&state),
                        conn,
                        attempt,
                    );
                }
            }
        } else {
            tracing::warn!(window = %label, "closed devserver window is absent from the feed");
        }
        return window.destroy().map_err(err);
    }
    // `destroy()`, not `close()`: this is the SPA's DELIBERATE close-cascade
    // (last tab, then last pane, just closed -- the window is empty). `close()`
    // would fire `CloseRequested`, where the close-on-red-dot handler prompts
    // instead of closing SPA windows; an empty window is worthless buried.
    // Destroy skips the request phase and goes straight to `Destroyed` cleanup.
    window.destroy().map_err(err)
}

/// SPA callback for the close-confirm overlay's HIDE choice: bury THIS window
/// (hide it, keep its sessions warm and its record reopenable) instead of
/// destroying it. The red-dot `CloseRequested` handler already `prevent_close`d
/// and evaled `app.window.confirmClose` into the webview; this is the "Hide"
/// answer. Mirrors the launcher Hide action, minus the (now removed) teaching
/// notice. "Close" is the sibling answer and rides `request_close_window`
/// (discard + destroy).
#[tauri::command]
fn hide_window_from_close_confirm(app: tauri::AppHandle, window: tauri::WebviewWindow) {
    let state = app.state::<Arc<AppState>>();
    let label = window.label().to_string();
    serve::bury_window_now(&app, &state, &label);
}

/// Abandon the devserver backing a workspace window (the disconnect overlay's
/// Abandon button). A devserver window's label is `<library_id>::<window_id>`;
/// resolve it through the same cached label lookup Reconnect uses, then reveal
/// the launcher (it hides, not destroys) and tear the devserver down directly
/// in Rust. Kill-then-act: the teardown's control-terminal reap kills a
/// still-running connect script synchronously before the connection state and
/// workspace windows drop with it. The `devserver-abandon` event still fires so
/// the launcher refreshes its row. Inert on a local window, or when no
/// devserver matches the library.
#[tauri::command]
async fn abandon_devserver_for_window(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    let devserver_id = devserver_id_for_window_label(&state.devserver_feed, window.label());
    if let Some(id) = devserver_id {
        let _ = show_window(&app, "main");
        // Tear down directly in Rust so Abandon works even when the launcher is
        // not listening for the event. The teardown covers every control-run
        // state: reaping the control terminal kills a still-running connect
        // script, and is a no-op on an exited or absent one.
        teardown_devserver_connection(&app, &state, &id).await;
        let _ = app.emit("devserver-abandon", id);
    }
    Ok(())
}

/// Reconnect the devserver backing a workspace window (the disconnect overlay's
/// Reconnect button, desktop-only). Kill-then-act: resolve the owning devserver
/// from the window's `<library_id>::<window_id>` label through the cached
/// lookup, run the disconnect flow (the teardown's control-terminal reap kills
/// a still-running connect script and clears the reconnect block), then run the
/// connect flow, which re-runs the connect script. Tearing down first is what
/// lets Reconnect act on a connection in ANY state: connect's `is_connected`
/// guard would no-op a live-but-unreachable one. A connect already in flight is
/// left alone, so a second Reconnect racing the first cannot tear down the
/// attempt the first one just started. Inert on a local window or when no
/// devserver matches the library.
#[tauri::command]
async fn reconnect_devserver_for_window(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    let devserver_id = devserver_id_for_window_label(&state.devserver_feed, window.label());
    if let Some(id) = devserver_id {
        let state_arc = Arc::clone(state.inner());
        if state_arc.devserver_connecting.lock().unwrap().contains(&id) {
            return Ok(());
        }
        teardown_devserver_connection(&app, &state_arc, &id).await;
        connect_devserver_impl(app.clone(), state_arc, id).await?;
    }
    Ok(())
}

/// The one library a window is allowed to act on: its own. A watcher-managed
/// window's label is `{library_id}::{window_id}`. Every other label names no
/// library, so the commands below refuse instead of guessing one.
///
/// Deriving this from the caller's own label rather than an argument is what
/// keeps "may cause a native window to open" inside the Tauri capability
/// system: the ACL already binds which windows on which origin may invoke at
/// all, and the label then fixes which library they reach.
fn library_id_for_window_label(label: &str) -> Option<&str> {
    if let Some((library_id, _)) = label.split_once("::") {
        return (library_id == "local" || library_id.starts_with("lib-")).then_some(library_id);
    }
    None
}

/// Resolve the local library's opaque workspace id to its root path. The id is
/// the workspace's slug prefix, so recomputing that prefix per registered root
/// maps it back through the same function the library used to publish it. The
/// workspace's CURRENTLY MOUNTED prefix is not the same string on chan-desktop
/// (it mounts local workspaces at `workspace-<hash>`), so this cannot go
/// through `mounted_prefix_for_root`.
fn local_workspace_path(
    embedded: &embedded::EmbeddedServer,
    workspace_id: Option<String>,
) -> Result<String, String> {
    let workspace_id =
        workspace_id.ok_or_else(|| "a workspace window needs a workspace id".to_string())?;
    let wanted = workspace_id.trim_start_matches('/');
    embedded
        .library()
        .list_workspaces()
        .into_iter()
        .map(|workspace| workspace.root_path)
        .find(|root| {
            chan_server::allocate_workspace_prefix(root)
                .ok()
                .as_deref()
                .map(|prefix| prefix.trim_start_matches('/'))
                == Some(wanted)
        })
        .map(|root| root.to_string_lossy().into_owned())
        .ok_or_else(|| format!("no workspace {wanted} in this library"))
}

/// Resolve a devserver library's opaque workspace id to the root path that
/// library reports for it. The id is the workspace's slug prefix, so the
/// mapping belongs to the library that owns it; asking the devserver is what
/// lets the command take an id instead of a filesystem path from the page.
async fn devserver_workspace_path(
    conn: &devserver::DevserverConn,
    workspace_id: Option<String>,
) -> Result<String, String> {
    let workspace_id =
        workspace_id.ok_or_else(|| "a workspace window needs a workspace id".to_string())?;
    let wanted = workspace_id.trim_start_matches('/');
    devserver::fetch_workspaces(conn)
        .await?
        .into_iter()
        .find(|row| row.prefix.trim_start_matches('/') == wanted)
        .map(|row| row.path)
        .ok_or_else(|| format!("no workspace {wanted} on this devserver"))
}

/// Create a window in the invoking window's library, natively.
///
/// The command deck's browser flow cannot run in chan-desktop. `window.open`
/// returns null in every chan webview, and the scoped HTTP action mints a
/// `WindowOrigin::Browser` record, which the window watcher refuses to open as
/// a native twin, so skipping the popup alone would leave records with no
/// window behind them. The desktop mints with a native origin instead and the
/// watcher reconciles the record into a real OS window, which is the same path
/// every other devserver-driven window already takes.
#[tauri::command]
async fn create_library_window(
    state: State<'_, Arc<AppState>>,
    window: tauri::WebviewWindow,
    kind: chan_server::WindowKind,
    workspace_id: Option<String>,
) -> Result<(), String> {
    let label = window.label().to_string();
    let library_id = library_id_for_window_label(&label)
        .ok_or_else(|| format!("window {label} does not belong to a chan library"))?
        .to_string();
    if library_id == "local" {
        let embedded = state
            .embedded()
            .ok_or_else(|| "the local library is not running".to_string())?;
        let workspace_path = match kind {
            chan_server::WindowKind::Terminal => None,
            chan_server::WindowKind::Workspace => {
                Some(local_workspace_path(embedded, workspace_id)?)
            }
        };
        return embedded.mint_window(kind, workspace_path).map(|_| ());
    }
    let devserver_id = state
        .devserver_feed
        .devserver_id_for_library(&library_id)
        .ok_or_else(|| format!("no devserver is connected for library {library_id}"))?;
    // Clone the connection out of the registry before the first await so no
    // registry guard is held across it.
    let conn = state
        .devservers
        .get(&devserver_id)
        .ok_or_else(|| format!("devserver {devserver_id} is not connected"))?;
    let workspace_path = match kind {
        chan_server::WindowKind::Terminal => None,
        chan_server::WindowKind::Workspace => {
            Some(devserver_workspace_path(&conn, workspace_id).await?)
        }
    };
    devserver::mint_library_window(&conn, kind, workspace_path)
        .await
        .map(|_| ())
}

/// Raise a window of the invoking window's library to the front, un-hiding it
/// first if it was hidden.
///
/// The browser path holds a popup handle and focuses it; chan-desktop has none.
/// [`unbury_window`] is the same raise the launcher's `/open` route drives, and
/// it persists `hidden = false` to the owning registry on the way, so this is
/// one authority rather than a native raise layered over a separate HTTP
/// unhide that could disagree with it.
///
/// The `::` guard is load-bearing, not defensive noise: the native label is
/// `{library_id}::{window_id}`, so a window id carrying `::` would name a
/// window in a different library and defeat the label scoping above.
#[tauri::command]
fn focus_library_window(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    window_id: String,
) -> Result<(), String> {
    let label = window.label().to_string();
    let library_id = library_id_for_window_label(&label)
        .ok_or_else(|| format!("window {label} does not belong to a chan library"))?;
    if window_id.is_empty() || window_id.contains("::") {
        return Err(format!("invalid window id {window_id:?}"));
    }
    let target = format!("{library_id}::{window_id}");
    if unbury_window(&app, &target) {
        Ok(())
    } else {
        Err(format!("window {window_id} is no longer open"))
    }
}

/// What [`native_vocabulary`] answers: the app command vocabulary this build
/// grants to gateway-served `lib-*` windows, with the build identity. Field
/// names are the page-side contract.
#[derive(serde::Serialize)]
struct NativeVocabulary {
    version: String,
    build: &'static str,
    commands: &'static [&'static str],
}

/// Advertise the native command vocabulary and build identity.
///
/// A gateway-served page is delivered by the remote devserver while the ACL
/// gating its invokes belongs to the locally installed app, so the page can
/// name a command this build has never heard of. This query lets the page
/// learn what is available up front and report absence as a version
/// statement, instead of discovering it through a refusal that reads as a
/// capability defect. The answer is the gateway grant's vocabulary
/// ([`runtime_capability::GATEWAY_WINDOW_COMMANDS`]), not recomputed per
/// caller; a locally served caller's grant differs at the edges but cannot
/// skew from its host, which embeds the bundle it serves.
#[tauri::command]
fn native_vocabulary(app: tauri::AppHandle) -> NativeVocabulary {
    NativeVocabulary {
        version: app.package_info().version.to_string(),
        build: CHAN_DESKTOP_BUILD_ID,
        commands: runtime_capability::GATEWAY_WINDOW_COMMANDS,
    }
}

/// Browser-style zoom controls. Step size is
/// 10 % per Cmd++/Cmd+- press; the clamp range matches Tauri's own
/// `zoom_hotkeys_enabled` polyfill semantics (0.25-5.0).
const ZOOM_STEP: f64 = 0.10;
const ZOOM_MIN: f64 = 0.25;
const ZOOM_MAX: f64 = 5.0;

/// Read the current zoom level for `label` from process state,
/// defaulting to 1.0 (chan-desktop's initial zoom). Pure read; the
/// IPC handlers compute the next level locally and write back.
fn current_zoom(state: &AppState, label: &str) -> f64 {
    state
        .live_window_zooms
        .lock()
        .unwrap()
        .get(label)
        .copied()
        .unwrap_or(1.0)
}

fn apply_zoom(window: &tauri::WebviewWindow, state: &AppState, next: f64) -> Result<(), String> {
    let clamped = next.clamp(ZOOM_MIN, ZOOM_MAX);
    window
        .set_zoom(clamped)
        .map_err(|e| format!("setting webview zoom on {}: {e}", window.label()))?;
    state
        .live_window_zooms
        .lock()
        .unwrap()
        .insert(window.label().to_string(), clamped);
    Ok(())
}

/// Zoom the calling webview one step up (Cmd++ / Ctrl++).
#[tauri::command]
fn zoom_in(window: tauri::WebviewWindow, state: State<Arc<AppState>>) -> Result<(), String> {
    let current = current_zoom(&state, window.label());
    apply_zoom(&window, &state, current + ZOOM_STEP)
}

/// Zoom the calling webview one step down (Cmd+- / Ctrl+-).
#[tauri::command]
fn zoom_out(window: tauri::WebviewWindow, state: State<Arc<AppState>>) -> Result<(), String> {
    let current = current_zoom(&state, window.label());
    apply_zoom(&window, &state, current - ZOOM_STEP)
}

/// Reset the calling webview to 100 % (Cmd+0 / Ctrl+0).
#[tauri::command]
fn zoom_reset(window: tauri::WebviewWindow, state: State<Arc<AppState>>) -> Result<(), String> {
    apply_zoom(&window, &state, 1.0)
}

/// Canonical-path key used for desktop config, serve identity, and
/// the displayed path. `canonicalize` falls back to the input on
/// error so we still produce a stable key for not-yet-existing or
/// asleep paths.
fn canonical_key(p: &Path) -> String {
    // The registry's own normalization: a Windows key never carries the
    // `\\?\` verbatim prefix into the SPA list, a window title, or a log.
    chan_workspace::paths::canonicalize_normalized(p)
        .display()
        .to_string()
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn emit_system_notice(app: &tauri::AppHandle, level: &str, message: impl Into<String>) {
    let _ = app.emit(
        SYSTEM_NOTICE,
        serde_json::json!({ "level": level, "message": message.into() }),
    );
}

fn init_tracing() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("CHAN_LOG")
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn,chan_desktop=info")),
        )
        .with_writer(std::io::stderr)
        .init();
}

/// `chan-desktop --version` prints the version and build id and EXITS instead
/// of launching the GUI.
///
/// This is the only headless reader of `CHAN_DESKTOP_BUILD_ID`. The id's other
/// consumers are a Tauri IPC command, a `tracing` line emitted once the GUI is
/// up, and the About window, so before this a packaging check with no display
/// could not ask a binary which build it was -- which is the ambiguity the id
/// exists to remove, and it left the Nix package's own id unverifiable.
/// `scripts/smoke-nix-package.sh` is the reader.
///
/// Deliberately runs AFTER the `chan` and `cs` stem probes, so a `bin/chan`
/// symlink at this binary still answers `--version` as the `chan` CLI, with the
/// `chan` crate's own id, rather than being shadowed by this.
///
/// Output matches `chan --version`'s shape so one parser reads either binary.
fn print_version_if_requested() -> bool {
    let mut args = std::env::args_os();
    let _program = args.next();
    let Some(flag) = args.next() else {
        return false;
    };
    if !matches!(flag.to_str(), Some("--version" | "-V")) {
        return false;
    }
    // A GUI-subsystem exe invoked from a terminal starts with null standard
    // handles, and `attach_parent_console_for_cli` attaches only for the
    // `chan` / `cs` stems, so without this the line below is discarded and
    // `chan-desktop.exe --version` prints nothing. Best-effort and idempotent:
    // it leaves everything alone when there is no parent console.
    #[cfg(windows)]
    win_console::attach_parent();
    println!(
        "chan-desktop {} (build {})",
        env!("CARGO_PKG_VERSION"),
        CHAN_DESKTOP_BUILD_ID
    );
    true
}

/// Cross-platform MCP-proxy short-circuit: when chan-desktop is invoked as
/// `<exe> __mcp-proxy <socket>` (the `cs` / `chan` MCP discovery hands this
/// off), bridge stdio to the chan-server MCP socket and EXIT instead of
/// launching the GUI. The transport underneath (`run_mcp_stdio_proxy`) is
/// cross-platform -- a Unix-domain socket on unix, a named pipe on Windows -- so
/// the desktop carries MCP on every platform. Returns `Ok(true)` when it
/// handled the invocation, `Ok(false)` for a normal GUI launch.
fn run_hidden_mcp_proxy_if_requested() -> Result<bool, String> {
    let mut args = std::env::args_os();
    let _program = args.next();
    if args.next().as_deref() != Some(OsStr::new("__mcp-proxy")) {
        return Ok(false);
    }
    let socket = args
        .next()
        .map(PathBuf::from)
        .ok_or_else(|| "__mcp-proxy requires a socket path".to_string())?;
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("building MCP proxy runtime: {e}"))?;
    rt.block_on(run_mcp_proxy(socket))?;
    Ok(true)
}

/// When chan-desktop is invoked through a `cs` name (a `~/.local/bin/cs`
/// wrapper or symlink, `argv[0]` stem == "cs"), behave as the `cs` control
/// client and EXIT instead of launching the GUI. This is what lets desktop
/// users get `cs` (and the MCP discovery it carries) without a separate
/// `chan` binary on PATH. Mirrors `run_hidden_mcp_proxy_if_requested`: a
/// pre-GUI argv probe that short-circuits `main`. Returns `Ok(true)` when
/// it handled the invocation (caller returns), `Ok(false)` for a normal
/// GUI launch.
fn run_as_cs_if_requested() -> Result<bool, String> {
    // Stem detection prefers `$ARGV0` (see `chan_shell::invoked_arg0`): a
    // packaged AppImage invoked via `exec -a cs "$APPIMAGE"` loses argv[0] to
    // AppRun, so keying on `args_os().next()` alone would launch the GUI
    // instead of dispatching `cs`. The args we PASS keep the real argv (clap
    // ignores the program-name slot).
    if !chan_shell::invoked_as_cs(&chan_shell::invoked_arg0()) {
        return Ok(false);
    }
    // The `cs` client is a single round-trip over the control socket, so a
    // current-thread runtime is enough (matches the `chan` binary's `cs`
    // path). clap parses + dispatches; it prints help/usage and exits on a
    // parse error, so a bad `cs` invocation never falls through to the GUI.
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("building cs runtime: {e}"))?;
    rt.block_on(chan_shell::run_cs(std::env::args_os()))
        .map_err(|e| format!("{e:#}"))?;
    Ok(true)
}

/// When chan-desktop is invoked through a `chan` name (a `~/.local/bin/chan`
/// symlink or AppImage wrapper, `argv[0]` stem == "chan"), run the whole `chan`
/// CLI in-process with the Desktop personality and EXIT instead of launching
/// the GUI. This is what makes a desktop install also provide `chan` with no
/// separate download. Mirrors `run_as_cs_if_requested`: a pre-GUI argv probe
/// that short-circuits `main`. The Desktop personality makes `chan serve`
/// integrate with the running desktop (handoff / GUI launch) and `chan
/// upgrade` drive the desktop updater rather than replacing a CLI tarball.
/// Returns `Ok(true)` when it handled the invocation, `Ok(false)` for a
/// normal GUI launch.
fn run_as_chan_if_requested() -> Result<bool, String> {
    // Stem detection prefers `$ARGV0` (see `chan_shell::invoked_arg0`) so a
    // packaged AppImage invoked via `exec -a chan "$APPIMAGE"` (AppRun drops
    // argv[0]) still dispatches the CLI instead of launching the GUI. The args
    // passed to `chan::run` keep the real argv (clap ignores arg[0]).
    if !chan_shell::invoked_as_chan(&chan_shell::invoked_arg0()) {
        return Ok(false);
    }
    // `chan serve` needs a multi-threaded runtime; everything else runs fine
    // on it too. shutdown_background() detaches chan-workspace's uncancellable
    // reindex pool on exit, matching the standalone `chan` binary's shim.
    let rt = tokio::runtime::Builder::new_multi_thread()
        // Declared rather than inherited: this runtime serves workspaces and
        // can execute transfer work, and tokio's default blocking pool is
        // large enough that bulk work would expand into the threads
        // interactive work needs.
        .max_blocking_threads(chan_server::bulk_transfer::MAX_BLOCKING_THREADS)
        .enable_all()
        .build()
        .map_err(|e| format!("building chan runtime: {e}"))?;
    let res = rt.block_on(chan::run(std::env::args_os(), chan::Personality::Desktop));
    rt.shutdown_background();
    res.map_err(|e| format!("{e:#}"))?;
    Ok(true)
}

async fn run_mcp_proxy(socket: PathBuf) -> Result<(), String> {
    chan_server::run_mcp_stdio_proxy(socket)
        .await
        .map_err(|e| format!("running MCP proxy: {e}"))
}

/// Windows console attach for the `chan` / `cs` CLI dispatch.
///
/// A release `chan-desktop.exe` is built `windows_subsystem = "windows"` (GUI
/// subsystem) so a normal double-click never flashes a console window. The cost:
/// when the SAME exe is invoked through a `chan` / `cs` shim from a terminal and
/// runs as a CLI (see `run_as_chan_if_requested` / `run_as_cs_if_requested`),
/// the process starts with NO console and its standard handles are null, so
/// every `println!` is silently discarded -- `chan --version` "returns empty".
/// Re-attaching to the parent shell's console (and binding any null std handle
/// to it) is what routes the CLI output back to the terminal.
///
/// Gated on the CLI invocation: a normal GUI launch (`argv[0]` stem
/// "chan-desktop") returns early and stays console-free.
#[cfg(windows)]
fn attach_parent_console_for_cli() {
    let arg0 = chan_shell::invoked_arg0();
    if !chan_shell::invoked_as_chan(&arg0) && !chan_shell::invoked_as_cs(&arg0) {
        return;
    }
    win_console::attach_parent();
}

/// Win32 console-attach mechanics for the `chan` / `cs` CLI dispatch, kept in
/// one place beside the dispatch probes. Raw FFI (no higher-level wrapper) like
/// `cs_install`'s `WM_SETTINGCHANGE` broadcast.
#[cfg(windows)]
mod win_console {
    use windows_sys::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::Console::{
        AttachConsole, GetStdHandle, SetStdHandle, ATTACH_PARENT_PROCESS, STD_ERROR_HANDLE,
        STD_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
    };

    /// Attach to the parent process's console and bind any unset standard handle
    /// to it so the `chan` / `cs` CLI output reaches the terminal. Best-effort:
    /// `AttachConsole` fails when there is no parent console (a GUI launch from
    /// Explorer) and we leave everything alone. An already-valid std handle (a
    /// shell redirection like `chan ... > out.txt`, or one AttachConsole itself
    /// wired up) is preserved, never clobbered.
    pub(super) fn attach_parent() {
        // SAFETY: standard Win32 console FFI. AttachConsole is guarded on its
        // own return before any handle work; each std handle is validated before
        // use; the CONOUT$/CONIN$ names are valid NUL-terminated UTF-16 buffers
        // that outlive the synchronous CreateFileW call.
        unsafe {
            if AttachConsole(ATTACH_PARENT_PROCESS) == 0 {
                return; // no parent console -- a normal GUI launch
            }
            bind(STD_OUTPUT_HANDLE, "CONOUT$", GENERIC_WRITE);
            bind(STD_ERROR_HANDLE, "CONOUT$", GENERIC_WRITE);
            bind(STD_INPUT_HANDLE, "CONIN$", GENERIC_READ);
        }
    }

    /// Bind one standard handle to the console device `dev` (`CONOUT$` /
    /// `CONIN$`) when it is currently unset (null / invalid). A valid handle -- a
    /// shell redirection, or one AttachConsole already populated -- is left
    /// untouched so redirection to a file/pipe still works. Best-effort: a
    /// CreateFileW / SetStdHandle failure is ignored (nothing more we can do).
    unsafe fn bind(std_id: STD_HANDLE, dev: &str, access: u32) {
        let cur = GetStdHandle(std_id);
        if !cur.is_null() && cur != INVALID_HANDLE_VALUE {
            return; // already wired (redirection, or AttachConsole set it)
        }
        let wide: Vec<u16> = dev.encode_utf16().chain(std::iter::once(0)).collect();
        let h = CreateFileW(
            wide.as_ptr(),
            access,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null(),
            OPEN_EXISTING,
            0,
            std::ptr::null_mut(),
        );
        if h != INVALID_HANDLE_VALUE {
            SetStdHandle(std_id, h);
        }
    }
}

/// macOS GUI launches (Finder / Dock / Spotlight) inherit a restricted launchd
/// `$PATH` that misses the user's interactive dirs (`~/.local/bin`,
/// `/opt/homebrew/bin`, and custom dirs). Resolve the login+interactive shell's
/// `$PATH` and merge it into this process's `$PATH`, so in-process checks (the
/// `cs` alias detection, which scans `$PATH`) and spawned subprocesses
/// (terminals) see binaries wherever the user actually has them -- the general
/// fix for the launchd restricted-PATH gotcha, not `cs`-specific. Best-effort:
/// any failure leaves the inherited PATH untouched.
#[cfg(target_os = "macos")]
fn fix_macos_login_path() {
    let Some(shell_path) = resolve_login_shell_path() else {
        return;
    };
    let inherited = std::env::var("PATH").unwrap_or_default();
    let merged = merge_path_dirs(&shell_path, &inherited);
    if !merged.is_empty() {
        std::env::set_var("PATH", merged);
    }
}

/// Keep the interactive shell PATH first, then any inherited (launchd) dirs not
/// already present -- deduped, order-stable, empty segments dropped.
#[cfg(target_os = "macos")]
fn merge_path_dirs(shell_path: &str, inherited: &str) -> String {
    let mut seen = std::collections::HashSet::new();
    shell_path
        .split(':')
        .chain(inherited.split(':'))
        .filter(|dir| !dir.is_empty() && seen.insert(dir.to_string()))
        .collect::<Vec<_>>()
        .join(":")
}

/// Run the user's login shell (`$SHELL`) as a login + interactive shell to
/// capture the `$PATH` it exports -- the dirs the user has on their REAL
/// interactive PATH (their profile / rc files), which the GUI launchd PATH
/// lacks. Markers delimit the value so a chatty rc (banners) can't corrupt it;
/// stdin is `/dev/null` so an interactive shell can't block on input, and
/// stderr is discarded. Bounded by a ~3s timeout so a pathological / hanging
/// rc can't block app launch (a hang is worse than the no-op fallback). `None`
/// on any failure, timeout, or empty result.
#[cfg(target_os = "macos")]
fn resolve_login_shell_path() -> Option<String> {
    use std::io::Read;
    use std::time::Duration;
    const MARK: &str = "__CHAN_PATH__";
    const TIMEOUT: Duration = Duration::from_secs(3);
    // Single-source the shell with the interactive terminal: $SHELL, then the
    // passwd entry (pw_shell), then /bin/sh -- validated. The PATH-harvest
    // fallback therefore consults the shell the user actually logs in with.
    // `cfg(target_os = "macos")` is included in `cfg(unix)`, so the unix-gated
    // symbol is in scope.
    let shell = chan_server::user_shell();
    let mut child = std::process::Command::new(shell)
        .args([
            "-l",
            "-i",
            "-c",
            &format!("printf '{MARK}%s{MARK}' \"$PATH\""),
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    // Poll for exit with a timeout; on timeout kill the shell and fall back to
    // the inherited PATH. (stdin=/dev/null already stops the common read-hang;
    // this is belt-and-suspenders for a broken rc.)
    if !wait_for_child(&mut child, TIMEOUT) {
        return None;
    }
    // The output is tiny (a PATH between markers), so the pipe never fills and
    // the child exits before this read.
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    let begin = out.find(MARK)? + MARK.len();
    let end = out[begin..].find(MARK)? + begin;
    let path = &out[begin..end];
    (!path.is_empty()).then(|| path.to_string())
}

/// Wait for `child` to exit within `timeout`. Returns `true` if it exited on
/// its own; on timeout, kill + reap it and return `false`. Polls rather than
/// blocking so a broken interactive rc can't hang app launch. Extracted from
/// `resolve_login_shell_path` so the timeout/kill branch is unit-testable
/// without a real login shell.
// Compiled only on macOS: the Linux gate (fmt/clippy/test) never builds this
// block, so changes here need a macOS build to validate.
#[cfg(target_os = "macos")]
fn wait_for_child(child: &mut std::process::Child, timeout: std::time::Duration) -> bool {
    use std::time::{Duration, Instant};
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) if started.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => return false,
        }
    }
}

/// The generated tauri context: config, assets, icons, and the ACL manifests
/// from tauri.conf.json and capabilities/. This must stay the crate's ONLY
/// `generate_context!` expansion: on macOS each expansion embeds a
/// `#[no_mangle] _EMBED_INFO_PLIST` static, so a second expansion anywhere in
/// the crate (e.g. a test building from the real context) is a
/// duplicate-symbol compile error in the test binary - and invisible on
/// Linux, where the macro embeds nothing. Generic over the runtime; a static
/// inside a generic fn is emitted exactly once, so the Wry and MockRuntime
/// instantiations share the one symbol.
fn app_context<R: tauri::Runtime>() -> tauri::Context<R> {
    tauri::generate_context!()
}

fn main() {
    // Windows: a release chan-desktop.exe is GUI-subsystem (no console). When
    // invoked as the `chan` / `cs` CLI through a shim, reattach to the parent
    // shell's console FIRST so the CLI's stdout/stderr reach the terminal
    // instead of vanishing. No-op for a GUI launch and off Windows.
    #[cfg(windows)]
    attach_parent_console_for_cli();

    // Linux AppImage: the inner AppRun chdir'd this process into the mounted
    // AppDir's usr/. Move back to the directory the wrapper shim recorded
    // BEFORE any dispatch, so `chan serve .` / `cs upload .` resolve against
    // the invoking shell's directory instead of the ephemeral mount. No-op
    // off AppImage or when launched without a shim.
    #[cfg(unix)]
    cs_install::restore_caller_cwd();

    match run_hidden_mcp_proxy_if_requested() {
        Ok(true) => return,
        Ok(false) => {}
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    }
    // `cs` alias dispatch (argv[0] stem == "cs"): run the control client
    // and exit, before any GUI / runtime / config setup below.
    match run_as_cs_if_requested() {
        Ok(true) => return,
        Ok(false) => {}
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    }
    // `chan` alias dispatch (argv[0] stem == "chan"): run the whole chan CLI
    // in-process with the Desktop personality and exit, before any GUI /
    // runtime / config setup below. Same pre-GUI argv probe as `cs`.
    match run_as_chan_if_requested() {
        Ok(true) => return,
        Ok(false) => {}
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    }
    // `chan-desktop --version`: print the version and build id and exit. Last
    // of the pre-GUI probes so it cannot shadow `chan --version` reaching the
    // chan CLI above through a `bin/chan` symlink.
    if print_version_if_requested() {
        return;
    }
    // Linux AppImage only: prefer the host GTK/WebKit/EGL stack over the
    // bundled one and re-exec once before the webview is created, so it does
    // not abort with EGL_BAD_PARAMETER against a rolling-distro Mesa. No-op
    // off Linux/AppImage and once already applied.
    linux_gui_stack::prefer_system_gui_stack();
    init_tracing();
    // The version alone cannot distinguish a branch build from the previous
    // release; the build id can, and this line is where a terminal launch
    // shows it.
    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        build = CHAN_DESKTOP_BUILD_ID,
        "chan-desktop starting"
    );
    // Best-effort on boot: own `~/.local/bin/{chan,cs}` so a desktop install
    // also provides the `chan` + `cs` CLI without a separate download. Real
    // symlinks / AppImage wrappers / deb-rpm symlinks per package kind,
    // idempotent + marker-guarded + never clobbers a user-written shim. No-op
    // for a dev build / unrecognized layout; never fatal to boot.
    match cs_install::install_bin_shims() {
        Ok(0) => {}
        // Log the dir we ACTUALLY wrote to (CHAN_HOME-aware), not a hardcoded
        // `~/.local/bin` -- the literal misled a `CHAN_HOME` smoke run. Off unix the
        // dir is omitted rather than named wrong.
        Ok(n) => match cs_install::shim_install_dir() {
            Some(dir) => {
                tracing::info!(shims = n, dir = %dir.display(), "installed chan/cs bin shims")
            }
            None => tracing::info!(shims = n, "installed chan/cs bin shims"),
        },
        Err(e) => tracing::warn!(error = %e, "installing bin shims failed"),
    }
    let store = Arc::new(Mutex::new(
        ConfigStore::new().expect("failed to init config store"),
    ));
    // One-shot: devserver rows recorded by the retired pick-one gateway flow
    // become gateway entries, before any registry or connection reads the
    // config. A failure leaves the file untouched; the next startup retries.
    let migration_outcome = match config::migrate_legacy_gateway_rows(&store) {
        Ok(m) if m.changed() => {
            tracing::info!(
                gateways = m.created.len(),
                rows = m.converted_rows,
                "migrated legacy gateway devserver rows"
            );
            Some(m)
        }
        Ok(_) => None,
        Err(e) => {
            tracing::warn!(error = %e, "legacy gateway row migration failed");
            None
        }
    };
    let state = Arc::new(AppState::with_store(store));
    *state.gateway_migration.lock().unwrap() = migration_outcome;
    let state_for_exit = Arc::clone(&state);
    let state_for_setup = Arc::clone(&state);
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(state)
        // The migration summary waits for the FIRST launcher page load: a
        // notice emitted at startup would fire before the SPA subscribes,
        // and the launcher-notice event has no replay.
        .on_page_load(|webview, payload| {
            if webview.label() != "main"
                || !matches!(payload.event(), tauri::webview::PageLoadEvent::Finished)
            {
                return;
            }
            let state = Arc::clone(&webview.state::<Arc<AppState>>());
            narrate_parked_migration(&webview.app_handle().clone(), &state);
        })
        .setup(move |app| {
            install_app_menu(app.handle())?;

            tauri::async_runtime::spawn_blocking(|| {
                let Some(dir) = download::downloads_dir() else {
                    tracing::warn!("could not resolve Downloads directory for orphan reaping");
                    return;
                };
                let reaped = download::reap_orphaned_download_temps(
                    &dir,
                    std::time::SystemTime::now(),
                    std::time::Duration::from_secs(60 * 60),
                );
                tracing::debug!(
                    directory = %dir.display(),
                    reaped,
                    "reaped orphaned generated download temps"
                );
            });

            // Fix the restricted launchd `$PATH` of a macOS GUI launch BEFORE
            // the embedded server starts, so its in-process `cs` detection (and
            // the terminals it spawns) scan the user's real interactive PATH.
            #[cfg(target_os = "macos")]
            fix_macos_login_path();

            // Share the desktop's config handle + devserver-remove hook cell with
            // the embedded host so the launcher's devserver registry persists
            // through the same lock and its HTTP DELETE can reap a live connection.
            let config_store = Arc::clone(&state_for_setup.store);
            let registry_deps = embedded::RegistryDeps {
                config_store,
                devserver_remove_hook: Arc::clone(&state_for_setup.devserver_remove_hook),
                gateway_remove_hook: Arc::clone(&state_for_setup.gateway_remove_hook),
                gateway_manager: Arc::clone(&state_for_setup.gateway_manager),
                devserver_conns: Arc::clone(&state_for_setup.devservers),
                devserver_connecting: Arc::clone(&state_for_setup.devserver_connecting),
                devserver_feed: Arc::clone(&state_for_setup.devserver_feed),
            };
            match tauri::async_runtime::block_on(embedded::EmbeddedServer::start(registry_deps)) {
                Ok(server) => {
                    if state_for_setup.embedded.set(server).is_err() {
                        tracing::warn!("embedded local server initialized more than once");
                    }
                    // Install the connected-devserver feed source so the
                    // launcher merges remote windows + workspaces. Done after the
                    // host is up; connections (which populate it) only start later.
                    if let Some(embedded) = state_for_setup.embedded.get() {
                        // Clone the concrete Arc; the call coerces it to
                        // `Arc<dyn DevserverFeedSource>` (unsizing at the arg).
                        let feed = Arc::clone(&state_for_setup.devserver_feed);
                        embedded.install_devserver_feed(feed);
                    }
                    // Fill the registry's remove hook now that the AppHandle
                    // exists: the launcher's HTTP DELETE then reaps a live
                    // devserver's connection/windows via teardown_devserver_connection.
                    // The closure holds only the AppHandle (no Arc cycle) and
                    // resolves the AppState from it at call time.
                    let app_for_teardown = app.handle().clone();
                    let _ = state_for_setup.devserver_remove_hook.set(Arc::new(
                        move |id: &str| {
                            let app = app_for_teardown.clone();
                            let id = id.to_string();
                            tauri::async_runtime::spawn(async move {
                                let state = Arc::clone(&app.state::<Arc<AppState>>());
                                teardown_devserver_connection(&app, &state, &id).await;
                            })
                        },
                    ));
                    // The roster poll's node-move handling fires this after
                    // tearing the old managed connection down: the row
                    // re-enters the normal connect flow, which runs a fresh
                    // authenticated entry and pins the new node origin.
                    let app_for_reconnect = app.handle().clone();
                    let _ = state_for_setup
                        .devserver_reconnect_hook
                        .set(Arc::new(move |id: &str| {
                            let app = app_for_reconnect.clone();
                            let id = id.to_string();
                            tauri::async_runtime::spawn(async move {
                                let state = Arc::clone(&app.state::<Arc<AppState>>());
                                if let Err(e) =
                                    connect_devserver_impl(app, state, id.clone()).await
                                {
                                    tracing::warn!(devserver = %id, error = %e, "reconnect after a proxy node move failed");
                                }
                            });
                        }));
                    // The gateway analogue: the launcher's HTTP DELETE runs
                    // the full cascade (poll stop, rostered-connection
                    // teardown, roster drop). The registry's remove already
                    // dropped the config row, so the cascade only reaps
                    // runtime state.
                    let app_for_gw_remove = app.handle().clone();
                    let _ = state_for_setup.gateway_remove_hook.set(Arc::new(
                        move |id: &str| {
                            let app = app_for_gw_remove.clone();
                            let id = id.to_string();
                            tauri::async_runtime::spawn(async move {
                                let state = Arc::clone(&app.state::<Arc<AppState>>());
                                gateway::cascade_disconnect(
                                    &app,
                                    &state,
                                    &id,
                                    gateway::CascadeReason::Removed,
                                )
                                .await;
                            });
                        },
                    ));
                    // Reconnect enabled gateways from the last run. Never
                    // opens a browser: PAT-less rows park as sign-in
                    // required until the user clicks Connect.
                    gateway::autoconnect_enabled_gateways(
                        app.handle(),
                        &state_for_setup,
                    );
                    // Spawn the `cs window <op>` consumer now that the
                    // AppHandle exists: it owns the bridge receiver and
                    // turns lifecycle requests into Tauri window actions.
                    // The task lives until the channel closes at exit.
                    if let Some(rx) = state_for_setup
                        .embedded
                        .get()
                        .and_then(|e| e.take_window_ops_rx())
                    {
                        let app_for_ops = app.handle().clone();
                        let state_for_ops = Arc::clone(&state_for_setup);
                        tauri::async_runtime::spawn(window_ops::run(
                            app_for_ops,
                            state_for_ops,
                            rx,
                        ));
                    }
                    // Spawn the local window watcher: native windows become a
                    // pure idempotent reconcile of the local library's window
                    // set, so reconnect / relaunch can never spawn a
                    // duplicate. Inert until a local window is minted (an empty
                    // registry reconciles to nothing); converting the creation
                    // paths to mint makes it the sole driver.
                    window_watcher_wiring::spawn_local_window_watcher(
                        app.handle().clone(),
                        Arc::clone(&state_for_setup),
                    );
                }
                Err(e) => {
                    tracing::warn!(error = %e, "embedded local server disabled");
                }
            }

            // The loopback sign-in callback lands in THIS process on the
            // ephemeral `http://127.0.0.1:<port>/auth/callback` listener
            // that `auth::open_gateway_signin` binds per attempt (see
            // src/auth.rs). There is no OS scheme handler
            // and no second-instance spawn, so the callback needs no setup
            // wiring here.

            // The launcher window loads the embedded loopback's root `/`, where
            // the same web-launcher SPA is served as on every other surface
            // (replacing the former native `main.js` launcher). Its `?t=` token
            // authorizes the launcher's `/api/library/*` calls. Built here rather
            // than declared statically because the loopback address is dynamic and
            // is only known after the embedded server starts above.
            //
            // Closing it via the red traffic light or Cmd+W hides, not destroys:
            // hidden serve children keep the process alive, and reopening via Dock
            // click or the Window > Computers menu item is instant.
            if let Some(embedded) = state_for_setup.embedded.get() {
                let launcher_url =
                    format!("http://{}/?t={}", embedded.addr(), embedded.launcher_token());
                match launcher_url.parse::<tauri::Url>() {
                    Ok(url) => {
                        // Restore the launcher's last size + position (per-monitor),
                        // the same path workspace windows use: resolve a plan, build
                        // hidden when we'll reposition, then apply + reveal post-build
                        // so it never flashes at the default first.
                        let geometry_plan = serve::resolve_geometry_plan(app.handle(), "main");
                        let restored = geometry_plan.builds_hidden();
                        let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                            .title(LAUNCHER_WINDOW_TITLE)
                            // The launcher is remote-served and skips KEY_BRIDGE_JS;
                            // inject the minimal reload-only chord so Cmd+R / Ctrl+R
                            // reloads it.
                            .initialization_script(LAUNCHER_RELOAD_BRIDGE_JS)
                            // Compact default; persisted geometry above overrides
                            // it once the user resizes/moves the window.
                            .inner_size(LAUNCHER_DEFAULT_WIDTH, LAUNCHER_DEFAULT_HEIGHT)
                            .min_inner_size(LAUNCHER_MIN_WIDTH, LAUNCHER_MIN_HEIGHT)
                            .resizable(true);
                        let builder = if restored {
                            builder.visible(false)
                        } else {
                            builder
                        };
                        match builder.build() {
                            Ok(main) => {
                                // Off-mac the launcher is the ONLY window
                                // with a menubar, attached per-window (no
                                // app-wide default exists for it to
                                // inherit): every other window is born
                                // menu-less and gets its chords from
                                // KEY_BRIDGE_JS. The bar could not be
                                // attached in `install_app_menu` -- this
                                // window did not exist yet. Best-effort: a
                                // failure leaves the launcher bar-less,
                                // like every other window.
                                #[cfg(not(target_os = "macos"))]
                                {
                                    match build_launcher_menu(app.handle()) {
                                        Ok(menu) => {
                                            if let Err(e) = main.set_menu(menu) {
                                                tracing::warn!(error = %e, "attaching the launcher menu failed");
                                            }
                                        }
                                        Err(e) => {
                                            tracing::warn!(error = %e, "building the launcher menu failed")
                                        }
                                    }
                                }
                                let main_for_event = main.clone();
                                let app_for_close = app.handle().clone();
                                main.on_window_event(move |event| {
                                    if let WindowEvent::CloseRequested { api, .. } = event {
                                        api.prevent_close();
                                        // Persist size + position before hiding so the
                                        // next reopen restores them.
                                        serve::capture_window_geometry(&app_for_close, "main");
                                        let _ = main_for_event.hide();
                                    }
                                });
                                // Reveals the window on a `Restore` plan; a `Default`
                                // plan is a no-op, so show + focus it explicitly.
                                serve::apply_geometry_plan(&main, "main", geometry_plan);
                                if !restored {
                                    let _ = main.show();
                                    let _ = main.set_focus();
                                }
                            }
                            Err(e) => {
                                tracing::warn!(error = %e, "building the launcher window failed")
                            }
                        }
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, url = %launcher_url, "bad launcher window URL")
                    }
                }
            }

            // Registry watcher. Leaked: we want it alive for the
            // process lifetime and the inner Watcher type is
            // unnameable through `manage`.
            match watcher::spawn(app.handle().clone(), &registry::path()) {
                Ok(d) => {
                    Box::leak(Box::new(d));
                }
                Err(e) => {
                    tracing::warn!(error = %e, "registry watcher disabled");
                    emit_system_notice(
                        app.handle(),
                        "warning",
                        "Auto-refresh disabled; close and reopen the window after running chan workspace add.",
                    );
                }
            }

            // CLI-to-desktop handoff listener (ratified Option B). Binds the
            // well-known per-user endpoint (a UDS on unix, a named pipe on
            // Windows) so a `chan serve <workspace>` in a terminal hands the
            // workspace to this desktop window instead of failing on the
            // per-workspace flock. Leaked for the process lifetime (the registry
            // watcher above uses the same Box::leak pattern; the handle's Drop
            // tears down the listener, but we want it live until exit, and
            // RunEvent::Exit tears the process down anyway). A bind failure is
            // non-fatal: the CLI just falls back to its own server.
            // `ensure_well_known_socket_path` (bind-side) creates the
            // owner-only socket directory on the no-XDG arm, or refuses a
            // squatted one; clients validate the same directory without
            // creating it.
            #[cfg(any(unix, windows))]
            if let Some(sock) = chan_server::handoff::ensure_well_known_socket_path() {
                let app_for_handoff = app.handle().clone();
                let state_for_handoff = Arc::clone(&state_for_setup);
                // `start_listener` binds a tokio listener (UnixListener /
                // named-pipe server) and `tokio::spawn`s the accept loop, so it
                // MUST run inside a tokio runtime context. The Tauri `setup` runs
                // on the main thread OUTSIDE any runtime, so calling it
                // directly panics ("there is no reactor running"), which
                // aborts the whole desktop on launch. Enter the Tauri-
                // managed runtime via `block_on` (the same runtime the
                // embedded server above and every `async_runtime::spawn`
                // below use) so the bind + the spawned accept loop attach
                // to it and survive after this returns.
                let listener = tauri::async_runtime::block_on(async {
                    chan_server::handoff::start_listener(sock, move |req| {
                        let app = app_for_handoff.clone();
                        let state = Arc::clone(&state_for_handoff);
                        async move {
                            use chan_server::handoff::{Capabilities, Request, Response, CHAN_VERSION};
                            match req {
                                Request::OpenWorkspace { workspace_path, .. } => {
                                    match open_workspace_from_handoff(
                                        app,
                                        state,
                                        PathBuf::from(workspace_path),
                                    ) {
                                        Ok(()) => Response::Opened {
                                            desktop_version: CHAN_VERSION.into(),
                                            capabilities: Capabilities {
                                                open_local_workspace: true,
                                            },
                                        },
                                        Err(message) => Response::Error { message },
                                    }
                                }
                                Request::Upgrade { check_only, .. } => {
                                    desktop_handle_upgrade(app, check_only).await
                                }
                                Request::OpenDevserver {
                                    url, name, script, ..
                                } => match register_devserver_from_handoff(
                                    &app, &state, url, name, script,
                                ) {
                                    Ok(()) => {
                                        let _ = app.emit(serve::SERVES_CHANGED, ());
                                        Response::DevserverRegistered {
                                            desktop_version: CHAN_VERSION.into(),
                                        }
                                    }
                                    Err(message) => Response::Error { message },
                                },
                                Request::CloseWorkspace {
                                    workspace_path,
                                    remove,
                                    ..
                                } => match close_workspace_from_handoff(
                                    app,
                                    state,
                                    PathBuf::from(workspace_path),
                                    remove,
                                )
                                .await
                                {
                                    Ok(
                                        chan_server::WorkspaceLifecycleOutcome::Completed
                                        | chan_server::WorkspaceLifecycleOutcome::NotFound,
                                    ) => Response::Closed {
                                        desktop_version: CHAN_VERSION.into(),
                                    },
                                    Ok(chan_server::WorkspaceLifecycleOutcome::Refused {
                                        active_terminals,
                                    }) => Response::CloseRefused {
                                        error: "live_terminals".into(),
                                        active_terminals,
                                    },
                                    Err(message) => Response::Error { message },
                                },
                                Request::ListDevservers { .. } => Response::Devservers {
                                    desktop_version: CHAN_VERSION.into(),
                                    devservers: list_devservers_from_handoff(&state),
                                },
                                Request::ConnectDevserver { target, .. } => {
                                    match resolve_devserver_target(&state, &target) {
                                        // Fire-and-return, like Upgrade: the dial can
                                        // spend seconds in the control script and token
                                        // scrape, while the handoff client reads one
                                        // line on a short timeout. The launcher owns
                                        // the progress and any sign-in / trust prompt.
                                        Ok(id) => {
                                            let app = app.clone();
                                            let state = Arc::clone(&state);
                                            tauri::async_runtime::spawn(async move {
                                                if let Err(e) =
                                                    connect_devserver_impl(app, state, id).await
                                                {
                                                    tracing::warn!(
                                                        error = %e,
                                                        "handoff devserver connect failed"
                                                    );
                                                }
                                            });
                                            Response::DevserverConnectStarted {
                                                desktop_version: CHAN_VERSION.into(),
                                            }
                                        }
                                        Err(message) => Response::Error { message },
                                    }
                                }
                                Request::DisconnectDevserver { target, .. } => {
                                    match resolve_devserver_target(&state, &target) {
                                        Ok(id) => {
                                            teardown_devserver_connection(&app, &state, &id)
                                                .await;
                                            Response::DevserverDisconnected {
                                                desktop_version: CHAN_VERSION.into(),
                                            }
                                        }
                                        Err(message) => Response::Error { message },
                                    }
                                }
                                Request::ForgetDevserver { target, force, .. } => {
                                    match forget_devserver_from_handoff(&state, &target, force) {
                                        Ok(()) => Response::DevserverForgotten {
                                            desktop_version: CHAN_VERSION.into(),
                                        },
                                        Err(message) => Response::Error { message },
                                    }
                                }
                                Request::ServeRemoteWorkspace {
                                    target,
                                    workspace_path,
                                    ..
                                } => match serve_remote_workspace_from_handoff(
                                    &state,
                                    &target,
                                    &workspace_path,
                                )
                                .await
                                {
                                    Ok(prefix) => Response::RemoteWorkspaceServed {
                                        desktop_version: CHAN_VERSION.into(),
                                        prefix,
                                    },
                                    Err(message) => Response::Error { message },
                                },
                                Request::CloseRemoteWorkspace {
                                    target,
                                    workspace_path,
                                    ..
                                } => match close_remote_workspace_from_handoff(
                                    &state,
                                    &target,
                                    &workspace_path,
                                    false,
                                )
                                .await
                                {
                                    Ok((chan_server::SetWorkspaceOnOutcome::Done, was_served)) => {
                                        Response::RemoteWorkspaceClosed {
                                            desktop_version: CHAN_VERSION.into(),
                                            was_served,
                                        }
                                    }
                                    Ok((
                                        chan_server::SetWorkspaceOnOutcome::NeedsForce {
                                            active_terminals,
                                        },
                                        _,
                                    )) => Response::CloseRefused {
                                        error: "live_terminals".into(),
                                        active_terminals,
                                    },
                                    Err(message) => Response::Error { message },
                                },
                                Request::ForgetRemoteWorkspace {
                                    target,
                                    workspace_path,
                                    ..
                                } => match close_remote_workspace_from_handoff(
                                    &state,
                                    &target,
                                    &workspace_path,
                                    true,
                                )
                                .await
                                {
                                    Ok((chan_server::SetWorkspaceOnOutcome::Done, _)) => {
                                        Response::RemoteWorkspaceForgotten {
                                            desktop_version: CHAN_VERSION.into(),
                                        }
                                    }
                                    Ok((
                                        chan_server::SetWorkspaceOnOutcome::NeedsForce {
                                            active_terminals,
                                        },
                                        _,
                                    )) => Response::CloseRefused {
                                        error: "live_terminals".into(),
                                        active_terminals,
                                    },
                                    Err(message) => Response::Error { message },
                                },
                            }
                        }
                    })
                });
                match listener {
                    Ok(handle) => {
                        Box::leak(Box::new(handle));
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "CLI-to-desktop handoff listener disabled");
                    }
                }
            }

            // Boot matrix. Every window is a library registry row, so boot is
            // uniform: mount the shared terminal tenant (so persisted terminal
            // windows resolve a live prefix/token and the watcher reopens them),
            // re-serve the workspaces the user left on (each mount lets the watcher
            // reopen that workspace's persisted windows at their stable window_id),
            // and let the library's first-open rule mint one boot terminal only on
            // a truly fresh library (empty registry, marker unset).
            let handle = app.handle().clone();
            let state_for_restore = Arc::clone(&state_for_setup);
            tauri::async_runtime::spawn(async move {
                // Mount the shared terminal tenant FIRST so persisted terminal
                // windows resolve and the watcher reopens them on relaunch.
                if let Some(embedded) = state_for_restore.embedded() {
                    if let Err(e) = embedded.open_terminal().await {
                        tracing::warn!(error = %e, "mounting the shared terminal tenant on boot failed");
                    }
                }
                // Re-serve each workspace that was on at the last clean shutdown,
                // read from the library-owned workspace overlay. Serial so
                // concurrent opens can't race the shared embedded host; on a
                // failure surface a notice and leave it off (the key drops out of
                // the overlay on the next clean shutdown).
                let enabled: Vec<String> = state_for_restore
                    .embedded()
                    .and_then(|embedded| embedded.workspace_overlay())
                    .map(|overlay| overlay.on_paths())
                    .unwrap_or_default();
                tracing::info!(
                    restoring = enabled.len(),
                    paths = ?enabled,
                    "restoring the on workspaces from the overlay"
                );
                for key in enabled {
                    // Boot restores persisted windows only. A workspace whose
                    // windows were all closed has no record, so it stays
                    // windowless. The watcher keeps hidden records hidden.
                    if let Err(e) = serve::start(
                        handle.clone(),
                        Arc::clone(&state_for_restore),
                        key.clone(),
                        serve::WorkspaceOpenMode::RestoreOnly,
                    )
                    .await
                    {
                        tracing::warn!(key = %key, error = %e, "restoring enabled workspace failed");
                        emit_system_notice(
                            &handle,
                            "warning",
                            format!("Could not re-open workspace {key}: {e}"),
                        );
                    }
                }
                // First-open rule (library-owned): the very first time this local
                // library is opened with an empty registry, mint one boot terminal
                // and persist a marker. Once set, an emptied registry never
                // re-mints -- the user who closed their only terminal reopens to
                // none. Persisted windows restore via the watcher independently.
                if let Some(embedded) = state_for_restore.embedded() {
                    if let Err(e) = embedded.ensure_first_open_terminal() {
                        tracing::warn!(error = %e, "ensuring the boot terminal failed");
                    }
                }
            });

            // On-launch self-update check: a running stale desktop updates
            // itself instead of only on a hand `chan upgrade`. Spawns its own
            // background task; honors CHAN_UPDATE_CHECK=0.
            spawn_launch_update_check(app.handle().clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            platform_os,
            read_clipboard_text,
            write_clipboard_text,
            read_clipboard_image,
            write_clipboard_image,
            read_clipboard_html,
            write_clipboard_html,
            reload_window,
            open_devtools,
            open_new_window,
            request_app_quit,
            request_close_window,
            hide_window_from_close_confirm,
            abandon_devserver_for_window,
            reconnect_devserver_for_window,
            // The command deck's library-window actions. Both resolve the
            // library from the invoking window's own label, so a window reaches
            // only its own; the ACL decides which windows may invoke at all.
            create_library_window,
            focus_library_window,
            // The vocabulary + build-identity advertisement a remotely-served
            // page queries before treating a refusal as a version statement.
            native_vocabulary,
            restart_desktop_after_update,
            download::download_file_native,
            download::begin_generated_download,
            download::append_generated_download,
            download::finish_generated_download,
            download::cancel_generated_download,
            native_transfer::native_transfer_status,
            native_transfer::cancel_native_transfer,
            // Registered on every platform; returns [] off macOS so the
            // SPA's terminal drop handler needs no platform branching.
            // ACL-scoped to locally-served windows (capabilities/
            // local-drop.json) -- the drag pasteboard is system-wide.
            dropped_paths::read_dropped_paths,
            // Native upload picker + HTTP stream. Paths and bytes stay in Rust.
            upload::upload_files_native,
            // `cs tunnel` trigger: the SPA forwards the tunnel_open
            // window_command here; the devserver to dial is resolved from the
            // invoking window's own label, never from the payload.
            revtunnel::open_reverse_tunnel,
            zoom_in,
            zoom_out,
            zoom_reset,
            probe_url,
            devserver::gateway_csrf_token,
        ])
        .build(app_context())
        .expect("error building tauri application");

    app.run(move |_app, event| {
        match event {
            // Backstop for exit paths that do not come through the
            // chan-quit menu item (which already confirmed via
            // `request_quit`). NOTE this arm alone proved insufficient
            // for Cmd+Q: the macOS PREDEFINED Quit item exits through a
            // flow `prevent_exit` cannot reliably stop, so the menu now
            // carries a custom Quit item that asks BEFORE any exit is
            // requested. Kept for the code-None flows (e.g. last window
            // destroyed) where prevention does work.
            RunEvent::ExitRequested { api, .. } => {
                use std::sync::atomic::Ordering;
                capture_launcher_geometry(_app);
                if state_for_exit.quit_confirmed.load(Ordering::SeqCst) {
                    return; // user already confirmed; let the exit run
                }
                let open = _app
                    .webview_windows()
                    .into_keys()
                    .filter(|l| serve::is_workspace_webview_label(l))
                    .count();
                if open == 0 {
                    api.prevent_exit();
                    let _ = begin_normal_shutdown(_app.clone(), ShutdownAction::Exit(0));
                    return;
                }
                api.prevent_exit();
                request_quit(_app);
            }
            RunEvent::Exit => {
                capture_launcher_geometry(_app);
                // Normal exit/restart drained asynchronously before requesting
                // this event. An external/fallback exit cannot await here, but
                // it still snapshots the live overlay; dropping the host then
                // applies the cancel+abort-before-cell-clear fallback.
                if !state_for_exit
                    .shutdown_started
                    .load(std::sync::atomic::Ordering::SeqCst)
                {
                    persist_workspaces(&state_for_exit);
                }
            }
            // macOS: Dock click or `open -a` while the process is
            // still alive. If no windows are visible (main has been
            // hidden / closed and the user has no workspace windows
            // open), bring the main window back.
            #[cfg(target_os = "macos")]
            RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } => {
                let _ = show_window(_app, "main");
            }
            _ => {}
        }
    });
}

/// Build and install the application menu.
///
/// The Window submenu carries Computers / New Window so a closed main
/// window stays reachable by name. There is no Settings menu item: the
/// Settings chord is owned by the SPA keymap so user assignments can replace
/// the built-in Comma chord. No native menu accelerator may claim Comma or the
/// keydown never reaches the webview.
///
/// macOS starts from Tauri's `Menu::default` (the system menubar already
/// carries the App menu's About / Quit): ONE global menubar serves every
/// window, so its items route by the focused window's kind. Off macOS the
/// menubar renders per window and only the LAUNCHER carries one: there is
/// deliberately no app-wide default, and the launcher bar
/// (`build_launcher_menu`) is attached per-window with `Window::set_menu`
/// when the launcher is built later in setup (it cannot be attached here
/// -- the window does not exist yet). Every other window is born
/// menu-less; its chords ride KEY_BRIDGE_JS (serve.rs).
fn install_app_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    // macOS: inject the window-nav items into the system menubar's Window
    // submenu. The App menu already owns About <app> and Quit, so File ▸
    // About / Exit are macOS-implicit.
    #[cfg(target_os = "macos")]
    let menu = {
        // Computers keeps no accelerator: Cmd+1..9 is reserved for
        // jump-to-tab in workspace windows (handled by the per-workspace key
        // bridge script in serve.rs). The menu entry still surfaces the
        // window by name.
        let workspace_manager = MenuItemBuilder::with_id("win-main", "Computers").build(app)?;
        // New Window opens another window of the FOCUSED window's
        // connection (open_new_window_for_focused_workspace): local
        // workspace or another standalone
        // terminal window; with the launcher (or nothing) focused it opens
        // a standalone terminal window -- the launcher itself is a
        // singleton and is never multiplied. Convention for future
        // chan-desktop shortcuts: declare a MenuItemBuilder here with the
        // `CmdOrCtrl+<key>` accelerator, add it to the Window submenu, and
        // add a matching `on_menu_event` branch.
        // `CmdOrCtrl+Shift+N` (not plain Cmd+N) so the
        // SPA's New Draft handler can claim Cmd+N without the menu
        // accelerator intercepting first. Menu label stays "New Window".
        let new_window = MenuItemBuilder::with_id("app-new-window", "New Window")
            .accelerator("CmdOrCtrl+Shift+N")
            .build(app)?;
        // Open the FOCUSED workspace window's contents in the system browser: mints a
        // browser-affinity record for the same workspace (chan-desktop skips it, D4)
        // so the browser tab holds its own window_id, then opens the composed URL.
        let open_in_browser =
            MenuItemBuilder::with_id("app-open-in-browser", "Open in Browser").build(app)?;
        // File ▸ New Terminal, Cmd+T. ALWAYS enabled (no dynamic
        // enable/disable: a disabled menu item still swallows the accelerator,
        // so a launcher-focused chord would dead-end). The single handler
        // routes by the FOCUSED window's kind: a launcher (main / main-*)
        // opens a new standalone terminal window; any watcher-opened SPA window
        // (`local::*` / `lib-*`) gets `app.terminal.toggle`
        // dispatched, which the SPA interprets per its mode (workspace:
        // toggle a pane terminal; terminal: add a tab).
        let new_terminal = MenuItemBuilder::with_id("app-new-terminal", "New Terminal")
            .accelerator("CmdOrCtrl+T")
            .build(app)?;
        let menu = Menu::default(app)?;
        // Strip muda's predefined "Close Window" from a submenu. We replace it
        // with our own Cmd+W-bound item (see `close_window` below) so a single
        // accelerator can route by the focused window's kind; leaving the
        // predefined one would either double-bind Cmd+W or natively close the
        // window unconditionally. Match by text since muda assigns predefined
        // items an opaque generated id.
        let strip_close = |submenu: &tauri::menu::Submenu<tauri::Wry>| {
            if let Ok(items) = submenu.items() {
                for item in items {
                    if let MenuItemKind::Predefined(p) = &item {
                        if let Ok(text) = p.text() {
                            if text.to_lowercase().contains("close") {
                                let _ = submenu.remove(&item);
                            }
                        }
                    }
                }
            }
        };
        // File ▸ Close Window. A CUSTOM item (not the predefined
        // close_window) carrying Cmd+W, routed by `handle_close_window`: a
        // focused workspace webview closes the active TAB (dispatching the same
        // `app.tab.close` the KEY_BRIDGE_JS KeyW case fires), while the launcher
        // (`main`) and other plain windows close natively. The accelerator
        // pre-empts the webview on macOS, so the KEY_BRIDGE_JS KeyW case is
        // harmlessly shadowed here (same arrangement as New Terminal's Cmd+T).
        let close_window = MenuItemBuilder::with_id("app-close-window", "Close Window")
            .accelerator("CmdOrCtrl+W")
            .build(app)?;
        // macOS `Menu::default` ALREADY ships a
        // File submenu (carrying the predefined Close Window) alongside App /
        // Edit / View / Window / Help. Reuse it rather than inserting a second
        // one (which produced a duplicate "File" menu): strip the predefined
        // Close Window, then rebuild File as New Terminal, a separator, and our
        // routed Close Window. Match the submenu by title.
        if let Some(file_submenu) = menu.items().ok().and_then(|items| {
            items.into_iter().find_map(|k| {
                k.as_submenu()
                    .filter(|sm| sm.text().ok().as_deref() == Some("File"))
                    .cloned()
            })
        }) {
            strip_close(&file_submenu);
            let sep = PredefinedMenuItem::separator(app)?;
            file_submenu.prepend_items(&[&new_terminal, &sep, &close_window])?;
        }
        if let Some(window_submenu) = menu
            .get(WINDOW_SUBMENU_ID)
            .and_then(|k| k.as_submenu().cloned())
        {
            let sep = PredefinedMenuItem::separator(app)?;
            window_submenu.prepend_items(&[
                &workspace_manager,
                &new_window,
                &open_in_browser,
                &sep,
            ])?;
            // Drop the Window submenu's own Close Window so Cmd+W is owned
            // solely by File's routed item above (no double accelerator).
            strip_close(&window_submenu);
        }
        // Redirect the system "About Chan" item to our bundled About window
        // so macOS shows the same About content as Linux/Windows (the
        // Dashboard About slide). The App menu is the first submenu in the
        // default macOS menubar: prepend a custom (non-predefined) About
        // item routed to `chan-about`, then strip the predefined system
        // About. The Predefined-only match below leaves our custom item.
        //
        // The predefined QUIT is replaced the same way: it exits through
        // a flow `ExitRequested` + `prevent_exit` cannot reliably stop,
        // so the v0.31.0 quit-confirmation dialog never appeared. Our
        // custom item keeps Cmd+Q but routes through `request_quit`,
        // which asks BEFORE any exit is requested. Appended (not
        // prepended) so Quit stays at the App menu's bottom.
        if let Some(app_submenu) = menu
            .items()
            .ok()
            .and_then(|items| items.into_iter().next())
            .and_then(|k| k.as_submenu().cloned())
        {
            let about = MenuItemBuilder::with_id("chan-about", "About Chan").build(app)?;
            app_submenu.prepend_items(&[&about])?;
            if let Ok(items) = app_submenu.items() {
                for item in items {
                    if let MenuItemKind::Predefined(p) = &item {
                        if let Ok(text) = p.text() {
                            let text = text.to_lowercase();
                            if text.contains("about") || text.contains("quit") {
                                let _ = app_submenu.remove(&item);
                            }
                        }
                    }
                }
            }
            let quit = MenuItemBuilder::with_id("chan-quit", "Quit Chan")
                .accelerator("CmdOrCtrl+Q")
                .build(app)?;
            app_submenu.append(&quit)?;
        }
        menu
    };

    // macOS: install the ONE global menubar. Off macOS there is no
    // app-wide menu at all -- the launcher window gets its bar per-window
    // when it is built (see the setup hook), and every other window is
    // born menu-less.
    #[cfg(target_os = "macos")]
    app.set_menu(menu)?;

    app.on_menu_event(handle_menu_event);
    Ok(())
}

/// Route every menubar item click / accelerator. Menu events carry only
/// the item id -- never the source window -- so the dynamic Window-menu
/// rows encode their window's label in the id (the `buried:` / `open:`
/// namespaces); routing by `is_focused` is reserved for items
/// that genuinely mean "the focused window" (and for macOS, whose single
/// global menubar has no owning window). Off macOS only the launcher has
/// a menubar, so the static items below fire from it alone.
fn handle_menu_event(app: &tauri::AppHandle, event: tauri::menu::MenuEvent) {
    let id = event.id().as_ref();
    // Dynamic Window-menu entries (buried windows) carry their
    // window label in the id; route by prefix before the static
    // match.
    if let Some(label) = id.strip_prefix(BURIED_MENU_ID_PREFIX) {
        if !unbury_window(app, label) {
            tracing::warn!(label, "buried window menu entry pointed at a dead window");
        }
        return;
    }
    if let Some(label) = id.strip_prefix(OPEN_MENU_ID_PREFIX) {
        // An open-window entry just raises the live window to the front.
        if let Err(e) = show_window(app, label) {
            tracing::warn!(label, error = %e, "raising open window from menu failed");
        }
        return;
    }
    match id {
        "win-main" => {
            let _ = show_window(app, "main");
        }
        "app-new-window" => {
            if let Err(e) = open_new_window_for_focused_workspace(app) {
                tracing::warn!(error = %e, "open new window for focused workspace failed");
            }
        }
        "app-open-in-browser" => {
            if let Err(e) = open_focused_window_in_browser(app) {
                tracing::warn!(error = %e, "open focused window in browser failed");
            }
        }
        "app-new-terminal" => {
            // macOS's single global menubar routes New Terminal by the
            // focused window's kind. Off-mac the item lives only on the
            // launcher's menubar, is labelled New Standalone Terminal,
            // and always means a standalone window.
            #[cfg(target_os = "macos")]
            handle_new_terminal(app);
            #[cfg(not(target_os = "macos"))]
            spawn_terminal_window(app);
        }
        "app-close-window" => {
            handle_close_window(app);
        }
        "chan-about" => {
            if let Err(e) = open_about_window(app) {
                tracing::warn!(error = %e, "open about window failed");
            }
        }
        // Cross-platform: the custom Quit item (Cmd/Ctrl+Q) asks
        // BEFORE exiting while SPA windows are open or hidden.
        "chan-quit" => {
            request_quit(app);
        }
        _ => {}
    }
}

/// Window-menu item id namespace for buried-window entries: the id is
/// this prefix + the Tauri window label, so the menu handler recovers
/// the label with a `strip_prefix`. The constant doubles as the marker
/// `rebuild_window_menu` uses to find (and replace) its own entries.
const BURIED_MENU_ID_PREFIX: &str = "buried:";
/// Disabled section header above the buried entries.
const BURIED_MENU_HEADER_ID: &str = "buried-header";
/// Window-menu id namespace for currently-OPEN (visible) windows: the id is
/// this prefix + the Tauri window label, so a click recovers the label and
/// raises the live window. Same prefix+label scheme as `buried:`.
const OPEN_MENU_ID_PREFIX: &str = "open:";
/// Disabled section header above all open-window entries.
const OPEN_MENU_HEADER_ID: &str = "open-header";
/// Linux/Windows Window-submenu id (macOS uses the system
/// `WINDOW_SUBMENU_ID` from `Menu::default`). The launcher's menubar --
/// the only off-mac bar -- uses this id for its Window submenu, so the
/// dynamic-tail rebuild can find it by one key.
#[cfg(not(target_os = "macos"))]
const LINUX_WINDOW_SUBMENU_ID: &str = "chan-window-submenu";

/// Launcher menubar (off-mac): File (New Standalone Terminal,
/// Close Window, About, Quit), Edit (the four clipboard items muda
/// implements on GTK), Window (Computers, New Window, Open in Browser
/// plus the dynamic tail `rebuild_window_menu` appends). The launcher is
/// the ONLY window with a bar: attached per-window with
/// `Window::set_menu` when the launcher window is built (there is no
/// app-wide default), so the bar's accelerators can never collide with
/// another window's. Every other window is menu-less and gets its chords
/// from KEY_BRIDGE_JS, which is why this bar keeps the Ctrl+Shift+T claim
/// (the launcher webview loads no key bridge, so only a native
/// accelerator can serve the chord there).
///
/// "About Chan" opens a version dialog that also offers a manual update
/// check - the only manual self-update entry point off macOS (the
/// launcher window otherwise auto-checks once per launch). No Help
/// submenu.
///
/// Quit is a CUSTOM item, not PredefinedMenuItem::quit: muda has no GTK
/// handler for the predefined Quit (it is wired only on macOS / Windows),
/// so on Linux the predefined item is silently dropped and File showed no
/// Exit at all. The custom item routes through `request_quit` (confirm
/// while windows exist). Undo/Redo are likewise GTK-unsupported (dropped, and they
/// would orphan a leading separator), so Edit sticks to the four clipboard
/// items muda does implement on GTK.
#[cfg(not(target_os = "macos"))]
fn build_launcher_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    use tauri::menu::{MenuBuilder, SubmenuBuilder};
    // File ▸ New Standalone Terminal always opens a fresh standalone
    // terminal window (workspace windows reach their pane-terminal
    // toggle through KEY_BRIDGE_JS instead).
    let new_terminal = MenuItemBuilder::with_id("app-new-terminal", "New Standalone Terminal")
        .accelerator("CmdOrCtrl+Shift+T")
        .build(app)?;
    let about = MenuItemBuilder::with_id("chan-about", "About Chan").build(app)?;
    let quit = MenuItemBuilder::with_id("chan-quit", "Quit")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;
    // Close Window on Linux/Windows rides Ctrl+Alt+W (plain
    // Ctrl+W stays a terminal readline chord, and Ctrl+Shift+W is
    // tab close there). Same routed handler
    // as macOS's Cmd+W item: tab-close in SPA windows,
    // cancel-close on the connecting screen, native close
    // elsewhere. On the launcher that means the launcher's own
    // hide-on-close. SPA windows claim the same chord inside
    // KEY_BRIDGE_JS, mirroring the macOS menu/bridge shadow pair.
    let close_window = MenuItemBuilder::with_id("app-close-window", "Close Window")
        .accelerator("CmdOrCtrl+Alt+W")
        .build(app)?;
    let file = SubmenuBuilder::new(app, "File")
        .item(&new_terminal)
        .item(&close_window)
        .separator()
        .item(&about)
        .separator()
        .item(&quit)
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    // Computers keeps no accelerator: Cmd+1..9 is reserved for
    // jump-to-tab in workspace windows (handled by the per-workspace key
    // bridge script in serve.rs). The menu entry still surfaces the
    // window by name.
    let workspace_manager = MenuItemBuilder::with_id("win-main", "Computers").build(app)?;
    // New Window opens another window of the FOCUSED window's connection
    // (open_new_window_for_focused_workspace): a standalone terminal
    // from the launcher (or nothing) focused -- the launcher itself is a
    // singleton and is never multiplied. `CmdOrCtrl+Shift+N` (not plain
    // Cmd+N) so the SPA's New Draft handler can claim Cmd+N without the
    // menu accelerator intercepting first.
    let new_window = MenuItemBuilder::with_id("app-new-window", "New Window")
        .accelerator("CmdOrCtrl+Shift+N")
        .build(app)?;
    // Open the FOCUSED workspace window's contents in the system browser.
    let open_in_browser =
        MenuItemBuilder::with_id("app-open-in-browser", "Open in Browser").build(app)?;
    let window = SubmenuBuilder::with_id(app, LINUX_WINDOW_SUBMENU_ID, "Window")
        .item(&workspace_manager)
        .item(&new_window)
        .item(&open_in_browser)
        .build()?;
    MenuBuilder::new(app)
        .item(&file)
        .item(&edit)
        .item(&window)
        .build()
}

/// The live Window submenu(s) the dynamic tail is stamped onto. macOS
/// has exactly one (the global menubar); off-mac the launcher's menubar
/// is the only bar, so this is its Window submenu alone. Empty before
/// the launcher window exists (early setup) or if the bar lost the
/// submenu.
fn window_submenus(app: &tauri::AppHandle) -> Vec<Submenu<tauri::Wry>> {
    #[cfg(target_os = "macos")]
    {
        app.menu()
            .and_then(|m| m.get(WINDOW_SUBMENU_ID))
            .and_then(|k| k.as_submenu().cloned())
            .into_iter()
            .collect()
    }
    #[cfg(not(target_os = "macos"))]
    {
        app.get_webview_window("main")
            .and_then(|window| window.menu())
            .and_then(|m| m.get(LINUX_WINDOW_SUBMENU_ID))
            .and_then(|k| k.as_submenu().cloned())
            .into_iter()
            .collect()
    }
}

/// Re-sync the Window submenu's dynamic tail: remove every
/// previously-appended `buried:*` / `open:*` entry (and the section
/// headers), then append the current snapshots. Off-mac
/// the tail lands on the launcher's bar alone (the only menubar). Runs
/// on the main thread -- muda requires menu mutation there on macOS --
/// and is best-effort throughout: a menu glitch must never take down a
/// close/destroy handler.
pub fn rebuild_window_menu(app: &tauri::AppHandle) {
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        let submenus = window_submenus(&app);
        if submenus.is_empty() {
            return;
        }
        for submenu in &submenus {
            if let Ok(items) = submenu.items() {
                for item in items {
                    let id = item.id().as_ref();
                    // The single buried and open headers use exact ids; their
                    // rows use the corresponding prefixes.
                    if id.starts_with(BURIED_MENU_HEADER_ID)
                        || id.starts_with(OPEN_MENU_HEADER_ID)
                        || id.starts_with(BURIED_MENU_ID_PREFIX)
                        || id.starts_with(OPEN_MENU_ID_PREFIX)
                    {
                        let _ = submenu.remove(&item);
                    }
                }
            }
        }
        let state = app.state::<Arc<AppState>>();
        let buried = state.buried_snapshot();
        // Sections are assembled as data first, then applied to every
        // submenu at the end -- MenuItems can't be shared across menus, so
        // each menubar gets freshly built ones.
        struct MenuSection {
            header_id: String,
            header: String,
            /// (window label, menu title) per row.
            rows: Vec<(String, String)>,
            id_prefix: &'static str,
        }
        let mut sections: Vec<MenuSection> = Vec::new();
        let mut push_section =
            |header_id: &str, header: &str, rows: Vec<(String, String)>, id_prefix: &'static str| {
                if rows.is_empty() {
                    return;
                }
                sections.push(MenuSection {
                    header_id: header_id.to_string(),
                    header: header.to_string(),
                    rows,
                    id_prefix,
                });
            };
        // Currently-OPEN (visible) windows, so the Window menu can RAISE a live
        // window in addition to reopening a hidden one. The library's own
        // window set is the source of truth (local rows now; each connected
        // devserver's rows once its feed merges in via `DevserverFeedSource`). A
        // row counts as open when its native webview is alive AND visible: a
        // buried window's webview is alive but hidden, so it shows under Hidden,
        // not here. Appended first, the open windows head the dynamic tail.
        let open_records = state
            .embedded()
            .map(|e| e.assemble_window_records())
            .unwrap_or_default();
        let mut open_local: Vec<(String, String)> = Vec::new();
        for record in &open_records {
            // A server-hidden window belongs under Hidden, never Open:
            // group strictly by the persisted `hidden`, not just native visibility.
            if record.hidden {
                continue;
            }
            let label = window_watcher::native_label(record);
            let Some(window) = app.get_webview_window(&label) else {
                continue;
            };
            if !window.is_visible().unwrap_or(false) {
                continue;
            }
            let title = window.title().unwrap_or_else(|_| record_menu_title(record));
            open_local.push((label, title));
        }
        if !open_local.is_empty() {
            push_section(
                OPEN_MENU_HEADER_ID,
                &format!("Open Windows ({})", open_local.len()),
                open_local,
                OPEN_MENU_ID_PREFIX,
            );
        }
        let mut local: Vec<(String, String)> = Vec::new();
        // Hidden = the in-session buried set UNION the server-persisted hidden
        // records: a window hidden in a PRIOR session (record.hidden)
        // isn't opened on connect (should_show false) and isn't in the local
        // buried set, so list it here so the user can reopen it. Dedup by label.
        //
        // Title precedence for a hidden row: the live webview when the window
        // still has one (a standalone terminal keeps its native window when
        // buried), else the library record, else the title captured at bury
        // time. The record beats the captured title because the capture freezes
        // the caption as it was when the window was hidden, so a caption edited
        // while hidden would otherwise never show. Buried rows keep their
        // most-recent-first order; server-hidden records follow.
        let records_by_label: HashMap<String, &chan_server::WindowRecord> = open_records
            .iter()
            .map(|record| (window_watcher::native_label(record), record))
            .collect();
        let hidden_title = |label: &str, captured: Option<String>| -> String {
            if let Some(title) = app.get_webview_window(label).and_then(|w| w.title().ok()) {
                return title;
            }
            match records_by_label.get(label) {
                Some(record) => record_menu_title(record),
                None => captured.unwrap_or_else(|| label.to_string()),
            }
        };
        let mut hidden_rows: Vec<(String, String)> = Vec::new();
        for (label, captured) in buried {
            let title = hidden_title(&label, Some(captured));
            hidden_rows.push((label, title));
        }
        for record in &open_records {
            if !record.hidden {
                continue;
            }
            let label = window_watcher::native_label(record);
            if hidden_rows.iter().any(|(l, _)| l == &label) {
                continue;
            }
            let title = hidden_title(&label, None);
            hidden_rows.push((label, title));
        }
        local.extend(hidden_rows);

        // Count + cost hint in the header: buried webviews stay live (warm
        // layout, running terminals), which is memory the user can't see.
        if !local.is_empty() {
            push_section(
                BURIED_MENU_HEADER_ID,
                &format!("Hidden Windows ({}, kept warm in memory)", local.len()),
                local,
                BURIED_MENU_ID_PREFIX,
            );
        }
        for submenu in &submenus {
            for section in &sections {
                if let Ok(item) =
                    MenuItemBuilder::with_id(section.header_id.as_str(), section.header.as_str())
                        .enabled(false)
                        .build(&app)
                {
                    let _ = submenu.append(&item);
                }
                let id_prefix = section.id_prefix;
                for (label, title) in &section.rows {
                    match MenuItemBuilder::with_id(format!("{id_prefix}{label}"), title)
                        .build(&app)
                    {
                        Ok(item) => {
                            let _ = submenu.append(&item);
                        }
                        Err(e) => {
                            tracing::warn!(label, error = %e, "building dynamic window menu item failed");
                        }
                    }
                }
            }
        }
    });
}

pub fn unbury_window(app: &tauri::AppHandle, label: &str) -> bool {
    let state = app.state::<Arc<AppState>>();
    let removed = state.remove_buried(label);
    // Unbury persists `hidden=false` to the owning registry so the show
    // is durable + mirrored on connect (BOTH the native menu reopen and the SPA
    // `/open` toggle funnel here). Routes by the label's library.
    persist_window_hidden(&state, label, false);
    // A watcher-managed local window: un-bury through the view state. The bury
    // destroyed the native window (the reconcile closed it), so there is nothing
    // to show() -- the reconcile reopens it at its window_id. Counts as shown.
    if label.starts_with("local::") {
        if let Some(view) = state.local_watcher_view() {
            view.unbury(label);
        }
        // FOCUS on an ALREADY-VISIBLE watcher window: `view.unbury` is a no-op
        // (its webview is alive, not buried), and the early return below skips
        // the show()/set_focus() the final branch does -- so raise + focus the
        // live webview here. A BURIED window's webview was destroyed
        // (`get_webview_window` is None → no-op), and the reconcile reopens it
        // focused (the window builder focuses by default).
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.show();
            let _ = w.set_focus();
        }
        if removed {
            rebuild_window_menu(app);
        }
        return true;
    }
    // A watcher-managed DEVSERVER window: un-bury through ITS devserver view.
    // The bury destroyed the webview (the reconcile closed it), so there's nothing
    // to show() -- un-burying lets the reconcile reopen it at its window_id.
    if label.starts_with("lib-") {
        let library_id = label.split("::").next().unwrap_or(label);
        if let Some(ds_id) = state.devserver_feed.devserver_id_for_library(library_id) {
            if let Some(view) = state.devserver_watcher_views.lock().unwrap().get(&ds_id) {
                view.unbury(label);
            }
        }
        // Clear the feed `connected` override and re-push so the dot goes back
        // to shown; the reconcile reopens the webview and the `/ws` reconnects.
        if state.devserver_feed.set_buried(label, false) {
            if let Some(embedded) = state.embedded() {
                embedded.signal_library_change();
            }
        }
        // FOCUS on an ALREADY-VISIBLE devserver window: as in the `local::`
        // branch, `view.unbury` is a no-op on a live webview and the early
        // return skips show()/set_focus(), so raise + focus it here. A buried
        // window's webview is destroyed (None → no-op) and the reconcile reopens
        // it focused.
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.show();
            let _ = w.set_focus();
        }
        if removed {
            rebuild_window_menu(app);
        }
        return true;
    }
    let shown = match app.get_webview_window(label) {
        Some(w) => {
            let _ = w.show();
            let _ = w.set_focus();
            true
        }
        None => false,
    };
    // The control terminal's launcher dot now reflects PTY-alive (resolved at read
    // time from its chan-library control tenant), uniform with all windows -- no
    // desktop-side shown/hidden flip; shown/hidden returns uniformly through the
    // server-persisted hidden path.
    if removed {
        rebuild_window_menu(app);
    }
    shown
}

/// Open the bundled About window. Same content on every platform (mirrors
/// the SPA Dashboard About slide: version, license, links, donation QR, and
/// third-party attributions); the macOS system About panel is redirected
/// here so all platforms share one surface.
/// Singleton: focus an existing About window instead of stacking copies.
/// The desktop version is passed as a query param so `about.html` needs no
/// `app`-plugin capability just to render it.
fn open_about_window(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("about") {
        let _ = win.set_focus();
        return Ok(());
    }
    let version = app.package_info().version.to_string();
    let build = CHAN_DESKTOP_BUILD_ID;
    // Inject the launcher's light/dark choice so the About window follows it
    // instead of only the OS media query. `null` follows the OS.
    let theme = app
        .state::<Arc<AppState>>()
        .embedded()
        .and_then(|e| e.local_theme());
    let init = format!(
        "window.__CHAN_THEME__ = {};",
        serde_json::to_string(&theme).unwrap_or_else(|_| "null".to_string())
    );
    let win = WebviewWindowBuilder::new(
        app,
        "about",
        WebviewUrl::App(format!("about.html?v={version}&b={build}").into()),
    )
    .title("About Chan Desktop")
    // Tall enough that the content never has to scroll; about.css centers
    // it, so any slack is split evenly above and below rather than piling
    // up under the card. 460 is measured, not guessed: the DOM lays out at
    // 422 (head 67, links 20, Fund card 182, separator 1, credits 36, four
    // 16px gaps, 52px of padding), plus one wrapped line each for the links
    // row and the credits line. Those two are the only rows whose height
    // depends on the platform's font: the Fund card is pinned by its 150px
    // QR and the head by its two fixed lines. Fixed, since the window is
    // non-resizable.
    .inner_size(420.0, 460.0)
    .min_inner_size(420.0, 380.0)
    .resizable(false)
    .initialization_script(&init)
    .build()
    .map_err(|e| format!("building about window: {e}"))?;
    // Off macOS the About window is born menu-less like every window but
    // the launcher (there is no app-wide menu to inherit) -- a File/Edit/
    // Window bar on a fixed-size dialog would be noise. macOS keeps the
    // global menubar -- nothing to do there either.
    let _ = win;
    Ok(())
}

/// Open a new window of the workspace that owns the currently
/// focused window (the Cmd/Ctrl+Shift+N "New Window" semantics).
///
/// A watcher-opened window's composite label resolves its library record. The
/// library mints a sibling record of the focused window's kind, and its watcher
/// opens the native window.
///
/// With the launcher (or nothing) focused, Cmd/Ctrl+Shift+N opens a standalone
/// terminal window instead -- the launcher is a singleton, never
/// multiplied. The "Computers" picker stays reachable via the
/// `win-main` menu item, which is also the fallback surface when a
/// focused window's backing connection can't be resolved.
/// Open the FOCUSED workspace window's contents in the system browser. Mints a
/// browser-affinity record for the same workspace (chan-desktop's watcher skips
/// non-native records, so no native twin opens), composes its loopback URL with
/// its own `?w=` / `?lib=`, and hands it to the opener plugin. A no-op when the
/// focused window is a launcher or terminal (nothing workspace-shaped to open).
fn open_focused_window_in_browser(app: &tauri::AppHandle) -> Result<(), String> {
    let Some(focused) = app
        .webview_windows()
        .into_values()
        .find(|w| serve::is_workspace_webview_label(w.label()) && w.is_focused().unwrap_or(false))
    else {
        return Ok(());
    };
    let label = focused.label().to_string();
    open_window_in_browser(app, &label)
}

/// Open the workspace shown by the window `label` in the system browser:
/// mints a browser-affinity record for the same workspace (chan-desktop
/// skips it, D4) so the browser tab holds its own window_id, then opens
/// the composed URL. No-op for a window without a workspace record
/// (standalone terminals).
fn open_window_in_browser(app: &tauri::AppHandle, label: &str) -> Result<(), String> {
    let state = app.state::<Arc<AppState>>();
    let embedded = state
        .embedded()
        .ok_or_else(|| "embedded local server is unavailable".to_string())?;
    // Resolve the window's record from the live feed; only a workspace
    // window has a workspace to serve in the browser.
    let Some(record) = embedded
        .assemble_window_records()
        .into_iter()
        .find(|r| crate::window_watcher::native_label(r) == label)
    else {
        return Ok(());
    };
    if record.kind != chan_server::WindowKind::Workspace {
        return Ok(());
    }
    // A fresh browser-affinity record for the same workspace: the browser tab
    // gets its own window_id and the desktop never opens a native twin for it.
    let minted =
        embedded.mint_browser_window(chan_server::WindowKind::Workspace, record.workspace_path)?;
    let url = serve::browser_window_url(app, embedded.addr(), &minted)?;
    app.opener()
        .open_url(url.to_string(), None::<&str>)
        .map_err(|e| format!("opening the browser window URL: {e}"))
}

fn open_new_window_for_focused_workspace(app: &tauri::AppHandle) -> Result<(), String> {
    let Some(focused) = app
        .webview_windows()
        .into_values()
        .find(|w| serve::is_workspace_webview_label(w.label()) && w.is_focused().unwrap_or(false))
    else {
        // Launcher (or nothing) focused: New Window means a standalone terminal.
        spawn_terminal_window(app);
        return Ok(());
    };
    let label = focused.label().to_string();
    open_new_window_for_label(app, &label)
}

/// Open a new window of the connection owning the window `label` (the
/// label-addressed core of the New Window semantics above).
fn open_new_window_for_label(app: &tauri::AppHandle, focused_label: &str) -> Result<(), String> {
    let state = app.state::<Arc<AppState>>();
    // A watcher-opened local window (`local::<window_id>`): branch on the
    // window's KIND. A terminal opens ANOTHER standalone terminal; a
    // workspace mints another window for the same workspace (the watcher opens
    // it). Each minted window is an independent registry record.
    // A Terminal record carries no `workspace_path`, so the window kind is the
    // reliable branch key.
    if focused_label.starts_with("local::") {
        let record = state.embedded().and_then(|embedded| {
            embedded
                .assemble_window_records()
                .into_iter()
                .find(|r| crate::window_watcher::native_label(r) == focused_label)
        });
        return match record {
            Some(r) if r.kind == chan_server::WindowKind::Terminal => {
                spawn_terminal_window(app);
                Ok(())
            }
            Some(r) => state
                .embedded()
                .ok_or_else(|| "embedded local server is unavailable".to_string())?
                .mint_window(chan_server::WindowKind::Workspace, r.workspace_path)
                .map(|_| ()),
            None => show_window(app, "main"),
        };
    }
    // A watcher-opened devserver window (`lib-<library_id>::<window_id>`): mint
    // ANOTHER window of the SAME kind on the same devserver, mirroring the
    // `local::` branch (a Terminal opens another standalone terminal; a Workspace
    // another window for its workspace). There is no stored library_id->devserver
    // map, so the async helper matches the focused label against each connected
    // devserver's feed (which hands back the focused window's kind +
    // workspace_path). It is an HTTP round-trip, so fire-and-forget -- a failure
    // surfaces as a warning, not a blocked menu handler. (Without this a `lib-`
    // label matches no branch below and falls through to `show_window("main")`  --
    // Cmd+Shift+N on a devserver window jumps focus back to the launcher.)
    if focused_label.starts_with("lib-") {
        let app = app.clone();
        let focused_label = focused_label.to_string();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = mint_another_devserver_window(&app, &focused_label).await {
                tracing::warn!(label = %focused_label, error = %e, "Cmd+Shift+N on a devserver window failed");
            }
        });
        return Ok(());
    }
    show_window(app, "main")
}

/// Mint another window for the devserver window that owns `focused_label`
/// (a `lib-<library_id>::<window_id>` watcher window), for Cmd+Shift+N. The
/// owning conn resolves through the window feed (`record_for_native_label`),
/// which covers persisted-config devservers AND gateway-rostered ones (whose
/// synthesized ids never live in `cfg.devservers`); the matching record yields
/// the conn AND the focused window's kind + `workspace_path`. Mint the SAME
/// kind on that conn -- the watcher opens it -- mirroring the `local::`
/// New-Window behavior. A stale window whose devserver is gone falls back to
/// the picker.
async fn mint_another_devserver_window(
    app: &tauri::AppHandle,
    focused_label: &str,
) -> Result<(), String> {
    let state = app.state::<Arc<AppState>>();
    let Some((devserver_id, record)) = state.devserver_feed.record_for_native_label(focused_label)
    else {
        // Stale window for a disconnected/forgotten devserver: surface the picker.
        return show_window(app, "main");
    };
    let Some(conn) = state.devservers.get(&devserver_id) else {
        return show_window(app, "main");
    };
    // Mirror the focused window's kind. A Terminal record carries no
    // `workspace_path`, so minting a Workspace would make a blank,
    // path-less window; branch on the kind and carry the path only for a
    // Workspace.
    let workspace_path = match record.kind {
        chan_server::WindowKind::Terminal => None,
        chan_server::WindowKind::Workspace => record.workspace_path.clone(),
    };
    devserver::mint_library_window(&conn, record.kind, workspace_path)
        .await
        .map(|_| ())
}

/// Run one bounded attempt for a process-local pending window DELETE. Both the
/// close path and the feed-reconnect driver use this owner so completion and
/// the one terminal notice cannot diverge.
pub(crate) fn spawn_pending_window_delete_attempt(
    app: tauri::AppHandle,
    state: Arc<AppState>,
    conn: devserver::DevserverConn,
    attempt: window_watcher::PendingDeleteAttempt,
) {
    tauri::async_runtime::spawn(async move {
        let result = devserver::discard_library_window(&conn, &attempt.window_id).await;
        let error = result.as_ref().err().cloned();
        if let Some(error) = &error {
            tracing::warn!(
                window = %attempt.label,
                window_name = %attempt.window_name,
                attempt = attempt.attempt,
                error = %error,
                "discarding a closed devserver window failed",
            );
        }
        let finish = state
            .pending_window_deletes
            .finish(&attempt.label, result.is_ok());
        if let Some(window_watcher::PendingDeleteFinish::Exhausted {
            window_id,
            window_name,
            attempts,
        }) = finish
        {
            let error = error.unwrap_or_else(|| "unknown error".to_string());
            emit_system_notice(
                &app,
                "warning",
                format!(
                    "Could not delete closed window \"{window_name}\" ({window_id}) after {attempts} attempts: {error}. It remains closed for this desktop session."
                ),
            );
        }
    });
}

/// Discard a devserver window matched by the BARE `window_id` (what
/// `cs window rm` sends) instead of the composite native label -- the cross-host
/// path where a local terminal removes a connected devserver's window, whose
/// registry row lives remote-side and so cannot be reached by the embedded
/// host's own `discard_window`. Resolves the owning conn through the window
/// feed (`record_for_window_id`), covering rostered gateway devservers like
/// the label-matched sibling. Returns whether a connected devserver owned the
/// id (and its row was DELETEd there). The local `--force` guard does not apply
/// on this path: the embedded host cannot see the devserver's terminals, so a
/// devserver window is best managed from one of its own terminals (which routes
/// `cs window rm` to the guarded devserver-side path).
async fn discard_devserver_window_by_id(
    app: &tauri::AppHandle,
    window_id: &str,
) -> Result<bool, String> {
    let state = app.state::<Arc<AppState>>();
    let Some((devserver_id, _)) = state.devserver_feed.record_for_window_id(window_id) else {
        return Ok(false);
    };
    let Some(conn) = state.devservers.get(&devserver_id) else {
        return Ok(false);
    };
    devserver::discard_library_window(&conn, window_id).await?;
    Ok(true)
}

/// OS window title for the singleton launcher. Launchers are never
/// multiplied anymore (Cmd/Ctrl+Shift+N on the launcher opens a
/// standalone terminal window instead), so there is no `Window N`
/// suffix to disambiguate.
const LAUNCHER_WINDOW_TITLE: &str = "Chan Desktop";
const LAUNCHER_DEFAULT_WIDTH: f64 = 420.0;
const LAUNCHER_DEFAULT_HEIGHT: f64 = 720.0;
const LAUNCHER_MIN_WIDTH: f64 = 420.0;
const LAUNCHER_MIN_HEIGHT: f64 = 420.0;

fn capture_launcher_geometry(app: &tauri::AppHandle) {
    serve::capture_window_geometry(app, "main");
}

/// Minimal reload-only key bridge for the launcher window. The launcher is
/// remote-served (the embedded loopback SPA) and does NOT receive the full
/// workspace `KEY_BRIDGE_JS`, so without this it has no reload chord. Claims
/// Cmd+R (macOS) / Ctrl+R (Linux/Windows) in the capture phase and reloads via
/// the `reload_window` IPC, falling back to `location.reload()` when the Tauri
/// bridge is absent. Plain Ctrl+R is safe to claim here: the launcher hosts no
/// terminal whose shell reverse-search it would shadow (workspace windows move
/// reload to Ctrl+Shift+R off macOS for exactly that reason).
const LAUNCHER_RELOAD_BRIDGE_JS: &str = r#"
(() => {
  function reload() {
    const tauri = window.__TAURI__;
    if (tauri && tauri.core && typeof tauri.core.invoke === 'function') {
      tauri.core.invoke('reload_window').catch(() => window.location.reload());
    } else {
      window.location.reload();
    }
  }
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyR' || e.altKey || e.shiftKey) return;
    if (!(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    reload();
  }, true);
})();
"#;

enum ShutdownAction {
    Exit(i32),
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    Restart,
    /// Windows: hand the downloaded, verified installer bytes to
    /// `tauri-plugin-updater` after the drain. The plugin launches the NSIS
    /// installer (passive, `/R`) and exits this process; the installer
    /// relaunches the app.
    #[cfg(windows)]
    InstallUpdate {
        update: tauri_plugin_updater::Update,
        bytes: Vec<u8>,
    },
}

/// Start the one normal-exit drain. Snapshot the mounted overlay before any
/// tenant is removed, await every embedded tenant, then perform the process
/// action. Synchronous Tauri hooks call this and return; the async task owns the
/// remaining state. A second request while a drain is in flight is refused and
/// handed back, so a caller holding something valuable (the Windows staged
/// installer) can keep it rather than lose it silently.
fn begin_normal_shutdown(
    app: tauri::AppHandle,
    action: ShutdownAction,
) -> Result<(), ShutdownAction> {
    use std::sync::atomic::Ordering;

    let state = Arc::clone(&app.state::<Arc<AppState>>());
    if state.shutdown_started.swap(true, Ordering::SeqCst) {
        tracing::warn!("shutdown already in progress; a second shutdown request was not applied");
        return Err(action);
    }
    state.quit_confirmed.store(true, Ordering::SeqCst);
    persist_workspaces(&state);
    tauri::async_runtime::spawn(async move {
        serve::stop_all(&state).await;
        match action {
            ShutdownAction::Exit(code) => app.exit(code),
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            ShutdownAction::Restart => app.restart(),
            #[cfg(windows)]
            ShutdownAction::InstallUpdate { update, bytes } => {
                // The plugin exits the process itself on success, so the
                // `RunEvent::Exit` geometry capture never runs: take it here.
                capture_launcher_geometry(&app);
                tracing::info!(
                    "handing the verified installer to the updater; it runs passively and relaunches \
                     chan-desktop. If nothing relaunches, the staged installer is under %TEMP% in \
                     the updater's Chan-<version> directory; run it by hand"
                );
                if let Err(e) = update.install(bytes) {
                    // The tenants are already drained, so the current version
                    // is relaunched rather than left half-stopped.
                    tracing::error!(
                        error = %e,
                        "installing the downloaded update failed; relaunching the current version"
                    );
                    app.restart();
                }
                // On success the plugin has already exited the process.
                app.exit(0);
            }
        }
    });
    Ok(())
}

/// Quit, asking first while ANY SPA window is alive -- visible or
/// buried (a buried window is a live hidden webview, so one
/// `webview_windows()` scan covers both): quitting silently kills
/// standalone-terminal shells and stops local workspaces. A bare
/// launcher (or About) quits without ceremony.
///
/// The confirmation lives HERE, before any exit is requested, because
/// the macOS predefined Quit item exits through a flow
/// `RunEvent::ExitRequested` + `prevent_exit` cannot reliably stop
/// (the v0.31.0 dialog never appeared). The custom chan-quit menu item
/// (Cmd/Ctrl+Q) routes here on every platform; on Quit the
/// `quit_confirmed` flag lets the resulting `ExitRequested` pass.
fn request_quit(app: &tauri::AppHandle) {
    use std::sync::atomic::Ordering;
    let state = Arc::clone(&app.state::<Arc<AppState>>());
    let open = app
        .webview_windows()
        .into_keys()
        .filter(|l| serve::is_workspace_webview_label(l))
        .count();
    if open == 0 {
        capture_launcher_geometry(app);
        let _ = begin_normal_shutdown(app.clone(), ShutdownAction::Exit(0));
        return;
    }
    // One dialog at a time: a second Cmd+Q while the ask is up must
    // not stack another.
    if state.quit_prompt_open.swap(true, Ordering::SeqCst) {
        return;
    }
    let hidden = state.buried_windows.lock().unwrap().len();
    let message = if hidden > 0 {
        format!(
            "Chan has {open} window(s) ({hidden} hidden). Quitting stops their terminals and local workspaces; remote servers keep running."
        )
    } else {
        format!(
            "Chan has {open} window(s) open. Quitting stops their terminals and local workspaces; remote servers keep running."
        )
    };
    let app_for_reply = app.clone();
    native_dialog::confirm(app, "Quit Chan?", &message, "Quit", "Cancel", move |quit| {
        state.quit_prompt_open.store(false, Ordering::SeqCst);
        if quit {
            capture_launcher_geometry(&app_for_reply);
            let _ = begin_normal_shutdown(app_for_reply, ShutdownAction::Exit(0));
        }
    });
}

/// Eval a `chan:command` dispatch on `window`'s webview -- the same
/// CustomEvent bridge the SPA's own key chords ride, so a native menu
/// row and its in-app twin cannot drift.
fn eval_chan_command(window: &tauri::WebviewWindow, command: &str) {
    let js = format!(
        "window.dispatchEvent(new CustomEvent('chan:command', {{detail: {{name: {}}}}}));",
        serde_json::to_string(command).unwrap_or_else(|_| "\"\"".into())
    );
    let _ = window.eval(&js);
}

/// Eval a `chan:command` dispatch on the currently-focused workspace
/// webview. macOS-only: the global menubar's items defer to chan's
/// per-workspace behavior by focus; off-mac only the launcher has a
/// menubar, and SPA windows route their chords through KEY_BRIDGE_JS
/// instead. No-op when the focused window isn't a workspace.
#[cfg(target_os = "macos")]
fn dispatch_to_focused_workspace(app: &tauri::AppHandle, command: &str) {
    let Some(w) = app
        .webview_windows()
        .into_values()
        .find(|w| serve::is_workspace_webview_label(w.label()) && w.is_focused().unwrap_or(false))
    else {
        return;
    };
    eval_chan_command(&w, command);
}

/// Route File ▸ New Terminal (Cmd+T) by the focused window's kind:
/// macOS-only, where the single global menubar serves every window (the
/// off-mac shapes carry per-window items that need no focus routing).
///
/// - A watcher-opened SPA window (`local::*` / `lib-*`) gets
///   `app.terminal.toggle` dispatched. The SPA decides
///   what that means: a workspace window toggles a pane terminal (its
///   existing behaviour); a terminal window adds a terminal tab.
/// - Anything else (a focused launcher `main` / `main-*`, or no focused
///   window at all) opens a fresh standalone terminal window.
///
/// The single always-enabled menu accelerator pre-empts the webview, so
/// the KEY_BRIDGE_JS `KeyT` -> `app.terminal.toggle` case is harmlessly
/// shadowed in the desktop; this routing reproduces the same dispatch for
/// SPA windows while giving the launcher a working Cmd+T.
#[cfg(target_os = "macos")]
fn handle_new_terminal(app: &tauri::AppHandle) {
    let focused_spa = app
        .webview_windows()
        .into_values()
        .any(|w| serve::is_workspace_webview_label(w.label()) && w.is_focused().unwrap_or(false));
    if focused_spa {
        dispatch_to_focused_workspace(app, "app.terminal.toggle");
    } else {
        spawn_terminal_window(app);
    }
}

/// Route File ▸ Close Window by the focused window's kind, mirroring
/// `handle_new_terminal`. macOS binds Cmd+W; Linux/Windows bind Ctrl+Alt+W
/// (plain Ctrl+W stays a terminal readline chord there, and Ctrl+Shift+W
/// is tab close).
///
/// - A focused watcher-opened workspace webview (`local::*` / `lib-*`):
///   on macOS the menu shares Cmd+W with tab-close, so it dispatches
///   `app.tab.close` (the active tab, not the window). Off-mac the menu
///   chord is the registry's window-close (Ctrl+Alt+W; tab-close is
///   Ctrl+Shift+W there), so it dispatches `app.window.close`, the same
///   CustomEvent the KEY_BRIDGE_JS alt KeyW case fires.
/// - Any other focused window (the launcher `main` / `main-*`, the About
///   window) is closed natively. The launcher's `CloseRequested` handler
///   intercepts that to hide rather than destroy it, keeping reopen instant.
fn handle_close_window(app: &tauri::AppHandle) {
    let Some(window) = app
        .webview_windows()
        .into_values()
        .find(|w| w.is_focused().unwrap_or(false))
    else {
        return;
    };
    close_spa_or_native_window(app, window);
}

/// Close `window` by its kind: control terminals route through
/// `request_close_window` (reap the control row/tenant, disconnect only
/// if it still owns a live devserver connection); SPA webviews get the
/// close command dispatched (or a real destroy on the connecting/retry
/// screen, where the close means cancel); anything else (the launcher,
/// the About window) closes natively -- the launcher's `CloseRequested`
/// handler turns that into a hide.
fn close_spa_or_native_window(app: &tauri::AppHandle, window: tauri::WebviewWindow) {
    if window.label().starts_with("control-terminal-") {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = request_close_window(app, window).await;
        });
        return;
    }
    if serve::is_workspace_webview_label(window.label()) {
        // A window still on the connecting/retry screen has no tabs to
        // close and nothing to bury: the close chord means cancel, so destroy
        // for real (destroy skips the bury-on-close handler).
        if serve::window_on_connecting_screen(app, window.label()) {
            let _ = window.destroy();
            return;
        }
        // macOS Cmd+W is tab-close; off-mac Ctrl+Alt+W is window-close (its
        // tab-close is Ctrl+Shift+W, dispatched from the bridge).
        if cfg!(target_os = "macos") {
            eval_chan_command(&window, "app.tab.close");
        } else {
            eval_chan_command(&window, "app.window.close");
        }
    } else {
        let _ = window.close();
    }
}

/// Open a standalone terminal-only window. Mounting the
/// embedded tenant is async (`EmbeddedServer::open_terminal`), so this
/// hands off to the Tauri async runtime; a failure surfaces as a system
/// notice rather than blocking the menu-event / IPC thread. Mirrors how
/// the IPC commands drive `serve::start`.
fn spawn_terminal_window(app: &tauri::AppHandle) {
    let app_for_task = app.clone();
    let state = Arc::clone(&app.state::<Arc<AppState>>());
    tauri::async_runtime::spawn(async move {
        if let Err(e) = serve::spawn_local_terminal_window(state).await {
            tracing::warn!(error = %e, "opening standalone terminal window failed");
            emit_system_notice(
                &app_for_task,
                "error",
                format!("Could not open terminal: {e}"),
            );
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The bounded region of a source-slice pin: from the end of `start` to
    /// the beginning of `end`, with both bounds asserted to occur exactly
    /// once in `src`, so a pin can neither bind a sibling's needle nor
    /// survive a reordering by silently widening. Bound needles must keep
    /// their text out of this module's string literals: a line-start
    /// definition form (leading `\n`) can never match a literal, because a
    /// literal spells the newline as a two-character escape, and a mid-line
    /// needle gets the same property from `concat!`-split parts.
    fn source_region<'a>(src: &'a str, start: &str, end: &str) -> &'a str {
        for bound in [start, end] {
            assert_eq!(
                src.matches(bound).count(),
                1,
                "pin bound {bound:?} must occur exactly once in the sliced source"
            );
        }
        let (_, after) = src.split_once(start).expect("the start bound is present");
        let stop = after
            .find(end)
            .unwrap_or_else(|| panic!("pin end bound {end:?} must follow start bound {start:?}"));
        &after[..stop]
    }

    /// The ceiling is a construction property, so it is pinned at the
    /// construction seam. Counting live threads would prove nothing: tokio
    /// creates blocking threads lazily, so a run that never needs 32 looks
    /// identical to one that is capped at 32.
    ///
    /// Scope matters as much as the value. Only runtimes that can execute
    /// transfer work take the ceiling; the hidden MCP proxy, the
    /// current-thread `cs` client, and Tauri's own GUI runtime must not,
    /// because capping them would throttle work this lane never admits.
    #[test]
    fn production_runtime_blocking_limit() {
        // Only the production half: this test names the same call it checks
        // for, so scanning the whole file would match itself and keep passing
        // after the real call was deleted.
        let src = include_str!("main.rs");
        let boundary = "\n#[cfg(test)]\nmod tests {";
        assert_eq!(
            src.matches(boundary).count(),
            1,
            "one test-module boundary separates the production half"
        );
        let production = &src[..src.find(boundary).expect("the boundary is present")];
        assert!(
            production.contains("fn run_as_chan_if_requested"),
            "the production half must be what was scanned"
        );

        assert_eq!(
            production
                .matches(".max_blocking_threads(chan_server::bulk_transfer::MAX_BLOCKING_THREADS)")
                .count(),
            1,
            "exactly one desktop runtime declares the ceiling"
        );

        // The one that has it is the `chan` CLI runtime, and the excluded
        // builders keep their unbounded defaults.
        let chan_runtime = source_region(
            production,
            "\nfn run_as_chan_if_requested(",
            "\nasync fn run_mcp_proxy(",
        );
        assert!(
            chan_runtime.contains(
                ".max_blocking_threads(chan_server::bulk_transfer::MAX_BLOCKING_THREADS)"
            ),
            "the desktop chan runtime must declare its blocking-thread ceiling"
        );

        for (excluded, next_fn) in [
            (
                "\nfn run_hidden_mcp_proxy_if_requested(",
                "\nfn run_as_cs_if_requested(",
            ),
            (
                "\nfn run_as_cs_if_requested(",
                "\nfn run_as_chan_if_requested(",
            ),
        ] {
            let body = source_region(production, excluded, next_fn);
            assert!(
                !body.contains("max_blocking_threads"),
                "{} must keep tokio's default pool",
                excluded.trim_start()
            );
        }
    }

    /// The clipboard runner must not execute its operation on the thread that
    /// awaits it: a current-thread runtime is the strictest witness, because an
    /// inline call would starve the timer below for the operation's whole life.
    /// A blocked X11 selection read is exactly this shape, and holding the
    /// invoke thread through it is what froze the window.
    #[cfg(not(target_os = "macos"))]
    #[tokio::test(flavor = "current_thread")]
    async fn clipboard_op_leaves_the_awaiting_thread_free() {
        use std::sync::mpsc;
        use std::time::Duration;

        // The fake operation parks until a separate thread releases it ~200ms
        // from now, standing in for a clipboard owner that answers slowly.
        let (release_tx, release_rx) = mpsc::channel::<()>();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            let _ = release_tx.send(());
        });

        let op = run_clipboard_op(move || {
            release_rx
                .recv()
                .map(|()| "released")
                .map_err(|e| e.to_string())
        });
        tokio::pin!(op);
        let timer_won = tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(20)) => true,
            _ = &mut op => false,
        };
        assert!(
            timer_won,
            "the awaiting thread stalled until the clipboard operation finished"
        );
        assert_eq!(op.await, Ok("released"), "the parked operation still lands");
    }

    /// Two clipboard operations must never be inside the guard at once because
    /// X11 selections and Windows OLE both require serialized clipboard access.
    #[cfg(not(target_os = "macos"))]
    #[tokio::test]
    async fn clipboard_ops_never_overlap() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::time::Duration;

        static IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);
        static PEAK: AtomicUsize = AtomicUsize::new(0);
        static DONE: AtomicUsize = AtomicUsize::new(0);

        fn tracked_op() -> Result<(), String> {
            let now = IN_FLIGHT.fetch_add(1, Ordering::SeqCst) + 1;
            PEAK.fetch_max(now, Ordering::SeqCst);
            // Long enough that a second unserialized operation would be seen
            // inside the window, short enough to keep the test quick.
            std::thread::sleep(Duration::from_millis(20));
            IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
            DONE.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        let (a, b, c, d) = tokio::join!(
            run_clipboard_op(tracked_op),
            run_clipboard_op(tracked_op),
            run_clipboard_op(tracked_op),
            run_clipboard_op(tracked_op),
        );
        assert_eq!((a, b, c, d), (Ok(()), Ok(()), Ok(()), Ok(())));
        assert_eq!(DONE.load(Ordering::SeqCst), 4, "every operation ran");
        assert_eq!(
            PEAK.load(Ordering::SeqCst),
            1,
            "clipboard operations overlapped"
        );
    }

    #[test]
    fn optional_content_classifies_absent_content_without_hiding_failures() {
        assert_eq!(
            optional_content::<u32>(Ok(7)).expect("present content"),
            Some(7)
        );
        assert_eq!(
            optional_content::<u32>(Err(arboard::Error::ContentNotAvailable))
                .expect("absent content"),
            None
        );
        assert!(matches!(
            optional_content::<u32>(Err(arboard::Error::ClipboardNotSupported)),
            Err(arboard::Error::ClipboardNotSupported)
        ));
    }

    /// An absent representation is a successful read, so the cached Linux
    /// handle remains the selection owner for the next representation probe.
    #[cfg(target_os = "linux")]
    #[test]
    fn cached_clipboard_keeps_handle_when_representation_is_absent() {
        struct Handle;

        let mut slot = Some(Handle);
        let result = with_cached_clipboard(
            &mut slot,
            || panic!("a cached handle must not reconnect"),
            |_handle| optional_content::<u32>(Err(arboard::Error::ContentNotAvailable)),
        )
        .expect("an absent representation is not an operation failure");

        assert_eq!(result, None);
        assert!(
            slot.is_some(),
            "an absent representation must keep the cached handle"
        );

        // EVERY production read must classify inside `on_clipboard`; doing it
        // afterwards lets the cache see an error and release the selection.
        // Auto paste probes image first, so the image read is the one an empty
        // clipboard hits before any text read runs.
        let source = include_str!("main.rs");
        let production = source
            .split_once("#[cfg(test)]")
            .expect("main.rs has a test module")
            .0;
        for read in ["c.get_text()", "c.get_image()", "c.get().html()"] {
            let inside_operation = ["on_clipboard(|c| optional_", "content(", read, "))"].concat();
            assert!(
                production.contains(&inside_operation),
                "the {read} read classifies absent content outside the cached operation"
            );
        }
    }

    /// The Linux clipboard handle is connected once and reused, so chan stays
    /// the selection owner and a `cs copy` survives long enough for the
    /// session's clipboard manager to take a copy. A failed operation discards
    /// the handle, so a connection that died with its X session cannot wedge
    /// every later operation.
    #[cfg(target_os = "linux")]
    #[test]
    fn cached_clipboard_reuses_one_handle_and_discards_a_broken_one() {
        use std::cell::Cell;

        /// Stands in for `arboard::Clipboard`: numbered, so an operation can
        /// tell whether it was handed the same handle back.
        struct Handle(u32);

        let connects = Cell::new(0u32);
        let connect = || {
            connects.set(connects.get() + 1);
            Ok::<_, String>(Handle(connects.get()))
        };

        let mut slot: Option<Handle> = None;
        let first = with_cached_clipboard(&mut slot, connect, |h| Ok(h.0)).expect("first op");
        let second = with_cached_clipboard(&mut slot, connect, |h| Ok(h.0)).expect("second op");
        assert_eq!(
            (first, second, connects.get()),
            (1, 1, 1),
            "the handle is connected once and reused"
        );

        // The connect closure panics: reaching it at all would disprove reuse.
        let err = with_cached_clipboard(
            &mut slot,
            || panic!("a cached handle must not reconnect"),
            |_h| Err::<u32, String>("dead connection".into()),
        )
        .expect_err("the operation failed");
        assert_eq!(
            err, "dead connection",
            "the operation's error rides through"
        );
        assert!(slot.is_none(), "a failed operation discards the handle");

        let third = with_cached_clipboard(&mut slot, connect, |h| Ok(h.0)).expect("third op");
        assert_eq!(
            (third, connects.get()),
            (2, 2),
            "the next operation reconnects"
        );
    }

    /// A failed connect surfaces as the operation's error and caches nothing,
    /// so a desktop started without a reachable display server retries instead
    /// of pinning the failure for the life of the process.
    #[cfg(target_os = "linux")]
    #[test]
    fn cached_clipboard_connect_failure_caches_nothing() {
        struct Handle;

        let mut slot: Option<Handle> = None;
        let err = with_cached_clipboard(
            &mut slot,
            || Err::<Handle, String>("no display server".into()),
            |_h| Ok(0u32),
        )
        .expect_err("connect failed");
        assert_eq!(err, "no display server");
        assert!(slot.is_none(), "a failed connect caches nothing");
    }

    /// An operation's own error is the command's error, verbatim: the runner
    /// adds no wrapping the SPA's fallback logic would have to parse.
    #[cfg(not(target_os = "macos"))]
    #[tokio::test]
    async fn clipboard_op_error_rides_through() {
        assert_eq!(
            run_clipboard_op(|| Err::<(), String>("clipboard is empty".into())).await,
            Err("clipboard is empty".into())
        );
    }

    /// A blocking task that dies (a panic inside arboard, or a cancelled task)
    /// becomes an ordinary command error instead of an unwrap on the invoke
    /// path. The panicking task here deliberately never touches the clipboard
    /// guard, so it cannot poison it for the other tests in this binary.
    #[cfg(not(target_os = "macos"))]
    #[tokio::test]
    async fn clipboard_join_failure_becomes_a_command_error() {
        let joined = tauri::async_runtime::spawn_blocking(|| -> Result<(), String> {
            panic!("blocking clipboard task died")
        })
        .await;
        assert!(joined.is_err(), "a panicking blocking task joins as an Err");
        let err = clipboard_join_result(joined).expect_err("join failure maps to an Err");
        assert!(err.contains("clipboard task failed"), "unexpected: {err}");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn merge_path_dirs_keeps_shell_first_and_dedups() {
        // Shell PATH first, inherited dirs appended once, deduped.
        assert_eq!(merge_path_dirs("/a:/b", "/b:/c"), "/a:/b:/c");
        // Empty segments dropped.
        assert_eq!(merge_path_dirs("/a::/b", ""), "/a:/b");
        assert_eq!(merge_path_dirs("", "/x"), "/x");
        assert_eq!(merge_path_dirs("", ""), "");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn wait_for_child_times_out_and_kills_a_hung_process() {
        use std::time::Duration;
        // A shell that never exits stands in for a broken interactive rc.
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .spawn()
            .expect("spawn sleep");
        // 100ms << 30s, so this deterministically takes the timeout branch.
        assert!(!wait_for_child(&mut child, Duration::from_millis(100)));
        // The child was killed + reaped, so its status is already available.
        assert!(matches!(child.try_wait(), Ok(Some(_))));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn wait_for_child_reports_a_fast_exit() {
        use std::time::Duration;
        let mut child = std::process::Command::new("true")
            .spawn()
            .expect("spawn true");
        assert!(wait_for_child(&mut child, Duration::from_secs(5)));
    }

    #[test]
    fn desktop_binary_accepts_hidden_mcp_proxy_command() {
        const MAIN_RS: &str = include_str!("main.rs");
        assert!(MAIN_RS.contains("\"__mcp-proxy\""));
        // The remaining needles appear verbatim in this test's own text, so
        // each is searched in the production region that must hold it rather
        // than in the whole file.
        let boundary = "\n#[cfg(test)]\nmod tests {";
        let production = &MAIN_RS[..MAIN_RS.find(boundary).expect("the boundary is present")];
        let main_body = source_region(
            production,
            "\nfn main() {",
            "linux_gui_stack::prefer_system_gui_stack();",
        );
        assert!(main_body.contains("run_hidden_mcp_proxy_if_requested()"));
        let dispatch = source_region(
            production,
            "\nfn run_hidden_mcp_proxy_if_requested(",
            "\nfn run_as_cs_if_requested(",
        );
        assert!(dispatch.contains("run_mcp_proxy(socket)"));
        let proxy = source_region(
            production,
            "\nasync fn run_mcp_proxy(",
            "\n/// Windows console attach",
        );
        assert!(proxy.contains("chan_server::run_mcp_stdio_proxy"));
    }

    /// The `--version` probe is what makes this binary's build id readable
    /// without a display, and its POSITION is the behaviour. The Nix package
    /// symlinks `bin/chan` at this same binary, so a probe that ran before the
    /// stem dispatch would answer `chan --version` with the desktop id and
    /// hide whether the `chan` crate ever received one. Both ids come from one
    /// derivation and carry the same value, so that substitution is invisible
    /// in the output and would go green on exactly the half-fix the packaging
    /// item exists to prevent.
    #[test]
    fn caller_cwd_restore_runs_before_every_dispatch() {
        // The AppImage's AppRun chdirs into the mount; the restore must run
        // ahead of every dispatch (MCP proxy, cs, chan, --version, the GUI)
        // or a relative CLI path resolves inside the mount again.
        const MAIN_RS: &str = include_str!("main.rs");
        let boundary = "\n#[cfg(test)]\nmod tests {";
        let production = &MAIN_RS[..MAIN_RS.find(boundary).expect("the boundary is present")];
        let main_body = source_region(
            production,
            "\nfn main() {",
            "linux_gui_stack::prefer_system_gui_stack();",
        );
        let restore = main_body
            .find("cs_install::restore_caller_cwd()")
            .expect("main restores the caller's cwd");
        for probe in [
            "run_hidden_mcp_proxy_if_requested()",
            "run_as_cs_if_requested()",
            "run_as_chan_if_requested()",
            "print_version_if_requested()",
        ] {
            let at = main_body
                .find(probe)
                .unwrap_or_else(|| panic!("main dispatches {probe}"));
            assert!(
                restore < at,
                "the caller-cwd restore must run before {probe}"
            );
        }
    }

    #[test]
    fn desktop_version_probe_runs_after_the_cli_stem_probes() {
        const MAIN_RS: &str = include_str!("main.rs");
        let boundary = "\n#[cfg(test)]\nmod tests {";
        let production = &MAIN_RS[..MAIN_RS.find(boundary).expect("the boundary is present")];
        let main_body = source_region(
            production,
            "\nfn main() {",
            "linux_gui_stack::prefer_system_gui_stack();",
        );

        let stem_probe = main_body
            .find("run_as_chan_if_requested()")
            .expect("main dispatches the chan stem before the GUI");
        let version_probe = main_body
            .find("print_version_if_requested()")
            .expect("main probes --version before the GUI");
        assert!(
            version_probe > stem_probe,
            "the --version probe must run after the chan stem probe"
        );

        // It must report the DESKTOP id, not the one the linked-in chan crate
        // carries, and in the shape smoke-nix-package.sh parses.
        let probe = source_region(
            production,
            "\nfn print_version_if_requested()",
            "\n/// Cross-platform MCP-proxy short-circuit",
        );
        assert!(probe.contains("CHAN_DESKTOP_BUILD_ID"));
        assert!(probe.contains("(build {})"));
    }

    #[test]
    fn desktop_setup_reaps_old_generated_download_temps() {
        const MAIN_RS: &str = include_str!("main.rs");
        let setup = source_region(
            MAIN_RS,
            concat!(".setup(move |app|", " {"),
            concat!(".invoke_", "handler"),
        );
        assert!(setup.contains("tauri::async_runtime::spawn_blocking"));
        assert!(setup.contains("download::reap_orphaned_download_temps("));
        assert!(setup.contains("std::time::Duration::from_secs(60 * 60)"));
    }

    #[test]
    fn control_script_clean_exit_reaps_and_failed_exit_keeps_terminal() {
        const MAIN_RS: &str = include_str!("main.rs");
        let request_close = source_region(
            MAIN_RS,
            "\nasync fn request_close_window(",
            concat!("let others", "_remain"),
        );
        assert!(request_close.contains("close_devserver_control_terminal"));
        assert!(!request_close.contains("devserver-control-closed"));

        // Only a status-0 exit counts as clean, and the post-token liveness
        // probe lets a clean (daemonizing) script return through while still
        // failing everything else.
        let clean = source_region(
            MAIN_RS,
            "\nfn control_script_exit_is_clean(",
            "\nfn ensure_control_run_live(",
        );
        assert!(clean.contains("TerminalExit::Code { code: 0 }"));
        let ensure = source_region(
            MAIN_RS,
            "\nfn ensure_control_run_live(",
            "\n/// Watch a scripted devserver",
        );
        assert!(ensure.contains("control_script_exit_is_clean"));

        // The token scrape reads the scrollback BEFORE the exit probe: a
        // daemonizing script prints the token and returns inside one poll
        // window, and the printed token must win over the exit behind it.
        let scrape = source_region(
            MAIN_RS,
            "\nasync fn scrape_control_terminal_token(",
            "\nfn control_run_is_current(",
        );
        let token_pos = scrape
            .find("scrape_token")
            .expect("scrape reads the scrollback");
        let exit_pos = scrape
            .find("control_terminal_exit")
            .expect("scrape probes the script exit");
        assert!(token_pos < exit_pos);

        // Exit watcher: a CLEAN exit with the connection up splits on the
        // registration age. Within the handshake grace it is the daemonizing
        // script returning: auto-reap the control terminal, keep the
        // connection (no down-mark, no reconnect block). Past the grace the
        // script WAS the transport, so the whole connection tears down:
        // windows closed, control terminal reaped, launcher shows. A failing
        // or premature exit closes the windows but keeps the control terminal
        // via mark_devserver_control_exited so the user can read the death
        // reason. A clean exit during an in-flight connect defers judgment
        // until the connect resolves, and that deferral must come BEFORE the
        // is_connected gate: reaping mid-connect fails the attempt's own
        // liveness checks.
        let exit_watcher = source_region(
            MAIN_RS,
            "\nfn spawn_control_terminal_exit_watcher(",
            "\n/// Connect to a configured devserver",
        );
        assert!(exit_watcher.contains("control_script_exit_is_clean"));
        assert!(!exit_watcher.contains("control_terminal_dead"));
        assert!(!exit_watcher.contains("devserver-control-closed"));
        let connecting_pos = exit_watcher
            .find("devserver_connecting")
            .expect("watcher defers a clean exit while a connect is in flight");
        let connected_pos = exit_watcher
            .find("devservers.is_connected")
            .expect("watcher gates the clean-exit split on a live connection");
        assert!(connecting_pos < connected_pos);
        // The grace split: the registration-age read gates the two clean
        // endings, the within-grace reap-and-keep before the past-grace full
        // teardown.
        let grace_pos = exit_watcher
            .find("registered_elapsed")
            .expect("watcher reads the registration age");
        let reap_pos = exit_watcher
            .find("reap_devserver_control_terminal")
            .expect("a within-grace clean exit reaps the control terminal");
        let teardown_pos = exit_watcher
            .find("teardown_devserver_connection")
            .expect("a past-grace clean exit tears the connection down");
        assert!(connected_pos < grace_pos);
        assert!(grace_pos < reap_pos);
        assert!(reap_pos < teardown_pos);
        // The failing-exit compose: the windows close THROUGH the still-
        // registered window watcher (CloseWindows) BEFORE the mark retires
        // that watcher keeping its windows; the reverse order leaks the
        // windows open against a dead transport.
        let close_windows_pos = exit_watcher
            .find("remove_devserver_windows")
            .expect("a failing exit closes the workspace windows");
        let mark_pos = exit_watcher
            .find("mark_devserver_control_exited")
            .expect("a failing exit keeps the control terminal");
        assert!(close_windows_pos < mark_pos);
        // The watcher owns script death END-TO-END: it never reconnects and
        // never spawns a replacement control terminal. Only an explicit user
        // Connect runs the script again; the SPA-side wake-recycle guard
        // (recyclePtySocketAfterWake's ui.terminalControl early return)
        // relies on this ownership staying one-sided.
        assert!(!exit_watcher.contains("reconnect_devserver"));
        assert!(!exit_watcher.contains("spawn_control_terminal_window"));

        // mark_devserver_control_exited (the failed-exit keep primitive) keeps
        // the control terminal and does no window closure of its own (the exit
        // watcher composes that ahead of it), retires the watcher KEEPING the
        // workspace windows, and blocks reconnect via control_terminal_dead.
        let mark_exited = source_region(
            MAIN_RS,
            "\nfn mark_devserver_control_exited(",
            "\nasync fn close_devserver_control_terminal(",
        );
        assert!(mark_exited.contains("control_terminal_dead"));
        assert!(mark_exited.contains("RetireKeepWindows"));
        assert!(!mark_exited.contains("reap_devserver_control_terminal"));
        assert!(!mark_exited.contains("remove_devserver_windows"));
        // Marking bails when no current control run exists: keeping requires
        // something to keep, and a stale mark (racing a close/reconnect that
        // reaped the run) must not strand the reconnect block on nothing.
        assert!(mark_exited.contains("control_terminal_runs"));
        // A dead script means no transport: hide the devserver's workspace +
        // window rows from the launcher (the kept control row is a registry
        // row, not a feed row, so it survives to show the death reason).
        assert!(mark_exited.contains("set_down(id, true)"));
        // The connect wait aborts on a FAILING control-script death instead of
        // pinning the launcher's Connect spinner for the full come-up budget
        // (the liveness probe lets a clean return keep dialing).
        let wait = source_region(
            MAIN_RS,
            "\nasync fn wait_for_devserver(",
            "\nenum ConnectDevserverError",
        );
        assert!(wait.contains("if let Some(e) = abort()"));

        // A dead control terminal blocks a plain connect; closing it clears
        // the block.
        let connect = source_region(
            MAIN_RS,
            "\nasync fn connect_devserver_impl(",
            "\nasync fn connect_devserver_impl_inner(",
        );
        assert!(connect.contains("control_terminal_dead"));
        // The block is only honored while its terminal exists; a stranded flag
        // (window gone) self-heals at the connect chokepoint instead of walling
        // off connect with an instruction the user cannot follow.
        assert!(connect.contains("control_terminal_dead.lock().unwrap().remove(&id)"));
        // The connect error arm keeps a still-open control terminal (the exit
        // watcher's choice, which its ControlTerminated error races) and only
        // tears down when the user closed the window mid-connect.
        assert!(connect.contains("control_window_live"));
        // A full teardown clears the reconnect block: the block must never
        // outlive the control terminal it tells the user to close.
        let teardown = source_region(
            MAIN_RS,
            "\nasync fn teardown_devserver_connection(",
            "\nfn mark_devserver_control_exited(",
        );
        assert!(teardown.contains("control_terminal_dead"));
        let close = source_region(
            MAIN_RS,
            "\nasync fn close_devserver_control_terminal(",
            "\nfn persist_window_hidden(",
        );
        assert!(close.contains("control_terminal_dead"));

        // Abandon is kill-then-disconnect: one unconditional teardown, whose
        // control-terminal reap kills a still-running connect script before
        // the connection state and windows drop.
        let abandon = source_region(
            MAIN_RS,
            "\nasync fn abandon_devserver_for_window(",
            "\n/// Reconnect the devserver backing",
        );
        assert!(abandon.contains("teardown_devserver_connection"));

        // Reconnect is kill-then-disconnect-then-connect: an unconditional
        // teardown (killing a running script and clearing connection state so
        // the dial is not no-opped by the is_connected guard) BEFORE the
        // connect, gated only on no connect already being in flight.
        let reconnect = source_region(
            MAIN_RS,
            "\nasync fn reconnect_devserver_for_window(",
            "\nfn library_id_for_window_label(",
        );
        assert!(reconnect.contains("devserver_connecting"));
        assert!(!reconnect.contains("close_devserver_control_terminal"));
        let teardown_pos = reconnect
            .find("teardown_devserver_connection")
            .expect("reconnect tears the connection down first");
        let connect_pos = reconnect
            .find("connect_devserver_impl")
            .expect("reconnect then dials");
        assert!(teardown_pos < connect_pos);
    }

    #[test]
    fn gateway_signin_wait_rides_the_gateway_flow() {
        // The browser hand-off lives at the GATEWAY level: the sign-in leg
        // stamps a pending wait whose timeout expires only its own attempt
        // (a re-click's fresh wait survives an old timer).
        const GATEWAY_RS: &str = include_str!("gateway.rs");
        let leg = source_region(
            GATEWAY_RS,
            "\nfn signin_leg",
            "\n/// Resume after a sign-in callback",
        );
        assert!(leg.contains("GATEWAY_SIGNIN_TIMEOUT"));
        assert!(leg.contains("rt.signin_stamp == stamp"));
        // A rostered row's 401 runs the gateway cascade (which clears the
        // dead PAT) instead of opening a per-row sign-in. The start bound is
        // parenless: the definition is generic, so its open paren does not
        // follow the name directly.
        const MAIN_RS: &str = include_str!("main.rs");
        let connect = source_region(
            MAIN_RS,
            "\nasync fn rostered_conn",
            "\nasync fn connect_devserver_impl_inner(",
        );
        assert!(connect.contains("GatewayEntryError::Unauthorized"));
        assert!(connect.contains("cascade_disconnect"));
    }

    #[test]
    fn workspace_poll_emits_control_attention_while_still_connected() {
        const MAIN_RS: &str = include_str!("main.rs");
        let poll = source_region(
            MAIN_RS,
            "\nfn spawn_devserver_workspace_poll(",
            "\n/// Register `path` with the shared embedded Library",
        );
        assert!(poll.contains("DEVSERVER_CONTROL_ATTENTION_EVENT"));
        assert!(poll.contains("DEVSERVER_CONTROL_RESTORED_EVENT"));
        assert!(poll.contains("state.devservers.is_connected(&id)"));
        // A failed poll marks the devserver DOWN (the launcher hides its
        // workspace + window rows immediately); a successful poll clears it.
        assert!(poll.contains("set_down(&id, true)"));
        assert!(poll.contains("set_down(&id, false)"));
    }

    #[test]
    fn devserver_disconnect_closes_its_windows() {
        // A disconnect stops the watcher AND closes the devserver's native
        // windows; only the control-exit path retires the watcher and keeps
        // them (pinned by the control-exit test above).
        const MAIN_RS: &str = include_str!("main.rs");
        let disconnect = source_region(
            MAIN_RS,
            "\nfn remove_devserver_windows(",
            "\n/// Error marker for native access",
        );
        assert!(disconnect.contains("DevserverWatcherStop::CloseWindows"));
    }

    #[test]
    fn every_devserver_connect_wires_its_watcher_through_one_helper() {
        const MAIN_RS: &str = include_str!("main.rs");
        let (production, _) = MAIN_RS
            .split_once("\n#[cfg(test)]\nmod tests {")
            .expect("the test module separates the production code");
        assert_eq!(
            production.matches("wire_devserver_watcher(").count(),
            3,
            "one definition and two connect calls",
        );
        // Both connect paths share one post-watcher sequence (down flag,
        // snapshot, poll, colour watch, view and stop handle), so each must
        // call the helper and none may register the snapshot on its own.
        for (start, end, seeds_rows) in [
            (
                "\nasync fn connect_rostered_devserver(",
                "\nasync fn connect_devserver_impl_inner(",
                true,
            ),
            (
                "\nasync fn connect_devserver_impl_inner(",
                "\npub(crate) async fn open_devserver_workspace_impl(",
                false,
            ),
        ] {
            let connect = source_region(MAIN_RS, start, end);
            assert!(
                connect.contains("wire_devserver_watcher("),
                "{start:?} wires its watcher through the helper"
            );
            assert!(
                !connect.contains("register_windows("),
                "{start:?} registers no window snapshot on its own"
            );
            assert_eq!(connect.matches("wire_devserver_watcher(").count(), 1);
            let (_, call) = connect.split_once("wire_devserver_watcher(").unwrap();
            let (args, _) = call.split_once(");").expect("the helper call ends");
            assert_eq!(
                args.contains("Some("),
                seeds_rows,
                "only the rostered connect passes workspace rows: {start:?}",
            );
            assert!(args.contains(if seeds_rows { "Some(rows)" } else { "None" }));
        }

        let wiring = source_region(
            MAIN_RS,
            "\nfn wire_devserver_watcher(",
            "\nfn spawn_devserver_workspace_poll(",
        );
        let register = wiring
            .find("register_windows(")
            .expect("register the snapshot");
        let seed = wiring
            .find("set_workspaces(")
            .expect("seed the workspace rows");
        let poll = wiring
            .find("spawn_devserver_workspace_poll(")
            .expect("start the workspace poll");
        assert!(
            register < seed && seed < poll,
            "register the snapshot before seeding rows, and seed before starting the poll",
        );
    }

    #[test]
    fn seed_library_id_resolves_before_any_window_arrives() {
        // On connect the desktop already knows the
        // devserver's library_id (from `wait_for_devserver`'s info) before any
        // window snapshot exists. Seeding it must make `library_id_of` resolve
        // immediately so the launcher's `DevserverEntry` carries the real id from
        // the FIRST render and groups the control row under its parent devserver  --
        // instead of a blank `↗` until a later window syncs the mapping.
        let feed = DevserverFeed::default();
        // No window snapshot yet → unresolvable without the seed.
        assert_eq!(feed.library_id_of("ds-1"), None);
        feed.seed_library_id("ds-1".to_string(), "lib-abc123".to_string());
        assert_eq!(feed.library_id_of("ds-1"), Some("lib-abc123".to_string()));
        // The seed is per-devserver; an unrelated id stays unresolved.
        assert_eq!(feed.library_id_of("ds-2"), None);
    }

    #[test]
    fn devserver_window_label_lookup_uses_cached_library_id() {
        let feed = DevserverFeed::default();
        feed.seed_library_id("ds-1".to_string(), "lib-fed".to_string());

        assert_eq!(
            devserver_library_id_from_window_label("lib-fed::w-1"),
            Some("lib-fed"),
        );
        assert_eq!(
            devserver_id_for_window_label(&feed, "lib-fed::w-1").as_deref(),
            Some("ds-1"),
        );
        assert_eq!(devserver_id_for_window_label(&feed, "local::w-1"), None);
        assert_eq!(devserver_id_for_window_label(&feed, "lib-fed"), None);
    }

    /// The library-window commands scope every action to the library named by
    /// the CALLER'S OWN label, so this mapping is the authority boundary: a
    /// window that resolves to the wrong library, or to one at all when it
    /// should not, reaches windows that are not its own.
    #[test]
    fn window_label_resolves_only_its_own_library() {
        assert_eq!(library_id_for_window_label("local::w-1"), Some("local"));
        assert_eq!(
            library_id_for_window_label("lib-0a1b::w-1"),
            Some("lib-0a1b")
        );
        // Windows that own no library must resolve to none rather than
        // defaulting into one.
        for label in [
            "main",
            "about",
            "unmanaged-1a2b",
            "terminal-1a2b",
            "control-terminal-1a2b",
            "lib-0a1b",
            "settings",
            // A label whose prefix merely resembles a library id.
            "library::w-1",
            "locals::w-1",
        ] {
            assert_eq!(library_id_for_window_label(label), None, "{label}");
        }
    }

    #[test]
    fn desktop_update_ready_payload_serializes_version_and_installed() {
        let payload = DesktopUpdateReadyPayload {
            version: "0.66.0".to_string(),
            installed: true,
        };
        assert_eq!(
            serde_json::to_value(payload).expect("payload serializes"),
            serde_json::json!({ "version": "0.66.0", "installed": true }),
        );
        let staged = DesktopUpdateReadyPayload {
            version: "0.66.0".to_string(),
            installed: false,
        };
        assert_eq!(
            serde_json::to_value(staged).expect("payload serializes"),
            serde_json::json!({ "version": "0.66.0", "installed": false }),
        );
    }

    #[test]
    fn windows_updater_refuses_a_build_outside_an_install() {
        assert_eq!(windows_updater_refusal(true), None);
        let reason = windows_updater_refusal(false).expect("a dev build refuses");
        assert!(reason.contains("installed chan-desktop"), "{reason}");
        assert!(!reason.contains("chan upgrade"), "{reason}");
    }

    #[test]
    fn windows_update_refuses_while_a_self_managed_devserver_runs() {
        // The daemon runs from the install's own chan.exe; the installer
        // cannot overwrite a mapped image, so both drivers refuse with the
        // pid and the command that clears it. No daemon: no refusal.
        assert_eq!(windows_devserver_daemon_refusal(None), None);
        let reason = windows_devserver_daemon_refusal(Some(4242)).expect("a live daemon refuses");
        assert!(reason.contains("4242"), "{reason}");
        assert!(reason.contains("chan devserver stop"), "{reason}");
    }

    #[test]
    fn linux_updater_refuses_outside_an_appimage() {
        assert_eq!(
            linux_updater_refusal(Some(std::path::Path::new("/home/u/Chan.AppImage"))),
            None,
        );
        let reason = linux_updater_refusal(None).expect("a non-AppImage build refuses");
        assert!(reason.contains("AppImage"), "{reason}");
        assert!(!reason.contains("chan upgrade"), "{reason}");
    }

    #[test]
    fn connecting_probe_classifies_gateway_and_loopback_responses() {
        use reqwest::StatusCode;

        assert_eq!(
            probe_target_kind("http://127.0.0.1:4000/workspace"),
            ProbeTargetKind::Loopback,
        );
        assert_eq!(
            probe_target_kind("http://[::1]:4000/workspace"),
            ProbeTargetKind::Loopback,
        );
        assert_eq!(
            probe_target_kind("https://alice--0123456789ab.proxy.example/workspace"),
            ProbeTargetKind::Gateway,
        );

        for status in [
            StatusCode::BAD_GATEWAY,
            StatusCode::SERVICE_UNAVAILABLE,
            StatusCode::GATEWAY_TIMEOUT,
        ] {
            assert!(!probe_response_reachable(
                ProbeTargetKind::Gateway,
                Some(status),
            ));
            assert!(probe_response_reachable(
                ProbeTargetKind::Loopback,
                Some(status),
            ));
        }
        for status in [
            StatusCode::UNAUTHORIZED,
            StatusCode::FORBIDDEN,
            StatusCode::NOT_FOUND,
        ] {
            assert!(probe_response_reachable(
                ProbeTargetKind::Gateway,
                Some(status),
            ));
        }
        assert!(!probe_response_reachable(ProbeTargetKind::Gateway, None));
        assert!(!probe_response_reachable(ProbeTargetKind::Loopback, None,));
    }

    #[test]
    fn desktop_update_uses_event_and_narrow_restart_command() {
        const MAIN_RS: &str = include_str!("main.rs");
        assert!(
            MAIN_RS.contains("const DESKTOP_UPDATE_READY_EVENT: &str = \"desktop-update-ready\"")
        );
        // These needles are searched in the production half: each appears
        // verbatim in this test's own text, which the whole file includes.
        let (production, _) = MAIN_RS
            .split_once("\n#[cfg(test)]\nmod tests {")
            .expect("the test module separates the production code");
        assert!(production.contains("fn notify_desktop_update_ready"));
        assert!(production.contains("fn restart_desktop_after_update"));
        assert!(production.contains("restart_desktop_after_update,"));
        assert!(
            !MAIN_RS.contains(concat!("prompt_restart", "_for_update")),
            "update-ready prompt must not use the native restart alert path",
        );
    }

    #[test]
    fn pane_color_resolves_once_colour_cached_and_window_seeded() {
        // A devserver window seeds its `?pane=` colour through
        // `pane_color`, which maps library_id -> devserver id via a registered
        // window snapshot, then reads the per-devserver colour cache. On a FRESH
        // connect that cache is cold until the async colour watch pushes its first
        // frame, so the first windows seeded `None` and flashed blue. Connect now warms the
        // cache eagerly on connect (`fetch_local_color` -> `set_color` before the
        // window watcher opens anything); this pins the resolution the seed relies
        // on.
        use chan_server::DevserverFeedSource;
        let feed = DevserverFeed::default();
        let lib = "lib-deadbeef";
        let snapshot = Arc::new(Mutex::new(vec![chan_server::WindowRecord {
            window_id: "w-1".into(),
            library_id: lib.into(),
            kind: chan_server::WindowKind::Terminal,
            title: "Terminal".into(),
            ordinal: 1,
            label: String::new(),
            workspace_path: None,
            prefix: "/lib".into(),
            token: "tok".into(),
            persisted: true,
            connected: true,
            active_transfer: false,
            control: false,
            hidden: false,
            origin: chan_server::WindowOrigin::Native,
        }]));
        feed.register_windows("ds-1".to_string(), snapshot);
        // Cache cold during a fresh connect -> the window seeds None (blue).
        assert_eq!(feed.pane_color(lib), None);
        // Eager seed warms the cache -> the first window seeds the colour.
        feed.set_color("ds-1".to_string(), Some("#ff8800".to_string()));
        assert_eq!(feed.pane_color(lib), Some("#ff8800".to_string()));
        // A genuine clear (the devserver dropped its colour) still
        // propagates -- a null push removes the cache so new windows fall
        // back to the accent. The web live-apply side ignores every null and
        // keeps its current colour, but the desktop cache must reflect a real
        // clear, so the eager seed must not blanket-ignore nulls.
        feed.set_color("ds-1".to_string(), None);
        assert_eq!(feed.pane_color(lib), None);
    }

    #[test]
    fn devserver_feed_resolves_current_record_by_native_label() {
        let feed = DevserverFeed::default();
        let snapshot = Arc::new(Mutex::new(vec![chan_server::WindowRecord {
            window_id: "w-1".into(),
            library_id: "lib-fed".into(),
            kind: chan_server::WindowKind::Terminal,
            title: "Terminal".into(),
            ordinal: 1,
            label: String::new(),
            workspace_path: None,
            prefix: "/terminal".into(),
            token: "fresh-token".into(),
            persisted: true,
            connected: true,
            active_transfer: false,
            control: false,
            hidden: false,
            origin: chan_server::WindowOrigin::Native,
        }]));
        feed.register_windows("ds-1".to_string(), snapshot);

        let (id, record) = feed
            .record_for_native_label("lib-fed::w-1")
            .expect("record by native label");

        assert_eq!(id, "ds-1");
        assert_eq!(record.token, "fresh-token");
        assert!(feed.record_for_native_label("lib-fed::w-9").is_none());
    }

    #[test]
    fn devserver_feed_resolves_a_rostered_devserver_for_the_close_discard() {
        // A gateway-rostered devserver registers its conn under a SYNTHESIZED
        // id (`gw:<8hex>:<owner>:<devserver_id>`) that never lives in the
        // persisted `cfg.devservers` vec, so the close/discard paths must
        // resolve the owning conn from the window feed -- where the rostered
        // id is the registration key -- or the DELETE silently never fires and
        // the record reconciles back open as a new window.
        let feed = DevserverFeed::default();
        let rostered = "gw:9f2c1a44:alice:9e314b8e58ea";
        let snapshot = Arc::new(Mutex::new(vec![chan_server::WindowRecord {
            window_id: "w-86fd".into(),
            library_id: "lib-f978".into(),
            kind: chan_server::WindowKind::Terminal,
            title: "Terminal".into(),
            ordinal: 1,
            label: String::new(),
            workspace_path: None,
            prefix: "/terminal".into(),
            token: "tok".into(),
            persisted: true,
            connected: true,
            active_transfer: false,
            control: false,
            hidden: false,
            origin: chan_server::WindowOrigin::Native,
        }]));
        feed.register_windows(rostered.to_string(), snapshot);

        // The close-cascade discard matches the composite native label.
        let (id, record) = feed
            .record_for_native_label("lib-f978::w-86fd")
            .expect("rostered record by native label");
        assert_eq!(id, rostered);
        assert_eq!(record.window_id, "w-86fd");

        // The `cs window rm` discard matches the BARE window_id.
        let (id, record) = feed
            .record_for_window_id("w-86fd")
            .expect("rostered record by bare window_id");
        assert_eq!(id, rostered);
        assert_eq!(record.library_id, "lib-f978");
        assert!(feed.record_for_window_id("w-none").is_none());
    }

    #[test]
    fn devserver_close_paths_resolve_conns_from_the_feed_not_the_config() {
        // The persisted `cfg.devservers` vec never carries rostered gateway
        // devservers, so any conn resolution that walks it silently skips
        // them; the close path must resolve through the feed.
        const MAIN_RS: &str = include_str!("main.rs");
        let close = source_region(
            MAIN_RS,
            "\nasync fn request_close_window(",
            "\nfn hide_window_from_close_confirm(",
        );
        assert!(close.contains("record_for_native_label"));
        assert!(!close.contains("cfg.devservers"));
        let by_id = source_region(
            MAIN_RS,
            "\nasync fn discard_devserver_window_by_id(",
            "\nconst LAUNCHER_WINDOW_TITLE",
        );
        assert!(by_id.contains("record_for_window_id"));
        assert!(!by_id.contains("cfg.devservers"));
    }

    #[test]
    fn devserver_window_close_records_pending_delete_before_destroy() {
        const MAIN_RS: &str = include_str!("main.rs");
        let close = source_region(
            MAIN_RS,
            "\nasync fn request_close_window(",
            "\nfn hide_window_from_close_confirm(",
        );
        let lib_branch = close
            .split("if closing.starts_with(\"lib-\")")
            .nth(1)
            .expect("devserver close branch exists");
        let pending = lib_branch
            .find("pending_window_deletes")
            .expect("records the pending delete");
        let bury = lib_branch
            .find("view.bury(&label)")
            .expect("suppresses a racing reconcile");
        let attempt = lib_branch
            .find("spawn_pending_window_delete_attempt")
            .expect("starts the first delete attempt");
        let destroy = lib_branch
            .find("window.destroy()")
            .expect("destroys the webview");
        assert!(pending < bury);
        assert!(bury < attempt);
        assert!(attempt < destroy);
        assert!(!lib_branch.contains("view.unbury"));

        let runner = source_region(
            MAIN_RS,
            "\npub(crate) fn spawn_pending_window_delete_attempt(",
            "\nasync fn discard_devserver_window_by_id(",
        );
        assert!(runner.contains("PendingDeleteFinish::Exhausted"));
        assert!(runner.contains("It remains closed for this desktop session."));
    }

    #[test]
    fn down_devserver_serves_no_launcher_rows_until_recovery() {
        // A DOWN devserver (control script exited, or the workspace poll finds
        // the transport unreachable) must serve NO workspace or window rows to
        // the launcher: every affordance on them (open / hide / on / off)
        // needs the connection that is gone. The caches survive underneath so
        // recovery restores the rows without a refetch, and bridge label
        // resolution keeps working for the native windows that stay open on
        // the reconnect overlay.
        use chan_server::DevserverFeedSource;
        let feed = DevserverFeed::default();
        let snapshot = Arc::new(Mutex::new(vec![chan_server::WindowRecord {
            window_id: "w-1".into(),
            library_id: "lib-fed".into(),
            kind: chan_server::WindowKind::Terminal,
            title: "Terminal".into(),
            ordinal: 1,
            label: String::new(),
            workspace_path: None,
            prefix: "/terminal".into(),
            token: "tok".into(),
            persisted: true,
            connected: true,
            active_transfer: false,
            control: false,
            hidden: false,
            origin: chan_server::WindowOrigin::Native,
        }]));
        feed.register_windows("ds-1".to_string(), snapshot);
        feed.set_workspaces(
            "ds-1".to_string(),
            vec![chan_server::LauncherWorkspace {
                workspace_id: "notes".into(),
                path: "/remote/notes".into(),
                label: "notes".into(),
                on: true,
                library_id: Some("lib-fed".into()),
                devserver_id: Some("ds-1".into()),
                prefix: "notes".into(),
                status: Default::default(),
                error: None,
            }],
        );
        assert_eq!(feed.windows().len(), 1);
        assert_eq!(feed.workspaces().len(), 1);
        // Down hides every launcher row for the devserver...
        assert!(feed.set_down("ds-1", true));
        assert!(feed.windows().is_empty());
        assert!(feed.workspaces().is_empty());
        // ...while bridge ops still resolve the live native labels.
        assert_eq!(feed.window_labels(), vec!["lib-fed::w-1".to_string()]);
        // Recovery restores the cached rows in place.
        assert!(feed.set_down("ds-1", false));
        assert_eq!(feed.windows().len(), 1);
        assert_eq!(feed.workspaces().len(), 1);
        // forget (full teardown) clears the flag so a reconnect starts clean.
        feed.set_down("ds-1", true);
        feed.forget("ds-1");
        assert!(
            !feed.set_down("ds-1", false),
            "forget must clear the down flag",
        );
    }

    #[test]
    fn devserver_url_token_reads_t_only() {
        assert_eq!(
            devserver_url_token("http://127.0.0.1:8787/?t=tok_abc").as_deref(),
            Some("tok_abc")
        );
        assert_eq!(
            devserver_url_token("http://127.0.0.1:8787/?token=tok_abc"),
            None
        );
    }

    #[test]
    fn window_numbers_are_lowest_free_per_base_with_reuse() {
        let mut numbers: HashMap<String, (String, u64)> = HashMap::new();
        // Helper mirroring AppState::assign_window_number against the
        // local map (the method just locks + delegates to the same
        // free function).
        let assign = |numbers: &mut HashMap<String, (String, u64)>, label: &str, base: &str| {
            let n = lowest_free_window_number(numbers, label, base);
            numbers.insert(label.to_string(), (base.to_string(), n));
            n
        };

        // First two terminal windows get 1, 2.
        assert_eq!(assign(&mut numbers, "local::w-t0", "Terminal"), 1);
        assert_eq!(assign(&mut numbers, "local::w-t1", "Terminal"), 2);
        // A different base title starts its own sequence at 1.
        assert_eq!(assign(&mut numbers, "local::w-w0", "🏠 /w"), 1);

        // Free the first terminal; the next terminal reuses 1, not 3.
        numbers.remove("local::w-t0");
        assert_eq!(assign(&mut numbers, "local::w-t2", "Terminal"), 1);
        // The unrelated base is untouched by the terminal churn.
        assert_eq!(assign(&mut numbers, "local::w-w1", "🏠 /w"), 2);

        // Re-assigning a live label keeps its slot (ignores itself).
        assert_eq!(assign(&mut numbers, "local::w-t1", "Terminal"), 2);
    }

    #[test]
    fn quit_is_gated_behind_a_confirmation_while_windows_exist() {
        // Cmd+Q / Quit must prompt while any SPA window (open or
        // buried) exists. The confirmation runs BEFORE any exit is
        // requested (`request_quit` behind the custom chan-quit item):
        // the macOS PREDEFINED Quit exits through a flow prevent_exit
        // cannot reliably stop, so it must be stripped and replaced.
        // concat! so the pins don't match this test's source.
        const MAIN_RS: &str = include_str!("main.rs");
        // The custom item exists with the Cmd+Q accelerator and routes
        // to request_quit; the predefined one is stripped by text.
        assert!(MAIN_RS.contains(concat!("fn request", "_quit(app: &tauri::AppHandle)")));
        assert!(MAIN_RS.contains(concat!("accelerator(\"CmdOrCtrl", "+Q\")")));
        assert!(MAIN_RS.contains(concat!("text.contains(", "\"quit\")")));
        // The ExitRequested backstop still guards non-menu exit paths.
        assert!(MAIN_RS.contains(concat!("RunEvent::Exit", "Requested { api, .. }")));
        assert!(MAIN_RS.contains(concat!("api.prevent", "_exit();")));
        assert!(MAIN_RS.contains(concat!("quit_", "confirmed.load")));
    }

    #[test]
    fn launcher_is_a_singleton_with_an_unsuffixed_title() {
        // Launchers are never multiplied (Cmd/Ctrl+Shift+N on the
        // launcher opens a standalone terminal window), so the title
        // carries no "Window N" suffix and no main-N spawner exists.
        assert_eq!(LAUNCHER_WINDOW_TITLE, "Chan Desktop");
        // concat! so the pin doesn't match its own assertion source.
        const MAIN_RS: &str = include_str!("main.rs");
        assert!(!MAIN_RS.contains(concat!("fn ", "open_new_launcher_window")));
        assert!(!MAIN_RS.contains(concat!("fn ", "next_launcher_label")));
    }

    #[test]
    fn launcher_uses_compact_default_and_minimum_geometry() {
        assert_eq!(LAUNCHER_DEFAULT_WIDTH, 420.0);
        assert_eq!(LAUNCHER_DEFAULT_HEIGHT, 720.0);
        assert_eq!(LAUNCHER_MIN_WIDTH, 420.0);
        assert_eq!(LAUNCHER_MIN_HEIGHT, 420.0);
    }

    #[test]
    fn launcher_geometry_is_captured_on_quit() {
        const MAIN_RS: &str = include_str!("main.rs");
        assert!(MAIN_RS.contains(concat!("fn capture", "_launcher_geometry")));
        assert!(MAIN_RS.contains(concat!("RunEvent::Exit", "Requested { api, .. }")));
        assert!(MAIN_RS.contains(concat!("RunEvent::", "Exit =>")));
        assert!(MAIN_RS.contains(concat!("capture", "_launcher_geometry(_app);")));
        assert!(MAIN_RS.contains(concat!("capture", "_launcher_geometry(app);")));
        assert!(MAIN_RS.contains(concat!("capture", "_launcher_geometry(&app_for_reply);")));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn off_mac_the_menubar_lives_on_the_launcher_alone() {
        const MAIN_RS: &str = include_str!("main.rs");
        // The launcher menu item says what it does.
        assert!(MAIN_RS.contains("\"New Standalone Terminal\""));
        // The per-window-kind menu machinery is gone: no workspace
        // hamburger-mirror menu, no owned terminal/control shapes, and no
        // label-encoded id namespaces to route them. concat! so the
        // absence pins don't match this test's own source.
        for gone in [
            concat!("build_workspace", "_menu"),
            concat!("WS_NEW_WINDOW_MENU_ID", "_PREFIX"),
            concat!("WS_CLOSE_WINDOW_MENU_ID", "_PREFIX"),
            concat!("WS_OPEN_IN_BROWSER_MENU_ID", "_PREFIX"),
            concat!("WORKSPACE_CMD_MENU_ID", "_PREFIX"),
            concat!("wsc", "md:"),
            concat!("parse_workspace_cmd_menu", "_id"),
            concat!("dispatch_to_workspace", "_window"),
        ] {
            assert!(!MAIN_RS.contains(gone), "{gone} must be gone");
        }
    }

    #[test]
    fn handoff_registration_responds_before_the_gateway_probe() {
        const MAIN_RS: &str = include_str!("main.rs");
        // The CLI blocks ~3s on DevserverRegistered: the register fn must
        // stay SYNC (the handoff closure builds the response as soon as it
        // returns) with the is-this-a-gateway probe on a detached task.
        // What this pins is that the response can never WAIT on the probe -
        // not a literal happens-before between the write and the task's
        // first poll - which is the property the handoff contract needs.
        assert!(
            !MAIN_RS.contains(concat!("async fn register_devserver", "_from_handoff")),
            "the handoff registration must not become async"
        );
        let reg = source_region(
            MAIN_RS,
            "\nfn register_devserver_from_handoff(",
            "\n/// Open a workspace in a native window",
        );
        assert!(reg.contains("discover_gateway"));
        assert!(reg.contains("convert_devserver_row_to_gateway"));
        // Nothing awaits before the spawn: the probe and the conversion
        // live entirely inside the detached task.
        let spawn = reg
            .find("tauri::async_runtime::spawn")
            .expect("the registration spawns its detached task");
        let before_spawn = &reg[..spawn];
        assert!(!before_spawn.contains(".await"));
        assert!(!before_spawn.contains("discover_gateway"));
    }

    #[test]
    fn synthesized_dispatch_runs_before_the_persisted_row_lookup() {
        const MAIN_RS: &str = include_str!("main.rs");
        // A gw: id must route to the gateway manager BEFORE the persisted
        // vec is consulted: synthesized rows are never in the config, so a
        // lookup-first order would answer "no devserver" for every one.
        let inner = source_region(
            MAIN_RS,
            "\nasync fn connect_devserver_impl_inner(",
            "\npub(crate) async fn open_devserver_workspace_impl(",
        );
        let dispatch = inner
            .find("parse_synthesized_id")
            .expect("gw: dispatch present");
        // Anchor the lookup on its unique error literal (rustfmt splits
        // `cfg.devservers` across lines inside this fn, so the field
        // access itself is not greppable here).
        let lookup = inner
            .find(r#"format!("no devserver {id}")"#)
            .expect("persisted-row lookup present");
        assert!(
            dispatch < lookup,
            "gw: dispatch must precede the persisted-row lookup"
        );
    }

    #[tokio::test]
    async fn gateway_backstop_probe_fires_once_per_row_per_run() {
        // The one-time flag is load-bearing: the probe must never become a
        // per-connect cost (its removal from the connect path is what the
        // dispatch rework bought).
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Mutex::new(config::ConfigStore::at_path(
            dir.path().join("config.json"),
        )));
        {
            let cfg = config::Config {
                devservers: vec![config::Devserver {
                    id: "ds1".to_string(),
                    // An unroutable dial so the detached probe fails fast.
                    url: "http://127.0.0.1:1".to_string(),
                    script: String::new(),
                    label: String::new(),
                    token: String::new(),
                    added_at: 0,
                    auto_hide_control: false,
                    gateway_owner: None,
                    gateway_devserver_id: None,
                }],
                ..Default::default()
            };
            store.lock().unwrap().save(&cfg).unwrap();
        }
        let state = Arc::new(AppState::with_store(store));
        let app = tauri::test::mock_app();
        assert!(
            spawn_gateway_backstop_probe(app.handle(), &state, "ds1"),
            "the first failure spawns the probe"
        );
        assert!(
            !spawn_gateway_backstop_probe(app.handle(), &state, "ds1"),
            "a second failure for the same row never re-probes"
        );
        assert!(
            spawn_gateway_backstop_probe(app.handle(), &state, "ds2"),
            "other rows keep their own one-shot"
        );
    }

    fn empty_state() -> Arc<AppState> {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Mutex::new(config::ConfigStore::at_path(
            dir.path().join("config.json"),
        )));
        std::mem::forget(dir);
        Arc::new(AppState::with_store(store))
    }

    #[test]
    fn shared_rostered_policy_requires_exact_persisted_trust() {
        let state = empty_state();
        let gateway_id = "gw-feedface";
        let owner = "bob";
        let devserver_id = "d".repeat(64);
        {
            let mut store = state.store.lock().unwrap();
            let mut cfg = store.get().unwrap();
            cfg.gateways.push(config::Gateway {
                id: gateway_id.into(),
                url: "https://id.example.test".into(),
                label: String::new(),
                enabled: true,
                added_at: 0,
                native_trust: Vec::new(),
            });
            store.save(&cfg).unwrap();
        }
        let discovery = devserver::GatewayDiscovery {
            kind: "chan-gateway".into(),
            api_version: 1,
            identity_origin: "https://id.example.test".into(),
            desktop_authorize_url: "https://id.example.test/desktop/authorize".into(),
            desktop_entry_url: "https://id.example.test/desktop/v1/devserver/entry".into(),
            devserver_proxy_origin: "https://devserver.example.test".into(),
            devserver_proxy_host_depth: 2,
            roster_url: Some("https://id.example.test/desktop/v1/devservers".into()),
        };
        state.gateway_manager.seed_test_runtime(
            gateway_id,
            discovery.clone(),
            vec![gateway::RosterDevserver {
                owner_user_id: uuid::Uuid::from_u128(2),
                owner: owner.into(),
                devserver_id: devserver_id.clone(),
                label: "shared".into(),
                online: true,
                shared: true,
                proxy_origin: Some("https://bob--d.p1.devserver.example.test".into()),
            }],
        );

        assert_eq!(
            require_rostered_native_policy(&state, gateway_id, owner, &devserver_id).unwrap_err(),
            NATIVE_TRUST_REQUIRED
        );
        config::set_native_trust(
            &state.store,
            gateway_id,
            uuid::Uuid::from_u128(3),
            "someone-else",
            &devserver_id,
            true,
        )
        .unwrap();
        assert_eq!(
            require_rostered_native_policy(&state, gateway_id, owner, &devserver_id).unwrap_err(),
            NATIVE_TRUST_REQUIRED,
            "trust for another owner must not widen the grant"
        );
        config::set_native_trust(
            &state.store,
            gateway_id,
            uuid::Uuid::from_u128(2),
            owner,
            &devserver_id,
            true,
        )
        .unwrap();
        assert!(require_rostered_native_policy(&state, gateway_id, owner, &devserver_id).is_ok());

        state
            .gateway_manager
            .seed_test_runtime(gateway_id, discovery, Vec::new());
        assert!(
            require_rostered_native_policy(&state, gateway_id, owner, &devserver_id)
                .unwrap_err()
                .contains("roster no longer contains"),
            "persisted trust must not outlive authenticated roster membership"
        );
    }

    /// A rostered row whose entry mint answers devserver_offline fails the
    /// connect AND emits a clean devserver-sourced info notice (the gateway
    /// checks liveness before authorization, so dark shared rows land here
    /// too).
    #[tokio::test]
    async fn offline_rostered_row_notices_and_fails_the_connect() {
        use tauri::Listener;
        // A gateway whose entry endpoint always answers the offline reason.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let stub = axum::Router::new().route(
            "/desktop/v1/devserver/entry",
            axum::routing::post(|| async {
                axum::http::Response::builder()
                    .status(404)
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(
                        r#"{"error":"not found","reason":"devserver_offline","label":"lap"}"#,
                    ))
                    .unwrap()
            }),
        );
        let server = tokio::spawn(async move {
            axum::serve(listener, stub).await.unwrap();
        });

        let ds64 = "d".repeat(64);
        let state = empty_state();
        {
            let mut store = state.store.lock().unwrap();
            let mut cfg = store.get().unwrap();
            cfg.gateways.push(config::Gateway {
                id: "gw-feedface".into(),
                url: origin.clone(),
                label: String::new(),
                enabled: true,
                added_at: 0,
                native_trust: Vec::new(),
            });
            store.save(&cfg).unwrap();
        }
        state.gateway_manager.seed_test_runtime(
            "gw-feedface",
            devserver::GatewayDiscovery {
                kind: "chan-gateway".into(),
                api_version: 1,
                identity_origin: origin.clone(),
                desktop_authorize_url: format!("{origin}/desktop/authorize"),
                desktop_entry_url: format!("{origin}/desktop/v1/devserver/entry"),
                devserver_proxy_origin: "https://proxy.chan.app".into(),
                devserver_proxy_host_depth: 2,
                roster_url: Some(format!("{origin}/desktop/v1/devservers")),
            },
            vec![gateway::RosterDevserver {
                owner_user_id: uuid::Uuid::from_u128(1),
                owner: "alice".into(),
                devserver_id: ds64.clone(),
                label: String::new(),
                online: false,
                shared: false,
                proxy_origin: None,
            }],
        );
        crate::auth::test_gateway_pats().lock().unwrap().insert(
            origin.clone(),
            crate::auth::StoredPat {
                id: "pat-1".into(),
                secret: "s3cret".into(),
                label: "test".into(),
                expires_at: String::new(),
            },
        );
        let app = tauri::test::mock_app();
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        app.listen(gateway::LAUNCHER_NOTICE, move |event| {
            let _ = tx.send(event.payload().to_string());
        });

        let result = rostered_conn(
            app.handle(),
            &state,
            &format!("gw:feedface:alice:{ds64}"),
            "gw-feedface",
            "alice",
            &ds64,
        )
        .await;
        let message = result
            .expect_err("offline entry fails the connect")
            .message();
        assert!(message.contains("not currently connected"), "{message}");
        // The notice went out synchronously before the Err returned.
        let payload = rx.try_recv().expect("offline notice emitted");
        let notice: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(notice["kind"], "info");
        assert_eq!(notice["source"]["type"], "devserver");
        // No roster label was seeded: the source label falls back to the
        // 12-char devserver-id prefix; the entry body's label ("lap")
        // rides the human message instead.
        assert_eq!(notice["source"]["label"], "dddddddddddd");
        assert_eq!(notice["title"], "Devserver offline");
        assert!(
            notice["message"].as_str().unwrap().contains("lap"),
            "{payload}"
        );
        server.abort();
    }

    /// The legacy-migration summary parks until the first launcher page
    /// load narrates it, once; marker-clearing-only outcomes stay silent.
    #[test]
    fn migration_summary_parks_until_narrated_once() {
        use tauri::Listener;
        let state = empty_state();
        *state.gateway_migration.lock().unwrap() = Some(config::GatewayMigration {
            created: Vec::new(),
            converted_rows: 2,
            cleared_marker_rows: 0,
        });
        let app = tauri::test::mock_app();
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        app.listen(gateway::LAUNCHER_NOTICE, move |event| {
            let _ = tx.send(event.payload().to_string());
        });

        assert!(
            narrate_parked_migration(app.handle(), &state),
            "a converted-rows outcome narrates"
        );
        let payload = rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("migration notice emitted after the grace");
        let notice: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(notice["title"], "Gateways migrated");
        assert!(
            notice["message"].as_str().unwrap().starts_with("2 gateway"),
            "{payload}"
        );
        // The park is one-shot.
        assert!(!narrate_parked_migration(app.handle(), &state));

        // Marker clearing alone changes nothing the user can see: silent.
        *state.gateway_migration.lock().unwrap() = Some(config::GatewayMigration {
            created: Vec::new(),
            converted_rows: 0,
            cleared_marker_rows: 1,
        });
        assert!(!narrate_parked_migration(app.handle(), &state));
    }
}
