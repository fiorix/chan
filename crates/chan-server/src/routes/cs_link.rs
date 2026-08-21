//! `POST /api/preflight/cs-link`: offer to drop a `cs` symlink next to the
//! running chan binary when the terminal control alias is missing from
//! `$PATH`.
//!
//! `cs` is the chan window's control alias: a name on `$PATH` whose argv[0]
//! basename is "cs". Both the `chan` CLI and the chan-desktop binary detect
//! it (`chan_shell::invoked_as_cs`) and run the control client instead of the
//! GUI / normal CLI, so a sibling symlink to `current_exe()` is a valid `cs`
//! for either binary. Most installs put the name on `$PATH` themselves; this
//! covers the ones that did not by offering the same one-time link on first
//! boot, so such a workspace can drive its window from the terminal without
//! reading the docs.
//!
//! NON-BLOCKING by construction: the detection rides on the pre-flight
//! snapshot (`cs_link`) but never feeds its `locked` / `phase` gate, and a
//! create failure (read-only dir, a bin dir off `$PATH`, an app bundle, an
//! AppImage mount) is surfaced for the user to accept and continue. The boot
//! never waits on it.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

use crate::error::err;
use crate::state::AppState;

/// The pre-flight snapshot fragment describing the `cs` alias offer. Present
/// only when `cs` is MISSING from `$PATH`: a resolvable `cs` means there is
/// nothing to do, so the fragment is omitted and the SPA shows no card.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct CsLink {
    /// Absolute path where the `cs` link would live: a sibling of the running
    /// binary named `cs`. Re-derived server-side on create; the client never
    /// picks the path.
    target: String,
    /// What the link resolves to: the running chan / chan-desktop binary,
    /// which handles the `cs` argv. Shown in the manual hint.
    points_to: String,
    /// True when one-click create is viable: the sibling dir is writable AND
    /// on `$PATH`. False for a dev build (`./target/debug`, off PATH), a
    /// macOS `.app` bundle, or an AppImage mount; the SPA then shows the
    /// manual `ln -s` hint instead of a Create button.
    can_create: bool,
    /// One-line reason auto-create is unavailable, when `can_create` is false.
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
}

/// Outcome of `POST /api/preflight/cs-link`.
#[derive(Debug, Serialize)]
struct CsLinkResult {
    /// True when `cs` now resolves on `$PATH` after this call (created in an
    /// on-PATH dir, or already present).
    resolved: bool,
    /// The link path we created (empty when nothing was created).
    target: String,
    /// User-facing outcome line.
    message: String,
}

/// Search `$PATH` for a `cs` entry. `exists()` follows symlinks, so a
/// `cs -> chan` the user already made reads as present.
fn cs_on_path() -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| dir.join("cs").exists())
}

/// True when `dir` is one of the `$PATH` entries. Canonicalized compare so a
/// symlinked bin dir matches, with a literal fallback for entries that don't
/// resolve.
fn dir_on_path(dir: &Path) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    let canon = dir.canonicalize().ok();
    std::env::split_paths(&path).any(|entry| {
        entry == dir
            || match (&canon, entry.canonicalize()) {
                (Some(c), Ok(e)) => *c == e,
                _ => false,
            }
    })
}

/// Cheap "looks writable" check from the dir's mode bits. Optimistic on
/// root-owned dirs (the owner write bit is set even when the current user
/// can't write), so the create route's actual symlink attempt is the
/// authoritative gate and surfaces any `EACCES` non-fatally.
fn dir_maybe_writable(dir: &Path) -> bool {
    std::fs::metadata(dir)
        .map(|m| !m.permissions().readonly())
        .unwrap_or(false)
}

/// Decide `can_create` + the explanatory note from the four contextual facts.
/// Pure, so the precedence is unit-tested without touching the filesystem or
/// the process environment.
fn classify(
    on_path: bool,
    writable: bool,
    appimage: bool,
    in_app_bundle: bool,
) -> (bool, Option<String>) {
    if on_path && writable && !appimage && !in_app_bundle {
        return (true, None);
    }
    let note = if appimage {
        "chan-desktop runs from an AppImage; create cs from a terminal instead."
    } else if in_app_bundle {
        "chan-desktop runs from inside its application bundle."
    } else if !on_path {
        "the folder holding chan is not on your PATH."
    } else {
        "the folder holding chan is read-only."
    };
    (false, Some(note.to_string()))
}

/// Build the `cs` offer, or `None` when there is nothing to surface (alias
/// already present, viewer not the owner, or `current_exe()` has no parent).
pub(crate) fn detect(allow: bool) -> Option<CsLink> {
    // Anonymous / tunnel-public viewers must not mutate the host's PATH.
    if !allow {
        return None;
    }
    // Already set up: nothing to offer.
    if cs_on_path() {
        return None;
    }
    let exe = std::env::current_exe().ok()?;
    // Resolved for a truthful `points_to`, minus the Windows `\\?\` prefix
    // (this string ends up in the manual `ln -s` hint).
    let exe = chan_workspace::paths::canonicalize_normalized(&exe);
    let dir = exe.parent()?.to_path_buf();
    let target = dir.join("cs");

    let appimage = std::env::var_os("APPIMAGE").is_some();
    // A `.app` bundle dir is never on PATH, so this only sharpens the note.
    let in_app_bundle = target.to_string_lossy().contains(".app/Contents/MacOS");
    let (can_create, note) = classify(
        dir_on_path(&dir),
        dir_maybe_writable(&dir),
        appimage,
        in_app_bundle,
    );

    Some(CsLink {
        target: target.to_string_lossy().into_owned(),
        points_to: exe.to_string_lossy().into_owned(),
        can_create,
        note,
    })
}

/// What `place_link` did with the target path.
#[derive(Debug, PartialEq, Eq)]
enum Placement {
    /// Created a fresh `cs -> points_to` symlink.
    Created,
    /// A `cs` symlink already points where we wanted (idempotent).
    AlreadyLinked,
    /// Something else already occupies the path; left untouched.
    Foreign,
}

/// Place (or confirm) a `cs` symlink at `target`. Never clobbers a foreign
/// entry, idempotent on our own link. Takes explicit paths so it is
/// tempdir-testable without the process env.
fn place_link(points_to: &Path, target: &Path) -> std::io::Result<Placement> {
    if let Ok(meta) = std::fs::symlink_metadata(target) {
        let ours = meta.file_type().is_symlink()
            && std::fs::read_link(target)
                .map(|t| t == points_to)
                .unwrap_or(false);
        return Ok(if ours {
            Placement::AlreadyLinked
        } else {
            Placement::Foreign
        });
    }
    symlink_cs(points_to, target)?;
    Ok(Placement::Created)
}

#[cfg(unix)]
fn symlink_cs(points_to: &Path, target: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(points_to, target)
}

#[cfg(not(unix))]
fn symlink_cs(_points_to: &Path, _target: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "cs symlink creation is unix-only",
    ))
}

/// Re-derive the offer server-side and create the link. Returns a small
/// result the SPA renders, or `(status, message)` for a non-fatal failure the
/// SPA surfaces while the boot continues.
fn create_cs_link() -> Result<CsLinkResult, (StatusCode, String)> {
    let Some(link) = detect(true) else {
        // `cs` already resolves (created out-of-band, or a concurrent create).
        return Ok(CsLinkResult {
            resolved: true,
            target: String::new(),
            message: "cs is already on your PATH.".into(),
        });
    };
    if !link.can_create {
        return Err((
            StatusCode::CONFLICT,
            link.note.unwrap_or_else(|| "cannot create cs here.".into()),
        ));
    }
    let target = PathBuf::from(&link.target);
    let points_to = PathBuf::from(&link.points_to);

    match place_link(&points_to, &target).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("creating {}: {e}", target.display()),
        )
    })? {
        // can_create implies the dir is on PATH, so a created/linked cs
        // resolves.
        Placement::Created => Ok(CsLinkResult {
            resolved: true,
            target: link.target,
            message: format!("Created cs -> {}.", points_to.display()),
        }),
        Placement::AlreadyLinked => Ok(CsLinkResult {
            resolved: true,
            target: link.target,
            message: format!("cs already points at {}.", points_to.display()),
        }),
        Placement::Foreign => Err((
            StatusCode::CONFLICT,
            format!("{} already exists; not overwriting it.", target.display()),
        )),
    }
}

pub async fn api_cs_link_create(State(state): State<Arc<AppState>>) -> Response {
    // Owner-only: a settings-locked (kiosk) deployment must not let the
    // operator at the keyboard write a symlink onto the host's PATH.
    if state.settings_disabled {
        return err(
            StatusCode::FORBIDDEN,
            "cs link setup is available to the workspace owner only".into(),
        );
    }
    match tokio::task::spawn_blocking(create_cs_link).await {
        Ok(Ok(result)) => Json(result).into_response(),
        Ok(Err((code, message))) => err(code, message),
        Err(e) => err(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("cs link task panicked: {e}"),
        ),
    }
}

#[cfg(test)]
#[cfg_attr(not(target_os = "linux"), allow(unused_imports, dead_code))]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn detect_suppressed_for_non_owner() {
        assert!(detect(false).is_none());
    }

    #[test]
    fn classify_offers_create_only_when_writable_on_path_and_native() {
        assert_eq!(classify(true, true, false, false), (true, None));
    }

    #[test]
    fn classify_explains_each_blocked_case() {
        // Precedence: AppImage first, then app bundle, then off-PATH, then
        // read-only.
        let (can, note) = classify(true, true, true, false);
        assert!(!can);
        assert!(note.unwrap().contains("AppImage"));

        let (can, note) = classify(false, true, false, true);
        assert!(!can);
        assert!(note.unwrap().contains("application bundle"));

        let (can, note) = classify(false, true, false, false);
        assert!(!can);
        assert!(note.unwrap().contains("PATH"));

        let (can, note) = classify(true, false, false, false);
        assert!(!can);
        assert!(note.unwrap().contains("read-only"));
    }

    #[cfg(unix)]
    #[test]
    fn place_link_creates_then_is_idempotent_and_refuses_foreign() {
        let dir = TempDir::new().unwrap();
        let points_to = dir.path().join("chan");
        std::fs::write(&points_to, b"#!/bin/sh\n").unwrap();
        let target = dir.path().join("cs");

        // Absent -> create the symlink at target pointing where we asked.
        assert_eq!(place_link(&points_to, &target).unwrap(), Placement::Created);
        assert_eq!(std::fs::read_link(&target).unwrap(), points_to);

        // Re-run -> our own link, idempotent.
        assert_eq!(
            place_link(&points_to, &target).unwrap(),
            Placement::AlreadyLinked
        );

        // A foreign file at the path is never clobbered.
        let foreign = dir.path().join("cs2");
        std::fs::write(&foreign, b"not ours").unwrap();
        assert_eq!(
            place_link(&points_to, &foreign).unwrap(),
            Placement::Foreign
        );
        assert_eq!(std::fs::read(&foreign).unwrap(), b"not ours");
    }
}
