//! The last shown window guard.
//!
//! Tauri requests an exit when chan's last native window is destroyed, and
//! the exit handler then runs the clean shutdown, which ends every terminal
//! session the process holds: the hidden windows' shells die with it. So a
//! gesture that would take away chan's last shown window is refused while a
//! terminal session that would end with the process is alive. The hide
//! gestures (`cs window hide`, the launcher's Hide, the close prompt's Hide)
//! and the close gestures (`cs window rm`, the launcher's Close, the close
//! prompt's Close) all ask [`check`], which reads the running desktop, and
//! [`refusal`] is the one rule they answer by.

use std::collections::HashSet;
use std::sync::Arc;

use tauri::{AppHandle, Manager, Runtime};

use crate::AppState;

/// What a gesture does to its window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Gesture {
    /// Bury the window: its terminals stay warm, but only while chan runs.
    Hide,
    /// Destroy the window: its own terminals end with it, by the user's
    /// choice (or `--force`).
    Close,
}

/// What the rule needs to know about the running desktop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Reading {
    /// Shown windows other than the gesture's own that keep chan running.
    pub others_shown: usize,
    /// Live terminal sessions of the library, across every tenant.
    pub live: usize,
    /// Live terminal sessions the gesture's own window owns.
    pub own: usize,
}

/// The refusal for `gesture` on chan's last shown window, or `None` when the
/// gesture may go ahead. With another shown window, chan keeps running and
/// nothing is refused. A hide refuses on any live session, its own window's
/// included, since the hide promised to keep those warm. A close refuses on
/// the sessions it does not end itself.
pub(crate) fn refusal(gesture: Gesture, reading: &Reading) -> Option<String> {
    if reading.others_shown > 0 {
        return None;
    }
    match gesture {
        Gesture::Hide => (reading.live > 0).then(|| {
            format!(
                "this is chan's last shown window: hiding it would quit chan and end {} \
                 running terminal session(s); show or open another window first",
                reading.live
            )
        }),
        Gesture::Close => {
            let others = reading.live.saturating_sub(reading.own);
            (others > 0).then(|| {
                format!(
                    "this is chan's last shown window: closing it would quit chan and end \
                     {others} other running terminal session(s); show or open another \
                     window first"
                )
            })
        }
    }
}

/// The labels of the windows that keep chan running and are in sight:
/// watcher-opened local and devserver windows and control terminals, less the
/// ones the desktop put away ([`put_away`]). The About window is not one:
/// closing it as the last window ends chan with no guard, so it cannot stand
/// in for a shown window.
pub(crate) fn shown_windows<R: Runtime>(app: &AppHandle<R>, state: &AppState) -> Vec<String> {
    let gone = put_away(state);
    app.webview_windows()
        .into_keys()
        .filter(|label| keeps_chan_running(label) && !gone.contains(label))
        .collect()
}

/// The labels of the windows the desktop put away itself: the buried ones (a
/// buried control terminal is hidden in place, so it is a native window the
/// user cannot see) and the ones whose hide is under way (a flagged hide
/// buries on a later turn of the event loop).
pub(crate) fn put_away(state: &AppState) -> HashSet<String> {
    let mut gone: HashSet<String> = state
        .buried_snapshot()
        .into_iter()
        .map(|(label, _)| label)
        .collect();
    gone.extend(state.silent_hides.lock().unwrap().iter().cloned());
    gone
}

fn keeps_chan_running(label: &str) -> bool {
    crate::serve::is_workspace_webview_label(label) || label.starts_with("control-terminal-")
}

/// Ask the rule about `gesture` on the native window `label`, reading the
/// running desktop: `Err` carries the sentence the gesture is refused with.
/// A window that is not shown takes no shown window away, and a control
/// terminal's hide keeps its native window, so neither is refused.
pub(crate) fn check<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    label: &str,
    gesture: Gesture,
) -> Result<(), String> {
    let shown = shown_windows(app, state);
    if !shown.iter().any(|shown| shown == label) {
        return Ok(());
    }
    if gesture == Gesture::Hide && label.starts_with("control-terminal-") {
        return Ok(());
    }
    let Some(embedded) = state.embedded() else {
        return Ok(());
    };
    let own = match gesture {
        Gesture::Hide => 0,
        Gesture::Close => own_sessions(state, embedded, label),
    };
    let reading = Reading {
        others_shown: shown.len() - 1,
        live: embedded.live_terminal_sessions(),
        own,
    };
    match refusal(gesture, &reading) {
        Some(sentence) => Err(sentence),
        None => Ok(()),
    }
}

/// The live sessions that end with the native window `label`: a local
/// window's are tagged with its window id, and a control terminal's run in a
/// tenant of its own. A devserver window's sessions live on its devserver and
/// outlast this process.
fn own_sessions(
    state: &AppState,
    embedded: &crate::embedded::EmbeddedServer,
    label: &str,
) -> usize {
    if let Some(window_id) = label.strip_prefix("local::") {
        return embedded.window_terminal_sessions(window_id);
    }
    if let Some(devserver_id) = label.strip_prefix("control-terminal-") {
        let prefix = state
            .control_terminal_runs
            .lock()
            .unwrap()
            .get(devserver_id)
            .map(|run| run.prefix.clone());
        return prefix
            .map(|prefix| embedded.tenant_terminal_sessions(&prefix))
            .unwrap_or(0);
    }
    0
}

/// [`check`] for a Tauri command, which reaches the state through the app.
pub(crate) fn check_window<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    gesture: Gesture,
) -> Result<(), String> {
    let state = Arc::clone(app.state::<Arc<AppState>>().inner());
    check(app, &state, label, gesture)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    fn reading(others_shown: usize, live: usize, own: usize) -> Reading {
        Reading {
            others_shown,
            live,
            own,
        }
    }

    #[test]
    fn a_hide_of_the_last_shown_window_is_refused_while_any_terminal_lives() {
        let sentence = refusal(Gesture::Hide, &reading(0, 3, 0)).expect("refused");
        assert_eq!(
            sentence,
            "this is chan's last shown window: hiding it would quit chan and end 3 \
             running terminal session(s); show or open another window first"
        );
        // The window's own sessions count: the hide promised to keep them.
        assert!(refusal(Gesture::Hide, &reading(0, 1, 1)).is_some());
    }

    #[test]
    fn a_close_of_the_last_shown_window_is_refused_for_the_sessions_it_does_not_end() {
        let sentence = refusal(Gesture::Close, &reading(0, 5, 2)).expect("refused");
        assert_eq!(
            sentence,
            "this is chan's last shown window: closing it would quit chan and end 3 \
             other running terminal session(s); show or open another window first"
        );
        // Its own sessions end by the user's choice, so they alone refuse nothing.
        assert_eq!(refusal(Gesture::Close, &reading(0, 2, 2)), None);
    }

    #[test]
    fn another_shown_window_or_no_live_terminal_refuses_nothing() {
        for gesture in [Gesture::Hide, Gesture::Close] {
            assert_eq!(refusal(gesture, &reading(1, 4, 0)), None, "{gesture:?}");
            assert_eq!(refusal(gesture, &reading(0, 0, 0)), None, "{gesture:?}");
        }
    }

    /// A mock desktop: an app managing `state`, whose embedded host is a real
    /// `WorkspaceHost`, with native windows built by label.
    pub(crate) struct Desk {
        pub app: tauri::App<tauri::test::MockRuntime>,
        pub state: Arc<AppState>,
        _config: tempfile::TempDir,
    }

    impl Desk {
        pub(crate) async fn new() -> Self {
            let config = tempfile::tempdir().expect("config dir");
            let store = Arc::new(std::sync::Mutex::new(crate::config::ConfigStore::at_path(
                config.path().join("config.json"),
            )));
            let state = Arc::new(AppState::with_store(store));
            let library = chan_workspace::Library::open_at(config.path().join("config.toml"))
                .expect("library");
            let embedded = crate::embedded::EmbeddedServer::for_tests(library).await;
            assert!(state.embedded.set(embedded).is_ok(), "one embedded server");
            let app = tauri::test::mock_app();
            app.manage(Arc::clone(&state));
            Self {
                app,
                state,
                _config: config,
            }
        }

        pub(crate) fn window(&self, label: &str) -> tauri::WebviewWindow<tauri::test::MockRuntime> {
            WebviewWindowBuilder::new(&self.app, label, WebviewUrl::App("index.html".into()))
                .build()
                .expect("mock webview window")
        }

        pub(crate) fn embedded(&self) -> &crate::embedded::EmbeddedServer {
            self.state.embedded().expect("embedded server")
        }

        /// Mount a control-terminal tenant for `devserver_id` and record it
        /// as that devserver's control run, as the connect flow does.
        pub(crate) async fn control_terminal(&self, devserver_id: &str) -> String {
            let (url, prefix) = self
                .embedded()
                .open_terminal_with_command(crate::embedded::LONG_RUNNING_TEST_COMMAND.into())
                .await
                .expect("control tenant");
            self.state.control_terminal_runs.lock().unwrap().insert(
                devserver_id.to_string(),
                crate::ControlTerminalRun {
                    generation: 1,
                    prefix: prefix.clone(),
                    script_based: true,
                },
            );
            url
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn shown_windows_count_watcher_and_control_windows_less_the_buried_and_about() {
        let desk = Desk::new().await;
        for label in [
            "local::w-a",
            "local::w-b",
            "lib-00ff::w-c",
            "control-terminal-ds",
            "about",
        ] {
            desk.window(label);
        }
        desk.state.bury_window("local::w-b", "B");
        let mut shown = shown_windows(desk.app.handle(), &desk.state);
        shown.sort();
        assert_eq!(
            shown,
            ["control-terminal-ds", "lib-00ff::w-c", "local::w-a"],
            "a buried window and the About window keep no shown window"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_last_shown_local_window_is_counted_against_the_librarys_live_sessions() {
        let desk = Desk::new().await;
        desk.window("local::w-shown");
        desk.window("local::w-hidden");
        desk.state.bury_window("local::w-hidden", "Hidden");
        let handle = desk.app.handle();
        // No live terminal: both gestures behave as before.
        assert_eq!(
            check(handle, &desk.state, "local::w-shown", Gesture::Hide),
            Ok(())
        );
        assert_eq!(
            check(handle, &desk.state, "local::w-shown", Gesture::Close),
            Ok(())
        );

        // A live session of the hidden window, which dies when chan quits.
        let url = desk
            .embedded()
            .open_terminal_with_command("true".into())
            .await
            .unwrap()
            .0;
        desk.embedded()
            .spawn_terminal_for_tests(&url, Some("w-hidden"))
            .await;
        let hide = check(handle, &desk.state, "local::w-shown", Gesture::Hide);
        assert!(
            matches!(&hide, Err(sentence) if sentence.contains("end 1 running terminal session(s)")),
            "got {hide:?}"
        );
        let close = check(handle, &desk.state, "local::w-shown", Gesture::Close);
        assert!(
            matches!(&close, Err(sentence) if sentence.contains("end 1 other running")),
            "got {close:?}"
        );
        // The hidden window is not shown, so a gesture on it takes nothing away.
        assert_eq!(
            check(handle, &desk.state, "local::w-hidden", Gesture::Close),
            Ok(())
        );

        // A second shown window keeps chan running.
        desk.window("lib-00ff::w-remote");
        assert_eq!(
            check(handle, &desk.state, "local::w-shown", Gesture::Hide),
            Ok(())
        );
    }

    /// `cs window hide` and the launcher's Hide flag the window and ask for its
    /// close, and the bury lands on a later turn of the event loop: a second
    /// hide in between must not take the first window for a shown one.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_window_whose_hide_is_under_way_is_not_a_shown_window() {
        let desk = Desk::new().await;
        desk.window("local::w-a");
        desk.window("local::w-b");
        let url = desk
            .embedded()
            .open_terminal_with_command("true".into())
            .await
            .unwrap()
            .0;
        desk.embedded()
            .spawn_terminal_for_tests(&url, Some("w-a"))
            .await;
        desk.state.mark_silent_hide("local::w-a");
        let second = check(desk.app.handle(), &desk.state, "local::w-b", Gesture::Hide);
        assert!(second.is_err(), "the second hide went ahead: {second:?}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_close_does_not_count_the_sessions_its_own_window_ends() {
        let desk = Desk::new().await;
        desk.window("local::w-last");
        let handle = desk.app.handle();
        let url = desk
            .embedded()
            .open_terminal_with_command("true".into())
            .await
            .unwrap()
            .0;
        desk.embedded()
            .spawn_terminal_for_tests(&url, Some("w-last"))
            .await;
        assert_eq!(
            check(handle, &desk.state, "local::w-last", Gesture::Close),
            Ok(()),
            "the window's own shell ends by the close itself"
        );
        assert!(check(handle, &desk.state, "local::w-last", Gesture::Hide).is_err());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_control_terminal_hides_in_place_and_closes_with_its_own_script() {
        let desk = Desk::new().await;
        desk.window("control-terminal-ds");
        let url = desk.control_terminal("ds").await;
        desk.embedded().spawn_terminal_for_tests(&url, None).await;
        let handle = desk.app.handle();
        assert_eq!(
            check(handle, &desk.state, "control-terminal-ds", Gesture::Hide),
            Ok(()),
            "a control terminal hides in place, so chan keeps a window"
        );
        assert_eq!(
            check(handle, &desk.state, "control-terminal-ds", Gesture::Close),
            Ok(()),
            "the connect script ends with its own window"
        );
    }
}
