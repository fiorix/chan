use super::super::tests::test_session_with_ring;
#[cfg(unix)]
use super::super::tests::{opts_with_command, test_config};
use super::super::*;

#[test]
fn reader_caps_native_reads_at_the_holding_views_half_ring() {
    reader_caps_reads_at_the_holding_views_half_ring(false);
}

#[test]
fn reader_caps_imported_reads_at_the_holding_views_half_ring() {
    reader_caps_reads_at_the_holding_views_half_ring(true);
}

fn reader_caps_reads_at_the_holding_views_half_ring(imported: bool) {
    struct Probe {
        sizes: Vec<usize>,
    }
    impl Read for Probe {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            self.sizes.push(buf.len());
            if self.sizes.len() == 1 {
                buf[0] = b'x';
                Ok(1)
            } else {
                Ok(0)
            }
        }
    }
    {
        let session = test_session_with_ring(1024);
        let _attached = session
            .clone()
            .attach(None)
            .with_output_progress(OutputFlow::Acknowledged);
        let mut probe = Probe { sizes: Vec::new() };
        let running = ReaderRunning::start(&session);
        session.read_output(&mut probe, running, imported, &Arc::new(Mutex::new(None)));
        assert_eq!(
            probe.sizes[0], 512,
            "real reader must cap its read at half-ring credit (imported={imported})"
        );
    }
}

#[test]
fn progress_recaptures_original_resume_and_counts_only_sent_raw_bytes() {
    let session = test_session_with_ring(1024);
    session.record_output(b"abcd");
    let attached = session.clone().attach(Some(2));
    session.record_output(b"ef");
    let attached = attached.with_output_progress(OutputFlow::Acknowledged);
    assert_eq!(attached.replay.concat(), b"cdef");
    let progress = attached.output_progress().expect("WebSocket lease");
    assert_eq!(progress.seq(), 2, "snapshot end is not the sent cursor");
    progress.sent_output(2);
    assert_eq!(progress.seq(), 4);
    let recovered = attached.replay_from(progress.seq());
    assert_eq!(recovered.replay.concat(), b"ef");
    assert_eq!(recovered.seq, 6);
    assert_eq!(recovered.generation, attached.generation);
}

#[cfg(target_os = "linux")]
#[test]
fn imported_progress_keeps_the_restored_nonzero_output_coordinates() {
    #[derive(Clone, Default)]
    struct StoredFds(Arc<Mutex<HashMap<String, OwnedFd>>>);

    impl FdStorePark for StoredFds {
        fn park(&self, fds: &[(&str, std::os::fd::BorrowedFd<'_>)]) -> bool {
            let mut stored = self.0.lock().expect("stored fds");
            for (name, fd) in fds {
                stored.insert(
                    (*name).to_owned(),
                    fd.try_clone_to_owned().expect("duplicate parked fd"),
                );
            }
            true
        }

        fn unpark(&self, names: &[&str]) {
            let mut stored = self.0.lock().expect("stored fds");
            for name in names {
                stored.remove(*name);
            }
        }

        fn adopt(&self, _name: &str) -> bool {
            true
        }

        fn changed(&self) {}
    }

    let stored = StoredFds::default();
    let mut source = test_session_with_ring(1024);
    let size = *source.winsize.lock().expect("size");
    let pair = native_pty_system().openpty(size).expect("owned PTY");
    let source_state = Arc::get_mut(&mut source).expect("one owner");
    source_state.id = "pacing-imported-origin".into();
    source_state.master_fd = Some(
        clone_master_fd(pair.master.as_raw_fd().expect("master fd")).expect("duplicate master fd"),
    );
    source_state.window_id = Mutex::new(Some("pacing-imported-window".into()));
    let history = b"history before the server restart\r\n";
    source.record_output(history);
    source.park_fdstore(
        &FdStoreParker::new(stored.clone()),
        ManifestCommit::Deferred,
    );
    let entry = source
        .fdstore_manifest_entry("pacing")
        .expect("parked manifest");
    assert_eq!(entry.meta.seq, history.len() as u64);
    let import = {
        let mut fds = stored.0.lock().expect("stored fds");
        FdStoreSessionImport {
            child_identity: RecordedChildIdentity::default(),
            master_fd: fds.remove(&entry.fd_name).expect("parked PTY"),
            ring_fd: Some(
                fds.remove(entry.ring_fd_name.as_ref().expect("parked ring name"))
                    .expect("parked ring"),
            ),
            meta: entry.meta,
            replay: entry.replay,
            sealed_manifest: false,
        }
    };
    source.detach_for_fdstore_restart();
    drop(source);

    let root = tempfile::tempdir().expect("workspace root");
    let registry = Registry::new(RegistryConfig {
        workspace_root: root.path().to_owned(),
        mcp_socket_path: None,
        control_socket: ControlSocketEnv::None,
        terminal: TerminalConfig {
            ring_bytes: 1024,
            ..TerminalConfig::default()
        },
    });
    let report = registry.restore_fdstore_sessions(vec![import]);
    assert_eq!(report.restored, 1, "{:?}", report.skipped);
    let attached = registry
        .attach("pacing-imported-origin", Some(7))
        .expect("restored session")
        .with_output_progress(OutputFlow::Acknowledged);
    let progress = attached.output_progress().expect("WebSocket lease");
    let initial_cursor = progress.seq();
    progress.sent_output(5);
    let partial_cursor = progress.seq();
    let recovered = attached.replay_from(partial_cursor);
    let resumed = recovered.output_progress().expect("recovery lease");
    resumed.sent_output(recovered.replay.iter().map(Vec::len).sum());
    let replay_cursor = resumed.seq();
    recovered.session.record_output(b"live after import\r\n");
    resumed.sent_output(b"live after import\r\n".len());
    let live_cursor = resumed.seq();

    // The slave stays open so no incidental EOF can bypass reader pacing.
    // Stop the process-free imported reader explicitly before assertions.
    recovered.session.request_reader_stop();
    recovered.session.reader_wake.wake();
    let reader_stopped = recovered
        .session
        .reader_stop
        .wait(std::time::Instant::now() + Duration::from_secs(2));
    registry.close("pacing-imported-origin", CloseReason::Explicit);
    let controller_stopped = recovered.session.ended.wait(Duration::from_secs(2));
    drop(pair);

    assert!(reader_stopped, "imported reader stopped");
    assert!(controller_stopped.is_some(), "imported controller stopped");
    assert_eq!(attached.seq, history.len() as u64);
    assert_eq!(attached.replay.concat(), history[7..]);
    assert_eq!(
        initial_cursor, 7,
        "resume starts at the absolute raw cursor"
    );
    assert_eq!(
        partial_cursor, 12,
        "sent replay advances within restored coordinates"
    );
    assert_eq!(recovered.replay.concat(), history[12..]);
    assert_eq!(recovered.missed_bytes, 0);
    assert_eq!(recovered.generation, attached.generation);
    assert_eq!(replay_cursor, history.len() as u64);
    assert_eq!(
        live_cursor,
        (history.len() + b"live after import\r\n".len()) as u64
    );
}

#[test]
fn live_replay_keeps_alt_screen_deltas_and_exact_missed_count() {
    let session = test_session_with_ring(64);
    let attached = session
        .clone()
        .attach(None)
        .with_output_progress(OutputFlow::Acknowledged);
    session.record_output(b"\x1b[?1049hALT");
    assert!(
        session.clone().attach(None).replay.is_empty(),
        "fresh alt-screen attach still asks for redraw"
    );
    let enter = attached.replay_from(0);
    assert_eq!(
        enter.replay.concat(),
        b"\x1b[?1049hALT",
        "same-view recovery preserves entering alternate screen"
    );
    assert_eq!(enter.missed_bytes, 0);
    session.record_output(b"\x1b[?1049lNORMAL");
    let leave = enter.replay_from(enter.seq);
    assert_eq!(
        leave.replay.concat(),
        b"\x1b[?1049lNORMAL",
        "same-view recovery preserves leaving alternate screen"
    );
    session.record_output(&[b'x'; 80]);
    session.record_output(b"\x1b[?1049h");
    let lost = attached.replay_from(0);
    let retained = lost.replay.iter().map(Vec::len).sum::<usize>();
    assert!(lost.alt_screen);
    assert!(
        retained > 0,
        "live alt-screen recovery includes retained bytes"
    );
    assert_eq!(
        lost.missed_bytes + retained as u64,
        lost.seq,
        "missed count plus tail covers the requested raw sequence"
    );
}

#[test]
fn progress_upgrade_and_same_session_replay_transfer_focus_ownership() {
    let session = test_session_with_ring(1024);
    let attached = session.clone().attach(None);
    let epoch = attached.set_focused(true).expect("focus epoch");
    let attached = attached.with_output_progress(OutputFlow::Acknowledged);
    assert_eq!(attached.focus_epoch.load(Ordering::Relaxed), epoch);
    assert_eq!(
        session.focus_epoch.load(Ordering::Relaxed),
        epoch,
        "upgrade cannot withdraw focus"
    );
    let recovered = attached.replay_from(0);
    drop(attached);
    assert_eq!(recovered.focus_epoch.load(Ordering::Relaxed), epoch);
    assert_eq!(
        session.focus_epoch.load(Ordering::Relaxed),
        epoch,
        "old handle drop cannot withdraw transferred focus"
    );
    drop(recovered);
    assert_eq!(session.focus_epoch.load(Ordering::Relaxed), 0);
}

#[test]
fn retained_lifecycle_survives_broadcast_eviction_and_registry_independence() {
    for event in [
        SessionEvent::Exit(TerminalExit::Code { code: 7 }),
        SessionEvent::Closed(CloseReason::Explicit),
        SessionEvent::Restarted,
    ] {
        let session = test_session_with_ring(1024);
        let mut attached = session
            .clone()
            .attach(None)
            .with_output_progress(OutputFlow::Acknowledged);
        session.record_output(b"tail");
        session.broadcast(event.clone());
        for _ in 0..BROADCAST_CAP + 1 {
            session.broadcast(SessionEvent::Activity {
                bytes_since_focus: 0,
            });
        }
        assert!(matches!(
            attached.rx.try_recv(),
            Err(broadcast::error::TryRecvError::Lagged(_))
        ));
        let expected = match event {
            SessionEvent::Exit(exit) => SessionLifecycle::Exit(exit),
            SessionEvent::Closed(reason) => SessionLifecycle::Closed(reason),
            SessionEvent::Restarted => SessionLifecycle::Restarted,
            _ => unreachable!(),
        };
        assert_eq!(
            *attached.lifecycle_rx.borrow(),
            Some(expected),
            "terminal control is retained independently of output events"
        );
        let recovered = attached.replay_from(0);
        assert_eq!(
            recovered.replay.concat(),
            b"tail",
            "recovery uses the held incarnation without a registry lookup"
        );
    }
}

#[test]
fn paced_reader_keeps_input_admission_live_and_exit_drain_unpaced() {
    use super::super::tests::test_session_with_commands;
    let (mut session, commands) = test_session_with_commands(1024);
    Arc::get_mut(&mut session).expect("one owner").id = "pacing-input-exit".into();
    let attached = session
        .clone()
        .attach(None)
        .with_output_progress(OutputFlow::Acknowledged);
    let (waiting_tx, waiting_rx) = std::sync::mpsc::channel();
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    arm_attach_seam(
        &session.id,
        AttachSeam::ReaderWaitingForProgress,
        move || {
            waiting_tx.send(()).expect("reader waiting");
        },
    );
    let worker = {
        let session = session.clone();
        std::thread::spawn(move || {
            struct Reader {
                calls: usize,
                sizes: Vec<usize>,
            }
            impl Read for Reader {
                fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                    self.calls += 1;
                    self.sizes.push(buf.len());
                    if self.calls == 1 {
                        buf.fill(b'x');
                        Ok(buf.len())
                    } else {
                        Ok(0)
                    }
                }
            }
            let mut reader = Reader {
                calls: 0,
                sizes: Vec::new(),
            };
            let running = ReaderRunning::start(&session);
            session.read_output(&mut reader, running, false, &Arc::new(Mutex::new(None)));
            done_tx.send(()).expect("reader finished");
            reader.sizes
        })
    };
    let waiting = waiting_rx.recv_timeout(Duration::from_secs(2));
    attached.send_input(b"input stays live");
    let input = commands.recv_timeout(Duration::from_secs(2));
    session.record_exit(TerminalExit::Code { code: 0 }, None);
    let finished = done_rx.recv_timeout(Duration::from_secs(2));
    // Release a broken exit wake before joining and reporting its failure.
    session.pacing.bypass();
    let sizes = worker.join().expect("reader thread");
    finished.expect("exit wakes the paced reader within its bounded drain");
    waiting.expect("reader reached holding view wait");
    assert!(
        matches!(input, Ok(PtyCommand::Input(bytes)) if bytes == b"input stays live"),
        "paced output does not hold the input command path"
    );
    assert_eq!(
        sizes,
        vec![512, PTY_READ_BYTES],
        "exit drain releases the reader without pacing its final read"
    );
    assert_eq!(
        *attached.lifecycle_rx.borrow(),
        Some(SessionLifecycle::Exit(TerminalExit::Code { code: 0 }))
    );
}

#[cfg(target_os = "linux")]
#[test]
fn reader_stop_wakes_a_pacing_wait_before_sealing_the_ring() {
    let mut session = test_session_with_ring(1024);
    Arc::get_mut(&mut session).expect("one owner").id = "pacing-reader-stop".into();
    let _attached = session
        .clone()
        .attach(None)
        .with_output_progress(OutputFlow::Acknowledged);
    session.record_output(&[b'x'; 512]);
    let (waiting_tx, waiting_rx) = std::sync::mpsc::channel();
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let worker = {
        let session = session.clone();
        std::thread::spawn(move || {
            let credit = session.pacing.credit(PTY_READ_BYTES, || {
                let _ = waiting_tx.send(());
            });
            done_tx.send(credit).expect("credit result");
        })
    };
    waiting_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("reader waiting");
    session.request_reader_stop();
    let result = done_rx.recv_timeout(Duration::from_secs(2));
    session.pacing.bypass();
    worker.join().expect("credit worker");
    assert!(session.reader_stop.requested());
    assert_eq!(result.expect("stop wakes pacing wait"), PTY_READ_BYTES);
}

#[test]
fn tmux_control_protocol_reads_bypass_a_slow_control_view() {
    let session = test_session_with_ring(1024);
    *session.tmux_foreground.lock().expect("tmux foreground") = Some(tmux_gate::Foreground {
        name: Some("tmux".into()),
        command: Some("tmux -CC".into()),
    });
    session.record_output(b"\x1bP1000p%begin 1 1 0\r\n%end 1 1 0\r\n");
    assert!(session.tmux.lock().expect("tmux gate").in_control_mode());
    let attached = session
        .clone()
        .attach(None)
        .with_output_progress(OutputFlow::Acknowledged);
    let progress = attached.output_progress().expect("lease");
    session.record_plain_output(&[b'x'; 512]);
    struct EmptyProbe(usize);
    impl Read for EmptyProbe {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            self.0 = buf.len();
            Ok(0)
        }
    }
    let mut reader = EmptyProbe(0);
    let running = ReaderRunning::start(&session);
    session.read_output(&mut reader, running, false, &Arc::new(Mutex::new(None)));
    assert!(
        !progress.needs_replay(),
        "control protocol bypass does not wait for lease expiry"
    );
    assert_eq!(
        reader.0, PTY_READ_BYTES,
        "a pane's control protocol cannot wait for the control view"
    );
}

#[tokio::test]
async fn paced_reader_delivers_over_a_broadcast_capacity_of_reads_exactly_once() {
    let mut session = test_session_with_ring(128);
    Arc::get_mut(&mut session).expect("one owner").id = "pacing-many-reads".into();
    let mut attached = session
        .clone()
        .attach(None)
        .with_output_progress(OutputFlow::Acknowledged);
    let progress = attached.output_progress().expect("lease");
    let expected: Vec<u8> = (0..1200)
        .flat_map(|line| format!("{line:06}\n").into_bytes())
        .collect();
    let (waiting_tx, waiting_rx) = std::sync::mpsc::channel();
    arm_attach_seam(
        &session.id,
        AttachSeam::ReaderWaitingForProgress,
        move || {
            waiting_tx.send(()).expect("producer reached credit wait");
        },
    );
    let worker = {
        let session = session.clone();
        let bytes = expected.clone();
        std::thread::spawn(move || {
            struct Chunks {
                input: std::io::Cursor<Vec<u8>>,
                reads: usize,
            }
            impl Read for Chunks {
                fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                    self.reads += 1;
                    let limit = buf.len().min(7);
                    self.input.read(&mut buf[..limit])
                }
            }
            let mut reader = Chunks {
                input: std::io::Cursor::new(bytes),
                reads: 0,
            };
            let running = ReaderRunning::start(&session);
            session.read_output(&mut reader, running, false, &Arc::new(Mutex::new(None)));
            reader.reads
        })
    };
    // Admit no output until the small ring has made the real reader wait.
    let waiting = waiting_rx.recv_timeout(Duration::from_secs(2));
    let mut rendered = Vec::new();
    let result = tokio::time::timeout(Duration::from_secs(10), async {
        while rendered.len() < expected.len() {
            match attached.rx.recv().await {
                Ok(SessionEvent::Output(bytes)) => {
                    // Sending this chunk completes before its raw cursor and
                    // consumed-event credit move, and the client parses it
                    // before acknowledging. No synthetic bytes count.
                    rendered.extend_from_slice(&bytes);
                    progress.sent_output(bytes.len());
                    progress.sent_event();
                    progress.acknowledge(progress.seq());
                }
                Ok(_) => progress.sent_event(),
                Err(error) => return Err(error),
            }
        }
        Ok(())
    })
    .await;
    let sent_seq = progress.seq();
    let cut_loose = progress.needs_replay();
    // Cleanup also releases the producer if a broken admission rule lost events.
    session.pacing.bypass();
    drop(progress);
    drop(attached);
    let reads = worker.join().expect("producer thread");
    waiting.expect("producer must reach credit wait before sends begin");
    result
        .expect("bounded output delivery")
        .expect("no broadcast lag for a progressing view");
    assert!(
        reads > BROADCAST_CAP,
        "fixture exceeds one broadcast buffer of reads"
    );
    assert!(!cut_loose, "each acknowledgement keeps the view holding");
    assert_eq!(
        rendered, expected,
        "paced reader delivers every byte exactly once"
    );
    assert_eq!(
        sent_seq,
        expected.len() as u64,
        "sent cursor equals the raw byte stream"
    );
}

fn assert_lifecycle_transition_wakes_credit(transition: fn(&Session), expected: SessionLifecycle) {
    let session = test_session_with_ring(1024);
    let attached = session
        .clone()
        .attach(None)
        .with_output_progress(OutputFlow::Acknowledged);
    session.record_output(&[b'x'; 512]);
    let (waiting_tx, waiting_rx) = std::sync::mpsc::channel();
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let worker = {
        let session = session.clone();
        std::thread::spawn(move || {
            let credit = session.pacing.credit(PTY_READ_BYTES, || {
                let _ = waiting_tx.send(());
            });
            done_tx.send(credit).expect("credit result");
        })
    };
    let waiting = waiting_rx.recv_timeout(Duration::from_secs(2));
    transition(&session);
    let result = done_rx.recv_timeout(Duration::from_secs(2));
    let observed = attached.lifecycle_rx.borrow().clone();
    // Release a broken transition before joining or asserting its result.
    session.pacing.bypass();
    drop(attached);
    worker.join().expect("credit worker");

    waiting.expect("reader reached the credit wait before the transition");
    assert_eq!(
        result.expect("lifecycle transition releases reader credit"),
        PTY_READ_BYTES,
        "a terminal transition must not wait for a view's five-second expiry"
    );
    assert_eq!(observed, Some(expected));
}

#[test]
fn close_wakes_a_pacing_wait() {
    assert_lifecycle_transition_wakes_credit(
        |session| session.close(CloseReason::Explicit),
        SessionLifecycle::Closed(CloseReason::Explicit),
    );
}

#[test]
fn restart_wakes_a_pacing_wait() {
    assert_lifecycle_transition_wakes_credit(
        Session::close_for_restart,
        SessionLifecycle::Restarted,
    );
}

#[cfg(target_os = "linux")]
#[test]
fn fdstore_detach_wakes_a_pacing_wait() {
    assert_lifecycle_transition_wakes_credit(
        Session::detach_for_fdstore_restart,
        SessionLifecycle::Closed(CloseReason::Parked),
    );
}

/// How a test ends the hold a view has on a real program.
#[cfg(unix)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HoldEnd {
    ViewGone,
    Bound,
    Exit,
}

/// A message queued while a view holds a real program mid-output is not
/// delivered during the hold, and is delivered one quiet period after it.
#[cfg(unix)]
fn queued_message_waits_out_a_hold(end: HoldEnd, awaiting_generation: bool) {
    const RING: usize = 64 * 1024;
    let registry = Registry::new(test_config(RING, 8, 60));
    // Visible text up to just short of the window, then whitespace, so the
    // bytes read after the hold cannot move the visible-output clock.
    let visible = RING / 2 - 256;
    let script = format!(
        "read _; head -c {visible} /dev/zero | tr '\\0' x; \
         head -c {RING} /dev/zero | tr '\\0' ' '; exec sleep 60"
    );
    let handle = registry
        .create(opts_with_command(&script))
        .expect("spawn the writer");
    let session = handle.session.clone();
    let attached = session
        .clone()
        .attach(None)
        .with_output_progress(OutputFlow::Acknowledged);
    drop(handle);
    let progress = attached.output_progress().expect("lease");
    let (waiting_tx, waiting_rx) = std::sync::mpsc::channel();
    arm_attach_seam(
        &session.id,
        AttachSeam::ReaderWaitingForProgress,
        move || {
            let _ = waiting_tx.send(());
        },
    );
    attached.send_input(b"\n");
    waiting_rx
        .recv_timeout(Duration::from_secs(10))
        .expect("the program fills the window and the reader waits");

    let queued = |session: &Session| session.write_queue.lock().expect("queue").len();
    session
        .enqueue_cs_write("queued while held".into(), None)
        .expect("queued");
    if awaiting_generation {
        let long_ago = now_unix_millis() - 2 * WRITE_QUEUE_GEN_START_CAP_MS;
        session.last_deliver_at.store(long_ago, Ordering::Relaxed);
        session.awaiting_gen.store(true, Ordering::Relaxed);
    }
    // Past every quiet period and generation cap the clocks can name.
    session.try_drain_batch(now_unix_millis() + 10 * WRITE_QUEUE_GEN_START_CAP_MS);
    assert_eq!(
        queued(&session),
        1,
        "a program blocked on the PTY is mid-output, not idle"
    );

    // The hold outlasts a quiet period, so a clock that kept running through
    // it would deliver the moment the hold ends.
    let ended = match end {
        HoldEnd::ViewGone => {
            std::thread::sleep(Duration::from_millis((WRITE_QUEUE_QUIET_MS + 200) as u64));
            let ended = now_unix_millis();
            drop(progress);
            drop(attached);
            ended
        }
        HoldEnd::Exit => {
            std::thread::sleep(Duration::from_millis((WRITE_QUEUE_QUIET_MS + 200) as u64));
            let ended = now_unix_millis();
            session.command_tx.send(PtyCommand::Kill);
            drop(progress);
            drop(attached);
            ended
        }
        HoldEnd::Bound => {
            // The last reading that still saw the hold: the release came
            // after it, so the quiet period is measured from no later a time.
            let bound = std::time::Instant::now() + Duration::from_secs(20);
            let mut ended = now_unix_millis();
            loop {
                let sampled = now_unix_millis();
                if progress.needs_replay() {
                    break;
                }
                ended = sampled;
                assert!(
                    std::time::Instant::now() < bound,
                    "the five-second bound releases the view"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
            drop(progress);
            drop(attached);
            ended
        }
    };

    let bound = std::time::Instant::now() + Duration::from_secs(20);
    let delivered_at = loop {
        let now = now_unix_millis();
        session.try_drain_batch(now);
        if queued(&session) == 0 {
            break now;
        }
        assert!(
            std::time::Instant::now() < bound,
            "a queued message is never stuck behind a finished hold"
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    registry.close_all(CloseReason::Shutdown);
    assert!(
        delivered_at - ended >= WRITE_QUEUE_QUIET_MS,
        "delivered {} ms after the hold ended, inside the {WRITE_QUEUE_QUIET_MS} ms quiet period",
        delivered_at - ended
    );
}

#[cfg(unix)]
#[test]
fn a_queued_message_waits_out_a_hold_that_ends_when_the_view_goes_away() {
    queued_message_waits_out_a_hold(HoldEnd::ViewGone, false);
}

#[cfg(unix)]
#[test]
fn a_queued_message_waits_out_a_hold_released_at_the_bound() {
    queued_message_waits_out_a_hold(HoldEnd::Bound, false);
}

#[cfg(unix)]
#[test]
fn a_queued_message_waits_out_a_hold_that_ends_at_exit() {
    queued_message_waits_out_a_hold(HoldEnd::Exit, false);
}

#[cfg(unix)]
#[test]
fn the_generation_cap_does_not_expire_a_delivery_gate_during_a_hold() {
    queued_message_waits_out_a_hold(HoldEnd::ViewGone, true);
}
