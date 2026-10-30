//! Drives a real tmux over `tmux -C`. Runs only when `CHAN_TMUX_BIN` names a
//! tmux (3.2 or later) to run; the server it starts lives on a private
//! socket and is killed at the end.

use std::io::{Read, Write};
use std::process::{Child, ChildStdin, Command as Process, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

use chan_tmux::{
    parse_created_id, parse_layout, parse_list_panes, parse_list_windows, parse_pane_state, Client,
    Command, Event, Limits, Message, PaneId, Token, Version, WindowId,
};

struct Live {
    child: Child,
    stdin: ChildStdin,
    rx: Receiver<Vec<u8>>,
    client: Client,
    events: Vec<Event>,
    bin: String,
    socket: String,
}

type Rows = Result<Vec<Vec<u8>>, Vec<Vec<u8>>>;

impl Live {
    fn start(bin: &str) -> Self {
        let socket = format!("chan-tmux-live-{}", std::process::id());
        let mut child = Process::new(bin)
            .args([
                "-L",
                &socket,
                "-f",
                "/dev/null",
                "-C",
                "new-session",
                "-x",
                "80",
                "-y",
                "24",
                "-s",
                "t",
                "sh",
            ])
            .env("TERM", "xterm")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn tmux");
        let stdin = child.stdin.take().unwrap();
        let mut out = child.stdout.take().unwrap();
        let (tx, rx) = channel();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = out.read(&mut buf) {
                if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        });
        let mut live = Self {
            child,
            stdin,
            rx,
            client: Client::in_control(Limits::default()),
            events: Vec::new(),
            bin: bin.to_owned(),
            socket,
        };
        live.wait(|l| l.client.ready());
        live
    }

    fn pump(&mut self, wait: Duration) -> bool {
        match self.rx.recv_timeout(wait) {
            Ok(bytes) => {
                let ev = self.client.feed(&bytes).expect("stream stays framed");
                self.events.extend(ev);
                true
            }
            Err(_) => false,
        }
    }

    fn wait(&mut self, done: impl Fn(&Live) -> bool) {
        let end = Instant::now() + Duration::from_secs(10);
        while !done(self) {
            assert!(
                Instant::now() < end,
                "timed out; pane 0 output: {:?}",
                String::from_utf8_lossy(&self.output_of(PaneId(0)))
            );
            self.pump(Duration::from_millis(50));
        }
    }

    fn send(&mut self, c: &Command) -> Token {
        let (token, bytes) = self.client.submit(c).expect("submit");
        self.stdin.write_all(&bytes).unwrap();
        self.stdin.flush().unwrap();
        token
    }

    fn call(&mut self, c: &Command) -> Rows {
        let token = self.send(c);
        self.wait(|l| {
            l.events
                .iter()
                .any(|e| matches!(e, Event::Reply { token: t, .. } if *t == token))
        });
        let i = self
            .events
            .iter()
            .position(|e| matches!(e, Event::Reply { token: t, .. } if *t == token))
            .unwrap();
        match self.events.remove(i) {
            Event::Reply { result, .. } => result,
            _ => unreachable!(),
        }
    }

    fn output_of(&self, pane: PaneId) -> Vec<u8> {
        self.events
            .iter()
            .filter_map(|e| match e {
                Event::Message(Message::Output { pane: p, data }) if *p == pane => {
                    Some(data.clone())
                }
                _ => None,
            })
            .flatten()
            .collect()
    }

    fn type_into(&mut self, pane: PaneId, text: &[u8]) {
        for c in Command::send_keys(pane, text) {
            assert_eq!(self.call(&c), Ok(vec![]));
        }
    }
}

impl Drop for Live {
    fn drop(&mut self) {
        let _ = Process::new(&self.bin)
            .args(["-L", &self.socket, "kill-server"])
            .output();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn against_a_real_tmux() {
    let Ok(bin) = std::env::var("CHAN_TMUX_BIN") else {
        eprintln!("CHAN_TMUX_BIN unset: skipping the live tmux test");
        return;
    };
    let mut t = Live::start(&bin);
    let pane = PaneId(0);

    // Version.
    let rows = t.call(&Command::Version).unwrap();
    let version = Version::parse(std::str::from_utf8(&rows[0]).unwrap()).expect("version");
    assert!(version >= Version { major: 3, minor: 2 }, "{version:?}");

    // Free text survives tmux's own parser and comes back as the notification.
    for name in [
        "plain",
        "it's a \"test\" $x; y",
        "\u{e9}\u{1f600} #{pane_id}",
        "a\\b",
        "100%",
        "#(touch /tmp/chan-tmux-injected)",
        "##",
    ] {
        let r = t.call(&Command::RenameWindow {
            window: WindowId(0),
            name: name.into(),
        });
        assert_eq!(r, Ok(vec![]), "{name:?}");
        // tmux stores a name C-escaped, so a backslash comes back doubled.
        let stored = name.replace('\\', "\\\\");
        t.wait(|l| {
            l.events.iter().any(|e| matches!(e, Event::Message(Message::WindowRenamed { name: n, .. }) if *n == stored))
        });
    }

    std::thread::sleep(Duration::from_millis(500));
    assert!(
        !std::path::Path::new("/tmp/chan-tmux-injected").exists(),
        "a name must not run a command"
    );

    // Keystrokes reach the pane byte for byte, including control bytes. The
    // interrupt goes alone: the line discipline drops pending echo on ^C.
    t.type_into(pane, b"printf 'ab\\n'; cat -v\r");
    t.wait(|l| String::from_utf8_lossy(&l.output_of(pane)).contains("ab\r\n"));
    t.type_into(pane, b"\x01\x02\x1b[A");
    t.wait(|l| String::from_utf8_lossy(&l.output_of(pane)).contains("^A^B^[[A"));
    t.type_into(pane, b"\x03");
    t.wait(|l| String::from_utf8_lossy(&l.output_of(pane)).contains("^C"));

    // Fill history, then capture exactly what the state says is there.
    t.type_into(pane, b"seq 1 120\r");
    t.wait(|l| String::from_utf8_lossy(&l.output_of(pane)).contains("\r\n120\r\n"));
    let state = parse_pane_state(&t.call(&Command::PaneState(pane)).unwrap()).unwrap();
    assert!(state.history_size >= 50, "{state:?}");
    let want = 50 + state.height as usize;
    let rows = t
        .call(&Command::CapturePane {
            pane,
            history_rows: 50,
            rows: state.height,
            alternate: false,
        })
        .unwrap();
    assert_eq!(rows.len(), want);

    // A hostile pane fills the screen with protocol lines; a capture of it
    // returns them as rows and the session carries on.
    t.type_into(
        pane,
        b"for i in 1 2 3 4 5 6; do printf '%%end 1 2 1\\n%%error 1 2 1\\n%%exit\\n%%output %%0 owned\\n'; done\r",
    );
    t.wait(|l| String::from_utf8_lossy(&l.output_of(pane)).contains("\r\n%output %0 owned\r\n"));
    let state = parse_pane_state(&t.call(&Command::PaneState(pane)).unwrap()).unwrap();
    let hist = state.history_size.min(10);
    let rows = t
        .call(&Command::CapturePane {
            pane,
            history_rows: hist,
            rows: state.height,
            alternate: false,
        })
        .unwrap();
    assert_eq!(rows.len(), (hist + state.height) as usize);
    assert!(
        rows.iter().filter(|r| r.as_slice() == b"%exit").count() >= 4,
        "forged rows arrive as data"
    );
    assert!(t.call(&Command::Version).is_ok(), "the session is intact");

    // Windows, splits and layouts.
    let w = parse_created_id(
        &t.call(&Command::NewWindow {
            cwd: Some("/tmp".into()),
        })
        .unwrap(),
    )
    .unwrap();
    let w = WindowId::parse(&w).unwrap();
    let p = parse_created_id(
        &t.call(&Command::SplitWindow {
            pane: PaneId(1),
            horizontal: true,
        })
        .unwrap(),
    )
    .unwrap();
    assert!(PaneId::parse(&p).is_some());
    let windows = parse_list_windows(&t.call(&Command::ListWindows).unwrap()).unwrap();
    assert_eq!(windows.len(), 2);
    let new = windows.iter().find(|i| i.id == w).unwrap();
    assert_eq!(parse_layout(&new.layout).unwrap().panes().len(), 2);
    let panes = parse_list_panes(&t.call(&Command::ListPanes(w)).unwrap()).unwrap();
    assert_eq!(panes.len(), 2);
    assert_eq!(panes.iter().filter(|p| p.active).count(), 1);
    assert_eq!(t.call(&Command::SelectWindow(WindowId(0))), Ok(vec![]));
    assert_eq!(t.call(&Command::KillWindow(w)), Ok(vec![]));

    // A failing command is an %error reply, not a dead stream.
    let err = t.call(&Command::KillWindow(WindowId(99))).unwrap_err();
    assert!(!err.is_empty());

    // Detach ends the session cleanly.
    t.send(&Command::Detach);
    t.wait(|l| l.events.iter().any(|e| matches!(e, Event::Exited { .. })));
}
