//! Continuous systemd fd-store parking for devserver terminals.
//!
//! Every windowed PTY parks its master fd in the systemd fd store at spawn
//! and a maintained restart manifest describes the parked set, so ANY unit
//! restart -- `systemctl --user restart`, `chan devserver --restart`, a
//! watchdog kill, a crash under Restart=on-failure -- rebuilds the
//! terminals on boot. `systemctl stop` releases the store instead, closing
//! the masters and HUPping the shells: the stop/restart asymmetry lives
//! entirely in systemd's store-release semantics, never in a SIGTERM guess.

use super::DevserverState;

#[must_use = "the watchdog task must be stopped and joined before shutdown completes"]
pub(super) struct WatchdogPings {
    task: Option<tokio::task::JoinHandle<()>>,
}

impl WatchdogPings {
    fn none() -> Self {
        Self { task: None }
    }

    // Only constructed on Linux, where the fdstore watchdog task is spawned.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
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
    use std::collections::HashMap;
    use std::collections::HashSet;
    use std::os::fd::AsFd;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex, MutexGuard};
    use std::time::Duration;

    use anyhow::Context;
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
    use chan_library::terminal_sessions::{
        fdstore_fd_name, FdStorePark, FdStoreParker, FdStoreSessionImport, FdStoreSessionMeta,
        FdStoreSkippedSession, FDSTORE_FD_PREFIX,
    };
    use serde::{Deserialize, Serialize};

    use super::{DevserverState, WatchdogPings};
    use crate::WorkspaceHost;

    const MANIFEST_VERSION: u32 = 2;
    /// Coalescing window for deferred (unpark/metadata) manifest rewrites.
    /// Additive commits never wait on this: a park writes synchronously.
    const MANIFEST_DEBOUNCE: Duration = Duration::from_millis(250);
    /// Bound on the post-FDSTORE manager sync in a park's additive commit.
    const BARRIER_TIMEOUT: Duration = Duration::from_secs(5);
    /// The canonical unit's FileDescriptorStoreMax, the cap fallback where
    /// the manager does not export `$FDSTORE`.
    const UNIT_FDSTORE_MAX: usize = 512;

    #[derive(Debug, Serialize, Deserialize)]
    struct RestartManifest {
        version: u32,
        library_id: String,
        sessions: Vec<ManifestSession>,
    }

    #[derive(Debug, Serialize, Deserialize)]
    struct ManifestSession {
        fd_name: String,
        meta: FdStoreSessionMeta,
        #[serde(default, skip_serializing_if = "String::is_empty")]
        replay_b64: String,
    }

    /// Parking lifecycle. Transitions are one-way:
    /// Disabled -> Active (after the boot restore applies) -> Sealed (at the
    /// head of graceful shutdown). park() succeeds only in Active; unpark
    /// store removals are valid in every phase; manifest writes happen in
    /// Active plus the single sealed final write.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum ParkerPhase {
        Disabled,
        Active,
        Sealed,
    }

    /// Injectable systemd store boundary, so phase/cap/barrier failure
    /// arms are unit-testable without a manager.
    trait StoreOps: Send + Sync {
        fn store(&self, name: &str, fd: std::os::fd::BorrowedFd<'_>) -> std::io::Result<()>;
        /// Synchronize with the manager: returning Ok proves it processed
        /// everything sent so far, `store` included. `sd_notify(3)` is
        /// fire-and-forget on its own -- an FDSTORE datagram that was SENT
        /// may still be dropped or rejected (e.g. over
        /// FileDescriptorStoreMax), which only the barrier can exclude.
        fn barrier(&self) -> std::io::Result<()>;
        fn remove(&self, name: &str);
    }

    struct SystemdStoreOps;

    impl StoreOps for SystemdStoreOps {
        fn store(&self, name: &str, fd: std::os::fd::BorrowedFd<'_>) -> std::io::Result<()> {
            chan_systemd::fdstore(name, fd)
        }

        fn barrier(&self) -> std::io::Result<()> {
            chan_systemd::notify_barrier(BARRIER_TIMEOUT)
        }

        fn remove(&self, name: &str) {
            chan_systemd::fdstore_remove_many([name]);
        }
    }

    /// Whether a park may proceed: `parked` counts the manifest snapshot
    /// INCLUDING the candidate's provisional entry, so a store already at
    /// its maximum refuses the candidate instead of manifesting an fd the
    /// manager would reject.
    fn park_within_cap(parked_including_candidate: usize, store_max: usize) -> bool {
        parked_including_candidate <= store_max
    }

    struct ParkerShared {
        host: Arc<WorkspaceHost>,
        library_id: String,
        manifest_path: PathBuf,
        store: Box<dyn StoreOps>,
        /// The service's fd-store ceiling: systemd's exported `$FDSTORE`
        /// when present, else the canonical unit's FileDescriptorStoreMax.
        store_max: usize,
        /// Serializes every manifest write with phase transitions: a
        /// debounced rewrite can never land after the sealed final write,
        /// and a park's synchronous commit cannot interleave with a seal.
        phase: Mutex<ParkerPhase>,
        dirty: tokio::sync::Notify,
    }

    impl ParkerShared {
        /// Rewrite the manifest from the live parked set. Caller holds the
        /// phase lock (the guard parameter enforces it).
        fn write_manifest_locked(&self, phase: &MutexGuard<'_, ParkerPhase>) -> Result<(), String> {
            let entries = self.host.fdstore_manifest_sessions();
            self.write_entries_locked(phase, entries)
        }

        /// Serialize `entries` as the manifest. An empty set removes the
        /// file: no manifest is the truthful description of an empty store.
        fn write_entries_locked(
            &self,
            _phase: &MutexGuard<'_, ParkerPhase>,
            entries: Vec<chan_library::terminal_sessions::FdStoreManifestEntry>,
        ) -> Result<(), String> {
            if entries.is_empty() {
                let _ = std::fs::remove_file(&self.manifest_path);
                return Ok(());
            }
            let manifest = RestartManifest {
                version: MANIFEST_VERSION,
                library_id: self.library_id.clone(),
                sessions: entries
                    .into_iter()
                    .map(|entry| ManifestSession {
                        fd_name: entry.fd_name,
                        meta: entry.meta,
                        replay_b64: BASE64.encode(&entry.replay),
                    })
                    .collect(),
            };
            write_manifest(&self.manifest_path, &manifest)
        }

        fn write_if_active(&self) {
            let phase = self.phase.lock().expect("fdstore parker poisoned");
            if *phase != ParkerPhase::Active {
                return;
            }
            if let Err(error) = self.write_manifest_locked(&phase) {
                tracing::warn!(error = %error, "systemd fdstore manifest rewrite failed");
            }
        }
    }

    /// The [`FdStorePark`] hook handed to every tenant registry.
    struct ParkerHook(Arc<ParkerShared>);

    impl FdStorePark for ParkerHook {
        fn park(&self, fd_name: &str, fd: std::os::fd::BorrowedFd<'_>) -> bool {
            let phase = self.0.phase.lock().expect("fdstore parker poisoned");
            if *phase != ParkerPhase::Active {
                return false;
            }
            // One snapshot serves the cap check AND the commit content; the
            // caller's provisional reservation is already in it.
            let entries = self.0.host.fdstore_manifest_sessions();
            if !park_within_cap(entries.len(), self.0.store_max) {
                tracing::warn!(
                    fd_name,
                    parked = entries.len(),
                    store_max = self.0.store_max,
                    "refusing park: the systemd fd store is at capacity"
                );
                return false;
            }
            if let Err(error) = self.0.store.store(fd_name, fd) {
                tracing::warn!(fd_name, error = %error, "storing PTY in systemd fdstore failed");
                return false;
            }
            // A sent FDSTORE datagram is not an accepted one: barrier so a
            // spawn followed immediately by process death cannot outrun
            // manager attribution, and an over-cap rejection surfaces here.
            if let Err(error) = self.0.store.barrier() {
                tracing::warn!(
                    fd_name, error = %error,
                    "systemd did not confirm the stored PTY (notify barrier failed); unparking"
                );
                self.0.store.remove(fd_name);
                return false;
            }
            // The additive commit: the fd name must be durable before the
            // spawn/restart reports success. On failure, roll the store
            // back so no stored fd is ever absent from the manifest.
            if let Err(error) = self.0.write_entries_locked(&phase, entries) {
                tracing::warn!(fd_name, error = %error, "committing fdstore manifest failed; unparking");
                self.0.store.remove(fd_name);
                return false;
            }
            true
        }

        fn unpark(&self, fd_name: &str) {
            self.0.store.remove(fd_name);
            // Removal staleness is safe (a manifest entry without a stored
            // fd is skipped and cleaned at boot), so the rewrite coalesces.
            self.0.dirty.notify_one();
        }

        fn adopt(&self, _fd_name: &str) -> bool {
            // Adoption records an fd the store already retains: valid while
            // booting (Disabled) and serving (Active), refused once sealed.
            *self.0.phase.lock().expect("fdstore parker poisoned") != ParkerPhase::Sealed
        }

        fn changed(&self) {
            self.0.dirty.notify_one();
        }
    }

    /// Owner of continuous parking: installs the hook on the host, runs the
    /// debounced manifest writer, and drives the phase transitions from the
    /// devserver boot/shutdown sequence.
    pub(crate) struct DevserverParker {
        shared: Arc<ParkerShared>,
        writer: tokio::task::JoinHandle<()>,
    }

    impl DevserverParker {
        /// Install parking on `host`. Must run BEFORE the first tenant
        /// mount (the hook reaches registries at mount wiring) and only
        /// under systemd notify (`NOTIFY_SOCKET` present).
        pub(crate) fn install(host: &Arc<WorkspaceHost>, library_id: String) -> Self {
            // Systemd exports the service's actual store ceiling as
            // `$FDSTORE`; older managers do not, so fall back to the value
            // the canonical unit renderer configures.
            let store_max = std::env::var("FDSTORE")
                .ok()
                .and_then(|value| value.parse::<usize>().ok())
                .filter(|max| *max > 0)
                .unwrap_or(UNIT_FDSTORE_MAX);
            Self::install_at(
                host,
                library_id,
                manifest_path(),
                Box::new(SystemdStoreOps),
                store_max,
            )
        }

        fn install_at(
            host: &Arc<WorkspaceHost>,
            library_id: String,
            path: PathBuf,
            store: Box<dyn StoreOps>,
            store_max: usize,
        ) -> Self {
            let shared = Arc::new(ParkerShared {
                host: host.clone(),
                library_id,
                manifest_path: path,
                store,
                store_max,
                phase: Mutex::new(ParkerPhase::Disabled),
                dirty: tokio::sync::Notify::new(),
            });
            host.install_terminal_fd_parker(FdStoreParker::new(ParkerHook(shared.clone())));
            let writer_shared = shared.clone();
            let writer = tokio::spawn(async move {
                loop {
                    writer_shared.dirty.notified().await;
                    tokio::time::sleep(MANIFEST_DEBOUNCE).await;
                    writer_shared.write_if_active();
                }
            });
            Self { shared, writer }
        }

        /// Disabled -> Active, after [`StartupRestore::apply`]: reconcile-park
        /// every session that spawned while parking was disabled, then
        /// rewrite the manifest to the full live parked set (adopted,
        /// reconciled, minus anything that died during boot).
        pub(crate) fn activate(&self) {
            {
                let mut phase = self.shared.phase.lock().expect("fdstore parker poisoned");
                *phase = ParkerPhase::Active;
            }
            self.shared.host.park_unparked_windowed_terminal_sessions();
            self.shared.write_if_active();
        }

        /// Active -> Sealed, at the head of graceful shutdown: refuse
        /// further parks, take the final manifest write, then remove and
        /// detach exactly the parked set. Between the write and the detach
        /// the set can only SHRINK (exit/close unpark), so every fd left
        /// stored for preservation is described by the final manifest.
        pub(crate) fn seal_flush_detach(&self) -> usize {
            {
                let mut phase = self.shared.phase.lock().expect("fdstore parker poisoned");
                *phase = ParkerPhase::Sealed;
                if let Err(error) = self.shared.write_manifest_locked(&phase) {
                    tracing::warn!(error = %error, "final fdstore manifest flush failed; crash-grade restore");
                }
            }
            self.shared.host.detach_parked_terminal_sessions()
        }

        pub(crate) async fn stop(self) {
            self.writer.abort();
            match self.writer.await {
                Ok(()) => {}
                Err(error) if error.is_cancelled() => {}
                Err(error) => {
                    tracing::error!(error = %error, "fdstore manifest writer task failed");
                }
            }
        }
    }

    pub(crate) struct StartupRestore {
        manifest_path: PathBuf,
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
            let mut fd_names = Vec::new();
            let mut fd_by_name = HashMap::new();
            for named in named_fds {
                if named.name.starts_with(FDSTORE_FD_PREFIX) {
                    fd_names.push(named.name.clone());
                    fd_by_name.insert(named.name, named.fd);
                }
            }

            let manifest = std::fs::read(&manifest_path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<RestartManifest>(&bytes).ok());

            let Some(manifest) = manifest else {
                if fd_by_name.is_empty() {
                    return Self::empty(manifest_path);
                }
                // Inherited fds without a readable manifest: no trustworthy
                // session-to-window mapping is left.
                let skipped = fd_names
                    .iter()
                    .map(|name| {
                        format!("inherited fd {name}: restart manifest missing or unreadable")
                    })
                    .collect();
                cleanup_invalid_fds(&fd_names);
                return Self {
                    manifest_path,
                    orphan_fd_names: Vec::new(),
                    cleanup_all_terminal_windows: true,
                    manifest_library_id: None,
                    imports: Vec::new(),
                    skipped,
                    skipped_sessions: Vec::new(),
                };
            };

            if manifest.version != MANIFEST_VERSION {
                // A manifest from another protocol generation (hard swap, no
                // shim): clean up everything it might describe. Works with
                // zero inherited fds too.
                let mut skipped = fd_names
                    .iter()
                    .map(|name| {
                        format!("inherited fd {name}: restart manifest version is unsupported")
                    })
                    .collect::<Vec<_>>();
                let mut skipped_sessions = Vec::new();
                for session in &manifest.sessions {
                    push_skipped_session(
                        &mut skipped,
                        &mut skipped_sessions,
                        &session.meta,
                        "restart manifest version is unsupported",
                    );
                }
                cleanup_invalid_fds(&fd_names);
                return Self {
                    manifest_path,
                    orphan_fd_names: Vec::new(),
                    cleanup_all_terminal_windows: false,
                    manifest_library_id: Some(manifest.library_id),
                    imports: Vec::new(),
                    skipped,
                    skipped_sessions,
                };
            }

            // A live manifest with ZERO inherited chan fds is the bare-stop
            // case: systemd released the store, every session is gone. The
            // not-inherited arm below classifies them all so apply() signals
            // any recorded child a HUP could not kill and reaps the
            // terminal-window rows.
            let mut imports = Vec::new();
            let mut skipped = Vec::new();
            let mut skipped_sessions = Vec::new();
            for session in manifest.sessions {
                let ManifestSession {
                    fd_name,
                    meta,
                    replay_b64,
                } = session;
                if !fd_name.starts_with(FDSTORE_FD_PREFIX) {
                    push_skipped_session(
                        &mut skipped,
                        &mut skipped_sessions,
                        &meta,
                        format!("fd name {fd_name} is outside chan fdstore namespace"),
                    );
                    continue;
                }
                // The name IS the session identity in the store: a corrupt or
                // reassigned mapping must never restore an fd under another
                // session's metadata. Clean the fd by its ACTUAL name here,
                // because apply()'s meta-derived cleanup could not reach it.
                if fd_name != fdstore_fd_name(&meta.session_id, meta.child_pid) {
                    if fd_by_name.remove(&fd_name).is_some() {
                        cleanup_invalid_fds(&[fd_name.clone()]);
                    }
                    push_skipped_session(
                        &mut skipped,
                        &mut skipped_sessions,
                        &meta,
                        format!("fd name {fd_name} does not match its session metadata"),
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
                orphan_fd_names: Vec::new(),
                cleanup_all_terminal_windows: false,
                manifest_library_id: None,
                imports: Vec::new(),
                skipped: Vec::new(),
                skipped_sessions: Vec::new(),
            }
        }

        pub(crate) fn apply(self, state: &DevserverState) {
            if self.orphan_fd_names.is_empty()
                && !self.cleanup_all_terminal_windows
                && self.imports.is_empty()
                && self.skipped.is_empty()
                && self.skipped_sessions.is_empty()
            {
                return;
            }
            let StartupRestore {
                manifest_path,
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
                // Restored sessions ADOPT their store entries (the store
                // retained them across the restart); their fds stay put.
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

            // Remove exactly the fds that will NOT live on: orphans plus
            // every skipped session's deterministic name. Restored sessions
            // keep their entries. (A skipped session whose fd was already
            // cleaned at take() gets a harmless second FDSTOREREMOVE.)
            let mut invalid_fd_names: Vec<String> = orphan_fd_names;
            invalid_fd_names.extend(
                skipped_sessions
                    .iter()
                    .map(|session| fdstore_fd_name(&session.session_id, session.child_pid)),
            );
            if !invalid_fd_names.is_empty() {
                chan_systemd::fdstore_remove_many(invalid_fd_names.iter().map(String::as_str));
            }
            // With nothing restored there is nothing the manifest still
            // protects: delete it so a non-parking boot (foreground with a
            // leftover manifest) cannot re-signal recycled pids forever.
            // With restores, the file stays until the activation rewrite --
            // a crash before that reboots into the same restore.
            if restored == 0 {
                let _ = std::fs::remove_file(&manifest_path);
            }
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

    pub(crate) fn child_pid_from_name(name: &str) -> Option<u32> {
        let suffix = name.strip_prefix(FDSTORE_FD_PREFIX)?;
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

    #[cfg(test)]
    mod parker_tests {
        use super::*;
        use std::sync::atomic::{AtomicBool, Ordering};

        #[derive(Default)]
        struct FakeStoreState {
            calls: Mutex<Vec<String>>,
            fail_store: AtomicBool,
            fail_barrier: AtomicBool,
        }

        #[derive(Clone, Default)]
        struct FakeStoreOps(Arc<FakeStoreState>);

        impl FakeStoreOps {
            fn calls(&self) -> Vec<String> {
                self.0.calls.lock().unwrap().clone()
            }
        }

        impl StoreOps for FakeStoreOps {
            fn store(&self, name: &str, _fd: std::os::fd::BorrowedFd<'_>) -> std::io::Result<()> {
                self.0.calls.lock().unwrap().push(format!("store:{name}"));
                if self.0.fail_store.load(Ordering::Relaxed) {
                    return Err(std::io::Error::other("injected store failure"));
                }
                Ok(())
            }

            fn barrier(&self) -> std::io::Result<()> {
                self.0.calls.lock().unwrap().push("barrier".to_string());
                if self.0.fail_barrier.load(Ordering::Relaxed) {
                    return Err(std::io::Error::other("injected barrier failure"));
                }
                Ok(())
            }

            fn remove(&self, name: &str) {
                self.0.calls.lock().unwrap().push(format!("remove:{name}"));
            }
        }

        fn test_parker(store: FakeStoreOps) -> (DevserverParker, ParkerHook, std::path::PathBuf) {
            let tmp = tempfile::tempdir().unwrap();
            let library = chan_workspace::Library::open_at(tmp.path().join("config.toml")).unwrap();
            let host = Arc::new(WorkspaceHost::new(library, crate::route_builder()));
            let manifest = tmp.path().join("fdstore-restart.json");
            std::mem::forget(tmp);
            let parker = DevserverParker::install_at(
                &host,
                "lib-test".into(),
                manifest.clone(),
                Box::new(store),
                UNIT_FDSTORE_MAX,
            );
            let hook = ParkerHook(parker.shared.clone());
            (parker, hook, manifest)
        }

        #[tokio::test]
        async fn parker_phases_gate_park_adopt_and_writes() {
            let store = FakeStoreOps::default();
            let (parker, hook, manifest) = test_parker(store.clone());
            let devnull = std::fs::File::open("/dev/null").unwrap();

            assert!(
                !hook.park("chan.pty.a.1", devnull.as_fd()),
                "Disabled must refuse park"
            );
            assert!(
                hook.adopt("chan.pty.a.1"),
                "Disabled accepts adoption (boot)"
            );
            assert!(
                store.calls().is_empty(),
                "a refused park must not touch the store"
            );

            parker.activate();
            assert!(
                hook.park("chan.pty.a.1", devnull.as_fd()),
                "Active parks and commits"
            );
            assert_eq!(
                store.calls(),
                vec!["store:chan.pty.a.1".to_string(), "barrier".to_string()],
                "park is store then barrier then commit"
            );
            assert!(
                !manifest.exists(),
                "an empty parked set commits by removing the file"
            );

            assert_eq!(parker.seal_flush_detach(), 0);
            assert!(
                !hook.park("chan.pty.a.2", devnull.as_fd()),
                "Sealed must refuse park"
            );
            assert!(!hook.adopt("chan.pty.a.3"), "Sealed must refuse adoption");
            parker.stop().await;
        }

        #[test]
        fn cap_refuses_exactly_beyond_the_store_maximum() {
            // `parked` includes the candidate's provisional entry.
            assert!(park_within_cap(1, 1));
            assert!(park_within_cap(512, 512));
            assert!(!park_within_cap(513, 512));
            assert!(!park_within_cap(2, 1));
        }

        #[tokio::test]
        async fn barrier_failure_removes_the_submitted_name_and_refuses() {
            let store = FakeStoreOps::default();
            store.0.fail_barrier.store(true, Ordering::Relaxed);
            let (parker, hook, manifest) = test_parker(store.clone());
            parker.activate();
            let devnull = std::fs::File::open("/dev/null").unwrap();

            assert!(
                !hook.park("chan.pty.b.7", devnull.as_fd()),
                "an unconfirmed store must refuse the park"
            );
            assert_eq!(
                store.calls(),
                vec![
                    "store:chan.pty.b.7".to_string(),
                    "barrier".to_string(),
                    "remove:chan.pty.b.7".to_string(),
                ],
                "the submitted name must be removed best-effort"
            );
            assert!(
                !manifest.exists(),
                "no manifest may describe the refused fd"
            );
            parker.stop().await;
        }

        #[tokio::test]
        async fn store_failure_refuses_without_a_remove() {
            let store = FakeStoreOps::default();
            store.0.fail_store.store(true, Ordering::Relaxed);
            let (parker, hook, _manifest) = test_parker(store.clone());
            parker.activate();
            let devnull = std::fs::File::open("/dev/null").unwrap();

            assert!(!hook.park("chan.pty.c.9", devnull.as_fd()));
            assert_eq!(
                store.calls(),
                vec!["store:chan.pty.c.9".to_string()],
                "nothing was stored, so nothing is removed"
            );
            parker.stop().await;
        }

        #[test]
        fn manifest_v2_shape_round_trips_and_v1_is_unsupported() {
            let manifest = RestartManifest {
                version: MANIFEST_VERSION,
                library_id: "lib-test".into(),
                sessions: Vec::new(),
            };
            let bytes = serde_json::to_vec(&manifest).unwrap();
            let parsed: RestartManifest = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(parsed.version, 2);
            assert_eq!(parsed.library_id, "lib-test");

            // A v1 manifest (nonce + TTL era) still PARSES -- serde ignores
            // the retired fields -- and is rejected by the version gate, so
            // the old binary's leftovers route to cleanup, not restore.
            let v1 = serde_json::json!({
                "version": 1,
                "nonce": "abc",
                "library_id": "lib-test",
                "created_unix_secs": 1,
                "sessions": [],
            });
            let parsed: RestartManifest = serde_json::from_value(v1).unwrap();
            assert_ne!(parsed.version, MANIFEST_VERSION);
        }
    }
}

#[cfg(all(target_os = "linux", test))]
pub(super) use linux::child_pid_from_name;
#[cfg(target_os = "linux")]
pub(super) use linux::{notify_ready, spawn_watchdog_pings, DevserverParker, StartupRestore};

#[cfg(not(target_os = "linux"))]
mod unsupported {
    use std::sync::Arc;

    use anyhow::Context;

    use super::{DevserverState, WatchdogPings};
    use crate::WorkspaceHost;

    pub(crate) struct StartupRestore;

    impl StartupRestore {
        pub(crate) fn take() -> Self {
            Self
        }

        pub(crate) fn apply(self, _state: &DevserverState) {}
    }

    /// Non-Linux: no systemd fd store; parking never engages.
    pub(crate) struct DevserverParker;

    impl DevserverParker {
        pub(crate) fn install(_host: &Arc<WorkspaceHost>, _library_id: String) -> Self {
            Self
        }

        pub(crate) fn activate(&self) {}

        pub(crate) fn seal_flush_detach(&self) -> usize {
            0
        }

        pub(crate) async fn stop(self) {}
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
pub(super) use unsupported::{notify_ready, spawn_watchdog_pings, DevserverParker, StartupRestore};

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
