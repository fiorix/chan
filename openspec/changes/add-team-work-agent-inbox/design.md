## Context

Team Work currently coordinates local agents through terminal sessions,
`CHAN_TAB_NAME`, MCP discovery variables, and a bootstrapped identity prompt.
The old filesystem watcher path was removed in Phase 13 r2, and the remaining
browser-side `agent_event_echo` path is stale. The replacement path must keep
coordination server-side, avoid frontend delivery state, and preserve the
Phase 5 boundary where `chan-llm` owns MCP while `chan-server` owns app state.

The accepted ADR is `docs/adr/0001-team-work-agent-inbox-over-mcp.md`. This
change refines that direction around Agent tasks, `send_agent_task`, and
`list_agent_tasks`, matching the glossary in `CONTEXT.md`.

## Goals / Non-Goals

**Goals:**

- Provide a volatile, process-local Agent inbox keyed by Team Work team and
  recipient agent handle.
- Let reconnecting agents read retained Agent tasks through MCP.
- Wake live recipients by writing exactly `poke\n` to matching PTYs after a
  task is stored.
- Keep tasks isolated by team and reject invalid routing identity before use.
- Keep `chan-llm` as the MCP server owner while `chan-server` implements the
  app-level inbox provider.

**Non-Goals:**

- No filesystem-backed inbox files or watcher directory.
- No browser-mediated inbox delivery, unread state, ack state, delete state,
  dedupe, roster, sent-task outbox, or frontend inbox display in v1.
- No cross-workspace task routing.
- No inline task body or file snapshot in the inbox. Tasks retain only a
  workspace-facing `context_path`.

## Decisions

### Server-Owned Inbox With MCP Provider Boundary

`chan-server` will add an app-level `agent_inbox` module and store the inbox in
`AppState`. The module owns retention, validation, global task ids, task
storage, and terminal poke dispatch. `chan-llm` will define the MCP tool schemas
and a small optional async `Send + Sync` provider trait. `mcp_bridge` will pass
provider and identity clones into `chan_llm::mcp::Server`.

This keeps filesystem and terminal concerns out of `chan-llm` while avoiding a
second agent-facing protocol. The rejected alternatives were reintroducing
watcher files, using browser WebSocket echo replay, or putting app state inside
`chan-llm`.

Inbox tools remain listed when the capability is compiled in. Availability is
checked at call time so standalone MCP connections keep workspace tools while
returning clear inbox errors.

### Spawn-Time Team Work Identity

Every bootstrapped Team Work member PTY gets system-owned
`CHAN_TEAM_NAME=<team>` and `CHAN_TAB_NAME=<@@Agent>`. `mcp_env=false` only
suppresses `CHAN_MCP_*` discovery variables and does not suppress Team Work
identity. Existing member env values for these keys are treated as legacy
routing identity and rewritten to canonical values on the next save or
bootstrap.

The advertised MCP proxy command will emit a private prelude before MCP traffic
only when both identity values are present and locally valid:

```text
CHAN-MCP-PROXY 1 {"team":"alpha","agent":"@@FullStackA"}
```

`mcp_bridge` strips and validates this line before handing the stream to
`chan-llm`. Non-prelude bytes are replayed into the MCP stream so direct socket
clients remain compatible. Reserved-prefix malformed prelude lines are consumed
and continue as workspace-tools-only connections. Prelude detection is bounded
by a short timeout or first-byte availability.

Routing identity is captured when the PTY is spawned or restarted. Later UI tab
renames do not affect inbox routing until restart.

### Volatile Retention Model

The inbox is process-local and app-owned. Restarting `chan serve` loses all
retained tasks. Tasks are keyed by `(team, recipient_agent)`, with the sender
stored as metadata. Multiple live terminals sharing the same team and agent
handle share one retained inbox, while each agent process owns its own cursor.

Task ids are global per process, monotonically increasing `u64` values starting
at `1`. Overflow fails sends rather than wrapping. Retained order is ascending
by id, and critical sections stay short by cloning retained tasks under the
inbox lock and building MCP responses outside the lock.

Retention depth is configured by `server.team_work.inbox_depth`, default `10`,
sanitized to `1..=100`. Runtime config changes update the active inbox object in
place so existing provider clones observe the new depth. Shrinking depth evicts
excess retained tasks per inbox key.

### Task Shape And Path Boundary

Each task stores `id`, `from`, `to`, `context_path`, and
`created_at_unix_ms`. The stored path is workspace-facing and canonicalized
through the same readable workspace boundary as MCP file tools, including
supported virtual namespaces. Host paths and resolved physical metadata are
never exposed.

`send_agent_task` requires one recipient and one non-empty JSON string
`context_path`. The sender comes from the MCP connection identity, not caller
params. The context path must resolve to an existing regular readable workspace
file at send time. Later deletion or movement does not hide or mutate retained
tasks.

The inbox does not create files, snapshot contents, validate a task-file schema,
or restrict tasks to markdown. Binary or media files are rejected by the text
workspace boundary; use a text task file to point at media.

### Poke Delivery

On send, the task is stored before any poke is attempted. The inbox then asks
the terminal registry to write exactly `poke\n` to every live, non-closed PTY
with spawn-time Team Work identity matching the recipient team and handle.

Poke is best-effort. Missing terminals, closed terminals, failed writes, or
terminal wake-up unavailability do not fail the send because the retained inbox
is the source of truth. The inbox lock is not held while poking. Failed poke
writes may be debug logged but do not appear in the MCP result.

Starting or reconnecting a PTY does not automatically poke for retained tasks.
Agents catch up by calling `list_agent_tasks` on startup.

### MCP Listing, Cursors, And Errors

`list_agent_tasks` has no recipient parameter. It always reads the connected
agent's own shared inbox derived from MCP Team Work identity. The response
includes canonical `team` and `agent` fields, `oldest_retained_id`,
`latest_id`, and `tasks`.

Without `since_id`, or with `since_id: null`, listing returns the current
retained inbox. With `since_id`, listing returns retained tasks with
`id > since_id`. `since_id` is only a numeric cursor and is not checked for
membership in the inbox. Gaps caused by retention are detected from
`oldest_retained_id` and `latest_id`, not returned as errors.

Inbox MCP errors are clear and do not include absolute host paths. Unavailable
checks run in this order: provider, team identity, agent identity.

### Frontend And Prompt Scope

The Team Work dialog requires canonical `@@Name` agent handles. It does not
auto-prefix member names, and the legacy `auto_prefix_at` field must not repair
non-canonical handles. Duplicate member handles are allowed and mean shared
Agent inbox identity; the UI may warn but must not block them.

Bootstrap injects `CHAN_TEAM_NAME` and `CHAN_TAB_NAME` into every member env in
persisted `chan-team.toml` and actual terminal spawn or restart requests. It
requires exactly one lead row as the bootstrap anchor, not as a uniqueness
constraint for that handle.

The Team Work identity prompt and MCP-facing guidance must name
`send_agent_task` and `list_agent_tasks`, require creating or updating a
workspace task file before handoff, and explain that a standalone `poke` means
the agent should list tasks over MCP.

The old SPA-side `agent_event_echo`, `agent_echo_since`, and
`lastAgentEchoSeq` paths are removed. Normal user-driven terminal broadcast
remains in scope but is not used for inbox poke delivery.

## Risks / Trade-offs

- Volatile process-local storage can lose retained tasks on server restart.
  Mitigation: v1 explicitly stores only pointers to workspace task files, and
  agents are instructed to create or update the task file before sending.
- Best-effort poke can be missed. Mitigation: sends succeed only after storing
  the retained task, and agents call `list_agent_tasks` on startup to catch up.
- Duplicate team names intentionally share a team bus. Mitigation: team names
  are validated, preserved exactly, documented, and the UI can derive an
  initial name for new configs while loaded configs keep persisted names.
- Duplicate agent handles share one inbox. Mitigation: this is explicit domain
  behavior; the UI may warn but does not block duplicate handles.
- Prelude detection could delay direct MCP clients. Mitigation: detection is
  bounded by a short timeout or first-byte availability, and non-prelude bytes
  are replayed.
- Runtime depth shrink can evict tasks immediately. Mitigation: depth changes
  apply consistently to the active inbox and retained metadata lets agents
  detect cursor gaps.

## Migration Plan

1. Add shared validation helpers for Team Work agent handles, team names,
   prelude fields, and inbox MCP params.
2. Implement `chan-server` inbox state, retention, config updates, and terminal
   registry poke dispatch.
3. Add the `chan-llm` MCP tools and optional provider interface.
4. Update `mcp_bridge` and every advertised MCP proxy command for Team Work
   identity prelude handling and workspace-tools-only fallback.
5. Update Team Work frontend config handling, bootstrap env injection, prompts,
   and remove stale browser echo delivery paths.
6. Update docs and tests.

Rollback is limited to reverting this change before release. The inbox is
volatile and introduces no on-disk task store migration.

## Open Questions

None. The v1 scope intentionally excludes persistent inbox state, roster
membership, ack state, delete state, frontend display, and sent-task outboxes.
