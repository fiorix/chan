//! systemd notify/fdstore helpers.
//!
//! This crate is the explicit unsafe boundary for systemd fdstore adoption:
//! systemd transfers inherited descriptors as raw fd numbers starting at 3.
//! The rest of chan consumes typed `OwnedFd` values.

#![deny(unsafe_op_in_unsafe_fn)]

use std::ffi::OsStr;
use std::path::Path;

/// The `FileDescriptorStoreMax` the canonical unit renders: two stored fds,
/// a PTY master and its ring file, for each of 512 parked terminals.
pub const DEVSERVER_FDSTORE_MAX: usize = 1024;

/// The `FileDescriptorStoreMax` earlier chan units rendered, when each
/// parked terminal stored its PTY master alone. A unit carrying it is still
/// chan-owned, so it is migrated rather than refused.
const LEGACY_FDSTORE_MAX: usize = 512;

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
/// [`render`](Self::render), and the shape of the `PATH` assignment only in
/// [`with_search_path`](Self::with_search_path).
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

    /// Add a `PATH` assignment built from `search_path`, the installing
    /// process's own `PATH`, in emission order.
    ///
    /// systemd starts a user service with the user manager's environment, not
    /// the environment of the shell that installed it, so without this line
    /// the devserver and every extension it spawns resolve commands through
    /// the manager's default `PATH`. The entries are the ones
    /// [`service_search_path`] keeps, and `%` is written as `%%` so systemd's
    /// specifier expansion hands the service the literal directory. Nothing
    /// is added when no entry survives.
    pub fn with_search_path(self, search_path: &OsStr) -> Self {
        match service_search_path(search_path) {
            Some(search_path) => {
                self.with_environment(format!("PATH={}", search_path.replace('%', "%%")))
            }
            None => self,
        }
    }

    /// The value of the `PATH` assignment `installed` records, exactly as the
    /// unit spells it (specifiers still escaped), or `None` when it has none.
    ///
    /// Rendering it back with [`with_environment`](Self::with_environment)
    /// reproduces the line byte for byte, which is how a rewrite keeps the
    /// `PATH` an earlier install recorded.
    pub fn recorded_search_path(installed: &str) -> Option<&str> {
        installed
            .lines()
            .map(str::trim)
            .find_map(|line| line.strip_prefix("Environment=\"PATH=")?.strip_suffix('"'))
    }

    /// Render the canonical systemd user unit.
    pub fn render(&self) -> String {
        self.render_profile(DevserverUnitProfile::Current, DEVSERVER_FDSTORE_MAX)
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
        .any(|profile| {
            [DEVSERVER_FDSTORE_MAX, LEGACY_FDSTORE_MAX]
                .into_iter()
                .any(|fdstore_max| {
                    installed == canonical_unit(&candidate.render_profile(profile, fdstore_max))
                })
        });
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
                    "CHAN_HOME"
                        | "CHAN_TUNNEL_TOKEN"
                        | "CHAN_TUNNEL_URL"
                        | "CHAN_TUNNEL_DEVSERVER_NAME"
                        | "PATH"
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

    fn render_profile(&self, profile: DevserverUnitProfile, fdstore_max: usize) -> String {
        let mut unit = String::from(
            "[Unit]\n\
             Description=chan devserver\n\
             After=network.target\n\
             \n\
             [Service]\n\
             Type=notify\n\
             NotifyAccess=main\n",
        );
        unit.push_str(&format!("FileDescriptorStoreMax={fdstore_max}\n"));
        unit.push_str("KillMode=process\n");
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

/// The `PATH` a supervised devserver definition records from `search_path`,
/// the installing process's own, or `None` when no entry survives.
///
/// Entries are split on `:`, the separator of every platform that has a
/// service manager chan drives. Only absolute entries are kept (an empty or
/// relative one would search the service's working directory), the first
/// occurrence of a repeated entry wins, and an entry a service definition
/// cannot carry raw (a `"`, a `\`, a control character, or bytes that are
/// not UTF-8) is dropped rather than escaped, so what a definition records
/// reads back byte for byte. The value is unescaped: each definition escapes
/// it for its own syntax.
pub fn service_search_path(search_path: &OsStr) -> Option<String> {
    let search_path = search_path.to_string_lossy();
    let mut entries: Vec<&str> = Vec::new();
    for entry in search_path.split(':') {
        if entry.starts_with('/')
            && !entry.contains(['"', '\\', char::REPLACEMENT_CHARACTER])
            && !entry.chars().any(char::is_control)
            && !entries.contains(&entry)
        {
            entries.push(entry);
        }
    }
    (!entries.is_empty()).then(|| entries.join(":"))
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
    // `split_once` would also match `chan devserverrun`; the subcommand has to
    // end the token, or a lookalike executable rides in on the verb below.
    if !(arguments.is_empty() || arguments.starts_with(char::is_whitespace)) {
        return false;
    }
    let mut arguments = arguments.split_whitespace().peekable();
    // The renderer emits `<exe> devserver run [flags]` (both the plain and the
    // tunnel branch of `devserver_systemd_unit_spec`), and units written before
    // the verb existed carry the flags with no subcommand at all. Accept the
    // one verb the renderer can emit, then require flags for the rest.
    if arguments.peek() == Some(&DEVSERVER_EXEC_VERB) {
        arguments.next();
    }
    arguments.all(|argument| {
        argument.starts_with("--bind=")
            || argument.starts_with("--port=")
            || argument.starts_with("--tunnel-url=")
    })
}

/// The only `chan devserver` subcommand chan's own unit renderer emits.
const DEVSERVER_EXEC_VERB: &str = "run";

#[cfg(target_os = "linux")]
mod linux;
#[cfg(not(target_os = "linux"))]
mod unsupported;

#[cfg(target_os = "linux")]
pub use linux::{
    fdstore, fdstore_remove_many, notify_barrier, notify_ready, notify_watchdog,
    own_unit_fdstore_max, pty_master_has_live_slave, scrub_child_supervision_env, take_listen_fds,
    watchdog_interval, NamedFd,
};
#[cfg(not(target_os = "linux"))]
pub use unsupported::{
    notify_barrier, notify_ready, notify_watchdog, scrub_child_supervision_env, watchdog_interval,
};

#[cfg(test)]
mod unit_tests {
    use super::{DevserverUnit, DevserverUnitClass};
    use std::ffi::OsStr;

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
             FileDescriptorStoreMax=1024\n\
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

    // Every unit installed before the store maximum rose carries 512 in an
    // otherwise current shape: it must migrate, never be refused as foreign.
    #[test]
    fn devserver_unit_migrates_a_unit_installed_with_the_older_store_maximum() {
        let desired =
            DevserverUnit::new("/usr/bin/chan devserver run --bind=127.0.0.1 --port=8787")
                .with_environment("CHAN_HOME=/tmp/chan");
        let current = desired.render();
        assert!(current.contains("\nFileDescriptorStoreMax=1024\n"));
        assert_eq!(
            desired.classify_installed(&current),
            DevserverUnitClass::Current
        );

        let installed_at_512 =
            current.replace("FileDescriptorStoreMax=1024", "FileDescriptorStoreMax=512");
        assert_eq!(
            desired.classify_installed(&installed_at_512),
            DevserverUnitClass::KnownLegacy,
            "today's installed unit"
        );
        for legacy in [
            installed_at_512.replace("TimeoutStartSec=10min\n", ""),
            installed_at_512
                .replace("TimeoutStartSec=10min\n", "")
                .replace("WatchdogSec=30\n", ""),
        ] {
            assert_eq!(
                desired.classify_installed(&legacy),
                DevserverUnitClass::KnownLegacy,
                "an older installed unit: {legacy}"
            );
        }

        for foreign in [
            installed_at_512.replace("Restart=on-failure", "Restart=always"),
            current.replace("FileDescriptorStoreMax=1024", "FileDescriptorStoreMax=4096"),
            current.replace("FileDescriptorStoreMax=1024\n", ""),
        ] {
            assert_eq!(
                desired.classify_installed(&foreign),
                DevserverUnitClass::Foreign,
                "a unit chan never rendered: {foreign}"
            );
        }
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

    #[test]
    fn devserver_unit_accepts_the_run_verb_but_no_other_command() {
        // `<exe> devserver run [flags]` is the shape the renderer actually
        // emits; a unit carrying it must stay chan-owned even when the
        // installed address differs from the desired one. The end-to-end proof
        // against the real renderer lives in the chan crate; this pins the
        // allowlist itself.
        let desired =
            DevserverUnit::new("/usr/bin/chan devserver run --bind=127.0.0.1 --port=9000");
        let installed =
            DevserverUnit::new("/usr/bin/chan devserver run --bind=127.0.0.1 --port=8787")
                .render()
                .replace("TimeoutStartSec=10min\n", "");
        assert_eq!(
            desired.classify_installed(&installed),
            DevserverUnitClass::KnownLegacy
        );

        // Only `run`: no other subcommand and no second verb is chan-owned.
        for exec in [
            "/usr/bin/chan devserver start --bind=127.0.0.1 --port=8787",
            "/usr/bin/chan devserver run run --bind=127.0.0.1 --port=8787",
            "/usr/bin/chan devserverrun --bind=127.0.0.1 --port=8787",
        ] {
            let installed = DevserverUnit::new(exec)
                .render()
                .replace("TimeoutStartSec=10min\n", "");
            assert_eq!(
                desired.classify_installed(&installed),
                DevserverUnitClass::Foreign,
                "{exec} must not be treated as chan-owned"
            );
        }
    }

    #[test]
    fn devserver_unit_renders_the_install_time_search_path() {
        let unit = DevserverUnit::new("/usr/bin/chan devserver run --bind=127.0.0.1 --port=8787")
            .with_environment("CHAN_HOME=/tmp/chan")
            .with_search_path(OsStr::new(
                "/home/dev/.local/bin::bin:./tools:/usr/bin:/home/dev/.local/bin\
                 :/opt/100%/bin:/opt/quo\"te:/opt/back\\slash:/opt/line\nbreak\
                 :/mnt/c/Program Files/Git/cmd:/usr/local/bin:/usr/bin",
            ))
            .render();
        let environment: Vec<_> = unit
            .lines()
            .filter(|line| line.starts_with("Environment="))
            .collect();
        assert_eq!(
            environment,
            [
                "Environment=\"CHAN_HOME=/tmp/chan\"",
                "Environment=\"PATH=/home/dev/.local/bin:/usr/bin:/opt/100%%/bin\
                 :/mnt/c/Program Files/Git/cmd:/usr/local/bin\"",
            ],
            "absolute entries only, first occurrence first, `%` escaped for \
             systemd, and entries its quoting cannot carry raw dropped: {unit}"
        );

        // A search path with no absolute entry adds no line, so the service
        // keeps the user manager's default PATH rather than an empty one.
        let bare = DevserverUnit::new("/usr/bin/chan devserver run");
        assert_eq!(
            bare.clone()
                .with_search_path(OsStr::new("::bin:."))
                .render(),
            bare.render()
        );
    }

    #[test]
    fn devserver_unit_reads_back_the_search_path_it_recorded() {
        let spec = || {
            DevserverUnit::new("/usr/bin/chan devserver run")
                .with_environment("CHAN_HOME=/tmp/chan")
        };
        let installed = spec()
            .with_search_path(OsStr::new("/opt/100%/bin:/usr/bin"))
            .render();
        let recorded = DevserverUnit::recorded_search_path(&installed);
        assert_eq!(recorded, Some("/opt/100%%/bin:/usr/bin"));
        // Rendered back, the recorded value reproduces the unit byte for byte.
        assert_eq!(
            spec()
                .with_environment(format!("PATH={}", recorded.unwrap()))
                .render(),
            installed
        );
        assert_eq!(DevserverUnit::recorded_search_path(&spec().render()), None);
    }

    #[test]
    fn devserver_unit_with_a_search_path_stays_chan_owned() {
        let exec = "/usr/bin/chan devserver run --bind=127.0.0.1 --port=8787";
        let desired = DevserverUnit::new(exec)
            .with_environment("CHAN_HOME=/tmp/chan")
            .with_search_path(OsStr::new("/home/dev/.local/bin:/usr/bin"));
        let current = desired.render();
        assert_eq!(
            desired.classify_installed(&current),
            DevserverUnitClass::Current
        );

        // A unit installed from a shell with another PATH is chan's own
        // render, so re-running the install refreshes it instead of
        // refusing it.
        let other_shell = DevserverUnit::new(exec)
            .with_environment("CHAN_HOME=/tmp/chan")
            .with_search_path(OsStr::new("/usr/local/bin:/usr/bin"))
            .render();
        assert_eq!(
            desired.classify_installed(&other_shell),
            DevserverUnitClass::KnownLegacy
        );

        // A unit an older chan rendered before it carried a PATH is still
        // chan-owned, so an upgrade rewrites it with one.
        let before_path = DevserverUnit::new(exec)
            .with_environment("CHAN_HOME=/tmp/chan")
            .render();
        assert_eq!(
            desired.classify_installed(&before_path),
            DevserverUnitClass::KnownLegacy
        );
        assert_eq!(
            desired.classify_installed(&before_path.replace("TimeoutStartSec=10min\n", "")),
            DevserverUnitClass::KnownLegacy
        );

        // Accepting PATH accepts no other key, and not PATH twice.
        for edit in [
            "Environment=\"LD_PRELOAD=/tmp/hook.so\"\n",
            "Environment=\"PATH=/tmp/second\"\n",
        ] {
            let edited = current.replace("ExecStart=", &format!("{edit}ExecStart="));
            assert_eq!(
                desired.classify_installed(&edited),
                DevserverUnitClass::Foreign,
                "{edit:?} is an administrator edit"
            );
        }
    }
}
