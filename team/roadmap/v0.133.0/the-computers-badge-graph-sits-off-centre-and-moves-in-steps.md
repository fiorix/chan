# The Computers badge graph sits off centre and moves in steps

Status: Accepted for v0.133.0 by the owner on 2026-11-20 ("the devserver graph in the computer's window badge has extra margin on the left side in comparison to right side, we should fix it; also since we ping every 3s, i want the graph to gradually scroll instead of tick every 3s; this is just a presentation refinement, the data seems right already.. i just want the line so move smoothly").

Record: the owner's words above, on the chart in the connection detail of a connected devserver's card in front on the Computers screen, which shipped in v0.132.0 with [the connection health row](../done/connection-health-shows-in-each-window-not-on-its-devservers-computers-badge.md). The smooth motion was built first and the insets waited for the owner's choice of layout, since the detail's left padding kept its text in line with the devserver's name; his rulings are under Decided.

## What is there now

Read at `793d86522`, by reading; nothing run.

- The chart: `web/packages/launcher/src/components/ConnectionDetail.svelte` measures the detail's width (lines 31 to 44) and draws an SVG (lines 53 to 57) of `connectionSparkline(health.samples, chartWidth)` (`web/packages/launcher/src/lib/connectionHealth.ts`, lines 113 to 138). Every point sits at `EDGE + index * (width - 2 * EDGE) / (samples - 1)` (line 117), so the points spread over the width whatever their count, and a new sample redraws the whole line one place to the left: the line moves in one step per sample. The chart's own margins are symmetric: `CONNECTION_SPARKLINE_EDGE`, 3 view-box units at each end (line 24), about 4.3 px at the chart's 48 units to 69 px.
- The detail's box: `web/packages/launcher/src/components/Library.svelte` mounts the detail in `.ds-health` (line 832), whose rule (line 944, from `3a93322d5`) pads it `0.1rem 0.2rem 0.6rem 1.75rem`: 1.75rem on the left to put the detail's text under the devserver's name (the header's 0.2rem padding, the 1.15rem glyph column and the 0.4rem gap), 0.2rem on the right to end it at the header actions' right edge. Inside the card's own 0.5rem padding that reads about 41 px from the card's left border to the chart's first point and about 16 px from its last point to the right border at a 16 px rem. That padding is the cause of the extra left margin by this arithmetic (about 41 px against 16 px, a difference of the name's 1.55rem indent past the header's padding), to be confirmed by the chart driver's reading in the desktop guest.
- When a sample arrives: the desktop pings each connected devserver on its window feed every 3 s while a window of the desktop has the focus and every 20 s while none has (`FOCUSED_CADENCE` and `UNFOCUSED_CADENCE`, `desktop/src-tauri/src/connection_health.rs` lines 55 to 58), the next ping due 3 s after the last (`window_watcher_wiring.rs`, `next_ping`). A pong pushes its reply time into the history at the moment it arrives (`connection_health.rs`, `pong`, line 288), and a lost socket pushes a miss for each ping still waiting (line 313); the history keeps the last 60. The row the launcher reads carries the history and no time or count for its newest sample: `last_contact` is the latest frame of any kind and a miss does not move it. The launcher re-lists the devservers every 2 s while it is visible and one has a reading (`web/packages/launcher/src/state/library.svelte.ts`, lines 73 and 215 to 231), and at once on a change of face, so the page sees a new sample up to 2 s after it arrived.

## Desired contract

1. Between samples the line moves left continuously, one sample width per ping interval, and the newest reading enters from the right edge; an arriving sample makes no jump: the drawn position just before and just after an arrival agree to within a pixel.
2. The data is untouched: the same samples, the same scale and ceiling rule, the same miss marks, and the same latest, median and worst figures. A late sample or a slower cadence (an unfocused desktop pings every 20 s) never draws a reading that was not measured: the line holds at its last sample until the next arrives; the motion clamps and never extrapolates.
3. With `prefers-reduced-motion: reduce` the chart steps, one sample per arrival, as it does today.
4. The baseline and the chart's edges stay put; only the reading and its miss marks move, clipped to the chart.
5. The chart's left and right insets inside the card are equal within 1 px, measured in the rendered page: the detail takes the header's 0.2rem inset on both sides and the chart spans the card, while the figures line keeps its indent under the devserver's name.
6. One step is one ping at every count of samples. A history under 60 samples grows from the right: its newest sample at the right edge, the line filling leftward over the first three minutes of a connection's history; a full history rests with its oldest point one step past the left edge.
7. The fourth figure under the chart is "Missed <N>", the number of pings in the chart's window with no reply (its red marks, counted), in place of "Since <clock time>". The owner: "can you recommend something better than 'since: {hh:mm:ss}' for the chart? there's no much base to comparison there, users would have to look at a clock to match". Its title reads "<N> of the last <M> pings got no reply; last contact <clock time>", M the samples in the window and the time a dash before any contact; before any ping has finished the figure reads "-" like the others. The line still wraps between figures, never inside one.
8. Privacy mode leaves the connection shown, live: the chart, the figures line with Missed and its title, and the face's words and name beside the devserver's name. The owner: "in privacy mode, we do not need to cover the network graph in the devserver card on the computers window; it's ok to leave it showing live". The connection's privacy field (`devserver:<id>:connection`) and its reveal button go, having nothing left to reveal; the computer's name, address and the rest of the card stay as privacy mode has them.

## Boundaries

- `ConnectionDetail.svelte`, `connectionHealth.ts` and its tests, the `.ds-health` rule in `Library.svelte`, the launcher's size ceiling in `web/packages/launcher/vite.config.ts` (82 KiB), and the chart check of the connection face driver.
- The connection's privacy field in `ConnectionFace.svelte`, `ConnectionDetail.svelte` and `Library.svelte`, and the text that describes privacy mode for this card (the launcher's design notes, the manual's Computers and Settings pages, `docs/config-reference.md`).
- The fourth figure's words and title, the manual's description of the detail (`web/packages/marketing/src/pages/manual/computers.html`) and the face driver's reading of the last contact.
- Not the desktop's feed, its ping cadence or its sampling, the row the launcher reads, the chart's 400 ms floor, or the figures' wrapping.

## Acceptance

1. A desktop driver under WebKitGTK in a desktop guest reads the on-screen position of a marked reading at least 8 times inside one ping interval and across one arrival: it moves left continuously and jumps no more than 1 px at the arrival. Red at the base, where it steps; green at the tip.
2. The same driver with reduced motion set in the desktop's GTK settings reads the position unchanged between arrivals.
3. The same driver reads the chart's drawn extent (the baseline's ends) against the card and finds the left and right insets equal within 1 px. Red at the base; green at the tip.
4. The connection face driver (`scripts/e2e/desktop-observations/connection-face-native.sh`) stays green, its chart check following the chosen layout.
5. Unit tests cover only what the driver cannot reach: how the page counts the samples a new history adds, and the pace of the catch-up after a burst; each dies to one named mutation; the same for the missed count and its title.
6. The chart driver's `figures` leg reads the fourth figure as "Missed 0" over its relay, which drops nothing, with the count, the window and a last contact in its title: red at the base, which reads Since; green at the tip. The face driver reads the last contact from that title.
7. The chart driver's `privacy` leg, run with privacy mode on from the desktop's start, finds the computer's name hidden and the chart, the figures and the face's name shown, with no connection reveal: red at the base, green at the tip.

## Decided

The owner, 2026-11-20 (recorded at 13:22:47Z), each with the recommendation taken:

1. The insets: "Chart breaks out (Recommended)". The chart gets equal insets, about 16 px each side, and spans the card; the figures line keeps its indent under the name (contract 5).
2. The launcher's gzipped JS ceiling, 78 KiB, which the motion takes to 78.3 KiB from 77.7 KiB: "Raise to 82 KiB (Recommended)", with the comment's stale size corrected.
3. A history under 60 samples: "Grow from the right (Recommended)". A fixed time axis: the newest sample at the right edge, the line filling leftward over the first minutes (contract 6).
4. The fourth figure, 2026-11-20 (recorded at 13:30:25Z): offered a missed count, the current state's duration or the last reply's age in place of Since, the owner took "Missed count (Recommended)": the pings in the chart's window with no reply, the count's window and the last contact's clock time in its tooltip (contract 7).
5. Privacy mode and the connection, 2026-11-20 (recorded at 13:36:23Z): asked the scope, the one privacy field that covered the chart, the figures and the face's words behind one reveal, the owner took "All connection info (Recommended)": all of it shows live in privacy mode and the reveal goes (contract 8).
