use super::*;

fn attach(pacing: &Arc<Pacing>) -> OutputProgress {
    pacing
        .subscribe(0, Some(OutputFlow::Acknowledged), || ())
        .1
        .expect("acknowledging lease")
}

fn admission(pacing: &Pacing, maximum: usize, now: Instant) -> Admission {
    let mut state = pacing.state.lock().expect("pacing state");
    pacing.admit(&mut state, maximum, now)
}

/// A client that has parsed `bytes` more of what it was sent.
fn parsed(progress: &OutputProgress, bytes: u64) {
    let acked = progress.with_view(|view| view.acked).flatten();
    progress.acknowledge(acked.expect("acknowledging view") + bytes);
}

#[test]
fn event_credit_leaves_broadcast_headroom() {
    assert!(
        2 * EVENT_CREDIT as usize <= super::super::BROADCAST_CAP,
        "a holding view stays within the broadcast channel"
    );
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
    for view in [&slow, &fast] {
        view.sent_output(40);
        view.sent_event();
    }
    parsed(&fast, 40);
    assert_eq!(
        admission(&pacing, 1000, now),
        Admission::Read(10),
        "slowest acknowledging view supplies reader credit"
    );
    parsed(&slow, 10);
    assert_eq!(admission(&pacing, 1000, now), Admission::Read(20));
}

#[test]
fn a_completed_send_is_not_progress() {
    let pacing = Pacing::new(100, 0);
    let view = attach(&pacing);
    let now = Instant::now();
    pacing.publish(50, || ());
    view.sent_output(50);
    view.sent_event();
    assert_eq!(
        admission(&pacing, 1000, now),
        Admission::Wait(now + NO_PROGRESS_LIMIT),
        "a page that accepts frames it never parses still holds the window"
    );
    assert_eq!(view.send_credit(), Some(0), "nothing more may be sent");
    assert!(!view.drained());
}

#[test]
fn a_completed_send_does_not_renew_the_deadline() {
    let pacing = Pacing::new(100, 0);
    let view = attach(&pacing);
    let started = Instant::now();
    pacing.publish(50, || ());
    view.sent_output(30);
    assert_eq!(
        admission(&pacing, 1000, started),
        Admission::Wait(started + NO_PROGRESS_LIMIT)
    );
    view.sent_output(20);
    assert_eq!(
        admission(&pacing, 1000, started + NO_PROGRESS_LIMIT),
        Admission::Read(1000),
        "the send completed during the hold leaves its deadline in place"
    );
    assert!(view.needs_replay());
}

#[test]
fn an_acknowledgement_cannot_vouch_for_unsent_or_unpublished_bytes() {
    let pacing = Pacing::new(100, 0);
    let view = attach(&pacing);
    let now = Instant::now();
    pacing.publish(50, || ());
    view.sent_output(10);
    view.acknowledge(1000);
    assert_eq!(
        view.send_credit(),
        Some(50),
        "the unsent tail is not acknowledged"
    );
    assert_eq!(
        admission(&pacing, 1000, now),
        Admission::Read(10),
        "credit counts only what was sent and parsed"
    );
    view.sent_output(40);
    assert_eq!(
        admission(&pacing, 1000, now),
        Admission::Read(50),
        "an early acknowledgement counts once its bytes are sent"
    );
    assert!(view.drained());
    pacing.publish(10, || ());
    view.sent_output(10);
    assert!(
        !view.drained(),
        "a position capped at the published stream cannot cover later output"
    );
}

#[test]
fn a_stale_acknowledgement_moves_nothing() {
    let pacing = Pacing::new(100, 0);
    let view = attach(&pacing);
    let now = Instant::now();
    pacing.publish(50, || ());
    view.sent_output(50);
    view.acknowledge(10);
    pacing.publish(10, || ());
    assert_eq!(
        admission(&pacing, 1000, now),
        Admission::Wait(now + NO_PROGRESS_LIMIT)
    );
    view.acknowledge(5);
    view.acknowledge(10);
    assert_eq!(
        admission(&pacing, 1000, now + Duration::from_secs(1)),
        Admission::Wait(now + NO_PROGRESS_LIMIT),
        "a repeated or older position does not renew the deadline"
    );
}

#[test]
fn event_credit_blocks_even_without_output_and_events_do_not_renew_deadline() {
    let pacing = Pacing::new(100, 0);
    let progress = attach(&pacing);
    for _ in 0..512 {
        pacing.publish(0, || ());
    }
    let started = Instant::now();
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
        "control events cannot keep a stalled view holding"
    );
    assert!(progress.needs_replay());
}

#[test]
fn progress_renews_deadline_and_cut_loose_stays_latched() {
    let pacing = Pacing::new(100, 0);
    let progress = attach(&pacing);
    pacing.publish(50, || ());
    progress.sent_output(50);
    let started = Instant::now();
    assert_eq!(
        admission(&pacing, 1000, started),
        Admission::Wait(started + NO_PROGRESS_LIMIT)
    );
    parsed(&progress, 1);
    pacing.publish(1, || ());
    progress.sent_output(1);
    let renewed = started + Duration::from_secs(4);
    assert_eq!(
        admission(&pacing, 1000, renewed),
        Admission::Wait(renewed + NO_PROGRESS_LIMIT),
        "an acknowledgement renews the deadline"
    );
    assert_eq!(
        admission(&pacing, 1000, renewed + NO_PROGRESS_LIMIT),
        Admission::Read(1000)
    );
    assert!(progress.needs_replay(), "deadline releases only that view");
    parsed(&progress, 50);
    assert_eq!(progress.seq(), 51);
    assert!(
        progress.needs_replay(),
        "a late acknowledgement cannot silently re-enroll a released view"
    );
    assert!(progress.drained(), "the released view has caught up");
}

#[test]
fn idle_time_does_not_expire_a_fresh_backlog() {
    let pacing = Pacing::new(100, 0);
    let progress = attach(&pacing);
    let later = Instant::now() + Duration::from_secs(100);
    assert_eq!(admission(&pacing, 1000, later), Admission::Read(50));
    assert!(!progress.needs_replay(), "an idle view keeps its lease");
    pacing.publish(49, || ());
    assert_eq!(
        admission(&pacing, 1000, later + Duration::from_secs(100)),
        Admission::Read(1),
        "a view inside its window is not on the clock"
    );
    pacing.publish(1, || ());
    let blocked = later + Duration::from_secs(200);
    assert_eq!(
        admission(&pacing, 1000, blocked),
        Admission::Wait(blocked + NO_PROGRESS_LIMIT),
        "the clock starts when the view first holds the reader"
    );
}

#[test]
fn an_unacknowledged_client_never_holds_and_is_tracked_for_its_cursor() {
    let pacing = Pacing::new(100, 0);
    let (_, lease) = pacing.subscribe(0, Some(OutputFlow::Unacknowledged), || ());
    let view = lease.expect("tracked lease");
    pacing.publish(1000, || ());
    view.sent_output(10);
    assert_eq!(
        admission(&pacing, 1000, Instant::now()),
        Admission::Read(1000)
    );
    assert_eq!(view.seq(), 10, "the recovery cursor still follows sends");
    assert_eq!(view.send_credit(), None, "no window limits its sends");
    assert_eq!(view.ack_window(), None, "no window is advertised");
    assert!(
        view.drained(),
        "a recovery never waits for an acknowledgement"
    );
    assert!(!view.needs_replay(), "only a holding view can be released");
    view.acknowledge(10);
    assert_eq!(view.send_credit(), None, "a stray frame enrolls nothing");
}

#[test]
fn ordinary_subscribers_drop_and_drain_do_not_hold_reader() {
    let pacing = Pacing::new(100, 0);
    let (_, none) = pacing.subscribe(0, None, || ());
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
fn blocked_credit_wakes_on_acknowledgement_last_lease_drop_and_exit_bypass() {
    for release in ["ack", "drop", "bypass"] {
        let pacing = Pacing::new(100, 0);
        let mut progress = Some(attach(&pacing));
        pacing.publish(50, || ());
        progress.as_ref().expect("lease").sent_output(50);
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
            "ack" => parsed(progress.as_ref().expect("lease"), 1),
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
            if release == "ack" { 1 } else { 1000 },
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
    for view in [&slow, &fast] {
        view.sent_output(50);
        view.sent_event();
    }
    let started = Instant::now();
    assert_eq!(
        admission(&pacing, 1000, started),
        Admission::Wait(started + NO_PROGRESS_LIMIT)
    );
    parsed(&fast, 40);

    assert_eq!(
        admission(&pacing, 1000, started + NO_PROGRESS_LIMIT),
        Admission::Read(40),
        "expiring the slow view leaves only the progressing view's credit"
    );
    assert!(slow.needs_replay(), "the stalled view is released");
    assert!(!fast.needs_replay(), "the progressing view keeps its lease");

    pacing.publish(40, || ());
    fast.sent_output(40);
    fast.sent_event();
    let blocked = started + Duration::from_secs(6);
    assert_eq!(
        admission(&pacing, 1000, blocked),
        Admission::Wait(blocked + NO_PROGRESS_LIMIT),
        "the progressing view still enforces its own credit and deadline"
    );
    parsed(&fast, 10);
    assert_eq!(
        admission(&pacing, 1000, blocked),
        Admission::Read(10),
        "only the remaining holding view's progress replenishes credit"
    );
    assert!(slow.needs_replay());
    assert!(!fast.needs_replay());
}

/// Poll once, with no waker to call: whether the future is done now.
fn ready(future: std::pin::Pin<&mut impl std::future::Future<Output = ()>>) -> bool {
    let mut context = std::task::Context::from_waker(std::task::Waker::noop());
    std::future::Future::poll(future, &mut context).is_ready()
}

#[test]
fn released_completes_at_the_release_of_its_own_view() {
    let pacing = Pacing::new(100, 0);
    let stalled = attach(&pacing);
    let healthy = attach(&pacing);
    pacing.publish(50, || ());
    for view in [&stalled, &healthy] {
        view.sent_output(50);
        view.sent_event();
    }
    parsed(&healthy, 50);
    let started = Instant::now();
    assert_eq!(
        admission(&pacing, 1000, started),
        Admission::Wait(started + NO_PROGRESS_LIMIT),
        "fixture: the stalled view holds the reader"
    );
    let mut stalled_waits = std::pin::pin!(stalled.released());
    let mut healthy_waits = std::pin::pin!(healthy.released());
    assert!(!ready(stalled_waits.as_mut()), "no view is released yet");
    assert!(!ready(healthy_waits.as_mut()), "no view is released yet");
    assert_eq!(
        admission(&pacing, 1000, started + NO_PROGRESS_LIMIT),
        Admission::Read(50),
        "fixture: the reader releases the stalled view"
    );
    assert!(
        ready(stalled_waits.as_mut()),
        "a wait under way ends at its view's release"
    );
    assert!(
        !ready(healthy_waits.as_mut()),
        "another view's release leaves this view waiting"
    );
    assert!(
        ready(std::pin::pin!(stalled.released())),
        "a wait begun after its view's release ends at once"
    );
}
