//! One chan-desktop per handoff endpoint.
//!
//! Every desktop process runs its own window watcher, and a watcher counts
//! only its own process's windows, so a second desktop beside the first
//! opens a native window for every record the first already shows, attached
//! to the same sessions. A GUI launch therefore claims the handoff endpoint
//! (the flock beside the per-user socket; on Windows the first instance of a
//! claim pipe beside the endpoint's, whose own pipe is created only when the
//! listener starts) before it touches anything,
//! and keeps the claim until its listener serves it. A launch that finds the
//! endpoint held asks the desktop holding it to come forward over the
//! handoff socket, or, given paths, to open each of them in a standalone
//! window, and exits without opening a window, starting a watcher or
//! reading any state; on Windows a holder still booting, its claim held and
//! its pipe not created yet, is waited for first. When that desktop does not
//! answer, or is still shutting down past the wait, the launch says so in a
//! native message before it exits, unless its stderr is a terminal that has
//! the log line. The CLI personalities and the `chan-term` launch never reach
//! this: they are dispatched before it in `main`.
//!
//! The endpoint is per account (the runtime directory on unix, the account's
//! SID in both pipes' names on Windows), not per `CHAN_HOME`.

use std::collections::HashSet;
use std::io::IsTerminal;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use chan_server::handoff::{
    self, ActivateReply, ClaimError, EndpointClaim, ListenerHandle, ListenerStartError,
    OpenPathReply, Response,
};
use tauri::{AppHandle, Manager, Runtime};

use crate::{serve, window_watcher, AppState};

/// How long a launch that found the endpoint held keeps asking the holder to
/// come forward. On unix the holder may still be booting within this bound:
/// it claims the endpoint first thing and binds its listener only once its
/// embedded server is up. On Windows a holder still booting is waited for
/// first ([`BOOT_BOUND`]), and this bound starts once its listener is up.
const ASK_BOUND: Duration = Duration::from_secs(5);

/// How long a launch waits for a holder that is still booting before it
/// asks. On Windows the holder's claim is held from the start of its boot
/// and its pipe exists only once its listener starts, after the embedded
/// server is up: 0.4 to 2.2 s on the Windows test VM, and 7.1 s for the first
/// run of a fresh install. Thirty seconds covers a slow first start several
/// times over, and only a holder that never starts its listener (one whose
/// listener failed) makes a launch wait it out, which then asks and exits 1
/// as before.
const BOOT_BOUND: Duration = Duration::from_secs(30);

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
/// chan-library, and then the extension runtime, 3 s shared by all supervisors
/// (`SUPERVISOR_SHUTDOWN_GRACE` in chan-server). That is 13 s, and the rest
/// is for the exit itself. A task that never yields can still delay process
/// exit despite its abort, so the launch waits no longer than this bound.
/// Past it, the launch exits 1.
const DRAIN_GRACE: Duration = Duration::from_secs(20);

/// What a desktop that is shutting down answers an `Activate` with. The
/// launch reads it back ([`refusal`]) to tell that desktop, which is about
/// to free the endpoint, from one that refuses and stays, so the text is
/// exchanged between releases: a desktop that words it differently is read
/// as one that stays.
pub(crate) const SHUTTING_DOWN: &str = "chan-desktop is shutting down";

/// The pause between two looks at the endpoint while waiting.
const POLL: Duration = Duration::from_millis(100);

/// The bounds of the start-up check's waits, together so a test can shorten
/// them.
#[derive(Debug, Clone, Copy)]
struct Bounds {
    /// [`BOOT_BOUND`].
    boot: Duration,
    /// [`ASK_BOUND`].
    ask: Duration,
    /// [`RELEASE_GRACE`].
    release: Duration,
    /// [`DRAIN_GRACE`].
    drain: Duration,
}

const BOUNDS: Bounds = Bounds {
    boot: BOOT_BOUND,
    ask: ASK_BOUND,
    release: RELEASE_GRACE,
    drain: DRAIN_GRACE,
};

/// The first look at the endpoint.
#[derive(Debug)]
pub(crate) enum Lock<C> {
    /// This process claimed it.
    Taken(C),
    /// A live process of this account holds it.
    Held,
    /// The claim could not be tried, or a process of another account holds
    /// the endpoint's name where no launch of this account can reach it; the
    /// reason is logged.
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

/// Run the check for a GUI launch given `paths` (absolute, from
/// `launch_paths`): the claimed endpoint for the listener, or `None` to boot
/// without one. A launch another desktop answers for ends the process here,
/// its paths handed to that desktop; a launch that boots keeps its paths for
/// its own boot to open.
pub(crate) fn guard(paths: &[String]) -> Option<EndpointClaim> {
    let startup = match handoff::ensure_well_known_socket_path() {
        Some(path) => check_at(&path, BOUNDS, paths),
        None => Startup::RunWithoutListener {
            why: "no handoff endpoint for this account (no owner-controlled runtime directory \
                  on unix, no readable account SID on Windows)"
                .into(),
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

fn check_at(path: &Path, bounds: Bounds, paths: &[String]) -> Startup<EndpointClaim> {
    decide(
        claim(path),
        || ask(path, bounds, paths),
        |wait| {
            let grace = match wait {
                Wait::Drain => bounds.drain,
                Wait::Release => bounds.release,
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
        Err(ClaimError::Foreign(error)) => Lock::Unavailable(format!(
            "the handoff endpoint's claim is held by another account's process, which this \
             account cannot reach: {error}"
        )),
        Err(ClaimError::Unavailable(error)) => Lock::Unavailable(error.to_string()),
    }
}

fn ask(path: &Path, bounds: Bounds, paths: &[String]) -> Answer<EndpointClaim> {
    ask_with(
        bounds,
        || handoff::endpoint_is_booting_at(path),
        |budget| {
            forward_with(
                paths,
                budget,
                bounds.ask,
                |open, budget| {
                    tauri::async_runtime::block_on(handoff::try_open_path_at(path, open, budget))
                },
                |budget| tauri::async_runtime::block_on(handoff::try_activate_at(path, budget)),
            )
        },
        || match claim(path) {
            Lock::Taken(claim) => Some(claim),
            Lock::Held | Lock::Unavailable(_) => None,
        },
    )
}

/// Hand the launch to the holder: an `Activate` for a launch without paths,
/// an `OpenPath` for each path otherwise. A path the holder opened raised the
/// window it landed in, so the holder came forward.
///
/// The first path is sent within `budget`, the attempt `ask_with` repeats
/// until the holder answers or the ask's bound passes. Each later path gets
/// `each`, and the first one the holder leaves unanswered ends the run: the
/// rest are not sent, so a holder that stops answering costs one `each` past
/// its last answer, and one that answers every path, however slowly, at most
/// `each` per path. A holder that opened none of the paths, one that predates
/// the request or could open none of them there, is asked to come forward as
/// a launch without paths would; when that goes unanswered too it is still a
/// desktop that answered, so it reads as a refusal and the paths are never
/// sent again. A holder that says it is shutting down, on any path, is
/// answered for at once: the launch waits for it and boots with all its
/// paths.
fn forward_with(
    paths: &[String],
    budget: Duration,
    each: Duration,
    mut open: impl FnMut(&str, Duration) -> OpenPathReply,
    activate: impl FnOnce(Duration) -> ActivateReply,
) -> ActivateReply {
    if paths.is_empty() {
        return activate(budget);
    }
    let mut opened = None;
    let mut refused = None;
    for (at, path) in paths.iter().enumerate() {
        match open(path, if at == 0 { budget } else { each }) {
            OpenPathReply::NoReply if at == 0 => return ActivateReply::NoReply,
            OpenPathReply::NoReply => {
                tracing::warn!(
                    %path,
                    unsent = paths.len() - at - 1,
                    "the running chan-desktop stopped answering; the remaining paths are not sent"
                );
                break;
            }
            OpenPathReply::Refused { reply } if is_shutting_down(&reply) => {
                return ActivateReply::Refused { reply }
            }
            OpenPathReply::Refused { reply } => {
                tracing::warn!(%path, %reply, "the running chan-desktop did not open the path");
                refused = Some(reply);
            }
            OpenPathReply::Opened {
                desktop_version,
                message,
            } => {
                tracing::info!(%path, %message, "the running chan-desktop opened the path");
                opened.get_or_insert(desktop_version);
            }
        }
    }
    match opened {
        Some(desktop_version) => ActivateReply::Activated { desktop_version },
        None => match activate(budget) {
            ActivateReply::NoReply => ActivateReply::Refused {
                reply: refused.unwrap_or_default(),
            },
            answered => answered,
        },
    }
}

/// Ask the holder to come forward, with the endpoint's probes passed in so
/// the waits can be driven without a desktop. A holder still booting, which
/// only Windows tells apart, is waited for until its listener is up or
/// `bounds.boot` passes; then the holder has `bounds.ask` to answer, and a
/// holder that exits meanwhile frees the endpoint for this launch.
fn ask_with<C>(
    bounds: Bounds,
    mut booting: impl FnMut() -> bool,
    mut activate: impl FnMut(Duration) -> ActivateReply,
    mut claim: impl FnMut() -> Option<C>,
) -> Answer<C> {
    let boot_deadline = Instant::now() + bounds.boot;
    while booting() && Instant::now() < boot_deadline {
        std::thread::sleep(POLL);
    }
    let deadline = Instant::now() + bounds.ask;
    loop {
        let budget = deadline.saturating_duration_since(Instant::now());
        if budget.is_zero() {
            return Answer::Silent;
        }
        match activate(budget) {
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
        if let Some(claim) = claim() {
            return Answer::Released(claim);
        }
        std::thread::sleep(POLL);
    }
}

/// Read a holder's refusal: the answer of a desktop that is shutting down
/// ([`shutting_down`]), or any other.
fn refusal<C>(reply: String) -> Answer<C> {
    if is_shutting_down(&reply) {
        Answer::ShuttingDown
    } else {
        Answer::Refused { reply }
    }
}

fn is_shutting_down(reply: &str) -> bool {
    matches!(
        serde_json::from_str::<Response>(reply),
        Ok(Response::Error { message }) if message == SHUTTING_DOWN
    )
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

    /// The guard's bounds for a test that never meets a holder still booting
    /// (unix reads none): `ask` for the holder to answer, `release` and
    /// `drain` for the waits after a refusal.
    #[cfg(unix)]
    fn bounds(ask: Duration, release: Duration, drain: Duration) -> Bounds {
        Bounds {
            boot: Duration::ZERO,
            ask,
            release,
            drain,
        }
    }

    fn activated() -> ActivateReply {
        ActivateReply::Activated {
            desktop_version: "9.9.9".into(),
        }
    }

    /// A holder whose listener comes up within the boot bound comes forward,
    /// though its boot took longer than the ask bound: the ask starts once
    /// the listener is up, and a holder still booting is not asked.
    #[test]
    fn a_holder_still_booting_is_waited_for_and_comes_forward() {
        let up_at = Instant::now() + Duration::from_millis(600);
        let mut asked_while_booting = false;
        let answer = ask_with(
            Bounds {
                boot: Duration::from_secs(10),
                ask: Duration::from_millis(200),
                release: Duration::ZERO,
                drain: Duration::ZERO,
            },
            || Instant::now() < up_at,
            |_| {
                if Instant::now() < up_at {
                    asked_while_booting = true;
                    ActivateReply::NoReply
                } else {
                    activated()
                }
            },
            || None::<&str>,
        );
        assert!(
            matches!(&answer, Answer::CameForward { version } if version == "9.9.9"),
            "{answer:?}"
        );
        assert!(!asked_while_booting, "a holder still booting is not asked");
    }

    /// A holder that never starts its listener is waited for up to the boot
    /// bound and then asked like any other, so the launch ends in the exit
    /// that tells the user.
    #[test]
    fn a_holder_that_never_starts_its_listener_ends_unanswered_after_the_boot_bound() {
        let started = Instant::now();
        let mut asks = 0;
        let answer = ask_with(
            Bounds {
                boot: Duration::from_millis(400),
                ask: Duration::from_millis(200),
                release: Duration::ZERO,
                drain: Duration::ZERO,
            },
            || true,
            |_| {
                asks += 1;
                ActivateReply::NoReply
            },
            || None::<&str>,
        );
        assert!(matches!(answer, Answer::Silent), "{answer:?}");
        let waited = started.elapsed();
        assert!(
            waited >= Duration::from_millis(600) && waited < Duration::from_secs(3),
            "the boot bound, then the ask bound, and no longer: {waited:?}"
        );
        assert!(asks > 0, "past the boot bound the holder is asked");
        let startup = decide(Lock::Held, || answer, never_waited);
        assert_eq!(startup, Startup::Unanswered);
        assert_eq!(startup.exit_code(), Some(1));
    }

    /// A holder that exits while it boots frees the endpoint, and the launch
    /// takes it and boots.
    #[test]
    fn a_holder_that_exits_while_booting_hands_the_endpoint_over() {
        let gone_at = Instant::now() + Duration::from_millis(300);
        let answer = ask_with(
            Bounds {
                boot: Duration::from_secs(10),
                ask: Duration::from_secs(5),
                release: Duration::ZERO,
                drain: Duration::ZERO,
            },
            || Instant::now() < gone_at,
            |_| ActivateReply::NoReply,
            || (Instant::now() >= gone_at).then_some("claim"),
        );
        assert!(matches!(answer, Answer::Released("claim")), "{answer:?}");
    }

    /// A holder whose listener is up and does not answer has the ask bound
    /// alone: the boot bound does not lengthen it.
    #[test]
    fn a_served_holder_that_does_not_answer_has_the_ask_bound_alone() {
        let started = Instant::now();
        let answer = ask_with(
            Bounds {
                boot: Duration::from_secs(30),
                ask: Duration::from_millis(300),
                release: Duration::ZERO,
                drain: Duration::ZERO,
            },
            || false,
            |_| ActivateReply::NoReply,
            || None::<&str>,
        );
        assert!(matches!(answer, Answer::Silent), "{answer:?}");
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "{:?}",
            started.elapsed()
        );
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

    #[tokio::test]
    async fn a_terminal_offer_uses_the_same_shutdown_refusal() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(std::sync::Mutex::new(crate::config::ConfigStore::at_path(
            dir.path().join("config.json"),
        )));
        let state = Arc::new(AppState::with_store(store));
        state.shutdown_started.store(true, Ordering::SeqCst);
        let message = serve::spawn_throwaway_terminal_window(state, dir.path().to_path_buf())
            .await
            .expect_err("a shutting-down desktop refuses terminal offers");
        assert_eq!(
            message, "chan-desktop is shutting down",
            "release wire text"
        );
        let sent = serde_json::to_string(&Response::Error { message }).unwrap();
        assert!(matches!(refusal::<()>(sent), Answer::ShuttingDown));
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
            .split_once("\npub(crate) fn guard(paths: &[String]) -> Option<EndpointClaim> {")
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
            bounds(
                Duration::from_secs(5),
                Duration::from_millis(200),
                Duration::from_millis(200),
            ),
            &[],
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
            bounds(Duration::from_secs(5), Duration::ZERO, Duration::ZERO),
            &[],
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
            bounds(
                Duration::from_millis(400),
                Duration::from_millis(200),
                Duration::from_millis(200),
            ),
            &[],
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
            bounds(
                Duration::from_millis(400),
                Duration::from_millis(200),
                Duration::from_millis(200),
            ),
            &[],
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
            bounds(
                Duration::from_secs(5),
                Duration::from_millis(200),
                Duration::from_millis(200),
            ),
            &[],
        );
        release.join().unwrap();
        assert!(matches!(startup, Startup::Run(_)), "{startup:?}");
    }

    /// A pipe name of one Windows test's own, so parallel tests and an
    /// installed desktop never meet.
    #[cfg(windows)]
    fn test_pipe(tag: &str) -> std::path::PathBuf {
        std::path::PathBuf::from(format!(
            r"\\.\pipe\chan-desktop-test-{tag}-{}",
            std::process::id()
        ))
    }

    /// The claim of `pipe`, taken inside the runtime its pipe registers with.
    #[cfg(windows)]
    fn claimed(pipe: &Path) -> EndpointClaim {
        tauri::async_runtime::block_on(async { handoff::claim_endpoint_at(pipe) }).unwrap()
    }

    #[cfg(windows)]
    fn activate_answers(req: handoff::Request) -> Response {
        match req {
            handoff::Request::Activate { .. } => Response::Activated {
                desktop_version: "9.9.9".into(),
            },
            _ => Response::Error {
                message: "unexpected request".into(),
            },
        }
    }

    /// A second launch during a boot longer than the ask bound waits for the
    /// holder's listener and comes forward, instead of taking a desktop that
    /// is only booting for one that does not answer.
    #[cfg(windows)]
    #[test]
    fn a_launch_during_a_long_boot_comes_forward() {
        let pipe = test_pipe("long-boot");
        let held = claimed(&pipe);
        let serving = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(1500));
            tauri::async_runtime::block_on(async {
                handoff::start_claimed_listener(held, |req| async move { activate_answers(req) })
            })
        });
        let startup = check_at(
            &pipe,
            Bounds {
                boot: Duration::from_secs(10),
                ask: Duration::from_millis(500),
                release: Duration::from_millis(200),
                drain: Duration::from_millis(200),
            },
            &[],
        );
        let _listener = serving.join().unwrap().unwrap();
        assert!(
            matches!(&startup, Startup::HandedOver { version } if version == "9.9.9"),
            "{startup:?}"
        );
        assert_eq!(startup.exit_code(), Some(0));
    }

    /// A claim whose listener never starts reads as a desktop booting until
    /// the boot bound, and then as one that does not answer: the launch
    /// exits 1 rather than boot beside it.
    #[cfg(windows)]
    #[test]
    fn a_launch_beside_a_claim_that_never_listens_exits_non_zero() {
        let pipe = test_pipe("never-listens");
        let _held = claimed(&pipe);
        let started = Instant::now();
        let startup = check_at(
            &pipe,
            Bounds {
                boot: Duration::from_millis(600),
                ask: Duration::from_millis(300),
                release: Duration::from_millis(200),
                drain: Duration::from_millis(200),
            },
            &[],
        );
        assert!(matches!(startup, Startup::Unanswered), "{startup:?}");
        assert_eq!(startup.exit_code(), Some(1));
        assert!(
            started.elapsed() >= Duration::from_millis(900),
            "a claim with no pipe is waited for as a boot: {:?}",
            started.elapsed()
        );
    }

    /// A launch given paths beside a desktop that opens them: each path goes
    /// over as an `OpenPath`, in order, and the launch hands over without
    /// booting and without an `Activate` besides.
    #[cfg(unix)]
    #[test]
    fn a_launch_with_paths_beside_a_serving_desktop_hands_them_over() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("d.sock");
        let seen = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let record = Arc::clone(&seen);
        let _listener = tauri::async_runtime::block_on(async {
            handoff::start_listener(sock.clone(), move |req| {
                let record = Arc::clone(&record);
                async move {
                    let (seen, answer) = match req {
                        handoff::Request::OpenPath { path, .. } => (
                            format!("open_path {path}"),
                            Response::PathOpened {
                                desktop_version: "9.9.9".into(),
                                message: format!("open request queued for {path}"),
                            },
                        ),
                        handoff::Request::Activate { .. } => (
                            "activate".to_string(),
                            Response::Activated {
                                desktop_version: "9.9.9".into(),
                            },
                        ),
                        other => (
                            format!("{other:?}"),
                            Response::Error {
                                message: "unexpected request".into(),
                            },
                        ),
                    };
                    record.lock().unwrap().push(seen);
                    answer
                }
            })
        })
        .unwrap();
        let startup = check_at(
            &sock,
            bounds(
                Duration::from_secs(5),
                Duration::from_millis(200),
                Duration::from_millis(200),
            ),
            &["/srv/notes.md".into(), "/srv/docs".into()],
        );
        assert!(
            matches!(&startup, Startup::HandedOver { version } if version == "9.9.9"),
            "{startup:?}"
        );
        assert_eq!(
            *seen.lock().unwrap(),
            ["open_path /srv/notes.md", "open_path /srv/docs"]
        );
    }

    /// A launch given paths with no desktop running claims the endpoint and
    /// boots: nothing is sent, and the paths stay with the launch for its
    /// own boot to open.
    #[cfg(unix)]
    #[test]
    fn a_launch_with_paths_and_no_desktop_boots() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("d.sock");
        let startup = check_at(
            &sock,
            bounds(
                Duration::from_secs(5),
                Duration::from_millis(200),
                Duration::from_millis(200),
            ),
            &["/srv/notes.md".into()],
        );
        assert!(matches!(startup, Startup::Run(_)), "{startup:?}");
    }

    fn launch(paths: &[&str]) -> Vec<String> {
        paths.iter().map(|path| path.to_string()).collect()
    }

    fn opened(path: &str) -> OpenPathReply {
        OpenPathReply::Opened {
            desktop_version: "9.9.9".into(),
            message: format!("open request queued for {path}"),
        }
    }

    /// What a desktop that predates `OpenPath` answers it: the listener's line
    /// for a type it does not know, read from the listener of the release
    /// before it.
    const OLDER_DESKTOP_REPLY: &str = r#"{"status":"error","message":"invalid handoff request: unknown variant `open_path`, expected one of `open_workspace`, `upgrade`, `open_devserver`, `close_workspace`, `list_devservers`, `connect_devserver`, `disconnect_devserver`, `forget_devserver`, `serve_remote_workspace`, `close_remote_workspace`, `forget_remote_workspace`, `open_terminal`, `activate` at line 1 column 77"}"#;

    #[test]
    fn a_launch_without_paths_asks_the_holder_to_come_forward() {
        let reply = forward_with(
            &[],
            Duration::from_secs(2),
            Duration::from_secs(1),
            |_, _| panic!("there is no path to open"),
            |budget| {
                assert_eq!(budget, Duration::from_secs(2));
                activated()
            },
        );
        assert_eq!(reply, activated());
    }

    #[test]
    fn a_launch_hands_each_path_over_and_the_holder_comes_forward() {
        let mut sent = Vec::new();
        let reply = forward_with(
            &launch(&["/srv/notes.md", "/srv/docs", "/srv/image.png"]),
            Duration::from_secs(2),
            Duration::from_secs(1),
            |path, budget| {
                sent.push((path.to_string(), budget));
                opened(path)
            },
            |_| panic!("a holder that opened a path came forward"),
        );
        assert_eq!(reply, activated());
        assert_eq!(
            sent,
            [
                ("/srv/notes.md".to_string(), Duration::from_secs(2)),
                ("/srv/docs".to_string(), Duration::from_secs(1)),
                ("/srv/image.png".to_string(), Duration::from_secs(1)),
            ]
        );
    }

    /// An older desktop refuses every `OpenPath` as an unknown type, and a
    /// current one refuses a path it cannot open. Either is a live desktop
    /// the launch must not run beside, so once no path opened it is asked to
    /// come forward as a launch without paths would.
    #[test]
    fn a_holder_that_opens_no_path_is_asked_to_come_forward() {
        let unopenable = serde_json::to_string(&Response::Error {
            message: "cannot open /gone/notes.md: canonicalize path: No such file or directory \
                      (os error 2)"
                .into(),
        })
        .unwrap();
        for refusal in [OLDER_DESKTOP_REPLY.trim().to_string(), unopenable] {
            let mut sent = 0;
            let mut asked = false;
            let reply = forward_with(
                &launch(&["/srv/notes.md", "/srv/docs"]),
                Duration::from_secs(1),
                Duration::from_secs(1),
                |_, _| {
                    sent += 1;
                    OpenPathReply::Refused {
                        reply: refusal.clone(),
                    }
                },
                |_| {
                    asked = true;
                    activated()
                },
            );
            assert_eq!(reply, activated(), "{refusal}");
            assert_eq!(sent, 2, "every path is offered: {refusal}");
            assert!(asked, "{refusal}");
        }
    }

    #[test]
    fn a_holder_that_opens_some_of_the_paths_came_forward() {
        let reply = forward_with(
            &launch(&["/gone/notes.md", "/srv/docs"]),
            Duration::from_secs(1),
            Duration::from_secs(1),
            |path, _| {
                if path == "/srv/docs" {
                    opened(path)
                } else {
                    OpenPathReply::Refused {
                        reply: "{\"status\":\"error\",\"message\":\"cannot open\"}".into(),
                    }
                }
            },
            |_| panic!("a holder that opened a path came forward"),
        );
        assert_eq!(reply, activated());
    }

    /// A holder shutting down is answered for at once: the launch waits for
    /// it and boots with every path, so none is offered to the desktop on its
    /// way out.
    #[test]
    fn a_holder_shutting_down_takes_no_path() {
        let shutting = serde_json::to_string(&shutting_down()).unwrap();
        let reply = forward_with(
            &launch(&["/srv/notes.md", "/srv/docs"]),
            Duration::from_secs(1),
            Duration::from_secs(1),
            |path, _| {
                assert_eq!(path, "/srv/notes.md", "only the first path is offered");
                OpenPathReply::Refused {
                    reply: shutting.clone(),
                }
            },
            |_| panic!("a holder shutting down is not asked to come forward"),
        );
        assert_eq!(
            reply,
            ActivateReply::Refused {
                reply: shutting.clone()
            }
        );
        assert!(matches!(refusal::<()>(shutting), Answer::ShuttingDown));
    }

    /// Nothing answered the first path: `ask_with` asks again, or claims the
    /// endpoint the holder left, so the rest wait.
    #[test]
    fn a_holder_that_does_not_answer_is_asked_again() {
        let reply = forward_with(
            &launch(&["/srv/notes.md", "/srv/docs"]),
            Duration::from_secs(1),
            Duration::from_secs(1),
            |path, _| {
                assert_eq!(path, "/srv/notes.md", "only the first path is offered");
                OpenPathReply::NoReply
            },
            |_| panic!("an unanswered launch is not asked to come forward"),
        );
        assert_eq!(reply, ActivateReply::NoReply);
    }

    /// A holder that answers a path and then stops answering gets no more:
    /// the rest are not sent, and the path it opened is its coming forward.
    #[test]
    fn a_holder_that_stops_answering_gets_no_more_paths() {
        let mut sent = Vec::new();
        let reply = forward_with(
            &launch(&["/srv/notes.md", "/srv/docs", "/srv/image.png"]),
            Duration::from_secs(1),
            Duration::from_secs(1),
            |path, _| {
                sent.push(path.to_string());
                if path == "/srv/notes.md" {
                    opened(path)
                } else {
                    OpenPathReply::NoReply
                }
            },
            |_| panic!("a holder that opened a path came forward"),
        );
        assert_eq!(reply, activated());
        assert_eq!(sent, ["/srv/notes.md", "/srv/docs"]);
    }

    /// A holder that starts shutting down partway takes no more paths, and
    /// the launch waits for it and boots with all of them, as it does when
    /// the first path meets the shutdown.
    #[test]
    fn a_holder_shutting_down_on_a_later_path_takes_no_more() {
        let shutting = serde_json::to_string(&shutting_down()).unwrap();
        let mut sent = Vec::new();
        let reply = forward_with(
            &launch(&["/srv/notes.md", "/srv/docs", "/srv/image.png"]),
            Duration::from_secs(1),
            Duration::from_secs(1),
            |path, _| {
                sent.push(path.to_string());
                if path == "/srv/notes.md" {
                    opened(path)
                } else {
                    OpenPathReply::Refused {
                        reply: shutting.clone(),
                    }
                }
            },
            |_| panic!("a holder shutting down is not asked to come forward"),
        );
        assert_eq!(
            reply,
            ActivateReply::Refused {
                reply: shutting.clone()
            }
        );
        assert_eq!(sent, ["/srv/notes.md", "/srv/docs"]);
        assert!(matches!(refusal::<()>(shutting), Answer::ShuttingDown));
    }

    /// A holder that refused every path has answered, so an `Activate` it
    /// then leaves unanswered reads as a refusal: `ask_with` asks once, and
    /// the paths are not sent a second time.
    #[test]
    fn a_holder_that_refuses_every_path_and_then_is_silent_is_not_asked_again() {
        let mut sent = 0;
        let mut forward = |budget| {
            forward_with(
                &launch(&["/srv/notes.md", "/srv/docs"]),
                budget,
                Duration::from_secs(1),
                |_, _| {
                    sent += 1;
                    OpenPathReply::Refused {
                        reply: OLDER_DESKTOP_REPLY.to_string(),
                    }
                },
                |_| ActivateReply::NoReply,
            )
        };
        let answer = ask_with(
            Bounds {
                boot: Duration::ZERO,
                ask: Duration::from_secs(5),
                release: Duration::ZERO,
                drain: Duration::ZERO,
            },
            || false,
            &mut forward,
            || None::<()>,
        );
        assert!(
            matches!(&answer, Answer::Refused { reply } if reply == OLDER_DESKTOP_REPLY),
            "{answer:?}"
        );
        assert_eq!(sent, 2, "each path is sent once");
    }

    /// The Windows twin of `a_launch_beside_a_serving_desktop_hands_over`.
    #[cfg(windows)]
    #[test]
    fn a_launch_beside_a_serving_desktop_hands_over_on_windows() {
        let pipe = test_pipe("serving");
        let _listener = tauri::async_runtime::block_on(async {
            handoff::start_listener(pipe.clone(), |req| async move { activate_answers(req) })
        })
        .unwrap();
        let startup = check_at(
            &pipe,
            Bounds {
                boot: Duration::from_secs(10),
                ask: Duration::from_secs(5),
                release: Duration::from_millis(200),
                drain: Duration::from_millis(200),
            },
            &[],
        );
        assert!(
            matches!(&startup, Startup::HandedOver { version } if version == "9.9.9"),
            "{startup:?}"
        );
    }

    /// The Windows twin of `a_launch_claims_the_endpoint_a_silent_holder_frees`:
    /// a holder that exits during its boot frees the claim, and the launch
    /// boots on it.
    #[cfg(windows)]
    #[test]
    fn a_launch_claims_the_endpoint_a_booting_holder_frees() {
        let pipe = test_pipe("frees");
        let held = claimed(&pipe);
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            drop(held);
        });
        let startup = check_at(
            &pipe,
            Bounds {
                boot: Duration::from_secs(10),
                ask: Duration::from_secs(5),
                release: Duration::from_millis(200),
                drain: Duration::from_millis(200),
            },
            &[],
        );
        release.join().unwrap();
        assert!(matches!(startup, Startup::Run(_)), "{startup:?}");
    }

    /// A launch beside a claim pipe another account holds boots at once,
    /// without the listener, and says why, instead of waiting for and asking
    /// a desktop it can never reach. The test stands in for that account with
    /// a claim pipe whose security grants LocalSystem alone.
    #[cfg(windows)]
    #[test]
    fn a_launch_beside_another_accounts_claim_boots_without_the_listener() {
        let pipe = test_pipe("foreign-claim");
        let mut claim_pipe = pipe.as_os_str().to_owned();
        claim_pipe.push(".claim");
        let _theirs = tauri::async_runtime::block_on(async {
            chan_winpipe::create_with_sddl(
                tokio::net::windows::named_pipe::ServerOptions::new()
                    .first_pipe_instance(true)
                    .access_outbound(false),
                &claim_pipe,
                "D:P(A;;GA;;;SY)",
            )
        })
        .unwrap();
        let started = Instant::now();
        let startup = check_at(
            &pipe,
            Bounds {
                boot: Duration::from_secs(10),
                ask: Duration::from_secs(5),
                release: Duration::from_millis(200),
                drain: Duration::from_millis(200),
            },
            &[],
        );
        assert!(
            matches!(&startup, Startup::RunWithoutListener { why } if why.contains("another account")),
            "{startup:?}"
        );
        assert_eq!(startup.exit_code(), None);
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "nothing waited for: {:?}",
            started.elapsed()
        );
    }

    /// The Windows twin of
    /// `a_desktop_whose_listener_failed_to_start_still_holds_the_endpoint`:
    /// the listener fails to start because another process created a pipe of
    /// the name during the boot, the desktop keeps the claim, and a second
    /// launch meets a holder that does not answer and exits 1.
    #[cfg(windows)]
    #[test]
    fn a_desktop_whose_listener_failed_to_start_still_holds_the_endpoint_on_windows() {
        let pipe = test_pipe("listener-failed");
        let config = tempfile::tempdir().unwrap();
        let store = Arc::new(std::sync::Mutex::new(crate::config::ConfigStore::at_path(
            config.path().join("config.json"),
        )));
        let state = AppState::with_store(store);
        let claimed = claimed(&pipe);
        let (squatter, started) = tauri::async_runtime::block_on(async {
            let squatter = tokio::net::windows::named_pipe::ServerOptions::new()
                .first_pipe_instance(true)
                .create(&pipe)
                .unwrap();
            let started = handoff::start_claimed_listener(claimed, |_req| async {
                Response::Error {
                    message: "unreachable".into(),
                }
            });
            (squatter, started)
        });
        assert!(started.is_err(), "a pipe another process created first");
        hold_endpoint(&state, started);
        let startup = check_at(
            &pipe,
            Bounds {
                boot: Duration::from_secs(10),
                ask: Duration::from_millis(400),
                release: Duration::from_millis(200),
                drain: Duration::from_millis(200),
            },
            &[],
        );
        assert!(
            matches!(startup, Startup::Unanswered),
            "a second launch must not boot beside a desktop whose listener failed to start: \
             {startup:?}"
        );
        release_endpoint(&state);
        drop(squatter);
        assert!(
            matches!(claim(&pipe), Lock::Taken(_)),
            "a relaunch gives the endpoint up"
        );
    }
}
