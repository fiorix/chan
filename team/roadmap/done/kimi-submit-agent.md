# Kimi Code is a first-class submit agent

Status: SHIPPED in [v0.83.0](../release/release-v0.83.0.md). Kimi is a named submit agent with its own measured chord, command derivation, and SPA mirror.

## What

Kimi Code is a named terminal submit agent alongside Claude Code, Codex, Gemini, and OpenCode. A team member launched as `kimi`, `kimi --yolo`, or through an absolute Kimi launcher path derives to `kimi` without a `CHAN_AGENT` override. `cs terminal list` reports that identity, `cs terminal write --submit=kimi` is accepted, and generated team bootstrap material uses the Kimi submit chord.

The built-in Kimi encoding is bracketed paste followed by CR. It is byte-identical to Codex today, but it remains its own template and runtime override target (`CHAN_SUBMIT_KIMI` or `[kimi]` in `submit.toml`) so either client can change independently.

## Grounding

- Kimi Code 0.31.0 was live-probed on 2026-08-02. A bare CR inserts an editor newline; bracketed paste followed by CR submits.
- Kimi Code 0.31.1 was live-probed through an isolated team spawn on 2026-08-02. The command-derived session reported `kimi`; named and server-corrected Kimi submissions both completed, and the context counter advanced from zero.
- `SubmitAgent` in `chan-shell` owns the Rust name, command derivation, wire name, built-in template, and batching eligibility.
- `AgentTarget`, `agentForCommand`, and `agentForMember` in `teamDialog.svelte.ts` mirror the Rust command and `CHAN_AGENT` derivation for Team Work bootstrap.
- The server derives the target session's agent at enqueue time. A sender naming the wrong agent is corrected to Kimi and receives the existing divergence note.

## Contract

- Kimi has a distinct `SubmitAgent::Kimi` variant and a distinct built-in chord match arm.
- Whole-word command matching recognizes bare, flagged, and absolute-path Kimi launchers without matching a containing word such as `kimiko`.
- Kimi's proven built-in template is eligible for chronological notification batching; runtime overrides remain singleton boundaries like every other override.
- The CLI help rendered by `chan dump-skill`, the Team Work dialog hint, generated bootstrap roster and poke guidance, submit configuration reference, and chan-shell design all enumerate Kimi.
- `CHAN_AGENT=codex` remains a valid explicit override for operators who still want that identity.

## Acceptance

- A Kimi member needs no `CHAN_AGENT` entry to derive and report `kimi`.
- Kimi input reaches the PTY as one exact `\x1b[200~` + normalized body + `\x1b[201~\r` write.
- A wrong requested submit agent is corrected to the target's Kimi identity and encoding.
- The Rust and TypeScript derivation matrices agree for bare commands, launcher paths, case folding, near misses, and `CHAN_AGENT` overrides.
