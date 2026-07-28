# Agent terminal submit suffix

Status: REGISTERED for v0.80.0, NOT specced.

When submitting content through the terminal queue to an agent, always append a newline. Shell terminal writes keep their existing behavior.

Make the newline suffix part of the public contract in command help and in `chan dump-skill`, and cover the agent and shell cases independently.
