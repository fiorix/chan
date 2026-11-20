# The Computers badge graph sits off centre and moves in steps

Status: Accepted for v0.133.0 by the owner on 2026-11-20 ("the devserver graph in the computer's window badge has extra margin on the left side in comparison to right side, we should fix it; also since we ping every 3s, i want the graph to gradually scroll instead of tick every 3s; this is just a presentation refinement, the data seems right already.. i just want the line so move smoothly").

Record: the owner's words above, on the chart in the connection detail of a connected devserver's card in front on the Computers screen, which shipped in v0.132.0 with [the connection health row](../done/connection-health-shows-in-each-window-not-on-its-devservers-computers-badge.md). The smooth motion is built first; the insets wait for the owner's choice of layout, since the detail's left padding keeps its text in line with the devserver's name.

## What is there now

Read at `793d86522`, by reading; nothing run.

- The chart: `web/packages/launcher/src/components/ConnectionDetail.svelte` measures the detail's width (lines 31 to 44) and draws an SVG (lines 53 to 57) of `connectionSparkline(health.samples, chartWidth)` (`web/packages/launcher/src/lib/connectionHealth.ts`, lines 113 to 138). Every point sits at `EDGE + index * (width - 2 * EDGE) / (samples - 1)` (line 117), so the points spread over the width whatever their count, and a new sample redraws the whole line one place to the left: the line moves in one step per sample. The chart's own margins are symmetric: `CONNECTION_SPARKLINE_EDGE`, 3 view-box units at each end (line 24), about 4.3 px at the chart's 48 units to 69 px.
- The detail's box: `web/packages/launcher/src/components/Library.svelte` mounts the detail in `.ds-health` (line 832), whose rule (line 944, from `3a93322d5`) pads it `0.1rem 0.2rem 0.6rem 1.75rem`: 1.75rem on the left to put the detail's text under the devserver's name (the header's 0.2rem padding, the 1.15rem glyph column and the 0.4rem gap), 0.2rem on the right to end it at the header actions' right edge. Inside the card's own 0.5rem padding that reads about 41 px from the card's left border to the chart's first point and about 16 px from its last point to the right border at a 16 px rem. That padding is the likely cause of the extra left margin; the cause is to be measured in the desktop guest.
- When a sample arrives: the desktop pings each connected devserver on its window feed every 3 s while a window of the desktop has the focus and every 20 s while none has (`FOCUSED_CADENCE` and `UNFOCUSED_CADENCE`, `desktop/src-tauri/src/connection_health.rs` lines 55 to 58), the next ping due 3 s after the last (`window_watcher_wiring.rs`, `next_ping`). A pong pushes its reply time into the history at the moment it arrives (`connection_health.rs`, `pong`, line 288), and a lost socket pushes a miss for each ping still waiting (line 313); the history keeps the last 60. The row the launcher reads carries the history and no time or count for its newest sample: `last_contact` is the latest frame of any kind and a miss does not move it. The launcher re-lists the devservers every 2 s while it is visible and one has a reading (`web/packages/launcher/src/state/library.svelte.ts`, lines 73 and 215 to 231), and at once on a change of face, so the page sees a new sample up to 2 s after it arrived.

## Desired contract

1. Between samples the line moves left continuously, one sample width per ping interval, and the newest reading enters from the right edge; an arriving sample makes no jump: the drawn position just before and just after an arrival agree to within a pixel.
2. The data is untouched: the same samples, the same scale and ceiling rule, the same miss marks and figures. A late sample or a slower cadence (an unfocused desktop pings every 20 s) never draws a reading that was not measured: the line holds at its last sample until the next arrives; the motion clamps and never extrapolates.
3. With `prefers-reduced-motion: reduce` the chart steps, one sample per arrival, as it does today.
4. The baseline and the chart's edges stay put; only the reading and its miss marks move, clipped to the chart.
5. The chart's left and right insets inside the detail are equal, measured in the rendered page; the layout is the owner's choice.

## Boundaries

- `ConnectionDetail.svelte`, `connectionHealth.ts` and its tests, and, after the owner's choice, the `.ds-health` rule in `Library.svelte`.
- Not the desktop's feed, its ping cadence or its sampling, the row the launcher reads, the chart's 400 ms floor, or the figures' wrapping.

## Acceptance

1. A desktop driver under WebKitGTK in a desktop guest reads the on-screen position of a marked reading at least 8 times inside one ping interval and across one arrival: it moves left continuously and jumps no more than 1 px at the arrival. Red at the base, where it steps; green at the tip.
2. The same driver with reduced motion set in the desktop's GTK settings reads the position unchanged between arrivals.
3. The same driver reads the chart's drawn extent (the baseline's ends) against the card and finds the left and right insets equal within 1 px. Red at the base; green once the owner's layout lands.
4. The connection face driver (`scripts/e2e/desktop-observations/connection-face-native.sh`) stays green, its chart check following the chosen layout.
5. Unit tests cover only what the driver cannot reach: how the page counts the samples a new history adds, and the pace of the catch-up after a burst; each dies to one named mutation.
