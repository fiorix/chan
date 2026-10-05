//! Continuous systemd fd-store parking for devserver terminals.
//!
//! Every windowed PTY parks its master fd in the systemd fd store at spawn
//! and a maintained restart manifest describes the parked set, so ANY unit
//! restart -- `systemctl --user restart`, `chan devserver restart`, a
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
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex, MutexGuard};
    use std::time::Duration;

    use anyhow::Context;
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
    use chan_library::terminal_sessions::{
        current_boot_id, fdstore_fd_name, fdstore_ring_fd_name, FdStoreManifestEntry, FdStorePark,
        FdStoreParker, FdStoreSessionImport, FdStoreSessionMeta, FdStoreSkippedSession,
        RecordedChildIdentity, FDSTORE_FD_PREFIX, FDSTORE_RING_FD_PREFIX,
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
    /// Bound on the seal's wait for the parked sessions' PTY readers to stop.
    const READER_STOP_WAIT: Duration = Duration::from_secs(2);
    /// Wait from the final writer thread's start, including its wait for the phase lock, leaving room for tenant teardown inside systemd's default 90 second stop budget. A final write stalled under the chan home can continue after this bound.
    const SEAL_WRITE_WAIT: Duration = Duration::from_secs(5);
    /// The cap where the manager exports no `$FDSTORE` and the unit's own
    /// value cannot be read: the smaller maximum chan units have rendered,
    /// since a unit only `chan devserver start|restart` rewrites may still
    /// carry it after an upgrade.
    const FALLBACK_FDSTORE_MAX: usize = 512;

    #[derive(Debug, Serialize, Deserialize)]
    struct RestartManifest {
        version: u32,
        library_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        boot_id: Option<String>,
        /// Whether this is the seal's final write, taken once the parked
        /// sessions' PTY readers stopped or after `READER_STOP_WAIT` with
        /// some still running. Each `seq` is where its session ended, but
        /// for a read a still-running reader records after the write, which
        /// only a ring file keeps. Absent from a manifest written before the
        /// field, which imports as sealed, as it always has.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sealed: Option<bool>,
        sessions: Vec<ManifestSession>,
    }

    #[derive(Debug, Serialize, Deserialize)]
    struct ManifestSession {
        fd_name: String,
        /// The session's ring file, stored beside the PTY master. Absent from
        /// a manifest written before ring files, which restores its tail.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ring_fd_name: Option<String>,
        meta: FdStoreSessionMeta,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        child_start_time: Option<u64>,
        #[serde(default, skip_serializing_if = "String::is_empty")]
        replay_b64: String,
    }

    #[derive(Default)]
    struct RecordedChildren {
        boot_id: Option<String>,
        start_times: HashMap<String, u64>,
    }

    impl RecordedChildren {
        fn from_manifest(manifest: &RestartManifest) -> Self {
            Self {
                boot_id: manifest.boot_id.clone(),
                start_times: manifest
                    .sessions
                    .iter()
                    .filter_map(|session| {
                        // A start time belongs only to its own metadata-derived name.
                        (session.fd_name
                            == fdstore_fd_name(&session.meta.session_id, session.meta.child_pid))
                        .then_some((session.fd_name.clone(), session.child_start_time?))
                    })
                    .collect(),
            }
        }
    }

    /// Parking phases move one way in an activated run: Disabled until boot restore, Active after activation, and Sealed when the final writer takes the phase lock, possibly after detach. Manifest writes occur in Active and in the one final sealed write; only Active accepts parks, while store removals remain valid in every phase.
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
        /// Synchronize with the manager: returning Ok proves it PICKED UP
        /// everything sent so far, `store` included, ordering manager
        /// attribution ahead of whatever follows. `sd_notify(3)` is
        /// fire-and-forget on its own, so without the barrier a datagram
        /// may still sit undelivered when the sender dies. The barrier does
        /// NOT report semantic acceptance -- an over-cap rejection is what
        /// the cap precheck guards against.
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

    /// Whether a park may proceed: `parked` counts the stored fds of the
    /// manifest snapshot INCLUDING the candidate's provisional entry, so a
    /// store already at its maximum refuses the candidate instead of
    /// manifesting an fd the manager would reject.
    fn park_within_cap(parked_including_candidate: usize, store_max: usize) -> bool {
        parked_including_candidate <= store_max
    }

    /// The service's fd-store ceiling from the manager's exported `$FDSTORE`,
    /// else from `installed`, the unit's own configured value, else
    /// [`FALLBACK_FDSTORE_MAX`].
    fn resolve_store_max(
        exported: Option<&str>,
        installed: impl FnOnce() -> Option<usize>,
    ) -> usize {
        exported
            .and_then(|value| value.parse::<usize>().ok())
            .filter(|max| *max > 0)
            .or_else(|| installed().filter(|max| *max > 0))
            .unwrap_or(FALLBACK_FDSTORE_MAX)
    }

    /// The fds `entries` keep in the store: a PTY master each, and a ring
    /// file beside it where the session has one. One session's fds are one
    /// park decision, so a session never parks its PTY without its ring.
    fn stored_fd_count(entries: &[FdStoreManifestEntry]) -> usize {
        entries
            .iter()
            .map(|entry| 1 + usize::from(entry.ring_fd_name.is_some()))
            .sum()
    }

    struct ParkerShared {
        host: Arc<WorkspaceHost>,
        library_id: String,
        manifest_path: PathBuf,
        store: Box<dyn StoreOps>,
        /// The service's fd-store ceiling: systemd's exported `$FDSTORE`
        /// when present, else the canonical unit's FileDescriptorStoreMax.
        store_max: usize,
        /// Serializes manifest writes with phase transitions. A park's commit can finish while the seal stops readers or freezes its snapshot, but a debounced rewrite cannot publish after the final writer has taken this lock.
        phase: Mutex<ParkerPhase>,
        /// Refuse new parks, adoptions, and rewrites from the start of reader stop, without waiting for the phase lock; that lock still serializes commits already in flight and the final write.
        sealing: AtomicBool,
        dirty: tokio::sync::Notify,
        #[cfg(test)]
        before_sealed_write: Mutex<Option<Box<dyn FnOnce() + Send>>>,
        #[cfg(test)]
        before_active_write: Mutex<Option<Box<dyn FnOnce() + Send>>>,
        #[cfg(test)]
        fail_active_spawn: AtomicBool,
        #[cfg(test)]
        fail_seal_spawn: AtomicBool,
        #[cfg(test)]
        after_active_spawn_failure: Mutex<Option<Box<dyn FnOnce() + Send>>>,
        #[cfg(test)]
        before_sealed_snapshot: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    }

    enum ManifestThread {
        Active,
        Seal,
    }

    impl ManifestThread {
        fn name(&self) -> &'static str {
            match self {
                Self::Active => "chan-fdstore-manifest",
                Self::Seal => "chan-fdstore-seal",
            }
        }
    }

    impl ParkerShared {
        fn spawn_manifest_thread(
            &self,
            kind: ManifestThread,
            write: impl FnOnce() + Send + 'static,
        ) -> std::io::Result<std::thread::JoinHandle<()>> {
            #[cfg(test)]
            if match kind {
                ManifestThread::Active => &self.fail_active_spawn,
                ManifestThread::Seal => &self.fail_seal_spawn,
            }
            .swap(false, Ordering::SeqCst)
            {
                return Err(std::io::Error::other(
                    "injected manifest thread spawn failure",
                ));
            }
            std::thread::Builder::new()
                .name(kind.name().into())
                .spawn(write)
        }

        fn seal_entries(&self, entries: Vec<FdStoreManifestEntry>) {
            let mut phase = self.phase.lock().expect("fdstore parker poisoned");
            if *phase == ParkerPhase::Active {
                *phase = ParkerPhase::Sealed;
                if let Err(error) = self.write_entries_locked(&phase, entries) {
                    tracing::warn!(error = %error, "final fdstore manifest flush failed; crash-grade restore");
                }
            } else {
                // An early shutdown preserves the inherited manifest.
                *phase = ParkerPhase::Sealed;
            }
        }

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
            phase: &MutexGuard<'_, ParkerPhase>,
            entries: Vec<FdStoreManifestEntry>,
        ) -> Result<(), String> {
            #[cfg(test)]
            if **phase == ParkerPhase::Sealed {
                let hook = self.before_sealed_write.lock().unwrap().take();
                if let Some(hook) = hook {
                    hook();
                }
            }
            #[cfg(test)]
            if **phase == ParkerPhase::Active {
                let hook = self.before_active_write.lock().unwrap().take();
                if let Some(hook) = hook {
                    hook();
                }
            }
            if entries.is_empty() {
                let _ = std::fs::remove_file(&self.manifest_path);
                return Ok(());
            }
            let manifest = RestartManifest {
                version: MANIFEST_VERSION,
                library_id: self.library_id.clone(),
                boot_id: current_boot_id(),
                sealed: Some(**phase == ParkerPhase::Sealed),
                sessions: entries
                    .iter()
                    .map(|entry| ManifestSession {
                        fd_name: entry.fd_name.clone(),
                        ring_fd_name: entry.ring_fd_name.clone(),
                        child_start_time: entry.meta.child_pid.and(entry.child_start_time),
                        meta: entry.meta.clone(),
                        replay_b64: BASE64.encode(&entry.replay),
                    })
                    .collect(),
            };
            write_manifest(&self.manifest_path, &manifest)?;
            // The generations these entries carry are durable now, which a
            // restore that may end behind its previous process waits for.
            self.host.fdstore_manifest_committed(&entries);
            Ok(())
        }

        fn write_if_active(&self) {
            if self.sealing.load(Ordering::SeqCst) {
                return;
            }
            let phase = self.phase.lock().expect("fdstore parker poisoned");
            if *phase != ParkerPhase::Active || self.sealing.load(Ordering::SeqCst) {
                return;
            }
            if let Err(error) = self.write_manifest_locked(&phase) {
                tracing::warn!(error = %error, "systemd fdstore manifest rewrite failed");
            }
        }
    }

    /// The [`FdStorePark`] hook handed to every tenant registry.
    struct ParkerHook(Arc<ParkerShared>);

    impl ParkerHook {
        fn remove_all(&self, fd_names: &[&str]) {
            for name in fd_names {
                self.0.store.remove(name);
            }
        }
    }

    impl ParkerHook {
        /// Cap check, `FDSTORE` per fd, barrier, then the durable manifest
        /// commit when `commit` asks for it.
        fn store_and_commit(
            &self,
            fds: &[(&str, std::os::fd::BorrowedFd<'_>)],
            commit: bool,
        ) -> bool {
            let Some(&(fd_name, _)) = fds.first() else {
                return false;
            };
            if self.0.sealing.load(Ordering::SeqCst) {
                return false;
            }
            let phase = self.0.phase.lock().expect("fdstore parker poisoned");
            if *phase != ParkerPhase::Active || self.0.sealing.load(Ordering::SeqCst) {
                return false;
            }
            // One snapshot serves the cap check AND the commit content; the
            // caller's provisional reservation is already in it.
            let entries = self.0.host.fdstore_manifest_sessions();
            let stored = stored_fd_count(&entries);
            if !park_within_cap(stored, self.0.store_max) {
                tracing::warn!(
                    fd_name,
                    stored,
                    store_max = self.0.store_max,
                    "refusing park: the systemd fd store is at capacity"
                );
                return false;
            }
            let mut submitted = Vec::with_capacity(fds.len());
            for &(name, fd) in fds {
                if let Err(error) = self.0.store.store(name, fd) {
                    tracing::warn!(fd_name = name, error = %error, "storing a terminal fd in systemd fdstore failed");
                    self.remove_all(&submitted);
                    return false;
                }
                submitted.push(name);
            }
            // Order: cap check, FDSTORE per fd, barrier, durable manifest
            // commit. The barrier proves the manager picked the submissions
            // up, so a spawn followed immediately by process death cannot
            // outrun manager attribution; over-cap rejection is excluded by
            // the precheck above, not here.
            if let Err(error) = self.0.store.barrier() {
                tracing::warn!(
                    fd_name, error = %error,
                    "the manager did not pick up the stored terminal fds (notify barrier failed); unparking"
                );
                self.remove_all(&submitted);
                return false;
            }
            if !commit {
                return true;
            }
            // The additive commit: the fd names must be durable before the
            // spawn/restart reports success. On failure, roll the store
            // back so no stored fd is ever absent from the manifest.
            if let Err(error) = self.0.write_entries_locked(&phase, entries) {
                tracing::warn!(fd_name, error = %error, "committing fdstore manifest failed; unparking");
                self.remove_all(&submitted);
                return false;
            }
            true
        }
    }

    impl FdStorePark for ParkerHook {
        fn park(&self, fds: &[(&str, std::os::fd::BorrowedFd<'_>)]) -> bool {
            self.store_and_commit(fds, true)
        }

        /// The stored fds stay stored when the caller's later commit fails:
        /// the manifest names them at the next write that succeeds, and a
        /// boot before one removes them as fds its manifest does not name.
        fn park_deferring_commit(&self, fds: &[(&str, std::os::fd::BorrowedFd<'_>)]) -> bool {
            self.store_and_commit(fds, false)
        }

        fn unpark(&self, fd_names: &[&str]) {
            self.remove_all(fd_names);
            // Removal staleness is safe (a manifest entry without a stored
            // fd is skipped and cleaned at boot), so the rewrite coalesces.
            self.0.dirty.notify_one();
        }

        fn adopt(&self, _fd_name: &str) -> bool {
            // Adoption records an fd the store already retains: valid while
            // booting (Disabled) and serving (Active), refused once sealed.
            if self.0.sealing.load(Ordering::SeqCst) {
                return false;
            }
            let phase = self.0.phase.lock().expect("fdstore parker poisoned");
            *phase != ParkerPhase::Sealed && !self.0.sealing.load(Ordering::SeqCst)
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
            let store_max = resolve_store_max(
                std::env::var("FDSTORE").ok().as_deref(),
                chan_systemd::own_unit_fdstore_max,
            );
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
                sealing: AtomicBool::new(false),
                dirty: tokio::sync::Notify::new(),
                #[cfg(test)]
                before_sealed_write: Mutex::new(None),
                #[cfg(test)]
                before_active_write: Mutex::new(None),
                #[cfg(test)]
                fail_active_spawn: AtomicBool::new(false),
                #[cfg(test)]
                fail_seal_spawn: AtomicBool::new(false),
                #[cfg(test)]
                after_active_spawn_failure: Mutex::new(None),
                #[cfg(test)]
                before_sealed_snapshot: Mutex::new(None),
            });
            host.install_terminal_fd_parker(FdStoreParker::new(ParkerHook(shared.clone())));
            let writer_shared = shared.clone();
            let writer = tokio::spawn(async move {
                loop {
                    writer_shared.dirty.notified().await;
                    tokio::time::sleep(MANIFEST_DEBOUNCE).await;
                    // A synchronous write under the chan home can stop
                    // answering. Aborting this task on quit must not wait
                    // for that OS thread to return.
                    let shared = writer_shared.clone();
                    let (done, finished) = tokio::sync::oneshot::channel();
                    match writer_shared.spawn_manifest_thread(ManifestThread::Active, move || {
                        shared.write_if_active();
                        let _ = done.send(());
                    }) {
                        Ok(_thread) => {
                            if finished.await.is_err() {
                                tracing::error!(
                                    "fdstore manifest writer ended before reporting completion"
                                );
                            }
                        }
                        Err(error) => {
                            tracing::warn!(%error, "spawning fdstore manifest writer failed");
                            writer_shared.write_if_active();
                            #[cfg(test)]
                            if let Some(hook) = writer_shared
                                .after_active_spawn_failure
                                .lock()
                                .unwrap()
                                .take()
                            {
                                hook();
                            }
                        }
                    }
                }
            });
            Self { shared, writer }
        }

        #[cfg(test)]
        pub(crate) fn arm_sealed_write_for_test(&self, hook: impl FnOnce() + Send + 'static) {
            *self.shared.before_sealed_write.lock().unwrap() = Some(Box::new(hook));
        }

        #[cfg(test)]
        pub(crate) fn arm_active_write_for_test(&self, hook: impl FnOnce() + Send + 'static) {
            *self.shared.before_active_write.lock().unwrap() = Some(Box::new(hook));
        }

        #[cfg(test)]
        pub(crate) fn fail_next_seal_spawn_for_test(&self) {
            self.shared.fail_seal_spawn.store(true, Ordering::SeqCst);
        }

        #[cfg(test)]
        pub(crate) fn seal_spawn_failure_pending_for_test(&self) -> bool {
            self.shared.fail_seal_spawn.load(Ordering::SeqCst)
        }

        #[cfg(test)]
        pub(crate) fn seal_flush_detach_with_wait(&self, wait: Duration) -> usize {
            self.seal_flush_detach_bounded(wait)
        }

        /// Disabled -> Active, after [`StartupRestore::apply`], which follows
        /// the whole startup restore: reconcile-park every session that
        /// spawned while parking was disabled, in the tenants that opened
        /// before it as well, then rewrite the manifest to the full live
        /// parked set (adopted, reconciled, minus anything that died during
        /// boot). The reconcile's parks store without committing, so this
        /// rewrite is activation's one manifest commit. It does not run
        /// earlier: a rewrite before every inherited session has found its
        /// tenant would drop the ones still waiting from the manifest.
        pub(crate) fn activate(&self) {
            {
                let mut phase = self.shared.phase.lock().expect("fdstore parker poisoned");
                *phase = ParkerPhase::Active;
            }
            self.shared.host.park_unparked_windowed_terminal_sessions();
            self.shared.write_if_active();
        }

        /// Seal parking at the head of graceful shutdown: refuse new parks, adoptions, and rewrites; wait at most two seconds for parked readers; freeze the parked set; and detach it before tenant teardown. The final writer gets five seconds from its thread start, including its wait for the phase lock. A write still running at that bound continues without a join and may publish the frozen manifest after detach if the process remains alive. A failed thread start writes on this caller instead, outside the bound.
        ///
        /// A park already in flight when sealing begins can fail after the frozen snapshot names it. The next start then skips a named session with no stored descriptor. If the final write does not publish before exit, the next start reads the last unsealed manifest or none: it imports only sessions with matching stored descriptors from a stale manifest, or cleans inherited descriptors and terminal windows when inherited descriptors have a missing or unreadable manifest.
        ///
        /// Before activation the inherited manifest stays untouched because the mounted tenant set is incomplete; restored sessions still detach against it.
        pub(crate) fn seal_flush_detach(&self) -> usize {
            self.seal_flush_detach_bounded(SEAL_WRITE_WAIT)
        }

        fn seal_flush_detach_bounded(&self, wait: Duration) -> usize {
            self.shared.sealing.store(true, Ordering::SeqCst);
            #[cfg(test)]
            if let Some(hook) = self.shared.before_sealed_snapshot.lock().unwrap().take() {
                hook();
            }
            // Readers stop before the snapshot: anything they read after a
            // final write would reach no socket or manifest. A reader still
            // running at the bound keeps later bytes in its ring file.
            let running = self
                .shared
                .host
                .stop_parked_terminal_readers(READER_STOP_WAIT);
            if running > 0 {
                tracing::warn!(
                    running,
                    "PTY readers still running at fdstore seal; a session with a ring file keeps what they read after it there, one without loses it"
                );
            }
            // Freeze the parked set before detach, so a worker released after
            // the wait still writes the selected sessions, not an empty set.
            let entries = self.shared.host.fdstore_manifest_sessions();
            let shared = self.shared.clone();
            let (done, finished) = std::sync::mpsc::sync_channel(1);
            let (entries_tx, entries_rx) = std::sync::mpsc::sync_channel(1);
            match self
                .shared
                .spawn_manifest_thread(ManifestThread::Seal, move || {
                    if let Ok(entries) = entries_rx.recv() {
                        shared.seal_entries(entries);
                        let _ = done.send(());
                    }
                }) {
                Ok(_thread) => {
                    match entries_tx.send(entries) {
                        Ok(()) => match finished.recv_timeout(wait) {
                            Ok(()) => {}
                            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                                tracing::warn!(
                                    "final fdstore manifest flush did not finish before detach"
                                );
                            }
                            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                                tracing::error!("final fdstore manifest writer ended before reporting completion");
                            }
                        },
                        Err(error) => {
                            tracing::error!(
                                "final fdstore manifest writer ended before receiving its snapshot"
                            );
                            self.shared.seal_entries(error.0);
                        }
                    }
                }
                Err(error) => {
                    tracing::warn!(%error, "spawning final fdstore manifest writer failed");
                    self.shared.seal_entries(entries);
                }
            }
            self.shared.host.detach_parked_terminal_sessions()
        }

        /// Abort the debounced task without joining a detached OS writer thread. A failed-spawn write running on the task thread must return before the abort can finish; the final writer may also continue after its five-second wait.
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
        recorded_children: RecordedChildren,
        imports: Vec<FdStoreSessionImport>,
        skipped: Vec<String>,
        skipped_sessions: Vec<FdStoreSkippedSession>,
        /// What the applies of single tenants have restored and given up so
        /// far, kept for the last apply's cleanup and its one summary.
        restored: usize,
        abandoned_ring_fds: Vec<String>,
    }

    impl StartupRestore {
        pub(crate) fn take() -> Self {
            Self::from_inherited(manifest_path(), chan_systemd::take_listen_fds())
        }

        /// Pair the fds a restart handed down with the manifest at
        /// `manifest_path`.
        fn from_inherited(manifest_path: PathBuf, named_fds: Vec<chan_systemd::NamedFd>) -> Self {
            // Every chan name, PTY masters and ring files alike, for the
            // paths that clean up whatever was inherited. Only a PTY name
            // parses to a child pid, so a ring name never authorizes a signal.
            let mut fd_names = Vec::new();
            let mut fd_by_name = HashMap::new();
            let mut ring_fd_by_name = HashMap::new();
            for named in named_fds {
                if named.name.starts_with(FDSTORE_FD_PREFIX) {
                    fd_names.push(named.name.clone());
                    fd_by_name.insert(named.name, named.fd);
                } else if named.name.starts_with(FDSTORE_RING_FD_PREFIX) {
                    fd_names.push(named.name.clone());
                    ring_fd_by_name.insert(named.name, named.fd);
                }
            }

            let manifest = std::fs::read(&manifest_path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<RestartManifest>(&bytes).ok());

            let Some(manifest) = manifest else {
                if fd_names.is_empty() {
                    return Self::empty(manifest_path);
                }
                // Inherited fds without a readable manifest: no trustworthy
                // session-to-window mapping is left.
                let mut skipped = fd_names
                    .iter()
                    .map(|name| {
                        format!("inherited fd {name}: restart manifest missing or unreadable")
                    })
                    .collect();
                cleanup_invalid_fds(&fd_names, &RecordedChildren::default(), &mut skipped);
                return Self {
                    cleanup_all_terminal_windows: true,
                    skipped,
                    ..Self::empty(manifest_path)
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
                cleanup_invalid_fds(&fd_names, &RecordedChildren::default(), &mut skipped);
                return Self {
                    manifest_library_id: Some(manifest.library_id),
                    skipped,
                    skipped_sessions,
                    ..Self::empty(manifest_path)
                };
            }

            // Without inherited masters, cleanup can still signal a recorded
            // child whose boot and process start identity remain verifiable.
            let recorded_children = RecordedChildren::from_manifest(&manifest);
            let mut imports = Vec::new();
            let mut skipped = Vec::new();
            let mut skipped_sessions = Vec::new();
            let sealed_manifest = manifest.sealed.unwrap_or(true);
            for session in manifest.sessions {
                let ManifestSession {
                    fd_name,
                    ring_fd_name,
                    meta,
                    child_start_time,
                    replay_b64,
                } = session;
                // Claimed before any skip, so a skipped session's ring file
                // is closed with it rather than reported as an orphan. Only
                // the name derived from the session's own metadata is its
                // ring; any other is left to the orphan cleanup.
                let ring_fd = ring_fd_name
                    .filter(|name| *name == fdstore_ring_fd_name(&meta.session_id, meta.child_pid))
                    .and_then(|name| ring_fd_by_name.remove(&name));
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
                        cleanup_invalid_fds(
                            std::slice::from_ref(&fd_name),
                            &recorded_children,
                            &mut skipped,
                        );
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
                    child_identity: RecordedChildIdentity {
                        boot_id: manifest.boot_id.clone(),
                        start_time: child_start_time,
                    },
                    master_fd,
                    ring_fd,
                    replay,
                    sealed_manifest,
                });
            }
            let orphan_fd_names: Vec<String> = fd_by_name
                .keys()
                .chain(ring_fd_by_name.keys())
                .cloned()
                .collect();
            skipped.extend(
                orphan_fd_names
                    .iter()
                    .map(|name| format!("inherited fd {name}: no matching manifest entry")),
            );

            Self {
                orphan_fd_names,
                manifest_library_id: Some(manifest.library_id),
                recorded_children,
                imports,
                skipped,
                skipped_sessions,
                ..Self::empty(manifest_path)
            }
        }

        /// An inherited state that holds `imports` and nothing else, as a
        /// restart's manifest for `library_id` would have described them.
        #[cfg(test)]
        pub(crate) fn of_sessions(
            manifest_path: PathBuf,
            library_id: &str,
            imports: Vec<FdStoreSessionImport>,
        ) -> Self {
            Self {
                manifest_library_id: Some(library_id.to_string()),
                imports,
                ..Self::empty(manifest_path)
            }
        }

        fn empty(manifest_path: PathBuf) -> Self {
            Self {
                manifest_path,
                orphan_fd_names: Vec::new(),
                cleanup_all_terminal_windows: false,
                manifest_library_id: None,
                recorded_children: RecordedChildren::default(),
                imports: Vec::new(),
                skipped: Vec::new(),
                skipped_sessions: Vec::new(),
                restored: 0,
                abandoned_ring_fds: Vec::new(),
            }
        }

        /// The tenant prefixes the inherited sessions name.
        pub(crate) fn session_prefixes(&self) -> HashSet<String> {
            self.imports
                .iter()
                .map(|import| import.meta.tenant_prefix.clone())
                .collect()
        }

        /// Restore the inherited sessions that name the tenant mounted at
        /// `prefix`, and no other. Every other session stays as inherited,
        /// neither restored nor given up, with its fds in the store, for a
        /// later call or for [`apply`](Self::apply). What this restore
        /// skips or abandons is cleaned up there too, once for the whole
        /// start. A manifest written for another library restores nothing
        /// here: `apply` gives all of it up.
        pub(crate) fn apply_prefix(&mut self, state: &DevserverState, prefix: &str) {
            if self.manifest_library_id.as_deref() != Some(state.library_id.as_str()) {
                return;
            }
            let (named, rest): (Vec<_>, Vec<_>) = std::mem::take(&mut self.imports)
                .into_iter()
                .partition(|import| import.meta.tenant_prefix == prefix);
            self.imports = rest;
            if named.is_empty() {
                return;
            }
            let report = state.host.restore_fdstore_terminal_sessions(named);
            self.restored += report.restored;
            self.skipped.extend(report.skipped);
            self.skipped_sessions.extend(report.skipped_sessions);
            self.abandoned_ring_fds.extend(report.abandoned_ring_fds);
        }

        /// Apply what is left of the inherited state, once the whole restore
        /// has ended: restore the sessions no tenant has taken yet, by their
        /// prefix and then by their window, give up the ones no mounted
        /// tenant takes, signal the children of those and of orphaned fds,
        /// remove from the store every fd that will not live on, and delete
        /// the manifest when nothing was restored at all.
        pub(crate) fn apply(self, state: &DevserverState) {
            if self.orphan_fd_names.is_empty()
                && !self.cleanup_all_terminal_windows
                && self.imports.is_empty()
                && self.skipped.is_empty()
                && self.skipped_sessions.is_empty()
                && self.restored == 0
                && self.abandoned_ring_fds.is_empty()
            {
                return;
            }
            let StartupRestore {
                manifest_path,
                orphan_fd_names,
                cleanup_all_terminal_windows,
                manifest_library_id,
                recorded_children,
                imports,
                mut skipped,
                mut skipped_sessions,
                mut restored,
                mut abandoned_ring_fds,
            } = self;

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
                restored += report.restored;
                skipped.extend(report.skipped);
                skipped_sessions.extend(report.skipped_sessions);
                abandoned_ring_fds.extend(report.abandoned_ring_fds);
            }

            if !orphan_fd_names.is_empty() {
                signal_children_from_names(&orphan_fd_names, &recorded_children, &mut skipped);
            }
            cleanup_skipped_session_children(&skipped_sessions, &recorded_children, &mut skipped);
            if cleanup_all_terminal_windows {
                skipped.extend(state.host.cleanup_fdstore_metadata_loss_terminal_windows());
            }
            skipped.extend(
                state
                    .host
                    .cleanup_skipped_fdstore_sessions(&skipped_sessions),
            );

            // Remove exactly the fds that will NOT live on: orphans, every
            // skipped session's deterministic names, its PTY and its ring
            // file, and the ring files restored sessions gave up on, which
            // activation replaces under the same name. Restored sessions keep
            // their other entries. (A skipped
            // session whose fd was already cleaned at take(), or that parked
            // no ring file, gets a harmless FDSTOREREMOVE for a name the
            // store does not hold.)
            let invalid_fd_names =
                fds_to_remove(orphan_fd_names, &skipped_sessions, abandoned_ring_fds);
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

    fn fds_to_remove(
        orphan_fd_names: Vec<String>,
        skipped_sessions: &[FdStoreSkippedSession],
        abandoned_ring_fds: Vec<String>,
    ) -> Vec<String> {
        let mut names = orphan_fd_names;
        names.extend(abandoned_ring_fds);
        names.extend(skipped_sessions.iter().flat_map(|session| {
            [
                fdstore_fd_name(&session.session_id, session.child_pid),
                fdstore_ring_fd_name(&session.session_id, session.child_pid),
            ]
        }));
        names
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

    fn signal_child(
        pid: u32,
        recorded_boot: Option<&str>,
        current_boot: Option<&str>,
        recorded_start: Option<u64>,
    ) -> Result<(), String> {
        let pidfd = RecordedChildIdentity {
            boot_id: recorded_boot.map(str::to_owned),
            start_time: recorded_start,
        }
        .pin(pid, current_boot)?;
        let _ = rustix::process::pidfd_send_signal(&pidfd, rustix::process::Signal::HUP);
        let _ = rustix::process::pidfd_send_signal(&pidfd, rustix::process::Signal::TERM);
        Ok(())
    }

    fn signal_children_from_names(
        fd_names: &[String],
        recorded: &RecordedChildren,
        skipped: &mut Vec<String>,
    ) {
        let current_boot = current_boot_id();
        let mut seen = HashSet::new();
        for name in fd_names {
            let Some(pid) = child_pid_from_name(name) else {
                continue;
            };
            if seen.insert(pid) {
                if let Err(reason) = signal_child(
                    pid,
                    recorded.boot_id.as_deref(),
                    current_boot.as_deref(),
                    recorded.start_times.get(name).copied(),
                ) {
                    skipped.push(format!("pid {pid}: explicit signal skipped: {reason}"));
                }
            }
        }
    }

    fn cleanup_skipped_session_children(
        sessions: &[FdStoreSkippedSession],
        recorded: &RecordedChildren,
        skipped: &mut Vec<String>,
    ) {
        let names: Vec<_> = sessions
            .iter()
            .filter(|session| session.child_pid.is_some())
            .map(|session| fdstore_fd_name(&session.session_id, session.child_pid))
            .collect();
        signal_children_from_names(&names, recorded, skipped);
    }

    fn cleanup_invalid_fds(
        fd_names: &[String],
        recorded: &RecordedChildren,
        skipped: &mut Vec<String>,
    ) {
        signal_children_from_names(fd_names, recorded, skipped);
        chan_systemd::fdstore_remove_many(fd_names.iter().map(String::as_str));
    }

    fn write_manifest(path: &Path, manifest: &RestartManifest) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(manifest).map_err(|e| e.to_string())?;
        crate::atomic_file::write(path, &bytes, Some(0o600)).map_err(|e| e.to_string())
    }

    #[cfg(test)]
    mod parker_tests {
        use super::*;
        use std::sync::atomic::{AtomicBool, Ordering};

        #[test]
        fn manifest_write_keeps_new_and_replaced_files_private() {
            use std::os::unix::fs::PermissionsExt;
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("fdstore-restart.json");
            let manifest = RestartManifest {
                version: MANIFEST_VERSION,
                library_id: "lib-test".into(),
                boot_id: None,
                sealed: None,
                sessions: Vec::new(),
            };
            write_manifest(&path, &manifest).unwrap();
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
            write_manifest(&path, &manifest).unwrap();
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            let published: RestartManifest =
                serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            assert_eq!(published.library_id, manifest.library_id);
        }

        #[test]
        fn manifest_atomic_writer_sets_mode_before_persist() {
            use std::os::unix::fs::PermissionsExt;
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("fdstore-restart.json");
            let manifest = RestartManifest {
                version: MANIFEST_VERSION,
                library_id: "lib-test".into(),
                boot_id: None,
                sealed: None,
                sessions: Vec::new(),
            };
            let bytes = serde_json::to_vec_pretty(&manifest).unwrap();
            for prior in [None, Some(b"prior manifest".as_slice())] {
                if let Some(prior) = prior {
                    std::fs::write(&path, prior).unwrap();
                }
                crate::atomic_file::write_with_pre_persist_hook(
                    &path,
                    &bytes,
                    Some(0o600),
                    |tmp| {
                        assert_ne!(tmp, path);
                        assert_eq!(std::fs::metadata(tmp)?.permissions().mode() & 0o777, 0o600);
                        assert_eq!(std::fs::read(tmp)?, bytes);
                        if let Some(prior) = prior {
                            assert_eq!(std::fs::read(&path)?, prior);
                        } else {
                            assert!(!path.exists());
                        }
                        Ok(())
                    },
                )
                .unwrap();
                assert_eq!(std::fs::read(&path).unwrap(), bytes);
                assert_eq!(
                    std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                    0o600
                );
            }
        }

        #[tokio::test]
        async fn orphan_fd_names_do_not_authorize_signals() {
            let mut child = tokio::process::Command::new("sleep")
                .arg("60")
                .kill_on_drop(true)
                .spawn()
                .unwrap();
            let name = fdstore_fd_name("orphan", child.id());
            let mut skipped = Vec::new();
            signal_children_from_names(
                &[name],
                &RecordedChildren {
                    boot_id: current_boot_id(),
                    ..RecordedChildren::default()
                },
                &mut skipped,
            );
            assert!(skipped
                .iter()
                .any(|reason| reason.contains("no recorded start time")));
            tokio::time::sleep(Duration::from_millis(150)).await;
            assert!(
                child.try_wait().unwrap().is_none(),
                "an orphan fd name killed an unverified child"
            );
        }

        #[tokio::test]
        async fn invalid_fd_names_do_not_authorize_signals() {
            let mut child = tokio::process::Command::new("sleep")
                .arg("60")
                .kill_on_drop(true)
                .spawn()
                .unwrap();
            let name = fdstore_fd_name("invalid", child.id());
            let mut skipped = Vec::new();
            cleanup_invalid_fds(&[name], &RecordedChildren::default(), &mut skipped);
            assert!(skipped
                .iter()
                .any(|reason| reason.contains("manifest boot id is missing")));
            tokio::time::sleep(Duration::from_millis(150)).await;
            assert!(
                child.try_wait().unwrap().is_none(),
                "an invalid fd name killed an unverified child"
            );
        }

        #[tokio::test]
        async fn releasing_the_last_pty_master_hangs_up_its_child() {
            use std::io::Read;
            let pair = portable_pty::native_pty_system()
                .openpty(portable_pty::PtySize::default())
                .unwrap();
            let mut command = portable_pty::CommandBuilder::new("sh");
            command.args(["-c", "printf ready; exec sleep 60"]);
            let mut child = pair.slave.spawn_command(command).unwrap();
            drop(pair.slave);
            let mut reader = pair.master.try_clone_reader().unwrap();
            let mut ready = [0; 5];
            reader.read_exact(&mut ready).unwrap();
            assert_eq!(&ready, b"ready");
            drop(reader);
            drop(pair.master);
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            let status = loop {
                if let Some(status) = child.try_wait().unwrap() {
                    break Some(status);
                }
                if std::time::Instant::now() >= deadline {
                    break None;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            };
            if status.is_none() {
                let _ = child.kill();
            }
            let _ = child.wait();
            assert!(
                status.is_some(),
                "last master close did not hang up its child"
            );
            eprintln!("last master close: {status:?}");
            assert!(!status.unwrap().success());
        }

        #[test]
        fn old_format_manifest_preserves_restore_metadata_and_replay() {
            let name = fdstore_fd_name("legacy", None);
            let legacy = serde_json::json!({
                "version": 2, "library_id": "lib-test",
                "sessions": [{
                    "fd_name": name,
                    "meta": {
                        "tenant_prefix": "/t/terminals", "session_id": "legacy",
                        "env": {}, "mcp_env": false, "child_pid": null,
                        "size": { "rows": 24, "cols": 80, "pixel_width": 0, "pixel_height": 0 },
                        "seq": 0, "generation": 0, "alt_screen": false, "private_modes": [],
                    },
                    "replay_b64": BASE64.encode(b"legacy replay"),
                }],
            });
            let manifest: RestartManifest = serde_json::from_value(legacy).unwrap();
            assert_eq!(manifest.version, MANIFEST_VERSION);
            assert_eq!(manifest.sessions.len(), 1);
            assert_eq!(manifest.sessions[0].fd_name, name);
            assert_eq!(
                manifest.sessions[0].ring_fd_name, None,
                "a manifest from before ring files restores its tail"
            );
            assert_eq!(manifest.sessions[0].meta.session_id, "legacy");
            assert_eq!(manifest.sessions[0].meta.size.rows, 24);
            let mut skipped = Vec::new();
            assert_eq!(
                decode_replay(
                    &manifest.sessions[0].replay_b64,
                    &manifest.sessions[0].meta,
                    &mut skipped
                ),
                b"legacy replay"
            );
            assert!(skipped.is_empty());
            let recorded = RecordedChildren::from_manifest(&manifest);
            assert!(recorded.boot_id.is_none());
            assert!(recorded.start_times.is_empty());
        }

        #[derive(Default)]
        struct FakeStoreState {
            calls: Mutex<Vec<String>>,
            fail_store: AtomicBool,
            /// Fail only the store of this one name.
            fail_store_name: Mutex<Option<String>>,
            fail_barrier: AtomicBool,
            /// A duplicate of every fd stored and not removed, by name.
            fds: Mutex<HashMap<String, std::os::fd::OwnedFd>>,
        }

        #[derive(Clone, Default)]
        struct FakeStoreOps(Arc<FakeStoreState>);

        impl FakeStoreOps {
            fn calls(&self) -> Vec<String> {
                self.0.calls.lock().unwrap().clone()
            }

            /// The contents of the file stored under `name`.
            fn stored_file(&self, name: &str) -> Vec<u8> {
                use std::io::Read;
                let fds = self.0.fds.lock().unwrap();
                let fd = fds.get(name).expect("a stored fd").try_clone().unwrap();
                let mut bytes = Vec::new();
                std::fs::File::from(fd).read_to_end(&mut bytes).unwrap();
                bytes
            }
        }

        impl StoreOps for FakeStoreOps {
            fn store(&self, name: &str, fd: std::os::fd::BorrowedFd<'_>) -> std::io::Result<()> {
                self.0.calls.lock().unwrap().push(format!("store:{name}"));
                if self.0.fail_store.load(Ordering::Relaxed)
                    || self.0.fail_store_name.lock().unwrap().as_deref() == Some(name)
                {
                    return Err(std::io::Error::other("injected store failure"));
                }
                self.0
                    .fds
                    .lock()
                    .unwrap()
                    .insert(name.to_string(), fd.try_clone_to_owned()?);
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
                self.0.fds.lock().unwrap().remove(name);
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
                chan_systemd::DEVSERVER_FDSTORE_MAX,
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
                !hook.park(&[("chan.pty.a.1", devnull.as_fd())]),
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
                hook.park(&[("chan.pty.a.1", devnull.as_fd())]),
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
                !hook.park(&[("chan.pty.a.2", devnull.as_fd())]),
                "Sealed must refuse park"
            );
            assert!(!hook.adopt("chan.pty.a.3"), "Sealed must refuse adoption");
            parker.stop().await;
        }

        #[tokio::test]
        async fn a_deferred_park_stores_and_barriers_without_a_commit() {
            let store = FakeStoreOps::default();
            let (parker, hook, manifest) = test_parker(store.clone());
            let devnull = std::fs::File::open("/dev/null").unwrap();
            assert!(
                !hook.park_deferring_commit(&[("chan.pty.a.1", devnull.as_fd())]),
                "Disabled must refuse a deferred park"
            );

            parker.activate();
            // An empty host commits by removing the file, so a manifest still
            // on disk after the park shows it was not committed.
            std::fs::write(&manifest, b"the previous manifest").unwrap();
            assert!(hook.park_deferring_commit(&[("chan.pty.a.1", devnull.as_fd())]));
            assert_eq!(
                store.calls(),
                vec!["store:chan.pty.a.1".to_string(), "barrier".to_string()],
                "a deferred park is store then barrier"
            );
            assert_eq!(
                std::fs::read(&manifest).unwrap(),
                b"the previous manifest",
                "a deferred park leaves the manifest to the caller's commit"
            );
            assert!(hook.park(&[("chan.pty.a.2", devnull.as_fd())]));
            assert!(!manifest.exists(), "a park commits");
            parker.stop().await;
        }

        #[tokio::test]
        async fn a_seal_refuses_park_commits_before_its_snapshot() {
            let store = FakeStoreOps::default();
            let (parker, hook, _manifest) = test_parker(store.clone());
            parker.activate();
            let (entered_tx, entered_rx) = std::sync::mpsc::channel();
            let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
            *parker.shared.before_sealed_snapshot.lock().unwrap() = Some(Box::new(move || {
                let _ = entered_tx.send(());
                let _ = release_rx.recv_timeout(Duration::from_secs(15));
            }));
            let parker = Arc::new(parker);
            let sealing = {
                let parker = parker.clone();
                std::thread::spawn(move || parker.seal_flush_detach())
            };
            entered_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("seal reached the snapshot seam");
            let before = store.calls();
            let devnull = std::fs::File::open("/dev/null").unwrap();
            let parked = hook.park(&[("chan.pty.late.1", devnull.as_fd())]);
            let adopted = hook.adopt("chan.pty.late.2");
            let after = store.calls();
            drop(release_tx);
            sealing.join().expect("seal caller");
            Arc::try_unwrap(parker)
                .unwrap_or_else(|_| panic!("seal worker retained the parker"))
                .stop()
                .await;

            assert!(!parked, "a park starting after the seal must be refused");
            assert!(
                !adopted,
                "an adoption starting after the seal must be refused"
            );
            assert_eq!(
                after, before,
                "a refused park must leave the store untouched"
            );
        }

        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn a_held_seal_write_refuses_rewrites_and_parks() {
            let (parker, hook, _manifest) = test_parker(FakeStoreOps::default());
            parker.activate();
            let (entered_tx, entered_rx) = std::sync::mpsc::channel();
            let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
            let (left_tx, left_rx) = std::sync::mpsc::channel();
            parker.arm_sealed_write_for_test(move || {
                let _ = entered_tx.send(());
                let _ = release_rx.recv_timeout(Duration::from_secs(20));
                let _ = left_tx.send(());
            });
            let parker = Arc::new(parker);
            let sealing = {
                let parker = parker.clone();
                std::thread::spawn(move || parker.seal_flush_detach())
            };
            entered_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("sealed write entered the hold");

            let (rewrite_tx, rewrite_rx) = std::sync::mpsc::channel();
            let shared = parker.shared.clone();
            let rewrite = std::thread::spawn(move || {
                shared.write_if_active();
                let _ = rewrite_tx.send(());
            });
            let (park_tx, park_rx) = std::sync::mpsc::channel();
            let park = std::thread::spawn(move || {
                let devnull = std::fs::File::open("/dev/null").unwrap();
                let accepted = hook.park(&[("chan.pty.late.1", devnull.as_fd())]);
                let _ = park_tx.send(accepted);
            });
            let rewrite_done = rewrite_rx.recv_timeout(Duration::from_secs(5));
            let park_result = park_rx.recv_timeout(Duration::from_secs(5));
            let write_still_held = left_rx.try_recv().is_err();
            drop(release_tx);
            sealing.join().expect("seal caller");
            rewrite.join().expect("rewrite caller");
            park.join().expect("park caller");
            Arc::try_unwrap(parker)
                .unwrap_or_else(|_| panic!("seal worker retained the parker"))
                .stop()
                .await;

            assert!(
                rewrite_done.is_ok(),
                "a rewrite starting after the seal must return while its write is held"
            );
            assert!(
                !park_result.expect("park returns while the sealed write is held"),
                "a park starting after the seal must be refused while its write is held"
            );
            assert!(write_still_held, "the sealed write was released early");
        }

        /// Output the PTY emitted before a graceful restart's seal must reach
        /// what the next process restores: a reader holding a read it has not
        /// recorded yet is exactly the window the seal must wait out, since a
        /// read recorded after the final write reaches no manifest and no
        /// socket. The session's ring file holds the read, and the final
        /// manifest, marked sealed, counts it in the `seq` the file must reach.
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn the_sealed_manifest_counts_a_read_the_reader_still_holds() {
            use axum::body::Body;
            use axum::http::{Request, StatusCode};
            use chan_library::terminal_sessions::{arm_attach_seam, AttachSeam};
            use chan_library::windows::WindowRegistry;
            use tower::ServiceExt;

            let store = FakeStoreOps::default();
            let (parker, _hook, manifest) = test_parker(store.clone());
            let host = parker.shared.host.clone();
            let windows = tempfile::tempdir().unwrap();
            host.install_window_registry(
                Arc::new(WindowRegistry::open(windows.path().join("windows.json"))),
                "lib-test".into(),
            );
            let mut config =
                crate::devserver::tenant_config("127.0.0.1:0".parse().unwrap(), "/terminal");
            config.no_token = true;
            host.open_terminal_session(config, None, None)
                .await
                .expect("mount terminal tenant");
            parker.activate();
            let window = host
                .mint_window(crate::WindowKind::Terminal, None)
                .expect("mint window");

            let create = serde_json::json!({
                "name": "held",
                "command": "sleep 1; printf held-before-the-seal; exec sleep 86396",
                "window_id": window.window_id,
            })
            .to_string();
            let res = host
                .clone()
                .router()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/terminal/api/terminals")
                        .header("content-type", "application/json")
                        .body(Body::from(create))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(res.status(), StatusCode::CREATED);
            let body = axum::body::to_bytes(res.into_body(), usize::MAX)
                .await
                .unwrap();
            let id = serde_json::from_slice::<serde_json::Value>(&body).unwrap()["session"]
                .as_str()
                .expect("session id")
                .to_string();

            // Hold the reader between its read of the printf and recording it.
            let (entered_tx, entered_rx) = std::sync::mpsc::channel::<()>();
            let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
            arm_attach_seam(&id, AttachSeam::ReaderBeforeRecord, move || {
                let _ = entered_tx.send(());
                let _ = release_rx.recv_timeout(Duration::from_secs(10));
            });
            entered_rx
                .recv_timeout(Duration::from_secs(10))
                .expect("the reader read the printf");

            let parker = Arc::new(parker);
            let sealing = {
                let parker = parker.clone();
                std::thread::spawn(move || parker.seal_flush_detach())
            };
            std::thread::sleep(Duration::from_millis(300));
            release_tx.send(()).unwrap();
            assert_eq!(sealing.join().unwrap(), 1, "the parked session is detached");

            let sealed: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&manifest).expect("sealed manifest"))
                    .expect("sealed json");
            let session = &sealed["sessions"][0];
            let pid = session["meta"]["child_pid"].as_u64().expect("child pid") as i32;
            let _ = rustix::process::kill_process(
                rustix::process::Pid::from_raw(pid).unwrap(),
                rustix::process::Signal::KILL,
            );
            assert_eq!(sealed["sealed"], serde_json::json!(true));
            let ring_name = session["ring_fd_name"].as_str().expect("a ring file");
            let ring = store.stored_file(ring_name);
            assert!(
                String::from_utf8_lossy(&ring).contains("held-before-the-seal"),
                "the ring file holds output read before the seal: {:?}",
                String::from_utf8_lossy(&ring)
            );
            // The ring file's header: its end seq is the little-endian u64 at
            // byte 32, after the magic, version, header length, capacity and
            // start seq.
            let end = u64::from_le_bytes(ring[32..40].try_into().unwrap());
            assert_eq!(session["meta"]["seq"].as_u64(), Some(end));
            assert!(
                session.get("replay_b64").is_none(),
                "a mirrored ring carries no tail"
            );
            if let Ok(parker) = Arc::try_unwrap(parker) {
                parker.stop().await;
            }
        }

        /// A held directory check in one parked session must leave another
        /// tenant's park, the writer and the final seal able to publish. The
        /// directory hook has no caller on the manifest path when this holds.
        #[test]
        fn manifest_rewrite_does_not_resolve_a_parked_sessions_root() {
            use axum::body::Body;
            use axum::http::{Request, StatusCode};
            use chan_library::terminal_sessions::{arm_attach_seam, AttachSeam};
            use chan_library::windows::WindowRegistry;
            use tower::ServiceExt;

            struct ReleaseDirectory(Option<std::sync::mpsc::Sender<()>>);
            impl Drop for ReleaseDirectory {
                fn drop(&mut self) {
                    if let Some(release) = self.0.take() {
                        let _ = release.send(());
                    }
                }
            }

            struct KillParked(FakeStoreOps);
            impl Drop for KillParked {
                fn drop(&mut self) {
                    let pids: Vec<i32> = self
                        .0
                         .0
                        .fds
                        .lock()
                        .unwrap()
                        .keys()
                        .filter_map(|name| name.strip_prefix("chan.pty."))
                        .filter_map(|name| name.rsplit_once('.'))
                        .filter_map(|(_, pid)| pid.parse().ok())
                        .collect();
                    for pid in pids {
                        if let Some(pid) = rustix::process::Pid::from_raw(pid) {
                            let _ =
                                rustix::process::kill_process(pid, rustix::process::Signal::KILL);
                        }
                    }
                }
            }

            async fn create_windowed(
                host: Arc<WorkspaceHost>,
                prefix: &str,
                window_id: &str,
            ) -> String {
                let create = serde_json::json!({
                    "name": prefix,
                    "command": "exec sleep 60",
                    "window_id": window_id,
                })
                .to_string();
                let response = host
                    .router()
                    .oneshot(
                        Request::builder()
                            .method("POST")
                            .uri(format!("{prefix}/api/terminals"))
                            .header("content-type", "application/json")
                            .body(Body::from(create))
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                assert_eq!(response.status(), StatusCode::CREATED);
                let body = axum::body::to_bytes(response.into_body(), usize::MAX)
                    .await
                    .unwrap();
                serde_json::from_slice::<serde_json::Value>(&body).unwrap()["session"]
                    .as_str()
                    .expect("session id")
                    .to_string()
            }

            let runtime = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(4)
                .enable_all()
                .build()
                .unwrap();
            let store = FakeStoreOps::default();
            let _kill = KillParked(store.clone());
            let (parker, _hook, manifest) = {
                let _enter = runtime.enter();
                test_parker(store)
            };
            let host = parker.shared.host.clone();
            let windows = tempfile::tempdir().unwrap();
            host.install_window_registry(
                Arc::new(WindowRegistry::open(windows.path().join("windows.json"))),
                "lib-test".into(),
            );
            runtime.block_on(async {
                for prefix in ["/a", "/b"] {
                    let mut config =
                        crate::devserver::tenant_config("127.0.0.1:0".parse().unwrap(), prefix);
                    config.no_token = true;
                    host.open_terminal_session(config, None, None)
                        .await
                        .expect("mount terminal tenant");
                }
            });
            parker.activate();
            let window_a = host
                .mint_window(crate::WindowKind::Terminal, None)
                .expect("mint first window");
            let id_a = runtime.block_on(create_windowed(host.clone(), "/a", &window_a.window_id));

            let entered = Arc::new(AtomicBool::new(false));
            let (entered_tx, entered_rx) = std::sync::mpsc::channel();
            let (release_tx, release_rx) = std::sync::mpsc::channel();
            let release = ReleaseDirectory(Some(release_tx));
            let entered_in_hook = entered.clone();
            arm_attach_seam(&id_a, AttachSeam::CwdBeforeRootCheck, move || {
                entered_in_hook.store(true, Ordering::SeqCst);
                let _ = entered_tx.send(());
                let _ = release_rx.recv_timeout(Duration::from_secs(15));
            });

            let (rewrite_tx, rewrite_rx) = std::sync::mpsc::channel();
            let shared = parker.shared.clone();
            let rewrite = std::thread::spawn(move || {
                shared.write_if_active();
                let _ = rewrite_tx.send(());
            });
            // The first marker orders the competing park after either the
            // held directory check or a completed rewrite. No hook is
            // expected on the manifest path once it asks only procfs.
            let start = std::time::Instant::now();
            loop {
                if entered_rx.try_recv().is_ok() || rewrite_rx.try_recv().is_ok() {
                    break;
                }
                assert!(
                    start.elapsed() < Duration::from_secs(5),
                    "manifest rewrite reached a directory result"
                );
                std::thread::sleep(Duration::from_millis(10));
            }

            let window_b = host
                .mint_window(crate::WindowKind::Terminal, None)
                .expect("mint second window");
            let (created_tx, created_rx) = std::sync::mpsc::channel();
            let host_b = host.clone();
            let window_b_id = window_b.window_id.clone();
            runtime.spawn(async move {
                let id = create_windowed(host_b, "/b", &window_b_id).await;
                let _ = created_tx.send(id);
            });
            let created = created_rx.recv_timeout(Duration::from_secs(5));
            drop(release);
            if created.is_err() {
                assert!(
                    entered.load(Ordering::SeqCst),
                    "directory hold entered before the blocked park"
                );
            }
            let id_b = created.expect("other tenant park waits for directory resolution");
            rewrite.join().expect("rewrite thread");
            assert!(
                !entered.load(Ordering::SeqCst),
                "manifest asked for a root check"
            );

            std::fs::remove_file(&manifest).expect("remove stale manifest");
            parker.shared.dirty.notify_one();
            let start = std::time::Instant::now();
            loop {
                if let Ok(bytes) = std::fs::read(&manifest) {
                    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                    let sessions = value["sessions"].as_array().unwrap();
                    if sessions
                        .iter()
                        .any(|entry| entry["meta"]["session_id"] == id_b)
                    {
                        break;
                    }
                }
                assert!(
                    start.elapsed() < Duration::from_secs(5),
                    "debounced rewrite publishes the other tenant"
                );
                std::thread::sleep(Duration::from_millis(10));
            }

            let (sealed_tx, sealed_rx) = std::sync::mpsc::channel();
            let sealing = std::thread::spawn(move || {
                let count = parker.seal_flush_detach();
                let _ = sealed_tx.send(count);
            });
            assert_eq!(
                sealed_rx
                    .recv_timeout(Duration::from_secs(8))
                    .expect("seal returns"),
                2,
            );
            sealing.join().expect("seal thread");
            let value: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&manifest).unwrap()).unwrap();
            let sessions = value["sessions"].as_array().unwrap();
            assert_eq!(value["sealed"], true);
            assert!(sessions
                .iter()
                .any(|entry| entry["meta"]["session_id"] == id_a));
            assert!(sessions
                .iter()
                .any(|entry| entry["meta"]["session_id"] == id_b));
            assert!(
                !entered.load(Ordering::SeqCst),
                "the final seal reached a directory check after the rewrite"
            );
            runtime.shutdown_timeout(Duration::from_secs(2));
        }

        #[tokio::test]
        async fn shutdown_before_activation_preserves_the_inherited_manifest() {
            let store = FakeStoreOps::default();
            let (parker, hook, manifest) = test_parker(store.clone());
            let inherited =
                br#"{"version":2,"library_id":"lib-test","sessions":[{"sentinel":true}]}"#;
            std::fs::write(&manifest, inherited).expect("seed inherited manifest");

            assert_eq!(parker.seal_flush_detach(), 0);
            assert_eq!(
                std::fs::read(&manifest).expect("read preserved manifest"),
                inherited,
                "an incomplete mounted tenant set must not replace inherited state"
            );
            assert!(store.calls().is_empty());
            assert!(!hook.adopt("chan.pty.late.1"), "shutdown seals adoption");
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
                !hook.park(&[("chan.pty.b.7", devnull.as_fd())]),
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

            assert!(!hook.park(&[("chan.pty.c.9", devnull.as_fd())]));
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
                boot_id: None,
                sealed: None,
                sessions: Vec::new(),
            };
            let bytes = serde_json::to_vec(&manifest).unwrap();
            let parsed: RestartManifest = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(parsed.version, 2);
            assert_eq!(parsed.library_id, "lib-test");

            // A v1 manifest (nonce + TTL era) still parses because serde ignores
            // the retired fields, but the version gate routes its leftovers to
            // cleanup rather than restore.
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

        #[tokio::test]
        async fn a_session_parks_its_pty_and_ring_behind_one_barrier() {
            let store = FakeStoreOps::default();
            let (parker, hook, _manifest) = test_parker(store.clone());
            parker.activate();
            let devnull = std::fs::File::open("/dev/null").unwrap();

            assert!(hook.park(&[
                ("chan.pty.d.3", devnull.as_fd()),
                ("chan.ring.d.3", devnull.as_fd()),
            ]));
            assert_eq!(
                store.calls(),
                vec![
                    "store:chan.pty.d.3".to_string(),
                    "store:chan.ring.d.3".to_string(),
                    "barrier".to_string(),
                ]
            );
            hook.unpark(&["chan.pty.d.3", "chan.ring.d.3"]);
            assert_eq!(
                store.calls()[3..],
                [
                    "remove:chan.pty.d.3".to_string(),
                    "remove:chan.ring.d.3".to_string(),
                ],
                "an unpark removes both of the session's names"
            );
            parker.stop().await;
        }

        // A session is never left with its PTY parked and its ring refused:
        // a failure on either fd, or at the barrier, removes what it stored.
        #[tokio::test]
        async fn a_failure_on_either_fd_parks_neither() {
            let (pty, ring) = ("chan.pty.e.4", "chan.ring.e.4");
            for (fail_ring, fail_barrier, removed) in [
                (true, false, vec!["remove:chan.pty.e.4"]),
                (
                    false,
                    true,
                    vec!["remove:chan.pty.e.4", "remove:chan.ring.e.4"],
                ),
            ] {
                let store = FakeStoreOps::default();
                if fail_ring {
                    *store.0.fail_store_name.lock().unwrap() = Some(ring.to_string());
                }
                store.0.fail_barrier.store(fail_barrier, Ordering::Relaxed);
                let (parker, hook, manifest) = test_parker(store.clone());
                parker.activate();
                let devnull = std::fs::File::open("/dev/null").unwrap();

                assert!(!hook.park(&[(pty, devnull.as_fd()), (ring, devnull.as_fd()),]));
                let removes: Vec<String> = store
                    .calls()
                    .into_iter()
                    .filter(|call| call.starts_with("remove:"))
                    .collect();
                assert_eq!(removes, removed, "calls: {:?}", store.calls());
                assert!(!manifest.exists(), "no manifest may describe a refused fd");
                parker.stop().await;
            }
        }

        fn manifest_entry(session_id: &str, with_ring: bool) -> FdStoreManifestEntry {
            let meta: FdStoreSessionMeta = serde_json::from_value(serde_json::json!({
                "tenant_prefix": "/t/terminals", "session_id": session_id,
                "tab_name": null, "tab_group": null, "window_id": "w", "pane_id": null,
                "tab_id": null, "cwd": null, "command": null,
                "env": {}, "mcp_env": false, "child_pid": 7,
                "size": { "rows": 24, "cols": 80, "pixel_width": 0, "pixel_height": 0 },
                "seq": 0, "generation": 0, "alt_screen": false, "private_modes": [],
            }))
            .unwrap();
            FdStoreManifestEntry {
                fd_name: fdstore_fd_name(session_id, Some(7)),
                ring_fd_name: with_ring.then(|| fdstore_ring_fd_name(session_id, Some(7))),
                meta,
                child_start_time: None,
                replay: Vec::new(),
            }
        }

        struct IdentitySentinel {
            child: Option<std::process::Child>,
            pin: std::os::fd::OwnedFd,
            identity: RecordedChildIdentity,
            can_reap: bool,
        }

        impl IdentitySentinel {
            fn start() -> Self {
                let child = std::process::Command::new("sleep")
                    .arg("60")
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .unwrap();
                let identity = RecordedChildIdentity {
                    boot_id: current_boot_id(),
                    start_time: chan_library::terminal_sessions::process_start_time(child.id()),
                };
                let pin = identity
                    .pin(child.id(), current_boot_id().as_deref())
                    .expect("owned-child identity and pidfd must be available");
                Self {
                    child: Some(child),
                    pin,
                    identity,
                    can_reap: true,
                }
            }

            fn pid(&self) -> u32 {
                self.child.as_ref().unwrap().id()
            }

            fn exited(&self) -> bool {
                let stat = std::fs::read_to_string(format!("/proc/{}/stat", self.pid())).unwrap();
                matches!(
                    stat.rsplit_once(')').unwrap().1.split_whitespace().next(),
                    Some("Z" | "X")
                )
            }
        }

        impl Drop for IdentitySentinel {
            fn drop(&mut self) {
                let _ =
                    rustix::process::pidfd_send_signal(&self.pin, rustix::process::Signal::KILL);
                if self.can_reap {
                    if let Some(mut child) = self.child.take() {
                        let _ = child.wait();
                    }
                } else {
                    // A failed close acknowledgement cannot prove its
                    // numeric-PID controller has stopped. Keep ownership
                    // until this test process tears down all its threads.
                    std::mem::forget(self.child.take());
                }
            }
        }

        fn identity_registry() -> chan_library::terminal_sessions::Registry {
            chan_library::terminal_sessions::Registry::new(
                chan_library::terminal_sessions::RegistryConfig {
                    workspace_root: PathBuf::from("/"),
                    mcp_socket_path: None,
                    control_socket_path: None,
                    terminal: chan_library::config::TerminalConfig::default(),
                },
            )
        }

        fn identity_manifest_session(
            id: &str,
            child: Option<&IdentitySentinel>,
        ) -> ManifestSession {
            let mut entry = manifest_entry(id, true);
            entry.meta.child_pid = child.map(IdentitySentinel::pid);
            entry.meta.tab_name = Some(id.into());
            entry.fd_name = fdstore_fd_name(id, entry.meta.child_pid);
            entry.ring_fd_name = Some(fdstore_ring_fd_name(id, entry.meta.child_pid));
            ManifestSession {
                fd_name: entry.fd_name,
                ring_fd_name: entry.ring_fd_name,
                meta: entry.meta,
                child_start_time: child.and_then(|child| child.identity.start_time),
                replay_b64: BASE64.encode(b"saved tail"),
            }
        }

        fn identity_inherited(
            session: &ManifestSession,
        ) -> (Vec<chan_systemd::NamedFd>, std::os::unix::net::UnixStream) {
            // This descriptor surrogate keeps the imported reader live and
            // cannot hang up the independent sentinel. PTY behavior is covered
            // by the library's owned-child import fixtures.
            let (master, peer) = std::os::unix::net::UnixStream::pair().unwrap();
            let mut fds = vec![chan_systemd::NamedFd {
                name: session.fd_name.clone(),
                fd: master.into(),
            }];
            if let Some(name) = &session.ring_fd_name {
                fds.push(inherited(name));
            }
            (fds, peer)
        }

        #[test]
        fn child_identity_mismatch_is_refused_by_import_and_cleanup() {
            let mut sentinel = IdentitySentinel::start();
            let mut bad = identity_manifest_session("identity-bad", Some(&sentinel));
            bad.child_start_time = sentinel.identity.start_time.map(|time| time + 1);
            let mut good = identity_manifest_session("identity-good", None);
            good.ring_fd_name = None;
            let bad_names = [bad.fd_name.clone(), bad.ring_fd_name.clone().unwrap()];
            let good_names = [good.fd_name.clone()];
            let (mut inherited_fds, _bad_pair) = identity_inherited(&bad);
            let (good_fds, _good_pair) = identity_inherited(&good);
            inherited_fds.extend(good_fds);
            let tmp = tempfile::tempdir().unwrap();
            let path = tmp.path().join("manifest.json");
            write_manifest(
                &path,
                &RestartManifest {
                    version: MANIFEST_VERSION,
                    library_id: "lib-test".into(),
                    boot_id: current_boot_id(),
                    sealed: Some(true),
                    sessions: vec![bad, good],
                },
            )
            .unwrap();
            let restore = StartupRestore::from_inherited(path, inherited_fds);
            assert_eq!(
                restore.imports.len(),
                2,
                "both independent live descriptors reach import verification"
            );
            let registry = identity_registry();
            sentinel.can_reap = false;
            let report = registry.restore_fdstore_sessions(restore.imports);
            let closed = registry.close_matching_and_wait(
                Some("identity-bad"),
                None,
                Duration::from_secs(5),
            );
            sentinel.can_reap = closed.is_empty() || closed.iter().all(|session| session.ended);
            let mut skipped = Vec::new();
            cleanup_skipped_session_children(
                &report.skipped_sessions,
                &restore.recorded_children,
                &mut skipped,
            );
            let removals = fds_to_remove(
                Vec::new(),
                &report.skipped_sessions,
                report.abandoned_ring_fds,
            );
            let store = FakeStoreOps::default();
            for name in bad_names.iter().chain(&good_names) {
                store
                    .store(name, std::fs::File::open("/dev/null").unwrap().as_fd())
                    .unwrap();
            }
            for name in &removals {
                store.remove(name);
            }
            let alive = !sentinel.exited();
            registry.close_matching_and_wait(Some("identity-good"), None, Duration::from_secs(5));
            assert!(
                alive,
                "mismatching import or cleanup signalled the owned sentinel"
            );
            assert_eq!(
                report.restored, 1,
                "only the unrelated descriptor-only entry may restore"
            );
            assert!(report
                .skipped
                .iter()
                .any(|reason| reason.contains("child start time does not match")));
            assert!(skipped
                .iter()
                .any(|reason| reason.contains("child start time does not match")));
            let stored = store.0.fds.lock().unwrap();
            assert!(bad_names.iter().all(|name| !stored.contains_key(name)));
            assert!(
                good_names.iter().all(|name| stored.contains_key(name)),
                "unrelated valid store entries must survive"
            );
        }

        #[test]
        fn child_identity_cleanup_mismatch_authorizes_no_signal() {
            let sentinel = IdentitySentinel::start();
            let reason = signal_child(
                sentinel.pid(),
                sentinel.identity.boot_id.as_deref(),
                current_boot_id().as_deref(),
                sentinel.identity.start_time.map(|time| time + 1),
            )
            .unwrap_err();
            assert_eq!(reason, "child start time does not match the manifest");
            assert!(!sentinel.exited());
        }

        #[tokio::test]
        async fn child_identity_writer_keeps_absent_capture() {
            let child = IdentitySentinel::start();
            let (parker, _, path) = test_parker(FakeStoreOps::default());
            let mut entry = manifest_entry("identity-no-capture", false);
            entry.meta.child_pid = Some(child.pid());
            entry.fd_name = fdstore_fd_name(&entry.meta.session_id, entry.meta.child_pid);
            entry.child_start_time = None;
            {
                let phase = parker.shared.phase.lock().unwrap();
                parker
                    .shared
                    .write_entries_locked(&phase, vec![entry])
                    .unwrap();
            }
            let written: RestartManifest =
                serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
            parker.stop().await;
            assert_eq!(
                written.sessions[0].child_start_time, None,
                "a failed capture must never be refreshed by a manifest write"
            );
        }

        #[tokio::test]
        async fn child_identity_writer_preserves_import_across_rewrites() {
            let mut child = IdentitySentinel::start();
            let session = identity_manifest_session("identity-rewrite", Some(&child));
            let (fds, _pair) = identity_inherited(&session);
            let tmp = tempfile::tempdir().unwrap();
            let input = tmp.path().join("input.json");
            write_manifest(
                &input,
                &RestartManifest {
                    version: MANIFEST_VERSION,
                    library_id: "lib-test".into(),
                    boot_id: current_boot_id(),
                    sealed: Some(true),
                    sessions: vec![session],
                },
            )
            .unwrap();
            let restore = StartupRestore::from_inherited(input, fds);
            let registry = identity_registry();
            let (parker, hook, path) = test_parker(FakeStoreOps::default());
            registry.install_fd_parker(FdStoreParker::new(hook));
            parker.activate();
            child.can_reap = false;
            let report = registry.restore_fdstore_sessions(restore.imports);
            assert_eq!(report.restored, 1, "{:?}", report.skipped);
            let exported = || registry.fdstore_manifest_sessions("/t/terminals");
            assert_eq!(exported().len(), 1);
            {
                let phase = parker.shared.phase.lock().unwrap();
                parker
                    .shared
                    .write_entries_locked(&phase, exported())
                    .unwrap();
            }
            let written: RestartManifest =
                serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            let (second_fds, _second_peer) = identity_inherited(&written.sessions[0]);
            let second = identity_registry();
            let again = StartupRestore::from_inherited(path.clone(), second_fds);
            assert_eq!(
                again.imports[0].child_identity, child.identity,
                "a second import must receive the original recorded identity"
            );
            let second_report = second.restore_fdstore_sessions(again.imports);
            assert_eq!(second_report.restored, 1, "{:?}", second_report.skipped);
            let changed = child.identity.start_time.unwrap() + 99;
            assert!(
                !child.exited(),
                "the child must be live during the rewrites"
            );
            let mut written_times = Vec::new();
            for _ in 0..2 {
                let mut entries = exported();
                entries[0].child_start_time = Some(changed);
                let phase = parker.shared.phase.lock().unwrap();
                parker.shared.write_entries_locked(&phase, entries).unwrap();
                let written: RestartManifest =
                    serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
                written_times.push(written.sessions[0].child_start_time);
            }
            let closed = registry.close_matching_and_wait(None, None, Duration::from_secs(5));
            let second_closed = second.close_matching_and_wait(None, None, Duration::from_secs(5));
            child.can_reap = closed
                .iter()
                .chain(&second_closed)
                .all(|session| session.ended);
            parker.stop().await;
            assert_eq!(
                written_times,
                vec![Some(changed); 2],
                "manifest rewrites must copy the stored time instead of reading the live child's"
            );
        }

        #[test]
        fn the_cap_counts_a_ring_file_as_a_second_fd() {
            // One parked session with its ring, one legacy PTY alone, and the
            // candidate's provisional entry with its ring.
            let entries = [
                manifest_entry("a", true),
                manifest_entry("b", false),
                manifest_entry("c", true),
            ];
            assert_eq!(stored_fd_count(&entries), 5);
            assert!(park_within_cap(stored_fd_count(&entries), 5));
            assert!(
                !park_within_cap(stored_fd_count(&entries), 4),
                "a store with room for the PTY but not its ring refuses both"
            );
        }

        // A manager that exports no `$FDSTORE` may run a unit an upgrade left at
        // 512, since only `chan devserver start|restart` rewrites it. The cap
        // must be that unit's value, or the manager rejects fds the precheck
        // passed while the manifest names them.
        #[test]
        fn without_fdstore_the_cap_is_the_installed_units_value() {
            let max = resolve_store_max(None, || Some(512));
            let ringed: Vec<_> = (0..257)
                .map(|i| manifest_entry(&format!("s{i}"), true))
                .collect();
            assert!(park_within_cap(stored_fd_count(&ringed[..256]), max));
            assert!(
                !park_within_cap(stored_fd_count(&ringed), max),
                "the 257th ringed park must be refused at the precheck under a 512 unit"
            );
            assert_eq!(resolve_store_max(Some("1024"), || Some(512)), 1024);
            assert_eq!(
                resolve_store_max(None, || None),
                512,
                "an unreadable unit falls back to the smaller maximum chan has rendered"
            );
            assert_eq!(resolve_store_max(Some("junk"), || None), 512);
        }

        fn inherited(name: &str) -> chan_systemd::NamedFd {
            chan_systemd::NamedFd {
                name: name.to_string(),
                fd: std::fs::File::open("/dev/null").unwrap().into(),
            }
        }

        /// A manifest at a fresh path naming the sessions `entries` describe,
        /// with the seal's mark `sealed`.
        fn manifest_file(entries: Vec<(&str, Option<String>)>, sealed: Option<bool>) -> PathBuf {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("fdstore-restart.json");
            std::mem::forget(dir);
            let manifest = RestartManifest {
                version: MANIFEST_VERSION,
                library_id: "lib-test".into(),
                boot_id: None,
                sealed,
                sessions: entries
                    .into_iter()
                    .map(|(id, ring_fd_name)| {
                        let entry = manifest_entry(id, false);
                        ManifestSession {
                            fd_name: entry.fd_name,
                            ring_fd_name,
                            meta: entry.meta,
                            child_start_time: None,
                            replay_b64: String::new(),
                        }
                    })
                    .collect(),
            };
            write_manifest(&path, &manifest).unwrap();
            path
        }

        // The restore hands a session the ring file named after its own
        // metadata, and nothing else: a ring the manifest names under some
        // other name, or that no entry names, is an orphan the boot removes.
        // (/dev/null stands in for a PTY master: it has no tty index, so the
        // liveness check passes it.)
        #[test]
        fn restore_claims_a_ring_only_under_its_derived_name() {
            let derived = fdstore_ring_fd_name("a", Some(7));
            let path = manifest_file(
                vec![
                    ("a", Some(derived.clone())),
                    ("b", Some("chan.ring.someone-else.7".to_string())),
                ],
                None,
            );
            let restore = StartupRestore::from_inherited(
                path,
                vec![
                    inherited(&fdstore_fd_name("a", Some(7))),
                    inherited(&derived),
                    inherited(&fdstore_fd_name("b", Some(7))),
                    inherited("chan.ring.someone-else.7"),
                    inherited(&fdstore_ring_fd_name("unnamed", Some(9))),
                ],
            );
            let ring_of = |id: &str| {
                restore
                    .imports
                    .iter()
                    .find(|import| import.meta.session_id == id)
                    .map(|import| import.ring_fd.is_some())
            };
            assert_eq!(ring_of("a"), Some(true), "the derived name is claimed");
            assert_eq!(ring_of("b"), Some(false), "a foreign name is not claimed");
            let mut orphans = restore.orphan_fd_names.clone();
            orphans.sort();
            assert_eq!(
                orphans,
                vec![
                    "chan.ring.someone-else.7".to_string(),
                    fdstore_ring_fd_name("unnamed", Some(9)),
                ],
                "unclaimed rings are orphans"
            );
        }

        // Every import carries whether its manifest is the seal's final write;
        // a manifest from before the mark imports as sealed, as it always has.
        #[test]
        fn every_import_carries_the_manifests_seal_mark() {
            for (sealed, want) in [(None, true), (Some(true), true), (Some(false), false)] {
                let path = manifest_file(vec![("a", None)], sealed);
                let restore = StartupRestore::from_inherited(
                    path,
                    vec![inherited(&fdstore_fd_name("a", Some(7)))],
                );
                assert_eq!(restore.imports.len(), 1, "{:?}", restore.skipped);
                assert_eq!(
                    restore.imports[0].sealed_manifest, want,
                    "sealed {sealed:?}"
                );
            }
        }

        // Only the seal's final write marks the manifest sealed: a restore
        // from any other write may end behind its sessions.
        #[tokio::test]
        async fn only_the_seals_write_marks_the_manifest_sealed() {
            let (parker, _hook, manifest) = test_parker(FakeStoreOps::default());
            let written = |phase: ParkerPhase| {
                let mut guard = parker.shared.phase.lock().unwrap();
                *guard = phase;
                parker
                    .shared
                    .write_entries_locked(&guard, vec![manifest_entry("a", true)])
                    .unwrap();
                let json: serde_json::Value =
                    serde_json::from_slice(&std::fs::read(&manifest).unwrap()).unwrap();
                json["sealed"].clone()
            };
            assert_eq!(written(ParkerPhase::Active), serde_json::json!(false));
            assert_eq!(written(ParkerPhase::Sealed), serde_json::json!(true));
            parker.stop().await;
        }

        #[tokio::test]
        async fn manifest_write_hooks_run_in_their_phases() {
            let (parker, _hook, _manifest) = test_parker(FakeStoreOps::default());
            let sealed_entered = Arc::new(AtomicBool::new(false));
            let sealed_in_hook = sealed_entered.clone();
            parker.arm_sealed_write_for_test(move || {
                sealed_in_hook.store(true, Ordering::SeqCst);
            });
            let active_entered = Arc::new(AtomicBool::new(false));
            let active_in_hook = active_entered.clone();
            parker.arm_active_write_for_test(move || {
                active_in_hook.store(true, Ordering::SeqCst);
            });
            {
                let mut phase = parker.shared.phase.lock().unwrap();
                *phase = ParkerPhase::Active;
                parker
                    .shared
                    .write_entries_locked(&phase, vec![manifest_entry("a", true)])
                    .unwrap();
                assert!(active_entered.load(Ordering::SeqCst));
                assert!(!sealed_entered.load(Ordering::SeqCst));
                *phase = ParkerPhase::Sealed;
                parker
                    .shared
                    .write_entries_locked(&phase, vec![manifest_entry("a", true)])
                    .unwrap();
            }
            assert!(sealed_entered.load(Ordering::SeqCst));
            assert_eq!(
                parker.seal_flush_detach_with_wait(Duration::from_millis(10)),
                0
            );
            parker.stop().await;
        }

        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn a_held_debounced_write_cannot_hold_shutdown() {
            let (parker, _hook, _manifest) = test_parker(FakeStoreOps::default());
            *parker.shared.phase.lock().unwrap() = ParkerPhase::Active;
            let (entered_tx, entered_rx) = std::sync::mpsc::channel();
            let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
            let (left_tx, left_rx) = std::sync::mpsc::channel();
            parker.arm_active_write_for_test(move || {
                let _ = entered_tx.send(());
                let _ = release_rx.recv_timeout(Duration::from_secs(10));
                let _ = left_tx.send(());
            });
            parker.shared.dirty.notify_one();
            entered_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("the debounced write entered the hold");

            let (done_tx, done_rx) = std::sync::mpsc::channel();
            let shutdown = std::thread::spawn(move || {
                let detached = parker.seal_flush_detach_with_wait(Duration::from_millis(100));
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("shutdown runtime");
                runtime.block_on(parker.stop());
                let _ = done_tx.send(detached);
            });
            let completed = done_rx.recv_timeout(Duration::from_secs(5));
            let write_still_held = left_rx.try_recv().is_err();
            drop(release_tx);
            shutdown.join().expect("shutdown thread");

            assert_eq!(
                completed.expect("held debounced write held the quit drain"),
                0
            );
            assert!(write_still_held, "the debounced write was released early");
        }

        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn a_failed_rewrite_spawn_still_rewrites_the_manifest() {
            let (parker, _hook, manifest) = test_parker(FakeStoreOps::default());
            parker.activate();
            std::fs::write(&manifest, b"stale manifest").expect("seed stale manifest");
            let (handled_tx, handled_rx) = std::sync::mpsc::channel();
            parker
                .shared
                .fail_active_spawn
                .store(true, Ordering::SeqCst);
            *parker.shared.after_active_spawn_failure.lock().unwrap() = Some(Box::new(move || {
                let _ = handled_tx.send(());
            }));
            parker.shared.dirty.notify_one();
            handled_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("the failed rewrite spawn was handled");
            let rewritten = !manifest.exists();
            parker.stop().await;
            assert!(rewritten, "a failed rewrite spawn must update the manifest");
        }

        #[test]
        fn a_skipped_session_loses_its_ring_file_with_its_pty() {
            let skipped = FdStoreSkippedSession {
                tenant_prefix: "/t".into(),
                session_id: "s".into(),
                window_id: None,
                child_pid: Some(42),
                reason: "test".into(),
            };
            let names = fds_to_remove(vec!["chan.ring.orphan.1".into()], &[skipped], Vec::new());
            assert_eq!(
                names,
                vec![
                    "chan.ring.orphan.1".to_string(),
                    fdstore_fd_name("s", Some(42)),
                    fdstore_ring_fd_name("s", Some(42)),
                ]
            );
        }

        /// A ring file a restored session gave up on is removed before
        /// activation parks a new ring under its name.
        #[test]
        fn a_ring_file_a_restore_gave_up_on_is_removed() {
            let given_up = fdstore_ring_fd_name("s", Some(42));
            let names = fds_to_remove(Vec::new(), &[], vec![given_up.clone()]);
            assert_eq!(names, vec![given_up]);
        }

        #[test]
        fn a_ring_name_authorizes_no_signal() {
            assert_eq!(
                child_pid_from_name(&fdstore_fd_name("s", Some(42))),
                Some(42)
            );
            assert_eq!(
                child_pid_from_name(&fdstore_ring_fd_name("s", Some(42))),
                None
            );
        }

        #[test]
        fn the_manifest_names_a_ring_file_only_when_one_is_stored() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("fdstore-restart.json");
            let manifest = RestartManifest {
                version: MANIFEST_VERSION,
                library_id: "lib-test".into(),
                boot_id: None,
                sealed: None,
                sessions: [manifest_entry("a", true), manifest_entry("b", false)]
                    .into_iter()
                    .map(|entry| ManifestSession {
                        fd_name: entry.fd_name,
                        ring_fd_name: entry.ring_fd_name,
                        meta: entry.meta,
                        child_start_time: None,
                        replay_b64: String::new(),
                    })
                    .collect(),
            };
            write_manifest(&path, &manifest).unwrap();
            let json: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            assert_eq!(
                json["sessions"][0]["ring_fd_name"],
                fdstore_ring_fd_name("a", Some(7))
            );
            assert!(json["sessions"][1].get("ring_fd_name").is_none());
            let read: RestartManifest = serde_json::from_value(json).unwrap();
            assert_eq!(
                read.sessions[0].ring_fd_name.as_deref(),
                Some(fdstore_ring_fd_name("a", Some(7)).as_str())
            );
            assert_eq!(read.sessions[1].ring_fd_name, None);
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

        pub(crate) fn session_prefixes(&self) -> std::collections::HashSet<String> {
            std::collections::HashSet::new()
        }

        pub(crate) fn apply_prefix(&mut self, _state: &DevserverState, _prefix: &str) {}

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
