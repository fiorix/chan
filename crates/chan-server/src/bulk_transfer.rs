//! Process-owned admission for bulk transfer work.
//!
//! Bulk transfers must never draw from the blocking pool that editor saves and
//! terminal spawns queue on, so this lane owns dedicated threads instead. The
//! bound is server-side on purpose: a browser, a second window, `curl`, MCP,
//! and a shell inside a chan terminal all reach the same allocation, so no
//! client can widen it by not asking.
//!
//! Ownership is split in two because a queued job can capture a handle to the
//! lane it is queued on. [`BulkTransferLane`] is the lifecycle object and owns
//! the worker threads; [`BulkTransferTenant`] is the job-visible handle and can
//! reach neither. Without that split, `BulkTransferLane -> SharedLane ->
//! WorkItem -> BulkTransferTenant -> BulkTransferLane` closes a cycle, and the
//! last owner can drop on a worker thread that is then asked to join itself.

use std::collections::VecDeque;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::JoinHandle;

use tokio::sync::oneshot;

/// Bulk jobs executing at once, and therefore the worker-thread count.
pub const ACTIVE_CAPACITY: usize = 2;

/// Jobs allowed to wait behind the active set, process-wide.
pub const WAITING_CAPACITY: usize = 32;

/// `Retry-After` seconds carried by a refusal at the bound.
pub const RETRY_AFTER_SECS: u64 = 1;

/// Explicit blocking-thread ceiling for repository-owned multithread runtimes
/// that can execute transfer work. Tokio's default is 512, which is a pool
/// large enough to make the isolation this lane provides meaningless: the
/// point of a dedicated lane is that bulk work cannot expand into the threads
/// interactive work needs.
pub const MAX_BLOCKING_THREADS: usize = 32;

/// Opaque per-tenant identity. Deliberately carries no workspace path, window
/// id, or user-facing name: it exists so one tenant's queue positions can be
/// computed without any tenant learning that another exists.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct TenantId(u64);

/// Refusal at the bound. Routes render this as HTTP 503 with `Retry-After`.
#[derive(Debug, PartialEq, Eq)]
pub struct BulkFull;

impl BulkFull {
    /// Seconds a refused caller should wait before retrying.
    pub fn retry_after_secs(&self) -> u64 {
        RETRY_AFTER_SECS
    }
}

impl axum::response::IntoResponse for BulkFull {
    /// 503 rather than 429: the machine is saturated, not the caller. The
    /// rendering lives with the policy so every transfer route refuses
    /// identically and no route can invent its own status or retry hint.
    fn into_response(self) -> axum::response::Response {
        (
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            [(
                axum::http::header::RETRY_AFTER,
                self.retry_after_secs().to_string(),
            )],
            axum::Json(serde_json::json!({
                "error": "too many transfers in progress; retry shortly"
            })),
        )
            .into_response()
    }
}

/// What a submitted job produced.
#[derive(Debug, PartialEq, Eq)]
pub enum BulkOutcome<T> {
    Done(T),
    /// The job was cancelled, shut down, or panicked. Callers cannot
    /// distinguish those, and should not: all three mean no result exists.
    Cancelled,
}

/// Cooperative cancellation signal handed to a running job. Bulk work is
/// chunked, so a job checks this between chunks rather than being killed.
///
/// Cloneable because the check usually happens inside a writer or reader the
/// job hands to a library, not in the job closure itself.
#[derive(Clone)]
pub struct BulkCancel(Arc<AtomicBool>);

impl BulkCancel {
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// Delivery of one job's result, deferred so the worker can release its slot
/// and promote queued work before running it.
type BulkCompletion = Box<dyn FnOnce() + Send + 'static>;

type WorkFn = Box<dyn FnOnce(&BulkCancel) -> BulkCompletion + Send + 'static>;

struct QueuedJob {
    id: u64,
    tenant: TenantId,
    cancel: Arc<AtomicBool>,
    work: WorkFn,
}

struct ActiveJob {
    id: u64,
    cancel: Arc<AtomicBool>,
}

struct LaneInner {
    queue: VecDeque<QueuedJob>,
    active: Vec<ActiveJob>,
    shutdown: bool,
    next_id: u64,
}

/// Admission state shared by the lifecycle owner, the tenants, and the
/// workers. Holds no thread handle, which is what keeps a captured tenant from
/// reaching the join set.
struct SharedLane {
    inner: Mutex<LaneInner>,
    wake: Condvar,
}

impl SharedLane {
    /// A poisoned admission lock is recoverable: the guarded state is a queue
    /// and a counter, and every panic path that could poison it leaves both
    /// structurally intact. Refusing to admit transfers for the rest of the
    /// process lifetime would be the worse failure.
    fn lock(&self) -> MutexGuard<'_, LaneInner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Rank of `id` among `tenant`'s own waiting jobs, 1-based. `None` once the
    /// job is active or finished. Sibling tenants are not counted, so a caller
    /// cannot infer that any other tenant is transferring.
    fn tenant_position(&self, tenant: TenantId, id: u64) -> Option<usize> {
        let inner = self.lock();
        let mut rank = 0;
        for job in &inner.queue {
            if job.tenant != tenant {
                continue;
            }
            rank += 1;
            if job.id == id {
                return Some(rank);
            }
        }
        None
    }

    /// Cancel by id wherever the job currently is. Removing a queued job frees
    /// its waiting slot immediately, which is what lets a client that gave up
    /// return capacity instead of holding it until a worker reaches it.
    fn cancel(&self, id: u64) {
        let mut inner = self.lock();
        if let Some(pos) = inner.queue.iter().position(|job| job.id == id) {
            if let Some(job) = inner.queue.remove(pos) {
                job.cancel.store(true, Ordering::SeqCst);
            }
        }
        if let Some(job) = inner.active.iter().find(|job| job.id == id) {
            job.cancel.store(true, Ordering::SeqCst);
        }
        self.wake.notify_all();
    }
}

/// A tenant's admission handle. Cloning it is cheap and non-owning with
/// respect to lane lifetime: dropping every clone does not stop the process
/// lane, and holding one does not keep it alive.
#[derive(Clone)]
pub struct BulkTransferTenant {
    shared: Arc<SharedLane>,
    tenant: TenantId,
}

impl BulkTransferTenant {
    /// Submit bulk work. One call consumes one admission whether or not the
    /// job runs, so a refusal happens before any large body is read.
    pub fn submit<T, F>(&self, job: F) -> Result<BulkJob<T>, BulkFull>
    where
        F: FnOnce(&BulkCancel) -> T + Send + 'static,
        T: Send + 'static,
    {
        let mut inner = self.shared.lock();
        // A shutting-down lane has already drained its queue, so accepting
        // here would park the caller on a result no worker will ever deliver.
        // Refusing with the same retry shape is truthful: the transfer did not
        // run and retrying against the next process is the correct action.
        if inner.shutdown
            || inner.active.len() + inner.queue.len() >= ACTIVE_CAPACITY + WAITING_CAPACITY
        {
            return Err(BulkFull);
        }

        let id = inner.next_id;
        inner.next_id += 1;
        let cancel = Arc::new(AtomicBool::new(false));
        let (tx, rx) = oneshot::channel();

        let cancel_at_completion = cancel.clone();
        let work: WorkFn = Box::new(move |signal| {
            let value = job(signal);
            Box::new(move || {
                // Cancellation observed during the work still reports
                // Cancelled: a job that returned early holds a partial value
                // its caller must not mistake for a completed transfer.
                let outcome = if cancel_at_completion.load(Ordering::SeqCst) {
                    BulkOutcome::Cancelled
                } else {
                    BulkOutcome::Done(value)
                };
                let _ = tx.send(outcome);
            }) as BulkCompletion
        });

        inner.queue.push_back(QueuedJob {
            id,
            tenant: self.tenant,
            cancel: cancel.clone(),
            work,
        });
        drop(inner);
        self.shared.wake.notify_all();

        Ok(BulkJob {
            id,
            tenant: self.tenant,
            shared: self.shared.clone(),
            rx: Some(rx),
        })
    }
}

/// A submitted job's handle. Dropping it cancels the job, which is what makes
/// a dropped request or an abandoned response release admission rather than
/// holding a worker until the transfer finishes for nobody.
pub struct BulkJob<T> {
    id: u64,
    tenant: TenantId,
    shared: Arc<SharedLane>,
    rx: Option<oneshot::Receiver<BulkOutcome<T>>>,
}

impl<T> BulkJob<T> {
    /// Rank among this tenant's waiting jobs, 1-based; `None` once running.
    pub fn position(&self) -> Option<usize> {
        self.shared.tenant_position(self.tenant, self.id)
    }

    /// Cancel without waiting for the outcome.
    pub fn cancel(&self) {
        self.shared.cancel(self.id);
    }

    /// Await the outcome. A dropped sender means the job was drained at
    /// shutdown or unwound, both of which are reported as `Cancelled`.
    pub async fn outcome(mut self) -> BulkOutcome<T> {
        match self.rx.take() {
            Some(rx) => rx.await.unwrap_or(BulkOutcome::Cancelled),
            None => BulkOutcome::Cancelled,
        }
    }

    /// Blocking form of [`BulkJob::outcome`], for callers that are not on an
    /// async runtime.
    pub fn wait(mut self) -> BulkOutcome<T> {
        match self.rx.take() {
            Some(rx) => rx.blocking_recv().unwrap_or(BulkOutcome::Cancelled),
            None => BulkOutcome::Cancelled,
        }
    }
}

impl<T> Drop for BulkJob<T> {
    fn drop(&mut self) {
        // Cheap and idempotent once the job has finished: the id is no longer
        // in either collection, so this is a lookup that finds nothing.
        self.shared.cancel(self.id);
    }
}

/// The process-owned lane: the lifecycle object and the sole owner of the
/// worker threads. Exactly one exists per hosted process and per standalone
/// serve. Dropping the last owner shuts the lane down.
pub struct BulkTransferLane {
    shared: Arc<SharedLane>,
    workers: Vec<JoinHandle<()>>,
    next_tenant: Mutex<u64>,
}

impl BulkTransferLane {
    /// Allocate the lane and start its workers.
    pub fn new() -> Arc<Self> {
        let shared = Arc::new(SharedLane {
            inner: Mutex::new(LaneInner {
                queue: VecDeque::new(),
                active: Vec::new(),
                shutdown: false,
                next_id: 1,
            }),
            wake: Condvar::new(),
        });

        let mut workers = Vec::with_capacity(ACTIVE_CAPACITY);
        for index in 0..ACTIVE_CAPACITY {
            let worker_shared = shared.clone();
            let handle = std::thread::Builder::new()
                .name(format!("chan-bulk-transfer-{index}"))
                .spawn(move || worker_main(worker_shared))
                .expect("spawn bulk transfer worker");
            workers.push(handle);
        }

        Arc::new(Self {
            shared,
            workers,
            next_tenant: Mutex::new(1),
        })
    }

    /// Mint one tenant handle over this lane. Distinct tenants share the
    /// global FIFO but see only their own positions.
    pub fn tenant(&self) -> BulkTransferTenant {
        let mut next = self.next_tenant.lock().unwrap_or_else(|e| e.into_inner());
        let tenant = TenantId(*next);
        *next += 1;
        BulkTransferTenant {
            shared: self.shared.clone(),
            tenant,
        }
    }
}

impl Drop for BulkTransferLane {
    fn drop(&mut self) {
        {
            let mut inner = self.shared.lock();
            inner.shutdown = true;
            for job in &inner.active {
                job.cancel.store(true, Ordering::SeqCst);
            }
            // Dropping the queued work drops each job's result sender, so a
            // waiting caller observes Cancelled instead of hanging on a
            // transfer that will never start.
            inner.queue.clear();
        }
        self.shared.wake.notify_all();
        for handle in self.workers.drain(..) {
            let _ = handle.join();
        }
    }
}

fn worker_main(shared: Arc<SharedLane>) {
    loop {
        let job = {
            let mut inner = shared.lock();
            loop {
                if inner.shutdown {
                    return;
                }
                if inner.active.len() < ACTIVE_CAPACITY {
                    if let Some(job) = inner.queue.pop_front() {
                        inner.active.push(ActiveJob {
                            id: job.id,
                            cancel: job.cancel.clone(),
                        });
                        break job;
                    }
                }
                inner = shared.wake.wait(inner).unwrap_or_else(|e| e.into_inner());
            }
        };

        let id = job.id;
        let signal = BulkCancel(job.cancel.clone());
        let work = job.work;
        // First boundary: a panicking transfer must not take the worker with
        // it, or one bad job would permanently halve the lane.
        let completion = catch_unwind(AssertUnwindSafe(move || work(&signal)));

        // Release the slot and wake a waiting worker BEFORE delivering, so a
        // slow or panicking delivery cannot hold capacity that queued work is
        // waiting on.
        {
            let mut inner = shared.lock();
            inner.active.retain(|active| active.id != id);
        }
        shared.wake.notify_all();

        // Second boundary: delivery drops the result value when the receiver
        // is gone, and a user value with a panicking destructor would
        // otherwise unwind on the worker after its slot was already released.
        if let Ok(completion) = completion {
            let _ = catch_unwind(AssertUnwindSafe(completion));
        }
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    //! Standalone cancellation signals, so a route's writer or reader can be
    //! unit-tested at its own seam without admitting a job to reach one.

    use super::*;

    pub(crate) fn uncancelled() -> BulkCancel {
        BulkCancel(Arc::new(AtomicBool::new(false)))
    }

    pub(crate) fn cancelled() -> BulkCancel {
        BulkCancel(Arc::new(AtomicBool::new(true)))
    }

    /// A tenant on its OWN lane. Tests that saturate admission must not use
    /// the shared test lane: filling it would refuse admission for every other
    /// test running at the same time. The returned lane must stay in scope for
    /// the test's life; dropping it shuts the workers down.
    pub(crate) fn isolated_tenant() -> (Arc<BulkTransferLane>, BulkTransferTenant) {
        let lane = BulkTransferLane::new();
        let tenant = lane.tenant();
        (lane, tenant)
    }

    /// Hold every admission slot on `tenant`'s lane. Dropping the returned
    /// senders releases the held jobs.
    pub(crate) fn saturate_admission(
        tenant: &BulkTransferTenant,
    ) -> (Vec<std::sync::mpsc::Sender<()>>, Vec<BulkJob<()>>) {
        let mut releases = Vec::new();
        let mut held = Vec::new();
        for _ in 0..(ACTIVE_CAPACITY + WAITING_CAPACITY) {
            let (release, park) = std::sync::mpsc::channel::<()>();
            releases.push(release);
            held.push(
                tenant
                    .submit(move |_| {
                        let _ = park.recv();
                    })
                    .expect("within the process budget"),
            );
        }
        (releases, held)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    /// A job that parks until released, so a test can hold a worker for as
    /// long as it needs without sleeping.
    fn gate() -> (mpsc::Sender<()>, impl FnOnce(&BulkCancel) + Send + 'static) {
        let (tx, rx) = mpsc::channel::<()>();
        (tx, move |_: &BulkCancel| {
            let _ = rx.recv();
        })
    }

    /// Hold both workers and return the releases plus a signal proving each
    /// job actually started.
    fn saturate(lane: &BulkTransferLane) -> (Vec<mpsc::Sender<()>>, Vec<BulkJob<()>>) {
        let tenant = lane.tenant();
        let mut releases = Vec::new();
        let mut jobs = Vec::new();
        let (started_tx, started_rx) = mpsc::channel();
        for _ in 0..ACTIVE_CAPACITY {
            let (release, park) = gate();
            let started = started_tx.clone();
            releases.push(release);
            jobs.push(
                tenant
                    .submit(move |cancel| {
                        let _ = started.send(());
                        park(cancel);
                    })
                    .expect("submit within capacity"),
            );
        }
        for _ in 0..ACTIVE_CAPACITY {
            started_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("both workers pick up work");
        }
        (releases, jobs)
    }

    #[test]
    fn two_jobs_run_while_the_third_waits_at_position_one() {
        let lane = BulkTransferLane::new();
        let (releases, _active) = saturate(&lane);
        let tenant = lane.tenant();

        let third = tenant.submit(|_| ()).expect("third is admitted");
        assert_eq!(third.position(), Some(1));

        drop(releases);
        assert_eq!(third.wait(), BulkOutcome::Done(()));
    }

    #[test]
    fn waiting_positions_run_one_through_thirty_two() {
        let lane = BulkTransferLane::new();
        let (_releases, _active) = saturate(&lane);
        let tenant = lane.tenant();

        let waiting: Vec<_> = (0..WAITING_CAPACITY)
            .map(|_| tenant.submit(|_| ()).expect("within waiting capacity"))
            .collect();

        let positions: Vec<_> = waiting.iter().map(|job| job.position()).collect();
        let expected: Vec<_> = (1..=WAITING_CAPACITY).map(Some).collect();
        assert_eq!(positions, expected);
    }

    #[test]
    fn the_thirty_fifth_submission_is_refused_with_a_retry_hint() {
        let lane = BulkTransferLane::new();
        let (_releases, _active) = saturate(&lane);
        let tenant = lane.tenant();

        let _waiting: Vec<_> = (0..WAITING_CAPACITY)
            .map(|_| tenant.submit(|_| ()).expect("within waiting capacity"))
            .collect();

        let refused = match tenant.submit(|_| ()) {
            Ok(_) => panic!("the lane admitted work beyond its bound"),
            Err(full) => full,
        };
        assert_eq!(refused, BulkFull);
        assert_eq!(refused.retry_after_secs(), 1);
    }

    #[test]
    fn a_refusal_does_not_consume_capacity() {
        let lane = BulkTransferLane::new();
        let (releases, _active) = saturate(&lane);
        let tenant = lane.tenant();

        let waiting: Vec<_> = (0..WAITING_CAPACITY)
            .map(|_| tenant.submit(|_| ()).expect("within waiting capacity"))
            .collect();
        assert!(tenant.submit(|_| ()).is_err());

        // The refused submission must not have displaced a queued job or taken
        // a slot of its own: the survivors keep their exact ranks.
        let positions: Vec<_> = waiting.iter().map(|job| job.position()).collect();
        let expected: Vec<_> = (1..=WAITING_CAPACITY).map(Some).collect();
        assert_eq!(positions, expected);
        drop(releases);
    }

    #[test]
    fn queued_work_is_promoted_in_global_fifo_order() {
        let lane = BulkTransferLane::new();
        let (mut releases, _active) = saturate(&lane);
        // Two tenants interleave, so this pins GLOBAL order rather than any
        // per-tenant order.
        let first = lane.tenant();
        let second = lane.tenant();
        let (order_tx, order_rx) = mpsc::channel();

        let mut queued = Vec::new();
        for index in 0..6 {
            let tenant = if index % 2 == 0 { &first } else { &second };
            let tx = order_tx.clone();
            queued.push(
                tenant
                    .submit(move |_| {
                        let _ = tx.send(index);
                    })
                    .expect("within capacity"),
            );
        }
        drop(order_tx);

        // Release exactly ONE worker and keep the other held. Two workers
        // draining concurrently would let a later job report before an
        // earlier one, which pins send order rather than dequeue order and
        // fails under load rather than on a real regression.
        drop(releases.pop().expect("a held worker to release"));
        for job in queued {
            let _ = job.wait();
        }

        let observed: Vec<i32> = order_rx.iter().collect();
        assert_eq!(observed, vec![0, 1, 2, 3, 4, 5]);
        drop(releases);
    }

    #[test]
    fn positions_do_not_disclose_sibling_tenants() {
        let lane = BulkTransferLane::new();
        let (_releases, _active) = saturate(&lane);
        let loud = lane.tenant();
        let quiet = lane.tenant();

        let _crowd: Vec<_> = (0..10)
            .map(|_| loud.submit(|_| ()).expect("within capacity"))
            .collect();
        let only = quiet.submit(|_| ()).expect("within capacity");

        // Eleven jobs are queued ahead-or-alongside, but this tenant has
        // exactly one, so it must see rank 1 and learn nothing else.
        assert_eq!(only.position(), Some(1));
    }

    #[test]
    fn cancelling_queued_work_frees_capacity_and_refreshes_positions() {
        let lane = BulkTransferLane::new();
        let (releases, _active) = saturate(&lane);
        let tenant = lane.tenant();

        let first = tenant.submit(|_| ()).expect("within capacity");
        let second = tenant.submit(|_| ()).expect("within capacity");
        let third = tenant.submit(|_| ()).expect("within capacity");
        assert_eq!(second.position(), Some(2));
        assert_eq!(third.position(), Some(3));

        first.cancel();
        assert_eq!(first.position(), None);
        assert_eq!(second.position(), Some(1));
        assert_eq!(third.position(), Some(2));
        assert_eq!(first.wait(), BulkOutcome::Cancelled);

        drop(releases);
    }

    #[test]
    fn dropping_a_queued_handle_removes_it_without_running_it() {
        let lane = BulkTransferLane::new();
        let (releases, _active) = saturate(&lane);
        let tenant = lane.tenant();
        let (ran_tx, ran_rx) = mpsc::channel();

        let abandoned = tenant
            .submit(move |_| {
                let _ = ran_tx.send(());
            })
            .expect("within capacity");
        let follower = tenant.submit(|_| ()).expect("within capacity");
        assert_eq!(follower.position(), Some(2));

        drop(abandoned);
        assert_eq!(follower.position(), Some(1));

        drop(releases);
        assert_eq!(follower.wait(), BulkOutcome::Done(()));
        assert!(
            ran_rx.recv_timeout(Duration::from_millis(200)).is_err(),
            "a dropped queued job must never execute"
        );
    }

    #[test]
    fn explicit_active_cancellation_releases_a_saturated_slot() {
        let lane = BulkTransferLane::new();
        let tenant = lane.tenant();
        let (started_tx, started_rx) = mpsc::channel();

        // Both workers held: one cooperatively cancellable, one inert. The
        // probe can only run if the CANCELLED slot is released, because the
        // other worker stays held for the whole test.
        let (held_release, held_park) = gate();
        let held_started = started_tx.clone();
        let _held = tenant
            .submit(move |cancel| {
                let _ = held_started.send(());
                held_park(cancel);
            })
            .expect("within capacity");

        let cancellable_started = started_tx.clone();
        let (observed_tx, observed_rx) = mpsc::channel();
        let cancellable = tenant
            .submit(move |cancel| {
                let _ = cancellable_started.send(());
                while !cancel.is_cancelled() {
                    std::thread::yield_now();
                }
                let _ = observed_tx.send(());
            })
            .expect("within capacity");

        started_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("first job starts");
        started_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("second job starts");

        let (probe_tx, probe_rx) = mpsc::channel();
        let probe = tenant
            .submit(move |_| {
                let _ = probe_tx.send(());
            })
            .expect("within capacity");
        assert_eq!(probe.position(), Some(1));

        cancellable.cancel();
        observed_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("the active job observes cancellation");
        probe_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("the freed slot promotes the queued probe");
        assert_eq!(cancellable.wait(), BulkOutcome::Cancelled);

        drop(held_release);
    }

    #[test]
    fn dropping_an_active_handle_releases_a_saturated_slot() {
        let lane = BulkTransferLane::new();
        let tenant = lane.tenant();
        let (started_tx, started_rx) = mpsc::channel();

        let (held_release, held_park) = gate();
        let held_started = started_tx.clone();
        let _held = tenant
            .submit(move |cancel| {
                let _ = held_started.send(());
                held_park(cancel);
            })
            .expect("within capacity");

        let owner_started = started_tx.clone();
        let owner = tenant
            .submit(move |cancel| {
                let _ = owner_started.send(());
                while !cancel.is_cancelled() {
                    std::thread::yield_now();
                }
            })
            .expect("within capacity");

        started_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("first job starts");
        started_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("second job starts");

        let (probe_tx, probe_rx) = mpsc::channel();
        let probe = tenant
            .submit(move |_| {
                let _ = probe_tx.send(());
            })
            .expect("within capacity");
        assert_eq!(probe.position(), Some(1));

        // Dropping the response owner is the path a disconnected browser
        // takes; it must drive the same cancellation as an explicit call.
        drop(owner);
        probe_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("owner drop frees the active slot");

        drop(held_release);
    }

    #[test]
    fn a_panicking_job_leaves_the_worker_serving() {
        let lane = BulkTransferLane::new();
        let tenant = lane.tenant();

        let exploded = tenant
            .submit(|_| panic!("bulk job panic under test"))
            .expect("within capacity");
        assert_eq!(exploded.wait(), BulkOutcome::Cancelled);

        // Sequential follow-up work would prove nothing: a surviving worker
        // serves it all while the other is dead. Requiring both workers to
        // hold a job at once is what actually detects a lost worker.
        let (releases, _held) = saturate(&lane);
        drop(releases);

        let later = tenant.submit(|_| 7u8).expect("within capacity");
        assert_eq!(later.wait(), BulkOutcome::Done(7));
    }

    #[test]
    fn a_panicking_result_destructor_leaves_the_worker_serving() {
        struct PanicsOnDrop;
        impl Drop for PanicsOnDrop {
            fn drop(&mut self) {
                panic!("result destructor panic under test");
            }
        }

        let lane = BulkTransferLane::new();
        let tenant = lane.tenant();

        // The job must already be RUNNING when the receiver closes. Dropping
        // the handle while the job is still queued just removes it from the
        // queue, so the value is never constructed and the delivery path is
        // never exercised.
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let doomed = tenant
            .submit(move |_| {
                let _ = started_tx.send(());
                let _ = release_rx.recv();
                PanicsOnDrop
            })
            .expect("within capacity");
        started_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("the doomed job starts");

        // Closes the result receiver under a running job, so delivery has to
        // drop the returned value on the worker.
        drop(doomed);
        let _ = release_tx.send(());

        // Both workers must still hold a job at once. A sequential probe
        // would be served by whichever worker survived and would pass even
        // with the delivery boundary removed.
        let (releases, _held) = saturate(&lane);
        drop(releases);

        let later = tenant.submit(|_| 9u8).expect("within capacity");
        assert_eq!(later.wait(), BulkOutcome::Done(9));
    }

    #[test]
    fn the_bound_is_shared_across_tenants_of_one_lane() {
        let lane = BulkTransferLane::new();
        let (_releases, _active) = saturate(&lane);
        let first = lane.tenant();
        let second = lane.tenant();

        // One tenant fills the waiting capacity; a DIFFERENT tenant is then
        // refused. The bound is a property of the process, not of a tenant,
        // which is what stops a second window or a second workspace from
        // doubling the machine's transfer load.
        let _filled: Vec<_> = (0..WAITING_CAPACITY)
            .map(|_| first.submit(|_| ()).expect("within waiting capacity"))
            .collect();
        assert!(
            second.submit(|_| ()).is_err(),
            "a sibling tenant must not get its own admission budget"
        );
    }

    #[test]
    fn separate_lanes_hold_independent_bounds() {
        let first_lane = BulkTransferLane::new();
        let second_lane = BulkTransferLane::new();
        let (_first_releases, _first_active) = saturate(&first_lane);
        let first = first_lane.tenant();
        let second = second_lane.tenant();

        let _filled: Vec<_> = (0..WAITING_CAPACITY)
            .map(|_| first.submit(|_| ()).expect("within waiting capacity"))
            .collect();
        assert!(first.submit(|_| ()).is_err());

        // A standalone serve builds its own lane, so a saturated hosted
        // process must not refuse work in an unrelated process.
        let independent = second
            .submit(|_| 5u8)
            .expect("a separate lane is unaffected");
        assert_eq!(independent.wait(), BulkOutcome::Done(5));
    }

    #[test]
    fn dropping_a_tenant_clone_does_not_stop_the_lane() {
        let lane = BulkTransferLane::new();
        let tenant = lane.tenant();
        drop(lane.tenant());
        drop(lane.tenant());

        let after = tenant.submit(|_| 3u8).expect("lane still admits work");
        assert_eq!(after.wait(), BulkOutcome::Done(3));
    }

    #[test]
    fn a_captured_tenant_does_not_own_the_lane_lifetime() {
        let lane = BulkTransferLane::new();
        let tenant = lane.tenant();
        let (started_tx, started_rx) = mpsc::channel();

        // The job captures a tenant clone, which is the ownership shape that
        // would close a cycle if a tenant could reach the lifecycle object.
        let captured = tenant.clone();
        let _job = tenant
            .submit(move |cancel| {
                let _ = started_tx.send(());
                while !cancel.is_cancelled() {
                    std::thread::yield_now();
                }
                drop(captured);
            })
            .expect("within capacity");
        started_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("job starts");

        assert_eq!(
            Arc::strong_count(&lane),
            1,
            "an in-flight job must not hold an owning reference to the lane"
        );
    }

    #[test]
    fn the_final_owner_cancels_active_work_drains_the_queue_and_joins() {
        let lane = BulkTransferLane::new();
        let tenant = lane.tenant();
        let (started_tx, started_rx) = mpsc::channel();
        let (never_ran_tx, never_ran_rx) = mpsc::channel();

        let mut active = Vec::new();
        for _ in 0..ACTIVE_CAPACITY {
            let started = started_tx.clone();
            active.push(
                tenant
                    .submit(move |cancel| {
                        let _ = started.send(());
                        while !cancel.is_cancelled() {
                            std::thread::yield_now();
                        }
                    })
                    .expect("within capacity"),
            );
        }
        for _ in 0..ACTIVE_CAPACITY {
            started_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("both workers busy");
        }

        let queued = tenant
            .submit(move |_| {
                let _ = never_ran_tx.send(());
            })
            .expect("within capacity");
        assert_eq!(queued.position(), Some(1));

        // Shut down from a bounded thread: a hang here is a self-join, which
        // is the failure this whole ownership split exists to prevent.
        let (done_tx, done_rx) = mpsc::channel();
        std::thread::spawn(move || {
            drop(lane);
            let _ = done_tx.send(());
        });
        done_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("final owner drop shuts down and joins both workers");

        for job in active {
            assert_eq!(job.wait(), BulkOutcome::Cancelled);
        }
        assert_eq!(queued.wait(), BulkOutcome::Cancelled);
        assert!(
            never_ran_rx
                .recv_timeout(Duration::from_millis(200))
                .is_err(),
            "queued work must be drained, not executed, at shutdown"
        );
    }

    #[test]
    fn workers_carry_their_documented_names() {
        let lane = BulkTransferLane::new();
        let tenant = lane.tenant();
        let (name_tx, name_rx) = mpsc::channel();

        // Saturate so both workers report, not just whichever is idle first.
        let mut jobs = Vec::new();
        let barrier = Arc::new(std::sync::Barrier::new(ACTIVE_CAPACITY));
        for _ in 0..ACTIVE_CAPACITY {
            let tx = name_tx.clone();
            let barrier = barrier.clone();
            jobs.push(
                tenant
                    .submit(move |_| {
                        let name = std::thread::current().name().map(str::to_string);
                        let _ = tx.send(name);
                        barrier.wait();
                    })
                    .expect("within capacity"),
            );
        }
        drop(name_tx);
        for job in jobs {
            let _ = job.wait();
        }

        let mut names: Vec<String> = name_rx.iter().flatten().collect();
        names.sort();
        assert_eq!(
            names,
            vec![
                "chan-bulk-transfer-0".to_string(),
                "chan-bulk-transfer-1".to_string()
            ]
        );
    }

    #[test]
    fn bulk_work_never_reaches_the_ambient_blocking_pool() {
        // Only the production half: this test's own assertion text mentions
        // the pool it forbids, so scanning the whole file matches itself.
        let production = include_str!("bulk_transfer.rs")
            .split("#[cfg(test)]")
            .next()
            .expect("module source has a production half");
        assert!(
            production.contains("fn worker_main"),
            "the production half must be what was scanned"
        );
        assert!(
            !production.contains("spawn_blocking"),
            "bulk jobs must run on the lane's own threads, not tokio's blocking pool"
        );
        assert!(
            production.contains("std::thread::Builder::new()"),
            "the lane owns dedicated OS threads"
        );
    }
}
