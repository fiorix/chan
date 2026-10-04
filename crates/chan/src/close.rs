use std::fmt;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use chan_workspace::{KnownWorkspace, Library};
use serde::Deserialize;

use crate::control::control_socket_for_pid;
use crate::registry::{library, same_path};
use crate::remote::{cmd_workspace_close_remote, cmd_workspace_forget_remote};
use crate::Personality;

/// Exit status of a `chan workspace forget` whose server answered that the
/// workspace is still releasing: nothing was forgotten, because the server
/// has not let go of the workspace. `EX_TEMPFAIL` of `sysexits.h`, which
/// separates it from a refusal or a failure (exit 1).
const STILL_RELEASING_EXIT: i32 = 75;

/// A `chan workspace forget` whose server answered that the workspace is
/// still releasing. Carried as an `anyhow` error to the dispatch edge, which
/// prints it and exits [`STILL_RELEASING_EXIT`].
#[derive(Debug)]
struct ForgetStillReleasing {
    path: PathBuf,
    /// The server's answer, as it worded it.
    answer: String,
}

impl fmt::Display for ForgetStillReleasing {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} is still registered: its server answered \"{}\"",
            self.path.display(),
            self.answer
        )
    }
}

impl std::error::Error for ForgetStillReleasing {}

/// A close whose reachable host is still releasing its mounted workspace.
/// Keep the host's exact answer for the CLI's temporary-failure report.
#[derive(Debug)]
struct CloseStillReleasing(String);

impl fmt::Display for CloseStillReleasing {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for CloseStillReleasing {}

/// Forget `path` from the registry: drop the registry key and the whole
/// `~/.chan/workspaces/<key>/` metadata dir (trash included), leaving the
/// filesystem contents untouched. Reached through `chan workspace forget`.
/// The caller is responsible for tearing down any running serve first;
/// neither unregister method does so. A selected row is removed by the root
/// it stores, regardless of where that path resolves now.
fn remove_from_registry(lib: &Library, path: &Path, row: Option<&KnownWorkspace>) -> Result<()> {
    // Capture the metadata root before `unregister_workspace` drops the
    // registry key (after which the path no longer resolves to it).
    let metadata_root = row
        .map(|row| lib.workspace_paths_for_row(row).root)
        .or_else(|| lib.workspace_paths_for(path).map(|p| p.root));
    let removed = match row {
        Some(row) => lib.unregister_workspace_row(&row.root_path, &row.root_path),
        None => lib.unregister_workspace(path),
    }
    .with_context(|| format!("unregistering {}", path.display()))?;
    if removed {
        // `reset_workspace(Everything)` deliberately preserves the trash +
        // lock dirs (other callers rely on that). Forgetting a workspace means
        // "forget everything", so drop the whole metadata dir -- trash
        // included -- leaving no `~/.chan/workspaces/<key>/` behind.
        if let Some(root) = metadata_root {
            let _ = std::fs::remove_dir_all(&root);
        }
        println!("unregistered: {}", path.display());
    } else {
        println!("(not registered: {})", path.display());
    }
    Ok(())
}

/// A typed path names its exact stored row when every `..` pops a plain directory.
/// Other paths use the resolved lookup.
fn stored_row_named_by(lib: &Library, path: &Path) -> Result<Option<KnownWorkspace>> {
    let given = chan_workspace::paths::strip_verbatim_prefix(path);
    let absolute = if given.is_absolute() {
        given
    } else {
        std::env::current_dir()?.join(given)
    };
    let mut given = PathBuf::new();
    for component in chan_workspace::paths::strip_verbatim_prefix(&absolute).components() {
        match component {
            Component::ParentDir => {
                if !matches!(std::fs::symlink_metadata(&given), Ok(meta) if meta.file_type().is_dir())
                {
                    return Ok(None);
                }
                given.pop();
            }
            Component::CurDir => {}
            other => given.push(other.as_os_str()),
        }
    }
    Ok(lib
        .list_workspaces()
        .into_iter()
        .find(|row| row.root_path == given))
}

/// `chan close {path}`: tear down a running server holding `path`, releasing
/// its writer lock. Best-effort -- "not currently served" (and an unreachable
/// holder) is treated as success, since the goal is "this workspace is not
/// served". A reachable host's still-releasing answer is a temporary failure.
/// With `remove`, it then also forgets the workspace from the registry
/// (`chan workspace forget`), unless the holder refused the teardown over live
/// terminals or a discovered devserver cannot complete the removal.
async fn cmd_close(path: PathBuf, remove: bool, personality: Personality) -> Result<()> {
    let lib = library()?;
    let row = if remove {
        stored_row_named_by(&lib, &path)?
    } else {
        None
    };
    // Pass `remove` through so a host (devserver/desktop) that serves this
    // workspace also unregisters it from its own library + overlay; the local
    // `remove_from_registry` below then handles the caller's config.toml +
    // metadata (and the not-served / standalone cases the host can't).
    match unserve_running(&lib, &path, remove, personality, row.as_ref()).await {
        Ok(UnserveOutcome::Unserved) => println!("closed: {}", path.display()),
        Ok(UnserveOutcome::NotServed) => println!("(not served: {})", path.display()),
        Ok(UnserveOutcome::Refused { active_terminals }) => {
            anyhow::bail!(
                "refusing to close {}: {active_terminals} live terminal(s)",
                path.display()
            );
        }
        Ok(UnserveOutcome::RemovalStillReleasing { answer }) => {
            return Err(ForgetStillReleasing { path, answer }.into());
        }
        Ok(UnserveOutcome::CloseStillReleasing { answer }) => {
            return Err(CloseStillReleasing(answer).into());
        }
        Ok(UnserveOutcome::DevserverFailure { reason }) => anyhow::bail!("{reason}"),
        // A reachable-but-failed teardown is still "best effort": report it
        // with what the server answered, then (on forget) drop the registry
        // entry anyway.
        Err(e) => eprintln!(
            "chan: could not reach the server for {} ({e:#}); treating as closed.",
            path.display()
        ),
    }
    if remove {
        remove_from_registry(&lib, &path, row.as_ref())?;
    }
    Ok(())
}

enum UnserveOutcome {
    /// A live holder was reached and told to unserve; its flock released.
    Unserved,
    /// No lock holder or matching devserver can be reached for this workspace.
    NotServed,
    /// A live holder refused teardown because live terminals would be killed.
    Refused { active_terminals: usize },
    /// A live host asked to remove the workspace answered that an earlier
    /// call of its own on the root has not let go: it removed nothing and
    /// still holds the workspace in its library. Carries its answer.
    RemovalStillReleasing { answer: String },
    /// A live host answered that a close has not finished releasing this root.
    CloseStillReleasing { answer: String },
    /// A discovered devserver for this library could not complete removal.
    DevserverFailure { reason: String },
}

#[derive(Debug, PartialEq, Eq)]
enum LibraryDevserverMatch {
    None,
    One(usize),
    Ambiguous,
}

fn matching_devserver<'a>(
    library_root: &Path,
    roots: impl Iterator<Item = &'a Path>,
) -> LibraryDevserverMatch {
    let mut selected = None;
    for (index, root) in roots.enumerate() {
        if same_path(root, library_root) {
            if selected.is_some() {
                return LibraryDevserverMatch::Ambiguous;
            }
            selected = Some(index);
        }
    }
    selected.map_or(LibraryDevserverMatch::None, LibraryDevserverMatch::One)
}

/// Ask the one discovered devserver for this library to remove an off row.
/// A discovered host must answer before the caller changes the registry on disk.
async fn forget_on_library_devserver(
    lib: &Library,
    requested: &Path,
    lock_dir: &Path,
) -> UnserveOutcome {
    let library_root = lib
        .config_path()
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(chan_workspace::paths::config_dir);
    let instances = chan_server::devserver_handoff::discover_devservers().await;
    let selected = matching_devserver(
        &library_root,
        instances
            .iter()
            .map(|instance| instance.library_root.as_path()),
    );
    let instance = match selected {
        LibraryDevserverMatch::None => return UnserveOutcome::NotServed,
        LibraryDevserverMatch::One(index) => &instances[index],
        LibraryDevserverMatch::Ambiguous => {
            let matches = instances
                .iter()
                .filter(|instance| same_path(&instance.library_root, &library_root))
                .map(|instance| {
                    format!(
                        "pid {} port {} library {}",
                        instance.pid,
                        instance.port,
                        instance.library_root.display()
                    )
                })
                .collect::<Vec<_>>()
                .join("; ");
            return UnserveOutcome::DevserverFailure {
                reason: format!(
                    "refusing to forget {}: multiple matching devservers ({matches})",
                    requested.display()
                ),
            };
        }
    };
    let host = format!(
        "devserver pid {} port {} library {}",
        instance.pid,
        instance.port,
        instance.library_root.display()
    );
    let Some(socket) = control_socket_for_pid(instance.pid).await else {
        return UnserveOutcome::DevserverFailure {
            reason: format!(
                "refusing to forget {}: {host} has no reachable control socket",
                requested.display()
            ),
        };
    };
    let answer = chan_shell::send_control_request(
        &socket,
        chan_shell::ControlRequest::Close {
            path: requested.to_path_buf(),
            remove: true,
        },
    )
    .await;
    match answer {
        Ok(_) => {
            wait_for_lock_release(lock_dir);
            UnserveOutcome::Unserved
        }
        Err(error) => {
            let message = error.to_string();
            if let Some(active_terminals) = parse_live_terminals_refusal(&message) {
                return UnserveOutcome::Refused { active_terminals };
            }
            if answers_still_releasing(&message) {
                return UnserveOutcome::RemovalStillReleasing { answer: message };
            }
            UnserveOutcome::DevserverFailure {
                reason: format!(
                    "could not confirm forgetting {}: {host}: {error:#}; run the command again to see whether the workspace is still registered",
                    requested.display()
                ),
            }
        }
    }
}

#[derive(Deserialize)]
struct LiveTerminalsBody {
    active_terminals: usize,
}

/// The live-terminal count of a host's close refusal: a JSON object with a
/// non-negative integer `active_terminals`. The count alone is read, because
/// the host may be another build that words the fields beside it differently,
/// and a refusal that is not read is taken for a server that could not be
/// reached and the workspace for closed.
fn parse_live_terminals_refusal(message: &str) -> Option<usize> {
    // serde reads a struct from a JSON array by position as well as from an
    // object, and only an object is a refusal.
    let object: serde_json::Map<String, serde_json::Value> = serde_json::from_str(message).ok()?;
    let body: LiveTerminalsBody = serde_json::from_value(object.into()).ok()?;
    Some(body.active_terminals)
}

/// Whether a server's close or removal answer says that the workspace is still
/// releasing. The answer ends with [`chan_server::WORKSPACE_STILL_RELEASING`];
/// the path and action before it are the server's own rendering.
fn answers_still_releasing(message: &str) -> bool {
    message.ends_with(chan_server::WORKSPACE_STILL_RELEASING)
}

/// Shared by `chan close` and `chan workspace forget`. Tries the desktop
/// handoff, then discovers the holder from the `writer.lock` record and asks
/// it over its control socket to tear down. When a forget has a stored row
/// but no reachable lock-record holder and a free writer lock, it asks the
/// discovered devserver for that library. A successful close waits for the
/// flock to release.
///
/// With `remove`, a HOST (devserver / desktop) also UNREGISTERS the workspace
/// from its library + overlay, so the removal is reflected in the host's own
/// registry -- not just the caller's local `config.toml`. This is what keeps a
/// devserver-served workspace from lingering in the launcher (and surviving a
/// restart) after `chan workspace forget`.
async fn unserve_running(
    lib: &Library,
    path: &Path,
    remove: bool,
    personality: Personality,
    row: Option<&KnownWorkspace>,
) -> Result<UnserveOutcome> {
    // A stored root names its own row on a forget. Other paths and every
    // close use the canonical request name the hosts read.
    let requested = row
        .map(|row| row.root_path.clone())
        .unwrap_or_else(|| chan_workspace::paths::canonicalize_normalized(path));
    // Failed resolution can leave `..` in the request. The desktop matches
    // stored roots lexically, so let the resolved lookup below answer it.
    let unresolved_forget_parent = remove
        && row.is_none()
        && requested
            .components()
            .any(|component| component == Component::ParentDir);

    // Desktop close handoff, mirroring the `chan serve` handoff. A running
    // same-user chan-desktop owns the workspace flock AND its own library +
    // overlay; the per-pid control socket reaches the embedded host (the window
    // closes) but never updates the desktop's runtime map, so the launcher shows
    // the workspace stale-on and a restart resurrects it. The well-known handoff
    // socket sidesteps that and the pid-discovery miss (a GUI desktop whose
    // runtime socket directory differs from the terminal's). Gated like the
    // open handoff: only the Desktop personality or the forced shim hands off,
    // never a plain standalone binary; `CHAN_NO_DESKTOP_HANDOFF` opts out.
    // A still-releasing answer stops here; other desktop errors
    // fall through to the control-socket and devserver paths below.
    let want_desktop_handoff = (personality == Personality::Desktop
        || chan_server::handoff::handoff_forced())
        && !chan_server::handoff::handoff_opt_out()
        && !unresolved_forget_parent;
    if want_desktop_handoff {
        match chan_server::handoff::try_close_workspace(&requested, remove).await {
            chan_server::handoff::Outcome::HandedOff => {
                // The desktop released its flock during teardown; wait it out so a
                // `chan serve` racing right behind doesn't see a transient
                // WorkspaceLocked. Only the locally-registered case resolves a lock
                // dir to wait on.
                if let Some(paths) = row
                    .map(|row| lib.workspace_paths_for_row(row))
                    .or_else(|| lib.workspace_paths_for(path))
                {
                    wait_for_lock_release(&paths.lock);
                }
                return Ok(UnserveOutcome::Unserved);
            }
            chan_server::handoff::Outcome::CloseRefused { active_terminals } => {
                return Ok(UnserveOutcome::Refused { active_terminals });
            }
            chan_server::handoff::Outcome::DesktopError { message }
                if answers_still_releasing(&message) =>
            {
                return Ok(if remove {
                    UnserveOutcome::RemovalStillReleasing { answer: message }
                } else {
                    UnserveOutcome::CloseStillReleasing { answer: message }
                });
            }
            _ => {}
        }
    }

    let Some(paths) = row
        .map(|row| lib.workspace_paths_for_row(row))
        .or_else(|| lib.workspace_paths_for(path))
    else {
        return Ok(UnserveOutcome::NotServed); // no row => no devserver removal
    };
    let Some(record) = chan_workspace::lock::read_lock_record(&paths.lock) else {
        return Ok(
            if remove && row.is_some() && chan_workspace::lock::is_free(&paths.lock) {
                forget_on_library_devserver(lib, &requested, &paths.lock).await
            } else {
                UnserveOutcome::NotServed
            },
        );
    };
    let Some(socket) = control_socket_for_pid(record.pid).await else {
        // A record but no reachable control socket: the holder may be gone
        // (stale record) or may still own the lock without a control socket.
        // Only a free lock permits asking the devserver to remove the row.
        return Ok(
            if remove && row.is_some() && chan_workspace::lock::is_free(&paths.lock) {
                forget_on_library_devserver(lib, &requested, &paths.lock).await
            } else {
                UnserveOutcome::NotServed
            },
        );
    };
    match chan_shell::send_control_request(
        &socket,
        chan_shell::ControlRequest::Close {
            path: requested,
            remove,
        },
    )
    .await
    {
        Ok(_) => {}
        Err(e) => {
            let message = e.to_string();
            if let Some(active_terminals) = parse_live_terminals_refusal(&message) {
                return Ok(UnserveOutcome::Refused { active_terminals });
            }
            if answers_still_releasing(&message) {
                return Ok(if remove {
                    UnserveOutcome::RemovalStillReleasing { answer: message }
                } else {
                    UnserveOutcome::CloseStillReleasing { answer: message }
                });
            }
            return Err(e)
                .with_context(|| format!("asking the server (pid {}) to tear down", record.pid));
        }
    }
    wait_for_lock_release(&paths.lock);
    Ok(UnserveOutcome::Unserved)
}

/// Block (bounded) until the writer lock for `lock_dir` is free after a
/// serve was asked to unserve. The server drops the flock asynchronously
/// during graceful shutdown, so a `chan serve` racing right behind would
/// otherwise see a transient `WorkspaceLocked`.
fn wait_for_lock_release(lock_dir: &Path) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !chan_workspace::lock::is_free(lock_dir) {
        if Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// `chan close` / `chan workspace close` / `chan workspace forget`: the
/// remote arm when `--on` is given, else the local teardown. A local close or
/// forget answered still releasing ends the process here with
/// [`STILL_RELEASING_EXIT`].
pub(super) async fn cmd_close_cli(
    path: PathBuf,
    on: Option<String>,
    remove: bool,
    personality: Personality,
) -> Result<()> {
    match on {
        Some(target) => {
            let path = path.to_string_lossy().into_owned();
            if remove {
                cmd_workspace_forget_remote(&path, &target).await
            } else {
                cmd_workspace_close_remote(&path, &target).await
            }
        }
        None => match cmd_close(path, remove, personality).await {
            Err(err) if err.is::<ForgetStillReleasing>() || err.is::<CloseStillReleasing>() => {
                eprintln!("chan: {err}");
                std::process::exit(STILL_RELEASING_EXIT);
            }
            outcome => outcome,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forget_selects_exactly_one_devserver_for_its_library() {
        let own = Path::new("unregistered-library-own");
        let other = Path::new("unregistered-library-other");
        assert_eq!(
            matching_devserver(own, [other].into_iter()),
            LibraryDevserverMatch::None
        );
        assert_eq!(
            matching_devserver(own, [other, own].into_iter()),
            LibraryDevserverMatch::One(1)
        );
        assert_eq!(
            matching_devserver(own, [own, own].into_iter()),
            LibraryDevserverMatch::Ambiguous
        );
    }

    /// A host's close refusal is read by its live-terminal count, whatever
    /// the host puts beside it, so a host of another build is still read as
    /// a refusal. A message that is not a JSON object with a count is some
    /// other failure.
    #[test]
    fn a_close_refusal_is_read_by_its_count() {
        let rows: [(&str, Option<usize>); 8] = [
            (
                r#"{"error":"live_terminals","active_terminals":2}"#,
                Some(2),
            ),
            (
                r#"{"error":"workspace has 2 live terminal session(s)","code":"live_terminals","active_terminals":2}"#,
                Some(2),
            ),
            (r#"{"active_terminals":2}"#, Some(2)),
            ("no workspace mounted for /srv/notes", None),
            (r#"{"error":"live_terminals"}"#, None),
            (r#"{"active_terminals":"2"}"#, None),
            (r#"{"active_terminals":-1}"#, None),
            ("[2]", None),
        ];
        let misread: Vec<_> = rows
            .iter()
            .filter_map(|&(message, want)| {
                let read = parse_live_terminals_refusal(message);
                (read != want).then_some((message, read))
            })
            .collect();
        assert!(
            misread.is_empty(),
            "messages read as another count than the table's: {misread:#?}"
        );
    }

    /// A removal's answer is read as still releasing by the words it closes
    /// with, whatever path the server put before them.
    #[test]
    fn a_still_releasing_answer_is_read_by_its_closing_words() {
        let rows: [(&str, bool); 6] = [
            (
                "removing /srv/notes: workspace is still releasing; retry",
                true,
            ),
            (
                r"removing C:\notes: workspace is still releasing; retry",
                true,
            ),
            ("workspace is still releasing; retry", true),
            ("removing /srv/notes: workspace is locked", false),
            ("no workspace registered for /srv/notes", false),
            (
                "removing /srv/workspace is still releasing; retry/notes: gone",
                false,
            ),
        ];
        let misread: Vec<_> = rows
            .iter()
            .filter(|&&(message, want)| answers_still_releasing(message) != want)
            .collect();
        assert!(
            misread.is_empty(),
            "answers read the other way than the table's: {misread:#?}"
        );
    }

    /// What the forget prints holds the server's answer as it worded it.
    #[test]
    fn a_forget_still_releasing_prints_the_servers_answer() {
        let refusal = ForgetStillReleasing {
            path: PathBuf::from("/srv/notes"),
            answer: "removing /srv/notes: workspace is still releasing; retry".into(),
        };
        assert_eq!(
            refusal.to_string(),
            "/srv/notes is still registered: its server answered \"removing \
             /srv/notes: workspace is still releasing; retry\""
        );
    }
}
