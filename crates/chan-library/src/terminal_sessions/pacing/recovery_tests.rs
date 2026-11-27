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

#[test]
fn a_resume_past_a_lost_switch_names_the_screen_its_replay_starts_on() {
    for alt_screen in [false, true] {
        let session = test_session_with_ring(32);
        let viewer = session.clone().attach(None);
        session.record_output(if alt_screen { b"$ " } else { b"\x1b[?1049h" });
        let cursor = session.clone().attach(None).seq;
        // The switch the view never parsed is evicted, and the ring keeps
        // only output drawn on the screen it selected.
        session.record_output(if alt_screen {
            b"\x1b[?1049h"
        } else {
            b"\x1b[?1049l"
        });
        session.record_output(&[b'x'; 20]);
        session.record_output(&[b'y'; 20]);
        let screen = Some(TerminalScreen::of(alt_screen));
        let live = viewer.replay_from(cursor);
        assert!(live.missed_bytes > 0, "fixture: the switch was evicted");
        assert_eq!(
            live.replay_screen, screen,
            "a live recovery names the screen its replay starts on"
        );
        if !alt_screen {
            assert_eq!(
                session.clone().attach(Some(cursor)).replay_screen,
                screen,
                "a resume that lost bytes names the screen a live recovery names"
            );
        }
        assert_eq!(
            session.clone().attach(Some(0)).replay_screen,
            None,
            "a fresh view dialed at 0 never parsed the lost span"
        );
        let end = session.clone().attach(None).seq;
        assert_eq!(
            session.clone().attach(Some(end)).replay_screen,
            None,
            "a resume that misses nothing names no screen"
        );
    }
}

#[test]
fn a_replay_whose_first_write_switches_screens_names_the_screen_of_its_first_byte() {
    let session = test_session_with_ring(32);
    let viewer = session.clone().attach(None);
    session.record_output(b"\x1b[?1049h");
    let cursor = session.clone().attach(None).seq;
    session.record_output(b"\x1b[?1049l");
    session.record_output(&[b'f'; 20]);
    session.record_output(b"between\r\n\x1b[?1049htui2 frame");
    let live = viewer.replay_from(cursor);
    assert_eq!(
        String::from_utf8_lossy(&live.replay.concat()),
        "between\r\n\x1b[?1049htui2 frame",
        "fixture: the ring keeps the last write alone"
    );
    assert!(
        live.alt_screen,
        "fixture: the write ends on the alternate screen"
    );
    assert_eq!(
        live.replay_screen,
        Some(TerminalScreen::Normal),
        "the screen of the write's first byte, before its own switch"
    );
}

#[test]
fn a_switch_the_ring_start_cut_counts_as_made() {
    let session = test_session_with_ring(32);
    let viewer = session.clone().attach(None);
    session.record_output(b"\x1b[?1049h");
    let cursor = session.clone().attach(None).seq;
    session.record_output(&[b'f'; 20]);
    // Two reads split the switch to the normal screen, and the ring keeps
    // only the second: a view parses its rest as text.
    session.record_output(b"\x1b[?10");
    session.record_output(b"49lBETWEEN_TUIS\r\n\x1b[?1049htui2");
    let live = viewer.replay_from(cursor);
    assert_eq!(
        String::from_utf8_lossy(&live.replay.concat()),
        "49lBETWEEN_TUIS\r\n\x1b[?1049htui2",
        "fixture: the ring starts inside the switch"
    );
    assert_eq!(
        live.replay_screen,
        Some(TerminalScreen::Normal),
        "the screen the cut switch selects, not the one before it or after the next"
    );
}

#[test]
fn a_switch_the_ring_start_cut_counts_as_made_across_the_reads_that_finish_it() {
    let session = test_session_with_ring(32);
    let viewer = session.clone().attach(None);
    session.record_output(b"\x1b[?1049h");
    let cursor = session.clone().attach(None).seq;
    session.record_output(&[b'f'; 20]);
    // Three reads split the switch to the normal screen, and the ring
    // keeps the last two.
    session.record_output(b"\x1b[?");
    session.record_output(b"10");
    session.record_output(b"49lBETWEEN_TUIS\r\n\x1b[?1049htui2");
    let live = viewer.replay_from(cursor);
    assert_eq!(
        live.replay,
        [
            b"10".to_vec(),
            b"49lBETWEEN_TUIS\r\n\x1b[?1049htui2".to_vec()
        ],
        "fixture: the ring starts inside the switch"
    );
    assert_eq!(
        live.replay_screen,
        Some(TerminalScreen::Normal),
        "the screen the cut switch selects in the replay's second write"
    );
}

#[test]
fn a_mode_change_the_ring_start_cut_keeps_the_screen_it_was_made_on() {
    let session = test_session_with_ring(32);
    let viewer = session.clone().attach(None);
    session.record_output(b"\x1b[?1049h\x1b[?1000h");
    let cursor = session.clone().attach(None).seq;
    session.record_output(&[b'f'; 20]);
    // Two reads split the program's mouse-mode reset on its alternate
    // screen, and the ring keeps only the second.
    session.record_output(b"\x1b[?10");
    session.record_output(b"00lthe frame after the reset\r\n");
    let live = viewer.replay_from(cursor);
    assert_eq!(
        String::from_utf8_lossy(&live.replay.concat()),
        "00lthe frame after the reset\r\n",
        "fixture: the ring starts inside the reset"
    );
    assert_eq!(
        live.replay_screen,
        Some(TerminalScreen::Alternate),
        "a cut sequence that switches no screen leaves the screen of the ring's start"
    );
}

#[test]
fn a_replay_that_starts_after_a_full_reset_names_the_normal_screen() {
    let session = test_session_with_ring(32);
    let viewer = session.clone().attach(None);
    session.record_output(b"\x1b[?1049h\x1b[?1000h");
    let cursor = session.clone().attach(None).seq;
    // The program's RIS and its next frame are evicted, and the ring keeps
    // only output drawn after them.
    session.record_output(b"\x1bc");
    session.record_output(&[b'x'; 20]);
    session.record_output(&[b'y'; 20]);
    let live = viewer.replay_from(cursor);
    assert_eq!(
        live.replay.concat(),
        [b'y'; 20],
        "fixture: the ring keeps the last write alone"
    );
    assert_eq!(
        (
            live.replay_screen,
            live.alt_screen,
            String::from_utf8_lossy(&live.mode_reassert).into_owned()
        ),
        (
            Some(TerminalScreen::Normal),
            false,
            "\x18\x1b7\x1b[?1049;1047;47l\x1b[?1l\x1b[?9l\x1b[?1000l\x1b[?1001l\x1b[?1002l\
             \x1b[?1003l\x1b[?1004l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l\x1b[?2004l"
                .to_owned()
        ),
        "(replay screen, alternate screen, recovery suffix): RIS selects the normal \
         screen and turns every tracked mode off"
    );
}

#[test]
fn a_full_reset_the_ring_start_cut_counts_as_made() {
    // The core passes over a C0 control between RIS's ESC and its `c`, so
    // a cut there leaves the reset as begun as one right after the ESC.
    for start in [b"\x1b".as_slice(), b"\x1b\r"] {
        let session = test_session_with_ring(32);
        let viewer = session.clone().attach(None);
        session.record_output(b"\x1b[?1049h\x1b[?1000h");
        let cursor = session.clone().attach(None).seq;
        session.record_output(&[b'f'; 20]);
        // Two reads split the program's RIS, and the ring keeps only the
        // second: a view parses its rest as text.
        session.record_output(&[b"zz".as_slice(), start].concat());
        session.record_output(&[b"cBETWEEN_TUIS\r\n".as_slice(), &[b'y'; 15]].concat());
        let live = viewer.replay_from(cursor);
        assert!(
            live.replay.concat().starts_with(b"cBETWEEN_TUIS"),
            "fixture: the ring starts inside the reset begun by {start:?}"
        );
        assert_eq!(
            (live.replay_screen, live.alt_screen),
            (Some(TerminalScreen::Normal), false),
            "(replay screen, alternate screen): the reset begun by {start:?} that the ring's \
             start cut selects the normal screen"
        );
    }
}

#[test]
fn a_switch_carried_into_the_ring_ends_with_its_own_sequence() {
    let session = test_session_with_ring(64);
    let viewer = session.clone().attach(None);
    session.record_output(b"\x1b[?1049h");
    let cursor = session.clone().attach(None).seq;
    session.record_output(&[b'f'; 40]);
    session.record_output(b"\x1b[?10");
    // The ring starts inside a switch to the normal screen, and its two
    // writes split another one, back to the alternate screen.
    session.record_output(&[b"49l".as_slice(), &[b'x'; 52], b"\x1b[?10"].concat());
    session.record_output(b"49h");
    let live = viewer.replay_from(cursor);
    assert_eq!(
        live.replay.len(),
        2,
        "fixture: the ring keeps the two writes"
    );
    assert!(
        live.replay[0].starts_with(b"49l"),
        "fixture: the ring starts inside the first switch"
    );
    assert_eq!(
        live.replay_screen,
        Some(TerminalScreen::Normal),
        "the carried switch ends in the first write; the next is the program's own"
    );
}

#[test]
fn a_lossy_attach_on_an_empty_ring_names_the_screen_it_ends_on() {
    let session = test_session_with_ring(32);
    let attached = session.clone().attach(Some(5));
    assert!(
        attached.missed_bytes > 0 && attached.replay.is_empty(),
        "fixture: a cursor past an empty ring"
    );
    assert_eq!(attached.replay_screen, Some(TerminalScreen::Normal));
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
