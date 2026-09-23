pub(super) fn contains_subslice(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && haystack.windows(needle.len()).any(|w| w == needle)
}

/// Longest OSC, DCS, SOS, PM or APC payload skipped as one sequence. A string
/// that never terminates must not swallow every later byte: that would read a
/// working program as silent, and silent is the verdict that lets the write
/// queue type into it. Past the cap the scan returns to ground, so the error is
/// counting a long payload's tail as text rather than missing text.
const OSC_SKIP_CAP: usize = 4096;

/// Longest CSI parameter and intermediate string skipped as one sequence.
/// ECMA-48 parameter strings are a few bytes long, and a stray `ESC [` must not
/// swallow the digits and punctuation that follow it: that would read a
/// working program as silent. Past the cap the scan returns to ground and
/// counts the tripping byte, so the error is counting text rather than missing
/// it.
const CSI_SKIP_CAP: usize = 64;

/// Counts the user-visible bytes in PTY output. Hidden: escape sequences of
/// every ECMA-48 family (CSI; OSC, ended by BEL or ST; DCS, SOS, PM and APC,
/// ended by ST; escapes with intermediate bytes, such as the `ESC ( B` in
/// ncurses' `sgr0`; two-byte escapes), control characters and whitespace. A
/// CSI ends at its final byte, or at the first byte that can neither continue
/// nor end it, which is then scanned as ground. A string payload longer than
/// [`OSC_SKIP_CAP`] and a CSI longer than [`CSI_SKIP_CAP`] stop being hidden.
/// The position inside a sequence is carried from one read to the next,
/// because a PTY read can end anywhere and the parameters of a cut CSI
/// (`8;3H`) are printable ASCII.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(super) enum VisibleScan {
    #[default]
    Ground,
    Escape,
    /// After ESC and one or more intermediate bytes, waiting for the final.
    Intermediate,
    Csi {
        skipped: usize,
    },
    Osc {
        skipped: usize,
    },
    /// A DCS, SOS, PM or APC payload, which only ST ends.
    Str {
        skipped: usize,
    },
}

impl VisibleScan {
    pub(super) fn count(&mut self, bytes: &[u8]) -> u64 {
        let mut visible = 0;
        for &b in bytes {
            *self = match *self {
                Self::Ground => Self::ground(b, &mut visible),
                Self::Escape => match b {
                    b'[' => Self::Csi { skipped: 0 },
                    b']' => Self::Osc { skipped: 0 },
                    b'P' | b'X' | b'^' | b'_' => Self::Str { skipped: 0 },
                    0x20..=0x2f => Self::Intermediate,
                    0x1b => Self::Escape,
                    _ => Self::Ground,
                },
                Self::Intermediate => match b {
                    0x1b => Self::Escape,
                    0x20..=0x2f => Self::Intermediate,
                    _ => Self::Ground,
                },
                Self::Csi { skipped } => match b {
                    0x40..=0x7e => Self::Ground,
                    0x20..=0x3f if skipped < CSI_SKIP_CAP => Self::Csi {
                        skipped: skipped + 1,
                    },
                    // ESC, a control, a UTF-8 byte, or a parameter byte past
                    // the cap: the CSI is over and the byte is scanned anew.
                    _ => Self::ground(b, &mut visible),
                },
                Self::Osc { skipped } => match b {
                    0x07 => Self::Ground,
                    // Either the ESC of a string terminator or the start of a
                    // sequence that abandons this OSC; `Escape` decides both.
                    0x1b => Self::Escape,
                    _ if skipped >= OSC_SKIP_CAP => Self::Ground,
                    _ => Self::Osc {
                        skipped: skipped + 1,
                    },
                },
                Self::Str { skipped } => match b {
                    // As in `Osc`: ST or an abandoning sequence.
                    0x1b => Self::Escape,
                    _ if skipped >= OSC_SKIP_CAP => Self::Ground,
                    _ => Self::Str {
                        skipped: skipped + 1,
                    },
                },
            };
        }
        visible
    }

    fn ground(b: u8, visible: &mut u64) -> Self {
        match b {
            0x1b => Self::Escape,
            0x00..=0x1f | 0x7f | b' ' => Self::Ground,
            _ => {
                *visible += 1;
                Self::Ground
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn count(bytes: &[u8]) -> u64 {
        VisibleScan::default().count(bytes)
    }

    #[test]
    fn escape_sequences_controls_and_whitespace_are_not_visible() {
        assert_eq!(count(b"\x1b[?25l\x1b[?25h\x1b[31m\x1b[0m\r\n\t \x07"), 0);
        assert_eq!(count(b"\x1b]0;chan\x07"), 0);
        assert_eq!(count(b"\x1b]2;title\x1b\\"), 0);
        assert_eq!(count(b"\x1bM\x1b7\x1b8"), 0);
    }

    #[test]
    fn text_between_sequences_is_visible() {
        assert_eq!(count(b"\x1b[32mhello\x1b[0m\r\n"), 5);
        assert_eq!(count("\x1b[3G\u{273d}".as_bytes()), 3);
    }

    #[test]
    fn a_sequence_cut_at_any_offset_counts_the_same_as_whole() {
        let streams: [&[u8]; 6] = [
            b"\x1b[39m\x1b[49m\x1b[59m\x1b[0m\x1b[38;3H",
            b"\x1b]0;a title\x07\x1b]8;;https://chan.app\x1b\\\x1b[1mhi\x1b[0m",
            b"\x1b]2;t\x1b\x1b[0mok",
            b"\x1b(B\x1b[m\x1b)0\x1b#8x\x1b(B\x1b[m",
            b"\x1bP1$r0m\x1b\\\x1b_Gf=100;AAAA\x1b\\ok\x1b^pm\x1b\\",
            "\x1b[42% \u{5b8c}\u{6210}\x1b[1mok\x1b[0m".as_bytes(),
        ];
        for stream in streams {
            let whole = count(stream);
            for cut in 0..=stream.len() {
                let mut scan = VisibleScan::default();
                let split = scan.count(&stream[..cut]) + scan.count(&stream[cut..]);
                assert_eq!(split, whole, "cut at {cut} of {stream:?}");
            }
        }
    }

    #[test]
    fn ncurses_sgr0_and_other_intermediate_escapes_are_not_visible() {
        assert_eq!(count(&b"\x1b(B\x1b[m".repeat(64)), 0);
        assert_eq!(count(b"\x1b)0\x1b#8\x1b(0\x1b%G\x1b $B"), 0);
        assert_eq!(count(b"\x1b(Bok\x1b[m"), 2);
    }

    #[test]
    fn dcs_sos_pm_and_apc_payloads_are_not_visible() {
        assert_eq!(count(b"\x1bP1$r0;1m\x1b\\"), 0);
        assert_eq!(count(b"\x1b_Gf=100,a=T;iVBORw0KGgo=\x1b\\"), 0);
        assert_eq!(count(b"\x1bXsos text\x1b\\\x1b^pm text\x1b\\"), 0);
        assert_eq!(count(b"\x1bPq#0;2;0;0;0\x1b\\done"), 4);
    }

    #[test]
    fn an_unterminated_apc_stops_hiding_text_at_the_cap() {
        let mut scan = VisibleScan::default();
        assert_eq!(scan.count(b"\x1b_G"), 0);
        assert_eq!(scan.count(&[b'A'; OSC_SKIP_CAP - 1]), 0);
        assert_eq!(
            scan.count(b"AB"),
            1,
            "the byte that trips the cap is dropped"
        );
        assert_eq!(scan, VisibleScan::Ground);
        assert_eq!(scan.count(b"tail"), 4);
    }

    #[test]
    fn a_stray_csi_ends_at_the_first_byte_that_cannot_continue_it() {
        assert_eq!(count("\x1b[42% \u{5b8c}\u{6210}".as_bytes()), 6);
        assert_eq!(count("\x1b[  42%  \u{1f680}".as_bytes()), 4);
        assert_eq!(count("\x1b[42%\n\u{5b8c}\u{6210}".as_bytes()), 6);
        assert_eq!(count(b"\x1b[38;5;196mX"), 1);
    }

    #[test]
    fn a_csi_longer_than_the_cap_stops_hiding_text() {
        let mut scan = VisibleScan::default();
        assert_eq!(scan.count(b"\x1b["), 0);
        assert_eq!(scan.count(&[b'1'; CSI_SKIP_CAP]), 0);
        assert_eq!(
            scan.count(b"23"),
            2,
            "the byte that trips the cap is counted"
        );
        assert_eq!(scan, VisibleScan::Ground);
    }

    #[test]
    fn an_escape_inside_an_osc_abandons_it() {
        assert_eq!(count(b"\x1b]2;t\x1b\x1b[0mok"), 2);
        assert_eq!(count(b"\x1b]2;t\x1b[0mok"), 2);
    }

    #[test]
    fn an_unterminated_osc_stops_hiding_text_at_the_cap() {
        let mut scan = VisibleScan::default();
        assert_eq!(scan.count(b"\x1b]52;c;"), 0);
        assert_eq!(scan.count(&[b'A'; OSC_SKIP_CAP - 5]), 0);
        assert_eq!(
            scan,
            VisibleScan::Osc {
                skipped: OSC_SKIP_CAP
            }
        );
        assert_eq!(
            scan.count(b"AB"),
            1,
            "the byte that trips the cap is dropped"
        );
        assert_eq!(scan, VisibleScan::Ground);
    }
}
