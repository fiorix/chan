use super::*;

fn attach(pacing: &Arc<Pacing>) -> OutputProgress {
    pacing.subscribe(0, true, || ()).1.expect("holding lease")
}

fn admission(pacing: &Pacing, maximum: usize, now: Instant) -> Admission {
    let mut state = pacing.state.lock().expect("pacing state");
    pacing.admit(&mut state, maximum, now)
}

#[test]
fn half_ring_caps_each_read_and_slowest_view_holds_credit() {
    let pacing = Pacing::new(100, 0);
    let slow = attach(&pacing);
    let fast = attach(&pacing);
    let now = Instant::now();
    assert_eq!(
        admission(&pacing, 1000, now),
        Admission::Read(50),
        "read cannot spend beyond half the ring"
    );
    pacing.publish(40, || ());
    fast.sent_output(40);
    fast.sent_event();
    assert_eq!(
        admission(&pacing, 1000, now),
        Admission::Read(10),
        "slowest holding view supplies reader credit"
    );
    slow.sent_output(10);
    assert_eq!(admission(&pacing, 1000, now), Admission::Read(20));
}

#[test]
fn event_credit_blocks_even_without_output_and_events_do_not_renew_deadline() {
    let pacing = Pacing::new(100, 0);
    let progress = attach(&pacing);
    for _ in 0..512 {
        pacing.publish(0, || ());
    }
    let started = pacing.state.lock().expect("state").views[&progress.0.id]
        .stalled_since
        .expect("backlog start");
    assert_eq!(
        admission(&pacing, 1000, started),
        Admission::Wait(started + NO_PROGRESS_LIMIT),
        "512 unconsumed events hold the reader"
    );
    progress.sent_event();
    pacing.publish(0, || ());
    assert_eq!(
        admission(&pacing, 1000, started + NO_PROGRESS_LIMIT),
        Admission::Read(1000),
        "control acknowledgments cannot keep a stalled view holding"
    );
    assert!(progress.needs_replay());
}

#[test]
fn progress_renews_deadline_and_cut_loose_stays_latched() {
    let pacing = Pacing::new(100, 0);
    let progress = attach(&pacing);
    pacing.publish(50, || ());
    let started = pacing.state.lock().expect("state").views[&progress.0.id]
        .stalled_since
        .expect("backlog start");
    progress.sent_output_at(1, started + Duration::from_secs(4));
    pacing.publish(1, || ());
    assert_eq!(
        admission(&pacing, 1000, started + Duration::from_secs(5)),
        Admission::Wait(started + Duration::from_secs(9)),
        "raw byte progress renews the deadline"
    );
    assert_eq!(
        admission(&pacing, 1000, started + Duration::from_secs(9)),
        Admission::Read(1000)
    );
    assert!(progress.needs_replay(), "deadline releases only that view");
    progress.sent_output(50);
    assert_eq!(progress.seq(), 51);
    assert!(
        progress.needs_replay(),
        "late sends cannot silently re-enroll a released view"
    );
}

#[test]
fn idle_time_does_not_expire_a_fresh_backlog() {
    let pacing = Pacing::new(100, 0);
    let progress = attach(&pacing);
    let later = Instant::now() + Duration::from_secs(100);
    assert_eq!(admission(&pacing, 1000, later), Admission::Read(50));
    assert!(!progress.needs_replay(), "an idle view keeps its lease");
    pacing.publish(50, || ());
    let started = pacing.state.lock().expect("state").views[&progress.0.id]
        .stalled_since
        .expect("backlog start");
    assert_eq!(
        admission(&pacing, 1000, started),
        Admission::Wait(started + NO_PROGRESS_LIMIT)
    );
}

#[test]
fn ordinary_subscribers_drop_and_drain_do_not_hold_reader() {
    let pacing = Pacing::new(100, 0);
    let (_, none) = pacing.subscribe(0, false, || ());
    assert!(none.is_none());
    assert_eq!(
        admission(&pacing, 1000, Instant::now()),
        Admission::Read(1000)
    );
    let progress = attach(&pacing);
    let other = progress.clone();
    pacing.publish(50, || ());
    drop(progress);
    assert!(
        matches!(admission(&pacing, 1000, Instant::now()), Admission::Wait(_)),
        "a live clone retains the view"
    );
    drop(other);
    assert_eq!(
        admission(&pacing, 1000, Instant::now()),
        Admission::Read(1000)
    );
    let _progress = attach(&pacing);
    pacing.bypass();
    assert_eq!(
        admission(&pacing, 1000, Instant::now()),
        Admission::Read(1000),
        "stop and exit drain bypass pacing"
    );
}

#[test]
fn blocked_credit_wakes_on_raw_progress_last_lease_drop_and_exit_bypass() {
    for release in ["progress", "drop", "bypass"] {
        let pacing = Pacing::new(100, 0);
        let mut progress = Some(attach(&pacing));
        pacing.publish(50, || ());
        let (waiting_tx, waiting_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let worker = {
            let pacing = pacing.clone();
            std::thread::spawn(move || {
                let credit = pacing.credit(1000, || {
                    let _ = waiting_tx.send(());
                });
                done_tx.send(credit).expect("credit result");
            })
        };
        waiting_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("reader reached credit wait");
        match release {
            "progress" => progress.as_ref().expect("lease").sent_output(1),
            "drop" => drop(progress.take()),
            "bypass" => pacing.bypass(),
            _ => unreachable!(),
        }
        let result = done_rx.recv_timeout(Duration::from_secs(2));
        // Unblock before asserting so a broken notification cannot strand a worker.
        pacing.bypass();
        drop(progress);
        worker.join().expect("credit worker");
        assert_eq!(
            result.expect("credit wait wakes promptly"),
            if release == "progress" { 1 } else { 1000 },
            "release={release}"
        );
    }
}

#[test]
fn expiring_one_view_preserves_the_other_views_credit_and_deadline() {
    let pacing = Pacing::new(100, 0);
    let slow = attach(&pacing);
    let fast = attach(&pacing);
    pacing.publish(50, || ());
    let started = pacing.state.lock().expect("state").views[&slow.0.id]
        .stalled_since
        .expect("backlog start");
    fast.sent_output_at(40, started + Duration::from_secs(4));
    fast.sent_event();

    assert_eq!(
        admission(&pacing, 1000, started + Duration::from_secs(5)),
        Admission::Read(40),
        "expiring the slow view leaves only the progressing view's credit"
    );
    assert!(slow.needs_replay(), "the stalled view is released");
    assert!(!fast.needs_replay(), "the progressing view keeps its lease");

    pacing.publish(40, || ());
    assert_eq!(
        admission(&pacing, 1000, started + Duration::from_secs(5)),
        Admission::Wait(started + Duration::from_secs(9)),
        "the progressing view still enforces its own credit and deadline"
    );
    fast.sent_output_at(10, started + Duration::from_secs(6));
    assert_eq!(
        admission(&pacing, 1000, started + Duration::from_secs(6)),
        Admission::Read(10),
        "only the remaining holding view's progress replenishes credit"
    );
    assert!(slow.needs_replay());
    assert!(!fast.needs_replay());
}
