# Agent terminal submit suffix

Status: REGISTERED for v0.80.0, validated 2026-07-29, ready to spec.

When submitting content through the terminal queue to an agent, always append a newline. Shell terminal writes keep their existing behavior.

Make the newline suffix part of the public contract in command help and in `chan dump-skill`, and cover the agent and shell cases independently.

## Validation (2026-07-29)

Rulings taken during validation: the motivation is consistency and robustness (a singleton submit ends with one `\n` exactly as the batch framer already delivers per message, and a non-firing chord stacks queued messages instead of concatenating them), and the suffix applies to ALL submit encodings at the funnel: `cs terminal write --submit`, Rich Prompt, and the team-spawn identity poke. This supersedes two records in [terminal-submit-chord-authority](../done/terminal-submit-chord-authority.md): the "Rejected fix: appending a trailing newline" section, and acceptance item 7 (Rich Prompt untouched).

Semantics: normalize, never blind-append. A submit body is delivered as `trim_end_matches('\n')` plus exactly one `\n` ahead of the chord, so senders that already pass a trailing newline stay idempotent; an empty body stays chord-only. Raw writes stay verbatim on both axes: no `--submit` anywhere, and a derived-shell target under `--submit` (refused, exit 69) still delivers the raw bytes untouched. The "No newline is appended" raw-write contract in the help stays as written.

Live probes (tmux PTY rig; claude 2.1.220, codex 0.145.0, gemini 0.51.0, opencode 1.18.4):

- `body\n` + chord submits on all four agents in their production delivery shapes (claude coalesced and batched two-part with the 50 ms gap, codex/opencode bracketed paste + CR, gemini split body then bare CR one gap later). The trailing newline is invisible to cosmetic in every history.
- A bare trailing LF self-submits NOWHERE: chordless `msg one\n` then `msg two\n` parks and stacks on separate composer lines in all four agents, while today's trimmed bytes reproduce the `msg onemsg two` concatenation on all four. The gemini early-submit worry is refuted on 0.51.0: the same-write Return conversion applies to LF too.
- Cross-chord: the claude chord into codex parks and stacks, which is the failure shape the suffix exists for. Codex-shaped bytes into claude 2.1.220 now SUBMIT, so the pre-0.74 claude/codex breakage matrix is stale in that direction.

Seam: `submitted_body_bytes` (`crates/chan-shell/src/submit.rs:285`) and the `apply_template` arm of `plan_submitted_input` (`submit.rs:335`), plus `apply_submit_chord` (`submit.rs:355`) for the spawn poke. NOT the templates (`submit.rs:196-203`): an env/file override replaces the whole template and would silently drop a template-embedded suffix. `format_notification_batch` already emits the per-message `\n` (`crates/chan-library/src/terminal_sessions.rs:2302-2303`); trim-then-append-one keeps the framed bytes stable, with `batch_framing_overhead` (`terminal_sessions.rs:2257-2271`) and its formatter pin moving in lockstep if the framed length changes.

Contract surfaces: the write about line (`crates/chan-shell/src/cli.rs:834`), the `--submit` arg doc (`cli.rs:843-856`), `CS_TERMINAL_WRITE` (`crates/chan-shell/src/help.rs:1373-1377` raw paragraph stays; `1399-1400` and `1411-1413` reword) and the examples in `CS_TERMINAL_WRITE_AFTER`; `docs/config-reference.md:35,51`; `crates/chan-shell/design.md:140-146`. `chan dump-skill` needs no separate edit: it renders the live long help (`crates/chan/src/skill.rs:449-461`).

Tests: flip the encoding pins in `submit.rs:498-530,616-676` (the raw pin at `:646` stays) and the delivery pins in `terminal_sessions.rs:3891,3949,4272-4291,4396-4496,4481,4756-4797,4847`; the shell pin at `:3919-3946` stays verbatim as the shell half of the independent coverage. Add the new pair beside the `delivered_input` harness: an agent submit delivers body, one `\n`, chord; a shell raw write is byte-identical in and out. `encodeForAgentSubmit` (`web/packages/workspace-app/src/terminal/submitMode.ts:39-66`) is unreferenced outside its own test: delete it or re-wire it with parity coverage when the suffix lands.

## Write-size cap (folded into this item)

Today: the CLI reads stdin to EOF unbounded (`cli.rs:2025`); the only wire bound is `MAX_CONTROL_REQUEST_BYTES`, 48 MiB for the whole JSON line (`crates/chan-shell/src/wire.rs:50`, `crates/chan-server/src/control_socket.rs:807`), sized for `cs copy`, not writes; the queue caps entries (`WRITE_QUEUE_CAP` 100), not bytes; `WRITE_QUEUE_BATCH_MAX_BYTES` (64 KiB) bounds only the framed batch, and an oversized head deliberately drains whole as a singleton. Nothing keeps a multi-MiB write out of the queue or out of an agent's composer.

Ruled 2026-07-29: every write is capped, raw and submit alike, at 4096 bytes per logical message. The cap is a design statement, not just defense: the terminal queue is a bus for pokes, and content above poke size moves through the medium built for it, a file the poke points at. The write help teaches that redirect next to the newline contract: over-cap content goes to a file, the poke carries its path. Enforce it two-tier like the clipboard: the CLI bounds the read with `take(4096+1)` and errors early (the `cs copy` pattern, `cli.rs:1897-1911`), and the server refuses an over-cap body at the queue (`push_message`, `crates/chan-library/src/terminal_sessions.rs:2122-2148`), which binds `cs terminal write`, Rich Prompt, and any direct control client in one place. Refuse, never truncate; each surface already carries a refusal signal (the typed `term_write` failure ack; `PromptAck queued:false` for Rich Prompt). `WRITE_QUEUE_BATCH_MAX_BYTES` (64 KiB) stays as the batch bound: a drain still frames many small messages into one turn. The team-spawn identity poke bypasses the queue (`write_input_matching`) and sits well under the cap by construction (`crates/chan-server/src/routes/team_config.rs:615`).

## Adjacent, out of scope

Recorded for later items: Rich Prompt resolves the chord from the SPA-sent agent name with a claude default (`crates/chan-server/src/routes/terminal.rs:761-764`), never the server-side derive, so a shell tab reached via Rich Prompt gets the SPA's bare-CR fallback; `scripts/e2e/terminal-queue-drain.sh:647` sets `CHAN_SUBMIT_*` in the writer env, inert since template resolution moved server-side.
