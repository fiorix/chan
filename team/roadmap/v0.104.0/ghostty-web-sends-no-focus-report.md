# ghostty-web sends no focus report to the pty

Status: accepted for v0.104.0 by the owner's word of 2026-10-08; a small repair with its test.

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
5. With the repair, under ghostty-web, a program that answers the focus-out report with invisible bytes raises no unseen-output dot across tab switches, and a visible repaint and a printing shell raise it, as the xterm.js capture of [an-idle-codex-tab-raises-the-unseen-output-dot-on-every-switch](../done/an-idle-codex-tab-raises-the-unseen-output-dot-on-every-switch.md) reads; that closed item says its proof does not reach this backend, and this repair turns the stimulus on.
