use super::*;
use serde_json::{json, Value};

struct Session {
    state: Arc<AppState>,
    handle: AttachHandle,
}

impl Session {
    fn new() -> Self {
        let state = crate::state::test_support::make_test_state(false);
        let handle = state
            .terminal_sessions
            .create(CreateOptions {
                size: pty_size(Some(80), Some(24)),
                command: None,
                tab_name: None,
                tab_group: None,
                window_id: None,
                mcp_env: false,
                cwd: None,
                env: BTreeMap::new(),
                profile: None,
            })
            .expect("spawn default shell");
        // Startup output must not change activity between paired serializations.
        handle.set_focused(true);
        Self { state, handle }
    }

    fn tmux() -> Self {
        let state = crate::state::test_support::make_test_state(false);
        let handle = state
            .terminal_sessions
            .create_tmux_pane_for_test(1, 1, pty_size(Some(80), Some(24)))
            .expect("create process-free tmux pane");
        handle.set_focused(true);
        Self { state, handle }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.state
            .terminal_sessions
            .close(self.handle.id(), CloseReason::Explicit);
        self.state.terminal_sessions.remove(self.handle.id());
    }
}

fn frame(handle: &AttachHandle, pty: Option<SessionPty>) -> Value {
    serde_json::to_value(session_frame_with_pty(handle, pty)).expect("session JSON")
}

fn assert_without_pty(value: &Value) {
    assert!(value.get("pty").is_none(), "non-ConPTY omits pty: {value}");
    assert!(
        value.get("windows_build_number").is_none(),
        "non-ConPTY omits the Windows build number: {value}"
    );
}

fn assert_conpty(value: &Value, build: Option<u32>) {
    assert_eq!(value["pty"], "conpty", "ConPTY has its wire discriminator");
    if let Some(build) = build {
        assert_eq!(
            value.get("windows_build_number"),
            Some(&json!(build)),
            "the Windows build is a JSON integer"
        );
    } else {
        assert!(
            value.get("windows_build_number").is_none(),
            "an unknown build is omitted, not zero or null: {value}"
        );
    }
}

fn assert_old_fields_unchanged(mut value: Value, without_pty: &Value) {
    let fields = value.as_object_mut().expect("session object");
    fields.remove("pty");
    fields.remove("windows_build_number");
    assert_eq!(value, *without_pty, "only PTY metadata may be added");
}

#[test]
fn session_pty_serializes_conpty_and_numeric_windows_build() {
    let session = Session::new();
    let without_pty = frame(&session.handle, None);
    let windows = frame(
        &session.handle,
        Some(SessionPty::Conpty {
            windows_build_number: Some(26300),
        }),
    );
    assert_conpty(&windows, Some(26300));
    assert_old_fields_unchanged(windows, &without_pty);
}

#[test]
fn session_pty_omits_both_fields_for_other_ptys() {
    let session = Session::new();
    assert_without_pty(&frame(&session.handle, None));
}

#[test]
fn session_pty_omits_windows_host_metadata_for_tmux_panes() {
    let session = Session::tmux();
    assert!(session.handle.tmux_pane().is_some());
    let without_pty = frame(&session.handle, None);
    assert_without_pty(&without_pty);
    for build in [Some(26300), None] {
        let windows = frame(
            &session.handle,
            Some(SessionPty::Conpty {
                windows_build_number: build,
            }),
        );
        assert_without_pty(&windows);
        assert_eq!(
            windows, without_pty,
            "tmux owns the pane screen even on a Windows host"
        );
    }
}

#[test]
fn session_pty_keeps_conpty_when_windows_build_is_unknown() {
    let session = Session::new();
    let without_pty = frame(&session.handle, None);
    let windows = frame(
        &session.handle,
        Some(SessionPty::Conpty {
            windows_build_number: None,
        }),
    );
    assert_conpty(&windows, None);
    assert_old_fields_unchanged(windows, &without_pty);
}

#[test]
fn session_pty_metadata_survives_restart_and_reattach() {
    let session = Session::new();
    let initial_generation = session.handle.generation;
    let assert_metadata = |handle: &AttachHandle| {
        handle.set_focused(true);
        let without_pty = frame(handle, None);
        assert_without_pty(&without_pty);
        for build in [Some(26300), None] {
            let windows = frame(
                handle,
                Some(SessionPty::Conpty {
                    windows_build_number: build,
                }),
            );
            assert_conpty(&windows, build);
            assert_old_fields_unchanged(windows, &without_pty);
        }
    };
    assert_metadata(&session.handle);
    assert!(session
        .state
        .terminal_sessions
        .restart(session.handle.id(), RestartOverrides::default())
        .expect("restart default shell"));
    let restarted = session
        .state
        .terminal_sessions
        .attach(session.handle.id(), None)
        .expect("attach restarted shell");
    assert_eq!(restarted.id(), session.handle.id());
    assert!(restarted.generation > initial_generation);
    assert_metadata(&restarted);
    let reattached = session
        .state
        .terminal_sessions
        .attach(session.handle.id(), Some(0))
        .expect("reattach restarted shell");
    assert_eq!(reattached.id(), session.handle.id());
    assert_eq!(reattached.generation, restarted.generation);
    assert_metadata(&reattached);
}

#[cfg(windows)]
#[test]
fn session_pty_native_windows_frame_reports_the_host_build() {
    let session = Session::new();
    let raw = sysinfo::System::kernel_version().expect("Windows build query succeeds");
    let expected: u32 = raw.parse().expect("Windows build is a decimal u32");
    assert_ne!(expected, 0, "Windows reports a real build number");
    let value = serde_json::to_value(session_frame(&session.handle)).expect("session JSON");
    assert_conpty(&value, Some(expected));
}

#[cfg(not(windows))]
#[test]
fn session_pty_native_non_windows_frame_omits_windows_metadata() {
    let session = Session::new();
    let value = serde_json::to_value(session_frame(&session.handle)).expect("session JSON");
    assert_without_pty(&value);
}

#[test]
fn session_pty_parses_the_observed_windows_build() {
    let SessionPty::Conpty {
        windows_build_number,
    } = conpty_pty(Some("26300"));
    assert_eq!(windows_build_number, Some(26300));
}

#[test]
fn session_pty_does_not_invent_a_build_for_invalid_or_missing_values() {
    for raw in [
        None,
        Some(""),
        Some("0"),
        Some("-1"),
        Some("4294967296"),
        Some("10.0.26300"),
        Some("26300x"),
        Some(" 26300"),
    ] {
        let SessionPty::Conpty {
            windows_build_number,
        } = conpty_pty(raw);
        assert_eq!(windows_build_number, None, "input {raw:?}");
    }
}
