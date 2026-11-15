//! External links use the host's programs and environment, even in an AppImage.

use tauri_plugin_opener::OpenerExt;

fn validated_url(target: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(target).map_err(|_| "invalid external URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https" | "mailto" | "tel") {
        return Err("external links must use http, https, mailto or tel".into());
    }
    Ok(url)
}

#[cfg(target_os = "linux")]
fn appimage_command(
    url: &url::Url,
    parent: impl IntoIterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
) -> Option<std::process::Command> {
    use std::process::{Command, Stdio};

    let parent: Vec<_> = parent.into_iter().collect();
    if !["APPDIR", "APPIMAGE"].iter().all(|name| {
        parent
            .iter()
            .any(|(key, value)| key == name && !value.is_empty())
    }) {
        return None;
    }
    let mut command = Command::new("xdg-open");
    command.env_clear().envs(parent.iter().cloned());
    chan_server::clear_appimage_command_env(&mut command, parent);
    command
        .arg(url.as_str())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    Some(command)
}

/// Open a supported external URL through the host's registered application.
pub(crate) fn open<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    target: &str,
) -> Result<(), String> {
    let url = validated_url(target)?;
    #[cfg(target_os = "linux")]
    if let Some(mut command) = appimage_command(&url, std::env::vars_os()) {
        let mut child = command
            .spawn()
            .map_err(|error| format!("starting the host link opener: {error}"))?;
        // Reap xdg-open without holding a sign-in attempt or the UI thread.
        tauri::async_runtime::spawn_blocking(move || match child.wait() {
            Ok(status) if !status.success() => {
                tracing::warn!(%status, "the host link opener failed");
            }
            Err(error) => tracing::warn!(%error, "waiting for the host link opener failed"),
            Ok(_) => {}
        });
        return Ok(());
    }
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|error| format!("opening an external link: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_link_sites_share_the_host_opener() {
        for (name, source, calls) in [
            ("main", include_str!("main.rs"), 2),
            ("sign-in", include_str!("auth.rs"), 1),
            ("launcher", include_str!("launcher_panel.rs"), 1),
        ] {
            assert_eq!(
                source.matches("external_open::open(").count(),
                calls,
                "{name} must route every external link through the host opener",
            );
            assert!(
                !source.contains(".open_url("),
                "{name} bypasses the host opener"
            );
        }
    }

    #[test]
    fn only_link_schemes_reach_an_opener() {
        for target in [
            "https://example.com/path?q=a%20b#section",
            "http://localhost:8080/",
            "mailto:someone@example.com",
            "tel:+441234567890",
        ] {
            assert!(validated_url(target).is_ok(), "{target}");
        }
        for target in [
            "file:///tmp/example",
            "javascript:alert(1)",
            "data:text/html,hello",
            "custom:handler",
            "/tmp/example",
            "--help",
            "https://",
        ] {
            assert!(validated_url(target).is_err(), "{target}");
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn incomplete_appimage_identity_keeps_the_platform_opener() {
        let url = validated_url("https://example.com").unwrap();
        for parent in [
            vec![],
            vec![("APPDIR", "/tmp/mount")],
            vec![("APPIMAGE", "/tmp/Chan.AppImage")],
            vec![("APPDIR", ""), ("APPIMAGE", "/tmp/Chan.AppImage")],
            vec![("APPDIR", "/tmp/mount"), ("APPIMAGE", "")],
        ] {
            assert!(
                appimage_command(&url, parent.into_iter().map(|(k, v)| (k.into(), v.into())))
                    .is_none()
            );
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn host_link_command_resolves_the_scrubbed_path_and_keeps_one_url_argument() {
        use std::os::unix::fs::PermissionsExt;
        use std::process::Stdio;

        let temp = tempfile::tempdir().unwrap();
        let mount = temp.path().join("mount");
        let bundled_bin = mount.join("usr/bin");
        let host_bin = temp.path().join("host bin");
        std::fs::create_dir_all(&bundled_bin).unwrap();
        std::fs::create_dir_all(&host_bin).unwrap();
        // Executable stand-ins distinguish PATH lookup as well as argv shape.
        for (directory, script) in [
            (&bundled_bin, "#!/bin/sh\nexit 91\n"),
            (&host_bin, "#!/bin/sh\n[ \"$#\" = 1 ] || exit 92\n[ -z \"${APPDIR+x}${APPIMAGE+x}${PYTHONHOME+x}${LD_LIBRARY_PATH+x}\" ] || exit 93\nprintf '%s' \"$1\"\n"),
        ] {
            let path = directory.join("xdg-open");
            std::fs::write(&path, script).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let url = validated_url("https://example.com/path?q=a%20b&other=x#part").unwrap();
        let parent = vec![
            ("APPDIR".into(), mount.as_os_str().to_owned()),
            (
                "APPIMAGE".into(),
                temp.path().join("Chan.AppImage").into_os_string(),
            ),
            (
                "PATH".into(),
                std::env::join_paths([&bundled_bin, &host_bin]).unwrap(),
            ),
            ("PYTHONHOME".into(), mount.join("usr").into_os_string()),
            (
                "LD_LIBRARY_PATH".into(),
                format!("{}/usr/lib:", mount.display()).into(),
            ),
        ];
        let mut command = appimage_command(&url, parent).expect("AppImage command");
        assert_eq!(command.get_program(), "xdg-open");
        assert_eq!(command.get_args().collect::<Vec<_>>(), [url.as_str()]);
        let output = command
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        assert_eq!(output.stdout, url.as_str().as_bytes());
        assert!(output.stderr.is_empty());
    }
}
