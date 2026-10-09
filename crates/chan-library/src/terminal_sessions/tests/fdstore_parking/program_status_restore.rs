use super::*;

struct StatusRestart {
    store: StoreSim,
    registry: Arc<Registry>,
    session: Arc<Session>,
    _pair: portable_pty::PtyPair,
}

impl StatusRestart {
    fn new(id: &str) -> Self {
        let store = StoreSim::default();
        let registry = Arc::new(Registry::new(test_config(LIVE_RING_BYTES, 8, 600)));
        store.serve(&registry);
        let (session, pair) = parked_session_without_a_child(&registry, id);
        Self {
            store,
            registry,
            session,
            _pair: pair,
        }
    }

    fn report(&self, body: &str) {
        assert!(self
            .registry
            .inject_output(&self.session.id, format!("\x1b]7501;{body}\x07").as_bytes()));
    }

    fn snapshot(&self) -> Arc<ProgramStatusSnapshot> {
        self.session
            .output
            .lock()
            .unwrap()
            .status
            .published
            .borrow()
            .clone()
    }

    fn imports(&self) -> Vec<FdStoreSessionImport> {
        let entries = self.registry.seal_fdstore_manifest_sessions("t");
        self.registry.fdstore_manifest_committed("t", &entries);
        *self.store.0.published.lock().unwrap() = entries;
        assert_eq!(self.registry.detach_parked_sessions(), 1);
        let mut imports = self.store.imports();
        imports[0].sealed_manifest = true;
        imports
    }
}

impl Drop for StatusRestart {
    fn drop(&mut self) {
        self.registry.close_all(CloseReason::Shutdown);
    }
}

struct AdoptedStatus(Registry);

impl AdoptedStatus {
    fn new(imports: Vec<FdStoreSessionImport>) -> Self {
        let registry = Registry::new(test_config(LIVE_RING_BYTES, 8, 600));
        let result = registry.restore_fdstore_sessions(imports);
        assert_eq!(result.restored, 1, "{:?}", result.skipped);
        Self(registry)
    }

    fn session(&self, id: &str) -> Arc<Session> {
        self.0.sessions.lock().unwrap()[id].clone()
    }

    fn snapshot(&self, id: &str) -> Arc<ProgramStatusSnapshot> {
        self.0
            .attach(id, None)
            .unwrap()
            .initial_program_status
            .clone()
    }
}

impl Drop for AdoptedStatus {
    fn drop(&mut self) {
        self.0.close_all(CloseReason::Shutdown);
    }
}

#[test]
fn program_status_manifest_pins_records_counters_and_partial_bytes() {
    let rig = StatusRestart::new("status-manifest");
    rig.report("state=done:id=job:app=build:title=eA==:msg=eQ==");
    rig.session.set_focused(true);
    rig.session.record_output(b"\x1b]7501;state=");
    let meta = rig
        .registry
        .fdstore_manifest_sessions("t")
        .pop()
        .unwrap()
        .meta;
    let value = serde_json::to_value(&meta).unwrap();
    assert_eq!(
        value["program_status"],
        serde_json::json!({
            "revision": 2,
            "next_update_order": 1,
            "records": [{"id":"job", "state":"done", "kind":null, "progress":null,
                "app":"build", "title":"x", "msg":"y", "seen":true, "update_order":1}],
            "framing": {"state":"osc_body", "command":"program_status", "body": b"state="}
        }),
        "manifest must contain the exact program-only stored representation"
    );
    let decoded: FdStoreSessionMeta = serde_json::from_value(value).unwrap();
    assert_eq!(decoded, meta);
    assert_eq!(meta.seq, rig.session.output.lock().unwrap().ring.end_seq());
}

#[test]
fn program_status_sealed_restore_preserves_order_seen_and_reopens_admission() {
    let rig = StatusRestart::new("status-order");
    rig.report("state=done:id=a");
    rig.report("state=working:id=b:progress=0");
    rig.report("state=error:id=c:msg=eA==");
    rig.session.set_focused(true);
    rig.session.set_focused(false);
    rig.report("state=blocked:id=b:kind=auth");
    let before = rig.snapshot();
    let adopted = AdoptedStatus::new(rig.imports());
    let after = adopted.snapshot("status-order");
    assert_eq!(
        after.records, before.records,
        "sealed adoption preserves every record, seen mark and update order"
    );
    assert_eq!(
        after.revision,
        before.revision + 1,
        "adoption publishes a fresh revision"
    );
    let session = adopted.session("status-order");
    assert_eq!(session.output.lock().unwrap().status.publications, 1);
    assert!(session
        .output
        .lock()
        .unwrap()
        .status
        .tagged_records()
        .is_empty());
    assert_eq!(session.focus_epoch.load(Ordering::Relaxed), 0);
    assert!(adopted
        .0
        .inject_output("status-order", b"\x1b]7501;state=working:id=d\x07"));
    let updated = adopted.snapshot("status-order");
    assert_eq!(
        updated.records.last().unwrap().update_order,
        5,
        "the restored next order admits subsequent reports"
    );
    assert_eq!(updated.revision, after.revision + 1);
}

#[test]
fn program_status_sealed_restore_continues_every_report_split() {
    for end in ["\x07", "\x1b\\"] {
        let bytes =
            format!("\x1b]7501;state=blocked:id=job:kind=question:progress=0:msg=eA=={end}");
        for cut in 0..=bytes.len() {
            let rig = StatusRestart::new("status-split");
            rig.session.record_output(&bytes.as_bytes()[..cut]);
            let before = rig.snapshot();
            let adopted = AdoptedStatus::new(rig.imports());
            assert!(adopted
                .0
                .inject_output("status-split", &bytes.as_bytes()[cut..]));
            let after = adopted.snapshot("status-split");
            assert_eq!(
                after.records.len(),
                1,
                "sealed report split {cut}, end {end:?}, must finish after adoption"
            );
            let record = &after.records[0];
            assert_eq!(record.id.as_deref(), Some("job"));
            assert_eq!(record.state, ProgramState::Blocked);
            assert_eq!(record.kind, Some(ProgramStatusKind::Question));
            assert_eq!(record.progress, Some(0));
            assert_eq!(record.msg.as_deref(), Some("x"));
            assert_eq!(
                record.update_order, 1,
                "a dispatched ESC-ended report must not be applied again"
            );
            assert_eq!(
                after.revision, 2,
                "exactly one report and one adoption, before={before:?}"
            );
        }
    }
}

#[test]
fn program_status_sealed_empty_restore_publishes_once() {
    let rig = StatusRestart::new("status-empty");
    let adopted = AdoptedStatus::new(rig.imports());
    assert_eq!(
        *adopted.snapshot("status-empty"),
        ProgramStatusSnapshot {
            revision: 1,
            records: vec![]
        },
        "an eligible empty restore also publishes a fresh value"
    );
    assert_eq!(
        adopted
            .session("status-empty")
            .output
            .lock()
            .unwrap()
            .status
            .publications,
        1
    );
}

#[test]
fn program_status_legacy_manifest_without_status_restores_empty() {
    let rig = StatusRestart::new("status-legacy");
    rig.report("state=working:id=job");
    rig.session.record_output(b"\x1b]7501;state=");
    let mut imports = rig.imports();
    let mut value = serde_json::to_value(&imports[0].meta).unwrap();
    value.as_object_mut().unwrap().remove("program_status");
    let parsed = serde_json::from_value::<FdStoreSessionMeta>(value);
    assert!(
        parsed.is_ok(),
        "the v0.104.0 entry without program_status must parse: {parsed:?}"
    );
    imports[0].meta = parsed.unwrap();
    let adopted = AdoptedStatus::new(imports);
    assert_eq!(
        *adopted.snapshot("status-legacy"),
        ProgramStatusSnapshot::default()
    );
    assert!(adopted.0.inject_output("status-legacy", b"done\x07"));
    assert!(
        adopted.snapshot("status-legacy").records.is_empty(),
        "legacy framing starts in ground"
    );
}

fn refused_status_restore(case: &str) {
    let rig = StatusRestart::new(case);
    rig.report("state=done:id=job");
    rig.session.record_output(b"\x1b]7501;state=");
    let mut imports = rig.imports();
    let import = &mut imports[0];
    match case {
        "unsealed-exact" => import.sealed_manifest = false,
        "missing" => import.ring_fd = None,
        "corrupt" => {
            let file = File::from(import.ring_fd.as_ref().unwrap().try_clone().unwrap());
            std::os::unix::fs::FileExt::write_all_at(&file, b"NOTARING", 0).unwrap();
        }
        "stopped-exact" => {
            let mut file =
                RingFile::adopt(import.ring_fd.as_ref().unwrap().try_clone().unwrap()).unwrap();
            assert_eq!(file.read().unwrap().0, import.meta.seq);
            file.publish_state(&TerminalState::default(), true).unwrap();
        }
        "behind" => import.meta.seq += 1,
        "ahead" => import.meta.seq -= 1,
        _ => panic!("unknown case"),
    }
    let adopted = AdoptedStatus::new(imports);
    assert_eq!(
        *adopted.snapshot(case),
        ProgramStatusSnapshot::default(),
        "{case} status must start empty"
    );
    assert!(adopted.0.inject_output(case, b"done:id=unfinished\x07"));
    assert!(
        adopted.snapshot(case).records.is_empty(),
        "{case} framing must start in ground"
    );
    assert!(adopted
        .0
        .inject_output(case, b"\x1b]7501;state=working:id=new\x07"));
    let after = adopted.snapshot(case);
    assert_eq!(after.records.len(), 1);
    assert_eq!(
        after.records[0].update_order, 1,
        "{case} order starts fresh"
    );
}

macro_rules! refused_restore_test {
    ($name:ident, $case:literal) => {
        #[test]
        fn $name() {
            refused_status_restore($case);
        }
    };
}

refused_restore_test!(
    program_status_restore_refuses_unsealed_exact_ring,
    "unsealed-exact"
);
refused_restore_test!(program_status_restore_refuses_missing_ring, "missing");
refused_restore_test!(program_status_restore_refuses_corrupt_ring, "corrupt");
refused_restore_test!(
    program_status_restore_refuses_stopped_exact_ring,
    "stopped-exact"
);
refused_restore_test!(program_status_restore_refuses_behind_ring, "behind");
refused_restore_test!(program_status_restore_refuses_ahead_ring, "ahead");

#[test]
fn program_status_restore_keeps_each_unfinished_framing_state() {
    for (prefix, state) in [
        (&b"text"[..], "ground"),
        (&b"\x1b"[..], "escape"),
        (&b"\x1b("[..], "escape_intermediate"),
        (&b"\x1b[12;"[..], "csi"),
        (&b"\x1b]75"[..], "osc_identifier"),
        (&b"\x1b]7501;state="[..], "osc_body"),
        (&b"\x1b]133;A;"[..], "osc_body"),
        (&b"\x1b]999;ignored"[..], "osc_discard"),
        (&b"\x1bPpayload"[..], "string"),
    ] {
        let rig = StatusRestart::new("status-framing");
        rig.report("state=done:id=kept");
        rig.session.record_output(prefix);
        let before = rig.session.output.lock().unwrap().status.framing.clone();
        assert_eq!(
            serde_json::to_value(&before).unwrap()["state"],
            state,
            "fixture {prefix:?}"
        );
        let adopted = AdoptedStatus::new(rig.imports());
        let session = adopted.session("status-framing");
        assert_eq!(
            session.output.lock().unwrap().status.framing,
            before,
            "adoption must retain {state} from output"
        );
        assert!(adopted
            .0
            .inject_output("status-framing", b"\x1b]7501;state=done:id=new\x07"));
        assert_eq!(
            adopted
                .snapshot("status-framing")
                .records
                .last()
                .unwrap()
                .id
                .as_deref(),
            Some("new")
        );
    }
}

#[test]
fn program_status_seal_blocks_late_report_focus_cleanup_and_exit() {
    let rig = StatusRestart::new("status-sealed-admission");
    rig.report("state=done:id=done");
    rig.report("state=working:id=job");
    rig.session.record_output(b"\x1b]7501;state=");
    let before = rig.snapshot();
    let entry = rig
        .registry
        .seal_fdstore_manifest_sessions("t")
        .pop()
        .unwrap();
    let framing = rig.session.output.lock().unwrap().status.framing.clone();
    rig.session
        .record_output(b"error\x07\x1b]7501;state=clear\x07");
    assert_eq!(
        rig.snapshot(),
        before,
        "reports after sealing cannot change the status"
    );
    assert_eq!(
        rig.session.output.lock().unwrap().status.framing,
        framing,
        "framing after sealing must stay at the cut"
    );
    assert!(
        rig.session.output.lock().unwrap().ring.end_seq() > entry.meta.seq,
        "late output retains the byte replay path"
    );
    rig.session.set_focused(true);
    assert_eq!(
        rig.snapshot(),
        before,
        "focus after sealing cannot mark stored completions seen"
    );
    rig.session
        .output
        .lock()
        .unwrap()
        .status
        .remove_gone_groups(&[2]);
    assert_eq!(
        rig.snapshot(),
        before,
        "cleanup after sealing cannot remove a stored program"
    );
    rig.session
        .record_terminal_exit(TerminalExit::Unknown, &rig.registry.last_exit);
    assert_eq!(
        rig.snapshot(),
        before,
        "exit after sealing cannot change the saved set"
    );
}

#[test]
fn program_status_seal_waits_for_the_admitted_output_and_captures_its_position() {
    let rig = StatusRestart::new("status-admitted-output");
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    arm_attach_seam(
        &rig.session.id,
        AttachSeam::OutputBeforeRingPush,
        move || {
            entered_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        },
    );
    let session = rig.session.clone();
    let bytes = b"\x1b]7501;state=done:id=admitted\x07";
    let writing = std::thread::spawn(move || session.record_output(bytes));
    entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let (sealing_tx, sealing_rx) = std::sync::mpsc::channel();
    arm_attach_seam(
        &rig.session.id,
        AttachSeam::ManifestBeforeReplayTail,
        move || {
            sealing_tx.send(()).unwrap();
        },
    );
    let registry = rig.registry.clone();
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let sealing = std::thread::spawn(move || {
        done_tx
            .send(registry.seal_fdstore_manifest_sessions("t"))
            .unwrap();
    });
    sealing_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(
        matches!(
            done_rx.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Empty)
        ),
        "seal cannot pass a report that holds the output lock"
    );
    release_tx.send(()).unwrap();
    writing.join().unwrap();
    let entry = done_rx
        .recv_timeout(Duration::from_secs(5))
        .unwrap()
        .pop()
        .unwrap();
    sealing.join().unwrap();
    assert_eq!(
        entry.meta.seq,
        bytes.len() as u64,
        "sealed position must include the admitted read"
    );
    let saved = serde_json::to_value(entry.meta).unwrap();
    assert_eq!(
        saved["program_status"]["records"][0]["id"], "admitted",
        "status and byte position come from one admitted read"
    );
}

#[test]
fn program_status_focus_waiting_at_seal_cannot_change_saved_marks() {
    let rig = StatusRestart::new("status-delayed-focus");
    rig.report("state=done");
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    arm_attach_seam(
        &rig.session.id,
        AttachSeam::FocusBeforeRingLock,
        move || {
            entered_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        },
    );
    let session = rig.session.clone();
    let focusing = std::thread::spawn(move || session.set_focused(true));
    entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let entry = rig
        .registry
        .seal_fdstore_manifest_sessions("t")
        .pop()
        .unwrap();
    release_tx.send(()).unwrap();
    focusing.join().unwrap();
    let saved = serde_json::to_value(entry.meta).unwrap();
    assert_eq!(saved["program_status"]["records"][0]["seen"], false);
    assert!(
        !rig.snapshot().records[0].seen,
        "a focus word waiting before the seal is refused when it reaches the closed admission"
    );
}

#[test]
fn program_status_ordinary_manifest_does_not_seal_and_unparked_session_is_excluded() {
    let rig = StatusRestart::new("status-ordinary");
    let (unparked, _commands) =
        test_agent_session(LIVE_RING_BYTES, "unparked", None, None, None, &[]);
    rig.registry
        .sessions
        .lock()
        .unwrap()
        .insert(unparked.id.clone(), unparked.clone());
    assert!(rig
        .registry
        .inject_output("unparked", b"\x1b]7501;state=working\x07"));
    rig.report("state=working");
    let first = rig.registry.fdstore_manifest_sessions("t");
    assert_eq!(first.len(), 1, "unparked status never enters a manifest");
    rig.report("state=done");
    assert_eq!(
        rig.snapshot().records[0].state,
        ProgramState::Done,
        "ordinary snapshots keep status admission open"
    );
    let adopted = AdoptedStatus::new(rig.imports());
    assert!(
        adopted.0.attach("unparked", None).is_none(),
        "unparked sessions do not survive"
    );
    assert_eq!(rig.registry.close_all(CloseReason::Shutdown), 1);
    assert!(unparked.closed.load(Ordering::Relaxed));
}
