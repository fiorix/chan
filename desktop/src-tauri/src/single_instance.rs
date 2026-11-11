//! One chan-desktop per handoff endpoint.
//!
//! Every desktop process runs its own window watcher, and a watcher counts
//! only its own process's windows, so a second desktop beside the first
//! opens a native window for every record the first already shows, attached
//! to the same sessions. A GUI launch therefore claims the handoff endpoint
//! (the flock beside the per-user socket, the pipe's first instance on
//! Windows) before it touches anything, and keeps the claim until its
//! listener serves it. A launch that finds the endpoint held asks the desktop
//! holding it to come forward over the handoff socket and exits without
//! opening a window, starting a watcher or reading any state. When that
//! desktop does not answer, or is still shutting down past the wait, the
//! launch says so in a native message before it exits, unless its stderr is
//! a terminal that has the log line. The CLI
//! personalities and the default-terminal launch never reach this: they are
//! dispatched before it in `main`.
//!
//! The endpoint is per user (the runtime directory on unix, the user name in
//! the pipe name on Windows), not per `CHAN_HOME`.

use std::collections::HashSet;
use std::io::IsTerminal;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use chan_server::handoff::{
    self, ActivateReply, ClaimError, EndpointClaim, ListenerHandle, ListenerStartError, Response,
};
use tauri::{AppHandle, Manager, Runtime};

use crate::{serve, window_watcher, AppState};

/// How long a launch that found the endpoint held keeps asking the holder to
/// come forward. The holder may still be booting: it claims the endpoint
/// first thing and binds its listener only once its embedded server is up.
const ASK_BOUND: Duration = Duration::from_secs(5);

/// How long a launch waits for the endpoint after a refusal that does not
/// say the holder is shutting down. An older desktop relaunching after an
/// update refuses that way, answering the request as unknown, and holds the
/// endpoint until it exits.
const RELEASE_GRACE: Duration = Duration::from_secs(5);

/// How long a launch waits for the endpoint after the holder said it is
/// shutting down. That desktop holds the endpoint until its process exits,
/// which follows its drain: every embedded tenant at once, each given 5 s
/// for its tasks (`TENANT_TASK_SHUTDOWN_GRACE`) and then 5 s for its
/// workspace to be let go (`WORKSPACE_SHUTDOWN_RELEASE_TIMEOUT`), both in
/// chan-library, and then the extension runtime, 3 s for a supervisor
/// (`SUPERVISOR_SHUTDOWN_GRACE` in chan-server). That is 13 s, and the rest
/// is for the exit itself. The drain has no hard bound, since a task that
/// outlives its abort holds it and each further stuck supervisor adds 3 s,
/// so the launch does not wait it out: past this it exits 1.
const DRAIN_GRACE: Duration = Duration::from_secs(20);

/// What a desktop that is shutting down answers an `Activate` with. The
/// launch reads it back ([`refusal`]) to tell that desktop, which is about
/// to free the endpoint, from one that refuses and stays, so the text is
/// exchanged between releases: a desktop that words it differently is read
/// as one that stays.
const SHUTTING_DOWN: &str = "chan-desktop is shutting down";

/// The pause between two looks at the endpoint while waiting.
const POLL: Duration = Duration::from_millis(100);

/// The first look at the endpoint.
#[derive(Debug)]
pub(crate) enum Lock<C> {
    /// This process claimed it.
    Taken(C),
    /// A live process holds it.
    Held,
    /// The claim could not be tried; the reason is logged.
    Unavailable(String),
}

/// What asking the holder to come forward came to.
#[derive(Debug)]
pub(crate) enum Answer<C> {
    /// It is coming forward.
    CameForward { version: String },
    /// It answered that it is shutting down.
    ShuttingDown,
    /// It answered without coming forward, and not that it is shutting
    /// down; `reply` is its answer.
    Refused { reply: String },
    /// Nothing answered, and meanwhile the endpoint came free and this
    /// process claimed it: the holder had exited.
    Released(C),
    /// Nothing answered within the bound and the endpoint stayed held.
    Silent,
}

/// What a GUI launch does.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Startup<C> {
    /// Boot, serving the claimed endpoint.
    Run(C),
    /// Boot without the handoff listener, as when the claim cannot be tried.
    RunWithoutListener { why: String },
    /// Another desktop came forward; exit 0.
    HandedOver { version: String },
    /// Another desktop holds the endpoint and refused to come forward, an
    /// older one refusing the request as unknown; exit 0, since a desktop is
    /// running and this one would only duplicate its windows.
    Refused { reply: String },
    /// Another desktop said it was shutting down and still holds the
    /// endpoint past [`DRAIN_GRACE`]; exit 1, since no desktop may be left
    /// once it goes and this launch started none.
    StillShuttingDown,
    /// Another desktop holds the endpoint and does not answer; exit 1.
    Unanswered,
}

/// Which wait for the endpoint follows a refusal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Wait {
    /// The holder said it is shutting down: through its drain and exit
    /// ([`DRAIN_GRACE`]).
    Drain,
    /// Any other refusal ([`RELEASE_GRACE`]).
    Release,
}

impl<C> Startup<C> {
    /// `None` boots; `Some(code)` ends the process with `code`.
    pub(crate) fn exit_code(&self) -> Option<i32> {
        match self {
            Startup::Run(_) | Startup::RunWithoutListener { .. } => None,
            Startup::HandedOver { .. } | Startup::Refused { .. } => Some(0),
            Startup::StillShuttingDown | Startup::Unanswered => Some(1),
        }
    }
}

/// The start-up decision. `ask` runs only when the endpoint is held, and
/// `wait` only when the holder refused: a holder on its way out refuses, so
/// the launch exits only if the endpoint stays held. A holder that said it
/// is shutting down is waited for through its drain, and a launch that
/// outwaits it exits non-zero: exiting 0 there would report a running
/// desktop while the only one is on its way out.
pub(crate) fn decide<C>(
    lock: Lock<C>,
    ask: impl FnOnce() -> Answer<C>,
    wait: impl FnOnce(Wait) -> Option<C>,
) -> Startup<C> {
    match lock {
        Lock::Taken(claim) => Startup::Run(claim),
        Lock::Unavailable(why) => Startup::RunWithoutListener { why },
        Lock::Held => match ask() {
            Answer::CameForward { version } => Startup::HandedOver { version },
            Answer::Released(claim) => Startup::Run(claim),
            Answer::Silent => Startup::Unanswered,
            Answer::ShuttingDown => match wait(Wait::Drain) {
                Some(claim) => Startup::Run(claim),
                None => Startup::StillShuttingDown,
            },
            Answer::Refused { reply } => match wait(Wait::Release) {
                Some(claim) => Startup::Run(claim),
                None => Startup::Refused { reply },
            },
        },
    }
}

/// Run the check for a GUI launch: the claimed endpoint for the listener, or
/// `None` to boot without one. A launch another desktop answers for ends the
/// process here.
pub(crate) fn guard() -> Option<EndpointClaim> {
    let startup = match handoff::ensure_well_known_socket_path() {
        Some(path) => check_at(&path, ASK_BOUND, RELEASE_GRACE, DRAIN_GRACE),
        None => Startup::RunWithoutListener {
            why: "no owner-controlled runtime directory for the handoff endpoint".into(),
        },
    };
    report(&startup, |notice| {
        tell_user(notice, std::io::stderr().is_terminal(), show_message)
    });
    if let Some(code) = startup.exit_code() {
        std::process::exit(code);
    }
    match startup {
        Startup::Run(claim) => Some(claim),
        _ => None,
    }
}

/// Log what the launch came to. The two exits that leave no desktop
/// answering for the launch also go to `tell_user`: started from the Dock,
/// the Start menu or a launcher, the log line goes nowhere the user reads,
/// and without the message nothing appears and nothing says why.
fn report<C>(startup: &Startup<C>, tell_user: impl FnOnce(Notice)) {
    match startup {
        Startup::Run(_) => {}
        Startup::RunWithoutListener { why } => {
            tracing::warn!(error = %why, "CLI-to-desktop handoff listener disabled")
        }
        Startup::HandedOver { version } => tracing::info!(
            running = %version,
            "another chan-desktop is running and came forward; this launch exits"
        ),
        Startup::Refused { reply } => tracing::warn!(
            %reply,
            "another chan-desktop holds the handoff endpoint and did not come forward \
             (one older than this launch refuses the request as unknown); this launch exits"
        ),
        Startup::StillShuttingDown => {
            tracing::error!(
                waited = ?DRAIN_GRACE,
                "another chan-desktop said it is shutting down and still holds the handoff \
                 endpoint; this launch exits rather than start a second desktop"
            );
            tell_user(Notice::StillShuttingDown);
        }
        Startup::Unanswered => {
            tracing::error!(
                waited = ?ASK_BOUND,
                "another chan-desktop holds the handoff endpoint but does not answer; this \
                 launch exits rather than start a second desktop"
            );
            tell_user(Notice::NotAnswering);
        }
    }
}

/// What a launch that exits with no desktop answering for it tells the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Notice {
    /// [`Startup::Unanswered`].
    NotAnswering,
    /// [`Startup::StillShuttingDown`].
    StillShuttingDown,
}

impl Notice {
    /// The message's heading, which is also its window title.
    fn title(self) -> &'static str {
        match self {
            Notice::NotAnswering => "Chan is not responding",
            Notice::StillShuttingDown => "Chan is still shutting down",
        }
    }

    fn text(self) -> &'static str {
        match self {
            Notice::NotAnswering => {
                "A running copy of Chan is not answering, so this one did not open. Quit \
                 that copy, or end its process if it does not quit, then start Chan again."
            }
            Notice::StillShuttingDown => {
                "A running copy of Chan is still shutting down, so this one did not open. \
                 Wait for it to exit, or end its process if it does not, then start Chan \
                 again."
            }
        }
    }
}

/// The hook the exiting arms call. A launch whose stderr is a terminal has
/// the log line in front of whoever started it, so it shows nothing more: a
/// modal there would hold that shell until dismissed, and over SSH there is
/// no display to show it on. The Dock, the Start menu and a launcher leave
/// stderr on `/dev/null`, a pipe or a file, and get the message.
fn tell_user(notice: Notice, stderr_is_terminal: bool, show: impl FnOnce(Notice)) {
    if !stderr_is_terminal {
        show(notice);
    }
}

/// Show `notice` as a native message and return once it is dismissed. The
/// guard runs before the Tauri app is built, so the dialog plugin, which
/// needs an app handle, is out of reach; rfd is the library under it, at the
/// version it links. On macOS rfd shows a message that needs no window of
/// the app's as a user notification alert, and on Windows a task dialog.
#[cfg(any(target_os = "macos", windows))]
fn show_message(notice: Notice) {
    rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Warning)
        .set_title(notice.title())
        .set_description(notice.text())
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
}

/// Show `notice` as a GTK message and return once it is dismissed. Not
/// through rfd: its blocking GTK dialog waits for a GTK thread that ends at
/// once when GTK cannot open a display, so it would never return and the
/// launch would hang instead of exiting. `gtk::init` reports that, and the
/// launch exits with the log line alone. The process exits right after, which
/// takes the dialog's window with it.
#[cfg(any(target_os = "linux", target_os = "freebsd"))]
fn show_message(notice: Notice) {
    use gtk::prelude::*;
    if let Err(error) = gtk::init() {
        tracing::warn!(%error, "no display to show the message on");
        return;
    }
    let dialog = gtk::MessageDialog::new(
        None::<&gtk::Window>,
        gtk::DialogFlags::MODAL,
        gtk::MessageType::Warning,
        gtk::ButtonsType::Ok,
        notice.title(),
    );
    dialog.set_title(notice.title());
    dialog.set_secondary_text(Some(notice.text()));
    dialog.run();
}

#[cfg(not(any(
    target_os = "macos",
    windows,
    target_os = "linux",
    target_os = "freebsd"
)))]
fn show_message(_: Notice) {}

fn check_at(
    path: &Path,
    ask_bound: Duration,
    release_grace: Duration,
    drain_grace: Duration,
) -> Startup<EndpointClaim> {
    decide(
        claim(path),
        || ask(path, ask_bound),
        |wait| {
            let grace = match wait {
                Wait::Drain => drain_grace,
                Wait::Release => release_grace,
            };
            wait_for_release(path, grace)
        },
    )
}

fn claim(path: &Path) -> Lock<EndpointClaim> {
    // A Windows claim creates a pipe instance, which registers with the
    // runtime's reactor.
    match tauri::async_runtime::block_on(async { handoff::claim_endpoint_at(path) }) {
        Ok(claim) => Lock::Taken(claim),
        Err(ClaimError::Held(_)) => Lock::Held,
        Err(ClaimError::Unavailable(error)) => Lock::Unavailable(error.to_string()),
    }
}

fn ask(path: &Path, bound: Duration) -> Answer<EndpointClaim> {
    let deadline = Instant::now() + bound;
    loop {
        let budget = deadline.saturating_duration_since(Instant::now());
        if budget.is_zero() {
            return Answer::Silent;
        }
        match tauri::async_runtime::block_on(handoff::try_activate_at(path, budget)) {
            ActivateReply::Activated { desktop_version } => {
                return Answer::CameForward {
                    version: desktop_version,
                }
            }
            ActivateReply::Refused { reply } => return refusal(reply),
            ActivateReply::NoReply => {}
        }
        // Nothing answers a holder that is still booting, or one that has
        // exited, which frees the endpoint.
        if let Lock::Taken(claim) = claim(path) {
            return Answer::Released(claim);
        }
        std::thread::sleep(POLL);
    }
}

/// Read a holder's refusal: the answer of a desktop that is shutting down
/// ([`shutting_down`]), or any other.
fn refusal<C>(reply: String) -> Answer<C> {
    match serde_json::from_str::<Response>(&reply) {
        Ok(Response::Error { message }) if message == SHUTTING_DOWN => Answer::ShuttingDown,
        _ => Answer::Refused { reply },
    }
}

/// The refusal of a desktop that is shutting down.
fn shutting_down() -> Response {
    Response::Error {
        message: SHUTTING_DOWN.into(),
    }
}

fn wait_for_release(path: &Path, grace: Duration) -> Option<EndpointClaim> {
    let deadline = Instant::now() + grace;
    loop {
        if let Lock::Taken(claim) = claim(path) {
            return Some(claim);
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(POLL);
    }
}

/// Keep what the listener's start left this desktop holding of the endpoint,
/// for the process's life: the listener, or the claim of a listener that
/// failed to start. Without that claim the desktop would go on with the
/// endpoint free, and a second launch would claim it and boot beside this
/// one; with it the launch meets a held endpoint that does not answer, and
/// exits.
pub(crate) fn hold_endpoint(state: &AppState, started: Result<ListenerHandle, ListenerStartError>) {
    match started {
        Ok(listener) => {
            *state
                .handoff_listener
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = Some(listener);
        }
        Err(failed) => {
            tracing::warn!(
                error = %failed.error,
                "CLI-to-desktop handoff listener disabled; the endpoint stays claimed, so a \
                 second launch exits instead of running beside this desktop"
            );
            *state
                .unserved_endpoint
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = Some(failed.claim);
        }
    }
}

/// Give up the endpoint before this process relaunches itself, so the new
/// process claims it at once instead of meeting it held by a desktop on its
/// way out. Only the platforms that relaunch themselves call it.
#[cfg(any(target_os = "macos", target_os = "linux", windows))]
pub(crate) fn release_endpoint(state: &AppState) {
    drop(
        state
            .handoff_listener
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take(),
    );
    drop(
        state
            .unserved_endpoint
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take(),
    );
}

/// Remember the workspace window that took focus last: the window a second
/// launch brings forward.
pub(crate) fn note_focused(app: &AppHandle, label: &str) {
    let state = app.state::<Arc<AppState>>();
    *state
        .last_focused_window
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(label.to_string());
}

/// Marks the boot settled when dropped. The boot's restore task holds one
/// from its first statement, so the mark is set however the task ends, by a
/// panic too: a boot left pending would have every later `Activate` open
/// nothing.
pub(crate) struct BootSettled(Arc<AppState>);

impl BootSettled {
    pub(crate) fn when_dropped(state: &Arc<AppState>) -> Self {
        Self(Arc::clone(state))
    }
}

impl Drop for BootSettled {
    fn drop(&mut self) {
        self.0.boot_settled.store(true, Ordering::SeqCst);
    }
}

/// Answer a second launch's `Activate` as a Dock click does: raise the last
/// focused window that still shows, or open a standalone terminal when no
/// window shows and none is on its way. A desktop shutting down refuses, so
/// the launch waits for the endpoint instead of exiting beside a desktop
/// about to go.
pub(crate) fn come_forward(app: &AppHandle, state: &AppState) -> Response {
    if state.shutdown_started.load(Ordering::SeqCst) {
        return shutting_down();
    }
    // A hidden app's windows read as not visible; a Dock click unhides it
    // before anything else.
    #[cfg(target_os = "macos")]
    if let Err(e) = app.show() {
        tracing::warn!(error = %e, "unhiding the app to come forward failed");
    }
    match forward_for(app, state) {
        Forward::Raise(label) => {
            if let Some(window) = app.get_webview_window(&label) {
                let _ = window.unminimize();
                if let Err(e) = window.show() {
                    tracing::warn!(label = %window.label(), error = %e, "showing the window to come forward failed");
                }
                if let Err(e) = window.set_focus() {
                    tracing::warn!(label = %window.label(), error = %e, "focusing the window to come forward failed");
                }
            }
        }
        Forward::OpenTerminal => crate::spawn_terminal_window(app),
        Forward::WindowOnItsWay => {
            tracing::info!("asked to come forward while a window is on its way; opening none")
        }
    }
    Response::Activated {
        desktop_version: handoff::CHAN_VERSION.into(),
    }
}

/// Answer a reopen that found no visible window, which on macOS is a Dock
/// click or a second `open` of the running app: open a standalone terminal,
/// the window the launcher is toggled in, unless a window is on its way. A
/// reopen during the boot would otherwise add one more saved window beside
/// those the boot is about to open, as a second launch's `Activate` would.
/// Only macOS delivers the event, and its arm of the run loop is built on
/// macOS alone, so that arm makes this one call and the rule is built and
/// tested on every target.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn reopen_without_a_window(app: &AppHandle) {
    let state = app.state::<Arc<AppState>>();
    if reopen_for(app, &state) == Forward::OpenTerminal {
        crate::spawn_terminal_window(app);
    } else {
        tracing::info!("reopened while a window is on its way; opening none");
    }
}

/// The choice for a reopen with no visible window: [`forward_choice`] with
/// no window shown, so a terminal, or nothing while a window is on its way.
fn reopen_for<R: Runtime>(app: &AppHandle<R>, state: &AppState) -> Forward {
    forward_choice(None, &[], local_window_on_its_way(app, state))
}

/// What coming forward does.
#[derive(Debug, PartialEq, Eq)]
enum Forward {
    /// Raise this window.
    Raise(String),
    /// No window shows and none is on its way: open a standalone terminal.
    OpenTerminal,
    /// No window shows yet and one is on its way. A terminal opened now
    /// would be one more saved window beside those about to show.
    WindowOnItsWay,
}

/// Read the desktop's windows and choose ([`forward_choice`]).
///
/// The caller is the handoff listener's handler, on a runtime worker, and
/// each window's visibility is a round trip to the main thread that blocks
/// the worker until it is answered. That keeps the reads in step with the
/// main thread: one queues behind a window the main thread is building, so
/// that window is read once its build has run. A main thread that is stuck
/// answers none, the worker stays parked, and the launch, getting no reply,
/// exits as beside a desktop that does not answer.
fn forward_for<R: Runtime>(app: &AppHandle<R>, state: &AppState) -> Forward {
    // Read before the windows. A window the watcher builds between the two
    // reads was on its way at the first, so no terminal opens beside it; in
    // the other order it could be missing from the windows and then no
    // longer on its way.
    let on_its_way = local_window_on_its_way(app, state);
    let windows = app.webview_windows();
    let shown: Vec<String> = windows
        .iter()
        .filter(|(label, window)| {
            serve::is_workspace_webview_label(label)
                && (window.is_visible().unwrap_or(false) || window.is_minimized().unwrap_or(false))
        })
        .map(|(label, _)| label.clone())
        .collect();
    let last = state
        .last_focused_window
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    forward_choice(last.as_deref(), &shown, on_its_way)
}

/// Whether a window of this desktop's own library is about to show: the boot
/// has not settled, so its restored windows or its terminal are still to
/// come, or the library holds a shown record whose native window the watcher
/// has not built yet ([`window_watcher::awaiting_native_window`]). Devserver
/// records are left out, where `window_on_its_way` in `main.rs` counts them
/// for an exit it rechecks: a closed devserver window stays in its feed until
/// the devserver has deleted it, nothing opens for it, and an `Activate`
/// answered with no window in that time has no recheck to open one.
fn local_window_on_its_way<R: Runtime>(app: &AppHandle<R>, state: &AppState) -> bool {
    if !state.boot_settled.load(Ordering::SeqCst) {
        return true;
    }
    let Some(embedded) = state.embedded() else {
        return false;
    };
    let open: HashSet<String> = app.webview_windows().into_keys().collect();
    let buried: HashSet<String> = state
        .buried_snapshot()
        .into_iter()
        .map(|(label, _)| label)
        .collect();
    window_watcher::awaiting_native_window(&embedded.local_window_records(), &open, &buried)
}

/// The choice as a function of what was read: a window that shows is raised
/// whatever else is due, and a terminal opens only when no window shows and
/// none is on its way.
fn forward_choice(
    last_focused: Option<&str>,
    shown: &[String],
    window_on_its_way: bool,
) -> Forward {
    match forward_target(last_focused, shown) {
        Some(label) => Forward::Raise(label),
        None if window_on_its_way => Forward::WindowOnItsWay,
        None => Forward::OpenTerminal,
    }
}

/// The window to raise: the last focused one while it still shows, else the
/// first shown by label, so the choice does not depend on map order. `None`
/// when no window shows.
fn forward_target(last_focused: Option<&str>, shown: &[String]) -> Option<String> {
    last_focused
        .filter(|last| shown.iter().any(|label| label == last))
        .map(str::to_string)
        .or_else(|| shown.iter().min().cloned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn never_asked() -> Answer<&'static str> {
        panic!("the holder must not be asked")
    }

    fn never_waited(_: Wait) -> Option<&'static str> {
        panic!("the endpoint must not be waited for")
    }

    #[test]
    fn a_free_endpoint_boots_serving_it() {
        let startup = decide(Lock::Taken("claim"), never_asked, never_waited);
        assert_eq!(startup, Startup::Run("claim"));
        assert_eq!(startup.exit_code(), None);
    }

    #[test]
    fn a_held_endpoint_whose_desktop_comes_forward_exits_zero() {
        let startup = decide(
            Lock::Held,
            || Answer::CameForward {
                version: "0.127.0".into(),
            },
            never_waited,
        );
        assert_eq!(
            startup,
            Startup::HandedOver {
                version: "0.127.0".into()
            }
        );
        assert_eq!(startup.exit_code(), Some(0));
    }

    /// An older desktop answers `Activate` as an unknown request type. It is
    /// still a running desktop, so the launch exits once the endpoint stays
    /// held through the grace.
    #[test]
    fn a_held_endpoint_whose_desktop_refuses_the_request_as_unknown_exits() {
        let reply =
            r#"{"status":"error","message":"invalid handoff request: unknown variant `activate`"}"#;
        let startup = decide(
            Lock::<&str>::Held,
            || Answer::Refused {
                reply: reply.into(),
            },
            |wait| {
                assert_eq!(wait, Wait::Release);
                None
            },
        );
        assert_eq!(
            startup,
            Startup::Refused {
                reply: reply.into()
            }
        );
        assert_eq!(startup.exit_code(), Some(0));
    }

    /// A relaunch right after Quit: the old desktop says it is shutting down
    /// and holds the endpoint through its drain, so the launch waits for the
    /// drain, not the short grace, and boots once the endpoint is free.
    #[test]
    fn a_holder_shutting_down_is_waited_for_through_its_drain() {
        let startup = decide(
            Lock::Held,
            || Answer::ShuttingDown,
            |wait| {
                assert_eq!(
                    wait,
                    Wait::Drain,
                    "a shutting-down holder is on its way out"
                );
                Some("claim")
            },
        );
        assert_eq!(startup, Startup::Run("claim"));
    }

    /// A holder that said it is shutting down and still holds the endpoint
    /// after its drain's bound: no desktop comes of this launch and the old
    /// one is going, so the exit is not the 0 of a launch that handed over.
    #[test]
    fn a_holder_still_shutting_down_after_its_drain_exits_non_zero() {
        let startup = decide(Lock::<&str>::Held, || Answer::ShuttingDown, |_| None);
        assert_eq!(startup, Startup::StillShuttingDown);
        assert_eq!(startup.exit_code(), Some(1));
    }

    /// The launch tells a desktop that is shutting down by the refusal that
    /// desktop sends, and reads every other refusal, an older desktop's
    /// unknown request type among them, as a desktop that stays.
    #[test]
    fn the_refusal_of_a_desktop_shutting_down_is_read_back_as_shutting_down() {
        let sent = serde_json::to_string(&shutting_down()).unwrap();
        assert!(
            matches!(refusal::<()>(sent.clone()), Answer::ShuttingDown),
            "{sent}"
        );
        for other in [
            r#"{"status":"error","message":"invalid handoff request: unknown variant `activate`"}"#,
            r#"{"status":"error","message":"chan-desktop is shutting down soon"}"#,
            "not json",
        ] {
            assert!(
                matches!(refusal::<()>(other.into()), Answer::Refused { reply } if reply == other),
                "{other}"
            );
        }
        // The answer `come_forward` gives once a shutdown has started.
        let (production, _) = include_str!("single_instance.rs")
            .split_once("\n#[cfg(test)]\nmod tests {")
            .expect("the test module separates the production code");
        let (_, come_forward) = production
            .split_once("\npub(crate) fn come_forward(")
            .expect("come_forward exists");
        assert!(come_forward.contains(
            "if state.shutdown_started.load(Ordering::SeqCst) {\n        return shutting_down();"
        ));
    }

    /// The wait for a desktop that is shutting down outlasts the bounds its
    /// drain runs under, read from where they are defined: a tenant's task
    /// grace and release budget in chan-library, an extension supervisor's
    /// grace in chan-server. A bound raised there fails here until
    /// `DRAIN_GRACE` covers it again.
    #[test]
    fn the_wait_for_a_desktop_shutting_down_covers_its_drain() {
        fn secs(source: &str, name: &str) -> u64 {
            let declaration = format!("const {name}: Duration = Duration::from_secs(");
            assert_eq!(
                source.matches(&declaration).count(),
                1,
                "{name} is declared once, in whole seconds"
            );
            let (_, rest) = source.split_once(&declaration).unwrap();
            let (value, _) = rest.split_once(')').unwrap();
            value.parse().unwrap_or_else(|_| panic!("{name} = {value}"))
        }
        let task_grace = secs(
            include_str!("../../../crates/chan-library/src/tenant.rs"),
            "TENANT_TASK_SHUTDOWN_GRACE",
        );
        let release_budget = secs(
            include_str!("../../../crates/chan-library/src/host.rs"),
            "WORKSPACE_SHUTDOWN_RELEASE_TIMEOUT",
        );
        let supervisor_grace = secs(
            include_str!("../../../crates/chan-server/src/extensions.rs"),
            "SUPERVISOR_SHUTDOWN_GRACE",
        );
        let drain = Duration::from_secs(task_grace + release_budget + supervisor_grace);
        assert_eq!(
            drain,
            Duration::from_secs(13),
            "the bound DRAIN_GRACE states"
        );
        assert!(
            DRAIN_GRACE > drain,
            "a launch must wait longer than a drain may take ({drain:?}), with time for the exit"
        );
    }

    #[test]
    fn a_held_endpoint_whose_desktop_does_not_answer_exits_non_zero() {
        let startup = decide(Lock::Held, || Answer::Silent, never_waited);
        assert_eq!(startup, Startup::Unanswered);
        assert_eq!(startup.exit_code(), Some(1));
    }

    /// The two exits that leave no desktop answering for the launch, and only
    /// they, tell the user: every other outcome boots, or exits beside a
    /// desktop that came forward or is running.
    #[test]
    fn only_the_exits_with_no_desktop_answering_tell_the_user() {
        let outcomes: [Startup<&str>; 6] = [
            Startup::Run("claim"),
            Startup::RunWithoutListener {
                why: "no runtime directory".into(),
            },
            Startup::HandedOver {
                version: "0.127.0".into(),
            },
            Startup::Refused {
                reply: "unknown variant".into(),
            },
            Startup::StillShuttingDown,
            Startup::Unanswered,
        ];
        for startup in outcomes {
            // No wildcard: a new outcome is added here before it builds.
            let expected = match &startup {
                Startup::Run(_)
                | Startup::RunWithoutListener { .. }
                | Startup::HandedOver { .. }
                | Startup::Refused { .. } => None,
                Startup::StillShuttingDown => Some(Notice::StillShuttingDown),
                Startup::Unanswered => Some(Notice::NotAnswering),
            };
            let mut told = Vec::new();
            report(&startup, |notice| told.push(notice));
            assert_eq!(told, Vec::from_iter(expected), "{startup:?}");
            assert_eq!(
                expected.is_some(),
                startup.exit_code() == Some(1),
                "the user is told exactly when the launch exits 1: {startup:?}"
            );
        }
    }

    /// The message names Chan, says what became of the running copy, and
    /// says what to do.
    #[test]
    fn the_message_says_what_happened_and_what_to_do() {
        for (notice, happened) in [
            (Notice::NotAnswering, "is not answering"),
            (Notice::StillShuttingDown, "is still shutting down"),
        ] {
            assert!(notice.title().starts_with("Chan "), "{notice:?}");
            let text = notice.text();
            assert!(
                text.contains(&format!("A running copy of Chan {happened}")),
                "{text}"
            );
            assert!(text.contains("end its process"), "{text}");
            assert!(text.ends_with("then start Chan again."), "{text}");
        }
    }

    /// A launch from a terminal has the log line there and shows nothing
    /// more; any other launch shows the message.
    #[test]
    fn a_launch_from_a_terminal_keeps_the_line_and_shows_no_message() {
        tell_user(Notice::NotAnswering, true, |notice| {
            panic!("a launch from a terminal must show no message: {notice:?}")
        });
        let mut shown = None;
        tell_user(Notice::NotAnswering, false, |notice| shown = Some(notice));
        assert_eq!(shown, Some(Notice::NotAnswering));
    }

    /// The guard reports before it ends the process, since the message is
    /// shown while `report` runs and an exit first would show none; and the
    /// hook it passes reads the launch's own stderr and shows the message.
    #[test]
    fn the_guard_reports_through_the_hook_before_it_exits() {
        let (production, _) = include_str!("single_instance.rs")
            .split_once("\n#[cfg(test)]\nmod tests {")
            .expect("the test module separates the production code");
        let (_, guard) = production
            .split_once("\npub(crate) fn guard() -> Option<EndpointClaim> {")
            .expect("guard exists");
        let (guard, _) = guard.split_once("\n}\n").expect("guard ends");
        let reported = guard
            .find("report(&startup, |notice| {")
            .expect("the guard reports the outcome");
        let exited = guard
            .find("std::process::exit(code)")
            .expect("the guard ends the process for an exit");
        assert!(reported < exited, "the guard must report before it exits");
        assert!(
            guard.contains("tell_user(notice, std::io::stderr().is_terminal(), show_message)"),
            "{guard}"
        );
    }

    #[test]
    fn an_endpoint_that_cannot_be_claimed_boots_without_the_listener() {
        let startup = decide(
            Lock::Unavailable("No such file or directory".into()),
            never_asked,
            never_waited,
        );
        assert_eq!(
            startup,
            Startup::RunWithoutListener {
                why: "No such file or directory".into()
            }
        );
        assert_eq!(startup.exit_code(), None);
    }

    /// A relaunch: the old desktop refuses while it exits, then frees the
    /// endpoint, and the new process boots instead of leaving no desktop.
    #[test]
    fn a_holder_that_refuses_and_then_exits_hands_the_endpoint_over() {
        let startup = decide(
            Lock::Held,
            || Answer::Refused {
                reply: "shutting down".into(),
            },
            |_| Some("claim"),
        );
        assert_eq!(startup, Startup::Run("claim"));
    }

    #[test]
    fn a_holder_that_exits_while_asked_hands_the_endpoint_over() {
        let startup = decide(Lock::Held, || Answer::Released("claim"), never_waited);
        assert_eq!(startup, Startup::Run("claim"));
    }

    #[test]
    fn come_forward_raises_the_last_focused_window_that_still_shows() {
        let shown = vec!["local::b".to_string(), "local::a".to_string()];
        assert_eq!(
            forward_target(Some("local::b"), &shown).as_deref(),
            Some("local::b")
        );
        // A last focused window that no longer shows falls back to a stable
        // pick, and no window at all opens a terminal instead.
        assert_eq!(
            forward_target(Some("local::gone"), &shown).as_deref(),
            Some("local::a")
        );
        assert_eq!(forward_target(None, &shown).as_deref(), Some("local::a"));
        assert_eq!(forward_target(Some("local::a"), &[]), None);
    }

    /// A desktop still booting shows no window yet and is about to open its
    /// own: a terminal opened for the second launch would be one more saved
    /// window beside them.
    #[test]
    fn come_forward_opens_nothing_while_a_window_is_on_its_way_and_none_shows() {
        assert_eq!(forward_choice(None, &[], true), Forward::WindowOnItsWay);
        assert_eq!(
            forward_choice(Some("local::gone"), &[], true),
            Forward::WindowOnItsWay
        );
    }

    #[test]
    fn come_forward_opens_a_terminal_when_no_window_shows_and_none_is_on_its_way() {
        assert_eq!(forward_choice(None, &[], false), Forward::OpenTerminal);
        assert_eq!(
            forward_choice(Some("local::gone"), &[], false),
            Forward::OpenTerminal
        );
    }

    #[test]
    fn come_forward_raises_a_shown_window_whatever_is_on_its_way() {
        let shown = vec!["local::b".to_string(), "local::a".to_string()];
        for on_its_way in [false, true] {
            assert_eq!(
                forward_choice(Some("local::b"), &shown, on_its_way),
                Forward::Raise("local::b".into())
            );
            assert_eq!(
                forward_choice(Some("local::gone"), &shown, on_its_way),
                Forward::Raise("local::a".into())
            );
            assert_eq!(
                forward_choice(None, &shown, on_its_way),
                Forward::Raise("local::a".into())
            );
        }
    }

    /// The restore task's guard marks the boot settled when the task ends,
    /// and when it panics instead: the unwind drops the guard.
    #[test]
    fn the_boot_settles_when_its_restore_task_ends_or_panics() {
        for panics in [false, true] {
            let config = tempfile::tempdir().unwrap();
            let store = Arc::new(std::sync::Mutex::new(crate::config::ConfigStore::at_path(
                config.path().join("config.json"),
            )));
            let state = Arc::new(AppState::with_store(store));
            assert!(
                !state.boot_settled.load(Ordering::SeqCst),
                "a desktop starts with its boot pending"
            );
            let guard = BootSettled::when_dropped(&state);
            assert!(
                !state.boot_settled.load(Ordering::SeqCst),
                "the boot stays pending while the restore task runs"
            );
            let task = std::thread::spawn(move || {
                let _boot_settled = guard;
                assert!(!panics, "the restore task panics");
            });
            assert_eq!(task.join().is_err(), panics);
            assert!(
                state.boot_settled.load(Ordering::SeqCst),
                "the boot is settled once the restore task is over (panicked: {panics})"
            );
        }
    }

    /// The reads behind the choice, against a desktop with a window registry.
    /// While the boot is pending a second launch opens nothing. A boot that
    /// ended with no window leaves the terminal to the launch. A minted
    /// terminal's record is on its way until the watcher builds its native
    /// window, which is then the window raised.
    #[test]
    fn a_second_launch_opens_nothing_while_the_boot_or_a_window_is_on_its_way() {
        if !crate::embedded::in_own_chan_home(
            "single_instance::tests::a_second_launch_opens_nothing_while_the_boot_or_a_window_is_on_its_way",
        ) {
            return;
        }
        let desktop = crate::tests::handoff_row::Desktop::new();
        let app = desktop.app.handle();
        assert_eq!(
            forward_for(app, &desktop.state),
            Forward::WindowOnItsWay,
            "a pending boot opens its own windows"
        );
        drop(BootSettled::when_dropped(&desktop.state));
        assert_eq!(
            forward_for(app, &desktop.state),
            Forward::OpenTerminal,
            "a settled boot with no window and none on its way"
        );
        desktop
            .runtime
            .block_on(crate::ensure_boot_window(Arc::clone(&desktop.state)))
            .expect("the boot window rule mints a terminal");
        let records = desktop.embedded().local_window_records();
        assert_eq!(records.len(), 1, "the boot window rule minted one terminal");
        assert_eq!(
            forward_for(app, &desktop.state),
            Forward::WindowOnItsWay,
            "the terminal has a record and no native window yet"
        );
        let label = window_watcher::native_label(&records[0]);
        tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::App("index.html".into()))
            .build()
            .expect("mock webview window");
        assert_eq!(forward_for(app, &desktop.state), Forward::Raise(label));
    }

    /// A reopen with no visible window, on macOS a Dock click or a second
    /// `open` of the running app. Nothing opens while the boot is pending or
    /// a minted window has no native window yet, and a settled desktop with
    /// no window on its way opens the terminal.
    #[test]
    fn a_reopen_opens_nothing_while_the_boot_or_a_window_is_on_its_way() {
        if !crate::embedded::in_own_chan_home(
            "single_instance::tests::a_reopen_opens_nothing_while_the_boot_or_a_window_is_on_its_way",
        ) {
            return;
        }
        let desktop = crate::tests::handoff_row::Desktop::new();
        let app = desktop.app.handle();
        assert_eq!(
            reopen_for(app, &desktop.state),
            Forward::WindowOnItsWay,
            "a reopen during the boot opens nothing"
        );
        drop(BootSettled::when_dropped(&desktop.state));
        assert_eq!(
            reopen_for(app, &desktop.state),
            Forward::OpenTerminal,
            "a settled desktop with no window and none on its way opens the terminal"
        );
        desktop
            .runtime
            .block_on(crate::ensure_boot_window(Arc::clone(&desktop.state)))
            .expect("the boot window rule mints a terminal");
        assert_eq!(desktop.embedded().local_window_records().len(), 1);
        assert_eq!(
            reopen_for(app, &desktop.state),
            Forward::WindowOnItsWay,
            "a reopen while a minted window has no native window yet opens nothing"
        );
    }

    /// The I/O half against a real listener on a temporary endpoint: a launch
    /// that meets a desktop answering `Activate` hands over without booting.
    #[cfg(unix)]
    #[test]
    fn a_launch_beside_a_serving_desktop_hands_over() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("d.sock");
        let _listener = tauri::async_runtime::block_on(async {
            handoff::start_listener(sock.clone(), |req| async move {
                match req {
                    handoff::Request::Activate { .. } => Response::Activated {
                        desktop_version: "9.9.9".into(),
                    },
                    _ => Response::Error {
                        message: "unexpected request".into(),
                    },
                }
            })
        })
        .unwrap();
        let startup = check_at(
            &sock,
            Duration::from_secs(5),
            Duration::from_millis(200),
            Duration::from_millis(200),
        );
        assert_eq!(
            startup.exit_code(),
            Some(0),
            "the launch must exit: {startup:?}"
        );
        assert!(matches!(startup, Startup::HandedOver { version } if version == "9.9.9"));
    }

    /// A launch beside a desktop that answers it is shutting down and keeps
    /// the endpoint: with no time left to wait, the launch exits non-zero.
    #[cfg(unix)]
    #[test]
    fn a_launch_beside_a_desktop_still_shutting_down_exits_non_zero() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("d.sock");
        let _listener = tauri::async_runtime::block_on(async {
            handoff::start_listener(sock.clone(), |_req| async { shutting_down() })
        })
        .unwrap();
        let startup = check_at(
            &sock,
            Duration::from_secs(5),
            Duration::ZERO,
            Duration::ZERO,
        );
        assert!(matches!(startup, Startup::StillShuttingDown), "{startup:?}");
        assert_eq!(startup.exit_code(), Some(1));
    }

    /// A holder with no listener stays silent: the launch exits non-zero
    /// rather than boot beside it.
    #[cfg(unix)]
    #[test]
    fn a_launch_beside_a_silent_holder_exits_non_zero() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("d.sock");
        let _held = handoff::claim_endpoint_at(&sock).unwrap();
        let startup = check_at(
            &sock,
            Duration::from_millis(400),
            Duration::from_millis(200),
            Duration::from_millis(200),
        );
        assert!(matches!(startup, Startup::Unanswered), "{startup:?}");
        assert_eq!(startup.exit_code(), Some(1));
    }

    /// A desktop whose listener failed to start keeps the endpoint claimed:
    /// a second launch meets a holder that does not answer and exits
    /// non-zero instead of booting beside it, and a relaunch still gives the
    /// endpoint up. The bind fails on a socket name past the `sun_path`
    /// limit, which the lock file beside the socket does not have.
    #[cfg(unix)]
    #[test]
    fn a_desktop_whose_listener_failed_to_start_still_holds_the_endpoint() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join(format!("{}.sock", "s".repeat(150)));
        let config = tempfile::tempdir().unwrap();
        let store = Arc::new(std::sync::Mutex::new(crate::config::ConfigStore::at_path(
            config.path().join("config.json"),
        )));
        let state = AppState::with_store(store);
        let claimed = handoff::claim_endpoint_at(&sock).unwrap();
        let started = tauri::async_runtime::block_on(async {
            handoff::start_claimed_listener(claimed, |_req| async {
                Response::Error {
                    message: "unreachable".into(),
                }
            })
        });
        assert!(
            started.is_err(),
            "a socket path past the sun_path limit must not bind"
        );
        hold_endpoint(&state, started);
        let startup = check_at(
            &sock,
            Duration::from_millis(400),
            Duration::from_millis(200),
            Duration::from_millis(200),
        );
        assert!(
            matches!(startup, Startup::Unanswered),
            "a second launch must not boot beside a desktop whose listener failed to start: \
             {startup:?}"
        );
        assert_eq!(startup.exit_code(), Some(1));
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            release_endpoint(&state);
            assert!(
                matches!(claim(&sock), Lock::Taken(_)),
                "a relaunch gives the endpoint up"
            );
        }
    }

    /// A silent holder that exits while the launch asks frees the endpoint,
    /// and the launch boots on it.
    #[cfg(unix)]
    #[test]
    fn a_launch_claims_the_endpoint_a_silent_holder_frees() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("d.sock");
        let held = handoff::claim_endpoint_at(&sock).unwrap();
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            drop(held);
        });
        let startup = check_at(
            &sock,
            Duration::from_secs(5),
            Duration::from_millis(200),
            Duration::from_millis(200),
        );
        release.join().unwrap();
        assert!(matches!(startup, Startup::Run(_)), "{startup:?}");
    }
}
