//! The tmux gate on a session: what the marker does to the ring, the
//! controller and an attached client.

use super::*;
use crate::config::TerminalTmuxConfig;
use crate::terminal_sessions::tmux_gate::Foreground;

const MARKER: &[u8] = b"\x1bP1000p";
/// What the terminal is shown of an entry: the marker and the ST closing it.
const SHOWN: &[u8] = b"\x1bP1000p\x1b\\";
const ENTRY: &[u8] =
    b"%begin 1 1 0\r\n%end 1 1 0\r\n%sessions-changed\r\n%session-changed $0 main\r\n";
const VERSION_REPLY: &[u8] =
    b"%begin 2 2 1\r\n%error 2 2 1\r\n%begin 2 3 1\r\n3.8\r\n%end 2 3 1\r\n";

fn entry() -> Vec<u8> {
    let mut bytes = MARKER.to_vec();
    bytes.extend_from_slice(ENTRY);
    bytes
}

fn foreground(name: &str) -> Foreground {
    Foreground {
        name: Some(name.to_owned()),
        command: Some(format!("{name} -CC")),
    }
}

fn declare_foreground(session: &Session, name: &str) {
    *session
        .tmux_foreground
        .lock()
        .expect("terminal tmux foreground poisoned") = Some(foreground(name));
}

/// Every output chunk broadcast so far, joined.
fn drain_output(rx: &mut broadcast::Receiver<SessionEvent>) -> Vec<u8> {
    let mut out = Vec::new();
    while let Ok(event) = rx.try_recv() {
        if let SessionEvent::Output(bytes) = event {
            out.extend_from_slice(&bytes);
        }
    }
    out
}

fn drain_inputs(rx: &std::sync::mpsc::Receiver<PtyCommand>) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    while let Ok(command) = rx.try_recv() {
        if let PtyCommand::Input(bytes) = command {
            out.push(bytes);
        }
    }
    out
}

#[test]
fn a_local_tmux_marker_enters_without_a_question_and_the_protocol_never_draws() {
    let (session, commands) = test_session_with_commands(4096);
    declare_foreground(&session, "tmux");
    let mut events = session.output_tx.subscribe();

    session.record_output(b"$ tmux -CC\r\n");
    session.record_output(&entry());
    assert_eq!(
        drain_output(&mut events),
        [b"$ tmux -CC\r\n".as_slice(), SHOWN].concat()
    );
    assert_eq!(
        drain_inputs(&commands),
        vec![
            b"\x03\n".to_vec(),
            b"display-message -p '#{version}'\n".to_vec()
        ]
    );
    let handle = session.clone().attach(None);
    assert!(handle.initial_tmux_consent.question.is_none());

    session.record_output(VERSION_REPLY);
    let shown = String::from_utf8(drain_output(&mut events)).unwrap();
    assert_eq!(shown, "\r\n[chan] tmux 3.8 control mode\r\n");

    session.record_output(b"%output %0 hidden\r\n%exit\r\n\x1b\\$ ");
    let shown = String::from_utf8(drain_output(&mut events)).unwrap();
    assert_eq!(shown, "\r\n[chan] tmux 3.8 control mode ended\r\n$ ");
    let ring = session
        .output
        .lock()
        .expect("terminal output poisoned")
        .ring
        .snapshot_since(None)
        .0
        .concat();
    assert!(
        !ring.windows(7).any(|w| w == b"%output"),
        "the ring never held protocol bytes"
    );
}

#[test]
fn another_foreground_asks_every_attached_client_and_a_deny_writes_a_newline() {
    let (session, commands) = test_session_with_commands(4096);
    declare_foreground(&session, "ssh");
    let mut events = session.output_tx.subscribe();
    let early = session.clone().attach(None);
    let mut early_rx = early.tmux_consent_rx.clone();

    session.record_output(&entry());
    assert_eq!(drain_output(&mut events), SHOWN);
    assert!(
        drain_inputs(&commands).is_empty(),
        "nothing is written while the question stands"
    );
    assert!(early_rx.has_changed().unwrap());
    let asked = early_rx.borrow_and_update().clone();
    let question = asked.question.as_ref().expect("the question");
    assert_eq!(question.program, "ssh");
    assert_eq!(question.command.as_deref(), Some("ssh -CC"));

    // A client attaching mid-question sees it at once.
    let late = session.clone().attach(None);
    assert_eq!(late.initial_tmux_consent, asked);

    late.answer_tmux(TmuxAnswer::Deny);
    assert_eq!(drain_inputs(&commands), vec![b"\n".to_vec()]);
    assert!(early_rx.borrow_and_update().question.is_none());
    let shown = String::from_utf8(drain_output(&mut events)).unwrap();
    assert_eq!(shown, "\r\n[chan] tmux control mode denied\r\n");
    session.record_output(b"%exit\r\n\x1b\\$ ");
    assert_eq!(drain_output(&mut events), b"$ ");
    // The second answer changes nothing.
    early.answer_tmux(TmuxAnswer::Allow);
    assert!(drain_inputs(&commands).is_empty());
}

#[test]
fn an_allow_replays_the_held_session_and_the_probe_goes_out() {
    let (session, commands) = test_session_with_commands(4096);
    declare_foreground(&session, "ssh");
    session.record_output(&entry());
    let handle = session.clone().attach(None);
    handle.answer_tmux(TmuxAnswer::Allow);
    assert_eq!(
        drain_inputs(&commands),
        vec![
            b"\x03\n".to_vec(),
            b"display-message -p '#{version}'\n".to_vec()
        ]
    );
}

#[test]
fn the_registry_switch_passes_the_marker_through_and_leaves_a_live_connection_alone() {
    let (session, _commands) = test_session_with_commands(4096);
    declare_foreground(&session, "tmux");
    let mut events = session.output_tx.subscribe();
    session.record_output(&entry());
    session.record_output(VERSION_REPLY);
    drain_output(&mut events);

    let off = TerminalTmuxConfig {
        enabled: false,
        trust: Vec::new(),
    };
    session.apply_tmux_policy(&off);
    session.record_output(b"%output %0 still protocol\r\n");
    assert!(
        drain_output(&mut events).is_empty(),
        "a connection already running keeps swallowing its protocol"
    );
    session.record_output(b"%exit\r\n\x1b\\");
    drain_output(&mut events);

    session.record_output(&entry());
    assert_eq!(
        drain_output(&mut events),
        entry(),
        "off, the marker and what follows are ordinary bytes"
    );
}

#[test]
fn a_trusted_foreground_enters_at_once() {
    let (session, commands) = test_session_with_commands(4096);
    declare_foreground(&session, "ssh");
    session.apply_tmux_policy(&TerminalTmuxConfig {
        enabled: true,
        trust: vec!["ssh".into()],
    });
    session.record_output(&entry());
    assert_eq!(drain_inputs(&commands).len(), 2);
    assert!(session
        .clone()
        .attach(None)
        .initial_tmux_consent
        .question
        .is_none());
}

#[test]
fn the_drainer_tick_denies_an_unanswered_question() {
    let (session, commands) = test_session_with_commands(4096);
    declare_foreground(&session, "cat");
    session.record_output(&entry());
    let handle = session.clone().attach(None);
    assert!(handle.initial_tmux_consent.question.is_some());
    session.tick_tmux(std::time::Instant::now() + tmux_gate::QUESTION_TIMEOUT);
    assert_eq!(drain_inputs(&commands), vec![b"\n".to_vec()]);
    assert!(handle.tmux_consent_rx.borrow().question.is_none());
}
