//! Live per-window transfer count: how many file uploads / downloads a
//! window currently has in flight.
//!
//! Every SPA window opens one event socket and tags it with its window
//! id (`/ws?w=<id>` -- the same id `window_presence` keys on) and reports
//! its in-flight transfer count over it (`{ "type": "transfers", "active":
//! <n> }`). The refcounted map below SUMS those counts per window id across
//! its sockets, so the desktop's close handler can ask one synchronous
//! question -- [`WindowTransfers::window_has_active_transfer`] -- before it
//! lets a window close mid-transfer, the same hold/cancel guard a window
//! with live terminal shells gets.
//!
//! Per-socket and RAII-cleared via [`TransferGuard`]: a reload drops the
//! socket AND kills its in-flight XHRs, and the guard's Drop subtracts that
//! socket's last-reported count, so a reloaded window reads inactive for
//! free -- no client message needed. Refcounted (a sum, not a boolean) so a
//! reload's brief overlap of the old and new socket of one window doesn't
//! undercount.
//!
//! Simpler than [`window_presence`](crate::window_presence): the close
//! guard is a synchronous query, not a watch, so there is no change-notify
//! here.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct WindowTransfers {
    /// window id -> SUM of active transfers across its live sockets.
    inner: Mutex<HashMap<String, usize>>,
}

impl WindowTransfers {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register one live socket for `window_id`. It contributes 0 active
    /// transfers until [`TransferGuard::set`] is called; the window's
    /// transfer total holds until the returned guard drops.
    pub fn register(self: &Arc<Self>, window_id: &str) -> TransferGuard {
        TransferGuard {
            transfers: Arc::clone(self),
            window_id: window_id.to_string(),
            last: AtomicUsize::new(0),
        }
    }

    /// True when `window_id` has at least one active transfer summed across
    /// its live sockets. The desktop close handler's question.
    pub fn window_has_active_transfer(&self, window_id: &str) -> bool {
        self.lock().get(window_id).copied().unwrap_or(0) > 0
    }

    /// Recover from a poisoned lock: the critical sections are simple
    /// counter ops that can't leave the map inconsistent, and this must
    /// never panic a ws teardown path.
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, usize>> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Apply one socket's `delta` to the window sum. Saturating at 0, and
    /// the entry is removed when it reaches 0 so an idle window leaves no
    /// trace in the map.
    fn adjust(&self, window_id: &str, delta: isize) {
        if delta == 0 {
            return;
        }
        let mut inner = self.lock();
        let entry = inner.entry(window_id.to_string()).or_insert(0);
        let next = (*entry as isize + delta).max(0) as usize;
        if next == 0 {
            inner.remove(window_id);
        } else {
            *entry = next;
        }
    }
}

/// Largest in-flight count one socket may report. Far above any real transfer
/// fan-out, and small enough that `isize` arithmetic on it never overflows.
const MAX_REPORTED_TRANSFERS: usize = 1 << 20;

/// RAII handle for one window socket's transfer contribution. `set` updates
/// this socket's reported in-flight count; Drop subtracts whatever it last
/// reported, so a dropped socket (a reload, a network drop, server shutdown)
/// clears its share without a client message. Held by the `/ws` pump for the
/// socket's lifetime.
pub struct TransferGuard {
    transfers: Arc<WindowTransfers>,
    window_id: String,
    last: AtomicUsize,
}

impl TransferGuard {
    /// Report this socket's current in-flight transfer count, adjusting the
    /// window sum by the delta from its previous report. Called from the
    /// socket's own pump (single-threaded per guard), so the swap-then-adjust
    /// pair needs no extra synchronization beyond the map lock.
    pub fn set(&self, active: usize) {
        // The count comes from the client. Capped, the signed deltas below
        // cannot wrap, and no report can leave the window's sum stuck above
        // zero after the socket reports zero or drops.
        let active = active.min(MAX_REPORTED_TRANSFERS);
        let prev = self.last.swap(active, Ordering::SeqCst);
        if active != prev {
            self.transfers
                .adjust(&self.window_id, active as isize - prev as isize);
        }
    }
}

impl Drop for TransferGuard {
    fn drop(&mut self) {
        let last = self.last.load(Ordering::SeqCst);
        if last > 0 {
            self.transfers.adjust(&self.window_id, -(last as isize));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A report of any size clears when the socket reports zero or drops, and
    // dropping after an enormous report does not overflow.
    #[test]
    fn an_absurd_report_still_clears() {
        let transfers = Arc::new(WindowTransfers::new());
        let guard = transfers.register("w1");
        guard.set(usize::MAX);
        assert!(transfers.window_has_active_transfer("w1"));
        guard.set(0);
        assert!(!transfers.window_has_active_transfer("w1"));

        guard.set(usize::MAX / 2 + 1);
        drop(guard);
        assert!(!transfers.window_has_active_transfer("w1"));
    }

    #[test]
    fn set_then_clear_follows_the_count() {
        let transfers = Arc::new(WindowTransfers::new());
        let guard = transfers.register("w1");
        // A fresh guard contributes nothing until it reports.
        assert!(!transfers.window_has_active_transfer("w1"));

        guard.set(2);
        assert!(transfers.window_has_active_transfer("w1"));

        // Reporting zero again clears the window (and the map entry).
        guard.set(0);
        assert!(!transfers.window_has_active_transfer("w1"));
    }

    #[test]
    fn drop_clears_the_remaining_count() {
        let transfers = Arc::new(WindowTransfers::new());
        let guard = transfers.register("w1");
        guard.set(3);
        assert!(transfers.window_has_active_transfer("w1"));
        // A socket that drops mid-transfer (reload / network drop) clears
        // its outstanding contribution via Drop.
        drop(guard);
        assert!(!transfers.window_has_active_transfer("w1"));
    }

    #[test]
    fn windows_track_independently() {
        let transfers = Arc::new(WindowTransfers::new());
        let g1 = transfers.register("w1");
        let g2 = transfers.register("w2");
        g1.set(1);
        g2.set(5);
        assert!(transfers.window_has_active_transfer("w1"));
        assert!(transfers.window_has_active_transfer("w2"));
        drop(g2);
        assert!(transfers.window_has_active_transfer("w1"));
        assert!(!transfers.window_has_active_transfer("w2"));
    }

    #[test]
    fn reload_overlap_sum_follows_the_dropped_socket() {
        // Two sockets of one window (the reload overlap): the sum holds the
        // window active, and dropping the first follows down to the second's
        // contribution rather than flickering to zero.
        let transfers = Arc::new(WindowTransfers::new());
        let g1 = transfers.register("w1");
        let g2 = transfers.register("w1");
        g1.set(1);
        g2.set(2);
        assert!(transfers.window_has_active_transfer("w1")); // sum 3

        drop(g1); // -1 -> sum 2
        assert!(transfers.window_has_active_transfer("w1"));

        drop(g2); // -2 -> sum 0
        assert!(!transfers.window_has_active_transfer("w1"));
    }
}
