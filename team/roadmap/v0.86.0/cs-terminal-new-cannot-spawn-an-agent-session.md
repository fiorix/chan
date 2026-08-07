# `cs terminal new` cannot spawn a session that derives an agent

Status: REGISTERED for v0.86.0, grounded 2026-08-06 from two independent projects.

## What

The submit chord is derived server-side from a session's spawn command plus `CHAN_AGENT` in its spawn env (`terminal_sessions.rs:3729`), never from what is running inside the PTY. `cs terminal new` offers no way to set either: it spawns the tenant's default shell, and the SPA attach path passes `command: None` (`routes/terminal.rs:637`).

So a shell tab that later runs an agent still derives to no agent, and every `cs terminal write --submit=<agent>` to it returns `SubmitRefused` (exit 69) while the text parks unsubmitted in the compose box.

## Why it matters more than it looks

The only control-socket route to an agent-carrying session is `cs terminal team new`, whose members carry a command and env. A single agent terminal spawned any other way, including a human's own manually started session, is permanently unpokeable.

This is not hypothetical and it is not rare. It burned the v0.85.0 delivery round: the host's own tab derived no agent, every lead poke to it parked unsubmitted, and the round had to fall back to an append-only inbox file as its host channel for the entire second half. A second project hit the same wall independently and produced the source-level trace above. Two projects reaching the same dead end by different routes is the argument that this is a missing capability rather than a workflow preference.

The failure is also quiet in the worst way: the poke is accepted, the ack reports a queue position, and only a later line notes that no chord was applied. An operator reading the first line concludes the message was delivered.

## Contract

- `cs terminal new` accepts the spawn command and env, mirroring the team member config: at minimum `--command <cmd>`, with the agent derived by the same whole-word sniff, and `--env KEY=VALUE` so `CHAN_AGENT` can force derivation for an unorthodox launcher.
- Identity stays fixed at spawn and server-derived. No write-side chord forcing, which would break the server-owns-encoding design.
- A session spawned this way is indistinguishable from a team member's session as far as `--submit` is concerned.

## Acceptance

- `cs terminal new` with a command that derives an agent produces a session whose derived agent appears in `cs terminal list`, and a `cs terminal write --submit=<agent>` to it submits rather than parking.
- The same session spawned without the new flags still derives no agent, so the change adds a capability rather than loosening the derivation.
- `CHAN_AGENT` passed through `--env` forces derivation for a launcher the sniff does not recognise, proven with a launcher that the sniff genuinely misses rather than one it already handles.
- The refusal path keeps its current behaviour and its exit code, so an ungranted submit still fails loudly rather than silently parking.

## Re-verified 2026-08-07

The defect and both citations hold exactly: derivation at `terminal_sessions.rs:3729-3733` from `spawn_opts.command` plus `spawn_opts.env["CHAN_AGENT"]`, the SPA attach path hardcoding `command: None` at `routes/terminal.rs:637`, and `cs terminal new` carrying only path and tab flags (`chan-shell/src/cli.rs:820-834`).

Three facts change the execution plan, and the third is a scope decision the item does not currently make:

1. **The control-socket route is five hops, not one.** Neither `ControlRequest::OpenTermNew` (`chan-shell/src/wire.rs:120`) nor the server-to-SPA `WindowCommand::OpenTermNew` (`chan-server/src/control_socket.rs:83`) nor `TerminalWsOptions` (`routes/terminal.rs:580-593`) carries command or env, which is why line 637 is hardcoded. Plumbing `cs terminal new --command/--env` spans CLI, wire, control socket, SPA TypeScript, WS query, and `CreateOptions`.
2. **The server half already exists on HTTP.** `POST /api/terminals` (`routes/terminal.rs:390`, body at `:57-77`) takes `command` and `env`, spawns through `terminal_sessions.create`, and already has `normalize_terminal_command` and `validate_terminal_env`. Only the control-socket surface is missing, and acceptance criterion 3 is provably reachable: `control_socket.rs:5747-5786` already asserts `CHAN_AGENT=codex` in env yields `agent: "codex"`.
3. **A restart-with-override path covers the case `--command` on `new` does not.** `POST /api/terminals/{session}/restart` (`routes/terminal.rs:456`) takes command and env overrides, and is how the team bootstrap flips the host's bash into the lead's agent. `cs terminal restart` exists (`cli.rs:884`) but preserves command and env. The round's burn scenario was an already-running shell tab, which a `new`-only flag cannot repair. The item must choose: `new` only, `restart --command/--env` only, or both surfaces.

## Ruling 2026-08-07: both surfaces

The owner accepted the route recommendation: implement both `cs terminal new --command/--env` and `cs terminal restart --command/--env`, sharing the wire and control-socket plumbing. `new` completes the capability this item was filed for; `restart` with overrides is the repair path for the burned scenario, an already-running shell tab, and dispatches onto the override behaviour `POST /api/terminals/{session}/restart` already implements. The acceptance below applies to both: a restarted session with a deriving command behaves identically to one spawned deriving, and `cs terminal restart` without the new flags keeps preserving the existing command and env.

## Interim workaround, which works today

A one-member team: `cs terminal team new <dir> --config <toml>` with a single `is_lead = true` member carrying the command and env. It is heavier than a plain terminal, since it writes a `config.toml`, a `bootstrap.md`, and a tasks and journals tree into the workspace, but it produces a correctly deriving, pokeable session over the control socket.

## Rough size

Small to medium. The derivation already exists and is already fed by the team path; this is plumbing the same two inputs through a second spawn route plus its CLI surface.
