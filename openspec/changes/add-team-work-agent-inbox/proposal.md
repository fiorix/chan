## Why

Team Work currently has no durable-enough, agent-facing coordination path after
the filesystem watcher route was removed. Agents need a process-local retained
task inbox they can read through MCP after reconnecting, with live wake-up that
does not depend on browser WebSocket echo or frontend state.

## What Changes

- Add a volatile, process-local Agent inbox owned by `chan-server` and exposed
  to agents through `chan-llm` MCP tools.
- Add `send_agent_task(to, context_path)` for storing a retained task and
  best-effort poking live recipient PTYs with exactly `poke\n`.
- Add `list_agent_tasks(since_id?)` for the connected Team Work agent to read
  its own retained tasks with cursor metadata.
- Add Team Work routing identity through `CHAN_TEAM_NAME`, `CHAN_TAB_NAME`, and
  a private `chan __mcp-proxy` prelude consumed by `mcp_bridge`.
- Add validation for agent handles, team names, context paths, prelude shape,
  inbox parameters, and clear MCP errors without host path disclosure.
- Add `server.team_work.inbox_depth`, defaulting to `10` and sanitized to
  `1..=100`, with runtime updates applied to the active in-memory inbox.
- Update Team Work frontend bootstrap and prompts so agents use task files,
  exact MCP tool names, and the `poke` wake-up contract.
- **BREAKING**: remove stale SPA-side `agent_event_echo`, `agent_echo_since`,
  and `lastAgentEchoSeq` delivery paths, including terminal WebSocket
  `agent_echo_since` compatibility.

## Capabilities

### New Capabilities

- `team-work-agent-inbox`: MCP-exposed retained Agent tasks, Team Work routing
  identity, PTY poke wake-up, inbox retention, cursor listing, validation,
  configuration, and frontend bootstrap behavior.

### Modified Capabilities

- None.

## Impact

- `crates/chan-server`: add app-level inbox state, validation, retention,
  terminal poke dispatch, config plumbing, and MCP bridge identity handling.
- `crates/chan-llm`: add MCP tool schemas and provider interface while keeping
  standalone workspace tools available.
- `crates/chan`: update `__mcp-proxy` to emit the private identity prelude
  only when local Team Work identity is present and valid.
- `web/`: update Team Work bootstrap, env handling, prompts, and remove stale
  browser echo delivery state.
- `docs/`: update configuration and terminal/MCP documentation.
- Tests cover Rust inbox behavior, MCP errors, proxy prelude parsing, terminal
  routing, frontend Team Work env handling, prompts, and stale echo removal.
