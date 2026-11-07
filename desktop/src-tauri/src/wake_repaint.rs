//! The repaint a chan window gets on macOS when it comes back into view.
//!
//! Every window is built transparent (`serve.rs`, `mark_transparent_window`),
//! so a webview that presents no frame shows the desktop below the title bar.
//! WebKit hides a webview's content until its web process commits a frame:
//! the drawing area proxy's `hideContentUntilPendingUpdate` detaches the root
//! layer and asks the web process for a drawing, and the root layer comes back
//! with the first main-frame layer tree commit that carries the answer
//! (`RemoteLayerTreeDrawingAreaProxy::commitLayerTree` in WebKit's
//! `Source/WebKit/UIProcess/RemoteLayerTree/RemoteLayerTreeDrawingAreaProxy.mm`).
//! The web process sends that answer with the commit of its next rendering
//! update, and a window whose web process renders nothing stays blank.
//!
//! A web process WebKit suspended resumes when its window comes back into
//! view: after a display wake, and when an occluded window turns visible (a
//! display sleep, a tiling window manager's workspace switch). The desktop
//! observes both, and one second after the latest, once the web processes
//! have resumed, it evaluates `wake_repaint.js` in every webview of every
//! shown window, the launcher panel included: an invisible one-pixel fixed
//! element that schedules a rendering update, so the web process commits a
//! frame. Nothing changes size, neither a frame nor a page box, so no terminal
//! grid moves and no PTY is resized.
//!
//! [`WakeRepaint`] and [`repaint_targets`] are the schedule, free of AppKit so
//! the tests run them on every platform; the macOS observer below drives them.

use std::time::{Duration, Instant};

/// How long after the latest trigger the repaint waits, so the web processes
/// WebKit suspended have resumed before they are asked to render.
pub(crate) const REPAINT_DELAY: Duration = Duration::from_secs(1);

/// The script every webview runs for the repaint.
#[cfg(target_os = "macos")]
const REPAINT_SCRIPT: &str = include_str!("wake_repaint.js");

/// What can bring a window back into view.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Trigger {
    /// The displays or the system woke.
    Wake,
    /// A chan window's occlusion state changed; `visible` is its state now.
    Occlusion { visible: bool },
}

/// One window as the repaint reads it: whether it is shown, and its webviews.
/// A workspace window with its launcher panel built holds two.
pub(crate) struct WindowViews<V> {
    pub(crate) shown: bool,
    pub(crate) webviews: Vec<V>,
}

/// When the repaint is due.
#[derive(Default)]
pub(crate) struct WakeRepaint {
    due: Option<Instant>,
}

impl WakeRepaint {
    /// Record a trigger seen at `now` and return when the repaint is due, or
    /// `None` for a window turning occluded, which asks for none and leaves
    /// a repaint already due as it is. Every other trigger moves the repaint
    /// to a delay after it, so a burst (the screens' and the system's wakes,
    /// each window turning visible) gets one repaint after the latest.
    pub(crate) fn trigger(&mut self, trigger: Trigger, now: Instant) -> Option<Instant> {
        match trigger {
            Trigger::Occlusion { visible: false } => None,
            Trigger::Wake | Trigger::Occlusion { visible: true } => {
                let due = now + REPAINT_DELAY;
                self.due = Some(due);
                Some(due)
            }
        }
    }

    /// Whether the repaint runs at `now`: true once when it is due, false
    /// before it is due and after it has run.
    pub(crate) fn take_due(&mut self, now: Instant) -> bool {
        if self.due.is_none_or(|due| now < due) {
            return false;
        }
        self.due = None;
        true
    }
}

/// The webviews a repaint runs in: every webview of every shown window, each
/// once. The repaint names a webview and nothing else, so it carries no frame
/// to change.
pub(crate) fn repaint_targets<V>(windows: impl IntoIterator<Item = WindowViews<V>>) -> Vec<V> {
    windows
        .into_iter()
        .filter(|window| window.shown)
        .flat_map(|window| window.webviews)
        .collect()
}

#[cfg(target_os = "macos")]
pub(crate) use macos::install;

/// The observers and the repaint. The schedule lives on the main thread, and
/// every step that reads it or a window runs there, on a turn of its own.
#[cfg(target_os = "macos")]
mod macos {
    use std::cell::RefCell;
    use std::time::Instant;

    use objc2::rc::Retained;
    use objc2::runtime::{NSObject, NSObjectProtocol};
    use objc2::{define_class, msg_send, sel, AnyThread, DefinedClass, MainThreadMarker};
    use objc2_app_kit::{
        NSWindow, NSWindowDidChangeOcclusionStateNotification, NSWindowOcclusionState, NSWorkspace,
        NSWorkspaceDidWakeNotification, NSWorkspaceScreensDidWakeNotification,
    };
    use objc2_foundation::{NSNotification, NSNotificationCenter};
    use tauri::{AppHandle, Manager};

    use super::{repaint_targets, Trigger, WakeRepaint, WindowViews, REPAINT_SCRIPT};
    use crate::launcher_panel;

    thread_local! {
        /// The schedule and the observer that feeds it. Main thread only.
        static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
    }

    struct State {
        schedule: WakeRepaint,
        /// Held for the app's life: a notification center does not retain its
        /// observers.
        _observer: Retained<RepaintObserver>,
    }

    /// A webview of a chan window: the window's own, by window label, or the
    /// launcher panel over it, by host label.
    enum Webview {
        Window(String),
        Launcher(String),
    }

    define_class!(
        // SAFETY: NSObject has no subclassing requirements, and
        // RepaintObserver does not implement Drop.
        #[unsafe(super(NSObject))]
        #[ivars = AppHandle]
        struct RepaintObserver;

        unsafe impl NSObjectProtocol for RepaintObserver {}

        impl RepaintObserver {
            /// Both wake notifications land here, on the thread that posted
            /// them.
            #[unsafe(method(displayDidWake:))]
            fn display_did_wake(&self, _notification: &NSNotification) {
                later(self.ivars(), Instant::now(), |app| {
                    triggered(app, Trigger::Wake)
                });
            }

            /// Every window's occlusion change lands here. AppKit posts a
            /// window's notifications on the main thread, where its state is
            /// read; whether it is a chan window is read on a later turn, away
            /// from AppKit's call.
            #[unsafe(method(windowDidChangeOcclusionState:))]
            fn window_did_change_occlusion_state(&self, notification: &NSNotification) {
                if MainThreadMarker::new().is_none() {
                    return;
                }
                let Some(window) = notification
                    .object()
                    .and_then(|object| object.downcast::<NSWindow>().ok())
                else {
                    return;
                };
                let visible = window
                    .occlusionState()
                    .contains(NSWindowOcclusionState::Visible);
                let window = Retained::as_ptr(&window) as usize;
                later(self.ivars(), Instant::now(), move |app| {
                    if is_chan_window(app, window) {
                        triggered(app, Trigger::Occlusion { visible });
                    }
                });
            }
        }
    );

    impl RepaintObserver {
        fn new(app: AppHandle) -> Retained<Self> {
            let this = Self::alloc().set_ivars(app);
            // SAFETY: NSObject's designated initializer, sent once to a freshly
            // allocated object whose ivars are set.
            unsafe { msg_send![super(this), init] }
        }
    }

    /// Observe the display and the system wakes on the workspace notification
    /// center, and every window's occlusion changes on the default one. Called
    /// once from the app setup, on the main thread; elsewhere it observes
    /// nothing.
    pub(crate) fn install(app: &AppHandle) {
        if MainThreadMarker::new().is_none() {
            tracing::warn!("the wake repaint is installed only on the main thread");
            return;
        }
        let observer = RepaintObserver::new(app.clone());
        let workspace = NSWorkspace::sharedWorkspace().notificationCenter();
        let windows = NSNotificationCenter::defaultCenter();
        // SAFETY: the observer answers both selectors, each taking the one
        // NSNotification the center passes, and STATE holds it for the app's
        // life, so no center messages a freed object. The names are AppKit's
        // constant strings; no object filters the occlusion notification, so
        // it comes for every window.
        unsafe {
            for name in [
                NSWorkspaceScreensDidWakeNotification,
                NSWorkspaceDidWakeNotification,
            ] {
                workspace.addObserver_selector_name_object(
                    &observer,
                    sel!(displayDidWake:),
                    Some(name),
                    None,
                );
            }
            windows.addObserver_selector_name_object(
                &observer,
                sel!(windowDidChangeOcclusionState:),
                Some(NSWindowDidChangeOcclusionStateNotification),
                None,
            );
        }
        STATE.with(|state| {
            *state.borrow_mut() = Some(State {
                schedule: WakeRepaint::default(),
                _observer: observer,
            });
        });
    }

    /// Run `step` on the main thread no earlier than `at`, and always on a
    /// later main-loop turn: Tauri runs a `run_on_main_thread` closure at once
    /// when the caller is already on the main thread, so the call is made from
    /// the async runtime instead.
    fn later(app: &AppHandle, at: Instant, step: impl FnOnce(&AppHandle) + Send + 'static) {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep_until(at.into()).await;
            let handle = app.clone();
            if let Err(e) = app.run_on_main_thread(move || step(&handle)) {
                tracing::warn!(error = %e, "scheduling a wake repaint step failed");
            }
        });
    }

    /// Whether the window at `address` is one of chan's.
    fn is_chan_window(app: &AppHandle, address: usize) -> bool {
        app.webview_windows()
            .values()
            .any(|window| window.ns_window().is_ok_and(|ns| ns as usize == address))
    }

    /// A trigger, on the main thread: arm the repaint when it asks for one.
    fn triggered(app: &AppHandle, trigger: Trigger) {
        let due = STATE.with(|state| {
            state
                .borrow_mut()
                .as_mut()
                .and_then(|state| state.schedule.trigger(trigger, Instant::now()))
        });
        if let Some(due) = due {
            tracing::debug!(?trigger, "wake repaint due");
            later(app, due, repaint);
        }
    }

    /// The repaint, when due: the script in every webview of every shown
    /// window.
    fn repaint(app: &AppHandle) {
        let due = STATE.with(|state| {
            state
                .borrow_mut()
                .as_mut()
                .is_some_and(|state| state.schedule.take_due(Instant::now()))
        });
        if !due {
            return;
        }
        let windows = app.webview_windows().into_iter().map(|(label, window)| {
            let mut webviews = vec![Webview::Window(label.clone())];
            if launcher_panel::has_launcher(&label) {
                webviews.push(Webview::Launcher(label));
            }
            WindowViews {
                shown: window.is_visible().unwrap_or(false),
                webviews,
            }
        });
        let targets = repaint_targets(windows);
        tracing::info!(
            webviews = targets.len(),
            "repainting every shown window back in view"
        );
        for target in targets {
            match target {
                Webview::Window(label) => {
                    if let Some(window) = app.get_webview_window(&label) {
                        if let Err(e) = window.eval(REPAINT_SCRIPT) {
                            tracing::warn!(window = %label, error = %e, "wake repaint failed");
                        }
                    }
                }
                Webview::Launcher(host) => {
                    launcher_panel::evaluate_in_launcher(&host, REPAINT_SCRIPT)
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(shown: bool, webviews: &[&'static str]) -> WindowViews<&'static str> {
        WindowViews {
            shown,
            webviews: webviews.to_vec(),
        }
    }

    /// A local workspace window, a devserver window with its launcher panel
    /// built over its page, and a hidden window.
    fn windows() -> Vec<WindowViews<&'static str>> {
        vec![
            window(true, &["local page"]),
            window(true, &["devserver page", "devserver launcher"]),
            window(false, &["hidden page"]),
        ]
    }

    /// The webviews a due repaint reaches, or none when it is not due.
    fn repaint_at(repaint: &mut WakeRepaint, now: Instant) -> Vec<&'static str> {
        if repaint.take_due(now) {
            repaint_targets(windows())
        } else {
            Vec::new()
        }
    }

    const SHOWN: [&str; 3] = ["local page", "devserver page", "devserver launcher"];

    #[test]
    fn a_window_turning_visible_repaints_every_shown_webview_once() {
        let shown = Instant::now();
        let mut repaint = WakeRepaint::default();
        assert_eq!(
            repaint.trigger(Trigger::Occlusion { visible: true }, shown),
            Some(shown + REPAINT_DELAY)
        );
        assert!(
            repaint_at(
                &mut repaint,
                shown + REPAINT_DELAY - Duration::from_millis(1)
            )
            .is_empty(),
            "the repaint waits for the web processes to resume"
        );
        assert_eq!(
            repaint_at(&mut repaint, shown + REPAINT_DELAY),
            SHOWN,
            "one repaint per webview of every shown window, none for a hidden one"
        );
        assert!(
            repaint_at(&mut repaint, shown + REPAINT_DELAY * 5).is_empty(),
            "one trigger, one repaint"
        );
    }

    #[test]
    fn a_wake_repaints_every_shown_webview_once() {
        let woke = Instant::now();
        let mut repaint = WakeRepaint::default();
        assert_eq!(
            repaint.trigger(Trigger::Wake, woke),
            Some(woke + REPAINT_DELAY)
        );
        assert_eq!(repaint_at(&mut repaint, woke + REPAINT_DELAY), SHOWN);
        assert!(repaint_at(&mut repaint, woke + REPAINT_DELAY * 5).is_empty());
    }

    #[test]
    fn a_window_turning_occluded_schedules_no_repaint() {
        let now = Instant::now();
        let mut repaint = WakeRepaint::default();
        assert_eq!(
            repaint.trigger(Trigger::Occlusion { visible: false }, now),
            None
        );
        assert!(repaint_at(&mut repaint, now + REPAINT_DELAY * 5).is_empty());

        // Nor does it move a repaint already due.
        repaint.trigger(Trigger::Wake, now);
        assert_eq!(
            repaint.trigger(
                Trigger::Occlusion { visible: false },
                now + Duration::from_millis(500)
            ),
            None
        );
        assert_eq!(repaint_at(&mut repaint, now + REPAINT_DELAY), SHOWN);
    }

    #[test]
    fn a_wake_and_a_window_turning_visible_within_the_delay_get_one_repaint_after_the_later() {
        let woke = Instant::now();
        let mut repaint = WakeRepaint::default();
        repaint.trigger(Trigger::Wake, woke);
        let shown = woke + Duration::from_millis(600);
        assert_eq!(
            repaint.trigger(Trigger::Occlusion { visible: true }, shown),
            Some(shown + REPAINT_DELAY)
        );
        assert!(repaint_at(&mut repaint, woke + REPAINT_DELAY).is_empty());
        assert_eq!(repaint_at(&mut repaint, shown + REPAINT_DELAY), SHOWN);
        assert!(repaint_at(&mut repaint, shown + REPAINT_DELAY * 5).is_empty());
    }

    #[test]
    fn no_trigger_no_repaint() {
        let mut repaint = WakeRepaint::default();
        assert!(repaint_at(&mut repaint, Instant::now() + REPAINT_DELAY * 5).is_empty());
    }

    /// The setup installs the observers on macOS, the glue observes both wakes
    /// and every window's occlusion and drives the schedule, and the repaint
    /// is the script: nothing in the module sets a frame or a size.
    #[test]
    fn the_macos_glue_observes_both_triggers_and_repaints_with_the_script_alone() {
        const MAIN_RS: &str = include_str!("main.rs");
        const MODULE: &str = include_str!("wake_repaint.rs");
        let setup_start = MAIN_RS
            .find(concat!(".setup(move |app|", " {"))
            .expect("main.rs has the app setup");
        let setup = &MAIN_RS[setup_start..];
        let install = setup
            .find(concat!("wake_repaint::install", "(app.handle())"))
            .expect("the setup installs the wake repaint");
        assert!(
            setup[..install].ends_with(concat!("#[cfg(target_os = \"macos\")]\n", "            ")),
            "the install is macOS only"
        );
        let production_end = MODULE
            .find(concat!("\n#[cfg(test)]\n", "mod tests {"))
            .expect("the module has its tests");
        let production = &MODULE[..production_end];
        let glue_start = production
            .find(concat!("\nmod ", "macos {"))
            .expect("the module has its macOS glue");
        let glue = &production[glue_start..];
        for needle in [
            // The registrations themselves: the names also sit in the imports.
            concat!(
                "for name in [\n",
                "                NSWorkspaceScreensDidWakeNotification,\n",
                "                NSWorkspaceDidWakeNotification,\n",
                "            ] {",
            ),
            concat!("sel!(", "displayDidWake:)"),
            concat!(
                "sel!(windowDidChangeOcclusionState:),\n",
                "                Some(NSWindowDidChangeOcclusionStateNotification),",
            ),
            concat!(".contains(NSWindowOcclusionState::", "Visible)"),
            concat!("if is_chan_window(app, ", "window) {"),
            concat!("triggered(app, Trigger::", "Wake)"),
            concat!("triggered(app, Trigger::", "Occlusion { visible })"),
            concat!("state.schedule.", "trigger(trigger, Instant::now())"),
            concat!("state.schedule.", "take_due(Instant::now())"),
            concat!("later(app, due, ", "repaint)"),
            concat!("let targets = ", "repaint_targets(windows);"),
            concat!("window.eval(", "REPAINT_SCRIPT)"),
            concat!(
                "launcher_panel::evaluate_in_launcher(&host, ",
                "REPAINT_SCRIPT)"
            ),
        ] {
            assert!(glue.contains(needle), "the macOS glue lacks {needle}");
        }
        for frame_or_size in [
            "setFrame",
            "set_size",
            "set_bounds",
            "set_position",
            "NSRect",
        ] {
            assert!(
                !production.contains(frame_or_size),
                "the wake repaint sets a frame or a size: {frame_or_size}"
            );
        }
    }
}
