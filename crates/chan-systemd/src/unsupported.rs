use std::io::Result;
use std::time::Duration;

pub fn notify_ready() -> Result<()> {
    Ok(())
}

pub fn notify_watchdog() -> Result<()> {
    Ok(())
}

/// Remove systemd notification authority from a child command's environment.
pub fn scrub_child_supervision_env(mut remove_var: impl FnMut(&'static str)) {
    for key in ["WATCHDOG_PID", "WATCHDOG_USEC", "NOTIFY_SOCKET"] {
        remove_var(key);
    }
}

/// Non-Linux: no systemd supervision, never a watchdog cadence.
pub fn watchdog_interval() -> Option<Duration> {
    let _ = std::env::var("WATCHDOG_USEC");
    None
}

pub fn notify_barrier(_timeout: Duration) -> Result<()> {
    Ok(())
}
