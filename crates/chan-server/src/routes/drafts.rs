//! Drafts route.
//!
//! * `POST /api/drafts/new` -- Cmd+N from the SPA. Creates
//!   `<drafts_dir>/<next-untitled>/draft.md` + indexes it + returns
//!   the real in-root path. An optional JSON body picks the seed:
//!   no body (or no `kind`) seeds a plain markdown draft,
//!   `{"kind": "slides"}` seeds a slide deck.
//!
//! Drafts are real in-root files under the configured drafts
//! directory (default `.Drafts`), named by `Workspace::drafts_dir_name`.
//! Public paths are plain relpaths like `.Drafts/<name>/draft.md`, so
//! `create_draft_dir`, `next_untitled_draft_name`, and `write_text`
//! route through the normal workspace path machinery with no special
//! casing.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::error::{err, err_from, err_state};
use crate::state::AppState;

const NEW_DRAFT_CONTENT: &str = "# Draft\n";

/// Seed for a brand-new slide deck: the canonical `chan: kind: slides`
/// frontmatter block the SPA's `parseSlidesSpec` recognizes (16:9 default
/// aspect) plus a first slide heading, so the draft opens straight into the
/// slides layout. The primary file is still `draft.md`: a deck is markdown.
const NEW_SLIDES_CONTENT: &str = r#"---
chan:
  kind: slides
  slides:
    aspect_ratio: "16:9"
    zoom_factor: 2
---

# Slide 1
"#;

/// Seed for a brand-new diagram: a valid, non-empty Excalidraw scene so
/// the board opens cleanly and is not treated as an empty file that
/// auto-discards on close. `ExcalidrawCanvas` parses it as an empty
/// board. The frontend mirrors this exact string as its diagram seed so
/// a never-drawn board still discards silently on close.
const NEW_DIAGRAM_CONTENT: &str =
    r#"{"type":"excalidraw","version":2,"source":"chan","elements":[],"appState":{},"files":{}}"#;

/// Extract the draft leaf name from a draft public path.
///
/// A draft path is `<drafts_dir>/<name>/...`, so strip the configured
/// `<drafts_dir>/` prefix and take the first path segment. Errors when
/// the path is not under the drafts directory or carries no leaf.
fn draft_name_from_path(
    workspace: &chan_workspace::Workspace,
    path: &str,
) -> Result<String, chan_workspace::ChanError> {
    let dir = workspace.drafts_dir_name();
    let trimmed = path.trim_matches('/');
    let rest = trimmed
        .strip_prefix(dir)
        .and_then(|r| r.strip_prefix('/'))
        .ok_or_else(|| {
            chan_workspace::ChanError::Io(format!(
                "path `{path}` is not under the drafts directory `{dir}`"
            ))
        })?;
    let name = rest.split('/').next().unwrap_or("");
    if name.is_empty() {
        return Err(chan_workspace::ChanError::Io(format!(
            "path `{path}` carries no draft name under `{dir}`"
        )));
    }
    Ok(name.to_string())
}

#[derive(Deserialize)]
pub struct DraftPathPayload {
    /// Any path inside the draft directory, usually
    /// `<drafts_dir>/<name>/draft.md`.
    pub path: String,
}

#[derive(Deserialize)]
pub struct DraftPromotePayload {
    /// Any path inside the draft directory.
    pub path: String,
    /// Workspace-relative destination. Single-file drafts save to this
    /// file; workspace drafts save to this directory.
    pub target: String,
}

#[derive(Serialize)]
pub struct DraftCreateResponse {
    /// In-root path for the new draft.md: `<drafts_dir>/<name>/draft.md`.
    /// SPA `openInActivePane(path)` routes through
    /// `/api/fs/<drafts_dir>/<name>/draft.md`, a normal in-root read.
    pub path: String,
    /// Bare draft name (e.g. `"untitled"` or `"untitled-3"`), in
    /// case the SPA wants to show it separately from the path.
    pub name: String,
}

#[derive(Serialize, PartialEq, Eq, Debug)]
pub struct DraftInspectResponse {
    pub path: String,
    pub name: String,
    pub file_count: usize,
    pub dir_count: usize,
    pub total_size: u64,
    pub has_attachments: bool,
}

#[derive(Serialize, PartialEq, Eq, Debug)]
pub struct DraftPromoteResponse {
    pub path: String,
    pub name: String,
    pub mode: &'static str,
}

/// Optional body of `POST /api/drafts/new`. The plain Cmd+N path sends no
/// body at all; `kind` picks the seed content when present.
#[derive(Deserialize, Default)]
pub struct DraftCreatePayload {
    /// `"slides"` seeds a slide deck; absent seeds a markdown draft.
    #[serde(default)]
    kind: Option<String>,
}

/// Resolve the `draft.md` seed for a create-draft request body. An empty
/// body or an omitted `kind` seeds the markdown draft; `{"kind":"slides"}`
/// seeds the slide deck. Anything else is a client error, refused before
/// touching the workspace.
fn draft_seed_for_body(body: &[u8]) -> Result<&'static str, String> {
    if body.is_empty() {
        return Ok(NEW_DRAFT_CONTENT);
    }
    let payload: DraftCreatePayload =
        serde_json::from_slice(body).map_err(|e| format!("invalid create-draft body: {e}"))?;
    match payload.kind.as_deref() {
        None => Ok(NEW_DRAFT_CONTENT),
        Some("slides") => Ok(NEW_SLIDES_CONTENT),
        Some(other) => Err(format!(
            "unknown draft kind {other:?} (expected \"slides\")"
        )),
    }
}

/// Create a fresh draft directory + a seeded `draft.md` inside.
///
/// Race-window note: `next_untitled_draft_name` + `create_draft_dir`
/// can race against another concurrent creator; if `create_draft_dir`
/// returns `AlreadyExists` we retry once with a re-resolved name.
/// The race is rare in practice (single-user / single-machine) but
/// the retry keeps the contract clean.
pub async fn api_create_draft(
    State(state): State<Arc<AppState>>,
    body: axum::body::Bytes,
) -> Response {
    let seed = match draft_seed_for_body(&body) {
        Ok(seed) => seed,
        Err(message) => return err(StatusCode::BAD_REQUEST, message),
    };
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    // Note the draft path inside the blocking task, before it returns to
    // the await, so the watcher's Created event for our own draft is
    // suppressed without the post-await race (see files.rs::api_write_file).
    let self_writes = Arc::clone(&state.self_writes);
    let result = tokio::task::spawn_blocking(move || {
        let name = create_draft_sync(&workspace, seed)?;
        self_writes.note(&format!("{}/{name}/draft.md", workspace.drafts_dir_name()));
        Ok::<_, chan_workspace::ChanError>((name, workspace.drafts_dir_name().to_string()))
    })
    .await;

    let (name, dir) = match result {
        Ok(Ok(pair)) => pair,
        Ok(Err(e)) => return err_from(&e),
        Err(join) => return err(StatusCode::INTERNAL_SERVER_ERROR, join.to_string()),
    };

    let path = format!("{dir}/{name}/draft.md");
    Json(DraftCreateResponse { path, name }).into_response()
}

/// Create a fresh draft directory + a seeded `<name>.excalidraw` board
/// inside, mirroring `api_create_draft`. The diagram is a real draft
/// (promotable + discardable) whose primary file is the Excalidraw
/// scene rather than `draft.md`.
pub async fn api_create_diagram(State(state): State<Arc<AppState>>) -> Response {
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    // Note the diagram path inside the blocking task, before it returns
    // to the await, so the watcher's Created event for our own write is
    // suppressed without the post-await race (see files.rs::api_write_file).
    let self_writes = Arc::clone(&state.self_writes);
    let result = tokio::task::spawn_blocking(move || {
        let (name, path) = create_diagram_sync(&workspace)?;
        self_writes.note(&path);
        Ok::<_, chan_workspace::ChanError>((name, path))
    })
    .await;

    let (name, path) = match result {
        Ok(Ok(pair)) => pair,
        Ok(Err(e)) => return err_from(&e),
        Err(join) => return err(StatusCode::INTERNAL_SERVER_ERROR, join.to_string()),
    };

    Json(DraftCreateResponse { path, name }).into_response()
}

fn create_diagram_sync(
    workspace: &chan_workspace::Workspace,
) -> Result<(String, String), chan_workspace::ChanError> {
    for _ in 0..2 {
        let name = workspace.next_untitled_draft_name()?;
        match workspace.create_draft_dir(&name) {
            Ok(_) => {
                let path = format!("{}/{name}/{name}.excalidraw", workspace.drafts_dir_name());
                workspace.write_text(&path, NEW_DIAGRAM_CONTENT)?;
                return Ok((name, path));
            }
            Err(chan_workspace::ChanError::Io(msg)) if msg.contains("already exists") => {
                continue;
            }
            Err(e) => return Err(e),
        }
    }
    Err(chan_workspace::ChanError::Io(
        "race condition picking next untitled diagram name (retried 2x)".to_string(),
    ))
}

fn create_draft_sync(
    workspace: &chan_workspace::Workspace,
    seed: &str,
) -> Result<String, chan_workspace::ChanError> {
    for _ in 0..2 {
        let name = workspace.next_untitled_draft_name()?;
        match workspace.create_draft_dir(&name) {
            Ok(_) => {
                let path = format!("{}/{name}/draft.md", workspace.drafts_dir_name());
                workspace.write_text(&path, seed)?;
                return Ok(name);
            }
            Err(chan_workspace::ChanError::Io(msg)) if msg.contains("already exists") => {
                continue;
            }
            Err(e) => return Err(e),
        }
    }
    Err(chan_workspace::ChanError::Io(
        "race condition picking next untitled draft name (retried 2x)".to_string(),
    ))
}

pub async fn api_inspect_draft(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<DraftPathPayload>,
) -> Response {
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    let result =
        tokio::task::spawn_blocking(move || inspect_draft_sync(&workspace, &payload.path)).await;

    match result {
        Ok(Ok(out)) => Json(out).into_response(),
        Ok(Err(e)) => err_from(&e),
        Err(join) => err(StatusCode::INTERNAL_SERVER_ERROR, join.to_string()),
    }
}

pub async fn api_discard_draft(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<DraftPathPayload>,
) -> Response {
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    let path = payload.path.clone();
    // Suppress the watcher's Removed event before the blocking discard
    // (see files.rs::api_write_file).
    state.self_writes.note(&path);
    let result =
        tokio::task::spawn_blocking(move || discard_draft_sync(&workspace, &payload.path)).await;

    match result {
        Ok(Ok(())) => StatusCode::NO_CONTENT.into_response(),
        Ok(Err(e)) => err_from(&e),
        Err(join) => err(StatusCode::INTERNAL_SERVER_ERROR, join.to_string()),
    }
}

pub async fn api_promote_draft(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<DraftPromotePayload>,
) -> Response {
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    let source_path = payload.path.clone();
    let target_path = payload.target.clone();
    // Suppress the discard-at-source + create-at-target events before
    // the blocking promote (see files.rs::api_write_file).
    state.self_writes.note(&source_path);
    state.self_writes.note(&target_path);
    let result = tokio::task::spawn_blocking(move || {
        promote_draft_sync(&workspace, &payload.path, &payload.target)
    })
    .await;

    match result {
        Ok(Ok(out)) => Json(out).into_response(),
        Ok(Err(e)) => err_from(&e),
        Err(join) => err(StatusCode::INTERNAL_SERVER_ERROR, join.to_string()),
    }
}

fn inspect_draft_sync(
    workspace: &chan_workspace::Workspace,
    path: &str,
) -> Result<DraftInspectResponse, chan_workspace::ChanError> {
    let name = draft_name_from_path(workspace, path)?;
    let info = workspace.inspect_draft(&name)?;
    Ok(DraftInspectResponse {
        path: format!("{}/{name}/draft.md", workspace.drafts_dir_name()),
        name,
        file_count: info.file_count,
        dir_count: info.dir_count,
        total_size: info.total_size,
        has_attachments: info.has_attachments,
    })
}

fn discard_draft_sync(
    workspace: &chan_workspace::Workspace,
    path: &str,
) -> Result<(), chan_workspace::ChanError> {
    let name = draft_name_from_path(workspace, path)?;
    workspace.discard_draft(&name)
}

fn promote_draft_sync(
    workspace: &chan_workspace::Workspace,
    path: &str,
    target: &str,
) -> Result<DraftPromoteResponse, chan_workspace::ChanError> {
    let name = draft_name_from_path(workspace, path)?;
    let report = workspace.promote_draft(&name, target)?;
    Ok(DraftPromoteResponse {
        path: report.target_path,
        name: report.name,
        mode: promote_mode_label(report.mode),
    })
}

fn promote_mode_label(mode: chan_workspace::DraftPromoteMode) -> &'static str {
    match mode {
        chan_workspace::DraftPromoteMode::File => "file",
        chan_workspace::DraftPromoteMode::DirectoryCreated => "directory_created",
        chan_workspace::DraftPromoteMode::DirectoryMerged => "directory_merged",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make_workspace() -> (TempDir, TempDir, std::sync::Arc<chan_workspace::Workspace>) {
        let cfg = TempDir::new().unwrap();
        let root = TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        (cfg, root, workspace)
    }

    #[test]
    fn create_draft_sync_seeds_title() {
        let (_cfg, _root, workspace) = make_workspace();

        let name = create_draft_sync(&workspace, NEW_DRAFT_CONTENT).unwrap();
        let path = format!(".Drafts/{name}/draft.md");

        assert_eq!(name, "untitled");
        assert_eq!(workspace.read_text(&path).unwrap(), NEW_DRAFT_CONTENT);
    }

    #[test]
    fn draft_seed_for_body_picks_the_kind() {
        // No body / no kind: the plain markdown draft (the Cmd+N path).
        assert_eq!(draft_seed_for_body(b"").unwrap(), NEW_DRAFT_CONTENT);
        assert_eq!(draft_seed_for_body(b"{}").unwrap(), NEW_DRAFT_CONTENT);
        // The slides kind seeds the deck.
        assert_eq!(
            draft_seed_for_body(br#"{"kind":"slides"}"#).unwrap(),
            NEW_SLIDES_CONTENT
        );
        // An unknown kind (and a malformed body) is refused, not defaulted.
        assert!(draft_seed_for_body(br#"{"kind":"sculpture"}"#)
            .unwrap_err()
            .contains("sculpture"));
        assert!(draft_seed_for_body(b"not json").is_err());
    }

    #[test]
    fn slides_seed_carries_the_canonical_frontmatter_block() {
        // The exact block `parseSlidesSpec` matches on: frontmatter at the
        // very start, `chan: kind: slides`, quoted 16:9 aspect. A drift here
        // opens the new deck as a plain draft instead of slides.
        assert!(NEW_SLIDES_CONTENT.starts_with(
            "---\nchan:\n  kind: slides\n  slides:\n    aspect_ratio: \"16:9\"\n    zoom_factor: 2\n---\n"
        ));
        assert!(NEW_SLIDES_CONTENT.contains("# Slide 1"));
    }

    #[test]
    fn create_diagram_sync_seeds_a_valid_board_that_inspects_and_promotes() {
        let (_cfg, root, workspace) = make_workspace();

        let (name, path) = create_diagram_sync(&workspace).unwrap();

        assert_eq!(name, "untitled");
        assert_eq!(path, ".Drafts/untitled/untitled.excalidraw");

        // The seed is non-empty valid JSON and classifies as editable
        // text, so the editor opens it as a board.
        let content = workspace.read_text(&path).unwrap();
        assert_eq!(content, NEW_DIAGRAM_CONTENT);
        assert!(!content.is_empty());
        let parsed: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(parsed["type"], "excalidraw");
        assert_eq!(
            chan_workspace::fs_ops::classify(&path),
            chan_workspace::FileClass::Text
        );

        // It is a real single-file draft: inspects cleanly (no
        // "missing draft.md" broken) and promotes to an .excalidraw file.
        let info = workspace.inspect_draft(&name).unwrap();
        assert!(!info.has_attachments);
        std::fs::create_dir_all(root.path().join("boards")).unwrap();
        let promoted = workspace
            .promote_draft(&name, "boards/diagram.excalidraw")
            .unwrap();
        assert_eq!(promoted.target_path, "boards/diagram.excalidraw");
        assert_eq!(
            std::fs::read_to_string(root.path().join("boards/diagram.excalidraw")).unwrap(),
            NEW_DIAGRAM_CONTENT
        );
    }

    #[test]
    fn inspect_draft_sync_reports_workspace_shape() {
        let (_cfg, _root, workspace) = make_workspace();
        workspace.create_draft_dir("untitled-1").unwrap();
        workspace
            .write_text(".Drafts/untitled-1/draft.md", "# draft\n")
            .unwrap();
        workspace
            .write_bytes(".Drafts/untitled-1/pasted.png", &[1, 2, 3])
            .unwrap();

        let out = inspect_draft_sync(&workspace, ".Drafts/untitled-1/draft.md").unwrap();

        assert_eq!(out.name, "untitled-1");
        assert_eq!(out.path, ".Drafts/untitled-1/draft.md");
        assert_eq!(out.file_count, 2);
        assert!(out.has_attachments);
    }

    #[test]
    fn promote_draft_sync_returns_target_path_and_mode() {
        let (_cfg, root, workspace) = make_workspace();
        std::fs::create_dir_all(root.path().join("notes")).unwrap();
        workspace.create_draft_dir("untitled-1").unwrap();
        workspace
            .write_text(".Drafts/untitled-1/draft.md", "# draft\n")
            .unwrap();

        let out = promote_draft_sync(&workspace, ".Drafts/untitled-1/draft.md", "notes/draft.md")
            .unwrap();

        assert_eq!(out.name, "untitled-1");
        assert_eq!(out.path, "notes/draft.md");
        assert_eq!(out.mode, "file");
        assert_eq!(
            std::fs::read_to_string(root.path().join("notes/draft.md")).unwrap(),
            "# draft\n"
        );
    }

    #[test]
    fn discard_draft_sync_removes_workspace() {
        let (_cfg, _root, workspace) = make_workspace();
        workspace.create_draft_dir("untitled-1").unwrap();
        workspace
            .write_text(".Drafts/untitled-1/draft.md", "# draft\n")
            .unwrap();

        discard_draft_sync(&workspace, ".Drafts/untitled-1/draft.md").unwrap();

        assert!(!workspace.drafts_dir().join("untitled-1").exists());
    }

    // ---- Draft-banner backend stress test -----------------------------
    //
    // The false "unsaved changes from a previous session" banner
    // is a frontend bug, but it
    // can only be exercised cleanly if the backend invariants it stands
    // on hold under load. This is the backend half of the e2e stress
    // test: it hammers create-draft -> autosave (CAS) -> re-read over
    // many iterations against the REAL self-write suppression
    // (self_writes.rs) + watcher bridge (bus.rs) the server wires up,
    // and asserts:
    //   1. self-write suppression holds: every own write (and notify's
    //      2-3 event burst per write) is recognized as a self-echo and
    //      never forwarded to the /ws fan-out as an external edit -- the
    //      path that would otherwise drive the banner.
    //   2. a genuine external edit still surfaces (suppression is not a
    //      blanket mute).
    //   3. the CAS mtime_ns token round-trips: each autosave's returned
    //      token is valid for the next write; a stale token conflicts.
    //   4. no spurious DraftBroken / "missing draft.md": inspect_draft +
    //      re-read stay healthy across the whole loop.
    #[test]
    fn draft_autosave_loop_holds_suppression_cas_and_no_broken_draft() {
        use crate::bus::{make_watch_bridge, ScopeRegistry};
        use crate::self_writes::SelfWrites;
        use chan_workspace::{WatchCallback, WatchEvent, WatchKind};
        use std::sync::Arc;
        use tokio::sync::broadcast;

        let (_cfg, _root, workspace) = make_workspace();

        // Wire the real suppression + bridge the server uses (not a
        // mock). `events_tx` is the /ws fan-out the editor's
        // external-edit banner listens on; a self-write must never land
        // there.
        let self_writes = Arc::new(SelfWrites::with_window(std::time::Duration::from_secs(60)));
        let (events_tx, mut events_rx) = broadcast::channel::<String>(1024);
        let (index_tx, _index_rx) = broadcast::channel::<WatchEvent>(1024);
        let scopes = Arc::new(ScopeRegistry::new());
        let bridge = make_watch_bridge(
            &events_tx,
            &index_tx,
            &self_writes,
            &scopes,
            workspace.root().to_path_buf(),
        );

        let echo = |bridge: &Arc<dyn WatchCallback>, kind, path: &str| {
            bridge.on_event(WatchEvent::file(
                kind,
                path,
                chan_workspace::WorkspaceGeneration::default(),
            ));
        };

        // Create the draft the way api_create_draft does: seed draft.md,
        // note the path so the Created event is suppressed.
        let name = create_draft_sync(&workspace, NEW_DRAFT_CONTENT).unwrap();
        let path = format!(".Drafts/{name}/draft.md");
        self_writes.note(&path);
        echo(&bridge, WatchKind::Created, &path);

        // Hammer the autosave loop. Track the CAS token across writes.
        let mut token_ns = workspace.stat(&path).unwrap().mtime_ns;
        for i in 0..200 {
            let body = format!("# Draft\n\nautosave {i}\n");
            // api_write_file notes BEFORE the blocking write; mirror it.
            self_writes.note(&path);
            workspace
                .write_text_if_unchanged(&path, token_ns, None, &body)
                .unwrap_or_else(|e| panic!("autosave {i} failed: {e:?}"));

            // CAS token must round-trip: the post-write mtime_ns is the
            // valid token for the next write.
            let stat = workspace.stat(&path).unwrap();
            assert!(stat.mtime_ns.is_some(), "autosave {i}: mtime_ns missing");
            token_ns = stat.mtime_ns;

            // notify often emits 2-3 events per logical write; every one
            // must be suppressed (no consume-on-match).
            echo(&bridge, WatchKind::Modified, &path);
            echo(&bridge, WatchKind::Modified, &path);
            echo(&bridge, WatchKind::Created, &path);

            // Re-read + inspect: never DraftBroken / missing draft.md.
            assert_eq!(
                workspace.read_text(&path).unwrap(),
                body,
                "autosave {i}: re-read mismatch"
            );
            let inspected = workspace
                .inspect_draft(&name)
                .unwrap_or_else(|e| panic!("autosave {i}: inspect_draft broke: {e:?}"));
            assert!(inspected.file_count >= 1, "autosave {i}: draft.md vanished");
        }

        // Not one self-write should have reached the /ws fan-out.
        assert!(
            matches!(
                events_rx.try_recv(),
                Err(broadcast::error::TryRecvError::Empty)
            ),
            "a self-write leaked to the editor as an external edit",
        );

        // A genuine external edit (a path we never noted) still surfaces.
        echo(&bridge, WatchKind::Modified, "notes/external.md");
        let frame = events_rx
            .try_recv()
            .expect("external edit must surface on /ws");
        assert!(
            frame.contains("external.md"),
            "unexpected /ws frame: {frame}",
        );

        // A stale CAS token must conflict (lock-step token contract).
        let err = workspace
            .write_text_if_unchanged(&path, Some(1), None, "# stale\n")
            .unwrap_err();
        assert!(
            matches!(err, chan_workspace::ChanError::WriteConflict { .. }),
            "stale token did not conflict: {err:?}",
        );
    }

    // ---- Route-level create-draft tests --------------------------------
    //
    // These go through the real router (auth middleware + body extraction),
    // pinning the `POST /api/drafts/new` contract: no body seeds the plain
    // markdown draft, `{"kind":"slides"}` seeds the deck, an unknown kind
    // is a 400. Mirrors the route_test_app harness in routes/index.rs.

    use std::sync::atomic::AtomicU64;
    use std::sync::{Mutex, RwLock};

    use axum::body::Body;
    use axum::http::{header, Request};
    use chan_workspace::SearchAggression;
    use tokio::sync::{broadcast, watch};
    use tower::ServiceExt;

    use crate::self_writes::SelfWrites;
    use crate::state::WorkspaceCell;
    use crate::terminal_sessions::{Registry as TerminalRegistry, RegistryConfig};
    use crate::{EditorPrefs, ServerConfig};

    struct RouteTestApp {
        _cfg: TempDir,
        _root: TempDir,
        state: Arc<AppState>,
    }

    fn route_test_app() -> RouteTestApp {
        let cfg = TempDir::new().unwrap();
        let root = TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();

        let (events_tx, _) = broadcast::channel::<String>(1);
        let (index_events_tx, _) = broadcast::channel::<chan_workspace::WatchEvent>(1);
        let indexer = Arc::new(crate::indexer::Indexer::spawn(
            workspace.clone(),
            index_events_tx.subscribe(),
            false,
            SearchAggression::Conservative,
            Arc::new(chan_workspace::NoProgress),
        ));
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        std::mem::forget(shutdown_tx);

        let state = Arc::new(AppState {
            library: lib,
            workspace_root: root.path().to_path_buf(),
            workspace_cell: Arc::new(RwLock::new(Some(WorkspaceCell {
                workspace,
                watch_handle: None,
                indexer,
            }))),
            token: Some("secret".to_string()),
            prefix: Arc::new(RwLock::new(String::new())),
            settings_disabled: false,
            last_activity: Arc::new(AtomicU64::new(0)),
            events_tx,
            index_events_tx,
            server_config: Mutex::new(ServerConfig::default()),
            editor_prefs: Mutex::new(EditorPrefs::default()),
            config_revision: AtomicU64::new(1),
            config_write_serial: Mutex::new(()),
            self_writes: Arc::new(SelfWrites::new()),
            terminal_sessions: Arc::new(TerminalRegistry::new(RegistryConfig {
                workspace_root: root.path().to_path_buf(),
                mcp_socket_path: None,
                control_socket_path: None,
                terminal: ServerConfig::default().terminal,
            })),
            doc_sessions: std::sync::Arc::new(crate::doc_sessions::DocRegistry::new()),
            scene_sessions: std::sync::Arc::new(crate::scene_sessions::SceneRegistry::new()),
            shutdown_rx,
            scope_registry: std::sync::Arc::new(crate::bus::ScopeRegistry::new()),
            survey_bus: std::sync::Arc::new(crate::survey::SurveyBus::new()),
            window_bus: std::sync::Arc::new(crate::window_bus::WindowBus::new()),
            handover_bus: std::sync::Arc::new(crate::handover_bus::HandoverBus::new()),
            ephemeral_sessions: std::sync::Mutex::new(std::collections::HashMap::new()),
            ephemeral_files_sessions: std::sync::Mutex::new(std::collections::HashMap::new()),
            terminal_session_dir: None,
            window_presence: std::sync::Arc::new(crate::window_presence::WindowPresence::new()),
            session_registry: std::sync::Arc::new(crate::session_presence::SessionRegistry::new()),
            pending_window_commands: std::sync::Arc::new(Default::default()),
            window_transfers: std::sync::Arc::new(crate::window_transfers::WindowTransfers::new()),
            window_titles: std::sync::Arc::new(crate::window_titles::WindowTitles::new()),
            bulk_transfer: crate::state::test_support::make_test_bulk_transfer_tenant(),
            instance_id: "test-instance".to_string(),
            standalone_files: None,
        });

        RouteTestApp {
            _cfg: cfg,
            _root: root,
            state,
        }
    }

    /// POST /api/drafts/new with an optional JSON body, the way the SPA
    /// does: no body means no content-type header either.
    async fn post_create_draft(
        router: &axum::Router,
        body: Option<&str>,
    ) -> (StatusCode, serde_json::Value) {
        let mut req = Request::builder()
            .method("POST")
            .uri("/api/drafts/new")
            .header(header::AUTHORIZATION, "Bearer secret");
        let body = if let Some(b) = body {
            req = req.header(header::CONTENT_TYPE, "application/json");
            Body::from(b.to_string())
        } else {
            Body::empty()
        };
        let response = router
            .clone()
            .oneshot(req.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let json = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, json)
    }

    #[tokio::test]
    async fn create_draft_route_with_slides_kind_seeds_the_slides_deck() {
        let app = route_test_app();
        let router = crate::router(app.state.clone());

        let (status, body) = post_create_draft(&router, Some(r#"{"kind":"slides"}"#)).await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["name"], "untitled");
        assert_eq!(body["path"], ".Drafts/untitled/draft.md");
        // Seeded with EXACTLY the slides content (frontmatter + heading).
        assert_eq!(
            app.state
                .try_workspace()
                .expect("slides draft test workspace")
                .read_text(".Drafts/untitled/draft.md")
                .unwrap(),
            NEW_SLIDES_CONTENT
        );
    }

    #[tokio::test]
    async fn create_draft_route_without_body_seeds_the_markdown_draft() {
        // The plain Cmd+N path sends no body and no content-type; it keeps
        // seeding the markdown draft.
        let app = route_test_app();
        let router = crate::router(app.state.clone());

        let (status, body) = post_create_draft(&router, None).await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["name"], "untitled");
        assert_eq!(
            app.state
                .try_workspace()
                .expect("markdown draft test workspace")
                .read_text(".Drafts/untitled/draft.md")
                .unwrap(),
            NEW_DRAFT_CONTENT
        );
    }

    #[tokio::test]
    async fn create_draft_route_refuses_an_unknown_kind() {
        let app = route_test_app();
        let router = crate::router(app.state.clone());

        let (status, body) = post_create_draft(&router, Some(r#"{"kind":"sculpture"}"#)).await;

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(
            body["error"]
                .as_str()
                .unwrap_or_default()
                .contains("sculpture"),
            "unexpected error body: {body}"
        );
        // Nothing was created for the refused request.
        assert!(!app
            .state
            .try_workspace()
            .expect("draft test workspace")
            .drafts_dir()
            .join("untitled")
            .exists());
    }
}
