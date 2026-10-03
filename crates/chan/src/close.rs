use std::fmt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use chan_workspace::Library;
use serde::Deserialize;

use crate::control::control_socket_for_pid;
use crate::registry::library;
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

/// Forget `path` from the registry: drop the registry key and the whole
/// `~/.chan/workspaces/<key>/` metadata dir (trash included), leaving the
/// filesystem contents untouched. Reached through `chan workspace forget`.
/// The caller is responsible for tearing down any running serve first
/// (`unregister_workspace` does not).
fn remove_from_registry(lib: &Library, path: &Path) -> Result<()> {
    // Capture the metadata root before `unregister_workspace` drops the
    // registry key (after which the path no longer resolves to it).
    let metadata_root = lib.workspace_paths_for(path).map(|p| p.root);
    let removed = lib
        .unregister_workspace(path)
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

/// `chan close {path}`: tear down a running server holding `path`, releasing
/// its writer lock. Best-effort -- "not currently served" (and an unreachable
/// holder) is treated as success, since the goal is "this workspace is not
/// served". With `remove`, it then also forgets the workspace from the
/// registry (`chan workspace forget`), unless the holder refused the teardown
/// over live terminals or answered that the workspace is still releasing: a
/// holder that has kept the workspace in its own library is not contradicted
/// by the registry on disk.
async fn cmd_close(path: PathBuf, remove: bool, personality: Personality) -> Result<()> {
    let lib = library()?;
    // Pass `remove` through so a host (devserver/desktop) that serves this
    // workspace also unregisters it from its own library + overlay; the local
    // `remove_from_registry` below then handles the caller's config.toml +
    // metadata (and the not-served / standalone cases the host can't).
    match unserve_running(&lib, &path, remove, personality).await {
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
        // A reachable-but-failed teardown is still "best effort": report it
        // with what the server answered, then (on forget) drop the registry
        // entry anyway.
        Err(e) => eprintln!(
            "chan: could not reach the server for {} ({e:#}); treating as closed.",
            path.display()
        ),
    }
    if remove {
        remove_from_registry(&lib, &path)?;
    }
    Ok(())
}

enum UnserveOutcome {
    /// A live holder was reached and told to unserve; its flock released.
    Unserved,
    /// No live process holds the workspace (unregistered, no lock record,
    /// or the recorded holder is gone).
    NotServed,
    /// A live holder refused teardown because live terminals would be killed.
    Refused { active_terminals: usize },
    /// A live host asked to remove the workspace answered that an earlier
    /// call of its own on the root has not let go: it removed nothing and
    /// still holds the workspace in its library. Carries its answer.
    RemovalStillReleasing { answer: String },
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

/// Whether a server's answer to a removal says that the workspace is still
/// releasing. The server words it `removing <path>: ` and then
/// [`chan_server::WORKSPACE_STILL_RELEASING`]; only those closing words are
/// read, because the path before them is the server's own rendering.
fn answers_still_releasing(message: &str) -> bool {
    message.ends_with(chan_server::WORKSPACE_STILL_RELEASING)
}

/// Shared by `chan close` and `chan workspace forget`. Discovers the process
/// serving `path` from its `writer.lock` record, reaches it over its
/// control socket, asks it to tear down (the server decides scope: a
/// dedicated serve exits, a devserver/desktop unmounts just that tenant),
/// and waits for the flock to release.
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
) -> Result<UnserveOutcome> {
    // Normalize (strip any Windows `\\?\` verbatim prefix) so the path carried
    // in the Close request is in the same canonical form the serving host and
    // the registry key their runtimes under, rather than a verbatim-prefixed
    // form the two sides would have to agree to strip.
    let canonical = chan_workspace::paths::canonicalize_normalized(path);

    // Desktop close handoff, mirroring the `chan serve` handoff. A running
    // same-user chan-desktop owns the workspace flock AND its own library +
    // overlay; the per-pid control socket reaches the embedded host (the window
    // closes) but never updates the desktop's runtime map, so the launcher shows
    // the workspace stale-on and a restart resurrects it. The well-known handoff
    // socket sidesteps that and the pid-discovery miss (a GUI desktop whose
    // runtime socket directory differs from the terminal's). Gated like the
    // open handoff: only the Desktop personality or the forced shim hands off,
    // never a plain standalone
    // binary; `CHAN_NO_DESKTOP_HANDOFF` opts out. Any non-`HandedOff` outcome
    // (no desktop, skew, error) drops through to the control-socket path below.
    let want_desktop_handoff = (personality == Personality::Desktop
        || chan_server::handoff::handoff_forced())
        && !chan_server::handoff::handoff_opt_out();
    if want_desktop_handoff {
        match chan_server::handoff::try_close_workspace(&canonical, remove).await {
            chan_server::handoff::Outcome::HandedOff => {
                // The desktop released its flock during teardown; wait it out so a
                // `chan serve` racing right behind doesn't see a transient
                // WorkspaceLocked. Only the locally-registered case resolves a lock
                // dir to wait on.
                if let Some(paths) = lib.workspace_paths_for(path) {
                    wait_for_lock_release(&paths.lock);
                }
                return Ok(UnserveOutcome::Unserved);
            }
            chan_server::handoff::Outcome::CloseRefused { active_terminals } => {
                return Ok(UnserveOutcome::Refused { active_terminals });
            }
            _ => {}
        }
    }

    let Some(paths) = lib.workspace_paths_for(path) else {
        return Ok(UnserveOutcome::NotServed); // not registered => nothing serving
    };
    let Some(record) = chan_workspace::lock::read_lock_record(&paths.lock) else {
        return Ok(UnserveOutcome::NotServed); // no holder record on disk
    };
    let Some(socket) = control_socket_for_pid(record.pid).await else {
        // A record but no reachable control socket: the holder is gone
        // (stale record -- the lock is free / steal-able) or runs no control
        // socket. Nothing to tear down over the wire.
        return Ok(UnserveOutcome::NotServed);
    };
    match chan_shell::send_control_request(
        &socket,
        chan_shell::ControlRequest::Close {
            path: canonical,
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
            if remove && answers_still_releasing(&message) {
                return Ok(UnserveOutcome::RemovalStillReleasing { answer: message });
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
/// remote arm when `--on` is given, else the local teardown. A local forget
/// answered still releasing ends the process here with
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
            Err(err) if err.is::<ForgetStillReleasing>() => {
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
