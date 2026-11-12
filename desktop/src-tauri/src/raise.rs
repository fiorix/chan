//! The raise a window gets when chan brings it forward on request: a second
//! launch coming forward (`single_instance::come_forward`), a close
//! confirmation (`serve::on_close_requested`) and a Window menu row
//! (`show_window` in `main.rs`). Those three call [`raise_window`] and nothing
//! else does, so no path takes focus that nobody asked for.
//!
//! The raise restores the window, shows it and focuses it through Tauri, and
//! then settles what those calls leave undone on the platform. The focus call
//! is tao's `set_focus`, which does nothing while the window reads minimized,
//! and on macOS also while it reads not visible. Each platform settles that
//! its own way:
//!
//! - macOS: `set_focus` is the only one of the three calls that activates
//!   the app (it makes the window key and calls `activateIgnoringOtherApps:`),
//!   and it skips a window that reads miniaturized, as one still leaving the
//!   Dock may, or not visible, as every window of a hidden app does. So the
//!   raise does what `set_focus` does whatever the window reads: on the main
//!   thread, after the window calls, it unhides a hidden app, makes the
//!   window key and activates the app. For a window that was neither
//!   minimized nor hidden that repeats what `set_focus` already did.
//! - Linux and FreeBSD, where tao drives GTK: tao queues the restore for the
//!   GTK main loop and clears its minimized flag only when GTK reports the
//!   window's new state, after the window manager has handled the restore,
//!   so a `set_focus` that follows the restore at once finds the window
//!   still minimized. A window that read minimized before the raise is
//!   focused again once it no longer reads minimized, looked at off the main
//!   thread every [`RESTORE_POLL`] for at most [`RESTORE_WAIT`]; one that
//!   still reads minimized then is left as the window manager put it. A
//!   window that did not read minimized needs nothing more, since
//!   `set_focus` already presented it. Whether the window manager then
//!   gives the window the focus is its own decision: one that prevents
//!   focus stealing weighs the request's time, which GTK takes from the last
//!   input the app received, against the user's last input elsewhere.
//! - Windows: tao restores the window with `ShowWindow(SW_RESTORE)` on the
//!   event loop's thread and clears its minimized flag in the same step,
//!   before the focus call runs there, so `set_focus` brings the window to
//!   the foreground by itself.

use std::time::Duration;

use tauri::WebviewWindow;

/// How long a raise on the GTK desktops waits for a window that read
/// minimized to read restored, and how often it looks. A window manager
/// answers a restore within a few frames; the bound keeps a window that never
/// reads restored from being focused long after the user moved on.
const RESTORE_WAIT: Duration = Duration::from_secs(1);
const RESTORE_POLL: Duration = Duration::from_millis(20);

/// Restore, show and focus `window`, then settle the platform's remainder
/// (see the module comment). Fails only when Tauri cannot reach the window's
/// event loop.
pub(crate) fn raise_window(window: &WebviewWindow) -> tauri::Result<()> {
    let was_minimized = window.is_minimized().unwrap_or(false);
    let _ = window.unminimize();
    window.show()?;
    window.set_focus()?;
    match settle_for(Platform::CURRENT, was_minimized) {
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
    /// Focus the window again once it no longer reads minimized.
    FocusOnceRestored,
    /// The window calls were enough.
    Nothing,
}

fn settle_for(platform: Platform, was_minimized: bool) -> Settle {
    match platform {
        Platform::MacOs => Settle::ActivateApp,
        Platform::Gtk if was_minimized => Settle::FocusOnceRestored,
        Platform::Gtk | Platform::Windows => Settle::Nothing,
    }
}

/// Unhide a hidden app, make `window` key and activate the app, on the main
/// thread. `activateIgnoringOtherApps:` is the call tao's `set_focus` makes.
/// macOS 14 deprecates it for a cooperative `activate`, which the system may
/// decline while another app is active, as one is when a second launch asks
/// chan to come forward.
#[cfg(target_os = "macos")]
fn activate_app(window: &WebviewWindow) {
    use objc2_app_kit::{NSApplication, NSWindow};

    let target = window.clone();
    let scheduled = window.run_on_main_thread(move || {
        let Some(mtm) = objc2::MainThreadMarker::new() else {
            return;
        };
        let app = NSApplication::sharedApplication(mtm);
        if app.isHidden() {
            app.unhideWithoutActivation();
        }
        if let Ok(ns_window) = target.ns_window() {
            // SAFETY: on the main thread (the marker above), and `ns_window`
            // is the live NSWindow Tauri owns for this window, borrowed for
            // this call.
            if let Some(ns_window) = unsafe { ns_window.cast::<NSWindow>().as_ref() } {
                ns_window.makeKeyAndOrderFront(None);
            }
        }
        #[allow(deprecated)]
        app.activateIgnoringOtherApps(true);
    });
    if let Err(e) = scheduled {
        tracing::warn!(label = %window.label(), error = %e, "activating the app to raise a window failed");
    }
}

/// Focus `window` once it no longer reads minimized, from a task of its own
/// so the caller's thread, the main thread for two of the three callers, is
/// never held.
fn focus_once_restored(window: WebviewWindow) {
    tauri::async_runtime::spawn(async move {
        let restored = focus_when_restored(
            || window.is_minimized().ok(),
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
            Restored::StillMinimized => tracing::info!(
                label = %window.label(),
                waited = ?RESTORE_WAIT,
                "the raised window still reads minimized; its focus is left to the window manager"
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
    /// It still read minimized when the wait was spent.
    StillMinimized,
    /// It could not be read, so it is gone.
    Gone,
}

/// Look at `minimized` every [`RESTORE_POLL`] and call `focus` once it reads
/// `false`, for at most [`RESTORE_WAIT`]. `minimized` answers `None` for a
/// window that cannot be read.
async fn focus_when_restored(
    mut minimized: impl FnMut() -> Option<bool>,
    focus: impl FnOnce(),
) -> Restored {
    let start = tokio::time::Instant::now();
    loop {
        let waited = start.elapsed();
        match after_look(minimized(), waited) {
            Look::Focus => {
                focus();
                return Restored::Focused(waited);
            }
            Look::Again => tokio::time::sleep(RESTORE_POLL).await,
            Look::StillMinimized => return Restored::StillMinimized,
            Look::Gone => return Restored::Gone,
        }
    }
}

/// What one look at a raised window decides.
#[derive(Debug, PartialEq, Eq)]
enum Look {
    Focus,
    Again,
    StillMinimized,
    Gone,
}

fn after_look(minimized: Option<bool>, waited: Duration) -> Look {
    match minimized {
        Some(false) => Look::Focus,
        Some(true) if waited < RESTORE_WAIT => Look::Again,
        Some(true) => Look::StillMinimized,
        None => Look::Gone,
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
            assert_eq!(
                settle_for(Platform::MacOs, was_minimized),
                Settle::ActivateApp
            );
            assert_eq!(
                settle_for(Platform::Windows, was_minimized),
                Settle::Nothing
            );
        }
        assert_eq!(settle_for(Platform::Gtk, true), Settle::FocusOnceRestored);
        // A window that did not read minimized was presented by the focus
        // call already, and is not waited for.
        assert_eq!(settle_for(Platform::Gtk, false), Settle::Nothing);
    }

    #[test]
    fn a_look_focuses_a_restored_window_and_waits_for_a_minimized_one_within_the_bound() {
        assert_eq!(after_look(Some(false), Duration::ZERO), Look::Focus);
        assert_eq!(after_look(Some(false), RESTORE_WAIT * 2), Look::Focus);
        assert_eq!(after_look(Some(true), Duration::ZERO), Look::Again);
        assert_eq!(
            after_look(Some(true), RESTORE_WAIT - RESTORE_POLL),
            Look::Again
        );
        assert_eq!(after_look(Some(true), RESTORE_WAIT), Look::StillMinimized);
        assert_eq!(after_look(None, Duration::ZERO), Look::Gone);
        assert_eq!(after_look(None, RESTORE_WAIT), Look::Gone);
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
    async fn a_window_that_stays_minimized_is_left_once_the_wait_is_spent() {
        let start = tokio::time::Instant::now();
        let mut focused = false;
        let restored = tokio::time::timeout(
            RESTORE_WAIT * 10,
            focus_when_restored(|| Some(true), || focused = true),
        )
        .await
        .expect("the wait is bounded");
        assert_eq!(restored, Restored::StillMinimized);
        assert!(!focused);
        let waited = start.elapsed();
        assert!(
            waited >= RESTORE_WAIT && waited < RESTORE_WAIT + RESTORE_POLL,
            "{waited:?}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_window_that_cannot_be_read_is_not_focused() {
        let mut focused = false;
        let restored = tokio::time::timeout(
            RESTORE_WAIT * 10,
            focus_when_restored(|| None, || focused = true),
        )
        .await
        .expect("the wait is bounded");
        assert_eq!(restored, Restored::Gone);
        assert!(!focused);
    }

    /// A source pin: the window calls run in the order a minimized window
    /// needs (restored before it is shown and focused), the minimized reading
    /// is taken before the restore changes it, and the settle comes last.
    #[test]
    fn the_raise_restores_shows_and_focuses_before_it_settles() {
        let raise = body(
            production(include_str!("raise.rs")),
            "\npub(crate) fn raise_window(",
        );
        in_order(
            raise,
            &[
                "window.is_minimized()",
                "window.unminimize()",
                "window.show()?",
                "window.set_focus()?",
                "settle_for(Platform::CURRENT, was_minimized)",
            ],
        );
    }

    /// A source pin of the macOS settle, read on every host: it runs on the
    /// main thread, unhides the app before it keys the window, and activates
    /// the app last, as `set_focus` keys before it activates.
    #[test]
    fn the_app_is_unhidden_then_the_window_keyed_then_the_app_activated() {
        let activate = body(production(include_str!("raise.rs")), "\nfn activate_app(");
        in_order(
            activate,
            &[
                "window.run_on_main_thread(move || {",
                "objc2::MainThreadMarker::new()",
                "if app.isHidden() {",
                "app.unhideWithoutActivation();",
                "ns_window.makeKeyAndOrderFront(None);",
                "app.activateIgnoringOtherApps(true);",
            ],
        );
    }

    /// The raise takes focus, so it is reached from the three raises a user
    /// asked for and from nowhere else: one call in each of their files, by
    /// the module path, and no other mention of it outside this module.
    #[test]
    fn only_the_three_raises_take_the_shared_raise() {
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut calls = BTreeMap::new();
        for entry in std::fs::read_dir(&src).expect("the crate's sources are readable") {
            let path = entry.expect("a source entry").path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("rs") {
                continue;
            }
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            if name == "raise.rs" {
                continue;
            }
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
        assert_eq!(
            calls,
            BTreeMap::from([
                ("main.rs".to_string(), 1),
                ("serve.rs".to_string(), 1),
                ("single_instance.rs".to_string(), 1),
            ])
        );
    }
}
