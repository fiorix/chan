# A tmux connection's windows are missing from their machine's card

Status: raised by the owner on 2026-11-10 and accepted for v0.128.0 the same day; not started.

## What is there now

The Computers window shows a carousel of machine cards on the desktop: All windows, This machine, each devserver by name, each tmux control-mode connection, then Add devserver (`web/packages/launcher/src/components/Library.svelte`). The grouping is the pure `web/packages/launcher/src/lib/machineTree.ts`, which treats each `tmux -CC` connection as a machine of its own: "A tmux row goes to its connection's node before any library lookup, so the library's own machine never lists it." A tmux connection's windows, and its control terminal, which stays hidden while the connection runs (`WindowRow.svelte`: "The control terminal stays buried while the connection runs"), therefore show under All windows and on the connection's own card, but not on the card of the machine where `tmux -CC` was run, whether that is This machine or a devserver. The owner looks for them on the machine they run on.

The tree keeps its buckets disjoint on purpose: a window id repeated inside one keyed list throws Svelte's `each_key_duplicate` and freezes the tree (`machineTree.ts`, top comment).

## Desired contract

1. The card of the machine where a `tmux -CC` connection runs (This machine for a local run, the devserver's card for a run on a devserver) lists that connection's windows, and its control terminal marked as hidden, as the connection's own card lists them, with the same row actions and the same buried rule for the control terminal.
2. All windows keeps listing them as today.
3. Whether the connection keeps its own card beside its machine's is decided in this item, with the reason recorded; if it stays, a window may show on both cards, and no keyed list repeats an id within itself.
4. Privacy mode masks these rows as it masks the others.

## Boundaries

- The launcher's grouping and presentation; no change to how tmux windows are minted or named.
- A tmux connection whose machine is not known (a run from a carrier the desktop cannot place) stays on its own card, and the item says so.

## Acceptance

1. `machineTree` tests: a local `tmux -CC` connection's windows and control terminal land on This machine's card and a devserver run's on that devserver's card, with no id repeated inside any one card, and All windows unchanged.
2. A mounted launcher test of the card's rows, the buried control terminal's note included.
3. On chan-desktop (owner): a `tmux -CC` window on this machine and one on a devserver each show on their machine's card.

## Owner ruling, 2026-11-11

Alex, on 2026-11-10, after reading this item: "i dont want all tmux windows on the source machine's card, just the control terminal that got buried; that is because each tmux -CC have their own card in the computers screen; i think from the source machine's card, we should have the button to detach on the buried terminal, while in the specific tmux -CC card we have the detach on the card title, the session - which is fine".

The ruling supersedes contract 1 and settles contract 3:

1. Each `tmux -CC` connection keeps its own card, which lists its windows and keeps the detach control on the card's title (the session), as today.
2. The card of the machine whose terminal runs the tmux client (This machine when the control terminal is a local terminal, the devserver's card when it is that devserver's), read from the control terminal's library, lists only the connection's buried control terminal, marked as hidden as the connection's own card marks it, with a detach button on that row that detaches the connection. A carrier run (`ssh -t host tmux -CC ...`) is placed the same way: its buried terminal is a terminal of a known library whether or not the tmux server is remote. The connection's other windows do not move there.
3. The control terminal is therefore the one window listed on two cards beside All windows (the connection's and its machine's); every other window stays on the connection's card alone, and no keyed list repeats an id within itself.
4. Contracts 2 (All windows unchanged) and 4 (privacy mode) stand. The boundary on a connection whose machine is not known belonged to contract 1 (where the tmux server runs decided where the windows went) and falls with it; under this ruling the one case left alone on the connection's card is a control terminal whose library no card holds yet, until that card exists.

The acceptance checks, restated:

1. `machineTree` tests: a local `tmux -CC` connection's control terminal lands on This machine's card and a devserver run's on that devserver's card, marked as the connection's control terminal; the connection's windows stay on the connection's card alone; no id is repeated inside any one card; All windows is unchanged.
2. A mounted launcher test of the machine card's control terminal row: the buried note and the detach button, whose action is the connection's detach.
3. A browser check in an isolated guest, beside check 195 (which runs a `tmux -CC` connection against a devserver and reads the launcher): the control terminal row shows on the machine's card with its detach button, the connection's windows do not, and detaching from that row ends the connection as the card title's detach does.
4. On chan-desktop on macOS (owner, batched with the milestone's other Mac checks): a `tmux -CC` window on this machine and one on a devserver each show their buried control terminal on their machine's card with a detach button, and the connection's card reads as before.
