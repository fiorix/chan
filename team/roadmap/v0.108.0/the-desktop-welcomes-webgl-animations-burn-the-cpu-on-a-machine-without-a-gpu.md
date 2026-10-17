# The desktop welcome's WebGL animations burn the CPU on a machine without a GPU

Status: carried into v0.108.0 at the v0.107.0 GA on 2026-10-17, still raised for a decision.

Record before the release: carried into v0.107.0 at the v0.106.0 GA on 2026-10-15, still raised for a decision.

Record before the release: raised by the desktop seat's native reading on 2026-10-13 beside the frame-rate item (`reports/report-Desktop106-welcome-native.md` in the round's bus); decided by the owner the same day by survey ("Next round: a runtime guard row; this candidate as is (recommended)"); written down the same day by the lead as a row of its own; owner the frontend seat; not reached in the v0.106.0 round

## What was seen

In the desktop app on Linux WebKitGTK 2.52.6 with no `/dev/dri`, the product's own cached reader returns a masked renderer, so the welcome keeps the whole catalog of thirty-three animations (twenty-two WebGL2 and eleven 2D), as the catalog's rule says for an engine that masks its renderer on every machine. Six of the twenty-two WebGL choices took the whole two-CPU quota while the welcome showed (1.99 to 2.00 CPU seconds per second: Cosmic Bell 2.0009 and Segmented Torus 1.9976, each throttled in all 195 sampled periods, with Tenfold Dahlia, Turbulent Oculus, Amber Recursion and Stellar Outburst), six took 1.15 to 1.74 and ten 0.54 to 0.96; the eleven 2D choices ran from 0.29 (Dotted Waves) to 0.86; the editor with no welcome 0.18 (an animation was still running at the report's first snapshot, by its own qualification). Every WebGL choice took one trusted key within two seconds, so the welcome does not block. In Chrome, which names its software renderer, the rule leaves the WebGL animations out and the 2D one selected costs a quarter of a CPU. Not measured: macOS and Windows; a release build; the frame rate on a machine without a GPU beyond the harness's driven rows (2.7 to 12.8 frames a second).

## Desired contract

On a machine without a GPU the welcome does not burn the CPU: a WebGL animation that cannot hold a frame rate is swapped for a 2D one, whatever the engine says about its renderer.

## What to do

A runtime guard in the welcome: measure the animation's own frame time over its first second or two and swap a slow WebGL animation for a 2D one of the catalog; the thresholds from the harness's rows; design read before code. Not a change to the catalog's rule for a masked renderer, which keeps WebGL on desktops that have a GPU.

## Boundaries

`web/packages/workspace-app/src/` welcome and animation modules (`emptyPaneAnimations.ts`, `emptyPaneAnimationChoices` and the welcome component) and their tests. Not changed: the harness of the frame-rate item.

## Acceptance

1. The decision recorded here (the owner's above).
2. If built: a pin red first that a slow WebGL animation is swapped and a fast one kept, on a constructed frame clock; the native desktop reading repeated on a machine without a GPU, the CPU below a stated bound while the welcome shows.

## The owner's word 2026-10-16

Asked at the cut through one survey that listed the thirteen rows not shipped and the seven findings outside any item, with the lead's recommendation on each, and offered each row's own question with its cost (this row's line: "wglgrd, the welcome's WebGL on a machine without a GPU: carry, as you decided on 2026-10-13"), the owner answered: "Take all fourteen recommendations as listed (Recommended)". The row moves to v0.108.0 at the GA commit with its record as it stands.
