//! Headless multi-workspace devserver.
//!
//! `run_devserver` binds a [`WorkspaceHost`] to a real address and adds two
//! surfaces a desktop client and the `chan open` CLI drive over it:
//!
//! - A management HTTP/JSON API under the reserved `/api/devserver/*`
//!   namespace ([`crate::devserver_api`]): list, mount, forget workspaces
//!   and open standalone terminals. Workspace tenants mount at their PUBLIC
//!   slug `/{slug}` (top-level), so the gateway forwards
//!   `{user}.devserver.chan.app/{slug}/` unchanged and the devserver routes
//!   the tenant by it; the explicit `/api/devserver/*` and `/api/library/*`
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
//! reconnecting client re-hydrates its panes from the tenant. Terminal PTY
//! contents reset except for an explicit Linux systemd fdstore restart, which
//! re-associates inherited PTY masters with freshly built session objects.
//! Per-tenant control sockets bind at paths derived from the persisted
//! library id (not the pid), so the `$CHAN_CONTROL_SOCKET` baked into
//! already-open shells reaches the restarted instance and `cs` keeps working.

use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
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
    /// tenant content at `{user}.devserver.chan.app/{workspace}/*`. `None`
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
    /// Tunnel endpoint URL (default `https://devserver.chan.app/v1/tunnel`).
    pub tunnel_url: String,
    /// Personal access token (`chan_pat_*`) from id.chan.app.
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
        let dir = match self.path.parent() {
            Some(dir) => {
                std::fs::create_dir_all(dir)?;
                dir
            }
            None => Path::new("."),
        };
        let bytes = serde_json::to_vec_pretty(cfg)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        let tmp = self.path.with_extension("json.tmp");
        // Write + fsync the tmp so its bytes are durable BEFORE the rename:
        // renaming un-synced data is exactly the partial-config risk on a
        // crash or power loss.
        {
            use std::io::Write;
            let mut f = std::fs::File::create(&tmp)?;
            f.write_all(&bytes)?;
            f.sync_all()?;
        }
        // 0600 on the tmp, before the rename, so the token file is never
        // visible at its final path with looser permissions.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
        }
        std::fs::rename(&tmp, &self.path)?;
        // fsync the parent directory so the new dirent survives a crash too;
        // POSIX permits the rename to be lost otherwise. Matches the
        // gold-standard `atomic_write`. Best-effort: durability hardening, not
        // a reason to fail a save the rename already committed.
        let _ = chan_workspace::fs_ops::sync_dir(dir);
        Ok(())
    }
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

/// A registered workspace as the devserver tracks it, the source of truth for
/// `GET /api/devserver/workspaces`. Keyed by its stable `prefix` in
/// [`DevserverState`]. Either mounted (`on`, live in the host, carrying a
/// per-mount `token`) or registered-but-unmounted (`!on`, absent from the
/// host, empty `token`). Forget drops it entirely.
struct WorkspaceRecord {
    root: PathBuf,
    prefix: String,
    label: String,
    /// Whether the workspace is mounted in the host right now.
    on: bool,
    /// Per-mount bearer token while `on`; empty while off.
    token: String,
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
    store: DevserverStore,
    /// The actual bound TCP port (`local_addr().port()`); `0` until bound.
    /// Persisted so a local client re-discovers the current port after a restart.
    bound_port: AtomicU16,
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
        self.persist_state();
        Ok(mounted)
    }

    /// Mount `root` at `prefix` in the host and record it as on. The host
    /// opens through the shared `Library`, which requires the root to be
    /// registered first; registering an already-known root is a no-op. Does
    /// NOT persist -- callers batch the save. Returns the prefix actually
    /// mounted at (the host's idempotent re-register can return an existing
    /// prefix; for a fresh mount it is `prefix`).
    ///
    /// Rejects a `prefix` that collides with the reserved `/api/` namespace.
    /// The host's own collision guard rejects a `prefix` already taken by a
    /// DIFFERENT root (two workspaces with the same basename slug), surfacing
    /// the design's "slug uniqueness within a devserver".
    async fn mount_at(&self, root: &Path, prefix: &str) -> Result<String, Error> {
        if prefix == RESERVED_WORKSPACE_PREFIX {
            return Err(Error::Config(format!(
                "cannot mount a workspace at {prefix}: that path is reserved for the devserver \
                 management API (/api/*). Rename the workspace directory; its basename becomes \
                 the public slug."
            )));
        }
        self.host.library().register_workspace(root)?;
        let hosted = self
            .host
            .open_or_get_registered_workspace(root, tenant_config(self.addr, prefix))
            .await?;
        let record = WorkspaceRecord {
            root: hosted.root.clone(),
            prefix: hosted.prefix.clone(),
            label: workspace_label(&hosted.root),
            on: true,
            // Tenants are configured with `no_token: false`, so the handle
            // always carries a token; default to empty rather than panic.
            token: hosted.handle.token.clone().unwrap_or_default(),
        };
        let mut workspaces = self.workspaces.lock().unwrap_or_else(|e| e.into_inner());
        workspaces.insert(hosted.prefix.clone(), record);
        Ok(hosted.prefix)
    }

    /// Track `root` at `prefix` as registered-but-off (remembered, not
    /// mounted, no token). Re-surfaces an off row on restart and is the off
    /// side of a toggle. Does NOT persist -- callers batch the save.
    fn track_off(&self, root: &Path, prefix: &str) {
        let record = WorkspaceRecord {
            root: root.to_path_buf(),
            prefix: prefix.to_string(),
            label: workspace_label(root),
            on: false,
            token: String::new(),
        };
        let mut workspaces = self.workspaces.lock().unwrap_or_else(|e| e.into_inner());
        workspaces.insert(prefix.to_string(), record);
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
        // Snapshot under the lock, then release it before the mount/unmount:
        // `close_workspace` blocks on the bounded flock wait and the remount
        // awaits, and the list endpoint must stay responsive meanwhile.
        let current = {
            let workspaces = self.workspaces.lock().unwrap_or_else(|e| e.into_inner());
            workspaces.get(prefix).map(|record| {
                let currently_on = self.host.is_root_mounted(&record.root);
                (currently_on, record.root.clone())
            })
        };
        let (currently_on, root) = match current {
            Some(current) => current,
            // Not in the serving map: it may be a host-library workspace the
            // devserver has not mounted yet. Every library workspace is listable
            // and toggleable. Resolve the prefix back to its library
            // root and treat it as currently off; an unknown prefix is a 404.
            None => match self.library_root_for_prefix(prefix) {
                Some(root) => (false, root),
                None => return Ok(SetWorkspaceOnResult::Updated(None)),
            },
        };
        if currently_on == on {
            // Already in the requested state: idempotent no-op, current row.
            // A library-only off row has no map entry, so synthesize it. If a
            // host-level close already unmounted this workspace, normalize the
            // stale in-memory record too; the row derivation below already masks
            // the token, but clearing it here keeps future persists honest.
            if !on {
                let mut workspaces = self.workspaces.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(record) = workspaces.get_mut(prefix) {
                    record.on = false;
                    record.token.clear();
                }
            }
            return Ok(SetWorkspaceOnResult::Updated(
                self.entry_for(prefix)
                    .or_else(|| self.library_off_entry(prefix)),
            ));
        }
        if on {
            // Off → on: mount at the SAME (stable) prefix, minting a fresh
            // token. Works for a registered-off row AND a never-served library
            // workspace (mount_at registers it in the library + host).
            self.mount_at(&root, prefix).await?;
        } else {
            // On → off: unmount, release the flock, keep the registration.
            match self.host.close_workspace(prefix, force)? {
                WorkspaceLifecycleOutcome::Completed | WorkspaceLifecycleOutcome::NotFound => {}
                WorkspaceLifecycleOutcome::Refused { active_terminals } => {
                    return Ok(SetWorkspaceOnResult::Refused { active_terminals });
                }
            }
            let mut workspaces = self.workspaces.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(record) = workspaces.get_mut(prefix) {
                record.on = false;
                record.token.clear();
            }
        }
        self.persist_state();
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
    fn forget_workspace(
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
        let root = {
            let workspaces = self.workspaces.lock().unwrap_or_else(|e| e.into_inner());
            workspaces.get(prefix).map(|record| record.root.clone())
        }
        .or_else(|| self.library_root_for_prefix(prefix));
        let Some(root) = root else {
            return Ok(WorkspaceLifecycleOutcome::NotFound);
        };
        match self.host.remove_workspace_for_root(&root, force)? {
            WorkspaceLifecycleOutcome::Refused { active_terminals } => {
                return Ok(WorkspaceLifecycleOutcome::Refused { active_terminals });
            }
            WorkspaceLifecycleOutcome::Completed | WorkspaceLifecycleOutcome::NotFound => {}
        }
        {
            let mut workspaces = self.workspaces.lock().unwrap_or_else(|e| e.into_inner());
            workspaces.remove(prefix);
        }
        self.persist_state();
        Ok(WorkspaceLifecycleOutcome::Completed)
    }

    /// Persist devserver state across two stores: workspace on/off into the
    /// library-owned [`WorkspaceOverlay`], and the bearer token + library id into
    /// the devserver config. So a restart comes back serving exactly what was on
    /// and remembering what was off.
    fn persist_state(&self) {
        // Workspace on/off → the library-owned overlay store. The overlay sorts
        // by path on save for a stable file.
        if let Some(overlay) = self.host.workspace_overlay() {
            // Reconcile against the HOST before persisting, not the in-memory
            // map alone: a control-socket `chan close --remove` unregisters a
            // workspace from the library without touching this map, and a plain
            // `chan close` unmounts it without updating the map's `on`. Trusting
            // the stale map would re-grow a removed workspace into the overlay
            // and persist a closed one as on, so a restart resurrects it. Drop
            // rows no longer registered in the library, and take `on` from what
            // is ACTUALLY mounted now. (The map stays the row SOURCE so a
            // registered-but-off row the devserver tracks still survives.)
            let registered: std::collections::HashSet<PathBuf> = self
                .host
                .library()
                .list_workspaces()
                .into_iter()
                .map(|w| canonical_root(&w.root_path))
                .collect();
            let mounted: std::collections::HashSet<String> = self
                .host
                .mounted_prefixes()
                .unwrap_or_default()
                .into_iter()
                .collect();
            let rows: Vec<PersistedWorkspace> = {
                let map = self.workspaces.lock().unwrap_or_else(|e| e.into_inner());
                map.values()
                    .filter(|record| registered.contains(&canonical_root(&record.root)))
                    .map(|record| PersistedWorkspace {
                        path: record.root.to_string_lossy().into_owned(),
                        on: mounted.contains(&record.prefix),
                    })
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
        let token = random_token();
        *self.token.write().unwrap_or_else(|e| e.into_inner()) = token.clone();
        self.token_minted_at
            .store(unix_now_secs(), Ordering::Relaxed);
        self.persist_state();
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
        let (status, error) = self.host.workspace_status(&record.root);
        let on = status == WorkspaceStatus::Running && self.host.is_root_mounted(&record.root);
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
        store,
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

    // Restore the registered workspaces from the library-owned overlay. The
    // mount prefix is re-derived from the path (the stable slug live mounts and
    // the window feed already use), not persisted. `on` rows re-mount at it;
    // `off` rows are tracked as registered-but-unmounted so the client still
    // sees them and can toggle them on. A root that fails to re-mount is
    // downgraded to off so its row still surfaces; a path that fails to map to a
    // prefix is skipped with a note.
    let restore_rows = state
        .host
        .workspace_overlay()
        .map(|overlay| overlay.entries())
        .unwrap_or_default();
    for ws in &restore_rows {
        let path = PathBuf::from(&ws.path);
        let prefix = match allocate_workspace_prefix(&path) {
            Ok(prefix) => prefix,
            Err(e) => {
                eprintln!(
                    "chan devserver: NOTE: skipping persisted workspace {} ({e})",
                    ws.path
                );
                continue;
            }
        };
        if ws.on {
            if let Err(e) = state.mount_at(&path, &prefix).await {
                eprintln!("chan devserver: NOTE: could not re-mount {}: {e}", ws.path);
                state.track_off(&path, &prefix);
            }
        } else {
            state.track_off(&path, &prefix);
        }
    }
    // Persist once now so a newly-minted token + the restored set (with any
    // failed re-mounts downgraded to off) land even before the first call.
    state.persist_state();

    fdstore_restore.apply(&state);

    let (app, serve_addr_cell) = build_devserver_app(state.clone(), host.clone());

    // Bind the local TCP listener up front (so a bind failure errors before we
    // dial the tunnel), unless the resolved config is tunnel-only. `addr` is
    // still meaningful when unbound -- the discovery socket and the per-tenant
    // window records use it; only the loopback TCP bind is skipped.
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
    // A discovery bind failure is non-fatal: the management API still works,
    // only `chan open` registration is disabled. Tunnel-only instances have no
    // bound TCP address, so their configured port (possibly zero) is their
    // local selector identity.
    let discovery_port = local_addr.unwrap_or(config.addr).port();
    let _discovery = start_discovery_listener(state.clone(), discovery_port);

    // Shutdown wiring mirrors `serve()`: a single watch channel fed by
    // SIGINT/SIGTERM, plus a side task that cancels every tenant's in-flight
    // reindex so the per-workspace flocks release promptly. Both the bound and
    // the tunnel-only paths share it; the tunnel task and the no-listener wait
    // both subscribe to it.
    let signal_tx = Arc::new(tokio::sync::watch::channel(false).0);
    let cancel_host = host.clone();
    let mut cancel_rx = signal_tx.subscribe();
    tokio::spawn(async move {
        let _ = cancel_rx.changed().await;
        cancel_host.cancel_all_reindex();
    });

    // Tunnel mode: also hand the SAME app to chan-tunnel-client, which registers
    // ONE devserver and forwards inbound substreams into it, publishing every
    // mounted tenant behind one gateway registration. The management API rides
    // the same router, but the proxy 404s `/api/devserver/*` on the public
    // wildcard, so only tenant content is reachable through the gateway. The
    // run loop reconnects with backoff and is cancelled by the shutdown signal.
    let tunnel_url = config.tunnel.as_ref().map(|t| t.tunnel_url.clone());
    if let Some(tunnel) = config.tunnel {
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
        spawn_devserver_tunnel(tunnel, tunnel_app, &signal_tx);
    }

    match listener {
        Some(listener) => {
            // Report the bound address, not the requested one, so `--port 0`
            // prints the OS-assigned port (mirrors `chan open`). Falls back to
            // the request on the impossible local_addr() error rather than
            // refusing to serve.
            let local_addr = local_addr.expect("listening devserver has a bound address");
            println!("chan devserver: listening on http://{local_addr}/?t={token}");
            // Machine-readable token contract: the desktop control terminal
            // scrapes this exact marker from the connect-script output on every
            // connect and reconnect, as the source of truth for the bearer
            // token. Emitted once the token and bound address are known; the
            // `--service=systemd` first start surfaces it through the unit
            // journal the launcher follows.
            println!("{DEVSERVER_TOKEN_MARKER}{token}");
            fdstore::notify_ready()?;
            // The ping loop observes the shutdown channel, and its owner also
            // aborts and joins it before this serve arm can return.
            let watchdog_pings = fdstore::spawn_watchdog_pings(signal_tx.subscribe());
            let serve_result = crate::signal::graceful_serve(listener, app, signal_tx).await;
            watchdog_pings.stop().await;
            serve_result.context("running devserver")?;
        }
        None => {
            // Tunnel-only: no local TCP listener. The discovery Unix socket and
            // the tunnel are already up; report the public endpoint instead of a
            // bound address. The token marker is omitted -- it is scraped only on
            // a LOCAL connect, so it is moot with no listener (and tunnel mode is
            // foreground-only, so no supervisor follows a journal for it).
            match &tunnel_url {
                Some(url) => println!(
                    "chan devserver: tunnel-only (no local listener); publishing via {url}"
                ),
                None => println!(
                    "chan devserver: no local listener and no tunnel; only the chan-open \
                     discovery socket is reachable"
                ),
            }
            fdstore::notify_ready()?;
            let watchdog_pings = fdstore::spawn_watchdog_pings(signal_tx.subscribe());
            // No listener to drain: install the signal watcher and await
            // shutdown while the tunnel + reindex-cancel tasks run on `signal_tx`.
            crate::signal::graceful_wait(signal_tx).await;
            watchdog_pings.stop().await;
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
) {
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
        tokio::spawn(async move {
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
    });
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
            "/api/devserver/systemd-fdstore/prepare",
            post(handle_fdstore_prepare),
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
    match state.forget_workspace(&prefix, query.force) {
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

async fn handle_fdstore_prepare(State(state): State<Arc<DevserverState>>) -> Response {
    match fdstore::prepare_restart(&state) {
        Ok(response) => Json(response).into_response(),
        Err(e) => (e.status, e.message).into_response(),
    }
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
        assert_eq!(
            fdstore::child_pid_from_name("chan.pty.nonce.0.4242"),
            Some(4242)
        );
        assert_eq!(fdstore::child_pid_from_name("chan.pty.nonce.0.0"), None);
        assert_eq!(fdstore::child_pid_from_name("other.pty.nonce.0.4242"), None);
        assert_eq!(fdstore::child_pid_from_name("chan.pty.nonce.0.nope"), None);
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
        store.save(&cfg).unwrap();
        let loaded = store.load();
        assert_eq!(loaded.devserver_token, "abc");
        assert_eq!(loaded.library_id, "lib-xyz");
        assert_eq!(loaded.port, 9605);
        // The atomic tmp+rename leaves no tmpfile behind after a save.
        let tmp = dir.path().join("nested").join("config.json.tmp");
        assert!(!tmp.exists(), "leftover tmpfile: {}", tmp.display());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join("nested").join("config.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600, "config must be 0600");
        }
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
            store: DevserverStore::at(home.join("devserver").join("config.json")),
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
        assert!(!rows[0].on);
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
        assert!(!a.on, "closed A stays off across a later persist_state");
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
        let home = tempfile::tempdir().expect("home");
        let ws = tempfile::tempdir().expect("workspace");
        let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
        let state = test_state(home.path(), addr);

        let prefix = state.register_workspace(ws.path()).await.expect("mount");
        assert!(state
            .host
            .close_workspace_for_root(ws.path(), false)
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
}
