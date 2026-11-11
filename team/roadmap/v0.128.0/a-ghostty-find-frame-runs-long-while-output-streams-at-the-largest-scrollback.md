# A ghostty find frame runs long while output streams at the largest scrollback

Status: accepted by the owner on 2026-11-09 for v0.128.0. Measured in the v0.127.0 find follow-ups, whose report is kept with the round's raw data; nothing is built. It is separate from the [ghostty-web-ng item](chan-drives-ghostty-web-from-outside-through-its-private-internals.md) and can land before or after that item's find part, on whichever find controller is in place.

## What is there now

With the find bar open on a ghostty terminal, the find controller (`src/terminal/ghosttyFind.ts`) feeds libghostty-vt's search once per animation frame while output arrives, then scans on a 4 ms budget. The feed is a single wasm call, outside that budget, that takes in every change since the last feed. Its cost grows with the rows it takes in, with the number of matches, and with the terminal's width.

Measured on 2026-11-09 by streaming `seq 1 200000` (1,488,895 bytes) into a terminal with the bar open. The Node runs used v26.12.1 on a Ryzen 9 8945HS, the find controller over the vendored core, and 16, 64 or 256 KiB written per frame, with 10 repetitions each:

| Setting | Longest find frame |
| --- | --- |
| Default scrollback (10 MB, 10,922 lines) | 11.8 ms, none over 16 ms |
| Largest (50 MB, 54,613 lines), needle 4999 | 12.5 ms, none over 16 ms |
| Largest, needle 9, 80x24, 256 KiB | 47.4 ms, 41 of 60 over |
| Largest, needle 9, 200x50, 64 KiB | 21.3 ms, 34 of 230 over |
| Largest, needle 9, 200x50, 256 KiB | 57.3 ms, 60 of 60 over |

- **Chrome agrees.** In headless Chrome 156 in an isolated guest (196x44, needle `9`), the default scrollback's longest find frame was 4.4 to 4.7 ms. At the largest scrollback it was 28.6 to 30.2 ms, with 7 to 9 of 12 find frames over 16 ms and gaps between animation frames up to 50 ms; with the bar closed the longest gap was 33.4 ms.
- **A fresh scan is cheaper than the feed.** It covers the whole 54,000-row buffer in budgeted calls: 13.5 to 14.8 ms in 3 calls of at most 6.5 ms at 80x24, and 55 ms in 12 calls of at most 10.4 ms at 200x50.

## Desired contract

1. With the find bar open on a ghostty terminal, no find frame exceeds 16 ms while output streams, at any scrollback chan allows.
2. The count stays honest. It shows a partial total (`+`) while the search catches up, and never a wrong total.
3. When the fix gives up the incremental search, the active match is kept where it can be found again, for example by finding the last highlighted range after the rescan. Otherwise the highlight drops and the count shows no index until the next step, as after a resize. A selection the user made is never taken over.
4. When feeds are cheap, as at the default scrollback, behavior is unchanged: no extra restarts and no extra partial counts.

## Design candidates

- **Restart past a backlog threshold.** Count the bytes or history rows written since the last feed; past a threshold, set the needle again on a fresh search instead of feeding, so the core rescans in budgeted calls. The threshold can be fixed (roughly 32 to 64 KiB at 200 columns with the largest scrollback) or follow the last feed's measured cost.
- **Defer feeds while the backlog is large**, and restart once output pauses.
- **Rejected:** a time budget around the feed, because it is one wasm call that cannot be split from JavaScript; and feeding every other frame, because the cost grows with the rows per feed, which makes the worst frame worse.
- **Upstream:** a bounded or incremental feed in libghostty-vt would remove the need for either. It can be reported separately; it is not a dependency of this item.

## Boundaries

- Ghostty terminals only. xterm's search addon is unaffected.
- The vendored core stays as it is.
- The scan budget per frame (4 ms) may change if the design needs it, with the reason recorded.

## Acceptance

1. The Node frame measurement, repeated over the configurations in the table (needles `9` and `4999`, 16, 64 and 256 KiB per frame, 80x24 and 200x50, default and largest scrollback), shows no find frame over 16 ms.
2. The Chrome reading in an isolated guest shows no find frame over 16 ms at the largest scrollback with needle `9`.
3. Tests over the vendored core pin when the controller feeds and when it restarts. They also pin what happens to the active match and the count across a restart.
4. Browser check 211 and checks 93, 94, 105 and 204 are green in an isolated guest at the integration tip.

## Built, 2026-11-11

A ghostty find frame no longer runs long while output streams at the largest scrollback. The cause was wider than the backlog. libghostty-vt's feed (`ghostty_search_feed`) reads every row moved into the history since the last feed in one call, and while the scan is complete it also checks every match the search holds against the history's pages, walking the page list from its first page for each match, and drops the matches whose rows were pruned one at a time from a list shifted for each. So a complete scan's feed costs a check that grows with the matches times the history (8.7 ms with nothing new at 200x50, the largest scrollback and needle `9`; 15 ms with needle `1`), a read that grows with the rows, and a drop that grows faster than the matches the output pruned; selects and the unit that completes a scan pay the check too. A restart costs under 0.5 ms however many matches the search held, and its fresh scan runs in budgeted units, the completing one paying the check once.

The find controller (`web/packages/workspace-app/src/terminal/ghosttyFind.ts`) brings the search up to date through one decision a frame (`catchUp`). It counts the rows moved into the history since the last feed with a tracked cell put on the first row of the screen at each feed, and predicts from three costs (`FIND_COST_PRIORS`): the read per cell of those rows, a complete scan's feed's check per match held per cell of history, and the check of a scan's completing unit. It assumes them until the terminal's own feeds and units measure them, and never takes them under that: a read measured cheap on small feeds or on a history not yet full says nothing of a burst into a full one. A complete scan whose feed predicts over `FIND_FRAME_BUDGET_MS` (12 ms) and dearer than the rescan's completion restarts instead (`VtSearch.restart`): a restart moves the check to that completion rather than saving it, so where the check is most of the feed find goes on feeding. A running scan restarts for a read of at least a scan step's 4 ms that would not fit beside the completion, so heavy output holds it from completing until it eases, while lighter writes, and writes that move no row into the history, are fed and the scan completes under them. The step leaves room for the completion, at least 1 ms, and runs the whole 4 ms scan budget, which is unchanged, when the completion alone is over the frame's. Any one measure counts at most one and a half times the estimate, a measure under the clock's grain is ignored, and a check is learned only from about 2 ms of work; after a resize, and for a backlog spanning the whole history, the core starts over by itself and find feeds. A step pressed with output pending decides the same way first. The design candidate taken is the adaptive restart, with the fixed floor folded into the assumed costs. The deferred feed was not taken: while the backlog kept growing, the count would have shown a total the pruned history no longer holds.

Across a restart the count is a floor with `+` and, while the kept match waits, no index (contract 2). The active match is kept by the two tracked cells findresize added and selected again once the rescan finds it, the highlight following the cells while pruned history moves them and a selection the user made staying theirs; a reselect already waiting keeps its time, so output that restarts the search every frame holds the steps behind it no longer than `FIND_WAIT_CAP_MS`. A match the rescan has not found again by then, as under heavy output that goes on for more than about a second, is dropped like one whose row the output pruned: no highlight and no index until the next step, which starts over (contract 3). At the default scrollback nothing restarts at the assumed costs, up to 200 columns, and the partial counts there are no more frequent than the base's; a terminal whose feeds measure dearer than assumed restarts there too. At the largest scrollback find also restarts where the base's feeds were cheap (contract 4): 80x24, 256 KiB a frame and needle `4999`, where the base's longest frame was 8.7 ms, and the tip restarts there ten times in ten runs, 10 of 60 stream frames partial.

Verified in Node over the vendored core with `vitest.findframes.config.ts` (acceptance 1), base and tip interleaved over the row's 24 configurations and a leg of 16 KiB for 30 frames then 256 KiB frames, on a Ryzen 9 8945HS at a load of 7 to 17: the base has frames over 16 ms in eight configurations, up to 74.0 ms; here one frame of 13,199 is, 16.4 ms at 80x24, the largest scrollback, 64 KiB a frame and needle `9`, where find feeds as the base does and the base reached 17.1 ms, its long feeds the core dropping a dense run of pruned matches. Every count checked against a fresh blocking scan was a true floor or exact, and every run ended on the buffer's whole count. In headless Chrome in an isolated guest at the largest scrollback with needle `9` (acceptance 2), no find frame passes 16 ms (the longest 12.1 ms, against 24.4 to 41.2 ms at the base in the same session). Vitest cases pin when find feeds and when it restarts, on both sides of each threshold, and what the count and the active match do across a restart (acceptance 3): 26 of the 91 find cases fail with the base controller, and each of 35 mutations of the controller's and the binding's guards turns a case red. Checks 211 (ten runs), 93, 94, 105 and 204 are green in the guest at the tip (acceptance 4), where make web-check is green too. The web app's design document and the manual's terminal page say so. Feeds that drop a dense run of pruned matches, and with a needle that matches very often the check itself, can still outlast a frame where find feeds; both costs are upstream's prune and could be reported to libghostty-vt. Nothing here needs the owner's Mac.
