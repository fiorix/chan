//! systemd notify/fdstore helpers.
//!
//! This crate is the explicit unsafe boundary for systemd fdstore adoption:
//! systemd transfers inherited descriptors as raw fd numbers starting at 3.
//! The rest of chan consumes typed `OwnedFd` values.

#![deny(unsafe_op_in_unsafe_fn)]

#[cfg(target_os = "linux")]
mod linux;
#[cfg(not(target_os = "linux"))]
mod unsupported;

#[cfg(target_os = "linux")]
pub use linux::{
    fdstore, fdstore_remove_many, notify_barrier, notify_ready, notify_watchdog,
    pty_master_has_live_slave, take_listen_fds, watchdog_interval, NamedFd,
};
#[cfg(not(target_os = "linux"))]
pub use unsupported::{notify_barrier, notify_ready, notify_watchdog, watchdog_interval};
