use super::*;
use futures::FutureExt;
use std::sync::mpsc;

const GUARD: Duration = Duration::from_secs(10);

fn held(tenant: &BulkTransferTenant) -> (mpsc::Sender<()>, BulkJob<()>) {
    let (entered, started) = mpsc::channel();
    let (release, park) = mpsc::channel();
    let job = tenant
        .submit(move |_| {
            entered.send(()).unwrap();
            let _ = park.recv_timeout(GUARD);
        })
        .unwrap();
    started.recv_timeout(GUARD).unwrap();
    (release, job)
}

#[test]
fn queued_client_cancel_delivers_without_a_writer_turn_and_promotes_the_next() {
    let lane = BulkTransferLane::new();
    let tenant = lane.tenant();
    let (release_a, a) = held(&tenant);
    let (release_b, b) = held(&tenant);
    let (ran, started) = mpsc::channel();
    let c = tenant
        .submit(move |_| {
            ran.send("c").unwrap();
        })
        .unwrap();
    let (ran, fourth) = mpsc::channel();
    let d = tenant
        .submit(move |_| {
            ran.send("d").unwrap();
        })
        .unwrap();
    let mut changes = tenant.shared.changes.subscribe();
    changes.mark_unchanged();
    assert_eq!(d.position(), Some(2));
    assert_eq!(c.client_cancel().cancel(), ClientCancelResult::Requested);
    assert!(
        changes.has_changed().unwrap(),
        "explicit withdrawal announces the new rank"
    );
    assert_eq!(
        d.position(),
        Some(1),
        "the fourth job moves up before an active slot frees"
    );
    assert_eq!(tenant.shared.lock().active.len(), 2);
    assert_eq!(
        c.outcome().now_or_never(),
        Some(BulkOutcome::ClientCancelled),
        "queued explicit cancellation delivers its own outcome immediately"
    );
    drop(release_a);
    assert_eq!(fourth.recv_timeout(GUARD).unwrap(), "d");
    assert_eq!(d.wait(), BulkOutcome::Done(()));
    drop(release_b);
    assert_eq!(a.wait(), BulkOutcome::Done(()));
    assert_eq!(b.wait(), BulkOutcome::Done(()));
    drop(lane);
    assert!(
        started.try_recv().is_err(),
        "the cancelled writer never runs"
    );
}

#[test]
fn queued_withdrawal_is_distinct_from_active_cancellation() {
    let lane = BulkTransferLane::new();
    let tenant = lane.tenant();
    let (release_a, a) = held(&tenant);
    let (release_b, b) = held(&tenant);
    let c = tenant
        .submit(|_| -> () { panic!("withdrawn writer ran") })
        .unwrap();
    let d = tenant.submit(|_| ()).unwrap();
    let mut changes = tenant.shared.changes.subscribe();
    changes.mark_unchanged();
    assert!(c.withdraw_queued(), "waiting work is withdrawn");
    assert_eq!(d.position(), Some(1));
    assert_eq!(tenant.shared.lock().active.len(), 2);
    assert!(
        changes.has_changed().unwrap(),
        "queued-only withdrawal announces"
    );
    assert_eq!(c.outcome().now_or_never(), Some(BulkOutcome::Cancelled));
    assert!(!a.withdraw_queued(), "promoted work cannot be withdrawn");
    drop(release_a);
    assert_eq!(
        a.wait(),
        BulkOutcome::Done(()),
        "withdrawal leaves active work uncancelled"
    );
    drop(release_b);
    assert_eq!(b.wait(), BulkOutcome::Done(()));
    assert_eq!(d.wait(), BulkOutcome::Done(()));
}

#[tokio::test]
async fn a_pending_outcome_wait_retains_the_receiver() {
    let lane = BulkTransferLane::new();
    let tenant = lane.tenant();
    let (release, mut job) = held(&tenant);
    assert!(job.settled().now_or_never().is_none());
    drop(release);
    assert_eq!(
        tokio::time::timeout(GUARD, job.settled()).await.unwrap(),
        BulkOutcome::Done(()),
        "a cancelled wait retains the receiver"
    );
}

#[test]
fn finalization_before_client_close_preserves_the_writer_result() {
    let lane = BulkTransferLane::new();
    let tenant = lane.tenant();
    let (ready, entered) = mpsc::channel();
    let (release, park) = mpsc::channel::<()>();
    let mut job = tenant
        .submit(move |cancel| {
            cancel.begin_finalization().unwrap();
            assert!(!cancel.is_cancelled(), "finalization is not cancellation");
            cancel.check_cancelled().unwrap();
            assert!(!cancel.is_stalled());
            ready.send(()).unwrap();
            let _ = park.recv_timeout(GUARD);
            7
        })
        .unwrap();
    entered.recv_timeout(GUARD).unwrap();
    assert_eq!(
        job.client_cancel().cancel(),
        ClientCancelResult::NotCancellable,
        "a finalizing upload refuses explicit cancel"
    );
    let result = job.rx.take().unwrap();
    drop(job);
    drop(release);
    assert_eq!(
        result.blocking_recv().unwrap(),
        BulkOutcome::Done(7),
        "client close after finalization preserves the real result"
    );
}

#[tokio::test]
async fn finalization_before_shutdown_preserves_the_writer_result() {
    let lane = BulkTransferLane::new();
    let tenant = lane.tenant();
    let (ready, entered) = oneshot::channel();
    let (release, park) = mpsc::channel::<()>();
    let job = tenant
        .submit(move |cancel| {
            cancel.begin_finalization().unwrap();
            ready.send(()).unwrap();
            let _ = park.recv_timeout(GUARD);
            9
        })
        .unwrap();
    tokio::time::timeout(GUARD, entered).await.unwrap().unwrap();
    let mut changes = tenant.shared.changes.subscribe();
    changes.mark_unchanged();
    let shutdown = std::thread::spawn(move || drop(lane));
    tokio::time::timeout(GUARD, async {
        while !tenant.shared.lock().shutdown {
            changes.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    assert_eq!(
        job.client_cancel().cancel(),
        ClientCancelResult::NotCancellable
    );
    drop(release);
    assert_eq!(
        job.outcome().await,
        BulkOutcome::Done(9),
        "shutdown after finalization preserves the real result"
    );
    shutdown.join().unwrap();
}

#[test]
fn cancellation_before_finalization_wins_and_panic_stays_server_failure() {
    for panics in [false, true] {
        let lane = BulkTransferLane::new();
        let tenant = lane.tenant();
        let (ready, entered) = mpsc::channel();
        let (release, park) = mpsc::channel::<()>();
        let job = tenant
            .submit(move |cancel| {
                ready.send(()).unwrap();
                let _ = park.recv_timeout(GUARD);
                assert!(
                    cancel.begin_finalization().is_err(),
                    "a cancelled upload cannot finalize"
                );
                assert!(cancel.is_cancelled());
                assert!(!cancel.is_stalled());
                assert!(!panics, "constructed writer panic");
                11
            })
            .unwrap();
        entered.recv_timeout(GUARD).unwrap();
        let capability = job.client_cancel();
        assert_eq!(capability.cancel(), ClientCancelResult::Requested);
        job.cancel();
        assert_eq!(
            capability.cancel(),
            ClientCancelResult::Requested,
            "explicit cancel is idempotent and first-wins"
        );
        drop(release);
        let expected = if panics {
            BulkOutcome::Cancelled
        } else {
            BulkOutcome::ClientCancelled
        };
        assert_eq!(
            job.wait(),
            expected,
            "a panic never becomes a client completion"
        );
    }
}

#[test]
fn an_earlier_shutdown_or_stall_is_not_replaced_by_client_cancel() {
    for reason in [CANCELLED, STALLED] {
        let lane = BulkTransferLane::new();
        let tenant = lane.tenant();
        let (ready, entered) = mpsc::channel();
        let (release, park) = mpsc::channel::<()>();
        let job = tenant
            .submit(move |cancel| {
                end_job(&cancel.0, reason);
                ready.send(()).unwrap();
                let _ = park.recv_timeout(GUARD);
            })
            .unwrap();
        entered.recv_timeout(GUARD).unwrap();
        assert_eq!(job.client_cancel().cancel(), ClientCancelResult::NotFound);
        drop(release);
        let expected = if reason == STALLED {
            BulkOutcome::Stalled
        } else {
            BulkOutcome::Cancelled
        };
        assert_eq!(
            job.wait(),
            expected,
            "the original end reason survives a later explicit cancel"
        );
    }
}

struct DeliveryGate {
    entered: mpsc::Sender<()>,
    park: mpsc::Receiver<()>,
}
impl Drop for DeliveryGate {
    fn drop(&mut self) {
        let _ = self.entered.send(());
        let _ = self.park.recv_timeout(GUARD);
    }
}

#[test]
fn a_promoting_pop_announces_after_the_previous_completion_announcement() {
    let lane = BulkTransferLane::new();
    let tenant = lane.tenant();
    let (release_b, b) = held(&tenant);
    let (ready, entered) = mpsc::channel();
    let (release_a, park_a) = mpsc::channel::<()>();
    let (delivery, at_delivery) = mpsc::channel();
    let (release_delivery, park_delivery) = mpsc::channel();
    let a = tenant
        .submit(move |_| {
            ready.send(()).unwrap();
            let _ = park_a.recv_timeout(GUARD);
            DeliveryGate {
                entered: delivery,
                park: park_delivery,
            }
        })
        .unwrap();
    entered.recv_timeout(GUARD).unwrap();
    let (started, promoted) = mpsc::channel();
    let (release_d, park_d) = mpsc::channel::<()>();
    let d = tenant
        .submit(move |_| {
            started.send(()).unwrap();
            let _ = park_d.recv_timeout(GUARD);
        })
        .unwrap();
    drop(a);
    drop(release_a);
    at_delivery.recv_timeout(GUARD).unwrap();
    assert_eq!(d.position(), Some(1));
    let mut changes = tenant.shared.changes.subscribe();
    changes.mark_unchanged();
    drop(release_delivery);
    promoted.recv_timeout(GUARD).unwrap();
    assert!(
        changes.has_changed().unwrap(),
        "the pop announces independently of the previous completion"
    );
    assert_eq!(d.position(), None);
    drop(release_d);
    drop(release_b);
    assert_eq!(d.wait(), BulkOutcome::Done(()));
    assert_eq!(b.wait(), BulkOutcome::Done(()));
}

#[tokio::test]
async fn client_cancel_after_lane_shutdown_keeps_shutdown_outcome() {
    let lane = BulkTransferLane::new();
    let tenant = lane.tenant();
    let (ready, entered) = oneshot::channel();
    let (release, park) = mpsc::channel::<()>();
    let job = tenant
        .submit(move |_| {
            ready.send(()).unwrap();
            let _ = park.recv_timeout(GUARD);
        })
        .unwrap();
    tokio::time::timeout(GUARD, entered).await.unwrap().unwrap();
    let mut changes = tenant.shared.changes.subscribe();
    changes.mark_unchanged();
    let shutdown = std::thread::spawn(move || drop(lane));
    tokio::time::timeout(GUARD, async {
        while !tenant.shared.lock().shutdown {
            changes.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    assert_eq!(
        job.client_cancel().cancel(),
        ClientCancelResult::NotFound,
        "an explicit cancel cannot replace shutdown"
    );
    drop(release);
    assert_eq!(job.outcome().await, BulkOutcome::Cancelled);
    shutdown.join().unwrap();
}

#[test]
fn a_finalized_capability_stays_noncancellable_after_slot_release() {
    let lane = BulkTransferLane::new();
    let job = lane
        .tenant()
        .submit(|cancel| {
            cancel.begin_finalization().unwrap();
            42
        })
        .unwrap();
    let capability = job.client_cancel();
    assert_eq!(job.wait(), BulkOutcome::Done(42));
    assert_eq!(
        capability.cancel(),
        ClientCancelResult::NotCancellable,
        "the finalization decision outlives its lane slot"
    );
}

#[tokio::test]
async fn a_panicking_cancelled_writer_keeps_the_async_server_failure_outcome() {
    let lane = BulkTransferLane::new();
    let (ready, started) = oneshot::channel();
    let (release, wait) = mpsc::channel::<()>();
    let job = lane
        .tenant()
        .submit(move |cancel| -> () {
            ready.send(()).unwrap();
            let _ = wait.recv_timeout(GUARD);
            assert!(cancel.begin_finalization().is_err());
            panic!("constructed cancelled-writer panic");
        })
        .unwrap();
    tokio::time::timeout(GUARD, started).await.unwrap().unwrap();
    assert_eq!(job.client_cancel().cancel(), ClientCancelResult::Requested);
    drop(release);
    assert_eq!(
        job.outcome().await,
        BulkOutcome::Cancelled,
        "async delivery never turns a writer panic into a client completion"
    );
}
