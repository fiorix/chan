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
//! `resolve_path`, `workspace_search`, report tools, and
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
    schemars,
    service::RequestContext,
    tool, tool_handler, tool_router,
    transport::stdio,
    RoleServer, ServerHandler, ServiceExt,
};
use serde::Deserialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::error::LlmError;
use crate::tools::{self, ToolContext, WorkspaceSearchParams};

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

type WorkspaceResolver = dyn Fn() -> Option<Arc<Workspace>> + Send + Sync;

/// MCP server handle. Tool bodies resolve the workspace on the blocking
/// pool, preserving chan-workspace's path sandbox,
/// special-file refusal, and editable-text gate.
///
/// `new` retains an owner for standalone hosting. A tenant resolver reads
/// its live cell so workspace swaps serialize with tool admission and
/// unmount can clear the owner independently of queued requests and I/O.
#[derive(Clone)]
pub struct Server {
    workspace_for: Arc<WorkspaceResolver>,
    /// Hard cap on a single `read_media` response, in bytes. Set via
    /// `with_max_media_bytes`; defaults to
    /// `DEFAULT_MCP_MEDIA_MAX_BYTES`. Lives on the server (not the
    /// `ToolContext`) because it's an MCP-surface policy, not a
    /// chan-workspace invariant: the same `Workspace` can host a server with
    /// a different cap.
    max_media_bytes: u64,
}

impl Server {
    /// Own the workspace for standalone MCP hosting.
    pub fn new(workspace: Arc<Workspace>) -> Self {
        Self::from_resolver(move || Some(workspace.clone()))
    }

    /// Resolve the current tenant workspace inside each blocking tool body.
    /// The resolver must clone through the tenant cell and return `None`
    /// after unmount. Queued requests do not acquire a workspace snapshot.
    pub fn from_resolver<F>(workspace_for: F) -> Self
    where
        F: Fn() -> Option<Arc<Workspace>> + Send + Sync + 'static,
    {
        Self {
            workspace_for: Arc::new(workspace_for),
            max_media_bytes: DEFAULT_MCP_MEDIA_MAX_BYTES,
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
pub struct ListFilesParams {
    /// Optional POSIX rel-path prefix to scope the listing to a
    /// subdirectory. Empty / omitted lists the whole workspace (capped).
    /// Drafts live in the in-workspace `.Drafts/` directory like any content.
    #[serde(default)]
    pub prefix: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ResolvePathParams {
    /// POSIX-style path in chan's public namespace; resolves under the
    /// workspace root, including drafts in the in-workspace `.Drafts/`.
    pub path: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ReadMediaParams {
    /// POSIX-style path in chan's public namespace. Must be an image
    /// or PDF class path according to chan-workspace.
    pub path: String,
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
POSIX-style in chan's public namespace. Returns { path, content, \
size, mtime_ns }. Files \
larger than 256 KiB are truncated and the response includes \
`truncated: true` plus a `note` describing the cap; in that case \
re-issue with a smaller scope (or open the file in the editor if \
you need the full thing). Pass `mtime_ns` back on `write_file` as \
`expected_mtime_ns` to detect concurrent edits.")]
    async fn read_file(
        &self,
        Parameters(p): Parameters<ReadFileParams>,
        context: RequestContext<RoleServer>,
    ) -> std::result::Result<String, ErrorData> {
        run_tool(
            "read_file",
            serde_json::json!({"path": p.path}),
            self.workspace_for.clone(),
            context,
        )
        .await
    }

    #[tool(description = "\
Replace the content of a file in the active workspace (creates the \
parent directory if needed). The path is POSIX-style in chan's \
public namespace and must be \
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
        context: RequestContext<RoleServer>,
    ) -> std::result::Result<String, ErrorData> {
        let mut args = serde_json::json!({"path": p.path, "content": p.content});
        if let Some(mtime_ns) = p.expected_mtime_ns {
            args["expected_mtime_ns"] = serde_json::json!(mtime_ns);
        }
        run_tool("write_file", args, self.workspace_for.clone(), context).await
    }

    #[tool(description = "\
List files in the active workspace as { entries, count, total }. \
Pass an optional `prefix` (POSIX rel-path) to scope the listing to \
a subdirectory; omit it to list the whole workspace, including \
drafts in the in-workspace `.Drafts/` directory. Listings are \
capped at 2,000 entries; if `truncated` \
is true, narrow with a prefix or call workspace_search instead.")]
    async fn list_files(
        &self,
        Parameters(p): Parameters<ListFilesParams>,
        context: RequestContext<RoleServer>,
    ) -> std::result::Result<String, ErrorData> {
        let mut args = serde_json::json!({});
        if let Some(prefix) = p.prefix {
            args["prefix"] = serde_json::Value::String(prefix);
        }
        run_tool("list_files", args, self.workspace_for.clone(), context).await
    }

    #[tool(description = "\
Resolve a chan public path to a host filesystem path. Use this only \
when you need a real path for shell tools or terminal cwd. Normal \
content operations should keep using read_file, write_file, and \
list_files with chan paths. The path argument is POSIX-style in \
chan's public namespace and resolves under the workspace root, \
including drafts in the in-workspace `.Drafts/` directory.")]
    async fn resolve_path(
        &self,
        Parameters(p): Parameters<ResolvePathParams>,
        context: RequestContext<RoleServer>,
    ) -> std::result::Result<String, ErrorData> {
        run_tool(
            "resolve_path",
            serde_json::json!({"path": p.path}),
            self.workspace_for.clone(),
            context,
        )
        .await
    }

    #[tool(description = "\
Search and traverse the active workspace with one bounded request. \
Use `query` for content or entity search and typed `from` selectors \
for exact file, directory, tag, mention, contact, or language starts. \
`domains` chooses returned content/entities; `depth`, `direction`, and \
`relationship_kinds` control traversal. The result includes content \
hits, entity matches, normalized graph nodes and relationships, \
effective limits, truncation, warnings, and structured errors. It \
also covers query-free entity browsing, backlinks, tag membership, \
contacts, language membership, linked media, and containment.")]
    async fn workspace_search(
        &self,
        Parameters(p): Parameters<WorkspaceSearchParams>,
        context: RequestContext<RoleServer>,
    ) -> std::result::Result<String, ErrorData> {
        let args = serde_json::to_value(p).map_err(|error| {
            ErrorData::invalid_params(format!("invalid workspace_search args: {error}"), None)
        })?;
        run_tool(
            "workspace_search",
            args,
            self.workspace_for.clone(),
            context,
        )
        .await
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
        context: RequestContext<RoleServer>,
    ) -> std::result::Result<Content, ErrorData> {
        read_media_content(
            self.workspace_for.clone(),
            p.path,
            self.max_media_bytes,
            context,
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
        context: RequestContext<RoleServer>,
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
        run_tool("repo_report", args, self.workspace_for.clone(), context).await
    }
}

#[tool_handler(
    name = "chan",
    instructions = "Tools for reading, writing, listing, searching, and resolving paths in a chan markdown workspace. Content operations are sandboxed by chan-workspace; Cmd+N drafts are regular workspace files in the in-workspace .Drafts/ directory, addressed by their real relpath."
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
    workspace_for: Arc<WorkspaceResolver>,
    context: RequestContext<RoleServer>,
) -> std::result::Result<String, ErrorData> {
    let ct = context.ct;
    #[cfg(test)]
    tests::gate_tool(&args).await;
    let result = tokio::task::spawn_blocking(move || {
        if ct.is_cancelled() {
            return Err(ErrorData::internal_error("request cancelled", None));
        }
        let workspace = workspace_for()
            .ok_or_else(|| ErrorData::internal_error("workspace is closed", None))?;
        if ct.is_cancelled() {
            return Err(ErrorData::internal_error("request cancelled", None));
        }
        tools::execute(name, &args, &ToolContext::new(workspace))
            .map_err(|e| ErrorData::internal_error(mcp_safe_message(&e), None))
    })
    .await
    .map_err(|e| ErrorData::internal_error(format!("tool task failed: {e}"), None))??;
    serde_json::to_string(&result)
        .map_err(|e| ErrorData::internal_error(format!("serialize result: {e}"), None))
}

async fn read_media_content(
    workspace_for: Arc<WorkspaceResolver>,
    path: String,
    max_media_bytes: u64,
    context: RequestContext<RoleServer>,
) -> std::result::Result<Content, ErrorData> {
    let ct = context.ct;
    tokio::task::spawn_blocking(move || {
        if ct.is_cancelled() {
            return Err(ErrorData::internal_error("request cancelled", None));
        }
        let workspace = workspace_for()
            .ok_or_else(|| ErrorData::internal_error("workspace is closed", None))?;
        if ct.is_cancelled() {
            return Err(ErrorData::internal_error("request cancelled", None));
        }
        read_media_content_sync(&ToolContext::new(workspace), path, max_media_bytes)
    })
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
    use chan_workspace::Library;
    use std::time::Duration;
    use tempfile::TempDir;
    use tokio::io::{AsyncBufReadExt, BufReader};

    const GATED_PATH: &str = "__mcp_test_dispatch_gate__.md";
    struct ToolGate {
        entered: tokio::sync::oneshot::Sender<()>,
        release: Arc<tokio::sync::Semaphore>,
    }
    static TOOL_GATE: std::sync::Mutex<Option<ToolGate>> = std::sync::Mutex::new(None);
    const CANCELLED_GATED_PATH: &str = "__mcp_test_cancel_gate__.md";
    static CANCELLED_TOOL_GATE: std::sync::Mutex<Option<ToolGate>> = std::sync::Mutex::new(None);

    pub(super) async fn gate_tool(args: &serde_json::Value) {
        let slot = match args["path"].as_str() {
            Some(GATED_PATH) => &TOOL_GATE,
            Some(CANCELLED_GATED_PATH) => &CANCELLED_TOOL_GATE,
            _ => return,
        };
        let gate = slot.lock().unwrap().take();
        if let Some(gate) = gate {
            gate.entered.send(()).unwrap();
            tokio::time::timeout(Duration::from_secs(5), gate.release.acquire())
                .await
                .expect("dispatched tool gate was not released")
                .unwrap()
                .forget();
        }
    }

    async fn write_rpc<W: AsyncWrite + Unpin>(writer: &mut W, value: serde_json::Value) {
        writer
            .write_all(format!("{value}\n").as_bytes())
            .await
            .unwrap();
    }

    async fn read_rpc<R: tokio::io::AsyncBufRead + Unpin>(reader: &mut R) -> serde_json::Value {
        let mut line = String::new();
        assert_ne!(reader.read_line(&mut line).await.unwrap(), 0);
        serde_json::from_str(&line).unwrap()
    }

    async fn initialize<R, W>(reader: &mut R, writer: &mut W)
    where
        R: tokio::io::AsyncBufRead + Unpin,
        W: AsyncWrite + Unpin,
    {
        write_rpc(
            writer,
            serde_json::json!({
                "jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                    "clientInfo": {"name": "lifetime-test", "version": "0"}}
            }),
        )
        .await;
        assert_eq!(
            read_rpc(reader).await["result"]["serverInfo"]["name"],
            "chan"
        );
        write_rpc(
            writer,
            serde_json::json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
        )
        .await;
        write_rpc(
            writer,
            serde_json::json!({"jsonrpc": "2.0", "id": 2, "method": "ping"}),
        )
        .await;
        assert_eq!(read_rpc(reader).await["id"], 2);
    }

    async fn assert_workspace_released(
        weak: &std::sync::Weak<Workspace>,
        lock_dir: &std::path::Path,
    ) {
        tokio::time::timeout(Duration::from_secs(1), async {
            while weak.strong_count() != 0 || !chan_workspace::lock::is_free(lock_dir) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("MCP retains {} workspace handles", weak.strong_count()));
    }

    #[tokio::test]
    async fn mcp_call_waits_for_the_replacement_workspace() {
        tokio::time::timeout(Duration::from_secs(5), async {
            let cfg = TempDir::new().unwrap();
            let root = TempDir::new().unwrap();
            let library = Library::open_at(cfg.path().join("config.toml")).unwrap();
            library.register_workspace(root.path()).unwrap();
            let workspace = library.open_workspace(root.path()).unwrap();
            workspace.write_text("generation.md", "original").unwrap();
            workspace.stop_open_recovery();
            let weak = Arc::downgrade(&workspace);
            let cell = Arc::new(std::sync::RwLock::new(Some(workspace)));
            let resolving_cell = cell.clone();
            let (entered, entry) = tokio::sync::oneshot::channel();
            let probe = Arc::new(std::sync::Mutex::new(None));
            let resolving_probe = probe.clone();
            let server = Server::from_resolver(move || {
                if let Some(entered) = resolving_probe.lock().unwrap().take() {
                    let entered: tokio::sync::oneshot::Sender<()> = entered;
                    entered.send(()).unwrap();
                }
                resolving_cell.read().unwrap().clone()
            });
            *probe.lock().unwrap() = Some(entered);
            let (client, peer) = tokio::io::duplex(4096);
            let (read, write) = tokio::io::split(peer);
            let session = tokio::spawn(server.serve_io(read, write));
            let (read, mut write) = tokio::io::split(client);
            let mut read = BufReader::new(read);
            initialize(&mut read, &mut write).await;
            let (locked, lock_ready) = tokio::sync::oneshot::channel();
            let (release, released) = std::sync::mpsc::channel();
            let swapping_root = root.path().to_path_buf();
            let swapping = tokio::task::spawn_blocking(move || {
                let mut guard = cell.write().unwrap();
                locked.send(()).unwrap();
                released.recv_timeout(Duration::from_secs(3)).unwrap();
                drop(guard.take());
                let replacement = library.open_workspace(&swapping_root).unwrap();
                replacement
                    .write_text("generation.md", "replacement")
                    .unwrap();
                *guard = Some(replacement);
            });
            lock_ready.await.unwrap();
            let strong_count = weak.strong_count();
            let weak_count = weak.weak_count();
            assert_eq!(strong_count, 1);
            write_rpc(
                &mut write,
                serde_json::json!({"jsonrpc": "2.0", "id": 3,
                "method": "tools/call", "params": {"name": "read_file",
                "arguments": {"path": "generation.md"}}}),
            )
            .await;
            tokio::select! {
                entered = entry => entered.unwrap(),
                reply = read_rpc(&mut read) => panic!("tool bypassed the workspace cell: {reply}"),
            }
            assert_eq!(weak.strong_count(), strong_count);
            assert_eq!(weak.weak_count(), weak_count);
            let mut waiting = Box::pin(read_rpc(&mut read));
            std::future::poll_fn(|cx| {
                assert!(std::future::Future::poll(waiting.as_mut(), cx).is_pending());
                std::task::Poll::Ready(())
            })
            .await;
            drop(waiting);
            release.send(()).unwrap();
            swapping.await.unwrap();
            let reply = read_rpc(&mut read).await;
            let value: serde_json::Value =
                serde_json::from_str(reply["result"]["content"][0]["text"].as_str().unwrap())
                    .unwrap();
            assert_eq!(value["content"], "replacement");
            session.abort();
            assert!(session.await.unwrap_err().is_cancelled());
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn mcp_cancelled_request_does_not_resolve_or_write() {
        tokio::time::timeout(Duration::from_secs(5), async {
            let cfg = TempDir::new().unwrap();
            let root = TempDir::new().unwrap();
            let library = Library::open_at(cfg.path().join("config.toml")).unwrap();
            library.register_workspace(root.path()).unwrap();
            let workspace = library.open_workspace(root.path()).unwrap();
            workspace.write_text(CANCELLED_GATED_PATH, "unchanged").unwrap();
            workspace.stop_open_recovery();
            let weak = Arc::downgrade(&workspace);
            let resolutions = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let observed = resolutions.clone();
            let server = Server::from_resolver(move || {
                observed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                weak.upgrade()
            });
            resolutions.store(0, std::sync::atomic::Ordering::SeqCst);
            let (client, peer) = tokio::io::duplex(4096);
            let (read, write) = tokio::io::split(peer);
            let session = tokio::spawn(server.serve_io(read, write));
            let (read, mut write) = tokio::io::split(client);
            let mut read = BufReader::new(read);
            initialize(&mut read, &mut write).await;
            let (entered, entry) = tokio::sync::oneshot::channel();
            let release = Arc::new(tokio::sync::Semaphore::new(0));
            assert!(CANCELLED_TOOL_GATE.lock().unwrap().replace(ToolGate { entered, release: release.clone() }).is_none());
            write_rpc(&mut write, serde_json::json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                "params": {"name": "write_file", "arguments": {"path": CANCELLED_GATED_PATH, "content": "must not land"}}})).await;
            entry.await.unwrap();
            write_rpc(&mut write, serde_json::json!({"jsonrpc": "2.0", "method": "notifications/cancelled",
                "params": {"requestId": 3, "reason": "test cancellation"}})).await;
            write_rpc(&mut write, serde_json::json!({"jsonrpc": "2.0", "id": 4, "method": "ping"})).await;
            assert_eq!(read_rpc(&mut read).await["id"], 4);
            release.add_permits(1);
            let reply = read_rpc(&mut read).await;
            assert_eq!(reply["error"]["message"], "request cancelled");
            assert_eq!(resolutions.load(std::sync::atomic::Ordering::SeqCst), 0);
            assert_eq!(workspace.read_text(CANCELLED_GATED_PATH).unwrap(), "unchanged");
            session.abort();
            assert!(session.await.unwrap_err().is_cancelled());
        }).await.unwrap();
    }

    #[tokio::test]
    async fn mcp_dispatched_request_releases_workspace_after_session_abort() {
        tokio::time::timeout(Duration::from_secs(5), async {
            let cfg = TempDir::new().unwrap();
            let root = TempDir::new().unwrap();
            let library = Library::open_at(cfg.path().join("config.toml")).unwrap();
            library.register_workspace(root.path()).unwrap();
            let workspace = library.open_workspace(root.path()).unwrap();
            workspace.write_text(GATED_PATH, "unchanged").unwrap();
            let weak = Arc::downgrade(&workspace);
            let lock_dir = workspace.paths().lock.clone();
            let server = weak_server(weak.clone());
            let (client, peer) = tokio::io::duplex(4096);
            let (read, write) = tokio::io::split(peer);
            let session = tokio::spawn(server.serve_io(read, write));
            let (read, mut write) = tokio::io::split(client);
            let mut read = BufReader::new(read);
            initialize(&mut read, &mut write).await;
            let (entered, entry) = tokio::sync::oneshot::channel();
            let release = Arc::new(tokio::sync::Semaphore::new(0));
            assert!(TOOL_GATE.lock().unwrap().replace(ToolGate { entered, release: release.clone() }).is_none());
            write_rpc(&mut write, serde_json::json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                "params": {"name": "write_file", "arguments": {"path": GATED_PATH, "content": "must not land"}}})).await;
            entry.await.unwrap();
            session.abort();
            assert!(session.await.unwrap_err().is_cancelled());
            drop(workspace);
            assert_workspace_released(&weak, &lock_dir).await;
            release.add_permits(1);
            // Keep the reopened owner live: the stale request must not acquire it.
            let reopened = library.open_workspace(root.path()).unwrap();
            let mut line = String::new();
            if read.read_line(&mut line).await.unwrap() != 0 {
                let reply: serde_json::Value = serde_json::from_str(&line).unwrap();
                assert!(reply.get("error").is_some(), "cancelled request succeeded: {reply}");
            }
            assert_eq!(reopened.read_text(GATED_PATH).unwrap(), "unchanged");
        }).await.unwrap();
    }

    #[tokio::test]
    async fn mcp_call_after_workspace_drop_answers_workspace_closed() {
        tokio::time::timeout(Duration::from_secs(5), async {
            let cfg = TempDir::new().unwrap();
            let root = TempDir::new().unwrap();
            let library = Library::open_at(cfg.path().join("config.toml")).unwrap();
            library.register_workspace(root.path()).unwrap();
            let workspace = library.open_workspace(root.path()).unwrap();
            workspace.write_text("kept.md", "unchanged").unwrap();
            let server = weak_server(Arc::downgrade(&workspace));
            drop(workspace);
            let (client, peer) = tokio::io::duplex(4096);
            let (read, write) = tokio::io::split(peer);
            let session = tokio::spawn(server.serve_io(read, write));
            let (read, mut write) = tokio::io::split(client);
            let mut read = BufReader::new(read);
            initialize(&mut read, &mut write).await;
            for (id, name, arguments) in [
                (
                    3,
                    "write_file",
                    serde_json::json!({"path": "kept.md", "content": "must not land"}),
                ),
                (4, "read_media", serde_json::json!({"path": "image.png"})),
            ] {
                write_rpc(
                    &mut write,
                    serde_json::json!({"jsonrpc": "2.0", "id": id, "method": "tools/call",
                    "params": {"name": name, "arguments": arguments}}),
                )
                .await;
                let reply = read_rpc(&mut read).await;
                assert_eq!(reply["error"]["message"], "workspace is closed", "{reply}");
            }
            let reopened = library.open_workspace(root.path()).unwrap();
            assert_eq!(reopened.read_text("kept.md").unwrap(), "unchanged");
            session.abort();
            assert!(session.await.unwrap_err().is_cancelled());
        })
        .await
        .unwrap();
    }

    struct StalledWriter<W> {
        inner: W,
        stalled: Option<tokio::sync::oneshot::Sender<()>>,
        armed: Arc<std::sync::atomic::AtomicBool>,
    }

    impl<W: AsyncWrite + Unpin> AsyncWrite for StalledWriter<W> {
        fn poll_write(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
            bytes: &[u8],
        ) -> std::task::Poll<std::io::Result<usize>> {
            let result = std::pin::Pin::new(&mut self.inner).poll_write(cx, bytes);
            if result.is_pending() && self.armed.load(std::sync::atomic::Ordering::SeqCst) {
                if let Some(stalled) = self.stalled.take() {
                    stalled.send(()).unwrap();
                }
            }
            result
        }

        fn poll_flush(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            std::pin::Pin::new(&mut self.inner).poll_flush(cx)
        }

        fn poll_shutdown(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            std::pin::Pin::new(&mut self.inner).poll_shutdown(cx)
        }
    }

    #[tokio::test]
    async fn mcp_stalled_reader_does_not_pin_the_workspace() {
        tokio::time::timeout(Duration::from_secs(5), async {
            let cfg = TempDir::new().unwrap();
            let root = TempDir::new().unwrap();
            let library = Library::open_at(cfg.path().join("config.toml")).unwrap();
            library.register_workspace(root.path()).unwrap();
            let workspace = library.open_workspace(root.path()).unwrap();
            workspace
                .write_text("large.md", &"x".repeat(32 * 1024))
                .unwrap();
            let weak = Arc::downgrade(&workspace);
            let lock_dir = workspace.paths().lock.clone();
            let server = weak_server(weak.clone());
            let (client, peer) = tokio::io::duplex(1024);
            let (read, write) = tokio::io::split(peer);
            let (stalled, pending) = tokio::sync::oneshot::channel();
            let armed = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let session = tokio::spawn(server.serve_io(
                read,
                StalledWriter {
                    inner: write,
                    stalled: Some(stalled),
                    armed: armed.clone(),
                },
            ));
            let (read, mut write) = tokio::io::split(client);
            let mut read = BufReader::new(read);
            initialize(&mut read, &mut write).await;
            armed.store(true, std::sync::atomic::Ordering::SeqCst);
            write_rpc(
                &mut write,
                serde_json::json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                "params": {"name": "read_file", "arguments": {"path": "large.md"}}}),
            )
            .await;
            pending.await.unwrap();
            session.abort();
            assert!(session.await.unwrap_err().is_cancelled());
            drop(workspace);
            assert_workspace_released(&weak, &lock_dir).await;
            let _reopened = library.open_workspace(root.path()).unwrap();
            drop(read);
            drop(write);
        })
        .await
        .unwrap();
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
        let search = Server::workspace_search_tool_attr();
        assert_eq!(
            search.description.as_deref(),
            Some(crate::prompts::WORKSPACE_SEARCH_DESC)
        );
        let standard = tools::standard_tool_schemas()
            .into_iter()
            .find(|schema| schema.name == "workspace_search")
            .expect("workspace_search standard schema");
        assert_eq!(
            serde_json::Value::Object((*search.input_schema).clone()),
            standard.parameters
        );
        let image = Server::read_media_tool_attr();
        assert_eq!(
            image.description.as_deref(),
            Some(crate::prompts::READ_MEDIA_DESC)
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

    fn weak_server(workspace: std::sync::Weak<Workspace>) -> Server {
        Server::from_resolver(move || workspace.upgrade())
    }

    fn request_context() -> RequestContext<RoleServer> {
        struct ContextServer;
        impl ServerHandler for ContextServer {}
        let (_client, peer) = tokio::io::duplex(1);
        let service = rmcp::service::serve_directly(ContextServer, tokio::io::split(peer), None);
        RequestContext::new(
            rmcp::model::NumberOrString::Number(1),
            service.peer().clone(),
        )
    }

    #[tokio::test]
    async fn read_file_dispatches_to_workspace() {
        let (_cfg, root, server) = fixture();
        std::fs::write(root.path().join("a.md"), "hello").unwrap();
        let out = server
            .read_file(
                Parameters(ReadFileParams {
                    path: "a.md".into(),
                }),
                request_context(),
            )
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
            .write_file(
                Parameters(WriteFileParams {
                    path: "a.md".into(),
                    content: "hi".into(),
                    expected_mtime_ns: None,
                }),
                request_context(),
            )
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
                .write_file(
                    Parameters(WriteFileParams {
                        path: path.into(),
                        content: body.into(),
                        expected_mtime_ns: None,
                    }),
                    request_context(),
                )
                .await
                .unwrap();
            let out = server
                .read_file(
                    Parameters(ReadFileParams { path: path.into() }),
                    request_context(),
                )
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
            .list_files(
                Parameters(ListFilesParams { prefix: None }),
                request_context(),
            )
            .await
            .unwrap();
        assert!(out.contains("a.md"), "got: {out}");
    }

    #[tokio::test]
    async fn resolve_path_maps_drafts_to_in_root_dir() {
        // Drafts are real in-root files under the configured drafts dir
        // now, so a draft path resolves like any other in-root path:
        // `virtual` is false and the physical path lives under the
        // workspace root's drafts dir.
        let (_cfg, _root, server) = fixture();
        let workspace = (server.workspace_for)().unwrap();
        let drafts_dir = workspace.drafts_dir_name().to_string();
        workspace.create_draft_dir("untitled-1").unwrap();
        let draft_dir_rel = format!("{drafts_dir}/untitled-1");
        workspace
            .write_text(&format!("{draft_dir_rel}/draft.md"), "# draft\n")
            .unwrap();

        let out = server
            .resolve_path(
                Parameters(ResolvePathParams {
                    path: draft_dir_rel.clone(),
                }),
                request_context(),
            )
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(body["path"], draft_dir_rel);
        assert_eq!(body["virtual"], false);
        assert_eq!(
            body["physical_path"].as_str().unwrap(),
            workspace
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
            .write_file(
                Parameters(WriteFileParams {
                    path: "img.png".into(),
                    content: "x".into(),
                    expected_mtime_ns: None,
                }),
                request_context(),
            )
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
            .write_file(
                Parameters(WriteFileParams {
                    path: "img.png".into(),
                    content: "x".into(),
                    expected_mtime_ns: None,
                }),
                request_context(),
            )
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
            .read_media(
                Parameters(ReadMediaParams {
                    path: "a.png".into(),
                }),
                request_context(),
            )
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
            .read_media(
                Parameters(ReadMediaParams {
                    path: "docs spec.pdf".into(),
                }),
                request_context(),
            )
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
            .read_media(
                Parameters(ReadMediaParams {
                    path: "icon.svg".into(),
                }),
                request_context(),
            )
            .await
            .unwrap();
        let avif = server
            .read_media(
                Parameters(ReadMediaParams {
                    path: "photo.avif".into(),
                }),
                request_context(),
            )
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
            .read_media(
                Parameters(ReadMediaParams {
                    path: "a.bmp".into(),
                }),
                request_context(),
            )
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
            .read_media(
                Parameters(ReadMediaParams {
                    path: "a.png".into(),
                }),
                request_context(),
            )
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
            .read_media(
                Parameters(ReadMediaParams {
                    path: "../escape.png".into(),
                }),
                request_context(),
            )
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
