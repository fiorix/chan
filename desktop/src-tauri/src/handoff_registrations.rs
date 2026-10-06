//! The permits `chan serve` handoffs register their paths under.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};

/// The permits of the paths that `chan serve` handoffs register, one per path.
///
/// A handoff's blocking registration owns its path's permit until it returns,
/// also once the handoff that started it has given up at its bound. A path
/// that stops answering in registration therefore holds one thread of the
/// blocking pool however many handoffs name it: a later handoff of the path
/// waits for the permit and starts no registration meanwhile, and a handoff
/// of any other path takes its own permit and waits for none.
///
/// The key is the path as it was sent, normalized lexically, so finding a
/// permit asks no filesystem; two spellings of one directory take two
/// permits. The permit is the desktop's own: it is not the host's
/// registry-write permit, so it orders nothing against the host's own
/// registrations and removals of the root. An entry lives while its permit
/// is held or waited for and is pruned by a later lookup.
#[derive(Default)]
pub(crate) struct HandoffRegistrations {
    permits: Mutex<HashMap<PathBuf, Weak<tokio::sync::Mutex<()>>>>,
    /// How many registrations [`register`](Self::register) has handed to the
    /// blocking pool, counted where it hands one over, so a test reads a
    /// handoff's decision without waiting for a thread to start. The tests
    /// that read it are the Unix handoff tests, so it is built with them.
    #[cfg(all(test, unix))]
    dispatched: std::sync::atomic::AtomicUsize,
}

impl HandoffRegistrations {
    /// Run `registration` on the blocking pool under the permit of `path`
    /// and answer what it returns. The wait for the permit is the caller's
    /// and ends with it: dropping this future while it waits takes nothing
    /// and starts nothing. Once the permit is taken the registration is
    /// handed over in the same poll, and the permit goes with it, so
    /// dropping this future afterwards leaves both with the blocking call
    /// until that call returns.
    pub(crate) async fn register<T: Send + 'static>(
        &self,
        path: &Path,
        registration: impl FnOnce() -> T + Send + 'static,
    ) -> Result<T, tokio::task::JoinError> {
        let permit = self.permit(path).await;
        #[cfg(all(test, unix))]
        self.dispatched
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        tokio::task::spawn_blocking(move || {
            // Released when the path answers, not when the handoff gives up.
            let _permit = permit;
            registration()
        })
        .await
    }

    /// Wait for the permit of `path`. Dropping the wait takes nothing.
    async fn permit(&self, path: &Path) -> tokio::sync::OwnedMutexGuard<()> {
        let key = Self::key(path);
        let permit = {
            let mut permits = self.permits.lock().unwrap();
            permits.retain(|_, permit| permit.strong_count() > 0);
            match permits.get(&key).and_then(Weak::upgrade) {
                Some(permit) => permit,
                None => {
                    let permit = Arc::new(tokio::sync::Mutex::new(()));
                    permits.insert(key, Arc::downgrade(&permit));
                    permit
                }
            }
        };
        permit.lock_owned().await
    }

    /// The key of `path`'s permit: the path as sent, normalized lexically.
    fn key(path: &Path) -> PathBuf {
        chan_workspace::paths::lexical_normalize(&chan_workspace::paths::strip_verbatim_prefix(
            path,
        ))
    }

    /// How many registrations have been handed to the blocking pool.
    #[cfg(all(test, unix))]
    pub(crate) fn dispatched(&self) -> usize {
        self.dispatched.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// How many own `path`'s permit right now: the registration that holds
    /// it and every handoff that waits for it.
    #[cfg(all(test, unix))]
    pub(crate) fn holding_or_waiting(&self, path: &Path) -> usize {
        self.permits
            .lock()
            .unwrap()
            .get(&Self::key(path))
            .map_or(0, Weak::strong_count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The handoff permits go by the path as sent, normalized lexically: a
    /// spelling that normalizes to a held path waits for that path's permit,
    /// another path takes its own, and the next lookup prunes the entries of
    /// permits nobody holds or waits for.
    #[tokio::test]
    async fn handoff_permits_go_by_the_normalized_path_and_are_pruned_once_released() {
        let registrations = HandoffRegistrations::default();
        let entries = || registrations.permits.lock().unwrap().len();
        let held = registrations.permit(Path::new("/roots/a")).await;
        let mut respelled = Box::pin(registrations.permit(Path::new("/roots/x/../a")));
        let waits = std::future::poll_fn(|cx| {
            std::task::Poll::Ready(std::future::Future::poll(respelled.as_mut(), cx).is_pending())
        })
        .await;
        assert!(
            waits,
            "another spelling of a held path took a permit of its own"
        );
        // One poll decides, as for the respelled path: a permit shared with
        // the held path would leave this wait pending for good.
        let mut other = Box::pin(registrations.permit(Path::new("/roots/b")));
        let other = std::future::poll_fn(|cx| {
            std::task::Poll::Ready(match std::future::Future::poll(other.as_mut(), cx) {
                std::task::Poll::Ready(permit) => Some(permit),
                std::task::Poll::Pending => None,
            })
        })
        .await
        .expect("another path waited for a held path's permit");
        assert_eq!(
            entries(),
            2,
            "the entries of two paths, one of them held twice over"
        );
        drop(held);
        let handed_on = respelled.await;
        assert_eq!(
            entries(),
            2,
            "handing a permit to its waiter changed the entries"
        );
        drop(handed_on);
        drop(other);
        drop(registrations.permit(Path::new("/roots/c")).await);
        assert_eq!(
            entries(),
            1,
            "a lookup kept the entries of permits nobody holds or waits for"
        );
    }
}
