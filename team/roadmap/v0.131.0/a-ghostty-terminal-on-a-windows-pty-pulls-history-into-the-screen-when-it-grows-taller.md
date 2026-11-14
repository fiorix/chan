# A ghostty terminal on a Windows PTY pulls history into the screen when it grows taller

Status: accepted for v0.130.0 by the owner on 2026-11-13 and moved by him to v0.131.0 on 2026-11-14, when he took v0.130.0 to its release with the rows built by then; not started.

Record: raised on 2026-11-12, while the terminal core was re-pinned to libghostty-vt 1.0.1, as an open question and unverified: "chan's ghostty terminals on Windows run over ConPTY but leave the core's `RESIZE_PULL_SCROLLBACK` option (in the ABI since 1.0.0) at its default of on, and the core's own comment says it should be off under ConPTY. It predates 1.0.1, but 1.0.1 now pulls scrollback on a combined resize too. To read on the Windows VM." (`dev/v0129/row-notes.md`, "Open questions raised by lanes"). The owner, for v0.130.0: "what i really want on v0.130 is the systemd and flush-window-edges, plus ghostty/terminal bug fixes like the one my other agent is actively fixing right now".

## What is there now

Read at `342dbe791`; nothing run on Windows.

- The PTY is the server's. On Windows the session's PTY system is portable-pty's native one (`native_pty_system`, `crates/chan-library/src/terminal_sessions.rs`), which is ConPTY there (portable-pty 0.9). So the terminals of a server on Windows run over ConPTY whatever client shows them, and a Windows client of a Linux or macOS server shows a Unix PTY.
- chan's binding sets the core's PTY-write and device-attributes callbacks, scrollback limits, colours and modes (`web/packages/ghostty-web-ng/vt/ghosttyVt.ts`, whose `ABI.GhosttyTerminalOption` names no other option) and never `RESIZE_PULL_SCROLLBACK` (41, a bool, in the 1.0.1 ABI: `dev/v0129/evidence/corebump/abi/1.0.1/type-json.sorted.json`). The core's default of on holds on every platform: a resize that adds rows pulls history rows down into the screen. The core's field (`Resize.pull_scrollback: bool = true`) has a doc comment ending "rows back and would otherwise get out of sync with us" (`dev/v0129/evidence/corebump/release-notes/vt-1.0.0...vt-1.0.1.diff`); the comment's opening, which names ConPTY by the re-pin's reading, is not in the local copies.
- xterm.js documents the same for ConPTY under its `windowsPty` option: with it set, rows added go into scrollback "because ConPTY does not behave like expect scrollback to come back into the viewport, instead it makes empty rows at of the viewport. Not having this behavior can result in missing data as the rows get replaced" (xterm.js 6.0.0, `typings/xterm.d.ts`). chan does not set `windowsPty`, so its xterm.js terminals pull history on a Windows server as well, by reading. That option also turns reflow off below Windows build 21376.
- No client learns the PTY's kind: the attach prelude's `session` frame names none (`ServerFrame::Session`, `crates/chan-server/src/routes/terminal.rs`).
- What this does on screen is unread. By the two comments, after a terminal grows taller its screen and ConPTY's disagree by the rows pulled down, and ConPTY's next repaint lands on rows that hold other text.

## Desired contract

1. The reading in acceptance 1 comes first. If it shows the terminal on both backends keeping its rows as Windows Terminal does, this row closes withdrawn with that reading.
2. Otherwise, a ghostty terminal whose PTY is a ConPTY runs with the core's `RESIZE_PULL_SCROLLBACK` off from its first resize on, and every other ghostty terminal keeps it on.
3. An xterm.js terminal on a ConPTY gets the same rule through `windowsPty` where the reading shows the same drift there.
4. The rule follows the PTY's kind as the server states it, never the browser's or the desktop's own platform.

## Boundaries

- The binding's terminal options (`vt/ghosttyVt.ts`), the terminal tab's construction of both backends (`web/packages/workspace-app/src/components/TerminalTab.svelte`), and a field of the attach prelude naming the PTY's kind.
- Not here: how ConPTY repaints on a resize; reflow of wrapped lines beyond what `windowsPty` brings with it.

## Acceptance

1. On the Windows VM (`dev/vm/windows.sh`), chan-desktop at the base, a ghostty terminal and then an xterm.js one, each over PowerShell: a screen of output with history above it (`1..300`), the window made shorter, then taller, by its height alone and then by a corner (rows and columns at once), then a command run. Record, beside Windows Terminal doing the same, whether the prompt, its output and the rows above stay where they belong and whether any row is lost, blank or doubled, with screenshots.
2. If acceptance 1 shows the drift: tests that a ghostty terminal on a ConPTY session sets the option off and one on another PTY leaves it on (and `windowsPty` likewise on xterm.js, where it applies), red on today's code; then acceptance 1 again at the tip, its rows in place.
