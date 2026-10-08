# The welcome runs a WebGL2 animation on a software WebGL context

Status: accepted for v0.104.0 by the owner's word of 2026-10-08 as a measurement and a survey; measured on 2026-10-08, and the owner chose the 2D fallback by survey the same day (see Owner decision); the change is built after the command-upload item on the frontend seat.

## What was seen

In a browser with no GPU, the empty pane's welcome runs a WebGL2 animation on a software WebGL context. Over seven recorded runs of browser check 62 at the v0.103.0 candidate and its rc1 pin, the two slow runs (1.99 and 2.00 of the guest's two cores at 59% and 70% CPU pressure; the rc1 whole-suite run among them took about 144 seconds to reach the chooser against about 99 alone) logged Chrome's software WebGL fallback line and showed WebGL2 welcome animations in their screenshots; the five normal runs lacked the line. That is an association, not a shown mechanism, as the v0.103.0 report and the closed item [check-62-asks-for-a-file-chooser-without-a-user-gesture](../done/check-62-asks-for-a-file-chooser-without-a-user-gesture.md) record. On new session storage `initialEmptyPaneAnimation()` picks at random among the animations, twelve of 23 starting a WebGL2 animation on mount at v0.103.0; `EmptyPaneWelcome.svelte` guards `prefers-reduced-motion` alone (one media query, line 284 on `chan-anim`), and the eight shader animations of `chan-anim` make this the branch's own question.

## Measurement, 2026-10-08

The frontend seat measured the welcome in its guest at a two-core quota with Chrome's renderer string recorded as SwiftShader in every run (`dev/v0104-team/reports/measurement-Frontend104-item2.md`, records under `dev/v0104-team/evidence/Frontend104/item2/`), every reading contended at that quota: the fullscreen fragment animation (Tenfold Dahlia) drew at about 2.3 to 2.6 observer frames a second using about two cores at 66 to 73 percent CPU pressure; a 2D-canvas animation drew at about 60 using 7 to 9 percent of one core; a point-cloud WebGL2 animation drew at about 60 using 44 to 47 percent; reduced motion drew no recurring frame; the idle controls drifted toward 15 frames a second in later windows, a headless scheduling behavior the report states rather than certifies. Browser check 62 alone, unchanged, twice with the welcome forced to the fragment animation and twice with it off: both on runs failed on the check's own assertions (the process-memory growth before any chooser; the 30 s upload deadline after choosers of 0.9 to 1.5 s), both off runs passed in about 108 s with choosers at 9 to 48 ms; the check makes no trusted click, so the waits are labelled as wait-to-event. Two instrument faults were found and corrected before the measured runs (a process reader that matched nothing under Chrome 155's flattened command lines; an observer that resolved a different Puppeteer module than the runner), each retained beside its corrected run. The branch's frame-rate page keeps its refusal to certify a software reading; this is a cost reading by a guest-local harness.

## Owner decision, 2026-10-08

A 2D fallback: on a software WebGL context the welcome picks only among the 2D-canvas animations, so it still moves at low cost. Chosen by survey from three options (the 2D fallback, recommended by the lead; a static mark; nothing changed), with the figures above in the survey's text; `dev/v0104-team/evidence/Lead104/surveys/welcome-software-context.*`.

## Desired contract

The owner's choice among three, now made: the welcome keeps running as it does on a software context (nothing changed), it shows a static mark, or it falls back to a 2D animation. Whichever is chosen is what the welcome does, measured, and the choice is recorded here with the measurement that informed it.

## What to do

Measure first: in a guest with no GPU, the welcome on a software WebGL context against a control with the animation off, on the same page and the same hardware, reading CPU use, the page's frame timing and the time a transfer check takes to reach its chooser, with the guest's cores and CPU pressure recorded for each run; a throttled or out-of-memory run is not a measurement of the product. Then the lead surveys the owner with the numbers and the three options. If the owner chooses a change, design it against `EmptyPaneWelcome.svelte` and the animation registry, and pin the detection of a software context red first.

## Boundaries

`web/packages/workspace-app/src/components/EmptyPaneWelcome.svelte`, the animation registry and the WebGL runner under `web/packages/workspace-app/src/`, and the browser checks that observe them. The check 62 repair of v0.103.0 is not reopened; the chooser's gesture is the question of [a-command-triggered-upload-with-no-gesture-opens-no-chooser](a-command-triggered-upload-with-no-gesture-opens-no-chooser.md).

## Acceptance

1. A measurement record: the welcome on a software context and the control with the animation off, each run with its cores, CPU pressure, CPU use and frame timing, at one named commit of the picked branch.
2. The owner's decision recorded in this item with the survey's text and answer.
3. The 2D fallback: the detection of a software context (the renderer string the tuner page reads, or the absence of a hardware WebGL2 context, as the design says) pinned red first; on a software context the welcome's random choice draws only from the 2D-canvas animations, shown in a browser check on SwiftShader; on a hardware context the choice is unchanged, pinned; the reduced-motion guard unchanged, pinned; `make web-check` green at the commit.
4. Acceptances 1 and 2 are met by the measurement and the decision above.
