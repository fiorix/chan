# Terminal And MCP Discovery

Terminal tabs start at the workspace root. They are intended for shell work that
belongs next to the files you are editing.

## MCP environment

When the server MCP bridge is available, Chan exports discovery variables into
terminal sessions:

```text
CHAN_MCP_SERVER_NAME=chan
CHAN_MCP_SOCKET=...
CHAN_MCP_COMMAND=...
CHAN_MCP_COMMAND_JSON=...
CHAN_MCP_SERVER_JSON=...
```

External agent CLIs launched from that terminal can translate the `CHAN_`
descriptor into their own MCP configuration shape.

`chan __mcp-proxy <socket>` is the stdio bridge used by those descriptors. In
a Team Work terminal, the proxy also reads `CHAN_TEAM_NAME` and
`CHAN_TAB_NAME`. When both are present and valid, it sends a private first line
to the server before normal MCP traffic:

```text
CHAN-MCP-PROXY 1 {"team":"alpha","agent":"@@FullStackA"}
```

The server strips this line and uses it only as Team Work routing identity. If
the variables are missing or invalid, the proxy sends no prelude and workspace
MCP tools still work.

## Team Work agent inbox

Team Work terminals get two system-owned identity variables:

```text
CHAN_TEAM_NAME=<team>
CHAN_TAB_NAME=<@@Agent>
```

`mcp_env=false` suppresses only `CHAN_MCP_*` discovery variables. It does not
suppress Team Work identity.

The MCP server exposes these inbox tools:

- `send_agent_task(to, context_path) -> { id }`
- `list_agent_tasks(since_id?) -> { team, agent, oldest_retained_id, latest_id, tasks }`

`send_agent_task` stores a task for one canonical `@@Name` recipient in the
same team. The sender comes from the MCP connection identity, not from a
caller-supplied field. `context_path` must be a workspace-relative path to an
existing regular file. Chan stores the path only; agents read the file with the
normal workspace tools.

`list_agent_tasks` has no recipient argument. It lists the connected agent's own
retained inbox, oldest to newest. Agents should call it on startup with no
cursor, then store `latest_id` and pass it back as `since_id` on later calls.
If the previous cursor is older than the retained window, the response still
returns retained tasks and exposes `oldest_retained_id` so the agent can detect
the gap.

After a task is stored, Chan writes exactly `poke\n` to every live terminal with
the matching spawn-time Team Work identity. A standalone `poke` in the terminal
means the agent should call `list_agent_tasks`. The poke is not a shell command
to inspect the inbox, does not include the task path, and is best effort. If no
matching terminal is live, the task remains retained and the send still
succeeds.

## External agents only

Chan exposes its workspace tools through MCP for external agents. It does not
ship in-app chat or assistant HTTP APIs.
