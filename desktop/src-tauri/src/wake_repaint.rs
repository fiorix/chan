//! The repaint every chan window gets after a display wake on macOS.
//!
//! Every window is built transparent (`serve.rs`, `mark_transparent_window`),
//! so a webview that presents no frame shows the desktop below the title bar.
//! After a display sleep in which WebKit suspended the web processes, a window
//! can come back presenting nothing while WebKit reports its view visible and
//! its process resumed. A webview whose size changes sends its page a new
//! geometry, which the web process answers with a layout and a new frame. So
//! the desktop observes the wake and, once the web processes have had time to
//! resume, shortens every webview of every shown window by one point and gives
//! each its frame back on a later main-loop turn. The webview's own frame
//! moves, never the window's: a window frame change reaches geometry
//! persistence and the launcher's host sync as a real resize, and window
//! managers see it.
//!
//! [`WakeRepaint`] is the schedule, free of AppKit so the tests run it on every
//! platform; the macOS observer and the frame calls below drive it.

use std::time::{Duration, Instant};

/// How long after a wake the repaint waits, so the web processes WebKit
/// suspended during the sleep have resumed before their views change size.
pub(crate) const REPAINT_DELAY: Duration = Duration::from_secs(1);

/// How much shorter, in points, a nudged webview is for one main-loop turn.
const NUDGE_POINTS: f64 = 1.0;

/// A view's frame in its superview, in points.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Frame {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
}

/// A frame to give one view.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SetFrame<V> {
    pub(crate) view: V,
    pub(crate) frame: Frame,
}

/// One native window as the repaint reads it: whether it is shown, and every
/// webview in it with its frame. A workspace window showing its launcher holds
/// two.
pub(crate) struct WindowViews<V> {
    pub(crate) shown: bool,
    pub(crate) webviews: Vec<SetFrame<V>>,
}

/// A view the nudge shortened: the frame it had and the frame it was given.
struct Nudged<V> {
    view: V,
    original: Frame,
    nudged: Frame,
}

/// The schedule of the wake repaint: when it is due, and which views wait for
/// their frame back.
pub(crate) struct WakeRepaint<V> {
    due: Option<Instant>,
    nudged: Vec<Nudged<V>>,
}

impl<V> Default for WakeRepaint<V> {
    fn default() -> Self {
        Self {
            due: None,
            nudged: Vec::new(),
        }
    }
}

impl<V: Clone> WakeRepaint<V> {
    /// Record a wake seen at `now` and return when the repaint is due. The
    /// screens and the system each post a wake, so a second wake before the
    /// repaint runs moves it to a delay after the later one, and one repaint
    /// answers both.
    pub(crate) fn wake(&mut self, now: Instant) -> Instant {
        let due = now + REPAINT_DELAY;
        self.due = Some(due);
        due
    }

    /// The nudge at `now`. Once the repaint is due, every webview of every
    /// shown window gets a frame one point shorter, and the frame it had is
    /// kept for [`Self::restore`]. Nothing before the repaint is due or after
    /// it has run; nothing either while an earlier nudge waits for its
    /// restore, and the repaint then stays due. A webview too short to shorten
    /// is left as it is.
    pub(crate) fn nudge(
        &mut self,
        now: Instant,
        windows: impl IntoIterator<Item = WindowViews<V>>,
    ) -> Vec<SetFrame<V>> {
        if !self.nudged.is_empty() || self.due.is_none_or(|due| now < due) {
            return Vec::new();
        }
        self.due = None;
        for window in windows.into_iter().filter(|window| window.shown) {
            for SetFrame { view, frame } in window.webviews {
                if frame.height > NUDGE_POINTS {
                    let nudged = Frame {
                        height: frame.height - NUDGE_POINTS,
                        ..frame
                    };
                    self.nudged.push(Nudged {
                        view,
                        original: frame,
                        nudged,
                    });
                }
            }
        }
        self.nudged
            .iter()
            .map(|nudged| SetFrame {
                view: nudged.view.clone(),
                frame: nudged.nudged,
            })
            .collect()
    }

    /// The frames that give every nudged view its point back, once. A view
    /// still at its nudged frame gets the frame it had. A view something else
    /// moved in between keeps where it was moved and gets the point back on
    /// top of that: a window resized on that turn carries its autoresizing
    /// webview along, and the frame from before the resize would no longer fit
    /// the window. `frame_of` reads a view's frame now.
    pub(crate) fn restore(&mut self, frame_of: impl Fn(&V) -> Frame) -> Vec<SetFrame<V>> {
        std::mem::take(&mut self.nudged)
            .into_iter()
            .map(|entry| {
                let current = frame_of(&entry.view);
                let frame = if current == entry.nudged {
                    entry.original
                } else {
                    Frame {
                        height: current.height + NUDGE_POINTS,
                        ..current
                    }
                };
                SetFrame {
                    view: entry.view,
                    frame,
                }
            })
            .collect()
    }
}

#[cfg(target_os = "macos")]
pub(crate) use macos::install;

/// The wake observer and the frame calls. Every AppKit call runs on the main
/// thread, where the schedule lives too.
#[cfg(target_os = "macos")]
mod macos {
    use std::cell::RefCell;
    use std::time::Instant;

    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, NSObject, NSObjectProtocol};
    use objc2::{define_class, msg_send, sel, AnyThread, DefinedClass, MainThreadMarker};
    use objc2_app_kit::{
        NSApplication, NSView, NSWorkspace, NSWorkspaceDidWakeNotification,
        NSWorkspaceScreensDidWakeNotification,
    };
    use objc2_foundation::{NSNotification, NSPoint, NSRect, NSSize};
    use tauri::AppHandle;

    use super::{Frame, SetFrame, WakeRepaint, WindowViews};

    thread_local! {
        /// The schedule and the observer that feeds it. Main thread only.
        static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
    }

    struct State {
        schedule: WakeRepaint<Retained<NSView>>,
        /// Held for the app's life: a notification center does not retain its
        /// observers.
        _observer: Retained<WakeObserver>,
    }

    define_class!(
        // SAFETY: NSObject has no subclassing requirements, and WakeObserver
        // does not implement Drop.
        #[unsafe(super(NSObject))]
        #[ivars = AppHandle]
        struct WakeObserver;

        unsafe impl NSObjectProtocol for WakeObserver {}

        impl WakeObserver {
            /// Both wake notifications land here, on the thread that posted
            /// them; the schedule is read on the main thread.
            #[unsafe(method(displayDidWake:))]
            fn display_did_wake(&self, _notification: &NSNotification) {
                let app = self.ivars();
                let handle = app.clone();
                if let Err(e) = app.run_on_main_thread(move || woke(&handle)) {
                    tracing::warn!(error = %e, "scheduling the wake repaint failed");
                }
            }
        }
    );

    impl WakeObserver {
        fn new(app: AppHandle) -> Retained<Self> {
            let this = Self::alloc().set_ivars(app);
            // SAFETY: NSObject's designated initializer, sent once to a freshly
            // allocated object whose ivars are set.
            unsafe { msg_send![super(this), init] }
        }
    }

    /// Observe the display and the system wakes on the workspace notification
    /// center. Called once from the app setup, on the main thread; elsewhere
    /// it observes nothing.
    pub(crate) fn install(app: &AppHandle) {
        if MainThreadMarker::new().is_none() {
            tracing::warn!("the wake repaint is installed only on the main thread");
            return;
        }
        let observer = WakeObserver::new(app.clone());
        let center = NSWorkspace::sharedWorkspace().notificationCenter();
        // SAFETY: the observer answers `displayDidWake:`, which takes the one
        // NSNotification the center passes, and STATE holds it for the app's
        // life, so the center never messages a freed object. The names are
        // AppKit's constant strings.
        unsafe {
            for name in [
                NSWorkspaceScreensDidWakeNotification,
                NSWorkspaceDidWakeNotification,
            ] {
                center.addObserver_selector_name_object(
                    &observer,
                    sel!(displayDidWake:),
                    Some(name),
                    None,
                );
            }
        }
        STATE.with(|state| {
            *state.borrow_mut() = Some(State {
                schedule: WakeRepaint::default(),
                _observer: observer,
            });
        });
    }

    /// A wake, on the main thread: the repaint is due a delay from now.
    fn woke(app: &AppHandle) {
        let due = STATE.with(|state| {
            state
                .borrow_mut()
                .as_mut()
                .map(|state| state.schedule.wake(Instant::now()))
        });
        if let Some(due) = due {
            tracing::info!(delay = ?super::REPAINT_DELAY, "wake observed; repaint due");
            run_on_main_thread_at(app, due, repaint);
        }
    }

    /// Run `step` on the main thread no earlier than `at`, and always on a
    /// later main-loop turn: Tauri runs a `run_on_main_thread` closure at once
    /// when the caller is already on the main thread, so the call is made from
    /// the async runtime instead.
    fn run_on_main_thread_at(app: &AppHandle, at: Instant, step: fn(&AppHandle)) {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep_until(at.into()).await;
            let handle = app.clone();
            if let Err(e) = app.run_on_main_thread(move || step(&handle)) {
                tracing::warn!(error = %e, "scheduling a wake repaint step failed");
            }
        });
    }

    /// The nudge, when the repaint is due: every webview of every shown
    /// window one point shorter, each given its frame back on a later turn.
    fn repaint(app: &AppHandle) {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let windows = windows(mtm);
        let nudges = STATE.with(|state| {
            state
                .borrow_mut()
                .as_mut()
                .map(|state| state.schedule.nudge(Instant::now(), windows))
                .unwrap_or_default()
        });
        if nudges.is_empty() {
            return;
        }
        tracing::info!(
            webviews = nudges.len(),
            "repainting every shown window after a wake"
        );
        set_frames(&nudges);
        run_on_main_thread_at(app, Instant::now(), restore);
    }

    /// Every nudged webview gets its point back; then a wake that came due
    /// while the nudge waited repaints.
    fn restore(app: &AppHandle) {
        let restores = STATE.with(|state| {
            state
                .borrow_mut()
                .as_mut()
                .map(|state| state.schedule.restore(|view| frame(view)))
                .unwrap_or_default()
        });
        set_frames(&restores);
        repaint(app);
    }

    /// Every window of the app: whether it is shown, and the webviews in its
    /// content view.
    fn windows(mtm: MainThreadMarker) -> Vec<WindowViews<Retained<NSView>>> {
        let Some(webview_class) = AnyClass::get(c"WKWebView") else {
            return Vec::new();
        };
        NSApplication::sharedApplication(mtm)
            .windows()
            .iter()
            .map(|window| {
                let mut webviews = Vec::new();
                if let Some(content) = window.contentView() {
                    collect_webviews(&content, webview_class, &mut webviews);
                }
                WindowViews {
                    shown: window.isVisible(),
                    webviews,
                }
            })
            .collect()
    }

    /// The webviews in `view`'s tree, `view` included. A webview's own
    /// subviews are WebKit's and are not searched.
    fn collect_webviews(
        view: &Retained<NSView>,
        webview_class: &AnyClass,
        found: &mut Vec<SetFrame<Retained<NSView>>>,
    ) {
        if view.isKindOfClass(webview_class) {
            found.push(SetFrame {
                view: view.clone(),
                frame: frame(view),
            });
            return;
        }
        for subview in view.subviews().iter() {
            collect_webviews(&subview, webview_class, found);
        }
    }

    fn frame(view: &NSView) -> Frame {
        let rect = view.frame();
        Frame {
            x: rect.origin.x,
            y: rect.origin.y,
            width: rect.size.width,
            height: rect.size.height,
        }
    }

    fn set_frames(frames: &[SetFrame<Retained<NSView>>]) {
        for SetFrame { view, frame } in frames {
            view.setFrame(NSRect::new(
                NSPoint::new(frame.x, frame.y),
                NSSize::new(frame.width, frame.height),
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(x: f64, y: f64, width: f64, height: f64) -> Frame {
        Frame {
            x,
            y,
            width,
            height,
        }
    }

    fn window(shown: bool, webviews: &[(&'static str, Frame)]) -> WindowViews<&'static str> {
        WindowViews {
            shown,
            webviews: webviews
                .iter()
                .map(|&(view, frame)| SetFrame { view, frame })
                .collect(),
        }
    }

    /// A local workspace window, a devserver window showing its launcher over
    /// its page, and a hidden window.
    fn windows() -> Vec<WindowViews<&'static str>> {
        vec![
            window(true, &[("local page", frame(0.0, 0.0, 1200.0, 800.0))]),
            window(
                true,
                &[
                    ("devserver page", frame(0.0, 0.0, 1440.0, 900.5)),
                    ("devserver launcher", frame(0.0, 0.0, 1440.0, 900.5)),
                ],
            ),
            window(false, &[("hidden page", frame(0.0, 0.0, 1000.0, 700.0))]),
        ]
    }

    /// The frames of the shown windows' webviews, as `windows()` gives them.
    fn shown_frames() -> Vec<SetFrame<&'static str>> {
        windows()
            .into_iter()
            .filter(|window| window.shown)
            .flat_map(|window| window.webviews)
            .collect()
    }

    #[test]
    fn a_wake_repaints_every_shown_webview_once_and_restores_every_frame() {
        let woke = Instant::now();
        let mut repaint = WakeRepaint::default();
        assert_eq!(repaint.wake(woke), woke + REPAINT_DELAY);

        assert!(
            repaint
                .nudge(woke + REPAINT_DELAY - Duration::from_millis(1), windows())
                .is_empty(),
            "the repaint waits for the web processes to resume"
        );

        let nudges = repaint.nudge(woke + REPAINT_DELAY, windows());
        let views: Vec<_> = nudges.iter().map(|nudge| nudge.view).collect();
        assert_eq!(
            views,
            ["local page", "devserver page", "devserver launcher"],
            "one repaint per webview of every shown window, none for a hidden one"
        );
        for (nudge, shown) in nudges.iter().zip(shown_frames()) {
            assert_eq!(
                nudge.frame,
                Frame {
                    height: shown.frame.height - 1.0,
                    ..shown.frame
                },
                "{} is one point shorter and stays where it is",
                nudge.view
            );
        }

        let restores = repaint.restore(|view| {
            nudges
                .iter()
                .find(|nudge| nudge.view == *view)
                .map(|nudge| nudge.frame)
                .expect("a nudged view")
        });
        assert_eq!(
            restores,
            shown_frames(),
            "every webview gets back the frame it had"
        );

        assert!(repaint.restore(|_| unreachable!()).is_empty());
        assert!(
            repaint
                .nudge(woke + REPAINT_DELAY * 5, windows())
                .is_empty(),
            "one wake, one repaint"
        );
    }

    #[test]
    fn the_screens_and_the_system_wake_together_get_one_repaint_after_the_later() {
        let woke = Instant::now();
        let mut repaint = WakeRepaint::default();
        repaint.wake(woke);
        let later = woke + Duration::from_millis(300);
        assert_eq!(repaint.wake(later), later + REPAINT_DELAY);

        assert!(repaint.nudge(woke + REPAINT_DELAY, windows()).is_empty());
        assert_eq!(repaint.nudge(later + REPAINT_DELAY, windows()).len(), 3);
        assert!(repaint
            .nudge(later + REPAINT_DELAY * 2, windows())
            .is_empty());
    }

    #[test]
    fn no_wake_no_repaint() {
        let mut repaint = WakeRepaint::default();
        assert!(repaint.nudge(Instant::now(), windows()).is_empty());
        assert!(repaint.restore(|_| unreachable!()).is_empty());
    }

    #[test]
    fn a_webview_moved_while_nudged_gets_its_point_back_where_it_was_moved() {
        let woke = Instant::now();
        let mut repaint = WakeRepaint::default();
        repaint.wake(woke);
        let nudges = repaint.nudge(
            woke + REPAINT_DELAY,
            [window(true, &[("page", frame(0.0, 0.0, 1200.0, 800.0))])],
        );
        assert_eq!(nudges[0].frame, frame(0.0, 0.0, 1200.0, 799.0));

        // A window manager widened the window and moved the view on that turn.
        let restores = repaint.restore(|_| frame(0.0, 2.0, 1300.0, 829.0));
        assert_eq!(
            restores,
            [SetFrame {
                view: "page",
                frame: frame(0.0, 2.0, 1300.0, 830.0),
            }]
        );
    }

    #[test]
    fn a_wake_while_a_nudge_waits_repaints_after_the_restore() {
        let woke = Instant::now();
        let mut repaint = WakeRepaint::default();
        repaint.wake(woke);
        let nudges = repaint.nudge(woke + REPAINT_DELAY, windows());
        assert_eq!(nudges.len(), 3);

        let again = woke + REPAINT_DELAY;
        repaint.wake(again);
        assert!(
            repaint.nudge(again + REPAINT_DELAY, windows()).is_empty(),
            "a nudged view is not nudged again before its frame is back"
        );
        let restores = repaint.restore(|view| {
            nudges
                .iter()
                .find(|nudge| nudge.view == *view)
                .map(|nudge| nudge.frame)
                .expect("a nudged view")
        });
        assert_eq!(restores, shown_frames());
        assert_eq!(
            repaint.nudge(again + REPAINT_DELAY, windows()).len(),
            3,
            "the later wake still repaints"
        );
    }

    #[test]
    fn a_webview_with_no_height_to_give_is_left_alone() {
        let woke = Instant::now();
        let mut repaint = WakeRepaint::default();
        repaint.wake(woke);
        let nudges = repaint.nudge(
            woke + REPAINT_DELAY,
            [window(
                true,
                &[
                    ("collapsed", frame(0.0, 0.0, 800.0, 0.0)),
                    ("one point", frame(0.0, 0.0, 800.0, 1.0)),
                    ("page", frame(0.0, 0.0, 800.0, 600.0)),
                ],
            )],
        );
        assert_eq!(
            nudges,
            [SetFrame {
                view: "page",
                frame: frame(0.0, 0.0, 800.0, 599.0),
            }]
        );
        assert_eq!(
            repaint.restore(|_| frame(0.0, 0.0, 800.0, 599.0)),
            [SetFrame {
                view: "page",
                frame: frame(0.0, 0.0, 800.0, 600.0),
            }]
        );
    }

    /// The setup observes both wakes on macOS, and the observer drives the
    /// schedule's three steps.
    #[test]
    fn the_macos_setup_observes_both_wakes_and_drives_the_schedule() {
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
        let glue_start = MODULE
            .find(concat!("\nmod ", "macos {"))
            .expect("the module has its macOS glue");
        let glue_end = MODULE
            .find(concat!("\n#[cfg(test)]\n", "mod tests {"))
            .expect("the module has its tests");
        let glue = &MODULE[glue_start..glue_end];
        for needle in [
            // The registration itself: the names also sit in the imports.
            concat!(
                "for name in [\n",
                "                NSWorkspaceScreensDidWakeNotification,\n",
                "                NSWorkspaceDidWakeNotification,\n",
                "            ] {",
            ),
            concat!("sel!(", "displayDidWake:)"),
            concat!("state.schedule.", "wake(Instant::now())"),
            concat!("state.schedule.", "nudge(Instant::now(), windows)"),
            concat!("state.schedule.", "restore(|view| frame(view))"),
            concat!("run_on_main_thread_at(app, due, ", "repaint)"),
            concat!("run_on_main_thread_at(app, Instant::now(), ", "restore)"),
        ] {
            assert!(glue.contains(needle), "the macOS glue lacks {needle}");
        }
    }
}
