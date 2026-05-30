# chan-llm design

`chan-llm` is now the MCP-facing tool sandbox for chan workspaces. It
does not own an in-app chat session, transcript persistence, local
agent subprocess management, or app settings. Those surfaces were
removed in phase 5 with the editor Agent UI.

## Scope

In scope:

  - Shared prompt and tool descriptions for chan workspace access.
  - Direct tool dispatch through `tools::execute`.
  - MCP stdio / async-I/O hosting behind the optional `mcp` feature.
  - Media reads for MCP clients, capped by server policy.
  - Team Work identity validation and MCP proxy prelude
    parsing/formatting shared by MCP hosts and proxy commands.
  - Typed error passthroughs for chan-workspace write conflicts,
    write-size limits, listing limits, and refused paths.

Out of scope:

  - HTTP routes, WebSocket events, and frontend state.
  - API key storage and model/provider configuration.
  - Agent transcript/history storage.
  - Spawning or supervising model CLIs.

## Architecture

```
MCP client / host
        |
        v
chan_llm::mcp::Server  -- feature "mcp"
        |
        v
chan_llm::tools::execute
        |
        v
chan_workspace::Workspace
```

`mcp::Server` owns a `ToolContext`, which is just an `Arc<Workspace>`.
Each JSON tool call goes through `tools::execute`. MCP handlers run
workspace work on `spawn_blocking` so synchronous chan-workspace reads,
writes, graph, search, and report work do not pin the async transport
worker. The MCP-only `read_media` path still reads through
`Workspace::read`, so it keeps the same path sandbox and regular-file
checks that the editor uses.

`serve_stdio` is used by the standalone `chan-llm-mcp` binary and by
`chan __mcp`. `serve_io` is used by chan-server's MCP bridge: the
server already holds the workspace lock, so it hosts the MCP service
in-process over a Unix-domain socket and lets child processes proxy
stdio to that socket.

## Tools

Text tools are defined as `StandardTool` and dispatched by name:

  - `read_file`
  - `write_file`
  - `list_files`
  - `search_content`
  - `repo_report`
  - `graph_neighbors`
  - `graph_tags`
  - `graph_files_with_tag`

`read_media` is exposed only by the MCP server because it returns
MCP image content blocks or embedded PDF blob resources rather than
a JSON text result. Supported media matches chan-workspace's Image and
Pdf classes: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`,
`.avif`, and `.pdf`.

Writes are full-file replacements. `write_file` accepts
`expected_mtime_ns` for compare-and-swap semantics and maps
chan-workspace conflicts into `LlmError::WriteConflict`.

## Configuration

The library has no model/provider config. MCP media size is server
policy:

  - default: `DEFAULT_MCP_MEDIA_MAX_BYTES` (10 MiB)
  - override: `Server::with_max_media_bytes(bytes)`
  - standalone binary: `--max-media-bytes <N>`

`chan-llm-mcp --config <path>` points at the chan-workspace registry
config, not an LLM settings file.

## Error Boundary

`LlmError` is intentionally small:

  - `Tool`
  - `Core`
  - `WriteConflict`
  - `WriteTooLarge`
  - `ListingTooLarge`
  - `PathRefused`
  - `Io`
  - `Mcp`

Public error variants stay matchable for hosts while preserving the
original chan-workspace display text for user-facing messages.
