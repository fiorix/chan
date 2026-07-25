//! systemd notify/fdstore helpers.
//!
//! This crate is the explicit unsafe boundary for systemd fdstore adoption:
//! systemd transfers inherited descriptors as raw fd numbers starting at 3.
//! The rest of chan consumes typed `OwnedFd` values.

#![deny(unsafe_op_in_unsafe_fn)]

/// Typed input for the canonical `chan devserver` systemd user unit.
///
/// Callers own the deployment-specific `ExecStart` and optional environment
/// assignments. Supervision directives and their ordering live only in
/// [`render`](Self::render).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DevserverUnit {
    exec_start: String,
    environment: Vec<String>,
}

impl DevserverUnit {
    pub fn new(exec_start: impl Into<String>) -> Self {
        Self {
            exec_start: exec_start.into(),
            environment: Vec::new(),
        }
    }

    /// Add one already-escaped `NAME=value` assignment in emission order.
    pub fn with_environment(mut self, assignment: impl Into<String>) -> Self {
        self.environment.push(assignment.into());
        self
    }

    /// Render the canonical systemd user unit.
    pub fn render(&self) -> String {
        let mut unit = String::from(
            "[Unit]\n\
             Description=chan devserver\n\
             After=network.target\n\
             \n\
             [Service]\n\
             Type=notify\n\
             NotifyAccess=main\n\
             FileDescriptorStoreMax=512\n\
             KillMode=process\n",
        );
        for assignment in &self.environment {
            unit.push_str("Environment=\"");
            unit.push_str(assignment);
            unit.push_str("\"\n");
        }
        unit.push_str("ExecStart=");
        unit.push_str(&self.exec_start);
        unit.push_str(
            "\n\
             TimeoutStartSec=10min\n\
             Restart=on-failure\n\
             WatchdogSec=30\n\
             \n\
             [Install]\n\
             WantedBy=default.target\n",
        );
        unit
    }
}

#[cfg(target_os = "linux")]
mod linux;
#[cfg(not(target_os = "linux"))]
mod unsupported;

#[cfg(target_os = "linux")]
pub use linux::{
    fdstore, fdstore_remove_many, notify_barrier, notify_ready, notify_watchdog,
    pty_master_has_live_slave, scrub_child_supervision_env, take_listen_fds, watchdog_interval,
    NamedFd,
};
#[cfg(not(target_os = "linux"))]
pub use unsupported::{
    notify_barrier, notify_ready, notify_watchdog, scrub_child_supervision_env, watchdog_interval,
};

#[cfg(test)]
mod unit_tests {
    use super::DevserverUnit;

    #[test]
    fn devserver_unit_renderer_owns_supervision_directives() {
        let unit = DevserverUnit::new("/usr/bin/chan devserver")
            .with_environment("CHAN_HOME=/tmp/chan home")
            .render();
        assert_eq!(
            unit,
            "[Unit]\n\
             Description=chan devserver\n\
             After=network.target\n\
             \n\
             [Service]\n\
             Type=notify\n\
             NotifyAccess=main\n\
             FileDescriptorStoreMax=512\n\
             KillMode=process\n\
             Environment=\"CHAN_HOME=/tmp/chan home\"\n\
             ExecStart=/usr/bin/chan devserver\n\
             TimeoutStartSec=10min\n\
             Restart=on-failure\n\
             WatchdogSec=30\n\
             \n\
             [Install]\n\
             WantedBy=default.target\n"
        );
    }
}
