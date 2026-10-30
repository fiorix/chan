//! Replays the captures in `fixtures/tmux-control/` (real tmux 3.8 output).

use chan_tmux::{
    parse_layout, parse_message, Client, Command, Decoder, Event, Expect, Frame, Kind, Limits,
    Message, PaneId, WindowId,
};

fn fixture(name: &str) -> Vec<u8> {
    let path = format!(
        "{}/../../fixtures/tmux-control/{name}",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
}

/// Decode a capture whose solicited replies promise nothing.
fn frames(bytes: &[u8], chunk: usize, solicited: usize) -> Vec<Frame> {
    let mut d = Decoder::new(Limits::default());
    d.arm(true);
    for _ in 0..solicited {
        d.expect_next(Expect::Any);
    }
    let mut out = Vec::new();
    for c in bytes.chunks(chunk) {
        d.feed(c, &mut out).expect("capture decodes");
    }
    merge_passthrough(out)
}

/// Passthrough frames split by chunking are one logical run; merge them.
fn merge_passthrough(frames: Vec<Frame>) -> Vec<Frame> {
    let mut out: Vec<Frame> = Vec::new();
    for f in frames {
        match (out.last_mut(), f) {
            (Some(Frame::Passthrough(a)), Frame::Passthrough(b)) => a.extend(b),
            (_, f) => out.push(f),
        }
    }
    out
}

/// The notifications of a capture, in order.
fn messages(name: &str) -> Vec<Message> {
    frames(&fixture(name), usize::MAX, 20)
        .into_iter()
        .filter_map(|f| match f {
            Frame::Line(l) => Some(parse_message(&l).expect("notification")),
            _ => None,
        })
        .collect()
}

#[test]
fn entry_and_detach() {
    let f = frames(&fixture("01-entry-detach.raw"), usize::MAX, 2);
    assert_eq!(f[0], Frame::Entered);
    let Frame::Block(first) = &f[1] else {
        panic!("{:?}", f[1])
    };
    assert!(!first.solicited, "the first reply is the server's own");
    assert!(first.ok && first.lines.is_empty());
    assert!(f.iter().any(|f| matches!(f, Frame::Exit { reason: None })));
    assert_eq!(f.last(), Some(&Frame::Exit { reason: None }));
}

#[test]
fn every_split_point_decodes_the_same() {
    for name in [
        "01-entry-detach.raw",
        "02-output-escape.raw",
        "03-layout.raw",
        "03b-new-layouts.raw",
        "04-capture.raw",
        "06-exit-in-block.raw",
        "13-forged-end.raw",
    ] {
        let bytes = fixture(name);
        let whole = frames(&bytes, usize::MAX, 20);
        for chunk in [1, 2, 3, 7, 64] {
            assert_eq!(
                frames(&bytes, chunk, 20),
                whole,
                "{name} in chunks of {chunk}"
            );
        }
    }
}

#[test]
fn exits_in_every_way() {
    let reason = |name: &str| {
        let f = frames(&fixture(name), usize::MAX, 4);
        match f.last() {
            Some(Frame::Exit { reason }) => reason.clone(),
            other => panic!("{name}: {other:?}"),
        }
    };
    assert_eq!(reason("07-kill-server.raw"), None);
    assert_eq!(
        reason("08-sigkill-server.raw").as_deref(),
        Some("server exited unexpectedly")
    );
    assert_eq!(reason("12-after-exit.raw"), None);
    let f = frames(&fixture("10-attach-missing.raw"), usize::MAX, 1);
    let Frame::Block(b) = &f[1] else {
        panic!("{:?}", f[1])
    };
    assert!(!b.ok && b.lines == vec![b"no sessions".to_vec()]);
}

#[test]
fn a_pane_printing_exit_inside_a_reply_is_data() {
    let f = frames(&fixture("06-exit-in-block.raw"), usize::MAX, 4);
    let exits = f.iter().filter(|f| matches!(f, Frame::Exit { .. })).count();
    assert_eq!(exits, 1, "only the real %exit ends the session");
    let capture = f
        .iter()
        .find_map(|f| match f {
            Frame::Block(b) if b.lines.iter().any(|l| l == b"%exit") => Some(b),
            _ => None,
        })
        .expect("the pane's %exit is a row of the capture");
    assert!(capture.lines.iter().any(|l| l == b"%end"));
}

#[test]
fn output_is_unescaped() {
    let output: Vec<u8> = messages("02-output-escape.raw")
        .into_iter()
        .filter_map(|m| match m {
            Message::Output {
                pane: PaneId(0),
                data,
            } => Some(data),
            _ => None,
        })
        .flatten()
        .collect();
    let text = String::from_utf8_lossy(&output);
    assert!(text.contains("A\\\\B"), "backslashes survive: {text:?}");
    assert!(
        output.windows(2).any(|w| w == [0x1b, b'[']),
        "ESC is a real ESC byte"
    );
    assert!(output.contains(&0), "NUL survives");
    assert!(
        text.contains("\u{e9} \u{1f600} "),
        "UTF-8 passes through raw: {text:?}"
    );
}

#[test]
fn layouts_in_both_forms_agree() {
    let text = parse_layout("95e4,120x40,0,0{60x40,0,0,0,59x40,61,0[59x20,61,0,1,59x19,61,21,2]}")
        .unwrap();
    assert_eq!(text.panes(), vec![PaneId(0), PaneId(1), PaneId(2)]);
    let Kind::Horizontal(children) = &text.root.kind else {
        panic!()
    };
    assert_eq!(children.len(), 2);
    assert!(matches!(children[1].kind, Kind::Vertical(_)));

    let json = parse_layout(
        r#"{"V":2,"L":{"t":"h","w":80,"h":24,"x":0,"y":0,"c":[{"t":"p","w":40,"h":24,"x":0,"y":0,"l":0,"i":0,"I":"%0"},{"t":"p","w":39,"h":24,"x":41,"y":0,"a":true,"i":1,"I":"%1"}]}}"#,
    )
    .unwrap();
    assert_eq!(json.panes(), vec![PaneId(0), PaneId(1)]);
}

#[test]
fn every_layout_in_the_captures_parses_and_checks() {
    let mut seen = 0;
    for name in [
        "03-layout.raw",
        "03b-new-layouts.raw",
        "01-entry-detach.raw",
    ] {
        for m in messages(name) {
            if let Message::LayoutChange {
                layout,
                visible_layout,
                ..
            } = m
            {
                parse_layout(&layout).unwrap_or_else(|e| panic!("{layout}: {e}"));
                parse_layout(&visible_layout).unwrap();
                seen += 1;
            }
        }
    }
    assert!(seen >= 5, "{seen}");
}

#[test]
fn notifications_of_a_layout_session() {
    let msgs = messages("03-layout.raw");
    assert!(msgs.contains(&Message::WindowAdd(WindowId(1))));
    assert!(msgs.contains(&Message::WindowClose(WindowId(1))));
    assert!(msgs.contains(&Message::WindowRenamed {
        window: WindowId(1),
        name: "hello".into()
    }));
    assert!(msgs.contains(&Message::WindowPaneChanged {
        window: WindowId(0),
        pane: PaneId(1)
    }));
    assert!(matches!(msgs[0], Message::SessionsChanged));
}

#[test]
fn a_client_pairs_replies_with_commands() {
    let mut c = Client::new(Limits::default());
    c.arm(true);
    let head = b"\x1bP1000p%begin 1 1 0\r\n%end 1 1 0\r\n%session-changed $0 m1\r\n";
    c.feed(head).unwrap();
    assert!(c.ready());
    let (t1, bytes) = c.submit(&Command::Version).unwrap();
    assert_eq!(bytes, b"display-message -p '#{version}'\n");
    let (t2, _) = c.submit(&Command::ListWindows).unwrap();
    let ev = c
        .feed(b"%begin 2 2 1\r\n3.8\r\n%end 2 2 1\r\n%begin 3 3 1\r\n%error 3 3 1\r\n")
        .unwrap();
    assert_eq!(
        ev[0],
        Event::Reply {
            token: t1,
            result: Ok(vec![b"3.8".to_vec()])
        }
    );
    assert_eq!(
        ev[1],
        Event::Reply {
            token: t2,
            result: Err(vec![])
        },
        "an %error block with no rows"
    );
    let ev = c.feed(b"%exit\r\n\x1b\\after").unwrap();
    assert!(matches!(&ev[0], Event::Exited { dropped, .. } if dropped.is_empty()));
    assert_eq!(ev[1], Event::Passthrough(b"after".to_vec()));
}
