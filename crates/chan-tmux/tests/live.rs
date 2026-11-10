//! Drives a real tmux over `tmux -C`. Runs only when `CHAN_TMUX_BIN` names a
//! tmux (3.2 or later) to run; each test's server lives on a private socket
//! of its own and is killed at the end.

use std::io::{Read, Write};
use std::process::{Child, ChildStdin, Command as Process, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

use chan_tmux::{
    parse_created_id, parse_layout, parse_list_panes, parse_list_windows, parse_pane_state, Client,
    Command, Error, Event, Limits, Message, PaneId, PaneState, Token, Version, WindowId,
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
    /// Start a server on a socket named for this process and `tag`, so the
    /// tests of one run each have their own.
    fn start(bin: &str, tag: &str) -> Self {
        let socket = format!("chan-tmux-live-{}-{tag}", std::process::id());
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
        self.try_pump(wait).expect("stream stays framed")
    }

    /// Read once, handing back the client's refusal of what was read.
    fn try_pump(&mut self, wait: Duration) -> Result<bool, Error> {
        match self.rx.recv_timeout(wait) {
            Ok(bytes) => {
                let ev = self.client.feed(&bytes)?;
                self.events.extend(ev);
                Ok(true)
            }
            Err(_) => Ok(false),
        }
    }

    /// Run a tmux command against the server from outside the client.
    fn tmux(&self, args: &[&str]) {
        let _ = Process::new(&self.bin)
            .args(["-L", &self.socket])
            .args(args)
            .output();
    }

    /// Every name tmux reported for `pane`, oldest first.
    fn names_of(&self, pane: PaneId) -> Vec<String> {
        self.events
            .iter()
            .filter_map(|e| match e {
                Event::Message(Message::PaneName { pane: p, name }) if *p == pane => {
                    Some(name.clone())
                }
                _ => None,
            })
            .collect()
    }

    /// Wait until the last name tmux reported for `pane` is `name`.
    fn wait_name(&mut self, pane: PaneId, name: &str) {
        let end = Instant::now() + Duration::from_secs(10);
        while self.names_of(pane).last().map(String::as_str) != Some(name) {
            assert!(
                Instant::now() < end,
                "pane {pane} was never named {name:?}: {:?}",
                self.names_of(pane)
            );
            self.pump(Duration::from_millis(50));
        }
    }

    /// Read for `time`, long enough for tmux's once-a-second look at the
    /// panes to have run.
    fn settle(&mut self, time: Duration) {
        let end = Instant::now() + time;
        while Instant::now() < end {
            self.pump(Duration::from_millis(50));
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

    fn capture(&mut self, pane: PaneId, history_rows: u32) -> (PaneState, Vec<Vec<u8>>) {
        let token = self.send(&Command::CapturePane { pane, history_rows });
        self.wait(|l| {
            l.events
                .iter()
                .any(|e| matches!(e, Event::Capture { token: t, .. } if *t == token))
        });
        let i = self
            .events
            .iter()
            .position(|e| matches!(e, Event::Capture { token: t, .. } if *t == token))
            .unwrap();
        match self.events.remove(i) {
            Event::Capture { state, rows, .. } => (state, rows),
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
        self.tmux(&["kill-server"]);
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
    let mut t = Live::start(&bin, "protocol");
    let pane = PaneId(0);

    // The interrupt line is a command tmux refuses and nothing more.
    let refused = t.call(&Command::Interrupt).unwrap_err();
    assert!(
        refused.iter().any(|r| r.starts_with(b"parse error")),
        "{refused:?}"
    );

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
        "-x",
        "--",
        "-t @0; kill-server",
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
    // The tty echoes the line once and cat prints it again, which proves cat
    // is the foreground job before the interrupt is sent; sent earlier, the
    // interrupt can reach the shell instead.
    t.type_into(pane, b"\x01\x02\x1b[A\r");
    t.wait(|l| {
        String::from_utf8_lossy(&l.output_of(pane))
            .matches("^A^B^[[A")
            .count()
            >= 2
    });
    t.type_into(pane, b"\x03");
    // The tty echoes ^C before the shell gets its prompt back; wait for the
    // prompt, or the next line goes to cat.
    t.wait(|l| {
        let out = String::from_utf8_lossy(&l.output_of(pane)).into_owned();
        out.contains("^C") && out.ends_with("$ ")
    });

    // Fill history, then capture exactly what the state says is there.
    t.type_into(pane, b"seq 1 120\r");
    t.wait(|l| String::from_utf8_lossy(&l.output_of(pane)).contains("\r\n120\r\n"));
    let state = parse_pane_state(&t.call(&Command::PaneState(pane)).unwrap()).unwrap();
    assert!(state.history_size >= 50, "{state:?}");
    let (captured, rows) = t.capture(pane, 50);
    assert_eq!(captured.height, state.height);
    assert_eq!(rows.len(), 50 + state.height as usize);
    assert!(rows.iter().any(|r| r == b"120"), "{rows:?}");

    // A capture that asks for more history than there is gets what there
    // is, sized by the state in the same command line.
    let (captured, rows) = t.capture(pane, 100_000);
    assert_eq!(
        rows.len(),
        (captured.history_size + captured.height) as usize
    );

    // Shrinking the client moves screen rows into history; the capture
    // still sizes itself from the state tmux reads in the same breath.
    assert_eq!(
        t.call(&Command::ClientSize { cols: 80, rows: 10 }),
        Ok(vec![])
    );
    let (captured, rows) = t.capture(pane, 50);
    assert_eq!(captured.height, 10, "{captured:?}");
    assert_eq!(rows.len(), 50 + 10);
    assert_eq!(
        t.call(&Command::ClientSize { cols: 80, rows: 24 }),
        Ok(vec![])
    );

    // The alternate screen: the capture is what the pane shows, with the
    // history tmux still reports above it.
    t.type_into(pane, b"printf '\\033[?1049h'; printf 'ALTSCREEN\\n'\r");
    // The echo of the typed line holds the word too; the output line does
    // not arrive until the command ran.
    t.wait(|l| String::from_utf8_lossy(&l.output_of(pane)).contains("ALTSCREEN\r\n"));
    let (captured, shown) = t.capture(pane, 50);
    assert!(captured.alternate_on, "{captured:?}");
    assert_eq!(
        shown.len(),
        (captured.history_size.min(50) + captured.height) as usize
    );
    assert!(shown
        .iter()
        .any(|r| r.windows(9).any(|w| w == b"ALTSCREEN")));
    // The empty quotes keep the echoed line from spelling the word.
    t.type_into(pane, b"printf '\\033[?1049l'; echo ba\"\"ck\r");
    t.wait(|l| String::from_utf8_lossy(&l.output_of(pane)).contains("back\r\n"));
    let state = parse_pane_state(&t.call(&Command::PaneState(pane)).unwrap()).unwrap();
    assert!(!state.alternate_on, "{state:?}");

    // A hostile pane fills the screen with protocol lines; a capture of it
    // returns them as rows and the session carries on.
    t.type_into(
        pane,
        b"for i in 1 2 3 4 5 6; do printf '%%end 1 2 1\\n%%error 1 2 1\\n%%exit\\n%%output %%0 owned\\n'; done\r",
    );
    t.wait(|l| String::from_utf8_lossy(&l.output_of(pane)).contains("\r\n%output %0 owned\r\n"));
    let (state, rows) = t.capture(pane, 10);
    assert_eq!(
        rows.len(),
        (state.history_size.min(10) + state.height) as usize
    );
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
    assert!(!new.name.is_empty(), "{new:?}");
    let panes = parse_list_panes(&t.call(&Command::ListPanes(w)).unwrap()).unwrap();
    assert_eq!(panes.len(), 2);
    assert_eq!(panes.iter().filter(|p| p.active).count(), 1);
    assert_eq!(t.call(&Command::SelectWindow(WindowId(0))), Ok(vec![]));
    let second = PaneId::parse(&p).unwrap();
    assert_eq!(t.call(&Command::KillPane(second)), Ok(vec![]));
    let panes = parse_list_panes(&t.call(&Command::ListPanes(w)).unwrap()).unwrap();
    assert_eq!(panes.len(), 1, "the split pane is gone");
    assert_eq!(t.call(&Command::KillWindow(w)), Ok(vec![]));

    // A failing command is an %error reply, not a dead stream.
    let err = t.call(&Command::KillWindow(WindowId(99))).unwrap_err();
    assert!(!err.is_empty());

    // Detach ends the session cleanly.
    t.send(&Command::Detach);
    t.wait(|l| l.events.iter().any(|e| matches!(e, Event::Exited { .. })));
}

/// The pane names subscription against a real tmux: what a pane is called
/// when it is new, when a program titles it, when the program is gone, and
/// what a window's rename and a hostile command name do.
#[test]
fn pane_names_against_a_real_tmux() {
    let Ok(bin) = std::env::var("CHAN_TMUX_BIN") else {
        eprintln!("CHAN_TMUX_BIN unset: skipping the live tmux test");
        return;
    };
    let mut t = Live::start(&bin, "names");
    // A split runs the default shell, and a user's shell may title its pane
    // at every prompt; `sh` with no profile leaves the title alone.
    t.tmux(&["set-option", "-g", "default-shell", "/bin/sh"]);
    let first = PaneId(0);

    // tmux answers the subscription with an empty reply, then reports every
    // pane within its once-a-second look. A new pane's title is the host's
    // name, which names nothing, so the pane reads as its command.
    assert_eq!(t.call(&Command::SubscribePaneNames), Ok(vec![]));
    t.wait_name(first, "sh");

    // A pane split off later is reported without being asked for.
    let second = parse_created_id(
        &t.call(&Command::SplitWindow {
            pane: first,
            horizontal: true,
        })
        .unwrap(),
    )
    .unwrap();
    let second = PaneId::parse(&second).unwrap();
    t.wait_name(second, "sh");

    // A program titles its pane (OSC 2): that pane takes the title and the
    // other pane of the window keeps its own name.
    t.type_into(second, b"printf '\\033]2;build log\\007'\r");
    t.wait_name(second, "build log");
    assert_eq!(t.names_of(first).last().unwrap(), "sh");

    // The title outlives the program that set it, and a command run under it
    // does not replace it. OSC 0 sets it as OSC 2 does.
    t.type_into(
        second,
        b"sh -c \"printf '\\033]0;left by a program\\007'\"; sleep 2\r",
    );
    t.wait_name(second, "left by a program");
    t.settle(Duration::from_millis(3200));
    assert_eq!(t.names_of(second).last().unwrap(), "left by a program");

    // An emptied title names nothing: the command does again.
    t.type_into(second, b"printf '\\033]2;\\007'\r");
    t.wait_name(second, "sh");

    // Under the default title the name follows the foreground command, there
    // and back.
    t.type_into(first, b"sleep 2\r");
    t.wait_name(first, "sleep");
    t.wait_name(first, "sh");

    // Renaming the window is a window notification and no pane's name.
    let before = (t.names_of(first).len(), t.names_of(second).len());
    assert_eq!(
        t.call(&Command::RenameWindow {
            window: WindowId(0),
            name: "renamed".into(),
        }),
        Ok(vec![])
    );
    t.wait(|l| {
        l.events.iter().any(
            |e| matches!(e, Event::Message(Message::WindowRenamed { name, .. }) if name == "renamed"),
        )
    });
    t.settle(Duration::from_millis(2200));
    assert_eq!(
        (t.names_of(first).len(), t.names_of(second).len()),
        before,
        "a window rename reports no pane"
    );

    // A pane of a window added later is reported too.
    let window = parse_created_id(&t.call(&Command::NewWindow { cwd: None }).unwrap()).unwrap();
    let window = WindowId::parse(&window).unwrap();
    let panes = parse_list_panes(&t.call(&Command::ListPanes(window)).unwrap()).unwrap();
    t.wait_name(panes[0].id, "sh");

    // A command whose name holds a line break and a forged exit. A tmux that
    // prints the name as it is cuts its line, which the client refuses,
    // ending the stream; one that cleans the name keeps the stream. Either
    // way the forged line is never read as tmux's exit. The program under
    // that name is the shell, which runs whatever it is called; a `sleep`
    // that is one of a multicall binary's names refuses a name it does not
    // know and is gone before tmux looks at the pane.
    let hostile = b"d=$(mktemp -d) && f=\"$d/$(printf 'x\\n%%exit')\" && \
ln -s \"$(command -v sh)\" \"$f\" && \"$f\" -c 'sleep 2; :'; rm -rf \"$d\"\r";
    let reported = t.names_of(first).len();
    for c in Command::send_keys(first, hostile) {
        t.send(&c);
    }
    let end = Instant::now() + Duration::from_millis(4500);
    let mut refused = None;
    while Instant::now() < end && refused.is_none() {
        refused = t.try_pump(Duration::from_millis(50)).err();
    }
    assert!(
        !t.events.iter().any(|e| matches!(e, Event::Exited { .. })),
        "a pane's command name ended control mode"
    );
    // Which of the two this tmux did is printed for a run under --nocapture.
    match refused {
        Some(error) => {
            eprintln!("hostile command name: the client refused the cut line");
            assert_eq!(error, Error::Malformed("subscription-changed"));
        }
        None => {
            let during = t.names_of(first).split_off(reported);
            eprintln!("hostile command name: tmux reported {during:?}");
            assert!(!during.is_empty(), "the command was never reported");
            assert!(
                during.iter().all(|name| !name.contains(char::is_control)),
                "{during:?}"
            );
            t.wait_name(first, "sh");
            assert!(t.call(&Command::Version).is_ok(), "the session is intact");
            t.send(&Command::Detach);
            t.wait(|l| l.events.iter().any(|e| matches!(e, Event::Exited { .. })));
        }
    }
}
