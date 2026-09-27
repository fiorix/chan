//! Binds the surface-agnostic window-watcher core ([`crate::window_watcher`])
//! to the live desktop: the local library's in-process window feed and the
//! Tauri native-window surface.
//!
//! [`spawn_local_window_watcher`] runs one [`watch_loop`] for the embedded
//! local library (`"local"`). The feed snapshots
//! [`EmbeddedServer::assemble_window_records`](crate::embedded::EmbeddedServer::assemble_window_records)
//! and wakes on its aggregate change `Notify`; the surface opens windows
//! through [`serve::open_watched_local_window`] (the shared SPA builder) and
//! closes them by destroying the Tauri window. The watcher is inert until a
//! local window is minted (an empty registry reconciles to nothing); routing
//! the window-creation paths through the registry mint makes it the SOLE driver
//! of local windows, so reconnect/relaunch cannot duplicate windows and is
//! unreachable by construction.

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chan_server::WindowRecord;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{watch, Notify};

use crate::devserver::{ConnectionRows, DevserverConn};
use crate::window_watcher::{
    native_label, watch_loop, NativeSurface, PendingDeleteAttempt, PendingDeleteState,
    WatchLoopStop, WatcherViewState, WindowFeed,
};
use crate::{serve, AppState};

/// Library id of the embedded local-disk library.
const LOCAL_LIBRARY_ID: &str = "local";

pub(crate) fn request_devserver_reload(
    label: &str,
    connected: bool,
    view: Option<&WatcherViewState>,
) -> bool {
    connected && view.is_some_and(|view| view.request_reload(label))
}

async fn prepare_remote_navigation(
    resolve: impl std::future::Future<Output = Result<String, String>>,
    install: impl FnOnce() -> Result<(), String>,
) -> Result<String, String> {
    let url = resolve.await?;
    install()?;
    Ok(url)
}

/// How a devserver watcher should stop. Disconnect closes that devserver's
/// native windows; the control-exit path retires the watcher while preserving
/// its windows for the user's reconnect or abandon decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DevserverWatcherStop {
    Running,
    RetireKeepWindows,
    CloseWindows,
}

impl DevserverWatcherStop {
    pub(crate) fn is_stopped(self) -> bool {
        self != Self::Running
    }

    fn watch_loop_stop(self) -> Option<WatchLoopStop> {
        match self {
            Self::Running => None,
            Self::RetireKeepWindows => Some(WatchLoopStop::KeepWindows),
            Self::CloseWindows => Some(WatchLoopStop::CloseWindows),
        }
    }
}

/// How a watched window opens its SPA -- the only library-specific bit of the
/// otherwise surface-agnostic [`TauriNativeSurface`]. Local windows load the
/// in-process loopback library; remote windows load a connected devserver's SPA
/// at `host:port` (through the connecting screen, since the remote may be down).
enum WindowOpener {
    Local {
        addr: SocketAddr,
    },
    Remote {
        /// The devserver this watcher serves; navigation URLs resolve through
        /// it at open/retarget time (`devserver::window_navigation_url`).
        conn: crate::devserver::DevserverConn,
    },
}

impl WindowOpener {
    fn is_remote(&self) -> bool {
        matches!(self, WindowOpener::Remote { .. })
    }

    fn is_gateway(&self) -> bool {
        matches!(self, WindowOpener::Remote { conn } if conn.gateway.is_some())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RemoteLaunchKey {
    prefix: String,
    /// Raw-tunnel devservers only: their per-tenant token is stable, and a
    /// rotation (devserver restart) invalidates the loaded page, so it forces
    /// a retarget. Gateway windows blank this field because their standing
    /// authentication is the opaque devserver-gate cookie; a token change in
    /// the feed must not trigger navigation for that session.
    token: String,
    kind: chan_server::WindowKind,
    workspace_path: Option<String>,
    ordinal: u32,
}

impl RemoteLaunchKey {
    fn from_record(record: &WindowRecord, gateway: bool) -> Self {
        Self {
            prefix: record.prefix.clone(),
            token: if gateway {
                String::new()
            } else {
                record.token.clone()
            },
            kind: record.kind,
            workspace_path: record.workspace_path.clone(),
            ordinal: record.ordinal,
        }
    }
}

/// The local library's window-set feed, read in-process from the embedded host.
struct LocalWindowFeed {
    state: Arc<AppState>,
    /// The aggregate change signal, captured once at spawn (a stable `Arc` the
    /// host re-hands on every call, so capturing it once is sufficient).
    change: Arc<Notify>,
}

impl WindowFeed for LocalWindowFeed {
    fn snapshot(&self) -> Vec<WindowRecord> {
        // LOCAL records only (`local_window_records`): the merged launcher set
        // includes devserver windows, but the LOCAL native watcher must only
        // reconcile LOCAL windows -- devserver windows are driven by their own
        // per-devserver watcher -- else the local reconcile would try to open
        // remote records via the local opener (and trip its same-library assert).
        self.state
            .embedded()
            .map(|embedded| embedded.local_window_records())
            .unwrap_or_default()
    }

    fn change_notify(&self) -> Arc<Notify> {
        self.change.clone()
    }
}

const RETRY_NUDGE: Duration = Duration::from_secs(15);

type BuildCompletion = serve::WindowBuildCompletion;

#[derive(Clone, Copy, PartialEq, Eq)]
enum LaunchPhase {
    InFlight,
    Waiting,
    Applied,
}

/// Why the watcher dispatches a retarget.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Retarget {
    /// The user's Reload.
    Requested,
    /// A target the window has not been sent to: a changed launch key, or a
    /// window this watcher has no attempt for.
    Changed,
    /// A waiting attempt whose dispatch deadline passed.
    Retry,
}

impl Retarget {
    /// Whether the navigation shows and raises the window.
    fn raises(self) -> bool {
        true
    }
}

struct RemoteLaunch {
    key: RemoteLaunchKey,
    attempted_at: tokio::time::Instant,
    phase: LaunchPhase,
}

impl RemoteLaunch {
    fn retry_deadline(&self, now: tokio::time::Instant) -> Option<tokio::time::Instant> {
        let deadline = self.attempted_at + RETRY_NUDGE;
        match self.phase {
            LaunchPhase::Applied => None,
            // The completion wakes the loop if it finishes past this deadline.
            LaunchPhase::InFlight if deadline <= now => None,
            LaunchPhase::InFlight | LaunchPhase::Waiting => Some(deadline),
        }
    }

    fn should_retry(&self, next: &RemoteLaunchKey) -> bool {
        self.retry(next).is_some()
    }

    fn retry(&self, next: &RemoteLaunchKey) -> Option<Retarget> {
        if self.key != *next {
            Some(Retarget::Changed)
        } else if self.phase == LaunchPhase::Waiting
            && tokio::time::Instant::now() >= self.attempted_at + RETRY_NUDGE
        {
            Some(Retarget::Retry)
        } else {
            None
        }
    }
}

#[derive(Default)]
struct Launches {
    entries: HashMap<String, RemoteLaunch>,
    retired: Option<WatchLoopStop>,
}

impl Launches {
    fn retry_deadline(&self) -> Option<tokio::time::Instant> {
        let now = tokio::time::Instant::now();
        self.entries
            .values()
            .filter_map(|entry| entry.retry_deadline(now))
            .min()
    }

    fn retire(&mut self, stop: WatchLoopStop) {
        self.retired = Some(stop);
        self.entries.clear();
    }
}

/// Tracks native builds and retains failed attempts until their retry deadline.
#[derive(Clone)]
struct WindowBuilds {
    pending: Arc<Mutex<Launches>>,
    nudge: Arc<Notify>,
    view: Arc<WatcherViewState>,
}

impl WindowBuilds {
    fn new(nudge: Arc<Notify>, view: Arc<WatcherViewState>) -> Self {
        Self {
            pending: Arc::new(Mutex::new(Launches::default())),
            nudge,
            view,
        }
    }

    fn begin(&self, record: &WindowRecord, gateway: bool) -> bool {
        let label = native_label(record);
        let key = RemoteLaunchKey::from_record(record, gateway);
        let mut pending = self.pending.lock().unwrap();
        if pending.retired.is_some()
            || pending
                .entries
                .get(&label)
                .is_some_and(|entry| !entry.should_retry(&key))
        {
            return false;
        }
        pending.entries.insert(
            label,
            RemoteLaunch {
                key,
                attempted_at: tokio::time::Instant::now(),
                phase: LaunchPhase::InFlight,
            },
        );
        true
    }

    fn remove(&self, label: &str) {
        self.pending.lock().unwrap().entries.remove(label);
    }

    fn contains(&self, label: &str) -> bool {
        self.pending
            .lock()
            .unwrap()
            .entries
            .get(label)
            .is_some_and(|entry| entry.phase == LaunchPhase::InFlight)
    }

    fn open_labels(&self, prefix: &str, mut built: HashSet<String>) -> HashSet<String> {
        let mut pending = self.pending.lock().unwrap();
        pending.entries.retain(|label, _| !built.contains(label));
        built.extend(
            pending
                .entries
                .iter()
                .filter(|(label, entry)| {
                    label.starts_with(prefix) && entry.phase == LaunchPhase::InFlight
                })
                .map(|(label, _)| label.clone()),
        );
        built
    }

    fn retry(&self) {
        self.view.wake();
    }

    fn complete(&self, label: &str, result: Result<(), String>) {
        let error = match result {
            // Only a devserver watcher retires, and its builds settle through
            // `remote_completion`, which acts on what landing answers.
            Ok(()) => {
                self.land(label);
                return;
            }
            Err(error) => error,
        };
        let mut pending = self.pending.lock().unwrap();
        if pending.retired.is_some() {
            return;
        }
        let Some(attempt) = pending.entries.get_mut(label) else {
            return;
        };
        attempt.phase = LaunchPhase::Waiting;
        drop(pending);
        tracing::warn!(window = %label, %error, "window watcher: opening a window failed");
        self.retry();
    }

    /// Settle a build whose window now exists. False when the watcher no
    /// longer wants that window: a disconnect retired it first, and its
    /// sweep closed the windows before this one existed. A stop that keeps
    /// the windows keeps this one too.
    fn land(&self, label: &str) -> bool {
        let mut pending = self.pending.lock().unwrap();
        if let Some(stop) = pending.retired {
            return stop == WatchLoopStop::KeepWindows;
        }
        pending.entries.remove(label);
        drop(pending);
        self.nudge.notify_waiters();
        true
    }

    fn completion(&self, label: String) -> BuildCompletion {
        let builds = self.clone();
        Box::new(move |result| builds.complete(&label, result))
    }

    /// The completion of a remote build. It runs on the main thread once the
    /// builder installed the window or failed; `destroy` removes an installed
    /// window the watcher no longer wants.
    fn remote_completion(
        &self,
        label: String,
        fail: impl FnOnce(String) + Send + 'static,
        destroy: impl FnOnce() + Send + 'static,
    ) -> BuildCompletion {
        let builds = self.clone();
        Box::new(move |result| match result {
            Ok(()) => {
                if !builds.land(&label) {
                    destroy();
                }
            }
            Err(error) => fail(error),
        })
    }
}

#[derive(Default)]
struct RemoteLaunches(Mutex<Launches>);

impl RemoteLaunches {
    fn retarget(&self, record: &WindowRecord, gateway: bool, reload: bool) -> Option<Retarget> {
        let label = native_label(record);
        let next = RemoteLaunchKey::from_record(record, gateway);
        let state = self.0.lock().unwrap();
        if state.retired.is_some() {
            return None;
        }
        if reload {
            return Some(Retarget::Requested);
        }
        match state.entries.get(&label) {
            Some(entry) => entry.retry(&next),
            None => Some(Retarget::Changed),
        }
    }

    /// Whether a refresh dispatches a retarget, and why. `present` says
    /// whether the window's webview exists. A window still being built has
    /// none: its build owns it, and the pass after the build lands retargets
    /// it if the key moved, so no attempt is ever dispatched at an absent
    /// webview.
    fn admit(
        &self,
        record: &WindowRecord,
        gateway: bool,
        reload: bool,
        present: bool,
    ) -> Option<Retarget> {
        if !present {
            return None;
        }
        self.retarget(record, gateway, reload)
    }

    fn begin_remote(
        &self,
        record: &WindowRecord,
        gateway: bool,
        retarget: bool,
        tickets: &serve::RetargetTickets,
    ) -> Option<serve::RetargetTicket> {
        let label = native_label(record);
        let ticket = retarget.then(|| tickets.begin(&label));
        // Reserve the deadline before URL resolution so completion order cannot
        // move an attempt's next eligible dispatch behind another window's.
        let remember = || {
            let mut state = self.0.lock().unwrap();
            if state.retired.is_some() {
                return;
            }
            state.entries.insert(
                label.clone(),
                RemoteLaunch {
                    key: RemoteLaunchKey::from_record(record, gateway),
                    attempted_at: tokio::time::Instant::now(),
                    phase: if retarget {
                        LaunchPhase::InFlight
                    } else {
                        LaunchPhase::Applied
                    },
                },
            );
        };
        if let Some(ticket) = &ticket {
            tickets.with_current(ticket, remember);
        } else {
            remember();
        }
        ticket
    }

    fn forget(&self, label: &str) {
        self.0.lock().unwrap().entries.remove(label);
    }

    fn wait(&self, label: &str, builds: &WindowBuilds) {
        let mut state = self.0.lock().unwrap();
        let Some(attempt) = state.entries.get_mut(label) else {
            return;
        };
        attempt.phase = LaunchPhase::Waiting;
        drop(state);
        builds.retry();
    }

    fn fail(
        &self,
        label: &str,
        retarget: bool,
        tickets: &serve::RetargetTickets,
        ticket: Option<&serve::RetargetTicket>,
        builds: &WindowBuilds,
        error: String,
    ) {
        let rollback = || {
            if retarget {
                // A retarget does not own a concurrent open's marker.
                tracing::warn!(window = %label, %error, "window watcher: retargeting a window failed");
                self.wait(label, builds);
            } else {
                self.forget(label);
                builds.complete(label, Err(error));
            }
        };
        if let Some(ticket) = ticket {
            tickets.with_current(ticket, rollback);
        } else {
            rollback();
        }
    }

    fn finish_retarget(
        &self,
        label: &str,
        tickets: &serve::RetargetTickets,
        ticket: &serve::RetargetTicket,
        builds: &WindowBuilds,
        outcome: Result<serve::RetargetOutcome, String>,
    ) {
        match outcome {
            // Only a current attempt may forget its state. Native destruction
            // can already have cancelled the ticket, leaving this arm inert.
            Ok(serve::RetargetOutcome::Gone) => {
                tickets.with_current(ticket, || {
                    self.forget(label);
                    builds.retry();
                });
            }
            Ok(serve::RetargetOutcome::Navigated) => {
                tickets.with_current(ticket, || {
                    let mut state = self.0.lock().unwrap();
                    let Some(attempt) = state.entries.get_mut(label) else {
                        return;
                    };
                    attempt.phase = LaunchPhase::Applied;
                    drop(state);
                    builds.retry();
                });
            }
            Ok(serve::RetargetOutcome::NotReady) => {
                tickets.with_current(ticket, || {
                    tracing::debug!(window = %label, "window watcher: target is not ready");
                    self.wait(label, builds);
                });
            }
            Ok(serve::RetargetOutcome::Superseded) => {}
            Err(e) => self.fail(label, true, tickets, Some(ticket), builds, e),
        }
    }

    async fn run_retarget<
        F: std::future::Future<Output = Result<serve::RetargetOutcome, String>>,
    >(
        &self,
        label: &str,
        tickets: &serve::RetargetTickets,
        ticket: &serve::RetargetTicket,
        builds: &WindowBuilds,
        prepare: impl std::future::Future<Output = Result<String, String>>,
        navigate: impl FnOnce(String) -> F,
    ) {
        let outcome = match prepare.await {
            Ok(url) => navigate(url).await,
            Err(error) => Err(error),
        };
        self.finish_retarget(label, tickets, ticket, builds, outcome);
    }

    fn retain_attempts(
        &self,
        builds: &WindowBuilds,
        desired: &HashSet<String>,
        actual: &HashSet<String>,
    ) {
        self.0
            .lock()
            .unwrap()
            .entries
            .retain(|label, _| desired.contains(label) && actual.contains(label));
        builds
            .pending
            .lock()
            .unwrap()
            .entries
            .retain(|label, _| desired.contains(label));
    }

    fn retry_deadline(&self, builds: &WindowBuilds) -> Option<tokio::time::Instant> {
        let remote = self.0.lock().unwrap().retry_deadline();
        let native = builds.pending.lock().unwrap().retry_deadline();
        remote.into_iter().chain(native).min()
    }

    fn retire(&self, builds: &WindowBuilds, stop: WatchLoopStop) {
        self.0.lock().unwrap().retire(stop);
        builds.pending.lock().unwrap().retire(stop);
    }

    /// Hand a resolved open to the native builder. A close or a retirement
    /// during the resolution removed the in-flight marker, and building then
    /// would bring back a window the user just closed.
    fn build_resolved(
        &self,
        label: &str,
        builds: &WindowBuilds,
        fail: impl FnOnce(String) + Clone + Send + 'static,
        destroy: impl FnOnce() + Send + 'static,
        build: impl FnOnce(BuildCompletion) -> Result<(), String>,
    ) {
        if !builds.contains(label) {
            self.forget(label);
            return;
        }
        let completion = builds.remote_completion(label.to_string(), fail.clone(), destroy);
        if let Err(error) = build(completion) {
            fail(error);
        }
    }
}

/// The Tauri native-window surface: opens windows via the shared SPA builder,
/// closes them by destroying the OS window, and enumerates the open native
/// windows for a library by their `{library_id}::` label prefix.
struct TauriNativeSurface {
    app: AppHandle,
    opener: WindowOpener,
    builds: WindowBuilds,
    /// Last launch-only state used for remote devserver windows. A devserver
    /// restart keeps the same `{library_id}::{window_id}` label but rotates the
    /// tenant token in the URL, so an existing webview may need an in-place
    /// rebuild even though it is already "open" to the reconciler.
    remote_launches: Arc<RemoteLaunches>,
    /// Native label -> the OS title that window is known to be carrying. The
    /// reconcile calls `refresh` for every shown window on every feed change
    /// (which includes every connect/disconnect), and reading a Tauri title
    /// means a main-thread round trip; this answers the overwhelmingly common
    /// "nothing changed" case without one. Populated only from an observed or
    /// applied title, so it cannot claim a title the window does not have.
    applied_titles: Arc<Mutex<HashMap<String, String>>>,
}

impl TauriNativeSurface {
    /// Open or retarget a remote window off the reconcile path. Resolve the raw
    /// tenant URL or gateway URL, reusing a fresh gateway session or refreshing
    /// a stale one, then install that session before building or navigating.
    ///
    /// Remember the key and dispatch time before the async work. A failed
    /// retarget keeps that deadline, and its completion wakes this watcher to
    /// arm the loop's timer. Ticket currency guards each retarget settlement.
    /// The open path checks its in-flight marker before building; closing or
    /// retiring the watcher removes that marker. A vanished retarget never
    /// builds a window: authoritative reconciliation owns reopening, subject
    /// to the current visibility and pending-delete state.
    fn navigate_remote(&self, record: &WindowRecord, retarget: Option<Retarget>) {
        let WindowOpener::Remote { conn } = &self.opener else {
            return;
        };
        let raise = retarget.is_some_and(Retarget::raises);
        let retarget = retarget.is_some();
        let app = self.app.clone();
        let conn = conn.clone();
        let record = record.clone();
        let gateway = self.opener.is_gateway();
        let builds = self.builds.clone();
        let remote_launches = Arc::clone(&self.remote_launches);
        let label = native_label(&record);
        let state = Arc::clone(self.app.state::<Arc<AppState>>().inner());
        let ticket =
            remote_launches.begin_remote(&record, gateway, retarget, &state.retarget_tickets);
        tauri::async_runtime::spawn(async move {
            let fail = {
                let remote_launches = Arc::clone(&remote_launches);
                let builds = builds.clone();
                let label = label.clone();
                let state = Arc::clone(&state);
                let ticket = ticket.clone();
                move |error: String| {
                    remote_launches.fail(
                        &label,
                        retarget,
                        &state.retarget_tickets,
                        ticket.as_ref(),
                        &builds,
                        error,
                    );
                }
            };
            let navigation = prepare_remote_navigation(
                crate::devserver::window_navigation_url(&conn, &record),
                || {
                    crate::devserver::install_gateway_webview_session(
                        &app,
                        &conn,
                        retarget.then_some(label.as_str()),
                    )
                },
            );
            if retarget {
                let ticket = ticket.as_ref().expect("retarget ticket");
                remote_launches
                    .run_retarget(
                        &label,
                        &state.retarget_tickets,
                        ticket,
                        &builds,
                        navigation,
                        |url| {
                            let app = &app;
                            let record = &record;
                            async move {
                                serve::retarget_watched_remote_window(
                                    app, &url, record, ticket, raise,
                                )
                                .await
                            }
                        },
                    )
                    .await;
                return;
            }
            let url = match navigation.await {
                Ok(url) => url,
                Err(e) => return fail(e),
            };
            // The completion runs on the main thread, where the window it
            // destroys was just built.
            let destroy = {
                let app = app.clone();
                let label = label.clone();
                move || {
                    if let Some(window) = app.get_webview_window(&label) {
                        let _ = window.destroy();
                    }
                }
            };
            remote_launches.build_resolved(&label, &builds, fail, destroy, |completion| {
                serve::open_watched_remote_window(&app, &url, &conn.name, &record, completion)
            });
        });
    }

    /// Reconcile one live window's OS title to what its record now says.
    ///
    /// The library record's caption is user-editable at any time, and the title
    /// is otherwise written once at build, so this is what makes a caption edit
    /// visible in the titlebar, the OS window switcher, and the Window menu's
    /// Open section (which reads the live title). Idempotent: it compares before
    /// writing, so the common reconcile -- nothing changed -- touches nothing.
    fn sync_title(&self, record: &WindowRecord) {
        let label = native_label(record);
        let devserver_name = match &self.opener {
            WindowOpener::Remote { conn } => Some(conn.name.clone()),
            WindowOpener::Local { .. } => None,
        };
        let desired = serve::watched_window_title(record, devserver_name.as_deref());
        if self.applied_titles.lock().unwrap().get(&label) == Some(&desired) {
            return;
        }
        let kind = serve::watched_window_kind(record).unwrap_or("workspace");
        let app = self.app.clone();
        let applied_titles = Arc::clone(&self.applied_titles);
        // Tauri window mutation (and `title()`) must run on the main thread.
        let _ = self.app.clone().run_on_main_thread(move || {
            let Some(window) = app.get_webview_window(&label) else {
                return;
            };
            let state = app.state::<Arc<AppState>>();
            // An explicit title override owns the titlebar outright; it is not
            // ours to overwrite.
            if state.window_title_override(&label).is_some() {
                return;
            }
            // Already correct -- the build path composed it. Record that so the
            // next reconcile skips this round trip.
            if window.title().is_ok_and(|current| current == desired) {
                applied_titles.lock().unwrap().insert(label, desired);
                return;
            }
            if let Err(e) = window.set_title(&desired) {
                tracing::warn!(window = %label, error = %e, "window watcher: retitling failed");
                return;
            }
            applied_titles
                .lock()
                .unwrap()
                .insert(label.clone(), desired.clone());
            // Keep the server-visible title map in step, so `GET /api/windows`
            // and `cs window list` report what the title bar shows.
            if let Some(embedded) = state.embedded() {
                embedded.window_titles().set(
                    &label,
                    chan_server::WindowMeta {
                        title: desired.clone(),
                        kind: Some(kind.to_string()),
                    },
                );
            }
            // The Open Windows section renders the live title, so it is now
            // stale.
            crate::rebuild_window_menu(&app);
        });
    }
}

impl NativeSurface for TauriNativeSurface {
    fn retain_attempts(&self, desired: &HashSet<String>, actual: &HashSet<String>) {
        self.remote_launches
            .retain_attempts(&self.builds, desired, actual);
    }

    fn retry_deadline(&self) -> Option<tokio::time::Instant> {
        self.remote_launches.retry_deadline(&self.builds)
    }

    fn retire(&self, stop: WatchLoopStop) {
        self.remote_launches.retire(&self.builds, stop);
    }

    fn open_labels(&self, library_id: &str) -> HashSet<String> {
        let prefix = format!("{library_id}::");
        let labels = self
            .app
            .webview_windows()
            .into_keys()
            .filter(|label| label.starts_with(&prefix))
            .collect();
        self.builds.open_labels(&prefix, labels)
    }

    fn open(&self, record: &WindowRecord) {
        // Mark the label in-flight BEFORE dispatching the (async) build, so a
        // reconcile that runs before the build lands won't re-open it.
        let label = native_label(record);
        if !self.builds.begin(record, self.opener.is_gateway()) {
            return;
        }
        match &self.opener {
            // The local builder dispatches to the Tauri main thread
            // internally, so this returns promptly.
            WindowOpener::Local { addr } => {
                let completion = self.builds.completion(label.clone());
                if let Err(error) =
                    serve::open_watched_local_window(&self.app, *addr, record, completion)
                {
                    self.builds.complete(&label, Err(error));
                }
            }
            // Remote builds resolve their navigation URL asynchronously
            // first (a gateway mint is an HTTP round trip); the in-flight
            // marker covers the whole gap.
            WindowOpener::Remote { .. } => self.navigate_remote(record, None),
        }
    }

    fn refresh(&self, record: &WindowRecord, reload: bool) {
        // The caption is editable while the window is open, so every reconcile
        // reconciles the OS title too -- for local windows as well, which have
        // no other reason to be refreshed.
        self.sync_title(record);
        if !self.opener.is_remote() {
            return;
        }
        let present = self.app.get_webview_window(&native_label(record)).is_some();
        if let Some(retarget) =
            self.remote_launches
                .admit(record, self.opener.is_gateway(), reload, present)
        {
            self.navigate_remote(record, Some(retarget));
        }
    }

    fn close(&self, label: &str) {
        // No longer in-flight (also covers a close before the build landed).
        self.builds.remove(label);
        self.remote_launches.forget(label);
        // A rebuilt window at this label starts from whatever the build path
        // composes, so a remembered title must not outlive the window.
        self.applied_titles.lock().unwrap().remove(label);
        // Destroying a window must run on the Tauri main thread.
        let app = self.app.clone();
        let dispatch = self.app.clone();
        let label_owned = label.to_string();
        let result = dispatch.run_on_main_thread(move || {
            if let Some(window) = app.get_webview_window(&label_owned) {
                let _ = window.destroy();
            }
        });
        if let Err(e) = result {
            tracing::warn!(window = %label, error = %e, "window watcher: closing a local window failed");
        }
    }
}

/// Spawn the local library's window watcher (one [`watch_loop`] for `"local"`),
/// living for the process lifetime. A no-op when the embedded server is not up.
pub(crate) fn spawn_local_window_watcher(app: AppHandle, state: Arc<AppState>) {
    let Some(embedded) = state.embedded() else {
        tracing::warn!("local window watcher not started: embedded server unavailable");
        return;
    };
    let addr = embedded.addr();
    let change = embedded.library_change_notify();
    let feed = LocalWindowFeed {
        state: Arc::clone(&state),
        change: Arc::clone(&change),
    };
    let view = Arc::new(WatcherViewState::default());
    let surface = TauriNativeSurface {
        app,
        opener: WindowOpener::Local { addr },
        builds: WindowBuilds::new(Arc::clone(&change), Arc::clone(&view)),
        remote_launches: Arc::new(RemoteLaunches::default()),
        applied_titles: Arc::new(Mutex::new(HashMap::new())),
    };
    // Share the view state so the desktop close handlers can bury/unbury
    // through the watcher, then hand the same Arc to the loop.
    state.set_local_watcher_view(Arc::clone(&view));
    // The local library lives for the whole process, so the watcher is never
    // cancelled -- `cancel` is a future that only resolves at process exit
    // (which drops the spawned task).
    tauri::async_runtime::spawn(watch_loop(
        Some(LOCAL_LIBRARY_ID),
        feed,
        surface,
        view,
        std::future::pending::<WatchLoopStop>(),
    ));
}

/// A connected devserver's window-set feed, pushed over the
/// `GET /api/library/windows/watch` WebSocket. A background task holds the
/// latest snapshot and wakes the watcher on every push; it reconnects on a
/// dropped socket (resubscribe + the idempotent reconcile self-heals).
struct DevserverWindowFeed {
    snapshot: Arc<Mutex<Vec<WindowRecord>>>,
    change: Arc<Notify>,
}

impl WindowFeed for DevserverWindowFeed {
    fn snapshot(&self) -> Vec<WindowRecord> {
        self.snapshot.lock().unwrap().clone()
    }

    fn change_notify(&self) -> Arc<Notify> {
        self.change.clone()
    }
}

type GatewayWs =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// The exact canonical external origin the gateway requires on every
/// cookie-authenticated upgrade. Shared with the reverse-tunnel sockets, which
/// ride the same hop.
pub(crate) fn gateway_ws_origin(conn: &DevserverConn) -> Result<&str, String> {
    conn.gateway
        .as_ref()
        .map(|gateway| gateway.proxy_origin.as_str())
        .ok_or_else(|| "not a gateway connection".to_string())
}

async fn gateway_ws_request(
    conn: &DevserverConn,
    path: &str,
) -> Result<
    (
        tokio_tungstenite::tungstenite::handshake::client::Request,
        String,
    ),
    String,
> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let url = crate::devserver::gateway_ws_url(conn, path)?;
    let mut request = url
        .into_client_request()
        .map_err(|e| format!("bad gateway watch url: {e}"))?;
    let cookie_header = crate::devserver::gateway_cookie_header(conn).await?;
    request.headers_mut().insert(
        "Cookie",
        cookie_header
            .clone()
            .parse()
            .map_err(|e| format!("bad gateway cookie header: {e}"))?,
    );
    request.headers_mut().insert(
        "Origin",
        gateway_ws_origin(conn)?
            .parse()
            .map_err(|e| format!("bad gateway origin header: {e}"))?,
    );
    Ok((request, cookie_header))
}

fn ws_auth_shaped(e: &tokio_tungstenite::tungstenite::Error) -> bool {
    matches!(
        e,
        tokio_tungstenite::tungstenite::Error::Http(resp)
            if matches!(resp.status().as_u16(), 401 | 404)
    )
}

async fn connect_gateway_ws(conn: &DevserverConn, path: &str) -> Result<GatewayWs, String> {
    let (request, cookie_header) = gateway_ws_request(conn, path).await?;
    match tokio_tungstenite::connect_async(request).await {
        Ok((ws, _)) => Ok(ws),
        Err(e) if ws_auth_shaped(&e) => {
            crate::devserver::refresh_gateway_session_if_current(conn, &cookie_header).await?;
            let (request, _) = gateway_ws_request(conn, path).await?;
            tokio_tungstenite::connect_async(request)
                .await
                .map(|(ws, _)| ws)
                .map_err(|e| format!("connect gateway watch after refresh: {e}"))
        }
        Err(e) => Err(format!("connect gateway watch: {e}")),
    }
}

/// The bearer upgrade request for `path` on a raw devserver: a `ws://` URL on
/// the dialed host and port plus `Authorization: Bearer <token>`. `what` names
/// the feed in the error for a URL the client rejects, so each feed's
/// reconnect log keeps its own wording. Gateway-backed devservers build theirs
/// through [`gateway_ws_request`] instead.
fn raw_ws_request(
    conn: &DevserverConn,
    path: &str,
    what: &str,
) -> Result<tokio_tungstenite::tungstenite::handshake::client::Request, String> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let mut request = format!("ws://{}:{}{path}", conn.host, conn.port)
        .into_client_request()
        .map_err(|e| format!("bad {what} url: {e}"))?;
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {}", conn.token)
            .parse()
            .map_err(|e| format!("bad bearer header: {e}"))?,
    );
    Ok(request)
}

/// Open `path` on a raw devserver with the bearer upgrade. `what` names the
/// feed in the URL error and `target` names it in the connect error; the two
/// reach the feed loop's reconnect log, which is why each feed keeps its own.
async fn connect_raw_ws(
    conn: &DevserverConn,
    path: &str,
    what: &str,
    target: &str,
) -> Result<GatewayWs, String> {
    let request = raw_ws_request(conn, path, what)?;
    tokio_tungstenite::connect_async(request)
        .await
        .map(|(ws, _)| ws)
        .map_err(|e| format!("connect {target}: {e}"))
}

/// Keepalive cadence for a devserver feed socket: send a WS Ping after this long
/// with no inbound frame. Well under the gateway proxy's 300s bridge idle cut, so
/// the Ping/Pong both keeps the tunnel warm and probes liveness.
const FEED_PING_INTERVAL: Duration = Duration::from_secs(30);
/// Consecutive ping intervals with NO inbound frame (not even a pong) before a
/// feed socket is declared a half-open zombie and the stream errors out.
const FEED_MAX_MISSED: u32 = 2;
/// Consecutive feed rounds that never received a frame (connect kept failing, or
/// the socket died before any data) before the devserver is marked Unreachable.
/// A round that gets a frame resets the count, so a transient drop that
/// reconnects never flips it -- only a persistent outage does.
const FEED_UNREACHABLE_AFTER: u32 = 2;

/// Floor on the wait between proactive session re-mints, so a gateway that
/// advertises a very short cookie lifetime cannot spin the refresh loop.
const GATEWAY_SESSION_MIN_REFRESH_INTERVAL: Duration = Duration::from_secs(15);
/// Wait before retrying a failed proactive re-mint. The gateway may be briefly
/// unreachable, and the session is still accepted for the safety margin already
/// subtracted from `expires_at`, so a prompt retry beats waiting a full lifetime.
const GATEWAY_SESSION_RETRY_INTERVAL: Duration = Duration::from_secs(15);

/// Re-mint a gateway connection's proxy session before it expires, until
/// `cancel` fires.
///
/// The proxy's session lifetime is a hard cap rather than a sliding window, and
/// the gate is checked on every HTTP request but only at upgrade for a
/// WebSocket. A feed socket therefore stays connected straight through the
/// expiry: nothing fails, so none of the reactive re-mint paths fire, and the
/// WebView's cookies quietly stop being accepted. Every request under that
/// window's tenant prefix then answers 404 -- the SPA's own API calls and any
/// extension asset alike -- while the window still looks connected. Refreshing
/// on a timer is what carries an open window across the cap.
async fn run_gateway_session_refresh(
    conn: DevserverConn,
    mut cancel: watch::Receiver<DevserverWatcherStop>,
) {
    loop {
        if (*cancel.borrow_and_update()).is_stopped() {
            return;
        }
        // `None` is a connection that does not reach a gateway -- every plain
        // loopback devserver -- so there is nothing to keep fresh.
        let Some(delay) = crate::devserver::gateway_session_refresh_delay(&conn) else {
            return;
        };
        tokio::select! {
            _ = cancel.changed() => return,
            _ = tokio::time::sleep(delay.max(GATEWAY_SESSION_MIN_REFRESH_INTERVAL)) => {}
        }
        if (*cancel.borrow_and_update()).is_stopped() {
            return;
        }
        let observed = crate::devserver::cached_gateway_cookie_header(&conn).unwrap_or_default();
        if let Err(error) =
            crate::devserver::refresh_gateway_session_if_current(&conn, &observed).await
        {
            // Routine while a machine is asleep or the gateway is briefly down.
            tracing::debug!(%error, "proactive gateway session refresh failed");
            tokio::select! {
                _ = cancel.changed() => return,
                _ = tokio::time::sleep(GATEWAY_SESSION_RETRY_INTERVAL) => {}
            }
        }
    }
}

/// Stream a devserver's window-set feed into `snapshot` + wake `change` on every
/// push, reconnecting on a dropped socket until `cancel` fires. The server
/// pushes a full snapshot on connect, so a drop self-heals on the next reconcile.
///
/// Feeds go half-open silently after a laptop sleep (the gateway proxy tears the
/// bridge down at its idle cut while the machine is frozen, and no FIN reaches
/// us), so a bare `next()` would pend forever and the launcher would show a
/// stale-but-green devserver. `stream_window_feed` keepalive-pings and errors out
/// on a dead socket; this loop counts consecutive rounds that never saw a frame
/// and, past `FEED_UNREACHABLE_AFTER`, marks the devserver `Unreachable` so the
/// launcher dot is honest. The flag clears on the next frame (recovery).
async fn run_devserver_window_feed(
    id: String,
    app: AppHandle,
    conn: DevserverConn,
    snapshot: Arc<Mutex<Vec<WindowRecord>>>,
    change: Arc<Notify>,
    state: Arc<AppState>,
    mut cancel: watch::Receiver<DevserverWatcherStop>,
) {
    use std::sync::atomic::{AtomicBool, Ordering};
    const RECONNECT_BACKOFF: Duration = Duration::from_secs(2);
    // One WARN per outage window, DEBUG in between: an offline devserver is a
    // routine long-lived state, and this loop retries every 2s for the app's
    // lifetime -- unthrottled WARNs would flood stderr while saying nothing new.
    const WARN_EVERY: Duration = Duration::from_secs(5 * 60);
    let mut last_warn: Option<std::time::Instant> = None;
    let mut consecutive_failures: u32 = 0;
    loop {
        // A `watch` (not a `Notify`) so the cancel PERSISTS: a disconnect that
        // flips it while we are between selects is still seen here, not missed.
        if (*cancel.borrow_and_update()).is_stopped() {
            return;
        }
        let saw_frame = AtomicBool::new(false);
        tokio::select! {
            _ = cancel.changed() => return,
            result = stream_window_feed(&id, &app, &conn, &snapshot, &change, &state, &saw_frame) => {
                if saw_frame.load(Ordering::Relaxed) {
                    // The feed delivered at least one frame this round: healthy.
                    consecutive_failures = 0;
                } else {
                    consecutive_failures = consecutive_failures.saturating_add(1);
                    // Persistent feed failure while the connection record still
                    // exists: a green machine icon would lie (the 5s workspace poll heals
                    // on fresh TCP). Mark Unreachable + raise attention on the
                    // real flip; entry_from_devserver renders the red icon off the
                    // flag, and it clears on the next frame inside the stream.
                    if consecutive_failures >= FEED_UNREACHABLE_AFTER
                        && state.devservers.is_connected(&id)
                        && state.devserver_feed.set_unreachable(&id, true)
                    {
                        let _ = app.emit(crate::DEVSERVER_CONTROL_ATTENTION_EVENT, id.clone());
                        if let Some(embedded) = state.embedded() {
                            embedded.signal_library_change();
                        }
                    }
                }
                if let Err(e) = result {
                    // WARN (rate-limited), not debug: a dead feed means no
                    // devserver window ever materializes and the launcher
                    // list goes stale -- the whole devserver surface is dark
                    // while this loops.
                    if last_warn.is_none_or(|t| t.elapsed() >= WARN_EVERY) {
                        last_warn = Some(std::time::Instant::now());
                        tracing::warn!(
                            host = %conn.host,
                            error = %e,
                            "devserver window feed disconnected; reconnecting",
                        );
                    } else {
                        tracing::debug!(
                            host = %conn.host,
                            error = %e,
                            "devserver window feed disconnected; reconnecting",
                        );
                    }
                }
            }
        }
        if (*cancel.borrow_and_update()).is_stopped() {
            return;
        }
        tokio::select! {
            _ = cancel.changed() => return,
            _ = tokio::time::sleep(RECONNECT_BACKOFF) => {}
        }
    }
}

/// Pump a devserver feed WS with a keepalive Ping + read-deadline. `on_text` runs
/// for each text frame; a clean close returns Ok; `max_missed` consecutive
/// `ping_interval` windows with NO inbound frame -- a half-open socket that a
/// laptop sleep leaves behind -- returns Err instead of a forever-pending
/// `next()`. The interval + threshold are parameters so a unit test can drive a
/// silent mock socket (short interval) without a real Tauri app/state.
async fn keepalive_pump(
    ws: &mut GatewayWs,
    ping_interval: Duration,
    max_missed: u32,
    mut on_text: impl FnMut(&str),
) -> Result<(), String> {
    use futures::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    let mut missed = 0u32;
    loop {
        match tokio::time::timeout(ping_interval, ws.next()).await {
            Ok(Some(message)) => {
                missed = 0;
                match message.map_err(|e| format!("watch stream: {e}"))? {
                    Message::Text(text) => on_text(&text),
                    Message::Close(_) => break,
                    // Pong (our keepalive answered), Ping (axum auto-pongs the
                    // peer's), Binary, Frame: not data, but arriving already reset
                    // `missed` -- proof the socket is alive.
                    _ => {}
                }
            }
            Ok(None) => break,
            Err(_) => {
                // No inbound for a whole interval: send a keepalive Ping. The
                // gateway bridge forwards Ping/Pong and axum auto-pongs, so a live
                // feed answers within the next interval; `max_missed` intervals
                // with nothing inbound is a half-open zombie.
                missed += 1;
                if missed > max_missed {
                    return Err("feed idle: no frame or pong within deadline".to_string());
                }
                ws.send(Message::Ping(Vec::new().into()))
                    .await
                    .map_err(|e| format!("feed keepalive ping: {e}"))?;
            }
        }
    }
    Ok(())
}

/// A `/watch` frame as the desktop reads it: the rows stay raw JSON until
/// [`decode_window_rows`](crate::devserver::decode_window_rows) takes them one
/// at a time, and the frame's other fields (the additive `leaders` map) are
/// not read here.
#[derive(serde::Deserialize)]
struct WindowFeedFrame {
    windows: Vec<serde_json::Value>,
}

/// The rows one `/watch` text frame carries that this desktop can read,
/// decoded against what the frame's connection remembers (`seen`). A frame
/// that does not parse at all is logged and yields `None`: the view keeps its
/// last snapshot, and the next frame, a full snapshot, repairs it.
fn decode_window_frame(
    devserver_id: &str,
    text: &str,
    seen: &mut ConnectionRows,
) -> Option<Vec<WindowRecord>> {
    match serde_json::from_str::<WindowFeedFrame>(text) {
        Ok(frame) => Some(crate::devserver::decode_window_rows(
            devserver_id,
            "watch frame",
            frame.windows,
            seen,
        )),
        Err(error) => {
            tracing::warn!(
                devserver = %devserver_id,
                %error,
                "unreadable devserver window frame is skipped; the view keeps its last snapshot"
            );
            None
        }
    }
}

/// Settle DELETEs already absent from a full feed snapshot, then claim one
/// retry attempt for each remaining close intent on the first snapshot of a
/// connection round. Later frames only settle state; they cannot create an
/// unbounded retry loop on a persistent 4xx.
fn pending_delete_attempts_for_feed_snapshot(
    pending: &PendingDeleteState,
    devserver_id: &str,
    windows: &[WindowRecord],
    first_snapshot: bool,
) -> Vec<PendingDeleteAttempt> {
    pending.settle_snapshot(devserver_id, windows);
    if first_snapshot {
        pending.begin_for_devserver(devserver_id)
    } else {
        Vec::new()
    }
}

/// One connection's lifetime: open the `/watch` WS, then push the rows this
/// desktop can read from every `WindowSet` text frame into `snapshot` + wake
/// `change`. Raw tunnel devservers auth with a bearer header; gateway
/// devservers auth with the devserver-gate cookie.
///
/// The [`keepalive_pump`] read-deadline turns a half-open socket into an error
/// instead of a forever-pending `next()`. `saw_frame` is set on the first inbound
/// frame so the caller can tell a healthy round from a never-connected one; the
/// first frame also clears any `Unreachable` state (recovery) and announces it.
async fn stream_window_feed(
    id: &str,
    app: &AppHandle,
    conn: &DevserverConn,
    snapshot: &Arc<Mutex<Vec<WindowRecord>>>,
    change: &Arc<Notify>,
    state: &Arc<AppState>,
    saw_frame: &std::sync::atomic::AtomicBool,
) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    let mut ws = if conn.gateway.is_some() {
        connect_gateway_ws(conn, "/api/library/windows/watch").await?
    } else {
        connect_raw_ws(conn, "/api/library/windows/watch", "watch", "/watch").await?
    };
    let mut saw_snapshot = false;
    let mut rows = ConnectionRows::default();
    keepalive_pump(&mut ws, FEED_PING_INTERVAL, FEED_MAX_MISSED, |text| {
        // Any inbound data frame means the feed is live. Mark it, and on the FIRST
        // such frame clear any Unreachable state so the launcher's red icon clears
        // the instant the feed reconnects, not at the next drop.
        if !saw_frame.swap(true, Ordering::Relaxed)
            && state.devserver_feed.set_unreachable(id, false)
        {
            let _ = app.emit(crate::DEVSERVER_CONTROL_RESTORED_EVENT, id.to_string());
            if let Some(embedded) = state.embedded() {
                embedded.signal_library_change();
            }
        }
        if let Some(windows) = decode_window_frame(id, text, &mut rows) {
            // Rows keep their devserver-local tokens: `should_show` reads
            // token emptiness as the tenant on/off signal, and gateway
            // navigation credentials are minted at open/retarget time
            // (`devserver::window_navigation_url`), never stamped into
            // the feed.
            let first_snapshot = !saw_snapshot;
            saw_snapshot = true;
            let pending_attempts = pending_delete_attempts_for_feed_snapshot(
                &state.pending_window_deletes,
                id,
                &windows,
                first_snapshot,
            );
            for attempt in pending_attempts {
                crate::spawn_pending_window_delete_attempt(
                    app.clone(),
                    Arc::clone(state),
                    conn.clone(),
                    attempt,
                );
            }
            // Refresh this library's active-transfer cache so the desktop
            // close guard can see a remote window's in-flight transfer (the
            // desktop sees no remote `/ws`; the feed bit is its only signal).
            // The library_id is constant per devserver; an empty snapshot
            // carries none, but then there are no windows to guard either.
            if let Some(library_id) = windows.first().map(|r| r.library_id.clone()) {
                let active: Vec<String> = windows
                    .iter()
                    .filter(|r| r.active_transfer)
                    .map(native_label)
                    .collect();
                state.refresh_devserver_active_transfers(&library_id, &active);
            }
            *snapshot.lock().unwrap() = windows;
            // Re-push the launcher feed: a devserver window change
            // shifts the merged launcher window set, so signal the embedded
            // host to re-assemble + re-push. The devserver only pushes on a
            // real change, so this is already change-gated.
            if let Some(embedded) = state.embedded() {
                embedded.signal_library_change();
            }
            change.notify_one();
        }
    })
    .await
}

/// Subscribe to a connected devserver's pane-highlight COLOUR feed
/// (`GET /api/library/local-color/watch`): on each `{ color }` push,
/// refresh the launcher's per-devserver colour cache and -- only on a real
/// change -- re-push the library feed, so a NEW window of this devserver
/// reads the fresh `?pane=` colour at build. The workspace list is polled
/// because there is no `workspaces/watch`. Reconnects on a dropped socket
/// until `cancel` leaves `Running` or its sender drops, like the window feed.
pub(crate) fn spawn_devserver_color_watch(
    state: Arc<AppState>,
    id: String,
    conn: DevserverConn,
    mut cancel: watch::Receiver<DevserverWatcherStop>,
) {
    const RECONNECT_BACKOFF: Duration = Duration::from_secs(2);
    tauri::async_runtime::spawn(async move {
        loop {
            if (*cancel.borrow_and_update()).is_stopped() {
                return;
            }
            tokio::select! {
                _ = cancel.changed() => return,
                result = stream_color_feed(&state, &id, &conn) => {
                    if let Err(e) = result {
                        tracing::debug!(
                            devserver = %id,
                            error = %e,
                            "devserver colour feed disconnected; reconnecting",
                        );
                    }
                }
            }
            if (*cancel.borrow_and_update()).is_stopped() {
                return;
            }
            tokio::select! {
                _ = cancel.changed() => return,
                _ = tokio::time::sleep(RECONNECT_BACKOFF) => {}
            }
        }
    });
}

/// One `{ color }` frame of the devserver colour watch.
#[derive(serde::Deserialize)]
struct LocalColorFrame {
    color: Option<String>,
}

/// One connection's lifetime on the devserver colour watch: raw devservers auth
/// with bearer; gateway devservers auth with the devserver-gate cookie. Each
/// `{ color }` frame refreshes the per-devserver colour cache, re-pushing the
/// launcher feed only on a real change.
async fn stream_color_feed(
    state: &Arc<AppState>,
    id: &str,
    conn: &DevserverConn,
) -> Result<(), String> {
    let mut ws = if conn.gateway.is_some() {
        connect_gateway_ws(conn, "/api/library/local-color/watch").await?
    } else {
        connect_raw_ws(
            conn,
            "/api/library/local-color/watch",
            "colour watch",
            "colour watch",
        )
        .await?
    };
    // Same keepalive Ping + read-deadline as the window feed so a half-open
    // colour socket self-heals instead of pending forever. The colour feed does
    // NOT drive the Unreachable flag (the window feed owns it -- one writer).
    keepalive_pump(&mut ws, FEED_PING_INTERVAL, FEED_MAX_MISSED, |text| {
        if let Ok(frame) = serde_json::from_str::<LocalColorFrame>(text) {
            if state.devserver_feed.set_color(id.to_string(), frame.color) {
                if let Some(embedded) = state.embedded() {
                    embedded.signal_library_change();
                }
            }
        }
    })
    .await
}

/// Spawn a connected devserver's window watcher: one [`watch_loop`] driven by the
/// devserver's `/api/library/windows/watch` feed, opening windows as remote SPA
/// webviews. Returns the `cancel` (a `watch::Sender`) -- send
/// [`DevserverWatcherStop::CloseWindows`] on disconnect, or
/// [`DevserverWatcherStop::RetireKeepWindows`] from
/// `mark_devserver_control_exited` when the control process exits.
///
/// The `library_id` (`lib-<hex>`) is NOT needed up front: an EMPTY feed is valid
/// (a devserver with no windows, or one the user emptied before disconnecting),
/// so the watcher learns the id LAZILY from the first record (`watch_loop`). The
/// initial seed is best-effort -- an empty or failed fetch is fine; the `/watch`
/// WS pushes the authoritative snapshot on connect.
pub(crate) async fn spawn_devserver_window_watcher(
    id: String,
    app: AppHandle,
    conn: DevserverConn,
) -> Result<
    (
        watch::Sender<DevserverWatcherStop>,
        Arc<Mutex<Vec<WindowRecord>>>,
        Arc<WatcherViewState>,
    ),
    String,
> {
    let seed = crate::devserver::fetch_library_windows(&id, &conn)
        .await
        .unwrap_or_else(|error| {
            tracing::warn!(
                devserver = %id,
                %error,
                "devserver window list failed; seeding no windows until the watch feed's first snapshot"
            );
            Vec::new()
        });
    let snapshot = Arc::new(Mutex::new(seed));
    // A handle on the snapshot for the caller's launcher feed: the same
    // Arc the feed task mutates, so the launcher reads this devserver's live windows.
    let snapshot_handle = Arc::clone(&snapshot);
    let change = Arc::new(Notify::new());
    let (cancel_tx, cancel_rx) = watch::channel(DevserverWatcherStop::Running);
    // Shared state so the feed task can refresh the active-transfer cache the
    // close guard reads for this devserver's windows.
    let state = Arc::clone(app.state::<Arc<AppState>>().inner());
    let pending_deletes = Arc::clone(&state.pending_window_deletes);
    // The WS feed task owns a `conn` clone, pushes changes into `snapshot` +
    // wakes `change`, and stops when `cancel` leaves `Running` or its sender
    // drops.
    tauri::async_runtime::spawn(run_devserver_window_feed(
        id,
        app.clone(),
        conn.clone(),
        Arc::clone(&snapshot),
        Arc::clone(&change),
        state,
        cancel_rx.clone(),
    ));
    // Shares the feed's lifetime and stop signal: the feed socket survives a
    // session expiry silently, so nothing else on this connection would notice
    // the cap passing.
    tauri::async_runtime::spawn(run_gateway_session_refresh(conn.clone(), cancel_rx.clone()));
    let view = Arc::new(WatcherViewState::with_pending_deletes(pending_deletes));
    let surface = TauriNativeSurface {
        app,
        opener: WindowOpener::Remote { conn },
        builds: WindowBuilds::new(Arc::clone(&change), Arc::clone(&view)),
        remote_launches: Arc::new(RemoteLaunches::default()),
        applied_titles: Arc::new(Mutex::new(HashMap::new())),
    };
    let feed = DevserverWindowFeed { snapshot, change };
    // A handle on the view for the caller so the close handler can bury THIS
    // devserver's windows through it: a bury flips `should_show` false and
    // the reconcile CLOSES the webview (drops the `/ws`), so the launcher dot
    // reflects hidden -- unlike a bare `window.hide()`, which keeps the `/ws` live.
    let view_handle = Arc::clone(&view);
    let mut cancel_loop = cancel_rx;
    tauri::async_runtime::spawn(watch_loop(None, feed, surface, view, async move {
        loop {
            let stop = *cancel_loop.borrow_and_update();
            if let Some(stop) = stop.watch_loop_stop() {
                return stop;
            }
            if cancel_loop.changed().await.is_err() {
                return WatchLoopStop::CloseWindows;
            }
        }
    }));
    Ok((cancel_tx, snapshot_handle, view_handle))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec() -> WindowRecord {
        WindowRecord {
            window_id: "w-1".into(),
            library_id: "lib-test".into(),
            kind: chan_server::WindowKind::Terminal,
            title: "Terminal".into(),
            ordinal: 1,
            label: String::new(),
            workspace_path: None,
            prefix: "/terminal".into(),
            token: "tok-1".into(),
            persisted: true,
            connected: false,
            active_transfer: false,
            control: false,
            hidden: false,
            origin: chan_server::WindowOrigin::Native,
        }
    }

    struct BuildSurface {
        builds: WindowBuilds,
        opens: std::cell::Cell<usize>,
        completion: std::cell::RefCell<Option<BuildCompletion>>,
    }

    impl NativeSurface for BuildSurface {
        fn open_labels(&self, library_id: &str) -> HashSet<String> {
            self.builds
                .open_labels(&format!("{library_id}::"), HashSet::new())
        }
        fn open(&self, record: &WindowRecord) {
            let label = native_label(record);
            if !self.builds.begin(record, false) {
                return;
            }
            self.opens.set(self.opens.get() + 1);
            *self.completion.borrow_mut() = Some(self.builds.completion(label));
        }
        fn close(&self, label: &str) {
            self.builds.remove(label);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn failed_window_build_reopens_after_its_dispatch_deadline() {
        let surface = BuildSurface {
            builds: WindowBuilds::new(
                Arc::new(Notify::new()),
                Arc::new(WatcherViewState::default()),
            ),
            opens: std::cell::Cell::new(0),
            completion: std::cell::RefCell::new(None),
        };
        let record = rec();
        let label = native_label(&record);
        let reconcile = || {
            crate::window_watcher::reconcile(
                &record.library_id,
                std::slice::from_ref(&record),
                &HashSet::new(),
                &surface,
            )
        };
        reconcile();
        reconcile();
        assert_eq!(surface.opens.get(), 1, "a pending build is not duplicated");
        surface.completion.borrow_mut().take().unwrap()(Err("native builder failed".into()));
        assert!(
            !surface.builds.contains(&label),
            "a failed native build must release the pending label"
        );
        reconcile();
        assert_eq!(
            surface.opens.get(),
            1,
            "a failed build must keep its dispatch deadline"
        );
        tokio::time::advance(RETRY_NUDGE).await;
        reconcile();
        assert_eq!(surface.opens.get(), 2, "the desired window must be retried");
        // A successful retry leaves only the observed native window in the set.
        surface.completion.borrow_mut().take().unwrap()(Ok(()));
        assert!(!surface.builds.contains(&label));
        assert_eq!(
            surface
                .builds
                .open_labels("lib-test::", HashSet::from([label.clone()])),
            HashSet::from([label])
        );
    }

    #[tokio::test(start_paused = true)]
    async fn failed_window_build_retries_without_a_feed_change() {
        let record = retry_record("native-build-timer", 0);
        let harness = RetryHarness::start(vec![record.clone()], true, false).await;
        tokio::time::advance(RETRY_NUDGE).await;
        for _ in 0..100 {
            tokio::task::yield_now().await;
        }
        assert_eq!(
            harness.times(&record),
            vec![0, 15],
            "a failed build must retry without a feed change"
        );
        harness.stop(WatchLoopStop::CloseWindows).await;
    }

    #[derive(Clone)]
    struct RetryFeed {
        records: Arc<Mutex<Vec<WindowRecord>>>,
        nudge: Arc<Notify>,
        reads: Arc<std::sync::atomic::AtomicUsize>,
    }

    impl WindowFeed for RetryFeed {
        fn snapshot(&self) -> Vec<WindowRecord> {
            self.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.records.lock().unwrap().clone()
        }
        fn change_notify(&self) -> Arc<Notify> {
            Arc::clone(&self.nudge)
        }
    }

    struct RetrySurface {
        launches: RemoteLaunches,
        builds: WindowBuilds,
        tickets: serve::RetargetTickets,
        live: Mutex<HashSet<String>>,
        attempts: Mutex<Vec<(String, tokio::time::Instant)>>,
        held: Mutex<Vec<(String, serve::RetargetTicket)>>,
        hold: std::sync::atomic::AtomicBool,
        // Opens held by the test: first while their URL resolves, then as
        // builds queued on the main thread.
        hold_opens: bool,
        resolving: Mutex<Vec<String>>,
        queued: Mutex<Vec<(String, BuildCompletion)>>,
        // Whether each retarget dispatch raises its window, in order.
        raises: Mutex<Vec<(String, bool)>>,
        // What each window's webview reports as its own URL.
        urls: Mutex<HashMap<String, String>>,
    }

    impl RetrySurface {
        /// Finish every held open's URL resolution through the production
        /// marker check, queueing its build.
        fn resolve_opens(self: &Arc<Self>) {
            let labels = std::mem::take(&mut *self.resolving.lock().unwrap());
            for label in labels {
                let fail = {
                    let surface = Arc::clone(self);
                    let label = label.clone();
                    move |error: String| {
                        surface.launches.fail(
                            &label,
                            false,
                            &surface.tickets,
                            None,
                            &surface.builds,
                            error,
                        )
                    }
                };
                let destroy = {
                    let surface = Arc::clone(self);
                    let label = label.clone();
                    move || {
                        surface.live.lock().unwrap().remove(&label);
                    }
                };
                self.launches
                    .build_resolved(&label, &self.builds, fail, destroy, |completion| {
                        self.queued
                            .lock()
                            .unwrap()
                            .push((label.clone(), completion));
                        Ok(())
                    });
            }
        }

        /// Run every queued build on the main thread: the window exists
        /// before its completion runs.
        fn land_builds(&self) {
            let queued = std::mem::take(&mut *self.queued.lock().unwrap());
            for (label, completion) in queued {
                self.live.lock().unwrap().insert(label);
                completion(Ok(()));
            }
        }
    }

    impl NativeSurface for Arc<RetrySurface> {
        fn retain_attempts(&self, desired: &HashSet<String>, actual: &HashSet<String>) {
            self.launches.retain_attempts(&self.builds, desired, actual);
        }

        fn retry_deadline(&self) -> Option<tokio::time::Instant> {
            self.launches.retry_deadline(&self.builds)
        }

        fn retire(&self, stop: WatchLoopStop) {
            self.launches.retire(&self.builds, stop);
        }

        fn open_labels(&self, library_id: &str) -> HashSet<String> {
            self.builds.open_labels(
                &format!("{library_id}::"),
                self.live.lock().unwrap().clone(),
            )
        }
        fn open(&self, record: &WindowRecord) {
            let label = native_label(record);
            if !self.builds.begin(record, false) {
                return;
            }
            self.attempts
                .lock()
                .unwrap()
                .push((label.clone(), tokio::time::Instant::now()));
            if self.hold_opens {
                self.launches
                    .begin_remote(record, false, false, &self.tickets);
                self.resolving.lock().unwrap().push(label);
                return;
            }
            self.builds
                .complete(&label, Err("native build refused".into()));
        }
        fn refresh(&self, record: &WindowRecord, reload: bool) {
            let label = native_label(record);
            let present = self.live.lock().unwrap().contains(&label);
            let Some(retarget) = self.launches.admit(record, false, reload, present) else {
                return;
            };
            self.raises
                .lock()
                .unwrap()
                .push((label.clone(), retarget.raises()));
            let ticket = self
                .launches
                .begin_remote(record, false, true, &self.tickets)
                .unwrap();
            self.attempts
                .lock()
                .unwrap()
                .push((label.clone(), tokio::time::Instant::now()));
            if self.hold.load(std::sync::atomic::Ordering::SeqCst) {
                self.held.lock().unwrap().push((label, ticket));
            } else {
                self.launches.finish_retarget(
                    &label,
                    &self.tickets,
                    &ticket,
                    &self.builds,
                    Ok(serve::RetargetOutcome::NotReady),
                );
            }
        }
        fn close(&self, label: &str) {
            self.builds.remove(label);
            self.launches.forget(label);
            self.live.lock().unwrap().remove(label);
            self.tickets.cancel(label);
        }
    }

    struct RetryHarness {
        feed: RetryFeed,
        surface: Arc<RetrySurface>,
        view: Arc<WatcherViewState>,
        pending_deletes: Arc<PendingDeleteState>,
        stop: tokio::sync::oneshot::Sender<WatchLoopStop>,
        task: tokio::task::JoinHandle<()>,
        started: tokio::time::Instant,
    }

    impl RetryHarness {
        async fn start(records: Vec<WindowRecord>, build: bool, hold: bool) -> Self {
            Self::start_with(records, build, hold, false).await
        }

        async fn start_with(
            records: Vec<WindowRecord>,
            build: bool,
            hold: bool,
            hold_opens: bool,
        ) -> Self {
            let library_id = records[0].library_id.clone();
            let nudge = Arc::new(Notify::new());
            let feed = RetryFeed {
                records: Arc::new(Mutex::new(records.clone())),
                nudge: Arc::clone(&nudge),
                reads: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            };
            let pending_deletes = Arc::new(PendingDeleteState::default());
            let view = Arc::new(WatcherViewState::with_pending_deletes(Arc::clone(
                &pending_deletes,
            )));
            let surface = Arc::new(RetrySurface {
                launches: RemoteLaunches::default(),
                builds: WindowBuilds::new(nudge, Arc::clone(&view)),
                tickets: serve::RetargetTickets::default(),
                live: Mutex::new(if build {
                    HashSet::new()
                } else {
                    records.iter().map(native_label).collect()
                }),
                attempts: Mutex::new(Vec::new()),
                held: Mutex::new(Vec::new()),
                hold: std::sync::atomic::AtomicBool::new(hold),
                hold_opens,
                resolving: Mutex::new(Vec::new()),
                queued: Mutex::new(Vec::new()),
                raises: Mutex::new(Vec::new()),
                urls: Mutex::new(HashMap::new()),
            });
            let (stop, stopped) = tokio::sync::oneshot::channel();
            let task = tokio::spawn({
                let feed = feed.clone();
                let surface = Arc::clone(&surface);
                let view = Arc::clone(&view);
                async move {
                    watch_loop(Some(&library_id), feed, surface, view, async {
                        stopped.await.unwrap()
                    })
                    .await;
                }
            });
            let harness = Self {
                feed,
                surface,
                view,
                pending_deletes,
                stop,
                task,
                started: tokio::time::Instant::now(),
            };
            harness.after_pass(0).await;
            harness
        }

        async fn after_pass(&self, previous: usize) {
            for _ in 0..100 {
                tokio::task::yield_now().await;
                if self.feed.reads.load(std::sync::atomic::Ordering::SeqCst) > previous {
                    return;
                }
            }
            panic!("the production watch loop must reconcile after its wake");
        }

        async fn feed_wake(&self) {
            let previous = self.feed.reads.load(std::sync::atomic::Ordering::SeqCst);
            self.feed.nudge.notify_one();
            self.after_pass(previous).await;
        }

        async fn view_wake(&self) {
            let previous = self.feed.reads.load(std::sync::atomic::Ordering::SeqCst);
            self.view.unbury("lib-unused::w-other");
            self.after_pass(previous).await;
        }

        fn times(&self, record: &WindowRecord) -> Vec<u64> {
            let label = native_label(record);
            self.surface
                .attempts
                .lock()
                .unwrap()
                .iter()
                .filter(|(window, _)| *window == label)
                .map(|(_, at)| at.duration_since(self.started).as_secs())
                .collect()
        }

        async fn stop(self, stop: WatchLoopStop) -> Arc<RetrySurface> {
            self.stop.send(stop).unwrap();
            self.task.await.unwrap();
            self.surface
        }
    }

    fn retry_record(library: &str, index: usize) -> WindowRecord {
        WindowRecord {
            library_id: format!("lib-{library}"),
            window_id: format!("w-{index}"),
            ..rec()
        }
    }

    impl RetryHarness {
        fn request_reload(
            &self,
            record: &WindowRecord,
            connected: bool,
            view: Option<&WatcherViewState>,
        ) -> bool {
            request_devserver_reload(&native_label(record), connected, view)
        }

        fn finish_requested(
            &self,
            record: &WindowRecord,
            ticket: &serve::RetargetTicket,
            outcome: Result<serve::RetargetOutcome, String>,
        ) {
            self.surface.launches.finish_retarget(
                &native_label(record),
                &self.surface.tickets,
                ticket,
                &self.surface.builds,
                outcome,
            );
        }

        fn waiting_since(&self, record: &WindowRecord, second: u64) {
            let state = self.surface.launches.0.lock().unwrap();
            assert_eq!(
                state.entries.len(),
                1,
                "one window keeps exactly one attempt"
            );
            let attempt = state.entries.get(&native_label(record)).unwrap();
            assert!(
                attempt.phase == LaunchPhase::Waiting,
                "the newest refusal must leave the watcher waiting"
            );
            assert_eq!(
                attempt.key,
                RemoteLaunchKey::from_record(record, false),
                "the newest target keeps retry ownership"
            );
            assert_eq!(
                attempt.attempted_at.duration_since(self.started).as_secs(),
                second,
                "the newest dispatch sets the automatic retry deadline"
            );
        }

        async fn drain(&self) {
            for _ in 0..100 {
                tokio::task::yield_now().await;
            }
        }

        fn raised(&self, record: &WindowRecord) -> Vec<bool> {
            let label = native_label(record);
            self.surface
                .raises
                .lock()
                .unwrap()
                .iter()
                .filter(|(window, _)| *window == label)
                .map(|(_, raised)| *raised)
                .collect()
        }

        fn show_url(&self, record: &WindowRecord, url: &str) {
            self.surface
                .urls
                .lock()
                .unwrap()
                .insert(native_label(record), url.to_string());
        }

        fn applied(&self, record: &WindowRecord) -> bool {
            self.surface
                .launches
                .0
                .lock()
                .unwrap()
                .entries
                .get(&native_label(record))
                .is_some_and(|attempt| attempt.phase == LaunchPhase::Applied)
        }

        /// Settle the first pass's held retarget of a live window as
        /// navigated.
        async fn navigate_first(&self, record: &WindowRecord) {
            let (_, ticket) = self.surface.held.lock().unwrap().pop().unwrap();
            self.finish_requested(record, &ticket, Ok(serve::RetargetOutcome::Navigated));
            self.drain().await;
        }

        /// A Reload at t=5 that finds its target not ready, then the page
        /// reporting `url` (none: unreadable) when the timer's try comes due
        /// at t=20.
        async fn refused_reload_then_timer(&self, record: &WindowRecord, url: Option<&str>) {
            tokio::time::advance(Duration::from_secs(5)).await;
            assert!(self.request_reload(record, true, Some(&self.view)));
            self.drain().await;
            let (_, ticket) = self.surface.held.lock().unwrap().pop().unwrap();
            self.finish_requested(record, &ticket, Ok(serve::RetargetOutcome::NotReady));
            self.drain().await;
            self.waiting_since(record, 5);
            match url {
                Some(url) => self.show_url(record, url),
                None => {
                    self.surface
                        .urls
                        .lock()
                        .unwrap()
                        .remove(&native_label(record));
                }
            }
            tokio::time::advance(RETRY_NUDGE).await;
            self.drain().await;
        }
    }

    // What a devserver window's webview is assumed to report as its URL, read
    // in the code and not on a display. WebKitGTK's `uri`, WKWebView's `URL`
    // and WebView2's source all follow a same-document `replaceState`, and the
    // SPA deletes its `t` pair that way when it boots and writes its layout
    // into the fragment. So a booted page reports its target without `t`; a
    // page that never booted still carries `t`, and the connecting page
    // reports its bundled asset.
    const BOOTED_URL: &str = "http://127.0.0.1:4100/terminal/index.html?w=w-0&kind=terminal#l=1";
    const UNBOOTED_URL: &str = "http://127.0.0.1:4100/terminal/index.html?t=tok-1&w=w-0";
    const CONNECTING_URL: &str = "tauri://localhost/connecting.html";

    async fn reload_race(reload_first: bool, newer_finishes_first: bool) {
        let mut record = retry_record(
            if reload_first {
                "reload-then-feed"
            } else {
                "feed-then-reload"
            },
            usize::from(newer_finishes_first),
        );
        let harness = RetryHarness::start(vec![record.clone()], false, true).await;
        let (_, initial) = harness.surface.held.lock().unwrap().pop().unwrap();
        let first = if reload_first {
            harness.surface.launches.finish_retarget(
                &native_label(&record),
                &harness.surface.tickets,
                &initial,
                &harness.surface.builds,
                Ok(serve::RetargetOutcome::Navigated),
            );
            harness.drain().await;
            tokio::time::advance(Duration::from_secs(5)).await;
            assert!(harness.request_reload(&record, true, Some(&harness.view)));
            harness.drain().await;
            harness.surface.held.lock().unwrap().pop().unwrap().1
        } else {
            initial
        };
        tokio::time::advance(Duration::from_secs(if reload_first { 1 } else { 5 })).await;
        if reload_first {
            record.token = "new-feed-token".into();
            *harness.feed.records.lock().unwrap() = vec![record.clone()];
            harness.feed_wake().await;
        } else {
            assert!(harness.request_reload(&record, true, Some(&harness.view)));
            harness.drain().await;
        }
        let (_, second) = harness.surface.held.lock().unwrap().pop().unwrap();
        for newer in [newer_finishes_first, !newer_finishes_first] {
            let ticket = if newer { &second } else { &first };
            if newer != reload_first {
                harness.finish_requested(&record, ticket, Ok(serve::RetargetOutcome::NotReady));
            } else {
                harness.surface.launches.finish_retarget(
                    &native_label(&record),
                    &harness.surface.tickets,
                    ticket,
                    &harness.surface.builds,
                    Ok(serve::RetargetOutcome::NotReady),
                );
            }
            harness.drain().await;
        }
        let last = if reload_first { 6 } else { 5 };
        harness.waiting_since(&record, last);
        let expected = if reload_first {
            vec![0, 5, 6]
        } else {
            vec![0, 5]
        };
        tokio::time::advance(Duration::from_secs(14)).await;
        harness.drain().await;
        assert_eq!(
            harness.times(&record),
            expected,
            "stale completion cannot advance the newer deadline"
        );
        tokio::time::advance(Duration::from_secs(1)).await;
        harness.drain().await;
        let mut expected = expected;
        expected.push(last + 15);
        assert_eq!(
            harness.times(&record),
            expected,
            "the newest refusal must retry automatically at its dispatch deadline"
        );
        harness.stop(WatchLoopStop::KeepWindows).await;
    }

    #[tokio::test(start_paused = true)]
    async fn reload_after_watcher_old_completion_first() {
        reload_race(false, false).await;
    }
    #[tokio::test(start_paused = true)]
    async fn reload_after_watcher_new_completion_first() {
        reload_race(false, true).await;
    }
    #[tokio::test(start_paused = true)]
    async fn reload_before_feed_old_completion_first() {
        reload_race(true, false).await;
    }
    #[tokio::test(start_paused = true)]
    async fn reload_before_feed_new_completion_first() {
        reload_race(true, true).await;
    }

    #[tokio::test(start_paused = true)]
    async fn reload_inside_interval_resets_automatic_deadline() {
        let record = retry_record("reload-interval", 0);
        let harness = RetryHarness::start(vec![record.clone()], false, false).await;
        harness
            .surface
            .hold
            .store(true, std::sync::atomic::Ordering::SeqCst);
        tokio::time::advance(Duration::from_secs(5)).await;
        assert!(harness.request_reload(&record, true, Some(&harness.view)));
        harness.drain().await;
        assert_eq!(
            harness.times(&record),
            vec![0, 5],
            "Reload bypasses the same-target interval"
        );
        let (_, ticket) = harness.surface.held.lock().unwrap().pop().unwrap();
        harness.finish_requested(&record, &ticket, Ok(serve::RetargetOutcome::NotReady));
        harness.drain().await;
        harness.waiting_since(&record, 5);
        tokio::time::advance(Duration::from_secs(1)).await;
        harness.feed_wake().await;
        assert_eq!(
            harness.times(&record),
            vec![0, 5],
            "an unrelated wake adds no requested attempt"
        );
        tokio::time::advance(Duration::from_secs(13)).await;
        harness.drain().await;
        assert_eq!(harness.times(&record), vec![0, 5]);
        tokio::time::advance(Duration::from_secs(1)).await;
        harness.drain().await;
        assert_eq!(
            harness.times(&record),
            vec![0, 5, 20],
            "Reload owns the next fifteen-second interval"
        );
        harness.stop(WatchLoopStop::KeepWindows).await;
    }

    #[tokio::test(start_paused = true)]
    async fn reload_requests_coalesce_until_the_next_pass() {
        let record = retry_record("reload-coalesce", 0);
        let harness = RetryHarness::start(vec![record.clone()], false, true).await;
        tokio::time::advance(Duration::from_secs(5)).await;
        for _ in 0..3 {
            assert!(harness.request_reload(&record, true, Some(&harness.view)));
        }
        assert_eq!(
            harness.times(&record),
            vec![0],
            "Reload queues without dispatching before the watcher pass"
        );
        harness.drain().await;
        assert_eq!(
            harness.times(&record),
            vec![0, 5],
            "one pass consumes repeated Reload requests once"
        );
        harness.feed_wake().await;
        assert_eq!(
            harness.times(&record),
            vec![0, 5],
            "a consumed request does not survive the pass"
        );
        harness.stop(WatchLoopStop::KeepWindows).await;
    }

    async fn requested_failure(failure: &str) {
        let record = retry_record(&format!("reload-{failure}"), 0);
        let harness = RetryHarness::start(vec![record.clone()], false, true).await;
        let (_, initial) = harness.surface.held.lock().unwrap().pop().unwrap();
        harness.surface.launches.finish_retarget(
            &native_label(&record),
            &harness.surface.tickets,
            &initial,
            &harness.surface.builds,
            Ok(serve::RetargetOutcome::Navigated),
        );
        harness.drain().await;
        tokio::time::advance(Duration::from_secs(5)).await;
        assert!(harness.request_reload(&record, true, Some(&harness.view)));
        harness.drain().await;
        let (_, ticket) = harness.surface.held.lock().unwrap().pop().unwrap();
        let installs = std::cell::Cell::new(0);
        let navigations = std::cell::Cell::new(0);
        let prepared = prepare_remote_navigation(
            std::future::ready(if failure == "resolve" {
                Err("resolve".into())
            } else {
                Ok("https://test.invalid/".into())
            }),
            || {
                installs.set(installs.get() + 1);
                if failure == "session" {
                    Err("session".into())
                } else {
                    Ok(())
                }
            },
        );
        harness
            .surface
            .launches
            .run_retarget(
                &native_label(&record),
                &harness.surface.tickets,
                &ticket,
                &harness.surface.builds,
                prepared,
                |_| {
                    navigations.set(navigations.get() + 1);
                    std::future::ready(Err("navigation".into()))
                },
            )
            .await;
        assert_eq!(
            installs.get(),
            u32::from(failure != "resolve"),
            "resolution failure must skip session installation"
        );
        assert_eq!(
            navigations.get(),
            u32::from(failure == "navigation"),
            "preparation failure must skip native navigation"
        );
        harness.drain().await;
        harness.waiting_since(&record, 5);
        tokio::time::advance(Duration::from_secs(15)).await;
        harness.drain().await;
        assert_eq!(
            harness.times(&record),
            vec![0, 5, 20],
            "{failure}: a requested failure keeps an automatic retry"
        );
        harness.stop(WatchLoopStop::KeepWindows).await;
    }
    #[tokio::test(start_paused = true)]
    async fn reload_resolve_failure_keeps_retry() {
        requested_failure("resolve").await;
    }
    #[tokio::test(start_paused = true)]
    async fn reload_session_failure_keeps_retry() {
        requested_failure("session").await;
    }
    #[tokio::test(start_paused = true)]
    async fn reload_navigation_failure_keeps_retry() {
        requested_failure("navigation").await;
    }

    async fn rejected_reload(action: &str) {
        let record = retry_record(&format!("reload-{action}"), 0);
        let harness = RetryHarness::start(vec![record.clone()], false, false).await;
        harness.drain().await;
        let label = native_label(&record);
        match action {
            "gone" => {
                harness.surface.live.lock().unwrap().remove(&label);
            }
            "removed" => harness.feed.records.lock().unwrap().clear(),
            "closed" => {
                harness.pending_deletes.queue("test-connection", &record);
                harness.view.bury(&label);
                harness.surface.close(&label);
            }
            "buried" => harness.view.bury(&label),
            "hidden" => harness.feed.records.lock().unwrap()[0].hidden = true,
            "delete" => harness.pending_deletes.queue("test-connection", &record),
            _ => unreachable!(),
        }
        assert!(harness.request_reload(&record, true, Some(&harness.view)));
        harness.drain().await;
        assert_eq!(
            harness.times(&record),
            vec![0],
            "{action}: a Reload must neither dispatch nor build an ineligible window"
        );
        // A bare native disappearance leaves a desired feed record. Only a
        // later authoritative feed wake may rebuild it.
        if action != "gone" {
            tokio::time::advance(Duration::from_secs(60)).await;
            harness.feed_wake().await;
            assert_eq!(harness.times(&record), vec![0]);
        }
        harness.stop(WatchLoopStop::CloseWindows).await;
    }
    #[tokio::test(start_paused = true)]
    async fn reload_does_not_build_a_gone_window() {
        rejected_reload("gone").await;
    }
    #[tokio::test(start_paused = true)]
    async fn reload_does_not_dispatch_a_removed_record() {
        rejected_reload("removed").await;
    }
    #[tokio::test(start_paused = true)]
    async fn reload_does_not_dispatch_a_closed_window() {
        rejected_reload("closed").await;
    }
    #[tokio::test(start_paused = true)]
    async fn reload_does_not_dispatch_a_buried_window() {
        rejected_reload("buried").await;
    }
    #[tokio::test(start_paused = true)]
    async fn reload_does_not_dispatch_a_hidden_window() {
        rejected_reload("hidden").await;
    }
    #[tokio::test(start_paused = true)]
    async fn reload_does_not_dispatch_a_pending_delete() {
        rejected_reload("delete").await;
    }

    #[tokio::test(start_paused = true)]
    async fn reload_without_a_connection_is_not_handled() {
        let record = retry_record("reload-disconnected", 0);
        let harness = RetryHarness::start(vec![record.clone()], false, true).await;
        assert!(
            !harness.request_reload(&record, false, Some(&harness.view)),
            "a gone connection leaves Reload to the page"
        );
        harness.drain().await;
        assert_eq!(harness.times(&record), vec![0]);
        harness.stop(WatchLoopStop::CloseWindows).await;
    }
    #[tokio::test(start_paused = true)]
    async fn reload_without_a_view_is_not_handled() {
        let record = retry_record("reload-no-view", 0);
        let harness = RetryHarness::start(vec![record.clone()], false, true).await;
        assert!(
            !harness.request_reload(&record, true, None),
            "an absent watcher view leaves Reload to the page"
        );
        harness.drain().await;
        assert_eq!(harness.times(&record), vec![0]);
        harness.stop(WatchLoopStop::CloseWindows).await;
    }
    #[tokio::test(start_paused = true)]
    async fn reload_after_stop_is_not_handled() {
        for stop in [WatchLoopStop::KeepWindows, WatchLoopStop::CloseWindows] {
            let record = retry_record("reload-stopped", 0);
            let harness = RetryHarness::start(vec![record.clone()], false, true).await;
            let view = Arc::clone(&harness.view);
            harness.drain().await;
            assert!(harness.request_reload(&record, true, Some(&view)));
            let surface = harness.stop(stop).await;
            assert!(
                view.take_reload_requests().is_empty(),
                "stopping drops queued Reload requests"
            );
            let handled = request_devserver_reload(&native_label(&record), true, Some(&view));
            assert!(!handled, "a stopped watcher leaves Reload to the page");
            let (label, ticket) = surface.held.lock().unwrap().pop().unwrap();
            surface.launches.finish_retarget(
                &label,
                &surface.tickets,
                &ticket,
                &surface.builds,
                Ok(serve::RetargetOutcome::NotReady),
            );
            tokio::time::advance(Duration::from_secs(60)).await;
            assert!(surface.launches.0.lock().unwrap().entries.is_empty());
            assert!(surface.retry_deadline().is_none());
            assert_eq!(surface.attempts.lock().unwrap().len(), 1);
        }
    }

    async fn cadence_with_other_wakes(library: &str, offsets: &[u64]) {
        let records: Vec<_> = (0..offsets.len())
            .map(|i| retry_record(library, i))
            .collect();
        let harness = RetryHarness::start(vec![records[0].clone()], false, false).await;
        for second in 1..120 {
            tokio::time::advance(Duration::from_secs(1)).await;
            for (record, offset) in records.iter().zip(offsets) {
                if *offset == second {
                    harness
                        .surface
                        .live
                        .lock()
                        .unwrap()
                        .insert(native_label(record));
                    harness.feed.records.lock().unwrap().push(record.clone());
                }
            }
            harness.feed_wake().await;
            harness.view_wake().await;
            let previous = harness.feed.reads.load(std::sync::atomic::Ordering::SeqCst);
            harness
                .surface
                .builds
                .complete("lib-unused::w-other", Ok(()));
            harness.after_pass(previous).await;
            for (record, offset) in records
                .iter()
                .zip(offsets)
                .filter(|(_, offset)| **offset <= second)
            {
                let expected: Vec<_> = (*offset..=second).step_by(15).collect();
                assert_eq!(
                    harness.times(record),
                    expected,
                    "{library}: other wakes must not advance a waiting window's retry"
                );
            }
        }
        harness.stop(WatchLoopStop::KeepWindows).await;
    }

    #[tokio::test(start_paused = true)]
    async fn two_waiting_windows_keep_their_dispatch_intervals() {
        cadence_with_other_wakes("two-waiters", &[0, 5]).await;
    }

    #[tokio::test(start_paused = true)]
    async fn ten_waiting_windows_keep_their_dispatch_intervals() {
        cadence_with_other_wakes("ten-waiters", &[0, 1, 2, 3, 4, 5, 6, 7, 8, 9]).await;
    }

    #[tokio::test(start_paused = true)]
    async fn failed_native_build_waits_through_other_wakes() {
        let record = retry_record("build-waiter", 0);
        let harness = RetryHarness::start(vec![record.clone()], true, false).await;
        for second in 1..=30 {
            tokio::time::advance(Duration::from_secs(1)).await;
            harness.feed_wake().await;
            harness.view_wake().await;
            assert_eq!(
                harness.times(&record),
                (0..=second).step_by(15).collect::<Vec<_>>(),
                "a failed native build must wait fifteen seconds from dispatch"
            );
        }
        harness.stop(WatchLoopStop::CloseWindows).await;
    }

    #[tokio::test(start_paused = true)]
    async fn one_retry_timer_drives_staggered_waiters_without_feed_changes() {
        let a = retry_record("timer-waiters", 0);
        let b = retry_record("timer-waiters", 1);
        let harness = RetryHarness::start(vec![a.clone()], false, false).await;
        tokio::time::advance(Duration::from_secs(5)).await;
        harness
            .surface
            .live
            .lock()
            .unwrap()
            .insert(native_label(&b));
        harness.feed.records.lock().unwrap().push(b.clone());
        harness.feed_wake().await;
        assert_eq!(
            harness.times(&a),
            vec![0],
            "adding a waiter cannot retry the first window early"
        );
        for second in [15, 20, 30, 35, 45, 50] {
            let elapsed = tokio::time::Instant::now()
                .duration_since(harness.started)
                .as_secs();
            let previous = harness.feed.reads.load(std::sync::atomic::Ordering::SeqCst);
            tokio::time::advance(Duration::from_secs(second - elapsed)).await;
            harness.after_pass(previous).await;
            assert_eq!(
                harness.times(&a),
                (0..=second).step_by(15).collect::<Vec<_>>(),
                "the timer must service the first window's deadline"
            );
            assert_eq!(
                harness.times(&b),
                (5..=second).step_by(15).collect::<Vec<_>>(),
                "the timer must retain the staggered deadline"
            );
        }
        harness.stop(WatchLoopStop::KeepWindows).await;
    }

    #[tokio::test(start_paused = true)]
    async fn a_changed_target_bypasses_the_waiting_interval() {
        let mut record = retry_record("changed-target", 0);
        let harness = RetryHarness::start(vec![record.clone()], false, false).await;
        tokio::time::advance(Duration::from_secs(5)).await;
        record.token = "replacement-token".into();
        *harness.feed.records.lock().unwrap() = vec![record.clone()];
        harness.feed_wake().await;
        assert_eq!(
            harness.times(&record),
            vec![0, 5],
            "a changed target must be tried immediately"
        );
        tokio::time::advance(Duration::from_secs(1)).await;
        harness.feed_wake().await;
        assert_eq!(
            harness.times(&record),
            vec![0, 5],
            "the replacement target owns a fresh dispatch interval"
        );
        harness.stop(WatchLoopStop::KeepWindows).await;
    }

    #[tokio::test(start_paused = true)]
    async fn a_late_refusal_wakes_an_overdue_waiter_without_spinning() {
        let record = retry_record("late-refusal", 0);
        let harness = RetryHarness::start(vec![record.clone()], false, true).await;
        tokio::time::advance(Duration::from_secs(20)).await;
        harness.feed_wake().await;
        assert_eq!(
            harness.times(&record),
            vec![0],
            "an in-flight probe is not duplicated at its deadline"
        );
        let reads = harness.feed.reads.load(std::sync::atomic::Ordering::SeqCst);
        for _ in 0..100 {
            tokio::task::yield_now().await;
        }
        assert_eq!(
            harness.feed.reads.load(std::sync::atomic::Ordering::SeqCst),
            reads,
            "an overdue in-flight attempt must not spin the loop"
        );
        let (label, ticket) = harness.surface.held.lock().unwrap().pop().unwrap();
        harness
            .surface
            .hold
            .store(false, std::sync::atomic::Ordering::SeqCst);
        harness.surface.launches.finish_retarget(
            &label,
            &harness.surface.tickets,
            &ticket,
            &harness.surface.builds,
            Ok(serve::RetargetOutcome::NotReady),
        );
        for _ in 0..100 {
            tokio::task::yield_now().await;
        }
        assert_eq!(
            harness.times(&record),
            vec![0, 20],
            "settling an overdue refusal must wake the next try immediately"
        );
        harness.stop(WatchLoopStop::KeepWindows).await;
    }

    /// Stop the watcher while its first pass's open is in flight, then let
    /// the open finish. `queued` says whether its build had passed the
    /// marker check before the stop. Answers whether the window is open.
    async fn a_build_in_flight_at_the_stop(stop: WatchLoopStop, queued: bool) -> bool {
        let record = retry_record(if queued { "queued" } else { "resolving" }, 0);
        let harness = RetryHarness::start_with(vec![record.clone()], true, false, true).await;
        assert_eq!(harness.times(&record), vec![0], "the first pass opens");
        if queued {
            harness.surface.resolve_opens();
        }
        let surface = harness.stop(stop).await;
        surface.resolve_opens();
        surface.land_builds();
        let open = surface
            .live
            .lock()
            .unwrap()
            .contains(&native_label(&record));
        open
    }

    #[tokio::test(start_paused = true)]
    async fn a_disconnect_closes_a_build_that_lands_after_it() {
        for queued in [true, false] {
            assert!(
                !a_build_in_flight_at_the_stop(WatchLoopStop::CloseWindows, queued).await,
                "queued={queued}: no window of a devserver is left open after a disconnect"
            );
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_keep_windows_stop_keeps_a_build_that_lands_after_it() {
        assert!(
            a_build_in_flight_at_the_stop(WatchLoopStop::KeepWindows, true).await,
            "a stop that keeps the windows keeps the one that lands"
        );
        assert!(
            !a_build_in_flight_at_the_stop(WatchLoopStop::KeepWindows, false).await,
            "an open still resolving at the stop is never built"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_key_that_changes_during_a_build_waits_for_the_window() {
        let mut record = retry_record("key-during-build", 0);
        let harness = RetryHarness::start_with(vec![record.clone()], true, true, true).await;
        harness.surface.resolve_opens();
        tokio::time::advance(Duration::from_secs(5)).await;
        record.token = "restarted-token".into();
        *harness.feed.records.lock().unwrap() = vec![record.clone()];
        harness.feed_wake().await;
        assert_eq!(
            harness.times(&record),
            vec![0],
            "no retarget is dispatched for a window whose webview is not there"
        );
        let reads = harness.feed.reads.load(std::sync::atomic::Ordering::SeqCst);
        harness.surface.land_builds();
        harness.after_pass(reads).await;
        assert_eq!(
            harness.times(&record),
            vec![0, 5],
            "the pass after the build lands retargets the moved key"
        );
        harness.stop(WatchLoopStop::KeepWindows).await;
    }

    #[tokio::test(start_paused = true)]
    async fn a_timer_try_leaves_a_page_that_recovered_alone() {
        let record = retry_record("recovered", 0);
        let harness = RetryHarness::start(vec![record.clone()], false, true).await;
        harness.navigate_first(&record).await;
        harness.show_url(&record, BOOTED_URL);
        harness
            .refused_reload_then_timer(&record, Some(BOOTED_URL))
            .await;
        assert_eq!(
            harness.times(&record),
            vec![0, 5],
            "the timer's try navigates nothing on a page that recovered"
        );
        assert!(
            harness.applied(&record),
            "the try marks the attempt applied"
        );
        assert_eq!(
            harness.raised(&record),
            vec![true, true],
            "a Reload's own dispatch raises as the user asked"
        );
        harness.stop(WatchLoopStop::KeepWindows).await;
    }

    #[tokio::test(start_paused = true)]
    async fn a_timer_try_leaves_a_connecting_page_that_navigated_alone() {
        let record = retry_record("connected-itself", 0);
        let harness = RetryHarness::start_with(vec![record.clone()], true, true, true).await;
        harness.surface.resolve_opens();
        harness.show_url(&record, CONNECTING_URL);
        let reads = harness.feed.reads.load(std::sync::atomic::Ordering::SeqCst);
        harness.surface.land_builds();
        harness.after_pass(reads).await;
        // The Reload is pressed on the connecting page, which then reaches
        // its target by itself before the timer's try.
        harness
            .refused_reload_then_timer(&record, Some(BOOTED_URL))
            .await;
        assert_eq!(
            harness.times(&record),
            vec![0, 5],
            "the timer's try navigates nothing once the connecting page reached its target"
        );
        assert!(
            harness.applied(&record),
            "the try marks the attempt applied"
        );
        harness.stop(WatchLoopStop::KeepWindows).await;
    }

    #[tokio::test(start_paused = true)]
    async fn a_timer_try_on_a_changed_token_navigates_without_raising() {
        let mut record = retry_record("changed-token-try", 0);
        let harness = RetryHarness::start(vec![record.clone()], false, true).await;
        harness.navigate_first(&record).await;
        // The page booted on the old token, so its URL looks like the new
        // target's with the token pair gone.
        harness.show_url(&record, BOOTED_URL);
        tokio::time::advance(Duration::from_secs(5)).await;
        record.token = "restarted-token".into();
        *harness.feed.records.lock().unwrap() = vec![record.clone()];
        harness.feed_wake().await;
        let (_, ticket) = harness.surface.held.lock().unwrap().pop().unwrap();
        harness.finish_requested(&record, &ticket, Ok(serve::RetargetOutcome::NotReady));
        harness.drain().await;
        tokio::time::advance(RETRY_NUDGE).await;
        harness.drain().await;
        assert_eq!(
            harness.times(&record),
            vec![0, 5, 20],
            "the timer's try navigates a page loaded with another token"
        );
        assert_eq!(
            harness.raised(&record),
            vec![true, true, false],
            "a timer's try raises nothing"
        );
        harness.stop(WatchLoopStop::KeepWindows).await;
    }

    #[tokio::test(start_paused = true)]
    async fn a_timer_try_navigates_a_page_that_never_booted_without_raising() {
        for (case, url) in [
            ("token", Some(UNBOOTED_URL)),
            ("connecting", Some(CONNECTING_URL)),
            ("unreadable", None),
        ] {
            let record = retry_record(&format!("unbooted-{case}"), 0);
            let harness = RetryHarness::start(vec![record.clone()], false, true).await;
            harness.navigate_first(&record).await;
            harness.refused_reload_then_timer(&record, url).await;
            assert_eq!(
                harness.times(&record),
                vec![0, 5, 20],
                "{case}: the timer's try navigates a page that never got past loading"
            );
            assert_eq!(
                harness.raised(&record),
                vec![true, true, false],
                "{case}: a timer's try raises nothing"
            );
            harness.stop(WatchLoopStop::KeepWindows).await;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn stopped_watchers_reject_late_settlement_and_admission() {
        for stop in [WatchLoopStop::KeepWindows, WatchLoopStop::CloseWindows] {
            let record = retry_record("stopped-waiter", 0);
            let harness = RetryHarness::start(vec![record.clone()], false, true).await;
            let surface = harness.stop(stop).await;
            let (label, ticket) = surface.held.lock().unwrap().pop().unwrap();
            surface.launches.finish_retarget(
                &label,
                &surface.tickets,
                &ticket,
                &surface.builds,
                Ok(serve::RetargetOutcome::NotReady),
            );
            tokio::time::advance(Duration::from_secs(60)).await;
            assert!(
                surface.launches.retarget(&record, false, false).is_none(),
                "a stopped watcher must reject a late completion's next attempt"
            );
            assert_eq!(surface.attempts.lock().unwrap().len(), 1);
            assert_eq!(
                surface
                    .live
                    .lock()
                    .unwrap()
                    .contains(&native_label(&record)),
                stop == WatchLoopStop::KeepWindows
            );
        }
    }

    #[tokio::test(start_paused = true)]
    async fn hidden_closed_and_removed_waiters_receive_no_more_attempts() {
        for action in ["bury", "server-hidden", "close", "removed"] {
            let record = retry_record(action, 0);
            let harness = RetryHarness::start(vec![record.clone()], false, false).await;
            match action {
                "bury" => harness.view.bury(&native_label(&record)),
                "server-hidden" => harness.feed.records.lock().unwrap()[0].hidden = true,
                "close" => {
                    harness.pending_deletes.queue("test-connection", &record);
                    harness.view.bury(&native_label(&record));
                    harness.surface.close(&native_label(&record));
                }
                "removed" => harness.feed.records.lock().unwrap().clear(),
                _ => unreachable!(),
            }
            harness.feed_wake().await;
            for _ in 0..4 {
                tokio::time::advance(Duration::from_secs(15)).await;
                harness.feed_wake().await;
                assert_eq!(
                    harness.times(&record),
                    vec![0],
                    "{action}: an unwanted waiting window must receive no further attempt"
                );
            }
            harness.stop(WatchLoopStop::CloseWindows).await;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn failed_retargets_keep_the_dispatch_deadline() {
        for failure in ["mint", "session", "navigation"] {
            let record = retry_record("failed-retarget", 0);
            let harness = RetryHarness::start(vec![record.clone()], false, true).await;
            tokio::time::advance(Duration::from_secs(5)).await;
            let (label, ticket) = harness.surface.held.lock().unwrap().pop().unwrap();
            if failure == "navigation" {
                harness.surface.launches.finish_retarget(
                    &label,
                    &harness.surface.tickets,
                    &ticket,
                    &harness.surface.builds,
                    Err("navigation failed".into()),
                );
            } else {
                harness.surface.launches.fail(
                    &label,
                    true,
                    &harness.surface.tickets,
                    Some(&ticket),
                    &harness.surface.builds,
                    failure.into(),
                );
            }
            harness.feed_wake().await;
            assert_eq!(
                harness.times(&record),
                vec![0],
                "{failure}: a failed retarget must retain its dispatch deadline"
            );
            tokio::time::advance(Duration::from_secs(10)).await;
            harness.feed_wake().await;
            assert_eq!(
                harness.times(&record),
                vec![0, 15],
                "{failure}: failure must leave an eligible retry"
            );
            harness.stop(WatchLoopStop::KeepWindows).await;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn retry_deadlines_do_not_wake_shared_feed_subscribers() {
        use futures::FutureExt;
        let record = retry_record("private-retry", 0);
        let harness = RetryHarness::start(vec![record.clone()], false, false).await;
        let nudge = Arc::clone(&harness.feed.nudge);
        let subscriber = nudge.notified();
        tokio::pin!(subscriber);
        subscriber.as_mut().enable();
        tokio::time::advance(Duration::from_secs(15)).await;
        for _ in 0..100 {
            tokio::task::yield_now().await;
        }
        assert_eq!(
            harness.times(&record),
            vec![0, 15],
            "the owned deadline must retry without a feed push"
        );
        assert!(
            subscriber.as_mut().now_or_never().is_none(),
            "retry scheduling must not wake shared feed subscribers"
        );
        harness.stop(WatchLoopStop::KeepWindows).await;
    }

    #[test]
    fn native_gateway_websocket_uses_the_exact_proxy_origin() {
        let conn = DevserverConn {
            host: "alice--0123456789ab.p1.proxy.chan.app".into(),
            port: 443,
            token: String::new(),
            name: "alice".into(),
            gateway: Some(Box::new(crate::devserver::GatewayConn::new(
                "https://gw.chan.app".into(),
                "https://gw.chan.app/desktop/v1/devserver/entry".into(),
                "https://alice--0123456789ab.p1.proxy.chan.app".into(),
                "pat".into(),
            ))),
        };
        assert_eq!(
            gateway_ws_origin(&conn).unwrap(),
            "https://alice--0123456789ab.p1.proxy.chan.app"
        );
    }

    #[tokio::test]
    async fn raw_devserver_feed_requests_carry_the_bearer_and_feed_wording() {
        let conn = DevserverConn {
            host: "127.0.0.1".into(),
            port: 4321,
            token: "tok-raw".into(),
            name: "box".into(),
            gateway: None,
        };
        for path in [
            "/api/library/windows/watch",
            "/api/library/local-color/watch",
        ] {
            let request = raw_ws_request(&conn, path, "watch").expect("a raw feed request builds");
            let uri = request.uri();
            assert_eq!(uri.scheme_str(), Some("ws"));
            assert_eq!(uri.host(), Some("127.0.0.1"));
            assert_eq!(uri.port_u16(), Some(4321));
            assert_eq!(uri.path(), path);
            assert_eq!(uri.to_string(), format!("ws://127.0.0.1:4321{path}"));
            assert_eq!(
                request
                    .headers()
                    .get("Authorization")
                    .and_then(|value| value.to_str().ok()),
                Some("Bearer tok-raw")
            );
        }

        // Each feed's own wording survives the shared builder: the URL error
        // carries `what` and the connect error carries `target`.
        let mut unparsable = conn.clone();
        unparsable.host = "not a host".into();
        let err = raw_ws_request(
            &unparsable,
            "/api/library/local-color/watch",
            "colour watch",
        )
        .expect_err("a host with spaces is not a URL");
        assert!(err.starts_with("bad colour watch url: "), "{err}");

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut dropped = conn.clone();
        dropped.port = listener.local_addr().unwrap().port();
        // Hold the port until the dial connects, then drop the accepted stream
        // to fail the WebSocket handshake without a port-reuse race.
        let dial = tokio::time::timeout(Duration::from_secs(10), async {
            let (dial, ()) = tokio::join!(
                connect_raw_ws(&dropped, "/api/library/windows/watch", "watch", "/watch"),
                async {
                    let (stream, _) = listener.accept().await.unwrap();
                    drop(stream);
                },
            );
            dial
        })
        .await
        .expect("the dropped connection fails the handshake within the bound");
        let err = match dial {
            Ok(_) => panic!("a dropped connection cannot complete the WebSocket handshake"),
            Err(err) => err,
        };
        assert!(err.starts_with("connect /watch: "), "{err}");
    }

    #[test]
    fn remote_launch_key_ignores_feed_status_fields() {
        let a = rec();
        let mut b = a.clone();
        b.connected = true;
        b.active_transfer = true;
        b.control = true;
        b.hidden = true;

        for gateway in [false, true] {
            assert_eq!(
                RemoteLaunchKey::from_record(&a, gateway),
                RemoteLaunchKey::from_record(&b, gateway)
            );
        }
    }

    #[test]
    fn remote_launch_key_tracks_url_and_window_shape_fields() {
        let base = rec();

        let mut token = base.clone();
        token.token = "tok-2".into();
        // A raw devserver's token is the stable tenant bearer: rotation means
        // the loaded page's auth died, so it must retarget.
        assert_ne!(
            RemoteLaunchKey::from_record(&base, false),
            RemoteLaunchKey::from_record(&token, false)
        );

        let mut prefix = base.clone();
        prefix.prefix = "/other".into();
        assert_ne!(
            RemoteLaunchKey::from_record(&base, false),
            RemoteLaunchKey::from_record(&prefix, false)
        );

        let mut workspace = base.clone();
        workspace.kind = chan_server::WindowKind::Workspace;
        workspace.workspace_path = Some("/repo".into());
        assert_ne!(
            RemoteLaunchKey::from_record(&base, false),
            RemoteLaunchKey::from_record(&workspace, false)
        );
    }

    #[test]
    fn remote_launch_key_ignores_token_churn_for_gateway_windows() {
        // A gateway window's entry credential is single-use and minted fresh
        // per navigation; the page's standing auth is the opaque
        // devserver-gate cookie. A re-mint therefore must NOT change the
        // launch key -- keying on it made every feed push retarget every
        // open window into a reload loop.
        let base = rec();
        let mut token = base.clone();
        token.token = "tok-2".into();
        assert_eq!(
            RemoteLaunchKey::from_record(&base, true),
            RemoteLaunchKey::from_record(&token, true)
        );
        // Real shape changes still retarget.
        let mut prefix = base.clone();
        prefix.prefix = "/other".into();
        assert_ne!(
            RemoteLaunchKey::from_record(&base, true),
            RemoteLaunchKey::from_record(&prefix, true)
        );
    }

    #[test]
    fn pending_delete_retries_on_first_feed_snapshot_and_settles_when_absent() {
        let record = rec();
        let pending = PendingDeleteState::default();
        pending.queue("devserver-1", &record);
        let initial = pending.begin("lib-test::w-1").unwrap();
        let _ = pending.finish(&initial.label, false);

        assert!(pending_delete_attempts_for_feed_snapshot(
            &pending,
            "devserver-1",
            std::slice::from_ref(&record),
            false,
        )
        .is_empty());

        let retries = pending_delete_attempts_for_feed_snapshot(
            &pending,
            "devserver-1",
            std::slice::from_ref(&record),
            true,
        );
        assert_eq!(retries.len(), 1);
        assert_eq!(retries[0].attempt, 2);
        let _ = pending.finish(&retries[0].label, true);

        assert!(pending.contains("lib-test::w-1"));
        assert!(
            pending_delete_attempts_for_feed_snapshot(&pending, "devserver-1", &[], false,)
                .is_empty()
        );
        assert!(!pending.contains("lib-test::w-1"));
    }

    #[tokio::test]
    async fn keepalive_pump_errs_on_a_silent_socket() {
        // A mock feed WS that completes the handshake then stays silent: it never
        // sends a frame and never polls, so it does not even auto-pong. The pump
        // must give up after `max_missed` idle intervals rather than pend forever
        // on `next()` -- the half-open zombie a laptop sleep leaves behind. Short
        // injected interval so the deadline fires in ~120ms of real time.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (sock, _) = listener.accept().await.unwrap();
            let _ws = tokio_tungstenite::accept_async(sock).await.unwrap();
            tokio::time::sleep(Duration::from_secs(5)).await; // hold it open, silent
        });
        let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/"))
            .await
            .expect("connect to the mock feed");
        let mut frames = 0u32;
        let result = keepalive_pump(&mut ws, Duration::from_millis(40), 2, |_| frames += 1).await;
        assert!(
            result.is_err(),
            "a silent socket must error out, got {result:?}"
        );
        assert_eq!(frames, 0, "no frames should have arrived");
    }

    /// One `/watch` frame from a devserver on a later release can hold a row
    /// this desktop cannot read. The frame still delivers every row the
    /// desktop can read, so its view of that devserver keeps moving, and the
    /// other row is named in a warning.
    #[test]
    fn a_watch_frame_keeps_the_rows_it_can_read() {
        let mut unknown_kind = serde_json::to_value(WindowRecord {
            window_id: "w-2".into(),
            ..rec()
        })
        .unwrap();
        unknown_kind["kind"] = "panel".into();
        let frame = serde_json::json!({
            "windows": [serde_json::to_value(rec()).unwrap(), unknown_kind],
            "leaders": { "/terminal": "w-1" },
        })
        .to_string();
        let logs = crate::devserver::log_capture::Lines::default();
        let _logs = logs.install();

        let windows = decode_window_frame("dev-1", &frame, &mut ConnectionRows::default())
            .expect("one unreadable row must not drop the frame");

        let ids: Vec<&str> = windows.iter().map(|row| row.window_id.as_str()).collect();
        assert_eq!(ids, ["w-1"], "the readable row survives its neighbour");
        let warnings = logs.warnings();
        assert_eq!(
            warnings.len(),
            1,
            "one line per unreadable row: {warnings:?}"
        );
        assert!(
            warnings[0].contains("row=window_id w-2") && warnings[0].contains("panel"),
            "the line names the row and why it was unreadable: {}",
            warnings[0]
        );
        assert!(
            warnings[0].contains("devserver=dev-1") && warnings[0].contains("source=watch frame"),
            "the line names the devserver and the feed: {}",
            warnings[0]
        );
    }

    /// A frame that does not parse at all carries no row to keep, so the
    /// view stays at the last snapshot, and the skip is logged rather than
    /// silent.
    #[test]
    fn a_watch_frame_that_does_not_parse_is_logged() {
        let logs = crate::devserver::log_capture::Lines::default();
        let _logs = logs.install();

        assert!(
            decode_window_frame("dev-1", "{\"windows\":", &mut ConnectionRows::default()).is_none()
        );

        let warnings = logs.warnings();
        assert_eq!(
            warnings.len(),
            1,
            "the skipped frame is logged: {warnings:?}"
        );
        assert!(
            warnings[0].contains("unreadable devserver window frame")
                && warnings[0].contains("devserver=dev-1"),
            "the line says what was skipped and from which devserver: {}",
            warnings[0]
        );
    }

    /// A frame beside one readable row and one row of a kind this desktop
    /// does not know.
    fn frame_with_an_unknown_kind_row() -> String {
        let mut unknown_kind = serde_json::to_value(WindowRecord {
            window_id: "w-2".into(),
            ..rec()
        })
        .unwrap();
        unknown_kind["kind"] = "panel".into();
        serde_json::json!({ "windows": [serde_json::to_value(rec()).unwrap(), unknown_kind] })
            .to_string()
    }

    /// A devserver keeps serving an unreadable row in every frame, and a frame
    /// goes out on every window change. The row is logged the first time a
    /// connection sees it, not once per frame.
    #[test]
    fn an_unreadable_row_is_logged_once_per_connection() {
        let frame = frame_with_an_unknown_kind_row();
        let logs = crate::devserver::log_capture::Lines::default();
        let _logs = logs.install();

        let mut connection = ConnectionRows::default();
        decode_window_frame("dev-1", &frame, &mut connection).expect("the first frame parses");
        decode_window_frame("dev-1", &frame, &mut connection).expect("the second frame parses");

        let warnings = logs.warnings();
        assert_eq!(
            warnings.len(),
            1,
            "a second frame on the same connection logs the row again: {warnings:?}"
        );

        let mut reconnect = ConnectionRows::default();
        decode_window_frame("dev-1", &frame, &mut reconnect).expect("a reconnect's frame parses");
        let warnings = logs.warnings();
        assert_eq!(
            warnings.len(),
            2,
            "a reconnect logs the row again: {warnings:?}"
        );
        assert!(warnings[1].contains("row=window_id w-2"), "{}", warnings[1]);

        // A row with no readable id cannot be tracked, so it logs every time.
        let idless = serde_json::json!({ "windows": [7] }).to_string();
        decode_window_frame("dev-1", &idless, &mut reconnect).expect("the frame parses");
        decode_window_frame("dev-1", &idless, &mut reconnect).expect("the frame parses");
        let warnings = logs.warnings();
        assert_eq!(
            warnings.len(),
            4,
            "an id-less row logs per frame: {warnings:?}"
        );
        assert!(
            warnings[2..]
                .iter()
                .all(|line| line.contains("row=index 0")),
            "{warnings:?}"
        );
    }

    /// A row the desktop has shown can come back unreadable in a later frame.
    /// Its absence from the snapshot would close the native window and settle
    /// a pending close intent, so the row keeps the record last read for it.
    #[test]
    fn a_row_that_turns_unreadable_keeps_its_last_readable_record() {
        let shown = rec();
        let mut turned = serde_json::to_value(rec()).unwrap();
        turned["kind"] = "panel".into();
        let first = serde_json::json!({ "windows": [serde_json::to_value(&shown).unwrap()] });
        let second = serde_json::json!({ "windows": [turned] });
        let logs = crate::devserver::log_capture::Lines::default();
        let _logs = logs.install();

        let mut connection = ConnectionRows::default();
        decode_window_frame("dev-1", &first.to_string(), &mut connection)
            .expect("the first frame parses");
        let windows = decode_window_frame("dev-1", &second.to_string(), &mut connection)
            .expect("the second frame parses");

        assert_eq!(
            windows,
            vec![shown],
            "the row keeps the record the desktop last read for it"
        );
        let warnings = logs.warnings();
        assert_eq!(
            warnings.len(),
            1,
            "the stale row is logged once: {warnings:?}"
        );
        assert!(
            warnings[0].contains("turned unreadable")
                && warnings[0].contains("stale")
                && warnings[0].contains("row=window_id w-1")
                && warnings[0].contains("devserver=dev-1"),
            "the line says the row is stale and names it: {}",
            warnings[0]
        );

        // Later frames keep standing in for the row, without another line.
        let windows = decode_window_frame("dev-1", &second.to_string(), &mut connection)
            .expect("the third frame parses");
        assert_eq!(windows.len(), 1, "the stale record still stands in");
        assert_eq!(
            logs.warnings().len(),
            1,
            "the stale row logs once per connection"
        );

        // A reconnect has read nothing, so the row is hidden there.
        let windows =
            decode_window_frame("dev-1", &second.to_string(), &mut ConnectionRows::default())
                .expect("a reconnect's frame parses");
        assert!(
            windows.is_empty(),
            "a row never read on a connection is hidden"
        );
    }

    /// A row a frame no longer carries is forgotten: a discarded window closes
    /// as the feed says, and its record never stands in for a later
    /// unreadable row under the same id.
    #[test]
    fn a_discarded_row_is_not_kept_for_a_later_unreadable_one() {
        let mut turned = serde_json::to_value(rec()).unwrap();
        turned["kind"] = "panel".into();
        let shown = serde_json::json!({ "windows": [serde_json::to_value(rec()).unwrap()] });
        let discarded = serde_json::json!({ "windows": [] });
        let returned = serde_json::json!({ "windows": [turned] });
        let mut connection = ConnectionRows::default();

        decode_window_frame("dev-1", &shown.to_string(), &mut connection).expect("shown");
        let windows = decode_window_frame("dev-1", &discarded.to_string(), &mut connection)
            .expect("discarded");
        assert!(windows.is_empty(), "a discarded row leaves the snapshot");
        let windows =
            decode_window_frame("dev-1", &returned.to_string(), &mut connection).expect("returned");
        assert!(
            windows.is_empty(),
            "a discarded window's record stood in for a later row: {windows:?}"
        );
    }

    #[tokio::test]
    async fn keepalive_pump_forwards_frames_then_ok_on_clean_close() {
        use futures::SinkExt;
        use tokio_tungstenite::tungstenite::Message;
        // A mock feed that pushes two frames then closes cleanly: every frame
        // reaches `on_text` and the clean close returns Ok (no false deadline).
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (sock, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(sock).await.unwrap();
            ws.send(Message::text("{\"windows\":[]}")).await.unwrap();
            ws.send(Message::text("{\"windows\":[]}")).await.unwrap();
            ws.send(Message::Close(None)).await.unwrap();
        });
        let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/"))
            .await
            .expect("connect to the mock feed");
        let mut frames = 0u32;
        let result = keepalive_pump(&mut ws, Duration::from_secs(5), 2, |_| frames += 1).await;
        assert!(result.is_ok(), "a clean close returns Ok, got {result:?}");
        assert_eq!(frames, 2, "both text frames forwarded to on_text");
    }
}
