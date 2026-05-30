//! MCP server: stdio transport that exposes the chan-llm tool sandbox
//! as a Model Context Protocol service.
//!
//! Two consumers use this:
//!
//!   - The `chan-llm-mcp` binary, which any MCP client (Claude
//!     Desktop, Claude Code, Cursor, Continue, ...) can spawn against
//!     a chan workspace to gain chan-workspace-sandboxed file access.
//!   - The `chan __mcp` subcommand and chan-server MCP bridge, which
//!     host the same tool service for external agents without
//!     reopening the workspace.
//!
//! Tools exposed: `read_file`, `write_file`, `list_files`,
//! `resolve_path`, `search_content`, graph/report tools, and
//! `read_media`. The JSON tools route through `tools::execute`;
//! `read_media` is the binary media read path: it pulls bytes
//! through `Workspace::read` (path sandbox, regular-file gate, lstat)
//! and returns base64-encoded MCP image content or PDF blob
//! resources, capped at `max_media_bytes` (default 10 MiB,
//! configurable by the server builder or `--max-media-bytes`).

use std::io::Cursor;
use std::sync::Arc;

use base64::engine::Engine as _;
use chan_workspace::Workspace;
use rmcp::{
    handler::server::wrapper::Parameters,
    model::{Content, ErrorData, ResourceContents},
    schemars, tool, tool_handler, tool_router,
    transport::stdio,
    ServerHandler, ServiceExt,
};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::error::LlmError;
use crate::team_work::{canonical_agent_handle, TeamWorkIdentity};
use crate::tools::{self, ToolContext};

const MCP_FRAME_HEADER_LIMIT: usize = 8192;
const MCP_FRAME_BODY_LIMIT: usize = 16 * 1024 * 1024;

/// Default hard cap on a single `read_media` response, in bytes.
/// 10 MiB covers common image and PDF attachment reads with margin
/// for base64's ~33% inflation; oversized media surfaces as an
/// `invalid_params` error so the model can recover instead of
/// bloating a single tool turn. Overridable via
/// `Server::with_max_media_bytes` or `--max-media-bytes` on the
/// standalone binary.
pub const DEFAULT_MCP_MEDIA_MAX_BYTES: u64 = 10 * 1024 * 1024;

/// Extension -> MIME table for `read_media` image responses. This
/// mirrors chan-workspace's `FileClass::Image` set; BMP remains outside
/// the media class and is refused by classification.
const IMAGE_EXTENSIONS: &[(&str, &str)] = &[
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("webp", "image/webp"),
    ("gif", "image/gif"),
    ("svg", "image/svg+xml"),
    ("avif", "image/avif"),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MediaKind {
    Image(&'static str),
    Pdf,
}

/// Returns the image MIME type for `rel` when its extension is in
/// chan-workspace's Image class. The comparison lowercases;
/// `image.PNG` and `image.png` both match. Does not touch the
/// filesystem.
pub fn supported_image_mime(rel: &str) -> Option<&'static str> {
    let dot = rel.rfind('.')?;
    let ext = &rel[dot + 1..];
    if ext.is_empty() {
        return None;
    }
    let lower = ext.to_ascii_lowercase();
    IMAGE_EXTENSIONS
        .iter()
        .find_map(|(e, m)| if *e == lower { Some(*m) } else { None })
}

fn media_kind_for_path(rel: &str) -> Option<MediaKind> {
    match chan_workspace::fs_ops::classify(rel) {
        chan_workspace::FileClass::Image => supported_image_mime(rel).map(MediaKind::Image),
        chan_workspace::FileClass::Pdf => Some(MediaKind::Pdf),
        _ => None,
    }
}

// Note: we deliberately do NOT bring `crate::error::Result` into scope.
// The `#[tool_handler]` macro expands to code that uses bare `Result`,
// which would otherwise resolve to chan-llm's `Result<T, LlmError>`
// instead of `std::result::Result<T, ErrorData>` and break the trait
// bound. Use fully qualified `crate::error::Result` where needed.

/// MCP server handle. Owns a `ToolContext` (workspace handle); each
/// tool dispatch routes through `tools::execute`, so chan-workspace's
/// path sandbox, special-file refusal, and editable-text gate apply
/// to MCP-driven calls.
///
/// Cloning is cheap: `ToolContext` is just an `Arc<Workspace>`. The
/// rmcp tool macros expand into code that requires `Clone` on the
/// host type.
#[derive(Clone)]
pub struct Server {
    ctx: ToolContext,
    /// Hard cap on a single `read_media` response, in bytes. Set via
    /// `with_max_media_bytes`; defaults to
    /// `DEFAULT_MCP_MEDIA_MAX_BYTES`. Lives on the server (not the
    /// `ToolContext`) because it's an MCP-surface policy, not a
    /// chan-workspace invariant: the same `Workspace` can host a server with
    /// a different cap.
    max_media_bytes: u64,
    agent_inbox_provider: Option<Arc<dyn AgentInboxProvider>>,
    team_work_identity: TeamWorkIdentity,
}

impl Server {
    pub fn new(workspace: Arc<Workspace>) -> Self {
        Self {
            ctx: ToolContext::new(workspace),
            max_media_bytes: DEFAULT_MCP_MEDIA_MAX_BYTES,
            agent_inbox_provider: None,
            team_work_identity: TeamWorkIdentity::default(),
        }
    }

    /// Override the per-response `read_media` byte cap. Mirrors the
    /// caller that doesn't care about the cap keeps the default;
    /// chan-server and the standalone binary can set it from their
    /// own configuration surfaces.
    pub fn with_max_media_bytes(mut self, n: u64) -> Self {
        self.max_media_bytes = n;
        self
    }

    pub fn with_agent_inbox_provider<P>(mut self, provider: Arc<P>) -> Self
    where
        P: AgentInboxProvider + 'static,
    {
        self.agent_inbox_provider = Some(provider);
        self
    }

    pub fn with_agent_inbox_provider_dyn(mut self, provider: Arc<dyn AgentInboxProvider>) -> Self {
        self.agent_inbox_provider = Some(provider);
        self
    }

    pub fn with_team_work_identity(mut self, identity: TeamWorkIdentity) -> Self {
        self.team_work_identity = identity;
        self
    }

    /// Run the server on stdio. JSON-RPC frames in on stdin, out on
    /// stdout; rmcp's internal tracing goes to stderr. Blocks until
    /// the client disconnects.
    pub async fn serve_stdio(self) -> crate::error::Result<()> {
        let (reader, writer) = stdio();
        self.serve_io(reader, writer).await
    }

    /// Run the server over an arbitrary async read/write pair. Used
    /// by chan-server to host the MCP service over a Unix-domain
    /// socket so each agent session can connect without trying to
    /// reopen the workspace (which would deadlock against the parent
    /// process's per-workspace flock). Blocks until the client closes
    /// its end of the transport.
    pub async fn serve_io<R, W>(self, reader: R, writer: W) -> crate::error::Result<()>
    where
        R: tokio::io::AsyncRead + Send + Unpin + 'static,
        W: tokio::io::AsyncWrite + Send + Unpin + 'static,
    {
        let (reader, writer, framed_tasks) = adapt_mcp_transport(reader, writer).await?;
        let svc = self
            .serve((reader, writer))
            .await
            .map_err(|e| LlmError::Mcp(format!("serve: {e}")))?;
        svc.waiting()
            .await
            .map_err(|e| LlmError::Mcp(format!("waiting: {e}")))?;
        drop(framed_tasks);
        Ok(())
    }
}

#[async_trait::async_trait]
pub trait AgentInboxProvider: Send + Sync {
    async fn send_agent_task(
        &self,
        identity: TeamWorkIdentity,
        to: String,
        context_path: String,
    ) -> std::result::Result<SendAgentTaskResult, AgentInboxProviderError>;

    async fn list_agent_tasks(
        &self,
        identity: TeamWorkIdentity,
        since_id: Option<u64>,
    ) -> std::result::Result<ListAgentTasksResult, AgentInboxProviderError>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SendAgentTaskResult {
    pub id: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AgentTask {
    pub id: u64,
    pub from: String,
    pub to: String,
    pub context_path: String,
    pub created_at_unix_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ListAgentTasksResult {
    pub team: String,
    pub agent: String,
    pub oldest_retained_id: Option<u64>,
    pub latest_id: Option<u64>,
    pub tasks: Vec<AgentTask>,
}

#[derive(Debug, thiserror::Error)]
pub enum AgentInboxProviderError {
    #[error("{0}")]
    InvalidParams(String),
    #[error("{0}")]
    Internal(String),
}

struct FramedTasks {
    inbound: tokio::task::JoinHandle<()>,
    outbound: tokio::task::JoinHandle<()>,
}

impl Drop for FramedTasks {
    fn drop(&mut self) {
        self.inbound.abort();
        self.outbound.abort();
    }
}

async fn adapt_mcp_transport<R, W>(
    mut reader: R,
    writer: W,
) -> crate::error::Result<(
    Box<dyn AsyncRead + Send + Unpin>,
    Box<dyn AsyncWrite + Send + Unpin>,
    Option<FramedTasks>,
)>
where
    R: AsyncRead + Send + Unpin + 'static,
    W: AsyncWrite + Send + Unpin + 'static,
{
    let mut first = [0u8; 1];
    let n = reader
        .read(&mut first)
        .await
        .map_err(|e| LlmError::Mcp(format!("read transport prelude: {e}")))?;
    if n == 0 {
        return Ok((Box::new(Cursor::new(Vec::new())), Box::new(writer), None));
    }
    let first = first[0];
    let prefixed = Cursor::new(vec![first]).chain(reader);
    if first != b'C' && first != b'c' {
        return Ok((Box::new(prefixed), Box::new(writer), None));
    }

    let (rmcp_in_reader, rmcp_in_writer) = tokio::io::duplex(64 * 1024);
    let (rmcp_out_reader, rmcp_out_writer) = tokio::io::duplex(64 * 1024);
    let inbound = tokio::spawn(async move {
        let _ = content_length_to_lines(prefixed, rmcp_in_writer).await;
    });
    let outbound = tokio::spawn(async move {
        let _ = lines_to_content_length(rmcp_out_reader, writer).await;
    });
    Ok((
        Box::new(rmcp_in_reader),
        Box::new(rmcp_out_writer),
        Some(FramedTasks { inbound, outbound }),
    ))
}

async fn content_length_to_lines<R, W>(mut reader: R, mut writer: W) -> std::io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    loop {
        let header = match read_frame_header(&mut reader).await? {
            Some(header) => header,
            None => return Ok(()),
        };
        let len = parse_content_length(&header)?;
        if len > MCP_FRAME_BODY_LIMIT {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "mcp frame body too large",
            ));
        }
        let mut body = vec![0u8; len];
        reader.read_exact(&mut body).await?;
        writer.write_all(&body).await?;
        writer.write_all(b"\n").await?;
        writer.flush().await?;
    }
}

async fn lines_to_content_length<R, W>(mut reader: R, mut writer: W) -> std::io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut line = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        line.clear();
        loop {
            let n = reader.read(&mut byte).await?;
            if n == 0 {
                return Ok(());
            }
            if byte[0] == b'\n' {
                break;
            }
            line.push(byte[0]);
            if line.len() > MCP_FRAME_BODY_LIMIT {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "mcp line body too large",
                ));
            }
        }
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        let header = format!("Content-Length: {}\r\n\r\n", line.len());
        writer.write_all(header.as_bytes()).await?;
        writer.write_all(&line).await?;
        writer.flush().await?;
    }
}

async fn read_frame_header<R>(reader: &mut R) -> std::io::Result<Option<Vec<u8>>>
where
    R: AsyncRead + Unpin,
{
    let mut header = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        let n = reader.read(&mut byte).await?;
        if n == 0 {
            if header.is_empty() {
                return Ok(None);
            }
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "partial mcp frame header",
            ));
        }
        header.push(byte[0]);
        if header.len() > MCP_FRAME_HEADER_LIMIT {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "mcp frame header too large",
            ));
        }
        if header.ends_with(b"\r\n\r\n") || header.ends_with(b"\n\n") {
            return Ok(Some(header));
        }
    }
}

fn parse_content_length(header: &[u8]) -> std::io::Result<usize> {
    let header = std::str::from_utf8(header)
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "non-utf8 header"))?;
    for line in header.lines() {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.eq_ignore_ascii_case("content-length") {
            return value.trim().parse::<usize>().map_err(|_| {
                std::io::Error::new(std::io::ErrorKind::InvalidData, "bad content length")
            });
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        "missing content length",
    ))
}

// ---- tool param schemas -----------------------------------------------
//
// Descriptions on the params types are surfaced to the MCP client
// as JSON-schema field descriptions; the tool-level descriptions
// below explain the action itself. We keep both terse; claude
// already gets richer guidance from `prompts::SYSTEM_PROMPT`.

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ReadFileParams {
    /// POSIX-style path in chan's public namespace.
    pub path: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct WriteFileParams {
    /// POSIX-style path in chan's public namespace. Must be
    /// editable UTF-8 text according to chan-workspace.
    pub path: String,
    /// Full new file content. Partial diffs are not supported.
    pub content: String,
    /// Optional optimistic-concurrency token. When set, the write
    /// only succeeds if the file's current mtime (in nanoseconds)
    /// equals this value. Use the `mtime_ns` from your prior
    /// `read_file` response. On mismatch the call returns an
    /// error and the caller should re-read.
    #[serde(default)]
    pub expected_mtime_ns: Option<i64>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SearchContentParams {
    pub query: String,
    /// Hard cap on hits returned. Default 20.
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ListFilesParams {
    /// Optional POSIX rel-path prefix to scope the listing to a
    /// subdirectory. Empty / omitted lists the whole workspace (capped).
    /// `Drafts/...` points at uncommitted metadata-backed draft workspaces.
    #[serde(default)]
    pub prefix: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ResolvePathParams {
    /// POSIX-style path in chan's public namespace, including
    /// `Drafts/...` when resolving a draft metadata location.
    pub path: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct EmptyParams {}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ReadMediaParams {
    /// POSIX-style path in chan's public namespace. Must be an image
    /// or PDF class path according to chan-workspace.
    pub path: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SendAgentTaskParams {
    /// Canonical Team Work agent handle, for example @@FullStackA.
    pub to: String,
    /// POSIX-style path to an existing readable workspace text file.
    pub context_path: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ListAgentTasksParams {
    /// Optional numeric cursor. Returns retained tasks with id greater than this value.
    #[serde(default)]
    pub since_id: Option<u64>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GraphNeighborsParams {
    /// POSIX-style relative path of the file whose graph adjacency
    /// you want.
    pub path: String,
    /// `out` (this file's outbound edges), `in` (backlinks), or
    /// `both`. Defaults to `both` when omitted.
    #[serde(default)]
    pub direction: Option<String>,
    /// Subset of `link` / `tag` / `mention` to include. Omit for
    /// every kind.
    #[serde(default)]
    pub kinds: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GraphFilesWithTagParams {
    /// Tag name including the leading `#`, e.g. `#design`.
    pub tag: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct RepoReportParams {
    /// Optional POSIX rel-path prefix to scope the snapshot to a
    /// subdirectory.
    #[serde(default)]
    pub prefix: Option<String>,
    /// Optional explicit list of POSIX rel-paths. When non-empty,
    /// takes precedence over `prefix`.
    #[serde(default)]
    pub paths: Option<Vec<String>>,
    /// Include per-file rows in the response (capped at 200).
    /// Default false: only totals, per-language roll-ups, and the
    /// COCOMO summary are returned.
    #[serde(default)]
    pub include_files: Option<bool>,
}

// ---- tool dispatch ----------------------------------------------------

// Tool descriptions duplicate `crate::prompts::*_DESC` as string
// literals here because rmcp-macros 1.6's `#[tool(description =
// ...)]` only parses string literals (darling's FromMeta<String>
// rejects const paths). The `mcp_descriptions_match_prompts` test
// below pins the two copies together so a drift breaks the build.
#[tool_router]
impl Server {
    #[tool(description = "\
Read the UTF-8 content of a file in the active workspace. The path is \
POSIX-style in chan's public namespace, including `Drafts/...` \
when needed. Returns { path, content, size, mtime_ns }. Files \
larger than 256 KiB are truncated and the response includes \
`truncated: true` plus a `note` describing the cap; in that case \
re-issue with a smaller scope (or open the file in the editor if \
you need the full thing). Pass `mtime_ns` back on `write_file` as \
`expected_mtime_ns` to detect concurrent edits.")]
    async fn read_file(
        &self,
        Parameters(p): Parameters<ReadFileParams>,
    ) -> std::result::Result<String, ErrorData> {
        run_tool(
            "read_file",
            serde_json::json!({"path": p.path}),
            self.ctx.clone(),
        )
        .await
    }

    #[tool(description = "\
Replace the content of a file in the active workspace (creates the \
parent directory if needed). The path is POSIX-style in chan's \
public namespace, including `Drafts/...` when needed, and must be \
classified by chan-workspace as editable UTF-8 text (.md, .txt, source \
and config text such as .rs or .json, or known text basenames like \
Makefile). New files are capped at 2 MiB; existing files can be \
edited up to their current size. Pass `expected_mtime_ns` (from \
your earlier read_file response) to make the write a \
compare-and-swap; on conflict the call errors and you can re-read \
before retrying. Writes apply immediately. When a request touches \
multiple files or feels destructive, call AskUserQuestion first \
with a numbered plan and wait for the user's answer before any \
write_file call.")]
    async fn write_file(
        &self,
        Parameters(p): Parameters<WriteFileParams>,
    ) -> std::result::Result<String, ErrorData> {
        let mut args = serde_json::json!({"path": p.path, "content": p.content});
        if let Some(mtime_ns) = p.expected_mtime_ns {
            args["expected_mtime_ns"] = serde_json::json!(mtime_ns);
        }
        run_tool("write_file", args, self.ctx.clone()).await
    }

    #[tool(description = "\
List files in the active workspace as { entries, count, total }. \
Pass an optional `prefix` (POSIX rel-path) to scope the listing to \
a subdirectory; omit it to list the whole workspace. Includes the \
metadata-backed `Drafts/...` namespace for uncommitted draft \
workspaces. Listings are capped at 2,000 entries; if `truncated` \
is true, narrow with a prefix or call search_content instead.")]
    async fn list_files(
        &self,
        Parameters(p): Parameters<ListFilesParams>,
    ) -> std::result::Result<String, ErrorData> {
        let mut args = serde_json::json!({});
        if let Some(prefix) = p.prefix {
            args["prefix"] = serde_json::Value::String(prefix);
        }
        run_tool("list_files", args, self.ctx.clone()).await
    }

    #[tool(description = "\
Resolve a chan public path to a host filesystem path. Use this only \
when you need a real path for shell tools or terminal cwd. Normal \
content operations should keep using read_file, write_file, and \
list_files with chan paths. The path argument is POSIX-style in \
chan's public namespace, including `Drafts/...`; Drafts paths \
resolve to uncommitted chan metadata outside the workspace root.")]
    async fn resolve_path(
        &self,
        Parameters(p): Parameters<ResolvePathParams>,
    ) -> std::result::Result<String, ErrorData> {
        run_tool(
            "resolve_path",
            serde_json::json!({"path": p.path}),
            self.ctx.clone(),
        )
        .await
    }

    #[tool(description = "\
Search the workspace's BM25 index for the given query. Returns hits \
with relative paths, relevance scores, and short snippets around \
the match. Useful for finding which file mentions a topic before \
issuing read_file on it. `limit` defaults to 20 and is hard-capped \
at 100.")]
    async fn search_content(
        &self,
        Parameters(p): Parameters<SearchContentParams>,
    ) -> std::result::Result<String, ErrorData> {
        let mut args = serde_json::json!({"query": p.query});
        if let Some(limit) = p.limit {
            args["limit"] = serde_json::json!(limit);
        }
        run_tool("search_content", args, self.ctx.clone()).await
    }

    #[tool(description = "\
Read a media file from the active workspace and return it as MCP media \
content. The path is POSIX-style in chan's public namespace and \
must be classified by chan-workspace as Image (.png, .jpg, .jpeg, \
.gif, .webp, .svg, .avif) or Pdf (.pdf); other extensions are \
refused (text files use read_file). Image responses are MCP image \
content blocks. PDF responses are MCP blob resources with \
application/pdf MIME type. Single-call cap defaults to 10 MiB; \
oversized files error with `media too large` so you can pick a \
smaller file (the host may have widened or narrowed this cap via \
config).")]
    async fn read_media(
        &self,
        Parameters(p): Parameters<ReadMediaParams>,
    ) -> std::result::Result<Content, ErrorData> {
        read_media_content(self.ctx.clone(), p.path, self.max_media_bytes).await
    }

    #[tool(description = "\
Store a Team Work Agent task for one recipient. Requires a hosted \
Team Work MCP identity. `to` must be a canonical `@@Name` handle and \
`context_path` must point at an existing readable workspace text file. \
The sender is the connected agent identity; callers do not pass \
`from`. Returns only { id }.")]
    async fn send_agent_task(
        &self,
        Parameters(p): Parameters<SendAgentTaskParams>,
    ) -> std::result::Result<String, ErrorData> {
        let (provider, identity) = self.require_agent_inbox()?;
        let to = canonical_agent_handle(&p.to)
            .map_err(|e| ErrorData::invalid_params(format!("invalid to: {e}"), None))?;
        if p.context_path.is_empty() {
            return Err(ErrorData::invalid_params(
                "invalid context_path: must be non-empty".to_string(),
                None,
            ));
        }
        let result = provider
            .send_agent_task(identity, to, p.context_path)
            .await
            .map_err(inbox_provider_error)?;
        serde_json::to_string(&result)
            .map_err(|e| ErrorData::internal_error(format!("serialize result: {e}"), None))
    }

    #[tool(description = "\
List retained Team Work Agent tasks for the connected agent identity. \
No recipient parameter is accepted. With `since_id`, returns retained \
tasks whose id is greater than the cursor; without it, returns the \
current retained inbox plus oldest/latest retained id metadata.")]
    async fn list_agent_tasks(
        &self,
        Parameters(p): Parameters<ListAgentTasksParams>,
    ) -> std::result::Result<String, ErrorData> {
        let (provider, identity) = self.require_agent_inbox()?;
        let result = provider
            .list_agent_tasks(identity, p.since_id)
            .await
            .map_err(inbox_provider_error)?;
        serde_json::to_string(&result)
            .map_err(|e| ErrorData::internal_error(format!("serialize result: {e}"), None))
    }

    #[tool(description = "\
Read the workspace's link graph for a single file. Returns `out` (this \
file's outbound edges: wiki/markdown `[[links]]`, `#tags`, and \
`@@mentions`) and `in` (backlinks: every other file that points at \
this one). Use it for backlink-aware questions ('what links here?'), \
to discover a tag's neighbourhood without reading every file, or to \
plan an edit that should also touch the files that reference this \
one. Optional `direction` (`out` / `in` / `both`, default `both`) \
and `kinds` (subset of `link`/`tag`/`mention`) narrow the response.")]
    async fn graph_neighbors(
        &self,
        Parameters(p): Parameters<GraphNeighborsParams>,
    ) -> std::result::Result<String, ErrorData> {
        let mut args = serde_json::json!({"path": p.path});
        if let Some(dir) = p.direction {
            args["direction"] = serde_json::Value::String(dir);
        }
        if let Some(kinds) = p.kinds {
            args["kinds"] = serde_json::json!(kinds);
        }
        run_tool("graph_neighbors", args, self.ctx.clone()).await
    }

    #[tool(description = "\
List every `#tag` known to the workspace's graph index with the number \
of files that carry it. No arguments. Use it when the user asks \
about tag usage, before a rename / merge, or to discover the actual \
taxonomy instead of guessing. Pair with `graph_files_with_tag` to \
expand a tag into its file list.")]
    async fn graph_tags(
        &self,
        Parameters(_): Parameters<EmptyParams>,
    ) -> std::result::Result<String, ErrorData> {
        run_tool("graph_tags", serde_json::json!({}), self.ctx.clone()).await
    }

    #[tool(description = "\
Return every file that carries the given `#tag`. The argument \
includes the leading `#`. Cheap: the graph index keeps this \
membership as a direct lookup, so it's preferable to scanning every \
file with search_content when the user has a specific tag in mind.")]
    async fn graph_files_with_tag(
        &self,
        Parameters(p): Parameters<GraphFilesWithTagParams>,
    ) -> std::result::Result<String, ErrorData> {
        run_tool(
            "graph_files_with_tag",
            serde_json::json!({"tag": p.tag}),
            self.ctx.clone(),
        )
        .await
    }

    #[tool(description = "\
Snapshot the workspace's code/content report: per-file language, code \
lines, comments, blanks, a complexity heuristic (keyword count, \
not cyclomatic), plus per-language roll-ups and a Basic COCOMO \
cost estimate. The workspace maintains this index incrementally as \
files change, so the call is cheap to repeat. Use it when the user \
asks about repo size, language mix, where the code lives, or to \
scope a refactor. Optional args: `prefix` (POSIX rel-path) to \
limit the snapshot to a subdirectory, or `paths` (array) for an \
explicit file list. When both are present, `paths` wins. \
`include_files` (default false) controls whether the per-file rows \
are returned; leave it off for an overview, set true when you \
need to drill in. The per-file array is capped at 200 entries; if \
`truncated` is true, scope further with `prefix` or `paths`.")]
    async fn repo_report(
        &self,
        Parameters(p): Parameters<RepoReportParams>,
    ) -> std::result::Result<String, ErrorData> {
        let mut args = serde_json::json!({});
        if let Some(prefix) = p.prefix {
            args["prefix"] = serde_json::Value::String(prefix);
        }
        if let Some(paths) = p.paths {
            args["paths"] = serde_json::json!(paths);
        }
        if let Some(b) = p.include_files {
            args["include_files"] = serde_json::Value::Bool(b);
        }
        run_tool("repo_report", args, self.ctx.clone()).await
    }
}

impl Server {
    fn require_agent_inbox(
        &self,
    ) -> std::result::Result<(Arc<dyn AgentInboxProvider>, TeamWorkIdentity), ErrorData> {
        let provider = self.agent_inbox_provider.clone().ok_or_else(|| {
            ErrorData::internal_error("agent inbox unavailable".to_string(), None)
        })?;
        let Some(team) = self.team_work_identity.team.clone() else {
            return Err(ErrorData::internal_error(
                "team identity unavailable".to_string(),
                None,
            ));
        };
        let Some(agent) = self.team_work_identity.agent.clone() else {
            return Err(ErrorData::internal_error(
                "agent identity unavailable".to_string(),
                None,
            ));
        };
        Ok((
            provider,
            TeamWorkIdentity {
                team: Some(team),
                agent: Some(agent),
            },
        ))
    }
}

fn inbox_provider_error(err: AgentInboxProviderError) -> ErrorData {
    match err {
        AgentInboxProviderError::InvalidParams(message) => ErrorData::invalid_params(message, None),
        AgentInboxProviderError::Internal(message) => ErrorData::internal_error(message, None),
    }
}

#[tool_handler(
    name = "chan",
    instructions = "Tools for reading, writing, listing, searching, and resolving paths in a chan markdown workspace. Content operations are sandboxed by chan-workspace; Drafts paths are uncommitted workspaces that may resolve to chan metadata outside the workspace root."
)]
impl ServerHandler for Server {}

/// Adapter: dispatch into `tools::execute`, then translate the
/// result `Json` and any `LlmError` into MCP-shaped responses.
///
/// Error messages are run through `mcp_safe_message` so chan-workspace's
/// Display strings (which may carry host absolute paths via
/// `SpecialFile.path` / `SymlinkEscape`) don't leak across the
/// MCP boundary. The MCP client may be a third-party process; we
/// surface the variant kind and the model-actionable bits, no host
/// filesystem layout.
async fn run_tool(
    name: &'static str,
    args: serde_json::Value,
    ctx: ToolContext,
) -> std::result::Result<String, ErrorData> {
    let result = tokio::task::spawn_blocking(move || tools::execute(name, &args, &ctx))
        .await
        .map_err(|e| ErrorData::internal_error(format!("tool task failed: {e}"), None))?;
    match result {
        Ok(v) => serde_json::to_string(&v)
            .map_err(|e| ErrorData::internal_error(format!("serialize result: {e}"), None)),
        Err(e) => Err(ErrorData::internal_error(mcp_safe_message(&e), None)),
    }
}

async fn read_media_content(
    ctx: ToolContext,
    path: String,
    max_media_bytes: u64,
) -> std::result::Result<Content, ErrorData> {
    tokio::task::spawn_blocking(move || read_media_content_sync(&ctx, path, max_media_bytes))
        .await
        .map_err(|e| ErrorData::internal_error(format!("read_media task failed: {e}"), None))?
}

fn read_media_content_sync(
    ctx: &ToolContext,
    path: String,
    max_media_bytes: u64,
) -> std::result::Result<Content, ErrorData> {
    let kind = media_kind_for_path(&path).ok_or_else(|| {
        ErrorData::invalid_params(
            "path refused: unsupported media extension (expected png/jpg/jpeg/gif/webp/svg/avif/pdf)"
                .to_string(),
            None,
        )
    })?;
    let bytes = ctx
        .workspace
        .read(&path)
        .map_err(|e| ErrorData::internal_error(mcp_safe_message(&LlmError::from(e)), None))?;
    if (bytes.len() as u64) > max_media_bytes {
        return Err(ErrorData::invalid_params(
            format!(
                "media too large: {} bytes exceeds {} byte cap",
                bytes.len(),
                max_media_bytes
            ),
            None,
        ));
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    match kind {
        MediaKind::Image(mime) => Ok(Content::image(b64, mime)),
        MediaKind::Pdf => Ok(Content::resource(
            ResourceContents::blob(b64, media_resource_uri(&path))
                .with_mime_type("application/pdf"),
        )),
    }
}

fn media_resource_uri(path: &str) -> String {
    format!("chan://media/{}", percent_encode_path(path))
}

fn percent_encode_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for byte in path.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => {
                out.push(byte as char)
            }
            _ => {
                const HEX: &[u8; 16] = b"0123456789ABCDEF";
                out.push('%');
                out.push(HEX[(byte >> 4) as usize] as char);
                out.push(HEX[(byte & 0x0f) as usize] as char);
            }
        }
    }
    out
}

/// Build an MCP-safe error message for `err`. Strips host paths and
/// chan-workspace Display details that aren't relevant to the model
/// while preserving the kind and any model-actionable numbers
/// (sizes, mtimes, limits).
fn mcp_safe_message(err: &LlmError) -> String {
    match err {
        LlmError::WriteConflict { current_mtime_ns } => {
            format!("write conflict: file changed on disk (current mtime ns: {current_mtime_ns:?})")
        }
        LlmError::WriteTooLarge { kind, size, limit } => {
            format!("write too large: {size} bytes exceeds {limit} byte cap for {kind}")
        }
        LlmError::ListingTooLarge { observed, limit } => {
            format!("listing too large: {observed} entries (cap {limit})")
        }
        LlmError::PathRefused(_) => {
            // The chan-workspace Display may carry an absolute path
            // (SpecialFile.path, SymlinkEscape); flatten to the
            // category. The model knows which call it issued; the
            // category is enough to recover.
            "path refused: not editable, not a regular file, or escapes workspace root".to_string()
        }
        LlmError::Core(_) => {
            // chan-workspace errors that didn't get a typed passthrough
            // (WorkspaceLocked, WorkspaceAlreadyOpen, Trash*, Search, Graph,
            // Watch, ConfigDecode, Io). Several include paths or
            // host-specific detail; surface the category only.
            "workspace operation failed".to_string()
        }
        LlmError::Io(_) => "i/o error".to_string(),
        LlmError::Tool(msg) => format!("tool error: {msg}"),
        LlmError::Mcp(_) => "mcp error".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::team_work::TeamWorkIdentity;
    use chan_workspace::Library;
    use std::sync::{Arc, Mutex};
    use tempfile::TempDir;

    #[derive(Default)]
    struct TestInboxProvider {
        sends: Mutex<Vec<(TeamWorkIdentity, String, String)>>,
    }

    #[async_trait::async_trait]
    impl AgentInboxProvider for TestInboxProvider {
        async fn send_agent_task(
            &self,
            identity: TeamWorkIdentity,
            to: String,
            context_path: String,
        ) -> Result<SendAgentTaskResult, AgentInboxProviderError> {
            self.sends
                .lock()
                .unwrap()
                .push((identity, to, context_path));
            Ok(SendAgentTaskResult { id: 7 })
        }

        async fn list_agent_tasks(
            &self,
            identity: TeamWorkIdentity,
            since_id: Option<u64>,
        ) -> Result<ListAgentTasksResult, AgentInboxProviderError> {
            Ok(ListAgentTasksResult {
                team: identity.team.unwrap(),
                agent: identity.agent.unwrap(),
                oldest_retained_id: Some(4),
                latest_id: Some(9),
                tasks: vec![AgentTask {
                    id: since_id.unwrap_or(0) + 1,
                    from: "@@Architect".into(),
                    to: "@@FullStackA".into(),
                    context_path: "tasks/one.md".into(),
                    created_at_unix_ms: 123,
                }],
            })
        }
    }

    /// Pin the inlined `#[tool(description = ...)]` literals to the
    /// canonical `prompts::*_DESC` constants. rmcp-macros 1.6 won't
    /// accept const paths in the attribute (darling parses
    /// description as Lit::Str), so the strings are duplicated; this
    /// test breaks the build if the two copies drift.
    #[test]
    fn mcp_descriptions_match_prompts() {
        let read = Server::read_file_tool_attr();
        assert_eq!(
            read.description.as_deref(),
            Some(crate::prompts::READ_FILE_DESC)
        );
        let write = Server::write_file_tool_attr();
        assert_eq!(
            write.description.as_deref(),
            Some(crate::prompts::WRITE_FILE_DESC)
        );
        let list = Server::list_files_tool_attr();
        assert_eq!(
            list.description.as_deref(),
            Some(crate::prompts::LIST_FILES_DESC)
        );
        let resolve = Server::resolve_path_tool_attr();
        assert_eq!(
            resolve.description.as_deref(),
            Some(crate::prompts::RESOLVE_PATH_DESC)
        );
        let search = Server::search_content_tool_attr();
        assert_eq!(
            search.description.as_deref(),
            Some(crate::prompts::SEARCH_CONTENT_DESC)
        );
        let image = Server::read_media_tool_attr();
        assert_eq!(
            image.description.as_deref(),
            Some(crate::prompts::READ_MEDIA_DESC)
        );
        let neighbors = Server::graph_neighbors_tool_attr();
        assert_eq!(
            neighbors.description.as_deref(),
            Some(crate::prompts::GRAPH_NEIGHBORS_DESC)
        );
        let tags = Server::graph_tags_tool_attr();
        assert_eq!(
            tags.description.as_deref(),
            Some(crate::prompts::GRAPH_TAGS_DESC)
        );
        let files_with_tag = Server::graph_files_with_tag_tool_attr();
        assert_eq!(
            files_with_tag.description.as_deref(),
            Some(crate::prompts::GRAPH_FILES_WITH_TAG_DESC)
        );
        let report = Server::repo_report_tool_attr();
        assert_eq!(
            report.description.as_deref(),
            Some(crate::prompts::REPO_REPORT_DESC)
        );
    }

    fn fixture() -> (TempDir, TempDir, Server) {
        let cfg = TempDir::new().unwrap();
        let workspace_dir = TempDir::new().unwrap();
        let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(workspace_dir.path()).unwrap();
        let workspace = lib.open_workspace(workspace_dir.path()).unwrap();
        let server = Server::new(workspace);
        (cfg, workspace_dir, server)
    }

    fn test_provider() -> Arc<TestInboxProvider> {
        Arc::new(TestInboxProvider::default())
    }

    #[tokio::test]
    async fn inbox_tool_checks_provider_before_identity() {
        let (_cfg, _root, server) = fixture();

        let err = server
            .send_agent_task(Parameters(SendAgentTaskParams {
                to: "@@FullStackA".into(),
                context_path: "tasks/one.md".into(),
            }))
            .await
            .unwrap_err();

        assert_eq!(err.message, "agent inbox unavailable");
    }

    #[tokio::test]
    async fn inbox_tool_checks_team_before_agent_identity() {
        let (_cfg, _root, server) = fixture();
        let provider = test_provider();
        let server = server.with_agent_inbox_provider(provider.clone());

        let err = server
            .list_agent_tasks(Parameters(ListAgentTasksParams { since_id: None }))
            .await
            .unwrap_err();
        assert_eq!(err.message, "team identity unavailable");

        let server =
            server.with_team_work_identity(TeamWorkIdentity::new(Some("alpha".into()), None));
        let err = server
            .list_agent_tasks(Parameters(ListAgentTasksParams { since_id: None }))
            .await
            .unwrap_err();
        assert_eq!(err.message, "agent identity unavailable");
    }

    #[tokio::test]
    async fn send_agent_task_calls_provider_and_returns_only_id() {
        let (_cfg, _root, server) = fixture();
        let provider = test_provider();
        let server = server
            .with_agent_inbox_provider(provider.clone())
            .with_team_work_identity(TeamWorkIdentity::validated("alpha", "@@Architect").unwrap());

        let out = server
            .send_agent_task(Parameters(SendAgentTaskParams {
                to: "@@FullStackA".into(),
                context_path: "tasks/one.md".into(),
            }))
            .await
            .unwrap();

        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&out).unwrap(),
            serde_json::json!({"id": 7})
        );
        let sends = provider.sends.lock().unwrap();
        assert_eq!(sends.len(), 1);
        assert_eq!(sends[0].0.agent.as_deref(), Some("@@Architect"));
        assert_eq!(sends[0].1, "@@FullStackA");
        assert_eq!(sends[0].2, "tasks/one.md");
    }

    #[tokio::test]
    async fn list_agent_tasks_returns_provider_shape() {
        let (_cfg, _root, server) = fixture();
        let server = server
            .with_agent_inbox_provider(test_provider())
            .with_team_work_identity(TeamWorkIdentity::validated("alpha", "@@FullStackA").unwrap());

        let out = server
            .list_agent_tasks(Parameters(ListAgentTasksParams { since_id: Some(8) }))
            .await
            .unwrap();
        let value: serde_json::Value = serde_json::from_str(&out).unwrap();

        assert_eq!(value["team"], "alpha");
        assert_eq!(value["agent"], "@@FullStackA");
        assert_eq!(value["oldest_retained_id"], 4);
        assert_eq!(value["latest_id"], 9);
        assert_eq!(value["tasks"][0]["id"], 9);
        assert_eq!(value["tasks"][0]["context_path"], "tasks/one.md");
    }

    #[tokio::test]
    async fn send_agent_task_rejects_invalid_recipient_before_provider_call() {
        let (_cfg, _root, server) = fixture();
        let provider = test_provider();
        let server = server
            .with_agent_inbox_provider(provider.clone())
            .with_team_work_identity(TeamWorkIdentity::validated("alpha", "@@Architect").unwrap());

        let err = server
            .send_agent_task(Parameters(SendAgentTaskParams {
                to: "FullStackA".into(),
                context_path: "tasks/one.md".into(),
            }))
            .await
            .unwrap_err();

        assert!(err.message.contains("invalid to"), "msg={}", err.message);
        assert!(provider.sends.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn read_file_dispatches_to_workspace() {
        let (_cfg, root, server) = fixture();
        std::fs::write(root.path().join("a.md"), "hello").unwrap();
        let out = server
            .read_file(Parameters(ReadFileParams {
                path: "a.md".into(),
            }))
            .await
            .unwrap();
        // tools::execute returns {"path": ..., "content": ...} as JSON;
        // we serialize that to a string for the MCP response.
        assert!(out.contains("hello"), "got: {out}");
    }

    #[tokio::test]
    async fn write_file_applies_immediately() {
        let (_cfg, root, server) = fixture();
        let out = server
            .write_file(Parameters(WriteFileParams {
                path: "a.md".into(),
                content: "hi".into(),
                expected_mtime_ns: None,
            }))
            .await
            .unwrap();
        assert!(out.contains("a.md"), "got: {out}");
        assert_eq!(
            std::fs::read_to_string(root.path().join("a.md")).unwrap(),
            "hi"
        );
    }

    #[tokio::test]
    async fn read_write_file_accepts_source_config_and_makefile_text() {
        let (_cfg, root, server) = fixture();
        for (path, body) in [
            ("src/lib.rs", "pub fn answer() -> u8 { 42 }\n"),
            ("config.json", "{\"ok\":true}\n"),
            ("Makefile", "all:\n\t@true\n"),
        ] {
            if let Some(parent) = std::path::Path::new(path).parent() {
                std::fs::create_dir_all(root.path().join(parent)).unwrap();
            }
            server
                .write_file(Parameters(WriteFileParams {
                    path: path.into(),
                    content: body.into(),
                    expected_mtime_ns: None,
                }))
                .await
                .unwrap();
            let out = server
                .read_file(Parameters(ReadFileParams { path: path.into() }))
                .await
                .unwrap();
            let value: serde_json::Value = serde_json::from_str(&out).unwrap();
            assert_eq!(value["content"], body);
        }
    }

    #[tokio::test]
    async fn list_files_returns_tree() {
        let (_cfg, root, server) = fixture();
        std::fs::write(root.path().join("a.md"), "x").unwrap();
        let out = server
            .list_files(Parameters(ListFilesParams { prefix: None }))
            .await
            .unwrap();
        assert!(out.contains("a.md"), "got: {out}");
    }

    #[tokio::test]
    async fn resolve_path_maps_drafts_to_metadata_dir() {
        let (_cfg, _root, server) = fixture();
        server.ctx.workspace.create_draft_dir("untitled-1").unwrap();
        server
            .ctx
            .workspace
            .write_text("Drafts/untitled-1/draft.md", "# draft\n")
            .unwrap();

        let out = server
            .resolve_path(Parameters(ResolvePathParams {
                path: "Drafts/untitled-1".into(),
            }))
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(body["path"], "Drafts/untitled-1");
        assert_eq!(body["virtual"], true);
        assert_eq!(
            body["physical_path"].as_str().unwrap(),
            server
                .ctx
                .workspace
                .drafts_dir()
                .join("untitled-1")
                .to_string_lossy()
                .into_owned()
        );
    }

    #[tokio::test]
    async fn write_file_rejects_non_text_via_chan_workspace() {
        let (_cfg, _root, server) = fixture();
        let err = server
            .write_file(Parameters(WriteFileParams {
                path: "img.png".into(),
                content: "x".into(),
                expected_mtime_ns: None,
            }))
            .await
            .unwrap_err();
        // chan-workspace's editable-text gate fires; the MCP surface
        // returns the scrubbed kind ("path refused"), not the
        // chan-workspace Display string (which would echo "img.png" /
        // host paths). The model gets the category and recovers.
        assert!(
            err.message.to_lowercase().contains("path refused"),
            "msg={}",
            err.message
        );
    }

    #[tokio::test]
    async fn mcp_error_message_does_not_leak_host_paths() {
        // Trigger a path refusal that, prior to the scrub, would
        // echo "img.png" and any chan-workspace Display detail. After
        // the scrub the message is category-only.
        let (_cfg, _root, server) = fixture();
        let err = server
            .write_file(Parameters(WriteFileParams {
                path: "img.png".into(),
                content: "x".into(),
                expected_mtime_ns: None,
            }))
            .await
            .unwrap_err();
        assert!(
            !err.message.contains("img.png"),
            "leaked path: {}",
            err.message
        );
        assert!(
            !err.message.contains('/'),
            "looks like an absolute path: {}",
            err.message
        );
    }

    #[test]
    fn supported_image_mime_extension_table() {
        assert_eq!(supported_image_mime("a.png"), Some("image/png"));
        assert_eq!(supported_image_mime("a.PNG"), Some("image/png"));
        assert_eq!(supported_image_mime("a.jpg"), Some("image/jpeg"));
        assert_eq!(supported_image_mime("a.jpeg"), Some("image/jpeg"));
        assert_eq!(supported_image_mime("a.webp"), Some("image/webp"));
        assert_eq!(supported_image_mime("a.gif"), Some("image/gif"));
        assert_eq!(supported_image_mime("a.svg"), Some("image/svg+xml"));
        assert_eq!(supported_image_mime("a.avif"), Some("image/avif"));
        assert_eq!(supported_image_mime("a.md"), None);
        assert_eq!(supported_image_mime("a.bmp"), None);
        assert_eq!(supported_image_mime("a"), None);
        assert_eq!(supported_image_mime(""), None);
        assert_eq!(supported_image_mime("a."), None);
    }

    #[tokio::test]
    async fn read_media_returns_base64_image_content() {
        let (_cfg, root, server) = fixture();
        // Minimal valid PNG: the 8-byte signature is enough to
        // verify round-trip; we don't care that it's a parseable
        // image, only that read_media reads the bytes verbatim and
        // hands them to base64 with the right MIME.
        let bytes = b"\x89PNG\r\n\x1a\n";
        std::fs::write(root.path().join("a.png"), bytes).unwrap();
        let content = server
            .read_media(Parameters(ReadMediaParams {
                path: "a.png".into(),
            }))
            .await
            .unwrap();
        let img = content.as_image().expect("expected ImageContent");
        assert_eq!(img.mime_type, "image/png");
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&img.data)
            .unwrap();
        assert_eq!(decoded, bytes);
    }

    #[tokio::test]
    async fn read_media_returns_pdf_blob_resource() {
        let (_cfg, root, server) = fixture();
        let bytes = b"%PDF-1.7\n";
        std::fs::write(root.path().join("docs spec.pdf"), bytes).unwrap();
        let content = server
            .read_media(Parameters(ReadMediaParams {
                path: "docs spec.pdf".into(),
            }))
            .await
            .unwrap();
        let resource = content.as_resource().expect("expected resource content");
        let ResourceContents::BlobResourceContents {
            uri,
            mime_type,
            blob,
            ..
        } = &resource.resource
        else {
            panic!("expected blob resource");
        };
        assert_eq!(uri, "chan://media/docs%20spec.pdf");
        assert_eq!(mime_type.as_deref(), Some("application/pdf"));
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(blob)
            .unwrap();
        assert_eq!(decoded, bytes);
    }

    #[tokio::test]
    async fn read_media_accepts_svg_and_avif_image_class() {
        let (_cfg, root, server) = fixture();
        std::fs::write(root.path().join("icon.svg"), b"<svg/>").unwrap();
        std::fs::write(root.path().join("photo.avif"), b"avif").unwrap();

        let svg = server
            .read_media(Parameters(ReadMediaParams {
                path: "icon.svg".into(),
            }))
            .await
            .unwrap();
        let avif = server
            .read_media(Parameters(ReadMediaParams {
                path: "photo.avif".into(),
            }))
            .await
            .unwrap();

        assert_eq!(svg.as_image().unwrap().mime_type, "image/svg+xml");
        assert_eq!(avif.as_image().unwrap().mime_type, "image/avif");
    }

    #[tokio::test]
    async fn read_media_refuses_unsupported_extension() {
        let (_cfg, root, server) = fixture();
        std::fs::write(root.path().join("a.bmp"), b"BMP").unwrap();
        let err = server
            .read_media(Parameters(ReadMediaParams {
                path: "a.bmp".into(),
            }))
            .await
            .unwrap_err();
        assert!(
            err.message
                .to_lowercase()
                .contains("unsupported media extension"),
            "msg={}",
            err.message
        );
    }

    #[tokio::test]
    async fn read_media_caps_response_size() {
        let (_cfg, root, server_default) = fixture();
        // Override the cap to 4 bytes so a 5-byte file overflows;
        // exercises with_max_media_bytes alongside the cap check.
        let server = server_default.with_max_media_bytes(4);
        std::fs::write(root.path().join("a.png"), b"\x89PNG\r").unwrap();
        let err = server
            .read_media(Parameters(ReadMediaParams {
                path: "a.png".into(),
            }))
            .await
            .unwrap_err();
        assert!(
            err.message.contains("media too large"),
            "msg={}",
            err.message
        );
        // The numeric size and cap stay in the message: the model
        // needs them to pick a smaller file or to surface the cap
        // to the user.
        assert!(err.message.contains("5"), "msg={}", err.message);
        assert!(err.message.contains("4"), "msg={}", err.message);
    }

    #[tokio::test]
    async fn read_media_path_sandbox_error_is_scrubbed() {
        let (_cfg, _root, server) = fixture();
        // Path escape: chan-workspace's path-resolver refuses this; the
        // error surfaces through mcp_safe_message as the scrubbed
        // category, no host filesystem detail.
        let err = server
            .read_media(Parameters(ReadMediaParams {
                path: "../escape.png".into(),
            }))
            .await
            .unwrap_err();
        assert!(
            err.message.to_lowercase().contains("path refused"),
            "msg={}",
            err.message
        );
        assert!(
            !err.message.contains("escape.png"),
            "leaked path: {}",
            err.message
        );
    }

    #[test]
    fn server_with_max_media_bytes_overrides_default() {
        let (_cfg, _root, server_default) = fixture();
        let server = server_default.with_max_media_bytes(123);
        assert_eq!(server.max_media_bytes, 123);
    }

    #[test]
    fn server_defaults_to_default_media_cap() {
        let (_cfg, _root, server) = fixture();
        assert_eq!(server.max_media_bytes, DEFAULT_MCP_MEDIA_MAX_BYTES);
    }

    #[test]
    fn mcp_error_message_keeps_actionable_numbers() {
        // WriteConflict carries a numeric mtime; that's
        // model-actionable and stays in the scrubbed output.
        let err = mcp_safe_message(&LlmError::WriteConflict {
            current_mtime_ns: Some(123_456_789),
        });
        assert!(
            err.contains("123456789") || err.contains("123_456_789") || err.contains("123456_789"),
            "should keep mtime numeric in: {err}",
        );
        assert!(err.to_lowercase().contains("conflict"));
    }

    #[tokio::test]
    async fn framed_content_length_initialize_roundtrips() {
        let (_cfg, _root, server) = fixture();
        let (client_io, server_io) = tokio::io::duplex(64 * 1024);
        let (server_read, server_write) = tokio::io::split(server_io);
        let server_task =
            tokio::spawn(async move { server.serve_io(server_read, server_write).await });

        let (mut client_read, mut client_write) = tokio::io::split(client_io);
        let init = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "probe", "version": "0"}
            }
        })
        .to_string();
        write_content_length_frame(&mut client_write, init.as_bytes())
            .await
            .unwrap();

        let header = read_frame_header(&mut client_read)
            .await
            .unwrap()
            .expect("response header");
        let len = parse_content_length(&header).unwrap();
        let mut body = vec![0u8; len];
        client_read.read_exact(&mut body).await.unwrap();
        let response: serde_json::Value = serde_json::from_slice(&body).unwrap();

        assert_eq!(response["jsonrpc"], "2.0");
        assert_eq!(response["id"], 1);
        assert_eq!(response["result"]["serverInfo"]["name"], "chan");

        drop(client_write);
        server_task.abort();
    }

    #[tokio::test]
    async fn lf_content_length_initialize_roundtrips() {
        let (_cfg, _root, server) = fixture();
        let (client_io, server_io) = tokio::io::duplex(64 * 1024);
        let (server_read, server_write) = tokio::io::split(server_io);
        let server_task =
            tokio::spawn(async move { server.serve_io(server_read, server_write).await });

        let (mut client_read, mut client_write) = tokio::io::split(client_io);
        let init = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "codex-probe", "version": "0"}
            }
        })
        .to_string();
        let header = format!("Content-Length: {}\n\n", init.len());
        client_write.write_all(header.as_bytes()).await.unwrap();
        client_write.write_all(init.as_bytes()).await.unwrap();
        client_write.flush().await.unwrap();

        let header = read_frame_header(&mut client_read)
            .await
            .unwrap()
            .expect("response header");
        let len = parse_content_length(&header).unwrap();
        let mut body = vec![0u8; len];
        client_read.read_exact(&mut body).await.unwrap();
        let response: serde_json::Value = serde_json::from_slice(&body).unwrap();

        assert_eq!(response["jsonrpc"], "2.0");
        assert_eq!(response["id"], 1);
        assert_eq!(response["result"]["serverInfo"]["name"], "chan");

        drop(client_write);
        server_task.abort();
    }

    #[tokio::test]
    async fn newline_initialize_still_roundtrips() {
        let (_cfg, _root, server) = fixture();
        let (client_io, server_io) = tokio::io::duplex(64 * 1024);
        let (server_read, server_write) = tokio::io::split(server_io);
        let server_task =
            tokio::spawn(async move { server.serve_io(server_read, server_write).await });

        let (mut client_read, mut client_write) = tokio::io::split(client_io);
        let init = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "probe", "version": "0"}
            }
        })
        .to_string();
        client_write.write_all(init.as_bytes()).await.unwrap();
        client_write.write_all(b"\n").await.unwrap();
        client_write.flush().await.unwrap();

        let mut line = Vec::new();
        let mut byte = [0u8; 1];
        loop {
            client_read.read_exact(&mut byte).await.unwrap();
            if byte[0] == b'\n' {
                break;
            }
            line.push(byte[0]);
        }
        let response: serde_json::Value = serde_json::from_slice(&line).unwrap();

        assert_eq!(response["jsonrpc"], "2.0");
        assert_eq!(response["id"], 1);
        assert_eq!(response["result"]["serverInfo"]["name"], "chan");

        drop(client_write);
        server_task.abort();
    }

    async fn write_content_length_frame<W>(writer: &mut W, body: &[u8]) -> std::io::Result<()>
    where
        W: AsyncWrite + Unpin,
    {
        let header = format!("Content-Length: {}\r\n\r\n", body.len());
        writer.write_all(header.as_bytes()).await?;
        writer.write_all(body).await?;
        writer.flush().await
    }
}
