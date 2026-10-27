# The manual's launcher mocks size their cards by the reader's window

Status: accepted for v0.114.0 by the owner's word of 2026-10-27; not started.

## What was asked

The owner's words of 2026-10-27: "also i think the "This machine" badge in the web marketing site was very long, height wise.. no need for that".

## Evidence

Read at `8ce1c3646`. The carousel gives every card the same height, filling its slot, from `--deck-height: clamp(12rem, calc(100vh - 11rem), 48rem)` (`web/packages/launcher/src/components/Carousel.svelte`, `.carousel` and `.slot-body > .card`). On the desktop the launcher fills its window, so the viewport is the right measure. The manual's mocks mount the same carousel in a fixed frame (`web/packages/marketing/src/styles.css`, `.launcher-manual .launcher-demo-mount`, 640 px tall; the devserver iframe 780 px), so the deck follows the reader's browser window instead: on a tall window it reaches 48rem, the This machine card runs to the frame's bottom with three lines of content and its lower edge is clipped (headless Chrome screenshot of `/manual/install/` at 1280 px).

## Desired contract

In the manual's mocks the deck height follows the mock's frame, not the page viewport, and the first-run frame is only as tall as the This machine card and the in-frame New workspace dialog need. The desktop launcher is unchanged.

## What to do

- Set `--deck-height` for `.launcher-demo-frame .carousel` from the frame (container query units or a fixed value in `LauncherDemo.svelte`), and shorten `.launcher-manual .launcher-demo-mount`.
- Check the New workspace dialog and, with [the Add devserver demo row](the-add-devserver-demo-opens-a-dialog-where-the-desktop-flips-the-card.md), the flipped Add devserver form still fit without clipping.

## Acceptance

- At 1280 and 390 px and on a short and a tall browser window, the This machine card ends inside the frame with no clipped edge, and its height does not change with the window.
- The New workspace dialog opens fully inside the first-run mock.
- Launcher vitest and the marketing check green; headless Chrome screenshots of `/manual/install/` and `/manual/devserver/`.
