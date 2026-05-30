## 1. Validation And Configuration

- [x] 1.1 Add Team Work validation helpers for canonical agent handles, team
  names, and MCP proxy prelude fields, and use them at every routing boundary
- [x] 1.2 Add `server.team_work.inbox_depth` to server config with default
  `10`, sanitized range `1..=100`, and `chan config get/set` support
- [x] 1.3 Add runtime config update plumbing so active inbox provider clones
  observe depth changes and depth shrink evicts old retained tasks

## 2. Server Inbox Core

- [x] 2.1 Add `crates/chan-server/src/agent_inbox.rs` with task types, team
  and recipient keys, process-global monotonic ids, and per-key retention
- [x] 2.2 Implement context path validation through the existing workspace
  readable-file boundary, including canonical stored paths and safe errors
- [x] 2.3 Implement send behavior that derives `from` from MCP identity, stores
  task metadata, accepts offline and self recipients, and returns only `{ id }`
- [x] 2.4 Implement list behavior for the connected agent inbox, including
  `since_id`, empty inbox metadata, retained-window gaps, and future cursors
- [x] 2.5 Add server inbox tests for validation, ids, retention, cursor
  semantics, offline sends, self-sends, duplicate sends, and safe error text

## 3. Terminal Poke Delivery

- [x] 3.1 Extend terminal session state or registry metadata to retain
  spawn-time Team Work identity separately from later UI tab names
- [x] 3.2 Implement exact `poke\n` writes through the normal terminal input path
  to every live, non-closed PTY matching the task team and recipient handle
- [x] 3.3 Ensure task storage happens before poke attempts and the inbox lock is
  not held while poking terminals
- [x] 3.4 Add tests for all matching PTYs, no cross-team pokes, offline
  recipients, poke write failures, no browser WebSocket attachment, and no
  automatic poke on reconnect

## 4. MCP Tool Integration

- [x] 4.1 Add the optional async `Send + Sync` Agent inbox provider trait and
  `send_agent_task` / `list_agent_tasks` tool schemas to `chan-llm`
- [x] 4.2 Implement MCP param validation, canonical response shapes, and call
  time unavailable checks in provider, team identity, agent identity order
- [x] 4.3 Wire `chan-server` AppState inbox provider and per-connection Team
  Work identity through `mcp_bridge` into `chan_llm::mcp::Server`
- [x] 4.4 Add MCP tests for successful sends and lists, standalone provider
  absence, missing identity, invalid params, and workspace tool availability

## 5. MCP Proxy Prelude And Team Identity

- [x] 5.1 Update Team Work bootstrap to persist and spawn `CHAN_TEAM_NAME` and
  canonical `CHAN_TAB_NAME`, rewrite legacy identity env values, and keep these
  values when `mcp_env=false`
- [x] 5.2 Update every advertised MCP proxy command to emit the version `1`
  private prelude only when both Team Work identity env vars are present and
  valid
- [x] 5.3 Implement bounded `mcp_bridge` prelude detection that strips valid
  prelude lines, replays non-prelude bytes, and consumes malformed reserved
  prelude attempts as workspace-tools-only connections
- [x] 5.4 Add Rust tests for proxy prelude emission from every advertised MCP
  proxy command, silent omission, strict schema validation, bounded detection,
  byte replay, and malformed reserved prelude consumption. Desktop coverage must
  assert the proxy writes the prelude bytes before forwarded MCP/stdin bytes,
  not only that the hidden command exists.

## 6. Team Work Frontend And Prompting

- [x] 6.1 Update Team Work config loading and dialog validation to require
  canonical `@@Name` member handles and reject non-canonical legacy configs
  instead of repairing them
- [x] 6.2 Ensure new saves and bootstrap writes keep system-owned identity env
  out of visible custom env and set legacy `auto_prefix_at` to `false` if the
  field remains in the wire schema
- [x] 6.3 Add or update team name validation, initial team-name derivation for
  new configs, duplicate handle warning behavior, and exactly-one-lead
  bootstrap validation
- [x] 6.4 Update Team Work identity prompt text to include exact tool names,
  path-only Agent task guidance, startup listing, cursor storage guidance, and
  the standalone `poke` contract
- [x] 6.5 Add frontend tests for env round-tripping, canonical handle
  validation, duplicate handles, lead validation, prompt content, and duplicate
  teammate handles listed once

## 7. Remove Browser Echo Delivery

- [x] 7.1 Remove SPA-side `agent_event_echo`, `agent_echo_since`, and
  `lastAgentEchoSeq` code paths, serialized session fields, and tests that only
  preserve stale behavior
- [x] 7.2 Remove `agent_echo_since` from terminal WebSocket URL construction and
  handling while preserving normal user-driven terminal broadcast behavior
- [x] 7.3 Verify no HTTP inbox API or frontend inbox display is added for v1

## 8. Documentation And Verification

- [x] 8.1 Update `docs/config-reference.md` with
  `server.team_work.inbox_depth`
- [x] 8.2 Update `docs/manual/terminal-and-mcp.md` with Team Work MCP inbox
  tools, identity prelude behavior, retained task listing, and poke contract
- [x] 8.3 Run OpenSpec validation for `add-team-work-agent-inbox`
- [x] 8.4 Run Rust formatting, clippy, and relevant Rust tests
- [x] 8.5 Run relevant frontend checks and tests for Team Work UI and terminal
  behavior
