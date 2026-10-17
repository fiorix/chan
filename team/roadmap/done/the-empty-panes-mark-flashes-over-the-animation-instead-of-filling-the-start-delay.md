# The empty pane's mark flashes over the animation instead of filling the start delay

Status: shipped in [v0.107.0](../../release/release-v0.107.0.md).

Record before the release: raised by the owner on 2026-10-15 and built the same day (see "Built 2026-10-15"); not yet landed on `main`.

## What was seen

The owner's words of 2026-10-15:

> We currently display animations on the workspace windows which have a single pane with no tabs. We currently use a 2s sleep between opening and window and starting the animation.
>
> When we start the animation, we also print the chan logo in the center of the animation and it fades out quickly.
>
> I want to make a change here: when the workspace window is first open, we immediately fade the chan logo in and out, using the 2s interval between opening the window and showing the animation.
>
> This means by the time the animations are displayed we no longer show the chan logo. And when we change animations we shouldn't display the chan logo either. From this change onwards the chan logo on the single-pane no-tab window will only be displayed when the window is opened, for 2s; the fade in and out can use 250ms each

What the code did (`web/packages/workspace-app/src/components/EmptyPaneWelcome.svelte`): the welcome rendered its focusable region at once and nothing in it, and two seconds later (`EMPTY_PANE_ANIMATION_START_DELAY_MS` in `emptyPaneAnimations.ts`) mounted the animation field and the mark together; the mark ran a 1.8 s flash keyframe over the field (0 to 0.45 opacity and back) and was re-keyed on every animation switch so the flash replayed over the incoming field. The two readers of the welcome that start it at once, the animation tuner and the marketing gallery (`startDelayMs={0}`), got the flash over the running animation too.

## Desired contract

The mark fills the start delay and nothing else: it fades in over 250 ms as soon as the empty pane is shown, holds, and fades out over 250 ms so that it is gone when the animation starts two seconds after the pane appeared. The running animation shows no mark, an animation switch shows none, and a welcome that starts at once never shows one. Short panes keep dropping the mark. The start delay's other promise is unchanged: no canvas, context or frame before the delay, and none at all if a tab replaces the pane within it.

## What was done

`emptyPaneAnimations.ts` names the fade length beside the start delay (`EMPTY_PANE_MARK_FADE_MS`, 250). `EmptyPaneWelcome.svelte` renders the mark while the welcome has not started and removes it when the animation mounts; the surface sets `--welcome-mark-fade` and `--welcome-mark-out-delay` (the start delay less one fade) on itself, and the mark's stylesheet runs two fill-forward keyframe animations on those variables, a fade-in at once and a fade-out delayed to end as the field starts, so the mark rests at its full presence (0.45 opacity, the placeholder mark's) between them. The switch re-key is gone.

## Boundaries

`web/packages/workspace-app/src/components/EmptyPaneWelcome.svelte`, `emptyPaneAnimations.ts` and `EmptyPaneWelcome.test.ts`. Not changed: the start delay and what it withholds; the animation choice, persistence and keys; the name flash; the short-pane rule; the tuner and the gallery, which pass a zero delay and now show no mark.

## Acceptance

1. Before the start delay the mark is in the pane and no canvas is; at the start the canvas is and the mark is not; a switch shows no mark; a zero delay shows none. Pinned by `EmptyPaneWelcome.test.ts`, red on the previous component.
2. The surface carries the fade length and the fade-out start as CSS variables, pinned in the same tests for the default delay and a shorter one.
3. In a real engine the mark's opacity is 0 at 0 ms, full from 250 ms to 1750 ms and 0 at 2000 ms.
4. `make web-check`'s parts for the workspace app green: svelte-check and the whole vitest suite.

## Built 2026-10-15

Acceptance 1 and 2: `EmptyPaneWelcome.test.ts`, nine cases in its start-delay group and the key-handling case; against the previous component four of nine fail ("mark while the field runs: expected <div> to be null", "mark at 0 ms: expected null not to be null", "mark with no delay", "fade-out start ... to contain '--welcome-mark-out-delay: 750ms'"); with the change all seventeen welcome tests pass. Acceptance 3: the mark's rule and its two keyframes copied from the component into a constructed page in headless Chrome stable on the host with the surface's variables set for the default delay, sampled by `getComputedStyle` under virtual time: opacity 0 at 0 ms, 0.29 at 125 ms, 0.45 at 250, 500, 1000, 1700 and 1750 ms, 0.32 at 1875 ms, 0.0005 at 2000 ms and 0 at 2200 ms. Acceptance 4: svelte-check 0 errors over 5,190 files; the whole workspace-app suite 557 files and 7,039 tests green; the marketing gallery's six tests green. The browser checks 128 and 129 read canvas and context records only and are untouched.
