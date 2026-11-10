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
//! opening a window, starting a watcher or reading any state. The CLI
//! personalities and the default-terminal launch never reach this: they are
//! dispatched before it in `main`.
//!
//! The endpoint is per user (the runtime directory on unix, the user name in
//! the pipe name on Windows), not per `CHAN_HOME`.

use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use chan_server::handoff::{self, ActivateReply, ClaimError, EndpointClaim, Response};
use tauri::{AppHandle, Manager, Runtime};

use crate::{serve, window_watcher, AppState};

/// How long a launch that found the endpoint held keeps asking the holder to
/// come forward. The holder may still be booting: it claims the endpoint
/// first thing and binds its listener only once its embedded server is up.
const ASK_BOUND: Duration = Duration::from_secs(5);

/// How long a launch waits for the endpoint after the holder refused. A
/// holder on its way out refuses too: one shutting down answers so, and an
/// older one relaunching after an update answers the request as unknown and
/// holds the endpoint until it exits.
const RELEASE_GRACE: Duration = Duration::from_secs(5);

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
    /// It answered without coming forward; `reply` is its answer.
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
    /// Another desktop holds the endpoint and does not answer; exit 1.
    Unanswered,
}

impl<C> Startup<C> {
    /// `None` boots; `Some(code)` ends the process with `code`.
    pub(crate) fn exit_code(&self) -> Option<i32> {
        match self {
            Startup::Run(_) | Startup::RunWithoutListener { .. } => None,
            Startup::HandedOver { .. } | Startup::Refused { .. } => Some(0),
            Startup::Unanswered => Some(1),
        }
    }
}

/// The start-up decision. `ask` runs only when the endpoint is held, and
/// `wait` only when the holder refused: a holder on its way out refuses, so
/// the launch exits only if the endpoint stays held.
pub(crate) fn decide<C>(
    lock: Lock<C>,
    ask: impl FnOnce() -> Answer<C>,
    wait: impl FnOnce() -> Option<C>,
) -> Startup<C> {
    match lock {
        Lock::Taken(claim) => Startup::Run(claim),
        Lock::Unavailable(why) => Startup::RunWithoutListener { why },
        Lock::Held => match ask() {
            Answer::CameForward { version } => Startup::HandedOver { version },
            Answer::Released(claim) => Startup::Run(claim),
            Answer::Silent => Startup::Unanswered,
            Answer::Refused { reply } => match wait() {
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
        Some(path) => check_at(&path, ASK_BOUND, RELEASE_GRACE),
        None => Startup::RunWithoutListener {
            why: "no owner-controlled runtime directory for the handoff endpoint".into(),
        },
    };
    match &startup {
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
        Startup::Unanswered => tracing::error!(
            waited = ?ASK_BOUND,
            "another chan-desktop holds the handoff endpoint but does not answer; this launch \
             exits rather than start a second desktop"
        ),
    }
    if let Some(code) = startup.exit_code() {
        std::process::exit(code);
    }
    match startup {
        Startup::Run(claim) => Some(claim),
        _ => None,
    }
}

fn check_at(path: &Path, ask_bound: Duration, grace: Duration) -> Startup<EndpointClaim> {
    decide(
        claim(path),
        || ask(path, ask_bound),
        || wait_for_release(path, grace),
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
            ActivateReply::Refused { reply } => return Answer::Refused { reply },
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
        return Response::Error {
            message: "chan-desktop is shutting down".into(),
        };
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

    fn never_waited() -> Option<&'static str> {
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
            || None,
        );
        assert_eq!(
            startup,
            Startup::Refused {
                reply: reply.into()
            }
        );
        assert_eq!(startup.exit_code(), Some(0));
    }

    #[test]
    fn a_held_endpoint_whose_desktop_does_not_answer_exits_non_zero() {
        let startup = decide(Lock::Held, || Answer::Silent, never_waited);
        assert_eq!(startup, Startup::Unanswered);
        assert_eq!(startup.exit_code(), Some(1));
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
            || Some("claim"),
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
        let startup = check_at(&sock, Duration::from_secs(5), Duration::from_millis(200));
        assert_eq!(
            startup.exit_code(),
            Some(0),
            "the launch must exit: {startup:?}"
        );
        assert!(matches!(startup, Startup::HandedOver { version } if version == "9.9.9"));
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
        );
        assert!(matches!(startup, Startup::Unanswered), "{startup:?}");
        assert_eq!(startup.exit_code(), Some(1));
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
        let startup = check_at(&sock, Duration::from_secs(5), Duration::from_millis(200));
        release.join().unwrap();
        assert!(matches!(startup, Startup::Run(_)), "{startup:?}");
    }
}
