# A tmux connection's card lists the buried terminal that ran it

Status: accepted for v0.133.0 by the owner on 2026-11-20: "in the computers window, each 'tmux -CC' gets its own card (local and remote), and in that card, we currently show the terminal that was buried running the `tmux -CC` command; i dont want it to be there, because we already have the buried terminal in the local 'this machine' or in the 'devserver' card where it was started and that's good enough". Built and reviewed: check 219 red at the base and green at the tip in a Chrome guest with a real `tmux -CC` connection, one reader and a confirm reader accepting with notes.

Record: the control terminal was put on the card of the machine whose terminal ran `tmux -CC` by [a-tmux-connections-windows-are-missing-from-their-machines-card](../done/a-tmux-connections-windows-are-missing-from-their-machines-card.md) (v0.128.0, `1cddf0d2a` and `9917f4e32`), whose owner ruling of 2026-11-11 made it "the one window listed on two cards beside All windows (the connection's and its machine's)"; its amendment of the same day took it out of All windows (`888d346ff`). This row takes it off the connection's card, so the machine's card is the one card that lists it while the connection runs.

## What is there now

Read at `793d86522`.

- `web/packages/launcher/src/lib/machineTree.ts:264-290`: `tmuxNode` puts the row whose tmux mark says `control: true` in the tmux node's own `control` bucket (`:271`), which `sortWindows` pins first.
- `machineTree.ts:410-417`: the tree builder also pushes each such row into `tmuxControls` of the machine whose library ran the connection (`tmuxMachine`, `:296-299`, null while the record has not arrived or no machine card holds the record's library). The `TmuxControlRow` doc comment (`:160-169`) calls it "the one window two cards list".
- `web/packages/launcher/src/components/Library.svelte:507-531` (`machineContent`) renders `node.control`, then `node.tmuxControls` through the `tmuxControlRow` snippet (`:351-369`, which carries the connection's Detach), then the terminals and the unopened tmux windows. So the connection's card lists the control terminal first, buried with no action of its own (`WindowRow.svelte:55-60`), above the connection's windows.
- `machineWindowCount` (`machineTree.ts:318-327`) counts `control` and `tmuxControls`, so the connection's badge counts the control terminal. `windowOverview` (`:207-218`) leaves the control terminal out of All windows. The command launcher (`CommandLauncher.svelte:301-302`) lists each machine's `control`, `terminals` and `looseWindows`, so it lists the control terminal once, under the connection.
- Browser check 219 (`scripts/e2e/browser-smoke/checks/219-tmux-card-machine-row.mjs:109-111`) asserts that the connection's card lists its control terminal as one buried row with no action.

## Desired contract

1. A tmux connection's card no longer lists its control terminal: its rows are the connection's windows, open then unopened. The card's count badge counts what it lists.
2. The card of the machine where `tmux -CC` ran (This machine, or the devserver's card) keeps listing the control terminal as today, buried, with the connection's Detach on the row.
3. Nothing loses the window. While the connection's record has not arrived, or no machine card holds its library yet, the control terminal stays on the connection's card, as today in that case: that card is the only one a record-less connection has, the Connecting block groups windows by library and carries no connection, and the control terminal moves to its machine's card the moment that card holds the library. The command launcher lists it exactly once, under the machine whose card lists it. All windows keeps leaving it out.
4. Every other tmux card behaviour stays: the title, Detach on the card header, the hidden-window rows, the ordering, the read-only surface.

## Boundaries

- `web/packages/launcher/src/lib/machineTree.ts` and its test, `Library.svelte` and its mounted test's expectations that this contract changes, `CommandLauncher.svelte` for its single listing, and the doc comments these carry.
- Browser check 219, whose assertion on the connection's card is the one this contract changes.
- The documents that describe the tmux card: `web/packages/launcher/design.md` and the manual's tmux page.
- No change to how the library mints, marks or releases the control terminal.

## Acceptance

1. `machineTree` tests: the tmux node's rows exclude the control terminal once its machine's card holds it; that card's `tmuxControls` keeps it; with no record or no card for its library it stays on the connection's node; the connection's badge counts the rows it lists. Each test dies to one named mutation.
2. Browser check 219, with a real `tmux -CC` connection: the connection's card lists no control terminal and its badge counts its rows; This machine's card lists it with the connection's Detach. Red at the base on its first leg, green at the tip, alone and in one runner call with check 195.
3. `make web-check` green.
