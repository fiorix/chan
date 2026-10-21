# X10-encoded mouse reports from the xterm.js renderer never reach the terminal's PTY

Status: raised for v0.109.0 on 2026-10-21 by the lead, from the review seat's read of the typed-input broadcast design; closes in the round.

## What was seen

The workspace app subscribes to xterm.js's `onData` only: `web/packages/workspace-app/src/components/TerminalTab.svelte` 1332 (`term.onData(handleXtermData)`), and `onBinary` appears nowhere in `src/` outside tests. xterm.js 6.0.0's `CoreMouseService` (`src/common/services/CoreMouseService.ts`, "always send DEFAULT as binary data") sends a mouse report in the `DEFAULT` encoding, the X10 form `ESC [ M` followed by three characters whose codes carry the button and the coordinates offset by 32 and can exceed 127, through `triggerBinaryEvent`, which fires `onBinary` and not `onData`; the SGR and SGR-pixels encodings (modes 1006 and 1016) go through `triggerDataEvent` and reach the PTY, and xterm.js 6.0.0 has no UTF-8 or URXVT encoding (modes 1005 and 1015 set nothing). So a program that enables mouse tracking without choosing SGR, with or without 1005 or 1015, gets no mouse report at all from a chan terminal on the xterm.js renderer, whether or not a live write is pending. The reading is the xterm.js renderer's: Ghostty, the default renderer on Linux (`crates/chan-library/src/config.rs` 268; xterm.js is the default on macOS and Windows), was not read for mouse reports. The terminal socket's `input` frame is a JSON string: `sendInput` sends `{ type: "input", data }` (`TerminalTab.svelte` 1925, `ws.send(JSON.stringify(frame))` at 1892) and the server writes `data.as_bytes()` (`crates/chan-server/src/routes/terminal.rs` 1027), so a byte-valued character above 127 pushed through that frame would reach the PTY as two UTF-8 bytes, not one. Read at source by the review seat and the lead; not measured in a terminal.

## Desired contract

A mouse report xterm.js emits in the X10 encoding reaches the PTY of the terminal it was made in, byte for byte: each character of the binary string becomes one byte. It is user input, so it takes the route a user-made chunk takes, including the typed-input broadcast item's group route once that lands.

## What to do

A short design first, since the wire shape is unnamed: how a byte-valued chunk crosses the terminal socket unchanged (a frame of its own carrying the bytes, or the `input` frame with an encoding the server undoes; the design names the frame, its server arm in `routes/terminal.rs` and its authority row if the route is new, and why the shape is the smallest). Then the build: subscribe `term.onBinary` beside `onData` in `TerminalTab.svelte`, convert the string to bytes by character code, and hand the chunk to the same route a user-made data chunk takes. Pins red first: a unit test of the route with a constructed X10 report whose coordinate characters exceed 127, asserting the bytes the socket carries equal the character codes, one byte each, and a mutant that encodes the string as UTF-8 red; a server test that the frame's bytes reach the PTY unchanged, red first. The mounted terminal test over the real xterm fixture (`__tests__/terminalReplay.ts`) drives a report through `triggerBinaryEvent` if the fixture allows it; the row says so if it does not.

## Boundaries

`web/packages/workspace-app/src/components/TerminalTab.svelte` at the subscription and the send, `web/packages/workspace-app/src/terminal/connection.ts` (the byte conversion and the route), `crates/chan-server/src/routes/terminal.rs` (the frame's server arm) and `route_authority.rs` only if the design adds a route, with the design documents of both. Lands after the typed-input broadcast item through `TerminalTab.svelte` and `connection.ts`. Not changed: xterm.js, the SGR path, ghostty's route.

## Acceptance

1. The route pin red at the parent on its own assertion and green at the commit, the UTF-8 mutant red, the server pin red first; the commands and logs recorded here.
2. `make web-check` green and the chan-server suite green at the commit.
3. One observation in a browser check or by hand: a terminal running `printf '\033[?1000h'; cat -v` shows `^[[M` followed by three characters on a click, written on the suite owner's base, or the row says why it was not taken.
