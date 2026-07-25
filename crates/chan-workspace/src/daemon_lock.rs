//! Single-instance daemon lock + pidfile: the cross-OS supervisor primitive
//! behind `chan devserver --service=chan`.
//!
//! A sibling of [`WorkspaceLock`](crate::lock::WorkspaceLock): the SAME fs4
//! advisory flock + [`process_alive`](crate::lock::process_alive) stale-takeover,
//! but its on-disk record carries the daemon's bound address + start time + a
//! pid-reuse guard instead of the frozen workspace `LockRecord`. The lock anchor
//! (`daemon.lock`) and the record (`daemon.json`) are separate files: the flock
//! answers "is a daemon running right now" by contention, while the record lets
//! `--status` / `--stop` read the holder's pid + address WITHOUT taking the lock.
//!
//! A foreground `--service=chan` invocation calls [`DaemonLock::acquire`]:
//! winning the flock means "I am the daemon" (serve in this process, hold the
//! guard for its life); losing to a LIVE holder yields its [`DaemonRecord`] so
//! the caller re-attaches as a watchdog or reports a bind/port mismatch. A
//! provably-dead holder is stolen, mirroring the writer lock; `--force` (the
//! `force` argument) also breaks an ambiguous or wedged holder.

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use fs4::fs_std::FileExt;
use serde::{Deserialize, Serialize};

use crate::error::{ChanError, Result};
use crate::lock::{is_contended, open_lock_file, process_alive, ProcessLiveness};

/// Identity written into the daemon pidfile by the process that wins the lock.
///
/// Distinct from the frozen workspace `LockRecord`: it carries the bound address
/// (so a reattaching caller can detect a bind/port mismatch) and a pid-reuse
/// `creation_time` guard, and it lives in its own `daemon.json` rather than in
/// the lockfile body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DaemonRecord {
    /// OS pid of the daemon.
    pub pid: u32,
    /// OS process creation time, the pid-reuse guard. Mandatory on Windows (its
    /// liveness probe `OpenProcess`/`GetExitCodeProcess` reads a REUSED pid as
    /// alive); `0` on Unix, where the flock auto-releases on exit so a dead
    /// holder is provably free without the guard.
    pub creation_time: u64,
    /// The address the daemon bound (`ip:port`), as a string for stable JSON.
    pub addr: String,
    /// RFC3339 time the daemon acquired the lock (the `--status` uptime source
    /// and the "running since" diagnostic).
    pub started_at: String,
}

/// Outcome of [`DaemonLock::acquire`].
pub enum DaemonAcquire {
    /// We won the lock: this process IS the daemon. Hold the guard for the
    /// process lifetime; dropping it releases the flock and removes the pidfile.
    Daemon(DaemonLock),
    /// A LIVE daemon already holds the lock; here is its pidfile record. The
    /// caller re-attaches as a watchdog or reports a bind/port mismatch.
    Running(DaemonRecord),
}

/// Held while this process is the `--service=chan` daemon. Drop releases the
/// flock and removes the pidfile (a clean exit), so a later acquire fast-paths
/// instead of stealing a stale record. A `kill -9` skips Drop; the next acquire
/// then steals the dead record.
pub struct DaemonLock {
    file: File,
    record_path: PathBuf,
}

impl DaemonLock {
    /// Acquire the daemon lock at `lock_path`, stamping `addr` + this pid into
    /// `record_path`.
    ///
    /// Fast path: the flock is free -> take it, (over)write the record, return
    /// [`DaemonAcquire::Daemon`].
    ///
    /// Contended: the flock is held. A holder whose record is alive (and, on
    /// Windows, whose creation time still matches) is returned as
    /// [`DaemonAcquire::Running`] -- the caller watchdogs it or reports a
    /// mismatch. A provably-dead holder is stolen. A held lock with no readable
    /// record (a daemon mid-startup that has not written its pidfile, or a torn
    /// write) is refused with [`ChanError::WorkspaceLocked`] rather than stolen,
    /// so a healthy starting daemon is never killed; retry, or pass `force`.
    /// `force` steals from ANY holder (ambiguous, mid-startup, or live) -- the
    /// `--force` take-over.
    pub fn acquire(
        lock_path: &Path,
        record_path: &Path,
        addr: &str,
        force: bool,
    ) -> Result<DaemonAcquire> {
        if let Some(parent) = lock_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| ChanError::Io(e.to_string()))?;
        }
        let file = open_lock_file(lock_path)?;
        match FileExt::try_lock_exclusive(&file) {
            Ok(()) => {
                write_record(record_path, addr)?;
                Ok(DaemonAcquire::Daemon(DaemonLock {
                    file,
                    record_path: record_path.to_path_buf(),
                }))
            }
            Err(e) if is_contended(&e) => Self::contended(lock_path, record_path, addr, force),
            Err(e) => Err(ChanError::Io(e.to_string())),
        }
    }

    /// The flock is held. Decide: hand back a live holder, steal a dead one,
    /// refuse an unreadable one (unless `force`).
    fn contended(
        lock_path: &Path,
        record_path: &Path,
        addr: &str,
        force: bool,
    ) -> Result<DaemonAcquire> {
        let record = read_daemon_record(record_path);
        if !force {
            match &record {
                Some(r) if is_record_live(r) => return Ok(DaemonAcquire::Running(r.clone())),
                // A held lock with no parseable record: a daemon mid-startup
                // (pidfile not written yet) or a torn write. Refuse rather than
                // steal from a possibly-healthy starting daemon.
                None => return Err(ChanError::WorkspaceLocked),
                // A dead/stale record behind a still-held lock (a leaked fd):
                // fall through and steal.
                Some(_) => {}
            }
        }
        // Steal: holder provably dead, or `force` overrides. Unlink to orphan any
        // leaked fd's inode, recreate, relock the fresh inode.
        let _ = std::fs::remove_file(lock_path);
        let file = open_lock_file(lock_path)?;
        match FileExt::try_lock_exclusive(&file) {
            Ok(()) => {
                write_record(record_path, addr)?;
                Ok(DaemonAcquire::Daemon(DaemonLock {
                    file,
                    record_path: record_path.to_path_buf(),
                }))
            }
            // Lost the race to break the stale lock: a concurrent contender took
            // it. Report it if it is now a live holder, else surface contention.
            Err(e) if is_contended(&e) => match read_daemon_record(record_path) {
                Some(r) if is_record_live(&r) => Ok(DaemonAcquire::Running(r)),
                _ => Err(ChanError::WorkspaceLocked),
            },
            Err(e) => Err(ChanError::Io(e.to_string())),
        }
    }
}

impl Drop for DaemonLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
        // Clean exit: drop the pidfile so the next acquire fast-paths. The lock
        // anchor file is left in place (an empty flock target the next acquire
        // reuses), matching WorkspaceLock leaving its file.
        let _ = std::fs::remove_file(&self.record_path);
    }
}

/// Read + parse the [`DaemonRecord`] at `record_path`, if present and
/// well-formed. `--status` / `--stop` use this to find the daemon without taking
/// the lock.
pub fn read_daemon_record(record_path: &Path) -> Option<DaemonRecord> {
    let mut buf = String::new();
    File::open(record_path)
        .ok()?
        .read_to_string(&mut buf)
        .ok()?;
    let trimmed = buf.trim();
    if trimmed.is_empty() {
        return None;
    }
    serde_json::from_str(trimmed).ok()
}

/// Whether the daemon flock at `lock_path` is currently HELD by some process --
/// the authoritative "a daemon is running" signal on Unix, where the flock
/// auto-releases on exit, so a FREE lock proves the recorded pid is stale even
/// after a `kill -9` left a `daemon.json` behind and that pid was reused. A
/// caller signalling a recorded pid must gate on this so it never SIGTERMs an
/// innocent reused-pid process. Probe-only: it momentarily takes the lock for the
/// check and releases it on return. Conservative -- any open / unexpected error
/// reads as NOT held, so an ambiguous probe never green-lights a signal.
pub fn daemon_lock_held(lock_path: &Path) -> bool {
    let Ok(file) = open_lock_file(lock_path) else {
        return false;
    };
    match FileExt::try_lock_exclusive(&file) {
        // Acquired -> it was free -> not held (the lock drops with `file`).
        Ok(()) => false,
        Err(e) if is_contended(&e) => true,
        Err(_) => false,
    }
}

/// Whether `record` names a process that is alive AND -- when a creation time
/// was recorded (Windows) -- whose creation time still matches, so a reused pid
/// is never mistaken for the daemon. A `0` creation time degrades to
/// liveness-only (the Unix case, where the flock already proves staleness).
pub fn is_record_live(record: &DaemonRecord) -> bool {
    if process_alive(record.pid) != ProcessLiveness::Alive {
        return false;
    }
    if record.creation_time == 0 {
        return true;
    }
    process_creation_time(record.pid) == Some(record.creation_time)
}

/// Write `record_path` with this process's identity + `addr`. The pidfile is a
/// pretty JSON sibling of the lock anchor; the directory is created if needed.
fn write_record(record_path: &Path, addr: &str) -> Result<()> {
    if let Some(parent) = record_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| ChanError::Io(e.to_string()))?;
    }
    let pid = std::process::id();
    let record = DaemonRecord {
        pid,
        creation_time: process_creation_time(pid).unwrap_or(0),
        addr: addr.to_string(),
        started_at: chrono::Utc::now().to_rfc3339(),
    };
    let json = serde_json::to_vec_pretty(&record).map_err(|e| ChanError::Io(e.to_string()))?;
    std::fs::write(record_path, json).map_err(|e| ChanError::Io(e.to_string()))
}

/// The OS process creation time for `pid` (the pid-reuse guard), or `None` when
/// it cannot be read. Windows reads it via `GetProcessTimes`; every other target
/// returns `None` (Unix relies on flock auto-release for staleness), matching the
/// "Windows-mandatory, Unix best-effort" guard policy.
#[cfg(windows)]
pub fn process_creation_time(pid: u32) -> Option<u64> {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    // SAFETY: plain Win32 FFI. We open with the minimal query right, never
    // inherit the handle, and CloseHandle before returning.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut creation: FILETIME = std::mem::zeroed();
        let mut ignored: FILETIME = std::mem::zeroed();
        let ok = GetProcessTimes(
            handle,
            &mut creation,
            &mut ignored,
            &mut ignored,
            &mut ignored,
        );
        CloseHandle(handle);
        (ok != 0)
            .then_some(((creation.dwHighDateTime as u64) << 32) | (creation.dwLowDateTime as u64))
    }
}

/// Non-Windows: no dependency-free creation-time read; the guard degrades to
/// liveness-only and the flock proves staleness.
#[cfg(not(windows))]
pub fn process_creation_time(_pid: u32) -> Option<u64> {
    None
}

/// Best-effort stop of `pid`: `SIGTERM` on Unix (graceful -- the devserver
/// drains its HTTP and releases its writer locks on the signal), and
/// `TerminateProcess` on Windows (a detached daemon has no console for a
/// `CTRL_C_EVENT`, and the writer locks self-heal a hard stop). Returns `true`
/// when the signal was delivered or the process was already gone.
#[cfg(unix)]
pub fn signal_terminate(pid: u32) -> bool {
    use rustix::io::Errno;
    use rustix::process::{Pid, Signal};
    let Some(pid) = i32::try_from(pid).ok().and_then(Pid::from_raw) else {
        return false;
    };
    matches!(
        rustix::process::kill_process(pid, Signal::TERM),
        Ok(()) | Err(Errno::SRCH)
    )
}

/// Windows: `TerminateProcess` via the minimal terminate right. A gone or
/// inaccessible process reads as already-stopped.
#[cfg(windows)]
pub fn signal_terminate(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    // SAFETY: plain Win32 FFI; open with terminate right, close the handle.
    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if handle.is_null() {
            return true;
        }
        let ok = TerminateProcess(handle, 0);
        CloseHandle(handle);
        ok != 0
    }
}

/// No process-signalling primitive on this target.
#[cfg(not(any(unix, windows)))]
pub fn signal_terminate(_pid: u32) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn paths(tmp: &TempDir) -> (PathBuf, PathBuf) {
        (
            tmp.path().join("daemon.lock"),
            tmp.path().join("daemon.json"),
        )
    }

    #[test]
    fn acquire_writes_record_and_releases() {
        let tmp = TempDir::new().unwrap();
        let (lock, record) = paths(&tmp);

        let guard = match DaemonLock::acquire(&lock, &record, "127.0.0.1:8787", false).unwrap() {
            DaemonAcquire::Daemon(g) => g,
            DaemonAcquire::Running(_) => {
                panic!("a free lock must be acquired, not reported running")
            }
        };
        let r = read_daemon_record(&record).expect("pidfile written");
        assert_eq!(r.pid, std::process::id());
        assert_eq!(r.addr, "127.0.0.1:8787");

        drop(guard);
        // Clean exit removes the pidfile and frees the lock.
        assert!(
            read_daemon_record(&record).is_none(),
            "drop removes the pidfile"
        );
        assert!(matches!(
            DaemonLock::acquire(&lock, &record, "127.0.0.1:8787", false).unwrap(),
            DaemonAcquire::Daemon(_)
        ));
    }

    #[test]
    fn contended_by_live_holder_reports_running() {
        let tmp = TempDir::new().unwrap();
        let (lock, record) = paths(&tmp);

        // Hold the lock, then a second acquire (this process is alive) contends
        // and gets the holder's record back rather than stealing it.
        let _held = match DaemonLock::acquire(&lock, &record, "127.0.0.1:8787", false).unwrap() {
            DaemonAcquire::Daemon(g) => g,
            DaemonAcquire::Running(_) => panic!("first acquire must win"),
        };
        match DaemonLock::acquire(&lock, &record, "0.0.0.0:9999", false).unwrap() {
            DaemonAcquire::Running(r) => {
                assert_eq!(r.pid, std::process::id());
                assert_eq!(
                    r.addr, "127.0.0.1:8787",
                    "report the HOLDER's addr, not ours"
                );
            }
            DaemonAcquire::Daemon(_) => panic!("a live holder must not be stolen without --force"),
        }
    }

    #[test]
    fn stale_record_on_free_lock_is_overwritten() {
        let tmp = TempDir::new().unwrap();
        let (lock, record) = paths(&tmp);

        // A leftover pidfile from a crashed daemon, with the lock FREE (the
        // common kill-9 case on Unix). Acquire fast-paths and overwrites it.
        let stale = DaemonRecord {
            pid: 999_999_999,
            creation_time: 0,
            addr: "1.2.3.4:9".into(),
            started_at: "2020-01-01T00:00:00Z".into(),
        };
        std::fs::write(&record, serde_json::to_vec(&stale).unwrap()).unwrap();

        // Hold the guard across the read: dropping it would (correctly) remove
        // the pidfile, so bind it rather than `_`.
        let _guard = match DaemonLock::acquire(&lock, &record, "127.0.0.1:8787", false).unwrap() {
            DaemonAcquire::Daemon(g) => g,
            DaemonAcquire::Running(_) => {
                panic!("a free lock must acquire even with a stale pidfile")
            }
        };
        assert_eq!(read_daemon_record(&record).unwrap().addr, "127.0.0.1:8787");
    }

    #[test]
    fn is_record_live_tracks_pid_liveness() {
        let mine = DaemonRecord {
            pid: std::process::id(),
            creation_time: 0,
            addr: "127.0.0.1:8787".into(),
            started_at: "2020-01-01T00:00:00Z".into(),
        };
        assert!(is_record_live(&mine), "this process is alive");

        let dead = DaemonRecord {
            pid: 999_999_999,
            creation_time: 0,
            addr: "127.0.0.1:8787".into(),
            started_at: "2020-01-01T00:00:00Z".into(),
        };
        assert!(!is_record_live(&dead), "a long-dead pid is not live");
    }

    #[test]
    fn daemon_lock_held_reflects_the_flock() {
        let tmp = TempDir::new().unwrap();
        let (lock, record) = paths(&tmp);
        // Nothing holds it yet.
        assert!(!daemon_lock_held(&lock));
        let guard = match DaemonLock::acquire(&lock, &record, "127.0.0.1:8787", false).unwrap() {
            DaemonAcquire::Daemon(g) => g,
            DaemonAcquire::Running(_) => panic!("first acquire must win"),
        };
        // Held while a daemon owns the lock -> a stop / takeover may signal.
        assert!(daemon_lock_held(&lock));
        drop(guard);
        // Released on exit -> a leftover pidfile is provably stale (no signal).
        assert!(!daemon_lock_held(&lock));
    }

    #[test]
    fn record_round_trips() {
        let r = DaemonRecord {
            pid: 42,
            creation_time: 123,
            addr: "[::1]:9901".into(),
            started_at: "2026-06-26T00:00:00+00:00".into(),
        };
        let json = serde_json::to_string(&r).unwrap();
        assert_eq!(r, serde_json::from_str::<DaemonRecord>(&json).unwrap());
    }
}
