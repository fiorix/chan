# chan-llm

MCP server and tool sandbox for exposing a chan workspace to local agent tools. Filesystem access routes through `chan-workspace`, so the path sandbox, special-file refusal, atomic writes, and editable-text gate apply to every tool call.

The supported integration point is MCP; the crate has no in-app chat or agent-session surface.

## Add to your project

```toml
[dependencies]
chan-llm = "0.33"

# Optional: stdio MCP server module + the `chan-llm-mcp` binary.
# Pulls rmcp + schemars; off by default.
chan-llm = { version = "0.33", features = ["mcp"] }
```

## Public API

```text
StandardTool         ReadFile | WriteFile | ListFiles | ResolvePath |
                     WorkspaceSearch | RepoReport
ToolContext          { workspace: Arc<Workspace> }
ToolOutcome          Ok(json)
tools::execute(name, args, &ctx) -> Result<ToolOutcome>

prompts::*           Shared tool descriptions.

feature "mcp":
  mcp::Server::new(Arc<Workspace>)
  mcp::Server::with_max_media_bytes(bytes)
  mcp::Server::serve_stdio()
  mcp::Server::serve_io(reader, writer)
```

`read_media` is MCP-only. Text tools are also available through `tools::execute` for tests and hosts that need direct dispatch.

## Contacts and the graph

chan-workspace maintains a sqlite link graph next to every workspace (nodes, edges, headings, tags, contacts). The editor uses it for the `[[` link picker, the `@` contact picker, chip rendering, and the graph view. MCP exposes a single `workspace_search` tool unifying note-relationship (graph) traversal and BM25 content discovery; typed contact APIs stay in chan-workspace.

From an agent's perspective:

  - **"Find Alice"**: `workspace_search` with query `Alice` (content and entity results).
  - **"What contacts do I have?"**: `list_files` with a prefix that matches the contacts directory, then `read_file` on interesting hits.
  - **"What links to this contact?"**: `workspace_search` from a typed contact selector with bidirectional traversal.

## Build and test

```bash
cargo build -p chan-llm
cargo test  -p chan-llm
cargo build -p chan-llm --features mcp
```

## Design reference

See [`design.md`](design.md) for the current MCP boundary and tool-sandbox invariants.

## License

Apache-2.0.
