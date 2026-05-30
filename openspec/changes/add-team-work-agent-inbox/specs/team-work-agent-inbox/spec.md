## ADDED Requirements

### Requirement: MCP Inbox Tools

The system SHALL expose Agent inbox MCP tools for Team Work.
The chan MCP server exposes `send_agent_task` and `list_agent_tasks` when the
inbox capability is compiled in. The tools MUST remain visible in the MCP tool
list for every connection, and availability MUST be enforced at call time.

Inbox tool calls MUST check unavailable state in this order: inbox provider,
team identity, then agent identity. A standalone MCP connection without an inbox
provider MUST fail inbox calls with `agent inbox unavailable`. A
chan-server-hosted connection without a Team Work identity prelude MUST fail
with the matching identity error while keeping workspace MCP tools available.

#### Scenario: Inbox tools are visible to hosted MCP clients

- **WHEN** an MCP client lists tools on a chan-server-hosted connection
- **THEN** `send_agent_task` and `list_agent_tasks` are included in the tool
  list when the inbox capability is compiled in

#### Scenario: Standalone MCP lacks an inbox provider

- **WHEN** a standalone MCP connection calls an inbox tool without an inbox
  provider
- **THEN** the call fails with `agent inbox unavailable`

#### Scenario: Hosted MCP lacks team identity

- **WHEN** a chan-server-hosted MCP connection calls an inbox tool without a
  Team Work team identity
- **THEN** the call fails with `team identity unavailable`

#### Scenario: Hosted MCP lacks agent identity

- **WHEN** a chan-server-hosted MCP connection has an inbox provider and team
  identity but no agent identity
- **THEN** the call fails with `agent identity unavailable`

### Requirement: System-Owned Team Work Identity

The system MUST use system-owned Team Work identity for inbox routing.
Team Work routing identity is the system-owned pair of team name and agent
handle. Every bootstrapped Team Work member PTY MUST receive
`CHAN_TEAM_NAME=<team_name>` and `CHAN_TAB_NAME=<agent_handle>`. Non-Team-Work
terminals MUST NOT receive `CHAN_TEAM_NAME`.

The terminal `mcp_env=false` option MUST suppress only `CHAN_MCP_*` discovery
variables and MUST NOT suppress `CHAN_TEAM_NAME` or `CHAN_TAB_NAME`.

Team bootstrap MUST persist both identity values into each `chan-team.toml`
member env. Existing values for these keys MUST be treated as legacy routing
identity rather than user custom env values, and the next save or bootstrap
MUST rewrite them to the canonical team and agent identity.

Routing identity MUST be captured when a PTY is spawned or restarted. Later UI
tab renames MUST NOT change inbox routing until the PTY restarts with a new
Team Work identity.

#### Scenario: Bootstrap injects Team Work identity

- **WHEN** Team Work bootstrap creates or restarts member PTYs
- **THEN** each Team Work PTY is spawned with canonical `CHAN_TEAM_NAME` and
  `CHAN_TAB_NAME`

#### Scenario: MCP env suppression keeps Team Work identity

- **WHEN** a Team Work terminal is launched with `mcp_env=false`
- **THEN** `CHAN_MCP_*` variables are suppressed and `CHAN_TEAM_NAME` plus
  `CHAN_TAB_NAME` are still present

#### Scenario: Legacy identity env is rewritten

- **WHEN** a loaded Team Work config already contains `CHAN_TEAM_NAME` or
  `CHAN_TAB_NAME` in member env
- **THEN** the next save or bootstrap rewrites those keys to the canonical
  system-owned values instead of exposing them as custom env

#### Scenario: Tab rename does not reroute a running PTY

- **WHEN** a running Team Work tab is renamed in the UI
- **THEN** inbox routing continues to use the spawn-time Team Work identity
  until the PTY is restarted

### Requirement: MCP Proxy Prelude

The MCP proxy MUST carry valid Team Work identity with a private prelude.
Every advertised MCP proxy command MUST emit the prelude before MCP traffic
only when both `CHAN_TEAM_NAME` and `CHAN_TAB_NAME` are present and locally
valid. The prelude line MUST have version `1` and the exact JSON schema with
string fields `team` and `agent` and no extra fields:

```text
CHAN-MCP-PROXY 1 {"team":"alpha","agent":"@@FullStackA"}
```

If either identity value is missing or invalid, the proxy MUST omit the prelude
silently and preserve existing byte-for-byte MCP piping behavior.

`mcp_bridge` MUST strip and validate a valid prelude before handing the stream
to `chan-llm`. If the first bytes are not a prelude attempt, `mcp_bridge` MUST
replay them into the MCP stream. If the first line uses the reserved
`CHAN-MCP-PROXY ` prefix but has an unknown version, invalid JSON, invalid
schema, invalid team identity, or invalid agent identity, the bridge MUST
consume that line and continue as a workspace-tools-only connection.

Prelude detection MUST be bounded by a short timeout or first-byte availability
and MUST NOT wait indefinitely for identity before normal MCP handling.

#### Scenario: Valid prelude supplies identity

- **WHEN** the advertised MCP proxy command starts with valid Team Work identity
  env vars
- **THEN** it emits a version `1` prelude and `mcp_bridge` passes the canonical
  team and agent identity to `chan-llm`

#### Scenario: Invalid proxy identity omits prelude

- **WHEN** the advertised MCP proxy command starts with missing or invalid Team
  Work identity env vars
- **THEN** it emits no prelude and preserves normal MCP piping without stderr
  warnings

#### Scenario: Non-prelude bytes are replayed

- **WHEN** the first bytes received by `mcp_bridge` are not a
  `CHAN-MCP-PROXY ` prelude attempt
- **THEN** those bytes are replayed into the MCP stream for direct socket
  compatibility

#### Scenario: Malformed reserved prelude is consumed

- **WHEN** the first line uses the reserved `CHAN-MCP-PROXY ` prefix with an
  invalid version, JSON payload, schema, team, or agent
- **THEN** the line is consumed and the MCP connection continues without Team
  Work identity

#### Scenario: Prelude detection is bounded

- **WHEN** an MCP client sends no immediate identity prelude
- **THEN** the bridge starts normal MCP handling after the bounded detection
  window instead of waiting indefinitely

### Requirement: Routing Identity Validation

The system MUST validate team names and agent handles before routing.
Agent handles MUST be exact canonical `@@Name` strings before routing, where
`Name` contains one or more ASCII `[A-Za-z0-9_-]` characters. Routing MUST be
case-sensitive. Empty handles, handles missing the `@@` prefix, whitespace,
`/`, NUL, control characters, and other characters MUST be rejected.

Team names MUST contain one or more ASCII `[A-Za-z0-9_-]` characters, be
preserved exactly, and route case-sensitively. Empty names, whitespace, `/`,
NUL, control characters, and other characters MUST be rejected.

#### Scenario: Canonical agent handle is accepted

- **WHEN** routing validates `@@FullStackA`
- **THEN** the handle is accepted exactly as written

#### Scenario: Non-canonical agent handle is rejected

- **WHEN** routing validates `FullStackA`, `@@Full Stack`, `@@Full/Stack`, or
  an empty handle
- **THEN** the handle is rejected before task routing

#### Scenario: Team names are case-sensitive ids

- **WHEN** routing validates team names `alpha` and `Alpha`
- **THEN** both names are valid and identify distinct team buses

#### Scenario: Invalid team name is rejected

- **WHEN** routing validates an empty team name, a name with whitespace, a name
  containing `/`, or a name containing a control character
- **THEN** the team name is rejected before task routing

### Requirement: Sending Agent Tasks

The `send_agent_task` tool MUST store validated Agent tasks for one recipient.
The MCP tool accepts exactly one recipient through the required `to` parameter
and exactly one task target through the required `context_path` parameter. `to`
MUST be a canonical agent handle. `context_path` MUST be a non-empty JSON
string. Missing, `null`, empty, or non-string values MUST fail as invalid
params.

The sender MUST be derived from the MCP connection's Team Work agent identity.
Callers MUST NOT supply `from`. Sending to an unknown, offline, or self agent
handle MUST be accepted when validation passes. There is no sent-task outbox in
v1.

A successful send MUST create a retained task containing `id`, `from`, `to`,
`context_path`, and `created_at_unix_ms`. `created_at_unix_ms` MUST be captured
when the task is appended and serialized as a JSON number. The tool result MUST
return only the stored task id as `{ "id": <number> }` and MUST NOT report
whether any live terminal was poked.

`send_agent_task` MUST NOT create or modify the target file. Repeated sends to
the same `context_path` MUST create separate tasks with separate ids.

#### Scenario: Successful send stores a task

- **WHEN** `@@Architect` in team `alpha` calls `send_agent_task` with
  `to: "@@FullStackA"` and a valid `context_path`
- **THEN** the system stores a task in `(alpha, @@FullStackA)` with `from:
  "@@Architect"` and returns only its `id`

#### Scenario: Missing recipient is invalid

- **WHEN** `send_agent_task` is called without `to` or with `to: null`
- **THEN** the call fails with invalid params

#### Scenario: Invalid context path shape is invalid

- **WHEN** `send_agent_task` is called without `context_path`, with
  `context_path: null`, with an empty string, or with a non-string value
- **THEN** the call fails with invalid params

#### Scenario: Offline recipient is accepted

- **WHEN** `send_agent_task` targets a valid agent handle with no matching live
  terminal
- **THEN** the task is retained and the send succeeds

#### Scenario: Self-send is accepted

- **WHEN** an agent sends a task to its own agent handle
- **THEN** the task is stored in that shared agent inbox and matching live
  terminals for that handle are poked

#### Scenario: Repeated sends are not deduplicated

- **WHEN** the same sender sends the same `context_path` to the same recipient
  twice
- **THEN** two retained tasks with distinct ids are created

### Requirement: Context Path Boundary

The system MUST validate task context paths through the workspace read boundary.
`context_path` MUST be workspace-relative, POSIX-style, syntactically valid,
canonicalized before storage, and resolved through the same readable workspace
content boundary as the MCP `read_file` tool, including supported virtual
namespaces such as `Drafts/...`.

The target MUST resolve to an existing regular readable workspace text file
when the task is sent. The sender MUST be able to read the target through the
same MCP workspace connection boundary before the task is enqueued.

The system MUST reject absolute paths, `..` escapes, empty segments, leading
`./`, leading or trailing whitespace, URL fragments, URL query strings,
Windows-style separators, NUL, control junk, missing files, non-regular files,
directories, binary files, and media files. Internal spaces MUST be allowed
when part of an existing readable file path. Non-ASCII filenames MUST be
allowed when the existing workspace path/read boundary supports them.

The path MUST be treated literally. The system MUST NOT URL-decode or
percent-decode path input. Stored `context_path` values MUST remain
workspace-facing paths and MUST NOT expose resolved physical metadata or host
paths. Path canonicalization MUST preserve case according to the existing
workspace path resolver.

The inbox MUST NOT validate a task-file schema. Headings, frontmatter,
checkboxes, status fields, and ownership conventions inside the target file are
free-form in v1.

#### Scenario: Existing readable text file is accepted

- **WHEN** `send_agent_task` references an existing readable workspace text file
  through a valid workspace-facing path
- **THEN** the task is stored with the canonicalized workspace-facing
  `context_path`

#### Scenario: Path traversal is rejected

- **WHEN** `send_agent_task` references `../secret.md` or an absolute host path
- **THEN** the call fails with invalid params and does not expose a host path in
  the error

#### Scenario: Missing or non-regular target is rejected

- **WHEN** `send_agent_task` references a missing file, directory, symlink,
  FIFO, socket, device, binary file, or media file
- **THEN** the call fails with invalid params before storing a task

#### Scenario: Literal path is not URL decoded

- **WHEN** `send_agent_task` references a path containing percent-encoded
  characters
- **THEN** the system treats those characters literally and does not
  percent-decode the path

#### Scenario: Later file changes do not mutate retained task

- **WHEN** a valid task is stored and the referenced file is later deleted,
  moved, or edited
- **THEN** the retained task keeps the originally stored `context_path`

### Requirement: Volatile Team-Scoped Inbox Storage

The Agent inbox MUST be volatile and isolated by Team Work team bus.
The inbox is in-memory, process-local, app-owned, and volatile. Each
`chan-server` app instance and workspace MUST own its own inbox. Restarting
`chan serve` MUST lose all retained tasks.

The team bus id MUST be the validated team name. Two live Team Work launches
using the same team name MUST share one team bus. Distinct team names MUST keep
tasks and pokes isolated, even when agent handles match.

Tasks MUST be keyed by `(team, recipient_agent)`. Sender identity MUST be task
metadata and MUST NOT be part of the retention key. There is no roster in v1:
recipient identity is a validated agent handle inside the sender's team bus,
and live terminals are not membership authority.

When multiple live terminals share a team and agent handle, they MUST share the
same retained inbox. The server MUST NOT track per-terminal read state. Cursor
persistence is agent-local.

#### Scenario: Server restart clears retained tasks

- **WHEN** `chan serve` restarts for a workspace
- **THEN** previously retained Agent tasks are no longer available

#### Scenario: Matching handles in different teams are isolated

- **WHEN** team `alpha` and team `beta` both have `@@FullStackA`
- **THEN** tasks and pokes for `(alpha, @@FullStackA)` are not visible to
  `(beta, @@FullStackA)`

#### Scenario: Same team name shares the bus

- **WHEN** two live Team Work launches use the same validated team name
- **THEN** they use the same team bus for Agent task routing

#### Scenario: Duplicate live handles share retained inbox

- **WHEN** two live terminals have spawn-time identity `(alpha, @@FullStackA)`
- **THEN** both terminals share one retained inbox for `@@FullStackA`

### Requirement: Task Ids And Retained Ordering

The system MUST assign process-global monotonic ids to Agent tasks.
Task ids MUST be global per process, monotonically increasing `u64` values that
start at `1`. Ids MUST NOT be scoped by team or agent and MUST be serialized as
JSON numbers. Id overflow MUST fail the send rather than wrap.

Retained inbox order MUST remain ascending by id. Task ordering and cursors
MUST use `id`, not `created_at_unix_ms`.

In-memory inbox critical sections MUST stay short: retained tasks are cloned or
listed under the inbox lock, and MCP responses and terminal poke dispatch are
performed outside that lock.

#### Scenario: Ids are global across teams

- **WHEN** tasks are sent to different teams and recipients in one server
  process
- **THEN** each new task receives the next process-global id

#### Scenario: Retained tasks are ordered by id

- **WHEN** a retained inbox contains multiple tasks
- **THEN** listing returns tasks oldest to newest by task id

#### Scenario: Id overflow fails send

- **WHEN** the next task id would overflow `u64`
- **THEN** `send_agent_task` fails and does not wrap the id counter

### Requirement: Inbox Retention Depth

The Agent inbox MUST enforce configured per-recipient retention depth.
The in-memory inbox MUST retain the latest `team_work.inbox_depth` tasks per
`(team, recipient_agent)` key. The default depth MUST be `10`. Configured
values MUST be sanitized to the inclusive range `1..=100`.

The setting MUST be exposed as `server.team_work.inbox_depth` through
`chan config get/set` and documented in `docs/config-reference.md`. No Settings
UI is required in v1.

Runtime config changes MUST apply to the active process-local inbox
immediately. The existing `AppState` inbox object MUST be updated in place so
active provider clones observe the new depth. Shrinking depth MUST evict excess
retained tasks from each inbox key.

#### Scenario: Default retention depth is ten

- **WHEN** no inbox depth is configured
- **THEN** each `(team, recipient_agent)` inbox retains at most ten tasks

#### Scenario: Configured depth is sanitized

- **WHEN** the configured inbox depth is below `1` or above `100`
- **THEN** the active depth is clamped to the inclusive range `1..=100`

#### Scenario: Retention is per recipient key

- **WHEN** one recipient exceeds the depth and another recipient does not
- **THEN** only the overflowing recipient inbox evicts old tasks

#### Scenario: Runtime shrink evicts immediately

- **WHEN** `server.team_work.inbox_depth` is reduced at runtime
- **THEN** every retained inbox key is trimmed to the new active depth

### Requirement: Terminal Poke Wake-Up

The system MUST best-effort poke matching live PTYs after storing a task.
After a successful send, the system MUST write exactly `poke\n` to every live,
non-closed PTY whose spawn-time Team Work identity matches the task's team and
recipient agent handle. Matching terminals MUST be poked even when no browser
WebSocket is attached.

The task MUST always be stored before any poke is attempted. The inbox lock
MUST NOT be held while poking terminals. Poke writes MUST use the normal
terminal input path and keep the PTY session active.

The poke MUST NOT include submit chords, routing metadata, task content, or the
task path. Poke delivery MUST be best-effort. Failure to find a live terminal,
failure to write to a terminal, or terminal wake-up unavailability MUST NOT fail
`send_agent_task` because the retained inbox is the source of truth. Failed
poke writes can be logged at debug level and MUST NOT change the MCP result.

Pokes MUST be sent only when a task is created. Starting or reconnecting a PTY
MUST NOT automatically poke for already-retained tasks.

#### Scenario: Matching live terminal receives poke

- **WHEN** a task is sent to `@@FullStackA` in team `alpha` and a live PTY has
  spawn-time identity `(alpha, @@FullStackA)`
- **THEN** that PTY receives exactly `poke\n`

#### Scenario: All duplicate live handles are poked

- **WHEN** multiple live PTYs share spawn-time identity `(alpha, @@FullStackA)`
  and a task is sent to `@@FullStackA`
- **THEN** every matching live PTY receives `poke\n`

#### Scenario: Other teams are not poked

- **WHEN** a task is sent to `@@FullStackA` in team `alpha`
- **THEN** a live PTY with spawn-time identity `(beta, @@FullStackA)` does not
  receive a poke

#### Scenario: Missing terminal does not fail send

- **WHEN** a task is sent to a valid recipient with no matching live PTY
- **THEN** the task is retained and `send_agent_task` succeeds

#### Scenario: Reconnected terminal is not auto-poked

- **WHEN** a terminal starts or reconnects after tasks were already retained
- **THEN** the server does not automatically write `poke\n` for those existing
  tasks

### Requirement: Listing Agent Tasks

`list_agent_tasks` MUST list only the connected agent's retained tasks.
The MCP tool has no recipient parameter. It MUST read the connected agent's own
shared Agent inbox derived from the MCP connection's Team Work identity. The
response `team` and `agent` fields MUST be the canonical MCP connection
identity, not values inferred from returned tasks.

The response MUST include `team`, `agent`, `oldest_retained_id`, `latest_id`,
and `tasks`. The retained item array MUST be named `tasks`; there is no
`messages` alias in v1. For an empty retained inbox, `oldest_retained_id` and
`latest_id` MUST be present as `null`, `tasks` MUST be `[]`, and `team` plus
`agent` MUST still be returned.

Without `since_id`, or with `since_id: null`, the tool MUST return the
currently retained inbox oldest to newest by task id. With `since_id`, it MUST
return retained tasks with `id > since_id`, oldest to newest by task id.
`since_id` MUST be treated only as a numeric cursor. The server MUST NOT check
whether that id belongs to this inbox or any other inbox.

`since_id=0` MUST be accepted and return all currently retained tasks.
Non-integer, negative, and out-of-range `since_id` values MUST fail as invalid
params.

If `since_id` is older than the retained window, the call MUST return retained
tasks newer than `since_id` rather than an error. If `since_id` is newer than
`latest_id`, the call MUST return an empty `tasks` array with the current
retained window metadata.

There is no ack, unread, delete, or server-stored cursor state in v1.

#### Scenario: Listing without cursor returns retained inbox

- **WHEN** an agent calls `list_agent_tasks` without `since_id`
- **THEN** the response returns that agent's currently retained tasks oldest to
  newest by id

#### Scenario: Empty inbox returns null metadata

- **WHEN** an agent calls `list_agent_tasks` and its retained inbox is empty
- **THEN** the response includes `oldest_retained_id: null`,
  `latest_id: null`, `tasks: []`, and the canonical `team` and `agent`

#### Scenario: Cursor filters newer tasks

- **WHEN** an agent calls `list_agent_tasks` with `since_id: 12`
- **THEN** the response includes only retained tasks whose `id` is greater than
  `12`

#### Scenario: Cursor zero returns all retained tasks

- **WHEN** an agent calls `list_agent_tasks` with `since_id: 0`
- **THEN** the response returns all currently retained tasks for that inbox

#### Scenario: Old cursor returns retained window

- **WHEN** an agent calls `list_agent_tasks` with a `since_id` older than the
  retained window
- **THEN** the response returns retained tasks newer than that cursor and
  includes `oldest_retained_id` plus `latest_id` so the agent can detect the
  gap

#### Scenario: Future cursor returns empty tasks with metadata

- **WHEN** an agent calls `list_agent_tasks` with a `since_id` newer than the
  current `latest_id`
- **THEN** the response includes an empty `tasks` array and current retained
  window metadata

#### Scenario: Invalid cursor is rejected

- **WHEN** `list_agent_tasks` receives a non-integer, negative, or out-of-range
  `since_id`
- **THEN** the call fails with invalid params

### Requirement: Safe Inbox Errors

Inbox MCP errors MUST be concise, actionable, and safe.
Validation failures MUST return invalid params with messages such as
`invalid context_path: file not found`. Inbox MCP errors MUST NOT include
absolute host paths; they MUST use workspace-relative paths or generic reason
text.

`agent inbox unavailable` MUST mean the retained-task provider or in-memory
inbox is unavailable. It MUST NOT mean terminal wake-up failed or was
unavailable.

#### Scenario: Validation error avoids host path disclosure

- **WHEN** `send_agent_task` rejects a context path validation failure
- **THEN** the error message does not include an absolute host path

#### Scenario: Wake-up failure is not inbox unavailable

- **WHEN** the in-memory inbox is available but terminal wake-up is unavailable
- **THEN** `send_agent_task` stores the task and does not return
  `agent inbox unavailable`

### Requirement: Team Work Config And Bootstrap UI

The Team Work config and bootstrap UI MUST preserve canonical routing identity.
For new Team Work configs, the UI can derive the initial `team_name` from the
`chan-team.toml` parent directory, and the derived name MUST pass team-name
validation. For loaded configs, persisted `team_name` MUST be the source of
truth. Moving or copying `chan-team.toml` MUST NOT change the team bus id.
Invalid team names MUST fail load or bootstrap with a clear message and MUST
NOT be slugified or repaired.

The Team Work dialog MUST require canonical `@@Name` member handles and MUST
NOT auto-prefix member names. The legacy `auto_prefix_at` field MUST NOT
silently repair non-canonical handles. New saves and bootstrap writes MUST set
`auto_prefix_at` to `false` if the field remains in the wire schema.

Display-oriented host names are not routing identity and do not need to follow
the agent-handle character set. `host_handle` and member handles MUST follow
agent handle validation.

Duplicate member handles MUST be allowed and MUST mean shared Team Work
identity. The UI can warn about duplicate handles but MUST NOT block them.
Bootstrap MUST require exactly one lead row. The lead row is the bootstrap
anchor for restarting the existing lead PTY and priming the Team Work prompt;
it MUST NOT make that handle globally unique.

#### Scenario: Loaded config keeps persisted team name

- **WHEN** an existing `chan-team.toml` is moved to another directory
- **THEN** loading it keeps the persisted `team_name` as the team bus id

#### Scenario: Invalid team name fails clearly

- **WHEN** Team Work load or bootstrap encounters an invalid `team_name`
- **THEN** it fails with a clear validation message and does not repair the
  name

#### Scenario: Dialog rejects non-canonical member handle

- **WHEN** the Team Work dialog validates member handle `FullStackA`
- **THEN** it rejects the handle instead of rewriting it to `@@FullStackA`

#### Scenario: Duplicate member handles are allowed

- **WHEN** a Team Work config contains two member rows with handle
  `@@FullStackA`
- **THEN** the UI does not block the config, and those rows share the same
  Agent inbox identity

#### Scenario: Bootstrap requires one lead row

- **WHEN** Team Work bootstrap is requested
- **THEN** it requires exactly one lead row while allowing other rows to use
  duplicate non-lead handles

### Requirement: Agent Guidance And Poke Contract

Team Work guidance MUST explain task files, exact tools, cursors, and poke.
MCP-facing instructions and the Team Work identity prompt MUST tell agents to
create or update a workspace task file before handing work to another agent,
send that work with `send_agent_task(to, context_path)`, call
`list_agent_tasks` once on startup to catch retained work, and treat a
standalone terminal input line `poke` as a signal to call `list_agent_tasks`
over MCP.

The guidance MUST include the exact MCP tool names `send_agent_task` and
`list_agent_tasks`, and MUST describe the path-only task contract. If the host
supports persistent memory, the guidance MUST tell agents they can store
`latest_id` as the next cursor.

When the Team Work identity prompt lists teammates, duplicate member handles
MUST be listed once because handles are shared identities.

#### Scenario: Prompt names exact tools

- **WHEN** Team Work prompt text is generated for an agent
- **THEN** it includes `send_agent_task`, `list_agent_tasks`, and the
  path-only task contract

#### Scenario: Poke contract is explicit

- **WHEN** an agent receives the Team Work guidance
- **THEN** it is told that standalone `poke` means to call `list_agent_tasks`
  over MCP and then read each returned `context_path`

#### Scenario: Duplicate teammate handles are listed once

- **WHEN** the Team Work prompt lists teammates and multiple rows share a
  handle
- **THEN** that handle appears once in the teammate list

### Requirement: Browser Echo Delivery Removal

The system MUST remove browser echo delivery from v1 Agent inbox behavior.
The system MUST NOT add an HTTP inbox API or frontend inbox display in v1.
Inbox behavior MUST be exposed to agents through MCP only, with terminal poke as
the live wake-up path.

The old SPA-side `agent_event_echo`, `agent_echo_since`, and
`lastAgentEchoSeq` paths MUST be removed completely, including serialized
session fields and tests that only pin stale behavior. The terminal WebSocket
URL MUST no longer accept or send `agent_echo_since`.

New delivery MUST be direct server-side PTY input through the terminal
registry, not browser WebSocket echo replay or broadcast fan-out. Normal
user-driven terminal broadcast MUST remain in scope as an existing terminal
feature, but it MUST NOT be used for inbox poke delivery.

#### Scenario: No frontend inbox surface exists

- **WHEN** v1 Agent inbox support is enabled
- **THEN** there is no HTTP inbox API and no frontend inbox display

#### Scenario: Stale echo session state is removed

- **WHEN** frontend session state is serialized
- **THEN** it does not include `agent_event_echo`, `agent_echo_since`, or
  `lastAgentEchoSeq`

#### Scenario: Terminal WebSocket ignores old echo cursor

- **WHEN** a terminal WebSocket URL is built or handled
- **THEN** it does not accept or send `agent_echo_since`
