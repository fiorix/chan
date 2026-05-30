# Chan

Chan is a local-first workspace where a human can edit notes and coordinate
local agent processes around the same work.

## Language

**Agent handle**:
The addressable `@@Name` identity for one agent in a Team Work session. The
`@@` prefix is part of the identity; names are ASCII and routing is
case-sensitive.
_Avoid_: tab name, session id, process id

**Agent inbox**:
The bounded set of recent tasks addressed to one agent handle inside a team bus.
_Avoid_: watcher directory, notification file

**Agent task**:
A pointer from one agent handle to another to workspace content that should be
read for coordination. The sender is the connected agent handle, not a
caller-supplied field.
_Avoid_: agent message, event file, filesystem notification, inline chat message

**Agent poke**:
A minimal terminal wake-up line sent to a live agent terminal after a task is
stored in that agent's inbox. The poke is only a signal to call
`list_agent_tasks`; it is not the workspace path or a shell command that reads
the inbox directly.
_Avoid_: event command, watcher notification

**Poke contract**:
The instruction given to agents that a standalone `poke` received in the
terminal means "call `list_agent_tasks` over MCP". The contract is surfaced
in MCP-facing session guidance and in the Team Work identity prompt.
_Avoid_: hidden wake behavior, shell command injection

**Shared agent inbox**:
One inbox per agent handle inside a team bus. If multiple live terminals share
the same team bus and handle, they share the same inbox and all matching
terminals receive the agent poke.
_Avoid_: per-session inbox, tab-local messages

**Team bus**:
The isolated task space for one named Team Work team. Agent tasks are visible
only within their team bus; team names are ASCII ids, and matching agent
handles in different teams do not share tasks or pokes.
_Avoid_: workspace-wide bus, cross-team channel

**Team Work identity**:
The system-owned pair of team bus and agent handle that identifies an agent for
Team Work routing. Users may name teams and members, but they do not override
the routing identity through custom member environment values.
_Avoid_: custom environment identity, caller-supplied sender

## Example Dialogue

Dev: "When @@Architect sends a task to @@FullStackA, what identifies the
recipient?"

Domain expert: "The recipient is @@FullStackA, the agent handle. @@FullStackA
then reads its own agent inbox."

Dev: "Can I type Lead and let Chan treat it as @@Lead?"

Domain expert: "No. The agent handle is the canonical @@Lead spelling."

Dev: "What does @@Architect send to @@FullStackA?"

Domain expert: "A workspace path. @@FullStackA reads that content through the
workspace tools."

Dev: "What should @@FullStackA do when the terminal receives `poke`?"

Domain expert: "It should call `list_agent_tasks` over MCP and read its agent
inbox."

Dev: "What happens if two terminals are named @@FullStackA?"

Domain expert: "They share @@FullStackA's agent inbox. A new task to
@@FullStackA pokes both live terminals."

Dev: "Can @@FullStackA in team alpha receive tasks sent to @@FullStackA in
team beta?"

Domain expert: "No. Each team has its own team bus."

Dev: "What if two launches both use team name alpha?"

Domain expert: "They are the same team bus. Use a different team name when the
tasks must be isolated."

Dev: "Can a member override the Team Work routing identity with a custom
environment value?"

Domain expert: "No. Team Work identity is system-owned; custom environment
values are extras, not routing authority."
