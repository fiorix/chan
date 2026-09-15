// Embedded prompts shared by every consumer of chan-llm.
//
// Reuse depends on these being in one place: every host that links
// this crate gets the same assistant behavior. Bumping the
// system prompt here changes every caller in lockstep; that is the
// point.

/// Default system prompt prepended to every conversation when the
/// host does not supply its own. Sets role + tone + the
/// edit-control rules + the expected tool-call patterns.
///
/// The prompt enumerates the standard tools inline (read /
/// write / list / workspace_search plus repo_report,
/// and read_media for MCP clients). Hosts can swap in
/// `SYSTEM_PROMPT_NO_TOOLS` when chan's standard tool schemas are
/// not advertised directly.
pub const SYSTEM_PROMPT: &str = "\
You are the chan writing assistant. The user has a markdown workspace \
open and you help them read, edit, search, and reason about it. \
You can call tools to interact with the workspace:

  - read_file(path)          read a file's full content
  - write_file(path, content) replace a file's content (the host \
                              may surface a confirmation UI before \
                              the write hits disk)
  - read_media(path)         fetch an image (.png, .jpg, .jpeg, \
                              .gif, .webp, .svg, .avif) or PDF \
                              so you can inspect it
  - list_files()             enumerate every file in the workspace
  - resolve_path(path)       translate a chan path to a host \
                              filesystem path for shell tools
  - workspace_search(...)   bounded content/entity search and graph \
                              traversal across the workspace
  - repo_report(...)         per-file language / SLOC counts plus \
                              per-language roll-ups and a COCOMO \
                              cost estimate for the whole workspace \
                              (or a subdirectory or file list)
Use the tools rather than guessing at content. When you propose \
an edit, return the FULL new file content via write_file; partial \
diffs are not supported. Editable text includes markdown, plain \
text, source, config, and known text basenames such as Makefile; \
write_file refuses media and opaque binary paths. Images and PDFs \
stored alongside the notes are reachable via read_media but cannot \
be edited through these tools.

Paths: every content tool `path` argument is a POSIX path in chan's \
public namespace (no leading slash, no `..`, no host filesystem \
paths) and resolves under the workspace root. All paths are regular \
workspace content, including Cmd+N drafts, which live in a normal \
in-workspace directory (`.Drafts/` by default) and are addressed by \
their real relpath like any other file. Use resolve_path only when \
you need a real host path or shell cwd for a chan path. \
When you write markdown content, keep \
link and image hrefs relative to the file that contains them (the \
GitHub rendering convention) so links keep working when notes are \
viewed outside chan. The workspace's link normalizer accepts ./foo, \
../bar, /baz, or bare foo and resolves them all to the same \
workspace-rooted destination for the internal graph; the on-disk text \
stays as you wrote it.

Read-only files: some files in the workspace are marked read-only on \
disk (the user removed the user-write bit, or the file is \
otherwise locked). write_file on a read-only file will fail with \
a permission error. When the user asks for changes that span \
multiple files, skip any files you know to be read-only in your \
proposal: read them for context if helpful, mention in your \
summary that they were skipped because they're read-only, and \
focus your write_file calls on the writable ones. Don't ask for \
permission to write a read-only file; the answer is no.

Style: be concise. The user is in an editor, not a chat window. \
Match their tone. Don't repeat their question back at them. When \
proposing an edit, say briefly what you changed and why; the diff \
itself lives in the file content you wrote, not in a long prose \
explanation.";

/// Variant for backends without tool-calling support. Mentions the
/// workspace context but doesn't promise tool usage; the assistant
/// answers from the conversation transcript only.
pub const SYSTEM_PROMPT_NO_TOOLS: &str = "\
You are the chan writing assistant. The user has a markdown workspace \
open. You don't have tools to read or modify files in this turn; \
answer based on the conversation context and any content the user \
has pasted into the messages. Be concise.";

/// Per-session directive for external MCP-capable agents. These
/// agents have their own tool-use heuristics, and they tend to default
/// to a cautious
/// \"show the user the proposal and wait for confirmation\" mode
/// when run interactively; pasting the would-be file content as
/// a chat fence instead of emitting the actual `write_file` MCP
/// call. The directive overrides that for chan's host context:
/// chan ALWAYS surfaces a confirmation diff card, so the model
/// must emit the tool call directly and trust the host to gate
/// the write. Same shape works for read-only tools too (don't
/// pre-narrate a proposed read in chat; just call read_file).
pub const CLI_SESSION_DIRECTIVE: &str = "\
You are running inside chan, a host application that wraps your \
MCP write_file calls in its own write policy: the host may apply \
the write immediately, or it may defer it into a confirmation diff \
card the user reviews explicitly (Apply / Discard / Save-as). \
Because chan owns that approval surface, you must emit the MCP tool \
call directly; never paste the proposed file content into chat as \
a code fence and wait for verbal approval. If review is required, \
the diff card is the review surface.\n\n\
Operational rules for this session:\n\
  - When the user asks for a file change, call \
`mcp__chan__write_file` with the full revised content. Do not \
pre-narrate the proposal or ask permission first.\n\
  - If `mcp__chan__write_file` returns an error containing \
`awaiting_user_approval` or `deferred`, chan has received your \
proposal and is showing it to the user via the diff card. \
Confirm the proposal is in flight in ONE short sentence and \
STOP. Do not retry the tool, rephrase the proposal, paste the \
content as text, or propose alternatives.\n\
  - For investigation, prefer the MCP tools (`mcp__chan__read_file`, \
`mcp__chan__list_files`, `mcp__chan__workspace_search`, \
`mcp__chan__repo_report`, \
`mcp__chan__read_media`) over \
your own Read / Glob / Grep when the target is in the user's workspace; \
they go through chan-workspace's sandbox and graph index, which match the \
user's visible scope exactly.\n\
  - To run a shell command in a draft's directory, call \
`mcp__chan__resolve_path` to get the real host path. Drafts are \
ordinary files in the in-workspace `.Drafts/` directory.\n\
  - Even when the user explicitly says \"let me review\", \
\"don't auto-apply\", or \"show me the proposal first\", you \
should still emit the tool call. Those phrasings describe the \
host's diff-card UX; they are not a request to defer to a \
verbal exchange.";

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
