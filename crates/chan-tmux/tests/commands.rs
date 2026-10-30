use chan_tmux::escape::{escape_output, unescape_output};
use chan_tmux::layout::checksum;
use chan_tmux::{
    parse_created_id, parse_layout, parse_list_panes, parse_list_windows, parse_pane_state,
    Command, Error, LayoutError, PaneId, Version, WindowId, MAX_KEY_BYTES,
};

#[test]
fn octal_roundtrips_every_byte() {
    let all: Vec<u8> = (0..=255).collect();
    assert_eq!(unescape_output(&escape_output(&all)), all);
    let mut x: u32 = 12345;
    for _ in 0..200 {
        let data: Vec<u8> = (0..(x % 300))
            .map(|_| {
                x = x.wrapping_mul(1664525).wrapping_add(1013904223);
                (x >> 24) as u8
            })
            .collect();
        assert_eq!(unescape_output(&escape_output(&data)), data);
    }
}

#[test]
fn damaged_escapes_cost_a_byte_not_the_stream() {
    assert_eq!(unescape_output(b"a\\0b"), b"a?0b");
    assert_eq!(unescape_output(b"a\\778"), b"a?778");
    assert_eq!(unescape_output(b"\\777"), b"?777", "\\777 is not a byte");
    assert_eq!(
        unescape_output(b"x\ty"),
        b"xy",
        "a raw control byte is dropped"
    );
    assert_eq!(unescape_output(b"end\\"), b"end?");
}

#[test]
fn layout_checksum_matches_tmux() {
    // Taken from real captures.
    assert_eq!(checksum("120x40,0,0,0"), 0xaafd);
    assert!(parse_layout("aafd,120x40,0,0,0").is_ok());
    assert_eq!(
        parse_layout("aafe,120x40,0,0,0"),
        Err(LayoutError::Checksum)
    );
    assert_eq!(
        parse_layout("b25d,80x24,0,0,0").unwrap().panes(),
        vec![PaneId(0)]
    );
}

#[test]
fn layouts_refuse_the_malformed_and_the_huge() {
    for bad in [
        "",
        "zzzz,1x1,0,0,0",
        "0000,",
        "aafd,120x40,0,0",
        "aafd,120x40,0,0,0,",
    ] {
        assert!(parse_layout(bad).is_err(), "{bad:?}");
    }
    let deep = |n: usize| {
        let body = format!("{}1x1,0,0,0{}", "1x1,0,0{".repeat(n), "}".repeat(n));
        format!("{:04x},{body}", checksum(&body))
    };
    assert!(parse_layout(&deep(5)).is_ok());
    assert_eq!(parse_layout(&deep(40)), Err(LayoutError::TooDeep));
    let wide = {
        let cells = vec!["1x1,0,0,0"; 2000].join(",");
        let body = format!("10x10,0,0{{{cells}}}");
        format!("{:04x},{body}", checksum(&body))
    };
    assert_eq!(parse_layout(&wide), Err(LayoutError::TooLarge));
    let big = "100000x1,0,0,0";
    assert!(parse_layout(&format!("{:04x},{big}", checksum(big))).is_ok());
    let big = "100001x1,0,0,0";
    assert_eq!(
        parse_layout(&format!("{:04x},{big}", checksum(big))),
        Err(LayoutError::TooLarge)
    );
    let float = "1x1,0,0<1x1,0,0,0>";
    assert!(parse_layout(&format!("{:04x},{float}", checksum(float))).is_err());
    assert!(parse_layout("{\"L\":").is_err());
}

#[test]
fn commands_render() {
    let r = |c: Command| c.render().unwrap();
    assert_eq!(
        r(Command::ClientSize {
            cols: 120,
            rows: 40
        }),
        "refresh-client -C 120,40"
    );
    assert_eq!(
        r(Command::ContinuePane(PaneId(3))),
        "refresh-client -A '%3:continue'"
    );
    assert_eq!(
        r(Command::SendKeys {
            pane: PaneId(2),
            bytes: vec![0x1b, b'a', 0]
        }),
        "send-keys -t %2 -H 1b 61 00"
    );
    assert_eq!(
        r(Command::CapturePane {
            pane: PaneId(0),
            history_rows: 50,
            rows: 24,
            alternate: false
        }),
        "capture-pane -p -e -q -t %0 -S -50 -E 23"
    );
    assert_eq!(
        r(Command::CapturePane {
            pane: PaneId(0),
            history_rows: 0,
            rows: 24,
            alternate: true
        }),
        "capture-pane -p -e -q -a -t %0 -S 0 -E 23"
    );
    assert_eq!(
        r(Command::SplitWindow {
            pane: PaneId(1),
            horizontal: true
        }),
        "split-window -h -t %1 -PF '#{pane_id}'"
    );
    assert_eq!(
        r(Command::NewWindow { cwd: None }),
        "new-window -PF '#{window_id}'"
    );
}

#[test]
fn only_a_capture_promises_rows() {
    let c = Command::CapturePane {
        pane: PaneId(0),
        history_rows: 50,
        rows: 24,
        alternate: false,
    };
    assert_eq!(c.expect(), Some(74));
    for c in [
        Command::Version,
        Command::ListWindows,
        Command::Detach,
        Command::KillWindow(WindowId(1)),
    ] {
        assert_eq!(c.expect(), None);
    }
}

#[test]
fn free_text_cannot_end_the_command_line() {
    let name = |s: &str| {
        Command::RenameWindow {
            window: WindowId(0),
            name: s.into(),
        }
        .render()
    };
    assert_eq!(
        name("it's a \"test\" $x; y").unwrap(),
        "rename-window -t @0 'it'\\''s a \"test\" $x; y'"
    );
    for bad in ["a\nb", "a\rb", "a\0b", "a\x1bb", "a\u{7f}b", "a\u{85}b"] {
        assert_eq!(
            name(bad),
            Err(Error::BadArgument("control character")),
            "{bad:?}"
        );
    }
    assert_eq!(
        name("#{pane_id} #(touch x)").unwrap(),
        "rename-window -t @0 '##{pane_id} ##(touch x)'"
    );
    assert!(name(&"x".repeat(2000)).is_err());
    assert!(Command::NewWindow {
        cwd: Some("/tmp/a\nb".into())
    }
    .render()
    .is_err());
}

#[test]
fn sizes_and_ranges_are_checked() {
    assert!(Command::ClientSize { cols: 0, rows: 1 }.render().is_err());
    assert!(Command::ClientSize {
        cols: 1,
        rows: 10_001
    }
    .render()
    .is_err());
    assert!(Command::CapturePane {
        pane: PaneId(0),
        history_rows: 0,
        rows: 0,
        alternate: false
    }
    .render()
    .is_err());
    assert!(Command::CapturePane {
        pane: PaneId(0),
        history_rows: 5,
        rows: 24,
        alternate: true
    }
    .render()
    .is_err());
    assert!(Command::SendKeys {
        pane: PaneId(0),
        bytes: vec![]
    }
    .render()
    .is_err());
    assert!(Command::SendKeys {
        pane: PaneId(0),
        bytes: vec![0; MAX_KEY_BYTES + 1]
    }
    .render()
    .is_err());
}

#[test]
fn keystrokes_are_chunked() {
    let cmds = Command::send_keys(PaneId(1), &vec![b'x'; MAX_KEY_BYTES * 2 + 1]);
    assert_eq!(cmds.len(), 3);
    assert!(cmds.iter().all(|c| c.render().is_ok()));
    assert!(Command::send_keys(PaneId(1), b"").is_empty());
}

#[test]
fn versions() {
    assert_eq!(Version::parse("3.8"), Some(Version { major: 3, minor: 8 }));
    assert_eq!(Version::parse("3.0a"), Some(Version { major: 3, minor: 0 }));
    assert_eq!(
        Version::parse("next-3.5"),
        Some(Version { major: 3, minor: 5 })
    );
    assert!(Version::parse("3.8").unwrap() >= Version { major: 3, minor: 2 });
    assert_eq!(Version::parse("master"), None);
}

#[test]
fn reply_parsers() {
    let l = |s: &str| vec![s.as_bytes().to_vec()];
    let w = parse_list_windows(&[
        b"@0 95e4,10x10,0,0,0 95e4,10x10,0,0,0 -".to_vec(),
        b"@1 aa,1x1,0,0,3 aa,1x1,0,0,3 ".to_vec(),
    ])
    .unwrap();
    assert_eq!((w[0].id, w[0].flags.as_str()), (WindowId(0), "-"));
    assert_eq!(w[1].flags, "", "empty flags are a field");
    assert!(parse_list_windows(&l("@0 only three")).is_err());
    assert!(parse_list_windows(&l("x0 a b c")).is_err());

    let p = parse_list_panes(&[b"%0 1".to_vec(), b"%1 0".to_vec()]).unwrap();
    assert!(p[0].active && !p[1].active);

    let s = parse_pane_state(&l("%0 21 23 0 0 0 23 80 24 76")).unwrap();
    assert_eq!(
        (s.cursor_x, s.height, s.history_size, s.alternate_on),
        (21, 24, 76, false)
    );
    assert!(parse_pane_state(&l("%0 1 2")).is_err());
    assert!(parse_pane_state(&[]).is_err());

    assert_eq!(parse_created_id(&l("@4")).unwrap(), "@4");
    assert!(parse_created_id(&l("nope")).is_err());
}
