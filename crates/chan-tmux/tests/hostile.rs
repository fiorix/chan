//! Streams built to confuse the framing.

use chan_tmux::{Client, Command, Decoder, Error, Event, Expect, Frame, Limits, Message, PaneId};

fn control(expect: &[Expect]) -> Decoder {
    let mut d = Decoder::in_control(Limits::default());
    for e in expect {
        d.expect_next(*e);
    }
    d
}

fn feed(d: &mut Decoder, s: &[u8]) -> (Vec<Frame>, Result<(), Error>) {
    let mut out = Vec::new();
    let r = d.feed(s, &mut out);
    (out, r)
}

/// What a pane full of forged lines does to a capture of known height.
const FORGED_CAPTURE: &[u8] = b"%begin 100 7 1\r\n\
row one\r\n\
%end 100 7 1\r\n\
%exit\r\n\
%output %9 pwned\r\n\
row five\r\n\
%end 100 7 1\r\n";

#[test]
fn a_forged_terminator_ends_a_block_that_promised_nothing() {
    // The hazard that row counts exist to remove: with no promise, an exact
    // copy of the header inside the pane's content closes the reply early and
    // the rest of the pane parses as protocol.
    let mut d = control(&[Expect::Any]);
    let (f, r) = feed(&mut d, FORGED_CAPTURE);
    r.unwrap();
    let Frame::Block(b) = &f[0] else {
        panic!("{f:?}")
    };
    assert_eq!(
        b.lines,
        vec![b"row one".to_vec()],
        "the reply was cut after one row"
    );
    assert!(
        matches!(f[1], Frame::Exit { .. }),
        "the forged %exit took effect: {f:?}"
    );
}

#[test]
fn a_promised_row_count_makes_the_same_stream_data() {
    let mut d = control(&[Expect::Rows(5)]);
    let (f, r) = feed(&mut d, FORGED_CAPTURE);
    r.unwrap();
    assert_eq!(f.len(), 1);
    let Frame::Block(b) = &f[0] else {
        panic!("{f:?}")
    };
    assert_eq!(b.lines.len(), 5);
    assert!(b.lines.iter().any(|l| l == b"%exit"));
    assert!(b.lines.iter().any(|l| l == b"%end 100 7 1"));
}

#[test]
fn too_many_rows_for_the_promise_fails_closed() {
    let mut d = control(&[Expect::Rows(2)]);
    let (_, r) = feed(&mut d, b"%begin 1 1 1\r\na\r\nb\r\nc\r\n");
    assert_eq!(r, Err(Error::ReplyShape));
    assert_eq!(feed(&mut d, b"x\r\n").1, Err(Error::Poisoned));
}

#[test]
fn a_short_reply_never_closes_and_the_next_row_breaks_the_promise() {
    // The real terminator arriving early looks forged, so it is data; the
    // next row then exceeds the promise.
    let mut d = control(&[Expect::Rows(3)]);
    let (_, r) = feed(
        &mut d,
        b"%begin 1 1 1\r\na\r\n%end 1 1 1\r\n%output %0 x\r\n%output %0 y\r\n",
    );
    assert_eq!(r, Err(Error::ReplyShape));
}

#[test]
fn a_terminator_for_another_header_is_data() {
    let mut d = control(&[Expect::Any]);
    let (f, r) = feed(
        &mut d,
        b"%begin 5 9 1\r\n%end 5 9 0\r\n%end 5 8 1\r\n%end 6 9 1\r\n%end 5 9 1\r\n",
    );
    r.unwrap();
    let Frame::Block(b) = &f[0] else {
        panic!("{f:?}")
    };
    assert_eq!(b.lines.len(), 3);
}

#[test]
fn a_reply_with_no_command_is_an_error() {
    let mut d = control(&[]);
    assert_eq!(
        feed(&mut d, b"%begin 1 1 1\r\n").1,
        Err(Error::UnexpectedReply)
    );
}

#[test]
fn lines_and_blocks_are_bounded() {
    let mut d = Decoder::in_control(Limits {
        max_line: 16,
        max_block_bytes: 64,
        max_block_lines: 3,
    });
    assert_eq!(feed(&mut d, &[b'a'; 40]).1, Err(Error::LineTooLong));

    let mut d = Decoder::in_control(Limits {
        max_line: 16,
        max_block_bytes: 64,
        max_block_lines: 3,
    });
    d.expect_next(Expect::Any);
    assert_eq!(
        feed(&mut d, b"%begin 1 1 1\r\na\r\nb\r\nc\r\nd\r\n").1,
        Err(Error::BlockTooLarge)
    );

    let mut d = Decoder::in_control(Limits {
        max_line: 40,
        max_block_bytes: 64,
        max_block_lines: 100,
    });
    d.expect_next(Expect::Any);
    let mut s = b"%begin 1 1 1\r\n".to_vec();
    s.extend(std::iter::repeat_n(b"0123456789012345678901234567890\r\n".as_slice(), 4).flatten());
    assert_eq!(feed(&mut d, &s).1, Err(Error::BlockTooLarge));
}

#[test]
fn the_marker_is_ignored_unless_armed() {
    let mut d = Decoder::new(Limits::default());
    let (f, r) = feed(&mut d, b"hello\x1bP1000p%begin 1 1 0\r\nworld");
    r.unwrap();
    assert_eq!(
        f,
        vec![Frame::Passthrough(
            b"hello\x1bP1000p%begin 1 1 0\r\nworld".to_vec()
        )]
    );
    assert!(!d.in_control_mode());
}

#[test]
fn a_marker_split_across_reads_and_near_misses() {
    let mut d = Decoder::new(Limits::default());
    d.arm(true);
    let mut out = Vec::new();
    for part in [
        &b"x\x1b"[..],
        b"P10",
        b"00",
        b"p%begin 1 1 0\r\n",
        b"%end 1 1 0\r\n",
    ] {
        d.feed(part, &mut out).unwrap();
    }
    let entered = out
        .iter()
        .position(|f| *f == Frame::Entered)
        .expect("entered");
    let shown: Vec<u8> = out[..entered]
        .iter()
        .flat_map(|f| match f {
            Frame::Passthrough(b) => b.clone(),
            other => panic!("{other:?} before entry"),
        })
        .collect();
    assert_eq!(
        shown, b"x\x1bP1000p",
        "the marker's bytes pass as they come, ahead of the entry"
    );
    assert!(matches!(out[entered + 1], Frame::Block(_)));

    let mut d = Decoder::new(Limits::default());
    d.arm(true);
    let mut out = Vec::new();
    d.feed(b"\x1bP100\x1bP1000q\x1b\x1bP1000p", &mut out)
        .unwrap();
    assert_eq!(
        out[0],
        Frame::Passthrough(b"\x1bP100\x1bP1000q\x1b\x1bP1000p".to_vec())
    );
    assert_eq!(out[1], Frame::Entered);
}

#[test]
fn a_stream_that_does_not_close_the_dcs_returns_to_plain_bytes() {
    let mut d = control(&[]);
    let (f, r) = feed(&mut d, b"%exit\r\n\x1bXtail");
    r.unwrap();
    assert!(matches!(f[0], Frame::Exit { .. }));
    assert_eq!(f[1], Frame::Passthrough(b"\x1bXtail".to_vec()));
    assert!(!d.in_control_mode());
}

#[test]
fn commands_wait_for_a_session() {
    let mut c = Client::in_control(Limits::default());
    assert_eq!(c.submit(&Command::Version).unwrap_err(), Error::NotReady);
    c.feed(b"%session-changed $1 x\r\n").unwrap();
    assert!(c.submit(&Command::Version).is_ok());
}

#[test]
fn stray_lines_and_unknown_notifications_are_reported_not_fatal() {
    let mut c = Client::in_control(Limits::default());
    let ev = c
        .feed(b"just text\r\n%subscription-changed a b c\r\n%output %0 hi\r\n")
        .unwrap();
    assert!(matches!(&ev[0], Event::Stray(l) if l == b"just text"));
    assert!(
        matches!(&ev[1], Event::Message(chan_tmux::Message::Other { keyword }) if keyword == "%subscription-changed")
    );
    assert!(matches!(
        &ev[2],
        Event::Message(chan_tmux::Message::Output {
            pane: PaneId(0),
            ..
        })
    ));
}

#[test]
fn a_known_notification_with_bad_fields_is_an_error_without_the_bytes() {
    let mut c = Client::in_control(Limits::default());
    let e = c.feed(b"%window-add notanid\r\n").unwrap_err();
    assert_eq!(e, Error::Malformed("window-add"));
    assert!(!e.to_string().contains("notanid"));
}

/// A line of the pane names subscription for pane `%<pane>`, as tmux writes
/// it: whether the title is its default, the byte lengths it counted, and
/// the two texts.
fn pane_name_line(pane: u32, default_title: bool, command: &[u8], title: &[u8]) -> Vec<u8> {
    let mut line = format!(
        "%subscription-changed chan-pane-name $0 @0 0 %{pane} : {} {} {} ",
        u8::from(default_title),
        command.len(),
        title.len()
    )
    .into_bytes();
    line.extend_from_slice(command);
    line.push(b' ');
    line.extend_from_slice(title);
    line.extend_from_slice(b"\r\n");
    line
}

/// The one message a client reads from `line`.
fn pane_name(line: &[u8]) -> Message {
    let mut c = Client::in_control(Limits::default());
    match c.feed(line).expect("the line parses").as_slice() {
        [Event::Message(message)] => message.clone(),
        other => panic!("{other:?}"),
    }
}

fn named(pane: u32, name: &str) -> Message {
    Message::PaneName {
        pane: PaneId(pane),
        name: name.into(),
    }
}

#[test]
fn a_pane_is_named_by_its_command_whatever_its_title() {
    // The title a shell sets at every prompt, as Arch's bash.bashrc does with
    // `printf "\033]0;%s@%s:%s\007"`, names nothing: the shell at the prompt
    // does, and so does a program run under that title, which leaves it
    // standing.
    assert_eq!(
        pane_name(&pane_name_line(
            0,
            false,
            b"bash",
            b"user@devbox:~/src/chan"
        )),
        named(0, "bash")
    );
    assert_eq!(
        pane_name(&pane_name_line(0, false, b"top", b"user@devbox:~/src/chan")),
        named(0, "top")
    );
    // A title a program set for itself names nothing either, whatever it
    // holds: spaces, the separator the line itself uses, format syntax,
    // bytes past ASCII.
    let title = "vim: notes.md : #{pane_id} #(id), caf\u{e9}";
    assert_eq!(
        pane_name(&pane_name_line(3, false, b"vim", title.as_bytes())),
        named(3, "vim")
    );
    // Nor does the title tmux gives a new pane, its host's name, or a title
    // a program emptied or left blank.
    assert_eq!(
        pane_name(&pane_name_line(0, true, b"bash", b"build-host")),
        named(0, "bash")
    );
    assert_eq!(
        pane_name(&pane_name_line(1, false, b"top", b"")),
        named(1, "top")
    );
    assert_eq!(
        pane_name(&pane_name_line(1, false, b"top", b"   ")),
        named(1, "top")
    );
    // The ends are trimmed; nothing inside is.
    assert_eq!(
        pane_name(&pane_name_line(2, false, b"  two  words  ", b"sh")),
        named(2, "two  words")
    );
    // tmux may have no command: the name is empty, a title there or not, and
    // the line still holds both separators.
    assert_eq!(
        pane_name(&pane_name_line(4, true, b"", b"build-host")),
        named(4, "")
    );
    assert_eq!(
        pane_name(&pane_name_line(4, false, b"", b"a title")),
        named(4, "")
    );
    assert_eq!(pane_name(&pane_name_line(4, false, b"", b"")), named(4, ""));
    // Two panes of one window are two lines with a name each.
    let mut c = Client::in_control(Limits::default());
    let mut both = pane_name_line(0, true, b"bash", b"build-host");
    both.extend(pane_name_line(1, true, b"top", b"build-host"));
    let ev = c.feed(&both).unwrap();
    assert_eq!(
        ev,
        vec![
            Event::Message(named(0, "bash")),
            Event::Message(named(1, "top"))
        ]
    );
}

#[test]
fn a_subscription_this_crate_did_not_add_is_kept_by_keyword() {
    let mut line = pane_name_line(0, true, b"bash", b"build-host");
    let at = line
        .windows(14)
        .position(|w| w == b"chan-pane-name")
        .unwrap();
    line.splice(at..at + 14, b"another".iter().copied());
    assert_eq!(
        pane_name(&line),
        Message::Other {
            keyword: "%subscription-changed".into()
        }
    );
}

/// tmux 3.2 prints a foreground command's name as the process gave it, so a
/// program can put a line break in one and write the lines after it. The
/// first line then holds less than the length tmux counted.
#[test]
fn a_pane_name_cut_by_a_line_break_ends_the_stream_before_the_lines_it_wrote() {
    for (command, title) in [
        (&b"x\n%exit"[..], &b"build-host"[..]),
        (b"x\n%output %0 pwned", b"build-host"),
        (b"sh", b"a title\n%exit"),
        // The break is the command's last byte.
        (b"x\n", b"t"),
    ] {
        let line = pane_name_line(0, false, command, title);
        let mut c = Client::in_control(Limits::default());
        let e = c.feed(&line).unwrap_err();
        assert_eq!(
            e,
            Error::Malformed("subscription-changed"),
            "{:?}",
            String::from_utf8_lossy(&line)
        );
        assert_eq!(
            c.feed(b"%output %0 later\r\n").unwrap_err(),
            Error::Poisoned,
            "nothing after the cut line is read"
        );
    }
    // Read by read, the cut line is refused when its break arrives, before
    // the forged exit is even in the buffer.
    let line = pane_name_line(0, true, b"x\n%exit", b"build-host");
    let cut = line.iter().position(|&b| b == b'\n').unwrap() + 1;
    let mut c = Client::in_control(Limits::default());
    assert_eq!(
        c.feed(&line[..cut]).unwrap_err(),
        Error::Malformed("subscription-changed")
    );
    assert_eq!(c.feed(&line[cut..]).unwrap_err(), Error::Poisoned);
}

#[test]
fn a_pane_name_line_holds_exactly_what_its_lengths_say_or_is_an_error() {
    let head = "%subscription-changed chan-pane-name";
    for fields in [
        // One byte more and one byte less than the lengths.
        "$0 @0 0 %0 : 1 4 4 bash hostx",
        "$0 @0 0 %0 : 1 4 4 bash hos",
        // The lengths add up but the separator is not where they put it.
        "$0 @0 0 %0 : 1 4 4 bashXhost",
        "$0 @0 0 %0 : 1 3 5 bash host",
        // No texts, no separator, a length that is no number or is signed.
        "$0 @0 0 %0 : 1 4 4",
        "$0 @0 0 %0 : 1 4 4 ",
        "$0 @0 0 %0 : 1 0 0",
        "$0 @0 0 %0 : 1 +4 4 bash host",
        "$0 @0 0 %0 : 1 4 -4 bash host",
        "$0 @0 0 %0 : 1 four 4 bash host",
        "$0 @0 0 %0 : 1 99999999999999999999999 4 bash host",
        "$0 @0 0 %0 : 1 18446744073709551615 4 bash host",
        // A flag that is neither answer.
        "$0 @0 0 %0 : 2 4 4 bash host",
        "$0 @0 0 %0 :  4 4 bash host",
        // Ids that are not ids, and the shape tmux gives a session's value.
        "0 @0 0 %0 : 1 4 4 bash host",
        "$0 0 0 %0 : 1 4 4 bash host",
        "$0 @0 x %0 : 1 4 4 bash host",
        "$0 @0 0 0 : 1 4 4 bash host",
        "$0 @0 0 %0 1 4 4 bash host",
        "$0 - - - : 1 4 4 bash host",
        "",
    ] {
        let mut c = Client::in_control(Limits::default());
        let fed = c.feed(format!("{head} {fields}\r\n").as_bytes());
        assert_eq!(
            fed,
            Err(Error::Malformed("subscription-changed")),
            "{fields:?}"
        );
        let shown = fed.unwrap_err().to_string();
        assert!(!shown.contains("bash"), "none of the line: {shown}");
    }
    // The subscription's name alone, with no field after it.
    let mut c = Client::in_control(Limits::default());
    assert_eq!(
        c.feed(format!("{head}\r\n").as_bytes()).unwrap_err(),
        Error::Malformed("subscription-changed")
    );
}

#[test]
fn a_pane_name_carries_no_control_character_and_any_bytes_parse() {
    // Bytes a line can hold without ending it: the texts keep their length,
    // so the line parses, and none of them reaches the name.
    let command = b"a\tb\x1b[31mc\x7fd\x00e\xc2\x9bf";
    assert_eq!(
        pane_name(&pane_name_line(0, true, command, b"build-host")),
        named(0, "ab[31mcdef")
    );
    let title = b"\x1b]0;x\x07 t\x08 ";
    assert_eq!(
        pane_name(&pane_name_line(0, false, b"sh", title)),
        named(0, "sh")
    );
    // Bytes that are not UTF-8 are replaced, never refused: a name is shown,
    // not obeyed.
    assert_eq!(
        pane_name(&pane_name_line(0, false, b"\xff\xfe ok", b"t")),
        named(0, "\u{fffd}\u{fffd} ok")
    );
    assert_eq!(
        pane_name(&pane_name_line(0, false, b"sh", b"\xff\xfe ok")),
        named(0, "sh")
    );
    // A long title or command is a line like any other, inside the line
    // bound.
    let long = vec![b'n'; 100_000];
    assert_eq!(
        pane_name(&pane_name_line(0, false, b"sh", &long)),
        named(0, "sh")
    );
    let Message::PaneName { name, .. } = pane_name(&pane_name_line(0, false, &long, b"t")) else {
        panic!("a pane name");
    };
    assert_eq!(name.len(), 100_000);
}

/// Deterministic noise: nothing may panic, and a poisoned decoder stays
/// poisoned.
#[test]
fn random_streams_never_panic() {
    let mut x: u64 = 0x9e3779b97f4a7c15;
    let mut next = move || {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        x
    };
    let alphabet: &[&[u8]] = &[
        b"%begin ",
        b"%end ",
        b"%error ",
        b"%exit",
        b"%output ",
        b"%extended-output ",
        b"%layout-change ",
        b"%subscription-changed chan-pane-name ",
        b"$0 @0 0 %0 : ",
        b"1 4 4 ",
        b"\x1bP1000p",
        b"\x1b\\",
        b"\r\n",
        b"\n",
        b" ",
        b"1",
        b"0",
        b"@",
        b"$",
        b"%",
        b"\\",
        b"\\033",
        b" : ",
        b"abc",
        b"{",
        b"}",
        b"[",
        b"]",
        b",",
        b"x",
    ];
    for round in 0..300 {
        let mut c = if round % 2 == 0 {
            Client::new(Limits::default())
        } else {
            Client::in_control(Limits::default())
        };
        c.arm(true);
        let mut failed = false;
        for _ in 0..200 {
            let mut chunk = Vec::new();
            for _ in 0..(next() % 12) {
                if next() % 5 == 0 {
                    chunk.push(next() as u8);
                } else {
                    chunk.extend_from_slice(alphabet[(next() as usize) % alphabet.len()]);
                }
            }
            if next() % 7 == 0 && c.ready() {
                let _ = c.submit(&Command::ListWindows);
            }
            let r = c.feed(&chunk);
            if failed {
                assert!(r.is_err(), "poisoned decoders stay poisoned");
            }
            failed |= r.is_err();
        }
    }
}

/// A pane state line as `Command::PaneState` asks for it: `history_size`
/// is the last field and `pane_height` the one before.
fn state_block(hdr: &str, history_size: u32, height: u32) -> Vec<u8> {
    format!(
        "%begin {hdr}\r\n%7 0 0 0 0 0 {} 80 {height} {history_size}\r\n%end {hdr}\r\n",
        height - 1
    )
    .into_bytes()
}

const CAPTURE: Expect = Expect::Capture { history_rows: 50 };

#[test]
fn a_capture_is_sized_by_the_state_before_it() {
    // History 20 of the 50 asked for, height 3: the capture holds exactly 23
    // rows, and a forged terminator at row 5 is one of them.
    let mut d = control(&[Expect::PaneState, CAPTURE]);
    let mut s = state_block("100 7 1", 20, 3);
    s.extend_from_slice(b"%begin 100 8 1\r\n");
    for i in 0..23 {
        if i == 5 {
            s.extend_from_slice(b"%end 100 8 1\r\n");
        } else {
            s.extend_from_slice(format!("row {i}\r\n").as_bytes());
        }
    }
    s.extend_from_slice(b"%end 100 8 1\r\n%output %7 after\r\n");
    let (f, r) = feed(&mut d, &s);
    r.unwrap();
    assert_eq!(f.len(), 3, "{f:?}");
    let Frame::Block(b) = &f[1] else {
        panic!("{f:?}")
    };
    assert_eq!(b.lines.len(), 23);
    assert_eq!(b.lines[5], b"%end 100 8 1");
    assert!(matches!(&f[2], Frame::Line(l) if l == b"%output %7 after"));
}

#[test]
fn a_capture_whose_state_failed_ends_the_stream() {
    // The pane is gone: its state is an %error and the rows that follow
    // cannot be sized, so they are not believed either.
    let mut d = control(&[Expect::PaneState, CAPTURE]);
    let (f, r) = feed(
        &mut d,
        b"%begin 1 1 1\r\ncan't find pane: %7\r\n%error 1 1 1\r\n%begin 1 2 1\r\n",
    );
    assert_eq!(r, Err(Error::NoPaneState));
    assert!(matches!(&f[0], Frame::Block(b) if !b.ok));
}

#[test]
fn a_capture_with_no_state_before_it_ends_the_stream() {
    let mut d = control(&[CAPTURE]);
    assert_eq!(feed(&mut d, b"%begin 1 1 1\r\n").1, Err(Error::NoPaneState));

    // A state sizes only the capture right after it.
    let mut d = control(&[Expect::PaneState, Expect::Any, CAPTURE]);
    let mut s = state_block("1 1 1", 0, 2);
    s.extend_from_slice(b"%begin 1 2 1\r\n%end 1 2 1\r\n%begin 1 3 1\r\n");
    assert_eq!(feed(&mut d, &s).1, Err(Error::NoPaneState));
}

#[test]
fn a_malformed_state_line_is_an_error_without_the_bytes() {
    let mut d = control(&[Expect::PaneState, CAPTURE]);
    let e = feed(&mut d, b"%begin 1 1 1\r\nsecret 1 2\r\n%end 1 1 1\r\n")
        .1
        .unwrap_err();
    assert_eq!(e, Error::Malformed("pane state"));
    assert!(!e.to_string().contains("secret"));
}

#[test]
fn a_capture_past_the_block_bound_is_refused_not_fatal() {
    let mut c = Client::in_control(Limits::default());
    c.feed(b"%session-changed $1 x\r\n").unwrap();
    let big = Command::CapturePane {
        pane: PaneId(0),
        history_rows: 195_000,
    };
    assert_eq!(
        c.submit(&big).unwrap_err(),
        Error::BadArgument("capture exceeds the block bound")
    );
    assert_eq!(c.pending(), 0, "a refused command owes nothing");
    assert!(c.submit(&Command::Version).is_ok(), "the client is intact");
}

#[test]
fn a_client_pairs_a_capture_with_its_state() {
    let mut c = Client::in_control(Limits::default());
    c.feed(b"%session-changed $1 x\r\n").unwrap();
    let (token, line) = c
        .submit(&Command::CapturePane {
            pane: PaneId(7),
            history_rows: 50,
        })
        .unwrap();
    assert!(
        line.starts_with(b"display-message -p -t %7 '") && line.ends_with(b" -S -50 -E -\n"),
        "{}",
        String::from_utf8_lossy(&line)
    );
    assert_eq!(c.pending(), 2);
    let mut s = state_block("9 1 1", 1, 2);
    s.extend_from_slice(b"%begin 9 2 1\r\nh\r\na\r\nb\r\n%end 9 2 1\r\n");
    let ev = c.feed(&s).unwrap();
    assert_eq!(ev.len(), 1, "{ev:?}");
    match &ev[0] {
        Event::Capture {
            token: t,
            state,
            rows,
        } => {
            assert_eq!(*t, token);
            assert_eq!((state.history_size, state.height), (1, 2));
            assert_eq!(rows.len(), 3);
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(c.pending(), 0);
}

#[test]
fn a_capture_row_of_the_widest_pane_fits_the_line_bound() {
    // 10,000 cells, each a hyperlink of about 1 KiB plus its character.
    let mut d = control(&[Expect::Any]);
    let mut row = Vec::new();
    for _ in 0..10_000 {
        row.extend_from_slice(b"\x1b]8;;http://");
        row.extend(std::iter::repeat_n(b'u', 1024));
        row.extend_from_slice(b"\x1b\\x\x1b]8;;\x1b\\");
    }
    let mut s = b"%begin 1 1 1\r\n".to_vec();
    s.extend_from_slice(&row);
    s.extend_from_slice(b"\r\n%end 1 1 1\r\n");
    let (f, r) = feed(&mut d, &s);
    r.unwrap();
    assert!(matches!(&f[0], Frame::Block(b) if b.lines[0].len() == row.len()));
}

#[test]
fn disarming_then_rearming_between_reads_does_not_continue_the_marker() {
    let mut d = Decoder::new(Limits::default());
    d.arm(true);
    let mut out = Vec::new();
    d.feed(b"\x1bP10", &mut out).unwrap();
    assert_eq!(
        out,
        vec![Frame::Passthrough(b"\x1bP10".to_vec())],
        "nothing waits on the next read"
    );
    d.arm(false);
    d.arm(true);
    d.feed(b"00p%begin 1 1 0\r\n", &mut out).unwrap();
    assert_eq!(out[1], Frame::Passthrough(b"00p%begin 1 1 0\r\n".to_vec()));
    assert!(!d.in_control_mode());
}

#[test]
fn disarming_mid_marker_releases_the_bytes_as_output() {
    let mut d = Decoder::new(Limits::default());
    d.arm(true);
    let mut out = Vec::new();
    d.feed(b"a\x1bP10", &mut out).unwrap();
    d.arm(false);
    d.feed(b"00p%begin 1 1 0\r\n", &mut out).unwrap();
    let all: Vec<u8> = out
        .iter()
        .flat_map(|f| match f {
            Frame::Passthrough(b) => b.clone(),
            other => panic!("entered control mode after disarming: {other:?}"),
        })
        .collect();
    assert_eq!(all, b"a\x1bP1000p%begin 1 1 0\r\n");
    assert!(!d.in_control_mode());
}
