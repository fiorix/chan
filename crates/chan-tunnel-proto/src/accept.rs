//! What a TCP accept loop does when `accept(2)` fails.
//!
//! Most accept failures describe one pending connection or a moment
//! of resource pressure, not the listening socket. A loop that
//! returns on them looks, to the service embedding it, exactly like a
//! listener that died, and the tunnel listener and the controller's
//! proxy control listener each take their whole service down when
//! their loop returns. Both loops share this policy so the two cannot
//! drift apart.

use std::future::Future;
use std::io;
use std::time::Duration;

/// How long [`accept_next`] waits after an [`AcceptFailure::Exhausted`]
/// failure. The pending connection stays queued in the kernel, so an
/// immediate retry fails the same way and spins a core. One second is
/// the pause hyper's `AddrIncoming` used and axum's `serve` still
/// uses, which is also what the controller's admin listener does.
pub const ACCEPT_RETRY_PAUSE: Duration = Duration::from_secs(1);

/// The class of one `accept(2)` failure, by what it says about the
/// listening socket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcceptFailure {
    /// One pending connection failed before it was handed over (the
    /// peer reset or aborted, a firewall hook refused it, or Linux
    /// reported a network error already pending on the new socket).
    /// The next accept can proceed at once, and must: pausing here
    /// would let a flood of such connections throttle every other.
    Connection,
    /// The process or the kernel is short of something a new socket
    /// needs (`EMFILE`, `ENFILE`, `ENOBUFS`, `ENOMEM`), which frees up
    /// as other connections close. Also every failure this module does
    /// not recognise: pausing on an unknown error costs a second of
    /// accepts, while retrying it at once could spin forever.
    Exhausted,
    /// The listening socket itself is unusable (`EBADF`, `ENOTSOCK`,
    /// `EINVAL`: not a listening socket; `EFAULT`). No later accept
    /// can succeed, so the loop should end and let its supervisor
    /// replace the service.
    Listener,
}

impl AcceptFailure {
    pub fn classify(error: &io::Error) -> Self {
        #[cfg(unix)]
        if let Some(errno) = error.raw_os_error() {
            if let Some(class) = classify_errno(errno) {
                return class;
            }
        }
        match error.kind() {
            io::ErrorKind::ConnectionAborted
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::ConnectionRefused
            | io::ErrorKind::Interrupted
            | io::ErrorKind::WouldBlock
            | io::ErrorKind::TimedOut
            | io::ErrorKind::PermissionDenied
            | io::ErrorKind::NetworkDown
            | io::ErrorKind::NetworkUnreachable
            | io::ErrorKind::HostUnreachable => Self::Connection,
            _ => Self::Exhausted,
        }
    }
}

/// The errnos `io::ErrorKind` has no stable variant for. Linux's
/// accept(2) page lists the network errors it passes through from the
/// new socket (`ENETDOWN`, `EPROTO`, `ENOPROTOOPT`, `EHOSTDOWN`,
/// `ENONET`, `EHOSTUNREACH`, `EOPNOTSUPP`, `ENETUNREACH`) and says to
/// retry them like `EAGAIN`; `EOPNOTSUPP` is on that list, and its
/// other meaning (not a stream socket) cannot happen to a TCP
/// listener. The errnos that do have a kind fall through to it.
#[cfg(unix)]
fn classify_errno(errno: i32) -> Option<AcceptFailure> {
    match errno {
        libc::EBADF | libc::ENOTSOCK | libc::EINVAL | libc::EFAULT => Some(AcceptFailure::Listener),
        libc::EMFILE | libc::ENFILE | libc::ENOBUFS | libc::ENOMEM => {
            Some(AcceptFailure::Exhausted)
        }
        libc::EPROTO | libc::ENOPROTOOPT | libc::EHOSTDOWN | libc::EOPNOTSUPP => {
            Some(AcceptFailure::Connection)
        }
        #[cfg(any(target_os = "linux", target_os = "android"))]
        libc::ENONET => Some(AcceptFailure::Connection),
        _ => None,
    }
}

/// Accept the next connection, riding out every failure that does not
/// mean the listening socket is gone: an [`AcceptFailure::Connection`]
/// is logged and retried at once, an [`AcceptFailure::Exhausted`] one
/// is logged and retried after [`ACCEPT_RETRY_PAUSE`]. Returns an error
/// only for an [`AcceptFailure::Listener`] failure.
///
/// `accept` is called once per attempt, so a listener passes
/// `|| listener.accept()`. The returned future is cancel-safe whenever
/// `accept`'s futures are, which lets a `select!` arm race it against
/// shutdown without losing a connection.
pub async fn accept_next<A, F, T>(listener: &'static str, mut accept: A) -> io::Result<T>
where
    A: FnMut() -> F,
    F: Future<Output = io::Result<T>>,
{
    loop {
        let error = match accept().await {
            Ok(accepted) => return Ok(accepted),
            Err(error) => error,
        };
        match AcceptFailure::classify(&error) {
            AcceptFailure::Connection => {
                tracing::debug!(listener, %error, "accept failed for one connection");
            }
            AcceptFailure::Exhausted => {
                tracing::error!(
                    listener,
                    %error,
                    pause = ?ACCEPT_RETRY_PAUSE,
                    "accept failed; pausing before the next accept",
                );
                tokio::time::sleep(ACCEPT_RETRY_PAUSE).await;
            }
            AcceptFailure::Listener => return Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::collections::VecDeque;

    #[cfg(unix)]
    #[test]
    fn errnos_classify_by_what_they_say_about_the_listener() {
        let cases = [
            (libc::EMFILE, AcceptFailure::Exhausted),
            (libc::ENFILE, AcceptFailure::Exhausted),
            (libc::ENOBUFS, AcceptFailure::Exhausted),
            (libc::ENOMEM, AcceptFailure::Exhausted),
            (libc::ECONNABORTED, AcceptFailure::Connection),
            (libc::ECONNRESET, AcceptFailure::Connection),
            (libc::EINTR, AcceptFailure::Connection),
            (libc::EAGAIN, AcceptFailure::Connection),
            (libc::EPERM, AcceptFailure::Connection),
            (libc::ETIMEDOUT, AcceptFailure::Connection),
            (libc::ENETDOWN, AcceptFailure::Connection),
            (libc::ENETUNREACH, AcceptFailure::Connection),
            (libc::EHOSTUNREACH, AcceptFailure::Connection),
            (libc::EHOSTDOWN, AcceptFailure::Connection),
            (libc::EPROTO, AcceptFailure::Connection),
            (libc::ENOPROTOOPT, AcceptFailure::Connection),
            (libc::EOPNOTSUPP, AcceptFailure::Connection),
            (libc::EBADF, AcceptFailure::Listener),
            (libc::ENOTSOCK, AcceptFailure::Listener),
            (libc::EINVAL, AcceptFailure::Listener),
            (libc::EFAULT, AcceptFailure::Listener),
            // Unrecognised: pause rather than spin.
            (libc::ENOSR, AcceptFailure::Exhausted),
        ];
        for (errno, want) in cases {
            let error = io::Error::from_raw_os_error(errno);
            assert_eq!(AcceptFailure::classify(&error), want, "{error}");
        }
    }

    #[test]
    fn errors_without_an_errno_classify_by_kind() {
        let cases = [
            (io::ErrorKind::ConnectionAborted, AcceptFailure::Connection),
            (io::ErrorKind::Interrupted, AcceptFailure::Connection),
            (io::ErrorKind::OutOfMemory, AcceptFailure::Exhausted),
            (io::ErrorKind::Other, AcceptFailure::Exhausted),
        ];
        for (kind, want) in cases {
            assert_eq!(AcceptFailure::classify(&io::Error::from(kind)), want);
        }
    }

    /// Feed `accept_next` a script of accept results and record when each
    /// attempt was made.
    async fn run_script(
        script: Vec<io::Result<u32>>,
    ) -> (io::Result<u32>, Vec<tokio::time::Instant>) {
        let mut script = VecDeque::from(script);
        let mut attempts = Vec::new();
        let result = accept_next("test", || {
            attempts.push(tokio::time::Instant::now());
            let next = script.pop_front().expect("the script ran out");
            async move { next }
        })
        .await;
        (result, attempts)
    }

    #[tokio::test(start_paused = true)]
    async fn a_connection_failure_is_retried_at_once() {
        let (result, attempts) = run_script(vec![
            Err(io::ErrorKind::ConnectionAborted.into()),
            Err(io::ErrorKind::ConnectionReset.into()),
            Ok(7),
        ])
        .await;
        assert_eq!(result.expect("accepted"), 7);
        assert_eq!(attempts.len(), 3);
        assert!(attempts.windows(2).all(|pair| pair[0] == pair[1]));
    }

    #[tokio::test(start_paused = true)]
    async fn an_exhausted_failure_pauses_before_the_next_accept() {
        let (result, attempts) = run_script(vec![
            Err(io::ErrorKind::OutOfMemory.into()),
            Err(io::ErrorKind::OutOfMemory.into()),
            Ok(7),
        ])
        .await;
        assert_eq!(result.expect("accepted"), 7);
        assert_eq!(attempts.len(), 3);
        for pair in attempts.windows(2) {
            assert_eq!(pair[1] - pair[0], ACCEPT_RETRY_PAUSE);
        }
    }

    #[cfg(unix)]
    #[tokio::test(start_paused = true)]
    async fn only_a_listener_failure_ends_the_accept() {
        let (result, attempts) = run_script(vec![
            Err(io::Error::from_raw_os_error(libc::EMFILE)),
            Err(io::Error::from_raw_os_error(libc::ECONNABORTED)),
            Err(io::Error::from_raw_os_error(libc::EBADF)),
            Ok(7),
        ])
        .await;
        assert_eq!(
            result
                .expect_err("a listener failure ends it")
                .raw_os_error(),
            Some(libc::EBADF)
        );
        assert_eq!(attempts.len(), 3);
    }
}
