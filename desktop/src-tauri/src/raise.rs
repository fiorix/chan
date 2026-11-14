//! The raise a window gets when chan brings it forward on request: a second
//! launch coming forward (`single_instance::come_forward`), a close
//! confirmation (`serve::on_close_requested`), an open Window menu row
//! (`show_window` in `main.rs`), a window list or `cs window open` request or
//! hidden Window menu row (`unbury_window` in `main.rs`), the About item
//! for an existing window (`open_about_window` in `main.rs`), and a requested
//! terminal once its watcher builds it (`raise_new_terminal_window` in
//! `main.rs`). These call [`raise_window`] and nothing else does, so no path
//! takes focus that nobody asked for.
//!
//! The raise restores the window, shows it and focuses it through Tauri, and
//! then settles what those calls leave undone on the platform. The focus call
//! is tao's `set_focus`, which on every platform does nothing while the window
//! reads minimized or not visible. Each platform settles that its own way:
//!
//! - macOS: `set_focus` is the only one of the three calls that activates
//!   the app (it makes the window key and calls `activateIgnoringOtherApps:`),
//!   and it skips a window that reads miniaturized, as one still leaving the
//!   Dock may, or not visible, as every window of a hidden app does. A second
//!   launch on a hidden app raises one of those: `come_forward` picks it from
//!   the desktop's own books, not from its reads, and unhides the app just
//!   before the raise, so the window can still read not visible here. The
//!   raise therefore does what `set_focus` does whatever the window reads: on
//!   the main thread, after the window calls, it unhides a hidden app, makes
//!   the window key and activates the app. For a window that was neither
//!   minimized nor hidden that repeats what `set_focus` already did.
//! - Linux and FreeBSD, where tao drives GTK: tao queues the restore and the
//!   show for the GTK main loop and clears its minimized flag only when GTK
//!   reports the window's new state, after the window manager has handled
//!   the restore, so a `set_focus` that follows the restore at once finds
//!   the window still minimized. A window that read minimized or hidden
//!   before the raise is focused again once it reads visible and no longer
//!   minimized, looked at off the main thread every [`RESTORE_POLL`] for at
//!   most [`RESTORE_WAIT`]; one that still reads minimized or hidden then is
//!   left as the window manager put it.
//!   A window that read shown needs nothing more, since `set_focus` presented
//!   it. Waiting for visibility also covers the queued `show` of a hidden
//!   window, which the immediate `set_focus` skips.
//!   Whether the window manager gives a presented window the focus is its
//!   own decision: one that prevents focus stealing weighs the request's
//!   time, which GTK takes from the last input the app received, against
//!   the user's last input elsewhere.
//! - Windows: tao restores the window with `ShowWindow(SW_RESTORE)` and shows
//!   it on the event loop's thread, setting its minimized and visible flags
//!   in the same steps, before the focus call runs there, so `set_focus`
//!   brings the window to the foreground by itself.

use std::time::Duration;

use tauri::{Runtime, WebviewWindow};

/// How long a raise on the GTK desktops waits for a window that read
/// minimized or hidden to read restored and visible, and how often it looks.
/// A window manager answers a restore within a few frames; the bound keeps a
/// window that never reads restored from being focused long after the user
/// moved on.
const RESTORE_WAIT: Duration = Duration::from_secs(1);
const RESTORE_POLL: Duration = Duration::from_millis(20);

/// Restore, show and focus `window`, then settle the platform's remainder
/// (see the module comment). Fails only when Tauri cannot reach the window's
/// event loop.
pub(crate) fn raise_window<R: Runtime>(window: &WebviewWindow<R>) -> tauri::Result<()> {
    let was_minimized = window.is_minimized().unwrap_or(false);
    let was_visible = window.is_visible().unwrap_or(true);
    let _ = window.unminimize();
    window.show()?;
    window.set_focus()?;
    match settle_for(Platform::CURRENT, was_minimized, was_visible) {
        Settle::ActivateApp => {
            #[cfg(target_os = "macos")]
            activate_app(window);
        }
        Settle::FocusOnceRestored => focus_once_restored(window.clone()),
        Settle::Nothing => {}
    }
    Ok(())
}

/// The windowing platform a raise settles for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Platform {
    MacOs,
    /// Linux and FreeBSD, where tao drives GTK.
    Gtk,
    Windows,
}

impl Platform {
    const CURRENT: Platform = if cfg!(target_os = "macos") {
        Platform::MacOs
    } else if cfg!(windows) {
        Platform::Windows
    } else {
        Platform::Gtk
    };
}

/// What a raise does after the window calls.
#[derive(Debug, PartialEq, Eq)]
enum Settle {
    /// Unhide the app, make the window key and activate the app.
    ActivateApp,
    /// Focus the window again once it reads visible and no longer minimized.
    FocusOnceRestored,
    /// The window calls were enough.
    Nothing,
}

fn settle_for(platform: Platform, was_minimized: bool, was_visible: bool) -> Settle {
    match platform {
        Platform::MacOs => Settle::ActivateApp,
        Platform::Gtk if was_minimized || !was_visible => Settle::FocusOnceRestored,
        Platform::Gtk | Platform::Windows => Settle::Nothing,
    }
}

/// Unhide a hidden app, make `window` key and activate the app, on the main
/// thread; a window that can no longer be read by then asks for nothing, so
/// the app is left as it is. `activateIgnoringOtherApps:` is the call tao's
/// `set_focus` makes.
/// macOS 14 deprecates it for a cooperative `activate`, which the system may
/// decline while another app is active, as one is when a second launch asks
/// chan to come forward.
#[cfg(target_os = "macos")]
fn activate_app<R: Runtime>(window: &WebviewWindow<R>) {
    use objc2_app_kit::{NSApplication, NSWindow};

    let target = window.clone();
    let scheduled = window.run_on_main_thread(move || {
        let Some(mtm) = objc2::MainThreadMarker::new() else {
            return;
        };
        let Ok(ns_window) = target.ns_window() else {
            return;
        };
        // SAFETY: on the main thread (the marker above), and `ns_window` is
        // the live NSWindow Tauri owns for this window, borrowed for this
        // call.
        let Some(ns_window) = (unsafe { ns_window.cast::<NSWindow>().as_ref() }) else {
            return;
        };
        let app = NSApplication::sharedApplication(mtm);
        if app.isHidden() {
            app.unhideWithoutActivation();
        }
        ns_window.makeKeyAndOrderFront(None);
        #[allow(deprecated)]
        app.activateIgnoringOtherApps(true);
    });
    if let Err(e) = scheduled {
        tracing::warn!(label = %window.label(), error = %e, "activating the app to raise a window failed");
    }
}

/// Focus `window` once it reads visible and no longer minimized, from a task
/// of its own so a caller on the main thread is never held.
fn focus_once_restored<R: Runtime>(window: WebviewWindow<R>) {
    tauri::async_runtime::spawn(async move {
        let restored = focus_when_restored(
            || window.is_minimized().ok(),
            || window.is_visible().ok(),
            || {
                if let Err(e) = window.set_focus() {
                    tracing::warn!(label = %window.label(), error = %e, "focusing the restored window failed");
                }
            },
        )
        .await;
        match restored {
            Restored::Focused(waited) => {
                tracing::debug!(label = %window.label(), ?waited, "focused the raised window once it read restored")
            }
            Restored::NotReady => tracing::info!(
                label = %window.label(),
                waited = ?RESTORE_WAIT,
                "the raised window still reads minimized or hidden; its focus is left to the window manager"
            ),
            Restored::Gone => {
                tracing::debug!(label = %window.label(), "the raised window went before it read restored")
            }
        }
    });
}

/// How the wait for a restore ended.
#[derive(Debug, PartialEq, Eq)]
enum Restored {
    /// The window read restored after this long and was focused.
    Focused(Duration),
    /// It still read minimized or hidden when the wait was spent.
    NotReady,
    /// It could not be read, so it is gone.
    Gone,
}

/// Look every [`RESTORE_POLL`] and call `focus` once the window reads visible
/// and not minimized, for at most [`RESTORE_WAIT`]. Either reading answers
/// `None` for a window that cannot be read.
async fn focus_when_restored(
    mut minimized: impl FnMut() -> Option<bool>,
    mut visible: impl FnMut() -> Option<bool>,
    focus: impl FnOnce(),
) -> Restored {
    let start = tokio::time::Instant::now();
    loop {
        let waited = start.elapsed();
        match after_look(minimized(), visible(), waited) {
            Look::Focus => {
                focus();
                return Restored::Focused(waited);
            }
            Look::Again => tokio::time::sleep(RESTORE_POLL).await,
            Look::NotReady => return Restored::NotReady,
            Look::Gone => return Restored::Gone,
        }
    }
}

/// What one look at a raised window decides.
#[derive(Debug, PartialEq, Eq)]
enum Look {
    Focus,
    Again,
    NotReady,
    Gone,
}

fn after_look(minimized: Option<bool>, visible: Option<bool>, waited: Duration) -> Look {
    match (minimized, visible) {
        (Some(false), Some(true)) => Look::Focus,
        (Some(_), Some(_)) if waited < RESTORE_WAIT => Look::Again,
        (Some(_), Some(_)) => Look::NotReady,
        _ => Look::Gone,
    }
}

/// A requested window's current eligibility and native build state.
pub(crate) enum WindowReady {
    Waiting,
    Ready,
    Cancelled,
}

/// Wait for a requested native build, without polling or retaining a request
/// after its deadline. The build's completion and library changes share `change`.
pub(crate) async fn wait_for_requested_window(
    change: &tokio::sync::Notify,
    deadline: tokio::time::Instant,
    mut probe: impl FnMut() -> WindowReady,
) -> bool {
    loop {
        let notified = change.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        match probe() {
            WindowReady::Ready => return true,
            WindowReady::Cancelled => return false,
            WindowReady::Waiting => {}
        }
        if tokio::time::timeout_at(deadline, notified).await.is_err() {
            return false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn production(source: &str) -> &str {
        source
            .split_once("\n#[cfg(test)]\nmod tests {")
            .map_or(source, |(production, _)| production)
    }

    /// The body of the function whose signature line starts with
    /// `signature`, up to its closing brace at column 0.
    fn body<'a>(source: &'a str, signature: &str) -> &'a str {
        let (_, rest) = source
            .split_once(signature)
            .unwrap_or_else(|| panic!("{signature} exists"));
        let (body, _) = rest
            .split_once("\n}\n")
            .unwrap_or_else(|| panic!("{signature} ends at a column-0 brace"));
        body
    }

    fn in_order(source: &str, calls: &[&str]) {
        let at: Vec<usize> = calls
            .iter()
            .map(|call| {
                source
                    .find(call)
                    .unwrap_or_else(|| panic!("{call} is missing from:\n{source}"))
            })
            .collect();
        for (pair, at) in calls.windows(2).zip(at.windows(2)) {
            assert!(
                at[0] < at[1],
                "{} must come before {}:\n{source}",
                pair[0],
                pair[1]
            );
        }
    }

    #[test]
    fn each_platform_settles_the_raise_its_own_way() {
        for was_minimized in [false, true] {
            for was_visible in [false, true] {
                assert_eq!(
                    settle_for(Platform::MacOs, was_minimized, was_visible),
                    Settle::ActivateApp
                );
                assert_eq!(
                    settle_for(Platform::Windows, was_minimized, was_visible),
                    Settle::Nothing
                );
            }
        }
        for (minimized, visible) in [(true, true), (false, false), (true, false)] {
            assert_eq!(
                settle_for(Platform::Gtk, minimized, visible),
                Settle::FocusOnceRestored
            );
        }
        assert_eq!(settle_for(Platform::Gtk, false, true), Settle::Nothing);
    }

    #[test]
    fn a_look_requires_a_visible_restored_window_and_bounds_the_wait() {
        for waited in [Duration::ZERO, RESTORE_WAIT * 2] {
            assert_eq!(after_look(Some(false), Some(true), waited), Look::Focus);
        }
        for (minimized, visible) in [(true, true), (false, false), (true, false)] {
            for waited in [Duration::ZERO, RESTORE_WAIT - RESTORE_POLL] {
                assert_eq!(
                    after_look(Some(minimized), Some(visible), waited),
                    Look::Again
                );
            }
            assert_eq!(
                after_look(Some(minimized), Some(visible), RESTORE_WAIT),
                Look::NotReady
            );
        }
        for (minimized, visible) in [(None, Some(true)), (Some(false), None), (None, None)] {
            for waited in [Duration::ZERO, RESTORE_WAIT] {
                assert_eq!(after_look(minimized, visible, waited), Look::Gone);
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_requested_window_already_built_is_ready_without_a_notification() {
        let change = tokio::sync::Notify::new();
        let start = tokio::time::Instant::now();
        let mut probes = 0;
        assert!(
            wait_for_requested_window(&change, start + Duration::from_secs(3), || {
                probes += 1;
                WindowReady::Ready
            })
            .await
        );
        assert_eq!(probes, 1);
        assert_eq!(start.elapsed(), Duration::ZERO);
    }

    #[tokio::test(start_paused = true)]
    async fn a_native_completion_during_the_probe_is_not_lost() {
        let change = tokio::sync::Notify::new();
        let start = tokio::time::Instant::now();
        let mut probes = 0;
        assert!(
            wait_for_requested_window(&change, start + Duration::from_secs(3), || {
                probes += 1;
                if probes == 1 {
                    change.notify_waiters();
                    WindowReady::Waiting
                } else {
                    WindowReady::Ready
                }
            })
            .await
        );
        assert_eq!(probes, 2);
        assert_eq!(start.elapsed(), Duration::ZERO);
    }

    #[tokio::test(start_paused = true)]
    async fn a_cancelled_request_stops_without_waiting_or_retrying() {
        let change = tokio::sync::Notify::new();
        let start = tokio::time::Instant::now();
        let mut probes = 0;
        assert!(
            !wait_for_requested_window(&change, start + Duration::from_secs(3), || {
                probes += 1;
                WindowReady::Cancelled
            })
            .await
        );
        assert_eq!(probes, 1);
        assert_eq!(start.elapsed(), Duration::ZERO);
    }

    #[tokio::test(start_paused = true)]
    async fn a_missing_native_window_expires_without_polling() {
        let change = tokio::sync::Notify::new();
        let start = tokio::time::Instant::now();
        let mut probes = 0;
        let ready = tokio::time::timeout(
            Duration::from_secs(4),
            wait_for_requested_window(&change, start + Duration::from_secs(3), || {
                probes += 1;
                WindowReady::Waiting
            }),
        )
        .await
        .expect("the wait must be bounded");
        assert!(!ready);
        assert_eq!(probes, 1);
        assert_eq!(start.elapsed(), Duration::from_secs(3));
    }

    #[tokio::test(start_paused = true)]
    async fn an_expired_request_cannot_take_a_ready_window() {
        let change = tokio::sync::Notify::new();
        let mut probes = 0;
        assert!(
            !wait_for_requested_window(&change, tokio::time::Instant::now(), || {
                probes += 1;
                WindowReady::Ready
            })
            .await
        );
        assert_eq!(probes, 0);
    }

    #[tokio::test(start_paused = true)]
    async fn a_window_that_reads_restored_while_the_raise_waits_is_focused_once() {
        let mut looks = 0;
        let mut focused = 0;
        let restored = tokio::time::timeout(
            RESTORE_WAIT * 10,
            focus_when_restored(
                || {
                    looks += 1;
                    Some(looks < 4)
                },
                || Some(true),
                || focused += 1,
            ),
        )
        .await
        .expect("the wait is bounded");
        let Restored::Focused(waited) = restored else {
            panic!("{restored:?}");
        };
        assert!(
            waited >= RESTORE_POLL * 3 && waited < RESTORE_POLL * 4,
            "{waited:?}"
        );
        assert_eq!((looks, focused), (4, 1));
    }

    #[tokio::test(start_paused = true)]
    async fn a_window_that_stays_minimized_or_hidden_is_left_once_the_wait_is_spent() {
        for (minimized, visible) in [(true, true), (false, false), (true, false)] {
            let start = tokio::time::Instant::now();
            let mut focused = false;
            let restored = tokio::time::timeout(
                RESTORE_WAIT * 10,
                focus_when_restored(|| Some(minimized), || Some(visible), || focused = true),
            )
            .await
            .expect("the wait is bounded");
            assert_eq!(restored, Restored::NotReady);
            assert!(!focused);
            let waited = start.elapsed();
            assert!(
                waited >= RESTORE_WAIT && waited < RESTORE_WAIT + RESTORE_POLL,
                "{waited:?}"
            );
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_hidden_window_waits_for_both_visibility_and_restore_before_focusing_once() {
        use std::cell::Cell;
        for hidden_first in [false, true] {
            let looks = Cell::new(0);
            let mut focused = 0;
            let restored = tokio::time::timeout(
                RESTORE_WAIT * 10,
                focus_when_restored(
                    || {
                        looks.set(looks.get() + 1);
                        Some(if hidden_first {
                            looks.get() < 2
                        } else {
                            looks.get() < 4
                        })
                    },
                    || {
                        Some(if hidden_first {
                            looks.get() >= 4
                        } else {
                            looks.get() >= 2
                        })
                    },
                    || focused += 1,
                ),
            )
            .await
            .expect("the wait is bounded");
            assert_eq!(restored, Restored::Focused(RESTORE_POLL * 3));
            assert_eq!((looks.get(), focused), (4, 1));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_window_that_cannot_be_read_is_not_focused() {
        for (minimized, visible) in [(None, Some(true)), (Some(false), None)] {
            let mut focused = false;
            let restored = tokio::time::timeout(
                RESTORE_WAIT * 10,
                focus_when_restored(|| minimized, || visible, || focused = true),
            )
            .await
            .expect("the wait is bounded");
            assert_eq!(restored, Restored::Gone);
            assert!(!focused);
        }
    }

    /// A source pin: the window calls run in the order a minimized window
    /// needs (restored before it is shown and focused), the minimized reading
    /// is taken before the restore changes it, and the settle comes last and
    /// does what its choice names. The macOS arm is compiled on macOS alone,
    /// so only this pin sees it go missing on another host.
    #[test]
    fn the_raise_restores_shows_and_focuses_before_it_settles() {
        let raise = body(
            production(include_str!("raise.rs")),
            "\npub(crate) fn raise_window",
        );
        in_order(
            raise,
            &[
                "let was_minimized = window.is_minimized().unwrap_or(false);",
                "let was_visible = window.is_visible().unwrap_or(true);",
                "window.unminimize()",
                "window.show()?",
                "window.set_focus()?",
                "settle_for(Platform::CURRENT, was_minimized, was_visible)",
                "Settle::ActivateApp => {",
                "activate_app(window);",
                "Settle::FocusOnceRestored => focus_once_restored(window.clone())",
            ],
        );
    }

    #[test]
    fn the_current_platform_is_the_one_built_for() {
        #[cfg(target_os = "macos")]
        assert_eq!(Platform::CURRENT, Platform::MacOs);
        #[cfg(windows)]
        assert_eq!(Platform::CURRENT, Platform::Windows);
        #[cfg(any(target_os = "linux", target_os = "freebsd"))]
        assert_eq!(Platform::CURRENT, Platform::Gtk);
    }

    /// A source pin: the wait for a restore reads the window's minimized and
    /// visible states and focuses that same window.
    #[test]
    fn the_wait_reads_and_focuses_the_raised_window() {
        let focus = body(
            production(include_str!("raise.rs")),
            "\nfn focus_once_restored",
        );
        in_order(
            focus,
            &[
                "focus_when_restored(",
                "|| window.is_minimized().ok(),",
                "|| window.is_visible().ok(),",
                "if let Err(e) = window.set_focus() {",
                ".await;",
            ],
        );
    }

    /// A source pin of the macOS settle, read on every host: it runs on the
    /// main thread, does nothing for a window that can no longer be read,
    /// unhides the app before it keys the window, and activates the app last,
    /// as `set_focus` keys before it activates.
    #[test]
    fn the_app_is_unhidden_then_the_window_keyed_then_the_app_activated() {
        let activate = body(production(include_str!("raise.rs")), "\nfn activate_app");
        in_order(
            activate,
            &[
                "window.run_on_main_thread(move || {",
                "objc2::MainThreadMarker::new()",
                "let Ok(ns_window) = target.ns_window() else {\n            return;\n        };",
                "let Some(ns_window) = (unsafe { ns_window.cast::<NSWindow>().as_ref() }) else {\n            return;\n        };",
                "if app.isHidden() {",
                "app.unhideWithoutActivation();",
                "ns_window.makeKeyAndOrderFront(None);",
                "app.activateIgnoringOtherApps(true);",
            ],
        );
    }

    #[test]
    fn each_unbury_branch_and_the_existing_about_window_take_the_shared_raise() {
        let main = production(include_str!("main.rs"));
        let unbury = body(main, "\npub fn unbury_window");
        let (_, local) = unbury
            .split_once("if label.starts_with(\"local::\") {")
            .unwrap();
        let (local, remote) = local
            .split_once("if label.starts_with(\"lib-\") {")
            .unwrap();
        let (remote, other) = remote
            .split_once("let shown = match app.get_webview_window(label)")
            .unwrap();
        for branch in [local, remote] {
            in_order(
                branch,
                &[
                    "view.unbury(label)",
                    "if let Some(w) = app.get_webview_window(label)",
                    "raise::raise_window(&w)",
                ],
            );
            assert_eq!(branch.matches("raise::raise_window(&w)").count(), 1);
        }
        in_order(
            other,
            &["Some(w) => {", "raise::raise_window(&w)", "None => false"],
        );
        assert_eq!(other.matches("raise::raise_window(&w)").count(), 1);
        let about = body(main, "\nfn open_about_window(");
        let existing = about.split_once("let version =").unwrap().0;
        in_order(
            existing,
            &[
                "if let Some(win) = app.get_webview_window(\"about\")",
                "raise::raise_window(&win)",
                "return Ok(())",
            ],
        );
        assert_eq!(about.matches("raise::raise_window(&win)").count(), 1);
        for caller in [unbury, existing] {
            for own in [".show()", ".set_focus()", ".unminimize()"] {
                assert!(
                    !caller.contains(own),
                    "caller must leave {own} to the shared raise"
                );
            }
        }
    }

    #[test]
    fn requested_terminal_opens_raise_only_the_new_native_window() {
        let main = production(include_str!("main.rs"));
        let handoff = main
            .split_once("Request::OpenTerminal { cwd, .. } => {")
            .unwrap()
            .1;
        let handoff = handoff.split_once("Request::Activate { .. }").unwrap().0;
        in_order(
            handoff,
            &[
                "serve::spawn_throwaway_terminal_window(",
                "Ok(label) => {",
                "raise_new_terminal_window(app.clone(), state, label);",
                "Response::TerminalOpened",
            ],
        );
        let explicit = body(main, "\nfn spawn_terminal_window(");
        in_order(
            explicit,
            &[
                "serve::spawn_local_terminal_window(Arc::clone(&state)).await",
                "Ok(label) => raise_new_terminal_window(app_for_task, state, label)",
            ],
        );
        let requested = body(main, "\nfn raise_new_terminal_window(");
        in_order(
            requested,
            &[
                "raise::wait_for_requested_window(",
                "requested_terminal_is_shown(&state, &label)",
                "app.get_webview_window(&label).is_some()",
                ".await",
                "if !ready {",
                "requested terminal raise wait stopped",
                "            );\n            return;\n        }\n        let dispatch",
                "dispatch.run_on_main_thread(move || {",
            ],
        );
        let callback = requested
            .split_once("dispatch.run_on_main_thread(move || {")
            .unwrap()
            .1;
        in_order(
            callback,
            &[
                "tokio::time::Instant::now() >= deadline",
                "!requested_terminal_is_shown(&state, &label)",
                "                }\n                return;\n            }\n            if let Some(window) = app.get_webview_window(&label)",
                "raise::raise_window(&window)",
            ],
        );
        assert!(callback.contains(concat!(
            "if tokio::time::Instant::now() >= deadline\n",
            "                || !requested_terminal_is_shown(&state, &label)\n",
            "            {\n                if tracing::enabled!(tracing::Level::DEBUG) {",
        )));
        assert_eq!(requested.matches("raise::raise_window(").count(), 1);
        assert_eq!(main.matches("raise_new_terminal_window(").count(), 3);
        for boot in [
            body(main, "\nasync fn ensure_boot_window("),
            production(include_str!("launch_paths.rs")),
        ] {
            assert!(!boot.contains("raise_new_terminal_window("));
        }
    }

    #[test]
    fn requested_terminal_refusal_logging_does_not_hold_locks() {
        let main = production(include_str!("main.rs"));
        let requested = body(main, "\nfn raise_new_terminal_window(");
        let callback = requested
            .split_once("dispatch.run_on_main_thread(move || {")
            .unwrap()
            .1;
        assert_eq!(callback.matches("tracing::debug!(").count(), 1);
        let arguments = callback.split_once("tracing::debug!(").unwrap().1;
        let arguments = arguments.split_once("\n                    );").unwrap().0;
        assert!(arguments.contains("\"requested terminal raise callback refused\""));
        let arguments: String = arguments.chars().filter(|c| !c.is_whitespace()).collect();
        for call in [".lock(", "put_away("] {
            assert!(
                !arguments.contains(call),
                "refusal logging must snapshot {call} before the debug macro: {arguments}"
            );
        }
    }

    #[test]
    fn a_requested_terminal_raise_uses_the_live_local_visibility_rule() {
        let main = production(include_str!("main.rs"));
        let eligibility = body(main, "\nfn requested_terminal_is_shown(");
        assert!(eligibility.contains(concat!(
            "if state\n        .shutdown_started\n",
            "        .load(std::sync::atomic::Ordering::SeqCst)\n",
            "        || state\n            .local_watcher_view()\n",
            "            .is_some_and(|view| view.is_buried(label))\n",
            "    {\n        return false;\n    }",
        )));
        in_order(
            eligibility,
            &[
                ".shutdown_started",
                ".load(std::sync::atomic::Ordering::SeqCst)",
                ".local_watcher_view()",
                ".is_some_and(|view| view.is_buried(label))",
                "return false;",
                "let Some(embedded) = state.embedded() else {",
                "let put_away = last_window::put_away(state);",
                "embedded.local_window_records().iter().any(|record| {",
                "window_watcher::native_label(record) == label",
                "&& window_watcher::should_show(record, &put_away)",
            ],
        );
    }

    /// Every direct caller is an explicit request to bring a window forward.
    /// Count all mentions so an import cannot bypass the module-path pin.
    #[test]
    fn only_the_requested_raises_take_the_shared_raise() {
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut calls = BTreeMap::new();
        let mut directories = vec![src.clone()];
        let mut visited = std::collections::HashSet::new();
        while let Some(directory) = directories.pop() {
            if !visited.insert(
                directory
                    .canonicalize()
                    .expect("a source directory resolves"),
            ) {
                continue;
            }
            for entry in std::fs::read_dir(directory).expect("the crate's sources are readable") {
                let entry = entry.expect("a source entry");
                let path = entry.path();
                if path == src.join("testdata") {
                    continue;
                }
                if path.is_dir() {
                    directories.push(path);
                    continue;
                }
                if path.extension().and_then(|ext| ext.to_str()) != Some("rs") {
                    continue;
                }
                let relative = path.strip_prefix(&src).expect("a source path under src");
                if relative == std::path::Path::new("raise.rs") {
                    continue;
                }
                let name = relative.to_string_lossy().into_owned();
                let source = std::fs::read_to_string(&path).expect("a source file reads");
                let production = production(&source);
                let by_path = production.matches("raise::raise_window(").count();
                assert_eq!(
                    production.matches("raise_window").count(),
                    by_path,
                    "{name} reaches the raise only by its module path"
                );
                if by_path > 0 {
                    calls.insert(name, by_path);
                }
            }
        }
        assert_eq!(
            calls,
            BTreeMap::from([
                ("main.rs".to_string(), 6),
                ("serve.rs".to_string(), 1),
                ("single_instance.rs".to_string(), 1),
            ])
        );
    }
}
