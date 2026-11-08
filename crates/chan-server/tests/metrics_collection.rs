//! A separate test process isolates process-wide recorder totals.
use chan_server::bulk_transfer::{BulkOutcome, BulkTransferLane};
use chan_server::metrics::{Runtime, Sample};
use std::time::{Duration, Instant};

fn wait_for(runtime: &Runtime, predicate: impl Fn(&Sample) -> bool) -> Sample {
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        if let Some(sample) = runtime.view(false, None).latest {
            if predicate(&sample) {
                return sample;
            }
        }
        assert!(
            Instant::now() < deadline,
            "collector did not observe transition"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[tokio::test]
async fn collected_transfer_counts_follow_admission_cancellation_and_completion() {
    let home = tempfile::tempdir().unwrap();
    let runtime = Runtime::start(home.path().into()).unwrap();
    let lane = BulkTransferLane::new();
    let tenant = lane.tenant();
    let (release_a, held_a) = std::sync::mpsc::channel();
    let (release_b, held_b) = std::sync::mpsc::channel();
    let a = tenant.submit(move |_| held_a.recv()).unwrap();
    let b = tenant.submit(move |_| held_b.recv()).unwrap();
    wait_for(&runtime, |s| s.transfers.running == 2);
    let queued = tenant.submit(|_| panic!("cancelled job ran")).unwrap();
    wait_for(&runtime, |s| {
        s.transfers.queued == 1 && s.transfers.running == 2
    });
    queued.cancel();
    assert!(matches!(queued.outcome().await, BulkOutcome::Cancelled));
    wait_for(&runtime, |s| {
        s.transfers.cancelled == 1 && s.transfers.queued == 0
    });
    release_a.send(()).unwrap();
    release_b.send(()).unwrap();
    assert!(matches!(a.outcome().await, BulkOutcome::Done(Ok(()))));
    assert!(matches!(b.outcome().await, BulkOutcome::Done(Ok(()))));
    let sample = wait_for(&runtime, |s| {
        s.transfers.finished == 2 && s.transfers.running == 0
    });
    assert_eq!(sample.transfers.cancelled, 1);
    assert_eq!(sample.transfers.panicked, 0);
}
