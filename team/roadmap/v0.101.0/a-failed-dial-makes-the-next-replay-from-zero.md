# A failed dial makes the next terminal dial replay from zero

Status: accepted for v0.101.0 by the owner on 2026-09-25; raised during v0.101.0 on 2026-09-24. From the terminal replay lane's report for its restart e2e at `918f03694` on `v0101/terminal-replay`. Read in the code, not reproduced: the lane's reproducer, `scripts/e2e/devserver-terminal-replay.sh` with `scripts/e2e/terminal-replay-client.mjs` (landing with that lane), models the attach protocol and not the SPA, and its keep clients saw no failed dials. The code claims are a source reading against `33e12f6c7`.

## Owner ruling

Accepted on 2026-09-25 as the lead recommended, in one small SPA lane with [a-graceful-restarts-session-save-drops-the-terminals-session-id](a-graceful-restarts-session-save-drops-the-terminals-session-id.md); both change `TerminalTab.svelte`.

## What was seen

`TerminalTab.connect()` (`web/packages/workspace-app/src/components/TerminalTab.svelte`) resumes a reattach from the live cursor only when `sawSessionControl` is set, and clears `sawSessionControl` before the dial it starts has settled; only a `session` frame sets it again. After one failed dial, the next dial therefore has no live cursor and sends `since=0` into an xterm that still shows its screen. The replay duplicates the history already on screen and, after a restore, prints `terminal replay missed N bytes` for a session over the restored tail. A crash restart takes this path: the tab's dials fail while the devserver is down, before the instance check reloads the window.

## Desired contract

A dial that fails leaves the tab's resume cursor as it was, so the next dial resumes from the screen the xterm still shows.

## What to do

Keep the live cursor across a dial that never reached a `session` frame, clearing `sawSessionControl` only when a dial is known to have replaced the session or the xterm, with a mounted test that fails one dial and shows the next one resume from the cursor. The path is reproduced first, red on the current code.

## Boundaries

`web/packages/workspace-app/src/components/TerminalTab.svelte` and its tests; no server change.
