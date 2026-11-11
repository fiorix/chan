# A tmux connection's windows are missing from their machine's card

Status: raised by the owner on 2026-11-10 and accepted for v0.128.0 the same day; built on 2026-11-11 from the ruling below and merged into the release's integration branch; the section Built holds the evidence, and acceptance 4 is the owner's Mac check.

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

## Built, 2026-11-11

`buildMachineTree` carries each tmux connection's control terminal on the node of the machine whose library runs the tmux client, read from the record's `library_id` for a local run and a carrier run alike (`tmuxControls`, a list beside the disjoint buckets), and the launcher lists it on that machine's card as a buried row whose one control is the connection's detach; the connection's other windows stay on its own card, which keeps the detach on its title, and All windows and the command launcher read the buckets alone, so they still list the window once. A control terminal whose library no card holds yet, or whose record has not arrived, stays on the connection's card alone. The launcher design document and the terminal manual page say where the control terminal shows (`1cddf0d2a`, `9917f4e32`, `ab2b96710`, merged as `9d8eb7088`; the check `c6200c080`).

Checks: the `machineTree` tests (a local run's control terminal on This machine, a devserver run's on that devserver's card, a carrier run's on the machine whose terminal ran it, the connection's windows on its card alone, no id repeated inside any card, All windows unchanged, an unsynced library and a missing record left alone), 7 red at the base and 42 of 42 green; the mounted Library tests of the row (the buried note and title, the detach bound to the connection, a devserver run beside the devserver's own control terminal, privacy mode masking the context), 4 red before the card change and 70 of 70 green; eight mutations each red (the two dedupes, the overview reading the list, the carrier gate, the placement ignoring the library, the placement without a record, the count skipping the list, the detach unbound); `make web-check` green (launcher 808 tests). Browser check 219 in an isolated guest runs a local `tmux -CC` connection against its own devserver, reads the cards on the devserver page and on the desktop deck (its surface meta rewritten at `readystatechange`) against the window feed, finds the buried row with its one detach on This machine and the connection's windows on the connection's card alone, detaches from the row, and finds the connection ended, the control window released and the source shell typing again; green three times and in sequence with check 195, which stays green, and red when the row is removed, when the connection's windows reach the machine card and when the row's detach does nothing.

Found beside the work: in headless Chrome the launcher is the devserver surface, which lists the cards one under another; the deck renders only with the desktop bridge. A check that answers the launcher document through request interception with the surface meta rewritten (check 197's recipe) gets its WebSockets refused by Chrome 156's local-network access check, so a check that reads the window feed must keep the devserver's own document and rewrite the meta from `evaluateOnNewDocument`. Check 219 repeats about seventy lines of check 195's helpers; a shared module would serve both.

The owner's Mac reading passed on 2026-11-11 (`dev/owner-mac-checks-v0128.md`, section A and F, built at 811bd5eb8): every step reported passing apart from one change he asked for in the All windows list, which does not need the tmux connection's buried control terminal (it is on the machine's card and the connection's own card and is not actionable there); that change is a small follow-up.

Amended by the owner on 2026-11-11 after his Mac reading: the All windows list does not show a running connection's buried control terminal, since it sits on the machine's card and the connection's own card and is not actionable from All windows (888d346ff: `windowOverview` drops a row whose tmux mark says it is the control terminal; a devserver's connect control terminal, which carries the flag alone, stays listed; the command launcher keeps it in its own list; a released control terminal is listed again); red on the old code, a mutation on the record's flag red; make web-check and the marketing check green; the launcher design and the manual's terminal page say so. Merged as b54786d27 under make web-check (tests 246, 817, 9344 and 35) and the marketing check (`dev/v0128-team/evidence/Lead128/allwindows-merge`).
