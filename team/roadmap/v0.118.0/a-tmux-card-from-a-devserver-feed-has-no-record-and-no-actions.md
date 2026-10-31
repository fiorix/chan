# A tmux card from a devserver feed has no record and no actions

Status: carried into v0.118.0 at the v0.117.1 GA on 2026-10-31, not started: the owner's word at the patch was "the tmux case im less concerned with, the file browser we must fix now".

Record before the release: raised by the owner on 2026-10-31 after the v0.117.0 publication, from chan-desktop on macOS connected to the Linux machine's devserver through the gateway; accepted for v0.117.1 as a patch, not started.

## What was asked

The owner's words of 2026-10-31, with two screenshots: "when im using tmux -CC and the top 'new terminal' and 'disconnect' buttons are missing", "it's supposed to look like the other badges but wired to the tmux functionality", "in the way it is, i cannot disconnect"; and, asked where tmux ran: "the second case is because I ran tmux -CC over the gateway, and it worked, but didn't show the buttons like it does on local or over ssh". So the connection was made in a terminal of the Linux machine's devserver, reached from the macOS desktop through gw.chan.app; the windows were minted and shown, and only the card's record and actions are missing. The tmux item's decision 17 left the chan gateway out of the v0.117.0 scope; the path works but for this, and the owner uses it.

## Evidence

- The owner's first capture: the tmux card in the launcher's Computers carousel titled `tmux -CC`, a window-count badge of 3, and the WINDOWS list (`Control terminal` buried, `Window 5 [tmux]`, `Window 6 [tmux @5]` each with focus and show buttons), with no session line under the title and no header action beside the badge. The second capture is the devserver card the owner expects it to mirror: `geekom via gw.chan.app` with the window count, the new-terminal button and the green disconnect toggle in its header. Both are kept with the cut's record (`bugs/tmux-card-no-header-actions-macos.png`, `bugs/devserver-card-header-actions-macos.png` in the chan-dev mirror of the v0.117.0 cut).
- The launcher renders the card's `t` and `c` actions, its session line and its origin title only when the node carries its connection record (`Library.svelte`, the `node.kind === "tmux"` arm: `{#if entry && !readOnly}`); a node without a record "carries its rows alone until the next push" and takes the fallback title. The records come from the window set's `tmux_connections`, which the host fills from its own registry alone (`WorkspaceHost::tmux_connections`, `host.rs`), while the window rows of a connected devserver arrive through its feed (`window_records_by_source`, the fed part). A `tmux -CC` run in a devserver's terminal therefore reaches a desktop connected to that devserver as marked window rows with no record: the card appears, but nothing on it can ask tmux for a window or detach, and the only way out is the terminal that ran tmux, buried as the control row. The tmux item's stage 9 results recorded this path as open ("a devserver's own tmux connection is not forwarded through the desktop's devserver feed aggregation, so a card for a connection made on a devserver terminal needs that path and a request-routing story").

## Desired contract

A tmux connection made on a devserver's terminal is a full card on every desktop connected to that devserver: the feed carries the devserver's `tmux_connections` records to the desktop's window set (and `GET /api/library/tmux` lists them), the card shows the origin title, the session and version line and the error mark, and its `t` and `c` actions and the selection's end route the request to the devserver that owns the connection (`POST /api/library/tmux/{connection}/request` on that devserver, through the same path the fed window rows' show and focus take). A local connection is unchanged.

## Boundaries

The devserver feed aggregation in chan-library (`host.rs`, the fed window records and the window set), the launcher's request routing for fed records (`state/computerActions.ts`, `api/library.ts`), and the tmux card (`Library.svelte`); the wire shape of the record is unchanged.

## Acceptance

1. With a devserver registered and connected in chan-desktop and `tmux -CC` run in one of that devserver's terminals, the desktop's launcher shows the card with its origin title, session line, `t` and `c`; `t` opens a new tmux window on the devserver, `c` detaches and the card goes; the connection record is listed by the desktop's `GET /api/library/tmux`.
2. A library test pins that a fed `tmux_connections` record reaches the aggregated window set, and a launcher test pins the card's actions for a fed record.
3. The owner reads it on macOS chan-desktop against the geekom devserver.
