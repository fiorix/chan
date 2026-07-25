use axum::http::StatusCode;
use serde::Serialize;

use super::DevserverState;

#[derive(Debug, Serialize)]
pub(super) struct PrepareResponse {
    preserved: usize,
    nonce: String,
    skipped: Vec<String>,
}

#[derive(Debug)]
pub(super) struct PrepareError {
    pub(super) status: StatusCode,
    pub(super) message: String,
}

impl PrepareError {
    #[cfg(target_os = "linux")]
    fn conflict(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            message: message.into(),
        }
    }

    #[cfg(not(target_os = "linux"))]
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }
}

#[must_use = "the watchdog task must be stopped and joined before shutdown completes"]
pub(super) struct WatchdogPings {
    task: Option<tokio::task::JoinHandle<()>>,
}

impl WatchdogPings {
    fn none() -> Self {
        Self { task: None }
    }

    pub(super) fn from_task(task: tokio::task::JoinHandle<()>) -> Self {
        Self { task: Some(task) }
    }

    pub(super) async fn stop(self) {
        let Some(task) = self.task else {
            return;
        };
        task.abort();
        match task.await {
            Ok(()) => {}
            Err(error) if error.is_cancelled() => {}
            Err(error) => {
                tracing::error!(error = %error, "systemd watchdog ping task failed");
            }
        }
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use std::collections::{HashMap, HashSet};
    use std::os::fd::AsFd;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use anyhow::Context;
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
    use chan_library::terminal_sessions::{
        FdStoreSessionImport, FdStoreSessionMeta, FdStoreSkippedSession,
    };
    use rand::RngCore;
    use serde::{Deserialize, Serialize};

    use super::{DevserverState, PrepareError, PrepareResponse, WatchdogPings};
    use crate::WorkspaceHost;

    const MANIFEST_VERSION: u32 = 1;
    const FD_PREFIX: &str = "chan.pty.";
    const MANIFEST_TTL_SECS: u64 = 30;
    const BARRIER_TIMEOUT: Duration = Duration::from_secs(5);

    #[derive(Debug, Serialize, Deserialize)]
    struct RestartManifest {
        version: u32,
        nonce: String,
        library_id: String,
        created_unix_secs: u64,
        sessions: Vec<ManifestSession>,
    }

    #[derive(Debug, Serialize, Deserialize)]
    struct ManifestSession {
        fd_name: String,
        meta: FdStoreSessionMeta,
        #[serde(default, skip_serializing_if = "String::is_empty")]
        replay_b64: String,
    }

    pub(crate) struct StartupRestore {
        manifest_path: PathBuf,
        fd_names: Vec<String>,
        orphan_fd_names: Vec<String>,
        cleanup_all_terminal_windows: bool,
        manifest_library_id: Option<String>,
        imports: Vec<FdStoreSessionImport>,
        skipped: Vec<String>,
        skipped_sessions: Vec<FdStoreSkippedSession>,
    }

    impl StartupRestore {
        pub(crate) fn take() -> Self {
            let manifest_path = manifest_path();
            let named_fds = chan_systemd::take_listen_fds();
            if named_fds.is_empty() {
                return Self::empty(manifest_path);
            }

            let mut fd_names = Vec::new();
            let mut fd_by_name = HashMap::new();
            for named in named_fds {
                if named.name.starts_with(FD_PREFIX) {
                    fd_names.push(named.name.clone());
                    fd_by_name.insert(named.name, named.fd);
                }
            }
            if fd_by_name.is_empty() {
                return Self::empty(manifest_path);
            }

            let manifest = match std::fs::read(&manifest_path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<RestartManifest>(&bytes).ok())
            {
                Some(manifest) => manifest,
                None => {
                    let skipped = fd_names
                        .iter()
                        .map(|name| {
                            format!("inherited fd {name}: restart manifest missing or unreadable")
                        })
                        .collect();
                    cleanup_invalid_fds(&fd_names);
                    return Self {
                        manifest_path,
                        fd_names: Vec::new(),
                        orphan_fd_names: Vec::new(),
                        cleanup_all_terminal_windows: true,
                        manifest_library_id: None,
                        imports: Vec::new(),
                        skipped,
                        skipped_sessions: Vec::new(),
                    };
                }
            };

            let now = now_unix_secs();
            if manifest.version != MANIFEST_VERSION
                || now.saturating_sub(manifest.created_unix_secs) > MANIFEST_TTL_SECS
            {
                let mut skipped = fd_names
                    .iter()
                    .map(|name| {
                        format!("inherited fd {name}: restart manifest version or age is invalid")
                    })
                    .collect::<Vec<_>>();
                let mut skipped_sessions = Vec::new();
                for session in &manifest.sessions {
                    push_skipped_session(
                        &mut skipped,
                        &mut skipped_sessions,
                        &session.meta,
                        "restart manifest version or age is invalid",
                    );
                }
                cleanup_invalid_fds(&fd_names);
                return Self {
                    manifest_path,
                    fd_names: Vec::new(),
                    orphan_fd_names: Vec::new(),
                    cleanup_all_terminal_windows: false,
                    manifest_library_id: Some(manifest.library_id),
                    imports: Vec::new(),
                    skipped,
                    skipped_sessions,
                };
            }

            let mut imports = Vec::new();
            let mut skipped = Vec::new();
            let mut skipped_sessions = Vec::new();
            for session in manifest.sessions {
                let ManifestSession {
                    fd_name,
                    meta,
                    replay_b64,
                } = session;
                if !fd_name.starts_with(FD_PREFIX) {
                    push_skipped_session(
                        &mut skipped,
                        &mut skipped_sessions,
                        &meta,
                        format!("fd name {fd_name} is outside chan fdstore namespace"),
                    );
                    continue;
                }
                let Some(master_fd) = fd_by_name.remove(&fd_name) else {
                    push_skipped_session(
                        &mut skipped,
                        &mut skipped_sessions,
                        &meta,
                        format!("fd {fd_name} was not inherited from systemd"),
                    );
                    continue;
                };
                match chan_systemd::pty_master_has_live_slave(master_fd.as_fd()) {
                    Ok(true) => {}
                    Ok(false) => {
                        push_skipped_session(
                            &mut skipped,
                            &mut skipped_sessions,
                            &meta,
                            "PTY slave has no live process",
                        );
                        continue;
                    }
                    Err(e) => {
                        push_skipped_session(
                            &mut skipped,
                            &mut skipped_sessions,
                            &meta,
                            format!("checking PTY slave liveness: {e}"),
                        );
                        continue;
                    }
                }
                let replay = decode_replay(&replay_b64, &meta, &mut skipped);
                imports.push(FdStoreSessionImport {
                    meta,
                    master_fd,
                    replay,
                });
            }
            let orphan_fd_names: Vec<String> = fd_by_name.keys().cloned().collect();
            skipped.extend(
                orphan_fd_names
                    .iter()
                    .map(|name| format!("inherited fd {name}: no matching manifest entry")),
            );

            Self {
                manifest_path,
                fd_names,
                orphan_fd_names,
                cleanup_all_terminal_windows: false,
                manifest_library_id: Some(manifest.library_id),
                imports,
                skipped,
                skipped_sessions,
            }
        }

        fn empty(manifest_path: PathBuf) -> Self {
            Self {
                manifest_path,
                fd_names: Vec::new(),
                orphan_fd_names: Vec::new(),
                cleanup_all_terminal_windows: false,
                manifest_library_id: None,
                imports: Vec::new(),
                skipped: Vec::new(),
                skipped_sessions: Vec::new(),
            }
        }

        pub(crate) fn apply(self, state: &DevserverState) {
            if self.fd_names.is_empty()
                && self.orphan_fd_names.is_empty()
                && !self.cleanup_all_terminal_windows
                && self.imports.is_empty()
                && self.skipped.is_empty()
                && self.skipped_sessions.is_empty()
            {
                return;
            }
            let StartupRestore {
                manifest_path,
                fd_names,
                orphan_fd_names,
                cleanup_all_terminal_windows,
                manifest_library_id,
                imports,
                mut skipped,
                mut skipped_sessions,
            } = self;

            let mut restored = 0usize;
            if manifest_library_id.as_deref() != Some(state.library_id.as_str()) {
                for import in imports {
                    push_skipped_session(
                        &mut skipped,
                        &mut skipped_sessions,
                        &import.meta,
                        "manifest library id does not match this devserver",
                    );
                }
            } else {
                let report = state.host.restore_fdstore_terminal_sessions(imports);
                restored = report.restored;
                skipped.extend(report.skipped);
                skipped_sessions.extend(report.skipped_sessions);
            }

            if !orphan_fd_names.is_empty() {
                signal_children_from_names(&orphan_fd_names);
            }
            cleanup_skipped_session_children(&skipped_sessions);
            if cleanup_all_terminal_windows {
                skipped.extend(state.host.cleanup_fdstore_metadata_loss_terminal_windows());
            }
            skipped.extend(
                state
                    .host
                    .cleanup_skipped_fdstore_sessions(&skipped_sessions),
            );

            if !fd_names.is_empty() {
                chan_systemd::fdstore_remove_many(fd_names.iter().map(String::as_str));
            }
            let _ = std::fs::remove_file(&manifest_path);
            if restored > 0 || !skipped.is_empty() {
                eprintln!(
                    "chan devserver: systemd fdstore restore: restored {restored}, skipped {}",
                    skipped.len()
                );
                for reason in skipped.iter().take(8) {
                    eprintln!("chan devserver: systemd fdstore skipped: {reason}");
                }
                if skipped.len() > 8 {
                    eprintln!(
                        "chan devserver: systemd fdstore skipped: {} more",
                        skipped.len() - 8
                    );
                }
            }
        }
    }

    pub(crate) fn prepare_restart(state: &DevserverState) -> Result<PrepareResponse, PrepareError> {
        if std::env::var_os("NOTIFY_SOCKET").is_none_or(|value| value.is_empty()) {
            return Err(PrepareError::conflict(
                "NOTIFY_SOCKET is not set; fdstore restart is only available inside the systemd unit",
            ));
        }

        let path = manifest_path();
        let _ = std::fs::remove_file(&path);
        let snapshots = state.host.fdstore_terminal_sessions();
        let nonce = nonce();
        let mut sessions = Vec::new();
        let mut fd_names = Vec::new();
        let mut skipped = Vec::new();

        for (idx, snapshot) in snapshots.into_iter().enumerate() {
            if snapshot.meta.window_id.is_none() {
                skipped.push(format!(
                    "session {}: missing window id",
                    snapshot.meta.session_id
                ));
                continue;
            }
            let child_pid = snapshot.meta.child_pid.unwrap_or(0);
            let fd_name = format!("{FD_PREFIX}{nonce}.{idx}.{child_pid}");
            if let Err(e) = chan_systemd::fdstore(&fd_name, snapshot.master_fd.as_fd()) {
                cleanup_prepare_failure(&path, &fd_names);
                return Err(PrepareError::conflict(format!(
                    "storing {fd_name} in systemd fdstore: {e}"
                )));
            }
            fd_names.push(fd_name.clone());
            sessions.push(ManifestSession {
                fd_name,
                meta: snapshot.meta,
                replay_b64: BASE64.encode(&snapshot.replay),
            });
        }

        if sessions.is_empty() {
            return Ok(PrepareResponse {
                preserved: 0,
                nonce,
                skipped,
            });
        }

        let manifest = RestartManifest {
            version: MANIFEST_VERSION,
            nonce: nonce.clone(),
            library_id: state.library_id.clone(),
            created_unix_secs: now_unix_secs(),
            sessions,
        };
        if let Err(e) = write_manifest(&path, &manifest) {
            cleanup_prepare_failure(&path, &fd_names);
            return Err(PrepareError::conflict(format!(
                "writing systemd fdstore restart manifest: {e}"
            )));
        }
        if let Err(e) = chan_systemd::notify_barrier(BARRIER_TIMEOUT) {
            cleanup_prepare_failure(&path, &fd_names);
            return Err(PrepareError::conflict(format!(
                "waiting for systemd fdstore barrier: {e}"
            )));
        }

        let preserved_sessions: Vec<(String, String)> = manifest
            .sessions
            .iter()
            .map(|session| {
                (
                    session.meta.tenant_prefix.clone(),
                    session.meta.session_id.clone(),
                )
            })
            .collect();
        state
            .host
            .preserve_fdstore_terminal_sessions(&preserved_sessions);
        schedule_cleanup(
            path,
            nonce.clone(),
            fd_names,
            state.host.clone(),
            preserved_sessions,
        );
        Ok(PrepareResponse {
            preserved: manifest.sessions.len(),
            nonce,
            skipped,
        })
    }

    pub(crate) fn notify_ready() -> anyhow::Result<()> {
        chan_systemd::notify_ready().context("notifying systemd READY=1")
    }

    /// Systemd watchdog ping loop: when the unit configures
    /// `WatchdogSec=` (WATCHDOG_USEC is set), ping at half the
    /// configured interval until shutdown. A seized-but-alive process
    /// then fails systemd's liveness check and is restarted with a
    /// journal trail. The returned owner is empty outside watchdog
    /// supervision.
    pub(crate) fn spawn_watchdog_pings(
        mut shutdown_rx: tokio::sync::watch::Receiver<bool>,
    ) -> WatchdogPings {
        let Some(interval) = chan_systemd::watchdog_interval() else {
            return WatchdogPings::none();
        };
        WatchdogPings::from_task(tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = tokio::time::sleep(interval) => {
                        if let Err(e) = chan_systemd::notify_watchdog() {
                            tracing::warn!(error = %e, "systemd watchdog ping failed");
                        }
                    }
                    changed = shutdown_rx.changed() => {
                        if changed.is_err() || *shutdown_rx.borrow() {
                            return;
                        }
                    }
                }
            }
        }))
    }

    fn manifest_path() -> PathBuf {
        chan_workspace::paths::config_dir()
            .join("devserver")
            .join("fdstore-restart.json")
    }

    fn now_unix_secs() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    }

    fn nonce() -> String {
        let mut bytes = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut bytes);
        let mut out = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            use std::fmt::Write as _;
            let _ = write!(&mut out, "{byte:02x}");
        }
        out
    }

    pub(crate) fn child_pid_from_name(name: &str) -> Option<u32> {
        let suffix = name.strip_prefix(FD_PREFIX)?;
        let pid = suffix.rsplit('.').next()?.parse::<u32>().ok()?;
        (pid != 0).then_some(pid)
    }

    fn decode_replay(
        replay_b64: &str,
        meta: &FdStoreSessionMeta,
        skipped: &mut Vec<String>,
    ) -> Vec<u8> {
        if replay_b64.is_empty() {
            return Vec::new();
        }
        match BASE64.decode(replay_b64) {
            Ok(bytes) => bytes,
            Err(e) => {
                skipped.push(format!(
                    "session {}: replay bytes could not be decoded; restoring PTY without replay: {e}",
                    meta.session_id
                ));
                Vec::new()
            }
        }
    }

    fn push_skipped_session(
        skipped: &mut Vec<String>,
        skipped_sessions: &mut Vec<FdStoreSkippedSession>,
        meta: &FdStoreSessionMeta,
        reason: impl Into<String>,
    ) {
        let reason = reason.into();
        skipped.push(format!("session {}: {reason}", meta.session_id));
        skipped_sessions.push(FdStoreSkippedSession::from_meta(meta, reason));
    }

    fn signal_child(pid: u32) {
        let Ok(raw_pid) = i32::try_from(pid) else {
            return;
        };
        let Some(pid) = rustix::process::Pid::from_raw(raw_pid) else {
            return;
        };
        let _ = rustix::process::kill_process(pid, rustix::process::Signal::HUP);
        let _ = rustix::process::kill_process(pid, rustix::process::Signal::TERM);
    }

    fn signal_children_from_names(fd_names: &[String]) {
        let mut seen = HashSet::new();
        for pid in fd_names.iter().filter_map(|name| child_pid_from_name(name)) {
            if seen.insert(pid) {
                signal_child(pid);
            }
        }
    }

    fn cleanup_skipped_session_children(sessions: &[FdStoreSkippedSession]) {
        let mut seen = HashSet::new();
        for pid in sessions.iter().filter_map(|session| session.child_pid) {
            if seen.insert(pid) {
                signal_child(pid);
            }
        }
    }

    fn cleanup_invalid_fds(fd_names: &[String]) {
        signal_children_from_names(fd_names);
        chan_systemd::fdstore_remove_many(fd_names.iter().map(String::as_str));
    }

    fn cleanup_prepare_failure(path: &Path, fd_names: &[String]) {
        if !fd_names.is_empty() {
            chan_systemd::fdstore_remove_many(fd_names.iter().map(String::as_str));
        }
        let _ = std::fs::remove_file(path);
    }

    fn write_manifest(path: &Path, manifest: &RestartManifest) -> Result<(), String> {
        use std::os::unix::fs::PermissionsExt;

        let bytes = serde_json::to_vec_pretty(manifest).map_err(|e| e.to_string())?;
        chan_workspace::fs_ops::atomic_write(path, &bytes).map_err(|e| e.to_string())?;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        if let Some(parent) = path.parent() {
            let _ = chan_workspace::fs_ops::sync_dir(parent);
        }
        Ok(())
    }

    fn schedule_cleanup(
        path: PathBuf,
        nonce: String,
        fd_names: Vec<String>,
        host: Arc<WorkspaceHost>,
        preserved_sessions: Vec<(String, String)>,
    ) {
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(MANIFEST_TTL_SECS)).await;
            let same_nonce = std::fs::read(&path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<RestartManifest>(&bytes).ok())
                .is_some_and(|manifest| manifest.nonce == nonce);
            if same_nonce {
                chan_systemd::fdstore_remove_many(fd_names.iter().map(String::as_str));
                host.clear_fdstore_terminal_session_preservation(&preserved_sessions);
                let _ = std::fs::remove_file(&path);
            }
        });
    }
}

#[cfg(all(target_os = "linux", test))]
pub(super) use linux::child_pid_from_name;
#[cfg(target_os = "linux")]
pub(super) use linux::{notify_ready, prepare_restart, spawn_watchdog_pings, StartupRestore};

#[cfg(not(target_os = "linux"))]
mod unsupported {
    use anyhow::Context;

    use super::{DevserverState, PrepareError, PrepareResponse, WatchdogPings};

    pub(crate) struct StartupRestore;

    impl StartupRestore {
        pub(crate) fn take() -> Self {
            Self
        }

        pub(crate) fn apply(self, _state: &DevserverState) {}
    }

    pub(crate) fn prepare_restart(
        _state: &DevserverState,
    ) -> Result<PrepareResponse, PrepareError> {
        Err(PrepareError::bad_request(
            "systemd fdstore restart is Linux-only",
        ))
    }

    pub(crate) fn notify_ready() -> anyhow::Result<()> {
        chan_systemd::notify_ready().context("notifying systemd READY=1")
    }

    /// Non-Linux: no systemd watchdog; never a task.
    pub(crate) fn spawn_watchdog_pings(
        _shutdown_rx: tokio::sync::watch::Receiver<bool>,
    ) -> WatchdogPings {
        WatchdogPings::none()
    }
}

#[cfg(not(target_os = "linux"))]
pub(super) use unsupported::{notify_ready, prepare_restart, spawn_watchdog_pings, StartupRestore};

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    #[tokio::test]
    async fn watchdog_owner_aborts_and_joins_before_stop_returns() {
        let fired = Arc::new(AtomicBool::new(false));
        let release = Arc::new(tokio::sync::Notify::new());
        let (signal_tx, mut signal_rx) = tokio::sync::watch::channel(false);
        let (observed_tx, observed_rx) = tokio::sync::oneshot::channel();
        let task_fired = fired.clone();
        let task_release = release.clone();
        let task = tokio::spawn(async move {
            signal_rx.changed().await.unwrap();
            assert!(*signal_rx.borrow());
            let _ = observed_tx.send(());
            task_release.notified().await;
            task_fired.store(true, Ordering::SeqCst);
        });
        signal_tx.send(true).unwrap();
        observed_rx.await.unwrap();

        WatchdogPings::from_task(task).stop().await;
        release.notify_waiters();
        tokio::task::yield_now().await;

        assert!(
            !fired.load(Ordering::SeqCst),
            "watchdog task acted after stop returned"
        );
    }
}
