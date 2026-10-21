# Typed input during a live write is not broadcast on the ghostty renderer

Status: raised for v0.109.0 on 2026-10-21 by the lead, from the frontend seat's reading at the typed-input broadcast item's build; withdrawn by the owner's word of 2026-10-21 (xterm.js becomes the default renderer on every platform and a loss on ghostty is accepted); the cost: typed input during a live write stays unbroadcast on a terminal switched to ghostty; it moves to done/ at the GA as not shipped.

## What was seen

The typed-input broadcast item routes a user-made chunk to the group through xterm.js's `onUserInput` mark and leaves ghostty-web's route as it is, so a terminal on the ghostty renderer keeps the loss the item repairs for xterm.js. ghostty is the default renderer on Linux (`crates/chan-library/src/config.rs` 268, `default_terminal_ghostty()` is `cfg!(target_os = "linux")`, pinned at 718 and 727) and xterm.js the default on macOS and Windows. ghostty-web 0.4.0-next.20 (locked) marks no clean user-input boundary: keyboard, paste and `input()` set `awaitingEcho = true` before firing `onData` (`dist/ghostty-web.js` 2766, 2824, 2833), while its parser replies are fired by `processTerminalResponses()` (3242 to 3250), which `write()` calls before clearing the flag (2806), so a reply made right after a keypress carries the flag. Read at source by the frontend seat; the ghostty loss itself was not measured in a terminal.

## Desired contract

A chunk a person types into a ghostty terminal of a broadcast group during a live write reaches every member, and a reply ghostty-web makes to a parser query reaches only its own PTY, as the xterm.js route does after the typed-input broadcast item.

## What to do

A design first: a seam that tells ghostty-web's replies from a person's input, the first candidate wrapping `processTerminalResponses()` so its chunks are marked as replies before they reach the app's `onData` handler, measured on a constructed query and a keypress in the same write; then the route through the same router the xterm.js item uses, with pins red first and the mounted terminal test over the real ghostty fixture if the harness allows it. The owner's word below withdraws the row at the cost it states.

## Boundaries

`web/packages/workspace-app/src/terminal/` (a ghostty seam beside the xterm.js one) and `components/TerminalTab.svelte` at the subscription; it would land after the typed-input broadcast item through `TerminalTab.svelte`. Not changed: ghostty-web's sources, the xterm.js route, the group semantics.

## Acceptance

1. Not taken: the seam's design read by the review seat, with the measurement of the reply mark on a constructed query beside a keypress.
2. Not taken: the pins red first and green at the commit, one mutant per guard, with the commands and logs recorded here; `make web-check` green.
3. Taken: the owner's word withdrawing the row, recorded here with what it costs: typed input during a live write stays unbroadcast on a terminal switched to ghostty in this version.

## Owner's word 2026-10-21

Surveyed with the choice of closing the row in this version or withdrawing it at the cost of typed input during a live write staying unbroadcast on Linux's default renderer. The answer: "A: close it in v0.109.0 (recommended): a design and a measured seam, then the route; about four hours on the Frontend lane after tbcast, or on the Hygiene lane after its rows". The lead placed it on the tooling and native-evidence seat's lane after the embedded demo's tab-order item, since the workspace app's lane is the version's critical path.

Later the same day, in the lead's terminal: "i think what i want about the xterm vs ghostty is to make xterm.js the default on all platforms, this is a change to linux.. and from this change if ghostty loses functionality like the secret masking, it is fine". With ghostty no longer a default anywhere and its losses accepted, this row is withdrawn at that cost, and the default change is its own row (xterm.js is the default terminal renderer on every platform).
