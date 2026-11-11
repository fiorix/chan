//! The paths a GUI launch of chan-desktop was given: `chan-desktop PATH...`
//! and the file URIs a desktop entry's `%U` expands to. A launch that finds a
//! desktop running hands each one to it as the handoff's `OpenPath`
//! (`single_instance`); a launch that boots the desktop opens them itself
//! during its boot. Either way the path lands as `cs open PATH` typed in a
//! standalone window would.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use chan_server::handoff::Response;

use crate::{serve, terminal_mode, AppState};

/// What a GUI launch's arguments come to.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct LaunchArgs {
    /// The absolute paths to open, in argument order.
    pub(crate) paths: Vec<String>,
    /// The arguments that name nothing this desktop can open, each with the
    /// reason, for one log line apiece: the rest of the launch goes on.
    pub(crate) skipped: Vec<(String, String)>,
}

/// Read a GUI launch's arguments. An argument that starts with `-` is an
/// option and is left alone, as a GUI launch has always left its options (an
/// old macOS Finder passes `-psn_...`); an empty argument is ignored. A
/// relative path is made absolute against `cwd`, the launch's working
/// directory, and a `file://` URI is percent-decoded. An argument that names
/// nothing this desktop can open is skipped with its reason, because a desktop
/// entry hands over every URI a file manager selected (`smb://` and `sftp://`
/// on a network mount among them): a URI of another scheme, a file URI naming
/// another host or encoding a `/` or a NUL in a name, a relative path with no
/// working directory, a path that is not UTF-8, which the request's JSON
/// cannot carry. `Err` is the sentence for a usage error: a terminal-mode
/// option (`-e`, `--`, `--dir` and the rest) beside a path, since a launch
/// either opens paths or runs a terminal, and that one is a mistake rather
/// than a path.
pub(crate) fn from_args(
    args: impl IntoIterator<Item = OsString>,
    cwd: Option<&Path>,
) -> Result<LaunchArgs, String> {
    let args: Vec<OsString> = args.into_iter().filter(|arg| !arg.is_empty()).collect();
    if args.iter().any(|arg| !is_option(arg)) {
        if let Some(option) = args
            .iter()
            .find(|arg| terminal_mode::is_terminal_option(arg))
        {
            return Err(format!(
                "{} is a terminal option and the launch also names a path: open paths with one \
                 chan-desktop and run a terminal with another",
                option.to_string_lossy()
            ));
        }
    }
    let mut launch = LaunchArgs::default();
    for arg in args.iter().filter(|arg| !is_option(arg)) {
        match resolve(arg, cwd).and_then(|path| {
            path.into_os_string().into_string().map_err(|path| {
                format!(
                    "{} is not valid UTF-8, so it cannot be sent to chan-desktop",
                    Path::new(&path).display()
                )
            })
        }) {
            Ok(path) => launch.paths.push(path),
            Err(why) => launch
                .skipped
                .push((arg.to_string_lossy().into_owned(), why)),
        }
    }
    Ok(launch)
}

fn is_option(arg: &OsStr) -> bool {
    arg.to_string_lossy().starts_with('-')
}

fn resolve(arg: &OsStr, cwd: Option<&Path>) -> Result<PathBuf, String> {
    if let Some(text) = arg.to_str() {
        if let Some(uri) = as_uri(text) {
            return file_uri_path(text, &uri);
        }
    }
    let path = Path::new(arg);
    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }
    match cwd {
        Some(cwd) => Ok(cwd.join(path)),
        None => Err(format!(
            "{} is relative and this launch has no working directory to resolve it in",
            path.display()
        )),
    }
}

/// `text` as a URI when it has a scheme of two letters or more, so a Windows
/// drive letter (`C:\notes.md`) stays a path.
fn as_uri(text: &str) -> Option<url::Url> {
    url::Url::parse(text)
        .ok()
        .filter(|uri| uri.scheme().len() > 1)
}

/// The local path a `file://` URI names. The host is checked here rather than
/// left to `to_file_path`, which on Windows makes `file://host/share/...` a UNC
/// path; a `/` or a NUL encoded in a name (`%2F`, `%00`) is refused, since
/// decoding it would split the name or end it.
fn file_uri_path(text: &str, uri: &url::Url) -> Result<PathBuf, String> {
    if uri.scheme() != "file" {
        return Err(format!(
            "{text} is not a file: chan-desktop opens files and directories, given as paths or \
             file:// URIs"
        ));
    }
    if let Some(host) = uri
        .host_str()
        .filter(|host| !host.is_empty() && !host.eq_ignore_ascii_case("localhost"))
    {
        return Err(format!(
            "{text} names the host {host}: chan-desktop opens files on this machine only"
        ));
    }
    let encoded = uri.path().to_ascii_lowercase();
    if encoded.contains("%2f") || encoded.contains("%00") {
        return Err(format!(
            "{text} encodes a / or a NUL inside a name, which no file name holds"
        ));
    }
    uri.to_file_path()
        .map_err(|()| format!("{text} names no local path"))
}

/// The environment the GUI app is built with, for Tauri's restart after an
/// update: this launch's own argv without its paths. Tauri relaunches with
/// the managed [`tauri::Env`]'s arguments, so with the launch's own the new
/// process would open every path again in a window of its own, and on macOS,
/// where LaunchServices starts it in `/`, refuse the relative ones. Managed on
/// the builder, it is the `Env` the app keeps: Tauri's own, set at build, is
/// refused as already managed.
pub(crate) fn relaunch_env() -> tauri::Env {
    let mut env = tauri::Env::default();
    env.args_os = relaunch_args(std::mem::take(&mut env.args_os));
    env
}

/// `argv[0]` and the options, without the arguments [`from_args`] reads.
fn relaunch_args(args: Vec<OsString>) -> Vec<OsString> {
    let mut args = args.into_iter();
    args.next()
        .into_iter()
        .chain(args.filter(|arg| is_option(arg)))
        .collect()
}

/// Open the paths a launch that booted this desktop was given, one after the
/// other, as the handoff's `OpenPath` would: the first reuses or mints the
/// standalone window and the rest land in it. A path that cannot be opened is
/// logged and the others still open.
pub(crate) async fn open_at_boot(state: Arc<AppState>, paths: &[String]) {
    for path in paths {
        match serve::open_path_in_standalone_window(Arc::clone(&state), path).await {
            Response::PathOpened { message, .. } => {
                tracing::info!(%message, "opened a path this launch was given")
            }
            other => {
                tracing::warn!(%path, reply = ?other, "could not open a path this launch was given")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    fn skipped(arg: &str, why: &str) -> (String, String) {
        (arg.to_string(), why.to_string())
    }

    #[cfg(unix)]
    #[test]
    fn plain_paths_are_made_absolute_against_the_working_directory() {
        let launch = from_args(
            args(&["notes.md", "../docs", "/srv/readme.md", "./a b/c.md"]),
            Some(Path::new("/home/u/work")),
        )
        .unwrap();
        assert_eq!(
            launch.paths,
            [
                "/home/u/work/notes.md",
                "/home/u/work/../docs",
                "/srv/readme.md",
                "/home/u/work/./a b/c.md",
            ]
        );
        assert_eq!(launch.skipped, Vec::<(String, String)>::new());
    }

    #[cfg(unix)]
    #[test]
    fn file_uris_are_percent_decoded() {
        let launch = from_args(
            args(&[
                "file:///tmp/a%20b.md",
                "file://localhost/srv/caf%C3%A9.md",
                "file:///home/u/dir/",
            ]),
            None,
        )
        .unwrap();
        assert_eq!(
            launch.paths,
            ["/tmp/a b.md", "/srv/caf\u{e9}.md", "/home/u/dir/"]
        );
        assert_eq!(launch.skipped, Vec::<(String, String)>::new());
    }

    /// A desktop entry hands over every URI a file manager selected; one of
    /// another scheme is skipped with its reason and the rest are delivered,
    /// and a launch left with no path is a launch without paths.
    #[cfg(unix)]
    #[test]
    fn a_uri_of_another_scheme_is_skipped_and_the_rest_delivered() {
        let not_a_file = |uri: &str| {
            skipped(
                uri,
                &format!(
                    "{uri} is not a file: chan-desktop opens files and directories, given as \
                     paths or file:// URIs"
                ),
            )
        };
        let launch = from_args(
            args(&[
                "/srv/a.md",
                "smb://nas/share/notes.md",
                "sftp://host/home/u/x.md",
                "file:///srv/b.md",
            ]),
            None,
        )
        .unwrap();
        assert_eq!(launch.paths, ["/srv/a.md", "/srv/b.md"]);
        assert_eq!(
            launch.skipped,
            [
                not_a_file("smb://nas/share/notes.md"),
                not_a_file("sftp://host/home/u/x.md")
            ]
        );
        let only = from_args(
            args(&["https://example.com/notes.md", "mailto:someone@example.com"]),
            None,
        )
        .unwrap();
        assert_eq!(only.paths, Vec::<String>::new());
        assert_eq!(
            only.skipped,
            [
                not_a_file("https://example.com/notes.md"),
                not_a_file("mailto:someone@example.com")
            ]
        );
    }

    /// The host is read before the URI becomes a path, on every platform:
    /// Windows would otherwise make `file://host/share/...` a UNC path.
    #[test]
    fn a_file_uri_on_another_host_is_skipped() {
        let launch = from_args(args(&["file://nas.local/share/notes.md"]), None).unwrap();
        assert_eq!(launch.paths, Vec::<String>::new());
        assert_eq!(
            launch.skipped,
            [skipped(
                "file://nas.local/share/notes.md",
                "file://nas.local/share/notes.md names the host nas.local: chan-desktop opens \
                 files on this machine only"
            )]
        );
    }

    /// Decoding `%2F` or `%00` would split a name or end it, so such a URI
    /// names no file and is skipped.
    #[test]
    fn a_file_uri_encoding_a_slash_or_a_nul_in_a_name_is_skipped() {
        for uri in [
            "file:///srv/a%2Fb.md",
            "file:///srv/a%2fb.md",
            "file:///srv/a%00b.md",
        ] {
            let launch = from_args(args(&[uri]), None).unwrap();
            assert_eq!(launch.paths, Vec::<String>::new(), "{uri}");
            assert_eq!(
                launch.skipped,
                [skipped(
                    uri,
                    &format!("{uri} encodes a / or a NUL inside a name, which no file name holds")
                )]
            );
        }
    }

    #[test]
    fn options_and_empty_arguments_are_left_alone() {
        assert_eq!(
            from_args(args(&["-psn_0_12345", "--some-flag", ""]), None).unwrap(),
            LaunchArgs::default()
        );
    }

    /// A terminal-mode option beside a path is a mistake, not a path: the
    /// arguments after `-e` would otherwise be read as paths, and a missing
    /// one created empty.
    #[test]
    fn a_terminal_option_beside_a_path_is_a_usage_error() {
        for (argv, option) in [
            (&["notes.md", "-e", "htop"][..], "-e"),
            (&["notes.md", "--", "htop"][..], "--"),
            (&["notes.md", "--title=x"][..], "--title=x"),
            (&["notes.md", "--dir", "/srv"][..], "--dir"),
            (&["notes.md", "--hold"][..], "--hold"),
        ] {
            assert_eq!(
                from_args(args(argv), Some(Path::new("/srv"))),
                Err(format!(
                    "{option} is a terminal option and the launch also names a path: open paths \
                     with one chan-desktop and run a terminal with another"
                )),
                "{argv:?}"
            );
        }
        assert_eq!(
            from_args(args(&["--hold"]), None).unwrap(),
            LaunchArgs::default(),
            "with no path there is nothing to refuse"
        );
    }

    #[test]
    fn a_relative_path_without_a_working_directory_is_skipped() {
        let launch = from_args(args(&["notes.md"]), None).unwrap();
        assert_eq!(launch.paths, Vec::<String>::new());
        assert_eq!(
            launch.skipped,
            [skipped(
                "notes.md",
                "notes.md is relative and this launch has no working directory to resolve it in"
            )]
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_path_that_is_not_utf8_is_skipped() {
        use std::os::unix::ffi::OsStringExt;
        let arg = OsString::from_vec(b"/tmp/bad-\xff.md".to_vec());
        let launch = from_args([arg], None).unwrap();
        assert_eq!(launch.paths, Vec::<String>::new());
        assert_eq!(
            launch.skipped,
            [skipped(
                "/tmp/bad-\u{fffd}.md",
                "/tmp/bad-\u{fffd}.md is not valid UTF-8, so it cannot be sent to chan-desktop"
            )]
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_drive_letter_path_is_a_path_not_a_uri() {
        assert_eq!(
            from_args(args(&[r"C:\notes\a.md"]), None).unwrap().paths,
            [r"C:\notes\a.md"]
        );
    }

    /// An update's relaunch keeps `argv[0]` and the options and drops what
    /// the boot already opened.
    #[test]
    fn a_relaunch_carries_the_options_and_not_the_paths() {
        assert_eq!(
            relaunch_args(args(&[
                "/opt/chan/chan-desktop",
                "notes.md",
                "--some-flag",
                "file:///srv/a.md",
                "-psn_0_12345",
                "smb://nas/x.md",
            ])),
            args(&["/opt/chan/chan-desktop", "--some-flag", "-psn_0_12345"])
        );
        assert_eq!(
            relaunch_args(args(&["chan-desktop"])),
            args(&["chan-desktop"])
        );
        assert_eq!(relaunch_args(Vec::new()), Vec::<OsString>::new());
    }

    /// Tauri's restart reads the app's managed `Env`; one managed on the
    /// builder is the one the built app keeps, not the default Tauri manages
    /// at build.
    #[test]
    fn the_env_managed_on_the_builder_is_the_one_a_restart_reads() {
        use tauri::Manager;
        let mut env = tauri::Env::default();
        env.args_os = args(&["chan-desktop", "--kept"]);
        let app = tauri::test::mock_builder()
            .manage(env)
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        assert_eq!(app.env().args_os, args(&["chan-desktop", "--kept"]));
    }

    /// The boot opens the launch's paths as the handoff would: in one
    /// standalone window, minted for the first path and reused for the next,
    /// holding no terminal of its own, a path it cannot open skipped. A
    /// desktop shutting down opens nothing.
    #[cfg(unix)]
    #[test]
    fn the_boot_opens_the_launch_paths_in_one_standalone_window() {
        if !crate::embedded::in_own_chan_home(
            "launch_paths::tests::the_boot_opens_the_launch_paths_in_one_standalone_window",
        ) {
            return;
        }
        let desktop = crate::tests::handoff_row::Desktop::new();
        let files = tempfile::tempdir().unwrap();
        let docs = files.path().join("docs");
        std::fs::create_dir(&docs).unwrap();
        let notes = files.path().join("notes.md");
        std::fs::write(&notes, "# notes\n").unwrap();
        let gone = files.path().join("gone").join("x.md");
        let paths: Vec<String> = [&docs, &gone, &notes]
            .iter()
            .map(|path| path.to_str().unwrap().to_string())
            .collect();
        desktop
            .runtime
            .block_on(open_at_boot(Arc::clone(&desktop.state), &paths));
        let terminals: Vec<String> = desktop
            .embedded()
            .local_window_records()
            .into_iter()
            .filter(|row| matches!(row.kind, chan_server::WindowKind::Terminal))
            .map(|row| row.window_id)
            .collect();
        assert_eq!(terminals.len(), 1, "{terminals:?}");
        assert!(
            desktop
                .embedded()
                .host_for_tests()
                .is_routed_mint(&terminals[0]),
            "the window seeds no terminal: its content is the paths"
        );

        desktop
            .state
            .shutdown_started
            .store(true, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(
            desktop
                .runtime
                .block_on(serve::open_path_in_standalone_window(
                    Arc::clone(&desktop.state),
                    notes.to_str().unwrap(),
                )),
            Response::Error {
                message: crate::single_instance::SHUTTING_DOWN.into()
            }
        );
    }
}
