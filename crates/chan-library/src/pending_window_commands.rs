//! Window commands parked for a window that does not exist yet.
//!
//! Every other window command is delivered to a LIVE socket and refused when
//! there is none: the caller named a window, so a disconnected one is the
//! caller's mistake. Routing is the exception. When `cs open` names a path
//! outside its workspace, the server picks the window that should hold it, and
//! that window may have been minted microseconds ago -- its registry row
//! exists, its webview has not connected, and there is nothing to dispatch to
//! for the second or two the surface takes to open it. Refusing there would
//! make the routed open a coin flip on window startup.
//!
//! So a frame with nowhere to go yet is parked under its window id and drained
//! by that window's first `/ws` attach. The park is deliberately small and
//! forgetful:
//!
//! - **Bounded per window.** A runaway loop parks at most [`MAX_PER_WINDOW`]
//!   frames and is then refused, so the caller hears about it rather than
//!   growing the map. This is the only place the queue answers back.
//! - **Expiring.** A window that never opens leaves its frames behind; they
//!   age out after [`TTL`], and every park sweeps expired entries first, so an
//!   abandoned mint cannot pin memory or land an ancient open on a window id
//!   the library later reuses.
//! - **Take-once.** A drain removes what it returns. A reload re-attaches to
//!   the same window id and must not replay an open the user already saw.
//!
//! The frames are pre-serialized `/ws` payloads: this crate never names
//! `WindowCommand` (it lives in chan-server) and the pump reads its target off
//! the leading `window_id` field, so a parked frame is just the string that
//! would have been broadcast.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Frames one window may hold. A routed open is a user gesture; a dozen queued
/// for a window that has not opened yet is a script that has lost the plot.
pub const MAX_PER_WINDOW: usize = 16;

/// How long a parked frame waits for its window. Long enough for a cold
/// desktop window or a user who opens the row from the launcher a minute
/// later; short enough that nothing lingers for a session.
pub const TTL: Duration = Duration::from_secs(600);

struct Parked {
    frame: String,
    at: Instant,
}

/// Per-window parking for `/ws` frames whose target has not connected yet.
#[derive(Default)]
pub struct PendingWindowCommands {
    by_window: Mutex<HashMap<String, Vec<Parked>>>,
}

impl PendingWindowCommands {
    pub fn new() -> Self {
        Self::default()
    }

    /// Park `frame` for `window_id`. `Err` when this window already holds
    /// [`MAX_PER_WINDOW`] unexpired frames -- the caller surfaces that rather
    /// than reporting a queued open that will never arrive.
    pub fn park(&self, window_id: &str, frame: String) -> Result<(), String> {
        let mut map = self.lock();
        let now = Instant::now();
        map.retain(|_, frames| {
            frames.retain(|parked| now.duration_since(parked.at) < TTL);
            !frames.is_empty()
        });
        let frames = map.entry(window_id.to_string()).or_default();
        if frames.len() >= MAX_PER_WINDOW {
            return Err(format!(
                "too many pending opens for window {window_id:?}; open that window to clear them"
            ));
        }
        frames.push(Parked { frame, at: now });
        Ok(())
    }

    /// Take everything parked for `window_id`, oldest first. Removes what it
    /// returns, so a later reload of the same window replays nothing.
    pub fn take(&self, window_id: &str) -> Vec<String> {
        let mut map = self.lock();
        let now = Instant::now();
        let Some(frames) = map.remove(window_id) else {
            return Vec::new();
        };
        frames
            .into_iter()
            .filter(|parked| now.duration_since(parked.at) < TTL)
            .map(|parked| parked.frame)
            .collect()
    }

    /// Whether anything is parked for `window_id` (expired frames included).
    /// Test seam; the drain is the only production reader.
    pub fn is_empty(&self) -> bool {
        self.lock().is_empty()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Vec<Parked>>> {
        self.by_window
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_parked_frame_is_taken_once_and_only_by_its_window() {
        let pending = PendingWindowCommands::new();
        pending.park("w-1", "frame-a".into()).expect("park");
        pending.park("w-1", "frame-b".into()).expect("park");
        pending.park("w-2", "other".into()).expect("park");

        // Another window's attach drains nothing of ours.
        assert_eq!(pending.take("w-3"), Vec::<String>::new());
        // Oldest first, so two routed opens land in the order they were sent.
        assert_eq!(pending.take("w-1"), vec!["frame-a", "frame-b"]);
        // Take-once: a reload of the same window replays nothing.
        assert_eq!(pending.take("w-1"), Vec::<String>::new());
        assert_eq!(pending.take("w-2"), vec!["other"]);
        assert!(pending.is_empty());
    }

    #[test]
    fn a_window_that_never_opens_is_bounded_and_says_so() {
        let pending = PendingWindowCommands::new();
        for i in 0..MAX_PER_WINDOW {
            pending.park("w-1", format!("frame-{i}")).expect("park");
        }
        let err = pending
            .park("w-1", "one too many".into())
            .expect_err("bounded");
        assert!(err.contains("too many pending opens"), "{err}");
        // The refusal names the window so the user knows which one to open.
        assert!(err.contains("w-1"), "{err}");
        // A different window is unaffected by its neighbour's backlog.
        pending.park("w-2", "fine".into()).expect("park");
    }
}
