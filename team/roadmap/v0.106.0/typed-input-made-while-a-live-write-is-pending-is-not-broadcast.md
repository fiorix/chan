# Typed input made while a live write is pending is not broadcast

Status: raised by the review seat on 2026-10-13 from its design read of the focus-report item (X1 of `reviews/review-Review106-fbcast-design-1.md` in the round's bus); written down the same day by the lead as a row of its own, outside that item; owner the frontend seat; a capture before any decision; not reached in the v0.106.0 round unless the readings leave room

## What was seen

Read at source, not run. `web/packages/workspace-app/src/terminal/connection.ts` 59 to 63 (the same blob at the round's base `4507fe5a0`): while a live write is pending, every chunk the terminal emits goes to the own-PTY sender alone, so that a terminal-generated reply reaches only the PTY that asked. `TerminalTab.svelte` 2021 pushes a live origin for every chunk of PTY output until xterm.js has parsed it, and ordinary typing reaches the router through the same `onData` path as the replies. So with broadcast on and the source terminal's output in flight when a key's data event fires (steady output in that terminal, or the echo of the key before), that key reaches the source PTY and no other member of the group, in this window or another: the group misses input the user typed. It is the focus report's "two routes by timing" with the opposite sign.

## Desired contract

A key the user types reaches every member of the broadcast group whatever the source terminal's output is doing at that instant; only terminal-generated replies take the own-PTY route.

## What to do

Capture before deciding, on the rig the frontend seat built for the focus-report item (`evidence/Frontend106/fbcast-browser-check.mjs` in the round's bus): two terminals of one broadcast group under xterm.js, the source program printing steadily while keys are typed into it, both PTYs' input recorded; count the keys each PTY received. If the group misses keys, read how the router can tell a reply from a key while a live write is pending (the reply's shape, the data event's source, or the pending write's own expectation) and put the choices to the lead. Design before code; the review seat reads the design.

## Boundaries

`web/packages/workspace-app/src/terminal/connection.ts`, `components/TerminalTab.svelte` and their tests. Not changed: the ghostty-web route; the focus report's own-PTY route; the server's fan-out.

## Acceptance

1. A written capture: with broadcast on and the source terminal printing steadily, what each member's PTY receives of the typed keys, with the engine named.
2. The decision recorded here with its reason.
3. If the route changes: a pin, red first on its own assertion, that a typed key made while a live write is pending reaches every member, and that a terminal-generated reply still reaches the own PTY alone.
