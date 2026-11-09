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
