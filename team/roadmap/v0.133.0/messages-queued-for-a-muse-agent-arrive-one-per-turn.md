# Messages queued for a Muse agent arrive one per turn

Status: accepted for v0.133.0 by the owner on 2026-11-20 ("when i was using the muse client, i could not see multiple 'cs terminal write' messages being flushed at once like we do for claude; wanted to check if this of flushing is wired to all agents, and i expect it does"). Probe budget set by the owner the same day: about ten real-model turns for the confirmation, Muse's echo provider for the repeats ("About 10 turns (Recommended)"). Not started.

Record: raised by the owner on 2026-11-20 while running Muse agents in chan terminals. His expectation does not hold in the code: the queue batches only for agents whose delivery shape was proven, and Muse was left out on purpose. No earlier reading of a Muse batch exists; the only Muse probe on record (Muse Code 1.4.2, 2026-10-03) sent three single messages, each one submission, with no model reply on that account, and did not measure whether Muse needs Gemini's split.

## What is there now

Read at `793d86522`.

- `ResolvedSubmit::is_batchable` (`crates/chan-shell/src/submit.rs`) names agy, claude, codex, kimi and opencode; its comment says gemini and muse remain singleton boundaries.
- Muse is encoded as Gemini: the built-in template is `{}\r`, and `splits_submit_chord` splits every non-empty Muse message into a body and a bare CR. The queue stores those as two entries, `MessagePart::Body` and `MessagePart::Chord` (`message_parts` in `crates/chan-library/src/terminal_sessions.rs`), separated by a full idle gate. `batch_boundary` stops a batch at any entry that is not `Whole` (`BatchStopReason::SplitWrite`) before it reaches `is_batchable`, so naming Muse there alone would change nothing: a Muse batch needs a delivery shape that is one entry per message.
- Gemini's reason is recorded on `WRITE_QUEUE_INPUT_GAP`: it did not preserve a 64 KiB batch under any tested fixed gap below the idle threshold.
- The live probe `scripts/e2e/terminal-queue-drain.sh` has arms for codex, claude, gemini and opencode, not Muse. It needs a connected browser window (`require_connected_window` in `crates/chan-server/src/control_socket.rs`), so it runs beside a browser page.
- `crates/chan-shell/design.md`, the `cs terminal write` help (`crates/chan-shell/src/help.rs`) and the configuration reference say gemini and muse take a separate CR and end a batch.

Read on 2026-11-20 against Muse Code 1.4.24 (1.4.24-R9131.1) in an isolated guest, on a PTY with no chan in between: a fresh Muse with its echo provider per trial, which replies with exactly what Muse accepted as a user turn, and Muse's own session log as the oracle (one `runtime.user_intent.accepted` record per submitted message, with its text). A framed batch of 5 messages of 3.5 KB (single-line and multi-line bodies) and of 16 messages of 3.9 KB (63896 bytes, at the 64 KiB ceiling) arrived as exactly one turn with its text intact under every shape tried: body and CR in one write, CR 50 or 200 ms after the body, CR after 800 ms of quiet output, bracketed paste and CR in one write, and bracketed paste with the CR 50 ms later. The instrument's two negative controls read as they must: a body with no CR was never submitted, and two bodies with a CR each in one write were two turns. So Muse 1.4.24 does not share Gemini 0.51's fault.

## Desired contract

1. Messages queued for a Muse agent while it generates drain as one turn, oldest first, as they do for Claude, under one proven delivery shape: the body framed in bracketed paste and the CR in the same write, as agy, codex, kimi and opencode take it. The bracket makes the control bytes of a notification body inert, which a bare `{}\r` would deliver as keys.
2. A single submitted message to Muse is one queue entry in the same shape and still arrives as one turn.
3. A raw write, a Rich Prompt turn, a runtime override and a different agent still end a Muse run, as for the other batchable agents.
4. Gemini is unchanged and stays a singleton boundary: no signed-in Gemini CLI is on this host, so it was not re-read and its recorded reason stands.
5. `cs terminal write --help`, the configuration reference and the design documents say which agents take a batch and which take one message per turn.

## Boundaries

- `crates/chan-shell/src/submit.rs` (Muse's template, the split and `is_batchable`) with its tests; the queue's tests in `crates/chan-library/src/terminal_sessions.rs` (no change to the drain's functions is expected); the server's Muse submit tests; the probe script; the documents.
- Claude's and the other proven agents' bytes do not change, and Gemini keeps its split.

## Acceptance

1. The probe gains a Muse arm, and its runs are recorded per run: the shape, the gap, the payload size and the verdict by the load-bearing oracle. Within the owner's budget: one batch run and one boundaries run on the real model; the repeats on the echo provider.
2. Crate tests, red at the base: a Muse session's queued run selects as one batch, a Muse message is one entry in the bracketed shape, and a mutation of the new arm turns a case red. The existing batch and boundary tests stay green.
3. A reading in the guest at the tip: five messages queued while Muse generates arrive as one turn; one raw write between them splits the run.
4. The terminal suite; two Fable readers; `ci.yml` dispatched on the integration tip.
