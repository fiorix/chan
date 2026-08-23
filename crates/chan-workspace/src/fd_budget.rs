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
/// the live descriptor count between files and backs off once the
/// headroom is gone, so a rebuild can never starve a concurrent
/// autosave or terminal spawn of the handles they need.
/// Bug 7: "Too Many Open Files" during autosave while indexing + two
/// terminals run.
///
/// This is the ceiling on that headroom rather than a flat demand;
/// [`reindex_reserve_for`] scales it down on a table too small to spare it.
const REINDEX_RESERVE: u64 = 64;

/// Spacing between back-off probes while a reindex waits for headroom.
/// Short enough that the rebuild resumes promptly once interactive work
/// releases descriptors, long enough that the probe loop is not a busy
/// spin. The probe reads process-wide kernel state, so we keep the cadence
/// modest.
const REINDEX_BACKOFF_STEP: std::time::Duration = std::time::Duration::from_millis(25);

/// Ceiling on the back-off steps one `pace_reindex_worker` call will take
/// before proceeding anyway, so the wait is `REINDEX_BACKOFF_STEP` times this
/// at worst. Pacing is a courtesy to interactive work, not a correctness gate:
/// under pressure that does not lift, a reindex must degrade into a slower
/// reindex rather than one that never finishes. The failure modes are not
/// symmetric -- running out of descriptors reports itself as an error the
/// caller can act on, while a parked worker is silent and reads as a hang.
///
/// This is the backstop, not the brake: [`reindex_reserve_for`] is what keeps
/// a small table from asking for headroom it can never have. Half a second is
/// far longer than an autosave or a terminal spawn needs to claim its handles.
const REINDEX_BACKOFF_MAX_STEPS: u32 = 20;

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
    pace_reindex_worker_with(snapshot, cancel)
}

/// [`pace_reindex_worker`] with the descriptor probe injected, so the wait
/// bound is testable against a snapshot that never improves. The real call
/// passes [`snapshot`].
fn pace_reindex_worker_with(
    mut probe: impl FnMut() -> Option<FdSnapshot>,
    cancel: Option<&std::sync::atomic::AtomicBool>,
) -> u32 {
    let mut steps = 0u32;
    loop {
        if cancel.is_some_and(|c| c.load(std::sync::atomic::Ordering::Relaxed)) {
            return steps;
        }
        match probe() {
            Some(snap) if reindex_should_pace(snap) => {
                if steps >= REINDEX_BACKOFF_MAX_STEPS {
                    return steps;
                }
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
            // Best-effort and bounded: it never blocks indefinitely.
            None => return pace_no_probe(),
        }
    }
}

/// `None`-snapshot fallback for `pace_reindex_worker`. Unix does not invent fd
/// pressure when its platform probe fails. The time-sliced yield below exists
/// for the Windows graph-DB hang, not descriptor pressure; on non-Unix this
/// dispatches to that yield.
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

/// Headroom a reindex keeps free at this descriptor limit: [`REINDEX_RESERVE`]
/// on any table big enough to give that much away, and a quarter of the table
/// otherwise.
///
/// [`REINDEX_RESERVE`] is sized for the 256-descriptor tables macOS shells hand
/// out, where 64 is a quarter of the budget. Unscaled on a much smaller table
/// it stops describing headroom and starts describing the whole table: at
/// `ulimit -n 72` a process holding its own stdio and index handles never has
/// 64 free, so every snapshot says "back off" and the pacing loop waits for
/// headroom that cannot arrive. Scaling keeps the intent -- leave a slice for
/// a concurrent autosave or terminal spawn -- at every limit, and leaves the
/// macOS case untouched, since `256 / 4` is exactly [`REINDEX_RESERVE`].
fn reindex_reserve_for(limit: u64) -> u64 {
    REINDEX_RESERVE.min(limit / 4)
}

/// Pure decision the pacing loop is built on: should a reindex worker
/// back off at this snapshot? Split out so the policy is unit-testable
/// without touching the real descriptor count or sleeping.
fn reindex_should_pace(snap: FdSnapshot) -> bool {
    snap.remaining() < reindex_reserve_for(snap.limit)
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

/// FreeBSD's bare devfs does not enumerate open descriptors under `/dev/fd`,
/// and opening that directory through fdescfs would itself perturb the count.
/// `KERN_PROC_NFDS` reads the current process's descriptor bitmap directly,
/// without opening a descriptor or allocating a file-information array.
#[cfg(target_os = "freebsd")]
fn fd_snapshot() -> Option<FdSnapshot> {
    let open = freebsd_open_fd_count()?;
    let limit = nofile_limit()?;
    Some(FdSnapshot { open, limit })
}

#[cfg(target_os = "freebsd")]
fn freebsd_open_fd_count() -> Option<u64> {
    let mib = [libc::CTL_KERN, libc::KERN_PROC, libc::KERN_PROC_NFDS, 0];
    let mut count: libc::c_int = 0;
    let mut count_len = std::mem::size_of_val(&count);
    // SAFETY: `mib` and `count` are live, correctly sized objects for the
    // duration of this read-only call. `count_len` describes the writable
    // output buffer, and a null new-value pointer with length zero requests
    // no mutation.
    let status = unsafe {
        libc::sysctl(
            mib.as_ptr(),
            mib.len() as libc::c_uint,
            (&mut count as *mut libc::c_int).cast(),
            &mut count_len,
            std::ptr::null(),
            0,
        )
    };
    decode_sysctl_fd_count(status, count_len, count)
}

#[cfg(any(test, target_os = "freebsd"))]
fn decode_sysctl_fd_count(status: i32, returned_len: usize, count: i32) -> Option<u64> {
    if status != 0 || returned_len != std::mem::size_of::<i32>() {
        return None;
    }
    u64::try_from(count).ok()
}

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

    /// The decode tests above run everywhere; this one is the only thing that
    /// exercises the `sysctl` call itself, so it runs only where that call is
    /// real. It pins the property the whole item exists for: on a stock box
    /// with no `fdescfs` mounted the snapshot is `Some` rather than `None`, and
    /// the count it carries tracks descriptors this process actually holds.
    /// Only the lower bound is asserted, so a sibling test thread opening its
    /// own files cannot make it flake.
    #[cfg(target_os = "freebsd")]
    #[test]
    fn freebsd_measures_live_descriptors_without_fdescfs() {
        const HELD: usize = 16;

        let before = fd_snapshot().expect("KERN_PROC_NFDS must measure a stock FreeBSD box");
        assert!(before.limit > 0, "a descriptor limit must be read too");
        assert!(before.open >= 3, "stdin/stdout/stderr are always open");

        let held: Vec<std::fs::File> = (0..HELD)
            .map(|_| std::fs::File::open("/dev/null").expect("open /dev/null"))
            .collect();
        let during = fd_snapshot().expect("the snapshot stays available under load");
        assert_eq!(during.limit, before.limit, "the limit does not move");
        assert!(
            during.open >= before.open + HELD as u64,
            "holding {HELD} descriptors must show up: {} -> {}",
            before.open,
            during.open
        );
        drop(held);
    }

    #[test]
    fn sysctl_fd_count_requires_an_exact_nonnegative_result() {
        let count_len = std::mem::size_of::<i32>();
        assert_eq!(decode_sysctl_fd_count(0, count_len, 17), Some(17));
        assert_eq!(decode_sysctl_fd_count(-1, count_len, 17), None);
        assert_eq!(decode_sysctl_fd_count(0, count_len - 1, 17), None);
        assert_eq!(decode_sysctl_fd_count(0, count_len, -1), None);
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
    fn the_reserve_scales_down_on_a_table_too_small_to_spare_it() {
        // 256 is the table the flat reserve was sized against, so it and
        // everything above must be unchanged.
        assert_eq!(reindex_reserve_for(256), REINDEX_RESERVE);
        assert_eq!(reindex_reserve_for(4096), REINDEX_RESERVE);
        // Below that the reserve is a quarter of the table rather than most
        // of it.
        assert_eq!(reindex_reserve_for(80), 20);
        assert_eq!(reindex_reserve_for(64), 16);
        assert_eq!(reindex_reserve_for(8), 2);
        assert_eq!(reindex_reserve_for(1), 0);
    }

    #[test]
    fn a_small_table_does_not_pace_on_headroom_it_can_never_have() {
        // Reproduces reindexes that never terminated under `ulimit -n` of 64,
        // 72 and 80 on FreeBSD: a process holding stdio plus its index handles
        // never leaves 64 descriptors free in a table this size, so a flat
        // 64-descriptor demand asks for headroom that cannot arrive.
        for limit in [64, 72, 80] {
            let realistic = FdSnapshot { open: 24, limit };
            assert!(
                !reindex_should_pace(realistic),
                "limit {limit} must make progress, not wait on 64 free"
            );
        }
        // The protection itself is intact: a quarter-full table still paces.
        let squeezed = FdSnapshot {
            open: 72 - 4,
            limit: 72,
        };
        assert!(reindex_should_pace(squeezed));
    }

    #[test]
    fn pace_reindex_worker_stops_waiting_for_headroom_that_never_arrives() {
        // Pressure that never lifts, at a limit large enough that the reserve
        // is satisfiable in principle. The worker must give up and let the
        // rebuild proceed rather than park on it forever.
        let stuck = FdSnapshot {
            open: 4096 - 1,
            limit: 4096,
        };
        assert!(reindex_should_pace(stuck));
        assert_eq!(
            pace_reindex_worker_with(|| Some(stuck), None),
            REINDEX_BACKOFF_MAX_STEPS
        );
    }

    #[test]
    fn pace_reindex_worker_returns_immediately_when_cancelled() {
        // A cancel flag set before the call short-circuits the wait so
        // a shutdown is never delayed by pacing, even under pressure.
        let cancel = std::sync::atomic::AtomicBool::new(true);
        assert_eq!(pace_reindex_worker(Some(&cancel)), 0);
    }
}
