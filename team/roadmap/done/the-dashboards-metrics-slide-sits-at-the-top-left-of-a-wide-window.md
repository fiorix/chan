# The Dashboard's Metrics slide sits at the top left of a wide window

Status: shipped in [v0.127.0](../../release/release-v0.127.0.md).

Record before the release: raised by the owner on 2026-11-10 from his Mac checks of the release ("the dashboard seems to be aligned to the top left, rather than the center of the tab; for example when we have a window taking the whole screen i'd like to see the dashboard centered horizontally and vertically as well when possible"). The release was closed to new work by then; he first left it for v0.128.0 and then pulled it in before the cut ("do include dashboard fix"). Built the same day on `fix/dashboard-metrics-centered` (`b9d83dcb7`, three commits over `8c7863e9a`: the browser check, the fix and a comment) and merged into the integration branch as `72fc72501`.

## What was there

A Dashboard opens on the Metrics slide since this release. The carousel gives the Metrics and Search slides a wide stage: `.slide-stage-wide` in `web/packages/workspace-app/src/components/EmptyPaneCarousel.svelte` drops the 720px cap the Workspace and About slides are centered under, and the stage is a column whose children stretch. The Metrics slide caps its own width (`components/MetricsSlide.svelte`) and set no margin, so in a tab wider than that cap it started at the stage's left edge, and at the stage's top whatever the tab's height. In a window that fills a large screen the slide sat in the top left with the rest of the tab empty to its right and below. Measured in Chrome in an isolated guest before the fix: in a 1900x1400 window the 1120x696 slide had 10 px to its left and 760 px to its right, none above and 591 px below.

## Contract as built

1. The Metrics slide is centered horizontally in the tab whenever the tab is wider than the slide.
2. It is centered vertically whenever the tab is taller than the slide, inside the carousel's stage (the tab less the carousel's top padding and its controls row, so 25 px above the tab's own middle in a 1900x1400 window); a slide taller than the tab starts at the top and scrolls from its first line. The fix is one declaration, `margin: auto` on the slide, whose auto margins take only the room the stage has to spare.
3. The Workspace, Search and About slides keep their placement, and so does a Dashboard in a narrow pane and in a window without a workspace.

## Boundaries

- The Metrics slide's own box; no rule of the carousel changed, and nothing the slide shows changed.
- On a first open the slide is short while it waits for the server's first answer, and is centered then too, so its heading moves up when the first sample arrives: a frame or two on a local window, one round trip over a slow tunnel.
- Measured in Chrome in an isolated guest. chan-desktop on macOS renders with WebKit; the owner's eye there is acceptance 3.

## Acceptance

1. A browser check (met): `scripts/e2e/browser-smoke/checks/212-metrics-slide-centered.mjs` opens a Dashboard on the Metrics slide at four window sizes (900 and 1900 px wide by 520 and 1400 px tall) and reads the slide's box against the tab's: equal space left and right when the tab is wider, equal space above and below when it is taller, top-aligned and scrolling from its first line when it is shorter, with a slide that must not move read beside it. Red at the code before the fix for the wide and the tall sizes, green with it: 385 px left and right and 295.5 px above and below at 1900x1400, the Search and About slides and the controls row unmoved. A mutation that centers the rows inside the scroller reds the check on the cut-off first row. The six other checks that open a Dashboard pass before and after; check 114, stale since the Metrics slide named the carousel's dots, fails the same way before and after and is in the v0.128.0 row of small findings.
2. The web checks green at the merge (met): the lead's web gate at `72fc72501`, with the static checks, the lockfile check, the web checks (the workspace app's 9,091 tests, svelte-check clean), the marketing check and the syntax check of the e2e tree, the new check among its files.
3. On chan-desktop on macOS (owner): a full-screen window's Dashboard shows the Metrics slide in the middle of the tab.
