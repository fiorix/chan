//! Live-window presence: which window ids currently hold a `/ws`
//! socket against this tenant.
//!
//! Every SPA window opens one event socket and names its window id on
//! it (`/ws?w=<id>` -- the same id that keys the per-window session
//! blob). The refcounted map below turns those sockets into a presence
//! set the window lists read for `connected`: `GET /api/windows` and the
//! library window feed (`GET /api/library/windows`), so a client can tell
//! which saved windows are currently open somewhere and which are
//! reopenable.
//!
//! Refcounted, not boolean: a reload briefly overlaps the old and new
//! socket of the same window, and a plain set would flicker the window
//! "disconnected" when the old socket drops. Connections register via
//! the RAII [`PresenceGuard`] so every pump exit path (clean close,
//! network drop, server shutdown) deregisters without bookkeeping at
//! the call sites.
//!
//! A socket can also say who holds it (`/ws?w=<id>&h=<holder>`), by a tag
//! that is opaque here. Several clients can hold one window id, another
//! desktop or another browser tab, so the count is kept for each holder
//! of a window beside the count of its untagged sockets, and the window
//! lists read the holders for `holders`: a client that decides whether a
//! window is on its own page looks for its own tag.
//!
//! Semantics note for consumers: "connected" means a live socket
//! exists SOMEWHERE -- a hidden (buried) chan-desktop window keeps its
//! webview and therefore its socket, so hidden-vs-visible is not
//! distinguishable here. The honest vocabulary is connected / saved.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::Notify;

/// The live sockets of one window id.
#[derive(Default)]
struct WindowSockets {
    /// Sockets that came with no holder tag.
    untagged: usize,
    /// Holder tag -> live socket count, sorted as a listing gives them.
    tagged: BTreeMap<String, usize>,
}

impl WindowSockets {
    fn is_empty(&self) -> bool {
        self.untagged == 0 && self.tagged.is_empty()
    }
}

#[derive(Default)]
pub struct WindowPresence {
    /// window id -> its live sockets. An id is a key only while it has one.
    inner: Mutex<HashMap<String, WindowSockets>>,
    /// Fired when a window's first socket connects or its last one drops,
    /// and when a holder's first socket for a window connects or its last
    /// one drops, so the library watch feed re-snapshots the window's
    /// `connected` flag and its `holders`. Installed by the host when it
    /// mounts the tenant; absent in unit tests / before install, in which
    /// case presence is silent.
    change_notify: OnceLock<Arc<Notify>>,
}

impl WindowPresence {
    pub fn new() -> Self {
        Self::default()
    }

    /// Install the library's aggregate change signal so presence transitions
    /// wake the watch feed. Idempotent set-once; the host calls this once per
    /// tenant right after the builder constructs the presence.
    pub fn install_change_notify(&self, notify: Arc<Notify>) {
        let _ = self.change_notify.set(notify);
    }

    /// Wake the watch feed if a change signal is installed.
    fn fire_change(&self) {
        if let Some(notify) = self.change_notify.get() {
            notify.notify_waiters();
        }
    }

    /// Register one live socket for `id`, held by `holder` when the socket
    /// named one; presence holds until the returned guard drops. The tag is
    /// taken as given: the caller decides what a well-formed one is.
    pub fn connect(self: &Arc<Self>, id: &str, holder: Option<&str>) -> PresenceGuard {
        let changed = {
            let mut inner = self.lock();
            let newly_connected = !inner.contains_key(id);
            let sockets = inner.entry(id.to_string()).or_default();
            match holder {
                Some(tag) => {
                    let count = sockets.tagged.entry(tag.to_string()).or_insert(0);
                    *count += 1;
                    newly_connected || *count == 1
                }
                None => {
                    sockets.untagged += 1;
                    newly_connected
                }
            }
        };
        if changed {
            self.fire_change();
        }
        PresenceGuard {
            presence: Arc::clone(self),
            id: id.to_string(),
            holder: holder.map(str::to_string),
        }
    }

    /// Window ids with at least one live socket, in arbitrary order.
    pub fn connected_ids(&self) -> Vec<String> {
        self.lock().keys().cloned().collect()
    }

    /// The holders of `id`'s live sockets, each tag once and sorted, or
    /// `None` when no socket is live for `id`. An untagged socket is in no
    /// list, so a window whose sockets all came untagged is `Some` and
    /// empty. One read under one lock, so the answer to "is it connected"
    /// and the list are of the same instant.
    pub(crate) fn holders(&self, id: &str) -> Option<Vec<String>> {
        self.lock()
            .get(id)
            .map(|sockets| sockets.tagged.keys().cloned().collect())
    }

    /// Recover from a poisoned lock: the critical sections are simple
    /// counter ops that can't leave the map inconsistent, and presence
    /// must never panic a ws teardown path.
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, WindowSockets>> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn disconnect(&self, id: &str, holder: Option<&str>) {
        let changed = {
            let mut inner = self.lock();
            match inner.get_mut(id) {
                Some(sockets) => {
                    let holder_left = match holder {
                        Some(tag) => match sockets.tagged.get_mut(tag) {
                            Some(count) => {
                                *count = count.saturating_sub(1);
                                *count == 0
                            }
                            None => false,
                        },
                        None => {
                            sockets.untagged = sockets.untagged.saturating_sub(1);
                            false
                        }
                    };
                    if let (true, Some(tag)) = (holder_left, holder) {
                        sockets.tagged.remove(tag);
                    }
                    let window_left = sockets.is_empty();
                    if window_left {
                        inner.remove(id);
                    }
                    holder_left || window_left
                }
                None => false,
            }
        };
        if changed {
            self.fire_change();
        }
    }
}

/// RAII handle for one window socket; dropping it releases the
/// presence ref. Held by the `/ws` pump for the socket's lifetime.
pub struct PresenceGuard {
    presence: Arc<WindowPresence>,
    id: String,
    holder: Option<String>,
}

impl Drop for PresenceGuard {
    fn drop(&mut self) {
        self.presence.disconnect(&self.id, self.holder.as_deref());
    }
}

#[cfg(test)]
mod tests {
    use std::future::Future;

    use super::*;

    fn connected(presence: &WindowPresence, id: &str) -> bool {
        presence.connected_ids().iter().any(|c| c == id)
    }

    /// Whether `step` fires the change signal `notify`.
    fn fires(notify: &Notify, step: impl FnOnce()) -> bool {
        let changed = std::pin::pin!(notify.notified());
        step();
        let mut context = std::task::Context::from_waker(std::task::Waker::noop());
        changed.poll(&mut context).is_ready()
    }

    #[test]
    fn presence_follows_guard_lifetimes() {
        let presence = Arc::new(WindowPresence::new());
        assert!(!connected(&presence, "w1"));

        let g1 = presence.connect("w1", None);
        assert_eq!(presence.connected_ids(), vec!["w1".to_string()]);

        // Reload overlap: a second socket for the same window keeps the
        // window connected after the FIRST guard drops.
        let g2 = presence.connect("w1", None);
        drop(g1);
        assert!(connected(&presence, "w1"));

        drop(g2);
        assert!(presence.connected_ids().is_empty());
    }

    #[test]
    fn windows_track_independently() {
        let presence = Arc::new(WindowPresence::new());
        let _g1 = presence.connect("w1", None);
        let g2 = presence.connect("w2", Some("desk-a"));
        let mut ids = presence.connected_ids();
        ids.sort();
        assert_eq!(ids, ["w1", "w2"]);
        assert_eq!(presence.holders("w1"), Some(Vec::new()));
        assert_eq!(presence.holders("w2"), Some(vec!["desk-a".to_string()]));
        drop(g2);
        assert!(connected(&presence, "w1"));
        assert!(!connected(&presence, "w2"));
        assert_eq!(presence.holders("w2"), None);
    }

    /// Two clients on one window id are two holders, listed once each and
    /// sorted however many sockets each has; a holder is listed until its
    /// last socket drops, and a window with no socket has no list at all.
    #[test]
    fn a_window_lists_each_holder_of_its_sockets_once_and_sorted() {
        let presence = Arc::new(WindowPresence::new());
        assert_eq!(presence.holders("w1"), None, "no socket, no list");

        let tab = presence.connect("w1", Some("tab-b"));
        let desk = presence.connect("w1", Some("desk-a"));
        let reload = presence.connect("w1", Some("desk-a"));
        let untagged = presence.connect("w1", None);
        let both = Some(vec!["desk-a".to_string(), "tab-b".to_string()]);
        assert_eq!(
            presence.holders("w1"),
            both,
            "the holders of one window are not listed once each and sorted"
        );

        drop(desk);
        assert_eq!(
            presence.holders("w1"),
            both,
            "a holder with a socket left was dropped from the list"
        );
        drop(reload);
        assert_eq!(
            presence.holders("w1"),
            Some(vec!["tab-b".to_string()]),
            "a holder with no socket left is still listed"
        );
        drop(tab);
        assert_eq!(
            presence.holders("w1"),
            Some(Vec::new()),
            "an untagged socket keeps the window connected and lists no holder"
        );
        assert!(connected(&presence, "w1"));
        drop(untagged);
        assert_eq!(presence.holders("w1"), None);
        assert!(presence.connected_ids().is_empty());
    }

    /// The change signal fires when a window's set of holders changes as it
    /// does when the window connects or disconnects, and not for a socket
    /// that changes neither.
    #[test]
    fn a_holder_arriving_or_leaving_signals_a_change() {
        let presence = Arc::new(WindowPresence::new());
        let notify = Arc::new(Notify::new());
        presence.install_change_notify(Arc::clone(&notify));
        let mut guards = Vec::new();
        let mut connect =
            |holder: Option<&str>| fires(&notify, || guards.push(presence.connect("w1", holder)));
        assert!(connect(Some("desk-a")), "the window's first socket");
        assert!(connect(Some("tab-b")), "a second holder's first socket");
        assert!(!connect(Some("desk-a")), "a holder's second socket");
        assert!(!connect(None), "an untagged socket beside others");

        // As they connected: desk-a, tab-b, desk-a, untagged.
        let mut guards = guards.into_iter();
        let mut leave = || fires(&notify, || drop(guards.next()));
        assert!(!leave(), "one of a holder's two sockets");
        assert!(
            leave(),
            "a holder's last socket, the window still connected"
        );
        assert!(leave(), "the other holder's last socket");
        assert!(leave(), "the window's last socket");
        assert_eq!(presence.holders("w1"), None);
    }
}
