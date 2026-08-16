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
//! spell a directory the way the client did (see [`Watch`]). Several wire
//! dirs can name one directory, and they share its single registration, so
//! an event is emitted once per spelling and the registration underneath
//! them is refcounted.

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

/// One live OS registration, shared by every wire dir naming that
/// directory.
///
/// Two forms are kept because the backends disagree on which one they
/// report: inotify echoes the path exactly as it was passed to `watch`,
/// while FSEvents reports the fully resolved path. A directory reached
/// through a symlinked ancestor (`/tmp`, `/var` and `/etc` are all symlinks
/// on macOS) therefore arrives spelled differently from the way it was
/// attached, and matching only one form drops every event.
///
/// It is refcounted because `notify` collapses duplicate registrations
/// itself: FSEvents canonicalizes before touching its `recursive_info` map,
/// and inotify returns the same watch descriptor for two paths reaching one
/// inode. A second `watch` would overwrite the first rather than add to it,
/// and an `unwatch` from either scope would silence the other with nothing
/// left to re-attach it. So the manager attaches once per directory and
/// releases only when the last scope naming it detaches.
struct Watch {
    /// The path handed to the watcher, and the one `unwatch` needs back.
    watched: PathBuf,
    /// How many attached scopes name this directory.
    scopes: usize,
}

struct ActorState {
    watcher: notify::RecommendedWatcher,
    resolver: Arc<dyn WatchScopeResolver>,
    registry: Arc<ScopeRegistry>,
    mutations: Arc<StandaloneMutationBus>,
    /// Wire-relative directories with at least one live subscriber.
    desired: HashSet<String>,
    /// Attached scopes: wire dir -> the canonical directory it names.
    /// Several wire dirs can map to one canonical directory.
    scopes: HashMap<String, PathBuf>,
    /// Live OS registrations, keyed by canonical directory.
    watches: HashMap<PathBuf, Watch>,
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
        scopes: HashMap::new(),
        watches: HashMap::new(),
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
        // Re-attaching a scope that already holds a registration must not
        // claim a second reference against it.
        self.release_scope(dir);
        let canonical = std::fs::canonicalize(&abs).unwrap_or_else(|_| abs.clone());
        // A directory already watched under another spelling needs no
        // second OS registration; see [`Watch`] for why asking for one
        // would silence both scopes rather than serve them.
        if let Some(watch) = self.watches.get_mut(&canonical) {
            watch.scopes += 1;
            self.pending.remove(dir);
            self.scopes.insert(dir.to_string(), canonical);
            self.registry.emit_fs_reset(dir, FsResetReason::Subscribed);
            return;
        }
        match self
            .watcher
            .watch(&abs, notify::RecursiveMode::NonRecursive)
        {
            Ok(()) => {
                self.pending.remove(dir);
                self.watches.insert(
                    canonical.clone(),
                    Watch {
                        watched: abs,
                        scopes: 1,
                    },
                );
                self.scopes.insert(dir.to_string(), canonical);
                self.registry.emit_fs_reset(dir, FsResetReason::Subscribed);
            }
            Err(error) => {
                tracing::debug!(dir, %error, "files watch attach failed; will retry");
                self.pending.insert(dir.to_string());
                self.registry.emit_fs_reset(dir, FsResetReason::WatchError);
            }
        }
    }

    /// Drop `dir`'s claim on its OS registration, unwatching only once no
    /// other wire dir names that directory. A no-op for an unattached
    /// scope.
    fn release_scope(&mut self, dir: &str) {
        let Some(canonical) = self.scopes.remove(dir) else {
            return;
        };
        let Some(watch) = self.watches.get_mut(&canonical) else {
            return;
        };
        watch.scopes = watch.scopes.saturating_sub(1);
        if watch.scopes == 0 {
            if let Some(watch) = self.watches.remove(&canonical) {
                let _ = self.watcher.unwatch(&watch.watched);
            }
        }
    }

    fn detach(&mut self, dir: &str) {
        self.desired.remove(dir);
        self.pending.remove(dir);
        self.release_scope(dir);
    }

    /// Every wire path one absolute event path has: one per attached scope
    /// naming its directory, sorted so frame order never rides on hash
    /// order. Empty when no scope names it.
    ///
    /// A non-recursive watch reports only the watched directory itself and
    /// its direct children, so the scopes that match are exactly those
    /// whose subscribers can see this path. Deriving each wire path from
    /// its scope, rather than relativizing the absolute path against the
    /// capability root, is what keeps a frame addressed to its subscriber:
    /// [`ScopeRegistry::emit_fs`] routes on the wire dir string the client
    /// subscribed with, and the OS may spell that directory another way
    /// (see [`Watch`]). Where a symlink lets two scopes name one directory
    /// both are returned, because both share the one registration and a
    /// frame naming only one of them leaves the other silent.
    fn wire_paths(&self, abs: &Path) -> Vec<String> {
        let parent = abs.parent();
        let name = abs.file_name().and_then(|name| name.to_str());
        let mut wires = Vec::new();
        for (dir, canonical) in &self.scopes {
            let Some(watch) = self.watches.get(canonical) else {
                continue;
            };
            if watch.watched.as_path() == abs || canonical.as_path() == abs {
                wires.push(dir.clone());
            } else if parent
                .is_some_and(|p| p == watch.watched.as_path() || p == canonical.as_path())
            {
                let Some(name) = name else { continue };
                wires.push(if dir.is_empty() {
                    name.to_string()
                } else {
                    format!("{dir}/{name}")
                });
            }
        }
        wires.sort();
        wires
    }

    /// The wire event a single frame carries, in the namespace of `paths`.
    fn translate(event: &notify::Event, paths: &[&str]) -> WatchEvent {
        let generation = WorkspaceGeneration::default();
        match event.kind {
            notify::EventKind::Create(_) => {
                WatchEvent::file(WatchKind::Created, paths[0], generation)
            }
            notify::EventKind::Remove(_) => {
                WatchEvent::file(WatchKind::Removed, paths[0], generation)
            }
            notify::EventKind::Modify(notify::event::ModifyKind::Name(mode)) => {
                use notify::event::RenameMode;
                match (mode, paths.len()) {
                    (RenameMode::Both, 2..) => WatchEvent::rename(
                        Some(paths[0].to_string()),
                        Some(paths[1].to_string()),
                        false,
                        None,
                        generation,
                    ),
                    (RenameMode::From, _) => WatchEvent::rename(
                        Some(paths[0].to_string()),
                        None,
                        false,
                        None,
                        generation,
                    ),
                    (RenameMode::To, _) => {
                        WatchEvent::file(WatchKind::Created, paths[0], generation)
                    }
                    _ => WatchEvent::file(WatchKind::Modified, paths[0], generation),
                }
            }
            _ => WatchEvent::file(WatchKind::Modified, paths[0], generation),
        }
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
        // Every spelling of every path the event touches, keeping the
        // from/to order a rename depends on. A path no scope names drops
        // out entirely.
        let spellings: Vec<Vec<String>> = event
            .paths
            .iter()
            .map(|abs| self.wire_paths(abs))
            .filter(|wires| !wires.is_empty())
            .collect();
        if spellings.is_empty() {
            return;
        }
        // A watched directory vanishing or being replaced invalidates its
        // watch: release every scope naming it (the bounded retry
        // re-attaches when something reappears) and tell its subscribers to
        // relist.
        if matches!(
            event.kind,
            notify::EventKind::Remove(_)
                | notify::EventKind::Modify(notify::event::ModifyKind::Name(_))
        ) {
            let mut hits: Vec<String> = spellings
                .iter()
                .flatten()
                .filter(|rel| self.scopes.contains_key(*rel))
                .cloned()
                .collect();
            hits.sort();
            hits.dedup();
            for rel in hits {
                self.release_scope(&rel);
                self.pending.insert(rel.clone());
                self.registry
                    .emit_fs_reset(&rel, FsResetReason::DirectoryReplaced);
            }
        }
        // One frame per spelling, each path riding at its own spelling of
        // the same index and holding at its last once exhausted. Every
        // spelling of every path therefore appears in at least one frame,
        // which is the property that keeps a co-named directory from going
        // silent; where nothing is co-named each path has exactly one
        // spelling and this emits the single frame it always did.
        let breadth = spellings.iter().map(Vec::len).max().unwrap_or(0);
        let frames: Vec<WatchEvent> = (0..breadth)
            .map(|index| {
                let paths: Vec<&str> = spellings
                    .iter()
                    .map(|wires| wires[index.min(wires.len() - 1)].as_str())
                    .collect();
                Self::translate(&event, &paths)
            })
            .collect();
        // Echoes of this tenant's own mutations are replaced by the
        // deterministic attributed frames the mutation bus emits at commit;
        // everything else is a genuine external change. Asked once per
        // frame it would spend one commit's budget several times over, so
        // the question stops at the first yes: one raw event answers for
        // one mutation however many spellings address it. A `no` costs
        // nothing, which is what lets the scan run to the end.
        if frames.iter().any(|wire| self.mutations.suppress_raw(wire)) {
            return;
        }
        for wire in &frames {
            self.registry.emit_fs(wire);
        }
    }

    /// Coverage was lost (provider error or queue overflow): every desired
    /// scope must relist, and the attached set is rebuilt through the
    /// bounded retry so a watch invalidated by the loss recovers too.
    fn reset_all_desired(&mut self) {
        self.scopes.clear();
        for (_, watch) in self.watches.drain() {
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

    /// Two scopes can name one directory: a client subscribed through a
    /// symlink and another through the real path. They share the single OS
    /// registration, so a frame addressed to one spelling only would leave
    /// the other silent while its watch reported itself subscribed.
    #[cfg(unix)]
    #[test]
    fn co_named_scopes_each_receive_their_own_spelling() {
        let fx = fixture();
        std::fs::create_dir_all(fx.root.join("real/notes")).unwrap();
        std::os::unix::fs::symlink(fx.root.join("real"), fx.root.join("link")).unwrap();

        let (a, mut rx_a) = fx.registry.register();
        let (b, mut rx_b) = fx.registry.register();
        fx.manager
            .apply_delta(fx.registry.subscribe(a, "link/notes"));
        fx.manager
            .apply_delta(fx.registry.subscribe(b, "real/notes"));
        assert_eq!(
            recv_frame(&mut rx_a, Duration::from_secs(5)).expect("A subscribed")["reason"],
            "subscribed"
        );
        assert_eq!(
            recv_frame(&mut rx_b, Duration::from_secs(5)).expect("B subscribed")["reason"],
            "subscribed"
        );

        std::fs::write(fx.root.join("real/notes/a.md"), "x").unwrap();
        let frame_a = recv_frame(&mut rx_a, Duration::from_secs(5)).expect("A fs frame");
        let frame_b = recv_frame(&mut rx_b, Duration::from_secs(5)).expect("B fs frame");
        assert_eq!(frame_a["dir"], "link/notes");
        assert_eq!(frame_a["event"]["path"], "link/notes/a.md");
        assert_eq!(frame_b["dir"], "real/notes");
        assert_eq!(frame_b["event"]["path"], "real/notes/a.md");
    }

    /// The registration is shared, so releasing it on the first detach
    /// would silence the scope still holding it -- and nothing would
    /// re-attach it, because an attached scope is not pending.
    #[cfg(unix)]
    #[test]
    fn detaching_one_co_named_scope_leaves_the_other_watching() {
        let fx = fixture();
        std::fs::create_dir_all(fx.root.join("real/notes")).unwrap();
        std::os::unix::fs::symlink(fx.root.join("real"), fx.root.join("link")).unwrap();

        let (a, mut rx_a) = fx.registry.register();
        let (b, mut rx_b) = fx.registry.register();
        fx.manager
            .apply_delta(fx.registry.subscribe(a, "link/notes"));
        fx.manager
            .apply_delta(fx.registry.subscribe(b, "real/notes"));
        assert!(recv_frame(&mut rx_a, Duration::from_secs(5)).is_some());
        assert!(recv_frame(&mut rx_b, Duration::from_secs(5)).is_some());

        fx.manager
            .apply_delta(fx.registry.unsubscribe(a, "link/notes"));
        // Let the detach land, then clear anything already queued for B.
        std::thread::sleep(Duration::from_millis(300));
        while recv_frame(&mut rx_b, Duration::from_millis(50)).is_some() {}

        std::fs::write(fx.root.join("real/notes/b.md"), "y").unwrap();
        let frame = recv_frame(&mut rx_b, Duration::from_secs(5))
            .expect("the surviving scope keeps its watch");
        assert_eq!(frame["dir"], "real/notes");
        assert_eq!(frame["event"]["path"], "real/notes/b.md");
        assert!(
            recv_frame(&mut rx_a, Duration::from_millis(400)).is_none(),
            "the detached scope receives nothing"
        );
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
