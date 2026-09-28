use std::fs;
use std::path::{Path, PathBuf};

use chan_workspace::{
    Library, WorkspaceGraphNode, WorkspaceSearchDomain, WorkspaceSearchRequest, WorkspaceSelector,
    WorkspaceSelectorKind,
};
use serde::Deserialize;
use tempfile::TempDir;

#[derive(Debug, Deserialize)]
struct Golden {
    cases: Vec<GoldenCase>,
}

#[derive(Debug, Deserialize)]
struct GoldenCase {
    lens: String,
    depth: u8,
    seed: String,
    visible_node_ids: Vec<String>,
    relationship_keys: Vec<String>,
}

fn fixture_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/workspace-search")
        .canonicalize()
        .unwrap()
}

fn copy_tree(source: &Path, target: &Path) {
    fs::create_dir_all(target).unwrap();
    for entry in fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let destination = target.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &destination);
        } else {
            fs::copy(entry.path(), destination).unwrap();
        }
    }
}

fn files_under(root: &Path, directory: &Path, paths: &mut Vec<String>) {
    for entry in fs::read_dir(directory).unwrap() {
        let entry = entry.unwrap();
        if entry.file_type().unwrap().is_dir() {
            files_under(root, &entry.path(), paths);
        } else {
            paths.push(chan_workspace::fs_ops::rel_path_text(
                entry.path().strip_prefix(root).unwrap(),
            ));
        }
    }
}

fn node_id(node: &WorkspaceGraphNode) -> &str {
    match node {
        WorkspaceGraphNode::File { id, .. }
        | WorkspaceGraphNode::Directory { id, .. }
        | WorkspaceGraphNode::Tag { id, .. }
        | WorkspaceGraphNode::Mention { id, .. }
        | WorkspaceGraphNode::Contact { id, .. }
        | WorkspaceGraphNode::Language { id, .. } => id,
    }
}

fn selector_kind(lens: &str) -> WorkspaceSelectorKind {
    match lens {
        "file" => WorkspaceSelectorKind::File,
        "directory" => WorkspaceSelectorKind::Directory,
        "tag" => WorkspaceSelectorKind::Tag,
        "mention" => WorkspaceSelectorKind::Mention,
        "contact" => WorkspaceSelectorKind::Contact,
        "language" => WorkspaceSelectorKind::Language,
        other => panic!("unknown golden lens {other}"),
    }
}

#[test]
fn workspace_search_matches_shared_lens_golden() {
    let fixture = fixture_root();
    let config = TempDir::new().unwrap();
    let root = TempDir::new().unwrap();
    copy_tree(&fixture.join("workspace"), root.path());

    let library = Library::open_at(config.path().join("config.toml")).unwrap();
    library.register_workspace(root.path()).unwrap();
    let workspace = library.open_workspace(root.path()).unwrap();
    workspace.report().unwrap();
    let mut paths = Vec::new();
    files_under(root.path(), root.path(), &mut paths);
    paths.sort();
    for path in paths {
        workspace.index_file(&path).unwrap();
    }

    let golden: Golden =
        serde_json::from_str(&fs::read_to_string(fixture.join("expected.json")).unwrap()).unwrap();
    assert_eq!(
        golden.cases.len(),
        18,
        "golden must pin all 18 lens x depth cases"
    );
    for case in golden.cases {
        let value = case
            .seed
            .strip_prefix("directory:")
            .unwrap_or(&case.seed)
            .to_string();
        let result = workspace
            .workspace_search(&WorkspaceSearchRequest {
                from: vec![WorkspaceSelector {
                    kind: selector_kind(&case.lens),
                    value,
                }],
                depth: Some(case.depth),
                ..WorkspaceSearchRequest::default()
            })
            .unwrap();
        assert!(
            result.errors.is_empty(),
            "{}: {:?}",
            case.lens,
            result.errors
        );

        let mut ids: Vec<String> = result
            .nodes
            .iter()
            .map(|node| node_id(node).to_string())
            .collect();
        ids.sort();
        assert_eq!(
            ids, case.visible_node_ids,
            "{} depth {}",
            case.lens, case.depth
        );

        let mut relationships: Vec<String> = result
            .relationships
            .iter()
            .map(|relationship| {
                serde_json::to_string(&(
                    &relationship.source,
                    &relationship.target,
                    relationship.kind,
                ))
                .unwrap()
            })
            .collect();
        relationships.sort();
        assert_eq!(
            relationships, case.relationship_keys,
            "{} depth {}",
            case.lens, case.depth
        );
    }
}

#[test]
fn workspace_search_fixture_keeps_source_bodies_out_of_content_search() {
    let fixture = fixture_root();
    let config = TempDir::new().unwrap();
    let root = TempDir::new().unwrap();
    copy_tree(&fixture.join("workspace"), root.path());
    let library = Library::open_at(config.path().join("config.toml")).unwrap();
    library.register_workspace(root.path()).unwrap();
    let workspace = library.open_workspace(root.path()).unwrap();
    workspace.index_file("src/lib.rs").unwrap();

    let content = workspace
        .workspace_search(&WorkspaceSearchRequest {
            query: Some("WORKSPACE_SEARCH_SOURCE_ONLY_TOKEN_7F31".into()),
            domains: vec![WorkspaceSearchDomain::Content],
            ..WorkspaceSearchRequest::default()
        })
        .unwrap();
    assert!(content.content_hits.is_empty());

    let entity = workspace
        .workspace_search(&WorkspaceSearchRequest {
            query: Some("src/lib.rs".into()),
            domains: vec![WorkspaceSearchDomain::File],
            ..WorkspaceSearchRequest::default()
        })
        .unwrap();
    assert!(
        entity
            .entity_matches
            .iter()
            .any(|matched| matched.id == "src/lib.rs"),
        "source path entity missing: {entity:#?}"
    );
}
