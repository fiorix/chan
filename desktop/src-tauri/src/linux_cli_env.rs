//! Loader preparation for AppImage CLI personalities, before any runtime starts.

use std::ffi::{OsStr, OsString};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::Command;

use chan_server::{CLI_REEXEC_MARKER, GUI_STACK_REEXEC_MARKERS};

/// Consume this process's markers and replace a dirty CLI image once. GUI
/// launches keep their GUI marker for the GUI-stack selector to consume.
pub fn prepare(cli: bool) -> Result<(), String> {
    let marker = std::env::var_os(CLI_REEXEC_MARKER);
    std::env::remove_var(CLI_REEXEC_MARKER);
    if !cli {
        return Ok(());
    }
    for name in GUI_STACK_REEXEC_MARKERS {
        std::env::remove_var(name);
    }
    let Some(ld_path) = loader_change(
        chan_server::own_appimage().is_some(),
        std::env::vars_os(),
        marker.as_deref(),
        std::process::id(),
    )?
    else {
        return Ok(());
    };
    let exe = std::env::current_exe().map_err(|error| format!("chan: CLI executable: {error}"))?;
    let mut argv = std::env::args_os();
    let arg0 = argv.next().ok_or("chan: CLI invocation has no argv[0]")?;
    let command = reexec_command(&exe, &arg0, argv, &ld_path, std::process::id());
    execute(command)
}

fn loader_change(
    own_appimage: bool,
    parent: impl IntoIterator<Item = (OsString, OsString)>,
    marker: Option<&OsStr>,
    pid: u32,
) -> Result<Option<OsString>, String> {
    if !own_appimage {
        return Ok(None);
    }
    let parent: Vec<_> = parent.into_iter().collect();
    let current = parent
        .iter()
        .find(|(key, _)| key == "LD_LIBRARY_PATH")
        .map(|(_, value)| value);
    let clean = chan_server::own_apprun_value("LD_LIBRARY_PATH", parent.iter().cloned(), None);
    let Some(clean) = clean.filter(|clean| current != Some(clean)) else {
        return Ok(None);
    };
    if marker == Some(OsStr::new(&pid.to_string())) {
        return Err("chan: CLI loader path is still dirty after re-exec".into());
    }
    Ok(Some(clean))
}

fn reexec_command(
    exe: &Path,
    arg0: &OsStr,
    args: impl IntoIterator<Item = OsString>,
    ld_path: &OsStr,
    pid: u32,
) -> Command {
    let mut command = Command::new(exe);
    command
        .arg0(arg0)
        .args(args)
        .env("LD_LIBRARY_PATH", ld_path);
    for name in GUI_STACK_REEXEC_MARKERS {
        command.env_remove(name);
    }
    command.env(CLI_REEXEC_MARKER, pid.to_string());
    command
}

fn execute(mut command: Command) -> Result<(), String> {
    // Returning would run the CLI with the loader's original search path.
    Err(format!(
        "chan: CLI loader re-exec failed: {}",
        command.exec()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    // AppRun.wrapped's measured ten-entry loader block, also pinned by the
    // library's apprun_shapes tests. Only the temporary mount root varies.
    fn block(mount: &str) -> String {
        [
            "usr/lib/",
            "usr/lib/i386-linux-gnu/",
            "usr/lib/x86_64-linux-gnu/",
            "usr/lib32/",
            "usr/lib64/",
            "lib/",
            "lib/i386-linux-gnu/",
            "lib/x86_64-linux-gnu/",
            "lib32/",
            "lib64/",
        ]
        .map(|entry| format!("{mount}/{entry}"))
        .join(":")
    }

    fn parent(value: &str) -> Vec<(OsString, OsString)> {
        vec![
            ("APPDIR".into(), "/tmp/.mount_ChanNEW".into()),
            ("LD_LIBRARY_PATH".into(), value.into()),
        ]
    }

    #[test]
    fn cli_loader_cleans_measured_blocks_once_and_preserves_user_entries() {
        let own = block("/tmp/.mount_ChanNEW");
        let host = tempfile::tempdir().unwrap();
        std::fs::write(host.path().join(chan_server::GUI_STACK_REEXEC_LIBRARY), b"").unwrap();
        for old in [
            String::new(),
            format!(
                "{}:{}:",
                host.path().display(),
                block("/tmp/.mount_ChanOLD")
            ),
        ] {
            for user in ["", ":", ":/opt/a", "/opt/a:", "/opt/a::/opt/b", "/opt/a"] {
                let raw = format!("{own}:{old}{user}");
                let expected = if user.is_empty() {
                    own.clone()
                } else {
                    format!("{own}:{user}")
                };
                let planned = loader_change(true, parent(&raw), None, 4242).unwrap();
                assert_eq!(
                    planned.as_deref(),
                    (raw != expected).then_some(OsStr::new(&expected)),
                    "{raw}"
                );
                assert_eq!(
                    loader_change(true, parent(&expected), Some(OsStr::new("4242")), 4242).unwrap(),
                    None
                );
                assert_eq!(
                    loader_change(false, parent(&raw), None, 4242).unwrap(),
                    None,
                    "foreign AppImage"
                );
            }
        }
        assert_eq!(loader_change(true, vec![], None, 4242).unwrap(), None);
    }

    #[test]
    fn cli_loader_own_pid_refuses_a_dirty_second_image() {
        let dirty = format!("{}:", block("/tmp/.mount_ChanNEW"));
        assert!(
            loader_change(true, parent(&dirty), Some(OsStr::new("4242")), 4242)
                .unwrap_err()
                .contains("still dirty")
        );
        for marker in ["1", "4243", "", "04242", "+4242", " 4242"] {
            assert!(
                loader_change(true, parent(&dirty), Some(OsStr::new(marker)), 4242)
                    .unwrap()
                    .is_some(),
                "{marker:?}"
            );
        }
    }

    #[test]
    fn cli_loader_command_preserves_alias_arguments_and_cwd() {
        let args = ["-c", "printf '%s\\n' \"$0\" \"$1\" \"$PWD\"", "cs", "a b"];
        let mut command = reexec_command(
            Path::new("/bin/sh"),
            OsStr::new("cs"),
            args.map(OsString::from),
            OsStr::new("/usr/lib"),
            4242,
        );
        assert_eq!(command.get_program(), "/bin/sh");
        assert_eq!(command.get_args().collect::<Vec<_>>(), args);
        assert_eq!(
            command.get_current_dir(),
            None,
            "exec retains restored caller cwd"
        );
        for name in GUI_STACK_REEXEC_MARKERS {
            assert!(command
                .get_envs()
                .any(|(key, value)| key == *name && value.is_none()));
        }
        assert!(command
            .get_envs()
            .any(|(key, value)| key == CLI_REEXEC_MARKER && value == Some(OsStr::new("4242"))));
        assert!(command
            .get_envs()
            .any(|(key, value)| key == "LD_LIBRARY_PATH" && value == Some(OsStr::new("/usr/lib"))));
        assert!(
            !command.get_envs().any(|(key, _)| key == "ARGV0"),
            "AppRun's dispatch name survives exec"
        );
        // With no shell-supplied name, $0 is execve's actual argv[0].
        command = reexec_command(
            Path::new("/bin/sh"),
            OsStr::new("cs"),
            ["-c", "printf %s \"$0\""].map(OsString::from),
            OsStr::new("/usr/lib"),
            4242,
        );
        let output = command.output().unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"cs");
    }

    #[test]
    fn cli_loader_marker_cleanup_preserves_gui_until_its_consumer() {
        const CHILD: &str = "CHAN_CLI_ENV_TEST_CHILD";
        if std::env::var_os(CHILD).is_none() {
            let output = Command::new(std::env::current_exe().unwrap())
                .args([
                    "cli_loader_marker_cleanup_preserves_gui_until_its_consumer",
                    "--nocapture",
                ])
                .env(CHILD, "1")
                .env(CLI_REEXEC_MARKER, "4242")
                .env(GUI_STACK_REEXEC_MARKERS[0], "4242")
                .env(GUI_STACK_REEXEC_MARKERS[1], "1")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stdout)
            );
            assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
            return;
        }
        prepare(false).unwrap();
        assert!(std::env::var_os(CLI_REEXEC_MARKER).is_none());
        for name in GUI_STACK_REEXEC_MARKERS {
            assert!(std::env::var_os(name).is_some());
        }
        prepare(true).unwrap();
        for name in GUI_STACK_REEXEC_MARKERS
            .iter()
            .copied()
            .chain([CLI_REEXEC_MARKER])
        {
            assert!(std::env::var_os(name).is_none(), "{name}");
        }
    }

    #[test]
    fn cli_loader_exec_failure_is_fatal_to_dispatch() {
        let dir = tempfile::tempdir().unwrap();
        let command = reexec_command(
            &dir.path().join("absent"),
            OsStr::new("cs"),
            [],
            OsStr::new("/usr/lib"),
            4242,
        );
        assert!(execute(command)
            .unwrap_err()
            .contains("CLI loader re-exec failed"));
    }
}
