# Orchestration with chan

Every chan terminal carries a control socket and the `cs` command, so a shell can drive the window that spawned it. That is what makes chan a single-machine orchestration host: agents (agy, claude, codex, gemini, kimi, muse, opencode, or anything custom) run in named terminal tabs and drive each other through `cs`. This directory holds the standing contracts an agent relies on when it does so. The option reference is the built-in help, `cs <command> --help`, and `chan dump-skill --topic <topic>` (or `cs dump-skill`) renders the agent-facing manual for pokes, surveys, teams and the rest of the surface; a provisioned team also carries a generated `bootstrap.md`, the authoritative process document for that team. Do not hand-duplicate either.

## Transport and identity

A chan-launched terminal gets `$CHAN_CONTROL_SOCKET`, the socket `cs` speaks a typed wire protocol over (server side in `crates/chan-server/src/control_socket.rs`, wire types in `crates/chan-shell/src/wire.rs`), and `$CHAN_WINDOW_ID`. Its identity is `$CHAN_TAB_NAME`, the tab's handle, set when the spawn carries a name, and `$CHAN_TAB_GROUP`, its broadcast group, always set. A recognized `$CHAN_AGENT` in the spawn env (agy, claude, codex, gemini, kimi, muse, opencode, or none/shell) overrides the submit-encoding sniff of the spawn command; an unrecognized value falls through to the sniff, so a typo cannot silently disable submit. `CHAN_MODE` is read by nothing. The keys chan sets for itself at spawn (`CHAN_SPAWN_ENV_KEYS` in `crates/chan-library/src/terminal_sessions.rs`) are refused in a caller's env, because the caller's value could never reach the child. The workspace app drives the same terminal surface over HTTP with the bearer token; agents use `cs`.

`cs session` is the client side: `list` and `info` show the frontend clients across workspace and standalone terminal windows, `self` identifies and names the caller's client (scripts pass `--id`), and `detach` disconnects a client while its terminals and layouts stay. `handover` and `takeover` are the workspace leadership verbs and keep their own meaning.

## Pokes

`cs terminal write` is the message primitive: up to 4096 bytes, refused rather than truncated above that, queued on the target's per-session FIFO and delivered when the target's visible output goes quiet (a repaint of escape sequences alone does not count). Consecutive submitted messages that share the target's encoding are framed into one agent turn. `--submit <agent>` appends that agent's chord; the server reports in the ack when the target's own derivation disagrees but never overrides the request, so a wrong name delivers a wrong chord, and naming an agent for a target that derives none is how you reach an agent started by hand in a shell. One chord is encoded per command, so address a mixed-agent group per session. Without `--submit` the text parks unsubmitted in the target's compose box. The discipline: a poke is a one-line pointer to an append-only section; write the section first, then poke it.

## Surveys

`cs terminal survey` raises a blocking overlay in the window that owns the target tab and parks the CLI on the reply: the chosen option (up to four), a follow-up marker ("answer coming later", which is not an answer), or a dismissal. A timeout exits 124. Surveys to one target open one at a time. In a team only the lead surveys the host; workers route decisions through the lead and never raise a survey.

## Teams

`cs terminal team new|load` provisions a whole agent team into named tabs from one config, with its coordination artifacts inside the workspace. See [teams.md](teams.md).

## Observability

`cs terminal list` reports each session's name, derived agent, session id, placement, window status, program state, queue depth and cwd; `--json` carries the raw records. `cs terminal scrollback --tab-name=<h>` reads a peer's terminal output as the raw byte stream, so strip the escape sequences before reading it. Judge a seat by the artifacts it produces, not by `offline` status or queue depth alone (see [../playbook.md](../playbook.md)).

The `program` column is what the program in each session last reported through the Program Status Protocol (OSC 7501): its state with the kind of a block (`blocked/permission`), a percentage when it reports progress, `done`, or `-` with no report. `--json` carries every record with its text, so an orchestrator reads a seat's blocked prompt from the roster instead of its scrollback.

## MCP discovery

The in-process MCP server rides the same terminal env plumbing and is off by default; see [mcp-discovery.md](mcp-discovery.md).

## What chan does not provide

- A networked event bus or a filesystem message protocol. Messages ride the control socket; durable coordination state is ordinary workspace files.
- Cross-host orchestration. The tunnel relocates the HTTP transport, not the agent runtime.
