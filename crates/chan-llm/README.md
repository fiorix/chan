# chan-llm

MCP server and tool sandbox that exposes a chan workspace to coding agents. Filesystem access routes through `chan-workspace`, so the path sandbox, special-file refusal, atomic writes and editable-text gate apply to every tool call.

The supported integration point is MCP; the crate has no in-app chat or agent-session surface, and chan writes no agent's configuration.

## Add to your project

Inside this repository the crate is a workspace dependency:

```toml
[dependencies]
chan-llm = { workspace = true }

# Optional: the MCP server module and the `chan-llm-mcp` binary.
# Pulls rmcp; off by default.
chan-llm = { workspace = true, features = ["mcp"] }
```

## Public API

```text
StandardTool         ReadFile | WriteFile | ListFiles | ResolvePath |
                     WorkspaceSearch | RepoReport
ToolContext::new(Arc<Workspace>)
tools::execute(name, args, &ctx) -> Result<Json>

prompts::*           Shared tool descriptions.

feature "mcp":
  mcp::Server::new(Arc<Workspace>)
  mcp::Server::from_resolver(|| Option<Arc<Workspace>>)
  mcp::Server::with_max_media_bytes(bytes)
  mcp::Server::serve_stdio()
  mcp::Server::serve_io(reader, writer)
```

`read_media` is MCP-only. The text tools are also reachable through `tools::execute` for tests and hosts that dispatch directly.

Contacts, tags, mentions and links are reached through the single `workspace_search` tool, which wraps chan-workspace's unified search; `read_file` reads the selected note.

## Build and test

```bash
cargo build -p chan-llm
cargo test  -p chan-llm
cargo build -p chan-llm --features mcp
```

## Design reference

See [`design.md`](design.md) for the MCP boundary, workspace ownership, the tool caps and cancellation.

## License

Apache-2.0.
