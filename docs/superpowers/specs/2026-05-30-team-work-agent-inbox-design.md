# Team Work Agent Inbox Design

## Context

Team Work currently relies on terminal sessions, `CHAN_TAB_NAME`, MCP
discovery variables, and a bootstrapped identity prompt. The old filesystem
event watcher path was removed in Phase 13 r2, and the remaining
`agent_event_echo` frontend code is stale. The new coordination path must not
reintroduce watcher files or browser-mediated delivery.

The accepted ADR is `docs/adr/0001-team-work-agent-inbox-over-mcp.md`.
Glossary terms live in `CONTEXT.md`.

## Goals

- Provide a volatile, process-local Team Work message bus.
- Let a reconnecting agent read retained messages through MCP.
- Wake live recipients by writing a minimal `poke\n` line to their PTY.
- Keep messages isolated by team, so matching handles in different teams do not
  share messages or pokes.
- Avoid frontend display, unread state, ack state, deletion, dedupe, and
  filesystem-backed message files in v1.

## Architecture

Use the MCP inbox plus server-side terminal poke approach.

`chan-server` gets an app-level `agent_inbox` module. It owns the volatile
store, global message ids, validation, configured retention depth, and terminal
poke dispatch. It depends on the terminal registry for live PTY wake-up.

`chan-llm` remains the MCP server owner. It defines:

- `send_agent_message(to, body, context_path?) -> { id }`
- `list_agent_messages(since_id?) -> { team, agent, oldest_retained_id,
  latest_id, messages }`
- A small optional inbox provider trait used by the MCP methods.

`mcp_bridge` passes an optional team identity, optional agent identity, and the
inbox provider into `chan_llm::mcp::Server`. Standalone MCP connections keep
workspace tools available, while inbox tools fail clearly if the team identity,
agent identity, or inbox provider is unavailable.

## Identity

Every bootstrapped Team Work member PTY receives:

- `CHAN_TEAM_NAME=<team_name>`
- `CHAN_TAB_NAME=<agent_handle>`

`chan __mcp-proxy` reads both env vars and sends a private prelude before MCP
traffic:

```text
CHAN-MCP-PROXY 1 {"team":"alpha","agent":"@@FullStackA"}
```

`mcp_bridge` strips and validates this line before handing the stream to
`chan-llm`. If the line is missing or invalid, non-prelude bytes are replayed
into the MCP stream so direct socket clients remain compatible.

## Storage Model

The store is process-local and volatile. Restarting `chan serve` loses all
messages.

Messages are keyed by `(team, recipient_agent)`. The store keeps the latest
`team_work.inbox_depth` messages per key, default `10`, sanitized to `1..=100`.

Message ids are global per process and monotonically increasing `u64` values.
Ids are not scoped by team or agent.

Each message has:

- `id`
- `from`
- `to`
- `body`
- optional `context_path`
- `created_at_unix_ms`

## Data Flow

1. `@@Architect` in team `alpha` calls `send_agent_message`.
2. `chan-llm` verifies the MCP connection has team identity, agent identity, and
   an inbox provider.
3. `chan-server` validates the recipient, body, and optional context path.
4. The inbox appends the message to `(alpha, @@FullStackA)` and evicts old
   messages beyond the configured depth.
5. The inbox asks the terminal registry to write `poke\n` to every live PTY with
   spawn-time `CHAN_TEAM_NAME=alpha` and `CHAN_TAB_NAME=@@FullStackA`.
6. The recipient agent sees `poke`, calls `list_agent_messages`, and reads its
   retained inbox.

Poke is best-effort. Failure to find or write to a live terminal does not fail
the send because the retained inbox is the source of truth inside the process.

## Cursor Semantics

`list_agent_messages` without `since_id` returns the currently retained inbox,
oldest to newest.

`list_agent_messages` with `since_id` returns retained messages with
`id > since_id`.

The response includes `oldest_retained_id` and `latest_id`. Agents can store
`latest_id` as their next cursor and can detect when their prior cursor is older
than the retained window.

There is no ack, unread, or delete state in v1.

## Validation And Errors

Agent handles are trimmed and auto-prefixed with `@@` if missing. Empty
handles, whitespace-only handles, `/`, NUL, and control characters are rejected.
Routing is case-sensitive.

Team names are trimmed and must be non-empty. They must not contain `/`, NUL, or
control characters.

Message bodies are inline UTF-8 text capped at `24 KiB`.

`context_path` is optional, workspace-relative, POSIX-style, syntactically
valid, and not required to exist. Absolute paths, `..` escapes, NUL, and control
junk are rejected.

Inbox MCP tools return clear errors:

- `team identity unavailable`
- `agent identity unavailable`
- `agent inbox unavailable`
- invalid params for validation failures

Sending to unknown or offline agents is accepted and retained until evicted.

## Config

Add `team_work.inbox_depth` to `ServerConfig`.

Default: `10`.

Sanitized range: `1..=100`.

No Settings UI is required in v1. The field is documented in
`docs/config-reference.md`.

## Guidance

The poke contract is explicit guidance. MCP-facing instructions and the Team
Work identity prompt tell agents:

```text
When terminal input contains a standalone `poke`, call
`list_agent_messages` over MCP.
```

This avoids injecting semantic commands into the PTY.

## Frontend Scope

Team bootstrap must inject `CHAN_TEAM_NAME` into every member env alongside
`CHAN_TAB_NAME`.

The Team Work identity prompt must include the poke contract.

The old SPA-side `agent_event_echo`, `agent_echo_since`, and
`lastAgentEchoSeq` paths should be removed or replaced as part of this change.
New delivery is server-side PTY input, not browser WebSocket echo replay.

No frontend inbox display is part of v1.

## Testing

Rust tests:

- Validate agent handles, team names, body cap, and context paths.
- Retain only `inbox_depth` messages per `(team, agent)`.
- Keep global ids monotonic across teams.
- Return correct `since_id`, `oldest_retained_id`, and `latest_id` behavior.
- Accept sends to offline agents.
- Poke all matching PTYs and no PTYs from other teams.
- MCP inbox tools fail cleanly without team, agent, or provider.
- Proxy prelude parsing strips valid prelude lines and replays non-prelude
  bytes.

Frontend tests:

- Team bootstrap writes `CHAN_TEAM_NAME`.
- Env round-tripping keeps `CHAN_TEAM_NAME` and `CHAN_TAB_NAME` out of the
  visible custom-env field unless the user explicitly supplied overrides.
- Identity prompt includes the poke contract.

Docs:

- Update `docs/config-reference.md`.
- Update `docs/manual/terminal-and-mcp.md`.
