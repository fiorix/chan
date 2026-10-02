#[cfg(unix)]
use std::path::Path;

#[cfg(unix)]
use chan_workspace::WorkspaceSearchResult;

#[cfg(unix)]
pub(super) fn empty_workspace_search_result(root: &Path, key: &str) -> WorkspaceSearchResult {
    WorkspaceSearchResult {
        workspace: chan_workspace::WorkspaceSearchIdentity {
            root: root.display().to_string(),
            metadata_key: key.into(),
            display_name: root
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
        },
        readiness: chan_workspace::WorkspaceReadiness::default(),
        search: chan_workspace::WorkspaceSearchStatus {
            requested: false,
            ready: true,
            mode: chan_workspace::EffectiveSearchMode::NotRun,
        },
        content_hits: Vec::new(),
        entity_matches: Vec::new(),
        nodes: Vec::new(),
        relationships: Vec::new(),
        traversal: chan_workspace::EffectiveWorkspaceTraversal {
            depth: 0,
            direction: chan_workspace::WorkspaceTraversalDirection::Auto,
            relationship_kinds: Vec::new(),
            spine_forced: false,
            profiles: Vec::new(),
        },
        truncation: chan_workspace::WorkspaceSearchTruncation::default(),
        warnings: Vec::new(),
        errors: Vec::new(),
    }
}

#[cfg(unix)]
pub(super) fn spawn_workspace_search_stub(
    socket: &std::path::Path,
    identity: chan_shell::Identity,
    result: WorkspaceSearchResult,
) -> tokio::task::JoinHandle<()> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let listener = tokio::net::UnixListener::bind(socket).expect("bind workspace stub");
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            let (read, mut write) = stream.into_split();
            let mut line = String::new();
            if BufReader::new(read).read_line(&mut line).await.is_err() {
                continue;
            }
            let response = match serde_json::from_str::<chan_shell::ControlRequest>(&line) {
                Ok(chan_shell::ControlRequest::Identify) => chan_shell::ControlResponse::Ok {
                    message: serde_json::to_string(&identity).expect("identity json"),
                },
                Ok(chan_shell::ControlRequest::WorkspaceSearch { .. }) => {
                    chan_shell::ControlResponse::Ok {
                        message: serde_json::to_string(&result).expect("search json"),
                    }
                }
                _ => chan_shell::ControlResponse::Error {
                    message: "unsupported request".into(),
                },
            };
            let mut out = serde_json::to_vec(&response).expect("response json");
            out.push(b'\n');
            let _ = write.write_all(&out).await;
        }
    })
}
