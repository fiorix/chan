//! systemd notify/fdstore helpers.
//!
//! This crate is the explicit unsafe boundary for systemd fdstore adoption:
//! systemd transfers inherited descriptors as raw fd numbers starting at 3.
//! The rest of chan consumes typed `OwnedFd` values.

#![deny(unsafe_op_in_unsafe_fn)]

use std::path::Path;

/// Relationship between an installed devserver unit and chan's renderer.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DevserverUnitClass {
    /// The installed unit matches the requested current render.
    Current,
    /// The unit has a recognized chan-owned shape that can be migrated.
    KnownLegacy,
    /// The unit contains directives or a command chan does not own.
    Foreign,
}

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
        self.render_profile(DevserverUnitProfile::Current)
    }

    /// Classify an installed unit without accepting arbitrary lookalikes.
    ///
    /// Whitespace and comments are inert. Dynamic values may differ across
    /// upgrades, but the command must remain a chan devserver invocation,
    /// environment keys must be chan-owned, and every supervision directive
    /// must match one of the known renderer profiles.
    pub fn classify_installed(&self, installed: &str) -> DevserverUnitClass {
        let current_render = canonical_unit(&self.render());
        if canonical_unit(installed) == current_render {
            return DevserverUnitClass::Current;
        }
        let Some(candidate) = DevserverUnit::from_installed_dynamic(installed, &self.exec_start)
        else {
            return DevserverUnitClass::Foreign;
        };
        let installed = canonical_unit(installed);
        let recognized = [
            DevserverUnitProfile::Current,
            DevserverUnitProfile::WatchdogLegacy,
            DevserverUnitProfile::NotifyLegacy,
        ]
        .into_iter()
        .any(|profile| installed == canonical_unit(&candidate.render_profile(profile)));
        if recognized {
            DevserverUnitClass::KnownLegacy
        } else {
            DevserverUnitClass::Foreign
        }
    }

    fn from_installed_dynamic(installed: &str, expected_exec_start: &str) -> Option<Self> {
        let mut exec_start = None;
        let mut environment = Vec::new();
        let mut environment_keys = Vec::new();
        for line in installed.lines().map(str::trim) {
            if let Some(value) = line.strip_prefix("ExecStart=") {
                if exec_start.is_some()
                    || (value != expected_exec_start && !is_chan_devserver_exec(value))
                {
                    return None;
                }
                exec_start = Some(value.to_string());
            } else if let Some(value) = line
                .strip_prefix("Environment=\"")
                .and_then(|value| value.strip_suffix('"'))
            {
                let (key, _) = value.split_once('=')?;
                if !matches!(
                    key,
                    "CHAN_HOME" | "CHAN_TUNNEL_TOKEN" | "CHAN_TUNNEL_DEVSERVER_NAME"
                ) || environment_keys.contains(&key)
                {
                    return None;
                }
                environment_keys.push(key);
                environment.push(value.to_string());
            }
        }
        Some(Self {
            exec_start: exec_start?,
            environment,
        })
    }

    fn render_profile(&self, profile: DevserverUnitProfile) -> String {
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
        unit.push('\n');
        if profile == DevserverUnitProfile::Current {
            unit.push_str("TimeoutStartSec=10min\n");
        }
        unit.push_str("Restart=on-failure\n");
        if profile != DevserverUnitProfile::NotifyLegacy {
            unit.push_str("WatchdogSec=30\n");
        }
        unit.push_str("\n[Install]\nWantedBy=default.target\n");
        unit
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum DevserverUnitProfile {
    Current,
    WatchdogLegacy,
    NotifyLegacy,
}

fn canonical_unit(unit: &str) -> String {
    unit.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .collect::<Vec<_>>()
        .join("\n")
}

fn is_chan_devserver_exec(exec_start: &str) -> bool {
    let Some((executable, arguments)) = exec_start.split_once(" devserver") else {
        return false;
    };
    let Some(name) = Path::new(executable)
        .file_name()
        .and_then(|name| name.to_str())
    else {
        return false;
    };
    let name = name.to_ascii_lowercase();
    if !(name == "chan"
        || name.starts_with("chan-")
        || (name.contains("chan") && name.ends_with(".appimage")))
    {
        return false;
    }
    arguments.split_whitespace().all(|argument| {
        argument.starts_with("--bind=")
            || argument.starts_with("--port=")
            || argument.starts_with("--tunnel-url=")
    })
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
    use super::{DevserverUnit, DevserverUnitClass};

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

    #[test]
    fn devserver_unit_classifies_current_known_legacy_and_foreign() {
        let desired = DevserverUnit::new("/usr/bin/chan devserver --bind=127.0.0.1 --port=8787")
            .with_environment("CHAN_HOME=/tmp/chan");
        let current = desired.render();
        assert_eq!(
            desired.classify_installed(&current),
            DevserverUnitClass::Current
        );
        let normalized_current = format!("# managed by chan\n\n  {current}");
        assert_eq!(
            desired.classify_installed(&normalized_current),
            DevserverUnitClass::Current
        );

        let watchdog_legacy = current.replace("TimeoutStartSec=10min\n", "");
        assert_eq!(
            desired.classify_installed(&watchdog_legacy),
            DevserverUnitClass::KnownLegacy
        );
        let notify_legacy = watchdog_legacy.replace("WatchdogSec=30\n", "");
        assert_eq!(
            desired.classify_installed(&notify_legacy),
            DevserverUnitClass::KnownLegacy
        );

        let foreign = current.replace("Restart=on-failure", "Restart=always");
        assert_eq!(
            desired.classify_installed(&foreign),
            DevserverUnitClass::Foreign
        );
        let foreign_exec = current.replace("/usr/bin/chan devserver", "/usr/bin/logger devserver");
        assert_eq!(
            desired.classify_installed(&foreign_exec),
            DevserverUnitClass::Foreign
        );
    }

    #[test]
    fn devserver_unit_classifies_its_own_render_regardless_of_exec_name() {
        let desired =
            DevserverUnit::new("/opt/Editor.AppImage devserver --bind=127.0.0.1 --port=8787")
                .with_environment("CHAN_HOME=/tmp/chan");
        let current = desired.render();
        assert_eq!(
            desired.classify_installed(&current),
            DevserverUnitClass::Current
        );

        let legacy = current.replace("TimeoutStartSec=10min\n", "");
        assert_eq!(
            desired.classify_installed(&legacy),
            DevserverUnitClass::KnownLegacy
        );

        let unrelated_exec = legacy.replace("Editor.AppImage", "OtherEditor.AppImage");
        assert_eq!(
            desired.classify_installed(&unrelated_exec),
            DevserverUnitClass::Foreign
        );
    }
}
