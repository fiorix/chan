//! Caller-owned lifecycle locks and blocking-call permits, keyed by a
//! workspace's canonical root for the host or a mount prefix for the
//! devserver. Key computations share one in-flight answer per spelling.
//!
//! A lifecycle caller keeps its root lock through settlement. The open, its
//! root check, mounted revalidation, a close's or removal's registry lookup,
//! registration and a removal's unregister own call permits, so cancelling
//! a caller releases its root lock while its abandoned work still prevents
//! another call of the same kind. A registered open, registration and a
//! removal wait for their permits at most the open's release budget, an open
//! of a mounted root skips a revalidation already in flight, and a close or
//! removal skips a lookup already in flight. A registered open also waits,
//! inside that budget, for a registry write of its root to return before it
//! reads the registry, and holds that permit across nothing.

use std::borrow::Borrow;
use std::collections::HashMap;
use std::hash::Hash;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError, Weak};

use tokio::sync::{watch, Mutex as AsyncMutex, OwnedMutexGuard};

/// One asynchronous mutex per key. Callers of one key serialize while other
/// keys remain independent. The host uses separate keys for caller-owned
/// lifecycle locks and blocking-call permits; only call permits move into
/// blocking work.
///
/// An entry is a `Weak` to its mutex, and every waiter or holder keeps that
/// mutex alive. A new mutex is inserted only when no holder or waiter remains.
/// The last borrowed guard removes an unused entry; subsequent lookups prune
/// entries left by cancelled waiters or detached guards. The entry-map mutex
/// is a leaf, held only for lookup, insertion or pruning and never across an
/// await or filesystem work.
pub struct KeyedLocks<K: Eq + Hash> {
    entries: Mutex<HashMap<K, Weak<AsyncMutex<()>>>>,
}

impl<K: Eq + Hash> Default for KeyedLocks<K> {
    fn default() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }
}

impl<K: Eq + Hash + Clone> KeyedLocks<K> {
    /// Wait for the lock of `key`.
    pub async fn lock<Q>(&self, key: &Q) -> KeyedLockGuard<'_, K>
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ToOwned<Owned = K> + ?Sized,
    {
        let guard = self.mutex_for(key).lock_owned().await;
        KeyedLockGuard {
            locks: self,
            key: key.to_owned(),
            guard: Some(guard),
        }
    }

    /// The lock of `key` when nobody holds it, without waiting.
    pub(crate) fn try_lock<Q>(&self, key: &Q) -> Option<KeyedLockGuard<'_, K>>
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ToOwned<Owned = K> + ?Sized,
    {
        let guard = self.mutex_for(key).try_lock_owned().ok()?;
        Some(KeyedLockGuard {
            locks: self,
            key: key.to_owned(),
            guard: Some(guard),
        })
    }

    fn mutex_for<Q>(&self, key: &Q) -> Arc<AsyncMutex<()>>
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ToOwned<Owned = K> + ?Sized,
    {
        let mut entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        entries.retain(|_, mutex| mutex.strong_count() > 0);
        if let Some(mutex) = entries.get(key).and_then(Weak::upgrade) {
            return mutex;
        }
        let mutex = Arc::new(AsyncMutex::new(()));
        entries.insert(key.to_owned(), Arc::downgrade(&mutex));
        mutex
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .len()
    }
}

/// One key's lock, held until drop.
pub struct KeyedLockGuard<'a, K: Eq + Hash> {
    locks: &'a KeyedLocks<K>,
    key: K,
    guard: Option<OwnedMutexGuard<()>>,
}

impl<K: Eq + Hash> KeyedLockGuard<'_, K> {
    /// Keep the key locked without borrowing the entry map. The owned guard
    /// keeps its weak entry alive; a lookup prunes it after the guard drops.
    pub(crate) fn into_owned(mut self) -> OwnedMutexGuard<()> {
        self.guard.take().expect("a keyed guard owns its lock")
    }
}

impl<K: Eq + Hash> Drop for KeyedLockGuard<'_, K> {
    fn drop(&mut self) {
        // Release before taking the entry map's mutex, which stays a leaf. A
        // caller that looks the key up in between either shares this mutex,
        // keeping the entry alive, or inserts a fresh one; the check below
        // removes only an entry nobody holds or waits on.
        drop(self.guard.take());
        let mut entries = self
            .locks
            .entries
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if entries
            .get(&self.key)
            .is_some_and(|mutex| mutex.strong_count() == 0)
        {
            entries.remove(&self.key);
        }
    }
}

/// The host's lifecycle locks, one per canonical workspace root.
///
/// The key is the root's canonical key, computed off the runtime thread
/// before the lock is awaited, so two spellings of one root share a mutex,
/// and a caller whose root hangs while its key is computed holds no lock.
///
/// Lock order: a caller holds at most one root lock. The only lock it may
/// already hold when it takes one is the devserver's mount-attempt lock for
/// that root's prefix (below). Every other lock on its path is taken after
/// the root lock: the routing map, the mount-state map, the overlay's and
/// window registry's data and save locks, and the library's registry mutex.
/// Those are taken and released while the root lock is held and none is held
/// while a root lock is awaited. A call permit is also taken after the root
/// lock, but it is not bound to it: a permit whose caller left outlives that
/// caller's root lock. Registration and the public open of an already-open
/// workspace take their permits with no root lock. No permit is held while
/// a root lock is awaited. A registered open holds its mount permit while it
/// awaits the registry-write permit, which closes no cycle: that permit's
/// holder is a blocking registration or unregister, or an open that lets it
/// go at once, and none of them awaits a permit or a lock.
/// The maps of key computations ([`RootKeys`]) and health checks in flight
/// are leaves, held across no await and no filesystem call.
///
/// The devserver's mount-attempt locks, a [`KeyedLocks`] by prefix, sit
/// above the root locks: an attempt holds its prefix's lock across its
/// intent checks, the host's mount of that prefix's root, which takes and
/// releases the root lock, and the cleanup of a stale completion, whose
/// removal takes the root lock again. An attempt holds at most one prefix
/// lock, and nothing that holds a root lock takes a prefix lock.
pub(crate) type RootLocks = KeyedLocks<PathBuf>;

/// Filesystem operations with independent admission for one canonical root.
#[derive(Clone, Copy, Eq, Hash, PartialEq)]
pub(crate) enum RootCall {
    Mount,
    Revalidate,
    Lookup,
    RegistryWrite,
}

/// A permit moves into blocking work and returns with its result. A caller
/// that leaves drops its lifecycle lock; the work keeps this permit until it
/// has dropped its own workspace reference, and references held elsewhere,
/// such as the tasks of a tenant its caller dropped, can outlast it. A mount
/// or registry-write waiter that gets the permit within the open's release
/// budget then dispatches its own call; the revalidation's and the lookup's
/// permits have no waiter, since an open that finds the one held skips the
/// check and a close or removal that finds the other held answers without
/// the row. Registration and a removal's unregister share the registry-write
/// permit, which stays with either blocking call until that call returns. A
/// registered open waits for that permit only to find no write outstanding,
/// and drops it before it dispatches its own call.
pub(crate) type RootCalls = KeyedLocks<(PathBuf, RootCall)>;

/// Canonical root keys computed on the blocking pool, with one computation
/// per spelled path in flight. Concurrent callers of a spelling share its
/// computation and receive cloned answers. A caller that gives up leaves
/// the computation running. Two spellings can each hold a thread because
/// their shared canonical identity is not yet known.
///
/// Completed computations are removed, so later callers resolve afresh.
/// This bound covers key resolution; the host uses separate call permits
/// for its filesystem open, post-build root check, mounted revalidation, a
/// close's or removal's registry lookup, registration and a removal's
/// unregister.
/// The entry-map mutex is held only for lookup, insertion and removal.
#[derive(Default)]
pub(crate) struct RootKeys {
    in_flight: Arc<Mutex<HashMap<PathBuf, watch::Receiver<Option<PathBuf>>>>>,
}

impl RootKeys {
    /// The key `compute` gives `root`, computed on the blocking pool by this
    /// call or by the computation already in flight for the same spelling.
    /// `None` when that computation ended without an answer (it panicked, or
    /// the runtime is shutting down).
    pub(crate) async fn key(
        &self,
        root: &Path,
        compute: impl FnOnce(&Path) -> PathBuf + Send + 'static,
    ) -> Option<PathBuf> {
        let mut answer = self.join_or_start(root, compute);
        let key = answer.wait_for(Option::is_some).await.ok()?;
        key.clone()
    }

    fn join_or_start(
        &self,
        root: &Path,
        compute: impl FnOnce(&Path) -> PathBuf + Send + 'static,
    ) -> watch::Receiver<Option<PathBuf>> {
        let mut in_flight = self
            .in_flight
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        // An entry whose sender is gone belongs to a computation that ended
        // without answering; it is replaced rather than joined.
        if let Some(answer) = in_flight
            .get(root)
            .filter(|answer| answer.has_changed().is_ok())
        {
            return answer.clone();
        }
        let (publish, answer) = watch::channel(None);
        in_flight.insert(root.to_path_buf(), answer.clone());
        let entries = Arc::clone(&self.in_flight);
        let own = answer.clone();
        let spelled = root.to_path_buf();
        // The entry is in the map before the computation can finish and look
        // for it, because the map's mutex is held until this returns.
        tokio::task::spawn_blocking(move || {
            let key = compute(&spelled);
            {
                let mut in_flight = entries.lock().unwrap_or_else(PoisonError::into_inner);
                if in_flight
                    .get(&spelled)
                    .is_some_and(|answer| answer.same_channel(&own))
                {
                    in_flight.remove(&spelled);
                }
            }
            publish.send_replace(Some(key));
        });
        answer
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.in_flight
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::Future;
    use std::path::Path;
    use std::pin::Pin;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::task::Poll;
    use std::time::Duration;

    /// Poll `future` once and report whether it is still pending.
    async fn still_pending<F: Future + Unpin>(future: &mut F) -> bool {
        std::future::poll_fn(|cx| Poll::Ready(Pin::new(&mut *future).poll(cx).is_pending())).await
    }

    #[tokio::test]
    async fn different_roots_take_different_locks() {
        let locks = RootLocks::default();
        let _held = locks.lock(Path::new("/roots/a")).await;
        let mut other = Box::pin(locks.lock(Path::new("/roots/b")));
        assert!(
            !still_pending(&mut other).await,
            "a lock on one root waited on another root's lock"
        );
    }

    #[tokio::test]
    async fn try_lock_takes_a_free_key_and_refuses_a_held_one() {
        let locks = RootLocks::default();
        let key = Path::new("/roots/a");
        let held = locks.try_lock(key).expect("a free key");
        assert!(locks.try_lock(key).is_none(), "a held key was taken twice");
        assert!(
            locks.try_lock(Path::new("/roots/b")).is_some(),
            "a held key refused another key"
        );
        drop(held);
        drop(locks.try_lock(key).expect("a released key"));
        assert_eq!(
            locks.len(),
            0,
            "a guard taken without waiting left its entry"
        );
    }

    #[tokio::test]
    async fn one_root_hands_every_caller_one_lock_until_its_last_guard_drops() {
        let locks = RootLocks::default();
        let key = Path::new("/roots/a");
        let first = locks.lock(key).await;
        let mut second = Box::pin(locks.lock(key));
        assert!(
            still_pending(&mut second).await,
            "a second caller on one root did not wait for the first"
        );
        drop(first);
        let second = second.await;
        let mut third = Box::pin(locks.lock(key));
        assert!(
            still_pending(&mut third).await,
            "a caller got a fresh lock for a root whose lock another caller holds"
        );
        drop(second);
        drop(third.await);
        assert_eq!(
            locks.len(),
            0,
            "the root's last guard left its entry behind"
        );
    }

    #[tokio::test]
    async fn a_cancelled_waiter_leaves_no_entry_behind() {
        let locks = RootLocks::default();
        let key = Path::new("/roots/a");

        let held = locks.lock(key).await;
        let mut waiter = Box::pin(locks.lock(key));
        assert!(still_pending(&mut waiter).await);
        drop(waiter);
        drop(held);
        assert_eq!(
            locks.len(),
            0,
            "the holder's guard kept an entry only a cancelled waiter pointed at"
        );

        let held = locks.lock(key).await;
        let mut waiter = Box::pin(locks.lock(key));
        assert!(still_pending(&mut waiter).await);
        drop(held);
        drop(waiter);
        let _other = locks.lock(Path::new("/roots/b")).await;
        assert_eq!(
            locks.len(),
            1,
            "a lookup kept the entry of a root whose last caller was cancelled"
        );
    }

    #[tokio::test]
    async fn a_detached_guard_keeps_its_key_locked_and_is_pruned_after_drop() {
        let locks = RootLocks::default();
        let key = Path::new("/roots/a");
        let held = locks.lock(key).await.into_owned();
        assert_eq!(locks.len(), 1, "detaching removed a live entry");
        let mut next = Box::pin(locks.lock(key));
        assert!(
            still_pending(&mut next).await,
            "a caller bypassed the detached guard for its key"
        );
        drop(held);
        drop(next.await);
        assert_eq!(locks.len(), 0, "the last caller left its entry behind");

        let held = locks.lock(key).await.into_owned();
        drop(held);
        let other = locks.lock(Path::new("/roots/b")).await;
        assert_eq!(locks.len(), 1, "a lookup kept the dead detached entry");
        drop(other);
        assert_eq!(locks.len(), 0);
    }

    /// Count the computations `compute` stands for, and answer `root`
    /// under `/canonical`.
    fn counting(computed: &Arc<AtomicUsize>) -> impl FnOnce(&Path) -> PathBuf + Send + 'static {
        let computed = Arc::clone(computed);
        move |root| {
            computed.fetch_add(1, Ordering::SeqCst);
            Path::new("/canonical").join(root.strip_prefix("/").unwrap_or(root))
        }
    }

    #[tokio::test]
    async fn one_spelling_shares_the_key_computation_in_flight() {
        let keys = RootKeys::default();
        let root = Path::new("/roots/hung");
        let computed = Arc::new(AtomicUsize::new(0));
        let (entered, started) = std::sync::mpsc::channel();
        let (release, gate) = std::sync::mpsc::channel::<()>();
        let held = counting(&computed);
        let mut first = Box::pin(keys.key(root, move |root| {
            entered.send(()).unwrap();
            gate.recv().unwrap();
            held(root)
        }));
        assert!(still_pending(&mut first).await);
        started
            .recv_timeout(Duration::from_secs(10))
            .expect("the first computation never started");
        let mut second = Box::pin(keys.key(root, counting(&computed)));
        assert!(
            still_pending(&mut second).await,
            "a caller did not wait for the computation in flight for its spelling"
        );
        release.send(()).unwrap();
        let expected = Some(PathBuf::from("/canonical/roots/hung"));
        assert_eq!(first.await, expected);
        assert_eq!(second.await, expected);
        assert_eq!(
            computed.load(Ordering::SeqCst),
            1,
            "two callers of one spelling each computed its key"
        );
        assert_eq!(
            keys.len(),
            0,
            "a finished computation left its entry behind"
        );
    }

    #[tokio::test]
    async fn a_finished_key_computation_is_not_served_again() {
        let keys = RootKeys::default();
        let root = Path::new("/roots/a");
        let computed = Arc::new(AtomicUsize::new(0));
        for _ in 0..2 {
            assert_eq!(
                keys.key(root, counting(&computed)).await,
                Some(PathBuf::from("/canonical/roots/a"))
            );
        }
        assert_eq!(
            computed.load(Ordering::SeqCst),
            2,
            "a key computed earlier was served instead of asked for afresh"
        );
        assert_eq!(
            keys.len(),
            0,
            "a finished computation left its entry behind"
        );
    }

    #[tokio::test]
    async fn a_key_computation_that_ends_without_an_answer_is_replaced() {
        let keys = RootKeys::default();
        let root = Path::new("/roots/a");
        assert_eq!(
            keys.key(root, |_| panic!("the computation ends without an answer"))
                .await,
            None
        );
        let computed = Arc::new(AtomicUsize::new(0));
        assert_eq!(
            keys.key(root, counting(&computed)).await,
            Some(PathBuf::from("/canonical/roots/a")),
            "a caller joined a computation that had ended without an answer"
        );
    }
}
