//! Linux process identity retained by a terminal's restart manifest.

use std::os::fd::OwnedFd;

/// Recorded evidence for a terminal's child, independent of its numeric PID.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RecordedChildIdentity {
    /// Boot in which the child was recorded. Missing evidence stays absent.
    pub boot_id: Option<String>,
    /// The recorded `/proc/<pid>/stat` start time, in ticks since boot.
    pub start_time: Option<u64>,
}

impl RecordedChildIdentity {
    /// Pin `pid` only if its boot and start time match this recorded identity.
    ///
    /// `current_boot` is the caller's local boot-id observation. The returned
    /// descriptor keeps signals tied to the checked process after PID reuse.
    pub fn pin(&self, pid: u32, current_boot: Option<&str>) -> Result<OwnedFd, String> {
        let recorded_boot = self
            .boot_id
            .as_deref()
            .ok_or("manifest boot id is missing")?;
        if current_boot != Some(recorded_boot) {
            return Err("manifest boot id does not match the current boot".into());
        }
        let recorded_start = self
            .start_time
            .ok_or("no recorded start time for this fd name")?;
        let raw_pid = i32::try_from(pid).map_err(|_| "invalid child pid")?;
        let process = rustix::process::Pid::from_raw(raw_pid).ok_or("invalid child pid")?;
        // Pin before reading /proc so reuse during validation cannot redirect
        // a later signal to a different process.
        let pidfd = rustix::process::pidfd_open(process, rustix::process::PidfdFlags::empty())
            .map_err(|error| format!("cannot pin child identity: {error}"))?;
        let current_start = process_start_time(pid).ok_or("cannot read child start time")?;
        if current_start != recorded_start {
            return Err("child start time does not match the manifest".into());
        }
        Ok(pidfd)
    }
}

/// Read the local Linux boot id, leaving unreadable or empty evidence absent.
pub fn current_boot_id() -> Option<String> {
    let boot_id = std::fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?;
    let boot_id = boot_id.trim();
    (!boot_id.is_empty()).then(|| boot_id.to_owned())
}

/// Read the process start time in ticks since boot from Linux procfs.
pub fn process_start_time(pid: u32) -> Option<u64> {
    parse_process_start_time(&std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?)
}

fn parse_process_start_time(stat: &str) -> Option<u64> {
    // comm is parenthesized and can itself contain spaces and parentheses.
    stat.rsplit_once(')')?
        .1
        .split_ascii_whitespace()
        .nth(19)?
        .parse()
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_start_time_parser_handles_parentheses_and_spaces() {
        let mut fields = vec!["0"; 20];
        fields[0] = "S";
        fields[19] = "424242";
        let stat = format!(
            "123 (a ) name (with parentheses)) {} 99 88",
            fields.join(" ")
        );
        assert_eq!(parse_process_start_time(&stat), Some(424242));
        assert_eq!(parse_process_start_time("123 (truncated) S 0"), None);
        assert_eq!(
            parse_process_start_time(&stat.replace("424242", "invalid")),
            None
        );
        assert_eq!(parse_process_start_time("malformed"), None);
    }
}
