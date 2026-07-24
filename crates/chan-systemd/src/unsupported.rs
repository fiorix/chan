use std::io::Result;
use std::time::Duration;

pub fn notify_ready() -> Result<()> {
    Ok(())
}

pub fn notify_watchdog() -> Result<()> {
    Ok(())
}

/// Non-Linux: no systemd supervision, never a watchdog cadence.
pub fn watchdog_interval() -> Option<Duration> {
    let _ = std::env::var("WATCHDOG_USEC");
    None
}

pub fn notify_barrier(_timeout: Duration) -> Result<()> {
    Ok(())
}
