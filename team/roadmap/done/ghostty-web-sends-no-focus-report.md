# ghostty-web sends no focus report to the pty

Status: shipped in [v0.104.0](../../release/release-v0.104.0.md).

Record before the release: accepted for v0.104.0 by the owner's word of 2026-10-08; a small repair with its test.

## What was seen

A program that enables focus reporting (DECSET 1004) gets no focus-in or focus-out report under the ghostty-web terminal backend; xterm.js sends them. The v0.103.0 report's Follow-ups record it. `web/packages/workspace-app/src/components/TerminalTab.svelte` names the mode at its reset of the mouse and focus modes (line 1563, `\x1b[?1000;1002;1003;1004;1006;1015l`) and relies on the report in its unseen-output reading (the comment at line 1762: a program with focus reporting on answers the terminal's own focus-out report).

## Desired contract

Under either backend, a program that has enabled focus reporting receives `CSI I` on focus-in and `CSI O` on focus-out, and nothing when it has not enabled it.

## What to do

Read where the terminal's focus changes reach the backend and where xterm.js emits the report; add the report for ghostty-web at the same seam, gated on the mode, red first with a backend test that enables 1004, focuses and blurs, and reads the pty input.

## Boundaries

`web/packages/workspace-app/src/components/TerminalTab.svelte` and the terminal backend files under `web/packages/workspace-app/src/terminal/` with their tests. The unseen-output dot's server-side reading is unchanged.

## Acceptance

1. Under ghostty-web with 1004 on, focus-in sends `CSI I` and focus-out sends `CSI O` to the pty; pinned red first.
2. With 1004 off, nothing is sent on focus changes under either backend; pinned.
3. xterm.js's reports are unchanged; its existing tests still pass.
4. `make web-check` green at the commit in the owning guest.
5. With the repair, under ghostty-web, a program that answers the focus-out report with invisible bytes raises no unseen-output dot across tab switches, and a visible repaint and a printing shell raise it, as the xterm.js capture of [an-idle-codex-tab-raises-the-unseen-output-dot-on-every-switch](an-idle-codex-tab-raises-the-unseen-output-dot-on-every-switch.md) reads; that closed item says its proof does not reach this backend, and this repair turns the stimulus on.

## Landed 2026-10-08

The frontend seat's range of two commits is on the integration branch at `f016f47606d27a2e736ada2268488b9e36493746` (`dev/v0104-team/reports/validation-Frontend104-item6.md`): under the ghostty-web backend a terminal whose program has enabled focus reporting sends `CSI I` on focus-in and `CSI O` on focus-out to the pty, as xterm.js does, and a focus move inside the terminal (the kit focusing its own input on a click or a right click) sends nothing; with the mode off nothing is sent under either backend; nineteen lines of `TerminalTab.svelte` and the backend's test. Red first at `bfcaa9ada` on its own assertions; `make web-check` green at the tip (7,390 tests); the three named mutants killed, each on its own assertion; the capture under ghostty-web reads as acceptance 5 asks (a program answering the focus-out report with invisible bytes raises no unseen-output dot across tab switches, a visible repaint raises it with the server counting the bytes, a program with no reporting raises nothing, a printing shell raises it), against a before-capture with no focus report sent at all. The reviewer accepted the range with no finding (`dev/v0104-team/reviews/review-Review104-item6-range-1.md`) and settled the author's one open question with the real kit in Chrome 155 on a constructed page: a click from outside sends one `I`, a click outside one `O`, and sixteen focus moves between the host and the kit's textarea send nothing under the range's rule; the product's page beyond the captures, the native webviews and the window itself losing focus are not observed. Two readings outside the range are held for a later version: under xterm.js a focus report made while no output is being written is routed as user input and, with broadcast on, typed into every other member of the group; and on both backends every click to a terminal tab sends focus-in, focus-out, focus-in within milliseconds, so a program with focus reporting runs its handlers one extra time per activation, a shape present in the archived v0103 xterm capture and in this range's captures alike.
