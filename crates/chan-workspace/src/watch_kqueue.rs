// FreeBSD watch backend: one kqueue, one descriptor per watched path.
//
// kqueue watches vnodes, not names. A directory's knote fires when its entries
// change, and a write to an existing file fires only on that file's own knote,
// so every watched path holds a descriptor for as long as it is watched.
// notify's kqueue backend pays that for every entry a recursive walk reaches,
// excluded build trees and followed symlinks included, and its event loop
// re-adds directories recursively on its own, so no registration policy can
// bound it. This backend is driven by the same filtered walk Linux uses
// (`register_root` in `watch.rs`) and holds its descriptors against one
// process-wide budget (`fd_budget::watch_descriptor_budget`).
//
// Directory changes are reported by diffing the directory's listing against
// the snapshot taken when it was registered, so every entry of a burst is
// named, and a replaced file (same name, new inode: an atomic save) reads as a
// modification. A new subdirectory is announced, not registered: the
// supervisor registers it through the walk, like an inotify `IN_CREATE`.
//
// Budget: a directory always takes a descriptor, and one that does not fit
// marks the backend exhausted; the supervisor then releases everything and
// retries later. An accepted file takes a descriptor while the budget lasts,
// and a file past it is polled with `lstat` every `POLL_INTERVAL` instead.
// Descriptors are opened `O_PATH`, which FreeBSD accepts for `EVFILT_VNODE`:
// opening a FIFO cannot block and an unreadable file cannot refuse.

use std::collections::{BTreeSet, HashMap};
use std::ffi::OsString;
use std::io;
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::fs::{DirEntryExt, MetadataExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use notify::event::{CreateKind, DataChange, MetadataKind, ModifyKind, RemoveKind};
use notify::{Event, EventKind, RecursiveMode};
use rustix::event::kqueue::{
    self, EventFilter, EventFlags, UserDefinedFlags, UserFlags, VnodeEvents,
};
use rustix::fs::{Mode, OFlags};

use super::{is_filtered, locate_root, IndexScopePolicy, ScopePolicySource, WatchRoot};

/// How often files past the descriptor budget are checked for in-place
/// changes. Creates, deletes and renames of those files still arrive at once
/// through their directory's knote; only a write into an existing file waits
/// for this.
pub(super) const POLL_INTERVAL: Duration = Duration::from_secs(2);

/// Events read per `kevent` call. A larger burst is read over several calls.
const EVENT_BATCH: usize = 256;

/// The `EVFILT_USER` identity that wakes the event thread to stop.
const WAKE: usize = 0;

/// Directory knotes: entry changes, and the directory itself going away.
const DIR_EVENTS: VnodeEvents = VnodeEvents::WRITE
    .union(VnodeEvents::EXTEND)
    .union(VnodeEvents::LINK)
    .union(VnodeEvents::DELETE)
    .union(VnodeEvents::RENAME)
    .union(VnodeEvents::REVOKE);

/// File knotes: content and metadata changes, and the name going away.
const FILE_EVENTS: VnodeEvents = VnodeEvents::WRITE
    .union(VnodeEvents::EXTEND)
    .union(VnodeEvents::ATTRIBUTES)
    .union(VnodeEvents::DELETE)
    .union(VnodeEvents::RENAME)
    .union(VnodeEvents::REVOKE);

/// Watch descriptors held by every backend in the process. One budget for all
/// of them, since they share one descriptor table.
static HELD: AtomicU64 = AtomicU64::new(0);

/// A watch descriptor counted against the process-wide budget for as long as
/// it is open.
struct Held(OwnedFd);

enum OpenError {
    /// The budget, or the kernel's table, has no room.
    NoRoom,
    Io(io::Error),
}

impl Held {
    fn open(path: &Path, directory: bool, budget: u64) -> Result<Self, OpenError> {
        if HELD
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |held| {
                (held < budget).then_some(held + 1)
            })
            .is_err()
        {
            return Err(OpenError::NoRoom);
        }
        let mut flags = OFlags::PATH | OFlags::NOFOLLOW | OFlags::CLOEXEC;
        if directory {
            flags |= OFlags::DIRECTORY;
        }
        match rustix::fs::open(path, flags, Mode::empty()) {
            Ok(fd) => Ok(Self(fd)),
            Err(errno) => {
                HELD.fetch_sub(1, Ordering::SeqCst);
                if errno == rustix::io::Errno::MFILE || errno == rustix::io::Errno::NFILE {
                    Err(OpenError::NoRoom)
                } else {
                    Err(OpenError::Io(errno.into()))
                }
            }
        }
    }
}

impl Drop for Held {
    fn drop(&mut self) {
        HELD.fetch_sub(1, Ordering::SeqCst);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Dir,
    File,
    Other,
}

/// One directory entry as a listing saw it. The inode is what tells a file
/// replaced under its name apart from the same file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Entry {
    kind: Kind,
    ino: u64,
}

struct DirWatch {
    id: u64,
    _fd: Held,
    entries: HashMap<OsString, Entry>,
}

/// What a polled file looked like at its last check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Stamp {
    ino: u64,
    len: u64,
    mtime: (i64, i64),
    ctime: (i64, i64),
}

impl Stamp {
    fn of(path: &Path) -> Option<Self> {
        let meta = std::fs::symlink_metadata(path).ok()?;
        Some(Self {
            ino: meta.ino(),
            len: meta.len(),
            mtime: (meta.mtime(), meta.mtime_nsec()),
            ctime: (meta.ctime(), meta.ctime_nsec()),
        })
    }
}

#[derive(Default)]
struct State {
    next_id: u64,
    /// Knote identity (the event's `udata`) to the path it watches. An id is
    /// never reused, so an event read just before its descriptor closed, or
    /// one whose descriptor number was reused since, finds nothing.
    ids: HashMap<u64, (PathBuf, Kind)>,
    dirs: HashMap<PathBuf, DirWatch>,
    files: HashMap<PathBuf, (u64, Held)>,
    polled: HashMap<PathBuf, Stamp>,
    next_poll: Option<Instant>,
    /// A directory did not fit during the current registration pass.
    exhausted: bool,
}

impl State {
    fn track(&mut self, path: &Path, kind: Kind) -> u64 {
        self.next_id += 1;
        self.ids.insert(self.next_id, (path.to_path_buf(), kind));
        self.next_id
    }

    fn release_file(&mut self, path: &Path) {
        if let Some((id, _fd)) = self.files.remove(path) {
            self.ids.remove(&id);
        }
        self.polled.remove(path);
    }

    /// Drop a directory that left, everything registered beneath it, and the
    /// files of each.
    fn release_subtree(&mut self, root: &Path) {
        let gone: Vec<PathBuf> = self
            .dirs
            .keys()
            .filter(|path| path.starts_with(root))
            .cloned()
            .collect();
        for path in gone {
            if let Some(dir) = self.dirs.remove(&path) {
                self.ids.remove(&dir.id);
            }
        }
        let files: Vec<PathBuf> = self
            .files
            .keys()
            .chain(self.polled.keys())
            .filter(|path| path.starts_with(root))
            .cloned()
            .collect();
        for path in files {
            self.release_file(&path);
        }
    }
}

struct Shared {
    kq: OwnedFd,
    state: Mutex<State>,
    stopping: AtomicBool,
    roots: Arc<Vec<WatchRoot>>,
    policy: ScopePolicySource,
}

/// The FreeBSD backend the watch supervisor owns. Registration calls take the
/// state lock; the event thread takes it to read and diff, and releases it
/// before running the handler, so a slow consumer never blocks registration.
pub(super) struct KqueueWatcher {
    shared: Arc<Shared>,
    thread: Option<JoinHandle<()>>,
}

impl KqueueWatcher {
    pub(super) fn new(
        handler: impl notify::EventHandler,
        roots: Arc<Vec<WatchRoot>>,
        policy: ScopePolicySource,
    ) -> notify::Result<Self> {
        let kq = kqueue::kqueue().map_err(|errno| notify::Error::io(errno.into()))?;
        rustix::io::fcntl_setfd(&kq, rustix::io::FdFlags::CLOEXEC)
            .map_err(|errno| notify::Error::io(errno.into()))?;
        let shared = Arc::new(Shared {
            kq,
            state: Mutex::new(State::default()),
            stopping: AtomicBool::new(false),
            roots,
            policy,
        });
        shared
            .change(user_wake(
                EventFlags::ADD | EventFlags::CLEAR,
                UserFlags::empty(),
            ))
            .map_err(notify::Error::io)?;
        let thread_shared = Arc::clone(&shared);
        let thread = std::thread::Builder::new()
            .name("chan-workspace::kqueue".to_string())
            .spawn(move || thread_shared.run(handler))
            .map_err(notify::Error::io)?;
        Ok(Self {
            shared,
            thread: Some(thread),
        })
    }

    /// Watch one directory and its accepted files. Idempotent: a directory
    /// already watched is left as it is, so no path is ever opened twice.
    pub(super) fn watch(&mut self, path: &Path, _mode: RecursiveMode) -> notify::Result<()> {
        let budget = crate::fd_budget::watch_descriptor_budget();
        let policy = Arc::clone(&self.shared.policy.read().unwrap());
        let mut state = self.shared.state.lock().unwrap();
        if state.dirs.contains_key(path) {
            return Ok(());
        }
        // Directories come first: a file holding a descriptor goes over to
        // polling before a directory is refused, so the files of the first
        // directories walked cannot crowd out the rest of the tree.
        let fd = loop {
            match Held::open(path, true, budget) {
                Ok(fd) => break fd,
                Err(OpenError::NoRoom) => {
                    if self.shared.demote_one_file(&mut state) {
                        continue;
                    }
                    state.exhausted = true;
                    return Err(notify::Error::generic(&format!(
                        "watch descriptor budget exhausted ({} held, budget {budget})",
                        HELD.load(Ordering::SeqCst)
                    ))
                    .add_path(path.to_path_buf()));
                }
                Err(OpenError::Io(error)) => {
                    return Err(notify::Error::io(error).add_path(path.to_path_buf()))
                }
            }
        };
        let id = state.track(path, Kind::Dir);
        // Armed before the listing is read: a change landing between the two
        // fires the knote, and its diff runs against this listing.
        let listed = self
            .shared
            .arm(&fd, id, DIR_EVENTS)
            .and_then(|()| list(path));
        let entries = match listed {
            Ok(entries) => entries,
            Err(error) => {
                state.ids.remove(&id);
                return Err(notify::Error::io(error).add_path(path.to_path_buf()));
            }
        };
        for (name, entry) in &entries {
            if entry.kind == Kind::File {
                self.shared
                    .add_file(&mut state, &path.join(name), &policy, budget);
            }
        }
        state.dirs.insert(
            path.to_path_buf(),
            DirWatch {
                id,
                _fd: fd,
                entries,
            },
        );
        Ok(())
    }

    /// Stop watching one directory and its files. Subdirectories are separate
    /// registrations and stay.
    pub(super) fn unwatch(&mut self, path: &Path) -> notify::Result<()> {
        let mut state = self.shared.state.lock().unwrap();
        let Some(dir) = state.dirs.remove(path) else {
            return Err(notify::Error::watch_not_found());
        };
        state.ids.remove(&dir.id);
        for (name, entry) in &dir.entries {
            if entry.kind == Kind::File {
                state.release_file(&path.join(name));
            }
        }
        Ok(())
    }

    /// Whether a directory has failed to fit since the last `take_exhausted`.
    pub(super) fn exhausted(&self) -> bool {
        self.shared.state.lock().unwrap().exhausted
    }

    pub(super) fn take_exhausted(&mut self) -> bool {
        std::mem::take(&mut self.shared.state.lock().unwrap().exhausted)
    }

    /// Close every watch descriptor this backend holds.
    pub(super) fn release_all(&mut self) {
        let mut state = self.shared.state.lock().unwrap();
        let exhausted = state.exhausted;
        let next_id = state.next_id;
        *state = State {
            next_id,
            exhausted,
            ..State::default()
        };
    }
}

impl Drop for KqueueWatcher {
    fn drop(&mut self) {
        self.shared.stopping.store(true, Ordering::SeqCst);
        let _ = self
            .shared
            .change(user_wake(EventFlags::empty(), UserFlags::TRIGGER));
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Shared {
    /// Submit one change to the kqueue without collecting events.
    fn change(&self, change: kqueue::Event) -> io::Result<()> {
        let mut none: [kqueue::Event; 0] = [];
        // SAFETY: the change names either the `EVFILT_USER` wake, which holds
        // no descriptor, or a descriptor `arm`'s caller keeps open while it is
        // registered. Closing a descriptor removes its knotes in the kernel,
        // and events are matched by the never-reused id in `udata`, not by the
        // descriptor number, so a closed and reused number cannot misroute.
        unsafe { kqueue::kevent(&self.kq, &[change], &mut none, Some(Duration::ZERO)) }
            .map(|_| ())
            .map_err(Into::into)
    }

    fn arm(&self, fd: &Held, id: u64, flags: VnodeEvents) -> io::Result<()> {
        self.change(kqueue::Event::new(
            EventFilter::Vnode {
                vnode: fd.0.as_raw_fd(),
                flags,
            },
            EventFlags::ADD | EventFlags::CLEAR,
            id as usize as *mut std::ffi::c_void,
        ))
    }

    fn accepts(&self, path: &Path, policy: &IndexScopePolicy) -> bool {
        locate_root(&self.roots, path).is_some_and(|(_, rel)| !is_filtered(&rel, false, policy))
    }

    /// Watch one file if the scope policy accepts it: with a descriptor while
    /// the budget lasts, by polling past it.
    fn add_file(&self, state: &mut State, path: &Path, policy: &IndexScopePolicy, budget: u64) {
        if state.files.contains_key(path) || state.polled.contains_key(path) {
            return;
        }
        if !self.accepts(path, policy) {
            return;
        }
        match Held::open(path, false, budget) {
            Ok(fd) => {
                let id = state.track(path, Kind::File);
                if self.arm(&fd, id, FILE_EVENTS).is_ok() {
                    state.files.insert(path.to_path_buf(), (id, fd));
                } else {
                    state.ids.remove(&id);
                }
            }
            Err(OpenError::NoRoom) => self.poll_file(state, path),
            // Gone already, or replaced by something that is not a file: the
            // directory's next diff accounts for whatever is there now.
            Err(OpenError::Io(_)) => {}
        }
    }

    fn poll_file(&self, state: &mut State, path: &Path) {
        let Some(stamp) = Stamp::of(path) else {
            return;
        };
        state.polled.insert(path.to_path_buf(), stamp);
        if state.next_poll.is_none() {
            state.next_poll = Some(Instant::now() + POLL_INTERVAL);
            // The event thread may be in an untimed wait; wake it so it
            // starts timing the poll.
            let _ = self.change(user_wake(EventFlags::empty(), UserFlags::TRIGGER));
        }
    }

    /// Close one file descriptor this backend holds and poll that file
    /// instead. False when it holds none.
    fn demote_one_file(&self, state: &mut State) -> bool {
        let Some(path) = state.files.keys().next().cloned() else {
            return false;
        };
        if let Some((id, fd)) = state.files.remove(&path) {
            state.ids.remove(&id);
            drop(fd);
        }
        self.poll_file(state, &path);
        true
    }

    fn run(&self, mut handler: impl notify::EventHandler) {
        let mut events: Vec<kqueue::Event> = Vec::with_capacity(EVENT_BATCH);
        while !self.stopping.load(Ordering::SeqCst) {
            let timeout = self
                .state
                .lock()
                .unwrap()
                .next_poll
                .map(|at| at.saturating_duration_since(Instant::now()));
            events.clear();
            // SAFETY: the change list is empty; the event list is this
            // thread's own buffer, filled into its spare capacity.
            let waited = unsafe {
                kqueue::kevent(
                    &self.kq,
                    &[],
                    rustix::buffer::spare_capacity(&mut events),
                    timeout,
                )
            };
            if self.stopping.load(Ordering::SeqCst) {
                return;
            }
            match waited {
                Ok(_) => {}
                Err(rustix::io::Errno::INTR) => continue,
                Err(errno) => {
                    handler.handle_event(Err(notify::Error::io(errno.into())));
                    std::thread::sleep(Duration::from_millis(250));
                    continue;
                }
            }
            for event in self.process(&events) {
                if self.stopping.load(Ordering::SeqCst) {
                    return;
                }
                handler.handle_event(event);
            }
        }
    }

    /// Turn one batch of kevents into notify events: file knotes report
    /// themselves, directory knotes queue a diff, and polled files are checked
    /// when their interval is due.
    fn process(&self, events: &[kqueue::Event]) -> Vec<notify::Result<Event>> {
        let budget = crate::fd_budget::watch_descriptor_budget();
        let policy = Arc::clone(&self.policy.read().unwrap());
        let mut state = self.state.lock().unwrap();
        let mut out = Vec::new();
        let mut rescan = BTreeSet::new();
        for event in events {
            let EventFilter::Vnode { flags, .. } = event.filter() else {
                continue;
            };
            let id = event.udata() as usize as u64;
            let Some((path, kind)) = state.ids.get(&id).cloned() else {
                continue;
            };
            let left =
                flags.intersects(VnodeEvents::DELETE | VnodeEvents::RENAME | VnodeEvents::REVOKE);
            if kind == Kind::Dir {
                if flags.intersects(VnodeEvents::WRITE | VnodeEvents::EXTEND | VnodeEvents::LINK) {
                    rescan.insert(path.clone());
                }
            } else if flags.intersects(VnodeEvents::WRITE | VnodeEvents::EXTEND) {
                out.push(Ok(modified(&path, ModifyKind::Data(DataChange::Any))));
            } else if flags.contains(VnodeEvents::ATTRIBUTES) {
                out.push(Ok(modified(&path, ModifyKind::Metadata(MetadataKind::Any))));
            }
            // A watched name went away; its parent's listing says what is
            // there now. A watched root that leaves has no watched parent, and
            // the supervisor's root probe reports it.
            if left {
                if let Some(parent) = path.parent() {
                    rescan.insert(parent.to_path_buf());
                }
            }
        }
        for dir in rescan {
            self.diff(&mut state, &dir, &policy, budget, &mut out);
        }
        if state.next_poll.is_some_and(|at| at <= Instant::now()) {
            poll(&mut state, &mut out);
        }
        out
    }

    /// Compare a watched directory's listing with its snapshot and report the
    /// difference, registering and releasing files as they come and go.
    fn diff(
        &self,
        state: &mut State,
        dir: &Path,
        policy: &IndexScopePolicy,
        budget: u64,
        out: &mut Vec<notify::Result<Event>>,
    ) {
        if !state.dirs.contains_key(dir) {
            return;
        }
        let current = match list(dir) {
            Ok(current) => current,
            // Gone: its own parent's diff, or the root probe, reports it.
            Err(error) if error.kind() == io::ErrorKind::NotFound => return,
            Err(error) => {
                out.push(Err(notify::Error::io(error).add_path(dir.to_path_buf())));
                return;
            }
        };
        let previous = std::mem::take(&mut state.dirs.get_mut(dir).unwrap().entries);
        for (name, now) in &current {
            let path = dir.join(name);
            match previous.get(name) {
                Some(before) if before == now => {}
                Some(before) if before.kind == Kind::File && now.kind == Kind::File => {
                    state.release_file(&path);
                    self.add_file(state, &path, policy, budget);
                    out.push(Ok(modified(&path, ModifyKind::Data(DataChange::Any))));
                }
                Some(before) => {
                    vanished(state, &path, before.kind, out);
                    self.appeared(state, &path, now.kind, policy, budget, out);
                }
                None => self.appeared(state, &path, now.kind, policy, budget, out),
            }
        }
        for (name, before) in &previous {
            if !current.contains_key(name) {
                vanished(state, &dir.join(name), before.kind, out);
            }
        }
        if let Some(watch) = state.dirs.get_mut(dir) {
            watch.entries = current;
        }
    }

    fn appeared(
        &self,
        state: &mut State,
        path: &Path,
        kind: Kind,
        policy: &IndexScopePolicy,
        budget: u64,
        out: &mut Vec<notify::Result<Event>>,
    ) {
        let create = match kind {
            Kind::Dir => CreateKind::Folder,
            Kind::File => {
                self.add_file(state, path, policy, budget);
                CreateKind::File
            }
            Kind::Other => CreateKind::Other,
        };
        out.push(Ok(
            Event::new(EventKind::Create(create)).add_path(path.to_path_buf())
        ));
    }
}

fn vanished(state: &mut State, path: &Path, kind: Kind, out: &mut Vec<notify::Result<Event>>) {
    let remove = match kind {
        Kind::Dir => {
            state.release_subtree(path);
            RemoveKind::Folder
        }
        Kind::File => {
            state.release_file(path);
            RemoveKind::File
        }
        Kind::Other => RemoveKind::Other,
    };
    out.push(Ok(
        Event::new(EventKind::Remove(remove)).add_path(path.to_path_buf())
    ));
}

/// Check every polled file and report the ones whose stamp moved.
fn poll(state: &mut State, out: &mut Vec<notify::Result<Event>>) {
    for (path, stamp) in &mut state.polled {
        if let Some(now) = Stamp::of(path) {
            if now != *stamp {
                *stamp = now;
                out.push(Ok(modified(path, ModifyKind::Data(DataChange::Any))));
            }
        }
    }
    state.next_poll = (!state.polled.is_empty()).then(|| Instant::now() + POLL_INTERVAL);
}

fn modified(path: &Path, kind: ModifyKind) -> Event {
    Event::new(EventKind::Modify(kind)).add_path(path.to_path_buf())
}

fn user_wake(flags: EventFlags, user: UserFlags) -> kqueue::Event {
    kqueue::Event::new(
        EventFilter::User {
            ident: WAKE as _,
            flags: user,
            user_flags: UserDefinedFlags::new(0),
        },
        flags,
        std::ptr::null_mut(),
    )
}

/// One directory's entries without following symlinks: `file_type` comes from
/// the directory entry itself.
fn list(dir: &Path) -> io::Result<HashMap<OsString, Entry>> {
    let mut entries = HashMap::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let kind = match entry.file_type() {
            Ok(kind) if kind.is_dir() => Kind::Dir,
            Ok(kind) if kind.is_file() => Kind::File,
            _ => Kind::Other,
        };
        entries.insert(
            entry.file_name(),
            Entry {
                kind,
                ino: entry.ino(),
            },
        );
    }
    Ok(entries)
}
