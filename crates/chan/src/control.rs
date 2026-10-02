use std::path::{Path, PathBuf};

/// Find a control socket for `pid`. A window-spawned server's sockets carry
/// the pid in their name (`chan-control-<pid>-<rand>`) and match by name
/// alone; a devserver's are stable-named (`chan-control-s<hash>`, no pid,
/// so `$CHAN_CONTROL_SOCKET` survives its restarts) and are matched
/// by asking each candidate who it is (a bounded `Identify` round-trip whose
/// reply carries the serving pid). A dedicated `chan serve` serve has exactly
/// one socket; a multi-tenant devserver has one per tenant under the same
/// pid. Either way every socket routes the `Close { path }` verb to the
/// server, which acts by path -- so the first match is sufficient and we
/// must NOT broadcast (once the first tenant unmounts, the rest 404). On
/// Unix control sockets live in a validated `$XDG_RUNTIME_DIR` or the private
/// `/tmp/chan-control-<uid>` fallback; on Windows they are named pipes.
#[cfg(unix)]
pub(super) async fn control_socket_for_pid(pid: u32) -> Option<PathBuf> {
    control_socket_for_pid_in_dirs(unix_control_socket_dirs(), pid, true).await
}

#[cfg(unix)]
pub(super) async fn control_socket_for_workspace(
    pid: u32,
    workspace_root: &Path,
    metadata_key: &str,
) -> Option<PathBuf> {
    control_socket_for_workspace_in_dirs(
        unix_control_socket_dirs(),
        pid,
        workspace_root,
        metadata_key,
        true,
    )
    .await
}

#[cfg(unix)]
fn unix_control_socket_dirs() -> Vec<PathBuf> {
    let xdg_dir = std::env::var_os("XDG_RUNTIME_DIR")
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from);
    unix_control_socket_dirs_at(Path::new("/tmp"), xdg_dir.as_deref(), |err| {
        eprintln!("{err}")
    })
}

#[cfg(unix)]
fn unix_control_socket_dirs_at(
    fallback_parent: &Path,
    xdg_dir: Option<&Path>,
    mut report: impl FnMut(&std::io::Error),
) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(dir) = xdg_dir {
        match chan_shell::validate_control_socket_dir(dir) {
            Ok(()) => push_unique_path(&mut dirs, dir.to_path_buf()),
            Err(err) => report(&err),
        }
    }
    let fallback = chan_shell::control_socket_fallback_dir_at(fallback_parent);
    match chan_shell::validate_control_socket_dir(&fallback) {
        Ok(()) => push_unique_path(&mut dirs, fallback),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => report(&err),
    }
    dirs
}

#[cfg(windows)]
pub(super) async fn control_socket_for_pid(pid: u32) -> Option<PathBuf> {
    // Windows control sockets are named pipes under the `\\.\pipe\`
    // namespace, which is directory-enumerable.
    control_socket_for_pid_in_dirs([std::path::Path::new(r"\\.\pipe\")], pid, false).await
}

#[cfg(windows)]
pub(super) async fn control_socket_for_workspace(
    pid: u32,
    workspace_root: &Path,
    metadata_key: &str,
) -> Option<PathBuf> {
    control_socket_for_workspace_in_dirs(
        [std::path::Path::new(r"\\.\pipe\")],
        pid,
        workspace_root,
        metadata_key,
        false,
    )
    .await
}

async fn control_socket_for_pid_in_dirs<I, P>(
    dirs: I,
    pid: u32,
    require_sock_ext: bool,
) -> Option<PathBuf>
where
    I: IntoIterator<Item = P>,
    P: AsRef<Path>,
{
    let mut seen: Vec<PathBuf> = Vec::new();
    for dir in dirs {
        let dir = dir.as_ref();
        if seen.iter().any(|seen| seen == dir) {
            continue;
        }
        seen.push(dir.to_path_buf());
    }
    // Pass 1, by name: a pid-named socket needs no round-trip.
    for dir in &seen {
        if let Some(socket) = control_socket_for_pid_in(dir, pid, require_sock_ext) {
            return Some(socket);
        }
    }
    // Pass 2, by identity: stable-named candidates carry no pid, so ask each
    // one who it is and match the reported pid. Dead sockets fail the connect
    // immediately; only a live-but-wedged one costs the probe timeout.
    for dir in &seen {
        for candidate in chan_shell::stable_control_socket_candidates(dir, require_sock_ext) {
            if socket_identity_pid(&candidate).await == Some(pid) {
                return Some(candidate);
            }
        }
    }
    None
}

pub(super) async fn control_socket_for_workspace_in_dirs<I, P>(
    dirs: I,
    pid: u32,
    workspace_root: &Path,
    metadata_key: &str,
    require_sock_ext: bool,
) -> Option<PathBuf>
where
    I: IntoIterator<Item = P>,
    P: AsRef<Path>,
{
    let mut candidates = Vec::new();
    for dir in dirs {
        let dir = dir.as_ref();
        for candidate in control_socket_candidates_for_pid_in(dir, pid, require_sock_ext) {
            push_unique_path(&mut candidates, candidate);
        }
        for candidate in chan_shell::stable_control_socket_candidates(dir, require_sock_ext) {
            push_unique_path(&mut candidates, candidate);
        }
    }
    for candidate in candidates {
        let Some(identity) = chan_shell::socket_identity(&candidate).await else {
            continue;
        };
        if identity.pid == pid
            && identity.workspace_root.as_deref() == Some(workspace_root)
            && identity.metadata_key.as_deref() == Some(metadata_key)
        {
            return Some(candidate);
        }
    }
    None
}

/// The pid serving `socket`, from a bounded `Identify` round-trip. `None` for
/// a dead / unreachable / wedged socket or an unparseable reply.
async fn socket_identity_pid(socket: &Path) -> Option<u32> {
    Some(chan_shell::socket_identity(socket).await?.pid)
}

fn push_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.iter().any(|existing| existing == &path) {
        paths.push(path);
    }
}

fn control_socket_candidates_for_pid_in(
    dir: &Path,
    pid: u32,
    require_sock_ext: bool,
) -> Vec<PathBuf> {
    #[cfg(unix)]
    if chan_shell::validate_control_socket_dir(dir).is_err() {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut candidates: Vec<PathBuf> = entries
        .flatten()
        .filter(|entry| {
            control_socket_name_matches(&entry.file_name().to_string_lossy(), pid, require_sock_ext)
        })
        .map(|entry| entry.path())
        .filter(|path| {
            #[cfg(unix)]
            {
                chan_shell::validate_control_socket_node(path).is_ok()
            }
            #[cfg(not(unix))]
            {
                let _ = path;
                true
            }
        })
        .collect();
    candidates.sort();
    candidates
}

fn control_socket_for_pid_in(dir: &Path, pid: u32, require_sock_ext: bool) -> Option<PathBuf> {
    control_socket_candidates_for_pid_in(dir, pid, require_sock_ext)
        .into_iter()
        .next()
}

/// True when `name` is a control socket for `pid`
/// (`chan-control-<pid>-<rand>`), optionally requiring the unix `.sock`
/// suffix (Windows named pipes have no extension).
fn control_socket_name_matches(name: &str, pid: u32, require_sock_ext: bool) -> bool {
    let prefix = format!("chan-control-{pid}-");
    name.starts_with(&prefix) && (!require_sock_ext || name.ends_with(".sock"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use crate::test_support::{empty_workspace_search_result, spawn_workspace_search_stub};

    #[test]
    fn control_socket_for_pid_matches_only_that_pid() {
        let dir = tempfile::TempDir::new().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        // A different pid's control socket and an unrelated chan socket are
        // both ignored.
        #[cfg(unix)]
        let _other =
            std::os::unix::net::UnixListener::bind(dir.path().join("chan-control-999-abcd.sock"))
                .unwrap();
        #[cfg(not(unix))]
        std::fs::write(dir.path().join("chan-control-999-abcd.sock"), b"").unwrap();
        std::fs::write(dir.path().join("chan-mcp-4242-abcd.sock"), b"").unwrap();
        assert_eq!(control_socket_for_pid_in(dir.path(), 4242, true), None);
        // The matching pid's socket is found.
        let want = dir.path().join("chan-control-4242-ef01.sock");
        #[cfg(unix)]
        let _wanted = std::os::unix::net::UnixListener::bind(&want).unwrap();
        #[cfg(not(unix))]
        std::fs::write(&want, b"").unwrap();
        assert_eq!(
            control_socket_for_pid_in(dir.path(), 4242, true),
            Some(want)
        );
    }

    #[tokio::test]
    async fn control_socket_for_pid_searches_candidate_dirs() {
        let first = tempfile::TempDir::new().unwrap();
        let second = tempfile::TempDir::new().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for dir in [&first, &second] {
                std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700))
                    .unwrap();
            }
        }
        let want = second.path().join("chan-control-4242-ef01.sock");
        #[cfg(unix)]
        let _wanted = std::os::unix::net::UnixListener::bind(&want).unwrap();
        #[cfg(not(unix))]
        std::fs::write(&want, b"").unwrap();
        assert_eq!(
            control_socket_for_pid_in_dirs([first.path(), second.path()], 4242, true).await,
            Some(want)
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn control_socket_discovery_refuses_an_untrusted_directory() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("chan-control-4242-ef01.sock");
        let _listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o777)).unwrap();
        assert_eq!(
            control_socket_for_pid_in_dirs([dir.path()], 4242, true).await,
            None,
            "discovered a socket in a directory another user can write"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn control_socket_discovery_refuses_a_regular_file() {
        let dir = tempfile::TempDir::new().unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let socket = dir.path().join("chan-control-4242-ef01.sock");
        std::fs::write(&socket, b"not a socket").unwrap();
        assert_eq!(
            control_socket_for_pid_in_dirs([dir.path()], 4242, true).await,
            None,
            "discovered a regular file as a socket"
        );
    }

    #[cfg(unix)]
    #[test]
    fn control_socket_discovery_skips_a_missing_fallback_silently() {
        let parent = tempfile::TempDir::new().unwrap();
        let fallback = chan_shell::control_socket_fallback_dir_at(parent.path());
        let mut errors = Vec::new();
        let dirs = unix_control_socket_dirs_at(parent.path(), None, |err| {
            errors.push(err.to_string());
        });
        assert!(
            !fallback.exists(),
            "discovery created {}",
            fallback.display()
        );
        assert!(!dirs.contains(&fallback));
        assert!(errors.is_empty(), "missing fallback emitted {errors:?}");
    }

    #[cfg(unix)]
    #[test]
    fn control_socket_discovery_names_an_invalid_existing_fallback() {
        let parent = tempfile::TempDir::new().unwrap();
        let fallback = chan_shell::control_socket_fallback_dir_at(parent.path());
        std::fs::create_dir(&fallback).unwrap();
        let mut errors = Vec::new();
        let dirs = unix_control_socket_dirs_at(parent.path(), None, |err| {
            errors.push(err.to_string());
        });
        assert!(!dirs.contains(&fallback));
        assert_eq!(errors.len(), 1);
        assert!(errors[0].contains(&fallback.display().to_string()));
    }

    /// A stub control server on a unix socket that answers every `Identify`
    /// with the given pid, standing in for a devserver tenant socket.
    #[cfg(unix)]
    fn spawn_identify_stub(socket: &std::path::Path, pid: u32) -> tokio::task::JoinHandle<()> {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        let listener = tokio::net::UnixListener::bind(socket).expect("bind stub socket");
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                let (read, mut write) = stream.into_split();
                let mut line = String::new();
                let _ = BufReader::new(read).read_line(&mut line).await;
                let identity = chan_shell::Identity {
                    kind: chan_shell::ServeKind::Devserver,
                    version: env!("CARGO_PKG_VERSION").to_string(),
                    pid,
                    workspace_root: None,
                    metadata_key: None,
                };
                let reply = chan_shell::ControlResponse::Ok {
                    message: serde_json::to_string(&identity).expect("identity json"),
                };
                let mut out = serde_json::to_vec(&reply).expect("response json");
                out.push(b'\n');
                let _ = write.write_all(&out).await;
            }
        })
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn control_socket_for_pid_probes_stable_named_sockets() {
        // A devserver's stable-named socket carries no pid, so discovery must
        // resolve it through the Identify round-trip. The wrong pid must NOT
        // resolve to it (a stale lock record's holder is genuinely gone).
        let dir = tempfile::TempDir::new().unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let stable = dir.path().join("chan-control-s00aa11bb22cc33dd.sock");
        let stub = spawn_identify_stub(&stable, 4242);
        assert_eq!(
            control_socket_for_pid_in_dirs([dir.path()], 4242, true).await,
            Some(stable.clone())
        );
        assert_eq!(
            control_socket_for_pid_in_dirs([dir.path()], 7777, true).await,
            None
        );
        stub.abort();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn workspace_socket_discovery_matches_root_and_metadata_key() {
        let dir = tempfile::Builder::new()
            .prefix("chan-ws-")
            .tempdir_in("/tmp")
            .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let root_a = tempfile::TempDir::new().unwrap();
        let root_b = tempfile::TempDir::new().unwrap();
        let pid = std::process::id();
        let result = empty_workspace_search_result(root_b.path(), "key-b");
        let wrong = dir.path().join(format!("chan-control-{pid}-a.sock"));
        let right = dir.path().join(format!("chan-control-{pid}-b.sock"));
        let wrong_stub = spawn_workspace_search_stub(
            &wrong,
            chan_shell::Identity {
                kind: chan_shell::ServeKind::Devserver,
                version: env!("CARGO_PKG_VERSION").into(),
                pid,
                workspace_root: Some(root_a.path().to_path_buf()),
                metadata_key: Some("key-a".into()),
            },
            result.clone(),
        );
        let right_stub = spawn_workspace_search_stub(
            &right,
            chan_shell::Identity {
                kind: chan_shell::ServeKind::Devserver,
                version: env!("CARGO_PKG_VERSION").into(),
                pid,
                workspace_root: Some(root_b.path().to_path_buf()),
                metadata_key: Some("key-b".into()),
            },
            result,
        );

        let selected =
            control_socket_for_workspace_in_dirs([dir.path()], pid, root_b.path(), "key-b", true)
                .await;
        assert_eq!(selected, Some(right));
        wrong_stub.abort();
        right_stub.abort();
    }

    #[test]
    fn control_socket_name_matches_pid_and_ext() {
        // A unix `.sock` file matches whether or not the suffix is required.
        assert!(control_socket_name_matches(
            "chan-control-1234-ab.sock",
            1234,
            true
        ));
        assert!(control_socket_name_matches(
            "chan-control-1234-ab.sock",
            1234,
            false
        ));
        // A Windows named pipe (no extension) matches only when the suffix
        // is not required.
        assert!(control_socket_name_matches(
            "chan-control-1234-deadbeef",
            1234,
            false
        ));
        assert!(!control_socket_name_matches(
            "chan-control-1234-deadbeef",
            1234,
            true
        ));
        // A different pid and an unrelated name never match.
        assert!(!control_socket_name_matches(
            "chan-control-9999-ab.sock",
            1234,
            true
        ));
        assert!(!control_socket_name_matches(
            "something-else.sock",
            1234,
            true
        ));
    }
}
