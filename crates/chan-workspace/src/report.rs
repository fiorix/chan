// Per-workspace SLOC / language / COCOMO report, backed by chan-report.
//
// chan-workspace owns the persisted JSONL (WorkspacePaths::report), debounces
// writes through a dedicated worker thread, and fans filesystem-watch
// events into the in-memory Index so chan-report stays current
// without a full rescan on every change. Public access goes through
// `Workspace::report()` / `Workspace::report_jsonl_path()`.

use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use chan_report::{CocomoParams, Index, Report, ReportOptions, Scope, UpdateOutcome};

use crate::error::{ChanError, Result};
use crate::fs_ops::{atomic_write, IndexScopePolicy};
use crate::watch::{WatchCallback, WatchEvent, WatchKind};

/// Bursts of filesystem events (`git checkout`, bulk save) hit the
/// Index in quick succession. We coalesce writes to the on-disk
/// JSONL with a short window: a flush request waits this long,
/// drains the channel of any additional signals that arrived
/// during the window, then writes once. Tuned for "feels fresh"
/// without causing thrash on a five-second branch switch.
const FLUSH_DEBOUNCE: Duration = Duration::from_millis(500);

/// Per-workspace report state. Owned by `Workspace` through a `OnceLock`
/// so we pay the initial scan only when the report is actually
/// used (call `Workspace::report()` or `Workspace::watch()` to warm).
///
/// Three pieces:
///   - `index`: the live chan-report Index behind an RwLock so
///     watcher writes and reader snapshots can interleave.
///   - `flush_tx`: signals the writer thread that the index
///     changed and the on-disk JSONL needs rewriting.
///   - `writer`: the join handle for the writer thread, taken
///     during Drop so chan-workspace doesn't outlive its own thread.
pub(crate) struct ReportState {
    index: Arc<RwLock<Index>>,
    jsonl_path: PathBuf,
    cocomo: CocomoParams,
    flush_tx: Option<Sender<()>>,
    writer: Option<JoinHandle<()>>,
}

impl ReportState {
    /// Initialize state: try to load the persisted JSONL, fall
    /// back to a full scan on missing-or-corrupt. Spawns the
    /// writer thread. Caller wraps the returned value in an
    /// `Arc` for shared ownership with the watcher fanout.
    pub(crate) fn open(
        workspace_root: &Path,
        jsonl_path: &Path,
        policy: Arc<IndexScopePolicy>,
    ) -> Result<Arc<Self>> {
        let opts = report_options(workspace_root, policy);

        // Try the persisted form first. Any error (missing file,
        // schema mismatch, parse error, partial write) falls
        // through to a full scan. The new scan replaces the bad
        // file on the next flush.
        let loaded = match std::fs::File::open(jsonl_path) {
            Ok(f) => Index::load_jsonl(BufReader::new(f), &opts).ok(),
            Err(_) => None,
        };
        let index = match loaded {
            Some(idx) => idx,
            None => Index::scan(&opts).map_err(|e| ChanError::Report(e.to_string()))?,
        };

        let index = Arc::new(RwLock::new(index));
        let cocomo = opts.cocomo.clone();
        let jsonl_path = jsonl_path.to_path_buf();

        let (flush_tx, flush_rx) = mpsc::channel::<()>();
        let writer = {
            let index = index.clone();
            let path = jsonl_path.clone();
            let cocomo = cocomo.clone();
            thread::Builder::new()
                .name("chan-report-writer".into())
                .spawn(move || writer_loop(flush_rx, index, path, cocomo))
                .map_err(|e| ChanError::Report(format!("spawn writer thread: {e}")))?
        };

        // Eagerly write the initial state so the file exists after
        // first open. Best-effort: failures only warn, the writer
        // thread will retry on the next flush.
        let _ = flush_tx.send(());

        Ok(Arc::new(Self {
            index,
            jsonl_path,
            cocomo,
            flush_tx: Some(flush_tx),
            writer: Some(writer),
        }))
    }

    /// Apply one watch event to the index. Called from the
    /// FanOut callback on the watcher's worker thread; must not
    /// block, must not panic. Errors are logged and swallowed
    /// because the watcher has no useful place to surface them.
    pub(crate) fn on_event(&self, ev: &WatchEvent) {
        let outcome = {
            let mut idx = match self.index.write() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            if idx.path_policy_generation() != Some(ev.generation.get()) {
                return;
            }
            match ev.kind {
                WatchKind::Removed => match &ev.path {
                    Some(p) => idx.remove(p),
                    None => return,
                },
                WatchKind::Renamed => match (&ev.path, &ev.to) {
                    (Some(from), Some(to)) => match idx.rename(from, to) {
                        Ok(o) => o,
                        Err(e) => {
                            tracing::warn!(error = %e, "chan-report rename failed");
                            return;
                        }
                    },
                    // macOS FSEvents reports a rename as UNPAIRED Name events
                    // (one path each, no `to`), so the paired arm above never
                    // fires there. Treat a lone path as an update: `idx.update`
                    // stats the path, indexing the destination if it now
                    // exists or dropping the row if the source vanished.
                    // Without this the rename destination never gets a report
                    // row, so its graph language edge stays missing until a
                    // later edit re-indexes it via a Modified event.
                    (Some(p), None) => match idx.update(p) {
                        Ok(o) => o,
                        Err(e) => {
                            tracing::warn!(error = %e, "chan-report rename update failed");
                            return;
                        }
                    },
                    (None, _) => return,
                },
                WatchKind::Created | WatchKind::Modified => {
                    let Some(p) = &ev.path else {
                        return;
                    };
                    match idx.update(p) {
                        Ok(o) => o,
                        Err(e) => {
                            tracing::warn!(error = %e, "chan-report update failed");
                            return;
                        }
                    }
                }
                WatchKind::ProviderError => {
                    // The watcher itself signaled it lost events.
                    // chan-report's Index can't tell from here
                    // which paths got out of sync, so the right
                    // recovery is a full rescan. Leave that to a
                    // future explicit Workspace::rebuild_report().
                    return;
                }
            }
        };
        if !matches!(outcome, UpdateOutcome::Unchanged | UpdateOutcome::Skipped) {
            if let Some(tx) = &self.flush_tx {
                let _ = tx.send(());
            }
        }
    }

    pub(crate) fn snapshot(&self, scope: &Scope) -> Report {
        let idx = match self.index.read() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        idx.snapshot(scope, &self.cocomo)
    }

    pub(crate) fn policy_generation(&self) -> Option<u64> {
        match self.index.read() {
            Ok(index) => index.path_policy_generation(),
            Err(poisoned) => poisoned.into_inner().path_policy_generation(),
        }
    }

    /// Replace the cached report with a scan governed by a newer scope.
    ///
    /// The caller holds the workspace derived-state serialization lock, so
    /// watcher mutations cannot land between the scan and swap.
    pub(crate) fn replace_policy(
        &self,
        workspace_root: &Path,
        policy: Arc<IndexScopePolicy>,
    ) -> Result<()> {
        let opts = report_options(workspace_root, policy);
        let replacement =
            Index::scan(&opts).map_err(|error| ChanError::Report(error.to_string()))?;
        match self.index.write() {
            Ok(mut index) => *index = replacement,
            Err(poisoned) => *poisoned.into_inner() = replacement,
        }
        if let Some(tx) = &self.flush_tx {
            let _ = tx.send(());
        }
        Ok(())
    }

    /// O(1) cached read of the per-directory aggregation. Mirrors
    /// `Index::dir_report` and exposes `None` to the caller when
    /// the directory is untracked so the HTTP layer can serve a
    /// 404 cleanly.
    pub(crate) fn dir_snapshot(&self, dir: &str) -> Option<Report> {
        let idx = match self.index.read() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        idx.dir_report(dir, &self.cocomo)
    }

    pub(crate) fn jsonl_path(&self) -> &Path {
        &self.jsonl_path
    }
}

pub(crate) fn load_snapshot_if_available(
    workspace_root: &Path,
    jsonl_path: &Path,
    policy: Arc<IndexScopePolicy>,
) -> Result<Option<Report>> {
    let file = match std::fs::File::open(jsonl_path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(ChanError::Report(error.to_string())),
    };
    let opts = report_options(workspace_root, policy);
    let Ok(index) = Index::load_jsonl(BufReader::new(file), &opts) else {
        return Ok(None);
    };
    Ok(Some(index.snapshot(&Scope::All, &opts.cocomo)))
}

fn report_options(workspace_root: &Path, policy: Arc<IndexScopePolicy>) -> ReportOptions {
    let mut opts = ReportOptions::new(workspace_root);
    opts.path_policy = Some(policy);
    opts
}

impl Drop for ReportState {
    fn drop(&mut self) {
        // Closing the channel signals the writer to exit. Joining
        // ensures any in-flight flush finishes before chan-workspace
        // tears down state the writer might be reading.
        self.flush_tx.take();
        if let Some(w) = self.writer.take() {
            let _ = w.join();
        }
    }
}

/// Fan-out callback that forwards every watch event to the user's
/// callback AND into the report state. Order: report first, so the
/// index reflects the change by the time the user's handler runs
/// (and might call Workspace::report()).
///
/// The report slot is the workspace's shared lazy `OnceLock`, not a scanned
/// `ReportState`: `Workspace::watch()` attaches this fan-out without paying the
/// report's content scan (the biggest cold-boot cost), so watcher registration
/// stays fast. The scan runs separately (`Workspace::report()` / `boot()`) and
/// fills the cell; until then report events are dropped, since the scan itself
/// captures the current filesystem state. The user callback always sees every
/// event. Warm report mutations take the workspace's shared derived-state
/// serialization boundary; the user callback runs after that guard is dropped.
pub(crate) struct ReportFanOut {
    user_cb: Arc<dyn WatchCallback>,
    report: Arc<OnceLock<Arc<ReportState>>>,
    write_serial: Arc<Mutex<()>>,
}

impl ReportFanOut {
    pub(crate) fn new(
        user_cb: Arc<dyn WatchCallback>,
        report: Arc<OnceLock<Arc<ReportState>>>,
        write_serial: Arc<Mutex<()>>,
    ) -> Arc<Self> {
        Arc::new(Self {
            user_cb,
            report,
            write_serial,
        })
    }
}

impl WatchCallback for ReportFanOut {
    fn on_event(&self, event: WatchEvent) {
        // Forward into the report only once it has been scanned; before that
        // the slot is empty and the event is a no-op for the report (the
        // pending scan reflects this file's on-disk state anyway).
        if let Some(report) = self.report.get() {
            let _serial = self.write_serial.lock().unwrap();
            report.on_event(&event);
        }
        self.user_cb.on_event(event);
    }
}

fn writer_loop(
    rx: mpsc::Receiver<()>,
    index: Arc<RwLock<Index>>,
    jsonl_path: PathBuf,
    cocomo: CocomoParams,
) {
    while rx.recv().is_ok() {
        // Debounce. The first signal kicks the wait; further
        // signals during the window are drained so a burst still
        // produces a single write.
        thread::sleep(FLUSH_DEBOUNCE);
        while rx.try_recv().is_ok() {}

        let mut buf = Vec::new();
        let write_result = {
            let idx = match index.read() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            idx.write_jsonl(&mut buf, &Scope::All, &cocomo)
        };
        if let Err(e) = write_result {
            tracing::warn!(error = %e, "chan-report write_jsonl failed");
            continue;
        }
        if let Some(parent) = jsonl_path.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                tracing::warn!(error = %e, path = %parent.display(), "chan-report mkdir failed");
                continue;
            }
        }
        if let Err(e) = atomic_write(&jsonl_path, &buf) {
            tracing::warn!(error = %e, path = %jsonl_path.display(), "chan-report atomic_write failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn lang_of(state: &ReportState, rel: &str) -> Option<String> {
        state
            .snapshot(&Scope::All)
            .files
            .into_iter()
            .find(|f| f.path == rel)
            .map(|f| f.language)
    }

    // macOS FSEvents delivers a rename as UNPAIRED Name events (one path
    // each, `to` = None), so the report's Renamed handler must still
    // (re)index a lone path. Without it the rename DESTINATION never gets a
    // report row, so the graph's language layer emits no language edge for
    // it and the file renders as a floating node until a later edit heals
    // it. Regression for that staleness bug.
    #[test]
    fn unpaired_rename_indexes_destination_and_drops_source() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        fs::write(root.join("a.md"), "# A\n\nprose\n").unwrap();
        let jsonl = root.join(".chan/report.jsonl");
        let policy = Arc::new(
            IndexScopePolicy::new(
                root.to_path_buf(),
                crate::WorkspaceGeneration::INITIAL,
                crate::WalkFilter::default(),
            )
            .unwrap(),
        );
        let state = ReportState::open(root, &jsonl, policy).unwrap();
        assert_eq!(lang_of(&state, "a.md").as_deref(), Some("Markdown"));

        // `mv a.md b.md`. macOS surfaces this as the destination's lone Name
        // event (the file now exists at b.md) and the source's lone Name
        // event (a.md is gone), each with `to` = None.
        fs::rename(root.join("a.md"), root.join("b.md")).unwrap();
        state.on_event(&WatchEvent::rename(
            Some("b.md".to_string()),
            None,
            false,
            None,
            crate::WorkspaceGeneration::INITIAL,
        ));
        assert_eq!(
            lang_of(&state, "b.md").as_deref(),
            Some("Markdown"),
            "unpaired-rename destination must be indexed with its language",
        );

        state.on_event(&WatchEvent::rename(
            Some("a.md".to_string()),
            None,
            false,
            None,
            crate::WorkspaceGeneration::INITIAL,
        ));
        assert!(
            lang_of(&state, "a.md").is_none(),
            "vanished rename source must be dropped from the report",
        );
    }
}
