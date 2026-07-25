// Cross-process advisory locks for per-workspace state.
//
// Two processes (e.g. `chan open` running on a workspace that the
// native desktop app then opens) must not both try to write the
// search index or graph DB at once. We use file-based advisory
// locks via fs4 (Unix flock + Windows LockFileEx).
//
// `WorkspaceLock` is the writer lock: held for the lifetime of a Workspace
// open in writer mode. Reading callers don't take any lock; tantivy
// and sqlite handle their own multi-reader concurrency.
//
// The lock file body carries a JSON [`LockRecord`] -- the holder's pid,
// canonical path, and start time -- written right after the advisory
// lock is won. It serves two jobs: a contender can tell a live holder
// (refuse) from a stale record a dead one left behind (steal), and
// `chan close` reads it to find the process serving a path. The
// record shape is a cross-lane contract (`chan close` parses it).

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

use fs4::fs_std::FileExt;
use serde::{Deserialize, Serialize};

use crate::error::{ChanError, Result};

/// Identity written into `writer.lock` by the holder immediately after
/// it wins the advisory lock.
///
/// The on-disk shape is a cross-crate contract: `chan close` parses it
/// to discover the serving process. Keep the field set and
/// `started_at`'s RFC3339 format stable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LockRecord {
    /// OS pid of the holder.
    pub pid: u32,
    /// Canonical absolute workspace root: a sanity check that the lock
    /// dir belongs to the workspace we think it does, plus a human hint.
    pub path: String,
    /// RFC3339 time the lock was acquired (the "held by pid N since …"
    /// diagnostic).
    pub started_at: String,
}

/// Process-wide advisory lock on a per-workspace lockfile. Drop to
/// release. Cross-platform via fs4 (flock on Unix, LockFileEx on
/// Windows).
pub struct WorkspaceLock {
    /// Holds the lock; the file lives as long as this struct.
    file: File,
}

impl WorkspaceLock {
    /// Acquire the writer lock for `lock_dir`, recording the holder's
    /// identity (`workspace_root`, this pid, now).
    ///
    /// Fast path: the OS advisory lock is free → take it and (over)write
    /// our [`LockRecord`].
    ///
    /// Contended path: the OS lock is held. We read the record. When it
    /// names THIS process (our own pid, same workspace root) the lock is
    /// held by us -- a live `Workspace` handle, or a mount in flight on
    /// another task -- so we return [`ChanError::WorkspaceAlreadyOpen`],
    /// never the cross-process [`ChanError::WorkspaceLocked`]: a turn-on
    /// racing chan's own in-flight mount must not read as a foreign lock.
    /// Otherwise we only **steal** when the recorded holder is **provably
    /// dead** (its pid no longer exists) and the record names this same
    /// workspace -- the case where a dead `chan open`'s lock fd was
    /// inherited by a still-living child and pins the flock with no real
    /// writer behind it. In every uncertain case -- record missing,
    /// unparseable, for a different path, a FOREIGN holder alive, or
    /// liveness indeterminate -- we refuse with
    /// [`ChanError::WorkspaceLocked`] rather than risk two writers
    /// corrupting the index.
    ///
    /// On Unix a normally-dead holder's flock is auto-released, so the
    /// contended path is reached only for that leaked-fd case. On Windows
    /// the equivalent is a leaked `LockFileEx` handle: the lockfile is
    /// opened with `FILE_SHARE_DELETE` and the steal unlinks it, but it
    /// stays best-effort (a recreate can lose a race to the leaked handle's
    /// pending-delete, degrading to a refuse). `process_alive` probes the
    /// recorded pid on both platforms so only a provably-dead holder is
    /// ever stolen from.
    pub fn acquire(lock_dir: &Path, workspace_root: &Path) -> Result<Self> {
        fs::create_dir_all(lock_dir)?;
        let path = lock_dir.join("writer.lock");
        let file = open_lock_file(&path)?;
        match FileExt::try_lock_exclusive(&file) {
            Ok(()) => {
                write_record(&file, workspace_root)?;
                Ok(Self { file })
            }
            Err(e) if is_contended(&e) => Self::try_steal(&path, workspace_root),
            Err(e) => Err(ChanError::Io(e.to_string())),
        }
    }

    /// Reclaim a contended lock iff the recorded holder is provably
    /// dead. Returns `WorkspaceLocked` whenever the steal isn't provably
    /// safe (the conservative default).
    fn try_steal(path: &Path, workspace_root: &Path) -> Result<Self> {
        let record = read_record_at(path);
        let our_path = canonical_string(workspace_root);
        // The contended lock is held by US (our own pid, this workspace): a
        // live handle elsewhere in this process, or a mount in flight on
        // another task. That is `WorkspaceAlreadyOpen`, not the cross-process
        // `WorkspaceLocked` -- the holder is this chan, so the "open in another
        // process" path must not fire. (A coincidental stale record with our
        // pid can't reach here: a dead holder's flock is free, so we'd be on
        // the fast path, not contended.)
        if let Some(r) = &record {
            if r.path == our_path && r.pid == std::process::id() {
                return Err(ChanError::WorkspaceAlreadyOpen);
            }
        }
        let stealable = match &record {
            // Missing/torn record ⇒ holder is mid-write or unknown ⇒
            // treat as alive.
            Some(r) => r.path == our_path && process_alive(r.pid) == ProcessLiveness::Dead,
            None => false,
        };
        if !stealable {
            if let Some(r) = &record {
                tracing::warn!(pid = r.pid, since = %r.started_at, "workspace locked by a live holder");
            }
            return Err(ChanError::WorkspaceLocked);
        }
        // The recorded holder is dead but a leaked fd still pins the OS
        // lock on this inode. Unlink to orphan that inode, recreate the
        // file, and lock the fresh inode. The leaked fd keeps its now-
        // nameless inode; future acquirers contend on the new one.
        let dead_pid = record.as_ref().map_or(0, |r| r.pid);
        let _ = fs::remove_file(path);
        let file = open_lock_file(path)?;
        match FileExt::try_lock_exclusive(&file) {
            Ok(()) => {
                tracing::warn!(
                    stolen_from = dead_pid,
                    "stole writer lock from a dead holder"
                );
                write_record(&file, workspace_root)?;
                Ok(Self { file })
            }
            // Lost a race to break the stale lock; treat as locked.
            Err(e) if is_contended(&e) => Err(ChanError::WorkspaceLocked),
            Err(e) => Err(ChanError::Io(e.to_string())),
        }
    }
}

impl Drop for WorkspaceLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

/// Read and parse the [`LockRecord`] in `<lock_dir>/writer.lock`, if
/// present and well-formed. `chan close` uses this to discover the
/// process serving a workspace path.
pub fn read_lock_record(lock_dir: &Path) -> Option<LockRecord> {
    read_record_at(&lock_dir.join("writer.lock"))
}

/// Probe whether the writer lock for `lock_dir` is currently free,
/// without taking it or touching the record. `false` means some open
/// file description still holds it -- including an in-flight
/// `Workspace::drop` whose flock release has not completed yet.
///
/// The close→reopen handoff uses this to confirm the prior holder's
/// flock actually released before a reopen races it: an `Arc`'s strong
/// count reaches zero *before* `Workspace::drop` runs the `_lock` drop,
/// so "no strong refs" is not the same as "flock free".
pub fn is_free(lock_dir: &Path) -> bool {
    let path = lock_dir.join("writer.lock");
    let Ok(file) = open_lock_file(&path) else {
        // Can't even open the lockfile → treat as not-free (conservative).
        return false;
    };
    match FileExt::try_lock_exclusive(&file) {
        // Held only for this probe; `file` drops here and the OS releases it.
        Ok(()) => true,
        Err(e) if is_contended(&e) => false,
        // An unexpected error is not a free lock.
        Err(_) => false,
    }
}

/// Probe whether `lock_dir` is held by a live or indeterminate foreign writer.
///
/// This is a read-side status check for launchers and menus, not an acquire
/// path. It mirrors the conservative side of [`WorkspaceLock::acquire`]: a free
/// lock, this process's own holder, or a provably-dead holder stays actionable;
/// a live, unknown, torn, or path-mismatched holder reports foreign-locked.
pub fn is_locked_by_foreign_holder(lock_dir: &Path, workspace_root: &Path) -> bool {
    let path = lock_dir.join("writer.lock");
    let Ok(file) = open_lock_file(&path) else {
        return true;
    };
    match FileExt::try_lock_exclusive(&file) {
        Ok(()) => false,
        Err(e) if is_contended(&e) => {
            let Some(record) = read_record_at(&path) else {
                return true;
            };
            let our_path = canonical_string(workspace_root);
            if record.path == our_path && record.pid == std::process::id() {
                return false;
            }
            if record.path == our_path && process_alive(record.pid) == ProcessLiveness::Dead {
                return false;
            }
            true
        }
        Err(_) => true,
    }
}

pub(crate) fn open_lock_file(path: &Path) -> Result<File> {
    let mut opts = OpenOptions::new();
    opts.create(true).read(true).write(true).truncate(false);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE. std's
        // default share mode omits DELETE, which would block the steal
        // path from unlinking the lockfile while a dead holder's leaked
        // handle is still open. Every opener sets DELETE so a provably-
        // dead holder's handle can be superseded.
        const FILE_SHARE_READ: u32 = 0x1;
        const FILE_SHARE_WRITE: u32 = 0x2;
        const FILE_SHARE_DELETE: u32 = 0x4;
        opts.share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
    }
    opts.open(path).map_err(|e| ChanError::Io(e.to_string()))
}

fn write_record(mut file: &File, workspace_root: &Path) -> Result<()> {
    let record = LockRecord {
        pid: std::process::id(),
        path: canonical_string(workspace_root),
        started_at: chrono::Utc::now().to_rfc3339(),
    };
    let json = serde_json::to_vec(&record).map_err(|e| ChanError::Io(e.to_string()))?;
    file.set_len(0).map_err(|e| ChanError::Io(e.to_string()))?;
    file.seek(SeekFrom::Start(0))
        .map_err(|e| ChanError::Io(e.to_string()))?;
    file.write_all(&json)
        .map_err(|e| ChanError::Io(e.to_string()))?;
    file.flush().map_err(|e| ChanError::Io(e.to_string()))?;
    Ok(())
}

fn read_record_at(path: &Path) -> Option<LockRecord> {
    let mut buf = String::new();
    File::open(path).ok()?.read_to_string(&mut buf).ok()?;
    let trimmed = buf.trim();
    if trimmed.is_empty() {
        return None;
    }
    serde_json::from_str(trimmed).ok()
}

fn canonical_string(root: &Path) -> String {
    root.canonicalize()
        .unwrap_or_else(|_| root.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

/// Verdict of [`process_alive`]. Only Unix and Windows have a real probe; on
/// any other target the sole verdict is `Indeterminate`, so `Alive`/`Dead` are
/// never built there.
#[cfg_attr(not(any(unix, windows)), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessLiveness {
    Alive,
    Dead,
    Indeterminate,
}

/// Is process `pid` alive? Conservative: only `Dead` is a definitive
/// "no such process"; anything ambiguous (permission denied, an unexpected
/// errno, no probe available) is `Indeterminate` so a caller never treats a
/// live process as gone. The writer-lock steal path keys on `Dead`; the
/// devserver Windows supervisor reuses it (alongside a creation-time guard)
/// before signalling a recorded pid. Dependency-free: `rustix` on unix,
/// `windows-sys` on Windows -- both already chan-workspace deps.
pub fn process_alive(pid: u32) -> ProcessLiveness {
    #[cfg(unix)]
    {
        use rustix::io::Errno;
        use rustix::process::{test_kill_process, Pid};
        let Some(pid) = i32::try_from(pid).ok().and_then(Pid::from_raw) else {
            return ProcessLiveness::Indeterminate;
        };
        match test_kill_process(pid) {
            Ok(()) => ProcessLiveness::Alive,
            Err(Errno::SRCH) => ProcessLiveness::Dead,
            Err(Errno::PERM) => ProcessLiveness::Alive,
            Err(_) => ProcessLiveness::Indeterminate,
        }
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{
            CloseHandle, GetLastError, ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER,
        };
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        // GetExitCodeProcess reports this (STATUS_PENDING) while a process
        // is still running. A process that genuinely exits with code 259
        // reads as Alive here, so the steal is refused for it: conservative,
        // never the reverse. pid reuse points OpenProcess at the new owner
        // and also reads Alive -> refuse, so a reused pid is never stolen.
        const STILL_ACTIVE: u32 = 259;
        // SAFETY: plain Win32 FFI. We pass our own `pid`, never inherit the
        // handle, and CloseHandle every successfully-opened handle before
        // returning.
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return match GetLastError() {
                    // No process with that id: provably dead.
                    ERROR_INVALID_PARAMETER => ProcessLiveness::Dead,
                    // It exists but is protected from our token: alive.
                    ERROR_ACCESS_DENIED => ProcessLiveness::Alive,
                    _ => ProcessLiveness::Indeterminate,
                };
            }
            let mut code: u32 = 0;
            let ok = GetExitCodeProcess(handle, &mut code);
            CloseHandle(handle);
            if ok == 0 {
                ProcessLiveness::Indeterminate
            } else if code == STILL_ACTIVE {
                ProcessLiveness::Alive
            } else {
                ProcessLiveness::Dead
            }
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        // No dependency-free liveness probe on this target. Stay
        // conservative: never steal.
        let _ = pid;
        ProcessLiveness::Indeterminate
    }
}

/// Did `try_lock_exclusive` fail because the lock is already held?
/// On Unix fs4 surfaces `WouldBlock`; on Windows it returns
/// `ERROR_LOCK_VIOLATION` / `ERROR_SHARING_VIOLATION`, which std does
/// not decode to `WouldBlock` -- the historical "Windows lock-contract
/// gap". Match both so contention maps to `WorkspaceLocked` uniformly.
pub(crate) fn is_contended(e: &std::io::Error) -> bool {
    if e.kind() == std::io::ErrorKind::WouldBlock {
        return true;
    }
    #[cfg(windows)]
    {
        const ERROR_SHARING_VIOLATION: i32 = 32;
        const ERROR_LOCK_VIOLATION: i32 = 33;
        if matches!(
            e.raw_os_error(),
            Some(ERROR_SHARING_VIOLATION | ERROR_LOCK_VIOLATION)
        ) {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    // The workspace root for the record; the lock dir is a sibling
    // tempdir so the two never alias.
    fn root(tmp: &TempDir) -> std::path::PathBuf {
        tmp.path().to_path_buf()
    }

    #[test]
    fn acquire_and_release() {
        let tmp = TempDir::new().unwrap();
        let lock = WorkspaceLock::acquire(tmp.path(), &root(&tmp)).unwrap();
        drop(lock);
        // Re-acquire after drop must succeed.
        let _lock2 = WorkspaceLock::acquire(tmp.path(), &root(&tmp)).unwrap();
    }

    #[test]
    fn records_holder_identity() {
        let tmp = TempDir::new().unwrap();
        let _lock = WorkspaceLock::acquire(tmp.path(), &root(&tmp)).unwrap();
        let rec = read_lock_record(tmp.path()).expect("record written");
        assert_eq!(rec.pid, std::process::id());
        assert_eq!(rec.path, canonical_string(&root(&tmp)));
        assert!(!rec.started_at.is_empty());
    }

    #[test]
    fn is_free_reflects_held_state() {
        let tmp = TempDir::new().unwrap();
        assert!(is_free(tmp.path())); // nothing holds it
        let held = WorkspaceLock::acquire(tmp.path(), &root(&tmp)).unwrap();
        assert!(!is_free(tmp.path())); // a live holder
        drop(held);
        assert!(is_free(tmp.path())); // released after drop
    }

    #[test]
    fn foreign_lock_probe_treats_free_and_own_locks_as_actionable() {
        let tmp = TempDir::new().unwrap();
        assert!(!is_locked_by_foreign_holder(tmp.path(), &root(&tmp)));

        let held = WorkspaceLock::acquire(tmp.path(), &root(&tmp)).unwrap();
        assert!(!is_locked_by_foreign_holder(tmp.path(), &root(&tmp)));
        drop(held);
        assert!(!is_locked_by_foreign_holder(tmp.path(), &root(&tmp)));
    }

    // Un-gated from the old `#[cfg(unix)]`: `is_contended` now maps the
    // Windows LockFileEx error (ERROR_LOCK_VIOLATION) to contention too,
    // so the contract is symmetric. CI runs tests on unix today; the
    // Windows arm is compile-checked via `cargo xwin check`.
    #[test]
    fn second_acquire_same_process_is_already_open() {
        // The contended lock's record names OUR own pid, so a second
        // acquire reads as `WorkspaceAlreadyOpen` (this chan already holds
        // it), NOT the cross-process `WorkspaceLocked`. This is what makes
        // a launcher turn-on racing chan's own in-flight mount idempotent
        // instead of a false "locked by another process".
        let tmp = TempDir::new().unwrap();
        let _l1 = WorkspaceLock::acquire(tmp.path(), &root(&tmp)).unwrap();
        let r2 = WorkspaceLock::acquire(tmp.path(), &root(&tmp));
        assert!(matches!(r2, Err(ChanError::WorkspaceAlreadyOpen)));
    }

    #[test]
    fn live_holder_is_never_stolen() {
        // The held lock records OUR (alive) pid; a second acquire must
        // refuse rather than steal. Stealing a live holder would corrupt
        // the index -- the highest-risk failure this module guards. Our own
        // pid reads as `WorkspaceAlreadyOpen`; either way the lock is NOT
        // stolen (the record still names the original holder).
        let tmp = TempDir::new().unwrap();
        let _held = WorkspaceLock::acquire(tmp.path(), &root(&tmp)).unwrap();
        assert_eq!(
            read_lock_record(tmp.path()).unwrap().pid,
            std::process::id()
        );
        let again = WorkspaceLock::acquire(tmp.path(), &root(&tmp));
        assert!(matches!(again, Err(ChanError::WorkspaceAlreadyOpen)));
        // No steal happened: the record is untouched, our handle still valid.
        assert_eq!(
            read_lock_record(tmp.path()).unwrap().pid,
            std::process::id()
        );
    }

    #[cfg(unix)]
    #[test]
    fn foreign_live_holder_is_workspace_locked() {
        // A contended lock whose record names a FOREIGN live pid is the real
        // cross-process `WorkspaceLocked`. We hold the flock, then overwrite
        // the record with pid 1 (init: always live on unix) to stand in for a
        // foreign holder; a second acquire must refuse with `WorkspaceLocked`,
        // not `WorkspaceAlreadyOpen` and not a steal.
        let tmp = TempDir::new().unwrap();
        let _held = WorkspaceLock::acquire(tmp.path(), &root(&tmp)).unwrap();
        let foreign = LockRecord {
            pid: 1,
            path: canonical_string(&root(&tmp)),
            started_at: "2000-01-01T00:00:00Z".to_string(),
        };
        fs::write(
            tmp.path().join("writer.lock"),
            serde_json::to_vec(&foreign).unwrap(),
        )
        .unwrap();
        let again = WorkspaceLock::acquire(tmp.path(), &root(&tmp));
        assert!(matches!(again, Err(ChanError::WorkspaceLocked)));
    }

    #[cfg(unix)]
    #[test]
    fn foreign_lock_probe_reports_live_foreign_holder() {
        let tmp = TempDir::new().unwrap();
        let _held = WorkspaceLock::acquire(tmp.path(), &root(&tmp)).unwrap();
        let foreign = LockRecord {
            pid: 1,
            path: canonical_string(&root(&tmp)),
            started_at: "2000-01-01T00:00:00Z".to_string(),
        };
        fs::write(
            tmp.path().join("writer.lock"),
            serde_json::to_vec(&foreign).unwrap(),
        )
        .unwrap();
        assert!(is_locked_by_foreign_holder(tmp.path(), &root(&tmp)));
    }

    #[test]
    fn stale_record_does_not_block_a_free_lock() {
        // A dead holder's record left on disk while the OS lock is free
        // (the common `kill -9` case on Unix: flock auto-released). The
        // fast path takes the lock and overwrites the record.
        let tmp = TempDir::new().unwrap();
        let stale = LockRecord {
            pid: 999_999_999,
            path: canonical_string(&root(&tmp)),
            started_at: "2000-01-01T00:00:00Z".to_string(),
        };
        fs::create_dir_all(tmp.path()).unwrap();
        fs::write(
            tmp.path().join("writer.lock"),
            serde_json::to_vec(&stale).unwrap(),
        )
        .unwrap();
        let _lock = WorkspaceLock::acquire(tmp.path(), &root(&tmp)).unwrap();
        assert_eq!(
            read_lock_record(tmp.path()).unwrap().pid,
            std::process::id()
        );
    }

    #[cfg(unix)]
    #[test]
    fn our_own_pid_reads_as_alive() {
        assert_eq!(process_alive(std::process::id()), ProcessLiveness::Alive);
    }

    #[cfg(unix)]
    #[test]
    fn reaped_child_pid_reads_as_dead() {
        // A reaped child is provably dead: `kill(pid, 0)` → ESRCH.
        let mut child = std::process::Command::new("true")
            .spawn()
            .expect("spawn /usr/bin/true");
        let pid = child.id();
        child.wait().expect("reap child");
        assert_eq!(process_alive(pid), ProcessLiveness::Dead);
    }

    #[cfg(windows)]
    #[test]
    fn our_own_pid_reads_as_alive() {
        assert_eq!(process_alive(std::process::id()), ProcessLiveness::Alive);
    }

    #[cfg(windows)]
    #[test]
    fn exited_child_pid_reads_as_dead() {
        // A child that has run to completion is provably dead:
        // GetExitCodeProcess returns its real exit code (not STILL_ACTIVE),
        // or OpenProcess fails once the process object is freed.
        let mut child = std::process::Command::new("cmd")
            .args(["/C", "exit", "0"])
            .spawn()
            .expect("spawn cmd /C exit");
        let pid = child.id();
        child.wait().expect("reap child");
        assert_eq!(process_alive(pid), ProcessLiveness::Dead);
    }
}
