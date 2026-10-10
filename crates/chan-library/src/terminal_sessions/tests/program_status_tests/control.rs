use super::*;

#[test]
fn control_between_pty_halves_preserves_framing_ring_and_visible_count() {
    let rig = Rig::new();
    let prefix = b"visible\x1b]7501;state=blocked:id=pty:msg=";
    rig.feed(prefix);
    let ring = rig.session.scrollback();
    let visible = rig.session.bytes_since_focus();
    let before = rig.session.clone().attach(None).seq;
    rig.registry
        .submit_program_status(&rig.session.id, b"state=done:id=control")
        .unwrap();
    assert_eq!(
        rig.snapshot().records,
        vec![record(&json!({"state":"done", "id":"control"}), 1)],
        "complete control record applied"
    );
    assert_eq!(
        rig.session.scrollback(),
        ring,
        "control changes no replay byte"
    );
    assert_eq!(
        rig.session.clone().attach(None).seq,
        before,
        "control changes no sequence number"
    );
    assert_eq!(
        rig.session.bytes_since_focus(),
        visible,
        "control changes no visible count"
    );
    assert!(
        rig.commands.lock().unwrap().try_recv().is_err(),
        "control writes no PTY input"
    );
    rig.feed(b"SGVsbG8=\x1b\\");
    assert_eq!(
        rig.snapshot().records,
        vec![
            record(&json!({"state":"done", "id":"control"}), 1),
            record(&json!({"state":"blocked", "id":"pty", "msg":"Hello"}), 2),
        ],
        "PTY continuation survives control ingress"
    );
}

#[test]
fn control_uses_report_validation_and_refuses_framed_requests() {
    let rig = Rig::new();
    rig.report("state=done:id=original");
    let before = rig.snapshot();
    for body in [
        b"?".as_slice(),
        b"\x1bc",
        b"state=done:\x07",
        b"state=done:\x18",
        b"state=done:\x1a",
        b"state=done:\x1bc",
        b"\x1b]7501;state=done\x1b\\\x1b]7501;state=error\x1b\\",
        b"state=unknown",
        b"state=clear:id=",
        b"state=done:msg=/w==",
        b"state=done:abcdefghijklmnopq=@",
    ] {
        assert!(
            rig.registry
                .submit_program_status(&rig.session.id, body)
                .is_err(),
            "invalid control body accepted: {body:?}"
        );
        assert_eq!(
            rig.snapshot(),
            before,
            "refusal preserves records and order"
        );
    }
    rig.registry
        .submit_program_status(
            &rig.session.id,
            b" state = done:\nstate=blocked:progress=bad:unknown=value:msg=a:msg=QQ==",
        )
        .unwrap();
    assert_eq!(
        rig.snapshot().records.last().unwrap(),
        &record(&json!({"state":"blocked", "msg":"A"}), 2),
        "control follows permissive shared pair grammar"
    );
    rig.registry
        .submit_program_status(&rig.session.id, b"state=clear:id=original")
        .unwrap();
    assert_eq!(
        rig.snapshot().records.len(),
        1,
        "clear removes the named record"
    );
}

#[test]
fn control_refuses_missing_closed_finalized_and_sealed_sessions() {
    let rig = Rig::new();
    assert!(
        rig.registry
            .submit_program_status("missing", b"state=done")
            .is_err(),
        "missing session accepted"
    );
    for mode in ["closed", "finalized", "sealed"] {
        #[cfg(not(target_os = "linux"))]
        if mode == "sealed" {
            continue;
        }
        let rig = Rig::new();
        rig.report("state=done:id=original");
        match mode {
            "closed" => rig.session.closed.store(true, Ordering::Relaxed),
            "finalized" => rig
                .session
                .record_terminal_exit(TerminalExit::Unknown, &Arc::new(Mutex::new(None))),
            #[cfg(target_os = "linux")]
            "sealed" => rig.session.output.lock().unwrap().status.seal(),
            _ => unreachable!(),
        }
        let before = rig.snapshot();
        assert!(
            rig.registry
                .submit_program_status(&rig.session.id, b"state=error:id=late")
                .is_err(),
            "{mode} accepted control mutation"
        );
        assert_eq!(
            rig.snapshot(),
            before,
            "{mode} admission preserves snapshot"
        );
    }
}

#[test]
fn control_completion_uses_focus_and_publishes_to_existing_receivers() {
    let rig = Rig::new();
    rig.feed(b"visible");
    rig.session.set_focused(true);
    let mut status = rig
        .session
        .output
        .lock()
        .unwrap()
        .status
        .published
        .subscribe();
    status.borrow_and_update();
    rig.registry
        .submit_program_status(&rig.session.id, b"state=error:id=control")
        .unwrap();
    assert!(
        status.has_changed().unwrap(),
        "control publishes retained value"
    );
    assert_eq!(
        status.borrow_and_update().records,
        vec![record(
            &json!({"state":"error", "id":"control", "seen":true}),
            1
        )],
        "focused completion is seen on arrival"
    );
    assert_eq!(rig.session.bytes_since_focus(), 0);
}

#[test]
fn control_holds_the_current_incarnation_until_application() {
    let rig = Rig::new();
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    arm_attach_seam(
        &rig.session.id,
        AttachSeam::StatusBeforeOutputLock,
        move || {
            entered_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        },
    );
    std::thread::scope(|scope| {
        let control = scope.spawn(|| {
            rig.registry
                .submit_program_status(&rig.session.id, b"state=done:id=before-restart")
        });
        entered_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        assert!(
            rig.registry.sessions.try_lock().is_err(),
            "restart can replace the selected incarnation before its control report settles"
        );
        let restart = scope.spawn(|| {
            rig.registry
                .restart(&rig.session.id, RestartOverrides::default())
        });
        release_tx.send(()).unwrap();
        control.join().unwrap().unwrap();
        assert!(restart.join().unwrap().unwrap());
    });
    assert_eq!(
        rig.snapshot().records[0].id.as_deref(),
        Some("before-restart"),
        "admitted report belongs to old incarnation"
    );
    let new = rig.registry.attach(&rig.session.id, None).unwrap();
    assert!(
        new.initial_program_status.records.is_empty(),
        "restart has no old program record"
    );
    rig.registry
        .submit_program_status(&rig.session.id, b"state=error:id=after-restart")
        .unwrap();
    assert_eq!(
        new.program_status().borrow().records[0].id.as_deref(),
        Some("after-restart")
    );
    assert_eq!(
        rig.snapshot().records[0].id.as_deref(),
        Some("before-restart")
    );
    rig.registry.close_all(CloseReason::Shutdown);
}

#[cfg(target_os = "linux")]
#[test]
fn control_waiting_for_admission_refuses_a_completed_seal() {
    let rig = Rig::new();
    rig.report("state=done:id=before-seal");
    let before = rig.snapshot();
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    arm_attach_seam(
        &rig.session.id,
        AttachSeam::StatusBeforeOutputLock,
        move || {
            entered_tx.send(()).unwrap();
        },
    );
    std::thread::scope(|scope| {
        let mut output = rig.session.output.lock().unwrap();
        let control = scope.spawn(|| {
            rig.registry
                .submit_program_status(&rig.session.id, b"state=error:id=after-seal")
        });
        entered_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        output.status.seal();
        drop(output);
        assert!(
            control.join().unwrap().is_err(),
            "control waiting on the seal was acknowledged"
        );
    });
    assert_eq!(rig.snapshot(), before, "sealed snapshot changed");
}

#[cfg(target_os = "linux")]
#[test]
fn control_refuses_exhausted_counters_without_acknowledging_a_lost_report() {
    for counter in ["revision", "next_update_order"] {
        let rig = Rig::new();
        rig.report("state=done:id=original");
        {
            let mut output = rig.session.output.lock().unwrap();
            let mut stored = serde_json::to_value(output.status.stored()).unwrap();
            // Restore increments the revision; the next report exhausts the counter.
            stored[counter] = json!(u64::MAX - if counter == "revision" { 2 } else { 1 });
            output.status =
                program_status::ProgramStatus::restored(serde_json::from_value(stored).unwrap());
        }
        rig.report("state=done:id=last");
        let before = rig.snapshot();
        assert_eq!(before.records.last().unwrap().id.as_deref(), Some("last"));
        assert_eq!(
            rig.registry
                .submit_program_status(&rig.session.id, b"state=error:id=lost"),
            Err("program status counter limit reached"),
            "{counter} exhaustion acknowledged a lost report"
        );
        assert_eq!(
            rig.snapshot(),
            before,
            "{counter} exhaustion changes no retained state"
        );
    }
}
