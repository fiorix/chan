//! Bounded capability replies owned by the PTY input controller.

use std::collections::VecDeque;
use std::io::{self, Write};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const MAX_PENDING: usize = 8;
const MAX_PER_SECOND: usize = 8;

#[derive(Clone, Copy, Debug)]
pub(super) enum Terminator {
    Bell,
    Escape,
}

#[derive(Debug, Default)]
pub(super) struct ReplySlots {
    pending: Arc<AtomicUsize>,
}

impl ReplySlots {
    pub(super) fn reserve(&self, terminator: Terminator) -> Option<Reply> {
        self.pending
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |pending| {
                (pending < MAX_PENDING).then_some(pending + 1)
            })
            .ok()?;
        Some(Reply {
            terminator,
            pending: self.pending.clone(),
        })
    }
}

/// The slot stays occupied through a blocked write, not only while queued.
pub(super) struct Reply {
    terminator: Terminator,
    pending: Arc<AtomicUsize>,
}

impl Drop for Reply {
    fn drop(&mut self) {
        self.pending.fetch_sub(1, Ordering::Relaxed);
    }
}

#[derive(Default)]
pub(super) struct ReplyWriter {
    written: VecDeque<Instant>,
}

impl ReplyWriter {
    pub(super) fn write(
        &mut self,
        reply: Reply,
        writer: &mut (impl Write + ?Sized),
        echoes: bool,
        mut now: impl FnMut() -> Instant,
    ) -> io::Result<()> {
        if echoes {
            return Ok(());
        }
        let start = now();
        while self
            .written
            .front()
            .is_some_and(|time| start.saturating_duration_since(*time) >= Duration::from_secs(1))
        {
            self.written.pop_front();
        }
        if self.written.len() == MAX_PER_SECOND {
            return Ok(());
        }
        let bytes: &[u8] = match reply.terminator {
            Terminator::Bell => b"\x1b]7501;?\x07",
            Terminator::Escape => b"\x1b]7501;?\x1b\\",
        };
        writer.write_all(bytes)?;
        writer.flush()?;
        // A write can block until a child reads; count its completion time.
        self.written.push_back(now());
        Ok(())
    }
}

#[cfg(unix)]
fn echoes_query(flags: rustix::termios::LocalModes) -> bool {
    use rustix::termios::LocalModes;
    flags.contains(LocalModes::ECHO) && !flags.contains(LocalModes::ECHOCTL)
}

pub(super) fn master_echoes_query(master: &dyn portable_pty::MasterPty) -> bool {
    #[cfg(unix)]
    {
        master.get_termios().is_some_and(|termios| {
            echoes_query(rustix::termios::LocalModes::from_bits_retain(
                termios.local_flags.bits(),
            ))
        })
    }
    #[cfg(not(unix))]
    {
        let _ = master;
        false
    }
}

#[cfg(target_os = "linux")]
pub(super) fn fd_echoes_query(master: &impl std::os::fd::AsFd) -> bool {
    rustix::termios::tcgetattr(master).is_ok_and(|termios| echoes_query(termios.local_modes))
}
