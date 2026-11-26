use super::super::tests::{opts_with_command, test_config, test_session_with_ring};
use super::super::*;
use super::session_tests::attach_acked;

fn expected_suffix(alt_screen: bool, enabled: &[u16]) -> Vec<u8> {
    // The normal-screen head saves the cursor first: libghostty-vt's
    // ?1049l restores the saved cursor even on the normal screen, so
    // without the DECSC the resume jumps to a stale saved position.
    // The alt head is ?1047h: the core's ?1049h writes the active
    // screen's saved-cursor slot, which over the alternate screen is the
    // program's own, and erases the alternate screen. ?1047h switches
    // screens without touching any saved slot or the alternate screen's
    // contents, and the guest suite exercises exactly that switch (the core
    // also honors ?47h, shown by the app's recovery tests on the core).
    let mut bytes = if alt_screen {
        b"\x18\x1b[?1047h".to_vec()
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
        let attached = attach_acked(&session, None);
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
fn a_resume_past_a_lost_mode_reset_gets_the_live_recovery_suffix() {
    // A redialed view keeps the screen and modes it had parsed up to its
    // cursor. When the reset of those modes is evicted before the redial,
    // only an authoritative suffix can take them away again.
    let session = test_session_with_ring(32);
    let viewer = session.clone().attach(None);
    session.record_output(b"\x1b[?1049h\x1b[?1000h");
    let cursor = session.clone().attach(None).seq;
    session.record_output(b"\x1b[?1049l\x1b[?1000l");
    session.record_output(b"$ the shell again\r\n");
    let live = viewer.replay_from(cursor);
    assert!(live.missed_bytes > 0, "fixture: the reset was evicted");
    assert_eq!(
        live.mode_reassert,
        expected_suffix(false, &[]),
        "fixture: a live socket's recovery from the cursor resets every mode"
    );
    let resumed = session.clone().attach(Some(cursor));
    assert_eq!(resumed.missed_bytes, live.missed_bytes);
    assert_eq!(
        resumed.mode_reassert, live.mode_reassert,
        "a resume that lost bytes gets the suffix a live recovery gets"
    );
}

/// A registry holding `session` live, for a dial through
/// [`Registry::get_or_create_for_ws`], which chooses the resume.
fn registry_holding(session: &Arc<Session>) -> Registry {
    let registry = Registry::new(test_config(1024, 4, 60));
    registry
        .sessions
        .lock()
        .expect("terminal registry poisoned")
        .insert(session.id.clone(), session.clone());
    registry
}

fn dial(
    registry: &Registry,
    session: &Session,
    since: u64,
    generation: Option<u64>,
) -> AttachHandle {
    registry
        .get_or_create_for_ws(
            Some(&session.id),
            Some(since),
            opts_with_command("true"),
            TerminalPlacement::default(),
            generation,
            None,
        )
        .expect("the session is live")
}

#[test]
fn a_redial_of_the_live_generation_resumes_as_the_live_recovery() {
    // A redialed view kept the screen it parsed up to its cursor, the
    // alternate one included, so it resumes as its live socket would: the
    // raw delta, nothing added when nothing was lost, the authoritative
    // suffix when the ring moved past a reset.
    for (ring, lossy) in [(1024, false), (32, true)] {
        let session = test_session_with_ring(ring);
        let registry = registry_holding(&session);
        let viewer = session.clone().attach(None);
        session.record_output(b"\x1b[?1049h\x1b[?1000h");
        let cursor = session.clone().attach(None).seq;
        session.record_output(b"\x1b[?1000l");
        session.record_output(&[b'x'; 32]);
        let live = viewer.replay_from(cursor);
        assert_eq!(
            live.missed_bytes > 0,
            lossy,
            "fixture: loss in a {ring}-byte ring"
        );
        assert_eq!(
            live.mode_reassert,
            if lossy {
                expected_suffix(true, &[])
            } else {
                Vec::new()
            },
            "fixture: the live recovery in a {ring}-byte ring"
        );
        let redial = dial(&registry, &session, cursor, Some(session.generation));
        assert_eq!(
            (redial.replay.concat(), redial.missed_bytes),
            (live.replay.concat(), live.missed_bytes),
            "a redial of the live generation in a {ring}-byte ring replays the raw delta, \
             alternate-screen bytes included, as the live recovery does"
        );
        assert_eq!(
            redial.mode_reassert, live.mode_reassert,
            "a redial of the live generation in a {ring}-byte ring gets the live recovery's \
             mode bytes"
        );
        assert!(
            redial.continues_view,
            "a redial of the live generation in a {ring}-byte ring continues its view, so it \
             gets no alternate-screen attach prelude"
        );
    }
}

#[test]
fn a_dial_without_a_live_generation_cursor_keeps_its_resume() {
    // Only a cursor proven by the live generation names a screen the dial
    // continues. A fresh view, a cursor no generation proves and another
    // life's cursor take the alternate screen's attach: no replay, and the
    // modes the program has on.
    let session = test_session_with_ring(1024);
    let registry = registry_holding(&session);
    session.record_output(b"\x1b[?1049h\x1b[?1000h");
    let cursor = session.clone().attach(None).seq;
    session.record_output(b"\x1b[?1000l\x1b[?1h");
    let live = Some(session.generation);
    for (since, generation, dialed) in [
        (0, None, "a fresh view"),
        (0, live, "a cursor at 0 in the live generation"),
        (cursor, None, "a cursor with no generation"),
        (
            cursor,
            Some(session.generation + 1),
            "another life's cursor",
        ),
    ] {
        let attached = dial(&registry, &session, since, generation);
        assert!(attached.alt_screen, "fixture: the alternate screen");
        assert!(attached.replay.is_empty(), "{dialed} replays nothing");
        assert_eq!(attached.missed_bytes, 0, "{dialed} counts nothing missed");
        assert_eq!(
            String::from_utf8_lossy(&attached.mode_reassert),
            "\x1b[?1h",
            "{dialed} gets the enables-only prelude"
        );
        assert!(
            !attached.continues_view,
            "{dialed} continues no view, so it gets the alternate-screen attach prelude"
        );
    }
}

const PLAIN_SCREEN_SWITCH: &[u8] = b"\x18\x1b7\x1b[?1049;1047;47l";
const ALT_SCREEN_SWITCH: &[u8] = b"\x18\x1b[?1047h";

#[test]
fn a_resume_past_a_lost_screen_switch_is_put_on_the_screen_its_replay_starts_on() {
    for alt_screen in [false, true] {
        let session = test_session_with_ring(32);
        let viewer = session.clone().attach(None);
        session.record_output(if alt_screen { b"$ " } else { b"\x1b[?1049h" });
        let cursor = session.clone().attach(None).seq;
        // The switch the view never parsed is evicted, and the ring keeps
        // only output drawn on the screen the program switched to.
        session.record_output(if alt_screen {
            b"\x1b[?1049h"
        } else {
            b"\x1b[?1049l"
        });
        session.record_output(&[b'x'; 40]);
        let live = viewer.replay_from(cursor);
        assert!(live.missed_bytes > 0, "fixture: the switch was evicted");
        let expected = if alt_screen {
            ALT_SCREEN_SWITCH
        } else {
            PLAIN_SCREEN_SWITCH
        };
        assert_eq!(
            String::from_utf8_lossy(&live.replay_screen),
            String::from_utf8_lossy(expected),
            "a recovery past a lost switch is put on the screen the ring ends on \
             (alternate screen: {alt_screen})"
        );
        assert!(
            live.mode_reassert.starts_with(expected),
            "the suffix after the replay selects the same screen"
        );
        if !alt_screen {
            let resumed = session.clone().attach(Some(cursor));
            assert_eq!(
                resumed.replay_screen, live.replay_screen,
                "a resume that lost bytes gets the switch a live recovery gets"
            );
        }
        let fresh = session.clone().attach(Some(0));
        assert!(
            fresh.replay_screen.is_empty(),
            "a fresh view dialed at 0 never parsed the lost span"
        );
    }
}

#[test]
fn a_lossy_replay_that_switches_screens_gets_no_switch_ahead_of_it() {
    let session = test_session_with_ring(32);
    let viewer = session.clone().attach(None);
    session.record_output(b"\x1b[?1049h");
    let cursor = session.clone().attach(None).seq;
    session.record_output(&[b'f'; 20]);
    session.record_output(&[b'f'; 10]);
    // Two reads split the switch inside the retained tail.
    session.record_output(b"\x1b[?1000;10");
    session.record_output(b"49l$ ");
    let live = viewer.replay_from(cursor);
    assert!(
        live.missed_bytes > 0,
        "fixture: the ring moved past the cursor"
    );
    assert_eq!(
        String::from_utf8_lossy(&live.replay.concat()),
        "ffffffffff\x1b[?1000;1049l$ ",
        "fixture: the replay holds the program's frame and its split switch"
    );
    assert!(
        live.replay_screen.is_empty(),
        "the session keeps no screen for the start of a replay that switches screens"
    );
    assert_eq!(
        live.mode_reassert,
        expected_suffix(false, &[]),
        "the suffix still reconciles the screen and the modes after the replay"
    );
}

#[test]
fn a_switch_the_ring_start_cut_is_not_one_the_replay_makes() {
    let session = test_session_with_ring(32);
    let viewer = session.clone().attach(None);
    session.record_output(b"\x1b[?1049h");
    let cursor = session.clone().attach(None).seq;
    // Two reads split the switch, and the eviction of the first leaves the
    // ring starting inside it: a view parses the rest as text.
    session.record_output(b"\x1b[?10");
    session.record_output(b"49l");
    session.record_output(&[b'x'; 29]);
    let live = viewer.replay_from(cursor);
    assert!(
        live.replay.concat().starts_with(b"49l"),
        "fixture: the ring starts inside the switch"
    );
    assert!(
        !live.alt_screen,
        "fixture: the session read the split switch"
    );
    assert_eq!(
        String::from_utf8_lossy(&live.replay_screen),
        String::from_utf8_lossy(PLAIN_SCREEN_SWITCH),
        "the replay switches no screen, so it starts on the screen the ring ends on"
    );
}

#[test]
fn fresh_attach_keeps_the_enables_only_prelude() {
    let session = test_session_with_ring(1024);
    session.record_output(b"\x1b[?1049;1000h");
    assert_eq!(session.attach(None).mode_reassert, b"\x1b[?1000h");
}

#[test]
fn a_fresh_view_past_an_overflowed_ring_keeps_the_enables_only_prelude() {
    // A fresh view dials at 0, so an overflowed ring gives it a missed
    // count. It never parsed the lost span, so it has no screen whose
    // modes that span could have reset.
    let session = test_session_with_ring(32);
    session.record_output(b"\x1b[?2004h");
    session.record_output(b"more shell output than the ring can hold, twice over");
    let fresh = session.attach(Some(0));
    assert!(fresh.missed_bytes > 0, "fixture: the ring overflowed");
    assert_eq!(
        String::from_utf8_lossy(&fresh.mode_reassert),
        "\x1b[?2004h",
        "a fresh view past an overflowed ring gets the enables-only prelude"
    );
}

fn assert_lossless_live_sequence(prefix: &[u8], continuation: &[u8]) {
    let session = test_session_with_ring(1024);
    let attached = attach_acked(&session, None);
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
            let attached = attach_acked(&session, None);
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
