//! Scoped, non-recursive filesystem watching for the standalone Files tenant.
//!
//! A workspace tenant derives per-directory `fs` frames from its one
//! recursive watcher; the standalone tenant serves the whole machine from
//! `/`, where a recursive watch is unacceptable. Instead this manager owns
//! one `notify` watcher and attaches exactly one NON-recursive OS watch per
//! directory with at least one live `/ws` subscriber, following the
//! [`crate::bus::ScopeRegistry`]'s refcount transitions ([`ScopeDelta`]).
//!
//! The manager is an actor: one owned thread consumes attach/detach
//! commands and the raw notify events, so `watch`/`unwatch` never run on
//! notify's own callback thread (its Linux backend answers them through the
//! same event loop and would deadlock). Failed attaches stay desired and
//! retry on a bounded interval, so a deleted and recreated directory
//! resumes without a new client subscription. Every reset the frontend
//! must relist on is a typed [`FsResetReason`]; raw provider messages stay
//! in the server log and never enter a path or dir field.
//!
//! Frames are addressed in the subscriber's own namespace: an event's wire
//! path is rebuilt from the wire dir that asked for the watch, never
//! relativized from the absolute path, because the OS does not necessarily
//! spell a directory the way the client did (see [`Attached`]).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use chan_workspace::{WatchEvent, WatchKind, WorkspaceGeneration};
use notify::Watcher as _;

use crate::bus::{FsResetReason, ScopeDelta, ScopeRegistry};
use crate::standalone_mutations::StandaloneMutationBus;

/// How often pending (desired but unattached) scopes retry their OS watch.
const RETRY_INTERVAL: Duration = Duration::from_secs(2);

/// Validates and translates wire-relative watch scopes for the actor. The
/// standalone Files state implements this over its capability root, so the
/// registry's raw client strings never reach the filesystem unchecked.
pub trait WatchScopeResolver: Send + Sync {
    /// Resolve a wire-relative directory to the absolute path to watch.
    /// Refuses traversal, symlinks, and anything that is not a real
    /// directory; the error text goes to the server log only.
    fn resolve_dir(&self, rel: &str) -> Result<PathBuf, String>;
}

enum Command {
    Attach(String),
    Detach(String),
    Shutdown,
    Event(notify::Result<notify::Event>),
}

/// Handle to the watch actor. Cheap to clone behind an `Arc`; dropping the
/// last handle shuts the actor down and joins its thread.
pub struct ScopedWatchManager {
    tx: mpsc::Sender<Command>,
    worker: std::sync::Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl ScopedWatchManager {
    /// Spawn the actor. `registry` receives the scoped frames and resets;
    /// `mutations` filters raw echoes of this tenant's own mutations.
    pub fn spawn(
        resolver: Arc<dyn WatchScopeResolver>,
        registry: Arc<ScopeRegistry>,
        mutations: Arc<StandaloneMutationBus>,
    ) -> std::io::Result<Arc<Self>> {
        let (tx, rx) = mpsc::channel::<Command>();
        let event_tx = tx.clone();
        let watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
            // Forward-only: the actor thread owns every watch mutation.
            let _ = event_tx.send(Command::Event(event));
        })
        .map_err(|e| std::io::Error::other(format!("starting scoped watcher: {e}")))?;
        let worker = std::thread::Builder::new()
            .name("chan-files-watch".into())
            .spawn(move || actor_loop(rx, watcher, resolver, registry, mutations))?;
        Ok(Arc::new(Self {
            tx,
            worker: std::sync::Mutex::new(Some(worker)),
        }))
    }

    /// Apply a registry lifecycle delta: 0 -> 1 transitions become attach
    /// commands, 1 -> 0 transitions detach. Non-blocking; safe to call from
    /// the `/ws` pump.
    pub fn apply_delta(&self, delta: ScopeDelta) {
        for dir in delta.attach {
            let _ = self.tx.send(Command::Attach(dir));
        }
        for dir in delta.detach {
            let _ = self.tx.send(Command::Detach(dir));
        }
    }
}

impl Drop for ScopedWatchManager {
    fn drop(&mut self) {
        let _ = self.tx.send(Command::Shutdown);
        if let Some(worker) = self.worker.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = worker.join();
        }
    }
}

/// One live OS watch, in both the spellings its events can arrive under.
/// The backends disagree: inotify echoes the path exactly as it was passed
/// to `watch`, while FSEvents reports the fully resolved path. A directory
/// reached through a symlinked ancestor (`/tmp`, `/var` and `/etc` are all
/// symlinks on macOS) therefore arrives spelled differently from the way
/// it was attached, and matching only one form drops every event.
struct Attached {
    /// The path handed to the watcher, and the one `unwatch` needs back.
    watched: PathBuf,
    /// Fully resolved form, or a copy of `watched` when it no longer
    /// resolves -- a watch outlives the directory it was attached to.
    canonical: PathBuf,
}

struct ActorState {
    watcher: notify::RecommendedWatcher,
    resolver: Arc<dyn WatchScopeResolver>,
    registry: Arc<ScopeRegistry>,
    mutations: Arc<StandaloneMutationBus>,
    /// Wire-relative directories with at least one live subscriber.
    desired: HashSet<String>,
    /// Successfully attached watches, keyed by wire dir.
    attached: HashMap<String, Attached>,
    /// Desired but unattached; retried on [`RETRY_INTERVAL`].
    pending: HashSet<String>,
}

fn actor_loop(
    rx: mpsc::Receiver<Command>,
    watcher: notify::RecommendedWatcher,
    resolver: Arc<dyn WatchScopeResolver>,
    registry: Arc<ScopeRegistry>,
    mutations: Arc<StandaloneMutationBus>,
) {
    let mut state = ActorState {
        watcher,
        resolver,
        registry,
        mutations,
        desired: HashSet::new(),
        attached: HashMap::new(),
        pending: HashSet::new(),
    };
    let mut next_retry = Instant::now() + RETRY_INTERVAL;
    loop {
        let timeout = next_retry.saturating_duration_since(Instant::now());
        match rx.recv_timeout(timeout) {
            Ok(Command::Attach(dir)) => state.attach(&dir),
            Ok(Command::Detach(dir)) => state.detach(&dir),
            Ok(Command::Event(event)) => state.on_notify(event),
            Ok(Command::Shutdown) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                state.retry_pending();
                next_retry = Instant::now() + RETRY_INTERVAL;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        if Instant::now() >= next_retry {
            state.retry_pending();
            next_retry = Instant::now() + RETRY_INTERVAL;
        }
    }
}

impl ActorState {
    fn attach(&mut self, dir: &str) {
        self.desired.insert(dir.to_string());
        self.try_attach(dir);
    }

    /// One attach attempt for a desired scope. Success emits the
    /// `subscribed` reset that closes the initial-list/watch-attachment
    /// race: once the watch is live, the subscriber relists once and no
    /// creation between its first list and this point can be missed.
    fn try_attach(&mut self, dir: &str) {
        let abs = match self.resolver.resolve_dir(dir) {
            Ok(abs) => abs,
            Err(reason) => {
                tracing::debug!(dir, reason, "files watch scope refused");
                self.pending.insert(dir.to_string());
                self.registry.emit_fs_reset(dir, FsResetReason::WatchError);
                return;
            }
        };
        match self
            .watcher
            .watch(&abs, notify::RecursiveMode::NonRecursive)
        {
            Ok(()) => {
                self.pending.remove(dir);
                let canonical = std::fs::canonicalize(&abs).unwrap_or_else(|_| abs.clone());
                self.attached.insert(
                    dir.to_string(),
                    Attached {
                        watched: abs,
                        canonical,
                    },
                );
                self.registry.emit_fs_reset(dir, FsResetReason::Subscribed);
            }
            Err(error) => {
                tracing::debug!(dir, %error, "files watch attach failed; will retry");
                self.pending.insert(dir.to_string());
                self.registry.emit_fs_reset(dir, FsResetReason::WatchError);
            }
        }
    }

    fn detach(&mut self, dir: &str) {
        self.desired.remove(dir);
        self.pending.remove(dir);
        if let Some(watch) = self.attached.remove(dir) {
            let _ = self.watcher.unwatch(&watch.watched);
        }
    }

    /// Wire path for one absolute event path, expressed under the wire
    /// directory whose subscription produced the watch.
    ///
    /// A non-recursive watch reports only the watched directory itself and
    /// its direct children, so the owning scope is exact. Deriving the wire
    /// path from that scope, rather than relativizing the absolute path
    /// against the capability root, is what keeps the frame addressed to
    /// its subscriber: [`ScopeRegistry::emit_fs`] routes on the wire dir
    /// string the client subscribed with, and the OS may spell that same
    /// directory another way (see [`Attached`]).
    fn wire_path(&self, abs: &Path) -> Option<String> {
        let parent = abs.parent();
        let mut owner: Option<(&str, bool)> = None;
        for (dir, watch) in &self.attached {
            let is_self = watch.watched == abs || watch.canonical == abs;
            let is_child =
                !is_self && parent.is_some_and(|p| p == watch.watched || p == watch.canonical);
            if !is_self && !is_child {
                continue;
            }
            // A symlink lets two live scopes name one directory; the
            // lexicographically first wire dir owns the event so the
            // choice does not ride on hash order.
            if owner.is_none_or(|(current, _)| dir.as_str() < current) {
                owner = Some((dir, is_child));
            }
        }
        let (dir, is_child) = owner?;
        if !is_child {
            return Some(dir.to_string());
        }
        let name = abs.file_name()?.to_str()?;
        Some(if dir.is_empty() {
            name.to_string()
        } else {
            format!("{dir}/{name}")
        })
    }

    fn retry_pending(&mut self) {
        let retry: Vec<String> = self
            .pending
            .iter()
            .filter(|dir| self.desired.contains(*dir))
            .cloned()
            .collect();
        // A scope whose last subscriber left while pending stops retrying.
        self.pending.retain(|dir| self.desired.contains(dir));
        for dir in retry {
            self.try_attach(&dir);
        }
    }

    fn on_notify(&mut self, event: notify::Result<notify::Event>) {
        let event = match event {
            Ok(event) => event,
            Err(error) => {
                tracing::warn!(%error, "files watch provider error");
                self.reset_all_desired();
                return;
            }
        };
        // notify reports inotify queue overflow as an Other-kind event, not
        // an error: coverage is lost, so every desired scope must relist.
        if matches!(event.kind, notify::EventKind::Other) {
            self.reset_all_desired();
            return;
        }
        if matches!(event.kind, notify::EventKind::Access(_)) {
            return;
        }
        let paths: Vec<String> = event
            .paths
            .iter()
            .filter_map(|abs| self.wire_path(abs))
            .collect();
        if paths.is_empty() {
            return;
        }
        // A watched directory vanishing or being replaced invalidates its
        // watch: move it back to pending (the bounded retry re-attaches when
        // something reappears) and tell its subscribers to relist.
        if matches!(
            event.kind,
            notify::EventKind::Remove(_)
                | notify::EventKind::Modify(notify::event::ModifyKind::Name(_))
        ) {
            for rel in &paths {
                if let Some(watch) = self.attached.remove(rel) {
                    let _ = self.watcher.unwatch(&watch.watched);
                    self.pending.insert(rel.clone());
                    self.registry
                        .emit_fs_reset(rel, FsResetReason::DirectoryReplaced);
                }
            }
        }
        let generation = WorkspaceGeneration::default();
        let wire = match event.kind {
            notify::EventKind::Create(_) => {
                let rel = &paths[0];
                WatchEvent::file(WatchKind::Created, rel, generation)
            }
            notify::EventKind::Remove(_) => {
                WatchEvent::file(WatchKind::Removed, &paths[0], generation)
            }
            notify::EventKind::Modify(notify::event::ModifyKind::Name(mode)) => {
                use notify::event::RenameMode;
                match (mode, paths.len()) {
                    (RenameMode::Both, 2..) => WatchEvent::rename(
                        Some(paths[0].clone()),
                        Some(paths[1].clone()),
                        false,
                        None,
                        generation,
                    ),
                    (RenameMode::From, _) => {
                        WatchEvent::rename(Some(paths[0].clone()), None, false, None, generation)
                    }
                    (RenameMode::To, _) => {
                        WatchEvent::file(WatchKind::Created, &paths[0], generation)
                    }
                    _ => WatchEvent::file(WatchKind::Modified, &paths[0], generation),
                }
            }
            _ => WatchEvent::file(WatchKind::Modified, &paths[0], generation),
        };
        // Echoes of this tenant's own mutations are replaced by the
        // deterministic attributed frames the mutation bus emits at commit;
        // everything else is a genuine external change.
        if self.mutations.suppress_raw(&wire) {
            return;
        }
        self.registry.emit_fs(&wire);
    }

    /// Coverage was lost (provider error or queue overflow): every desired
    /// scope must relist, and the attached set is rebuilt through the
    /// bounded retry so a watch invalidated by the loss recovers too.
    fn reset_all_desired(&mut self) {
        for (_, watch) in self.attached.drain() {
            let _ = self.watcher.unwatch(&watch.watched);
        }
        self.pending.extend(self.desired.iter().cloned());
        for dir in &self.desired {
            self.registry.emit_fs_reset(dir, FsResetReason::Overflow);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc as tokio_mpsc;

    /// Temp-root resolver: scopes resolve under a tempdir, mirroring the
    /// production resolver's shape without ever watching the host tree.
    struct TempResolver {
        root: PathBuf,
    }

    impl WatchScopeResolver for TempResolver {
        fn resolve_dir(&self, rel: &str) -> Result<PathBuf, String> {
            let abs = self.root.join(rel);
            let meta = std::fs::symlink_metadata(&abs).map_err(|e| e.to_string())?;
            if !meta.is_dir() || meta.file_type().is_symlink() {
                return Err("not a real directory".into());
            }
            Ok(abs)
        }
    }

    struct Fixture {
        _tmp: tempfile::TempDir,
        root: PathBuf,
        registry: Arc<ScopeRegistry>,
        manager: Arc<ScopedWatchManager>,
    }

    fn fixture() -> Fixture {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path().to_path_buf();
        let registry = Arc::new(ScopeRegistry::new());
        let mutations = Arc::new(StandaloneMutationBus::new(registry.clone()));
        let manager = ScopedWatchManager::spawn(
            Arc::new(TempResolver { root: root.clone() }),
            registry.clone(),
            mutations,
        )
        .expect("spawn watch manager");
        Fixture {
            _tmp: tmp,
            root,
            registry,
            manager,
        }
    }

    fn recv_frame(
        rx: &mut tokio_mpsc::UnboundedReceiver<String>,
        deadline: Duration,
    ) -> Option<serde_json::Value> {
        let start = Instant::now();
        while start.elapsed() < deadline {
            match rx.try_recv() {
                Ok(frame) => return Some(serde_json::from_str(&frame).expect("json frame")),
                Err(_) => std::thread::sleep(Duration::from_millis(20)),
            }
        }
        None
    }

    #[test]
    fn subscribe_attaches_and_delivers_external_events() {
        let fx = fixture();
        std::fs::create_dir(fx.root.join("notes")).unwrap();
        let (id, mut rx) = fx.registry.register();
        let delta = fx.registry.subscribe(id, "notes");
        fx.manager.apply_delta(delta);

        // The live watch announces itself with a subscribed reset first.
        let reset = recv_frame(&mut rx, Duration::from_secs(5)).expect("subscribed reset");
        assert_eq!(reset["type"], "fs_reset");
        assert_eq!(reset["dir"], "notes");
        assert_eq!(reset["reason"], "subscribed");

        std::fs::write(fx.root.join("notes/a.md"), "x").unwrap();
        let frame = recv_frame(&mut rx, Duration::from_secs(5)).expect("fs frame");
        assert_eq!(frame["type"], "fs");
        assert_eq!(frame["dir"], "notes");
        assert!(frame.get("source_w").is_none(), "shell writes are external");
    }

    /// The OS need not spell a watched directory the way the client did:
    /// FSEvents resolves symlinks in the paths it reports, so a directory
    /// subscribed through a symlinked ancestor arrives canonicalized. Its
    /// frames must still be addressed to the wire dir that subscribed, or
    /// they route to no one. Every macOS tempdir is already such a path
    /// (`/var` is a symlink); this builds one explicitly so the case is
    /// covered on Linux too, where inotify reports the other spelling.
    #[cfg(unix)]
    #[test]
    fn events_under_a_symlinked_ancestor_keep_the_subscribed_dir() {
        let fx = fixture();
        std::fs::create_dir_all(fx.root.join("real/notes")).unwrap();
        std::os::unix::fs::symlink(fx.root.join("real"), fx.root.join("link")).unwrap();

        let (id, mut rx) = fx.registry.register();
        fx.manager
            .apply_delta(fx.registry.subscribe(id, "link/notes"));
        let reset = recv_frame(&mut rx, Duration::from_secs(5)).expect("subscribed reset");
        assert_eq!(reset["dir"], "link/notes");
        assert_eq!(reset["reason"], "subscribed");

        std::fs::write(fx.root.join("real/notes/a.md"), "x").unwrap();
        let frame = recv_frame(&mut rx, Duration::from_secs(5)).expect("fs frame");
        assert_eq!(frame["type"], "fs");
        assert_eq!(frame["dir"], "link/notes");
        assert_eq!(frame["event"]["path"], "link/notes/a.md");
    }

    #[test]
    fn missing_directory_reports_watch_error_and_recovers_on_creation() {
        let fx = fixture();
        let (id, mut rx) = fx.registry.register();
        let delta = fx.registry.subscribe(id, "later");
        fx.manager.apply_delta(delta);

        let reset = recv_frame(&mut rx, Duration::from_secs(5)).expect("watch_error reset");
        assert_eq!(reset["reason"], "watch_error");

        // Creating the directory lets the bounded retry attach without a new
        // subscription; the recovery announces itself as subscribed.
        std::fs::create_dir(fx.root.join("later")).unwrap();
        let start = Instant::now();
        let mut recovered = false;
        while start.elapsed() < Duration::from_secs(6) {
            if let Some(frame) = recv_frame(&mut rx, Duration::from_millis(200)) {
                if frame["type"] == "fs_reset" && frame["reason"] == "subscribed" {
                    recovered = true;
                    break;
                }
            }
        }
        assert!(recovered, "retry must attach after the directory appears");
    }

    #[test]
    fn detach_stops_delivery() {
        let fx = fixture();
        std::fs::create_dir(fx.root.join("notes")).unwrap();
        let (id, mut rx) = fx.registry.register();
        fx.manager.apply_delta(fx.registry.subscribe(id, "notes"));
        assert!(
            recv_frame(&mut rx, Duration::from_secs(5)).is_some(),
            "subscribed reset arrives"
        );
        fx.manager.apply_delta(fx.registry.unsubscribe(id, "notes"));
        // Give the detach command time to land, then mutate.
        std::thread::sleep(Duration::from_millis(200));
        std::fs::write(fx.root.join("notes/a.md"), "x").unwrap();
        assert!(
            recv_frame(&mut rx, Duration::from_millis(600)).is_none(),
            "an unsubscribed scope receives nothing"
        );
    }
}
