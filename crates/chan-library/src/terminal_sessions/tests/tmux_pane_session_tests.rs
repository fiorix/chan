//! A tmux pane session: a registry session with no PTY, fed by its
//! connection and commanding it.

use super::*;
use chan_tmux::PaneId;

fn pane_spec(pane: u32, name: &str) -> TmuxPaneSpec {
    TmuxPaneSpec {
        pane: TmuxPaneRef {
            connection: TmuxConnectionId(1),
            pane: PaneId(pane),
        },
        name: Some(name.to_owned()),
        group: "tmux".to_owned(),
        window_id: Some("win-1".to_owned()),
        size: test_size(),
    }
}

fn drain_output(rx: &mut broadcast::Receiver<SessionEvent>) -> Vec<u8> {
    let mut out = Vec::new();
    while let Ok(event) = rx.try_recv() {
        if let SessionEvent::Output(bytes) = event {
            out.extend_from_slice(&bytes);
        }
    }
    out
}

#[test]
fn a_pane_session_records_output_into_its_ring_and_is_listed() {
    let registry = Registry::new(test_config(4096, 4, 10));
    let (sink, _commands) = std::sync::mpsc::channel();
    let session = registry
        .add_tmux_pane(pane_spec(3, "editor"), sink)
        .unwrap();
    assert!(session.is_tmux_pane());
    assert!(session.child_pid.is_none());
    let mut events = session.output_tx.subscribe();
    session.record_output(b"hello from %3\r\n");
    assert_eq!(drain_output(&mut events), b"hello from %3\r\n");
    let handle = registry
        .attach(&session.id, None)
        .expect("attachable by id");
    assert_eq!(handle.replay.concat(), b"hello from %3\r\n");
    let entry = registry
        .roster()
        .into_iter()
        .find(|entry| entry.id == session.id)
        .expect("in the roster");
    assert_eq!(entry.tab_name.as_deref(), Some("editor"));
    assert_eq!(entry.tab_group, "tmux");
    assert_eq!(entry.window_id.as_deref(), Some("win-1"));
    assert!(registry
        .session_summaries()
        .iter()
        .any(|s| s.session_id == session.id && s.cwd.is_none()));
}

#[test]
fn a_marker_inside_a_pane_is_pane_bytes() {
    let registry = Registry::new(test_config(4096, 4, 10));
    let (sink, _commands) = std::sync::mpsc::channel();
    let session = registry.add_tmux_pane(pane_spec(0, "shell"), sink).unwrap();
    let mut events = session.output_tx.subscribe();
    session.record_output(b"\x1bP1000p%begin 1 1 0\r\n");
    assert_eq!(drain_output(&mut events), b"\x1bP1000p%begin 1 1 0\r\n");
}

#[test]
fn pane_commands_carry_the_pane_id_on_the_connection_channel() {
    let registry = Registry::new(test_config(4096, 4, 10));
    let (sink, commands) = std::sync::mpsc::channel();
    let a = registry
        .add_tmux_pane(pane_spec(7, "a"), sink.clone())
        .unwrap();
    let b = registry.add_tmux_pane(pane_spec(9, "b"), sink).unwrap();
    a.send_input(b"ls\r");
    b.resize(PtySize {
        cols: 100,
        rows: 30,
        ..test_size()
    });
    assert!(registry.close(&a.id, CloseReason::Explicit));
    // (pane, what, detail): the input's bytes, the resize's columns.
    let got: Vec<(u32, &str, Vec<u8>)> = commands
        .try_iter()
        .map(|(pane, command)| match command {
            PtyCommand::Input(bytes) => (pane.0, "input", bytes),
            PtyCommand::Resize(size) => (pane.0, "resize", size.cols.to_string().into_bytes()),
            PtyCommand::Kill => (pane.0, "kill", Vec::new()),
            _ => (pane.0, "other", Vec::new()),
        })
        .collect();
    assert_eq!(
        got,
        vec![
            (7, "input", b"ls\r".to_vec()),
            (9, "resize", b"100".to_vec()),
            (7, "kill", Vec::new()),
        ]
    );
    assert!(
        registry.attach(&a.id, None).is_none(),
        "closed sessions leave the registry"
    );
}

#[test]
fn a_pane_session_is_not_restarted() {
    let registry = Registry::new(test_config(4096, 4, 10));
    let (sink, commands) = std::sync::mpsc::channel();
    let session = registry.add_tmux_pane(pane_spec(1, "p"), sink).unwrap();
    assert!(!registry
        .restart(&session.id, RestartOverrides::default())
        .unwrap());
    assert!(
        commands.try_recv().is_err(),
        "nothing was sent to the connection"
    );
    assert!(
        registry.attach(&session.id, None).is_some(),
        "the session is still there"
    );
}

#[test]
fn the_idle_pruner_leaves_a_detached_pane_alone() {
    let registry = Registry::new(test_config(4096, 4, 10));
    let (sink, _commands) = std::sync::mpsc::channel();
    let session = registry.add_tmux_pane(pane_spec(1, "p"), sink).unwrap();
    assert_eq!(
        registry.prune_idle_at(now_unix_secs() as i64 + 1_000_000),
        0
    );
    assert!(registry.attach(&session.id, None).is_some());
    // A PTY session in the same registry would have gone: the rule is the
    // pane's, not the clock's.
    let (pty, _rx) = test_session_with_commands(1024);
    register_session(&registry, &pty);
    pty.set_window_id(Some("win-2".to_owned()));
    assert_eq!(
        registry.prune_idle_at(now_unix_secs() as i64 + 1_000_000),
        1
    );
}

#[test]
fn panes_are_capped_apart_from_ptys() {
    let registry = Registry::new(test_config(1024, 1, 10));
    let (sink, _commands) = std::sync::mpsc::channel();
    for i in 0..TMUX_PANE_SESSION_CAP {
        registry
            .add_tmux_pane(pane_spec(i as u32, "p"), sink.clone())
            .unwrap_or_else(|e| panic!("pane {i}: {e:?}"));
    }
    assert!(matches!(
        registry.add_tmux_pane(pane_spec(9999, "p"), sink),
        Err(CreateError::Capped)
    ));
    assert_eq!(registry.len(), TMUX_PANE_SESSION_CAP);
}

#[test]
fn a_recorded_exit_reaches_an_attached_client_and_the_reaper() {
    let registry = Registry::new(test_config(4096, 4, 10));
    let (sink, _commands) = std::sync::mpsc::channel();
    let session = registry.add_tmux_pane(pane_spec(2, "p"), sink).unwrap();
    let mut handle = registry.attach(&session.id, None).unwrap();
    session.record_tmux_pane_exit(TerminalExit::Code { code: 0 });
    let mut saw_exit = false;
    while let Ok(event) = handle.rx.try_recv() {
        if matches!(event, SessionEvent::Exit(TerminalExit::Code { code: 0 })) {
            saw_exit = true;
        }
    }
    assert!(saw_exit, "the attached client learns the pane ended");
    assert!(
        registry.last_exit().is_some(),
        "the session itself records it"
    );
    assert_eq!(session.ended.wait(Duration::from_millis(10)), Some(true));
    drop(handle);
    assert_eq!(registry.reap_exited(), 1);
    assert!(registry.attach(&session.id, None).is_none());
    // The reaper's close of an exited session nobody is attached to is
    // remembered as closed, as for a PTY; a socket that ends on the exit
    // removes the incarnation and remembers the exit instead.
    assert!(matches!(
        registry.ended(&session.id),
        Some(SessionEnd::Closed)
    ));
}

#[cfg(target_os = "linux")]
#[test]
fn the_fdstore_manifest_skips_a_pane_session() {
    let registry = Registry::new(test_config(4096, 4, 10));
    let (sink, _commands) = std::sync::mpsc::channel();
    let session = registry.add_tmux_pane(pane_spec(2, "p"), sink).unwrap();
    assert!(session.window_id().is_some());
    let root = registry.config.workspace_root.clone();
    assert!(registry
        .fdstore_manifest_sessions_in_root("ws", &root, false)
        .is_empty());
}
