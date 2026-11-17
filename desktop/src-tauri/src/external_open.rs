//! External links use the host's programs and environment, even in an AppImage.

use tauri_plugin_opener::OpenerExt;

fn validated_url(target: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(target).map_err(|_| "invalid external URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https" | "mailto" | "tel") {
        return Err("external links must use http, https, mailto or tel".into());
    }
    Ok(url)
}

/// Open a supported external URL through the host's registered application.
pub(crate) fn open<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    target: &str,
) -> Result<(), String> {
    let url = validated_url(target)?;
    #[cfg(target_os = "linux")]
    if let Some(commands) =
        chan_server::appimage_browser_commands(url.as_str(), std::env::vars_os())
    {
        let mut tried: Vec<String> = Vec::new();
        for mut command in commands {
            tried.push(command.get_program().to_string_lossy().into_owned());
            if let Ok(mut child) = command.spawn() {
                // Reap the launcher without holding a sign-in attempt or the UI thread.
                tauri::async_runtime::spawn_blocking(move || match child.wait() {
                    Ok(status) if !status.success() => {
                        tracing::warn!(%status, "the host link opener failed");
                    }
                    Err(error) => {
                        tracing::warn!(%error, "waiting for the host link opener failed")
                    }
                    Ok(_) => {}
                });
                return Ok(());
            }
        }
        return Err(format!(
            "starting the host link opener (tried {})",
            tried.join(", ")
        ));
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
            assert!(chan_server::appimage_browser_commands(
                url.as_str(),
                parent.into_iter().map(|(k, v)| (k.into(), v.into()))
            )
            .is_none());
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
            (&host_bin, "#!/bin/sh\n[ \"$#\" = 1 ] || exit 92\n[ -z \"${APPDIR+x}${APPIMAGE+x}${PYTHONHOME+x}${LD_LIBRARY_PATH+x}${GDK_BACKEND+x}${GTK_THEME+x}\" ] || exit 93\nprintf '%s' \"$1\"\n"),
        ] {
            let path = directory.join("xdg-open");
            std::fs::write(&path, script).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let url = validated_url("https://example.com/path?q=a%20b&other=x#part").unwrap();
        // Reduced fixture like the serve tests: one mount entry plus a
        // trailing empty entry, with the GTK keys the terminal scrub drops.
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
            ("GDK_BACKEND".into(), "x11".into()),
            (
                "GTK_THEME".into(),
                mount.join("usr/share/themes/Bundle").into_os_string(),
            ),
        ];
        let mut commands = chan_server::appimage_browser_commands(url.as_str(), parent)
            .expect("AppImage commands");
        let command = commands.first_mut().expect("at least one candidate");
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
