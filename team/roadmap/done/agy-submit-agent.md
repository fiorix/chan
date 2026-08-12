# Google Antigravity is a first-class submit agent

Closed: shipped in [v0.89.0](../../release/release-v0.89.0.md).


Status: IMPLEMENTED for v0.89.0, live-probed and registered 2026-08-12 on the owner's instruction; suite validation rides the round's CI run.

## What

Google Antigravity's `agy` CLI, the successor of gemini, is a named terminal submit agent alongside Claude Code, Codex, Gemini, Kimi Code, and OpenCode. A team member launched as `agy`, `agy --continue`, or through an absolute launcher path derives to `agy` without a `CHAN_AGENT` override. `cs terminal list` reports that identity, `cs terminal write --submit=agy` is accepted, and generated team bootstrap material uses the agy submit chord.

The built-in agy encoding is bracketed paste followed by CR. It is byte-identical to Kimi and OpenCode today, but it remains its own template and runtime override target (`CHAN_SUBMIT_AGY` or `[agy]` in `submit.toml`) so any of the three clients can change independently.

Gemini remains a supported submit agent. The owner's ruling is that gemini will be marked for deprecation in an upcoming version, with the timing not yet decided; nothing in this item removes or changes gemini behavior.

## Grounding

- Antigravity CLI 1.1.12 was live-probed on 2026-08-12 in a PTY harness on the development host, signed in against a configured account, with submission proven by a model answer that cannot appear in the question's own echo.
- Its shortcut help documents `enter` as "Send message or confirm" with `alt+enter`, `ctrl+j`, and `shift+enter` inserting newlines. At startup it enables bracketed paste, xterm modifyOtherKeys, and kitty keyboard progressive enhancement.
- Every probed delivery submits: text plus CR in one write, a CR in its own later write, and bracketed paste plus CR in one write. Interior newlines inside a paste stay editor newlines; raw burst input is coalesced with the trailing CR still submitting.
- A three-line body with a blank line (the notification-batch shape) and a 33 KiB paste-sized body each landed as ONE message through the bracketed form, which is what qualifies the built-in for chronological batching.
- The bracketed form is the default because it is the only probed shape whose one-message guarantee does not depend on the CLI's burst-coalescing timing.
- `SubmitAgent` in `chan-shell` owns the Rust name, command derivation, wire name, built-in template, and batching eligibility; `AgentTarget`, `agentForCommand`, and `agentForMember` in `teamDialog.svelte.ts` mirror the derivation for Team Work bootstrap.

## Contract

- Agy has a distinct `SubmitAgent::Agy` variant and a distinct built-in chord match arm.
- Whole-word command matching recognizes bare, flagged, and absolute-path agy launchers without matching a containing word such as `stagy` or `agyle`.
- Agy's proven built-in template is eligible for chronological notification batching; runtime overrides remain singleton boundaries like every other override.
- The CLI help rendered by `chan dump-skill`, the Team Work dialog hint, generated bootstrap roster and poke guidance, the submit configuration reference, and the chan-shell design doc all enumerate agy.
- The SPA's `submitMode.ts` union names every known agent identity, including kimi, whose omission there predates this item; protocol inference still only ever produces claude, codex, or gemini.

## Acceptance

- An agy member needs no `CHAN_AGENT` entry to derive and report `agy`.
- Agy input reaches the PTY as one exact `\x1b[200~` + normalized body + `\x1b[201~\r` write.
- The Rust and TypeScript derivation matrices agree for bare commands, launcher paths, case folding, near misses, and `CHAN_AGENT` overrides.
- The round's CI run is the validation gate for the new Rust and vitest assertions; no cell is claimed verified beyond the live CLI probes above until it is green.
