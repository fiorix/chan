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
        self.pin_with(
            pid,
            current_boot,
            |process| {
                rustix::process::pidfd_open(process, rustix::process::PidfdFlags::empty())
                    .map_err(|error| format!("cannot pin child identity: {error}"))
            },
            process_start_time,
        )
    }

    fn pin_with<H>(
        &self,
        pid: u32,
        current_boot: Option<&str>,
        open: impl FnOnce(rustix::process::Pid) -> Result<H, String>,
        read_start: impl FnOnce(u32) -> Option<u64>,
    ) -> Result<H, String> {
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
        let pidfd = open(process)?;
        let current_start = read_start(pid).ok_or("cannot read child start time")?;
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

    fn identity() -> RecordedChildIdentity {
        RecordedChildIdentity {
            boot_id: Some("boot".into()),
            start_time: Some(42),
        }
    }

    fn refuses_before_open(
        identity: RecordedChildIdentity,
        pid: u32,
        boot: Option<&str>,
        reason: &str,
    ) {
        let opened = std::cell::Cell::new(false);
        let result = identity.pin_with(
            pid,
            boot,
            |_| {
                opened.set(true);
                Ok(())
            },
            |_| Some(42),
        );
        assert_eq!(result.unwrap_err(), reason);
        assert!(
            !opened.get(),
            "refused evidence must not open a process handle"
        );
    }

    #[test]
    fn child_identity_missing_boot() {
        refuses_before_open(
            RecordedChildIdentity {
                boot_id: None,
                ..identity()
            },
            17,
            Some("boot"),
            "manifest boot id is missing",
        );
    }

    #[test]
    fn child_identity_wrong_boot() {
        refuses_before_open(
            identity(),
            17,
            Some("other"),
            "manifest boot id does not match the current boot",
        );
    }

    #[test]
    fn child_identity_unreadable_boot() {
        refuses_before_open(
            identity(),
            17,
            None,
            "manifest boot id does not match the current boot",
        );
    }

    #[test]
    fn child_identity_missing_start() {
        refuses_before_open(
            RecordedChildIdentity {
                start_time: None,
                ..identity()
            },
            17,
            Some("boot"),
            "no recorded start time for this fd name",
        );
    }

    #[test]
    fn child_identity_zero_pid() {
        refuses_before_open(identity(), 0, Some("boot"), "invalid child pid");
    }

    #[test]
    fn child_identity_out_of_range_pid() {
        refuses_before_open(identity(), u32::MAX, Some("boot"), "invalid child pid");
    }

    #[test]
    fn child_identity_failed_open() {
        let read = std::cell::Cell::new(false);
        let result = identity().pin_with(
            17,
            Some("boot"),
            |_| Err::<(), _>("open refused".into()),
            |_| {
                read.set(true);
                Some(42)
            },
        );
        assert_eq!(result.unwrap_err(), "open refused");
        assert!(!read.get(), "failed open must not read a later PID holder");
    }

    #[test]
    fn child_identity_unreadable_stat_releases_handle() {
        struct Handle<'a>(&'a std::cell::Cell<bool>);
        impl Drop for Handle<'_> {
            fn drop(&mut self) {
                self.0.set(true);
            }
        }
        let dropped = std::cell::Cell::new(false);
        let result = identity().pin_with(17, Some("boot"), |_| Ok(Handle(&dropped)), |_| None);
        assert_eq!(
            result.err().as_deref(),
            Some("cannot read child start time")
        );
        assert!(dropped.get(), "a refused pin must release its handle");
    }

    #[test]
    fn child_identity_start_mismatch() {
        let result = identity().pin_with(17, Some("boot"), |_| Ok(()), |_| Some(43));
        assert_eq!(
            result.unwrap_err(),
            "child start time does not match the manifest"
        );
    }

    #[test]
    fn child_identity_opens_before_reading_a_reused_number() {
        // These are model handles only; no synthetic PID reaches the kernel.
        let occupant = std::cell::Cell::new("original");
        let trace = std::cell::RefCell::new(Vec::new());
        let handle = identity()
            .pin_with(
                17,
                Some("boot"),
                |_| {
                    trace.borrow_mut().push("open");
                    Ok(occupant.get())
                },
                |_| {
                    trace.borrow_mut().push("read");
                    occupant.set("sentinel");
                    Some(42)
                },
            )
            .unwrap();
        let signalled = [handle];
        assert_eq!(
            signalled,
            ["original"],
            "a read must not redirect the selected handle"
        );
        assert!(!signalled.contains(&"sentinel"));
        assert_eq!(*trace.borrow(), ["open", "read"]);
    }

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
