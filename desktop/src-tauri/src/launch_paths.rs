//! The paths a GUI launch of chan-desktop was given: `chan-desktop PATH...`
//! and the file URIs a desktop entry's `%U` expands to. A launch that finds a
//! desktop running hands each one to it as the handoff's `OpenPath`
//! (`single_instance`); a launch that boots the desktop opens them itself
//! during its boot. Either way the path lands as `cs open PATH` typed in a
//! standalone window would. On macOS a file Finder opens comes as an
//! open-file event's URL instead of an argument (`open_events`), read here by
//! [`from_urls`] as a launch's file URIs are. A desktop that a `chan-term`
//! started comes with the terminal it asked for instead
//! ([`take_boot_terminal`]), which its boot opens as a handed-over one.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use chan_server::handoff::{self, Response};

use crate::{serve, AppState};

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
/// old macOS Finder passes `-psn_...`); an empty argument is ignored. Every
/// other one is read as `chan-files` reads its paths
/// ([`handoff::launch_arg_path`]), and one that names nothing this desktop can
/// open is skipped with its reason. `Err` is the sentence for a usage error:
/// an option of `chan-term`'s launch (`-e`, `--`, `--dir` and the rest), which
/// runs terminals where chan-desktop opens paths; left alone, the arguments
/// after `-e` would be read as paths, and a missing one created empty.
pub(crate) fn from_args(
    args: impl IntoIterator<Item = OsString>,
    cwd: Option<&Path>,
) -> Result<LaunchArgs, String> {
    let args: Vec<OsString> = args.into_iter().filter(|arg| !arg.is_empty()).collect();
    if let Some(option) = args.iter().find(|arg| chan::term::is_launch_option(arg)) {
        return Err(format!(
            "{} is a chan-term option: run the terminal with chan-term, which takes it",
            option.to_string_lossy()
        ));
    }
    let mut launch = LaunchArgs::default();
    for arg in args.iter().filter(|arg| !is_option(arg)) {
        launch.add(
            arg.to_string_lossy().into_owned(),
            handoff::launch_arg_path(arg, cwd),
        );
    }
    Ok(launch)
}

/// Read the URLs an open-file event delivers (`open_events`) as [`from_args`]
/// reads a launch's file URIs, through the same reader
/// ([`handoff::launch_arg_path`]): a `file://` URL is percent-decoded with its
/// host checked, and one that names nothing this desktop can open is skipped
/// with its reason.
pub(crate) fn from_urls(urls: impl IntoIterator<Item = tauri::Url>) -> LaunchArgs {
    let mut launch = LaunchArgs::default();
    for url in urls {
        let text = url.as_str();
        launch.add(
            text.to_string(),
            handoff::launch_arg_path(OsStr::new(text), None),
        );
    }
    launch
}

impl LaunchArgs {
    /// Keep the path an argument was read as, or skip the argument with the
    /// reason it names nothing to open.
    fn add(&mut self, arg: String, read: Result<String, String>) {
        match read {
            Ok(path) => self.paths.push(path),
            Err(why) => self.skipped.push((arg, why)),
        }
    }
}

fn is_option(arg: &OsStr) -> bool {
    arg.to_string_lossy().starts_with('-')
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

/// The terminal a `chan-term` that started this desktop asked for
/// ([`handoff::OPEN_TERMINAL_ENV`]): the absolute directory its shell starts
/// in. Read and dropped before any thread starts, so no child of the desktop
/// inherits it; a value that is no absolute UTF-8 path names no terminal and
/// is logged.
pub(crate) fn take_boot_terminal() -> Option<String> {
    let value = std::env::var_os(handoff::OPEN_TERMINAL_ENV)?;
    std::env::remove_var(handoff::OPEN_TERMINAL_ENV);
    match value.into_string() {
        Ok(dir) if Path::new(&dir).is_absolute() => Some(dir),
        other => {
            tracing::warn!(value = ?other, "ignoring a launch terminal that names no absolute directory");
            None
        }
    }
}

/// Open the terminal a `chan-term` that started this desktop asked for, as
/// the handoff's `OpenTerminal` opens one: a throwaway terminal window whose
/// shell starts in `dir`. `true` when it opened, so the boot opens no other
/// first window beside it.
pub(crate) async fn open_terminal_at_boot(state: Arc<AppState>, dir: Option<&str>) -> bool {
    let Some(dir) = dir else {
        return false;
    };
    match serve::spawn_throwaway_terminal_window(state, PathBuf::from(dir)).await {
        Ok(label) => {
            tracing::info!(%dir, %label, "opened the terminal the launch asked for");
            true
        }
        Err(error) => {
            tracing::warn!(%dir, %error, "could not open the terminal the launch asked for");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    #[cfg(unix)]
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
                    "{uri} is not a file: chan opens files and directories, given as paths or \
                     file:// URIs"
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

    #[test]
    fn options_and_empty_arguments_are_left_alone() {
        assert_eq!(
            from_args(args(&["-psn_0_12345", "--some-flag", ""]), None).unwrap(),
            LaunchArgs::default()
        );
    }

    /// An option of `chan-term`'s launch is a usage error that points there,
    /// with a path beside it or none: chan-desktop runs no terminal, and the
    /// arguments after `-e` would otherwise be read as paths, and a missing
    /// one created empty.
    #[test]
    fn a_chan_term_option_is_a_usage_error() {
        for (argv, option) in [
            (&["notes.md", "-e", "htop"][..], "-e"),
            (&["-e", "htop"][..], "-e"),
            (&["notes.md", "--", "htop"][..], "--"),
            (&["notes.md", "--title=x"][..], "--title=x"),
            (&["--dir", "/srv"][..], "--dir"),
            (&["--dir=/srv"][..], "--dir=/srv"),
            (&["--hold"][..], "--hold"),
            (
                &["--app-id=TUI.float", "-e", "btop"][..],
                "--app-id=TUI.float",
            ),
        ] {
            assert_eq!(
                from_args(args(argv), Some(Path::new("/srv"))),
                Err(format!(
                    "{option} is a chan-term option: run the terminal with chan-term, which \
                     takes it"
                )),
                "{argv:?}"
            );
        }
    }

    /// An open-file event's URLs read as the same URIs given to a launch do:
    /// percent-decoded, another host, another scheme and an encoded `/` or
    /// NUL skipped with the launch's own reasons, in event order, on every
    /// platform.
    #[test]
    fn an_open_file_events_urls_read_as_a_launchs_file_uris() {
        let uris = [
            "file:///tmp/a%20b.md",
            "file://localhost/srv/caf%C3%A9.md",
            "file:///home/u/dir/",
            "file://nas.local/share/notes.md",
            "smb://nas/share/notes.md",
            "https://example.com/notes.md",
            "file:///srv/a%2Fb.md",
            "file:///srv/a%00b.md",
            "file://localhost/srv/c%2Fd.md",
        ];
        let urls: Vec<tauri::Url> = uris
            .iter()
            .map(|uri| tauri::Url::parse(uri).unwrap())
            .collect();
        // The url crate spells `file://localhost/...` as `file:///...`, which
        // an event's skip names, so the launch is given each URL so spelled.
        let spelled: Vec<OsString> = urls.iter().map(|url| url.as_str().into()).collect();
        let event = from_urls(urls);
        assert_eq!(event, from_args(spelled, None).unwrap());
        // A Unix path has no drive letter, so Windows names none of these.
        #[cfg(unix)]
        {
            assert_eq!(
                event.paths,
                ["/tmp/a b.md", "/srv/caf\u{e9}.md", "/home/u/dir/"]
            );
            assert_eq!(
                event
                    .skipped
                    .iter()
                    .map(|(uri, _)| uri.as_str())
                    .collect::<Vec<_>>(),
                [
                    "file://nas.local/share/notes.md",
                    "smb://nas/share/notes.md",
                    "https://example.com/notes.md",
                    "file:///srv/a%2Fb.md",
                    "file:///srv/a%00b.md",
                    "file:///srv/c%2Fd.md",
                ]
            );
        }
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

    /// The carrier a `chan-term` started this desktop with is read once and
    /// dropped from the environment whatever it holds, so no child of the
    /// desktop inherits it; only an absolute UTF-8 directory names a
    /// terminal. It mutates the process environment, so it runs in a test
    /// process of its own, which starts with no carrier whatever the runner
    /// had.
    #[test]
    fn the_boot_terminal_is_read_once_dropped_and_absolute_only() {
        if !crate::embedded::in_own_chan_home(
            "launch_paths::tests::the_boot_terminal_is_read_once_dropped_and_absolute_only",
        ) {
            return;
        }
        let carrier = handoff::OPEN_TERMINAL_ENV;
        std::env::remove_var(carrier);
        let absolute = if cfg!(windows) {
            r"C:\srv\notes"
        } else {
            "/srv/notes"
        };
        assert_eq!(take_boot_terminal(), None, "no carrier, no terminal");
        std::env::set_var(carrier, absolute);
        assert_eq!(take_boot_terminal(), Some(absolute.to_string()));
        assert_eq!(std::env::var_os(carrier), None, "the carrier is dropped");
        assert_eq!(take_boot_terminal(), None, "it is read once");
        #[cfg_attr(not(unix), allow(unused_mut))]
        let mut refused = vec![OsString::from("notes"), OsString::from("")];
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStringExt;
            refused.push(OsString::from_vec(b"/srv/caf\xe9".to_vec()));
        }
        for value in refused {
            std::env::set_var(carrier, &value);
            assert_eq!(take_boot_terminal(), None, "{value:?} names no terminal");
            assert_eq!(std::env::var_os(carrier), None, "{value:?} is dropped");
        }
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
