# Team Work Agent Task Inbox Design

## Context

Team Work currently relies on terminal sessions, `CHAN_TAB_NAME`, MCP
discovery variables, and a bootstrapped identity prompt. The old filesystem
event watcher path was removed in Phase 13 r2, and the remaining
`agent_event_echo` frontend code is stale. The new coordination path must not
reintroduce watcher files or browser-mediated delivery.

The accepted ADR is `docs/adr/0001-team-work-agent-inbox-over-mcp.md`.
Glossary terms live in `CONTEXT.md`.
The inbox container name remains Agent inbox; the retained item is an Agent
task.

## Goals

- Provide a volatile, process-local Team Work task bus.
- Let a reconnecting agent read retained tasks through MCP.
- Wake live recipients by writing a minimal `poke\n` line to their PTY.
- Keep tasks isolated by team, so matching handles in different teams do not
  share tasks or pokes.
- Avoid frontend display, unread state, ack state, deletion, dedupe, and
  filesystem-backed inbox files in v1.

## Architecture

Use the MCP inbox plus server-side terminal poke approach.

`chan-server` gets an app-level `agent_inbox` module. It owns the volatile
in-memory inbox, global task ids, validation, configured retention depth, and
terminal poke dispatch. It depends on the terminal registry for live PTY
wake-up.
The app holds the inbox as AppState-owned process state and passes a provider
clone into the MCP bridge.
`chan-llm` checks MCP parameter shape and whether Team Work identity/provider
are present, but the inbox provider performs Team Work validation and returns
canonical retained results.

`chan-llm` remains the MCP server owner. It defines:

- `send_agent_task(to, context_path) -> { id }`
- `list_agent_tasks(since_id?) -> { team, agent, oldest_retained_id,
  latest_id, tasks }`
- A small optional async, `Send + Sync` inbox provider trait used by the MCP
  methods.

`list_agent_tasks` has no recipient parameter. It always reads the connected
agent's own shared agent inbox, derived from the MCP connection's Team Work
identity.
The `team` and `agent` response fields are the canonical MCP connection
identity, not inferred from returned tasks.
`send_agent_task` accepts exactly one recipient. Multi-recipient sends are done
by multiple calls.
The `to` parameter is required; missing or `null` recipients are invalid params.
The `context_path` parameter is required and must be a non-empty JSON string;
missing, `null`, empty, or non-string values are invalid params.
There is no sent-task outbox in v1.

`mcp_bridge` passes an optional team identity, optional agent identity, and the
inbox provider into `chan_llm::mcp::Server`. Standalone MCP connections keep
workspace tools available, while inbox tools fail clearly if the team identity,
agent identity, or inbox provider is unavailable.

When the inbox capability is compiled in, the inbox tools stay in the MCP tool
list for every connection. Availability is enforced at call time with clear
errors rather than by hiding tools from connections without Team Work identity.

## Identity

Every bootstrapped Team Work member PTY receives:

- `CHAN_TEAM_NAME=<team_name>`
- `CHAN_TAB_NAME=<agent_handle>`

Non-Team-Work terminals do not receive `CHAN_TEAM_NAME`.

The terminal `mcp_env=false` option only suppresses `CHAN_MCP_*` discovery
variables. It does not suppress Team Work identity.

Team bootstrap persists both values into each `chan-team.toml` member env as
system-owned identity. On load, existing values for these keys are treated as
legacy routing identity, not custom environment values; the next save/bootstrap
rewrites them to the canonical team and agent identity.

`chan __mcp-proxy` reads both env vars and sends a private prelude before MCP
traffic:

```text
CHAN-MCP-PROXY 1 {"team":"alpha","agent":"@@FullStackA"}
```

Prelude version `1` has a strict JSON schema: exactly string fields `team` and
`agent`. Extra fields are invalid; future fields require a prelude version bump.

The proxy emits this prelude only when both identities are present and locally
valid. If either identity is missing or invalid, the proxy emits no prelude and
keeps today's byte-for-byte MCP piping behavior.
Prelude omission by the proxy is silent in v1; it does not print warnings to
stderr.
The agent identity in the prelude must already be a canonical agent handle and
uses the same validation rules as `send_agent_task`.

`mcp_bridge` strips and validates this line before handing the stream to
`chan-llm`. If the first bytes are not a prelude attempt, they are replayed into
the MCP stream so direct socket clients remain compatible. If the first line
uses the reserved `CHAN-MCP-PROXY ` prefix but has an unknown version, invalid
JSON, invalid schema, or invalid identity, the bridge consumes that line and
continues as a workspace-tools-only connection.
Prelude detection is bounded by a short timeout or first-byte availability; the
bridge must not wait indefinitely for identity before starting normal MCP
handling.

The routing identity is captured when the PTY is spawned or restarted. Later UI
tab renames do not change inbox routing until the PTY restarts with a new Team
Work identity.

## Storage Model

The in-memory inbox is process-local, app-owned, and volatile. Each
`chan-server` app instance/workspace owns its own inbox. Restarting `chan serve`
loses all tasks.

The team bus id is the validated team name. Two live Team Work launches using
the same team name share one team bus; use a distinct team name when tasks
must be isolated.
For new Team Work configs, the UI may derive the initial `team_name` from the
`chan-team.toml` parent directory, and the derived name must pass the same
team-name validation. For loaded configs, the persisted `team_name` is the
source of truth; moving or copying `chan-team.toml` does not change the team bus
id. Invalid team names fail load/bootstrap with a clear message; they are not
slugified or repaired.

Tasks are keyed by `(team, recipient_agent)`. Sender is task metadata, not part
of the retention key. The in-memory inbox keeps the latest
`team_work.inbox_depth` tasks per key, default `10`, sanitized to `1..=100`.
Self-sent tasks count against the same recipient inbox retention depth.

There is no roster in v1. Recipient identity is just a validated agent handle
inside the sender's team bus. Live terminals are used only for best-effort poke
fan-out, not as membership authority.
When multiple live terminals share a team and agent handle, they share the same
retained inbox, but each agent process maintains its own cursor. The server does
not track per-terminal read state.

Task ids are global per process and monotonically increasing `u64` values.
Ids start at `1`, are not scoped by team or agent, and are serialized as JSON
numbers.
Id overflow must fail the send rather than wrap.
The implementation may allocate ids under the inbox lock or with an atomic
counter, but retained inbox order must remain ascending by id.
In-memory inbox critical sections stay short: clone/list retained tasks under
the inbox lock, then build MCP responses outside the lock.

Each task has:

- `id`
- `from`
- `to`
- `context_path`
- `created_at_unix_ms`

The wire field is `id`; documentation and tests may refer to it as the task id.
Tasks keep both `from` and `to` even though the inbox key already includes
the recipient, so retained results are self-describing.
`created_at_unix_ms` is wall-clock metadata captured when the task is
appended and serialized as a JSON number. Task ordering and cursors use `id`,
not timestamps.
The inbox retains only `context_path`; it does not snapshot or retain file
contents.
The regular-file existence check happens only when sending. Later deletion or
movement of the file does not hide or mutate retained tasks.
There is no dedupe in v1. Repeated sends to the same `context_path` create
separate tasks with separate ids.

## Data Flow

1. `@@Architect` in team `alpha` calls `send_agent_task`.
2. `chan-llm` verifies the MCP connection has team identity, agent identity, and
   an inbox provider.
3. `chan-server` validates the recipient and required context path.
4. The inbox appends the task to `(alpha, @@FullStackA)` and evicts old tasks
   beyond the configured depth.
5. The inbox asks the terminal registry to write `poke\n` directly to every
   live PTY with spawn-time Team Work identity `(alpha, @@FullStackA)`.
6. The recipient agent sees `poke`, calls `list_agent_tasks`, and reads its
   retained inbox.

Matching live, non-closed PTYs are poked even when no browser WebSocket is
attached.
The task is always stored before any poke is attempted.
The inbox lock is not held while poking terminals.
Pokes are sent only when a task is created. Starting or reconnecting a PTY does
not automatically poke for already-retained tasks; agents catch up by calling
`list_agent_tasks`.

The poke write is exactly `poke\n`. It does not include submit chords, routing
metadata, or task content. Poke is best-effort. Failure to find or write to
a live terminal does not fail the send because the retained inbox is the source
of truth inside the process.
If the in-memory inbox is available but terminal wake-up is unavailable, the
task is still retained and the send succeeds.
Poke writes use the normal terminal input path and keep the PTY session active,
but they do not create unread state, ack state, or any separate frontend
notification.
Failed poke writes may be logged at debug level. They do not change the
`send_agent_task` result.

## Cursor Semantics

`list_agent_tasks` without `since_id`, or with `since_id: null`, returns the
currently retained inbox, oldest to newest by task id.

`list_agent_tasks` with `since_id` returns retained tasks with
`id > since_id`, oldest to newest by task id.
`since_id` is treated as a numeric cursor only; the server does not check
whether that id belongs to this inbox or any other inbox.
`since_id=0` is accepted and returns all currently retained tasks for the
inbox.
Non-integer, negative, or out-of-range `since_id` values are invalid params.

The response includes `oldest_retained_id` and `latest_id`. Agents can store
`latest_id` as their next cursor and can detect when their prior cursor is older
than the retained window.
Both fields describe the connected agent's retained inbox, not the process-
global task id range.
The retained item array is named `tasks`. There is no `messages` alias in v1.

For an empty retained inbox, `oldest_retained_id` and `latest_id` are present as
`null`, `tasks` is `[]`, and `team` and `agent` are still returned.

If `since_id` is older than the retained window, the call still returns retained
tasks newer than `since_id` rather than an error. The caller detects the gap
from `oldest_retained_id` and `latest_id`.
If `since_id` is newer than `latest_id`, the call returns an empty `tasks`
array with the current retained window metadata.

There is no ack, unread, or delete state in v1.
Cursor persistence is agent-local. Chan does not store per-agent cursors.

## Validation And Errors

Agent handles must be exact canonical `@@Name` strings before routing, where
`Name` is one or more ASCII `[A-Za-z0-9_-]` characters. Handles that are empty,
missing the `@@` prefix, contain whitespace, `/`, NUL, control characters, or
other characters are rejected. Routing is case-sensitive.

Team names must be one or more ASCII `[A-Za-z0-9_-]` characters, are preserved
exactly, and route case-sensitively. Empty names, whitespace, `/`, NUL, control
characters, and other characters are rejected.

`context_path` is required, workspace-relative, POSIX-style, syntactically
valid, canonicalized before storage, and must resolve to an existing regular
workspace file when the task is sent. Absolute paths, `..` escapes, empty
segments, leading `./`, leading/trailing whitespace, URL fragments or query
strings, Windows-style separators, NUL, control junk, missing files, and
non-regular files are rejected.
`send_agent_task` does not create or modify the target file.
The path is treated literally; no URL decoding or percent-decoding is applied.
Internal spaces are allowed when they are part of an existing readable file path.
Non-ASCII filenames are allowed when the existing workspace path/read boundary
supports them.
Validation uses the same workspace-readable content boundary as the MCP
`read_file` tool, including supported virtual namespaces such as `Drafts/...`.
Stored `context_path` values remain workspace-facing paths that recipients can
pass to MCP tools; they never expose resolved physical metadata or host paths.
The sender must be able to read the target through the same MCP workspace
connection boundary before the task is enqueued.
Team Work tasks are scoped to the current `chan serve` workspace. Cross-
workspace task routing is out of scope for v1.
Path canonicalization preserves case according to the existing workspace path
resolver; the inbox does not case-fold task paths.
Directories are not valid task targets in v1; use a concrete file inside the
directory to describe the work scope.
Task targets are not limited to markdown; any regular workspace file readable
through the MCP text tools is valid. Binary/media files are rejected; use a text
task file to point at media when needed.
The inbox does not validate a task-file schema. Headings, frontmatter,
checkboxes, status fields, and ownership conventions inside the target file are
free-form in v1.

Inbox MCP tools return clear errors:

- `team identity unavailable`
- `agent identity unavailable`
- `agent inbox unavailable`
- invalid params for validation failures, with concise actionable messages such
  as `invalid context_path: file not found`

Inbox MCP errors must not include absolute host paths; use workspace-relative
paths or generic reason text.

Unavailable checks run in this order: provider, team identity, agent identity.
Standalone MCP without an inbox provider returns `agent inbox unavailable`;
chan-server-hosted workspace-only connections without a prelude return identity
errors.
`agent inbox unavailable` means the retained-task provider or in-memory inbox is
unavailable.
It does not mean terminal wake-up failed or is unavailable.

Sending to unknown or offline agents is accepted and retained until evicted.
Sending to the caller's own agent handle is accepted; it stores in that shared
agent inbox and pokes every live terminal matching the caller's team and handle.
`send_agent_task` returns only the stored task id. It does not expose
whether any live terminal was poked.

## Config

Add `team_work.inbox_depth` to `ServerConfig`.

Default: `10`.

Sanitized range: `1..=100`.

Runtime changes apply to the active process-local inbox immediately. Shrinking
the depth evicts excess retained tasks from each inbox key.
The existing AppState-owned inbox object is updated in place so active provider
clones observe the new depth.

No Settings UI is required in v1. The field is documented in
`docs/config-reference.md` and exposed through `chan config get/set` as
`server.team_work.inbox_depth`.

## Guidance

The poke contract is explicit guidance. MCP-facing instructions and the Team
Work identity prompt tell agents:

```text
Create or update a workspace task file before handing work to another agent.
Send that work with `send_agent_task(to, context_path)`.
On startup, call `list_agent_tasks` once to catch retained work.
When terminal input contains a standalone `poke`, call
`list_agent_tasks` over MCP, then read each returned `context_path` with
the workspace MCP tools.
If your host supports persistent memory, store `latest_id` as your next cursor.
```

This avoids injecting semantic commands into the PTY.

When the Team Work identity prompt lists teammates, duplicate member handles are
listed once because handles are shared identities, not unique rows.

## Frontend Scope

No HTTP inbox API is added in v1. Inbox behavior is exposed to agents through
MCP only, with terminal poke as the live wake-up path.

The Team Work dialog requires canonical `@@Name` agent handles. It does not
auto-prefix member names. The existing `auto_prefix_at` field is legacy schema
compatibility only; reading it must not silently repair non-canonical handles.
New saves/bootstrap writes should set it to `false` if the field remains in the
wire schema. Old configs with non-canonical member handles fail load or
bootstrap validation with a clear message.
Display-oriented host names are not routing identity and do not need to follow
the agent-handle character set. `host_handle` and member handles do.
Duplicate member handles are allowed and mean shared Team Work identity: those
members share one agent inbox and all matching live terminals receive pokes. The
UI may warn about duplicate handles but must not block them.
Bootstrap requires exactly one lead row. The lead row is the bootstrap anchor
for restarting the existing lead PTY and priming the Team Work prompt; it does
not make that handle globally unique.

Team bootstrap must inject `CHAN_TEAM_NAME` into every member env alongside
`CHAN_TAB_NAME`, both in the persisted `chan-team.toml` member env and in the
actual terminal spawn/restart requests.

The Team Work identity prompt must include the exact MCP tool names
`send_agent_task` and `list_agent_tasks`, plus the path-only task contract.

The old SPA-side `agent_event_echo`, `agent_echo_since`, and
`lastAgentEchoSeq` paths must be removed completely as part of this change,
including serialized session fields and tests that only pin the stale behavior.
New delivery is direct server-side PTY input through the terminal registry, not
browser WebSocket echo replay or broadcast fan-out.
The terminal WebSocket URL no longer accepts or sends `agent_echo_since`.
Normal user-driven terminal broadcast remains in scope as an existing terminal
feature; it is not used for inbox poke delivery.

No frontend inbox display is part of v1.

## Testing

Rust tests:

- Validate agent handles, team names, and context paths.
- Retain only `inbox_depth` tasks per `(team, agent)`.
- Keep global ids monotonic across teams.
- Return correct `since_id`, `oldest_retained_id`, and `latest_id` behavior.
- Accept sends to offline agents.
- Poke all matching PTYs and no PTYs from other teams.
- Unit-test terminal routing identity matching separately from PTY writes, with
  limited end-to-end PTY coverage proving `poke\n` reaches a live terminal.
- MCP inbox tools fail cleanly without team, agent, or provider.
- Proxy prelude parsing strips valid prelude lines and replays non-prelude
  bytes.
- Proxy prelude parsing consumes malformed reserved-prefix prelude lines and
  continues as workspace-tools-only.

Frontend tests:

- Team bootstrap writes `CHAN_TEAM_NAME`.
- Env round-tripping keeps system-owned `CHAN_TEAM_NAME` and `CHAN_TAB_NAME`
  out of the visible custom-env field and rewrites legacy values to canonical
  Team Work identity on the next save/bootstrap.
- The Team Work dialog defaults to canonical `@@Name` handles, rejects
  non-canonical handles, and does not use `auto_prefix_at` to repair them.
- Identity prompt includes the poke contract, exact tool names, and path-only
  task contract.
- Stale `agent_event_echo`, `agent_echo_since`, and `lastAgentEchoSeq` code and
  tests are removed, not preserved as compatibility paths.

Docs:

- Update `docs/config-reference.md`.
- Update `docs/manual/terminal-and-mcp.md`.
