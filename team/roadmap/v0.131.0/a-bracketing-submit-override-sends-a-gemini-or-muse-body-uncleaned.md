# A bracketing submit override sends a gemini or muse body uncleaned

Status: accepted for v0.131.0 by the owner on 2026-11-14 (`dev/v0131/decisions.md`, point 11: "as you recommend"); not started. It has a security side.

Record: a follow-up of v0.130.0 with no row (its release record, "Follow-ups", the bracketed paste end; `dev/v0130/reports/pastend-1-handback.md`): under an override template that brackets, a gemini or muse body is sent raw and the chord write is an empty `ESC[200~ESC[201~\r`, as before that release's fix; and the delivered-paste reading (check 990) is evidence only, not committed. The decisions document for v0.131.0 sorted it as a row of its own, the residue of v0.130.0's paste-end row; the owner took that recommendation.

## What is there now

Read at `f7457becb`, by reading.

- For gemini and muse, `splits_submit_chord` (`crates/chan-shell/src/submit.rs`, around line 410) splits a submitted message into two writes, the body and then the chord, so a body and its bare CR never share a write. `plan_submitted_input` (around line 425) sends `submitted_body_bytes(text)` and then `submit_chord_bytes(submit)`.
- When a submit override's template brackets the text (`ESC[200~{}ESC[201~` and a chord), the split sends the body without the cleaning and framing the bracketed form gives every other agent, and the chord write is the template with an empty body: `ESC[200~ESC[201~\r`. Control bytes inside a body another agent sent therefore reach the receiving agent's input as keys, which is what v0.130.0's paste-end fix closes for the other agents.

## Desired contract

1. Whenever the resolved template brackets, a gemini or muse body is cleaned and framed as the bracketed form cleans and frames any other agent's body, including the `ESC[201~` an inner text holds, and still lands as its own write ahead of the chord.
2. The chord write carries no empty bracket pair.
3. The built-in templates and every agent's output without an override are unchanged.

## Boundaries

- `submit.rs` in chan-shell (the split and the body's encoding) and its tests; browser check 990 committed under `scripts/e2e/browser-smoke/checks/` with its reading.
- Not here: which agents split, and the built-in chords.

## Acceptance

1. chan-shell tests: under a bracketing override, a gemini body and a muse body holding `ESC[201~` and other control bytes are written cleaned and framed, and the chord write holds no `ESC[200~ESC[201~`; red on today's code. Without an override the bytes are unchanged.
2. Check 990, committed, run in a guest against a gemini-shaped stand-in under a bracketing override: the delivered body arrives as one paste with no control byte acting as a key; red at the base.
