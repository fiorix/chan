# Orchestration with chan

chan doubles as a single-machine orchestration host: agents (claude, codex, gemini, opencode, custom) run in named terminal tabs and drive each other through `cs`, the chan-shell control client every chan-launched terminal can reach. The agent-facing manual is built in: `chan dump-skill --topic <topic>` covers pokes, surveys, teams, and the rest of the `cs` surface, and each provisioned team carries a generated `bootstrap.md` that is the authoritative process doc for that team. This directory documents the standing contracts; do not hand-duplicate the generated material.

## Transport and identity

Every chan-launched terminal gets `$CHAN_CONTROL_SOCKET` (the control socket `cs` speaks a typed wire protocol over; server side in `crates/chan-server/src/control_socket.rs`, wire types in `crates/chan-shell/src/wire.rs`) and `$CHAN_WINDOW_ID`. Identity: `$CHAN_TAB_NAME` is the tab's handle (set whenever the spawn carries a name), `$CHAN_TAB_GROUP` is its broadcast group (always set), and a recognized `$CHAN_AGENT` value in a session's spawn env (claude, codex, gemini, kimi, opencode, or none/shell) overrides the submit-encoding sniff; an unrecognized value falls through to the command sniff so a typo cannot silently disable submit. `CHAN_MODE` is read by nothing. The SPA drives the same terminal surface over HTTP (`/api/terminals` create/restart/delete, broadcast, the roster, the PTY WebSocket) with the bearer token or `t=` query param; agents use `cs`.

## Pokes

`cs terminal write [text] --tab-name=<h>|--tab-group=<g> [--submit=<agent>]` is the message primitive. Messages are capped at 4096 bytes, enqueue on the target's per-session FIFO (bound 100), and deliver when the target's PTY goes output-quiet; consecutive same-encoding submitted messages batch into one agent turn. `--submit` names the agent to encode for and that agent's chord is what gets appended; the server reports in the ack when a target's own derivation disagrees but never overrides the request, so a wrong name delivers a wrong chord. Naming an agent for a target that derives none is how you reach an agent started by hand inside a shell session. One chord is encoded per command, so target a mixed-agent group per session. Without `--submit`, the text parks unsubmitted in the target's compose box. Discipline: a poke is a one-line pointer to an append-only section; write the section first, then poke it.

## Surveys

`cs terminal survey --tab-name=<host> --title ... --option ... (up to 4)` raises a blocking overlay in the target's window and parks the CLI on the reply; the recipient picks an option, sends a follow-up marker (an "answer coming later", not an answer), or dismisses. Timeout exits 124. In a team, only the lead surveys the host; workers route decisions through the lead and never raise a TUI survey.

## Teams

`cs terminal team new|load` provisions a whole agent team into named tabs from one config, with the team's coordination artifacts living inside the workspace. See [teams.md](teams.md).

## Observability

`cs terminal list [--json]` reports each tab's name, derived agent, session id, placement, window status, and cwd (`--json` adds `queue_depth`). `cs terminal scrollback --tab-name=<h>` reads a peer's terminal output. Judge a lane by the artifacts it produces, not by `offline` status or queue depth alone (see [../playbook.md](../playbook.md)).

## MCP discovery

The in-process MCP server rides the same terminal env plumbing and is off by default; see [mcp-discovery.md](mcp-discovery.md).

## What chan does NOT provide

* A networked event bus or filesystem message protocol. Messages ride the control socket; durable coordination state is ordinary workspace files.
* Cross-host orchestration. The tunnel relocates the HTTP transport, not the agent runtime.
