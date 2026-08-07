//! Confirm dialogs that honor Return-to-default on macOS.
//!
//! A confirm routed through `tauri_plugin_dialog` (rfd under the hood)
//! gets the button ORDER right, but rfd's async alert
//! window never becomes *key*, so a Return keypress is never routed to the
//! default button -- the user must click. There is no plugin-level setter to
//! fix it (traced to tauri-plugin-dialog 2.7.1 -> rfd 0.16.0).
//!
//! On macOS we therefore build an `NSAlert` directly, give its default
//! (first/blue) button the Return key-equivalent, give the secondary button
//! Escape, bring the app forward, and run it MODALLY. `runModal` makes the
//! alert's window key and main and spins its own nested event loop, so Return
//! reaches the default button and -- unlike rfd's *blocking* show, which would
//! wedge the outer event loop -- it cannot deadlock the main thread (it pumps
//! itself, the same way `pdf.rs` pumps the run loop synchronously).
//!
//! Off macOS the plugin path is kept verbatim (rfd routes Return fine on
//! GTK / Win32), so `confirm` is cfg-split internally and callers stay
//! platform-agnostic.
//!
//! `confirm` is callback-shaped like the old `.show(cb)` it replaces: the
//! result callback runs on the main thread. On macOS the modal is scheduled
//! via `run_on_main_thread`, so it fires on a fresh main-loop turn (after the
//! calling window-close handler unwinds) -- keeping the close path non-blocking
//! and the bury / destroy / hide side effects on the main thread exactly as
//! before.

use tauri::AppHandle;

#[cfg(target_os = "macos")]
use objc2::MainThreadMarker;

/// Show a two-button confirm. `on_result(true)` runs when the user chose the
/// default (first/blue) button; `on_result(false)` for the secondary button
/// or Escape. The callback runs on the main thread.
pub(crate) fn confirm(
    app: &AppHandle,
    title: &str,
    message: &str,
    default_label: &str,
    secondary_label: &str,
    on_result: impl FnOnce(bool) + Send + 'static,
) {
    #[cfg(target_os = "macos")]
    {
        let title = title.to_owned();
        let message = message.to_owned();
        let default_label = default_label.to_owned();
        let secondary_label = secondary_label.to_owned();
        let scheduled = app.run_on_main_thread(move || {
            let mtm = MainThreadMarker::new()
                .expect("run_on_main_thread closure must execute on the main thread");
            let chose_default = run_native_alert(
                mtm,
                &title,
                &message,
                &default_label,
                Some(&secondary_label),
            );
            on_result(chose_default);
        });
        if let Err(e) = scheduled {
            // Scheduling failed: the callback never runs, so a oneshot reply it
            // captured drops and the caller maps that to an error -- matching the
            // old behaviour when `.show` could not be scheduled.
            tracing::warn!(error = %e, "scheduling native confirm dialog failed");
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
        app.dialog()
            .message(message)
            .title(title)
            .buttons(MessageDialogButtons::OkCancelCustom(
                default_label.to_owned(),
                secondary_label.to_owned(),
            ))
            .show(on_result);
    }
}

/// Build and run a native `NSAlert` modally on the main thread. Returns true
/// when the user chose the default (first) button. `secondary_label` is
/// `None` for a single-OK notice.
///
/// Must be called on the main thread (`NSAlert` is main-thread-only); the
/// `MainThreadMarker` proves it.
#[cfg(target_os = "macos")]
fn run_native_alert(
    mtm: MainThreadMarker,
    title: &str,
    message: &str,
    default_label: &str,
    secondary_label: Option<&str>,
) -> bool {
    use objc2_app_kit::{NSAlert, NSAlertFirstButtonReturn, NSAlertStyle, NSApplication};
    use objc2_foundation::NSString;

    let alert = NSAlert::new(mtm);
    alert.setMessageText(&NSString::from_str(title));
    alert.setInformativeText(&NSString::from_str(message));
    alert.setAlertStyle(NSAlertStyle::Informational);

    // First button added is the default: rightmost, blue. AppKit already keys
    // it to Return, but we set it explicitly so the routing never depends on
    // that implicit default. `runModal` below makes the alert window key so Return
    // actually reaches this button.
    let default_btn = alert.addButtonWithTitle(&NSString::from_str(default_label));
    default_btn.setKeyEquivalent(&NSString::from_str("\r"));
    if let Some(secondary) = secondary_label {
        let secondary_btn = alert.addButtonWithTitle(&NSString::from_str(secondary));
        // Escape dismisses to the secondary (the safe "Keep open" / "Cancel" /
        // "Later" choice), preserving the previous Escape behaviour.
        secondary_btn.setKeyEquivalent(&NSString::from_str("\u{1b}"));
    }

    // The prompt can fire while chan is not frontmost (notably the on-launch
    // update-ready prompt). Bring the app forward so the modal alert becomes
    // key and Return routes. `activateIgnoringOtherApps` is deprecated on
    // macOS 14 but is the only variant available below it; `#[allow(deprecated)]`
    // mirrors the deprecated-but-still-correct AppKit calls in `dropped_paths.rs`.
    #[allow(deprecated)]
    NSApplication::sharedApplication(mtm).activateIgnoringOtherApps(true);

    // Synchronous, self-pumping nested modal loop -- safe on the main thread
    // (it does not depend on the outer event loop, so no deadlock).
    let response = alert.runModal();
    response == NSAlertFirstButtonReturn
}
