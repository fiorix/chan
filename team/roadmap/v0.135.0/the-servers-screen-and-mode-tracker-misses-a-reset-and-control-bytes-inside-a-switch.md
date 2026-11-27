# The server's screen and mode tracker misses a reset and control bytes inside a switch

Status: accepted by the owner on 2026-11-27 (the last section); not started. Not built in v0.135.0, so the GA commit moves it to the next version (D130).

Record: found by the carbon review of the lost tail's first fix (`dev/v0135-team/reviews/review-redial-tail-agy.md`, S2, probes P4, S4a and S4b) and named again by the Fable review of its second (`dev/v0135-team/reviews/review-d129-fable.md`, F7) and by the builder (`dev/v0135-team/followups/followup-Core135-Lead135-39.md`, "Not done"). The tracker predates the round; the lost tail's fix inherits it, as the recovery suffix already did.

## What is there now

Read at `c898ce40d` and on `v0135/redial-tail`, by the probes named.

- The session follows the program's alternate screen and private modes by scanning its output for DEC private mode sequences (`scan_private_modes` and `update_alt_screen` in `crates/chan-library/src/terminal_sessions.rs`). That state feeds the recovery suffix (`mode_reassert`) and, from v0.135.0, the replay's start screen in the session frame (`replay_screen`).
- The scan does not follow a full reset (`ESC c`, which `reset` and `tput reset` send). After one on the alternate screen the session still reads the alternate screen and the program's modes as on, so a later lossy recovery switches a correct normal-screen view back to the alternate screen and reasserts dead modes (carbon probe S4a).
- The scan reads a switch with a C0 byte other than CAN, SUB or ESC, or a DEL, inside its CSI (`ESC[?10 DEL 49l`, `ESC[?10 CR 49l`) as no switch, while the terminal core completes it (carbon probes P4, S4b). The view's keyboard protocol observer skips those bytes as the core does (`web/packages/workspace-app/src/terminal/keyboardProtocolStream.ts`).
- A grouped DECSET or DECRST longer than 64 bytes and split across PTY reads is not carried across the split (carbon S2).
- The server test's screen model (`drawn_screens` in `crates/chan-server/src/routes/terminal_streamlag_tests.rs`) misreads `ESC ESC [` and CSI intermediates (carbon S2).

## Desired contract

1. The session's alternate-screen and private-mode state follows a full reset: after `ESC c`, including one split across reads, the screen reads normal and every tracked mode reads off.
2. A switch or mode sequence with C0 or DEL bytes inside its CSI is read as the terminal core reads it.
3. A tracked sequence split across reads is carried whatever its length, or the limit is stated and its consequence named.
4. The server test's screen model reads these bytes as the core does.

## Boundaries

- The scanner and the session's mode state in `crates/chan-library/src/terminal_sessions.rs`, the server test model, and their tests. The suffix's and the field's bytes change only for streams these cases reach.

## Acceptance

1. Library tests, red at the base, for each case above, compared against the vendored core's reading of the same bytes.
2. Server tests: a lossy redial after `ESC c` on the alternate screen gets the plain suffix and `replay_screen` naming the normal screen; red at the base.

## Accepted, 2026-11-27

Accepted by the owner on 2026-11-27 ("yes", `dev/v0135-team/decisions.md`, D130), answering the lead's recommendation to take the tracker's gaps as one server row. Drafted as a lead document and not built in v0.135.0.
