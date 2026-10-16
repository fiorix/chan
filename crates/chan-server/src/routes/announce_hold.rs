//! Test seam for the mutating routes: hold a worker after its store succeeds
//! and before it announces, keyed by the request's window id, so a test can
//! drop the request in between. Each test picks its own window id, so tests
//! running in parallel do not meet.

use std::collections::HashMap;
use std::sync::{mpsc, LazyLock, Mutex, PoisonError};

struct Gate {
    entered: tokio::sync::oneshot::Sender<()>,
    release: mpsc::Receiver<()>,
}

static GATES: LazyLock<Mutex<HashMap<String, Gate>>> = LazyLock::new(Default::default);

/// Called by a route's worker once its store has succeeded and before it
/// announces. Holds the worker while a test holds the window `w`.
pub(crate) fn after_store(w: Option<&str>) {
    let Some(w) = w else {
        return;
    };
    let gate = GATES
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .remove(w);
    if let Some(gate) = gate {
        let _ = gate.entered.send(());
        // A dropped release, as a failed assertion leaves, ends the wait.
        let _ = gate.release.recv();
    }
}

/// A worker held for one window. Dropping it lets the worker go on.
pub(crate) struct Release {
    w: String,
    release: mpsc::Sender<()>,
}

impl Drop for Release {
    fn drop(&mut self) {
        GATES
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&self.w);
        let _ = self.release.send(());
    }
}

/// Hold the next worker of the window `w` after its store. The receiver
/// completes once the worker is held.
pub(crate) fn hold(w: &str) -> (tokio::sync::oneshot::Receiver<()>, Release) {
    let (entered_tx, entered) = tokio::sync::oneshot::channel();
    let (release, release_rx) = mpsc::channel();
    let previous = GATES.lock().unwrap_or_else(PoisonError::into_inner).insert(
        w.to_string(),
        Gate {
            entered: entered_tx,
            release: release_rx,
        },
    );
    assert!(previous.is_none(), "the window {w} is already held");
    (
        entered,
        Release {
            w: w.to_string(),
            release,
        },
    )
}
