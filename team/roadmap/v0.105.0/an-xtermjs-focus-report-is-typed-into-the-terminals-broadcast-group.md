# An xterm.js focus report is typed into the terminal's broadcast group

Status: raised for v0.105.0 by the owner's word of 2026-10-09, from the v0.104.0 release report's follow-ups; written down, not designed, not accepted for build.

## What was seen

A source reading, not a run. Under the xterm.js terminal backend a focus report (`CSI I` on focus-in, `CSI O` on focus-out, made when the terminal's program has enabled DECSET 1004) that is made while no output is being written is routed as the user's typing, so with broadcast on it is also sent to every other member of the terminal's broadcast group, whose programs did not ask for it. The record is `dev/v0104-team/reviews/review-Review104-item6-range-1.md`, section "Observations outside the range, for the lead", entry X1, marked there "existing on `main`" and "confirmed at source, not run": xterm.js emits the report through `onData`; `routeXtermData` sends it to this pty alone only while a live write is pending, and with no write pending calls `sendUserInput`, which runs `broadcastTerminalInput` for this window's members and sends `broadcast-input` for other windows. The review gives the trigger as broadcast on, focus reporting on in the source terminal's program, and a focus change while no output is being written, "which is the usual case", and adds that the same report takes two different routes by timing. The author of the ghostty-web repair named the same path first, as "read at source and not run, not changed" (`dev/v0104-team/reports/validation-Frontend104-item6.md`, section "Gaps and limits", third point).

The path is in the released tree as the review describes it, read again at the v0.104.0 commit: `web/packages/workspace-app/src/terminal/connection.ts`, `routeXtermData` (lines 53 to 67), calls `sendInput` only when the write tracker's origin is `live`, under the comment "Terminal-generated replies belong only to the PTY that emitted the query" (line 61), drops a replay-generated answer, and otherwise calls `sendUserInput`; `web/packages/workspace-app/src/components/TerminalTab.svelte`, `sendUserInput` (lines 2013 to 2021), calls `sendInput`, then `broadcastTerminalInput(tab, data)`, then sends a `broadcast-input` frame when `tab.broadcastEnabled`. The ghostty-web backend does not take this path: its report, added in v0.104.0, goes through `sendInput` to its own pty alone (`onGhosttyFocusChange`, line 2033 of the same component; `team/roadmap/done/ghostty-web-sends-no-focus-report.md`, section "Landed 2026-10-08").

It predates v0.104.0 by a source comparison, not by a replay: `terminal/connection.ts` is byte-identical between `main` at `9108113357f00c77393fd41932d1a0df2b7a09a8` and the composed tree `aee4705e71faebcaf34c7db827cf8b4e5e8f4646`, and the component's `sendUserInput` was not changed by the v0.104.0 range (`dev/v0104-team/reports/held-observation-dispositions-Lead104.md`, section "Review and provenance clarification 2026-10-08T18:06:22Z"). The release report lists it under "Observed without a repair" and in its Follow-ups (`team/release/release-v0.104.0.md`).

Not established: no run on any engine shows a focus report arriving in another member of a group, in the same window or in another; what a receiving shell or program does with a stray `CSI I` or `CSI O` was not observed; the server's fan-out of `broadcast-input` to other windows was not read for this item; nothing was observed on WebKitGTK, WKWebView or WebView2.

## Desired contract

The item asks for a decision. The choices the record names: a focus report under xterm.js goes to its own pty alone, as the ghostty-web report does and as the file's own rule for terminal-generated replies says, so that broadcast carries only what the user typed, pasted or dropped; or the present routing stands and is recorded as intended. If the first is chosen, a program in a broadcast group receives `CSI I` and `CSI O` only for focus changes of its own terminal.

## What to do

Reproduce before deciding. Pin the present routing at its seam: give `routeXtermData` the two report sequences with no write pending and with a live write pending, and read which sender each reaches. Then show the fan-out end to end where the library itself makes the report: two terminals of one broadcast group under the xterm.js backend, focus reporting enabled in the source terminal's program, a focus change with no output being written, and what each pty receives; the v0.104.0 record says the mounted xterm terminal of the component tests is a stand-in, so that xterm.js's own gate on the mode is not exercised by a unit test (`dev/v0104-team/reports/validation-Frontend104-item6.md`, section "Acceptance", point 2), and this half is therefore a browser capture in a guest unless a test can be shown to produce the library's report. Put the result and the two choices to the lead. The review's proposed repair, if wanted, is to route exactly the two report sequences through `sendInput` in `routeXtermData`, pinned for both origins; it is a proposal on the record, not a design.

## Boundaries

`web/packages/workspace-app/src/terminal/connection.ts`, `web/packages/workspace-app/src/components/TerminalTab.svelte` and their tests. Not changed: what broadcast does with typed input, pasted text and dropped paths; the ghostty-web report's route; the server's broadcast fan-out; the unseen-output dot's reading of focus.

## Acceptance

1. A written reproduction: with broadcast on and focus reporting enabled in the source terminal's program under xterm.js, what each group member's pty receives on a focus change with no write pending, with the engine named; or the reason no run could produce it.
2. The decision recorded here with its reason: own pty alone, or the present routing kept.
3. If own pty alone: a pin, red first on its own assertion, that a focus report under xterm.js reaches only its own pty with broadcast on, with no write pending and with a live write pending; typed input still reaches every member of the group, pinned.
4. If a product file changes: `make web-check` green at the commit in the owning guest.
