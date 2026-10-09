# Every click to a terminal tab sends focus-in, focus-out, focus-in

Status: raised for v0.105.0 by the owner's word of 2026-10-09, from the v0.104.0 release report's follow-ups; written down, not designed, not accepted for build.

## What was seen

A measured observation whose cause is not read. Each click that activates a terminal tab makes the page send its `focus {"focused": true}` message twice, 2 to 42 ms apart in the subject blocks of the two captures read below, and a program that has enabled focus reporting (DECSET 1004) receives focus-in, focus-out, focus-in (`CSI I`, `CSI O`, `CSI I`) where one focus-in is expected, so it runs its focus-lost and focus-gained handling one extra time per activation. The record is `dev/v0104-team/reviews/review-Review104-item6-range-1.md`, section "Observations outside the range, for the lead", entry X2, headed "existing, both backends": measured in the archived xterm.js capture and in the ghostty-web captures of the v0.104.0 repair, the three reports within 1 to 12 ms with the `focus` message sent twice, and "The cause is not read (the `focused` effect re-runs on `tabFocusPulse`; what takes the focus between the two is not established)".

Both captures were read again for this item, block by block. Under xterm.js: `../chan-dev/releases/v0103-team/evidence/Desktop103/terminal-dot/runs/capture-04/bus/xterm-standin-report.summary.txt` (a sibling checkout of the repository), four `click:DotSubject` blocks, each with `CSI I`, `CSI O`, `CSI I` sent to the clicked terminal within 1 ms by the summary's stamps and the `focus` message twice; that run's guest script (`payload/guest.sh` in the same run directory) names puppeteer's Chrome 154.0.8037.92 on Linux. Under ghostty-web: `dev/v0104-team/evidence/Frontend104/item6/capture-after.log`, twelve `click:DotSubject` blocks over three stand-ins on Chrome for Testing 155 headless (`dev/v0104-team/reports/validation-Frontend104-item6.md`, section "Acceptance", point 5): the eight blocks of the two stand-ins that turn reporting on each show the three reports within 12 ms, and all twelve blocks, the four of the stand-in with reporting off among them, show the `focus` message twice. In both files, where reporting is on, a click away from the subject sends it one `CSI O`. So the doubled `focus` message does not depend on the mode, and the three reports are what a program with the mode on sees of it.

Under ghostty-web a program sees this only since v0.104.0, which made that backend send the reports: the closed item records "on both backends every click to a terminal tab sends focus-in, focus-out, focus-in within milliseconds", "a shape present in the archived v0103 xterm capture and in this range's captures alike" (`team/roadmap/done/ghostty-web-sends-no-focus-report.md`, section "Landed 2026-10-08"), and the review says of it "Not this range's doing: with the repair the ghostty backend now shows what xterm.js users already had". The release report lists it under "Observed without a repair" and in its Follow-ups (`team/release/release-v0.104.0.md`).

The source the review points at, read at the v0.104.0 commit and not traced further: in `web/packages/workspace-app/src/components/TerminalTab.svelte` the effect at lines 524 to 549 runs when the tab is focused and again when the global tab-focus pulse changes, and each run calls `sendFocusState()` and then, in a microtask, `focusTerminal()`; the effect that starts at line 580 blurs the terminal and calls `sendFocusState()` when the tab stops being focused.

Not established: the cause, that is, what takes the focus away between the two focus-ins and why the `focus` message goes out twice; whether an activation by keyboard chord, by a command or by a pane focus change does the same, since both captures drive clicks on the tab strip; the behaviour on WebKitGTK, WKWebView and WebView2; any misbehaviour of a real program, since the record says only that a program's handlers run one extra time; whether the second `focus` message costs the server anything.

## Desired contract

The item asks for the cause and then a decision. The choices: one activation of a terminal tab sends one `focus` message and, with reporting on, one `CSI I`; or the present sequence stands and is recorded as accepted, with its cause. The release report words the question as whether the sequence "needs a change".

## What to do

Read the cause first: trace in `TerminalTab.svelte` what runs between the first focus-in and the focus-out on a tab click (the two focus effects, the tab-focus pulse, the pointer event on the tab strip, and what `focusTerminal` and `blur` do under each backend). Confirm the reading in a guest's Chrome with the existing capture driver or a constructed page, beside an activation that the reading predicts sends one report. Say whether keyboard and command activations share it, measured or not. Report the cause to the lead with the two choices before any change.

## Boundaries

`web/packages/workspace-app/src/components/TerminalTab.svelte`, the tab strip component where its pointer handling takes part, and their tests. Not changed: the reports themselves and their mode gate under either backend, the ghostty-web rule that a focus move inside the terminal sends nothing, the unseen-output dot's reading of focus, and the renderer recovery that the same focus effects run.

## Acceptance

1. The cause written down with its source lines and a run that shows it: what moves focus away and back on a tab click, on which backend and engine.
2. Whether an activation by keyboard chord and by command sends the same sequence: measured, or said to be unmeasured.
3. The decision recorded here.
4. If the decision is a change: a pin, red first on its own assertion, that one activation sends one `focus` message and, with reporting on, one `CSI I`, under both backends; a capture read again with one focus-in per click; a click away still sends one `CSI O`; `make web-check` green at the commit in the owning guest.
