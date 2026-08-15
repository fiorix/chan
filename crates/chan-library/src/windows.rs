//! The authoritative window set: the library-owned window registry plus its
//! wire contract.
//!
//! The library is the single authority for which windows exist. Every window (a
//! standalone terminal or a workspace view) is a durable [`PersistedWindow`] in
//! the [`WindowRegistry`], keyed by a library-minted
//! [`WindowRecord::window_id`]. Clients (native desktop windows, browser tabs,
//! `cs`) are pure views: they read the window set ([`WindowSet`]) and reconcile
//! their surface to it; they never mint an id and never parse one. A client
//! brings a window into being by asking the library to mint one
//! ([`CreateWindow`]).
//!
//! Durable vs wire split. [`PersistedWindow`] is the durable on-disk row (id,
//! kind, title, ordinal, workspace path). [`WindowRecord`] is what the HTTP feed
//! serves: the durable row plus live state assembled at read time (the owning
//! library's id, the serving tenant's `prefix`/`token`, and the `connected`
//! presence flag, see [`PersistedWindow::to_record`]). So the registry owns
//! durability plus the mint; the route layer assembles the live view.
//!
//! Id scope. `window_id` is unique within its minting library only: libraries
//! mint independently, with no global authority. The globally-unique key is the
//! composite `(library_id, window_id)`, which is what a client aggregating
//! libraries keys on. Within a library, uniqueness is structural: the mint
//! re-rolls against the registry, so it never collides regardless of entropy
//! width.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use rand::RngCore;
use serde::{Deserialize, Serialize};
use tokio::sync::Notify;

/// House glyph (⌂) for a local workspace under `$HOME`, mirroring the launcher's
/// lucide House icon. Titles are library-owned, so this is their single source.
const ICON_LOCAL_HOME: &str = "\u{2302}"; // ⌂ house
/// Monochrome desktop-computer glyph for a local workspace outside `$HOME`. The
/// U+FE0E text-presentation selector keeps it line-art alongside ⌂ / ⊕.
const ICON_LOCAL_OTHER: &str = "\u{1F5A5}\u{FE0E}"; // 🖥︎ desktop computer

/// Maximum user-supplied text appended to a non-control window's generated
/// `Terminal Window N` / `Window N` label. Counted in Unicode scalar values by
/// the authoritative server; the launcher's HTML `maxlength` is an earlier
/// input guard.
pub const MAX_WINDOW_LABEL_CHARS: usize = 64;

// ---------------------------------------------------------------------------
// The window wire contract. The serde field names ARE the wire, so a one-sided
// rename compiles green and breaks at runtime; the `*_wire` byte tests pin them.
// ---------------------------------------------------------------------------

/// Window flavour. `rename_all = "lowercase"` pins the wire tags
/// `"terminal"` / `"workspace"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WindowKind {
    Terminal,
    Workspace,
}

/// Which client surface minted a window. `Native` (a desktop or CLI mint) is
/// the default; `Browser` marks a window minted from a browser tab, which
/// chan-desktop must NOT reconcile into a native twin (its watcher skips
/// non-native records). Client-claimed at mint (the server cannot infer the
/// acting surface), the same honest-client trust as the acting window id.
/// `rename_all = "lowercase"` pins the wire tags `"native"` / `"browser"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WindowOrigin {
    #[default]
    Native,
    Browser,
}

impl WindowOrigin {
    /// A native (desktop/CLI) mint. The reconciler shows only native records;
    /// the serde skip predicate keeps a native row's on-disk/wire shape
    /// unchanged.
    pub fn is_native(&self) -> bool {
        matches!(self, WindowOrigin::Native)
    }
}

/// One library-owned window: the authoritative record every client reconciles
/// to. Assembled at read time from a [`PersistedWindow`] plus live state.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowRecord {
    /// Library-minted, persisted, opaque, stable across reconnect AND library
    /// restart. THE reconciliation key. Clients MUST NOT parse it. Unique
    /// within its minting library; the global key is the composite
    /// `(library_id, window_id)`.
    pub window_id: String,
    /// Owning library identity: `"local"` for the baked-in local-disk library,
    /// `lib-<hex>` for a devserver. Routes the attach, groups the per-library
    /// window menu, decorates remote titles, and forms the global key.
    pub library_id: String,
    /// Window flavour.
    pub kind: WindowKind,
    /// Library-composed and persisted display title, auto-derived (no user
    /// rename). Local perspective (`⌂ Terminal Window N` /
    /// `⌂ {path} Window N`); the desktop re-decorates a remote library's rows
    /// from `kind`/`ordinal`/`workspace_path`, never by parsing this string.
    pub title: String,
    /// Per-(kind, workspace/library) "Window N": library-owned, persisted,
    /// stable. On the wire so a client can recompose the title fully.
    pub ordinal: u32,
    /// Optional user text appended to the generated `Window N` display label.
    /// Kept separate from the library-owned title and ordinal so clients never
    /// need to parse either. Empty is the default and is omitted from the wire.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub label: String,
    /// `kind == Workspace`: the full workspace root path. `None` for a terminal
    /// window; omitted from the wire when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    /// Route prefix of the tenant serving this window's content. The client
    /// attaches under it.
    pub prefix: String,
    /// Per-tenant bearer for `prefix`; empty when the owning tenant is off (a
    /// persisted workspace window whose workspace is not mounted, so the desktop
    /// turns it on before attaching).
    pub token: String,
    /// A durable library record exists (survives client disconnect AND library
    /// restart). True for every feed row in this model.
    pub persisted: bool,
    /// A `/ws` socket tagged with `window_id` is live right now: some client has
    /// it open (visible OR buried; the server cannot tell those apart).
    pub connected: bool,
    /// A file transfer (upload or download) is in flight for this window right
    /// now. Volatile per-push state (the whole set is re-assembled each push), so
    /// a client with no `/ws` view of the serving tenant -- the desktop onto a
    /// remote devserver -- still learns a window is mid-transfer and can guard its
    /// close. `#[serde(default)]`: a record without the field reads `false`.
    #[serde(default)]
    pub active_transfer: bool,
    /// This is a devserver's script-connection CONTROL terminal -- the window
    /// running the connect script. The desktop surfaces it in that devserver's
    /// feed (tagged with the devserver's `library_id`), and the launcher renders
    /// it FIRST in the devserver's window list. Omitted from the wire when false
    /// (the common case), so only a control window carries it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub control: bool,
    /// Server-persisted visibility: `true` ⇒ the window is BURIED/hidden (the
    /// desktop keeps it closed on connect; the launcher renders it as hidden).
    /// The server is the source of truth (set via `POST …/visibility`), so a
    /// desktop connect mirrors the saved layout instead of force-opening every
    /// window. Omitted from the wire when false (the common case) -- the launcher
    /// treats absent as visible.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub hidden: bool,
    /// Which client surface minted this window. `browser` marks a browser-tab
    /// mint that chan-desktop skips (never opens a native twin); omitted from
    /// the wire when native (the common case), and absent reads as native so
    /// existing rows stay native.
    #[serde(default, skip_serializing_if = "WindowOrigin::is_native")]
    pub origin: WindowOrigin,
}

impl std::fmt::Debug for WindowRecord {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WindowRecord")
            .field("window_id", &self.window_id)
            .field("library_id", &self.library_id)
            .field("kind", &self.kind)
            .field("title", &self.title)
            .field("ordinal", &self.ordinal)
            .field("label", &self.label)
            .field("workspace_path", &self.workspace_path)
            .field("prefix", &self.prefix)
            .field("token", &"[REDACTED]")
            .field("persisted", &self.persisted)
            .field("connected", &self.connected)
            .field("active_transfer", &self.active_transfer)
            .field("control", &self.control)
            .field("hidden", &self.hidden)
            .field("origin", &self.origin)
            .finish()
    }
}

/// The window-set watch frame: a full snapshot pushed on connect and on every
/// change (mint, discard, bury, connect, disconnect), driven by the registry's
/// [`WindowRegistry::change_notify`]. A full snapshot rather than a delta keeps
/// the reconcile idempotent and lets a dropped frame self-heal on the next one.
/// (The plain list endpoint returns the bare `Vec<WindowRecord>`; the watch
/// wraps it so a future frame can add sibling fields.)
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowSet {
    pub windows: Vec<WindowRecord>,
    /// Per-tenant leaders for leader-gated affordances: tenant route `prefix` ->
    /// that tenant's leader `window_id`. A launcher correlates
    /// `leaders[record.prefix]` and checks it against its own window ids to know
    /// where it leads. Additive: absent (omitted) when no mounted tenant has a
    /// live leader, and a client that ignores it still reconciles windows.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub leaders: BTreeMap<String, String>,
}

/// Body of `POST /api/library/windows`, the mint request. The client supplies
/// the kind (plus `workspace_path` for a workspace window); the library supplies
/// the `window_id`, persists the record, and returns the assembled
/// [`WindowRecord`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateWindow {
    pub kind: WindowKind,
    /// Required for `kind == Workspace`; omitted for a terminal window.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    /// Client-claimed affinity: `browser` when a browser tab mints the window,
    /// so chan-desktop never opens a native twin. Absent (the desktop / CLI
    /// mint) reads as native; honest-client input, same trust as the acting
    /// window id.
    #[serde(default, skip_serializing_if = "WindowOrigin::is_native")]
    pub origin: WindowOrigin,
    /// The caller's claimed acting window id, checked against the target tenant's
    /// leader for the create gate. Honest-client input, not proof of identity;
    /// absent on a legacy / desktop-launcher caller, which the gate allows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acting_window_id: Option<String>,
}

// ---------------------------------------------------------------------------
// Durable registry (the source of truth).
// ---------------------------------------------------------------------------

/// The durable on-disk row for one window: everything that survives a library
/// restart. The live `prefix`/`token`/`connected` are NOT here; they are
/// assembled at read time (see [`Self::to_record`]). Field names are the
/// persisted contract, pinned by `persisted_window_pins_field_names`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PersistedWindow {
    pub window_id: String,
    pub kind: WindowKind,
    pub title: String,
    pub ordinal: u32,
    /// User-supplied terminal/workspace-window caption. Empty on legacy rows
    /// and omitted from disk to preserve their existing shape.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    /// A devserver control terminal (runs the connect script). True only for the
    /// transient control row minted via [`WindowRegistry::create_control`]; it is
    /// NEVER written to disk (see `WindowRegistry::save_best_effort`) -- the
    /// control terminal is per-connection, desktop-driven, and reaped on PTY
    /// exit. `skip_serializing_if` default keeps a normal row's on-disk shape
    /// unchanged.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub control: bool,
    /// Owning library override. `None` ⇒ this row belongs to the host's own
    /// library (the common case; assembly stamps the host's `library_id`).
    /// `Some(id)` ⇒ a FOREIGN library_id, used by the control row: it is minted
    /// in the desktop's LOCAL embedded library but GROUPS under the remote
    /// devserver's `library_id`. (Local-vs-remote OPEN routing keys off
    /// `control`, NOT this id -- see the desktop opener.) `skip_serializing_if`
    /// default keeps a normal row's on-disk shape unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub library_id: Option<String>,
    /// Server-persisted visibility: `true` ⇒ buried/hidden. The
    /// devserver is the source of truth; the desktop mirrors it on connect.
    /// Surfaced on the wire as [`WindowRecord::hidden`]. `skip_serializing_if`
    /// default keeps an existing/visible row's on-disk shape unchanged.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub hidden: bool,
    /// Which client surface minted this window. Persisted so a browser-minted
    /// window stays browser across a restart (chan-desktop keeps skipping it).
    /// `skip_serializing_if` default keeps a native row's on-disk shape
    /// unchanged; absent reads as native.
    #[serde(default, skip_serializing_if = "WindowOrigin::is_native")]
    pub origin: WindowOrigin,
}

impl PersistedWindow {
    /// Assemble the wire [`WindowRecord`] from this durable row plus the live
    /// state the route layer holds: the owning `library_id`, the serving
    /// tenant's `prefix` + `token` (empty when the tenant is off), and whether
    /// a `/ws` socket is currently `connected`. `persisted` is always true for
    /// a row that exists in the registry.
    pub fn to_record(
        &self,
        library_id: String,
        prefix: String,
        token: String,
        connected: bool,
    ) -> WindowRecord {
        WindowRecord {
            window_id: self.window_id.clone(),
            library_id,
            kind: self.kind,
            title: self.title.clone(),
            ordinal: self.ordinal,
            label: self.label.clone(),
            workspace_path: self.workspace_path.clone(),
            prefix,
            token,
            // A control row is transient (in-memory only, never on disk), so it
            // is NOT persisted; every other registry row is durable.
            persisted: !self.control,
            connected,
            // The live transfer bit is overlaid by the feed assembly
            // (`assemble_window_records`), the one place that holds tenant
            // transfer state; a freshly assembled/minted record defaults off.
            active_transfer: false,
            control: self.control,
            hidden: self.hidden,
            origin: self.origin,
        }
    }
}

/// Per-library state that lives beside the window set but is NOT a window: the
/// first-open marker. Kept in a sibling `*-state.json` rather than a field on
/// the window-set store so the window store stays a pure `Vec<PersistedWindow>`
/// (its serde shape is the persisted contract, pinned by
/// `persisted_window_pins_field_names`) and so this internal lifecycle flag can
/// never leak into the window feed. Field names are the persisted contract.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
struct LibraryState {
    /// The library has already minted its one first-open terminal. Once set, an
    /// emptied window registry (the user closed every window) does NOT re-mint:
    /// "closed it → reopening comes up with no terminal".
    #[serde(default)]
    first_open_done: bool,
}

/// The library's window registry: the durable window set, the mint, and the
/// change broadcaster. Library-level (one per library; a workspace window and a
/// terminal window both live here), persisted to `store_path`. Cheap to share
/// behind an `Arc`; the route layer holds one and reads/writes it per request.
pub struct WindowRegistry {
    store_path: PathBuf,
    /// Sibling state store (`<store_path stem>-state.json`) for the first-open
    /// marker. Derived once at open so the marker and the window set always sit
    /// in the same library directory.
    state_path: PathBuf,
    windows: Mutex<Vec<PersistedWindow>>,
    /// Per-library state that is not a window (the first-open marker). Guarded
    /// independently of `windows` since the open path reads/sets it without
    /// touching the window set.
    state: Mutex<LibraryState>,
    /// Fires on every change (create/remove). The watch endpoint awaits this
    /// and republishes a fresh [`WindowSet`] snapshot. A consumer must register
    /// its `notified()` BEFORE taking its snapshot, so a change between snapshot
    /// and re-await is not missed (`Notify` stores no permit for
    /// `notify_waiters`).
    notify: Arc<Notify>,
}

impl WindowRegistry {
    /// Open the registry at `store_path`, loading any persisted window set plus
    /// the sibling first-open state. An absent or unreadable store degrades to
    /// an empty set / default state rather than refusing to start (the windows
    /// reappear as clients re-create them).
    pub fn open(store_path: PathBuf) -> Self {
        let windows = match std::fs::read(&store_path) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
            Err(_) => Vec::new(),
        };
        let state_path = state_path_for(&store_path);
        let state = match std::fs::read(&state_path) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
            Err(_) => LibraryState::default(),
        };
        Self {
            store_path,
            state_path,
            windows: Mutex::new(windows),
            state: Mutex::new(state),
            notify: Arc::new(Notify::new()),
        }
    }

    /// Whether this library has already minted its first-open terminal. The open
    /// path gates the one-shot mint on `!first_open_done()` (and an empty
    /// registry), so a closed-then-reopened library does not re-mint.
    pub fn first_open_done(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .first_open_done
    }

    /// Mark the first-open terminal as minted and persist it atomically (same
    /// tmp+fsync+rename discipline as the window set). Idempotent: a no-op once
    /// already set. Persisted before the open path returns so a crash right
    /// after the mint cannot re-mint on the next boot.
    pub fn mark_first_open_done(&self) {
        let snapshot = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.first_open_done {
                return;
            }
            state.first_open_done = true;
            state.clone()
        };
        if let Err(e) = save_atomic(&self.state_path, &snapshot) {
            tracing::warn!("persisting library first-open state: {e}");
        }
    }

    /// Whether the durable window set is currently empty. The open path mints
    /// the first-open terminal only on an empty registry, so a library that
    /// already has persisted windows never gets an extra one.
    pub fn is_empty(&self) -> bool {
        self.lock().is_empty()
    }

    /// Mint and persist a new NATIVE window of `kind` (with `workspace_path` for
    /// a workspace window). The library owns the id, the ordinal, and the title;
    /// returns the durable row. Fires the change notification. The desktop and
    /// CLI mint through here; a browser mint uses [`Self::create_with_origin`].
    pub fn create(&self, kind: WindowKind, workspace_path: Option<String>) -> PersistedWindow {
        self.create_with_origin(kind, workspace_path, WindowOrigin::Native)
    }

    /// Mint and persist a new window with an explicit client `origin`, stamped at
    /// creation so a browser-minted row is never briefly visible as native to the
    /// desktop reconciler. Otherwise identical to [`Self::create`].
    pub fn create_with_origin(
        &self,
        kind: WindowKind,
        workspace_path: Option<String>,
        origin: WindowOrigin,
    ) -> PersistedWindow {
        let (row, snapshot) = {
            let mut windows = self.lock();
            let window_id = mint_id(&windows);
            let ordinal = next_ordinal(&windows, kind, workspace_path.as_deref());
            let title = compose_title(kind, ordinal, workspace_path.as_deref());
            let row = PersistedWindow {
                window_id,
                kind,
                title,
                ordinal,
                label: String::new(),
                workspace_path,
                control: false,
                library_id: None,
                hidden: false,
                origin,
            };
            windows.push(row.clone());
            (row, windows.clone())
        };
        self.save_best_effort(&snapshot);
        self.notify.notify_waiters();
        row
    }

    /// Mint a transient devserver CONTROL terminal row: `kind = Terminal`,
    /// `control = true`, `ordinal 0` (rendered first), tagged with the FOREIGN
    /// devserver `library_id` so it GROUPS under that devserver. The desktop
    /// supplies the `window_id` (the stable native control-window label) so the
    /// launcher's hide/open resolves straight to the live window. The session
    /// runs on a LOCAL control tenant; the assembly resolves its prefix/token
    /// from there (Local-vs-remote OPEN routing keys off `control`, not the
    /// foreign id). NOT persisted to disk (per-connection; reaped on PTY exit)  --
    /// a re-connect under the same label replaces any stale row. Fires the
    /// change notification.
    pub fn create_control(&self, window_id: String, library_id: String) -> PersistedWindow {
        let row = PersistedWindow {
            window_id,
            kind: WindowKind::Terminal,
            title: "Control Terminal".to_string(),
            ordinal: 0,
            label: String::new(),
            workspace_path: None,
            control: true,
            library_id: Some(library_id),
            hidden: false,
            // A control terminal is a desktop-native window.
            origin: WindowOrigin::Native,
        };
        {
            let mut windows = self.lock();
            // Re-connect reuses the stable label; drop any prior row first so the
            // set never carries two control rows for one devserver.
            windows.retain(|w| w.window_id != row.window_id);
            windows.push(row.clone());
        }
        // No persist: control rows are in-memory only (save_best_effort filters
        // them anyway); just signal the feed.
        self.notify.notify_waiters();
        row
    }

    /// Drop the window `window_id` from the durable set: the discard mechanism.
    /// The policy of when to discard versus bury lives in the route/desktop
    /// layer. Returns whether a row was removed; fires the change notification
    /// when so.
    pub fn remove(&self, window_id: &str) -> bool {
        let (removed, snapshot) = {
            let mut windows = self.lock();
            let before = windows.len();
            windows.retain(|w| w.window_id != window_id);
            (windows.len() != before, windows.clone())
        };
        if removed {
            self.save_best_effort(&snapshot);
            self.notify.notify_waiters();
        }
        removed
    }

    /// Remove `window_id` ONLY if it is a NON-CONTROL terminal window whose PTY
    /// exited while detached. A
    /// workspace window (its panes' deaths must not close it) and a control
    /// window (the desktop exit-watcher owns those) are left untouched, so this
    /// is safe to fire from the shared terminal tenant's reap hook. Returns
    /// whether a row was removed; fires the change notification when so.
    pub fn remove_terminal(&self, window_id: &str) -> bool {
        let (removed, snapshot) = {
            let mut windows = self.lock();
            let before = windows.len();
            windows.retain(|w| {
                !(w.window_id == window_id && matches!(w.kind, WindowKind::Terminal) && !w.control)
            });
            (windows.len() != before, windows.clone())
        };
        if removed {
            self.save_best_effort(&snapshot);
            self.notify.notify_waiters();
        }
        removed
    }

    /// Set window `window_id`'s persisted visibility. Returns whether a
    /// row MATCHED (so a route maps `false` to 404 -- idempotent: setting the
    /// value it already holds still matches). Persists (durable rows; a control
    /// row stays in-memory via `Self::save_best_effort`) + fires the change
    /// notification only when the value actually changed.
    pub fn set_hidden(&self, window_id: &str, hidden: bool) -> bool {
        let (matched, changed, snapshot) = {
            let mut windows = self.lock();
            let mut matched = false;
            let mut changed = false;
            for w in windows.iter_mut() {
                if w.window_id == window_id {
                    matched = true;
                    if w.hidden != hidden {
                        w.hidden = hidden;
                        changed = true;
                    }
                    break;
                }
            }
            (matched, changed, windows.clone())
        };
        if changed {
            self.save_best_effort(&snapshot);
            self.notify.notify_waiters();
        }
        matched
    }

    /// Set `window_id`'s user caption. The route layer excludes generated
    /// control terminals and validates the text; the registry owns persistence
    /// and the watch notification. Returns whether a row matched. Setting the
    /// existing value is an idempotent match and does not rewrite the store.
    pub fn set_label(&self, window_id: &str, label: String) -> bool {
        let (matched, changed, snapshot) = {
            let mut windows = self.lock();
            let mut matched = false;
            let mut changed = false;
            for w in windows.iter_mut() {
                if w.window_id == window_id {
                    matched = true;
                    if w.label != label {
                        w.label = label;
                        changed = true;
                    }
                    break;
                }
            }
            (matched, changed, windows.clone())
        };
        if changed {
            self.save_best_effort(&snapshot);
            self.notify.notify_waiters();
        }
        matched
    }

    /// Snapshot the durable window set, ordered for stable display: terminals
    /// before workspaces, then by `(workspace_path, ordinal, window_id)`. The
    /// route layer maps each row through [`PersistedWindow::to_record`].
    pub fn snapshot(&self) -> Vec<PersistedWindow> {
        let mut windows = self.lock().clone();
        windows.sort_by(|a, b| {
            kind_order(a.kind)
                .cmp(&kind_order(b.kind))
                .then_with(|| a.workspace_path.cmp(&b.workspace_path))
                .then_with(|| a.ordinal.cmp(&b.ordinal))
                .then_with(|| a.window_id.cmp(&b.window_id))
        });
        windows
    }

    /// The change-notification handle for the watch endpoint. Register
    /// `notify.notified()` *before* taking a snapshot to avoid missing a change
    /// that lands between the snapshot and the next await.
    pub fn change_notify(&self) -> Arc<Notify> {
        Arc::clone(&self.notify)
    }

    /// Persist the window set, logging on failure rather than propagating: a
    /// failed save must not abort a window create/remove (the in-memory set is
    /// still correct; the on-disk copy catches up on the next change).
    fn save_best_effort(&self, windows: &[PersistedWindow]) {
        // Control rows are transient/per-connection (in-memory only): never write
        // them, so a desktop crash can't strand a stale control window on the
        // next boot. Durable rows persist as before.
        let durable: Vec<&PersistedWindow> = windows.iter().filter(|w| !w.control).collect();
        if let Err(e) = save_atomic(&self.store_path, &durable) {
            tracing::warn!("persisting window registry: {e}");
        }
    }

    /// Recover from a poisoned lock instead of propagating the panic: the
    /// critical sections are simple Vec ops that cannot leave the set
    /// inconsistent, and registry bookkeeping must never abort a window path.
    fn lock(&self) -> MutexGuard<'_, Vec<PersistedWindow>> {
        self.windows.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Terminals sort before workspaces in the display order.
fn kind_order(kind: WindowKind) -> u8 {
    match kind {
        WindowKind::Terminal => 0,
        WindowKind::Workspace => 1,
    }
}

/// Mint a fresh `w-<16 hex>` id (8 random bytes), re-rolling against the current
/// set so the per-library id is unique structurally, not reliant on entropy
/// width. The opaque id never carries meaning; clients treat it as a black box.
fn mint_id(windows: &[PersistedWindow]) -> String {
    use std::fmt::Write as _;
    loop {
        let mut bytes = [0u8; 8];
        rand::thread_rng().fill_bytes(&mut bytes);
        let mut id = String::with_capacity(18);
        id.push_str("w-");
        for b in bytes {
            let _ = write!(id, "{b:02x}");
        }
        if !windows.iter().any(|w| w.window_id == id) {
            return id;
        }
    }
}

/// Lowest-free "Window N" within the same `(kind, workspace_path)` family, so a
/// closed window's number is reused rather than monotonically climbing (mirrors
/// the terminal-tab lowest-free numbering). Starts at 1.
fn next_ordinal(
    windows: &[PersistedWindow],
    kind: WindowKind,
    workspace_path: Option<&str>,
) -> u32 {
    let used: HashSet<u32> = windows
        .iter()
        .filter(|w| w.kind == kind && w.workspace_path.as_deref() == workspace_path)
        .map(|w| w.ordinal)
        .collect();
    (1u32..)
        .find(|n| !used.contains(n))
        .expect("u32 always has a free ordinal for a realistic window count")
}

/// Compose the persisted, library-perspective title: `⌂ Terminal Window N` for
/// a terminal; `{icon} {full path} Window N` for a workspace, where the icon is
/// the house glyph under `$HOME` else the local-other glyph. The remote
/// decoration (a remote arrow plus the devserver name) is the desktop's job for
/// a remote library's rows; the library always composes from its own local view.
fn compose_title(kind: WindowKind, ordinal: u32, workspace_path: Option<&str>) -> String {
    match kind {
        WindowKind::Terminal => format!("{ICON_LOCAL_HOME} Terminal Window {ordinal}"),
        WindowKind::Workspace => {
            let path = workspace_path.unwrap_or_default();
            let icon = local_workspace_icon(Path::new(path));
            format!("{icon} {path} Window {ordinal}")
        }
    }
}

/// ⌂ when `path` is under `$HOME`, else 🖥︎ (a local workspace elsewhere).
fn local_workspace_icon(path: &Path) -> &'static str {
    match dirs::home_dir() {
        Some(home) if path.starts_with(&home) => ICON_LOCAL_HOME,
        _ => ICON_LOCAL_OTHER,
    }
}

/// The sibling state-store path for a window store: `<dir>/<stem>-state.json`
/// next to `<dir>/<stem>.json`. Co-locating the first-open marker with the
/// window set keeps both in the one library directory.
fn state_path_for(store_path: &Path) -> PathBuf {
    let stem = store_path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "windows".to_string());
    store_path.with_file_name(format!("{stem}-state.json"))
}

/// Atomically persist `value` as pretty JSON: write a 0600 tmp, fsync it,
/// rename over the target, then fsync the parent dir. Renaming un-synced bytes
/// is the partial-write risk on a crash. The dir fsync is inlined (no
/// cross-crate dep) and best-effort: the rename already committed the data, so a
/// failed dir sync is durability hardening, not a save failure. Shared by the
/// window set and the sibling first-open state.
fn save_atomic<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    use std::io::Write as _;

    let dir = match path.parent() {
        Some(dir) => {
            std::fs::create_dir_all(dir)?;
            dir
        }
        None => Path::new("."),
    };
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let tmp = path.with_extension("json.tmp");
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(&bytes)?;
        f.sync_all()?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, path)?;
    // Best-effort parent-dir fsync so the new dirent survives a crash too.
    if let Ok(dir_file) = std::fs::File::open(dir) {
        let _ = dir_file.sync_all();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn registry() -> (WindowRegistry, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let reg = WindowRegistry::open(dir.path().join("windows.json"));
        (reg, dir)
    }

    // --- wire byte pins -----------------------------------------------------

    #[test]
    fn window_kind_wire() {
        assert_eq!(
            serde_json::to_value(WindowKind::Terminal).unwrap(),
            json!("terminal")
        );
        assert_eq!(
            serde_json::to_value(WindowKind::Workspace).unwrap(),
            json!("workspace")
        );
        assert_eq!(
            serde_json::from_value::<WindowKind>(json!("workspace")).unwrap(),
            WindowKind::Workspace
        );
    }

    #[test]
    fn window_record_terminal_wire() {
        // Local terminal, live client; `workspace_path` omitted.
        let rec = WindowRecord {
            window_id: "w-1a2b3c4d5e6f7081".into(),
            library_id: "local".into(),
            kind: WindowKind::Terminal,
            title: "🏠 Terminal Window 1".into(),
            ordinal: 1,
            label: String::new(),
            workspace_path: None,
            prefix: "/api/terminal".into(),
            token: "tok_term".into(),
            persisted: true,
            connected: true,
            active_transfer: false,
            control: false,
            hidden: false,
            origin: WindowOrigin::Native,
        };
        let v = serde_json::to_value(&rec).unwrap();
        assert_eq!(
            v,
            json!({
                "window_id": "w-1a2b3c4d5e6f7081",
                "library_id": "local",
                "kind": "terminal",
                "title": "🏠 Terminal Window 1",
                "ordinal": 1,
                "prefix": "/api/terminal",
                "token": "tok_term",
                "persisted": true,
                "connected": true,
                "active_transfer": false,
            })
        );
        assert_eq!(rec, serde_json::from_value(v).unwrap());
        let debug = format!("{rec:?}");
        assert!(debug.contains("[REDACTED]"));
        assert!(!debug.contains("tok_term"));
    }

    #[test]
    fn window_record_workspace_off_wire() {
        // Devserver library, workspace OFF (empty token), no client. `title`
        // carries the library's OWN-perspective ⌂ (the desktop re-decorates).
        let rec = WindowRecord {
            window_id: "w-99aa88bb77cc66dd".into(),
            library_id: "lib-0f1e2d3c4b5a6978".into(),
            kind: WindowKind::Workspace,
            title: "🏠 /home/u/notes Window 2".into(),
            ordinal: 2,
            label: "release checks".into(),
            workspace_path: Some("/home/u/notes".into()),
            prefix: "/api/notes-1a2b3c".into(),
            token: String::new(),
            persisted: true,
            connected: false,
            active_transfer: false,
            control: false,
            hidden: false,
            origin: WindowOrigin::Native,
        };
        assert_eq!(
            serde_json::to_value(&rec).unwrap(),
            json!({
                "window_id": "w-99aa88bb77cc66dd",
                "library_id": "lib-0f1e2d3c4b5a6978",
                "kind": "workspace",
                "title": "🏠 /home/u/notes Window 2",
                "ordinal": 2,
                "label": "release checks",
                "workspace_path": "/home/u/notes",
                "prefix": "/api/notes-1a2b3c",
                "token": "",
                "persisted": true,
                "connected": false,
                "active_transfer": false,
            })
        );
        // `#[serde(default)]`: a record minted before this field existed (no
        // `active_transfer` key) deserializes with the bit off -- the desktop
        // simply sees no in-flight transfer until the next push carries one.
        let legacy = json!({
            "window_id": "w-99aa88bb77cc66dd",
            "library_id": "lib-0f1e2d3c4b5a6978",
            "kind": "workspace",
            "title": "🏠 /home/u/notes Window 2",
            "ordinal": 2,
            "workspace_path": "/home/u/notes",
            "prefix": "/api/notes-1a2b3c",
            "token": "",
            "persisted": true,
            "connected": false,
        });
        let legacy = serde_json::from_value::<WindowRecord>(legacy).unwrap();
        assert!(!legacy.active_transfer);
        assert_eq!(legacy.label, "", "legacy rows default to no user text");
    }

    #[test]
    fn window_set_wire() {
        let set = WindowSet {
            windows: vec![WindowRecord {
                window_id: "w-1a2b3c4d5e6f7081".into(),
                library_id: "local".into(),
                kind: WindowKind::Terminal,
                title: "🏠 Terminal Window 1".into(),
                ordinal: 1,
                label: String::new(),
                workspace_path: None,
                prefix: "/api/terminal".into(),
                token: "tok_term".into(),
                persisted: true,
                connected: true,
                active_transfer: true,
                control: false,
                hidden: false,
                origin: WindowOrigin::Native,
            }],
            leaders: BTreeMap::new(),
        };
        let v = serde_json::to_value(&set).unwrap();
        assert_eq!(v["windows"][0]["window_id"], "w-1a2b3c4d5e6f7081");
        assert_eq!(v["windows"][0]["active_transfer"], true);
        // A non-control, visible window omits `control` AND `hidden` from the wire.
        assert!(v["windows"][0].get("control").is_none());
        assert!(v["windows"][0].get("hidden").is_none());
        assert_eq!(v["windows"].as_array().unwrap().len(), 1);
        // An empty leaders map is skip-if-empty: absent on the wire.
        assert!(v.get("leaders").is_none());
        assert_eq!(set, serde_json::from_value(v).unwrap());

        // A populated leaders map serializes as tenant `prefix` -> leader
        // `window_id`, keyed by the prefix a launcher reads off each record.
        let mut leaders = BTreeMap::new();
        leaders.insert(
            "/api/notes-1a2b3c".to_string(),
            "w-leaderwindow0001".to_string(),
        );
        let with_leaders = WindowSet {
            windows: vec![],
            leaders,
        };
        let v = serde_json::to_value(&with_leaders).unwrap();
        assert_eq!(v["leaders"]["/api/notes-1a2b3c"], "w-leaderwindow0001");
        assert_eq!(with_leaders, serde_json::from_value(v).unwrap());
    }

    #[test]
    fn control_record_via_to_record_is_terminal_first_and_control_flagged() {
        // The control record is now produced by `to_record` on a control row, not
        // a bespoke constructor. A hidden=true control row also
        // surfaces `hidden` on the wire.
        let row = PersistedWindow {
            window_id: "control-terminal-ds1".into(),
            kind: WindowKind::Terminal,
            title: "Control Terminal".into(),
            ordinal: 0,
            label: String::new(),
            workspace_path: None,
            control: true,
            library_id: Some("lib-0f1e2d3c4b5a6978".into()),
            hidden: true,
            origin: WindowOrigin::Native,
        };
        let rec = row.to_record(
            "lib-0f1e2d3c4b5a6978".into(),
            "/control-0".into(),
            "tok_ctl".into(),
            true,
        );
        assert_eq!(rec.kind, WindowKind::Terminal);
        assert_eq!(rec.library_id, "lib-0f1e2d3c4b5a6978");
        assert_eq!(rec.ordinal, 0, "rendered first");
        assert!(rec.control);
        assert!(rec.hidden);
        assert!(!rec.persisted, "transient, desktop-driven lifecycle");
        // `control` AND `hidden` are on the wire when true.
        let v = serde_json::to_value(&rec).unwrap();
        assert_eq!(v["control"], true);
        assert_eq!(v["hidden"], true);
        assert_eq!(rec, serde_json::from_value(v).unwrap());
    }

    #[test]
    fn create_window_wire() {
        let term = CreateWindow {
            kind: WindowKind::Terminal,
            workspace_path: None,
            origin: WindowOrigin::Native,
            acting_window_id: None,
        };
        assert_eq!(
            serde_json::to_value(&term).unwrap(),
            json!({ "kind": "terminal" })
        );
        assert_eq!(
            term,
            serde_json::from_value(json!({ "kind": "terminal" })).unwrap()
        );

        let ws = CreateWindow {
            kind: WindowKind::Workspace,
            workspace_path: Some("/home/u/notes".into()),
            origin: WindowOrigin::Native,
            acting_window_id: None,
        };
        assert_eq!(
            serde_json::to_value(&ws).unwrap(),
            json!({ "kind": "workspace", "workspace_path": "/home/u/notes" })
        );
    }

    #[test]
    fn window_origin_browser_wire() {
        // `native` is skip-if-default (absent on the wire); `browser` is explicit.
        assert_eq!(
            serde_json::to_value(WindowOrigin::Browser).unwrap(),
            json!("browser")
        );
        assert_eq!(
            serde_json::from_value::<WindowOrigin>(json!("native")).unwrap(),
            WindowOrigin::Native
        );

        // A browser mint carries the affinity; an absent origin reads as native
        // (so an existing client / row stays native).
        let browser = CreateWindow {
            kind: WindowKind::Workspace,
            workspace_path: Some("/n".into()),
            origin: WindowOrigin::Browser,
            acting_window_id: None,
        };
        assert_eq!(
            serde_json::to_value(&browser).unwrap(),
            json!({ "kind": "workspace", "workspace_path": "/n", "origin": "browser" })
        );
        let native: CreateWindow = serde_json::from_value(json!({ "kind": "terminal" })).unwrap();
        assert_eq!(native.origin, WindowOrigin::Native);

        // A browser row surfaces `origin` on the feed and round-trips; flipping it
        // back to native drops it off the wire.
        let mut rec = PersistedWindow {
            window_id: "w-b".into(),
            kind: WindowKind::Workspace,
            title: "🏠 /n Window 1".into(),
            ordinal: 1,
            label: String::new(),
            workspace_path: Some("/n".into()),
            control: false,
            library_id: None,
            hidden: false,
            origin: WindowOrigin::Browser,
        }
        .to_record("local".into(), "/api/n-0".into(), "tok".into(), true);
        assert_eq!(rec.origin, WindowOrigin::Browser);
        let v = serde_json::to_value(&rec).unwrap();
        assert_eq!(v["origin"], "browser");
        assert_eq!(rec, serde_json::from_value(v).unwrap());
        rec.origin = WindowOrigin::Native;
        let v = serde_json::to_value(&rec).unwrap();
        assert!(
            v.get("origin").is_none(),
            "native origin is skip-if-default"
        );
    }

    #[test]
    fn persisted_window_pins_field_names() {
        let p = PersistedWindow {
            window_id: "w-deadbeefdeadbeef".into(),
            kind: WindowKind::Workspace,
            title: "🏠 /n Window 1".into(),
            ordinal: 1,
            label: String::new(),
            workspace_path: Some("/n".into()),
            control: false,
            library_id: None,
            hidden: false,
            origin: WindowOrigin::Native,
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(
            v,
            json!({
                "window_id": "w-deadbeefdeadbeef",
                "kind": "workspace",
                "title": "🏠 /n Window 1",
                "ordinal": 1,
                "workspace_path": "/n",
            })
        );
        assert_eq!(p, serde_json::from_value(v).unwrap());
        let mut labeled = p.clone();
        labeled.label = "release checks".into();
        assert_eq!(
            serde_json::to_value(&labeled).unwrap()["label"],
            "release checks"
        );
        // A terminal row omits workspace_path AND the default control/library_id/hidden.
        let t = PersistedWindow {
            window_id: "w-0".into(),
            kind: WindowKind::Terminal,
            title: "🏠 Terminal Window 1".into(),
            ordinal: 1,
            label: String::new(),
            workspace_path: None,
            control: false,
            library_id: None,
            hidden: false,
            origin: WindowOrigin::Native,
        };
        assert_eq!(
            serde_json::to_value(&t).unwrap(),
            json!({ "window_id": "w-0", "kind": "terminal", "title": "🏠 Terminal Window 1", "ordinal": 1 })
        );
        // A control row carries `control` + the foreign `library_id`; all of
        // control/library_id/hidden are skip-if-default so they appear ONLY when set.
        let c = PersistedWindow {
            window_id: "control-terminal-ds1".into(),
            kind: WindowKind::Terminal,
            title: "Control Terminal".into(),
            ordinal: 0,
            label: String::new(),
            workspace_path: None,
            control: true,
            library_id: Some("lib-f81913a8ca0a6ff6".into()),
            hidden: false,
            origin: WindowOrigin::Native,
        };
        let cv = serde_json::to_value(&c).unwrap();
        assert_eq!(
            cv,
            json!({
                "window_id": "control-terminal-ds1",
                "kind": "terminal",
                "title": "Control Terminal",
                "ordinal": 0,
                "control": true,
                "library_id": "lib-f81913a8ca0a6ff6",
            })
        );
        assert_eq!(c, serde_json::from_value(cv).unwrap());
        // A hidden durable row carries `hidden` on disk (skip-if-default ⇒ present
        // only when true).
        let h = PersistedWindow {
            window_id: "w-1".into(),
            kind: WindowKind::Terminal,
            title: "🏠 Terminal Window 2".into(),
            ordinal: 2,
            label: String::new(),
            workspace_path: None,
            control: false,
            library_id: None,
            hidden: true,
            origin: WindowOrigin::Native,
        };
        let hv = serde_json::to_value(&h).unwrap();
        assert_eq!(hv["hidden"], true);
        assert_eq!(h, serde_json::from_value(hv).unwrap());
    }

    // --- control window -----------------------------------------------------

    #[test]
    fn create_control_row_shape() {
        let (reg, _d) = registry();
        let c = reg.create_control("control-terminal-ds1".into(), "lib-remote".into());
        assert_eq!(c.window_id, "control-terminal-ds1"); // desktop-supplied label
        assert!(c.control);
        assert_eq!(c.kind, WindowKind::Terminal); // no Control kind
        assert_eq!(c.ordinal, 0);
        assert_eq!(c.title, "Control Terminal");
        assert_eq!(c.library_id.as_deref(), Some("lib-remote")); // foreign id
        assert!(c.workspace_path.is_none());
        // It is in the live snapshot.
        assert!(reg
            .snapshot()
            .iter()
            .any(|w| w.window_id == "control-terminal-ds1" && w.control));
        // Re-create under the same label replaces (never duplicates).
        reg.create_control("control-terminal-ds1".into(), "lib-remote".into());
        assert_eq!(
            reg.snapshot()
                .iter()
                .filter(|w| w.window_id == "control-terminal-ds1")
                .count(),
            1
        );
    }

    #[test]
    fn control_rows_are_in_memory_only() {
        let (reg, dir) = registry();
        let path = dir.path().join("windows.json");
        reg.create_control("control-terminal-ds1".into(), "lib-remote".into());
        // A durable create triggers a save WHILE the control row is present; the
        // save filters control rows, so disk holds only the durable row.
        let durable = reg.create(WindowKind::Terminal, None);
        let reloaded = WindowRegistry::open(path);
        let ids: Vec<String> = reloaded
            .snapshot()
            .into_iter()
            .map(|w| w.window_id)
            .collect();
        assert!(ids.contains(&durable.window_id), "durable row persists");
        assert!(
            !ids.iter().any(|id| id == "control-terminal-ds1"),
            "control row is never written to disk"
        );
    }

    // --- visibility ---------------------------------------------------------

    #[test]
    fn set_hidden_toggles_and_matches() {
        let (reg, _d) = registry();
        let w = reg.create(WindowKind::Terminal, None);
        let hidden_of = |reg: &WindowRegistry, id: &str| {
            reg.snapshot()
                .into_iter()
                .find(|x| x.window_id == id)
                .map(|x| x.hidden)
        };
        // Unknown id ⇒ no match.
        assert!(!reg.set_hidden("nope", true));
        // Bury: matches, and the snapshot reflects it.
        assert!(reg.set_hidden(&w.window_id, true));
        assert_eq!(hidden_of(&reg, &w.window_id), Some(true));
        // Idempotent: setting the value it already holds still MATCHES (route 204,
        // not 404).
        assert!(reg.set_hidden(&w.window_id, true));
        // Unbury.
        assert!(reg.set_hidden(&w.window_id, false));
        assert_eq!(hidden_of(&reg, &w.window_id), Some(false));
    }

    /// A durable window's hidden state survives a reload (server is the source of
    /// truth).
    #[test]
    fn hidden_persists_across_reload() {
        let (reg, dir) = registry();
        let path = dir.path().join("windows.json");
        let w = reg.create(WindowKind::Terminal, None);
        assert!(reg.set_hidden(&w.window_id, true));
        let reloaded = WindowRegistry::open(path);
        assert_eq!(
            reloaded
                .snapshot()
                .into_iter()
                .find(|x| x.window_id == w.window_id)
                .map(|x| x.hidden),
            Some(true),
            "hidden persisted to disk"
        );
    }

    #[test]
    fn terminal_label_persists_across_reload_and_can_be_cleared() {
        let (reg, dir) = registry();
        let path = dir.path().join("windows.json");
        let window = reg.create(WindowKind::Terminal, None);
        assert!(!reg.set_label("nope", "ignored".into()));
        assert!(reg.set_label(&window.window_id, "release checks".into()));
        let reloaded = WindowRegistry::open(path.clone());
        assert_eq!(
            reloaded
                .snapshot()
                .into_iter()
                .find(|row| row.window_id == window.window_id)
                .map(|row| row.label),
            Some("release checks".into())
        );
        assert!(reloaded.set_label(&window.window_id, String::new()));
        let cleared = WindowRegistry::open(path);
        assert_eq!(
            cleared
                .snapshot()
                .into_iter()
                .find(|row| row.window_id == window.window_id)
                .map(|row| row.label),
            Some(String::new())
        );
    }

    // --- mint / ordinal / title --------------------------------------------

    #[test]
    fn mint_is_w_prefixed_hex_and_unique() {
        let (reg, _d) = registry();
        let mut ids = HashSet::new();
        for _ in 0..50 {
            let w = reg.create(WindowKind::Terminal, None);
            assert!(w.window_id.starts_with("w-"), "id: {}", w.window_id);
            assert_eq!(w.window_id.len(), 18, "w- + 16 hex chars");
            assert!(
                w.window_id[2..].chars().all(|c| c.is_ascii_hexdigit()),
                "id tail must be hex: {}",
                w.window_id
            );
            assert!(ids.insert(w.window_id), "minted a duplicate id");
        }
    }

    #[test]
    fn ordinal_is_lowest_free_per_kind_and_workspace() {
        let (reg, _d) = registry();
        // Terminals number independently: 1, 2, 3.
        let t1 = reg.create(WindowKind::Terminal, None);
        let t2 = reg.create(WindowKind::Terminal, None);
        let t3 = reg.create(WindowKind::Terminal, None);
        assert_eq!((t1.ordinal, t2.ordinal, t3.ordinal), (1, 2, 3));

        // A workspace numbers from 1 again (separate family); a different
        // workspace path is also its own family.
        let wa = reg.create(WindowKind::Workspace, Some("/a".into()));
        let wb = reg.create(WindowKind::Workspace, Some("/b".into()));
        assert_eq!((wa.ordinal, wb.ordinal), (1, 1));
        let wa2 = reg.create(WindowKind::Workspace, Some("/a".into()));
        assert_eq!(wa2.ordinal, 2);

        // Removing terminal #2 frees the slot; the next terminal reuses 2.
        assert!(reg.remove(&t2.window_id));
        let t = reg.create(WindowKind::Terminal, None);
        assert_eq!(t.ordinal, 2, "lowest-free is reused, not monotonic");
    }

    #[test]
    fn terminal_title_is_home_terminal_window_n() {
        let (reg, _d) = registry();
        let t = reg.create(WindowKind::Terminal, None);
        assert_eq!(t.title, "⌂ Terminal Window 1");
    }

    #[test]
    fn workspace_title_icon_follows_home_prefix() {
        // Under $HOME → ⌂; elsewhere → 🖥︎. Drive both via compose_title so the
        // test does not depend on a real registry path.
        let home = dirs::home_dir().expect("home dir");
        let under_home = home.join("notes");
        let title = compose_title(WindowKind::Workspace, 1, Some(under_home.to_str().unwrap()));
        assert!(
            title.starts_with(ICON_LOCAL_HOME),
            "under-home → ⌂: {title}"
        );
        assert!(title.ends_with("Window 1"));

        let elsewhere = compose_title(WindowKind::Workspace, 3, Some("/opt/elsewhere"));
        assert_eq!(
            elsewhere,
            format!("{ICON_LOCAL_OTHER} /opt/elsewhere Window 3")
        );
    }

    // --- persistence / assembly --------------------------------------------

    #[test]
    fn persist_round_trips_across_reopen() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("nested").join("windows.json");
        let ids: Vec<String> = {
            let reg = WindowRegistry::open(path.clone());
            let a = reg.create(WindowKind::Terminal, None);
            let b = reg.create(WindowKind::Workspace, Some("/n".into()));
            vec![a.window_id, b.window_id]
        };
        // A fresh registry over the same store sees the same windows.
        let reopened = WindowRegistry::open(path.clone());
        let snap = reopened.snapshot();
        assert_eq!(snap.len(), 2);
        for id in &ids {
            assert!(snap.iter().any(|w| &w.window_id == id), "missing {id}");
        }
        // 0600 + no leftover tmp.
        assert!(!path.with_extension("json.tmp").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "store must be 0600");
        }
    }

    #[test]
    fn first_open_marker_round_trips_and_is_co_located() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = dir.path().join("windows.json");
        {
            let reg = WindowRegistry::open(store.clone());
            // Fresh registry: empty + unmarked.
            assert!(reg.is_empty());
            assert!(!reg.first_open_done());
            reg.mark_first_open_done();
            assert!(reg.first_open_done());
            // Idempotent: a second mark is a no-op.
            reg.mark_first_open_done();
            assert!(reg.first_open_done());
        }
        // The marker survives a reopen and lives in the sibling state file
        // co-located with the window store.
        let state_file = dir.path().join("windows-state.json");
        assert!(
            state_file.exists(),
            "marker persists to a sibling state file"
        );
        let reopened = WindowRegistry::open(store);
        assert!(reopened.first_open_done(), "marker survives reopen");
    }

    #[test]
    fn snapshot_orders_terminals_before_workspaces() {
        let (reg, _d) = registry();
        reg.create(WindowKind::Workspace, Some("/z".into()));
        reg.create(WindowKind::Terminal, None);
        reg.create(WindowKind::Workspace, Some("/a".into()));
        let kinds: Vec<WindowKind> = reg.snapshot().iter().map(|w| w.kind).collect();
        assert_eq!(
            kinds,
            vec![
                WindowKind::Terminal,
                WindowKind::Workspace,
                WindowKind::Workspace
            ]
        );
        // Workspaces ordered by path (/a before /z).
        let paths: Vec<Option<String>> = reg
            .snapshot()
            .into_iter()
            .filter(|w| w.kind == WindowKind::Workspace)
            .map(|w| w.workspace_path)
            .collect();
        assert_eq!(paths, vec![Some("/a".into()), Some("/z".into())]);
    }

    #[test]
    fn to_record_assembles_live_state() {
        let p = PersistedWindow {
            window_id: "w-abc".into(),
            kind: WindowKind::Workspace,
            title: "🏠 /n Window 1".into(),
            ordinal: 1,
            label: "release checks".into(),
            workspace_path: Some("/n".into()),
            control: false,
            library_id: None,
            hidden: false,
            origin: WindowOrigin::Native,
        };
        let rec = p.to_record("local".into(), "/api/n-0".into(), String::new(), false);
        assert_eq!(rec.window_id, "w-abc");
        assert_eq!(rec.library_id, "local");
        assert_eq!(rec.prefix, "/api/n-0");
        assert_eq!(rec.token, "");
        assert!(rec.persisted, "a non-control registry row is persisted");
        assert!(!rec.control);
        assert!(!rec.connected);
        // `to_record` leaves the transfer bit off; the feed assembly overlays it.
        assert!(!rec.active_transfer);
        // The durable fields carry through unchanged.
        assert_eq!(rec.kind, WindowKind::Workspace);
        assert_eq!(rec.ordinal, 1);
        assert_eq!(rec.label, "release checks");
        assert_eq!(rec.workspace_path.as_deref(), Some("/n"));

        // A control row assembles to control:true + persisted:false, carrying the
        // foreign library_id passed by the assembly.
        let c = PersistedWindow {
            window_id: "control-terminal-ds1".into(),
            kind: WindowKind::Terminal,
            title: "Control Terminal".into(),
            ordinal: 0,
            label: String::new(),
            workspace_path: None,
            control: true,
            library_id: Some("lib-remote".into()),
            hidden: false,
            origin: WindowOrigin::Native,
        };
        let crec = c.to_record("lib-remote".into(), "/control-0".into(), "tok".into(), true);
        assert!(crec.control);
        assert!(!crec.persisted, "a control row is transient, not persisted");
        assert_eq!(crec.library_id, "lib-remote");
        assert_eq!(crec.prefix, "/control-0");
        assert!(crec.connected);
    }

    #[test]
    fn remove_is_idempotent_and_persists() {
        let (reg, _d) = registry();
        let w = reg.create(WindowKind::Terminal, None);
        assert!(reg.remove(&w.window_id), "first remove drops the row");
        assert!(reg.snapshot().is_empty());
        assert!(!reg.remove(&w.window_id), "second remove is a no-op false");
        assert!(!reg.remove("w-nope"), "unknown id is false");
    }

    #[test]
    fn remove_terminal_only_removes_non_control_terminal_rows() {
        // The shared terminal tenant's hook drops a standalone
        // terminal row, but must never touch a workspace window (its panes'
        // deaths must not close it) or a control window (the desktop
        // exit-watcher owns those).
        let (reg, _d) = registry();
        let term = reg.create(WindowKind::Terminal, None);
        let ws = reg.create(WindowKind::Workspace, Some("/tmp/ws".to_string()));
        let ctrl = reg.create_control("ctl-win".to_string(), "lib-remote".to_string());

        assert!(!reg.remove_terminal(&ws.window_id), "workspace row kept");
        assert!(!reg.remove_terminal(&ctrl.window_id), "control row kept");
        assert!(reg.remove_terminal(&term.window_id), "terminal row reaped");
        assert!(
            !reg.remove_terminal(&term.window_id),
            "second remove is a no-op false"
        );
        assert!(!reg.remove_terminal("w-nope"), "unknown id is false");

        let ids: Vec<String> = reg.snapshot().into_iter().map(|w| w.window_id).collect();
        assert!(ids.contains(&ws.window_id), "workspace survives");
        assert!(ids.contains(&ctrl.window_id), "control survives");
        assert!(!ids.contains(&term.window_id), "terminal gone");
    }

    // --- change notification (watch broadcaster contract) ------------------

    #[tokio::test]
    async fn change_notify_wakes_a_waiter_on_create() {
        let reg = Arc::new(WindowRegistry::open(
            tempfile::tempdir().unwrap().path().join("w.json"),
        ));
        let notify = reg.change_notify();
        let waiter = tokio::spawn(async move { notify.notified().await });
        // Let the spawned task poll `notified()` once so its waiter is parked
        // before we fire (current-thread runtime makes this deterministic).
        tokio::task::yield_now().await;
        reg.create(WindowKind::Terminal, None);
        tokio::time::timeout(std::time::Duration::from_secs(1), waiter)
            .await
            .expect("change_notify woke the waiter")
            .expect("waiter task ok");
    }
}
