# A ghostty terminal on a Windows PTY pulls history into the screen when it grows taller

Status: moved to v0.133.0 by the owner on 2026-11-19 ("move them and cut"); the session frame's PTY metadata shipped in v0.131.0; the client half is built on `v0133/conpty-client` at `19630872c` (pushed under that name; `v0131/conpty-client` is gone from origin) and not merged; in v0.132.0 its VM experiment kit reached revision 7, unsealed, after revision 6 was resealed in place following its reading, and no full job ran. Moved to v0.134.0 by the owner on 2026-11-20 ("the carry items and the current items in v0.133 move to v0.134 roadmap"). Moved to v0.135.0 by the owner on 2026-11-23 ("all other roadmap items will move to next version").

Record before the move: accepted for v0.130.0 by the owner on 2026-11-13 and moved by him to v0.131.0 on 2026-11-14, when he took v0.130.0 to its release with the rows built by then; not started.

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

## Rulings for v0.131.0, 2026-11-14

The owner answered the decisions document for v0.131.0 (`dev/v0131/decisions.md`, point 10) on 2026-11-14: "as you recommend". The reading's outcomes are ruled in advance:

- Rows stay as in Windows Terminal on both backends: the row closes withdrawn, as contract 1 says.
- Drift on ghostty, on xterm.js or on both: contract 2 or 3 is built for the backend that drifts. The wire shape: the attach prelude's `session` frame gains `pty`, `"conpty"` from a Windows server and absent elsewhere and from older servers (a client reads its absence as today's behaviour), and beside it the Windows build number, which xterm.js's `windowsPty` needs.
- Inconclusive (the resize cannot be scripted, or the screenshots do not settle it): one more run with the v0.126.0 drag tools (in the `chan-dev` repository, `releases/v0126/team/reports/Win126/scripts/qdrag.py` and `winstate.ps1`). Still inconclusive: the ghostty option is built off under ConPTY on the core's own comment, xterm.js is left as it is, and the reading is recorded as inconclusive.
- The option off reads worse at the tip: reverted, and the row closes withdrawn with both readings.
- Windows Terminal is installed on the VM if it is not there.

## Baseline reading, 2026-11-15

The native Windows VM reading at `951d81bbd148e2890c263159a89cab2b8ef9e13d` shows prompt and command displacement on both backends in both resize arms. The six r7 runs, their 24 screenshots, console buffers, native window records and available client text are under `dev/v0131-team/evidence/Ops131/J119/{ghostty,xterm,wt}-{height,corner}-r7/`. The parent reading and the exact commands are recorded in `dev/v0131-team/followups/followup-Core131-Lead131-34.md` and `dev/v0131-team/evidence/Core131/conpty/reading-r7/`; the latter also pins the raw artifacts by SHA-256. Every driver returned 0 with `CAPTURED_NOT_VERDICT`, which records successful capture rather than a product pass.

| Backend / arm | Grids: initial / short / grown | Next command |
| --- | --- | --- |
| Ghostty / height | 135x37 / 135x26 / 135x37 | Detached from prompt |
| Ghostty / corner | 135x37 / 157x26 / 135x37 | Detached from prompt |
| xterm.js / height | 133x37 / 133x26 / 133x37 | Detached from prompt |
| xterm.js / corner | 133x37 / 155x26 / 133x37 | Detached from prompt |
| Windows Terminal / height | 116x36 / 116x25 / 116x37 | On intact prompt |
| Windows Terminal / corner | 116x36 / 137x25 / 117x37 | On intact prompt |

After growth, all four chan arms retain 276..300 and the prompt above empty rows, as Windows Terminal also retains its visible output above empty rows. The next command distinguishes them: chan leaves an old `CONPTY>` at row 18, ten blank rows, then `      > 'AFTER_RESIZE'; 901..905` at row 29, followed by the requested output and a new prompt. Windows Terminal continues the command on its intact prompt at row 24. Indexes are zero-based. The visible numeric runs are ordered and single, and every arm prints the requested output once. The reading establishes displacement, not deletion from scrollback. Ghostty's live viewport text and Windows Terminal's UIA text agree with their respective console captures; xterm.js's renderer text is unavailable, and its screenshots establish the visible split.

Windows Terminal's grown native window is eight pixels taller than its initial window, and its corner arm is one pixel wider; the extra row and column prevent exact-grid equivalence. Both grown screens have room for the command output, so those differences do not explain chan's ten-row gap. The pre-run query reports Windows Terminal package 1.25.3131.0, PowerShell 5.1.26100.9444 and OS API version 10.0.26300.0; no per-process Windows Terminal binary version was captured. Windows Terminal's shell uses `-NoProfile`, while chan uses its ordinary PowerShell profile. Both run the same fixture and explicit prompt. These are limits of the comparison, not a measurement of the resize option's effect.

Under the existing ruling, the observed drift calls for contracts 2 and 3 on both backends. The lead accepted that outcome in task 29. The client options and the native reading at the completed implementation tip remain outstanding; this baseline does not close the row. A separate earlier input-loss observation remains unresolved in the terminal regression record, and the slower typing used for r7 does not resolve it.

## Server metadata, 2026-11-15

Native Windows sessions report `pty: "conpty"` and an optional positive `windows_build_number` in their session frame. The number is read once through `sysinfo::System::kernel_version()` and cached; unavailable or malformed values omit the number alone. Following the lead's task 30 ruling on contract 4, tmux pane sessions omit both fields even on Windows because tmux owns their screen. Other server platforms omit both fields as well. Existing session fields are unchanged, and the current client parses added fields without rejecting them.

Eight focused Linux tests pass, covering field serialization and omission, known and unknown builds, malformed input, the native non-Windows path, tmux panes, and handles after registry restart and reattach. The initial red ran on the scaffold in `server29/red-scaffold.patch`, which supplied the new types and helpers but ignored the PTY value when constructing the frame, and failed on the three intended missing-kind assertions; the test file does not compile on the true base. The `does_not_invent` parse test and the tmux, non-Windows and unknown-build omission tests are proven by the named `allow-zero`, `invent-build`, `mark-tmux`, `mark-unix` and `null-build` mutations across `server29/` and `server29-sizefix/`; the happy-path parse test and the plain `None` omission test were green from the first run and have no mutation yet. Seven mutations in each batch compiled and failed the intended assertion; the restored source passes all eight tests again. Initial commands, logs, exit statuses and mutation verdicts are under `dev/v0131-team/evidence/Core131/conpty/server29/`; that directory's failed committed gate is superseded by the complete green gate at `dev/v0131-team/evidence/Core131/conpty/server29-final-gate/`. The Windows CI selection includes the corresponding native Windows test, which requires a real positive build number; it has not run in this evidence.

This is the server stage only. Socket restart and lag-recovery coverage against the combined stream implementation remains outstanding; constructor tests on restarted handles do not establish socket delivery. The client resize options, native Windows validation, the repeated six-arm reading and the row's final acceptance remain open.

The final server representation encodes a known build as a positive integer type and boxes the session's program snapshot to keep the private frame enum within the size lint; the wire shape stays unchanged. All-target clippy passes with this representation. Seven mutations of its field contracts each compile and fail at the intended assertion, and the restored source passes all eight metadata tests. These final-source mutation results, source restoration hash and commands are under `dev/v0131-team/evidence/Core131/conpty/server29-sizefix/`; its interrupted gate and the earlier enum-size lint failures remain in the evidence rather than being counted as test failures. The committed gate of record is `dev/v0131-team/evidence/Core131/conpty/server29-final-gate/` at `d6912c06a618da508c466c63a0c91b79dd6cf594`: formatting, all-target clippy, rustdoc, the eight metadata tests, `server_frame_queue_wire_shapes`, shell-check and workflow-check all exit 0, with clean source hashes unchanged before and after.

## Server stage merged, 2026-11-15

The server stage (`86bfc1fbb..5164538a5`: the `pty` and `windows_build_number` fields of the session frame) was accepted by two Fable reviewers and a confirm read (`dev/v0131-team/reviews/review-conpty-1a.md`, `-1b.md`, `-2.md`) and merged into `v0131/int`. CI run 43702336716 at `d6912c06a` ran the eight metadata tests on the Windows runner, all passing, the native host build test among them. Still owed: the client half (the terminal tab reading the field on both backends), the metadata assertions on the composed socket paths with streamlag, one mutation each for the two tests named above, and the six-arm native resize reading with the terminal suite.

## The client half moved to v0.132.0, 2026-11-16

The client options (the ghostty and xterm.js settings under ConPTY, on `v0131/conpty-client` at `19630872c`, not merged) were built and read on the Windows test VM (job J185, every screenshot read): after a resize both backends still leave the old prompt mid-screen above blank rows with the typed command detached lower down, exactly as the baseline reading showed, while Windows Terminal keeps the prompt and the command on one row. Not worse, so the ruling to revert a worse tip did not apply; the row's goal was not met. The owner ruled by survey on 2026-11-16: "Move it to v0.132.0 (recommended)". v0.131.0 ships only the server stage merged above (the session frame's `pty` and `windows_build_number`, metadata the client does not yet read). The client half, its J185 and J186 readings (`dev/v0131-team/evidence/Ops131/J185/`, `J186/`) and the cause of the unchanged drift are this row's work in v0.132.0.
