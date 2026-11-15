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

## Built, 2026-11-15

The split encoder places a bracketing template's prefix, paste-cleaned normalized body and first closing bracket in the body write. Only the remaining suffix is the separate chord. A template without a chord stays one write, an empty message sends only its chord, and an unterminated bracket keeps its suffix with the body without adding a closing marker. Built-in templates, unframed overrides and other agents keep their bytes. The shell design, configuration reference and cs manual describe the encoding.

The lead extended the range on 2026-11-15 to the actual queued split in chan-library: its body entry passes the resolved submit template to the shared encoder. Queue ordering and idle gates are unchanged. The queue regression checks both body and chord writes under Gemini and Muse overrides, with built-in byte controls. The original boundary above is retained for the lead's amendment at merge.

Red-first evidence is under `dev/v0131-team/evidence/Core131/bracketbody/20261115T003819Z/rust/`: `shell-red.log` records six intended assertion failures and one preservation control; `library-red.log` records the queued override failure and its passing built-in control. Both exit 101. The restored submit module passes 35 tests (`shell-submit-green.log`, exit 0), and the queue filter passes two (`library-green.log`, exit 0). Nine individual mutations fail at their intended assertions with exit 101 and pass after restoration with exit 0; `mutation-results.json` names each guard and test, with exact commands, source hashes and statuses in the adjacent per-run JSON files.

Check 990 is included under `scripts/e2e/browser-smoke/checks/990-delivered-bracket-end.mjs`. Its private server owns the Gemini and Muse bracketing overrides; seven legs capture clipboard paste and Codex, Gemini and Muse cs/Rich Prompt input. Exact PTY bytes and paste/key ordering are checked independently of the Rust proof of separate writes. The check and recorder pass syntax checks; its reader distinguishes actual historical good and bad captures. The new guest base/tip run, committed scoped gates and the two required reviews remain pending at this checkpoint; this section does not close acceptance 2. Real agent CLIs and desktop WebKit have not been exercised by this check.
