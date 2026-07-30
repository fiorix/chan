//! Headless multi-workspace devserver.
//!
//! `run_devserver` binds a [`WorkspaceHost`] to a real address and adds two
//! surfaces a desktop client and the `chan open` CLI drive over it:
//!
//! - A management HTTP/JSON API under the reserved `/api/devserver/*`
//!   namespace ([`crate::devserver_api`]): list, mount, forget workspaces
//!   and open standalone terminals. Workspace tenants mount at their keyed
//!   pathspec `/{slug}-{8hex}` (top-level), so the gateway forwards
//!   `{owner}--{disc}.{proxy}.usr.{domain}/{slug}-{8hex}/` unchanged and the
//!   devserver routes the tenant by it; the explicit `/api/devserver/*` and `/api/library/*`
//!   management routes match before the per-tenant fallback, and the only
//!   reserved top-level slug is `api`.
//! - A per-user discovery namespace ([`crate::devserver_handoff`]): each local
//!   instance publishes a stable endpoint, and `chan open <path>` selects one,
//!   registers the workspace there, then exits instead of binding a second
//!   server, so the devserver owns the single-writer flock.
//!
//! What was mounted survives a restart: the enabled workspace roots and the
//! devserver bearer token persist in `~/.chan/devserver/config.json` (0600).
//! Per-window pane/tab layout is NOT persisted here; each tenant is a full
//! workspace mount that already stores its own SPA session per window, so a
//! reconnecting client re-hydrates its panes from the tenant. Under the Linux
//! systemd unit, terminal PTYs survive EVERY restart flavor: each windowed
//! session parks its master fd in the systemd fd store continuously, and boot
//! re-associates the inherited masters with freshly built session objects.
//! Per-tenant control sockets bind at paths derived from the persisted
//! library id (not the pid), so the `$CHAN_CONTROL_SOCKET` baked into
//! already-open shells reaches the restarted instance and `cs` keeps working.

use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::future::Future;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU16, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use anyhow::Context;
use axum::body::Body;
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{header, Request as HttpRequest, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use chan_workspace::Library;
use serde::{Deserialize, Serialize};

use crate::auth::random_token;
use crate::devserver_api::{
    ActiveTerminalsRejection, DevserverInfo, DevserverWindow, MountedPrefix, OpenWorkspaceRequest,
    RotatedToken, SetWorkspaceOnRequest, WorkspaceEntry, DEVSERVER_API_PROTOCOL,
};
use crate::{Error, ServeConfig, WorkspaceHost, WorkspaceLifecycleOutcome, WorkspaceStatus};
// Prefix allocation lives in chan-library (the window-record assembly needs the
// stable OFF-workspace prefix); the devserver mounts at the same prefix.
use chan_library::windows::WindowRegistry;
use chan_library::{
    allocate_workspace_prefix, FileLocalColor, PersistedWorkspace, WorkspaceOverlay,
};

mod fdstore;

/// Inputs the CLI resolves for `chan devserver`. The `--service=systemd`
/// supervision path is layered on in the CLI around this; the runtime
/// itself only needs where to bind, how to label the box, and whether to
/// also dial the gateway tunnel.
pub struct DevserverConfig {
    /// Address to bind the public HTTP listener.
    pub addr: SocketAddr,
    /// Human label for the box (drives the client's grouping header).
    pub host_label: String,
    /// When set, the devserver also dials the gateway and publishes its
    /// tenant content at `{owner}--{disc}.{proxy}.usr.{domain}/{workspace}/*`. `None`
    /// leaves it local-only (management API + discovery socket on `addr`).
    pub tunnel: Option<DevserverTunnel>,
    /// Bind the local TCP listener on `addr`. `false` in tunnel-only mode
    /// (publish through the gateway; binding the loopback port is pure
    /// overhead behind it). `addr` is still used for the bound-address report,
    /// the discovery socket, and the per-tenant window records; only the TCP
    /// bind is skipped. The CLI resolves this from `CHAN_DEVSERVER_LISTEN` +
    /// tunnel presence (see `cmd_devserver`).
    pub listen: bool,
}

/// Gateway tunnel registration for a devserver. The devserver identity is
/// resolved backend-side from the token (PAT SHA-256); the whole library
/// rides one registration. `name` is display-only metadata for the roster.
#[derive(Clone)]
pub struct DevserverTunnel {
    /// Tunnel endpoint URL (`--tunnel-url` / `CHAN_TUNNEL_URL`; required,
    /// no compiled-in default).
    pub tunnel_url: String,
    /// Personal access token (`chan_pat_*`) from the gateway identity origin.
    pub token: String,
    /// Display name announced in the tunnel `Hello` for the gateway
    /// roster. The CLI resolves it (`--tunnel-devserver-name`, else the
    /// hostname), trimmed and capped; never empty. Routing-inert.
    pub name: String,
}

impl std::fmt::Debug for DevserverTunnel {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DevserverTunnel")
            .field("tunnel_url", &tunnel_url_without_userinfo(&self.tunnel_url))
            .field("token", &"[REDACTED]")
            .field("name", &self.name)
            .finish()
    }
}

fn tunnel_url_without_userinfo(raw: &str) -> String {
    let Ok(mut url) = url::Url::parse(raw) else {
        return "[INVALID URL REDACTED]".into();
    };
    let _ = url.set_password(None);
    let _ = url.set_username("");
    url.to_string()
}

/// On-disk devserver state: the bearer token (reused across restarts so a
/// reconnecting client keeps working, but rotated by the operator verb and
/// on a cold start once it outlives [`DEVSERVER_TOKEN_MAX_AGE_SECS`]) and
/// the stable library identity. Workspace on/off lives in the library-owned
/// [`WorkspaceOverlay`] store (`~/.chan/devserver/workspaces.json`), not here.
#[derive(Default, Serialize, Deserialize)]
struct PersistedConfig {
    #[serde(default)]
    devserver_token: String,
    /// Unix seconds when `devserver_token` was minted. `0` (the default,
    /// and every pre-rotation config) reads as "unknown age" and rotates
    /// on the next cold start, deliberately retiring pre-fix tokens.
    #[serde(default)]
    token_minted_at: u64,
    /// This library's stable identity, minted once (`lib-<16hex>`) and persisted
    /// so it survives restart. Stamped on every window record; a client
    /// merging several libraries' feeds partitions by it.
    #[serde(default)]
    library_id: String,
    /// The last bound TCP port. A local client (the desktop) re-discovers the
    /// current port from here after a restart, instead of trusting a stored URL
    /// that goes stale when a `--port 0` devserver restarts on a different
    /// OS-assigned port. `0` (the default) means not yet bound.
    #[serde(default)]
    port: u16,
}

impl std::fmt::Debug for PersistedConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PersistedConfig")
            .field("devserver_token", &"[REDACTED]")
            .field("library_id", &self.library_id)
            .field("port", &self.port)
            .finish()
    }
}

/// Persistence at `~/.chan/devserver/config.json`, written atomically and
/// locked 0600 since it holds the bearer token.
struct DevserverStore {
    path: PathBuf,
}

impl DevserverStore {
    fn at(path: PathBuf) -> Self {
        Self { path }
    }

    /// Read the persisted config, or a default when the file is absent or
    /// unreadable. An unreadable file degrades to a fresh token + empty set
    /// rather than refusing to start.
    fn load(&self) -> PersistedConfig {
        match std::fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
            Err(_) => PersistedConfig::default(),
        }
    }

    fn save(&self, cfg: &PersistedConfig) -> std::io::Result<()> {
        let bytes = serialize_persisted_config(cfg)?;
        crate::atomic_file::write(&self.path, &bytes, Some(0o600))
    }

    #[cfg(test)]
    fn save_with_pre_persist_hook(
        &self,
        cfg: &PersistedConfig,
        pre_persist: impl FnOnce(&Path) -> std::io::Result<()>,
    ) -> std::io::Result<()> {
        let bytes = serialize_persisted_config(cfg)?;
        crate::atomic_file::write_with_pre_persist_hook(
            &self.path,
            &bytes,
            Some(0o600),
            pre_persist,
        )
    }
}

fn serialize_persisted_config(cfg: &PersistedConfig) -> std::io::Result<Vec<u8>> {
    serde_json::to_vec_pretty(cfg)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))
}

/// The session store for the shared standalone-terminal tenant:
/// `~/.chan/devserver/terminals/`. Each terminal window's per-window pane/tab
/// layout blob is keyed by its `?w=<window_id>` here, so the layout survives a
/// devserver restart (with fresh PTYs). `None` when there is no home dir (the
/// tenant then falls back to the in-memory `ephemeral_sessions`).
fn devserver_terminals_dir() -> Option<PathBuf> {
    // Routed through the single chan-home authority so `CHAN_HOME` relocates it.
    Some(
        chan_workspace::paths::config_dir()
            .join("devserver")
            .join("terminals"),
    )
}

fn devserver_config_path() -> std::io::Result<PathBuf> {
    // Routed through the single chan-home authority (`config_dir`) so `CHAN_HOME`
    // relocates it; `config_dir` is infallible, so this no longer errors.
    Ok(chan_workspace::paths::config_dir()
        .join("devserver")
        .join("config.json"))
}

/// Machine-readable marker the desktop control terminal scrapes from the
/// connect-script output to learn the devserver's bearer token, on every
/// connect and reconnect; the token value runs from the `=` to end of line.
/// LOCKED wire string: the desktop matches this exact prefix, so both the
/// foreground emit and the `--service=systemd --join` re-attach emit build to it.
pub const DEVSERVER_TOKEN_MARKER: &str = "CHAN_DEVSERVER_TOKEN=";

/// Maximum age of the persisted bearer token: 30 days. A cold start whose
/// token is older (or whose mint time is unrecorded) re-mints instead of
/// reusing it, so a token that leaked through a scrollback snapshot, a
/// backup, or a pasted log stops working at the next start after the
/// window instead of forever. Within the window restarts keep the token,
/// preserving the reconnecting-client property.
pub const DEVSERVER_TOKEN_MAX_AGE_SECS: u64 = 30 * 24 * 60 * 60;

fn unix_now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Read the persisted devserver bearer token from
/// `~/.chan/devserver/config.json`, or `None` when it is absent, unreadable,
/// or tokenless. The `--service=systemd --join` re-attach path prints the
/// [`DEVSERVER_TOKEN_MARKER`] from this, since a journal-follow does not
/// re-emit the running unit's original start line.
pub fn persisted_devserver_token() -> Option<String> {
    let store = DevserverStore::at(devserver_config_path().ok()?);
    let token = store.load().devserver_token;
    (!token.is_empty()).then_some(token)
}

/// Rotate the persisted devserver bearer token WITHOUT a running server:
/// re-mint, stamp the mint time, and save through the same atomic 0600
/// store. Returns the new token, or `None` when no config with a token
/// exists (nothing to rotate). The CLI verb uses this as its no-server
/// fallback; a devserver somehow still running elsewhere keeps accepting
/// its in-memory token until it restarts, which the caller must say.
pub fn rotate_persisted_devserver_token() -> std::io::Result<Option<String>> {
    let store = DevserverStore::at(devserver_config_path()?);
    let mut cfg = store.load();
    if cfg.devserver_token.is_empty() {
        return Ok(None);
    }
    cfg.devserver_token = random_token();
    cfg.token_minted_at = unix_now_secs();
    store.save(&cfg)?;
    Ok(Some(cfg.devserver_token))
}

/// Read the last bound TCP port the devserver recorded in
/// `~/.chan/devserver/config.json`, or `None` when nothing is recorded (`0`).
/// The CLI's supervised management verbs dial the running service through
/// this when its unit pins no `--port` (a listening tunnel-mode devserver
/// binds an OS-assigned port); the record is written before the readiness
/// notify, so an active unit has already persisted it.
pub fn persisted_devserver_port() -> Option<u16> {
    let store = DevserverStore::at(devserver_config_path().ok()?);
    let port = store.load().port;
    (port != 0).then_some(port)
}

/// A single workspace mount attempt may spend at most this long acquiring the
/// workspace and building its tenant. A timeout remains a visible desired-on
/// failure; it never wedges systemd READY forever.
const WORKSPACE_MOUNT_TIMEOUT: Duration = Duration::from_secs(60);
/// Absolute cold-start restore budget. Remaining desired-on rows become
/// visible failures when it expires; the systemd unit grants ten minutes.
const STARTUP_RESTORE_TIMEOUT: Duration = Duration::from_secs(8 * 60);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DesiredMount {
    On,
    Off,
    /// In-memory tombstone retained until an older mount attempt settles.
    Forgotten,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum MountPhase {
    Starting,
    Mounted,
    Stopped,
    Failed(String),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum MountCompletion {
    Adopted,
    CloseStale,
    ForgetStale,
}

/// A registered workspace as the devserver tracks it, keyed by stable prefix.
///
/// Desired intent and its generation are authoritative. `phase` is observed
/// serving progress; only a completion for the current desired-on generation
/// may publish a mounted token.
#[derive(Clone)]
struct WorkspaceRecord {
    root: PathBuf,
    prefix: String,
    label: String,
    desired: DesiredMount,
    phase: MountPhase,
    generation: u64,
    token: String,
}

impl WorkspaceRecord {
    fn prepared(root: PathBuf, prefix: String, desired_on: bool, generation: u64) -> Self {
        let label = workspace_label(&root);
        Self {
            root,
            prefix,
            label,
            desired: if desired_on {
                DesiredMount::On
            } else {
                DesiredMount::Off
            },
            phase: if desired_on {
                MountPhase::Starting
            } else {
                MountPhase::Stopped
            },
            generation,
            token: String::new(),
        }
    }

    fn advance_generation(&mut self) {
        self.generation = self.generation.wrapping_add(1);
    }

    /// Begin a fresh desired-on attempt, or return `None` when the current
    /// desired-on generation is already starting/running.
    fn begin_on(&mut self) -> Option<u64> {
        if self.desired == DesiredMount::On
            && matches!(self.phase, MountPhase::Starting | MountPhase::Mounted)
        {
            return None;
        }
        self.advance_generation();
        self.desired = DesiredMount::On;
        self.phase = MountPhase::Starting;
        self.token.clear();
        Some(self.generation)
    }

    fn turn_off(&mut self) -> bool {
        if self.desired == DesiredMount::Off && self.phase == MountPhase::Stopped {
            return false;
        }
        self.advance_generation();
        self.desired = DesiredMount::Off;
        self.phase = MountPhase::Stopped;
        self.token.clear();
        true
    }

    fn forget(&mut self) {
        if self.desired != DesiredMount::Forgotten {
            self.advance_generation();
        }
        self.desired = DesiredMount::Forgotten;
        self.phase = MountPhase::Stopped;
        self.token.clear();
    }

    fn complete_success(&mut self, generation: u64, token: String) -> MountCompletion {
        if self.generation == generation && self.desired == DesiredMount::On {
            self.phase = MountPhase::Mounted;
            self.token = token;
            MountCompletion::Adopted
        } else if self.desired == DesiredMount::Forgotten {
            MountCompletion::ForgetStale
        } else {
            MountCompletion::CloseStale
        }
    }

    fn complete_failure(&mut self, generation: u64, reason: String) -> bool {
        if self.generation != generation || self.desired != DesiredMount::On {
            return false;
        }
        self.phase = MountPhase::Failed(reason);
        self.token.clear();
        true
    }

    fn reconcile_persisted(&mut self, persisted: &PersistedWorkspace, mounted: bool) {
        if persisted.generation <= self.generation {
            return;
        }
        self.generation = persisted.generation;
        self.desired = if persisted.desired_on {
            DesiredMount::On
        } else {
            DesiredMount::Off
        };
        self.phase = if persisted.desired_on {
            if mounted {
                MountPhase::Mounted
            } else {
                MountPhase::Starting
            }
        } else {
            self.token.clear();
            MountPhase::Stopped
        };
    }

    fn persisted(&self) -> Option<PersistedWorkspace> {
        if self.desired == DesiredMount::Forgotten {
            return None;
        }
        Some(PersistedWorkspace {
            path: self.root.to_string_lossy().into_owned(),
            desired_on: self.desired == DesiredMount::On,
            generation: self.generation,
        })
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct MountAttemptKey {
    prefix: String,
    generation: u64,
}

impl MountAttemptKey {
    fn new(prefix: impl Into<String>, generation: u64) -> Self {
        Self {
            prefix: prefix.into(),
            generation,
        }
    }
}

#[derive(Clone, Debug)]
struct MountAttempt {
    root: PathBuf,
    prefix: String,
    generation: u64,
}

impl MountAttempt {
    fn key(&self) -> MountAttemptKey {
        MountAttemptKey::new(self.prefix.clone(), self.generation)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum StartupPhase {
    PreparingRows,
    Binding,
    FdstoreApplied,
    ServingAndRestoring,
    Ready,
    Stopping,
    Stopped,
}

struct StartupInner {
    phase: StartupPhase,
    pending: HashSet<MountAttemptKey>,
}

/// Serializes startup effects and the READY boundary. Mount intents register
/// before they spawn; READY atomically closes registration for startup work
/// only after every registered attempt has settled.
struct StartupCoordinator {
    inner: Mutex<StartupInner>,
    changed: tokio::sync::Notify,
}

impl StartupCoordinator {
    fn new() -> Self {
        Self {
            inner: Mutex::new(StartupInner {
                phase: StartupPhase::PreparingRows,
                pending: HashSet::new(),
            }),
            changed: tokio::sync::Notify::new(),
        }
    }

    #[cfg(test)]
    fn phase(&self) -> StartupPhase {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).phase
    }

    fn advance(&self, next: StartupPhase) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let valid = matches!(
            (inner.phase, next),
            (StartupPhase::PreparingRows, StartupPhase::Binding)
                | (StartupPhase::Binding, StartupPhase::FdstoreApplied)
                | (
                    StartupPhase::FdstoreApplied,
                    StartupPhase::ServingAndRestoring
                )
                | (StartupPhase::Stopping, StartupPhase::Stopped)
        );
        if !valid {
            return Err(format!(
                "invalid devserver startup transition {:?} -> {next:?}",
                inner.phase
            ));
        }
        inner.phase = next;
        drop(inner);
        self.changed.notify_waiters();
        Ok(())
    }

    fn track(&self, attempt: MountAttemptKey) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if inner.phase == StartupPhase::Ready {
            // Post-readiness user mounts are ordinary serving work. They still
            // carry generations, but cannot retroactively gate READY.
            return Ok(());
        }
        if !matches!(
            inner.phase,
            StartupPhase::PreparingRows | StartupPhase::ServingAndRestoring
        ) {
            return Err(format!(
                "cannot start workspace mount while devserver is {:?}",
                inner.phase
            ));
        }
        inner.pending.insert(attempt);
        drop(inner);
        self.changed.notify_waiters();
        Ok(())
    }

    fn settle(&self, attempt: &MountAttemptKey) {
        let removed = self
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .pending
            .remove(attempt);
        if removed {
            self.changed.notify_waiters();
        }
    }

    async fn ready_after_restore(&self) -> bool {
        loop {
            let notified = self.changed.notified();
            {
                let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
                match inner.phase {
                    StartupPhase::ServingAndRestoring if inner.pending.is_empty() => {
                        inner.phase = StartupPhase::Ready;
                        return true;
                    }
                    StartupPhase::Stopping | StartupPhase::Stopped => return false,
                    _ => {}
                }
            }
            notified.await;
        }
    }

    fn stop(&self) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if inner.phase != StartupPhase::Stopped {
            inner.phase = StartupPhase::Stopping;
        }
        drop(inner);
        self.changed.notify_waiters();
    }

    fn stopped(&self) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.phase = StartupPhase::Stopped;
        inner.pending.clear();
        drop(inner);
        self.changed.notify_waiters();
    }
}

#[derive(Debug)]
struct MountTimedOut;

async fn time_bound_mount<T>(
    timeout: Duration,
    future: impl Future<Output = T>,
) -> Result<T, MountTimedOut> {
    tokio::time::timeout(timeout, future)
        .await
        .map_err(|_| MountTimedOut)
}

#[derive(Debug)]
enum SetWorkspaceOnResult {
    Updated(Option<WorkspaceEntry>),
    Refused { active_terminals: usize },
}

#[derive(Deserialize, Default)]
struct ForceQuery {
    #[serde(default)]
    force: bool,
}

/// Shared runtime state behind the management API and the discovery socket.
struct DevserverState {
    host: Arc<WorkspaceHost>,
    addr: SocketAddr,
    /// Devserver-level bearer token, distinct from per-workspace tokens.
    /// A shared cell (not a plain `String`) because the launcher bundle's
    /// gates read the same value: one [`rotate_token`](Self::rotate_token)
    /// write retires the old bearer on every surface at once.
    token: crate::routes::LauncherBearer,
    /// Unix seconds when the current token was minted; persisted so the
    /// cold-start age check ([`resolve_boot_token`]) has ground truth.
    token_minted_at: AtomicU64,
    /// This library's stable identity (`lib-<16hex>`), persisted with the token.
    library_id: String,
    host_label: String,
    /// Registered workspaces by stable prefix, on and off.
    workspaces: Mutex<HashMap<String, WorkspaceRecord>>,
    /// Extends the host's mount serialization through generation adoption or
    /// compensating cleanup, so a newer attempt cannot adopt a tenant that an
    /// older stale completion is about to close.
    mount_attempt_lock: tokio::sync::Mutex<()>,
    startup: Arc<StartupCoordinator>,
    store: DevserverStore,
    /// Orders persisted snapshot capture and publication across both stores.
    persist_serial: Mutex<()>,
    /// The actual bound TCP port (`local_addr().port()`); `0` until bound.
    /// Persisted so a local client re-discovers the current port after a restart.
    bound_port: AtomicU16,
}

/// Makes startup tracking cancellation-safe for request-owned mount futures.
///
/// Dropping an in-flight handler future must publish a terminal failure and
/// settle its READY key. Explicit success, error, and timeout paths disarm the
/// guard after performing their more specific completion.
struct MountAttemptSettlement<'a> {
    state: &'a DevserverState,
    attempt: &'a MountAttempt,
    armed: bool,
}

impl<'a> MountAttemptSettlement<'a> {
    fn new(state: &'a DevserverState, attempt: &'a MountAttempt) -> Self {
        Self {
            state,
            attempt,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for MountAttemptSettlement<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.state.finish_failed_attempt(
                self.attempt,
                "mount cancelled before completion".to_string(),
            );
        }
    }
}

impl DevserverState {
    /// Register the workspace at `root` and mount it (on). Allocates the
    /// stable prefix, mounts via [`mount_at`](Self::mount_at), persists, and
    /// returns the prefix. Idempotent on the root (an already-mounted root
    /// returns its existing prefix). Used by `POST workspaces` and the
    /// discovery socket; `POST .../{prefix}/on` is the explicit-toggle sibling.
    async fn register_workspace(&self, root: &Path) -> Result<String, Error> {
        let prefix = allocate_workspace_prefix(root)?;
        let mounted = self.mount_at(root, &prefix).await?;
        Ok(mounted)
    }

    /// Publish desired-on + `starting` before awaiting the bounded mount.
    /// Returns the prefix actually mounted at (or the current stable prefix
    /// when an equivalent attempt is already pending).
    ///
    /// Rejects a `prefix` that collides with the reserved `/api/` namespace.
    /// The host's own collision guard rejects a `prefix` already taken by a
    /// DIFFERENT root (two workspaces with the same basename slug), surfacing
    /// the design's "slug uniqueness within a devserver".
    async fn mount_at(&self, root: &Path, prefix: &str) -> Result<String, Error> {
        let Some(attempt) = self.begin_mount(root, prefix)? else {
            return Ok(prefix.to_string());
        };
        self.persist_state();
        self.execute_mount_attempt(attempt, WORKSPACE_MOUNT_TIMEOUT)
            .await
    }

    fn begin_mount(&self, root: &Path, prefix: &str) -> Result<Option<MountAttempt>, Error> {
        if prefix == RESERVED_WORKSPACE_PREFIX {
            return Err(Error::Config(format!(
                "cannot mount a workspace at {prefix}: that path is reserved for the devserver \
                 management API (/api/*). Rename the workspace directory; its basename becomes \
                 the public slug."
            )));
        }
        self.host.library().register_workspace(root)?;
        let canonical = canonical_root(root);
        let attempt = {
            let mut workspaces = self.workspaces.lock().unwrap_or_else(|e| e.into_inner());
            let mut record = match workspaces.get(prefix).cloned() {
                Some(record) if canonical_root(&record.root) != canonical => {
                    return Err(Error::Config(format!(
                        "workspace prefix {prefix} already belongs to {}",
                        record.root.display()
                    )));
                }
                Some(mut record) => {
                    if record.phase == MountPhase::Mounted
                        && !self.host.is_root_mounted(&record.root)
                    {
                        record.turn_off();
                    }
                    record
                }
                None => WorkspaceRecord::prepared(canonical.clone(), prefix.to_string(), false, 0),
            };
            let Some(generation) = record.begin_on() else {
                return Ok(None);
            };
            let attempt = MountAttempt {
                root: canonical,
                prefix: prefix.to_string(),
                generation,
            };
            self.startup.track(attempt.key()).map_err(Error::Config)?;
            workspaces.insert(prefix.to_string(), record);
            attempt
        };
        self.host.mark_workspace_starting(&attempt.root);
        Ok(Some(attempt))
    }

    async fn execute_mount_attempt(
        &self,
        attempt: MountAttempt,
        timeout: Duration,
    ) -> Result<String, Error> {
        let mut settlement = MountAttemptSettlement::new(self, &attempt);
        let _attempt_guard = self.mount_attempt_lock.lock().await;
        if !self.reconcile_attempt_intent(&attempt, false) {
            self.restore_current_host_lifecycle(&attempt.prefix);
            self.remove_finished_tombstone(&attempt.prefix);
            self.startup.settle(&attempt.key());
            self.persist_state();
            settlement.disarm();
            return Ok(attempt.prefix.clone());
        }
        let result = time_bound_mount(
            timeout,
            self.host.open_or_get_registered_workspace(
                &attempt.root,
                tenant_config(self.addr, &attempt.prefix),
            ),
        )
        .await;
        match result {
            Ok(Ok(hosted)) => {
                let token = hosted.handle.token.clone().unwrap_or_default();
                self.reconcile_attempt_intent(&attempt, true);
                let completion = {
                    let mut workspaces = self.workspaces.lock().unwrap_or_else(|e| e.into_inner());
                    workspaces
                        .get_mut(&attempt.prefix)
                        .map(|record| record.complete_success(attempt.generation, token))
                        .unwrap_or(MountCompletion::ForgetStale)
                };
                match completion {
                    MountCompletion::Adopted => {}
                    MountCompletion::CloseStale => {
                        let _ = self.host.close_workspace(&hosted.prefix, true).await;
                        self.restore_current_host_lifecycle(&attempt.prefix);
                    }
                    MountCompletion::ForgetStale => {
                        let _ = self
                            .host
                            .remove_workspace_for_root(&attempt.root, true)
                            .await;
                        self.remove_finished_tombstone(&attempt.prefix);
                    }
                }
                self.startup.settle(&attempt.key());
                self.persist_state();
                settlement.disarm();
                Ok(hosted.prefix)
            }
            Ok(Err(error)) => {
                let reason = error.to_string();
                self.finish_failed_attempt(&attempt, reason);
                settlement.disarm();
                Err(error)
            }
            Err(MountTimedOut) => {
                // The timeout drops the in-flight future. Compensate in case it
                // inserted a tenant immediately before cancellation.
                let _ = self.host.close_workspace(&attempt.prefix, true).await;
                let reason = format!("mount timed out after {} seconds", timeout.as_secs().max(1));
                self.finish_failed_attempt(&attempt, reason.clone());
                settlement.disarm();
                Err(Error::Config(reason))
            }
        }
    }

    /// Fold host-level `chan close` / `chan close --remove` intent into the
    /// devserver's pending record before it opens or publishes a tenant.
    ///
    /// Those commands reach [`WorkspaceHost`] directly through the control
    /// socket. The shared overlay generation is therefore the ordering edge:
    /// a newer off row supersedes this attempt, while an absent registry row
    /// means a concurrent remove won.
    fn reconcile_attempt_intent(&self, attempt: &MountAttempt, mounted: bool) -> bool {
        let registered = self
            .host
            .library()
            .workspace_paths_for(&attempt.root)
            .is_some();
        let persisted = self.host.workspace_overlay().and_then(|overlay| {
            overlay
                .entries()
                .into_iter()
                .find(|row| canonical_root(Path::new(&row.path)) == canonical_root(&attempt.root))
        });
        let mut workspaces = self.workspaces.lock().unwrap_or_else(|e| e.into_inner());
        let Some(record) = workspaces.get_mut(&attempt.prefix) else {
            return false;
        };
        if !registered {
            record.forget();
        } else if let Some(persisted) = persisted {
            record.reconcile_persisted(&persisted, mounted);
        }
        record.generation == attempt.generation && record.desired == DesiredMount::On
    }

    fn finish_failed_attempt(&self, attempt: &MountAttempt, reason: String) {
        let adopted_failure = {
            let mut workspaces = self.workspaces.lock().unwrap_or_else(|e| e.into_inner());
            workspaces
                .get_mut(&attempt.prefix)
                .is_some_and(|record| record.complete_failure(attempt.generation, reason.clone()))
        };
        if adopted_failure {
            self.host.mark_workspace_failed(&attempt.root, reason);
        } else {
            self.restore_current_host_lifecycle(&attempt.prefix);
            self.remove_finished_tombstone(&attempt.prefix);
        }
        self.startup.settle(&attempt.key());
        self.persist_state();
    }

    fn restore_current_host_lifecycle(&self, prefix: &str) {
        let current = {
            let workspaces = self.workspaces.lock().unwrap_or_else(|e| e.into_inner());
            workspaces
                .get(prefix)
                .map(|record| (record.root.clone(), record.phase.clone()))
        };
        match current {
            Some((root, MountPhase::Starting)) => self.host.mark_workspace_starting(&root),
            Some((root, MountPhase::Failed(reason))) => {
                self.host.mark_workspace_failed(&root, reason)
            }
            Some((root, MountPhase::Mounted | MountPhase::Stopped)) => {
                self.host.clear_workspace_lifecycle(&root)
            }
            None => {}
        }
    }

    fn remove_finished_tombstone(&self, prefix: &str) {
        let mut workspaces = self.workspaces.lock().unwrap_or_else(|e| e.into_inner());
        if workspaces
            .get(prefix)
            .is_some_and(|record| record.desired == DesiredMount::Forgotten)
        {
            workspaces.remove(prefix);
        }
    }

    async fn cancel_mount_attempt(&self, attempt: &MountAttempt) {
        let _ = self.host.close_workspace(&attempt.prefix, true).await;
        self.restore_current_host_lifecycle(&attempt.prefix);
        self.startup.settle(&attempt.key());
    }

    /// Set whether the registered workspace at `prefix` is mounted, returning
    /// the updated row (`None` ⇒ no workspace registered there ⇒ the handler
    /// answers 404). `on:false` unmounts (releasing the per-workspace flock)
    /// but keeps the registration with an empty token; `on:true` remounts at
    /// the SAME prefix with a freshly-minted token. Idempotent in both
    /// directions. Distinct from Forget, which drops the registration.
    async fn set_workspace_on(
        &self,
        prefix: &str,
        on: bool,
        force: bool,
    ) -> Result<SetWorkspaceOnResult, Error> {
        let current = {
            let workspaces = self.workspaces.lock().unwrap_or_else(|e| e.into_inner());
            workspaces
                .get(prefix)
                .filter(|record| record.desired != DesiredMount::Forgotten)
                .map(|record| (record.root.clone(), record.phase.clone()))
        };
        let (root, phase) = match current {
            Some(current) => current,
            None => match self.library_root_for_prefix(prefix) {
                Some(root) => (root, MountPhase::Stopped),
                None => return Ok(SetWorkspaceOnResult::Updated(None)),
            },
        };
        if on {
            self.mount_at(&root, prefix).await?;
        } else {
            // A pending attempt must lose to the newer off intent before its
            // completion can publish. A mounted row can first run the existing
            // terminal-refusal guard because no attempt is outstanding.
            if phase == MountPhase::Mounted {
                match self.host.close_workspace(prefix, force).await? {
                    WorkspaceLifecycleOutcome::Completed | WorkspaceLifecycleOutcome::NotFound => {}
                    WorkspaceLifecycleOutcome::Refused { active_terminals } => {
                        return Ok(SetWorkspaceOnResult::Refused { active_terminals });
                    }
                }
            }
            {
                let mut workspaces = self.workspaces.lock().unwrap_or_else(|e| e.into_inner());
                match workspaces.get_mut(prefix) {
                    Some(record) => {
                        record.turn_off();
                    }
                    None => {
                        workspaces.insert(
                            prefix.to_string(),
                            WorkspaceRecord::prepared(root.clone(), prefix.to_string(), false, 1),
                        );
                    }
                }
            }
            if phase != MountPhase::Mounted {
                match self.host.close_workspace(prefix, force).await? {
                    WorkspaceLifecycleOutcome::Completed | WorkspaceLifecycleOutcome::NotFound => {}
                    WorkspaceLifecycleOutcome::Refused { active_terminals } => {
                        return Ok(SetWorkspaceOnResult::Refused { active_terminals });
                    }
                }
            }
            self.host.clear_workspace_lifecycle(&root);
            self.persist_state();
        }
        Ok(SetWorkspaceOnResult::Updated(
            self.entry_for(prefix)
                .or_else(|| self.library_off_entry(prefix)),
        ))
    }

    /// The current [`WorkspaceEntry`] for `prefix`, or `None` when no
    /// workspace is registered there.
    fn entry_for(&self, prefix: &str) -> Option<WorkspaceEntry> {
        let workspaces = self.workspaces.lock().unwrap_or_else(|e| e.into_inner());
        workspaces
            .get(prefix)
            .map(|record| self.entry_from_record(record))
    }

    /// Forget the workspace at `prefix`: unmount it if on, then drop the
    /// registration entirely. Refusal leaves both the live mount and the
    /// registration intact. Distinct from on/off.
    async fn forget_workspace(
        &self,
        prefix: &str,
        force: bool,
    ) -> Result<WorkspaceLifecycleOutcome, Error> {
        // Devserver Forget is destructive: it is `chan workspace rm`,
        // unmount-if-running, then UNREGISTER from the host
        // library (reset Everything + bin the trash). The host library is the
        // single registry, so the workspace then disappears everywhere
        // (library, devserver listing, CLI). `set_workspace_on {on:false}` is
        // the reversible unmount; this is the removal. Resolve the root from the
        // serving record OR, for a library workspace not currently served, the
        // library itself -- every library workspace is forgettable.
        let current = {
            let workspaces = self.workspaces.lock().unwrap_or_else(|e| e.into_inner());
            workspaces
                .get(prefix)
                .map(|record| (record.root.clone(), record.phase.clone()))
        }
        .or_else(|| {
            self.library_root_for_prefix(prefix)
                .map(|root| (root, MountPhase::Stopped))
        });
        let Some((root, phase)) = current else {
            return Ok(WorkspaceLifecycleOutcome::NotFound);
        };
        let pending_original = if phase == MountPhase::Starting {
            let mut workspaces = self.workspaces.lock().unwrap_or_else(|e| e.into_inner());
            workspaces.get_mut(prefix).map(|record| {
                let original = record.clone();
                record.forget();
                original
            })
        } else {
            None
        };
        if pending_original.is_some() {
            // Durable absence and the tombstone win before physical cleanup;
            // no lock is held across the host's potentially blocking teardown.
            self.persist_state();
        }
        match self.host.remove_workspace_for_root(&root, force).await? {
            WorkspaceLifecycleOutcome::Refused { active_terminals } => {
                if let Some(original) = pending_original {
                    self.workspaces
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .insert(prefix.to_string(), original);
                    self.persist_state();
                }
                return Ok(WorkspaceLifecycleOutcome::Refused { active_terminals });
            }
            WorkspaceLifecycleOutcome::Completed | WorkspaceLifecycleOutcome::NotFound => {}
        }
        if phase != MountPhase::Starting {
            let mut workspaces = self.workspaces.lock().unwrap_or_else(|e| e.into_inner());
            if workspaces.get(prefix).is_some() {
                workspaces.remove(prefix);
            }
        } else if pending_original.is_none() {
            // The serving record disappeared between the initial lookup and
            // intent update; physical removal above is still authoritative.
            let mut workspaces = self.workspaces.lock().unwrap_or_else(|e| e.into_inner());
            if workspaces
                .get(prefix)
                .is_some_and(|record| record.desired != DesiredMount::Forgotten)
            {
                workspaces.remove(prefix);
            }
        }
        self.persist_state();
        Ok(WorkspaceLifecycleOutcome::Completed)
    }

    /// Persist devserver state across two stores: workspace on/off into the
    /// library-owned [`WorkspaceOverlay`], and the bearer token + library id into
    /// the devserver config. So a restart comes back serving exactly what was on
    /// and remembering what was off.
    fn persist_state(&self) {
        let _persist = self
            .persist_serial
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.persist_state_locked();
    }

    fn persist_state_locked(&self) {
        self.persist_state_with_mounted_snapshot_locked(|| {
            self.host
                .mounted_prefixes()
                .unwrap_or_default()
                .into_iter()
                .collect()
        });
    }

    #[cfg(test)]
    fn persist_state_with_mounted_snapshot(
        &self,
        mounted_snapshot: impl FnOnce() -> HashSet<String>,
    ) {
        let _persist = self
            .persist_serial
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.persist_state_with_mounted_snapshot_locked(mounted_snapshot);
    }

    fn persist_state_with_mounted_snapshot_locked(
        &self,
        mounted_snapshot: impl FnOnce() -> HashSet<String>,
    ) {
        // Durable desired intent → the library-owned overlay store. Starting
        // and failed rows stay desired-on even though no host prefix is live.
        if let Some(overlay) = self.host.workspace_overlay() {
            let durable: HashMap<PathBuf, PersistedWorkspace> = overlay
                .entries()
                .into_iter()
                .map(|row| (canonical_root(Path::new(&row.path)), row))
                .collect();
            let registered: std::collections::HashSet<PathBuf> = self
                .host
                .library()
                .list_workspaces()
                .into_iter()
                .map(|w| canonical_root(&w.root_path))
                .collect();
            let rows: Vec<PersistedWorkspace> = {
                let mut map = self.workspaces.lock().unwrap_or_else(|e| e.into_inner());
                // Keep the serving record and host mount snapshot in one lock
                // window. Otherwise a mount may publish between the two reads
                // and be mistaken for an out-of-band close.
                let mounted = mounted_snapshot();
                // Preserve the prior out-of-band control-socket semantics:
                // remove means absence; close advances a settled mounted row
                // to a newer desired-off intent. A Starting row is deliberately
                // not mistaken for an out-of-band close.
                map.retain(|_, record| {
                    registered.contains(&canonical_root(&record.root))
                        || record.phase == MountPhase::Starting
                        || record.desired == DesiredMount::Forgotten
                });
                for record in map.values_mut() {
                    if let Some(row) = durable.get(&canonical_root(&record.root)) {
                        record.reconcile_persisted(row, mounted.contains(&record.prefix));
                    }
                    if record.phase == MountPhase::Mounted && !mounted.contains(&record.prefix) {
                        record.turn_off();
                    }
                }
                map.values()
                    .filter(|record| registered.contains(&canonical_root(&record.root)))
                    .filter_map(WorkspaceRecord::persisted)
                    .collect()
            };
            overlay.replace(rows);
        }
        // Bearer token + library identity → the devserver config.
        let cfg = PersistedConfig {
            devserver_token: self.token.read().unwrap_or_else(|e| e.into_inner()).clone(),
            token_minted_at: self.token_minted_at.load(Ordering::Relaxed),
            library_id: self.library_id.clone(),
            port: self.bound_port.load(Ordering::Relaxed),
        };
        if let Err(e) = self.store.save(&cfg) {
            tracing::warn!("persisting devserver config: {e}");
        }
    }

    /// Re-mint the bearer token: swap the value in the shared cell (the
    /// management gate and the launcher bundle's gates all read it), stamp
    /// the mint time, and persist through the 0600 store. The old bearer
    /// stops authorizing on the next request.
    fn rotate_token(&self) -> String {
        self.rotate_token_with_pre_mint_hook(random_token(), unix_now_secs(), || {})
    }

    fn rotate_token_with_pre_mint_hook(
        &self,
        token: String,
        minted_at: u64,
        pre_mint: impl FnOnce(),
    ) -> String {
        let _persist = self
            .persist_serial
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        *self.token.write().unwrap_or_else(|e| e.into_inner()) = token.clone();
        pre_mint();
        self.token_minted_at.store(minted_at, Ordering::Relaxed);
        self.persist_state_locked();
        token
    }

    /// The box's workspace list for `GET /api/devserver/workspaces`: ONE row
    /// per HOST-LIBRARY workspace (the set `chan workspace ls` shows, read live
    /// from the registry), with `on`/`prefix`/`token` from the devserver's
    /// serving state. The host library, not the devserver's own config, is
    /// the source of truth: a freshly-started devserver therefore lists
    /// exactly what `chan list` shows instead of coming up empty. A library
    /// workspace the devserver is not serving is `on:false` at its stable
    /// derived prefix with no token; toggling it on mounts it (see
    /// [`set_workspace_on`](Self::set_workspace_on)). Sorted by prefix.
    fn workspace_entries(&self) -> Vec<WorkspaceEntry> {
        let by_root: HashMap<PathBuf, WorkspaceEntry> = {
            let workspaces = self.workspaces.lock().unwrap_or_else(|e| e.into_inner());
            workspaces
                .values()
                .filter(|record| record.desired != DesiredMount::Forgotten)
                .map(|record| (record.root.clone(), self.entry_from_record(record)))
                .collect()
        };
        let mut entries: Vec<WorkspaceEntry> = Vec::new();
        let mut seen: HashSet<PathBuf> = HashSet::new();
        for ws in self.host.library().list_workspaces() {
            seen.insert(ws.root_path.clone());
            if let Some(entry) = by_root.get(&ws.root_path) {
                entries.push(entry.clone());
            } else if let Ok(prefix) = allocate_workspace_prefix(&ws.root_path) {
                let (status, error) = self.host.workspace_status(&ws.root_path);
                entries.push(WorkspaceEntry {
                    prefix,
                    path: ws.root_path.to_string_lossy().into_owned(),
                    label: workspace_label(&ws.root_path),
                    on: false,
                    status,
                    error,
                    token: String::new(),
                });
            }
        }
        // Defensive: a served workspace whose root left the library (forgotten
        // while still mounted) must still surface so a live mount never
        // silently vanishes from the list. Once the host has also unmounted it,
        // the stale devserver map row is not a real workspace anymore; this is
        // the control-socket `chan close --remove` path.
        for (root, entry) in &by_root {
            if !seen.contains(root) && entry.on {
                entries.push(entry.clone());
            }
        }
        entries.sort_by(|a, b| a.prefix.cmp(&b.prefix));
        entries
    }

    /// Resolve a route prefix back to a host-library workspace root for a
    /// prefix that names a library workspace the devserver is NOT serving (so
    /// it is absent from `self.workspaces`). Matches on the stable
    /// [`allocate_workspace_prefix`] mapping.
    fn library_root_for_prefix(&self, prefix: &str) -> Option<PathBuf> {
        self.host
            .library()
            .list_workspaces()
            .into_iter()
            .map(|ws| ws.root_path)
            .find(|root| allocate_workspace_prefix(root).ok().as_deref() == Some(prefix))
    }

    /// The off-state row for a library workspace the devserver is not serving
    /// (stable prefix, no token), for idempotent off-toggles and reporting.
    fn library_off_entry(&self, prefix: &str) -> Option<WorkspaceEntry> {
        let root = self.library_root_for_prefix(prefix)?;
        let (status, error) = self.host.workspace_status(&root);
        Some(WorkspaceEntry {
            prefix: prefix.to_string(),
            path: root.to_string_lossy().into_owned(),
            label: workspace_label(&root),
            on: false,
            status,
            error,
            token: String::new(),
        })
    }

    /// Build the wire [`WorkspaceEntry`] for a registered workspace record: an
    /// off row reports `on:false` with an empty token; an on row its live token.
    fn entry_from_record(&self, record: &WorkspaceRecord) -> WorkspaceEntry {
        let mounted = self.host.is_root_mounted(&record.root);
        let (status, error) = match &record.phase {
            MountPhase::Starting => (WorkspaceStatus::Starting, None),
            MountPhase::Failed(reason) => (WorkspaceStatus::Error, Some(reason.clone())),
            MountPhase::Mounted if mounted => (WorkspaceStatus::Running, None),
            MountPhase::Mounted | MountPhase::Stopped => self.host.workspace_status(&record.root),
        };
        let on =
            record.desired == DesiredMount::On && record.phase == MountPhase::Mounted && mounted;
        let token = if on {
            record.token.clone()
        } else {
            String::new()
        };
        WorkspaceEntry {
            prefix: record.prefix.clone(),
            path: record.root.to_string_lossy().into_owned(),
            label: record.label.clone(),
            on,
            status,
            error,
            token,
        }
    }

    /// Insert every durable row before any desired-on restore future spawns.
    fn prepare_restore_rows(&self, rows: Vec<PersistedWorkspace>) -> Vec<MountAttempt> {
        let mut attempts = Vec::new();
        for row in rows {
            let root = PathBuf::from(&row.path);
            let prefix = match allocate_workspace_prefix(&root) {
                Ok(prefix) => prefix,
                Err(error) => {
                    eprintln!(
                        "chan devserver: NOTE: skipping persisted workspace {} ({error})",
                        row.path
                    );
                    continue;
                }
            };
            if let Err(error) = self.host.library().register_workspace(&root) {
                eprintln!(
                    "chan devserver: NOTE: could not register persisted workspace {}: {error}",
                    row.path
                );
                continue;
            }
            let root = canonical_root(&root);
            let record = WorkspaceRecord::prepared(
                root.clone(),
                prefix.clone(),
                row.desired_on,
                row.generation,
            );
            let attempt = row.desired_on.then(|| MountAttempt {
                root: root.clone(),
                prefix: prefix.clone(),
                generation: row.generation,
            });
            {
                let mut workspaces = self.workspaces.lock().unwrap_or_else(|e| e.into_inner());
                workspaces.insert(prefix, record);
            }
            if let Some(attempt) = attempt {
                if let Err(reason) = self.startup.track(attempt.key()) {
                    self.finish_failed_attempt(&attempt, reason);
                    continue;
                }
                self.host.mark_workspace_starting(&root);
                attempts.push(attempt);
            }
        }
        attempts
    }

    /// Mount the per-library SHARED terminal tenant. `open_terminal_session`
    /// records its prefix in the host's `terminal_tenant_prefix`, which the window
    /// feed's `terminal_window_live` resolves a Terminal record's prefix+token
    /// against. The desktop does this via `embedded.rs`; the devserver never did
    /// (it only ever mounted per-LABEL terminals via the lower-level
    /// `open_terminal_session_with_command`, which does NOT set the OnceLock), so
    /// every devserver Terminal window carried an empty token and the desktop
    /// watcher's `should_show` (which requires a non-empty token) hid it --
    /// vanishing on every reconnect. `Some(dir)` persists each window's pane
    /// layout. One shared tenant per library, so this is called once at startup.
    async fn mount_shared_terminal_tenant(&self) -> Result<(), Error> {
        self.host
            .open_terminal_session(
                tenant_config(self.addr, DEVSERVER_SHARED_TERMINAL_PREFIX),
                devserver_terminals_dir(),
            )
            .await?;
        Ok(())
    }
}

#[must_use = "the startup restore task must be joined before shutdown completes"]
struct WorkspaceRestore {
    task: Option<tokio::task::JoinHandle<()>>,
}

impl WorkspaceRestore {
    fn spawn(
        state: Arc<DevserverState>,
        attempts: Vec<MountAttempt>,
        shutdown_rx: tokio::sync::watch::Receiver<bool>,
    ) -> Self {
        Self {
            task: Some(tokio::spawn(restore_prepared_workspaces(
                state,
                attempts,
                shutdown_rx,
            ))),
        }
    }

    async fn join(mut self) -> Result<(), tokio::task::JoinError> {
        self.task
            .take()
            .expect("restore owner always contains its task")
            .await
    }

    #[cfg(test)]
    fn from_task(task: tokio::task::JoinHandle<()>) -> Self {
        Self { task: Some(task) }
    }
}

async fn restore_prepared_workspaces(
    state: Arc<DevserverState>,
    attempts: Vec<MountAttempt>,
    mut shutdown_rx: tokio::sync::watch::Receiver<bool>,
) {
    let deadline = tokio::time::Instant::now() + STARTUP_RESTORE_TIMEOUT;
    let mut attempts = attempts.into_iter();
    while let Some(attempt) = attempts.next() {
        if *shutdown_rx.borrow() {
            state.cancel_mount_attempt(&attempt).await;
            for pending in attempts {
                state.cancel_mount_attempt(&pending).await;
            }
            return;
        }
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            let reason = format!(
                "startup restore exceeded {} seconds",
                STARTUP_RESTORE_TIMEOUT.as_secs()
            );
            state.finish_failed_attempt(&attempt, reason.clone());
            for pending in attempts {
                state.finish_failed_attempt(&pending, reason.clone());
            }
            return;
        }
        let mut restore = Box::pin(state.execute_mount_attempt(
            attempt.clone(),
            std::cmp::min(WORKSPACE_MOUNT_TIMEOUT, remaining),
        ));
        tokio::select! {
            result = &mut restore => {
                if let Err(error) = result {
                    eprintln!(
                        "chan devserver: NOTE: could not re-mount {}: {error}",
                        attempt.root.display()
                    );
                }
            }
            _ = shutdown_rx.changed() => {
                drop(restore);
                state.cancel_mount_attempt(&attempt).await;
                for pending in attempts {
                    state.cancel_mount_attempt(&pending).await;
                }
                return;
            }
        }
    }
}

/// What the cold-start token resolution decided, so the boot path can
/// explain a rotation to the operator.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BootToken {
    /// A persisted token within its age window: reused as-is.
    Kept,
    /// No token on disk (first boot): minted fresh.
    Minted,
    /// The persisted token outlived [`DEVSERVER_TOKEN_MAX_AGE_SECS`] (or
    /// its mint time was unrecorded): re-minted, old bearer retired.
    RotatedByAge,
}

/// Owns either `run_devserver` serving path through its shutdown boundary.
///
/// Both variants consume the watchdog owner and wait for its task to terminate
/// before the arm returns, so listener and tunnel-only shutdown cannot detach a
/// final notification.
enum DevserverServeArm {
    Listener(tokio::task::JoinHandle<std::io::Result<()>>),
    Wait(tokio::task::JoinHandle<()>),
}

impl DevserverServeArm {
    async fn join(self, watchdog: Option<fdstore::WatchdogPings>) -> anyhow::Result<()> {
        let serve_result = match self {
            Self::Listener(task) => task
                .await
                .context("joining devserver serve task")
                .and_then(|result| result.context("running devserver")),
            Self::Wait(task) => task.await.context("joining devserver wait task"),
        };
        if let Some(watchdog) = watchdog {
            watchdog.stop().await;
        }
        serve_result
    }
}

/// Resolve the boot token in `persisted`, minting or rotating in place.
/// Pure over (`persisted`, `now`) so the age rule is testable without a
/// boot: empty mints, an unknown or over-age mint time rotates, and a
/// future mint time (clock stepped back) is re-stamped to `now` without
/// rotating so the age check stays meaningful.
fn resolve_boot_token(persisted: &mut PersistedConfig, now: u64) -> BootToken {
    if persisted.devserver_token.is_empty() {
        persisted.devserver_token = random_token();
        persisted.token_minted_at = now;
        return BootToken::Minted;
    }
    if persisted.token_minted_at > now {
        persisted.token_minted_at = now;
        return BootToken::Kept;
    }
    if persisted.token_minted_at == 0
        || now - persisted.token_minted_at > DEVSERVER_TOKEN_MAX_AGE_SECS
    {
        persisted.devserver_token = random_token();
        persisted.token_minted_at = now;
        return BootToken::RotatedByAge;
    }
    BootToken::Kept
}

/// Run the devserver in the foreground until the process is interrupted.
/// Loads (or mints) the persisted token, re-mounts the enabled workspaces,
/// echoes the bind+token line, binds the management + discovery surfaces,
/// and serves.
pub async fn run_devserver(library: Library, config: DevserverConfig) -> anyhow::Result<()> {
    let fdstore_restore = fdstore::StartupRestore::take();

    let store =
        DevserverStore::at(devserver_config_path().context("resolving devserver config path")?);
    let mut persisted = store.load();
    if resolve_boot_token(&mut persisted, unix_now_secs()) == BootToken::RotatedByAge {
        eprintln!(
            "chan devserver: NOTE: bearer token was older than {} days; rotated -- \
             reopen any browser tab that used the old ?t= URL",
            DEVSERVER_TOKEN_MAX_AGE_SECS / 86_400
        );
    }
    let token = persisted.devserver_token.clone();
    // Mint a stable per-library id once (`lib-<16hex>`), persisted alongside the
    // token, so it survives restart and stamps every window record.
    if persisted.library_id.is_empty() {
        persisted.library_id = format!("lib-{:016x}", rand::random::<u64>());
    }
    let library_id = persisted.library_id.clone();

    let host = Arc::new(WorkspaceHost::new(library, crate::route_builder()));
    // Opt in to control-socket `chan close`: a hosted workspace's tenant can
    // then be unmounted by path (it does not kill the multi-tenant process).
    host.install_self();
    // Install the persisted window registry beside the devserver config, so the
    // window feed has data. The window-record
    // assembly reads it; `library_id` stamps each row.
    let windows_store = devserver_config_path()
        .context("resolving devserver windows store path")?
        .with_file_name("windows.json");
    host.install_window_registry(
        Arc::new(WindowRegistry::open(windows_store)),
        library_id.clone(),
    );
    // Every tenant this devserver mounts binds its control socket at a path
    // derived from the persisted library id, stable across restarts, so
    // `$CHAN_CONTROL_SOCKET` in shells that predate a restart still reaches
    // the new instance (`cs` keeps working across `--service=chan` daemon
    // restarts and systemd unit restarts alike). Installed before the first
    // mount so the shared terminal tenant gets it too.
    host.install_control_identity(library_id.clone());
    // Continuous fd parking, only under systemd notify: every windowed PTY
    // parks at spawn so ANY unit restart preserves it. Installed before the
    // first mount (the hook reaches registries at mount wiring); it starts
    // Disabled and activates after the inherited-fd restore applies, so no
    // early spawn or manifest write can race the taken restore state.
    let fd_parker = std::env::var_os("NOTIFY_SOCKET")
        .is_some_and(|value| !value.is_empty())
        .then(|| fdstore::DevserverParker::install(&host, library_id.clone()));
    // Install the library-owned workspace on/off overlay beside the window
    // registry, so the restore below re-mounts what was on. Same shape + store
    // the desktop-local library uses (`~/.chan/workspaces.json`).
    let overlay_store = devserver_config_path()
        .context("resolving devserver workspace overlay path")?
        .with_file_name("workspaces.json");
    host.install_workspace_overlay(Arc::new(WorkspaceOverlay::open(overlay_store)));
    // The devserver's own pane-highlight colour, persisted beside the registry +
    // overlay: each devserver "sticks" to its colour, the launcher's local-color
    // route serves it, and the desktop caches it for the pane-highlight inject.
    let color_store = devserver_config_path()
        .context("resolving devserver local-color path")?
        .with_file_name("color.json");
    host.install_local_color_store(Arc::new(FileLocalColor::open(color_store)));
    match start_registry_reload_watcher(host.clone(), host.library().config_path()) {
        Ok(watcher) => {
            // Process-lifetime watcher. Keeping it out of the async frame avoids
            // imposing its Send/Sync shape on the devserver future.
            Box::leak(Box::new(watcher));
        }
        Err(e) => {
            tracing::warn!(error = %e, "devserver registry reload watcher disabled");
        }
    }
    let state = Arc::new(DevserverState {
        host: host.clone(),
        addr: config.addr,
        token: Arc::new(std::sync::RwLock::new(token.clone())),
        token_minted_at: AtomicU64::new(persisted.token_minted_at),
        library_id,
        host_label: config.host_label,
        workspaces: Mutex::new(HashMap::new()),
        mount_attempt_lock: tokio::sync::Mutex::new(()),
        startup: Arc::new(StartupCoordinator::new()),
        store,
        persist_serial: Mutex::new(()),
        bound_port: AtomicU16::new(0),
    });

    // Mount the per-library SHARED terminal tenant before serving, so
    // devserver Terminal windows resolve to a real prefix+token.
    state
        .mount_shared_terminal_tenant()
        .await
        .context("mounting the devserver shared terminal tenant")?;

    // The library open path: a fresh devserver (empty registry, marker unset)
    // mints exactly one terminal so a plain browser pointed at it sees a window;
    // a devserver whose terminal was closed (marker set) does NOT re-mint on
    // restart. The rule lives in the library, identical to the desktop local
    // boot. Run after mounting the shared terminal tenant so the minted window
    // resolves to a real prefix+token. Persisted-workspace restore follows, so a
    // first boot whose persisted set turns a workspace ON still mints the
    // terminal (the registry was empty at this point) -- matching "open spawns one
    // terminal".
    state
        .host
        .ensure_first_open_terminal()
        .context("provisioning the devserver first-open terminal")?;

    // Prepare every durable row before spawning restore work. Desired-on rows
    // are already visible as Starting and persist as on throughout the window.
    let restore_rows = state
        .host
        .workspace_overlay()
        .map(|overlay| overlay.entries())
        .unwrap_or_default();
    let restore_attempts = state.prepare_restore_rows(restore_rows);
    state.persist_state();

    let (app, serve_addr_cell) = build_devserver_app(state.clone(), host.clone());

    // Bind the local TCP listener up front (so a bind failure errors before we
    // dial the tunnel), unless the resolved config is tunnel-only. `addr` is
    // still meaningful when unbound -- the discovery socket and the per-tenant
    // window records use it; only the loopback TCP bind is skipped.
    state
        .startup
        .advance(StartupPhase::Binding)
        .map_err(anyhow::Error::msg)?;
    let listener = if config.listen {
        // Bind intent, printed BEFORE the bind: on failure the journal names
        // the attempted address (port 0 = the OS assigns a free port).
        println!("chan devserver: binding {}", config.addr);
        Some(
            tokio::net::TcpListener::bind(config.addr)
                .await
                .with_context(|| format!("binding devserver on {}", config.addr))?,
        )
    } else {
        None
    };

    // Discovery names include the actual bound port. Resolve `local_addr`
    // before publishing the endpoint so `--port 0` is selectable by the port
    // the OS assigned rather than by the requested zero.
    let local_addr = listener
        .as_ref()
        .map(|listener| listener.local_addr().unwrap_or(config.addr));
    if let Some(local_addr) = local_addr {
        let _ = serve_addr_cell.set(local_addr);
        state.bound_port.store(local_addr.port(), Ordering::Relaxed);
        state.persist_state();
    }
    // Inherited terminals are adopted exactly once before any local, discovery,
    // or tunnel route can reconnect to them.
    fdstore_restore.apply(&state);
    // Adopted sessions and any boot-time spawn become parked + manifested
    // before routes expose: nothing can observe a session whose fd name is
    // not yet durable.
    if let Some(parker) = &fd_parker {
        parker.activate();
    }
    state
        .startup
        .advance(StartupPhase::FdstoreApplied)
        .map_err(anyhow::Error::msg)?;

    // Shutdown wiring is installed before route exposure. The observer moves
    // startup to Stopping and cancels reindex work; the owned restore task uses
    // another receiver and joins before this function returns.
    let signal_tx = Arc::new(tokio::sync::watch::channel(false).0);
    let cancel_host = host.clone();
    let cancel_startup = state.startup.clone();
    let mut cancel_rx = signal_tx.subscribe();
    let cancel_task = tokio::spawn(async move {
        let _ = cancel_rx.changed().await;
        cancel_startup.stop();
        cancel_host.cancel_all_reindex();
    });

    state
        .startup
        .advance(StartupPhase::ServingAndRestoring)
        .map_err(anyhow::Error::msg)?;

    // A discovery bind failure is non-fatal: the management API still works,
    // only `chan open` registration is disabled. Tunnel-only instances have no
    // bound TCP address, so their configured port (possibly zero) is their
    // local selector identity.
    let discovery_port = local_addr.unwrap_or(config.addr).port();
    let _discovery = start_discovery_listener(state.clone(), discovery_port);

    // Tunnel mode: also hand the SAME app to chan-tunnel-client, which registers
    // ONE devserver and forwards inbound substreams into it, publishing every
    // mounted tenant behind one gateway registration. The management API rides
    // the same router, but the proxy 404s `/api/devserver/*` on the public
    // wildcard, so only tenant content is reachable through the gateway. The
    // run loop reconnects with backoff and is cancelled by the shutdown signal.
    let tunnel_url = config.tunnel.as_ref().map(|t| t.tunnel_url.clone());
    let tunnel_task = config.tunnel.map(|tunnel| {
        let assertion = TunnelAssertion {
            key: chan_tunnel_proto::gateway_assertion::derive_assertion_key(&tunnel.token),
            devserver_id: chan_tunnel_proto::gateway_assertion::devserver_id_from_token(
                &tunnel.token,
            ),
        };
        // Mark every tunnel request as tunnel-origin. A verified owner assertion
        // unlocks the full launcher; missing or non-owner assertions stay
        // read-only.
        let tunnel_app = app.clone().layer(middleware::from_fn_with_state(
            assertion,
            mark_tunnel_origin,
        ));
        spawn_devserver_tunnel(tunnel, tunnel_app, &signal_tx)
    });

    match listener {
        Some(listener) => {
            let local_addr = local_addr.expect("listening devserver has a bound address");
            let serve_signal = signal_tx.clone();
            let serve_startup = state.startup.clone();
            let serve_arm = DevserverServeArm::Listener(tokio::spawn(async move {
                let result =
                    crate::signal::graceful_serve(listener, app, serve_signal.clone()).await;
                serve_startup.stop();
                let _ = serve_signal.send(true);
                result
            }));
            let restore =
                WorkspaceRestore::spawn(state.clone(), restore_attempts, signal_tx.subscribe());
            let restore_join = restore.join().await;
            if restore_join.is_err() {
                state.startup.stop();
                let _ = signal_tx.send(true);
            }
            let ready = restore_join.is_ok() && state.startup.ready_after_restore().await;
            let notify_result = if ready {
                println!("chan devserver: listening on http://{local_addr}/?t={token}");
                println!("{DEVSERVER_TOKEN_MARKER}{token}");
                fdstore::notify_ready()
            } else {
                Ok(())
            };
            if notify_result.is_err() {
                state.startup.stop();
                let _ = signal_tx.send(true);
            }
            let watchdog_pings = (ready && notify_result.is_ok())
                .then(|| fdstore::spawn_watchdog_pings(signal_tx.subscribe()));
            let serve_join = serve_arm.join(watchdog_pings).await;
            let cancel_join = cancel_task.await;
            let tunnel_join = match tunnel_task {
                Some(task) => Some(task.await),
                None => None,
            };
            // Graceful shutdown: seal parking (no further parks, one final
            // manifest write), then detach the parked sessions so tenant
            // teardown kills only the rest. Systemd decides what the store does
            // next: restart re-feeds the fds, stop releases them.
            if let Some(parker) = fd_parker {
                let detached = parker.seal_flush_detach();
                if detached > 0 {
                    eprintln!(
                    "chan devserver: systemd fdstore: detached {detached} parked terminal(s) for handover"
                );
                }
                parker.stop().await;
            }
            let hosted_shutdown = host.shutdown_all().await;
            state.startup.stop();
            state.startup.stopped();
            restore_join.context("joining workspace startup restore")?;
            notify_result?;
            cancel_join.context("joining devserver shutdown observer")?;
            if let Some(tunnel_join) = tunnel_join {
                tunnel_join.context("joining devserver tunnel task")?;
            }
            hosted_shutdown.context("shutting down hosted tenants")?;
            serve_join?;
        }
        None => {
            let serve_signal = signal_tx.clone();
            let serve_startup = state.startup.clone();
            let serve_arm = DevserverServeArm::Wait(tokio::spawn(async move {
                crate::signal::graceful_wait(serve_signal.clone()).await;
                serve_startup.stop();
                let _ = serve_signal.send(true);
            }));
            let restore =
                WorkspaceRestore::spawn(state.clone(), restore_attempts, signal_tx.subscribe());
            let restore_join = restore.join().await;
            if restore_join.is_err() {
                state.startup.stop();
                let _ = signal_tx.send(true);
            }
            let ready = restore_join.is_ok() && state.startup.ready_after_restore().await;
            let notify_result = if ready {
                match &tunnel_url {
                    Some(url) => println!(
                        "chan devserver: tunnel-only (no local listener); publishing via {url}"
                    ),
                    None => println!(
                        "chan devserver: no local listener and no tunnel; only the chan-open \
                         discovery socket is reachable"
                    ),
                }
                fdstore::notify_ready()
            } else {
                Ok(())
            };
            if notify_result.is_err() {
                state.startup.stop();
                let _ = signal_tx.send(true);
            }
            let watchdog_pings = (ready && notify_result.is_ok())
                .then(|| fdstore::spawn_watchdog_pings(signal_tx.subscribe()));
            let serve_join = serve_arm.join(watchdog_pings).await;
            let cancel_join = cancel_task.await;
            let tunnel_join = match tunnel_task {
                Some(task) => Some(task.await),
                None => None,
            };
            // Graceful shutdown: seal parking (no further parks, one final
            // manifest write), then detach the parked sessions so tenant
            // teardown kills only the rest. Systemd decides what the store does
            // next: restart re-feeds the fds, stop releases them.
            if let Some(parker) = fd_parker {
                let detached = parker.seal_flush_detach();
                if detached > 0 {
                    eprintln!(
                    "chan devserver: systemd fdstore: detached {detached} parked terminal(s) for handover"
                );
                }
                parker.stop().await;
            }
            let hosted_shutdown = host.shutdown_all().await;
            state.startup.stop();
            state.startup.stopped();
            restore_join.context("joining workspace startup restore")?;
            notify_result?;
            cancel_join.context("joining devserver shutdown observer")?;
            if let Some(tunnel_join) = tunnel_join {
                tunnel_join.context("joining devserver tunnel task")?;
            }
            hosted_shutdown.context("shutting down hosted tenants")?;
            serve_join?;
        }
    }
    Ok(())
}

fn start_registry_reload_watcher(
    host: Arc<WorkspaceHost>,
    registry_path: PathBuf,
) -> notify::Result<notify::RecommendedWatcher> {
    let dir = registry_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| Path::new(".").to_path_buf());
    let registry_name = registry_path
        .file_name()
        .map(OsStr::to_os_string)
        .unwrap_or_else(|| registry_path.as_os_str().to_os_string());
    let _ = std::fs::create_dir_all(&dir);

    let mut watcher =
        notify::recommended_watcher(move |res: notify::Result<notify::Event>| match res {
            Ok(event) => {
                if event
                    .paths
                    .iter()
                    .any(|path| path.file_name() == Some(registry_name.as_os_str()))
                {
                    if let Err(e) = host.library().reload_registry() {
                        tracing::warn!(error = %e, "reloading workspace registry failed");
                        return;
                    }
                    host.signal_library_change();
                }
            }
            Err(e) => tracing::warn!(error = %e, "workspace registry watch error"),
        })?;
    notify::Watcher::watch(&mut watcher, &dir, notify::RecursiveMode::NonRecursive)?;
    Ok(watcher)
}

/// Fixed registration name sent in the tunnel `Hello` frame. The gateway
/// resolves the devserver identity from the token (PAT SHA-256) and ignores
/// this value; it is non-empty only to satisfy the client-side name check
/// (`chan_tunnel_proto::is_valid_workspace_name`). One devserver per user means
/// the registry key `(user, name)` never collides across users.
const DEVSERVER_TUNNEL_NAME: &str = "devserver";

/// True iff the tunnel dial endpoint is the production `devserver.chan.app`
/// terminator. On that path the devserver can name the public host shape
/// (`{user}.devserver.chan.app`); anywhere else (a dev gateway, a staging
/// host) the terminator owns the URL scheme, so the connect log prints
/// identity only.
fn is_production_tunnel_url(tunnel_url: &str) -> bool {
    url::Url::parse(tunnel_url)
        .map(|u| u.scheme() == "https" && u.host_str() == Some("devserver.chan.app"))
        .unwrap_or(false)
}

/// Dial the gateway tunnel on a background task that races the reconnect loop
/// against the shutdown signal. The devserver is headless, so the lifecycle
/// drainer only logs connect / disconnect / dial-failure: no QR, no
/// browser-open, and no SPA prefix swap (each tenant already serves at its own
/// public slug, so the proxy forwards the public path unchanged).
fn spawn_devserver_tunnel(
    tunnel: DevserverTunnel,
    app: Router,
    signal_tx: &Arc<tokio::sync::watch::Sender<bool>>,
) -> tokio::task::JoinHandle<()> {
    let DevserverTunnel {
        tunnel_url,
        token,
        name,
    } = tunnel;
    let mut shutdown_rx = signal_tx.subscribe();
    tokio::spawn(async move {
        let url = match url::Url::parse(&tunnel_url) {
            Ok(url) => url,
            Err(e) => {
                eprintln!("chan devserver: invalid --tunnel-url {tunnel_url:?}: {e}");
                return;
            }
        };
        let production = is_production_tunnel_url(&tunnel_url);
        let (events_tx, mut events_rx) = tokio::sync::mpsc::channel(8);
        let events_task = tokio::spawn(async move {
            while let Some(ev) = events_rx.recv().await {
                match ev {
                    chan_tunnel_client::TunnelEvent::Connected(reg) => {
                        if production {
                            eprintln!(
                                "chan devserver: tunnel connected; workspaces are published at \
                                 https://{user}.devserver.chan.app/<workspace>/",
                                user = reg.user,
                            );
                        } else {
                            eprintln!(
                                "chan devserver: tunnel connected as user {user}",
                                user = reg.user,
                            );
                        }
                    }
                    chan_tunnel_client::TunnelEvent::Disconnected { retry_in } => {
                        eprintln!(
                            "chan devserver: tunnel disconnected; reconnecting in {retry_in:?}"
                        );
                    }
                    chan_tunnel_client::TunnelEvent::DialFailed { error, retry_in } => {
                        eprintln!(
                            "chan devserver: tunnel dial failed: {error} (retry in {retry_in:?})"
                        );
                    }
                }
            }
        });
        let cfg = chan_tunnel_client::ClientConfig {
            tunnel_url: url,
            token,
            workspace: DEVSERVER_TUNNEL_NAME.to_string(),
            name: Some(name),
            client_version: format!("chan/{}", env!("CARGO_PKG_VERSION")),
            initial_backoff: Duration::from_millis(500),
            max_backoff: Duration::from_secs(30),
            dial_timeout: Duration::from_secs(30),
            proxy: None,
            max_concurrent_substreams: chan_tunnel_client::ClientConfig::default()
                .max_concurrent_substreams,
            events: Some(events_tx),
        };
        // Race the run loop against shutdown: dropping the tunnel future closes
        // the yamux session immediately (no axum connection pool to drain).
        tokio::select! {
            res = chan_tunnel_client::run(cfg, app) => {
                if let Err(e) = res {
                    eprintln!("chan devserver: tunnel client exited: {e}");
                }
            }
            _ = shutdown_rx.changed() => {}
        }
        events_task.abort();
        let _ = events_task.await;
    })
}

/// Build the merged router: the unauthenticated info probe, the
/// bearer-gated management routes, and the per-tenant fallback. Explicit
/// `/api/devserver/*` routes match before the host's fallback, so the
/// reserved namespace is never shadowed by a workspace prefix.
fn build_devserver_app(
    state: Arc<DevserverState>,
    host: Arc<WorkspaceHost>,
) -> (Router, Arc<OnceLock<SocketAddr>>) {
    let public = Router::new()
        .route("/api/devserver/info", get(handle_info))
        // The launcher root the devserver serves has no `/api/health` of its own
        // (only the per-tenant routers under each workspace prefix do), so the
        // `--service` supervisor's watchdog probes `http://<addr>/api/health` and
        // must reach a live route here, not the root fallback's 404.
        .route("/api/health", get(handle_health))
        .with_state(state.clone());
    let authed = Router::new()
        .route(
            "/api/devserver/workspaces",
            get(handle_list).post(handle_open),
        )
        .route(
            "/api/devserver/workspaces/{*prefix}",
            delete(handle_forget).post(handle_set_workspace_on),
        )
        .route("/api/devserver/windows", get(handle_list_windows))
        .route("/api/devserver/rotate-token", post(handle_rotate_token))
        .route(
            "/api/devserver/terminal-sessions/drain",
            post(handle_terminal_sessions_drain),
        )
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_bearer,
        ))
        .with_state(state.clone());
    // Serve the web-launcher SPA at the library root `/` plus the `/api/library/*`
    // data surface (windows; workspaces next) as the host's root fallback --
    // without it the root 404s, since `host_dispatch` only matches
    // workspace-tenant prefixes. The `/api/library/windows*` routes used to live
    // in `authed` above; they now live in the shared launcher bundle so the
    // desktop loopback gets them too (the loopback never built this router).
    //
    // Gate the loopback launcher API with the same persisted devserver bearer as
    // `/api/devserver/*`. The static SPA shell remains public so it can load
    // first, then the printed `/?t=<token>` URL lets it present the bearer on
    // `/api/library/*`.
    //
    // `serve_addr = Some(cell)` emits the MUTABLE `devserver` surface (the local
    // web launcher gets the real Power toggle + self-managed windows) and lets
    // the workspace-mount path read the bound address. The tunnel MUST stay
    // read-only: the devserver's tunnel layer marks every tunnel request with
    // `TunnelOrigin`, which `require_local_mutation` 403s and the launcher-meta
    // fallback downgrades to `readonly`, so a credential-stripped tunnel request
    // can never flip the owner's workspaces. The cell is filled with the bound
    // address after the listener binds (unfilled on a tunnel-only devserver,
    // where there is no local bind to mutate from anyway).
    let serve_addr: Arc<OnceLock<SocketAddr>> = Arc::new(OnceLock::new());
    crate::install_launcher_root_fallback(
        &host,
        Some(state.token.clone()),
        Some(serve_addr.clone()),
    );
    let app = public.merge(authed).merge(host.router());
    (app, serve_addr)
}

/// Middleware that stamps every request entering the tunnel-only app clone with
/// [`crate::TunnelOrigin`]. A verified owner assertion lets the public gateway
/// use the same launcher surface as loopback; missing or non-owner assertions
/// stay read-only. A local loopback request never passes through this layer, so
/// it never carries the marker.
#[derive(Clone)]
struct TunnelAssertion {
    key: chan_tunnel_proto::gateway_assertion::AssertionKey,
    devserver_id: String,
}

async fn mark_tunnel_origin(
    State(assertion): State<TunnelAssertion>,
    mut req: HttpRequest<Body>,
    next: Next,
) -> Response {
    let Some(token) = req
        .headers()
        .get(chan_tunnel_proto::gateway_assertion::HEADER_NAME)
        .and_then(|v| v.to_str().ok())
    else {
        tracing::warn!(
            devserver_id = %assertion.devserver_id,
            "gateway assertion missing",
        );
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    };
    let Some(registration) = req.extensions().get::<chan_tunnel_client::Registration>() else {
        tracing::warn!(
            devserver_id = %assertion.devserver_id,
            "authoritative tunnel registration context missing",
        );
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    };
    if registration.workspace != assertion.devserver_id {
        tracing::warn!(
            expected_devserver_id = %assertion.devserver_id,
            registration_devserver_id = %registration.workspace,
            "tunnel registration context mismatch",
        );
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let aud = req
        .headers()
        .get("x-forwarded-host")
        .or_else(|| req.headers().get(header::HOST))
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let scheme = req
        .headers()
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let aud = chan_tunnel_proto::gateway_assertion::canonical_audience(scheme, &aud);
    let caller = match chan_tunnel_proto::gateway_assertion::verify(
        &assertion.key,
        token,
        &aud,
        &assertion.devserver_id,
        &registration.owner_user_id,
    ) {
        Ok(claims) => claims,
        Err(e) => {
            tracing::warn!(
                error = ?e,
                aud = %aud,
                devserver_id = %assertion.devserver_id,
                "gateway assertion verification failed",
            );
            return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
        }
    };
    tracing::debug!(
        owner = caller.is_owner(),
        aud = %caller.aud,
        "gateway assertion accepted",
    );
    req.extensions_mut().insert(crate::TunnelOrigin {
        caller: Some(caller),
    });
    next.run(req).await
}

/// Bind this instance's discovery endpoint. Its registration handler mounts
/// the requested workspace. Returns `None` (and prints a note) when the
/// endpoint cannot bind, so the management API still serves.
fn start_discovery_listener(
    state: Arc<DevserverState>,
    port: u16,
) -> Option<crate::devserver_handoff::ListenerHandle> {
    let Some(socket_path) =
        crate::devserver_handoff::devserver_socket_path(&state.library_id, port)
    else {
        eprintln!(
            "chan devserver: NOTE: discovery endpoint path unavailable; \
             serve-handoff registration is disabled"
        );
        return None;
    };
    let result = crate::devserver_handoff::start_listener(socket_path, move |req| {
        let state = state.clone();
        async move {
            match req {
                crate::devserver_handoff::Request::Identify { .. } => {
                    let library_root = state
                        .host
                        .library()
                        .config_path()
                        .parent()
                        .map(Path::to_path_buf)
                        .unwrap_or_default();
                    crate::devserver_handoff::Response::Identified {
                        pid: std::process::id(),
                        library_root,
                        port,
                        version: crate::devserver_handoff::CHAN_VERSION.to_string(),
                    }
                }
                crate::devserver_handoff::Request::RegisterWorkspace { workspace_path, .. } => {
                    match state.register_workspace(Path::new(&workspace_path)).await {
                        Ok(prefix) => crate::devserver_handoff::Response::Registered {
                            devserver_version: crate::devserver_handoff::CHAN_VERSION.to_string(),
                            prefix,
                        },
                        Err(e) => crate::devserver_handoff::Response::Error {
                            message: e.to_string(),
                        },
                    }
                }
            }
        }
    });
    match result {
        Ok(handle) => Some(handle),
        Err(e) => {
            eprintln!(
                "chan devserver: NOTE: discovery socket unavailable ({e}); \
                 serve-handoff registration is disabled"
            );
            None
        }
    }
}

// ---------------------------------------------------------------------------
// Management handlers.
// ---------------------------------------------------------------------------

/// The host's OS family + a best-effort human OS string for the launcher's
/// machine icon. `os` is `macos | windows | linux | other` from the running
/// binary's compile target; `pretty_name` is the linux `/etc/os-release`
/// `PRETTY_NAME` when readable, absent elsewhere (the family alone drives the
/// icon). Memoized: the OS is fixed for the process, and `/api/devserver/info`
/// is an unauthenticated probe a connecting client may poll. Also drives the
/// launcher's LOCAL machine icon via the `chan-launcher-host-os` meta tag.
pub(crate) fn detect_os() -> (String, Option<String>) {
    static OS: OnceLock<(String, Option<String>)> = OnceLock::new();
    OS.get_or_init(|| {
        let family = match std::env::consts::OS {
            "macos" => "macos",
            "windows" => "windows",
            "linux" => "linux",
            _ => "other",
        };
        let pretty_name = (family == "linux")
            .then(|| std::fs::read_to_string("/etc/os-release").ok())
            .flatten()
            .and_then(|text| parse_pretty_name(&text));
        (family.to_string(), pretty_name)
    })
    .clone()
}

/// `PRETTY_NAME` from `/etc/os-release` content (e.g. `"Ubuntu 22.04.3 LTS"`),
/// the freedesktop key every mainstream distro ships. `None` when no non-empty
/// `PRETTY_NAME` line is present.
fn parse_pretty_name(os_release: &str) -> Option<String> {
    os_release.lines().find_map(|line| {
        let value = line.strip_prefix("PRETTY_NAME=")?.trim().trim_matches('"');
        (!value.is_empty()).then(|| value.to_string())
    })
}

async fn handle_info(State(state): State<Arc<DevserverState>>) -> Json<DevserverInfo> {
    let (os, pretty_name) = detect_os();
    Json(DevserverInfo {
        devserver_version: env!("CARGO_PKG_VERSION").to_string(),
        protocol: DEVSERVER_API_PROTOCOL,
        host_label: state.host_label.clone(),
        library_id: state.library_id.clone(),
        os,
        pretty_name,
    })
}

/// Liveness shape for `GET /api/health` on the devserver root, mirroring the
/// per-tenant health route: `instance` carries the stable `library_id` so a
/// probe can tell one devserver from another across restarts.
#[derive(Serialize)]
struct DevserverHealth {
    status: &'static str,
    instance: String,
}

/// `GET /api/health` on the devserver root. The `--service` supervisor's
/// watchdog polls this to decide the backing devserver is still up.
async fn handle_health(State(state): State<Arc<DevserverState>>) -> Json<DevserverHealth> {
    Json(DevserverHealth {
        status: "ok",
        instance: state.library_id.clone(),
    })
}

/// `POST /api/devserver/rotate-token`: re-mint the devserver bearer under
/// the CURRENT bearer (the suspected-leak response). The old token stops
/// authorizing on the next request; the caller owns re-emitting the
/// `CHAN_DEVSERVER_TOKEN=` marker and the `/?t=` URL.
async fn handle_rotate_token(State(state): State<Arc<DevserverState>>) -> Json<RotatedToken> {
    Json(RotatedToken {
        token: state.rotate_token(),
    })
}

async fn handle_list(State(state): State<Arc<DevserverState>>) -> Json<Vec<WorkspaceEntry>> {
    Json(state.workspace_entries())
}

async fn handle_open(
    State(state): State<Arc<DevserverState>>,
    Json(req): Json<OpenWorkspaceRequest>,
) -> Response {
    match state.register_workspace(Path::new(&req.path)).await {
        Ok(prefix) => Json(MountedPrefix { prefix }).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e.to_string()).into_response(),
    }
}

async fn handle_forget(
    State(state): State<Arc<DevserverState>>,
    AxumPath(prefix_tail): AxumPath<String>,
    Query(query): Query<ForceQuery>,
) -> Response {
    // The wildcard captures the prefix without its leading slash (the
    // client appends the prefix value verbatim to the route base).
    let prefix = format!("/{}", prefix_tail.trim_start_matches('/'));
    match state.forget_workspace(&prefix, query.force).await {
        Ok(WorkspaceLifecycleOutcome::Completed) => StatusCode::NO_CONTENT.into_response(),
        Ok(WorkspaceLifecycleOutcome::NotFound) => StatusCode::NOT_FOUND.into_response(),
        Ok(WorkspaceLifecycleOutcome::Refused { active_terminals }) => (
            StatusCode::CONFLICT,
            Json(ActiveTerminalsRejection {
                error: "live_terminals".into(),
                active_terminals,
            }),
        )
            .into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

/// Set whether the registered workspace addressed by the route is mounted.
/// The catch-all captures `<prefix>/on` (the client appends the prefix
/// verbatim then `/on`, mirroring the `DELETE` convention -- an axum catch-all
/// can't carry a fixed `/on` suffix, so the suffix rides inside the capture);
/// we recover the prefix by stripping the trailing `/on`. A capture that is
/// not `<prefix>/on` is not this endpoint and 404s. The body is
/// [`SetWorkspaceOnRequest`]; the response is the updated [`WorkspaceEntry`]
/// (404 when the prefix is not a registered workspace).
async fn handle_set_workspace_on(
    State(state): State<Arc<DevserverState>>,
    AxumPath(captured): AxumPath<String>,
    Json(req): Json<SetWorkspaceOnRequest>,
) -> Response {
    let Some(prefix_tail) = captured.trim_start_matches('/').strip_suffix("/on") else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let prefix = format!("/{}", prefix_tail.trim_start_matches('/'));
    // Confirm-before-off: unmounting a workspace kills the terminals running in
    // it, so a reversible off with live terminals is refused (the response
    // carries the count) until the client re-issues with `force`. The check is
    // server-side because `cs` and the launcher can trigger the off too, not
    // just the desktop's own confirm dialog.
    if !req.on && !req.force {
        let active = state.host.tenant_terminal_session_count(&prefix);
        if active > 0 {
            return (
                StatusCode::CONFLICT,
                Json(ActiveTerminalsRejection {
                    error: "live_terminals".into(),
                    active_terminals: active,
                }),
            )
                .into_response();
        }
    }
    match state.set_workspace_on(&prefix, req.on, req.force).await {
        Ok(SetWorkspaceOnResult::Updated(Some(entry))) => Json(entry).into_response(),
        Ok(SetWorkspaceOnResult::Updated(None)) => StatusCode::NOT_FOUND.into_response(),
        Ok(SetWorkspaceOnResult::Refused { active_terminals }) => (
            StatusCode::CONFLICT,
            Json(ActiveTerminalsRejection {
                error: "live_terminals".into(),
                active_terminals,
            }),
        )
            .into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

/// `GET /api/devserver/windows` (L10): every PERSISTED window across all
/// tenants, for the desktop's menu-reopen of closed devserver windows. Folds
/// the host's per-tenant window enumeration into `DevserverWindow` rows,
/// stamping each with its tenant's per-mount token; the desktop filters
/// `saved && !connected`. Persisted-only: a discard reaped the blob + PTYs, so
/// only windows with a live blob (`saved`) surface.
async fn handle_list_windows(
    State(_state): State<Arc<DevserverState>>,
) -> Json<Vec<DevserverWindow>> {
    // Superseded by the library window feed `GET /api/library/windows`,
    // which the desktop watcher and `cs window list` reconcile to. The
    // per-tenant enumeration that backed this endpoint is gone with the host
    // move; this returns empty during the transition until the feed lands and
    // this endpoint is retired.
    Json(Vec::new())
}

/// Explicitly end every terminal session and wait, bounded, until the child
/// processes are observably dead. `chan devserver --stop` drains through
/// here before `systemctl stop`, and `--restart --force` before its
/// destructive bounce; the response never claims completion for a child
/// that is still running (`lingering`).
async fn handle_terminal_sessions_drain(State(state): State<Arc<DevserverState>>) -> Response {
    let outcome = state.host.drain_terminal_sessions().await;
    Json(crate::devserver_api::DrainedTerminals {
        closed: outcome.closed,
        dead: outcome.dead,
        lingering: outcome.lingering,
    })
    .into_response()
}

/// Gate every `/api/devserver/*` management route except `info` on the devserver
/// bearer token. The token arrives in the `Authorization: Bearer` header (`cs`,
/// the desktop). The management surface is header-only: it has no WebSocket
/// route, so there is no `?t=` query-token path here (the launcher's watch WS
/// lives in [`crate::routes::launcher_router`], which owns its own `?t=` rule).
async fn require_bearer(
    State(state): State<Arc<DevserverState>>,
    req: HttpRequest<Body>,
    next: Next,
) -> Response {
    let header_token = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    // Read the shared cell in a block so the guard drops before the await.
    let authorized = {
        let token = state.token.read().unwrap_or_else(|e| e.into_inner());
        header_token.is_some_and(|t| bytes_eq(t.as_bytes(), token.as_bytes()))
    };
    if authorized {
        next.run(req).await
    } else {
        (
            StatusCode::UNAUTHORIZED,
            "missing or invalid devserver bearer token",
        )
            .into_response()
    }
}

/// Length-then-content comparison of two byte slices in time independent of
/// where they first differ, so a wrong token leaks no position information.
/// `pub(crate)` so the launcher bundle ([`crate::routes::launcher_router`])
/// reuses the one vetted constant-time compare for its own bearer gate.
pub(crate) fn bytes_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

// ---------------------------------------------------------------------------
// Prefix + config helpers.
// ---------------------------------------------------------------------------

/// Top-level prefix reserved for the devserver's own `/api/` namespace (the
/// management API and the terminal tenants). A workspace whose basename
/// sanitizes to `api` would mount at `/api` and shadow that namespace, so
/// [`mount_at`](DevserverState::mount_at) rejects it. Workspace tenants mount at
/// their public slug `/{slug}` (top-level); only `/api` collides.
const RESERVED_WORKSPACE_PREFIX: &str = "/api";

/// Mount prefix of the per-library SHARED terminal tenant that every
/// devserver Terminal window resolves to. Fixed (one shared tenant per library),
/// and distinct from per-label terminal prefixes (`/api/term-…`) and workspace
/// prefixes (the top-level public slug `/{slug}`), so it never collides.
const DEVSERVER_SHARED_TERMINAL_PREFIX: &str = "/api/terminal";

/// Per-tenant serve config: each workspace gets its own bearer token (so
/// `no_token` is false), no browser, no idle timeout.
fn tenant_config(addr: SocketAddr, prefix: &str) -> ServeConfig {
    ServeConfig {
        addr,
        no_token: false,
        prefix: prefix.to_string(),
        idle_timeout: None,
        open_browser: false,
        search_aggression: None,
        settings_disabled: false,
        verbose: false,
    }
}

/// Display label for a workspace: its last path segment, or the full path
/// when there is no file name.
fn workspace_label(root: &Path) -> String {
    root.file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| root.display().to_string())
}

/// Canonical form of a workspace root for cross-store comparison (the library
/// registers canonical roots; the overlay/map store them as written). Falls
/// back to the path as-is when it no longer resolves on disk so a vanished
/// root still compares equal to its own stored form.
fn canonical_root(root: &Path) -> PathBuf {
    std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chan_library::workspace_slug;
    use std::sync::atomic::AtomicBool;

    /// Coordinates process-env access across this test binary: the fdstore
    /// boot tests rewrite `CHAN_HOME` under the WRITE side, and every test
    /// whose product path re-resolves `config_dir()` mid-test (mounting a
    /// workspace persists and re-reads its tenant token there) holds the
    /// READ side, so a rewrite can never interleave with a mount.
    static CHAN_HOME_ENV: std::sync::RwLock<()> = std::sync::RwLock::new(());

    fn chan_home_env_read() -> std::sync::RwLockReadGuard<'static, ()> {
        CHAN_HOME_ENV.read().unwrap_or_else(|e| e.into_inner())
    }

    struct ShutdownProbeBuilder {
        state_tx: Mutex<Option<tokio::sync::oneshot::Sender<Arc<crate::state::AppState>>>>,
    }

    #[async_trait::async_trait]
    impl chan_library::TenantBuilder for ShutdownProbeBuilder {
        async fn build_workspace(
            &self,
            library: Library,
            workspace: Arc<chan_workspace::Workspace>,
            config: &ServeConfig,
            desktop: crate::DesktopBridge,
            unserve: chan_library::UnserveMode,
            control_identity: Option<String>,
        ) -> Result<chan_library::TenantArtifacts, Error> {
            let artifacts = crate::build_app(
                library,
                workspace,
                config,
                desktop,
                unserve,
                control_identity,
            )
            .await?;
            let sent = self
                .state_tx
                .lock()
                .expect("probe builder lock")
                .take()
                .expect("workspace built once")
                .send(artifacts.state.clone());
            assert!(sent.is_ok(), "probe state receiver");
            Ok(crate::into_tenant_artifacts(artifacts))
        }

        async fn build_terminal(
            &self,
            _library: Library,
            _config: &ServeConfig,
            _desktop: crate::DesktopBridge,
            _unserve: chan_library::UnserveMode,
            _command: Option<String>,
            _session_dir: Option<PathBuf>,
            _control_identity: Option<String>,
        ) -> Result<chan_library::TenantArtifacts, Error> {
            Err(Error::Config(
                "shutdown probe does not build terminal tenants".into(),
            ))
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn hosted_shutdown_joins_doc_close_all_before_clearing_workspace_cell() {
        let config = tempfile::tempdir().expect("config");
        let root = tempfile::tempdir().expect("workspace");
        std::fs::write(root.path().join("note.md"), "previous bytes").expect("seed note");

        let library = Library::open_at(config.path().join("config.toml")).expect("library");
        library
            .register_workspace(root.path())
            .expect("register workspace");
        let (state_tx, state_rx) = tokio::sync::oneshot::channel();
        let host = Arc::new(WorkspaceHost::new(
            library.clone(),
            Arc::new(ShutdownProbeBuilder {
                state_tx: Mutex::new(Some(state_tx)),
            }),
        ));
        host.open_registered_workspace(
            root.path(),
            tenant_config("127.0.0.1:0".parse().unwrap(), "/shutdown-probe"),
        )
        .await
        .expect("mount workspace");
        let state = state_rx.await.expect("built app state");
        let workspace = state.try_workspace().expect("live workspace");
        let mut attachment = state
            .doc_sessions
            .attach(&workspace, "note.md", "window-1", None)
            .await
            .expect("attach document");
        let mut frames = attachment.take_frames();
        while frames.try_recv().is_ok() {}
        attachment
            .session()
            .apply_replace("$shutdown-probe", "shutdown-flushed bytes")
            .expect("dirty document");
        while frames.try_recv().is_ok() {}
        drop(workspace);

        let outcome = host
            .close_workspace("/shutdown-probe", false)
            .await
            .expect("close workspace");
        assert!(outcome.completed());
        let mut closed = false;
        while let Ok(frame) = frames.try_recv() {
            let frame: serde_json::Value = serde_json::from_str(&frame).expect("document frame");
            closed |= frame["type"] == "closed";
        }
        assert!(closed, "host returned before joining document close_all");
        assert_eq!(
            std::fs::read(root.path().join("note.md")).expect("read note"),
            b"shutdown-flushed bytes",
            "host cleared the workspace cell before close_all could flush"
        );
        assert!(
            state.try_workspace().is_err(),
            "workspace cell stayed live after joined shutdown"
        );
    }

    async fn completed_serve_arm(listener: bool) -> DevserverServeArm {
        if listener {
            let task = tokio::spawn(async { Ok(()) });
            while !task.is_finished() {
                tokio::task::yield_now().await;
            }
            DevserverServeArm::Listener(task)
        } else {
            let task = tokio::spawn(async {});
            while !task.is_finished() {
                tokio::task::yield_now().await;
            }
            DevserverServeArm::Wait(task)
        }
    }

    async fn assert_serve_arm_joins_watchdog(arm: DevserverServeArm) {
        let completed = Arc::new(AtomicBool::new(false));
        let task_completed = completed.clone();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let watchdog_task = tokio::spawn(async move {
            let _ = entered_tx.send(());
            release_rx
                .recv()
                .expect("release synchronous watchdog work");
            task_completed.store(true, Ordering::SeqCst);
        });
        entered_rx.await.expect("watchdog task entered");

        let watchdog = fdstore::WatchdogPings::from_task(watchdog_task);
        let mut arm_join = std::pin::pin!(arm.join(Some(watchdog)));
        assert!(
            futures::poll!(arm_join.as_mut()).is_pending(),
            "serve arm returned after abort without joining synchronous watchdog work"
        );
        release_tx.send(()).expect("release watchdog task");
        arm_join.await.expect("serve arm completed");
        assert!(
            completed.load(Ordering::SeqCst),
            "serve arm returned before the watchdog task's synchronous side effect"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn both_devserver_serve_arms_join_watchdog_before_return() {
        assert_serve_arm_joins_watchdog(completed_serve_arm(true).await).await;
        assert_serve_arm_joins_watchdog(completed_serve_arm(false).await).await;
    }

    fn pending_record(generation: u64) -> WorkspaceRecord {
        WorkspaceRecord::prepared(
            PathBuf::from("/tmp/notes"),
            "/notes-test".into(),
            true,
            generation,
        )
    }

    #[test]
    fn pending_mount_persists_desired_on_before_completion() {
        let record = pending_record(9);
        assert_eq!(record.phase, MountPhase::Starting);
        let persisted = record.persisted().expect("starting row persists");
        assert!(persisted.desired_on);
        assert_eq!(persisted.generation, 9);
    }

    #[tokio::test]
    async fn begin_mount_publishes_starting_and_intent_before_spawn() {
        let home = tempfile::tempdir().expect("home");
        let workspace = tempfile::tempdir().expect("workspace");
        let state = test_state(home.path(), "127.0.0.1:0".parse().unwrap());
        let prefix = allocate_workspace_prefix(workspace.path()).unwrap();

        let attempt = state
            .begin_mount(workspace.path(), &prefix)
            .expect("prepare mount")
            .expect("fresh attempt");
        state.persist_state();

        let entry = state.entry_for(&prefix).expect("starting row");
        assert_eq!(entry.status, WorkspaceStatus::Starting);
        assert!(!entry.on);
        let persisted = state
            .host
            .workspace_overlay()
            .expect("overlay")
            .entries()
            .pop()
            .expect("durable intent");
        assert!(persisted.desired_on);
        assert_eq!(persisted.generation, attempt.generation);

        state.cancel_mount_attempt(&attempt).await;
    }

    #[test]
    fn stale_mount_completion_cannot_reverse_off_or_forget() {
        let mut off = pending_record(3);
        let stale_off = off.generation;
        assert!(off.turn_off());
        assert_eq!(
            off.complete_success(stale_off, "stale-token".into()),
            MountCompletion::CloseStale
        );
        assert_eq!(off.desired, DesiredMount::Off);
        assert_eq!(off.phase, MountPhase::Stopped);
        assert!(!off.persisted().unwrap().desired_on);

        let mut toggled_back_on = pending_record(4);
        let older_on = toggled_back_on.generation;
        assert!(toggled_back_on.turn_off());
        let newer_on = toggled_back_on.begin_on().expect("new on intent");
        assert_ne!(older_on, newer_on);
        assert_eq!(
            toggled_back_on.complete_success(older_on, "stale-token".into()),
            MountCompletion::CloseStale
        );
        assert_eq!(toggled_back_on.desired, DesiredMount::On);
        assert_eq!(toggled_back_on.phase, MountPhase::Starting);

        let mut forgotten = pending_record(7);
        let stale_forget = forgotten.generation;
        forgotten.forget();
        assert_eq!(
            forgotten.complete_success(stale_forget, "stale-token".into()),
            MountCompletion::ForgetStale
        );
        assert_eq!(forgotten.desired, DesiredMount::Forgotten);
        assert!(forgotten.persisted().is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn timed_out_mount_becomes_visible_failed_intent() {
        let mut record = pending_record(11);
        let result = time_bound_mount(
            Duration::from_secs(1),
            std::future::pending::<Result<(), Error>>(),
        )
        .await;
        assert!(result.is_err(), "hung mount must hit its finite bound");
        assert!(record.complete_failure(11, "mount timed out after 1s".into()));
        assert_eq!(
            record.phase,
            MountPhase::Failed("mount timed out after 1s".into())
        );
        let persisted = record.persisted().expect("failure keeps desired intent");
        assert!(persisted.desired_on);
        assert_eq!(persisted.generation, 11);
    }

    #[tokio::test]
    async fn ready_waits_for_every_startup_attempt_to_settle() {
        let startup = Arc::new(StartupCoordinator::new());
        let attempt = MountAttemptKey::new("/notes-test", 4);
        startup.track(attempt.clone()).expect("track boot mount");
        startup
            .advance(StartupPhase::Binding)
            .expect("preparing -> binding");
        startup
            .advance(StartupPhase::FdstoreApplied)
            .expect("binding -> fdstore");
        startup
            .advance(StartupPhase::ServingAndRestoring)
            .expect("fdstore -> serving");

        let ready_startup = startup.clone();
        let ready = tokio::spawn(async move { ready_startup.ready_after_restore().await });
        tokio::task::yield_now().await;
        assert!(!ready.is_finished(), "READY fired with a mount pending");
        startup.settle(&attempt);
        assert!(ready.await.unwrap());
        assert_eq!(startup.phase(), StartupPhase::Ready);
    }

    #[tokio::test]
    async fn cancelled_client_mount_settles_startup_and_surfaces_failure() {
        let home = tempfile::tempdir().expect("home");
        let workspace = tempfile::tempdir().expect("workspace");
        let state = test_state(home.path(), "127.0.0.1:0".parse().unwrap());
        let prefix = allocate_workspace_prefix(workspace.path()).unwrap();
        let attempt = state
            .begin_mount(workspace.path(), &prefix)
            .expect("prepare mount")
            .expect("fresh attempt");
        state
            .startup
            .advance(StartupPhase::Binding)
            .expect("preparing -> binding");
        state
            .startup
            .advance(StartupPhase::FdstoreApplied)
            .expect("binding -> fdstore");
        state
            .startup
            .advance(StartupPhase::ServingAndRestoring)
            .expect("fdstore -> serving");

        let serialization = state.mount_attempt_lock.lock().await;
        let mount_state = state.clone();
        let mount = tokio::spawn(async move {
            mount_state
                .execute_mount_attempt(attempt, WORKSPACE_MOUNT_TIMEOUT)
                .await
        });
        tokio::task::yield_now().await;
        assert!(!mount.is_finished(), "mount must wait on serialization");
        mount.abort();
        assert!(mount.await.unwrap_err().is_cancelled());
        drop(serialization);

        assert!(
            tokio::time::timeout(
                Duration::from_millis(200),
                state.startup.ready_after_restore()
            )
            .await
            .expect("cancelled attempt must not wedge READY"),
            "startup stopped instead of becoming ready"
        );
        let row = state.entry_for(&prefix).expect("cancelled mount row");
        assert_eq!(row.status, WorkspaceStatus::Error);
        assert!(
            row.error
                .as_deref()
                .is_some_and(|reason| reason.contains("cancelled")),
            "cancellation must stay operator-visible: {:?}",
            row.error
        );
    }

    #[tokio::test]
    async fn workspace_root_removed_during_startup_fails_closed() {
        let home = tempfile::tempdir().expect("home");
        let parent = tempfile::tempdir().expect("workspace parent");
        let workspace = parent.path().join("workspace");
        std::fs::create_dir(&workspace).expect("workspace");
        std::fs::write(workspace.join("note.md"), "# booting\n").expect("seed workspace");
        let state = test_state(home.path(), "127.0.0.1:0".parse().unwrap());
        let prefix = allocate_workspace_prefix(&workspace).expect("workspace prefix");
        let attempt = state
            .begin_mount(&workspace, &prefix)
            .expect("prepare mount")
            .expect("fresh attempt");
        let registered_root = attempt.root.clone();
        state.persist_state();

        let serialization = state.mount_attempt_lock.lock().await;
        let mount_state = state.clone();
        let mount = tokio::spawn(async move {
            mount_state
                .execute_mount_attempt(attempt, WORKSPACE_MOUNT_TIMEOUT)
                .await
        });
        tokio::task::yield_now().await;
        assert!(!mount.is_finished(), "mount escaped the startup barrier");
        assert_eq!(
            state.entry_for(&prefix).expect("starting row").status,
            WorkspaceStatus::Starting
        );

        std::fs::remove_dir_all(&workspace).expect("remove harness-owned workspace");
        assert!(
            !workspace.exists(),
            "workspace root survived recursive deletion"
        );
        drop(serialization);

        let error = tokio::time::timeout(Duration::from_secs(10), mount)
            .await
            .expect("failed mount must settle")
            .expect("mount task")
            .expect_err("deleted workspace root must fail startup");
        assert!(
            matches!(
                error,
                Error::Core(chan_workspace::ChanError::WorkspaceRootMissing(ref missing))
                    if missing == &registered_root
            ),
            "unexpected mount error: {error}"
        );
        let failed = state.entry_for(&prefix).expect("registered failed row");
        assert!(!failed.on);
        assert_eq!(failed.status, WorkspaceStatus::Error);
        assert!(
            failed
                .error
                .as_deref()
                .is_some_and(|reason| reason.contains("workspace root does not exist")),
            "root-missing reason was not operator-visible: {:?}",
            failed.error
        );
        // Host and registry lookups resolve the caller path against the
        // registered root, and a deleted root can no longer canonicalize -- so
        // these must ask with the registered root. Asking with the raw path
        // would answer "not mounted" and "not registered" for a workspace that
        // is both, turning the mount assertion into a tautology.
        assert!(!state.host.is_root_mounted(&registered_root));
        assert!(
            state
                .host
                .library()
                .workspace_paths_for(&registered_root)
                .is_some(),
            "failed startup unexpectedly unregistered the workspace"
        );
        assert!(
            !workspace.exists(),
            "failed mount recreated the workspace root"
        );
        assert!(
            state
                .startup
                .inner
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .pending
                .is_empty(),
            "failed startup stayed pending"
        );
    }

    #[tokio::test]
    async fn chan_close_during_startup_stays_off_preserves_metadata_and_reopens() {
        let _env = chan_home_env_read();
        let home = tempfile::tempdir().expect("home");
        let workspace = tempfile::tempdir().expect("workspace");
        let state = test_state(home.path(), "127.0.0.1:0".parse().unwrap());
        let prefix = allocate_workspace_prefix(workspace.path()).expect("workspace prefix");
        let attempt = state
            .begin_mount(workspace.path(), &prefix)
            .expect("prepare mount")
            .expect("fresh attempt");
        state.persist_state();

        let metadata = state
            .host
            .library()
            .workspace_paths_for(workspace.path())
            .expect("registered workspace metadata");
        let layout_sentinel = metadata.sessions.join("startup-layout.json");
        std::fs::write(&layout_sentinel, b"preserve this layout").expect("seed layout");

        // Hold the real mount serialization boundary: the command observes a
        // Starting row, while the original attempt cannot acquire the writer
        // lock or complete until the test explicitly releases it.
        let serialization = state.mount_attempt_lock.lock().await;
        let mount_state = state.clone();
        let mount = tokio::spawn(async move {
            mount_state
                .execute_mount_attempt(attempt, WORKSPACE_MOUNT_TIMEOUT)
                .await
        });
        tokio::task::yield_now().await;
        assert!(!mount.is_finished(), "mount escaped the startup barrier");
        assert_eq!(
            state.entry_for(&prefix).expect("starting row").status,
            WorkspaceStatus::Starting
        );

        let closed = tokio::time::timeout(
            Duration::from_secs(2),
            state.host.close_workspace_for_root(workspace.path(), false),
        )
        .await
        .expect("chan close must be bounded")
        .expect("chan close");
        assert!(
            closed.completed(),
            "a registered starting workspace must count as closed: {closed:?}"
        );
        let durable = state
            .host
            .workspace_overlay()
            .expect("workspace overlay")
            .entries()
            .into_iter()
            .find(|row| canonical_root(Path::new(&row.path)) == canonical_root(workspace.path()))
            .expect("durable workspace intent");
        assert!(!durable.desired_on, "chan close did not persist off");
        assert!(
            !mount.is_finished(),
            "close released the held mount attempt"
        );
        assert!(!state.host.is_root_mounted(workspace.path()));
        assert!(
            state
                .host
                .library()
                .workspace_paths_for(workspace.path())
                .is_some(),
            "plain close removed the registration"
        );
        assert_eq!(
            std::fs::read(&layout_sentinel).expect("layout survives close"),
            b"preserve this layout"
        );

        drop(serialization);
        let stale_result = tokio::time::timeout(Duration::from_secs(10), mount)
            .await
            .expect("stale mount compensation must be bounded")
            .expect("stale mount task");
        assert_eq!(
            stale_result.expect("superseded closed mount settles cleanly"),
            prefix
        );
        let stopped = state
            .workspace_entries()
            .into_iter()
            .find(|row| row.prefix == prefix)
            .expect("registered stopped row");
        assert!(!stopped.on);
        assert_eq!(stopped.status, WorkspaceStatus::Stopped);
        assert_eq!(stopped.token, "");
        assert!(
            !state.host.is_root_mounted(workspace.path()),
            "stale startup resurrected the tenant"
        );
        assert_eq!(
            std::fs::read(&layout_sentinel).expect("layout survives stale completion"),
            b"preserve this layout"
        );

        let reopened = tokio::time::timeout(
            Duration::from_secs(10),
            state.set_workspace_on(&prefix, true, false),
        )
        .await
        .expect("reopen must be bounded")
        .expect("reopen");
        let SetWorkspaceOnResult::Updated(Some(reopened)) = reopened else {
            panic!("reopen did not return the running workspace row: {reopened:?}");
        };
        assert!(reopened.on);
        assert_eq!(reopened.status, WorkspaceStatus::Running);
        assert!(
            state.host.is_root_mounted(workspace.path()),
            "reopen did not reacquire the released writer lock"
        );
        assert_eq!(
            std::fs::read(&layout_sentinel).expect("layout survives reopen"),
            b"preserve this layout"
        );

        assert!(
            state
                .forget_workspace(&prefix, true)
                .await
                .expect("cleanup")
                .completed(),
            "cleanup did not remove the reopened workspace"
        );
    }

    #[tokio::test]
    async fn chan_close_remove_during_startup_forgets_metadata_preserves_source_and_reopens_fresh()
    {
        let _env = chan_home_env_read();
        let home = tempfile::tempdir().expect("home");
        let workspace = tempfile::tempdir().expect("workspace");
        let source_sentinel = workspace.path().join("source-sentinel.md");
        std::fs::write(&source_sentinel, b"# source survives\n").expect("seed source");
        let state = test_state(home.path(), "127.0.0.1:0".parse().unwrap());
        let prefix = allocate_workspace_prefix(workspace.path()).expect("workspace prefix");
        let attempt = state
            .begin_mount(workspace.path(), &prefix)
            .expect("prepare mount")
            .expect("fresh attempt");
        state.persist_state();

        let metadata = state
            .host
            .library()
            .workspace_paths_for(workspace.path())
            .expect("registered workspace metadata");
        let layout_sentinel = metadata.sessions.join("removed-layout.json");
        std::fs::write(&layout_sentinel, b"remove this layout").expect("seed layout");

        let serialization = state.mount_attempt_lock.lock().await;
        let mount_state = state.clone();
        let mount = tokio::spawn(async move {
            mount_state
                .execute_mount_attempt(attempt, WORKSPACE_MOUNT_TIMEOUT)
                .await
        });
        tokio::task::yield_now().await;
        assert!(!mount.is_finished(), "mount escaped the startup barrier");
        assert_eq!(
            state.entry_for(&prefix).expect("starting row").status,
            WorkspaceStatus::Starting
        );

        let removed = tokio::time::timeout(
            Duration::from_secs(2),
            state
                .host
                .remove_workspace_for_root(workspace.path(), false),
        )
        .await
        .expect("chan close --remove must be bounded")
        .expect("chan close --remove");
        assert!(removed.completed());
        assert!(
            !mount.is_finished(),
            "remove released the held mount attempt"
        );
        assert!(!state.host.is_root_mounted(workspace.path()));
        assert!(
            state.workspace_entries().is_empty(),
            "removed workspace stayed visible"
        );
        assert!(
            state.host.library().list_workspaces().is_empty(),
            "removed workspace stayed registered"
        );
        assert!(
            state
                .host
                .library()
                .workspace_paths_for(workspace.path())
                .is_none(),
            "removed workspace retained a metadata identity"
        );
        assert!(
            !layout_sentinel.exists(),
            "remove retained the saved layout"
        );
        assert_eq!(
            std::fs::read(&source_sentinel).expect("source survives remove"),
            b"# source survives\n"
        );

        drop(serialization);
        let stale_result = tokio::time::timeout(Duration::from_secs(10), mount)
            .await
            .expect("stale removed mount must settle")
            .expect("stale mount task");
        assert_eq!(
            stale_result.expect("superseded removed mount settles cleanly"),
            prefix
        );
        assert!(
            state.entry_for(&prefix).is_none(),
            "stale completion retained its internal tombstone"
        );
        assert!(
            state.workspace_entries().is_empty(),
            "stale completion resurrected the removed workspace"
        );
        assert!(!state.host.is_root_mounted(workspace.path()));
        assert!(
            !metadata.sessions.exists(),
            "stale completion recreated removed session metadata"
        );
        assert_eq!(
            std::fs::read(&source_sentinel).expect("source survives stale completion"),
            b"# source survives\n"
        );

        let fresh_prefix = tokio::time::timeout(
            Duration::from_secs(10),
            state.register_workspace(workspace.path()),
        )
        .await
        .expect("fresh reopen must be bounded")
        .expect("fresh reopen");
        assert_eq!(fresh_prefix, prefix);
        assert!(state.host.is_root_mounted(workspace.path()));
        let fresh_metadata = state
            .host
            .library()
            .workspace_paths_for(workspace.path())
            .expect("fresh metadata identity");
        assert!(
            !fresh_metadata.sessions.join("removed-layout.json").exists(),
            "fresh reopen recovered removed layout state"
        );
        assert_eq!(
            std::fs::read(&source_sentinel).expect("source survives fresh reopen"),
            b"# source survives\n"
        );

        assert!(
            state
                .forget_workspace(&prefix, true)
                .await
                .expect("cleanup")
                .completed(),
            "cleanup did not remove the freshly reopened workspace"
        );
    }

    #[test]
    fn fdstore_apply_is_single_and_precedes_route_exposure() {
        let startup = StartupCoordinator::new();
        startup
            .advance(StartupPhase::Binding)
            .expect("preparing -> binding");
        assert!(
            startup.advance(StartupPhase::ServingAndRestoring).is_err(),
            "routes must not serve before fdstore adoption"
        );
        startup
            .advance(StartupPhase::FdstoreApplied)
            .expect("fdstore applies once");
        assert!(
            startup.advance(StartupPhase::FdstoreApplied).is_err(),
            "fdstore adoption cannot run twice"
        );
        startup
            .advance(StartupPhase::ServingAndRestoring)
            .expect("routes expose after fdstore");
    }

    #[tokio::test]
    async fn restore_owner_joins_shutdown_before_returning() {
        let fired = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let release = Arc::new(tokio::sync::Notify::new());
        let (shutdown_tx, mut shutdown_rx) = tokio::sync::watch::channel(false);
        let task_fired = fired.clone();
        let task_release = release.clone();
        let task = tokio::spawn(async move {
            tokio::select! {
                _ = shutdown_rx.changed() => {}
                _ = task_release.notified() => {
                    task_fired.store(true, Ordering::SeqCst);
                }
            }
        });
        let restore = WorkspaceRestore::from_task(task);

        shutdown_tx.send(true).unwrap();
        restore.join().await.unwrap();
        release.notify_waiters();
        tokio::task::yield_now().await;
        assert!(
            !fired.load(Ordering::SeqCst),
            "restore task mutated state after its owner joined"
        );
    }

    fn updated_row(result: SetWorkspaceOnResult) -> WorkspaceEntry {
        match result {
            SetWorkspaceOnResult::Updated(Some(row)) => row,
            other => panic!("expected updated row, got {other:?}"),
        }
    }

    fn updated_none(result: SetWorkspaceOnResult) -> bool {
        matches!(result, SetWorkspaceOnResult::Updated(None))
    }

    #[test]
    fn parses_pretty_name_from_os_release() {
        // The freedesktop `PRETTY_NAME` is the launcher tooltip; surrounding
        // quotes are stripped, and a missing/blank value yields no tooltip (the
        // family icon stands alone).
        let ubuntu = "NAME=\"Ubuntu\"\nPRETTY_NAME=\"Ubuntu 22.04.3 LTS\"\nID=ubuntu\n";
        assert_eq!(
            parse_pretty_name(ubuntu).as_deref(),
            Some("Ubuntu 22.04.3 LTS")
        );
        assert_eq!(parse_pretty_name("ID=void\nNAME=void\n"), None);
        assert_eq!(parse_pretty_name("PRETTY_NAME=\"\"\n"), None);
    }

    #[test]
    fn token_marker_is_the_locked_wire_string() {
        // LOCKED contract: the desktop control terminal scrapes this exact
        // prefix from the connect-script output. Both the foreground emit and
        // the `--service=systemd --join` re-attach emit build to it, so pin it
        // here; an accidental edit breaks reconnect.
        assert_eq!(DEVSERVER_TOKEN_MARKER, "CHAN_DEVSERVER_TOKEN=");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn fdstore_child_pid_is_parsed_from_chan_fd_name() {
        // Continuous-parking names: chan.pty.<session_id>.<child_pid>.
        assert_eq!(
            fdstore::child_pid_from_name("chan.pty.0f3a9c.4242"),
            Some(4242)
        );
        assert_eq!(fdstore::child_pid_from_name("chan.pty.0f3a9c.0"), None);
        assert_eq!(fdstore::child_pid_from_name("other.pty.0f3a9c.4242"), None);
        assert_eq!(fdstore::child_pid_from_name("chan.pty.0f3a9c.nope"), None);
    }

    #[tokio::test]
    async fn port_zero_bind_resolves_to_a_concrete_port() {
        // The ready line reports `listener.local_addr()`, not the requested
        // addr, so `chan devserver --port 0` prints the OS-assigned port (the
        // shape `chan open` reports) instead of `:0`.
        let requested: SocketAddr = "127.0.0.1:0".parse().unwrap();
        let listener = tokio::net::TcpListener::bind(requested).await.unwrap();
        let local_addr = listener.local_addr().unwrap_or(requested);
        assert_eq!(local_addr.ip(), requested.ip());
        assert_ne!(
            local_addr.port(),
            0,
            "the OS assigns a concrete port for :0"
        );
    }

    #[test]
    fn slug_sanitizes_and_falls_back() {
        assert_eq!(workspace_slug(Path::new("/home/u/My Notes")), "my-notes");
        assert_eq!(workspace_slug(Path::new("/home/u/notes.d")), "notes-d");
        assert_eq!(workspace_slug(Path::new("/home/u/__")), "workspace");
        assert_eq!(workspace_slug(Path::new("/")), "workspace");
    }

    #[test]
    fn workspace_prefix_is_a_keyed_pathspec() {
        let a = allocate_workspace_prefix(Path::new("/tmp/notes")).unwrap();
        let b = allocate_workspace_prefix(Path::new("/tmp/notes")).unwrap();
        // Deterministic: the same root maps to the same prefix.
        assert_eq!(a, b);
        // The prefix is the keyed pathspec `/{slug}-{8hex}` the gateway forwards:
        // the legible basename slug plus a hash of the canonical root. Top-level,
        // never under the reserved `/api/` namespace, never empty.
        assert!(a.starts_with("/notes-"), "{a}");
        assert!(!a.starts_with("/api/") && a != "/api");
        assert_ne!(a, "");
        let suffix = a.rsplit_once('-').unwrap().1;
        assert_eq!(suffix.len(), 8);
        assert!(suffix.chars().all(|c| c.is_ascii_hexdigit()));
        // A different basename differs.
        let c = allocate_workspace_prefix(Path::new("/tmp/other")).unwrap();
        assert_ne!(a, c);
        // Same basename under a DIFFERENT parent no longer collides: the
        // hash suffix keys the prefix to the root, so the two map to DISTINCT
        // prefixes and both mount (the old basename-only slug rejected the
        // second at mount time).
        let d = allocate_workspace_prefix(Path::new("/tmp/sub/notes")).unwrap();
        assert!(d.starts_with("/notes-"), "{d}");
        assert_ne!(a, d, "same basename, different root → distinct prefix");
    }

    #[tokio::test]
    async fn mount_uses_keyed_pathspec_same_basename_coexist_and_reserved_guarded() {
        let home = tempfile::tempdir().expect("home");
        let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
        let state = test_state(home.path(), addr);

        // A workspace named "notes" mounts at its keyed pathspec `/notes-{8hex}`
        // (the path the gateway forwards): a legible basename slug plus a hash of
        // the canonical root.
        let parent = tempfile::tempdir().expect("parent");
        let notes = parent.path().join("notes");
        std::fs::create_dir_all(&notes).unwrap();
        std::fs::write(notes.join("n.md"), "# N\n").unwrap();
        let prefix = state.register_workspace(&notes).await.expect("mount");
        assert!(prefix.starts_with("/notes-"), "{prefix}");
        assert!(state.host.mounted_prefixes().unwrap().contains(&prefix));

        // A SECOND workspace with the same basename under a DIFFERENT parent
        // no longer collides -- the hash keys the prefix to the root, so both
        // mount at distinct prefixes (the bug was the second being rejected).
        let other = tempfile::tempdir().expect("other");
        let notes2 = other.path().join("notes");
        std::fs::create_dir_all(&notes2).unwrap();
        std::fs::write(notes2.join("n.md"), "# N2\n").unwrap();
        let prefix2 = state
            .register_workspace(&notes2)
            .await
            .expect("second same-basename workspace also mounts");
        assert!(prefix2.starts_with("/notes-"), "{prefix2}");
        assert_ne!(
            prefix, prefix2,
            "same basename, different root → distinct prefix"
        );
        assert!(state.host.mounted_prefixes().unwrap().contains(&prefix2));

        // A workspace named "api" no longer shadows the reserved /api management
        // namespace: the hash suffix mounts it at `/api-{8hex}`, a distinct
        // top-level segment.
        let api_parent = tempfile::tempdir().expect("api parent");
        let api_dir = api_parent.path().join("api");
        std::fs::create_dir_all(&api_dir).unwrap();
        std::fs::write(api_dir.join("a.md"), "# A\n").unwrap();
        let api_prefix = state
            .register_workspace(&api_dir)
            .await
            .expect("api mounts");
        assert!(api_prefix.starts_with("/api-"), "{api_prefix}");
        assert_ne!(api_prefix, RESERVED_WORKSPACE_PREFIX);

        // The reserved guard still rejects a LITERAL `/api` mount (defense in
        // depth: allocate_workspace_prefix can no longer produce it, but a direct
        // mount at the management namespace must still fail).
        let err = state
            .mount_at(&api_dir, RESERVED_WORKSPACE_PREFIX)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("reserved"), "{err}");
    }

    #[test]
    fn bytes_eq_is_length_and_content_sensitive() {
        assert!(bytes_eq(b"secret", b"secret"));
        assert!(!bytes_eq(b"secret", b"secre"));
        assert!(!bytes_eq(b"secret", b"secreT"));
        assert!(bytes_eq(b"", b""));
    }

    #[test]
    fn persisted_config_round_trips() {
        let cfg = PersistedConfig {
            devserver_token: "tok".into(),
            token_minted_at: 1_753_000_000,
            library_id: "lib-abc".into(),
            port: 9605,
        };
        let json = serde_json::to_string(&cfg).unwrap();
        let back: PersistedConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.devserver_token, "tok");
        assert_eq!(back.token_minted_at, 1_753_000_000);
        assert_eq!(back.library_id, "lib-abc");
        assert_eq!(back.port, 9605);
        // Tolerant of a missing/empty file shape; an absent port reads 0,
        // an absent mint time reads 0 (= unknown age, rotates on boot).
        let empty: PersistedConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(empty.devserver_token, "");
        assert_eq!(empty.port, 0);
        assert_eq!(empty.token_minted_at, 0);
        // Old-format keys (`enabled_workspaces`, `workspaces`, `terminals`)
        // degrade cleanly: workspace on/off lives in the overlay store now and
        // the per-label terminal subsystem is gone, so unknown keys are ignored
        // rather than failing the whole parse and minting a fresh token.
        let legacy =
            r#"{"devserver_token":"keep","workspaces":[{"path":"/x","on":true}],"terminals":[]}"#;
        let migrated: PersistedConfig = serde_json::from_str(legacy).unwrap();
        assert_eq!(migrated.devserver_token, "keep");
    }

    #[test]
    fn devserver_secret_debug_contracts_are_redacted() {
        let sentinel = "devserver-secret-sentinel";
        let tunnel = DevserverTunnel {
            tunnel_url:
                "https://tunnel-user-sentinel:tunnel-pass-sentinel@devserver.example.test/v1/tunnel"
                    .into(),
            token: sentinel.into(),
            name: "workstation".into(),
        };
        let tunnel_debug = format!("{tunnel:?}");
        assert!(tunnel_debug.contains("[REDACTED]"));
        assert!(!tunnel_debug.contains(sentinel));
        assert!(!tunnel_debug.contains("tunnel-user-sentinel"));
        assert!(!tunnel_debug.contains("tunnel-pass-sentinel"));

        let persisted = PersistedConfig {
            devserver_token: sentinel.into(),
            token_minted_at: 0,
            library_id: "lib-test".into(),
            port: 9605,
        };
        let persisted_debug = format!("{persisted:?}");
        assert!(persisted_debug.contains("[REDACTED]"));
        assert!(!persisted_debug.contains(sentinel));
    }

    #[test]
    fn resolve_boot_token_age_rules() {
        let day = 86_400u64;
        let now = 100 * day;
        // First boot: no token -> minted and stamped.
        let mut fresh = PersistedConfig::default();
        assert_eq!(resolve_boot_token(&mut fresh, now), BootToken::Minted);
        assert!(!fresh.devserver_token.is_empty());
        assert_eq!(fresh.token_minted_at, now);
        // Within the window: kept verbatim.
        let mut recent = PersistedConfig {
            devserver_token: "keep".into(),
            token_minted_at: now - 10 * day,
            ..Default::default()
        };
        assert_eq!(resolve_boot_token(&mut recent, now), BootToken::Kept);
        assert_eq!(recent.devserver_token, "keep");
        assert_eq!(recent.token_minted_at, now - 10 * day);
        // Over the window: rotated and re-stamped.
        let mut old = PersistedConfig {
            devserver_token: "stale".into(),
            token_minted_at: now - 31 * day,
            ..Default::default()
        };
        assert_eq!(resolve_boot_token(&mut old, now), BootToken::RotatedByAge);
        assert_ne!(old.devserver_token, "stale");
        assert_eq!(old.token_minted_at, now);
        // Unknown mint time (every pre-rotation config): rotated once.
        let mut unknown = PersistedConfig {
            devserver_token: "pre-fix".into(),
            token_minted_at: 0,
            ..Default::default()
        };
        assert_eq!(
            resolve_boot_token(&mut unknown, now),
            BootToken::RotatedByAge
        );
        assert_ne!(unknown.devserver_token, "pre-fix");
        // Clock stepped back (future stamp): kept, re-stamped to now so the
        // age check stays meaningful instead of never expiring.
        let mut future = PersistedConfig {
            devserver_token: "keep-too".into(),
            token_minted_at: now + day,
            ..Default::default()
        };
        assert_eq!(resolve_boot_token(&mut future, now), BootToken::Kept);
        assert_eq!(future.devserver_token, "keep-too");
        assert_eq!(future.token_minted_at, now);
    }

    #[test]
    fn rotate_token_replaces_persisted_and_preserves_identity() {
        let home = tempfile::tempdir().expect("home");
        let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
        let state = test_state(home.path(), addr);
        state.bound_port.store(9605, Ordering::Relaxed);
        state.persist_state();
        let before = state.store.load();
        assert_eq!(before.devserver_token, "test-token");

        let rotated = state.rotate_token();
        assert_ne!(rotated, "test-token", "rotation must mint a new value");
        let after = state.store.load();
        assert_eq!(after.devserver_token, rotated, "new token is persisted");
        assert!(after.token_minted_at > 0, "mint time is stamped");
        assert_eq!(after.library_id, before.library_id);
        assert_eq!(after.port, 9605);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(home.path().join("devserver").join("config.json"))
                .expect("config metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600, "config must stay 0600 across rotation");
        }
    }

    #[tokio::test]
    async fn terminal_sessions_drain_is_bearer_gated_and_reports_counts() {
        use tower::ServiceExt;

        let home = tempfile::tempdir().expect("home");
        let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
        let state = test_state(home.path(), addr);
        let host = state.host.clone();
        let (app, _serve_addr) = build_devserver_app(state, host);
        let drain = |bearer: &str| {
            HttpRequest::builder()
                .method("POST")
                .uri("/api/devserver/terminal-sessions/drain")
                .header(header::AUTHORIZATION, format!("Bearer {bearer}"))
                .body(Body::empty())
                .unwrap()
        };

        let res = app.clone().oneshot(drain("wrong")).await.unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

        let res = app.clone().oneshot(drain("test-token")).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let drained: crate::devserver_api::DrainedTerminals =
            serde_json::from_slice(&body).unwrap();
        assert_eq!(
            drained,
            crate::devserver_api::DrainedTerminals {
                closed: 0,
                dead: 0,
                lingering: Vec::new(),
            },
            "an empty host drains nothing and lingers nothing"
        );
    }

    #[tokio::test]
    async fn rotate_token_route_swaps_the_live_bearer() {
        use tower::ServiceExt;

        let home = tempfile::tempdir().expect("home");
        let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
        let state = test_state(home.path(), addr);
        let host = state.host.clone();
        let (app, _serve_addr) = build_devserver_app(state, host);
        let list = |bearer: &str| {
            HttpRequest::builder()
                .uri("/api/devserver/workspaces")
                .header(header::AUTHORIZATION, format!("Bearer {bearer}"))
                .body(Body::empty())
                .unwrap()
        };
        let rotate = |bearer: &str| {
            HttpRequest::builder()
                .method("POST")
                .uri("/api/devserver/rotate-token")
                .header(header::AUTHORIZATION, format!("Bearer {bearer}"))
                .body(Body::empty())
                .unwrap()
        };

        // A wrong bearer cannot rotate (the rotate route sits behind the
        // same gate it swaps).
        let res = app.clone().oneshot(rotate("wrong")).await.unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

        // Rotate under the current bearer.
        let res = app.clone().oneshot(rotate("test-token")).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let rotated: RotatedToken = serde_json::from_slice(&body).unwrap();
        assert_ne!(rotated.token, "test-token");

        // The old bearer dies on the next request; the new one authorizes.
        let res = app.clone().oneshot(list("test-token")).await.unwrap();
        assert_eq!(
            res.status(),
            StatusCode::UNAUTHORIZED,
            "pre-rotation bearer must stop authorizing immediately"
        );
        let res = app.clone().oneshot(list(&rotated.token)).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn off_without_live_terminals_is_not_blocked() {
        use tower::ServiceExt;

        let home = tempfile::tempdir().expect("home");
        let ws = tempfile::tempdir().expect("workspace");
        std::fs::write(ws.path().join("a.md"), "# A\n").expect("seed");
        let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
        let state = test_state(home.path(), addr);
        let prefix = state.register_workspace(ws.path()).await.expect("mount");
        let host = state.host.clone();
        let (app, _serve_addr) = build_devserver_app(state, host);

        // An unforced off of a workspace with no live terminals clears the
        // confirm-before-off guard (count is 0) and unmounts: 200, not 409. (The
        // 409 path needs a live PTY in the tenant, which the host's
        // `tenant_terminal_session_count` test covers.)
        let off = app
            .oneshot(
                HttpRequest::builder()
                    .method("POST")
                    .uri(format!("/api/devserver/workspaces{prefix}/on"))
                    .header(header::AUTHORIZATION, "Bearer test-token")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"on":false}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(off.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn devserver_root_answers_api_health() {
        use tower::ServiceExt;

        // The `--service` supervisor's watchdog probes `/api/health` on the
        // devserver root with no bearer; it must get 200, not the root
        // fallback's 404, or the supervisor declares a live devserver dead.
        let home = tempfile::tempdir().expect("home");
        let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
        let state = test_state(home.path(), addr);
        let host = state.host.clone();
        let (app, _serve_addr) = build_devserver_app(state, host);

        let resp = app
            .oneshot(
                HttpRequest::builder()
                    .uri("/api/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["status"], "ok");
        assert_eq!(json["instance"], "lib-test");
    }

    #[test]
    fn store_save_load_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let store = DevserverStore::at(dir.path().join("nested").join("config.json"));
        // Missing file loads a default.
        assert_eq!(store.load().devserver_token, "");
        let cfg = PersistedConfig {
            devserver_token: "abc".into(),
            token_minted_at: 42,
            library_id: "lib-xyz".into(),
            port: 9605,
        };
        store
            .save_with_pre_persist_hook(&cfg, |_tmp| {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;

                    let mode = std::fs::metadata(_tmp)?.permissions().mode() & 0o777;
                    assert_eq!(mode, 0o600, "temporary config must be 0600");
                }
                Ok(())
            })
            .unwrap();
        let loaded = store.load();
        assert_eq!(loaded.devserver_token, "abc");
        assert_eq!(loaded.library_id, "lib-xyz");
        assert_eq!(loaded.port, 9605);
        let path = dir.path().join("nested").join("config.json");
        let bytes = std::fs::read(&path).expect("published config");
        serde_json::from_slice::<PersistedConfig>(&bytes).expect("published JSON parses");
        assert_eq!(
            std::fs::read_dir(path.parent().unwrap()).unwrap().count(),
            1,
            "save must leave only the published config"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "config must be 0600");
        }
    }

    #[test]
    fn simultaneous_store_saves_do_not_collide() {
        let dir = tempfile::tempdir().unwrap();
        let store = DevserverStore::at(dir.path().join("config.json"));
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let configs = [
            PersistedConfig {
                devserver_token: "token-a".into(),
                token_minted_at: 11,
                library_id: "lib-test".into(),
                port: 9605,
            },
            PersistedConfig {
                devserver_token: "token-b".into(),
                token_minted_at: 22,
                library_id: "lib-test".into(),
                port: 9605,
            },
        ];

        let results = std::thread::scope(|scope| {
            let first = {
                let barrier = barrier.clone();
                let store = &store;
                let cfg = &configs[0];
                scope.spawn(move || {
                    store.save_with_pre_persist_hook(cfg, |_| {
                        barrier.wait();
                        Ok(())
                    })
                })
            };
            let second = {
                let barrier = barrier.clone();
                let store = &store;
                let cfg = &configs[1];
                scope.spawn(move || {
                    store.save_with_pre_persist_hook(cfg, |_| {
                        barrier.wait();
                        Ok(())
                    })
                })
            };
            [first.join().unwrap(), second.join().unwrap()]
        });

        assert!(
            results.iter().all(Result::is_ok),
            "both saves must publish successfully: {results:?}"
        );
        let published = store.load();
        assert!(
            configs.iter().any(|cfg| {
                cfg.devserver_token == published.devserver_token
                    && cfg.token_minted_at == published.token_minted_at
            }),
            "published config must be one complete submitted snapshot: {published:?}"
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn store_failure_preserves_prior_config_and_removes_temporary_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = DevserverStore::at(dir.path().join("config.json"));
        let prior = PersistedConfig {
            devserver_token: "prior-token".into(),
            token_minted_at: 11,
            library_id: "lib-test".into(),
            port: 9605,
        };
        store.save(&prior).unwrap();
        let replacement = PersistedConfig {
            devserver_token: "replacement-token".into(),
            token_minted_at: 22,
            library_id: "lib-test".into(),
            port: 9606,
        };

        let error = store
            .save_with_pre_persist_hook(&replacement, |_| {
                Err(std::io::Error::other("injected pre-persist failure"))
            })
            .unwrap_err();

        assert_eq!(error.kind(), std::io::ErrorKind::Other);
        let published = store.load();
        assert_eq!(published.devserver_token, prior.devserver_token);
        assert_eq!(published.token_minted_at, prior.token_minted_at);
        assert_eq!(published.port, prior.port);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    /// Build a `DevserverState` over a sandbox dir for the on/off
    /// state-machine tests: a fresh `Library`, an empty host, and a devserver
    /// store under `home`.
    fn test_state(home: &Path, addr: SocketAddr) -> Arc<DevserverState> {
        let lib = Library::open_at(home.join("config.toml")).expect("library");
        let host = Arc::new(WorkspaceHost::new(lib, crate::route_builder()));
        // Install the workspace overlay so persist_state has somewhere to write
        // the on/off rows (run_devserver installs it beside the window registry).
        host.install_workspace_overlay(Arc::new(WorkspaceOverlay::open(
            home.join("devserver").join("workspaces.json"),
        )));
        Arc::new(DevserverState {
            host,
            addr,
            token: Arc::new(std::sync::RwLock::new("test-token".to_string())),
            token_minted_at: AtomicU64::new(0),
            library_id: "lib-test".into(),
            host_label: "test".into(),
            workspaces: Mutex::new(HashMap::new()),
            mount_attempt_lock: tokio::sync::Mutex::new(()),
            startup: Arc::new(StartupCoordinator::new()),
            store: DevserverStore::at(home.join("devserver").join("config.json")),
            persist_serial: Mutex::new(()),
            bound_port: AtomicU16::new(0),
        })
    }

    fn test_tunnel_assertion() -> TunnelAssertion {
        let token = "chan_pat_test";
        TunnelAssertion {
            key: chan_tunnel_proto::gateway_assertion::derive_assertion_key(token),
            devserver_id: chan_tunnel_proto::gateway_assertion::devserver_id_from_token(token),
        }
    }

    fn test_gateway_assertion(assertion: &TunnelAssertion, aud: &str, role: &str) -> String {
        let owner = "11111111-1111-4111-8111-111111111111";
        let subject = if role == "owner" {
            owner
        } else {
            "22222222-2222-4222-8222-222222222222"
        };
        let claims = chan_tunnel_proto::gateway_assertion::claims(
            subject,
            owner,
            aud,
            &assertion.devserver_id,
        );
        chan_tunnel_proto::gateway_assertion::sign(&assertion.key, &claims).unwrap()
    }

    fn test_tunnel_registration() -> chan_tunnel_client::Registration {
        chan_tunnel_client::Registration {
            prefix: "/devserver".into(),
            user: "owner".into(),
            workspace: test_tunnel_assertion().devserver_id,
            owner_user_id: "11111111-1111-4111-8111-111111111111".into(),
        }
    }

    #[cfg(unix)]
    fn hold_foreign_lock(lib: &Library, root: &Path) -> chan_workspace::lock::WorkspaceLock {
        let paths = lib.workspace_paths_for(root).expect("workspace paths");
        let lock = chan_workspace::lock::WorkspaceLock::acquire(&paths.lock, root).expect("lock");
        let record = chan_workspace::lock::LockRecord {
            pid: 1,
            path: root
                .canonicalize()
                .unwrap_or_else(|_| root.to_path_buf())
                .to_string_lossy()
                .into_owned(),
            started_at: "2000-01-01T00:00:00Z".to_string(),
        };
        std::fs::write(
            paths.lock.join("writer.lock"),
            serde_json::to_vec(&record).expect("record json"),
        )
        .expect("write foreign lock record");
        lock
    }

    #[tokio::test]
    async fn shared_terminal_tenant_makes_terminal_windows_resolve() {
        // The real devserver open path: mount the shared terminal tenant, then
        // run the library's first-open rule (what `run_devserver` does at
        // startup). The minted terminal window must resolve to the shared
        // tenant's prefix + a real token, so the desktop watcher's should_show
        // (non-empty token) shows it rather than hiding it on every reconnect.
        let home = tempfile::tempdir().expect("home");
        let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
        let state = test_state(home.path(), addr);
        state.host.install_window_registry(
            Arc::new(WindowRegistry::open(home.path().join("windows.json"))),
            "lib-test".into(),
        );

        // Mount the shared terminal tenant (the same mount run_devserver does
        // before provisioning the first-open terminal), then provision it.
        state
            .mount_shared_terminal_tenant()
            .await
            .expect("mount shared terminal tenant");
        let term = state
            .host
            .ensure_first_open_terminal()
            .expect("first open")
            .expect("fresh devserver mints exactly one terminal");

        let records = state.host.assemble_window_records();
        assert_eq!(records.len(), 1, "exactly one window after first open");
        let after = records
            .into_iter()
            .find(|r| r.window_id == term.window_id)
            .expect("terminal row");
        assert_eq!(
            after.kind,
            chan_library::windows::WindowKind::Terminal,
            "first-open window is a terminal",
        );
        assert_eq!(
            after.prefix, DEVSERVER_SHARED_TERMINAL_PREFIX,
            "terminal window resolves to the shared tenant prefix",
        );
        assert!(
            !after.token.is_empty(),
            "terminal window resolves to a real token so should_show shows it",
        );

        // The marker is now set: a second open (a restart whose terminal was
        // never closed) mints nothing extra.
        assert!(state
            .host
            .ensure_first_open_terminal()
            .expect("re-open")
            .is_none());
        assert_eq!(
            state.host.assemble_window_records().len(),
            1,
            "no re-mint on a second open",
        );
    }

    #[tokio::test]
    async fn tunnel_origin_requires_a_valid_gateway_assertion() {
        use tower::ServiceExt;

        let home = tempfile::tempdir().expect("home");
        let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
        let state = test_state(home.path(), addr);
        state
            .mount_shared_terminal_tenant()
            .await
            .expect("mount shared terminal tenant");
        let host = state.host.clone();
        let (app, _serve_addr) = build_devserver_app(state, host);
        let tunnel = app.clone().layer(middleware::from_fn_with_state(
            test_tunnel_assertion(),
            mark_tunnel_origin,
        ));
        let tunnel = tunnel.layer(axum::Extension(test_tunnel_registration()));

        let req = || {
            HttpRequest::builder()
                .uri("/api/terminal/api/session?w=w-test")
                .body(Body::empty())
                .unwrap()
        };
        let asserted_req = || {
            HttpRequest::builder()
                .uri("/api/terminal/api/session?w=w-test")
                .header("x-forwarded-host", "owner.dev")
                .header(
                    chan_tunnel_proto::gateway_assertion::HEADER_NAME,
                    test_gateway_assertion(&test_tunnel_assertion(), "owner.dev", "owner"),
                )
                .body(Body::empty())
                .unwrap()
        };

        let local = app.clone().oneshot(req()).await.unwrap();
        assert_eq!(local.status(), StatusCode::UNAUTHORIZED);

        let missing = tunnel.clone().oneshot(req()).await.unwrap();
        assert_eq!(missing.status(), StatusCode::UNAUTHORIZED);

        let invalid = tunnel
            .clone()
            .oneshot(
                HttpRequest::builder()
                    .uri("/api/terminal/api/session?w=w-test")
                    .header("x-forwarded-host", "owner.dev")
                    .header(chan_tunnel_proto::gateway_assertion::HEADER_NAME, "invalid")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(invalid.status(), StatusCode::UNAUTHORIZED);

        let asserted = tunnel.oneshot(asserted_req()).await.unwrap();
        assert_eq!(asserted.status(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn workspace_on_off_toggle_round_trip() {
        let _env = chan_home_env_read();
        let home = tempfile::tempdir().expect("home");
        let ws = tempfile::tempdir().expect("workspace");
        std::fs::write(ws.path().join("a.md"), "# A\n").expect("seed");
        let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
        let state = test_state(home.path(), addr);

        // Mount it on: one listed row, on, carrying a token.
        let prefix = state.register_workspace(ws.path()).await.expect("mount");
        let entries = state.workspace_entries();
        assert_eq!(entries.len(), 1);
        assert!(entries[0].on);
        assert!(!entries[0].token.is_empty(), "on row carries a token");
        let token_on = entries[0].token.clone();

        // Toggle off: unmounted in the host, still registered, empty token,
        // SAME prefix.
        let row = state
            .set_workspace_on(&prefix, false, false)
            .await
            .map(updated_row)
            .expect("toggle off");
        assert!(!row.on);
        assert!(row.token.is_empty(), "off row drops its token");
        assert_eq!(row.prefix, prefix, "prefix stays stable across off");
        assert_eq!(state.workspace_entries().len(), 1, "off row still listed");
        assert!(
            state.host.mounted_prefixes().unwrap().is_empty(),
            "off workspace is unmounted in the host"
        );

        // Idempotent off.
        let row = state
            .set_workspace_on(&prefix, false, false)
            .await
            .map(updated_row)
            .unwrap();
        assert!(!row.on);

        // Toggle on: remounted at the SAME prefix. chan's per-workspace token
        // is persisted, so the on row carries that SAME stable token (the off
        // row merely hid it on the wire). The client rebuilds the tenant URL
        // from whatever the on row carries -- a stable token keeps the URL
        // bookmarkable across off→on, which is the behavior we want.
        let row = state
            .set_workspace_on(&prefix, true, false)
            .await
            .map(updated_row)
            .expect("toggle on");
        assert!(row.on);
        assert_eq!(row.prefix, prefix);
        assert!(!row.token.is_empty(), "on row carries the workspace token");
        assert_eq!(
            row.token, token_on,
            "per-workspace token is stable across off→on (persisted, not per-mount)"
        );
        assert_eq!(state.host.mounted_prefixes().unwrap(), vec![prefix.clone()]);

        // An unknown prefix is a 404 (None), not an error.
        assert!(updated_none(
            state
                .set_workspace_on("/api/nope-0", true, false)
                .await
                .expect("no error")
        ));
    }

    #[tokio::test]
    async fn lists_full_host_library_and_toggles_unserved_workspaces_on() {
        // GET /workspaces lists ONE row per HOST-LIBRARY workspace (what
        // `chan list` shows), not just the devserver's served subset -- so a
        // fresh devserver is not empty. An unserved library workspace is off at
        // its stable prefix; `{prefix}/on` mounts it even though it was never
        // registered on the devserver.
        let home = tempfile::tempdir().expect("home");
        let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
        let state = test_state(home.path(), addr);

        // Two workspaces registered in the HOST LIBRARY directly (as `chan add`
        // would), with NEITHER mounted on the devserver.
        let ws_a = tempfile::tempdir().expect("a");
        let ws_b = tempfile::tempdir().expect("b");
        std::fs::write(ws_a.path().join("a.md"), "# A\n").unwrap();
        std::fs::write(ws_b.path().join("b.md"), "# B\n").unwrap();
        state
            .host
            .library()
            .register_workspace(ws_a.path())
            .unwrap();
        state
            .host
            .library()
            .register_workspace(ws_b.path())
            .unwrap();

        // The devserver surfaces BOTH -- the full library -- off, no token.
        let entries = state.workspace_entries();
        assert_eq!(
            entries.len(),
            2,
            "lists the full host library, not the served subset"
        );
        assert!(
            entries.iter().all(|e| !e.on),
            "unserved library workspaces are off"
        );
        assert!(
            entries.iter().all(|e| e.token.is_empty()),
            "off rows carry no token"
        );
        assert!(
            state.host.mounted_prefixes().unwrap().is_empty(),
            "nothing mounted yet"
        );

        // Toggle A on by its stable prefix -- never registered on the devserver,
        // yet this mounts it; every library workspace is toggleable.
        let prefix_a = allocate_workspace_prefix(ws_a.path()).expect("prefix");
        let row = state
            .set_workspace_on(&prefix_a, true, false)
            .await
            .map(updated_row)
            .expect("toggle on");
        assert!(row.on);
        assert_eq!(row.prefix, prefix_a);
        assert!(!row.token.is_empty(), "an on row carries a token");

        // Still two rows; exactly A is on.
        let entries = state.workspace_entries();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries.iter().filter(|e| e.on).count(), 1);
        assert!(entries.iter().find(|e| e.prefix == prefix_a).unwrap().on);

        // An unknown prefix (no library workspace, no serving record) is a 404.
        assert!(updated_none(
            state
                .set_workspace_on("/api/ghost-0", true, false)
                .await
                .expect("no error")
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn workspace_entries_report_foreign_locked_library_rows() {
        let home = tempfile::tempdir().expect("home");
        let ws = tempfile::tempdir().expect("workspace");
        let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
        let state = test_state(home.path(), addr);
        state.host.library().register_workspace(ws.path()).unwrap();
        let _foreign = hold_foreign_lock(state.host.library(), ws.path());

        let row = state
            .workspace_entries()
            .into_iter()
            .find(|row| row.path == ws.path().canonicalize().unwrap().to_string_lossy())
            .expect("workspace row");
        assert!(!row.on);
        assert_eq!(row.status, WorkspaceStatus::Locked);
        assert!(row.token.is_empty());
    }

    #[tokio::test]
    async fn forget_is_destructive_and_removes_from_the_host_library() {
        // Devserver Forget is destructive: it is `chan workspace rm`
        // (unmount-if-on + unregister from the host library
        // + bin the trash). The host library is the single registry, so the
        // workspace then disappears from the listing too. (`set_workspace_on
        // {on:false}` is the reversible unmount; this is the removal.)
        let home = tempfile::tempdir().expect("home");
        let ws = tempfile::tempdir().expect("workspace");
        std::fs::write(ws.path().join("a.md"), "# A\n").unwrap();
        let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
        let state = test_state(home.path(), addr);

        let prefix = state.register_workspace(ws.path()).await.expect("mount");
        assert_eq!(state.workspace_entries().len(), 1);

        assert!(state
            .forget_workspace(&prefix, false)
            .await
            .expect("forget")
            .completed());
        assert!(
            state.host.mounted_prefixes().unwrap().is_empty(),
            "forget unmounts the workspace in the host"
        );
        // Destructive: unregistered from the host library, so gone from the
        // listing -- one registry, one removal.
        assert!(
            state.workspace_entries().is_empty(),
            "forgotten workspace is removed from the library listing"
        );
        assert!(
            state.host.library().list_workspaces().is_empty(),
            "forgotten workspace is unregistered from the host library"
        );

        // Idempotent: forgetting an unknown / already-removed prefix is false.
        assert!(state
            .forget_workspace(&prefix, false)
            .await
            .expect("already removed")
            .not_found());
    }

    #[tokio::test]
    async fn off_state_persists_to_overlay() {
        let home = tempfile::tempdir().expect("home");
        let ws = tempfile::tempdir().expect("workspace");
        let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
        let state = test_state(home.path(), addr);

        let prefix = state.register_workspace(ws.path()).await.expect("mount");
        state
            .set_workspace_on(&prefix, false, false)
            .await
            .map(updated_row)
            .unwrap();

        // The library-owned overlay records the workspace registered-but-off (by
        // path, the prefix re-derived at restore). On restart, `run_devserver`
        // reads the overlay and `track_off`s this row rather than re-mounting.
        let rows = state
            .host
            .workspace_overlay()
            .expect("overlay installed")
            .entries();
        assert_eq!(rows.len(), 1);
        // The host canonicalizes the registered root, so compare against the
        // canonical path.
        let canonical = ws.path().canonicalize().expect("canonicalize workspace");
        assert_eq!(rows[0].path, canonical.to_string_lossy());
        assert!(!rows[0].desired_on);
    }

    #[test]
    fn persist_state_samples_mounted_prefixes_under_workspace_lock() {
        let home = tempfile::tempdir().expect("home");
        let state = test_state(home.path(), "127.0.0.1:0".parse().unwrap());

        state.persist_state_with_mounted_snapshot(|| {
            assert!(
                state.persist_serial.try_lock().is_err(),
                "persist serialization must precede snapshot capture"
            );
            assert!(
                state.workspaces.try_lock().is_err(),
                "mounted-prefix sampling ran without the serving map locked"
            );
            HashSet::new()
        });
    }

    #[test]
    fn ordered_token_rotations_persist_the_newest_complete_pair() {
        let home = tempfile::tempdir().expect("home");
        let state = test_state(home.path(), "127.0.0.1:0".parse().unwrap());
        let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(0);
        let (release_tx, release_rx) = std::sync::mpsc::sync_channel(0);
        let (second_started_tx, second_started_rx) = std::sync::mpsc::sync_channel(0);

        std::thread::scope(|scope| {
            let first_state = state.clone();
            let first = scope.spawn(move || {
                first_state.rotate_token_with_pre_mint_hook("older-token".into(), 11, || {
                    entered_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                })
            });
            entered_rx.recv().unwrap();

            let second_state = state.clone();
            let second = scope.spawn(move || {
                second_started_tx.send(()).unwrap();
                second_state.rotate_token_with_pre_mint_hook("newest-token".into(), 22, || {})
            });
            second_started_rx.recv().unwrap();
            release_tx.send(()).unwrap();

            assert_eq!(first.join().unwrap(), "older-token");
            assert_eq!(second.join().unwrap(), "newest-token");
        });

        let published = state.store.load();
        assert_eq!(published.devserver_token, "newest-token");
        assert_eq!(published.token_minted_at, 22);
    }

    #[test]
    fn unrelated_persist_cannot_publish_token_before_matching_mint_time() {
        let home = tempfile::tempdir().expect("home");
        let state = test_state(home.path(), "127.0.0.1:0".parse().unwrap());
        state.token_minted_at.store(7, Ordering::Relaxed);
        state.persist_state();

        let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(0);
        let (release_tx, release_rx) = std::sync::mpsc::sync_channel(0);
        let (persist_started_tx, persist_started_rx) = std::sync::mpsc::sync_channel(0);
        let (persist_done_tx, persist_done_rx) = std::sync::mpsc::channel();

        std::thread::scope(|scope| {
            let rotate_state = state.clone();
            let rotate = scope.spawn(move || {
                rotate_state.rotate_token_with_pre_mint_hook("rotated-token".into(), 99, || {
                    entered_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                })
            });
            entered_rx.recv().unwrap();

            let persist_state = state.clone();
            let persist = scope.spawn(move || {
                persist_started_tx.send(()).unwrap();
                persist_state.persist_state();
                persist_done_tx.send(()).unwrap();
            });
            persist_started_rx.recv().unwrap();
            assert!(
                matches!(
                    persist_done_rx.recv_timeout(Duration::from_millis(100)),
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout)
                ),
                "unrelated persistence completed inside a token rotation"
            );
            let before_release = state.store.load();
            assert_eq!(before_release.devserver_token, "test-token");
            assert_eq!(before_release.token_minted_at, 7);

            release_tx.send(()).unwrap();
            assert_eq!(rotate.join().unwrap(), "rotated-token");
            persist.join().unwrap();
            persist_done_rx.recv().unwrap();
        });

        let published = state.store.load();
        assert_eq!(published.devserver_token, "rotated-token");
        assert_eq!(published.token_minted_at, 99);
    }

    #[tokio::test]
    async fn host_remove_is_not_resurrected_by_a_later_persist() {
        // `chan close --remove` routes through the HOST (remove_workspace_for_root),
        // which the devserver in-memory map never sees. A later persist_state (here,
        // a new registration) must NOT re-grow the removed workspace into the
        // overlay from that stale map -- persist reconciles against the library.
        let home = tempfile::tempdir().expect("home");
        let ws_a = tempfile::tempdir().expect("ws a");
        let ws_b = tempfile::tempdir().expect("ws b");
        let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
        let state = test_state(home.path(), addr);

        state
            .register_workspace(ws_a.path())
            .await
            .expect("mount a");
        state
            .register_workspace(ws_b.path())
            .await
            .expect("mount b");

        // Remove A the over-the-control-socket way (host-level), bypassing the map.
        assert!(state
            .host
            .remove_workspace_for_root(ws_a.path(), false)
            .await
            .expect("remove a")
            .completed());

        // A guaranteed persist_state.
        let ws_c = tempfile::tempdir().expect("ws c");
        state
            .register_workspace(ws_c.path())
            .await
            .expect("mount c");

        let canon = |d: &tempfile::TempDir| {
            d.path()
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .into_owned()
        };
        let paths: Vec<String> = state
            .host
            .workspace_overlay()
            .expect("overlay")
            .entries()
            .into_iter()
            .map(|r| r.path)
            .collect();
        assert!(
            !paths.contains(&canon(&ws_a)),
            "removed A must not be re-persisted: {paths:?}"
        );
        assert!(paths.contains(&canon(&ws_b)), "B persists: {paths:?}");
        assert!(paths.contains(&canon(&ws_c)), "C persists: {paths:?}");
    }

    #[tokio::test]
    async fn host_close_persists_off_through_a_later_persist() {
        // A plain `chan close` (host-level close_workspace_for_root) records the
        // workspace OFF, and a later persist_state must keep it off (derive `on`
        // from what is mounted) rather than flip it back on from the stale map --
        // else a restart re-mounts a just-closed workspace.
        let home = tempfile::tempdir().expect("home");
        let ws_a = tempfile::tempdir().expect("ws a");
        let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
        let state = test_state(home.path(), addr);

        state
            .register_workspace(ws_a.path())
            .await
            .expect("mount a");
        assert!(state
            .host
            .close_workspace_for_root(ws_a.path(), false)
            .await
            .expect("close a")
            .completed());

        // A later persist (a new registration).
        let ws_b = tempfile::tempdir().expect("ws b");
        state
            .register_workspace(ws_b.path())
            .await
            .expect("mount b");

        let canon = ws_a
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let rows = state.host.workspace_overlay().expect("overlay").entries();
        let a = rows
            .iter()
            .find(|r| r.path == canon)
            .expect("A is still registered (off)");
        assert!(
            !a.desired_on,
            "closed A stays off across a later persist_state"
        );
    }

    #[tokio::test]
    async fn host_close_reports_off_empty_token_immediately() {
        // `chan close` reaches the host directly, bypassing DevserverState's
        // workspace map. The management list must still report the real state
        // immediately, not the stale record's old `on` flag and tenant token.
        let home = tempfile::tempdir().expect("home");
        let ws = tempfile::tempdir().expect("workspace");
        let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
        let state = test_state(home.path(), addr);

        let prefix = state.register_workspace(ws.path()).await.expect("mount");
        let before = state
            .workspace_entries()
            .into_iter()
            .find(|row| row.prefix == prefix)
            .expect("row before close");
        assert!(before.on);
        assert_eq!(before.status, WorkspaceStatus::Running);
        assert!(!before.token.is_empty());

        assert!(state
            .host
            .close_workspace_for_root(ws.path(), false)
            .await
            .expect("close")
            .completed());

        let after = state
            .workspace_entries()
            .into_iter()
            .find(|row| row.prefix == prefix)
            .expect("row after close");
        assert!(!after.on);
        assert_eq!(after.status, WorkspaceStatus::Stopped);
        assert_eq!(after.token, "");
    }

    #[tokio::test]
    async fn host_remove_drops_row_from_listing_immediately() {
        // `chan close --remove` reaches the host directly too. The host removes
        // the library row and unmounts the tenant, while DevserverState still
        // has its old map record. The management list must not surface that
        // stale record after removal.
        let home = tempfile::tempdir().expect("home");
        let ws = tempfile::tempdir().expect("workspace");
        let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
        let state = test_state(home.path(), addr);

        let prefix = state.register_workspace(ws.path()).await.expect("mount");
        assert!(state
            .workspace_entries()
            .iter()
            .any(|row| row.prefix == prefix));

        assert!(state
            .host
            .remove_workspace_for_root(ws.path(), false)
            .await
            .expect("remove")
            .completed());

        assert!(
            state
                .workspace_entries()
                .iter()
                .all(|row| row.prefix != prefix),
            "removed workspace must disappear from the management listing"
        );
        assert!(
            state.host.library().list_workspaces().is_empty(),
            "removed workspace is unregistered from the host library"
        );
    }

    #[tokio::test]
    async fn stale_closed_record_can_be_turned_on_again() {
        // A stale map record with `on:true` but no live host tenant used to make
        // `set_workspace_on(..., true)` a no-op. The toggle must use the host's
        // real mount state so a stale-off row remounts cleanly.
        let _env = chan_home_env_read();
        let home = tempfile::tempdir().expect("home");
        let ws = tempfile::tempdir().expect("workspace");
        let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
        let state = test_state(home.path(), addr);

        let prefix = state.register_workspace(ws.path()).await.expect("mount");
        assert!(state
            .host
            .close_workspace_for_root(ws.path(), false)
            .await
            .expect("close")
            .completed());

        let stale = state
            .workspace_entries()
            .into_iter()
            .find(|row| row.prefix == prefix)
            .expect("stale row");
        assert!(!stale.on);
        assert_eq!(stale.status, WorkspaceStatus::Stopped);
        assert_eq!(stale.token, "");

        let remounted = state
            .set_workspace_on(&prefix, true, false)
            .await
            .map(updated_row)
            .expect("remount");
        assert!(remounted.on);
        assert_eq!(remounted.status, WorkspaceStatus::Running);
        assert!(!remounted.token.is_empty());
    }

    #[tokio::test]
    async fn library_windows_feed_lists_mints_and_discards() {
        use axum::body::to_bytes;
        use tower::ServiceExt;

        let home = tempfile::tempdir().expect("home");
        let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
        let state = test_state(home.path(), addr);
        // The real devserver installs a window registry in run_devserver; do the
        // same here so mint/discard have a store.
        state.host.install_window_registry(
            Arc::new(chan_library::windows::WindowRegistry::open(
                home.path().join("windows.json"),
            )),
            "local".to_string(),
        );
        let host = state.host.clone();
        let (app, _serve_addr) = build_devserver_app(state, host);

        // The raw/local devserver bind gates the launcher API with the persisted
        // devserver token.
        let unauth = app
            .clone()
            .oneshot(
                HttpRequest::builder()
                    .uri("/api/library/windows")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unauth.status(), StatusCode::UNAUTHORIZED);

        let listed = app
            .clone()
            .oneshot(
                HttpRequest::builder()
                    .uri("/api/library/windows")
                    .header(header::AUTHORIZATION, "Bearer test-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(listed.status(), StatusCode::OK);

        // The watch route is registered (no conflict with the discard route): a
        // plain GET is a 4xx upgrade error, not a 404.
        let watch = app
            .clone()
            .oneshot(
                HttpRequest::builder()
                    .uri("/api/library/windows/watch?t=test-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_ne!(watch.status(), StatusCode::NOT_FOUND);

        // Mint a terminal window: 200 with the assembled record (a w- id, stamped
        // with the library id).
        let minted = app
            .clone()
            .oneshot(
                HttpRequest::builder()
                    .method("POST")
                    .uri("/api/library/windows")
                    .header(header::AUTHORIZATION, "Bearer test-token")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"kind":"terminal"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(minted.status(), StatusCode::OK);
        let body = to_bytes(minted.into_body(), 64 * 1024).await.unwrap();
        let record: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let window_id = record["window_id"].as_str().unwrap().to_string();
        assert!(window_id.starts_with("w-"));
        assert_eq!(record["kind"], "terminal");
        assert_eq!(record["library_id"], "local");

        // Discard it: 204; an unknown id is 404.
        let discarded = app
            .clone()
            .oneshot(
                HttpRequest::builder()
                    .method("DELETE")
                    .uri(format!("/api/library/windows/{window_id}"))
                    .header(header::AUTHORIZATION, "Bearer test-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(discarded.status(), StatusCode::NO_CONTENT);
        let missing = app
            .oneshot(
                HttpRequest::builder()
                    .method("DELETE")
                    .uri("/api/library/windows/w-nope")
                    .header(header::AUTHORIZATION, "Bearer test-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn library_workspaces_lists_registered_with_on_state() {
        use axum::body::to_bytes;
        use tower::ServiceExt;

        let home = tempfile::tempdir().expect("home");
        let ws = tempfile::tempdir().expect("workspace");
        let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
        let state = test_state(home.path(), addr);
        // Register + mount one workspace so it lists as on.
        let prefix = state.register_workspace(ws.path()).await.expect("mount");
        let host = state.host.clone();
        let (app, _serve_addr) = build_devserver_app(state, host);

        let unauth = app
            .clone()
            .oneshot(
                HttpRequest::builder()
                    .uri("/api/library/workspaces")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unauth.status(), StatusCode::UNAUTHORIZED);

        let resp = app
            .oneshot(
                HttpRequest::builder()
                    .uri("/api/library/workspaces")
                    .header(header::AUTHORIZATION, "Bearer test-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = to_bytes(resp.into_body(), 64 * 1024).await.unwrap();
        let rows: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let rows = rows.as_array().expect("array of workspaces");
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        // workspace_id is the route prefix without its leading slash.
        assert_eq!(row["workspace_id"], prefix.trim_start_matches('/'));
        assert_eq!(row["on"], true);
        // Path is the canonical workspace root; label is its basename.
        let basename = ws.path().file_name().unwrap().to_str().unwrap();
        assert!(row["path"].as_str().unwrap().ends_with(basename));
        assert!(!row["label"].as_str().unwrap().is_empty());
    }

    /// The `on` state of a workspace `id` from the launcher list, or `None` when
    /// no row matches (forgotten).
    async fn launcher_workspace_on(app: &axum::Router, id: &str) -> Option<bool> {
        use axum::body::to_bytes;
        use tower::ServiceExt;
        let resp = app
            .clone()
            .oneshot(
                HttpRequest::builder()
                    .uri("/api/library/workspaces")
                    .header(header::AUTHORIZATION, "Bearer test-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = to_bytes(resp.into_body(), 64 * 1024).await.unwrap();
        let rows: serde_json::Value = serde_json::from_slice(&body).unwrap();
        rows.as_array()
            .unwrap()
            .iter()
            .find(|r| r["workspace_id"] == id)
            .map(|r| r["on"].as_bool().unwrap())
    }

    #[tokio::test]
    async fn library_workspaces_crud_is_loopback_only() {
        use axum::body::to_bytes;
        use std::sync::OnceLock;
        use tower::ServiceExt;

        let home = tempfile::tempdir().expect("home");
        let ws = tempfile::tempdir().expect("workspace");
        let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
        let state = test_state(home.path(), addr);
        let host = state.host.clone();

        // Read-only surface (serve_addr = None): a mutating call is refused 403,
        // so a grantee can never escalate to mutation.
        let readonly = crate::routes::launcher_router(host.clone(), None, None);
        let refused = readonly
            .oneshot(
                HttpRequest::builder()
                    .method("POST")
                    .uri("/api/library/workspaces/anything/off")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(refused.status(), StatusCode::FORBIDDEN);

        // Loopback surface: serve_addr filled post-bind enables the full CRUD.
        let cell = Arc::new(OnceLock::new());
        cell.set(addr).unwrap();
        let app = crate::routes::launcher_router(host.clone(), None, Some(cell));

        // add: register + mount the folder; 200 with the new row (on).
        let body = format!(r#"{{"path":{:?}}}"#, ws.path().to_string_lossy());
        let added = app
            .clone()
            .oneshot(
                HttpRequest::builder()
                    .method("POST")
                    .uri("/api/library/workspaces")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(added.status(), StatusCode::OK);
        let bytes = to_bytes(added.into_body(), 64 * 1024).await.unwrap();
        let row: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let id = row["workspace_id"].as_str().unwrap().to_string();
        assert_eq!(row["on"], true);
        assert_eq!(launcher_workspace_on(&app, &id).await, Some(true));

        // off: unmount, keep the registration (still listed, now off).
        let off = app
            .clone()
            .oneshot(
                HttpRequest::builder()
                    .method("POST")
                    .uri(format!("/api/library/workspaces/{id}/off"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(off.status(), StatusCode::NO_CONTENT);
        assert_eq!(launcher_workspace_on(&app, &id).await, Some(false));

        // on: remount at the same stable id.
        let on = app
            .clone()
            .oneshot(
                HttpRequest::builder()
                    .method("POST")
                    .uri(format!("/api/library/workspaces/{id}/on"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(on.status(), StatusCode::NO_CONTENT);
        assert_eq!(launcher_workspace_on(&app, &id).await, Some(true));

        // rm: unregister; the workspace disappears from the list.
        let removed = app
            .clone()
            .oneshot(
                HttpRequest::builder()
                    .method("DELETE")
                    .uri(format!("/api/library/workspaces/{id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(removed.status(), StatusCode::NO_CONTENT);
        assert_eq!(launcher_workspace_on(&app, &id).await, None);
    }

    #[tokio::test]
    async fn devserver_local_bind_is_mutable_but_the_tunnel_is_readonly() {
        use axum::body::to_bytes;
        use tower::ServiceExt;

        let home = tempfile::tempdir().expect("home");
        let ws = tempfile::tempdir().expect("workspace");
        let owner_ws = tempfile::tempdir().expect("owner workspace");
        let non_owner_ws = tempfile::tempdir().expect("non-owner workspace");
        let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
        let state = test_state(home.path(), addr);
        let host = state.host.clone();
        let (app, serve_addr) = build_devserver_app(state, host);
        // Simulate the post-bind fill so the loopback surface is fully mutable.
        serve_addr.set(addr).unwrap();
        // The tunnel clone marks every request tunnel-origin, exactly like the
        // serve loop; this also exercises that the marker survives the host's
        // root-fallback dispatch to require_local_mutation.
        let assertion = test_tunnel_assertion();
        let tunnel = app.clone().layer(middleware::from_fn_with_state(
            assertion.clone(),
            mark_tunnel_origin,
        ));
        let tunnel = tunnel.layer(axum::Extension(test_tunnel_registration()));

        let add_req = |auth: bool| {
            let body = format!(r#"{{"path":{:?}}}"#, ws.path().to_string_lossy());
            let mut req = HttpRequest::builder()
                .method("POST")
                .uri("/api/library/workspaces")
                .header(header::CONTENT_TYPE, "application/json");
            if auth {
                req = req.header(header::AUTHORIZATION, "Bearer test-token");
            }
            req.body(Body::from(body)).unwrap()
        };
        let owner_add_req = || {
            let body = format!(r#"{{"path":{:?}}}"#, owner_ws.path().to_string_lossy());
            HttpRequest::builder()
                .method("POST")
                .uri("/api/library/workspaces")
                .header(header::CONTENT_TYPE, "application/json")
                .header("x-forwarded-host", "owner.dev")
                .header(
                    chan_tunnel_proto::gateway_assertion::HEADER_NAME,
                    test_gateway_assertion(&assertion, "owner.dev", "owner"),
                )
                .body(Body::from(body))
                .unwrap()
        };
        let non_owner_add_req = || {
            let body = format!(r#"{{"path":{:?}}}"#, non_owner_ws.path().to_string_lossy());
            HttpRequest::builder()
                .method("POST")
                .uri("/api/library/workspaces")
                .header(header::CONTENT_TYPE, "application/json")
                .header("x-forwarded-host", "owner.dev")
                .header(
                    chan_tunnel_proto::gateway_assertion::HEADER_NAME,
                    test_gateway_assertion(&assertion, "owner.dev", "editor"),
                )
                .body(Body::from(body))
                .unwrap()
        };

        // A tunnel request without the bound gateway assertion is rejected
        // before route authorization. The explicit non-owner case below pins
        // the separate 403 policy boundary.
        let refused = tunnel.clone().oneshot(add_req(false)).await.unwrap();
        assert_eq!(refused.status(), StatusCode::UNAUTHORIZED);

        // A valid non-owner gateway assertion may read the launcher but still
        // cannot mutate `/api/library/*`.
        let non_owner_refused = tunnel.clone().oneshot(non_owner_add_req()).await.unwrap();
        assert_eq!(non_owner_refused.status(), StatusCode::FORBIDDEN);

        // The gateway owner assertion unlocks the full launcher over the tunnel.
        let owner_added = tunnel.clone().oneshot(owner_add_req()).await.unwrap();
        assert_eq!(owner_added.status(), StatusCode::OK);

        let unauth = app.clone().oneshot(add_req(false)).await.unwrap();
        assert_eq!(unauth.status(), StatusCode::UNAUTHORIZED);

        // The SAME add on the local bind is NOT blocked: it registers the folder.
        let added = app.clone().oneshot(add_req(true)).await.unwrap();
        assert_eq!(added.status(), StatusCode::OK);

        // Meta: when the launcher bundle is built, the local bind advertises the
        // mutable `devserver` surface and the tunnel the `readonly` one from the
        // SAME app. Tolerate an unbuilt bundle (no meta) so a bare cargo test
        // without `make web` still passes; pre-push builds it and verifies both.
        let get_root = || HttpRequest::builder().uri("/").body(Body::empty()).unwrap();
        let get_readonly_root = || {
            HttpRequest::builder()
                .uri("/")
                .header("x-forwarded-host", "owner.dev")
                .header(
                    chan_tunnel_proto::gateway_assertion::HEADER_NAME,
                    test_gateway_assertion(&assertion, "owner.dev", "guest"),
                )
                .body(Body::empty())
                .unwrap()
        };
        let get_owner_root = || {
            HttpRequest::builder()
                .uri("/")
                .header("x-forwarded-host", "owner.dev")
                .header(
                    chan_tunnel_proto::gateway_assertion::HEADER_NAME,
                    test_gateway_assertion(&assertion, "owner.dev", "owner"),
                )
                .body(Body::empty())
                .unwrap()
        };
        let body_of = |resp: Response| async move {
            let bytes = to_bytes(resp.into_body(), 1 << 20).await.unwrap();
            String::from_utf8_lossy(&bytes).into_owned()
        };
        let local_body = body_of(app.oneshot(get_root()).await.unwrap()).await;
        let tunnel_body = body_of(tunnel.clone().oneshot(get_readonly_root()).await.unwrap()).await;
        let owner_tunnel_body = body_of(tunnel.oneshot(get_owner_root()).await.unwrap()).await;
        if local_body.contains("chan-launcher-surface") {
            assert!(
                local_body.contains(r#"content="devserver""#),
                "local bind should advertise the devserver surface"
            );
            assert!(
                tunnel_body.contains(r#"content="readonly""#),
                "the tunnel should advertise the readonly surface"
            );
            assert!(
                owner_tunnel_body.contains(r#"content="devserver""#),
                "the owner tunnel should advertise the full devserver surface"
            );
        }
    }

    // The session-role seam WP18 keys on: a request entering the tunnel clone
    // carries `TunnelOrigin` (a Follower origin, `local == false`), while a
    // loopback request never does (a Leader origin, `local == true`).
    // `ws_upgrade` reads the same `Option<Extension<TunnelOrigin>>` extractor and
    // computes `let local = origin.is_none();`. A full `/ws` upgrade over a live
    // tunnel is a host-smoke item; this pins the marker->local mapping the role
    // derivation depends on at the route level, headless.
    #[tokio::test]
    async fn tunnel_origin_marks_ws_remote_loopback_local() {
        use axum::body::to_bytes;
        use axum::routing::get;
        use axum::Extension;
        use tower::ServiceExt;

        // Mirrors `ws_upgrade`'s origin read: local iff the marker is absent.
        async fn probe(origin: Option<Extension<crate::TunnelOrigin>>) -> String {
            (origin.is_none()).to_string()
        }

        let app = axum::Router::new().route("/ws", get(probe));
        let tunnel = app.clone().layer(middleware::from_fn_with_state(
            test_tunnel_assertion(),
            mark_tunnel_origin,
        ));
        let tunnel = tunnel.layer(axum::Extension(test_tunnel_registration()));

        let req = || {
            HttpRequest::builder()
                .uri("/ws")
                .body(Body::empty())
                .unwrap()
        };
        let tunnel_req = || {
            HttpRequest::builder()
                .uri("/ws")
                .header("x-forwarded-host", "owner.dev")
                .header("x-forwarded-proto", "https")
                .header(
                    chan_tunnel_proto::gateway_assertion::HEADER_NAME,
                    test_gateway_assertion(&test_tunnel_assertion(), "owner.dev", "owner"),
                )
                .body(Body::empty())
                .unwrap()
        };
        let body_of = |resp: Response| async move {
            let bytes = to_bytes(resp.into_body(), 1 << 20).await.unwrap();
            String::from_utf8_lossy(&bytes).into_owned()
        };

        // A tunnel request carries the marker: remote origin, so `local == false`.
        let tunnel_body = body_of(tunnel.oneshot(tunnel_req()).await.unwrap()).await;
        assert_eq!(tunnel_body, "false", "a tunnel /ws is remote (Follower)");

        // A loopback request never carries it: local origin, so `local == true`.
        let local_body = body_of(app.oneshot(req()).await.unwrap()).await;
        assert_eq!(local_body, "true", "a loopback /ws is local (Leader)");
    }

    #[tokio::test]
    async fn launcher_mounts_at_library_root() {
        use axum::body::to_bytes;
        use tower::ServiceExt;

        let home = tempfile::tempdir().expect("home");
        let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
        let state = test_state(home.path(), addr);
        let host = state.host.clone();
        let (app, _serve_addr) = build_devserver_app(state, host);

        // Root `/` is served by the installed launcher root fallback -- public
        // (no bearer). Without the fallback `host_dispatch` 404s the root with
        // an empty body; the launcher always names itself: a 200 SPA shell when
        // the bundle is built, or a 404 whose body names the missing bundle when
        // it isn't (the gate's `cargo test` runs before any frontend build, so
        // build.rs's `create_dir_all` leaves an empty embed there). Either proves
        // the fallback is wired; a non-wired root would be the bare host 404.
        let root = app
            .clone()
            .oneshot(HttpRequest::builder().uri("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = root.status();
        let body = to_bytes(root.into_body(), 1 << 20).await.unwrap();
        let text = std::str::from_utf8(&body).unwrap();
        let launcher_built = text.contains("Chan Launcher");
        assert!(
            launcher_built || text.contains("launcher bundle not built"),
            "root `/` must be served by the launcher fallback (status {status}, body starts: {:.120})",
            text,
        );

        // When the bundle is present (dev tree / a properly built release), the
        // shell is a 200 HTML doc and its hashed module script resolves under `/`
        // (vite `base: "./"` makes `./assets/..` land at the library root).
        if launcher_built {
            assert_eq!(status, StatusCode::OK);
            assert!(text.contains(r#"id="app""#));
            let asset = text
                .split_once("src=\"")
                .and_then(|(_, rest)| rest.split_once('"'))
                .map(|(src, _)| src.trim_start_matches("./").to_string())
                .expect("index references a module script");
            let asset_resp = app
                .clone()
                .oneshot(
                    HttpRequest::builder()
                        .uri(format!("/{asset}"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(
                asset_resp.status(),
                StatusCode::OK,
                "launcher asset {asset} must resolve"
            );
        }

        // An `/api` miss stays a real 404 (never the SPA HTML), so the
        // launcher's `/api/library/*` calls get JSON-style errors.
        let api_miss = app
            .oneshot(
                HttpRequest::builder()
                    .uri("/api/library/not-a-route")
                    .header(header::AUTHORIZATION, "Bearer test-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(api_miss.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn launcher_root_fallback_serves_unknown_paths() {
        use axum::body::to_bytes;
        use tower::ServiceExt;

        let home = tempfile::tempdir().expect("home");
        let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
        let state = test_state(home.path(), addr);
        let host = state.host.clone();
        let (app, _serve_addr) = build_devserver_app(state, host);

        let fetch = |uri: &'static str| {
            let app = app.clone();
            async move {
                let response = app
                    .oneshot(HttpRequest::builder().uri(uri).body(Body::empty()).unwrap())
                    .await
                    .unwrap();
                let status = response.status();
                let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
                (status, String::from_utf8(bytes.to_vec()).unwrap())
            }
        };

        // An unknown non-API path outside every tenant prefix serves exactly
        // what the launcher root serves (the SPA shell, or the 404 naming the
        // unbuilt bundle): serve_launcher answers both from the root fallback.
        // The body must identify the LAUNCHER either way; equality alone would
        // also hold for two bare host 404s with the fallback not installed.
        let (root_status, root_body) = fetch("/").await;
        let (unknown_status, unknown_body) = fetch("/nonexistent-page").await;
        assert!(
            unknown_body.contains("Chan Launcher")
                || unknown_body.contains("launcher bundle not built"),
            "unknown path must be answered by the launcher fallback (status {unknown_status}, body starts: {:.120})",
            unknown_body,
        );
        assert_eq!(unknown_status, root_status);
        assert_eq!(unknown_body, root_body);

        // An /api miss outside every prefix stays a real 404, never SPA HTML.
        let (api_status, api_body) = fetch("/api/nonexistent").await;
        assert_eq!(api_status, StatusCode::NOT_FOUND);
        assert!(
            !api_body.contains("<html"),
            "api miss must not serve the SPA shell (body starts: {:.120})",
            api_body,
        );
    }

    #[tokio::test]
    async fn launcher_router_bearer_gates_data_routes() {
        use tower::ServiceExt;

        // The LOOPBACK surface installs the launcher bundle with `Some(token)`
        // (the desktop per-window token). Drive `launcher_router` directly with a
        // token to pin the bearer semantics: header for every raw/local route,
        // `?t=` for the watch WS only, with a tunnel-origin bypass because the
        // gateway strips client credentials after its own auth check.
        let home = tempfile::tempdir().expect("home");
        let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
        let state = test_state(home.path(), addr);
        let host = state.host.clone();
        let app = crate::routes::launcher_router(
            host,
            Some(Arc::new(std::sync::RwLock::new("test-token".to_string()))),
            None,
        );

        // No credential: rejected.
        let unauth = app
            .clone()
            .oneshot(
                HttpRequest::builder()
                    .uri("/api/library/windows")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unauth.status(), StatusCode::UNAUTHORIZED);

        // Valid `Authorization` header: allowed.
        let with_header = app
            .clone()
            .oneshot(
                HttpRequest::builder()
                    .uri("/api/library/windows")
                    .header(header::AUTHORIZATION, "Bearer test-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(with_header.status(), StatusCode::OK);

        // A regular route does NOT accept `?t=`: the header is required (a query
        // token leaks via URL logs, and the SPA fetch can set the header).
        let regular = app
            .clone()
            .oneshot(
                HttpRequest::builder()
                    .uri("/api/library/windows?t=test-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(regular.status(), StatusCode::UNAUTHORIZED);

        // The watch WebSocket accepts `?t=`: a valid token passes the bearer
        // gate, so the response is the WebSocket upgrade error (no upgrade
        // headers in this plain request), NOT a 401.
        let watch_ok = app
            .clone()
            .oneshot(
                HttpRequest::builder()
                    .uri("/api/library/windows/watch?t=test-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_ne!(watch_ok.status(), StatusCode::UNAUTHORIZED);

        // A wrong `?t=` on the watch route is still rejected.
        let watch_bad = app
            .clone()
            .oneshot(
                HttpRequest::builder()
                    .uri("/api/library/windows/watch?t=nope")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(watch_bad.status(), StatusCode::UNAUTHORIZED);

        let tunnel = app.layer(middleware::from_fn_with_state(
            test_tunnel_assertion(),
            mark_tunnel_origin,
        ));
        let tunnel = tunnel.layer(axum::Extension(test_tunnel_registration()));
        let tunnel_read = tunnel
            .oneshot(
                HttpRequest::builder()
                    .uri("/api/library/windows")
                    .header("x-forwarded-host", "owner.dev")
                    .header("x-forwarded-proto", "https")
                    .header(
                        chan_tunnel_proto::gateway_assertion::HEADER_NAME,
                        test_gateway_assertion(&test_tunnel_assertion(), "owner.dev", "owner"),
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(tunnel_read.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn local_color_gate_accepts_a_tenant_token_but_windows_stay_launcher_only() {
        use tower::ServiceExt;

        // A window is served with its per-TENANT token, NOT the
        // launcher token, so the local-color (config) routes must accept a valid
        // tenant token -- while the launcher-MANAGEMENT routes (windows) stay
        // launcher-only.
        let home = tempfile::tempdir().expect("home");
        let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
        let state = test_state(home.path(), addr);

        // Mount a workspace so the host has a live tenant with a real token.
        let parent = tempfile::tempdir().expect("parent");
        let ws = parent.path().join("notes");
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::write(ws.join("n.md"), "# N\n").unwrap();
        let prefix = state.register_workspace(&ws).await.expect("mount");
        let tenant_token = state
            .workspaces
            .lock()
            .unwrap()
            .get(&prefix)
            .expect("record")
            .token
            .clone();
        assert!(!tenant_token.is_empty(), "the tenant minted a token");

        let app = crate::routes::launcher_router(
            state.host.clone(),
            Some(Arc::new(std::sync::RwLock::new(
                "launcher-token".to_string(),
            ))),
            None,
        );
        let bearer = |uri: &str, token: &str| {
            HttpRequest::builder()
                .uri(uri)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap()
        };

        // local-color GET accepts the per-tenant token.
        let color_tenant = app
            .clone()
            .oneshot(bearer("/api/library/local-color", &tenant_token))
            .await
            .unwrap();
        assert_ne!(
            color_tenant.status(),
            StatusCode::UNAUTHORIZED,
            "a valid tenant token must pass the surface gate"
        );

        // local-color PUT also passes the gate on the tenant token (whatever the
        // handler then does -- store-less may 4xx -- it is not a 401).
        let color_put = app
            .clone()
            .oneshot(
                HttpRequest::builder()
                    .method("PUT")
                    .uri("/api/library/local-color")
                    .header(header::AUTHORIZATION, format!("Bearer {tenant_token}"))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"color":"rebeccapurple"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_ne!(color_put.status(), StatusCode::UNAUTHORIZED);

        // The watch WS accepts the tenant token via `?t=` (a fresh window READS
        // on-connect through the watch -- it 401'd today).
        let color_watch = app
            .clone()
            .oneshot(
                HttpRequest::builder()
                    .uri(format!("/api/library/local-color/watch?t={tenant_token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_ne!(color_watch.status(), StatusCode::UNAUTHORIZED);

        // The launcher token still works on local-color.
        let color_launcher = app
            .clone()
            .oneshot(bearer("/api/library/local-color", "launcher-token"))
            .await
            .unwrap();
        assert_ne!(color_launcher.status(), StatusCode::UNAUTHORIZED);

        // A bogus token is still rejected on local-color.
        let color_bogus = app
            .clone()
            .oneshot(bearer("/api/library/local-color", "bogus"))
            .await
            .unwrap();
        assert_eq!(color_bogus.status(), StatusCode::UNAUTHORIZED);

        // The launcher-management routes stay launcher-only: the tenant token is
        // NOT accepted on /windows, but the launcher token is.
        let windows_tenant = app
            .clone()
            .oneshot(bearer("/api/library/windows", &tenant_token))
            .await
            .unwrap();
        assert_eq!(
            windows_tenant.status(),
            StatusCode::UNAUTHORIZED,
            "the launcher-management routes must stay launcher-only"
        );
        let windows_launcher = app
            .oneshot(bearer("/api/library/windows", "launcher-token"))
            .await
            .unwrap();
        assert_ne!(windows_launcher.status(), StatusCode::UNAUTHORIZED);
    }

    /// The watch pump arms its change waiter (`enable`) BEFORE it takes the
    /// snapshot. A `Notify::Notified` records the `notify_waiters` count when it
    /// is created and compares it on first poll, so a change is observed only
    /// when the waiter was created before that change. This pins the ordering
    /// the pump depends on against a real `notify_waiters` (the same primitive
    /// `library_change_notify` fires): armed-before-change wakes, armed-after
    /// blocks.
    #[tokio::test]
    async fn watch_waiter_must_be_armed_before_the_change() {
        use tokio::sync::Notify;

        let notify = Notify::new();

        // Armed before the stand-in "snapshot + send": a change in that window
        // wakes the await, so it returns at once.
        let armed = notify.notified();
        tokio::pin!(armed);
        armed.as_mut().enable();
        notify.notify_waiters();
        tokio::time::timeout(std::time::Duration::from_millis(200), armed.as_mut())
            .await
            .expect("a waiter armed before the change observes it");

        // Armed after the change: the waiter captures the already-advanced count,
        // so the change is behind it and the await blocks. This is what moving
        // the waiter past the snapshot would do, hence arm-before-snapshot.
        notify.notify_waiters();
        let late = notify.notified();
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), late)
                .await
                .is_err(),
            "a waiter armed after the change blocks until the next one"
        );
    }

    #[cfg(target_os = "linux")]
    mod fdstore_boot {
        use super::*;
        use chan_library::terminal_sessions::{fdstore_fd_name, FdStoreSessionMeta, StoredPtySize};
        use chan_library::windows::WindowKind;

        /// Serializes and scopes the env the fdstore paths read: CHAN_HOME
        /// (manifest location) set to the test home, NOTIFY_SOCKET and
        /// FDSTORE cleared so no real manager is ever addressed. EVERY
        /// touched variable's prior value or absence is restored on drop,
        /// so later tests and the invoking harness see the process env
        /// exactly as it was. Holds the WRITE side of
        /// [`super::CHAN_HOME_ENV`], so no reader resolving `config_dir()`
        /// can observe the rewritten env.
        struct FdstoreEnvGuard {
            _lock: std::sync::RwLockWriteGuard<'static, ()>,
            prev: Vec<(&'static str, Option<std::ffi::OsString>)>,
        }

        impl FdstoreEnvGuard {
            fn set(home: &Path) -> Self {
                Self::capture(
                    super::CHAN_HOME_ENV
                        .write()
                        .unwrap_or_else(|e| e.into_inner()),
                    home,
                )
            }

            /// Lock-passing body of [`set`](Self::set), so the round-trip
            /// regression can seed sentinel values under the SAME lock
            /// acquisition the guard then owns.
            fn capture(lock: std::sync::RwLockWriteGuard<'static, ()>, home: &Path) -> Self {
                let prev = ["CHAN_HOME", "NOTIFY_SOCKET", "FDSTORE"]
                    .into_iter()
                    .map(|key| (key, std::env::var_os(key)))
                    .collect();
                std::env::set_var("CHAN_HOME", home);
                std::env::remove_var("NOTIFY_SOCKET");
                std::env::remove_var("FDSTORE");
                Self { _lock: lock, prev }
            }
        }

        impl Drop for FdstoreEnvGuard {
            fn drop(&mut self) {
                for (key, value) in self.prev.drain(..) {
                    match value {
                        Some(value) => std::env::set_var(key, value),
                        None => std::env::remove_var(key),
                    }
                }
            }
        }

        fn meta(session_id: &str, window_id: &str, child_pid: Option<u32>) -> FdStoreSessionMeta {
            FdStoreSessionMeta {
                tenant_prefix: "/t/terminals".into(),
                session_id: session_id.into(),
                tab_name: None,
                tab_group: None,
                window_id: Some(window_id.into()),
                pane_id: None,
                side: None,
                tab_id: None,
                cwd: None,
                command: None,
                env: Default::default(),
                mcp_env: false,
                child_pid,
                size: StoredPtySize {
                    rows: 24,
                    cols: 80,
                    pixel_width: 0,
                    pixel_height: 0,
                },
                seq: 0,
                generation: 0,
                alt_screen: false,
                private_modes: Vec::new(),
            }
        }

        fn write_manifest_file(home: &Path, manifest: &serde_json::Value) {
            let dir = home.join("devserver");
            std::fs::create_dir_all(&dir).expect("devserver dir");
            std::fs::write(
                dir.join("fdstore-restart.json"),
                serde_json::to_vec_pretty(manifest).expect("manifest json"),
            )
            .expect("write manifest");
        }

        fn manifest_file(home: &Path) -> PathBuf {
            home.join("devserver").join("fdstore-restart.json")
        }

        async fn wait_child_dead(child: &mut std::process::Child) {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            loop {
                if child.try_wait().expect("try_wait").is_some() {
                    return;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "recorded child survived the boot cleanup"
                );
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        }

        fn kill_by_cmdline_fragment(fragment: &str) {
            let Ok(entries) = std::fs::read_dir("/proc") else {
                return;
            };
            for entry in entries.flatten() {
                let name = entry.file_name();
                let Some(pid) = name.to_str().and_then(|s| s.parse::<i32>().ok()) else {
                    continue;
                };
                let Ok(cmdline) = std::fs::read(entry.path().join("cmdline")) else {
                    continue;
                };
                if String::from_utf8_lossy(&cmdline).contains(fragment) {
                    if let Some(pid) = rustix::process::Pid::from_raw(pid) {
                        let _ = rustix::process::kill_process(pid, rustix::process::Signal::KILL);
                    }
                }
            }
        }

        /// The guard must leave the process env EXACTLY as it found it:
        /// present sentinels restored to their values, an absent variable
        /// restored to absence, with the in-scope state overridden/cleared.
        #[test]
        fn env_guard_round_trips_every_touched_variable() {
            let lock = super::CHAN_HOME_ENV
                .write()
                .unwrap_or_else(|e| e.into_inner());
            let home = tempfile::tempdir().expect("home");
            let originals: Vec<(&str, Option<std::ffi::OsString>)> =
                ["CHAN_HOME", "NOTIFY_SOCKET", "FDSTORE"]
                    .into_iter()
                    .map(|key| (key, std::env::var_os(key)))
                    .collect();

            // Seed: two PRESENT sentinels and one ABSENT variable, under
            // the same lock acquisition the guard takes over.
            std::env::set_var("CHAN_HOME", "sentinel-chan-home");
            std::env::set_var("NOTIFY_SOCKET", "sentinel-notify");
            std::env::remove_var("FDSTORE");

            let guard = FdstoreEnvGuard::capture(lock, home.path());
            assert_eq!(
                std::env::var_os("CHAN_HOME").as_deref(),
                Some(home.path().as_os_str()),
                "the guard scope must point CHAN_HOME at the test home"
            );
            assert_eq!(std::env::var_os("NOTIFY_SOCKET"), None);
            assert_eq!(std::env::var_os("FDSTORE"), None);
            drop(guard);

            let _lock = super::CHAN_HOME_ENV
                .write()
                .unwrap_or_else(|e| e.into_inner());
            assert_eq!(
                std::env::var_os("CHAN_HOME").as_deref(),
                Some(std::ffi::OsStr::new("sentinel-chan-home")),
                "a present variable must restore to its exact prior value"
            );
            assert_eq!(
                std::env::var_os("NOTIFY_SOCKET").as_deref(),
                Some(std::ffi::OsStr::new("sentinel-notify"))
            );
            assert_eq!(
                std::env::var_os("FDSTORE"),
                None,
                "an absent variable must restore to absence"
            );
            // Put back whatever the harness had before the sentinels.
            for (key, value) in originals {
                match value {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
        }

        /// The bare-stop case: a live v2 manifest, ZERO inherited chan fds.
        /// Every session classifies missing, recorded children get signaled
        /// (the HUP-immune stragglers), terminal window rows are reaped, and
        /// the manifest is removed. A corrupt fd_name entry is skipped by
        /// the name-consistency gate, never restored under foreign metadata.
        #[tokio::test]
        async fn startup_restore_cleans_a_bare_stop_manifest() {
            let home = tempfile::tempdir().expect("home");
            let _env = FdstoreEnvGuard::set(home.path());
            let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
            let state = test_state(home.path(), addr);
            state.host.install_window_registry(
                Arc::new(WindowRegistry::open(home.path().join("windows.json"))),
                "lib-test".into(),
            );
            let row1 = state
                .host
                .mint_window(WindowKind::Terminal, None)
                .expect("window 1");
            let row2 = state
                .host
                .mint_window(WindowKind::Terminal, None)
                .expect("window 2");
            let mut child = std::process::Command::new("sleep")
                .arg("300")
                .spawn()
                .expect("recorded child");
            let pid = child.id();

            let good = meta("sess1", &row1.window_id, Some(pid));
            let mismatched = meta("sess2", &row2.window_id, None);
            write_manifest_file(
                home.path(),
                &serde_json::json!({
                    "version": 2,
                    "library_id": "lib-test",
                    "sessions": [
                        {
                            "fd_name": fdstore_fd_name("sess1", Some(pid)),
                            "meta": serde_json::to_value(&good).unwrap(),
                            "replay_b64": "",
                        },
                        {
                            // Corrupt mapping: the name disagrees with the
                            // session metadata.
                            "fd_name": "chan.pty.someone-else.777",
                            "meta": serde_json::to_value(&mismatched).unwrap(),
                            "replay_b64": "",
                        },
                    ],
                }),
            );

            let restore = fdstore::StartupRestore::take();
            restore.apply(&state);

            wait_child_dead(&mut child).await;
            let remaining: Vec<String> = state
                .host
                .assemble_window_records()
                .into_iter()
                .map(|r| r.window_id)
                .collect();
            assert!(
                !remaining.contains(&row1.window_id) && !remaining.contains(&row2.window_id),
                "terminal rows must be reaped after the bare-stop cleanup: {remaining:?}"
            );
            assert!(
                !manifest_file(home.path()).exists(),
                "a manifest with nothing restored must be removed"
            );
        }

        /// A v1 (prepare-era) manifest takes the full cleanup path: its
        /// recorded child is signaled, its terminal row reaped, the file
        /// removed. Hard swap, no shim.
        #[tokio::test]
        async fn startup_restore_rejects_a_v1_manifest_via_cleanup() {
            let home = tempfile::tempdir().expect("home");
            let _env = FdstoreEnvGuard::set(home.path());
            let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
            let state = test_state(home.path(), addr);
            state.host.install_window_registry(
                Arc::new(WindowRegistry::open(home.path().join("windows.json"))),
                "lib-test".into(),
            );
            let row = state
                .host
                .mint_window(WindowKind::Terminal, None)
                .expect("window");
            let mut child = std::process::Command::new("sleep")
                .arg("300")
                .spawn()
                .expect("recorded child");
            let pid = child.id();
            let session = meta("old-sess", &row.window_id, Some(pid));
            write_manifest_file(
                home.path(),
                &serde_json::json!({
                    "version": 1,
                    "nonce": "deadbeef",
                    "library_id": "lib-test",
                    "created_unix_secs": 1,
                    "sessions": [{
                        "fd_name": "chan.pty.deadbeef.0.1234",
                        "meta": serde_json::to_value(&session).unwrap(),
                        "replay_b64": "",
                    }],
                }),
            );

            let restore = fdstore::StartupRestore::take();
            restore.apply(&state);

            wait_child_dead(&mut child).await;
            assert!(
                !state
                    .host
                    .assemble_window_records()
                    .iter()
                    .any(|r| r.window_id == row.window_id),
                "the v1 session's terminal row must be reaped"
            );
            assert!(
                !manifest_file(home.path()).exists(),
                "an unsupported manifest must be removed"
            );
        }

        /// Full parked lifecycle over a REAL mounted tenant: a windowed
        /// spawn parks and commits synchronously; the seal's final write
        /// serializes exactly the set selected for detach; a post-seal
        /// spawn is refused parking and cannot touch the sealed manifest.
        #[tokio::test]
        async fn seal_finalizes_the_manifest_and_detaches_the_parked_set() {
            use tower::ServiceExt;

            let home = tempfile::tempdir().expect("home");
            let _env = FdstoreEnvGuard::set(home.path());
            let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
            let state = test_state(home.path(), addr);
            state.host.install_window_registry(
                Arc::new(WindowRegistry::open(home.path().join("windows.json"))),
                "lib-test".into(),
            );
            let parker = fdstore::DevserverParker::install(&state.host, "lib-test".into());
            state
                .mount_shared_terminal_tenant()
                .await
                .expect("mount shared terminal tenant");
            parker.activate();

            let term = state
                .host
                .ensure_first_open_terminal()
                .expect("first open")
                .expect("terminal window");
            let row = state
                .host
                .assemble_window_records()
                .into_iter()
                .find(|r| r.window_id == term.window_id)
                .expect("terminal row");
            let host = state.host.clone();
            let (app, _serve_addr) = build_devserver_app(state, host);

            let spawn = |name: &str, command: &str| {
                HttpRequest::builder()
                    .method("POST")
                    .uri(format!("{}/api/terminals", row.prefix))
                    .header(header::AUTHORIZATION, format!("Bearer {}", row.token))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "name": name,
                            "command": command,
                            "window_id": row.window_id,
                        })
                        .to_string(),
                    ))
                    .unwrap()
            };
            let res = app
                .clone()
                .oneshot(spawn("parked", "exec sleep 86397"))
                .await
                .unwrap();
            assert_eq!(res.status(), StatusCode::CREATED);

            let manifest: serde_json::Value = serde_json::from_slice(
                &std::fs::read(manifest_file(home.path())).expect("manifest after park"),
            )
            .expect("manifest json");
            let sessions = manifest["sessions"].as_array().expect("sessions");
            assert_eq!(sessions.len(), 1, "the windowed spawn must be manifested");
            let fd_name = sessions[0]["fd_name"]
                .as_str()
                .expect("fd_name")
                .to_string();

            let detached = parker.seal_flush_detach();
            assert_eq!(detached, 1, "the parked session is selected for detach");
            let sealed: serde_json::Value = serde_json::from_slice(
                &std::fs::read(manifest_file(home.path())).expect("sealed manifest"),
            )
            .expect("sealed json");
            let sealed_sessions = sealed["sessions"].as_array().expect("sessions");
            assert_eq!(
                sealed_sessions.len(),
                1,
                "every fd selected for detach must be in the final manifest"
            );
            assert_eq!(
                sealed_sessions[0]["fd_name"].as_str(),
                Some(fd_name.as_str())
            );

            // A post-seal spawn is REFUSED parking; the sealed manifest
            // cannot change underneath the handover.
            let res = app.clone().oneshot(spawn("late", "true")).await.unwrap();
            assert_eq!(res.status(), StatusCode::CREATED);
            tokio::time::sleep(std::time::Duration::from_millis(400)).await;
            let after: serde_json::Value = serde_json::from_slice(
                &std::fs::read(manifest_file(home.path())).expect("post-seal manifest"),
            )
            .expect("post-seal json");
            assert_eq!(
                after["sessions"].as_array().map(|s| s.len()),
                Some(1),
                "no post-seal write may alter the sealed manifest"
            );

            parker.stop().await;
            // The detached child deliberately outlives the registries; the
            // test owns it now.
            kill_by_cmdline_fragment("sleep 86397");
        }
    }
}
