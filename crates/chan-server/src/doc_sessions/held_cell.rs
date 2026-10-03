//! Pieces shared by the document and the drawing sessions' tests of a
//! background task beside a workspace cell whose write guard is held, the way
//! a storage reset or a metadata import holds it for its whole swap.

use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use chan_workspace::Workspace;
use tokio::sync::broadcast;

use crate::indexer::Indexer;
use crate::state::WorkspaceCell;

pub(crate) type Cell = Arc<RwLock<Option<WorkspaceCell>>>;

/// How long a pin waits for what must happen.
pub(crate) const MUST_HAPPEN: Duration = Duration::from_secs(10);

/// A hold of the cell that outlasts the time after which a flusher told to
/// stop says that the cell is still held.
pub(crate) const A_LONG_HOLD: Duration =
    super::STOP_CELL_WARN_AFTER.saturating_add(Duration::from_millis(500));

/// A hold of the cell far longer than any shutdown grace, for a pin on a
/// paused clock: a flusher told to stop looks into the cell twenty-four
/// thousand times in it.
pub(crate) const A_HOLD_PAST_ANY_GRACE: Duration = Duration::from_secs(600);

/// How long the probe of [`worker_stays_free`] may take to end.
const PROBE_BOUND: Duration = Duration::from_secs(5);

/// The probe needs its worker this many times, this far apart: six hundred
/// milliseconds in all, longer than two ticks of a flusher.
const PROBE_STEPS: usize = 60;
const PROBE_STEP: Duration = Duration::from_millis(10);

/// A cell that holds `workspace`. Called inside a runtime, where the indexer
/// starts its tasks. The indexer listens on a channel of its own that closes
/// here, so a test's watch events reach only the task under test.
pub(crate) fn cell_of(workspace: &Arc<Workspace>) -> Cell {
    let (index_events, _) = broadcast::channel(1);
    let indexer = Arc::new(Indexer::spawn(
        workspace.clone(),
        index_events.subscribe(),
        false,
        chan_workspace::SearchAggression::Conservative,
        Arc::new(chan_workspace::NoProgress),
    ));
    Arc::new(RwLock::new(Some(WorkspaceCell {
        workspace: workspace.clone(),
        watch_handle: None,
        indexer,
    })))
}

/// Run `beside` while this thread holds the cell's write guard.
pub(crate) fn while_held<T>(cell: &Cell, beside: impl FnOnce() -> T) -> T {
    let held = cell.write().expect("workspace cell");
    let out = beside();
    drop(held);
    out
}

/// The cell's write guard, held on a thread of its own so that a test can
/// await beside it. Dropping it lets the cell go.
pub(crate) struct Hold {
    let_go: Option<std::sync::mpsc::Sender<()>>,
    holder: Option<std::thread::JoinHandle<()>>,
}

/// Take the cell's write guard and keep it until the returned [`Hold`] is
/// dropped.
pub(crate) fn hold(cell: &Cell) -> Hold {
    let (let_go, told) = std::sync::mpsc::channel::<()>();
    let (holding, held) = std::sync::mpsc::channel();
    let cell = cell.clone();
    let holder = std::thread::spawn(move || {
        let _guard = cell.write().expect("workspace cell");
        holding.send(()).expect("the test waits for the hold");
        // Ends when the hold is dropped, which closes the channel.
        let _ = told.recv();
    });
    held.recv_timeout(MUST_HAPPEN)
        .expect("the cell's write guard");
    Hold {
        let_go: Some(let_go),
        holder: Some(holder),
    }
}

impl Drop for Hold {
    fn drop(&mut self) {
        drop(self.let_go.take());
        if let Some(holder) = self.holder.take() {
            let _ = holder.join();
        }
    }
}

/// Look every few milliseconds until `done` holds or `bound` has passed;
/// whether it held. It sleeps on the calling thread, so a test calls it from
/// its own thread and never from a runtime worker.
pub(crate) fn within(bound: Duration, mut done: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + bound;
    loop {
        if done() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// Whether a task on a runtime of one worker keeps running beside the tasks
/// `start` spawns, while this thread holds the cell's write guard. `start`
/// runs inside the runtime: it spawns its tasks over the cell and does what
/// makes them look into it. What it returns is kept until the probe has
/// ended, so a channel a task listens on stays open.
///
/// The probe is a task that needs the worker again and again for longer than
/// two flusher ticks, so a task that waits for the cell on the worker stops
/// the probe whichever of the two the worker runs first.
pub(crate) fn worker_stays_free<K>(start: impl FnOnce(Cell) -> K) -> bool {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .expect("runtime of one worker");
    let cell: Cell = Arc::new(RwLock::new(None));
    let held = cell.write().expect("workspace cell");
    let kept = {
        let _inside = runtime.enter();
        start(cell.clone())
    };
    let (done, finished) = std::sync::mpsc::channel();
    runtime.spawn(async move {
        for _ in 0..PROBE_STEPS {
            tokio::time::sleep(PROBE_STEP).await;
        }
        let _ = done.send(());
    });
    let free = finished.recv_timeout(PROBE_BOUND).is_ok();
    // A task that waits for the cell on the worker goes on once the guard is
    // dropped, so the runtime can stop.
    drop(held);
    drop(kept);
    runtime.shutdown_timeout(MUST_HAPPEN);
    free
}
