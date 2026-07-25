//! Inspector payloads shared by file browser, graph, and search.

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use chan_workspace::{FileClass, PathClass, ReportFileStats, ReportLanguageStats, ReportTotals};
use serde::{Deserialize, Serialize};

use crate::error::{err_from, err_state};
use crate::state::AppState;

#[derive(Deserialize)]
pub struct InspectorParams {
    #[serde(default)]
    path: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InspectorKind {
    Workspace,
    Directory,
    Markdown,
    Text,
    Media,
    Binary,
    Special,
}

#[derive(Debug, Clone, Serialize)]
pub struct InspectorPayload {
    pub path: String,
    pub kind: InspectorKind,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: Option<i64>,
    pub path_class: PathClass,
    /// Always `None` now that drafts are real in-root files: the SPA
    /// derives the absolute path from `workspace.info.root` + the
    /// relative path for every path. Field kept on the payload to keep
    /// the wire shape stable; do not rely on it being populated.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub abs_path: Option<String>,
    pub frontmatter_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report_file: Option<ReportFileStats>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report_summary: Option<InspectorReportSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtree: Option<InspectorSubtree>,
}

#[derive(Debug, Clone, Serialize)]
pub struct InspectorReportSummary {
    pub totals: ReportTotals,
    pub by_language: Vec<ReportLanguageStats>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct InspectorSubtree {
    pub files: u64,
    pub directories: u64,
    pub bytes: u64,
    pub file_kinds: BTreeMap<&'static str, u64>,
}

#[derive(Debug, Default)]
struct InspectorScopeData {
    subtree: InspectorSubtree,
    report_paths: Vec<String>,
}

pub async fn api_inspector(
    State(state): State<Arc<AppState>>,
    Query(params): Query<InspectorParams>,
) -> Response {
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    match tokio::task::spawn_blocking(move || build_inspector_payload(&workspace, &params.path))
        .await
    {
        Ok(Ok(payload)) => Json(payload).into_response(),
        Ok(Err(e)) => err_from(&e),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("inspector task panicked: {e}"),
        )
            .into_response(),
    }
}

pub fn build_inspector_payload(
    workspace: &chan_workspace::Workspace,
    requested_path: &str,
) -> chan_workspace::Result<InspectorPayload> {
    let path = normalize_path(requested_path)?;
    // Drafts are now real in-root files under the configured drafts dir,
    // so the root-relative `classify_path` resolves them like any other
    // path. `abs_path` stays None: the SPA derives the absolute path from
    // `workspace.info.root` + the relative path.
    let path_class = chan_workspace::classify_path(workspace.root(), &path)?;
    let abs_path: Option<String> = None;
    let stat = if path.is_empty() {
        None
    } else {
        Some(workspace.stat(&path)?)
    };
    let is_dir = matches!(path_class.kind, chan_workspace::PathKind::Directory);
    let kind = inspector_kind(&path, &path_class);
    let frontmatter_kind = frontmatter_kind(workspace, &path, &kind)?;
    let report_file = if matches!(kind, InspectorKind::Markdown | InspectorKind::Text) {
        workspace
            .report_for_files(std::slice::from_ref(&path))?
            .files
            .into_iter()
            .find(|f| f.path == path)
    } else {
        None
    };
    let scope_data = if path.is_empty() || is_dir {
        Some(inspector_scope_data(workspace, &path)?)
    } else {
        None
    };
    let report_summary = if let Some(scope_data) = scope_data.as_ref() {
        let report = workspace.report_for_files(&scope_data.report_paths)?;
        Some(InspectorReportSummary {
            totals: report.totals,
            by_language: report.by_language,
        })
    } else {
        None
    };
    let subtree = scope_data.map(|scope| scope.subtree);
    Ok(InspectorPayload {
        path,
        kind,
        is_dir,
        size: stat.as_ref().map(|s| s.size).unwrap_or(0),
        mtime: stat.as_ref().and_then(|s| s.mtime),
        path_class,
        abs_path,
        frontmatter_kind,
        report_file,
        report_summary,
        subtree,
    })
}

fn normalize_path(requested: &str) -> chan_workspace::Result<String> {
    let trimmed = requested.trim_matches('/');
    if trimmed.is_empty() || trimmed == "." {
        return Ok(String::new());
    }
    chan_workspace::fs_ops::validate_rel(trimmed)?;
    Ok(trimmed.to_string())
}

fn inspector_kind(path: &str, class: &PathClass) -> InspectorKind {
    match class.kind {
        chan_workspace::PathKind::Directory if path.is_empty() => InspectorKind::Workspace,
        chan_workspace::PathKind::Directory => InspectorKind::Directory,
        chan_workspace::PathKind::RegularFile => match chan_workspace::fs_ops::classify(path) {
            FileClass::EditableText if chan_workspace::fs_ops::is_markdown_file(path) => {
                InspectorKind::Markdown
            }
            FileClass::EditableText | FileClass::Text => InspectorKind::Text,
            FileClass::Image | FileClass::Pdf => InspectorKind::Media,
            FileClass::Other => InspectorKind::Binary,
        },
        chan_workspace::PathKind::Symlink
        | chan_workspace::PathKind::Fifo
        | chan_workspace::PathKind::Socket
        | chan_workspace::PathKind::BlockDevice
        | chan_workspace::PathKind::CharDevice
        | chan_workspace::PathKind::Other => InspectorKind::Special,
    }
}

fn frontmatter_kind(
    workspace: &chan_workspace::Workspace,
    path: &str,
    kind: &InspectorKind,
) -> chan_workspace::Result<Option<String>> {
    if !matches!(kind, InspectorKind::Markdown) {
        return Ok(None);
    }
    let text = workspace.read_text(path)?;
    let fm = chan_workspace::markdown::parse_frontmatter(&text);
    Ok(chan_workspace::markdown::chan_kind(&fm.data).map(|spec| spec.name.to_string()))
}

fn inspector_scope_data(
    workspace: &chan_workspace::Workspace,
    path: &str,
) -> chan_workspace::Result<InspectorScopeData> {
    let entries = if path.is_empty() {
        workspace.list_tree()?
    } else {
        workspace.list_tree_prefix(path)?
    };
    let contact_paths: std::collections::HashSet<String> = workspace
        .contacts()
        .map(|rows| rows.into_iter().map(|c| c.rel_path).collect())
        .unwrap_or_default();
    let mut data = InspectorScopeData::default();
    let mut seen_inodes: HashSet<(u64, u64)> = HashSet::new();
    for entry in entries {
        if entry.path == path {
            continue;
        }
        if entry.is_dir {
            data.subtree.directories += 1;
            continue;
        }

        let abs = chan_workspace::fs_ops::resolve_safe(workspace.root(), &entry.path)?;
        let meta = std::fs::symlink_metadata(&abs).ok();
        if meta
            .as_ref()
            .and_then(inode_key)
            .is_some_and(|key| !seen_inodes.insert(key))
        {
            continue;
        }

        data.subtree.files += 1;
        data.subtree.bytes += meta
            .as_ref()
            .map(std::fs::Metadata::len)
            .unwrap_or(entry.size);
        data.report_paths.push(entry.path.clone());
        let kind = file_kind_label(&entry.path, contact_paths.contains(&entry.path));
        *data.subtree.file_kinds.entry(kind).or_default() += 1;
    }
    Ok(data)
}

#[cfg(unix)]
fn inode_key(meta: &std::fs::Metadata) -> Option<(u64, u64)> {
    if !meta.is_file() {
        return None;
    }
    use std::os::unix::fs::MetadataExt;
    Some((meta.dev(), meta.ino()))
}

#[cfg(not(unix))]
fn inode_key(_meta: &std::fs::Metadata) -> Option<(u64, u64)> {
    None
}

fn file_kind_label(path: &str, is_contact: bool) -> &'static str {
    if is_contact {
        return "contact";
    }
    // Only Markdown (.md) is a "document"; .txt is editable + searchable
    // text but not a graph document, so it labels as "text". Mirrors
    // `routes::files::project_kind` and the graph ingest gate.
    match chan_workspace::fs_ops::classify(path) {
        FileClass::EditableText if chan_workspace::fs_ops::is_markdown_file(path) => "document",
        FileClass::EditableText | FileClass::Text => "text",
        FileClass::Image | FileClass::Pdf => "media",
        FileClass::Other => "binary",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// `file_kind_label` must agree with `routes::files::project_kind`:
    /// only Markdown (.md) is `document`; .txt is `text`.
    #[test]
    fn file_kind_label_marks_only_markdown_as_document() {
        assert_eq!(file_kind_label("notes/a.md", false), "document");
        assert_eq!(file_kind_label("notes/plain.txt", false), "text");
        assert_eq!(file_kind_label("src/main.rs", false), "text");
        assert_eq!(file_kind_label("logo.png", false), "media");
        assert_eq!(file_kind_label("archive.zip", false), "binary");
        assert_eq!(file_kind_label("contacts/alex.md", true), "contact");
    }

    fn put(root: &std::path::Path, rel: &str, body: &[u8]) {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, body).unwrap();
    }

    fn open_workspace() -> (TempDir, TempDir, std::sync::Arc<chan_workspace::Workspace>) {
        let cfg = TempDir::new().unwrap();
        let workspace_root = TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(workspace_root.path()).unwrap();
        let workspace = lib.open_workspace(workspace_root.path()).unwrap();
        (cfg, workspace_root, workspace)
    }

    #[test]
    fn inspector_payload_covers_workspace_directory_text_and_binary() {
        let (_cfg, root, workspace) = open_workspace();
        put(root.path(), "src/lib.rs", b"fn main() {}\n");
        put(root.path(), "notes/today.md", b"# today\n\nbody\n");
        put(
            root.path(),
            "contacts/alex.md",
            b"---\nchan:\n  kind: contact\n---\n# Alex\n",
        );
        workspace.index_file("contacts/alex.md").unwrap();
        put(root.path(), "blob.bin", &[0, 1, 2, 3]);

        let workspace_payload = build_inspector_payload(&workspace, "").unwrap();
        assert_eq!(workspace_payload.kind, InspectorKind::Workspace);
        let subtree = workspace_payload.subtree.expect("workspace subtree");
        assert_eq!(subtree.files, 4);
        assert_eq!(subtree.directories, 3);
        assert_eq!(subtree.file_kinds.get("document"), Some(&1));
        assert_eq!(subtree.file_kinds.get("contact"), Some(&1));
        assert_eq!(subtree.file_kinds.get("text"), Some(&1));
        assert_eq!(subtree.file_kinds.get("binary"), Some(&1));
        assert!(
            workspace_payload
                .report_summary
                .as_ref()
                .expect("workspace report")
                .totals
                .bytes
                > 0
        );

        let dir_payload = build_inspector_payload(&workspace, "src").unwrap();
        assert_eq!(dir_payload.kind, InspectorKind::Directory);
        assert_eq!(dir_payload.subtree.as_ref().unwrap().files, 1);
        assert_eq!(
            dir_payload
                .report_summary
                .as_ref()
                .unwrap()
                .by_language
                .first()
                .map(|l| l.name.as_str()),
            Some("Rust")
        );

        let markdown = build_inspector_payload(&workspace, "notes/today.md").unwrap();
        assert_eq!(markdown.kind, InspectorKind::Markdown);
        assert_eq!(markdown.frontmatter_kind, None);
        assert!(markdown.report_file.is_some());

        let contact = build_inspector_payload(&workspace, "contacts/alex.md").unwrap();
        assert_eq!(contact.kind, InspectorKind::Markdown);
        assert_eq!(contact.frontmatter_kind.as_deref(), Some("contact"));

        let text = build_inspector_payload(&workspace, "src/lib.rs").unwrap();
        assert_eq!(text.kind, InspectorKind::Text);
        assert_eq!(text.report_file.as_ref().unwrap().language, "Rust");

        let binary = build_inspector_payload(&workspace, "blob.bin").unwrap();
        assert_eq!(binary.kind, InspectorKind::Binary);
        assert!(binary.report_file.is_none());
        assert!(binary.report_summary.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn inspector_scope_dedupes_hardlinked_files() {
        let (_cfg, root, workspace) = open_workspace();
        let body = b"# same inode\n\nbody\n";
        put(root.path(), "hard/a.md", body);
        std::fs::hard_link(root.path().join("hard/a.md"), root.path().join("hard/b.md")).unwrap();

        let payload = build_inspector_payload(&workspace, "hard").unwrap();
        let subtree = payload.subtree.expect("hard subtree");
        assert_eq!(subtree.files, 1);
        assert_eq!(subtree.bytes, body.len() as u64);

        let report = payload.report_summary.expect("hard report");
        assert_eq!(report.totals.files, 1);
        assert_eq!(report.totals.bytes, body.len() as u64);
    }

    #[cfg(unix)]
    #[test]
    fn inspector_payload_surfaces_read_only_directory_class() {
        use std::os::unix::fs::PermissionsExt;

        let (_cfg, root, workspace) = open_workspace();
        std::fs::create_dir(root.path().join("locked")).unwrap();
        std::fs::set_permissions(
            root.path().join("locked"),
            std::fs::Permissions::from_mode(0o555),
        )
        .unwrap();

        let payload = build_inspector_payload(&workspace, "locked").unwrap();
        assert_eq!(payload.kind, InspectorKind::Directory);
        assert_eq!(
            payload.path_class.permission,
            chan_workspace::PathPermission::ReadOnly
        );
    }

    #[test]
    fn inspector_rejects_path_escape() {
        let (_cfg, _root, workspace) = open_workspace();
        let err = build_inspector_payload(&workspace, "../etc").unwrap_err();
        assert!(matches!(err, chan_workspace::ChanError::PathEscape));
    }

    #[test]
    fn empty_path_normalizes_to_workspace_root() {
        assert_eq!(normalize_path("").unwrap(), "");
        assert_eq!(normalize_path("/").unwrap(), "");
        assert_eq!(normalize_path("./").unwrap(), "");
        assert_eq!(normalize_path("/notes/a.md").unwrap(), "notes/a.md");
    }

    #[test]
    fn inspector_missing_path_is_not_found() {
        let (_cfg, _root, workspace) = open_workspace();
        let err = build_inspector_payload(&workspace, "missing.md").unwrap_err();
        assert!(matches!(err, chan_workspace::ChanError::Io(_)));
    }
}
