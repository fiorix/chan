//! Where a watcher-opened chan window goes: the OS window manager, or a frame
//! inside the Hybrid host window.
//!
//! The window watcher already funnels every window it opens through
//! [`crate::serve::build_workspace_window`], which is also where the final
//! navigate URL is assembled (`?w=`, `?kind=`, `?lib=`, `?pane=`, and the
//! restored `#fragment`). Routing there rather than behind a second
//! [`NativeSurface`](crate::window_watcher::NativeSurface) is what keeps the
//! Hybrid path from re-deriving that URL, and it covers local and devserver
//! windows with one decision: by the time the remote path reaches the build,
//! its asynchronous gateway mint has already settled.
//!
//! Three things the watcher does still have to agree with the shell about, and
//! they are the whole of this module's contract:
//!
//!   - which labels are open, so a reconcile does not open a window twice;
//!   - where a given window already lives, so closing it reaches the right
//!     surface and so flipping the switch never migrates a window that is
//!     already on screen;
//!   - which frame is focused, so the New Window chord can answer for a window
//!     the OS cannot see.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

/// The event names the host webview listens on. The shell is the only
/// subscriber; the payloads are [`HybridOpen`] and the label alone.
pub(crate) const EVENT_OPEN: &str = "hybrid://open";
pub(crate) const EVENT_CLOSE: &str = "hybrid://close";
pub(crate) const EVENT_RETITLE: &str = "hybrid://retitle";
pub(crate) const EVENT_FOCUS: &str = "hybrid://focus";

/// Where the next window opens. Persisted with the rest of the desktop config
/// so the choice survives a restart.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Destination {
    /// The OS window manager: one webview window per chan window, which is
    /// what chan-desktop has always done. The default, so an install that
    /// never opens the Hybrid host behaves exactly as before.
    #[default]
    Os,
    /// A frame inside the Hybrid host window.
    Hybrid,
}

impl Destination {
    pub(crate) fn from_wire(value: &str) -> Option<Self> {
        match value {
            "os" => Some(Destination::Os),
            "hybrid" => Some(Destination::Hybrid),
            _ => None,
        }
    }

    /// The value the shell's switch reads and writes. The host is the authority
    /// on this: the shell keeps its own copy for the surface where there is no
    /// host, and a copy that disagreed would show a switch that does not
    /// describe where windows actually go.
    pub(crate) fn to_wire(self) -> &'static str {
        match self {
            Destination::Os => "os",
            Destination::Hybrid => "hybrid",
        }
    }
}

/// What the shell needs to build a frame. The URL is the one a native window
/// would have loaded, so the frame and the window are the same page.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct HybridOpen {
    /// The native label, `{library_id}::{window_id}`: the shell's frame key and
    /// the reconcile's identity for the window.
    pub label: String,
    pub url: String,
    pub title: String,
    /// `workspace`, `terminal` or `control`, for the frame's chrome.
    pub kind: String,
}

/// The desktop's half of the Hybrid contract. One instance in [`AppState`],
/// read by the watcher and written by the host window's commands.
#[derive(Debug, Default)]
pub struct HybridState {
    /// Native labels the shell currently holds a frame for, mirrored up on
    /// every change. This IS `open_labels` for the Hybrid surface: the shell
    /// owns those windows, and the watcher must see them as open or it would
    /// reopen them on the next reconcile.
    frames: Mutex<HashSet<String>>,
    /// The shell's focused frame, or `None` when it has none. Only meaningful
    /// while the host window is the OS-focused one; the resolver checks that.
    focused: Mutex<Option<String>>,
    /// Where the NEXT window opens.
    destination: Mutex<Destination>,
    /// Where each window already lives. A window is placed once, at its first
    /// open, and stays there: flipping the switch must not drag a window that
    /// is already on screen across to the other surface.
    placement: Mutex<HashMap<String, Destination>>,
}

impl HybridState {
    pub fn destination(&self) -> Destination {
        *self.destination.lock().unwrap()
    }

    pub fn set_destination(&self, destination: Destination) {
        *self.destination.lock().unwrap() = destination;
    }

    /// Replace the mirrored frame set, and forget the placement of every window
    /// the shell no longer holds. Dropping those entries is what lets a window
    /// closed inside Hybrid be reopened on whichever surface the switch names
    /// at the time.
    pub fn set_frames(&self, labels: HashSet<String>) {
        let mut placement = self.placement.lock().unwrap();
        placement.retain(|label, where_| *where_ != Destination::Hybrid || labels.contains(label));
        *self.frames.lock().unwrap() = labels;
    }

    pub fn frames(&self) -> HashSet<String> {
        self.frames.lock().unwrap().clone()
    }

    pub fn holds(&self, label: &str) -> bool {
        self.frames.lock().unwrap().contains(label)
    }

    pub fn set_focused(&self, label: Option<String>) {
        *self.focused.lock().unwrap() = label;
    }

    pub fn focused(&self) -> Option<String> {
        self.focused.lock().unwrap().clone()
    }

    /// Where `label` lives, deciding (and remembering) it on first sight.
    ///
    /// `hybrid_available` is the caller's answer to "is the host window there
    /// to receive a frame". A Hybrid destination with no host window falls back
    /// to the OS rather than dropping the window on the floor.
    pub fn place(&self, label: &str, hybrid_available: bool) -> Destination {
        let mut placement = self.placement.lock().unwrap();
        if let Some(existing) = placement.get(label) {
            return *existing;
        }
        let chosen = match *self.destination.lock().unwrap() {
            Destination::Hybrid if hybrid_available => Destination::Hybrid,
            _ => Destination::Os,
        };
        placement.insert(label.to_string(), chosen);
        chosen
    }

    /// Where `label` lives, without placing it. Answers `None` for a window
    /// this process has not opened, which is what a close of an already-gone
    /// window looks like.
    pub fn placed(&self, label: &str) -> Option<Destination> {
        self.placement.lock().unwrap().get(label).copied()
    }

    pub fn forget(&self, label: &str) {
        self.placement.lock().unwrap().remove(label);
        self.frames.lock().unwrap().remove(label);
    }
}

/// Whether the Hybrid host window exists and can be handed a frame.
pub(crate) fn host_available(app: &AppHandle) -> bool {
    app.get_webview_window(crate::HYBRID_WINDOW_LABEL).is_some()
}

/// Ask the shell to open a frame. Best effort, like every other window build:
/// a failure is logged and the next reconcile tries again.
pub(crate) fn open_frame(app: &AppHandle, payload: HybridOpen) {
    if let Err(error) = app.emit_to(crate::HYBRID_WINDOW_LABEL, EVENT_OPEN, &payload) {
        tracing::warn!(label = %payload.label, %error, "hybrid: opening a frame failed");
    }
}

/// Ask the shell to drop a frame. The shell answers with a `hybrid_frames`
/// push, which is what actually clears the label from [`HybridState`].
pub(crate) fn close_frame(app: &AppHandle, label: &str) {
    if let Err(error) = app.emit_to(crate::HYBRID_WINDOW_LABEL, EVENT_CLOSE, label) {
        tracing::warn!(%label, %error, "hybrid: closing a frame failed");
    }
}

/// Raise a window that lives inside the host: show and focus the host itself,
/// then ask the shell to bring that frame forward. Answers whether the window
/// was one of the host's, so the caller can fall through to its OS-window path.
pub(crate) fn focus_frame(app: &AppHandle, label: &str) -> bool {
    let state = app.state::<std::sync::Arc<crate::AppState>>();
    if !state.hybrid.holds(label) {
        return false;
    }
    if let Some(window) = app.get_webview_window(crate::HYBRID_WINDOW_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    if let Err(error) = app.emit_to(crate::HYBRID_WINDOW_LABEL, EVENT_FOCUS, label) {
        tracing::warn!(%label, %error, "hybrid: focusing a frame failed");
    }
    true
}

/// Push a window's current title to its frame. The watcher calls this for every
/// shown window on every feed change, so it stays cheap: the shell compares
/// against the title it already has.
pub(crate) fn retitle_frame(app: &AppHandle, label: &str, title: &str) {
    let payload = serde_json::json!({ "label": label, "title": title });
    if let Err(error) = app.emit_to(crate::HYBRID_WINDOW_LABEL, EVENT_RETITLE, payload) {
        tracing::debug!(%label, %error, "hybrid: retitling a frame failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> HybridState {
        HybridState::default()
    }

    #[test]
    fn the_default_destination_is_the_os_window_manager() {
        // An install that never opens the Hybrid host must behave exactly as
        // chan-desktop always has.
        let s = state();
        assert_eq!(s.destination(), Destination::Os);
        assert_eq!(s.place("local::w-1", true), Destination::Os);
    }

    #[test]
    fn a_hybrid_destination_places_into_hybrid_when_the_host_is_there() {
        let s = state();
        s.set_destination(Destination::Hybrid);
        assert_eq!(s.place("local::w-1", true), Destination::Hybrid);
    }

    #[test]
    fn a_hybrid_destination_falls_back_to_the_os_with_no_host_window() {
        // Dropping the window on the floor would lose a session; the OS window
        // manager is always able to show it.
        let s = state();
        s.set_destination(Destination::Hybrid);
        assert_eq!(s.place("local::w-1", false), Destination::Os);
    }

    #[test]
    fn flipping_the_switch_never_migrates_a_placed_window() {
        let s = state();
        s.set_destination(Destination::Hybrid);
        assert_eq!(s.place("local::w-1", true), Destination::Hybrid);
        s.set_destination(Destination::Os);
        // Already on screen inside Hybrid: it stays there.
        assert_eq!(s.place("local::w-1", true), Destination::Hybrid);
        // The switch governs the NEXT window.
        assert_eq!(s.place("local::w-2", true), Destination::Os);
    }

    #[test]
    fn placement_is_forgotten_when_the_shell_drops_the_frame() {
        // Otherwise a window closed inside Hybrid could never be reopened on
        // the OS window manager.
        let s = state();
        s.set_destination(Destination::Hybrid);
        assert_eq!(s.place("local::w-1", true), Destination::Hybrid);
        s.set_frames(HashSet::from(["local::w-1".to_string()]));
        assert!(s.holds("local::w-1"));

        s.set_frames(HashSet::new());
        assert!(!s.holds("local::w-1"));
        assert_eq!(s.placed("local::w-1"), None);
        s.set_destination(Destination::Os);
        assert_eq!(s.place("local::w-1", true), Destination::Os);
    }

    #[test]
    fn an_os_placement_survives_a_frame_push_that_does_not_mention_it() {
        // The shell only ever reports its OWN frames, so its pushes must not
        // be read as "every other window is gone".
        let s = state();
        assert_eq!(s.place("local::w-os", true), Destination::Os);
        s.set_frames(HashSet::from(["local::w-hy".to_string()]));
        assert_eq!(s.placed("local::w-os"), Some(Destination::Os));
    }

    #[test]
    fn focus_round_trips_and_clears() {
        let s = state();
        assert_eq!(s.focused(), None);
        s.set_focused(Some("local::w-1".to_string()));
        assert_eq!(s.focused().as_deref(), Some("local::w-1"));
        s.set_focused(None);
        assert_eq!(s.focused(), None);
    }

    #[test]
    fn destination_parses_only_the_two_wire_values() {
        assert_eq!(Destination::from_wire("os"), Some(Destination::Os));
        assert_eq!(Destination::from_wire("hybrid"), Some(Destination::Hybrid));
        assert_eq!(Destination::from_wire("OS"), None);
        assert_eq!(Destination::from_wire(""), None);
    }
}
