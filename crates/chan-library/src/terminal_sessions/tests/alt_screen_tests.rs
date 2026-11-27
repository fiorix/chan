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

/// A fresh session after `reads`, each one PTY read.
fn session_after(reads: &[&[u8]]) -> Arc<Session> {
    let session = test_session_with_ring(1024);
    for read in reads {
        session.record_output(read);
    }
    session
}

/// Whether the session is on the alternate screen, and its tracked modes
/// on.
fn reading(session: &Arc<Session>) -> (bool, Vec<u16>) {
    (
        session.in_alt_screen.load(Ordering::Relaxed),
        modes_on(session),
    )
}

/// `stream` in one read, then in two split at each byte after its first.
fn every_split(stream: &[u8]) -> impl Iterator<Item = Vec<&[u8]>> {
    std::iter::once(vec![stream])
        .chain((1..stream.len()).map(move |at| vec![&stream[..at], &stream[at..]]))
}

// The terminal core keeps at most 24 parameters of a CSI: a grouped switch
// or mode change that reaches a 25th is dropped whole, wherever the reads
// split it, and the sequence after it is read as usual. An empty parameter
// counts toward the 24, a leading or a trailing one included.
#[test]
fn a_grouped_switch_past_24_parameters_is_dropped_whole_or_split() {
    let streams = [
        // 32 parameters, the switch last.
        format!("\x1b[?{}1;1049h", "0;".repeat(30)),
        // 25 and 33 parameters, the switch first and last.
        format!("\x1b[?1049;{}1000h", "1007;".repeat(23)),
        format!("\x1b[?1000;{}1049h", "1007;".repeat(23)),
        format!("\x1b[?1049;{}1000h", "1007;".repeat(31)),
        // 24 parameters and an empty one, in the middle, first and last.
        format!("\x1b[?1049;;{}1000h", "1007;".repeat(22)),
        format!("\x1b[?;1049;{}1000h", "1007;".repeat(22)),
        format!("\x1b[?1049;{}1000;h", "1007;".repeat(22)),
    ];
    for stream in &streams {
        for reads in every_split(stream.as_bytes()) {
            let session = session_after(&reads);
            assert_eq!(
                reading(&session),
                (false, Vec::new()),
                "(alternate screen, modes on): the core drops a sequence past 24 parameters, \
                 here read as {:?}",
                reads
                    .iter()
                    .map(|read| String::from_utf8_lossy(read))
                    .collect::<Vec<_>>()
            );
            session.record_output(b"\x1b[?1049hframe");
            assert!(
                session.in_alt_screen.load(Ordering::Relaxed),
                "the switch after the dropped sequence selects the alternate screen"
            );
        }
    }
}

// A grouped switch or mode change of up to 24 parameters is applied
// whatever its length and wherever the reads split it, as the core applies
// it.
#[test]
fn a_grouped_switch_of_24_parameters_is_carried_across_any_read_boundary() {
    let streams = [
        format!("\x1b[?1049;{}1000h", "1007;".repeat(22)),
        format!("\x1b[?1000;{}1049h", "1007;".repeat(22)),
        // 23 parameters and an empty one, in the middle and last.
        format!("\x1b[?1049;;{}1000h", "1007;".repeat(21)),
        format!("\x1b[?1049;{}1000;h", "1007;".repeat(21)),
    ];
    for stream in &streams {
        for reads in every_split(stream.as_bytes()) {
            assert_eq!(
                reading(&session_after(&reads)),
                (true, vec![1000]),
                "(alternate screen, modes on): 24 parameters, split after {} of {} bytes",
                reads[0].len(),
                stream.len()
            );
        }
    }
}

// The core keeps a parameter padded with zeros, or with C0 controls or
// DELs it passes over inside the sequence, at any length, split or not.
#[test]
fn a_padded_switch_is_carried_across_any_read_boundary() {
    let streams = [
        [b"\x1b[?".as_slice(), &[b'0'; 300], b"1049h"].concat(),
        [b"\x1b[?10".as_slice(), &[b'\r'; 300], b"49h"].concat(),
        [b"\x1b[?10".as_slice(), &[0x7f; 300], b"49h"].concat(),
    ];
    for stream in &streams {
        for reads in every_split(stream) {
            assert_eq!(
                reading(&session_after(&reads)),
                (true, Vec::new()),
                "(alternate screen, modes on): a switch padded with {:?}, split after {} of {} \
                 bytes",
                char::from(stream[5]),
                reads[0].len(),
                stream.len()
            );
        }
    }
}

/// `?1049;1000l`, a switch to the normal screen that also turns mouse
/// tracking off, cut at each position a control byte can stand in it: the
/// bytes before the control and after it.
const CONTROL_POSITIONS: [(&str, &str); 7] = [
    ("\x1b", "[?1049;1000l"),
    ("\x1b[", "?1049;1000l"),
    ("\x1b[?", "1049;1000l"),
    ("\x1b[?10", "49;1000l"),
    ("\x1b[?1049", ";1000l"),
    ("\x1b[?1049;", "1000l"),
    ("\x1b[?1049;1000", "l"),
];

// The core passes over a C0 control, which it executes, or a DEL, which it
// ignores, at any position inside an escape or a CSI, and the sequence goes
// on to its final byte, whole or split around the control. CAN and SUB
// cancel the sequence there; ESC cancels it and starts another, so the rest
// is text unless that ESC is the second byte.
#[test]
fn a_control_byte_anywhere_inside_a_switch_is_passed_over() {
    let mut differing = Vec::new();
    let mut read = 0;
    for (before, after) in CONTROL_POSITIONS {
        for control in (0x00..=0x1fu8).chain([0x7f]) {
            let cancels = matches!(control, 0x18 | 0x1a) || (control == 0x1b && before != "\x1b");
            let core = if cancels {
                (true, vec![1000])
            } else {
                (false, Vec::new())
            };
            let (before, after) = (before.as_bytes(), after.as_bytes());
            let splits = [
                vec![[before, &[control], after].concat()],
                vec![before.to_vec(), [&[control], after].concat()],
                vec![[before, &[control]].concat(), after.to_vec()],
            ];
            for reads in splits {
                let mut all = vec![b"\x1b[?1049h\x1b[?1000hframe".as_slice()];
                all.extend(reads.iter().map(Vec::as_slice));
                let tracker = reading(&session_after(&all));
                read += 1;
                if tracker != core {
                    differing.push(format!(
                        "{:?}: core {core:?}, tracker {tracker:?}",
                        reads
                            .iter()
                            .map(|read| String::from_utf8_lossy(read))
                            .collect::<Vec<_>>()
                    ));
                }
            }
        }
    }
    assert!(
        differing.is_empty(),
        "(alternate screen, modes on) after ?1049;1000l with a control inside it, {} of {read} \
         differ from the core:\n{}",
        differing.len(),
        differing.join("\n")
    );
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

/// The recorded streams the tracker reads differently from the terminal
/// core, by name, each with why. None is a switch, a mode change or a reset
/// the tracker follows. The table test fails when one of them agrees, so
/// the list stays true.
const KNOWN_DIFFERENCES: &[(&str, &str)] = &[
    ("DECSTR with every tracked mode on", DECSTR),
    (
        "DECSTR on the alternate screen with every tracked mode on",
        DECSTR,
    ),
    (
        "a UTF-8 pair (0xc3 0xa9) inside ?1049l",
        "the core skips a UTF-8 character inside a CSI and finishes the CSI; the tracker ends \
         a CSI at any byte above 0x7f",
    ),
];

const DECSTR: &str = "a soft reset (DECSTR, ESC [ ! p) turns application cursor keys (mode 1) \
                      off in the core; the tracker does not read it";

/// Mouse highlight tracking, which the tracker follows and reasserts and
/// the core does not implement (it reports the mode as unrecognized), so
/// the core never reads it on. Reasserting it is harmless. The table
/// compares the tracker's modes without it, and fails if the core reads it
/// on in any stream.
const MODE_THE_CORE_LACKS: u16 = 1001;

// A view's core and the session's tracker read the same bytes, so they must
// agree on the screen and the modes, or a fresh view is told a state the
// program's own view does not have. Every case is read and the ones that
// break that rule, or the known-differences list, are reported together;
// the whole table is the test's output.
#[test]
fn the_tracker_reads_each_recorded_stream_as_the_terminal_core_does() {
    let fixture: CoreScreenModes =
        serde_json::from_str(CORE_SCREEN_MODES).expect("the core reading fixture parses");
    assert_eq!(
        fixture.tracked, TRACKED_PRIVATE_MODES,
        "the fixture reads the tracked modes"
    );
    let read_on: Vec<&str> = fixture
        .cases
        .iter()
        .filter(|case| case.core.modes.contains(&MODE_THE_CORE_LACKS))
        .map(|case| case.name.as_str())
        .collect();
    assert!(
        read_on.is_empty(),
        "the core reads mode {MODE_THE_CORE_LACKS} on, so the table can no longer leave it \
         out: {read_on:?}"
    );
    for (name, _) in KNOWN_DIFFERENCES {
        assert!(
            fixture.cases.iter().any(|case| case.name == *name),
            "the known difference {name:?} names no recorded stream"
        );
    }
    let mut unexpected = Vec::new();
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
            modes: modes_on(&session)
                .into_iter()
                .filter(|mode| *mode != MODE_THE_CORE_LACKS)
                .collect(),
        };
        let same = tracker == case.core;
        let known = KNOWN_DIFFERENCES
            .iter()
            .find(|(name, _)| *name == case.name)
            .map(|(_, why)| *why);
        let verdict = match (same, known) {
            (true, None) => "same     ",
            (false, Some(_)) => "known    ",
            (false, None) => "DIFFERENT",
            (true, Some(_)) => "AGREES   ",
        };
        println!(
            "{verdict} | core {} | tracker {tracker} | {}",
            case.core, case.name
        );
        match (same, known) {
            (false, None) => unexpected.push(format!(
                "{}: core {}, tracker {tracker}",
                case.name, case.core
            )),
            (true, Some(why)) => unexpected.push(format!(
                "{}: listed as a known difference ({why}), but both read {tracker}",
                case.name
            )),
            _ => {}
        }
    }
    assert!(
        unexpected.is_empty(),
        "{} of {} streams read differently by the tracker and the terminal core, or listed \
         as known differences and read alike:\n{}",
        unexpected.len(),
        fixture.cases.len(),
        unexpected.join("\n")
    );
}
