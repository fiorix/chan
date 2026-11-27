use super::*;

#[test]
fn an_alt_screen_reentry_in_one_read_takes_no_normal_screen_replay() {
    let session = test_session_with_ring(1024);
    session.record_output(b"normal-screen sentinel\r\n");
    session.record_output(b"\x1b[?1049hfirst screen");
    session.record_output(b"\x1b[?1049l\x1b[?1049hsecond screen");
    let attached = session.clone().attach(Some(0));
    assert!(
        attached.alt_screen,
        "the final DECSET selects the alternate screen"
    );
    assert!(
        attached.replay.is_empty(),
        "alternate screen takes no replay"
    );

    session.record_output(b"\x1b[?1049h\x1b[?1049lnormal again");
    let attached = session.attach(Some(0));
    assert!(
        !attached.alt_screen,
        "the final DECRST selects the normal screen"
    );
    assert!(
        contains_subslice(&attached.replay.concat(), b"normal-screen sentinel"),
        "normal-screen reattach retains its replay"
    );
}

#[test]
fn a_legacy_alt_screen_takes_no_normal_screen_replay() {
    for mode in [47, 1047] {
        let session = test_session_with_ring(1024);
        session.record_output(b"normal-screen sentinel\r\n");
        session.record_output(format!("\x1b[?{mode}hframe").as_bytes());
        let attached = session.attach(Some(0));
        assert!(
            attached.alt_screen,
            "DECSET {mode} selects the alternate screen"
        );
        assert!(
            attached.replay.is_empty(),
            "DECSET {mode} suppresses replay"
        );
    }
}

#[test]
fn alt_screen_1047_takes_no_normal_screen_replay() {
    let session = test_session_with_ring(1024);
    session.record_output(b"normal-screen sentinel\r\n\x1b[?1047hframe");
    let attached = session.attach(Some(0));
    assert!(
        attached.alt_screen,
        "DECSET 1047 selects the alternate screen"
    );
    assert!(attached.replay.is_empty(), "DECSET 1047 suppresses replay");
}

#[test]
fn decrqm_keeps_an_enabled_alt_screen_on() {
    let session = test_session_with_ring(1024);
    session.record_output(b"normal-screen sentinel\r\n\x1b[?1047hframe");
    assert!(session.in_alt_screen.load(Ordering::Relaxed));

    session.record_output(b"\x1b[?1047$p");

    let attached = session.attach(Some(0));
    assert!(
        attached.alt_screen,
        "DECRQM must leave the alternate-screen tracker on"
    );
    assert!(
        attached.replay.is_empty(),
        "a mode query must not expose normal-screen replay"
    );
}

#[test]
fn decrqm_keeps_an_enabled_mouse_mode_on() {
    let session = test_session_with_ring(1024);
    session.record_output(b"\x1b[?1015h");
    assert_eq!(modes_on(&session), vec![1015]);

    session.record_output(b"\x1b[?1015$p");

    assert_eq!(
        modes_on(&session),
        vec![1015],
        "DECRQM must leave the private-mode tracker on"
    );
    assert_eq!(
        session.attach(Some(0)).mode_reassert,
        b"\x1b[?1015h",
        "the queried mouse mode must remain in the attach prelude"
    );
}

#[test]
fn a_grouped_alt_screen_takes_no_normal_screen_replay() {
    let session = test_session_with_ring(1024);
    session.record_output(b"normal-screen sentinel\r\n");
    session.record_output(b"\x1b[?1000;1049hframe");
    let attached = session.attach(Some(0));
    assert!(
        attached.alt_screen,
        "grouped DECSET selects the alternate screen"
    );
    assert!(
        attached.replay.is_empty(),
        "grouped DECSET suppresses replay"
    );
}

#[test]
fn an_alt_screen_reattach_reasserts_urxvt_mouse_coordinates() {
    let session = test_session_with_ring(1024);
    session.record_output(b"\x1b[?1049h\x1b[?1015h");
    let attached = session.attach(Some(0));
    assert!(attached.alt_screen);
    assert!(attached.replay.is_empty());
    assert_eq!(
        attached.mode_reassert, b"\x1b[?1015h",
        "reattach restores urxvt mouse coordinates"
    );
}

macro_rules! alt_screen_reset_test {
    ($name:ident, $sequence:expr) => {
        #[test]
        fn $name() {
            let session = test_session_with_ring(1024);
            session.record_output(b"normal-screen sentinel\r\n\x1b[?1049hframe");
            assert!(session.in_alt_screen.load(Ordering::Relaxed));
            session.record_output($sequence);
            let attached = session.attach(Some(0));
            assert!(!attached.alt_screen, "DECRST selects the normal screen");
            assert!(
                contains_subslice(&attached.replay.concat(), b"normal-screen sentinel"),
                "normal-screen reattach retains its replay"
            );
        }
    };
}

alt_screen_reset_test!(alt_screen_47_reset_restores_replay, b"\x1b[?47l");
alt_screen_reset_test!(alt_screen_1047_reset_restores_replay, b"\x1b[?1047l");
alt_screen_reset_test!(
    alt_screen_47_grouped_reset_restores_replay,
    b"\x1b[?1000;47l"
);
alt_screen_reset_test!(
    alt_screen_1047_grouped_reset_restores_replay,
    b"\x1b[?1000;1047l"
);
alt_screen_reset_test!(
    alt_screen_1049_grouped_reset_restores_replay,
    b"\x1b[?1000;1049l"
);

macro_rules! grouped_alt_screen_test {
    ($name:ident, $mode:literal) => {
        #[test]
        fn $name() {
            for sequence in [
                format!("\x1b[?{};1000h", $mode),
                format!("\x1b[?1000;{}h", $mode),
                format!("\x1b[?1;{};1000h", $mode),
            ] {
                let session = test_session_with_ring(1024);
                session.record_output(b"normal-screen sentinel\r\n");
                session.record_output(sequence.as_bytes());
                let attached = session.attach(Some(0));
                assert!(
                    attached.alt_screen,
                    "grouped DECSET {} selects the alternate screen: {sequence:?}",
                    $mode
                );
                assert!(
                    attached.replay.is_empty(),
                    "grouped DECSET suppresses replay"
                );
            }
        }
    };
}

grouped_alt_screen_test!(alt_screen_47_grouped_set_takes_no_replay, 47);
grouped_alt_screen_test!(alt_screen_1047_grouped_set_takes_no_replay, 1047);

#[test]
fn alt_screen_reentry_carries_a_partial_csi_after_an_exit() {
    let session = test_session_with_ring(1024);
    session.record_output(b"normal-screen sentinel\r\n\x1b[?1049hframe");
    session.record_output(b"\x1b[?1049l\x1b[?10");
    assert!(
        !session.in_alt_screen.load(Ordering::Relaxed),
        "a partial re-entry leaves the completed exit in force"
    );
    session.record_output(b"49hnext frame");
    let attached = session.attach(Some(0));
    assert!(
        attached.alt_screen,
        "the carried DECSET completes the re-entry"
    );
    assert!(
        attached.replay.is_empty(),
        "split re-entry suppresses replay"
    );
}

#[test]
fn an_interrupted_private_mode_csi_does_not_hide_an_alt_screen_transition() {
    let session = test_session_with_ring(1024);
    session.record_output(b"\x1b[?1000\x1b[?1049hframe");
    let attached = session.attach(Some(0));
    assert!(
        attached.alt_screen,
        "ESC starts a new CSI after an interrupted one"
    );
    assert!(attached.replay.is_empty(), "the new CSI suppresses replay");
}

#[test]
fn an_interrupting_escape_can_start_an_alt_screen_csi_in_the_next_read() {
    let session = test_session_with_ring(1024);
    session.record_output(b"\x1b[?1000\x1b");
    session.record_output(b"[?1049hframe");
    let attached = session.attach(Some(0));
    assert!(
        attached.alt_screen,
        "the interrupting ESC is carried to the next read"
    );
    assert!(
        attached.replay.is_empty(),
        "the split new CSI suppresses replay"
    );
}

#[test]
fn alt_screen_grouped_csi_at_the_carry_limit_completes() {
    let session = test_session_with_ring(1024);
    let partial = format!("\x1b[?{}1", "0;".repeat(30));
    assert_eq!(partial.len(), PRIVATE_MODE_TAIL_CAP);
    session.record_output(partial.as_bytes());
    session.record_output(b";1049hframe");
    let attached = session.attach(Some(0));
    assert!(attached.alt_screen, "a CSI at the carry limit can complete");
    assert!(
        attached.replay.is_empty(),
        "the completed grouped CSI suppresses replay"
    );
}

#[test]
fn alt_screen_discards_an_overlong_partial_csi_and_recovers() {
    let session = test_session_with_ring(1024);
    let partial = format!("\x1b[?{}", "0;".repeat(31));
    assert_eq!(partial.len(), PRIVATE_MODE_TAIL_CAP + 1);
    session.record_output(partial.as_bytes());
    session.record_output(b"1049h");
    assert!(
        !session.in_alt_screen.load(Ordering::Relaxed),
        "an overlong partial CSI is discarded"
    );
    session.record_output(b"\x1b[?1049hframe");
    let attached = session.attach(Some(0));
    assert!(
        attached.alt_screen,
        "a new complete CSI still selects the alternate screen"
    );
    assert!(attached.replay.is_empty(), "recovery suppresses replay");
}

macro_rules! mouse_mode_tests {
    ($set:ident, $reset:ident, $mode:literal) => {
        #[test]
        fn $set() {
            let session = test_session_with_ring(1024);
            session.record_output(b"\x1b[?1049h");
            session.record_output(format!("\x1b[?{}h", $mode).as_bytes());
            let attached = session.attach(Some(0));
            assert!(attached.alt_screen);
            assert!(attached.replay.is_empty());
            assert_eq!(
                attached.mode_reassert,
                format!("\x1b[?{}h", $mode).as_bytes(),
                "DECSET {} is reasserted on attach",
                $mode
            );
        }

        #[test]
        fn $reset() {
            let session = test_session_with_ring(1024);
            session.record_output(b"\x1b[?1049h");
            // Seed the live mode so DECRST is verified independently of DECSET.
            session.private_modes.lock().unwrap().insert($mode);
            session.record_output(format!("\x1b[?{}l", $mode).as_bytes());
            let attached = session.attach(Some(0));
            assert!(attached.alt_screen);
            assert!(attached.replay.is_empty());
            assert!(
                attached.mode_reassert.is_empty(),
                "DECRST {} removes the mode from the attach prelude",
                $mode
            );
        }
    };
}

mouse_mode_tests!(
    mouse_9_set_is_reasserted,
    mouse_9_reset_is_not_reasserted,
    9
);
mouse_mode_tests!(
    mouse_1001_set_is_reasserted,
    mouse_1001_reset_is_not_reasserted,
    1001
);
mouse_mode_tests!(
    mouse_1005_set_is_reasserted,
    mouse_1005_reset_is_not_reasserted,
    1005
);
mouse_mode_tests!(
    mouse_1015_set_is_reasserted,
    mouse_1015_reset_is_not_reasserted,
    1015
);
mouse_mode_tests!(
    mouse_1016_set_is_reasserted,
    mouse_1016_reset_is_not_reasserted,
    1016
);

#[test]
fn reattach_prelude_orders_input_modes_and_omits_rendering_modes() {
    let session = test_session_with_ring(1024);
    session.record_output(
        b"\x1b[?1049h\x1b[?2004;1016;1015;1006;1005;1004;1003;1002;1001;1000;9;1;7;25h",
    );
    let attached = session.attach(Some(0));
    assert!(attached.alt_screen);
    assert!(attached.replay.is_empty());
    assert_eq!(
        attached.mode_reassert,
        b"\x1b[?1h\x1b[?9h\x1b[?1000h\x1b[?1001h\x1b[?1002h\x1b[?1003h\x1b[?1004h\x1b[?1005h\x1b[?1006h\x1b[?1015h\x1b[?1016h\x1b[?2004h",
        "the prelude orders input modes numerically and excludes screen modes"
    );
}

/// A session on the alternate screen with mouse tracking on, as a full
/// screen program leaves it before `reset` or `tput reset` sends RIS.
fn session_on_the_alternate_screen_with_a_mouse_mode() -> Arc<Session> {
    let session = test_session_with_ring(1024);
    session.record_output(b"normal-screen sentinel\r\n\x1b[?1049h\x1b[?1000hframe");
    assert!(
        session.in_alt_screen.load(Ordering::Relaxed),
        "fixture: the program is on the alternate screen"
    );
    assert_eq!(
        modes_on(&session),
        vec![1000],
        "fixture: the program turned mouse tracking on"
    );
    session
}

/// RIS left `session` on the normal screen with no tracked mode on, as the
/// terminal core leaves a view after it, so a fresh view is told the same.
fn assert_reset_to_the_normal_screen(session: Arc<Session>, how: &str) {
    let alt_screen = session.in_alt_screen.load(Ordering::Relaxed);
    let modes = modes_on(&session);
    let attached = session.attach(Some(0));
    assert_eq!(
        (
            alt_screen,
            modes,
            attached.alt_screen,
            String::from_utf8_lossy(&attached.mode_reassert).into_owned()
        ),
        (false, Vec::new(), false, String::new()),
        "(alternate screen, modes on, a fresh attach's alternate screen, its mode \
         reassert): RIS {how} selects the normal screen and turns every tracked mode off"
    );
}

#[test]
fn a_full_reset_in_one_read_selects_the_normal_screen_and_clears_the_modes() {
    let session = session_on_the_alternate_screen_with_a_mouse_mode();
    session.record_output(b"\x1bcplain");
    assert_reset_to_the_normal_screen(session, "in one read");
}

#[test]
fn a_full_reset_split_across_reads_selects_the_normal_screen_and_clears_the_modes() {
    let session = session_on_the_alternate_screen_with_a_mouse_mode();
    session.record_output(b"more frame\x1b");
    session.record_output(b"cplain");
    assert_reset_to_the_normal_screen(session, "split after its ESC");
}

#[test]
fn a_mode_set_after_a_full_reset_in_the_same_read_stays_on() {
    let session = test_session_with_ring(1024);
    session.record_output(b"\x1b[?1049h\x1b[?1000h\x1bc\x1b[?1006h");
    assert_eq!(
        (
            session.in_alt_screen.load(Ordering::Relaxed),
            modes_on(&session)
        ),
        (false, vec![1006]),
        "(alternate screen, modes on): RIS ends the switch and the mode before it, and the \
         mode set after it stays on"
    );
}

#[test]
fn a_switch_after_a_full_reset_in_the_same_read_stands() {
    let session = test_session_with_ring(1024);
    session.record_output(b"\x1b[?1000h\x1bc\x1b[?1049hframe");
    let attached = session.clone().attach(Some(0));
    assert!(
        attached.alt_screen,
        "a switch after RIS selects the alternate screen"
    );
    assert!(
        attached.replay.is_empty(),
        "the alternate screen takes no replay"
    );
}

// The terminal core executes a C0 control inside a CSI and ignores a DEL
// there, and the sequence goes on to its final byte; CAN and SUB cancel it,
// and ESC cancels it and starts the next. These cases hold the tracker to
// that reading, so a view and its session agree on the screen and the
// modes.
macro_rules! a_switch_across_a_control_test {
    ($leaves:ident, $resets:ident, $control:literal) => {
        #[test]
        fn $leaves() {
            let session = test_session_with_ring(1024);
            session.record_output(b"normal-screen sentinel\r\n\x1b[?1049hframe");
            assert!(
                session.in_alt_screen.load(Ordering::Relaxed),
                "fixture: the program is on the alternate screen"
            );
            session.record_output(concat!("\x1b[?10", $control, "49lplain").as_bytes());
            let attached = session.attach(Some(0));
            assert!(
                !attached.alt_screen,
                "DECRST 1049 with {:?} inside it selects the normal screen",
                $control
            );
            assert!(
                contains_subslice(&attached.replay.concat(), b"normal-screen sentinel"),
                "normal-screen reattach retains its replay"
            );
        }

        #[test]
        fn $resets() {
            let session = test_session_with_ring(1024);
            session.record_output(b"\x1b[?1049h\x1b[?1000h");
            assert_eq!(
                modes_on(&session),
                vec![1000],
                "fixture: the program turned mouse tracking on"
            );
            session.record_output(concat!("\x1b[?10", $control, "00l").as_bytes());
            assert_eq!(
                modes_on(&session),
                Vec::<u16>::new(),
                "DECRST 1000 with {:?} inside it turns mouse tracking off",
                $control
            );
            assert!(
                session.attach(Some(0)).mode_reassert.is_empty(),
                "a mode the program turned off is not reasserted"
            );
        }
    };
}

a_switch_across_a_control_test!(
    a_switch_with_a_del_inside_it_leaves_the_alternate_screen,
    a_mode_reset_with_a_del_inside_it_turns_the_mode_off,
    "\x7f"
);
a_switch_across_a_control_test!(
    a_switch_with_a_cr_inside_it_leaves_the_alternate_screen,
    a_mode_reset_with_a_cr_inside_it_turns_the_mode_off,
    "\r"
);

macro_rules! a_cancelled_switch_test {
    ($name:ident, $control:literal) => {
        #[test]
        fn $name() {
            let session = test_session_with_ring(1024);
            session.record_output(b"normal-screen sentinel\r\n\x1b[?1049h\x1b[?1000hframe");
            session.record_output(
                concat!("\x1b[?10", $control, "49l\x1b[?10", $control, "00l").as_bytes(),
            );
            assert_eq!(
                (
                    session.in_alt_screen.load(Ordering::Relaxed),
                    modes_on(&session)
                ),
                (true, vec![1000]),
                "(alternate screen, modes on): {:?} cancels the switch and the reset, and \
                 their digits are text",
                $control
            );
        }
    };
}

a_cancelled_switch_test!(a_can_inside_a_switch_cancels_it, "\x18");
a_cancelled_switch_test!(a_sub_inside_a_switch_cancels_it, "\x1a");

#[test]
fn an_escape_inside_a_switch_cancels_it_and_starts_the_next() {
    let session = test_session_with_ring(1024);
    session.record_output(b"normal-screen sentinel\r\n\x1b[?1049h\x1b[?1000hframe");
    session.record_output(b"\x1b[?10\x1b[?1049l\x1b[?10\x1b[?1000l");
    assert_eq!(
        (
            session.in_alt_screen.load(Ordering::Relaxed),
            modes_on(&session)
        ),
        (false, Vec::new()),
        "(alternate screen, modes on): the escape cancels each partial CSI and the \
         sequence it starts switches and resets"
    );
}

/// Byte streams with the vendored terminal core's reading of each, recorded
/// from the core by `web/packages/workspace-app/src/terminal/coreScreenModes.test.ts`.
const CORE_SCREEN_MODES: &str = include_str!("../../../tests/fixtures/core-screen-modes.json");

#[derive(serde::Deserialize)]
struct CoreScreenModes {
    tracked: Vec<u16>,
    cases: Vec<CoreScreenModesCase>,
}

#[derive(serde::Deserialize)]
struct CoreScreenModesCase {
    name: String,
    /// The PTY reads in order; each character is one byte.
    chunks: Vec<String>,
    core: ScreenReading,
}

/// Whether the alternate screen is active, and the tracked modes on.
#[derive(PartialEq, Eq, serde::Deserialize)]
struct ScreenReading {
    alternate: bool,
    modes: Vec<u16>,
}

impl std::fmt::Display for ScreenReading {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let screen = if self.alternate {
            "alternate"
        } else {
            "normal"
        };
        write!(f, "{screen} {:?}", self.modes)
    }
}

// A view's core and the session's tracker read the same bytes, so they must
// agree on the screen and the modes, or a fresh view is told a state the
// program's own view does not have. Every case is read and the differing
// ones are reported together; the whole table is the test's output.
#[test]
fn the_tracker_reads_each_recorded_stream_as_the_terminal_core_does() {
    let fixture: CoreScreenModes =
        serde_json::from_str(CORE_SCREEN_MODES).expect("the core reading fixture parses");
    assert_eq!(
        fixture.tracked, TRACKED_PRIVATE_MODES,
        "the fixture reads the tracked modes"
    );
    let mut differing = Vec::new();
    for case in &fixture.cases {
        let session = test_session_with_ring(4096);
        for chunk in &case.chunks {
            let bytes: Vec<u8> = chunk
                .chars()
                .map(|c| {
                    u8::try_from(c).unwrap_or_else(|_| panic!("{}: {c:?} is no byte", case.name))
                })
                .collect();
            session.record_output(&bytes);
        }
        let tracker = ScreenReading {
            alternate: session.in_alt_screen.load(Ordering::Relaxed),
            modes: modes_on(&session),
        };
        let same = tracker == case.core;
        println!(
            "{} | core {} | tracker {tracker} | {}",
            if same { "same     " } else { "DIFFERENT" },
            case.core,
            case.name
        );
        if !same {
            differing.push(format!(
                "{}: core {}, tracker {tracker}",
                case.name, case.core
            ));
        }
    }
    assert!(
        differing.is_empty(),
        "{} of {} streams read differently by the tracker and the terminal core:\n{}",
        differing.len(),
        fixture.cases.len(),
        differing.join("\n")
    );
}
