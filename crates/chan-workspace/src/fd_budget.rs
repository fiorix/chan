//! File-descriptor pressure probes for indexing internals.
//!
//! chan-workspace runs inside the editor process, so search indexing must
//! leave room for ordinary editor reads, writes, terminal PTYs, and
//! watcher handles. macOS shells commonly start with a soft `nofile`
//! limit of 256, which is low enough that eager SQLite pools plus
//! Tantivy worker fanout can exhaust the process table during first
//! boot on a large workspace.

use std::sync::{Condvar, Mutex, OnceLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct FdSnapshot {
    pub open: u64,
    pub limit: u64,
}

impl FdSnapshot {
    fn remaining(self) -> u64 {
        self.limit.saturating_sub(self.open)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TantivyWriterBudget {
    pub worker_threads: usize,
    pub merge_threads: usize,
}

#[derive(Debug)]
pub(crate) struct WorkspacePermit {
    _private: (),
}

struct WorkspaceGate {
    state: Mutex<WorkspaceGateState>,
    ready: Condvar,
}

#[derive(Default)]
struct WorkspaceGateState {
    active: usize,
}

const LOW_LIMIT: u64 = 512;
// The nofile/rlimit ceiling is a unix concept: both `nofile_limit` arms and
// `effective_nofile_limit` are unix-only, so off unix (Windows) this const has
// no users. `#[cfg(unix)]` keeps the windows build dead-code-clean under
// `-D warnings`.
#[cfg(unix)]
const EFFECTIVE_NOFILE_CEILING: u64 = 4096;
const TIGHT_HEADROOM: u64 = 96;
const MODEST_HEADROOM: u64 = 192;
const MAX_ACTIVE_WORKSPACES: usize = 64;
const LOW_LIMIT_ACTIVE_WORKSPACES: usize = 8;
const TIGHT_HEADROOM_ACTIVE_WORKSPACES: usize = 4;
const MODEST_HEADROOM_ACTIVE_WORKSPACES: usize = 8;

/// Descriptors a reindex pass keeps in reserve for interactive work
/// (editor reads/writes, terminal PTYs + their pipes, watcher handles).
/// The other budget knobs above are sized ONCE when an index opens;
/// they cannot react to terminals or editor handles that appear AFTER
/// a long reindex has already committed to its worker count. This
/// reserve is the mid-flight piece: the reindex read loop re-samples
/// the live descriptor count between files and backs off when fewer
/// than this many descriptors remain, so a rebuild can never starve a
/// concurrent autosave or terminal spawn of the handles they need.
/// Bug 7: "Too Many Open Files" during autosave while indexing + two
/// terminals run.
const REINDEX_RESERVE: u64 = 64;

/// Spacing between back-off probes while a reindex waits for headroom.
/// Short enough that the rebuild resumes promptly once interactive work
/// releases descriptors, long enough that the probe loop is not a busy
/// spin. The probe itself is a `read_dir("/dev/fd")` count, so we keep
/// the cadence modest.
const REINDEX_BACKOFF_STEP: std::time::Duration = std::time::Duration::from_millis(25);

/// Non-Unix only: how many files a reindex worker processes between
/// time-sliced yields (see `pace_reindex_worker_timesliced`). Unix paces
/// off live fd pressure and ignores this. The value trades reindex
/// throughput against interactive responsiveness: small enough that a
/// busy graph DB drains often (a 25ms pause every 32 files yields the
/// writer's tx window many times a second during a cold rebuild), large
/// enough that the cumulative sleep is a small fraction of total reindex
/// time on a real workspace.
#[cfg(not(unix))]
const REINDEX_TIMESLICE_FILES: u32 = 32;

static WORKSPACE_GATE: OnceLock<WorkspaceGate> = OnceLock::new();

pub(crate) fn snapshot() -> Option<FdSnapshot> {
    fd_snapshot()
}

pub(crate) fn graph_reader_pool_size(default: u32) -> u32 {
    match snapshot() {
        Some(snap) => graph_reader_pool_size_for(default, snap),
        None => default.max(1),
    }
}

pub(crate) fn cap_index_read_workers(requested: usize) -> usize {
    match snapshot() {
        Some(snap) => cap_index_read_workers_for(requested, snap),
        None => requested.max(1),
    }
}

pub(crate) fn tantivy_writer_budget(default_worker_threads: usize) -> TantivyWriterBudget {
    match snapshot() {
        Some(snap) => tantivy_writer_budget_for(default_worker_threads, snap),
        None => TantivyWriterBudget {
            worker_threads: default_worker_threads.max(1),
            merge_threads: 4,
        },
    }
}

pub(crate) fn acquire_workspace_permit() -> WorkspacePermit {
    let gate = workspace_gate();
    let mut state = gate.state.lock().unwrap_or_else(|e| e.into_inner());
    loop {
        let capacity = match snapshot() {
            Some(snap) => active_workspace_capacity_for(snap),
            None => MAX_ACTIVE_WORKSPACES,
        };
        if state.active < capacity {
            state.active += 1;
            return WorkspacePermit { _private: () };
        }
        state = gate.ready.wait(state).unwrap_or_else(|e| e.into_inner());
    }
}

/// Block a reindex worker until at least `REINDEX_RESERVE` descriptors
/// are free, re-sampling the live count each step. Returns immediately
/// when headroom is clear (the common case) or when the platform can't
/// report descriptor pressure (`fd_snapshot` is `None`, e.g. non-Unix);
/// pacing is best-effort and never blocks indefinitely on a stuck
/// probe. `cancel` lets a shutdown abort the wait promptly instead of
/// parking through it. Returns the number of back-off steps taken so
/// callers can surface pacing in diagnostics/tests.
///
/// This is the mid-flight counterpart to the open-time budget knobs:
/// those size the pools when the index opens; this keeps a long
/// rebuild from holding fds an interactive autosave or terminal spawn
/// needs RIGHT NOW.
pub(crate) fn pace_reindex_worker(cancel: Option<&std::sync::atomic::AtomicBool>) -> u32 {
    let mut steps = 0u32;
    loop {
        if cancel.is_some_and(|c| c.load(std::sync::atomic::Ordering::Relaxed)) {
            return steps;
        }
        match snapshot() {
            Some(snap) if reindex_should_pace(snap) => {
                steps = steps.saturating_add(1);
                std::thread::sleep(REINDEX_BACKOFF_STEP);
            }
            // Clear headroom: don't pace. On platforms with a probe this
            // is the common case.
            Some(_) => return steps,
            // No descriptor probe available: the fd-pressure heuristics
            // above all key off `snapshot()`. On non-Unix (Windows) this
            // is the ONLY arm, and without pacing the cold rebuild would
            // monopolise the graph DB -- the Windows file-open hang. We
            // can't measure fd pressure, so we fall back to a coarse
            // time-sliced yield (see `pace_reindex_worker_timesliced`).
            // Best-effort and bounded: it never blocks indefinitely. It is
            // also reachable on FreeBSD without `fdescfs`, where the same
            // reasoning does not apply; see `pace_no_probe`.
            None => return pace_no_probe(),
        }
    }
}

/// `None`-snapshot fallback for `pace_reindex_worker`. Unix does not pace
/// without a probe: Linux and macOS always have one, and FreeBSD without
/// `fdescfs` reaches this arm with the same reindex behaviour it had when the
/// stub `/dev/fd` count reported permanent clear headroom. The time-sliced
/// yield below exists for the Windows graph-DB hang, which is not a condition
/// FreeBSD is in. On non-Unix this dispatches to that yield.
#[cfg(unix)]
fn pace_no_probe() -> u32 {
    0
}

#[cfg(not(unix))]
fn pace_no_probe() -> u32 {
    pace_reindex_worker_timesliced()
}

/// Non-Unix fallback throttle for `pace_reindex_worker`. Unix paces off
/// live descriptor pressure; Windows has no `/dev/fd` probe, so we pace
/// off a per-worker file counter instead: every
/// `REINDEX_TIMESLICE_FILES` files a worker processes, it sleeps one
/// `REINDEX_BACKOFF_STEP`. That brief, periodic pause is enough for the
/// graph writer's transaction window to drain and for queued inspector /
/// backlinks / graph reads to acquire the DB, so the workspace window
/// stays responsive while the first index builds -- without any Win32
/// FFI. The counter is thread-local so each reindex worker paces
/// independently and there is no shared atomic on the hot per-file path.
#[cfg(not(unix))]
fn pace_reindex_worker_timesliced() -> u32 {
    use std::cell::Cell;
    thread_local! {
        static FILES_SINCE_YIELD: Cell<u32> = const { Cell::new(0) };
    }
    FILES_SINCE_YIELD.with(|c| {
        let next = c.get() + 1;
        if next >= REINDEX_TIMESLICE_FILES {
            c.set(0);
            std::thread::sleep(REINDEX_BACKOFF_STEP);
            1
        } else {
            c.set(next);
            0
        }
    })
}

/// Pure decision the pacing loop is built on: should a reindex worker
/// back off at this snapshot? Split out so the policy is unit-testable
/// without touching the real `/dev/fd` count or sleeping.
fn reindex_should_pace(snap: FdSnapshot) -> bool {
    snap.remaining() < REINDEX_RESERVE
}

fn graph_reader_pool_size_for(default: u32, snap: FdSnapshot) -> u32 {
    let default = default.max(1);
    if snap.limit <= LOW_LIMIT || snap.remaining() < TIGHT_HEADROOM {
        1
    } else if snap.remaining() < MODEST_HEADROOM {
        default.min(2)
    } else {
        default
    }
}

fn cap_index_read_workers_for(requested: usize, snap: FdSnapshot) -> usize {
    let requested = requested.max(1);
    if snap.limit <= LOW_LIMIT || snap.remaining() < TIGHT_HEADROOM {
        1
    } else if snap.remaining() < MODEST_HEADROOM {
        requested.min(2)
    } else {
        requested
    }
}

fn tantivy_writer_budget_for(
    default_worker_threads: usize,
    snap: FdSnapshot,
) -> TantivyWriterBudget {
    let default_worker_threads = default_worker_threads.max(1);
    if snap.limit <= LOW_LIMIT || snap.remaining() < TIGHT_HEADROOM {
        TantivyWriterBudget {
            worker_threads: 1,
            merge_threads: 1,
        }
    } else if snap.remaining() < MODEST_HEADROOM {
        TantivyWriterBudget {
            worker_threads: default_worker_threads.min(2),
            merge_threads: 1,
        }
    } else {
        TantivyWriterBudget {
            worker_threads: default_worker_threads,
            merge_threads: 4,
        }
    }
}

fn active_workspace_capacity_for(snap: FdSnapshot) -> usize {
    if snap.limit <= LOW_LIMIT {
        LOW_LIMIT_ACTIVE_WORKSPACES
    } else if snap.remaining() < TIGHT_HEADROOM {
        TIGHT_HEADROOM_ACTIVE_WORKSPACES
    } else if snap.remaining() < MODEST_HEADROOM {
        MODEST_HEADROOM_ACTIVE_WORKSPACES
    } else {
        MAX_ACTIVE_WORKSPACES
    }
}

fn workspace_gate() -> &'static WorkspaceGate {
    WORKSPACE_GATE.get_or_init(|| WorkspaceGate {
        state: Mutex::new(WorkspaceGateState::default()),
        ready: Condvar::new(),
    })
}

impl Drop for WorkspacePermit {
    fn drop(&mut self) {
        let gate = workspace_gate();
        let mut state = gate.state.lock().unwrap_or_else(|e| e.into_inner());
        state.active = state.active.saturating_sub(1);
        gate.ready.notify_one();
    }
}

#[cfg(all(unix, not(target_os = "freebsd")))]
fn fd_snapshot() -> Option<FdSnapshot> {
    let open = std::fs::read_dir("/dev/fd").ok()?.count() as u64;
    let limit = nofile_limit()?;
    Some(FdSnapshot { open, limit })
}

/// FreeBSD only counts descriptors through `/dev/fd` when `fdescfs` is mounted
/// over it. Bare devfs publishes `0`, `1`, `2` and nothing else, so the count
/// is a constant 3 however many descriptors the process holds. Reporting that
/// is worse than reporting nothing: every consumer would read permanent clear
/// headroom and disengage, believing it had measured something. Probe once for
/// the real thing and fall back to "no probe" when it is absent.
#[cfg(target_os = "freebsd")]
fn fd_snapshot() -> Option<FdSnapshot> {
    if !dev_fd_lists_open_descriptors() {
        return None;
    }
    let open = std::fs::read_dir("/dev/fd").ok()?.count() as u64;
    let limit = nofile_limit()?;
    Some(FdSnapshot { open, limit })
}

/// Whether `/dev/fd` reflects this process's descriptors. Holding a descriptor
/// the listing has to show separates `fdescfs` from the devfs stub: with the
/// stub the answer is always exactly the three standard entries, while under
/// `fdescfs` the probe descriptor and `read_dir`'s own handle are both listed,
/// which the stub can never reach. Resolved once; the mount does not come and
/// go under a running devserver.
#[cfg(target_os = "freebsd")]
fn dev_fd_lists_open_descriptors() -> bool {
    static LIVE: OnceLock<bool> = OnceLock::new();
    *LIVE.get_or_init(|| {
        let Ok(probe) = std::fs::File::open("/dev/null") else {
            return false;
        };
        let seen = std::fs::read_dir("/dev/fd")
            .map(|entries| entries.count())
            .unwrap_or(0);
        drop(probe);
        seen > STUB_DEV_FD_ENTRIES
    })
}

/// `0`, `1`, `2`: what bare devfs publishes under `/dev/fd`.
#[cfg(target_os = "freebsd")]
const STUB_DEV_FD_ENTRIES: usize = 3;

#[cfg(not(unix))]
fn fd_snapshot() -> Option<FdSnapshot> {
    None
}

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "freebsd"))]
fn nofile_limit() -> Option<u64> {
    let current = rustix::process::getrlimit(rustix::process::Resource::Nofile).current;
    Some(effective_nofile_limit(current))
}

#[cfg(all(
    unix,
    not(any(target_os = "linux", target_os = "macos", target_os = "freebsd"))
))]
fn nofile_limit() -> Option<u64> {
    Some(EFFECTIVE_NOFILE_CEILING)
}

// Called only from the rlimit arm of `nofile_limit`, clamping the host value.
// The remaining unix arm returns the ceiling directly and off unix there is no
// rlimit to clamp, so the gate names its callers' platforms and every other
// target stays dead-code-clean under `-D warnings`.
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "freebsd"))]
fn effective_nofile_limit(limit: Option<u64>) -> u64 {
    limit
        .unwrap_or(EFFECTIVE_NOFILE_CEILING)
        .min(EFFECTIVE_NOFILE_CEILING)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn graph_pool_shrinks_on_low_soft_limit() {
        let snap = FdSnapshot {
            open: 20,
            limit: 256,
        };
        assert_eq!(graph_reader_pool_size_for(4, snap), 1);
    }

    #[test]
    fn graph_pool_shrinks_when_headroom_is_tight() {
        let snap = FdSnapshot {
            open: 950,
            limit: 1024,
        };
        assert_eq!(graph_reader_pool_size_for(4, snap), 1);
    }

    #[test]
    fn graph_pool_keeps_default_when_headroom_is_clear() {
        let snap = FdSnapshot {
            open: 100,
            limit: 1024,
        };
        assert_eq!(graph_reader_pool_size_for(4, snap), 4);
    }

    #[test]
    fn index_read_workers_are_capped_under_fd_pressure() {
        let snap = FdSnapshot {
            open: 200,
            limit: 256,
        };
        assert_eq!(cap_index_read_workers_for(6, snap), 1);
    }

    #[test]
    fn tantivy_writer_budget_uses_single_thread_under_low_limit() {
        let snap = FdSnapshot {
            open: 20,
            limit: 256,
        };
        assert_eq!(
            tantivy_writer_budget_for(3, snap),
            TantivyWriterBudget {
                worker_threads: 1,
                merge_threads: 1
            }
        );
    }

    #[test]
    fn active_workspace_capacity_is_bounded_on_low_soft_limit() {
        let snap = FdSnapshot {
            open: 20,
            limit: 256,
        };
        assert_eq!(
            active_workspace_capacity_for(snap),
            LOW_LIMIT_ACTIVE_WORKSPACES
        );
    }

    #[test]
    fn active_workspace_capacity_uses_internal_ceiling_with_clear_headroom() {
        let snap = FdSnapshot {
            open: 20,
            limit: 4096,
        };
        assert_eq!(active_workspace_capacity_for(snap), MAX_ACTIVE_WORKSPACES);
    }

    // Exercises `effective_nofile_limit` / `EFFECTIVE_NOFILE_CEILING`; gated to
    // match the function so every other target's `--tests` build stays clean.
    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "freebsd"))]
    #[test]
    fn unlimited_nofile_uses_internal_ceiling() {
        assert_eq!(effective_nofile_limit(None), EFFECTIVE_NOFILE_CEILING);
        assert_eq!(
            effective_nofile_limit(Some(EFFECTIVE_NOFILE_CEILING * 4)),
            EFFECTIVE_NOFILE_CEILING
        );
    }

    #[test]
    fn reindex_paces_when_headroom_drops_below_reserve() {
        // Editor + two terminals + watcher handles have eaten into a
        // 256-fd table: only 32 descriptors remain, under the
        // REINDEX_RESERVE floor. The reindex must yield.
        let tight = FdSnapshot {
            open: 256 - 32,
            limit: 256,
        };
        assert!(reindex_should_pace(tight));
    }

    #[test]
    fn reindex_does_not_pace_with_clear_headroom() {
        // A roomy table: a rebuild runs full-tilt without yielding.
        let clear = FdSnapshot {
            open: 100,
            limit: 4096,
        };
        assert!(!reindex_should_pace(clear));
    }

    #[test]
    fn reindex_pace_boundary_is_inclusive_of_the_reserve() {
        // Exactly REINDEX_RESERVE free is enough; one fewer pages out.
        let at_reserve = FdSnapshot {
            open: 256 - REINDEX_RESERVE,
            limit: 256,
        };
        assert!(!reindex_should_pace(at_reserve));
        let just_under = FdSnapshot {
            open: 256 - (REINDEX_RESERVE - 1),
            limit: 256,
        };
        assert!(reindex_should_pace(just_under));
    }

    #[test]
    fn pace_reindex_worker_returns_immediately_when_cancelled() {
        // A cancel flag set before the call short-circuits the wait so
        // a shutdown is never delayed by pacing, even under pressure.
        let cancel = std::sync::atomic::AtomicBool::new(true);
        assert_eq!(pace_reindex_worker(Some(&cancel)), 0);
    }
}
