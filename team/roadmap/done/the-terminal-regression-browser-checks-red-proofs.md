# The terminal regression browser checks' red proofs

Status: closed by the owner on 2026-11-26 ("agree with your list", the Closed section), and it did not ship: the browser red proofs were not read; closed at [v0.135.0](../../release/release-v0.135.0.md), which records the decision. Record before the close: moved to v0.133.0 by the owner on 2026-11-19 ("move them and cut"); its red-proof recipes revised in a second round (`dev/v0132-team/evidence/Tab132/termredproofs-2/` in the development tree) with a pre-flight asked and not run; the search test's clock fix (H6) merged in v0.132.0. Moved to v0.134.0 by the owner on 2026-11-20 ("the carry items and the current items in v0.133 move to v0.134 roadmap"). Moved to v0.135.0 by the owner on 2026-11-23 ("all other roadmap items will move to next version").

Record before the move: carried from v0.131.0 on 2026-11-16 under the owner's release-first ruling ("if things get more complicated we move to next version"); not started.

Record: v0.131.0 merged the terminal regression checks the owner asked for ("smoke test for those cases so there's no regression"), branch `v0131/termregress`, on two accepting reviews and the first part of their proof chain: the vitest tests, each shown red by a recorded mutation and green restored (53 kills; `dev/v0131-team/terminal-regressions.md`, its B2 block). The browser checks the branch changed or added (check 229's input-scroll arms on both backends and encodings, check 205's readiness barrier, check 226's barrier) run green in the release's suites but were not shown red in a browser: the proof chain's ordering part (about 3.2 hours of the guest heavy lane) and its browser part (about 13 hours) did not fit before the release.

## What is there now

The current product heals a missed config broadcast through a catch-up refresh when the watcher becomes ready (`web/packages/workspace-app/src/state/store.svelte.ts`, `onWatchReady`), so check 205's old form paints and cannot serve as the red control; the revised contract asserts ordering instead: routed watch readiness before the request, the fixed check green, the barrier-removed mutant red at that assertion, restored green (`dev/v0131-team/tasks/task-Lead131-Term131-65.md`).

## Acceptance

1. The ordering proof for check 205 as revised, and check 226's barrier, each red under its mutation and green restored.
2. Check 229's arms each red under the product change it guards, on ghostty and xterm.js, and green restored.

## Closed, 2026-11-26

The owner closed the row on 2026-11-26 ("agree with your list", `dev/v0135-team/decisions.md`, D126 item 3), answering the lead's list, which named it among the terminal rows outside the v0.135.0 team's scope to close, all but the retired key's rejection. At closing, by the sections above: the terminal regression checks merged in v0.131.0 with the vitest half of their proof chain (53 kills), and the search test's clock fix (H6) merged in v0.132.0. Not read: the browser red proofs this row exists for, acceptance 1 (check 205's ordering proof as revised and check 226's barrier, each red under its mutation) and acceptance 2 (check 229's arms, each red under the product change it guards). Their recipes were revised in a second round (`dev/v0132-team/evidence/Tab132/termredproofs-2/` in the development tree), and the pre-flight asked of that round was not run. Check 229 has no xterm.js arm at `aabb9d039`: xterm.js leaves chan in v0.135.0 ([the xterm.js row](chan-carries-xterm-js-as-a-second-terminal-backend.md)). The browser red proofs did not ship.
