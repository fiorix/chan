# Chan

Chan is a local-first workspace where a human can edit notes and coordinate
local agent processes around the same work.

## Language

**Agent handle**:
The addressable `@@Name` identity for one agent in a Team Work session. Names
without the `@@` prefix are normalized to this form; routing is case-sensitive.
_Avoid_: tab name, session id, process id

**Agent inbox**:
The bounded set of recent messages addressed to one agent handle inside a team
bus.
_Avoid_: watcher directory, notification file

**Agent message**:
An inline text message from one agent handle to another, optionally pointing at
a workspace path for context. The sender is the connected agent handle, not a
caller-supplied field.
_Avoid_: event file, filesystem notification

**Agent poke**:
A minimal terminal wake-up line sent to a live agent terminal after a message is
stored in that agent's inbox. The poke is only a signal to call
`list_agent_messages`; it is not the message body or a shell command that reads
the inbox directly.
_Avoid_: event command, watcher notification

**Poke contract**:
The instruction given to agents that a standalone `poke` received in the
terminal means "call `list_agent_messages` over MCP". The contract is surfaced
in MCP-facing session guidance and in the Team Work identity prompt.
_Avoid_: hidden wake behavior, shell command injection

**Shared agent inbox**:
One inbox per agent handle inside a team bus. If multiple live terminals share
the same team bus and handle, they share the same inbox and all matching
terminals receive the agent poke.
_Avoid_: per-session inbox, tab-local messages

**Team bus**:
The isolated message space for one Team Work team. Agent messages are visible
only within their team bus; matching agent handles in different teams do not
share messages or pokes.
_Avoid_: workspace-wide bus, cross-team channel

## Example Dialogue

Dev: "When @@Architect sends a message to @@FullStackA, what identifies the
recipient?"

Domain expert: "The recipient is @@FullStackA, the agent handle. @@FullStackA
then reads its own agent inbox."

Dev: "Where does a large artifact go?"

Domain expert: "The artifact belongs in the workspace. The agent message can
point at that workspace path."

Dev: "What should @@FullStackA do when the terminal receives `poke`?"

Domain expert: "It should call `list_agent_messages` over MCP and read its
agent inbox."

Dev: "What happens if two terminals are named @@FullStackA?"

Domain expert: "They share @@FullStackA's agent inbox. A new message to
@@FullStackA pokes both live terminals."

Dev: "Can @@FullStackA in team alpha receive messages sent to @@FullStackA in
team beta?"

Domain expert: "No. Each team has its own team bus."
