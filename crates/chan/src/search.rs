use std::path::{Path, PathBuf};

use anyhow::Result;
use chan_workspace::{KnownWorkspace, Library, WorkspaceSearchRequest, WorkspaceSearchResult};
use serde::Serialize;

use crate::cli::WorkspaceTargets;
use crate::control::{control_socket_for_workspace, control_socket_for_workspace_in_dirs};
use crate::registry::library;

#[derive(Debug, Serialize)]
struct MultiWorkspaceSearchOutput {
    results: Vec<WorkspaceSearchResult>,
    errors: Vec<WorkspaceExecutionError>,
}

#[derive(Debug, Serialize)]
struct WorkspaceExecutionError {
    workspace: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    metadata_key: Option<String>,
    code: &'static str,
    message: String,
}

#[derive(Debug)]
struct WorkspaceExecutionFailure {
    code: &'static str,
    message: String,
}

pub(super) async fn cmd_workspace_search(
    request: WorkspaceSearchRequest,
    targets: WorkspaceTargets,
    json: bool,
    pretty: bool,
) -> Result<()> {
    let lib = library()?;
    let (selected, mut errors) = select_workspace_targets(&lib, &targets)?;
    let mut results = Vec::new();
    for workspace in selected {
        match execute_workspace_search(&lib, &workspace, &request).await {
            Ok(result) => results.push(result),
            Err(error) => errors.push(WorkspaceExecutionError {
                workspace: workspace.root_path.display().to_string(),
                metadata_key: Some(workspace.metadata_key.clone()),
                code: error.code,
                message: error.message,
            }),
        }
    }
    let output = MultiWorkspaceSearchOutput { results, errors };
    if json {
        if pretty {
            println!("{}", serde_json::to_string_pretty(&output)?);
        } else {
            println!("{}", serde_json::to_string(&output)?);
        }
    } else {
        for result in &output.results {
            println!(
                "# {} ({})\n",
                result.workspace.display_name, result.workspace.root
            );
            print!("{}", chan_shell::render_workspace_search_markdown(result));
        }
        if !output.errors.is_empty() {
            println!("# Workspace errors\n");
            for error in &output.errors {
                println!("- {}: {}", error.workspace, error.message);
            }
        }
    }
    anyhow::ensure!(
        output.errors.is_empty() && output.results.iter().all(|result| result.errors.is_empty()),
        "workspace search completed with errors"
    );
    Ok(())
}

fn select_workspace_targets(
    lib: &Library,
    targets: &WorkspaceTargets,
) -> Result<(Vec<KnownWorkspace>, Vec<WorkspaceExecutionError>)> {
    let mut known = lib.list_workspaces();
    if targets.all_workspaces {
        known.sort_by(|left, right| left.root_path.cmp(&right.root_path));
        return Ok((known, Vec::new()));
    }
    if targets.workspaces.is_empty() {
        let cwd = chan_workspace::paths::canonicalize_normalized(&std::env::current_dir()?);
        let selected = resolve_workspace_cwd(&known, &cwd).cloned();
        return match selected {
            Some(workspace) => Ok((vec![workspace], Vec::new())),
            None => Ok((
                Vec::new(),
                vec![WorkspaceExecutionError {
                    workspace: cwd.display().to_string(),
                    metadata_key: None,
                    code: "workspace_not_found",
                    message: "current directory is not inside a registered workspace".into(),
                }],
            )),
        };
    }

    let mut selected = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut errors = Vec::new();
    for selector in &targets.workspaces {
        match resolve_workspace_selector(&known, selector) {
            Ok(workspace) => {
                if seen.insert(workspace.metadata_key.clone()) {
                    selected.push(workspace.clone());
                }
            }
            Err(error) => errors.push(error),
        }
    }
    Ok((selected, errors))
}

fn resolve_workspace_cwd<'a>(
    known: &'a [KnownWorkspace],
    cwd: &Path,
) -> Option<&'a KnownWorkspace> {
    known
        .iter()
        .map(|workspace| {
            (
                workspace,
                chan_workspace::paths::canonicalize_normalized(&workspace.root_path),
            )
        })
        .filter(|(_, root)| cwd.starts_with(root))
        .max_by_key(|(_, root)| root.components().count())
        .map(|(workspace, _)| workspace)
}

fn resolve_workspace_selector<'a>(
    known: &'a [KnownWorkspace],
    selector: &str,
) -> std::result::Result<&'a KnownWorkspace, WorkspaceExecutionError> {
    let selector_path = PathBuf::from(selector);
    let canonical = chan_workspace::paths::canonicalize_normalized(&selector_path);
    if let Some(workspace) = known.iter().find(|workspace| {
        workspace.root_path == selector_path
            || canonical == chan_workspace::paths::canonicalize_normalized(&workspace.root_path)
            || workspace.root_path.to_string_lossy() == selector
    }) {
        return Ok(workspace);
    }
    if let Some(workspace) = known
        .iter()
        .find(|workspace| workspace.metadata_key == selector)
    {
        return Ok(workspace);
    }
    let display_matches: Vec<&KnownWorkspace> = known
        .iter()
        .filter(|workspace| known_workspace_display_name(workspace).eq_ignore_ascii_case(selector))
        .collect();
    match display_matches.as_slice() {
        [workspace] => Ok(workspace),
        [] => Err(WorkspaceExecutionError {
            workspace: selector.to_string(),
            metadata_key: None,
            code: "workspace_not_found",
            message: format!("no registered workspace matches {selector:?}"),
        }),
        matches => Err(WorkspaceExecutionError {
            workspace: selector.to_string(),
            metadata_key: None,
            code: "ambiguous_workspace",
            message: format!(
                "workspace display name {selector:?} is ambiguous: {}",
                matches
                    .iter()
                    .map(|workspace| format!(
                        "{} ({})",
                        workspace.root_path.display(),
                        workspace.metadata_key
                    ))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        }),
    }
}

fn known_workspace_display_name(workspace: &KnownWorkspace) -> String {
    workspace.display_name.clone().unwrap_or_else(|| {
        workspace
            .root_path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| workspace.root_path.display().to_string())
    })
}

async fn execute_workspace_search(
    lib: &Library,
    known: &KnownWorkspace,
    request: &WorkspaceSearchRequest,
) -> std::result::Result<WorkspaceSearchResult, WorkspaceExecutionFailure> {
    execute_workspace_search_with_dirs(lib, known, request, None).await
}

async fn execute_workspace_search_with_dirs(
    lib: &Library,
    known: &KnownWorkspace,
    request: &WorkspaceSearchRequest,
    socket_dirs: Option<&[PathBuf]>,
) -> std::result::Result<WorkspaceSearchResult, WorkspaceExecutionFailure> {
    // The row's own paths, so the probe asks nothing of the root: a root
    // another process holds is searched through that holder even when its
    // filesystem has stopped answering.
    let paths = lib.workspace_paths_for_row(known);
    // A holder the probe observed is searched through its live server. When
    // the probe established nothing, neither a live server nor a free local
    // workspace is known, so refuse rather than query one or open the other.
    match chan_workspace::lock::probe_foreign_holder(&paths.lock, &known.root_path) {
        chan_workspace::lock::ForeignHolder::Present => {
            return execute_live_workspace_search(known, &paths.lock, request, socket_dirs).await;
        }
        chan_workspace::lock::ForeignHolder::Unknown { reason } => {
            return Err(WorkspaceExecutionFailure {
                code: "workspace_lock_unknown",
                message: format!("cannot determine workspace lock status: {reason}"),
            });
        }
        chan_workspace::lock::ForeignHolder::Absent => {}
    }
    match lib.open_workspace(&known.root_path) {
        Ok(workspace) => {
            workspace
                .workspace_search(request)
                .map_err(|error| WorkspaceExecutionFailure {
                    code: "workspace_search_failed",
                    message: error.to_string(),
                })
        }
        Err(
            chan_workspace::ChanError::WorkspaceLocked
            | chan_workspace::ChanError::WorkspaceAlreadyOpen,
        ) => execute_live_workspace_search(known, &paths.lock, request, socket_dirs).await,
        Err(error) => Err(WorkspaceExecutionFailure {
            code: "workspace_open_failed",
            message: error.to_string(),
        }),
    }
}

async fn execute_live_workspace_search(
    known: &KnownWorkspace,
    lock_dir: &Path,
    request: &WorkspaceSearchRequest,
    socket_dirs: Option<&[PathBuf]>,
) -> std::result::Result<WorkspaceSearchResult, WorkspaceExecutionFailure> {
    let record = chan_workspace::lock::read_lock_record(lock_dir).ok_or_else(|| {
        WorkspaceExecutionFailure {
            code: "served_workspace_unreachable",
            message: "workspace lock is held but its holder record is unavailable".into(),
        }
    })?;
    let socket = match socket_dirs {
        Some(dirs) => {
            control_socket_for_workspace_in_dirs(
                dirs,
                record.pid,
                &known.root_path,
                &known.metadata_key,
                cfg!(unix),
            )
            .await
        }
        None => {
            control_socket_for_workspace(record.pid, &known.root_path, &known.metadata_key).await
        }
    }
    .ok_or_else(|| WorkspaceExecutionFailure {
        code: "served_workspace_unreachable",
        message: format!(
            "no reachable control tenant exactly matches {} ({})",
            known.root_path.display(),
            known.metadata_key
        ),
    })?;
    let raw = chan_shell::send_control_request(
        &socket,
        chan_shell::ControlRequest::WorkspaceSearch {
            request: request.clone(),
        },
    )
    .await
    .map_err(|error| WorkspaceExecutionFailure {
        code: "served_workspace_unreachable",
        message: error.to_string(),
    })?;
    serde_json::from_str(&raw).map_err(|error| WorkspaceExecutionFailure {
        code: "workspace_search_failed",
        message: format!("decoding workspace search response: {error}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use crate::test_support::spawn_workspace_search_stub;
    #[cfg(all(unix, unix))]
    use std::time::Duration;

    /// A writer lock the probe could not open refuses the search with an
    /// explicit inability to determine the lock status, rather than querying a
    /// live server nobody observed or opening a workspace a holder might own.
    /// A directory at the lock path makes the open fail deterministically.
    #[cfg(unix)]
    /// `chan search` of a root another process holds hands the search to the
    /// holder without asking that root's filesystem: the probe goes by the
    /// registry row, so a held root that hangs answers as unreachable rather
    /// than hanging the command.
    #[cfg(unix)]
    #[test]
    fn workspace_search_probes_a_held_root_by_its_registry_row() {
        let config = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let sockets = tempfile::TempDir::new().unwrap();
        let lib = Library::open_at(config.path().join("config.toml")).unwrap();
        let known = lib.register_workspace(root.path()).unwrap();
        let paths = lib.workspace_paths_for(root.path()).unwrap();
        let _held =
            chan_workspace::lock::WorkspaceLock::acquire(&paths.lock, &known.root_path).unwrap();
        let foreign = chan_workspace::lock::LockRecord {
            pid: 1,
            path: known.root_path.to_string_lossy().into_owned(),
            started_at: "2000-01-01T00:00:00Z".to_string(),
        };
        std::fs::write(
            paths.lock.join("writer.lock"),
            serde_json::to_vec(&foreign).unwrap(),
        )
        .unwrap();

        const HELD_ROOT_BOUND: Duration = Duration::from_secs(30);
        let stall = chan_workspace::paths::root_stall::stall(root.path());
        let socket_dirs = vec![sockets.path().to_path_buf()];
        let outcome =
            stall.finishes_beside("chan search of a held root", HELD_ROOT_BOUND, move || {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(execute_workspace_search_with_dirs(
                        &lib,
                        &known,
                        &WorkspaceSearchRequest::default(),
                        Some(&socket_dirs),
                    ))
            });
        match outcome {
            Err(failure) => assert_eq!(failure.code, "served_workspace_unreachable"),
            Ok(_) => panic!("a search of a held root with no reachable holder answered"),
        }
    }

    #[tokio::test]
    async fn workspace_search_refuses_when_the_lock_status_is_unknown() {
        let config = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = Library::open_at(config.path().join("config.toml")).unwrap();
        let known = lib.register_workspace(root.path()).unwrap();
        let paths = lib.workspace_paths_for(root.path()).unwrap();
        std::fs::create_dir_all(paths.lock.join("writer.lock")).unwrap();

        let request = WorkspaceSearchRequest::default();
        match execute_workspace_search_with_dirs(&lib, &known, &request, None).await {
            Err(failure) => {
                assert_eq!(failure.code, "workspace_lock_unknown");
                assert!(
                    failure
                        .message
                        .contains("cannot determine workspace lock status"),
                    "{}",
                    failure.message
                );
            }
            Ok(_) => panic!("an unknown lock status must refuse the search"),
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn workspace_search_retries_over_the_exact_tenant_when_direct_open_loses_the_lock() {
        let config = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let config_path = config.path().join("config.toml");
        let holder_library = Library::open_at(config_path.clone()).unwrap();
        let known = holder_library.register_workspace(root.path()).unwrap();
        let held = holder_library.open_workspace(root.path()).unwrap();
        held.write_text("note.md", "# Note\n").unwrap();
        held.index_file("note.md").unwrap();

        let request = WorkspaceSearchRequest {
            domains: vec![chan_workspace::WorkspaceSearchDomain::File],
            ..WorkspaceSearchRequest::default()
        };
        let expected = held.workspace_search(&request).unwrap();
        let socket_dir = tempfile::Builder::new()
            .prefix("chan-ws-")
            .tempdir_in("/tmp")
            .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(socket_dir.path(), std::fs::Permissions::from_mode(0o700))
            .unwrap();
        let socket = socket_dir.path().join(format!(
            "chan-control-{}-workspace.sock",
            std::process::id()
        ));
        let stub = spawn_workspace_search_stub(
            &socket,
            chan_shell::Identity {
                kind: chan_shell::ServeKind::Devserver,
                version: env!("CARGO_PKG_VERSION").into(),
                pid: std::process::id(),
                library_id: None,
                workspace_root: Some(known.root_path.clone()),
                metadata_key: Some(known.metadata_key.clone()),
            },
            expected.clone(),
        );

        // A distinct Library observes the root as free-by-this-pid, then its
        // direct open returns WorkspaceAlreadyOpen. The retry must identify
        // and query the exact live tenant instead of opening sidecars.
        let querying_library = Library::open_at(config_path).unwrap();
        let dirs = [socket_dir.path().to_path_buf()];
        let actual =
            execute_workspace_search_with_dirs(&querying_library, &known, &request, Some(&dirs))
                .await
                .unwrap();
        assert_eq!(actual, expected);
        stub.abort();
    }

    #[cfg(unix)]
    #[test]
    fn workspace_selection_matches_a_relinked_root_by_canonical_path() {
        let config = tempfile::TempDir::new().unwrap();
        let roots = tempfile::TempDir::new().unwrap();
        let original = roots.path().join("original");
        let moved = roots.path().join("moved");
        std::fs::create_dir_all(original.join("nested")).unwrap();
        let lib = Library::open_at(config.path().join("config.toml")).unwrap();
        let registered = lib.register_workspace(&original).unwrap();
        std::fs::rename(&original, &moved).unwrap();
        std::os::unix::fs::symlink(&moved, &original).unwrap();
        let known = lib.list_workspaces();

        let by_path = resolve_workspace_selector(&known, moved.to_str().unwrap());
        let cwd = chan_workspace::paths::canonicalize_normalized(&moved.join("nested"));
        let by_cwd = resolve_workspace_cwd(&known, &cwd);
        assert_eq!(
            (
                by_path
                    .as_ref()
                    .map(|workspace| &workspace.metadata_key)
                    .ok(),
                by_cwd.map(|workspace| &workspace.metadata_key),
            ),
            (
                Some(&registered.metadata_key),
                Some(&registered.metadata_key)
            ),
            "path error: {:?}",
            by_path.err().map(|error| error.code)
        );
    }

    #[cfg(windows)]
    #[test]
    fn workspace_selection_matches_a_relative_dot_selector() {
        let config = tempfile::TempDir::new().unwrap();
        let lib = Library::open_at(config.path().join("config.toml")).unwrap();
        let registered = lib
            .register_workspace(&std::env::current_dir().unwrap())
            .unwrap();
        let known = lib.list_workspaces();

        let selected = resolve_workspace_selector(&known, ".").unwrap();
        assert_eq!(selected.metadata_key, registered.metadata_key);
    }

    #[test]
    fn workspace_selection_preserves_explicit_order_and_deduplicates_by_key() {
        let config = tempfile::TempDir::new().unwrap();
        let roots = tempfile::TempDir::new().unwrap();
        let alpha = roots.path().join("alpha");
        let beta = roots.path().join("beta");
        std::fs::create_dir_all(&alpha).unwrap();
        std::fs::create_dir_all(&beta).unwrap();
        let lib = Library::open_at(config.path().join("config.toml")).unwrap();
        let alpha_known = lib.register_workspace(&alpha).unwrap();
        let beta_known = lib.register_workspace(&beta).unwrap();
        let targets = WorkspaceTargets {
            workspaces: vec![
                beta_known.metadata_key.clone(),
                alpha.display().to_string(),
                beta.display().to_string(),
            ],
            all_workspaces: false,
        };

        let (selected, errors) = select_workspace_targets(&lib, &targets).unwrap();

        assert!(errors.is_empty());
        assert_eq!(
            selected
                .iter()
                .map(|workspace| workspace.metadata_key.as_str())
                .collect::<Vec<_>>(),
            vec![
                beta_known.metadata_key.as_str(),
                alpha_known.metadata_key.as_str()
            ]
        );
    }

    #[test]
    fn workspace_selection_reports_ambiguous_display_names() {
        let config = tempfile::TempDir::new().unwrap();
        let roots = tempfile::TempDir::new().unwrap();
        let alpha = roots.path().join("alpha");
        let beta = roots.path().join("beta");
        std::fs::create_dir_all(&alpha).unwrap();
        std::fs::create_dir_all(&beta).unwrap();
        let lib = Library::open_at(config.path().join("config.toml")).unwrap();
        let alpha_known = lib
            .register_workspace_with_name(&alpha, Some("Shared".into()))
            .unwrap();
        let beta_known = lib
            .register_workspace_with_name(&beta, Some("shared".into()))
            .unwrap();
        let targets = WorkspaceTargets {
            workspaces: vec!["SHARED".into()],
            all_workspaces: false,
        };

        let (selected, errors) = select_workspace_targets(&lib, &targets).unwrap();

        assert!(selected.is_empty());
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].code, "ambiguous_workspace");
        assert!(errors[0]
            .message
            .contains(&alpha_known.root_path.display().to_string()));
        assert!(errors[0]
            .message
            .contains(&beta_known.root_path.display().to_string()));
    }
}
