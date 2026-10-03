use anyhow::Result;

use crate::parentage::in_devserver_context;

/// Whether a workspace path named for a remote devserver is absolute on that
/// machine's terms: a unix root, a drive-qualified Windows path, or a UNC
/// share. A relative path would resolve against this shell, not that box,
/// so the arms refuse it.
fn remote_path_is_absolute(path: &str) -> bool {
    let bytes = path.as_bytes();
    path.starts_with('/')
        || path.starts_with(r"\\")
        || (bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && (bytes[2] == b'\\' || bytes[2] == b'/'))
}

fn refuse_relative_remote_path(path: &str, target: &str) -> Result<()> {
    if remote_path_is_absolute(path) {
        return Ok(());
    }
    anyhow::bail!(
        "`--on {target}` names a path on that machine; give {path:?} as an absolute path there \
         (starting with `/`, a drive letter, or a UNC share), not relative to this shell"
    )
}

/// `chan devserver register {url}`: add a devserver row via the CLI→desktop handoff,
/// then return. It does NOT dial/connect -- connecting is the launcher's
/// Connect button. The devserver entry lives in the desktop's config (the same
/// registry the launcher reads), so this needs a running chan-desktop to land
/// into; without one there is nowhere to persist it (no standalone fallback --
/// a URL is never served locally).
pub(super) async fn cmd_devserver_register(
    url: String,
    name: Option<String>,
    script: Option<String>,
) -> Result<()> {
    // Refuse a devserver-in-a-devserver: this CLI running inside a devserver
    // session has no path to the desktop's registry, and nesting one headless
    // multi-tenant server inside another is not a shape the registry models.
    if in_devserver_context().await {
        anyhow::bail!(
            "cannot register a devserver from inside a devserver: `chan devserver register \
             {url}` writes into the desktop's devserver registry, which a devserver session \
             cannot reach. \
             Run it from chan-desktop (or a plain shell on the box running chan-desktop)."
        );
    }
    use chan_server::handoff::Outcome;
    match chan_server::handoff::try_open_devserver(&url, name.as_deref(), script.as_deref()).await {
        Outcome::HandedOff => {
            // Registered, not connected: point the user at the launcher's
            // Connect button. Labelled by --name when given, else the URL.
            let label = name.as_deref().unwrap_or(&url);
            println!("registered \"{label}\". Open it from the launcher.");
            Ok(())
        }
        Outcome::VersionSkew {
            desktop_version, ..
        } => anyhow::bail!(
            "chan-desktop is version {desktop_version}, CLI is {}; cannot register the \
             devserver. Restart chan-desktop to pick up the new version.",
            chan_server::handoff::CHAN_VERSION,
        ),
        Outcome::DesktopError { message } => {
            anyhow::bail!("chan-desktop could not register the devserver: {message}")
        }
        Outcome::CloseRefused { .. } => {
            anyhow::bail!("chan-desktop returned a close refusal while registering a devserver")
        }
        // No desktop = nowhere to register. Unlike the path form, a URL never
        // falls back to a standalone serve (mirrors the window-op "needs the
        // desktop" refusal).
        Outcome::NoDesktop => {
            anyhow::bail!("chan devserver register {url} needs the chan desktop app running.")
        }
    }
}

/// One devserver-control round-trip with uniform failure wording: an
/// absent desktop names the requirement, a protocol skew names the
/// restart, a desktop too old to know the verb says so, and any other
/// `Error` surfaces verbatim.
async fn devserver_control(
    req: chan_server::handoff::Request,
) -> Result<chan_server::handoff::Response> {
    use chan_server::handoff::{DevserverControlOutcome, Response};
    match chan_server::handoff::try_devserver_control(req).await {
        DevserverControlOutcome::NoDesktop => {
            anyhow::bail!("this command needs the chan desktop app running.")
        }
        DevserverControlOutcome::NoReply { budget } => anyhow::bail!(
            "chan-desktop accepted the request but did not answer within {}s; the operation may \
             still be running. Check `chan devserver ls` and the launcher.",
            budget.as_secs()
        ),
        DevserverControlOutcome::Reply(Response::VersionSkew {
            desktop_version, ..
        }) => anyhow::bail!(
            "chan-desktop is version {desktop_version}, CLI is {}; restart chan-desktop \
             to pick up the new version.",
            chan_server::handoff::CHAN_VERSION,
        ),
        DevserverControlOutcome::Reply(Response::Error { message })
            if message.contains("invalid handoff request") =>
        {
            anyhow::bail!(
                "chan-desktop does not understand this command (it predates it); upgrade \
                 and restart chan-desktop."
            )
        }
        DevserverControlOutcome::Reply(Response::Error { message }) => {
            anyhow::bail!("{message}")
        }
        DevserverControlOutcome::Reply(resp) => Ok(resp),
    }
}

/// The protocol + version pair every handoff request carries.
fn handoff_versions() -> (u32, String) {
    (
        chan_server::handoff::PROTOCOL_VERSION,
        chan_server::handoff::CHAN_VERSION.to_string(),
    )
}

/// `chan devserver ls`: the desktop's registry rows, as a table or JSON.
pub(super) async fn cmd_devserver_ls(json: bool) -> Result<()> {
    use chan_server::handoff::{Request, Response};
    let (protocol, cli_version) = handoff_versions();
    let resp = devserver_control(Request::ListDevservers {
        protocol,
        cli_version,
    })
    .await?;
    let Response::Devservers { devservers, .. } = resp else {
        anyhow::bail!("unexpected reply from chan-desktop");
    };
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({ "devservers": devservers }))?
        );
        return Ok(());
    }
    if devservers.is_empty() {
        println!("(no devservers registered)");
        return Ok(());
    }
    let label_w = devservers
        .iter()
        .map(|d| if d.label.is_empty() { 1 } else { d.label.len() })
        .max()
        .unwrap_or(5)
        .max("LABEL".len());
    println!("{:<12} {:<label_w$} URL", "STATUS", "LABEL");
    for d in &devservers {
        let label = if d.label.is_empty() { "-" } else { &d.label };
        let gateway = if d.gateway { "  (gateway)" } else { "" };
        println!("{:<12} {:<label_w$} {}{gateway}", d.status, label, d.url);
    }
    Ok(())
}

/// `chan devserver connect TARGET`: start the desktop's dial and return.
pub(super) async fn cmd_devserver_connect(target: String) -> Result<()> {
    use chan_server::handoff::{Request, Response};
    let (protocol, cli_version) = handoff_versions();
    let resp = devserver_control(Request::ConnectDevserver {
        protocol,
        cli_version,
        target: target.clone(),
    })
    .await?;
    match resp {
        Response::DevserverConnectStarted { .. } => {
            println!("connecting {target}. Watch the launcher for sign-in or trust prompts.");
            Ok(())
        }
        _ => anyhow::bail!("unexpected reply from chan-desktop"),
    }
}

/// `chan devserver disconnect TARGET`: drop the connection, keep the row.
pub(super) async fn cmd_devserver_disconnect(target: String) -> Result<()> {
    use chan_server::handoff::{Request, Response};
    let (protocol, cli_version) = handoff_versions();
    let resp = devserver_control(Request::DisconnectDevserver {
        protocol,
        cli_version,
        target: target.clone(),
    })
    .await?;
    match resp {
        Response::DevserverDisconnected { .. } => {
            println!("disconnected: {target}. The remote devserver keeps running.");
            Ok(())
        }
        _ => anyhow::bail!("unexpected reply from chan-desktop"),
    }
}

/// `chan devserver forget TARGET`: remove the registration row.
pub(super) async fn cmd_devserver_forget(target: String, force: bool) -> Result<()> {
    use chan_server::handoff::{Request, Response};
    let (protocol, cli_version) = handoff_versions();
    let resp = devserver_control(Request::ForgetDevserver {
        protocol,
        cli_version,
        target: target.clone(),
        force,
    })
    .await?;
    match resp {
        Response::DevserverForgotten { .. } => {
            println!("forgot: {target}. The remote devserver keeps running.");
            Ok(())
        }
        _ => anyhow::bail!("unexpected reply from chan-desktop"),
    }
}

/// `chan workspace serve PATH --on TARGET`: mount PATH (a path on that
/// machine) on a registered, connected devserver through the desktop, and
/// report the prefix it serves at. Mirrors `cmd_devserver_connect`.
pub(super) async fn cmd_workspace_serve_remote(path: Option<String>, target: &str) -> Result<()> {
    use chan_server::handoff::{Request, Response};
    let Some(path) = path else {
        anyhow::bail!(
            "`--on {target}` needs the workspace PATH on that machine, e.g. `chan serve \
             /srv/notes --on {target}`"
        );
    };
    refuse_relative_remote_path(&path, target)?;
    let (protocol, cli_version) = handoff_versions();
    let resp = devserver_control(Request::ServeRemoteWorkspace {
        protocol,
        cli_version,
        target: target.to_string(),
        workspace_path: path.clone(),
    })
    .await?;
    match resp {
        Response::RemoteWorkspaceServed { prefix, .. } => {
            println!(
                "served {path} on devserver {target} (mounted at {prefix}). Open it from the \
                 launcher."
            );
            Ok(())
        }
        _ => anyhow::bail!("unexpected reply from chan-desktop"),
    }
}

/// `chan close PATH --on TARGET`: unmount PATH on that devserver, keeping it
/// registered there. The devserver's live-terminal guard is the refusal.
pub(super) async fn cmd_workspace_close_remote(path: &str, target: &str) -> Result<()> {
    use chan_server::handoff::{Request, Response};
    refuse_relative_remote_path(path, target)?;
    let (protocol, cli_version) = handoff_versions();
    let resp = devserver_control(Request::CloseRemoteWorkspace {
        protocol,
        cli_version,
        target: target.to_string(),
        workspace_path: path.to_string(),
    })
    .await?;
    match resp {
        Response::RemoteWorkspaceClosed { was_served, .. } => {
            if was_served {
                println!("closed: {path} (on {target})");
            } else {
                println!("(not served on {target}: {path})");
            }
            Ok(())
        }
        Response::CloseRefused {
            active_terminals, ..
        } => anyhow::bail!(
            "refusing to close {path} on {target}: {active_terminals} live terminal(s)"
        ),
        _ => anyhow::bail!("unexpected reply from chan-desktop"),
    }
}

/// `chan workspace forget PATH --on TARGET`: unmount and drop PATH on that
/// devserver; the files on that machine are untouched.
pub(super) async fn cmd_workspace_forget_remote(path: &str, target: &str) -> Result<()> {
    use chan_server::handoff::{Request, Response};
    refuse_relative_remote_path(path, target)?;
    let (protocol, cli_version) = handoff_versions();
    let resp = devserver_control(Request::ForgetRemoteWorkspace {
        protocol,
        cli_version,
        target: target.to_string(),
        workspace_path: path.to_string(),
    })
    .await?;
    match resp {
        Response::RemoteWorkspaceForgotten { .. } => {
            println!("forgot: {path} on {target}. The files on that machine are untouched.");
            Ok(())
        }
        Response::CloseRefused {
            active_terminals, ..
        } => anyhow::bail!(
            "refusing to forget {path} on {target}: {active_terminals} live terminal(s); close \
             the terminals first"
        ),
        _ => anyhow::bail!("unexpected reply from chan-desktop"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_workspace_paths_must_be_absolute_on_that_machine() {
        assert!(remote_path_is_absolute("/srv/notes"));
        assert!(remote_path_is_absolute(r"C:\Users\me\proj"));
        assert!(remote_path_is_absolute("C:/Users/me/proj"));
        assert!(remote_path_is_absolute(r"\\server\share\proj"));
        assert!(!remote_path_is_absolute("notes"));
        assert!(!remote_path_is_absolute("./notes"));
        assert!(!remote_path_is_absolute("C:notes"));
        let err = refuse_relative_remote_path("notes", "lab")
            .unwrap_err()
            .to_string();
        assert!(err.contains("absolute"), "{err}");
    }
}
