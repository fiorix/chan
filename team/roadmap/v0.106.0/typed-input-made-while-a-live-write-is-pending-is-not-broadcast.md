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

## The capture and the lead's decision 2026-10-13

Acceptance 1 (the frontend seat, `dev/v0106-team/tasks/task-Frontend106-Lead106-42.md` in the round's bus; `evidence/Frontend106/tbcast-browser/typed-broadcast.json` with the two PTYs' raw input logs beside it), at the integration tip `710527543` in its guest's Chrome for Testing 155.0.8059.39 on the xterm.js backend, a disposable standalone server, two terminals of one broadcast group with both selected: the source's raw-mode program printed lines of 720 characters every 2 ms while Puppeteer typed the same 36 distinct ASCII keys with a 10 ms delay each, and both PTYs recorded their input. With the source silent each PTY received 36 of 36. With the source printing, the source PTY received 36 of 36 in each of three arms and the target PTY 15, 11 and 10 of 36, the received keys a subsequence in order with no duplicate, and the raw logs' totals (144 source bytes, 72 target bytes) show the missing keys never arrived later. The source made 1,443 to 1,755 output writes during each typing interval. The guest's cgroup was CPU-throttled through the run; the counts are a routing observation, not a timing measurement. Read at source by the seat, with the route as the first section says: every xterm `onData` chunk goes through one string path (`TerminalTab.svelte` 1312, 2077 to 2078), the live-write tracker at 2044 holds `live` until xterm's completion callback, and `connection.ts` 59 to 63 sends every chunk to the own PTY while it does; the broadcast route is `sendUserInput` (2067 to 2075) and the live branch bypasses it; the reply scanner at `connection.ts` 78 recognizes reply shapes and carries no provenance.

Acceptance 2, the lead's decision: the loss is established and the repair is designed in the next version, not this one, which freezes with this capture. The seat put three routes to the lead: the reply's shape (route recognized replies locally and everything else through the group, the smallest change, but a typed escape sequence can look like a reply and a chunk can mix both); input provenance (tag keyboard, paste and composition data before they enter the shared `onData` path, and keep parser replies local, which is the contract this row wants, if xterm.js offers the seam for every input mode); a pending reply expectation (track the queries in live output and route only matching answers locally, which widens into query parsing across chunks). The lead takes the seat's recommendation as the next version's first step: a design investigation of the provenance seam first, the shape rule as the narrower candidate with stated ambiguous-key and mixed-chunk tests, the design read by the review seat before code. Kept as a stated cost: with broadcast on, keys typed into a terminal whose output is in flight reach that terminal alone, and the other members of the group miss them; in the capture under steady output, 58 to 72 percent of the keys. Acceptance 3 is the next version's with the route change.

Not established: a cross-window target (the server's fan-out, read as the same route); the ghostty-web backend, which has its own route; a native WebView; a terminal whose output is intermittent rather than steady, where the loss is the fraction of keys that land inside a pending write.
