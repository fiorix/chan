# Team Work Agent Inbox Over MCP

Accepted. Team Work agent messages will be exposed to agents through the chan
MCP server, rather than through a separate control socket or filesystem watcher
directory. Agents already discover chan through `CHAN_MCP_*`, and the inbox is
an agent-facing coordination surface, so MCP keeps workspace tools and local
Team Work coordination available through one agent connection.

## Consequences

`chan-server` owns the agent inbox store and must pass per-connection team and
agent identity into the MCP server. `chan-llm` is no longer
workspace-tools-only when hosted by `chan-server`; standalone MCP mode may omit
inbox tools or require explicit team and agent identity.

Sending a message stores it first, then best-effort wakes a live recipient
terminal with a minimal `poke` line. The poke is only a wake-up signal. Agents
read message contents by calling `list_agent_messages` over MCP, which keeps
delivery replayable after a Codex reconnect while avoiding filesystem watcher
state.

The inbox is keyed by team bus and agent handle, not terminal session id. If
multiple live terminals have the same spawn-time `CHAN_TEAM_NAME` and
`CHAN_TAB_NAME`, they share one inbox and a send to that handle pokes all
matching live terminals. Matching handles in different team buses do not share
messages or pokes.

`chan-llm` remains the MCP server owner. It defines the inbox tool schemas and a
small optional inbox capability interface. `chan-server` implements that
interface with the volatile store, configured depth, global message ids,
validation, and terminal poke routing. Standalone MCP connections keep workspace
tools working; inbox tools fail with a clear unavailable error when no team
identity, agent identity, or inbox provider was supplied.

The poke contract is explicit guidance, not hidden protocol magic. MCP-facing
instructions and the Team Work identity prompt tell agents that a standalone
`poke` in the terminal means they should call `list_agent_messages` over MCP.

Team bootstrap exports both `CHAN_TEAM_NAME` and `CHAN_TAB_NAME` into each
member PTY. `chan __mcp-proxy` sends a private prelude line before MCP traffic:
`CHAN-MCP-PROXY 1 {"team":"alpha","agent":"@@Name"}\n`. The server-side bridge
strips and validates that line before handing the stream to `chan-llm`. If the
prelude is missing or invalid, the MCP connection still serves workspace tools,
but inbox tools fail with `team identity unavailable` or
`agent identity unavailable`. Non-prelude bytes are replayed into the MCP stream
so direct socket clients remain compatible.

`list_agent_messages` is cursor-based but has no ack state. Without `since_id`,
it returns the currently retained inbox oldest to newest. With `since_id`, it
returns retained messages where `id > since_id`. The response includes
`oldest_retained_id` and `latest_id` so reconnecting agents can store a next
cursor and can tell when their cursor is older than the retained window.
Messages include `id`, `from`, `to`, `body`, optional `context_path`, and
`created_at_unix_ms`.
