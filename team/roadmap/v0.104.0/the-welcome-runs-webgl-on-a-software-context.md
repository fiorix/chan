# The welcome runs a WebGL2 animation on a software WebGL context

Status: raised for v0.104.0 with the owner's acceptance of the scope on 2026-10-08; the product's answer is the owner's decision, to be surveyed with a measurement in hand, and no change is built before it.

## What was seen

In a browser with no GPU, the empty pane's welcome runs a WebGL2 animation on a software WebGL context. Over seven recorded runs of browser check 62 at the v0.103.0 candidate and its rc1 pin, the two slow runs (1.99 and 2.00 of the guest's two cores at 59% and 70% CPU pressure, 144 seconds to reach the chooser against 99 alone) logged Chrome's software WebGL fallback line and showed WebGL2 welcome animations in their screenshots; the five normal runs lacked the line. That is an association, not a shown mechanism, as the v0.103.0 report and the closed item [check-62-asks-for-a-file-chooser-without-a-user-gesture](../done/check-62-asks-for-a-file-chooser-without-a-user-gesture.md) record. On new session storage `initialEmptyPaneAnimation()` picks at random among the animations, twelve of 23 starting a WebGL2 animation on mount at v0.103.0; `EmptyPaneWelcome.svelte` guards `prefers-reduced-motion` alone (one media query, line 284 on `chan-anim`), and the eight shader animations of `chan-anim` make this the branch's own question.

## Desired contract

The owner's choice among three: the welcome keeps running as it does on a software context (nothing changed), it shows a static mark, or it falls back to a 2D animation. Whichever is chosen is what the welcome does, measured, and the choice is recorded here with the measurement that informed it.

## What to do

Measure first: in a guest with no GPU, the welcome on a software WebGL context against a control with the animation off, on the same page and the same hardware, reading CPU use, the page's frame timing and the time a transfer check takes to reach its chooser, with the guest's cores and CPU pressure recorded for each run; a throttled or out-of-memory run is not a measurement of the product. Then the lead surveys the owner with the numbers and the three options. If the owner chooses a change, design it against `EmptyPaneWelcome.svelte` and the animation registry, and pin the detection of a software context red first.

## Boundaries

`web/packages/workspace-app/src/components/EmptyPaneWelcome.svelte`, the animation registry and the WebGL runner under `web/packages/workspace-app/src/`, and the browser checks that observe them. The check 62 repair of v0.103.0 is not reopened; the chooser's gesture is the question of [a-command-triggered-upload-with-no-gesture-opens-no-chooser](a-command-triggered-upload-with-no-gesture-opens-no-chooser.md).

## Acceptance

1. A measurement record: the welcome on a software context and the control with the animation off, each run with its cores, CPU pressure, CPU use and frame timing, at one named commit of the picked branch.
2. The owner's decision recorded in this item with the survey's text and answer.
3. If a change is chosen: its pin red first, the welcome's behavior on a software context shown in a browser check, and the reduced-motion guard unchanged.
4. If nothing is changed: this item closes as an observation with the measurement as its record.
