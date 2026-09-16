// Tool descriptions shared by the standard tool schemas (`tools.rs`)
// and the MCP server (`mcp.rs`). One definition per tool keeps both
// surfaces describing each tool the same way.

/// Description of the read_file tool, surfaced in the tool schema
/// the backend sees.
pub const READ_FILE_DESC: &str = "\
Read the UTF-8 content of a file in the active workspace. The path is \
POSIX-style in chan's public namespace. Returns { path, content, \
size, mtime_ns }. Files \
larger than 256 KiB are truncated and the response includes \
`truncated: true` plus a `note` describing the cap; in that case \
re-issue with a smaller scope (or open the file in the editor if \
you need the full thing). Pass `mtime_ns` back on `write_file` as \
`expected_mtime_ns` to detect concurrent edits.";

/// Description of the write_file tool. Writes apply immediately
/// through chan-workspace's sandbox; if the user's intent looks
/// destructive (batch refactor across many files, etc.) the
/// model is expected to call `AskUserQuestion` for a numbered
/// confirmation BEFORE issuing the writes.
pub const WRITE_FILE_DESC: &str = "\
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
write_file call.";

/// Description of the list_files tool.
pub const LIST_FILES_DESC: &str = "\
List files in the active workspace as { entries, count, total }. \
Pass an optional `prefix` (POSIX rel-path) to scope the listing to \
a subdirectory; omit it to list the whole workspace, including \
drafts in the in-workspace `.Drafts/` directory. Listings are \
capped at 2,000 entries; if `truncated` \
is true, narrow with a prefix or call workspace_search instead.";

/// Description of the resolve_path tool.
pub const RESOLVE_PATH_DESC: &str = "\
Resolve a chan public path to a host filesystem path. Use this only \
when you need a real path for shell tools or terminal cwd. Normal \
content operations should keep using read_file, write_file, and \
list_files with chan paths. The path argument is POSIX-style in \
chan's public namespace and resolves under the workspace root, \
including drafts in the in-workspace `.Drafts/` directory.";

/// Description shared by standard and MCP workspace-search tools.
pub const WORKSPACE_SEARCH_DESC: &str = "\
Search and traverse the active workspace with one bounded request. \
Use `query` for content or entity search and typed `from` selectors \
for exact file, directory, tag, mention, contact, or language starts. \
`domains` chooses returned content/entities; `depth`, `direction`, and \
`relationship_kinds` control traversal. The result includes content \
hits, entity matches, normalized graph nodes and relationships, \
effective limits, truncation, warnings, and structured errors. It \
also covers query-free entity browsing, backlinks, tag membership, \
contacts, language membership, linked media, and containment.";

/// Description of the repo_report tool.
pub const REPO_REPORT_DESC: &str = "\
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
`truncated` is true, scope further with `prefix` or `paths`.";

/// Description of the read_media tool. MCP-only: not surfaced
/// through `tools::standard_tool_schemas()`. Pinned against the
/// inlined `#[tool]` literal in `mcp.rs` via
/// `mcp_descriptions_match_prompts`.
pub const READ_MEDIA_DESC: &str = "\
Read a media file from the active workspace and return it as MCP media \
content. The path is POSIX-style in chan's public namespace and \
must be classified by chan-workspace as Image (.png, .jpg, .jpeg, \
.gif, .webp, .svg, .avif) or Pdf (.pdf); other extensions are \
refused (text files use read_file). Image responses are MCP image \
content blocks. PDF responses are MCP blob resources with \
application/pdf MIME type. Single-call cap defaults to 10 MiB; \
oversized files error with `media too large` so you can pick a \
smaller file (the host may have widened or narrowed this cap via \
config).";
