//! A monotonic clock that keeps counting while the machine sleeps.
//!
//! The protocol timers decide when a session is too old to use and when
//! a peer has gone quiet. `std::time::Instant` stops during suspend on
//! Linux, so after a laptop wakes a stale session would still look fresh
//! and the peer would reject its packets until the timers caught up.
//! Linux reads `CLOCK_BOOTTIME`; macOS and the BSDs have no portable
//! equivalent through this interface and read the monotonic clock; on
//! Windows `std::time::Instant` already counts sleep.

use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct Instant {
    since_epoch: Duration,
}

impl Instant {
    pub(crate) fn now() -> Self {
        #[cfg(test)]
        let since_epoch = platform::now() + test_offset::current();
        #[cfg(not(test))]
        let since_epoch = platform::now();
        Self { since_epoch }
    }

    /// Time from `earlier` to this instant, or zero when `earlier` is later.
    pub(crate) fn duration_since(&self, earlier: Instant) -> Duration {
        self.since_epoch.saturating_sub(earlier.since_epoch)
    }

    pub(crate) fn elapsed(&self) -> Duration {
        Self::now().duration_since(*self)
    }
}

#[cfg(unix)]
mod platform {
    use std::time::Duration;

    #[cfg(any(target_os = "linux", target_os = "android"))]
    const CLOCK: rustix::time::ClockId = rustix::time::ClockId::Boottime;
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    const CLOCK: rustix::time::ClockId = rustix::time::ClockId::Monotonic;

    pub(super) fn now() -> Duration {
        let t = rustix::time::clock_gettime(CLOCK);
        Duration::new(t.tv_sec as u64, t.tv_nsec as u32)
    }
}

#[cfg(windows)]
mod platform {
    use std::sync::OnceLock;
    use std::time::Duration;

    pub(super) fn now() -> Duration {
        static START: OnceLock<std::time::Instant> = OnceLock::new();
        START.get_or_init(std::time::Instant::now).elapsed()
    }
}

/// A per-thread offset the timer tests add to the clock so a rekey or an
/// expiry can be reached without waiting for it.
#[cfg(test)]
mod test_offset {
    use std::cell::Cell;
    use std::time::Duration;

    thread_local! {
        static OFFSET: Cell<Duration> = const { Cell::new(Duration::ZERO) };
    }

    pub(super) fn current() -> Duration {
        OFFSET.with(|offset| offset.get())
    }

    pub(crate) fn advance(by: Duration) {
        OFFSET.with(|offset| offset.set(offset.get() + by));
    }

    /// Resets the offset when dropped, so one test's advance never leaks
    /// into another on the same thread.
    pub(crate) struct Guard;

    impl Drop for Guard {
        fn drop(&mut self) {
            OFFSET.with(|offset| offset.set(Duration::ZERO));
        }
    }
}

#[cfg(test)]
pub(crate) fn advance(by: Duration) {
    test_offset::advance(by);
}

#[cfg(test)]
pub(crate) fn test_offset_guard() -> test_offset::Guard {
    test_offset::Guard
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn now_is_monotonic_and_saturates() {
        let a = Instant::now();
        let b = Instant::now();
        assert!(b >= a);
        assert_eq!(a.duration_since(b), Duration::ZERO);
        assert!(b.duration_since(a) < Duration::from_secs(1));
    }

    #[test]
    fn test_offset_moves_the_clock_and_resets() {
        let a = Instant::now();
        {
            let _guard = test_offset_guard();
            advance(Duration::from_secs(300));
            assert!(a.elapsed() >= Duration::from_secs(300));
        }
        assert!(a.elapsed() < Duration::from_secs(300));
    }
}
