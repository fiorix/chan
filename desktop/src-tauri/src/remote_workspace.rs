//! The pure halves of the remote workspace arms (`chan workspace
//! serve|close|forget WS --on TARGET` over the desktop handoff): resolving a
//! `TARGET` to one registered devserver row, resolving `WS` to one workspace
//! row on that devserver, and the registered-but-not-connected refusal. Every
//! function here refuses over guessing and names the candidates, and none of
//! them touches `AppState`, the network, or the filesystem, so the refusals
//! are pinned by unit tests without a desktop.

use crate::config;
use crate::devserver::{DevserverConn, DevserverWorkspaceRow};

/// Resolve a `TARGET` (a registered URL or a launcher label) against the
/// persisted registry rows. A URL matches by endpoint (scheme, host, port), a
/// label by its trimmed text. Zero matches name the listing command; more
/// than one lists the candidates so the user can name the URL instead.
pub(crate) fn resolve_devserver_target_in(
    rows: &[config::Devserver],
    target: &str,
) -> Result<String, String> {
    let trimmed = target.trim();
    let matches: Vec<&config::Devserver> = if trimmed.contains("://") {
        let key = config::endpoint_key(trimmed);
        if key.is_none() {
            return Err(format!("invalid devserver URL {trimmed:?}"));
        }
        rows.iter()
            .filter(|d| config::endpoint_key(&d.url) == key)
            .collect()
    } else {
        rows.iter().filter(|d| d.label.trim() == trimmed).collect()
    };
    match matches.len() {
        0 => Err(format!(
            "no registered devserver matches {trimmed:?}. `chan devserver ls` lists the \
             registered rows; a gateway-managed devserver is managed on the Gateways screen."
        )),
        1 => Ok(matches[0].id.clone()),
        _ => {
            let listing = matches
                .iter()
                .map(|d| {
                    let label = if d.label.trim().is_empty() {
                        "-"
                    } else {
                        d.label.trim()
                    };
                    format!("  {label}  {}", d.url)
                })
                .collect::<Vec<_>>()
                .join("\n");
            Err(format!(
                "{trimmed:?} matches more than one registered devserver:\n{listing}\n\
                 Name the one you mean by URL, or remove the duplicate row in the launcher."
            ))
        }
    }
}

/// Resolve the `WS` the CLI was given to one workspace row on a connected
/// devserver. The row's `path` is the devserver's own canonical root, so an
/// exact match (modulo a trailing separator) wins; a bare name with no path
/// separator may also match a unique row by label or basename, which is how
/// a user types what the launcher shows. Zero or several matches refuse with
/// the devserver's rows, so the user can copy the exact path.
pub(crate) fn resolve_remote_workspace<'a>(
    rows: &'a [DevserverWorkspaceRow],
    workspace: &str,
    target: &str,
) -> Result<&'a DevserverWorkspaceRow, String> {
    let wanted = trim_trailing_separator(workspace.trim());
    if wanted.is_empty() {
        return Err("the workspace path is empty".to_string());
    }
    let exact: Vec<&DevserverWorkspaceRow> = rows
        .iter()
        .filter(|r| trim_trailing_separator(&r.path) == wanted)
        .collect();
    let candidates = if exact.is_empty() && !wanted.contains(['/', '\\']) {
        rows.iter()
            .filter(|r| r.label == wanted || basename(&r.path) == wanted)
            .collect()
    } else {
        exact
    };
    match candidates.len() {
        1 => Ok(candidates[0]),
        0 => Err(format!(
            "no workspace at {wanted:?} is registered on {target}; registered there:\n{}",
            listing(rows)
        )),
        _ => Err(format!(
            "{wanted:?} matches more than one workspace on {target}:\n{}\nName it by its full path.",
            listing(&candidates.into_iter().cloned().collect::<Vec<_>>())
        )),
    }
}

/// A connected devserver's live connection, or the refusal for a row that is
/// registered but not connected: every remote operation rides the connection
/// the desktop holds, and dialing on the CLI's behalf would guess at sign-in
/// and trust prompts the launcher owns.
pub(crate) fn refuse_unless_connected(
    conn: Option<DevserverConn>,
    target: &str,
    connecting: bool,
) -> Result<DevserverConn, String> {
    match conn {
        Some(conn) => Ok(conn),
        None if connecting => Err(format!(
            "devserver {target:?} is still connecting; wait for the launcher to finish, then retry"
        )),
        None => Err(format!(
            "devserver {target:?} is registered but not connected; run `chan devserver connect \
             {target}` first"
        )),
    }
}

fn trim_trailing_separator(path: &str) -> &str {
    let trimmed = path.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        path
    } else {
        trimmed
    }
}

fn basename(path: &str) -> &str {
    trim_trailing_separator(path)
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(path)
}

fn listing(rows: &[DevserverWorkspaceRow]) -> String {
    if rows.is_empty() {
        return "  (no workspaces)".to_string();
    }
    rows.iter()
        .map(|r| format!("  {}  ({})", r.path, if r.on { "on" } else { "off" }))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn devserver(id: &str, url: &str, label: &str) -> config::Devserver {
        config::Devserver {
            id: id.to_string(),
            url: url.to_string(),
            script: String::new(),
            label: label.to_string(),
            token: String::new(),
            added_at: 0,
            auto_hide_control: false,
            gateway_owner: None,
            gateway_devserver_id: None,
        }
    }

    fn row(prefix: &str, path: &str, label: &str, on: bool) -> DevserverWorkspaceRow {
        DevserverWorkspaceRow {
            prefix: prefix.to_string(),
            path: path.to_string(),
            label: label.to_string(),
            on,
            status: chan_server::WorkspaceStatus::Running,
            error: None,
            url: String::new(),
        }
    }

    #[test]
    fn target_resolves_by_label_or_endpoint_and_refuses_ambiguity() {
        let rows = vec![
            devserver("a", "http://127.0.0.1:8787", "lab"),
            devserver("b", "http://127.0.0.1:9000", "box"),
            devserver("c", "http://10.0.0.5:8787", "box"),
        ];
        assert_eq!(resolve_devserver_target_in(&rows, "lab").unwrap(), "a");
        assert_eq!(resolve_devserver_target_in(&rows, " lab ").unwrap(), "a");
        assert_eq!(
            resolve_devserver_target_in(&rows, "http://127.0.0.1:9000/?t=x").unwrap(),
            "b"
        );
        let err = resolve_devserver_target_in(&rows, "box").unwrap_err();
        assert!(err.contains("more than one"), "{err}");
        assert!(err.contains("http://127.0.0.1:9000"), "{err}");
        assert!(err.contains("http://10.0.0.5:8787"), "{err}");
        let err = resolve_devserver_target_in(&rows, "nope").unwrap_err();
        assert!(
            err.contains("no registered devserver matches \"nope\""),
            "{err}"
        );
        assert!(err.contains("chan devserver ls"), "{err}");
        let err = resolve_devserver_target_in(&rows, "http://[::1").unwrap_err();
        assert!(err.contains("invalid devserver URL"), "{err}");
    }

    #[test]
    fn workspace_resolves_by_exact_path_then_unique_name() {
        let rows = vec![
            row("/notes-1a2b3c", "/srv/notes", "notes", true),
            row("/docs-4d5e6f", "/srv/docs", "docs", false),
            row("/docs-7a8b9c", "/home/me/docs", "docs", true),
        ];
        // Exact path, trailing slash tolerated on either side.
        assert_eq!(
            resolve_remote_workspace(&rows, "/srv/notes/", "lab")
                .unwrap()
                .prefix,
            "/notes-1a2b3c"
        );
        // A bare name matches a unique label or basename.
        assert_eq!(
            resolve_remote_workspace(&rows, "notes", "lab")
                .unwrap()
                .prefix,
            "/notes-1a2b3c"
        );
        // Two rows share the name: refuse, list both, ask for the path.
        let err = resolve_remote_workspace(&rows, "docs", "lab").unwrap_err();
        assert!(err.contains("more than one workspace on lab"), "{err}");
        assert!(err.contains("/srv/docs  (off)"), "{err}");
        assert!(err.contains("/home/me/docs  (on)"), "{err}");
        // A path that matches nothing lists what is there.
        let err = resolve_remote_workspace(&rows, "/srv/other", "lab").unwrap_err();
        assert!(
            err.contains("no workspace at \"/srv/other\" is registered on lab"),
            "{err}"
        );
        assert!(err.contains("/srv/notes  (on)"), "{err}");
        // A path-shaped value never falls back to a name match.
        assert!(resolve_remote_workspace(&rows, "/other/notes", "lab").is_err());
        assert!(resolve_remote_workspace(&rows, "", "lab").is_err());
    }

    #[test]
    fn workspace_listing_for_an_empty_devserver_says_so() {
        let err = resolve_remote_workspace(&[], "/srv/notes", "lab").unwrap_err();
        assert!(err.contains("(no workspaces)"), "{err}");
    }

    #[test]
    fn not_connected_refuses_with_the_connect_command() {
        let err = refuse_unless_connected(None, "lab", false).unwrap_err();
        assert!(err.contains("registered but not connected"), "{err}");
        assert!(err.contains("chan devserver connect lab"), "{err}");
        let err = refuse_unless_connected(None, "lab", true).unwrap_err();
        assert!(err.contains("still connecting"), "{err}");
    }
}
