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
