# Messages queued for a Muse agent arrive one per turn

Status: shipped in [v0.133.0](../../release/release-v0.133.0.md): messages queued for a Muse agent while it generates drain as one turn, oldest first, as bracketed paste and CR in one write, and a single message is one queue entry; a raw write, a Rich Prompt turn, an override and another agent end a run, and Gemini keeps its split (`v0133/musebatch` at `18b79aaf2`, merged into `v0133/int-muse` as `d914ef1ba`, which merged into `v0133/int` as `9fa6729f6`). Read by crate tests red at the base, by check 331, red at the base, green at the tip and green in the whole browser suite on `49f7491b2`, by a real Muse Code 1.4.24 on its echo provider, and by the probe on the real model within the owner's budget of about ten turns; two readers accepted with notes. Gemini was not re-read. Nothing is open for the owner.

Record before the release: accepted for v0.133.0 by the owner on 2026-11-20 ("when i was using the muse client, i could not see multiple 'cs terminal write' messages being flushed at once like we do for claude; wanted to check if this of flushing is wired to all agents, and i expect it does"). Probe budget set by the owner the same day: about ten real-model turns for the confirmation, Muse's echo provider for the repeats ("About 10 turns (Recommended)"). Built and reviewed on 2026-11-20 on `v0133/musebatch` at `f8abd9750`; see "Built" below.

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

## Built, 2026-11-20

Muse's built-in template is bracketed paste and CR in one write (`\x1b[200~{}\x1b[201~\r`), Muse no longer splits its chord (`splits_submit_chord` and `split_bracketed_template` name Gemini alone), and `is_batchable` names Muse. A Muse message is one `Whole` queue entry, so a run of submitted Muse messages selects and drains as one framed, bracketed turn, and the drain's functions are unchanged. A Muse override, bracketing or not, is one write and a batch boundary, as every other non-splitting agent's is. The team bootstrap's chord line for a Muse member reads `bracketed-paste + \r`. `cs terminal write --help`, `crates/chan-shell/design.md`, `docs/config-reference.md`, `.agents/orchestration/README.md` and the manual's `cs` page say that agy, claude, codex, kimi, muse and opencode take a batch and gemini one message per turn. The probe `scripts/e2e/terminal-queue-drain.sh` has `--agent muse`. Commits `f3d676c03`, `209b61295`, `4eb5c323a`, `f8abd9750`.

Evidence, in `dev/v0133/lanes/muse/` of the development tree:

- Crate tests, red at the base (written before the code): chan-shell 10 of 35 submit tests, chan-library 5, chan-server 2; green at the tip. Two mutations by the builder and eight by a reviewer (Muse left splitting, unbracketed, the body not cleaned, an override made batchable, Gemini losing its split, batched Muse sent as Claude's two parts, among them) each turn named tests red. Scoped gate at `4eb5c323a`: fmt, clippy of the three crates, their whole test suites (chan-library 997, chan-server 2637 and 1, chan-shell 180), rustdoc, the help width test, shell-check; `f8abd9750` changes only the probe (bash -n and shellcheck green).
- Check 331 (`331-muse-batch-delivery`, a raw PTY recorder named `muse`): at the base ten deliveries, each body and then its bare CR, the depth stepping 5 to 0; at the tip one delivery, `ESC[200~`, the framed five-message batch, `ESC[201~` and CR, depth 5 straight to 0, and the raw-write boundary leg as three deliveries in order. The check reads deliveries by time, not PTY writes, so "the CR in the same write" rests on `five_muse_notifications_drain_as_one_bracketed_input_and_one_depth_event`.
- A real Muse Code 1.4.24 TUI with its echo provider, spawned through the server with `--command` so the server derives the agent, five and sixteen queued messages while it repainted: at the base each message was its own turn; at the tip one turn of 20017 and of 63773 bytes, three runs each, and the boundary leg 3 of 3 (Muse's own session log as the oracle). This harness is the development tree's (`tools/muselane-echo-batch.mjs`), since the probe's sentinels need a real model.
- The probe on the real model, within the owner's budget: one batch run (`sentinel=QUEUE_DRAIN_BATCH_5 tokens=ok depth_trace=5x92:0x1`) and one boundaries run (`order=ok depth_trace=5x142:4x102:3x13:2x315:1x12:0x1`), both green. Ten real turns were spent in all, the readings above included.
- Check 990 unchanged and green at the tip (its Muse legs now arrive as one write, with the same bytes). The terminal suite (J240's 25 checks, 292, 294, 296, 121, 990 and 331) green at the tip in one runner call, 31 of 31.
- Two Fable reviews, a correctness one and a test-honesty one with its own mutants: accept with notes, nothing blocking.

Gemini was not re-read: no signed-in Gemini CLI is on the host, so its recorded reason stands.
