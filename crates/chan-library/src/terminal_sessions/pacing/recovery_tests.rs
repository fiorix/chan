use super::super::tests::test_session_with_ring;
use super::super::*;

fn expected_suffix(alt_screen: bool, enabled: &[u16]) -> Vec<u8> {
    // The normal-screen head saves the cursor first: xterm.js's ?1049l
    // handler restores unconditionally (InputHandler.resetModePrivate),
    // so without the DECSC the resume jumps to a stale saved position.
    let mut bytes = if alt_screen {
        b"\x18\x1b[?47h".to_vec()
    } else {
        b"\x18\x1b7\x1b[?1049;1047;47l".to_vec()
    };
    for mode in [
        1, 9, 1000, 1001, 1002, 1003, 1004, 1005, 1006, 1015, 1016, 2004,
    ] {
        if !enabled.contains(&mode) {
            bytes.extend_from_slice(format!("\x1b[?{mode}l").as_bytes());
        }
    }
    for mode in enabled {
        bytes.extend_from_slice(format!("\x1b[?{mode}h").as_bytes());
    }
    bytes
}

#[test]
fn missed_live_tail_reconciles_every_mode_and_both_screen_targets() {
    for alt_screen in [false, true] {
        let session = test_session_with_ring(32);
        let attached = session.clone().attach(None).with_output_progress();
        session.record_output(b"\x1b[?1049;1000h");
        session.record_output(b"\x1b[?1049;1000l\x1b[?1006h");
        if alt_screen {
            session.record_output(b"\x1b[?1049h");
        }
        session.record_output(&[b'x'; 40]);
        let recovered = attached.replay_from(0);
        assert!(recovered.missed_bytes > 0);
        assert_eq!(recovered.mode_reassert, expected_suffix(alt_screen, &[1006]), "loss recovery cancels a partial escape and sets every tracked mode without clearing either screen");
    }
}

#[test]
fn fresh_attach_keeps_the_enables_only_prelude() {
    let session = test_session_with_ring(1024);
    session.record_output(b"\x1b[?1049;1000h");
    assert_eq!(session.attach(None).mode_reassert, b"\x1b[?1000h");
}

fn assert_lossless_live_sequence(prefix: &[u8], continuation: &[u8]) {
    let session = test_session_with_ring(1024);
    let attached = session.clone().attach(None).with_output_progress();
    session.record_output(b"\x1b[?2004h");
    session.record_output(prefix);
    let mut recovered = attached.replay_from(0);
    assert_eq!(recovered.missed_bytes, 0);
    session.record_output(continuation);
    let live = loop {
        match recovered.rx.try_recv().expect("live continuation") {
            SessionEvent::Output(bytes) => break bytes,
            SessionEvent::Activity { .. } => {}
            event => panic!("unexpected event before raw continuation: {event:?}"),
        }
    };
    let received = [
        recovered.replay.concat(),
        recovered.mode_reassert.clone(),
        live.to_vec(),
    ]
    .concat();
    assert_eq!(
        received,
        [b"\x1b[?2004h".as_slice(), prefix, continuation].concat(),
        "lossless recovery must not insert mode bytes into a split sequence"
    );
}

#[test]
fn lossless_live_recovery_preserves_a_split_csi_sequence() {
    assert_lossless_live_sequence(b"\x1b[31", b"mRED\x1b[0m");
}

#[test]
fn lossless_live_recovery_preserves_a_split_utf8_sequence() {
    assert_lossless_live_sequence(b"\xe2\x82", b"\xac");
}

#[test]
fn missed_tail_mouse_enables_follow_every_competing_reset() {
    // Xterm has one active mouse protocol and one encoding. Resetting any
    // member clears its whole group, even when a different member is enabled.
    for protocol in [9, 1000, 1002, 1003] {
        for encoding in [1006, 1016] {
            let session = test_session_with_ring(32);
            let attached = session.clone().attach(None).with_output_progress();
            session.record_output(format!("\x1b[?{protocol};{encoding}h").as_bytes());
            session.record_output(&[b'x'; 40]);
            let recovered = attached.replay_from(0);
            assert!(recovered.missed_bytes > 0, "fixture must require recovery");
            let mut last_protocol = None;
            let mut last_encoding = None;
            scan_private_modes(&mut Vec::new(), &recovered.mode_reassert, |mode, on| {
                if [9, 1000, 1002, 1003].contains(&mode) {
                    last_protocol = Some((mode, on));
                }
                if [1006, 1016].contains(&mode) {
                    last_encoding = Some((mode, on));
                }
            });
            assert_eq!(
                last_protocol,
                Some((protocol, true)),
                "the last protocol operation must enable the recorded mouse protocol"
            );
            assert_eq!(
                last_encoding,
                Some((encoding, true)),
                "the last encoding operation must enable the recorded mouse encoding"
            );
        }
    }
}

#[test]
fn pending_output_cannot_change_the_captured_screen_or_mode_state() {
    let mut session = test_session_with_ring(1024);
    Arc::get_mut(&mut session).expect("one owner").id = "pacing-mode-before-ring".into();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    arm_attach_seam(&session.id, AttachSeam::OutputBeforeRingLock, move || {
        ready_tx.send(()).expect("ready");
        release_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("release output");
    });
    let writer = {
        let session = session.clone();
        std::thread::spawn(move || session.record_output(b"\x1b[?1049;1000h"))
    };
    ready_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("output reached seam");
    let captured = session.attach(None);
    release_tx.send(()).expect("release");
    writer.join().expect("output thread");
    assert_eq!(captured.seq, 0);
    assert!(
        !captured.alt_screen,
        "screen state belongs to the ring snapshot, not an uncommitted read"
    );
    assert!(
        captured.mode_reassert.is_empty(),
        "mode state belongs to the ring snapshot"
    );
}

#[test]
fn later_output_cannot_change_an_already_captured_mode_suffix() {
    let mut session = test_session_with_ring(1024);
    Arc::get_mut(&mut session).expect("one owner").id = "pacing-mode-after-ring".into();
    let writer = session.clone();
    arm_attach_seam(&session.id, AttachSeam::AttachAfterRingLock, move || {
        writer.record_output(b"\x1b[?1000h");
    });
    let captured = session.attach(None);
    assert_eq!(captured.seq, 0);
    assert!(
        captured.mode_reassert.is_empty(),
        "mode suffix cannot include bytes after the replay frontier"
    );
}

#[test]
fn retained_restart_and_close_outrank_a_late_exit() {
    let session = test_session_with_ring(1024);
    let attached = session.clone().attach(None);
    session.broadcast(SessionEvent::Exit(TerminalExit::Unknown));
    session.broadcast(SessionEvent::Closed(CloseReason::Explicit));
    session.broadcast(SessionEvent::Exit(TerminalExit::Code { code: 0 }));
    assert_eq!(
        *attached.lifecycle_rx.borrow(),
        Some(SessionLifecycle::Closed(CloseReason::Explicit)),
        "late exit cannot replace retained close"
    );
    session.broadcast(SessionEvent::Restarted);
    session.broadcast(SessionEvent::Closed(CloseReason::Shutdown));
    session.broadcast(SessionEvent::Exit(TerminalExit::Unknown));
    assert_eq!(
        *attached.lifecycle_rx.borrow(),
        Some(SessionLifecycle::Restarted),
        "late close or exit cannot replace retained restart"
    );
}
