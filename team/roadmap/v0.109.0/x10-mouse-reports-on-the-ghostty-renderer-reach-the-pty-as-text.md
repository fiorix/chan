# X10 mouse reports on the ghostty renderer reach the PTY as text

Status: raised for v0.109.0 on 2026-10-22 by the lead, from the frontend seat's reading at source during the X10 mouse report item and the review seat's reading of ghostty-web's input handler; closes in the round.

## What was seen

Two producers make X10 mouse reports on the ghostty renderer and both send them as text. `handleGhosttyWheel` in `web/packages/workspace-app/src/components/TerminalTab.svelte` builds the X10 wheel report itself when the terminal has mouse reporting on and SGR mode (1006) off, and writes it through `sendInput` as text. ghostty-web 0.4.0-next.20's own input handler (`encodeMouseX10` and `sendMouseEvent` in its bundle) reports a press, a release and a motion in X10 when mode 1006 is off and hands the report to `onData` as text, where chan's `handleXtermData` routes it unmarked through `routeXtermData` to a text `input` frame. The X10 encoding adds 32 to each coordinate and sends the result as one byte, so a column or row past the 95th gives a byte above 127, which the text route encodes as two UTF-8 bytes; the PTY then reads a two-byte coordinate, which a program reading three bytes after `ESC [ M` takes as a wrong cell followed by a stray byte, so a wheel, a click or a drag over the right part of a wide terminal or the lower part of a tall one reaches the program at the wrong cell. The xterm.js backend's reports take the byte route the X10 mouse report item added, so the fault is the ghostty renderer's; it is read at source, not observed in a terminal.

## Desired contract

An X10 mouse report made on the ghostty renderer, by chan's wheel handler or by ghostty-web's input handler, reaches the PTY byte for byte, like a report the xterm.js backend makes. Every mouse report made on the ghostty renderer is user input, the wheel report included, and takes the route the xterm.js backend's mouse reports take, to its own PTY and the broadcast group whatever the terminal's output is doing: no reply the parser makes has a report's shape, so a recognized report is the user's. Ghostty's other data keeps the unmarked route the design describes.

## What to do

Send the X10 wheel report as user input through the byte route (`sendUserInput(report, true)`) and the SGR wheel report as user input through the text route (`sendUserInput(report)`), with the handler's comment saying both are user input. On the ghostty route, recognize ghostty-web's report in `onData`, a chunk that is exactly `ESC [ M` followed by three characters each in U+0020 to U+00FF, the encoder's shape and range, and send it through `sendUserInput` with the binary flag, bypassing `routeXtermData` as the xterm.js backend's `handleXtermBinary` does. The recognizer also takes ghostty-web's SGR report, `ESC [ <` digits `;` digits `;` digits and then `M` or `m`, nothing else, and sends it through `sendUserInput` as text. The residual is stated here: with bracketed paste off, a paste of exactly the X10 shape reaches the PTY one byte per character. Pins red first at the parent on a ghostty stand-in: a wheel over a column past the 95th reaches the socket as a frame carrying the report's bytes and the binary flag, and reaches a same-window member's sink; an SGR wheel report reaches the socket as text and reaches the member's sink; a press report past the 95th handed to `onData` reaches the socket with the flag and reaches the member's sink; a press report handed to `onData` while a live write is being parsed reaches the group; an SGR press report handed to `onData` while a live write is being parsed reaches the socket as text and reaches the group; a chunk of `ESC [ M` plus four characters, one above U+007F, stays a text frame; a report-shaped chunk with a character above U+00FF stays a text frame. Mutants, one per guard: the wheel's flag dropped; the X10 wheel through `sendInput`; the SGR wheel through `sendInput`; the X10 recognizer removed; the recognizer accepting a chunk of another length; the recognizer's range check dropped; the SGR recognizer removed; the recognized report through `routeXtermData`. The design sentence on the byte route names the ghostty renderer's reports and their routes.

## Boundaries

`TerminalTab.svelte` at `handleGhosttyWheel` and at the ghostty backend's `onData` route, the X10 mouse report item's binary-input test file, and the workspace app's `design.md` sentence on the byte route. Not changed: the SGR report's encoding, ASCII text; the server's conversion; the xterm.js route; ghostty-web.

## Acceptance

1. The pins red first at the parent on their own assertions and green at the commit; each mutant red on its pin; the commands and logs recorded here.
2. `make web-check` green at the commit.
