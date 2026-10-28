# The manual's launcher mocks size their cards by the reader's window

Status: shipped in [v0.114.0](../../release/release-v0.114.0.md) with the Add devserver demo row; the sections from Build findings and evidence on hold the evidence, the owner's acceptance of the heights last.

Record before the release: landed at `ae2793c08` (2026-10-27) with [the Add devserver demo row](the-add-devserver-demo-opens-a-dialog-where-the-desktop-flips-the-card.md), pending the owner's merge; the sections from Build findings and evidence on hold the evidence.

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

## Build findings and evidence (2026-10-27)

Change: `.launcher-demo-frame` is a size container, and under it `.launcher-demo-frame .content .carousel` sets `--deck-height: clamp(12rem, calc(100cqh - 11rem), 48rem)`, the desktop formula with the frame's height in place of the viewport's (the extra `.content` outranks the carousel's scoped rule whatever the bundle order). A frame narrower than 30rem, where the key hint wraps to two lines, takes 12rem off instead of 11rem. In-frame modals are capped at `calc(100cqh - 3rem)`, so a dialog taller than the mock scrolls inside it rather than running past the clipped edge; the Modal's own cap is 90vh of the page. In `web/packages/marketing/src/styles.css` the first-run mount is 540px (was 640px) and the devserver embed 800px (was 780px), and at a viewport of 680px or less they are 600px and 840px, where the New workspace dialog and the Add devserver form wrap taller. The desktop launcher is unchanged: Carousel.svelte keeps its 100vh rule and every override sits under `.launcher-demo-frame`.

Measured with headless Chrome over CDP (positions inside the frame, after scrolling the mock into view):

- `/manual/install/`, This machine card: 338px at 1280x1100 and 1280x2400 (was 438px at 640px frame), 382px at 390x2400; ends inside the frame, no inner scroll. Its height does not change with the window height.
- New workspace dialog, opened from This machine's New local workspace button: 459px tall in a 538px frame at 1280 (40px clear above and below), 539px in a 598px frame at 390 (30px clear); no inner scroll.
- `/manual/devserver/`: card 598px at 1280 and 622px at 390, the flipped form whole (no inner scroll); checked also at 681, 720, 760, 820, 900 and 1000px wide. At 681px wide with the old 780px height the form overflowed its card by 13px, which set the 800px height.

Tests: `LauncherDemo.test.ts` reads the component stylesheet (jsdom lays out nothing) and checks the frame is a size container, the deck height reads `100cqh` and no `vh`, and the modal cap reads `100cqh`. Launcher vitest 705/705, svelte-check 0 errors, marketing `npm run check` exit 0.

Left open: at 320px wide the cards are wider than the 282px frame and the dialog scrolls inside its cap (596/548); 320px is outside this row's acceptance widths and the card width comes from the carousel, not the frame height.

## Owner acceptance (2026-10-28)

On the first-run mock at 540 px and the devserver embed at 800 px: "mock heights 540px amd 800px should be fine".
