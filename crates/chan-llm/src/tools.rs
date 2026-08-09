// Tool sandbox for the assistant.
//
// Standard tools covering the editor's common operations:
//
//   read_file(path)       -> string
//   write_file(path, ...) -> { path, bytes_written }
//   list_files()          -> tree
//   resolve_path(path)    -> physical path metadata
//   workspace_search(...) -> bounded search and graph traversal
//
// Content tools route through `chan_workspace::Workspace` so the filesystem
// invariants (path sandbox, special-file refusal, atomic writes)
// apply automatically. `resolve_path` is metadata only: it reveals
// the real path behind a public chan path when a shell tool needs a
// cwd, but does not read or write content. Writes apply immediately;
// permission gating for destructive batch work is the model's
// responsibility (it calls `AskUserQuestion` before the writes).

use std::sync::Arc;

use chan_workspace::{
    Workspace, WorkspaceRelationshipKind, WorkspaceSearchDomain, WorkspaceSearchRequest,
    WorkspaceSelector, WorkspaceSelectorKind, WorkspaceTraversalDirection,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;

use crate::error::{LlmError, Result};

/// Soft cap on `read_file` output. 256 KiB is roughly 250k chars of
/// English, well past any realistic single-shot read for assistant
/// reasoning, and a tiny fraction of any frontier model's context
/// window. Past this we truncate and tell the model to issue a
/// follow-up read with the suffix it actually wants. Without the
/// cap, a misnamed binary or a runaway pasted-image markdown can
/// bloat the next turn's request body and the user's token bill.
pub const READ_FILE_CAP_BYTES: usize = 256 * 1024;

/// Soft cap on `list_files` entries. The workspace layer caps the walk
/// at 500k; this layer caps the slice we hand to the model at a
/// number that fits a model's context plus leaves room for the
/// rest of the conversation. 2k entries renders as a few hundred
/// KB of JSON which is already pushing it; past this we truncate
/// and tell the model to narrow with the `prefix` arg.
pub const LIST_FILES_CAP_ENTRIES: usize = 2_000;

/// Cap on per-file rows returned by `repo_report` when
/// `include_files = true`. The roll-ups and COCOMO summary stay
/// intact; only the `files` array is truncated past this point. A
/// workspace with ~200 files of code already produces ~50 KB of JSON
/// per call, which is the budget we're willing to spend on a
/// single tool response. The assistant narrows with `prefix` or
/// `paths` if it needs more detail.
pub const REPO_REPORT_FILES_CAP: usize = 200;

/// Hard cap on the `content` arg of `write_file`. Mirrors
/// `chan_workspace::TEXT_WRITE_LIMIT` (2 MiB) so a runaway model emitting
/// a multi-GB string fails fast inside chan-llm rather than reaching
/// chan-workspace (which would have rejected it anyway, but only after
/// the full string had been deserialized, cloned, and handed across
/// the tool dispatch boundary). The MCP layer applies the same
/// check before crossing into chan-llm.
pub const WRITE_FILE_CONTENT_CAP_BYTES: usize = 2 * 1024 * 1024;

/// Context the tools see. Owns an `Arc<Workspace>` so tool calls cross
/// thread boundaries cheaply.
#[derive(Clone)]
pub struct ToolContext {
    pub workspace: Arc<Workspace>,
}

/// Typed selector accepted by the LLM-facing workspace search tool.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct WorkspaceSearchSelector {
    pub kind: WorkspaceSearchSelectorKind,
    pub value: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceSearchSelectorKind {
    File,
    Directory,
    Tag,
    Mention,
    Contact,
    Language,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceSearchDomainParam {
    Content,
    File,
    Directory,
    Tag,
    Mention,
    Contact,
    Language,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceSearchDirection {
    #[default]
    Auto,
    Out,
    In,
    Both,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceSearchRelationshipKind {
    Link,
    Tag,
    Mention,
    Language,
    Contains,
}

/// Canonical input for standard and MCP workspace-search dispatch.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct WorkspaceSearchParams {
    pub query: Option<String>,
    pub from: Vec<WorkspaceSearchSelector>,
    pub domains: Vec<WorkspaceSearchDomainParam>,
    pub depth: Option<u8>,
    pub direction: WorkspaceSearchDirection,
    pub relationship_kinds: Vec<WorkspaceSearchRelationshipKind>,
    pub limit: Option<u32>,
    pub node_limit: Option<u32>,
    pub edge_limit: Option<u32>,
}

impl From<WorkspaceSearchParams> for WorkspaceSearchRequest {
    fn from(value: WorkspaceSearchParams) -> Self {
        Self {
            query: value.query,
            from: value
                .from
                .into_iter()
                .map(|selector| WorkspaceSelector {
                    kind: match selector.kind {
                        WorkspaceSearchSelectorKind::File => WorkspaceSelectorKind::File,
                        WorkspaceSearchSelectorKind::Directory => WorkspaceSelectorKind::Directory,
                        WorkspaceSearchSelectorKind::Tag => WorkspaceSelectorKind::Tag,
                        WorkspaceSearchSelectorKind::Mention => WorkspaceSelectorKind::Mention,
                        WorkspaceSearchSelectorKind::Contact => WorkspaceSelectorKind::Contact,
                        WorkspaceSearchSelectorKind::Language => WorkspaceSelectorKind::Language,
                    },
                    value: selector.value,
                })
                .collect(),
            domains: value
                .domains
                .into_iter()
                .map(|domain| match domain {
                    WorkspaceSearchDomainParam::Content => WorkspaceSearchDomain::Content,
                    WorkspaceSearchDomainParam::File => WorkspaceSearchDomain::File,
                    WorkspaceSearchDomainParam::Directory => WorkspaceSearchDomain::Directory,
                    WorkspaceSearchDomainParam::Tag => WorkspaceSearchDomain::Tag,
                    WorkspaceSearchDomainParam::Mention => WorkspaceSearchDomain::Mention,
                    WorkspaceSearchDomainParam::Contact => WorkspaceSearchDomain::Contact,
                    WorkspaceSearchDomainParam::Language => WorkspaceSearchDomain::Language,
                })
                .collect(),
            depth: value.depth,
            direction: match value.direction {
                WorkspaceSearchDirection::Auto => WorkspaceTraversalDirection::Auto,
                WorkspaceSearchDirection::Out => WorkspaceTraversalDirection::Out,
                WorkspaceSearchDirection::In => WorkspaceTraversalDirection::In,
                WorkspaceSearchDirection::Both => WorkspaceTraversalDirection::Both,
            },
            relationship_kinds: value
                .relationship_kinds
                .into_iter()
                .map(|kind| match kind {
                    WorkspaceSearchRelationshipKind::Link => WorkspaceRelationshipKind::Link,
                    WorkspaceSearchRelationshipKind::Tag => WorkspaceRelationshipKind::Tag,
                    WorkspaceSearchRelationshipKind::Mention => WorkspaceRelationshipKind::Mention,
                    WorkspaceSearchRelationshipKind::Language => {
                        WorkspaceRelationshipKind::Language
                    }
                    WorkspaceSearchRelationshipKind::Contains => {
                        WorkspaceRelationshipKind::Contains
                    }
                })
                .collect(),
            limit: value.limit,
            node_limit: value.node_limit,
            edge_limit: value.edge_limit,
        }
    }
}

impl ToolContext {
    pub fn new(workspace: Arc<Workspace>) -> Self {
        Self { workspace }
    }
}

/// The built-in tools. Backends see these as named tool
/// schemas; the assistant proposes calls and we dispatch through
/// `StandardTool::execute`. Adding a new built-in tool means a new
/// variant here plus a handler arm.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StandardTool {
    ReadFile,
    WriteFile,
    ListFiles,
    ResolvePath,
    WorkspaceSearch,
    RepoReport,
}

impl StandardTool {
    pub fn name(self) -> &'static str {
        match self {
            StandardTool::ReadFile => "read_file",
            StandardTool::WriteFile => "write_file",
            StandardTool::ListFiles => "list_files",
            StandardTool::ResolvePath => "resolve_path",
            StandardTool::WorkspaceSearch => "workspace_search",
            StandardTool::RepoReport => "repo_report",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "read_file" => Some(StandardTool::ReadFile),
            "write_file" => Some(StandardTool::WriteFile),
            "list_files" => Some(StandardTool::ListFiles),
            "resolve_path" => Some(StandardTool::ResolvePath),
            "workspace_search" => Some(StandardTool::WorkspaceSearch),
            "repo_report" => Some(StandardTool::RepoReport),
            _ => None,
        }
    }
}

/// Run a tool by name with the given args. Returns the tool's
/// result JSON. Unknown tools error.
pub fn execute(name: &str, args: &Json, ctx: &ToolContext) -> Result<Json> {
    let Some(tool) = StandardTool::from_name(name) else {
        return Err(LlmError::Tool(format!("unknown tool: {name}")));
    };
    match tool {
        StandardTool::ReadFile => exec_read_file(args, ctx),
        StandardTool::ListFiles => exec_list_files(args, ctx),
        StandardTool::ResolvePath => exec_resolve_path(args, ctx),
        StandardTool::WorkspaceSearch => exec_workspace_search(args, ctx),
        StandardTool::RepoReport => exec_repo_report(args, ctx),
        StandardTool::WriteFile => exec_write_file(args, ctx),
    }
}

fn arg_string<'a>(args: &'a Json, key: &str) -> Result<&'a str> {
    args.get(key)
        .and_then(|v| v.as_str())
        .ok_or_else(|| LlmError::Tool(format!("missing string arg `{key}`")))
}

fn exec_read_file(args: &Json, ctx: &ToolContext) -> Result<Json> {
    let path = arg_string(args, "path")?;
    // read_text_with_stat returns content + ns mtime in one stat
    // (no second-syscall race), so we can echo `mtime_ns` to the
    // model and accept it back on `write_file` for an OCC check.
    let (content, stat) = ctx.workspace.read_text_with_stat(path)?;
    let original_len = content.len();
    let (content, truncated) = if original_len > READ_FILE_CAP_BYTES {
        // Truncate at a UTF-8 char boundary so we hand the model a
        // valid Rust String. find_char_boundary walks back at most
        // 4 bytes which is cheap.
        let mut cut = READ_FILE_CAP_BYTES;
        while cut > 0 && !content.is_char_boundary(cut) {
            cut -= 1;
        }
        (content[..cut].to_owned(), true)
    } else {
        (content, false)
    };
    let mut out = serde_json::json!({
        "path": path,
        "content": content,
        "size": original_len,
    });
    if let Some(mtime_ns) = stat.mtime_ns {
        out["mtime_ns"] = serde_json::json!(mtime_ns);
    }
    if truncated {
        out["truncated"] = serde_json::Value::Bool(true);
        out["note"] = serde_json::json!(format!(
            "file truncated to {READ_FILE_CAP_BYTES} bytes; full size {original_len}"
        ));
    }
    Ok(out)
}

fn exec_list_files(args: &Json, ctx: &ToolContext) -> Result<Json> {
    let prefix = args.get("prefix").and_then(|v| v.as_str());
    // Push prefix scoping into chan-workspace so a narrow `prefix` on a
    // 500k-file workspace walks only the relevant subtree instead of the
    // full root. Drafts (in the in-root `.Drafts/` dir) are included by
    // the normal walk like any other content.
    let mut entries: Vec<_> = match prefix {
        Some(p) if !p.is_empty() => ctx
            .workspace
            .list_tree_prefix_unified(p.trim_end_matches('/'))?,
        _ => ctx.workspace.list_tree_unified()?,
    };
    let total = entries.len();
    let truncated = total > LIST_FILES_CAP_ENTRIES;
    if truncated {
        entries.truncate(LIST_FILES_CAP_ENTRIES);
    }
    let count = entries.len();
    let entries = serde_json::to_value(&entries)
        .map_err(|e| LlmError::Tool(format!("serialize tree: {e}")))?;
    let mut out = serde_json::json!({
        "entries": entries,
        "count": count,
        "total": total,
    });
    if truncated {
        out["truncated"] = serde_json::Value::Bool(true);
        out["note"] = serde_json::json!(format!(
            "listing capped at {LIST_FILES_CAP_ENTRIES} of {total}; \
             call again with a `prefix` to narrow."
        ));
    }
    Ok(out)
}

fn exec_resolve_path(args: &Json, ctx: &ToolContext) -> Result<Json> {
    let path = arg_string(args, "path")?;
    let physical = ctx.workspace.resolve_physical_path(path)?;
    let meta = std::fs::symlink_metadata(&physical).ok();
    // Drafts are now real in-root files under the configured drafts dir,
    // so nothing resolves to a virtual location outside the root. The
    // `virtual` flag stays for wire stability but is always false.
    let out = serde_json::json!({
        "path": path,
        "physical_path": physical.to_string_lossy(),
        "virtual": false,
        "exists": meta.is_some(),
        "is_dir": meta.as_ref().is_some_and(|m| m.is_dir()),
    });
    Ok(out)
}

fn exec_workspace_search(args: &Json, ctx: &ToolContext) -> Result<Json> {
    let params: WorkspaceSearchParams = serde_json::from_value(args.clone())
        .map_err(|error| LlmError::Tool(format!("invalid workspace_search args: {error}")))?;
    let result = ctx.workspace.workspace_search(&params.into())?;
    serde_json::to_value(result)
        .map_err(|error| LlmError::Tool(format!("serialize workspace search: {error}")))
}

fn exec_repo_report(args: &Json, ctx: &ToolContext) -> Result<Json> {
    // Resolve scope. `paths` wins over `prefix` (documented in
    // REPO_REPORT_DESC) so a model that bundles both gets the
    // narrower view it presumably wants.
    let paths: Vec<String> = args
        .get("paths")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let prefix = args.get("prefix").and_then(|v| v.as_str()).unwrap_or("");

    let mut report = if !paths.is_empty() {
        ctx.workspace.report_for_files(&paths)?
    } else if !prefix.is_empty() {
        ctx.workspace.report_for_prefix(prefix)?
    } else {
        ctx.workspace.report()?
    };

    let include_files = args
        .get("include_files")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    // Take the per-file array out of the report so the serializer
    // below never walks it on the include_files=false path. Holding
    // it on the side also avoids the redundant `report.files.clone()`
    // on the truncate branch the previous code had: we own `files`
    // here and sort/truncate it in place.
    let files = std::mem::take(&mut report.files);
    let total_files = files.len();
    let mut value = serde_json::to_value(&report)
        .map_err(|e| LlmError::Tool(format!("serialize report: {e}")))?;
    let obj = value
        .as_object_mut()
        .expect("Report serializes to a JSON object");

    if !include_files {
        // Drop the (now-empty) per-file array entirely; the assistant
        // asked for an overview. The other roll-up fields stay.
        obj.remove("files");
        obj.insert("files_omitted".into(), serde_json::json!(true));
    } else if total_files > REPO_REPORT_FILES_CAP {
        let mut sorted = files;
        // Sort by path so the truncation is stable across calls
        // and the model can predict what it'll see next time.
        sorted.sort_by(|a, b| a.path.cmp(&b.path));
        sorted.truncate(REPO_REPORT_FILES_CAP);
        obj.insert(
            "files".into(),
            serde_json::to_value(&sorted)
                .map_err(|e| LlmError::Tool(format!("serialize files: {e}")))?,
        );
        obj.insert("truncated".into(), serde_json::json!(true));
        obj.insert("total_files".into(), serde_json::json!(total_files));
    } else {
        // include_files=true and under the cap: re-insert the full
        // list verbatim. The serializer walks the files we already
        // own; no allocation beyond the resulting JSON value.
        obj.insert(
            "files".into(),
            serde_json::to_value(&files)
                .map_err(|e| LlmError::Tool(format!("serialize files: {e}")))?,
        );
    }

    Ok(value)
}

fn exec_write_file(args: &Json, ctx: &ToolContext) -> Result<Json> {
    let path = arg_string(args, "path")?;
    let content = arg_string(args, "content")?;
    // Reject oversized payloads before the tool result clones the
    // content into the next turn's transcript and before chan-workspace
    // gets a chance to allocate the write buffer. chan-workspace caps the
    // same value (TEXT_WRITE_LIMIT) but only after the string has
    // already crossed into its API; bailing here saves a clone and
    // keeps a runaway model from charging tokens on a write that
    // can't possibly land.
    if content.len() > WRITE_FILE_CONTENT_CAP_BYTES {
        return Err(LlmError::Tool(format!(
            "write_file: content {} bytes exceeds {} byte cap",
            content.len(),
            WRITE_FILE_CONTENT_CAP_BYTES
        )));
    }
    // Optional optimistic-concurrency token. The assistant gets
    // mtime_ns back from `read_file`; passing it here makes the
    // write a compare-and-swap against the file's current mtime,
    // which catches the case where the user (or another tool) has
    // edited the file between the assistant's read and its write.
    let expected_mtime_ns = args.get("expected_mtime_ns").and_then(|v| v.as_i64());
    if let Some(expected) = expected_mtime_ns {
        ctx.workspace
            .write_text_if_unchanged(path, Some(expected), None, content)?;
    } else {
        // No expected mtime supplied: fall back to a plain write.
        // This is the "the model didn't read first" path and
        // matches the legacy behavior; new flows should always
        // round-trip mtime_ns.
        ctx.workspace.write_text(path, content)?;
    }
    Ok(serde_json::json!({
        "path": path,
        "bytes_written": content.len(),
    }))
}

/// JSON-schema descriptor for one tool, in the common
/// `{name, description, parameters}` form. MCP hosts translate from
/// this to their wire format.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ToolSchema {
    pub name: &'static str,
    pub description: &'static str,
    pub parameters: Json,
}

/// Return JSON-schema descriptors for the built-in tools.
/// Hosts call this to populate their MCP tool surface.
pub fn standard_tool_schemas() -> Vec<ToolSchema> {
    vec![
        ToolSchema {
            name: "read_file",
            description: crate::prompts::READ_FILE_DESC,
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "POSIX rel path in chan's public namespace."
                    }
                },
                "required": ["path"],
            }),
        },
        ToolSchema {
            name: "write_file",
            description: crate::prompts::WRITE_FILE_DESC,
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "content": { "type": "string" },
                    "expected_mtime_ns": {
                        "type": "integer",
                        "description": "Optional. If set, the write only succeeds when the file's current mtime equals this value (the `mtime_ns` from your prior read_file response). Use this to detect concurrent edits; on conflict the call returns an error and you can re-read."
                    }
                },
                "required": ["path", "content"],
            }),
        },
        ToolSchema {
            name: "list_files",
            description: crate::prompts::LIST_FILES_DESC,
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "prefix": {
                        "type": "string",
                        "description": "Optional POSIX rel-path prefix to scope the listing. Empty / omitted lists the whole workspace (capped)."
                    }
                }
            }),
        },
        ToolSchema {
            name: "resolve_path",
            description: crate::prompts::RESOLVE_PATH_DESC,
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "POSIX rel path in chan's public namespace."
                    }
                },
                "required": ["path"],
            }),
        },
        ToolSchema {
            name: "workspace_search",
            description: crate::prompts::WORKSPACE_SEARCH_DESC,
            parameters: workspace_search_schema(),
        },
        ToolSchema {
            name: "repo_report",
            description: crate::prompts::REPO_REPORT_DESC,
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "prefix": {
                        "type": "string",
                        "description": "Optional POSIX rel-path to scope the snapshot to a subdirectory."
                    },
                    "paths": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Optional explicit list of POSIX rel-paths. When non-empty, takes precedence over `prefix`."
                    },
                    "include_files": {
                        "type": "boolean",
                        "description": "Include per-file rows in the response (capped at 200). Default false: only totals, per-language roll-ups, and the COCOMO summary are returned."
                    }
                }
            }),
        },
    ]
}

fn workspace_search_schema() -> Json {
    let generator = schemars::generate::SchemaSettings::draft2020_12().into_generator();
    serde_json::to_value(generator.into_root_schema_for::<WorkspaceSearchParams>())
        .expect("WorkspaceSearchParams schema serializes")
}

#[cfg(test)]
mod tests {
    use super::*;
    use chan_workspace::Library;
    use tempfile::TempDir;

    fn fixture() -> (TempDir, TempDir, ToolContext) {
        let cfg = TempDir::new().unwrap();
        let workspace_dir = TempDir::new().unwrap();
        let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(workspace_dir.path()).unwrap();
        let workspace = lib.open_workspace(workspace_dir.path()).unwrap();
        let ctx = ToolContext::new(workspace);
        (cfg, workspace_dir, ctx)
    }

    #[test]
    fn read_file_returns_content() {
        let (_cfg, root, ctx) = fixture();
        std::fs::write(root.path().join("a.md"), "hello").unwrap();
        let v = execute("read_file", &serde_json::json!({"path": "a.md"}), &ctx).unwrap();
        assert_eq!(v["content"], "hello");
    }

    #[test]
    fn write_file_applies_immediately() {
        let (_cfg, _root, ctx) = fixture();
        let v = execute(
            "write_file",
            &serde_json::json!({"path": "a.md", "content": "hello"}),
            &ctx,
        )
        .unwrap();
        assert_eq!(v["path"], "a.md");
        assert_eq!(v["bytes_written"], 5);
        assert_eq!(ctx.workspace.read_text("a.md").unwrap(), "hello");
    }

    #[test]
    fn unknown_tool_errors() {
        let (_cfg, _root, ctx) = fixture();
        let err = execute("rm_rf", &serde_json::json!({}), &ctx).unwrap_err();
        assert!(matches!(err, LlmError::Tool(_)));
    }

    #[test]
    fn read_file_truncates_large_content() {
        let (_cfg, root, ctx) = fixture();
        let big = "x".repeat(READ_FILE_CAP_BYTES + 1024);
        std::fs::write(root.path().join("big.md"), &big).unwrap();
        let v = execute("read_file", &serde_json::json!({"path": "big.md"}), &ctx).unwrap();
        assert_eq!(v["truncated"], serde_json::Value::Bool(true));
        assert_eq!(
            v["size"].as_u64().unwrap(),
            (READ_FILE_CAP_BYTES + 1024) as u64
        );
        let content = v["content"].as_str().unwrap();
        assert!(content.len() <= READ_FILE_CAP_BYTES);
    }

    #[test]
    fn list_files_filters_by_prefix_and_caps() {
        let (_cfg, root, ctx) = fixture();
        std::fs::create_dir_all(root.path().join("notes")).unwrap();
        std::fs::create_dir_all(root.path().join("recipes")).unwrap();
        std::fs::write(root.path().join("notes/a.md"), "x").unwrap();
        std::fs::write(root.path().join("notes/b.md"), "x").unwrap();
        std::fs::write(root.path().join("recipes/r.md"), "x").unwrap();
        let v = execute("list_files", &serde_json::json!({"prefix": "notes"}), &ctx).unwrap();
        let entries = v["entries"].as_array().unwrap();
        let paths: Vec<&str> = entries
            .iter()
            .map(|e| e["path"].as_str().unwrap())
            .collect();
        assert!(paths.contains(&"notes/a.md"));
        assert!(paths.contains(&"notes/b.md"));
        assert!(!paths.iter().any(|p| p.starts_with("recipes/")));
    }

    #[test]
    fn list_files_includes_in_root_drafts_dir() {
        // Drafts are real in-root files under the configured drafts dir,
        // so they show up in the workspace tree like any other path.
        let (_cfg, _root, ctx) = fixture();
        let drafts_dir = ctx.workspace.drafts_dir_name().to_string();
        ctx.workspace.create_draft_dir("untitled-1").unwrap();
        let draft_md = format!("{drafts_dir}/untitled-1/draft.md");
        ctx.workspace.write_text(&draft_md, "# draft\n").unwrap();

        let v = execute("list_files", &serde_json::json!({}), &ctx).unwrap();
        let paths: Vec<&str> = v["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["path"].as_str().unwrap())
            .collect();
        assert!(paths.contains(&drafts_dir.as_str()));
        assert!(paths.contains(&draft_md.as_str()));

        let prefix = format!("{drafts_dir}/untitled-1");
        let v = execute("list_files", &serde_json::json!({ "prefix": prefix }), &ctx).unwrap();
        let paths: Vec<&str> = v["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["path"].as_str().unwrap())
            .collect();
        assert!(paths.contains(&prefix.as_str()));
        assert!(paths.contains(&draft_md.as_str()));
    }

    #[test]
    fn resolve_path_resolves_in_root_draft_to_real_path() {
        // Drafts are real in-root files under the configured drafts dir
        // now, so a draft path resolves like any other in-root path:
        // `virtual` is always false and the physical path lives under
        // the workspace root's drafts dir.
        let (_cfg, root, ctx) = fixture();
        let drafts_dir = ctx.workspace.drafts_dir_name().to_string();
        ctx.workspace.create_draft_dir("untitled-1").unwrap();
        let draft_dir_rel = format!("{drafts_dir}/untitled-1");
        ctx.workspace
            .write_text(&format!("{draft_dir_rel}/draft.md"), "# draft\n")
            .unwrap();

        let draft = execute(
            "resolve_path",
            &serde_json::json!({ "path": draft_dir_rel }),
            &ctx,
        )
        .unwrap();
        assert_eq!(draft["path"], draft_dir_rel);
        assert_eq!(draft["virtual"], false);
        assert_eq!(draft["exists"], true);
        assert_eq!(draft["is_dir"], true);
        assert_eq!(
            draft["physical_path"].as_str().unwrap(),
            ctx.workspace
                .drafts_dir()
                .join("untitled-1")
                .to_string_lossy()
                .into_owned()
        );

        let workspace_path =
            execute("resolve_path", &serde_json::json!({"path": "notes"}), &ctx).unwrap();
        assert_eq!(workspace_path["virtual"], false);
        assert_eq!(
            workspace_path["physical_path"].as_str().unwrap(),
            root.path()
                .canonicalize()
                .unwrap()
                .join("notes")
                .to_string_lossy()
                .into_owned()
        );
    }

    #[test]
    fn workspace_search_uses_typed_selectors_and_core_limits() {
        let (_cfg, _root, ctx) = fixture();
        let result = execute(
            "workspace_search",
            &serde_json::json!({
                "from": [{"kind": "tag", "value": "design"}],
                "domains": ["tag", "file"],
                "depth": 1,
                "direction": "both",
                "relationship_kinds": ["tag"],
                "limit": 1_000_000,
            }),
            &ctx,
        )
        .unwrap();
        assert!(result["workspace"]["root"].is_string());
        assert_eq!(result["traversal"]["direction"], "both");
    }

    #[test]
    fn read_file_returns_mtime_ns_for_round_trip() {
        let (_cfg, root, ctx) = fixture();
        std::fs::write(root.path().join("a.md"), "hello").unwrap();
        let v = execute("read_file", &serde_json::json!({"path": "a.md"}), &ctx).unwrap();
        assert!(
            v["mtime_ns"].is_i64() || v["mtime_ns"].is_null(),
            "mtime_ns should be present (i64) or absent on FSes without ns mtime"
        );
    }

    #[test]
    fn write_file_with_mismatched_mtime_returns_conflict() {
        let (_cfg, _root, ctx) = fixture();
        ctx.workspace.write_text("a.md", "v1").unwrap();
        // Stale mtime from a parallel-universe earlier write.
        let stale = serde_json::json!({
            "path": "a.md",
            "content": "v2",
            "expected_mtime_ns": 1i64,
        });
        let err = execute("write_file", &stale, &ctx).unwrap_err();
        // Typed passthrough: hosts can branch on the kind without
        // string-matching.
        assert!(matches!(err, LlmError::WriteConflict { .. }));
        assert_eq!(ctx.workspace.read_text("a.md").unwrap(), "v1");
    }

    #[test]
    fn write_file_with_matching_mtime_succeeds() {
        let (_cfg, _root, ctx) = fixture();
        ctx.workspace.write_text("a.md", "v1").unwrap();
        let stat = ctx.workspace.stat("a.md").unwrap();
        let args = serde_json::json!({
            "path": "a.md",
            "content": "v2",
            "expected_mtime_ns": stat.mtime_ns,
        });
        let v = execute("write_file", &args, &ctx).unwrap();
        assert_eq!(v["bytes_written"], 2);
        assert_eq!(ctx.workspace.read_text("a.md").unwrap(), "v2");
    }

    #[test]
    fn repo_report_default_omits_files() {
        let (_cfg, root, ctx) = fixture();
        std::fs::write(root.path().join("a.md"), "# a\n").unwrap();
        std::fs::write(root.path().join("b.md"), "# b\n").unwrap();

        let v = execute("repo_report", &serde_json::json!({}), &ctx).unwrap();
        assert_eq!(v["files_omitted"], serde_json::json!(true));
        assert!(v.get("files").is_none());
        assert!(v["totals"]["files"].as_u64().unwrap() >= 2);
        assert!(v["by_language"].is_array());
        assert!(v["cocomo"]["model"].is_string());
    }

    #[test]
    fn repo_report_include_files_returns_rows() {
        let (_cfg, root, ctx) = fixture();
        std::fs::write(root.path().join("a.md"), "# a\n").unwrap();

        let v = execute(
            "repo_report",
            &serde_json::json!({"include_files": true}),
            &ctx,
        )
        .unwrap();
        let files = v["files"].as_array().expect("files present");
        assert!(files.iter().any(|f| f["path"] == "a.md"));
    }

    #[test]
    fn repo_report_prefix_scopes_subdir() {
        let (_cfg, root, ctx) = fixture();
        std::fs::create_dir_all(root.path().join("src")).unwrap();
        std::fs::write(root.path().join("src/lib.rs"), "fn x() {}\n").unwrap();
        std::fs::write(root.path().join("README.md"), "# r\n").unwrap();

        let v = execute(
            "repo_report",
            &serde_json::json!({"prefix": "src", "include_files": true}),
            &ctx,
        )
        .unwrap();
        let files = v["files"].as_array().unwrap();
        assert!(files
            .iter()
            .all(|f| f["path"].as_str().unwrap().starts_with("src/")));
    }

    #[test]
    fn repo_report_paths_wins_over_prefix() {
        let (_cfg, root, ctx) = fixture();
        std::fs::write(root.path().join("a.md"), "# a\n").unwrap();
        std::fs::write(root.path().join("b.md"), "# b\n").unwrap();
        std::fs::create_dir_all(root.path().join("docs")).unwrap();
        std::fs::write(root.path().join("docs/x.md"), "# x\n").unwrap();

        let v = execute(
            "repo_report",
            &serde_json::json!({
                "prefix": "docs",
                "paths": ["a.md"],
                "include_files": true,
            }),
            &ctx,
        )
        .unwrap();
        let files = v["files"].as_array().unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0]["path"], "a.md");
    }

    #[test]
    fn repo_report_appears_in_standard_schemas() {
        let schemas = standard_tool_schemas();
        assert!(schemas.iter().any(|s| s.name == "repo_report"));
        assert!(schemas.iter().any(|s| s.name == "resolve_path"));
        assert!(schemas.iter().any(|s| s.name == "workspace_search"));
        assert!(!schemas.iter().any(|s| s.name == "search_content"));
        assert!(!schemas.iter().any(|s| s.name.starts_with("graph_")));
    }

    #[test]
    fn write_file_rejects_non_text_via_chan_workspace() {
        let (_cfg, _root, ctx) = fixture();
        let err = execute(
            "write_file",
            &serde_json::json!({"path": "img.png", "content": "x"}),
            &ctx,
        )
        .unwrap_err();
        // chan-workspace's editable-text gate fires; the assistant cannot
        // bypass it through the tool sandbox. Typed PathRefused so
        // hosts can render a specific "wrong extension" message.
        assert!(matches!(err, LlmError::PathRefused(_)));
    }
}
