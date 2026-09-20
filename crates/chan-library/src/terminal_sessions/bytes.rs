pub(super) fn contains_subslice(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && haystack.windows(needle.len()).any(|w| w == needle)
}

/// Longest OSC payload skipped as one sequence. An OSC that never terminates
/// must not swallow every later byte: that would read a working program as
/// silent, and silent is the verdict that lets the write queue type into it.
/// Past the cap the scan returns to ground, so the error is counting a long
/// payload's tail as text rather than missing text.
const OSC_SKIP_CAP: usize = 4096;

/// Counts the user-visible bytes in PTY output: everything except escape
/// sequences, control characters and whitespace. The position inside a
/// sequence is carried from one read to the next, because a PTY read can end
/// anywhere and the parameters of a cut CSI (`8;3H`) are printable ASCII.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(super) enum VisibleScan {
    #[default]
    Ground,
    Escape,
    Csi,
    Osc {
        skipped: usize,
    },
}

impl VisibleScan {
    pub(super) fn count(&mut self, bytes: &[u8]) -> u64 {
        let mut visible = 0;
        for &b in bytes {
            *self = match *self {
                Self::Ground => match b {
                    0x1b => Self::Escape,
                    0x00..=0x1f | 0x7f | b' ' => Self::Ground,
                    _ => {
                        visible += 1;
                        Self::Ground
                    }
                },
                Self::Escape => match b {
                    b'[' => Self::Csi,
                    b']' => Self::Osc { skipped: 0 },
                    0x1b => Self::Escape,
                    _ => Self::Ground,
                },
                Self::Csi => match b {
                    0x1b => Self::Escape,
                    0x40..=0x7e => Self::Ground,
                    _ => Self::Csi,
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
            };
        }
        visible
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
        let streams: [&[u8]; 3] = [
            b"\x1b[39m\x1b[49m\x1b[59m\x1b[0m\x1b[38;3H",
            b"\x1b]0;a title\x07\x1b]8;;https://chan.app\x1b\\\x1b[1mhi\x1b[0m",
            b"\x1b]2;t\x1b\x1b[0mok",
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
