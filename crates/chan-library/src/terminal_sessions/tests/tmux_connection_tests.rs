//! A tmux connection on a control session: the attach sequence, the pane
//! sessions it makes, and their commands back to tmux.

use super::*;
use crate::terminal_sessions::tmux_gate::Foreground;
use std::time::{Duration, Instant};

const MARKER: &[u8] = b"\x1bP1000p";
const ENTRY: &[u8] =
    b"%begin 1 1 0\r\n%end 1 1 0\r\n%sessions-changed\r\n%session-changed $0 main\r\n";
/// The interrupt's refusal and the version, the replies to the first two
/// submitted commands.
const VERSION_REPLY: &[u8] =
    b"%begin 2 2 1\r\n%error 2 2 1\r\n%begin 2 3 1\r\n3.8\r\n%end 2 3 1\r\n";
/// Empty replies to pause-after and new-layouts.
const FLAGS_REPLIES: &[u8] = b"%begin 2 4 1\r\n%end 2 4 1\r\n%begin 2 5 1\r\n%end 2 5 1\r\n";
/// One window, one pane, 80 by 24 (the checksum is tmux's).
const ONE_WINDOW: &[u8] =
    b"%begin 2 6 1\r\n@0 b25d,80x24,0,0,0 b25d,80x24,0,0,0 * shell\r\n%end 2 6 1\r\n";

struct Rig {
    registry: Registry,
    control: Arc<Session>,
    commands: std::sync::mpsc::Receiver<PtyCommand>,
    /// tmux's command counter, for the headers of the replies the test writes.
    number: u64,
}

impl Rig {
    fn connected() -> Self {
        let registry = Registry::new(test_config(1 << 16, 4, 10));
        let (control, commands) = test_session_with_commands(1 << 16);
        register_session(&registry, &control);
        *control
            .tmux_foreground
            .lock()
            .expect("terminal tmux foreground poisoned") = Some(Foreground {
            name: Some("tmux".into()),
            command: Some("tmux -CC".into()),
        });
        let mut rig = Rig {
            registry,
            control,
            commands,
            number: 6,
        };
        rig.feed(&[MARKER, ENTRY].concat());
        assert_eq!(
            rig.inputs(),
            vec![
                b"\x03\n".to_vec(),
                b"display-message -p '#{version}'\n".to_vec()
            ]
        );
        rig.feed(VERSION_REPLY);
        let after_version = rig.inputs();
        assert_eq!(after_version.len(), 3, "{after_version:?}");
        assert!(after_version[0].starts_with(b"refresh-client -f pause-after="));
        assert_eq!(after_version[1], b"refresh-client -f new-layouts\n");
        assert!(after_version[2].starts_with(b"list-windows -F "));
        rig.work();
        rig.feed(FLAGS_REPLIES);
        rig
    }

    fn feed(&mut self, bytes: &[u8]) {
        self.control.record_output(bytes);
    }

    /// Everything written to the control PTY since the last call.
    fn inputs(&self) -> Vec<Vec<u8>> {
        let mut out = Vec::new();
        while let Ok(command) = self.commands.try_recv() {
            if let PtyCommand::Input(bytes) = command {
                out.push(bytes);
            }
        }
        out
    }

    /// Writes that arrive from another thread: wait up to two seconds for
    /// one matching `want`.
    fn wait_input(&self, want: impl Fn(&[u8]) -> bool) -> Vec<u8> {
        let end = Instant::now() + Duration::from_secs(2);
        loop {
            match self.commands.recv_timeout(Duration::from_millis(20)) {
                Ok(PtyCommand::Input(bytes)) if want(&bytes) => return bytes,
                Ok(_) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => panic!("control gone"),
            }
            assert!(Instant::now() < end, "no matching write in time");
        }
    }

    /// The registry's drainer pass for the control session's work.
    fn work(&self) {
        self.registry.perform_tmux_work(&self.control);
    }

    fn reply(&mut self, rows: &[&[u8]]) -> Vec<u8> {
        self.number += 1;
        let header = format!("2 {} 1", self.number);
        let mut out = format!("%begin {header}\r\n").into_bytes();
        for row in rows {
            out.extend_from_slice(row);
            out.extend_from_slice(b"\r\n");
        }
        out.extend_from_slice(format!("%end {header}\r\n").as_bytes());
        out
    }

    /// A capture reply: the state line, then `history` plus `height` rows.
    fn capture(&mut self, pane: u32, history: u32, height: u32, rows: &[&[u8]]) -> Vec<u8> {
        let state = format!(
            "%{pane} 0 {} 0 0 0 {} 80 {height} {history}",
            height - 1,
            height - 1
        );
        let mut out = self.reply(&[state.as_bytes()]);
        let mut all: Vec<&[u8]> = rows.to_vec();
        while all.len() < (history + height) as usize {
            all.push(b"");
        }
        out.extend(self.reply(&all));
        out
    }

    fn pane(&self, pane: u32) -> Arc<Session> {
        self.control
            .tmux
            .lock()
            .expect("terminal tmux gate poisoned")
            .connection()
            .expect("connected")
            .pane_session(chan_tmux::PaneId(pane))
            .expect("a pane session")
    }

    fn ring(&self, session: &Session) -> Vec<u8> {
        self.registry
            .attach(&session.id, None)
            .expect("attachable")
            .replay
            .concat()
    }

    fn windows(&self) -> usize {
        self.control
            .tmux
            .lock()
            .expect("terminal tmux gate poisoned")
            .connection()
            .map(|c| c.window_count())
            .unwrap_or(0)
    }

    fn control_output(&self, events: &mut broadcast::Receiver<SessionEvent>) -> String {
        let mut out = Vec::new();
        while let Ok(event) = events.try_recv() {
            if let SessionEvent::Output(bytes) = event {
                out.extend_from_slice(&bytes);
            }
        }
        String::from_utf8_lossy(&out).into_owned()
    }
}

/// Connect, list one window with one pane, let the registry make the pane
/// session, and answer the capture: the rig after the attach sequence.
fn attached() -> (Rig, Arc<Session>) {
    let mut rig = Rig::connected();
    rig.feed(ONE_WINDOW);
    let after_list = rig.inputs();
    assert_eq!(after_list.len(), 1, "{after_list:?}");
    assert!(after_list[0].starts_with(b"list-panes -t @0 "));
    rig.work();
    let pane = rig.pane(0);
    assert!(pane.is_tmux_pane());
    assert_eq!(pane.live_metadata().name.as_deref(), Some("shell"));
    assert_eq!(pane.live_metadata().group, "tmux");
    let capture = rig.inputs();
    assert_eq!(capture.len(), 1, "{capture:?}");
    assert!(
        capture[0].starts_with(b"display-message -p -t %0 ")
            && capture[0].ends_with(b" ; capture-pane -p -e -t %0 -S -10922 -E -\n"),
        "{}",
        String::from_utf8_lossy(&capture[0])
    );
    let panes_reply = rig.reply(&[b"%0 1"]);
    rig.feed(&panes_reply);
    (rig, pane)
}

#[test]
fn the_attach_sequence_makes_a_pane_session_and_replays_its_capture() {
    let (mut rig, pane) = attached();
    let capture = rig.capture(0, 2, 24, &[b"old one", b"old two", b"$ ls", b"a  b"]);
    rig.feed(&capture);
    let ring = rig.ring(&pane);
    let text = String::from_utf8_lossy(&ring).into_owned();
    assert!(text.starts_with("\x1b[0m\x1b[H\x1b[2J"), "{text:?}");
    assert!(
        text.contains("old one\r\nold two\r\n$ ls\r\na  b\r\n"),
        "{text:?}"
    );
    assert!(
        text.ends_with("\x1b[0m\x1b[24;1H"),
        "the cursor goes where tmux had it: {text:?}"
    );
    assert!(!text.contains("%begin"), "nothing of the protocol");
    rig.feed(b"%output %0 \\033[32mhi\\015\\012\r\n");
    assert!(rig.ring(&pane).ends_with(b"\x1b[32mhi\r\n"));
}

#[test]
fn output_before_the_capture_is_held_and_follows_it() {
    let (mut rig, pane) = attached();
    rig.feed(b"%output %0 early\r\n");
    assert!(rig.ring(&pane).is_empty(), "held, not shown");
    let capture = rig.capture(0, 0, 24, &[b"$ "]);
    rig.feed(&capture);
    let text = String::from_utf8_lossy(&rig.ring(&pane)).into_owned();
    let screen = text.find("$ ").unwrap();
    let early = text.find("early").unwrap();
    assert!(
        screen < early,
        "the capture first, then what was held: {text:?}"
    );
}

#[test]
fn a_hold_past_its_bound_makes_the_pane_lossy_and_the_capture_its_history() {
    let (mut rig, pane) = attached();
    let line = [b"%output %0 ".as_slice(), &[b'x'; 4000], b"\r\n"].concat();
    for _ in 0..300 {
        rig.feed(&line);
    }
    let capture = rig.capture(0, 0, 24, &[b"$ "]);
    rig.feed(&capture);
    let ring = rig.ring(&pane);
    assert!(
        !ring.windows(4000).any(|w| w.iter().all(|b| *b == b'x')),
        "the hold was dropped"
    );
    rig.feed(b"%output %0 after\r\n");
    let ring = rig.ring(&pane);
    assert!(
        ring.ends_with(b"after"),
        "live output flows after the capture"
    );
}

#[test]
fn input_resize_and_kill_reach_tmux_through_the_gateway_thread() {
    let (mut rig, pane) = attached();
    let capture = rig.capture(0, 0, 24, &[b"$ "]);
    rig.feed(&capture);
    pane.send_input(b"ls\r");
    let keys = rig.wait_input(|b| b.starts_with(b"send-keys"));
    assert_eq!(keys, b"send-keys -t %0 -H 6c 73 0d\n");
    pane.resize(PtySize {
        cols: 100,
        rows: 30,
        pixel_width: 0,
        pixel_height: 0,
    });
    let size = rig.wait_input(|b| b.starts_with(b"refresh-client -C"));
    assert_eq!(size, b"refresh-client -C @0:100x30\n");
    assert!(rig.registry.close(&pane.id, CloseReason::Explicit));
    let kill = rig.wait_input(|b| b.starts_with(b"kill-pane"));
    assert_eq!(kill, b"kill-pane -t %0\n");
}

#[test]
fn typing_into_the_control_terminal_reaches_nothing_while_connected() {
    let (mut rig, _pane) = attached();
    rig.control.send_input(b"detach-client\n");
    rig.control.send_input_plan(vec![b"x".to_vec()]);
    assert!(rig.inputs().is_empty(), "the PTY's input is the protocol's");
    rig.feed(b"%exit\r\n\x1b\\$ ");
    rig.work();
    rig.control.send_input(b"ls\r");
    assert_eq!(
        rig.inputs(),
        vec![b"ls\r".to_vec()],
        "plain again, typing flows"
    );
}

#[test]
fn a_pause_is_answered_and_a_window_close_ends_its_panes() {
    let (mut rig, pane) = attached();
    rig.feed(b"%pause %0\r\n");
    assert_eq!(
        rig.inputs(),
        vec![b"refresh-client -A '%0:continue'\n".to_vec()]
    );
    let mut handle = rig.registry.attach(&pane.id, None).unwrap();
    rig.feed(b"%window-close @0\r\n");
    rig.work();
    assert!(
        rig.registry.attach(&pane.id, None).is_none(),
        "the pane session is gone"
    );
    let mut exited = false;
    while let Ok(event) = handle.rx.try_recv() {
        if matches!(event, SessionEvent::Exit(TerminalExit::Code { code: 0 })) {
            exited = true;
        }
    }
    assert!(exited, "an attached client saw the pane end");
    assert_eq!(rig.windows(), 0);
}

#[test]
fn tmux_exiting_ends_every_pane_and_the_control_terminal_draws_again() {
    let (mut rig, pane) = attached();
    let mut events = rig.control.output_tx.subscribe();
    rig.feed(b"%exit\r\n\x1b\\$ ");
    rig.work();
    let shown = rig.control_output(&mut events);
    assert!(
        shown.contains("[chan] tmux 3.8 control mode ended"),
        "{shown:?}"
    );
    assert!(shown.ends_with("$ "), "{shown:?}");
    assert!(rig.registry.attach(&pane.id, None).is_none());
    assert!(matches!(
        rig.registry.ended(&pane.id),
        Some(SessionEnd::Closed)
    ));
}

#[test]
fn the_control_process_ending_ends_the_connection() {
    let (rig, pane) = attached();
    rig.control
        .record_terminal_exit(TerminalExit::Unknown, &rig.registry.last_exit);
    rig.work();
    assert!(rig.registry.attach(&pane.id, None).is_none());
    assert_eq!(rig.windows(), 0);
}

#[test]
fn windows_past_the_cap_are_listed_but_not_materialized() {
    let mut rig = Rig::connected();
    let rows: Vec<Vec<u8>> = (0..10)
        .map(|i| format!("@{i} b25d,80x24,0,0,{i} b25d,80x24,0,0,{i} - w{i}").into_bytes())
        .collect();
    let refs: Vec<&[u8]> = rows.iter().map(Vec::as_slice).collect();
    let list = rig.reply(&refs);
    rig.feed(&list);
    let list_panes = rig
        .inputs()
        .into_iter()
        .filter(|b| b.starts_with(b"list-panes"))
        .count();
    assert_eq!(list_panes, 8, "eight windows get their panes listed");
    assert_eq!(rig.windows(), 10, "all ten are known");
}

#[test]
fn a_renamed_window_renames_its_pane_sessions() {
    let (mut rig, pane) = attached();
    rig.feed(b"%window-renamed @0 build\r\n");
    rig.work();
    assert_eq!(pane.live_metadata().name.as_deref(), Some("build"));
}

#[test]
fn a_layout_change_sizes_the_pane_session_and_adds_a_new_pane() {
    let (mut rig, pane) = attached();
    let mut handle = rig.registry.attach(&pane.id, None).unwrap();
    // Two panes side by side: %0 at 40 wide, %1 at 39.
    let body = "80x24,0,0{40x24,0,0,0,39x24,41,0,1}";
    let layout = format!("{:04x},{body}", chan_tmux::layout::checksum(body));
    rig.feed(format!("%layout-change @0 {layout} {layout} *\r\n").as_bytes());
    let mut resized = None;
    while let Ok(event) = handle.rx.try_recv() {
        if let SessionEvent::Resize(size) = event {
            resized = Some(size);
        }
    }
    assert_eq!(resized.map(|s| (s.cols, s.rows)), Some((40, 24)));
    rig.work();
    let second = rig.pane(1);
    assert_eq!(second.winsize.lock().unwrap().cols, 39);
}

/// A recording window hook: mints `w-<n>` ids, and keeps every call.
struct RecordingHook {
    calls: Arc<Mutex<Vec<String>>>,
}

impl RecordingHook {
    fn install(registry: &Registry) -> Arc<Mutex<Vec<String>>> {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let minted = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let hook = RecordingHook {
            calls: calls.clone(),
        };
        let mint_calls = hook.calls.clone();
        let remove_calls = hook.calls.clone();
        let attach_calls = hook.calls.clone();
        let release_calls = hook.calls.clone();
        let layout_calls = hook.calls.clone();
        registry.install_tmux_windows(TmuxWindowHook {
            mint: Arc::new(move |title: &str| {
                let n = minted.fetch_add(1, Ordering::Relaxed) + 1;
                mint_calls
                    .lock()
                    .unwrap()
                    .push(format!("mint {title} -> w-{n}"));
                Some(format!("w-{n}"))
            }),
            remove: Arc::new(move |id: &str| {
                remove_calls.lock().unwrap().push(format!("remove {id}"));
            }),
            attach: Arc::new(move |window: &str, session: &str| {
                attach_calls
                    .lock()
                    .unwrap()
                    .push(format!("attach {window} {session}"));
            }),
            release: Arc::new(move |window: &str, session: &str, to: &str| {
                release_calls
                    .lock()
                    .unwrap()
                    .push(format!("release {window} {session} -> {to}"));
            }),
            layout: Arc::new(move |window: &str, layout: &serde_json::Value| {
                layout_calls
                    .lock()
                    .unwrap()
                    .push(format!("layout {window} {layout}"));
            }),
        });
        calls
    }
}

fn calls(calls: &Arc<Mutex<Vec<String>>>) -> Vec<String> {
    std::mem::take(&mut *calls.lock().unwrap())
}

#[test]
fn connecting_gives_the_control_session_a_window_and_moves_it_there() {
    let registry = Registry::new(test_config(1 << 16, 4, 10));
    let hook = RecordingHook::install(&registry);
    let (control, _commands) = test_session_with_commands(1 << 16);
    register_session(&registry, &control);
    control.set_window_id(Some("w-source".into()));
    *control
        .tmux_foreground
        .lock()
        .expect("terminal tmux foreground poisoned") = Some(Foreground {
        name: Some("tmux".into()),
        command: Some("tmux -CC".into()),
    });
    control.record_output(&[MARKER, ENTRY].concat());
    control.record_output(VERSION_REPLY);
    registry.perform_tmux_work(&control);
    assert_eq!(
        calls(&hook),
        vec![
            "mint tmux main -> w-1".to_owned(),
            format!("attach w-1 {}", control.id),
            format!("release w-source {} -> w-1", control.id),
        ],
        "the control window is minted, the tab parked for it, the source told"
    );
    assert_eq!(
        control.window_id().as_deref(),
        Some("w-1"),
        "the session now belongs to its control window"
    );
    // The connection ends and a second run in the same terminal re-enters:
    // the session still sits in its control window, so nothing is minted.
    control.record_output(b"%exit\r\n\x1b\\");
    registry.perform_tmux_work(&control);
    calls(&hook);
    control.record_output(&[MARKER, ENTRY].concat());
    control.record_output(VERSION_REPLY);
    registry.perform_tmux_work(&control);
    assert!(
        calls(&hook).is_empty(),
        "a second connection in the control window mints nothing"
    );
}

#[test]
fn a_pane_session_reaches_its_minted_window_through_the_layout() {
    let mut rig = Rig::connected();
    let hook = RecordingHook::install(&rig.registry);
    rig.feed(ONE_WINDOW);
    rig.work();
    let pane = rig.pane(0);
    let panes_reply = rig.reply(&[b"%0 1"]);
    rig.feed(&panes_reply);
    rig.work();
    let recorded = calls(&hook);
    assert!(
        recorded.iter().any(|c| c == "mint shell -> w-1"),
        "the window is minted for the tmux window: {recorded:?}"
    );
    assert!(
        recorded
            .iter()
            .any(|c| c.starts_with("layout w-1 ") && c.contains(&pane.id)),
        "the window's layout names the pane's session: {recorded:?}"
    );
    assert!(
        !recorded.iter().any(|c| c.starts_with("attach ")),
        "a tmux window's tabs come with its layout: {recorded:?}"
    );
    assert_eq!(pane.window_id().as_deref(), Some("w-1"));
}

/// The rig after the attach with a recording hook installed before the
/// window was minted, every reply answered and every write and call drained.
fn attached_with_hook() -> (Rig, Arc<Session>, Arc<Mutex<Vec<String>>>) {
    let mut rig = Rig::connected();
    let hook = RecordingHook::install(&rig.registry);
    rig.feed(ONE_WINDOW);
    rig.work();
    let pane = rig.pane(0);
    let panes_reply = rig.reply(&[b"%0 1"]);
    rig.feed(&panes_reply);
    let capture = rig.capture(0, 0, 24, &[b"$ "]);
    rig.feed(&capture);
    rig.work();
    rig.inputs();
    let recorded = calls(&hook);
    assert!(
        recorded
            .iter()
            .any(|c| c.starts_with("layout w-1 ") && c.contains(&pane.id)),
        "the pane's tab comes with the window's layout: {recorded:?}"
    );
    (rig, pane, hook)
}

#[test]
fn a_requested_window_gets_a_chan_window_of_its_own_and_its_list() {
    let (mut rig, pane, hook) = attached_with_hook();
    // A pane session's request reaches the control session through the
    // registry: Cmd+T or New Window in the window that holds the pane.
    let reached = rig
        .registry
        .tmux_request_for(&pane.tmux_pane.expect("a pane"), TmuxRequest::NewWindow);
    assert!(reached);
    assert_eq!(
        rig.inputs(),
        vec![b"new-window -PF '#{window_id}'\n".to_vec()]
    );
    let new_window_reply = rig.reply(&[b"@1"]);
    rig.feed(&new_window_reply);
    rig.feed(b"%window-add @1\r\n");
    rig.work();
    let after_add = rig.inputs();
    assert_eq!(after_add.len(), 2, "{after_add:?}");
    assert!(after_add[0].starts_with(b"list-panes -t @1 "));
    assert!(
        after_add[1].starts_with(b"list-windows -F "),
        "a window a notification added is listed for its name and layout"
    );
    assert_eq!(
        calls(&hook),
        vec!["mint tmux @1 -> w-2"],
        "a requested window gets a chan window of its own"
    );
    let panes_reply = rig.reply(&[b"%5 1"]);
    rig.feed(&panes_reply);
    rig.work();
    rig.work();
    assert_eq!(rig.pane(5).window_id().as_deref(), Some("w-2"));
    // An unknown connection reaches nothing.
    assert!(!rig.registry.tmux_request_for(
        &TmuxPaneRef {
            connection: TmuxConnectionId(999),
            pane: chan_tmux::PaneId(0),
        },
        TmuxRequest::Detach,
    ));
}

#[test]
fn a_refused_new_window_frees_the_next_added_window_for_the_cap_rule() {
    let (mut rig, pane, hook) = attached_with_hook();
    rig.registry
        .tmux_request_for(&pane.tmux_pane.expect("a pane"), TmuxRequest::NewWindow);
    rig.inputs();
    let refused = {
        rig.number += 1;
        let header = format!("2 {} 1", rig.number);
        format!("%begin {header}\r\nno more windows\r\n%error {header}\r\n").into_bytes()
    };
    rig.feed(&refused);
    // A window another client adds now is nobody's request: it is minted
    // under the cap rule, which it is within here.
    rig.feed(b"%window-add @3\r\n");
    rig.work();
    assert_eq!(calls(&hook), vec!["mint tmux @3 -> w-2"]);
}

/// tmux's layout checksum, for the layouts these tests write.
fn layout_with_checksum(body: &str) -> String {
    let mut csum: u16 = 0;
    for b in body.bytes() {
        csum = (csum >> 1).wrapping_add((csum & 1) << 15);
        csum = csum.wrapping_add(u16::from(b));
    }
    format!("{csum:04x},{body}")
}

#[test]
fn a_split_window_reaches_its_chan_window_as_a_tree_with_each_pane_session() {
    let mut rig = Rig::connected();
    let hook = RecordingHook::install(&rig.registry);
    let layout = layout_with_checksum("160x24,0,0{80x24,0,0,0,79x24,81,0,1}");
    let row = format!("@0 {layout} {layout} * shell");
    let list = rig.reply(&[row.as_bytes()]);
    rig.feed(&list);
    rig.work();
    rig.work();
    let recorded = calls(&hook);
    let layouts: Vec<&String> = recorded
        .iter()
        .filter(|c| c.starts_with("layout w-1 "))
        .collect();
    assert!(!layouts.is_empty(), "{recorded:?}");
    let last: serde_json::Value =
        serde_json::from_str(layouts.last().unwrap().trim_start_matches("layout w-1 ")).unwrap();
    assert_eq!(last["kind"], "row");
    assert_eq!(last["w"], 160);
    let children = last["children"].as_array().expect("two children");
    assert_eq!(children.len(), 2);
    assert_eq!(children[0]["w"], 80);
    assert_eq!(children[1]["w"], 79);
    assert_eq!(children[0]["session"], rig.pane(0).id.as_str());
    assert_eq!(children[1]["session"], rig.pane(1).id.as_str());
    assert!(
        !recorded.iter().any(|c| c.starts_with("attach ")),
        "a tmux window's tabs come with its layout, not one by one: {recorded:?}"
    );
    // A pane's resize in a split window leaves tmux's window size alone; in
    // a single-pane window it still sets it.
    rig.inputs();
    rig.pane(0).command_tx.send(PtyCommand::Resize(PtySize {
        cols: 50,
        rows: 10,
        pixel_width: 0,
        pixel_height: 0,
    }));
    std::thread::sleep(Duration::from_millis(300));
    assert!(
        rig.inputs()
            .iter()
            .all(|w| !w.starts_with(b"refresh-client -C")),
        "a split window's pane resize reached tmux"
    );
    // The pane goes: the tree shrinks to one pane and the resize rule flips.
    rig.feed(b"%layout-change @0 ");
    let one = layout_with_checksum("160x24,0,0,0");
    rig.feed(format!("{one} {one} *\r\n").as_bytes());
    rig.work();
    rig.work();
    let recorded = calls(&hook);
    let last = recorded
        .iter()
        .rev()
        .find(|c| c.starts_with("layout w-1 "))
        .cloned()
        .expect("a layout after the pane went");
    let tree: serde_json::Value =
        serde_json::from_str(last.trim_start_matches("layout w-1 ")).unwrap();
    assert_eq!(tree["kind"], "pane");
    assert_eq!(tree["session"], rig.pane(0).id.as_str());
    rig.inputs();
    rig.pane(0).command_tx.send(PtyCommand::Resize(PtySize {
        cols: 50,
        rows: 10,
        pixel_width: 0,
        pixel_height: 0,
    }));
    let resize = rig.wait_input(|w| w.starts_with(b"refresh-client -C"));
    assert_eq!(resize, b"refresh-client -C @0:50x10\n".to_vec());
}

#[test]
fn split_and_focus_requests_reach_tmux_for_a_shown_pane_alone() {
    let (rig, pane, _hook) = attached_with_hook();
    let pane_ref = pane.tmux_pane.expect("a pane");
    assert!(rig.registry.tmux_request_for(
        &pane_ref,
        TmuxRequest::Split {
            pane: "%0".into(),
            horizontal: true,
        },
    ));
    assert_eq!(
        rig.inputs(),
        vec![b"split-window -h -t %0 -PF '#{pane_id}'\n".to_vec()]
    );
    rig.registry
        .tmux_request_for(&pane_ref, TmuxRequest::Focus { pane: "%0".into() });
    assert_eq!(rig.inputs(), vec![b"select-pane -t %0\n".to_vec()]);
    // A pane tmux has not shown here, or a bad id, asks nothing.
    rig.registry.tmux_request_for(
        &pane_ref,
        TmuxRequest::Split {
            pane: "%9".into(),
            horizontal: false,
        },
    );
    rig.registry.tmux_request_for(
        &pane_ref,
        TmuxRequest::Focus {
            pane: "nine".into(),
        },
    );
    assert!(rig.inputs().is_empty());
}

#[test]
fn the_exit_removes_every_minted_window_through_the_hook() {
    let (mut rig, _pane, hook) = attached_with_hook();
    rig.feed(b"%exit\r\n\x1b\\");
    rig.work();
    let recorded = calls(&hook);
    assert!(
        recorded.iter().any(|c| c == "remove w-1"),
        "the tmux window's chan window goes with the connection: {recorded:?}"
    );
}

#[test]
fn a_control_session_closed_right_after_the_exit_still_removes_its_windows() {
    let (mut rig, _pane, hook) = attached_with_hook();
    // The exit's work waits for the drainer; the registry closes the control
    // session first, as the reaper does when the shell was the tmux client.
    rig.feed(b"%exit\r\n\x1b\\");
    assert!(rig.registry.close(&rig.control.id, CloseReason::Explicit));
    let recorded = calls(&hook);
    assert!(
        recorded.iter().any(|c| c == "remove w-1"),
        "the close performs the exit's work: {recorded:?}"
    );
}

#[test]
fn the_control_process_ending_removes_the_windows_on_the_next_drain() {
    let (rig, _pane, hook) = attached_with_hook();
    // The shell was the tmux client: tmux detaches, the client exits, the
    // PTY ends; the connection ends with the process.
    rig.control
        .record_exit(TerminalExit::Code { code: 0 }, None);
    rig.work();
    let recorded = calls(&hook);
    assert!(
        recorded.iter().any(|c| c == "remove w-1"),
        "the process's end removes the window: {recorded:?}"
    );
}

#[test]
fn a_control_process_exit_that_removes_the_session_still_removes_its_windows() {
    let (mut rig, _pane, hook) = attached_with_hook();
    // tmux prints its exit and the client process ends right after: the
    // controller removes the session before the drainer's next pass.
    rig.feed(b"%exit\r\n\x1b\\");
    assert!(rig
        .registry
        .remove_session(&rig.control.id, &rig.control, true));
    let recorded = calls(&hook);
    assert!(
        recorded.iter().any(|c| c == "remove w-1"),
        "the removal performs the exit's work: {recorded:?}"
    );
}
