//! Lifecycle locks keyed by what they serialize: a workspace's canonical root
//! for the host, a mount prefix for the devserver.
//!
//! A mount, close or remove holds its root's lock across the workspace open,
//! the tenant build, the release budget and the filesystem hops behind them,
//! so it may wait a long time on a slow or hung root. Keying the lock by root
//! confines that wait to callers of the same root. The devserver keys its
//! mount attempts by prefix the same way, for the same reason.

use std::borrow::Borrow;
use std::collections::HashMap;
use std::hash::Hash;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError, Weak};

use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

/// One asynchronous mutex per key, so the calls on one key serialize with
/// each other and never with another key's.
///
/// An entry is a `Weak` to its key's mutex, and every caller waiting on or
/// holding that mutex keeps an `Arc` to it. A caller shares the live mutex
/// when one exists and inserts a fresh one only when no `Arc` is left, which
/// means nobody holds or waits on the old one, so pruning never hands two
/// callers different mutexes for one key. The last guard of a key removes
/// its entry, and every lookup prunes the entries a cancelled waiter left
/// behind, so the map holds only keys with a caller in flight.
///
/// The entry map's own mutex is a leaf: held only to look up, insert or
/// prune an entry, never across an await and never while another lock is
/// taken or released.
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

/// The host's registration locks, one per canonical workspace root.
///
/// The key is the root's canonical key, computed off the runtime thread
/// before the lock is awaited, so two spellings of one root share a mutex,
/// and a caller whose root hangs while its key is computed holds no lock.
///
/// Lock order: a caller holds at most one root lock. The only lock it may
/// already hold when it takes one is the devserver's mount-attempt lock for
/// that root's prefix (below). Every other lock on its path is taken after
/// the root lock: the routing map, the mount-state map, the overlay's and
/// the window registry's data and save locks, and the library's registry
/// mutex. Those are taken and released while the root lock is held and
/// none is held while a root lock is awaited.
///
/// The devserver's mount-attempt locks, a [`KeyedLocks`] by prefix, sit
/// above the root locks: an attempt holds its prefix's lock across its
/// intent checks, the host's mount of that prefix's root, which takes and
/// releases the root lock, and the cleanup of a stale completion, whose
/// removal takes the root lock again. An attempt holds at most one prefix
/// lock, and nothing that holds a root lock takes a prefix lock.
pub(crate) type RootLocks = KeyedLocks<PathBuf>;

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::Future;
    use std::path::Path;
    use std::pin::Pin;
    use std::task::Poll;

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
}
